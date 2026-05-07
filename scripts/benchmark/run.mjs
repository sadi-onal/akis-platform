#!/usr/bin/env node
/**
 * AKIS dogfooding benchmark runner.
 *
 * For a fixed YAML set of problems, drives the pipeline API end-to-end
 * (create → answer clarifications → approve → wait for terminal state)
 * and writes a per-run JSON report under docs/dogfooding/results-*.json.
 *
 * Usage:
 *   AKIS_API_BASE=http://localhost:3000 \
 *   AKIS_TEST_TOKEN=<test-helper-token> \
 *   node scripts/benchmark/run.mjs [--problem todo-001] [--label baseline]
 *
 * Notes:
 * - Backend must be running and (for cheap iteration) AI_PROVIDER=mock.
 * - This script is read-mostly: it triggers pipelines and polls. It does
 *   NOT mutate user data outside of pipeline rows it creates.
 * - The test-helper token wires to backend/src/api/test-helpers.ts; using
 *   it bypasses regular auth so a CI box can run the benchmark headlessly.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const API = process.env.AKIS_API_BASE ?? 'http://localhost:3000';
const TOKEN = process.env.AKIS_TEST_TOKEN ?? '';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per problem

const { values: args } = parseArgs({
  options: {
    problem: { type: 'string' },
    label: { type: 'string', default: 'unlabeled' },
    dryRun: { type: 'boolean', default: false },
  },
});

// Tiny YAML reader — keeps the script dependency-free. Only handles the
// shape used by benchmark-set.yaml; do not generalize without testing.
function parseSimpleYaml(text) {
  const lines = text.split('\n');
  const root = { problems: [] };
  let current = null;
  let inAcceptance = false;
  let inAnswers = false;
  let inIdea = false;
  let ideaBuf = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('  - id:')) {
      if (current) root.problems.push(current);
      current = {
        id: line.split(':')[1].trim(),
        clarifying_answers: {},
        acceptance_criteria: [],
      };
      inAcceptance = inAnswers = inIdea = false;
      continue;
    }
    if (!current) continue;
    if (/^    title:/.test(line)) {
      current.title = line.split(/:(.+)/)[1].trim();
    } else if (/^    idea: \|/.test(line)) {
      inIdea = true;
      inAcceptance = inAnswers = false;
      ideaBuf = [];
    } else if (/^    clarifying_answers:/.test(line)) {
      inAnswers = true;
      inIdea = inAcceptance = false;
    } else if (/^    acceptance_criteria:/.test(line)) {
      inAcceptance = true;
      inIdea = inAnswers = false;
    } else if (inIdea && /^      /.test(line)) {
      ideaBuf.push(line.replace(/^      /, ''));
    } else if (inAnswers && /^      \w+:/.test(line)) {
      const [k, ...rest] = line.trim().split(':');
      current.clarifying_answers[k.trim()] = rest
        .join(':')
        .trim()
        .replace(/^"|"$/g, '');
    } else if (inAcceptance && /^      - /.test(line)) {
      current.acceptance_criteria.push(
        line.replace(/^      - /, '').replace(/^"|"$/g, '')
      );
    } else if (inIdea) {
      // empty/dedented line ends the idea block
      current.idea = ideaBuf.join('\n').trim();
      inIdea = false;
      ideaBuf = [];
    }
  }
  if (current) {
    if (inIdea && ideaBuf.length) current.idea = ideaBuf.join('\n').trim();
    root.problems.push(current);
  }
  return root;
}

async function api(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(TOKEN ? { 'X-Test-Token': TOKEN } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function pollUntilTerminal(pipelineId) {
  const start = Date.now();
  // Terminal stages we recognise — older builds may produce more.
  const TERMINAL = new Set([
    'completed',
    'completed_partial',
    'failed',
    'cancelled',
  ]);
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const { pipeline } = await api(`/api/pipelines/${pipelineId}`);
    if (TERMINAL.has(pipeline.stage)) return pipeline;
    if (pipeline.stage === 'awaiting_approval') {
      // benchmark auto-approves with a default repo name
      await api(`/api/pipelines/${pipelineId}/approve`, {
        method: 'POST',
        body: JSON.stringify({
          repoName: `akis-bench-${pipelineId.slice(0, 6)}`,
          repoVisibility: 'private',
        }),
      });
    }
    if (pipeline.stage === 'scribe_clarifying') {
      // Scribe expects user_answer next; we synthesise one from the
      // benchmark's `clarifying_answers` block.
      const meta = pipeline.intermediateState?.benchmarkMeta;
      const reply =
        meta?.clarifying_answers
          ? Object.entries(meta.clarifying_answers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n')
          : 'Sen karar ver.';
      await api(`/api/pipelines/${pipelineId}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: reply }),
      });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Pipeline ${pipelineId} did not reach a terminal state within ${POLL_TIMEOUT_MS}ms`);
}

async function runProblem(problem) {
  const startedAt = Date.now();
  const { pipeline } = await api('/api/pipelines', {
    method: 'POST',
    body: JSON.stringify({
      idea: problem.idea,
      // Mock benchmarkMeta inside intermediateState so the poller knows
      // which canned answers to send when Scribe asks for clarifications.
      __benchmarkMeta: {
        problemId: problem.id,
        clarifying_answers: problem.clarifying_answers,
      },
    }),
  });
  const final = await pollUntilTerminal(pipeline.id);
  let explanation = null;
  try {
    const expl = await api(`/api/pipelines/${pipeline.id}/explanation`);
    explanation = expl.explanation;
  } catch {
    /* explanation may not be available (older backend) */
  }
  return {
    problemId: problem.id,
    pipelineId: pipeline.id,
    finalStage: final.stage,
    durationMs: Date.now() - startedAt,
    metrics: final.metrics ?? null,
    confidenceByStage: explanation?.stages?.map((s) => ({
      agent: s.agentName,
      score: s.confidence?.score,
      decision: s.decision,
    })) ?? [],
    attentionPoints: explanation?.attentionPoints?.length ?? 0,
    error: final.error ?? null,
    coverage:
      final.traceOutput?.testSummary?.coveragePercentage ?? null,
    testCount: final.traceOutput?.testSummary?.totalTests ?? null,
    filesCreated: final.protoOutput?.metadata?.filesCreated ?? null,
  };
}

async function main() {
  const yamlPath = resolve(REPO_ROOT, 'docs', 'dogfooding', 'benchmark-set.yaml');
  const set = parseSimpleYaml(readFileSync(yamlPath, 'utf8'));
  const targets = args.problem
    ? set.problems.filter((p) => p.id === args.problem)
    : set.problems;
  if (targets.length === 0) {
    console.error(`No matching problem(s). Looked for: ${args.problem ?? '<all>'}`);
    process.exit(2);
  }
  if (args.dryRun) {
    console.log(JSON.stringify({ targets: targets.map((p) => p.id) }, null, 2));
    return;
  }
  const results = [];
  for (const p of targets) {
    console.log(`▶ Running ${p.id}: ${p.title}`);
    try {
      const r = await runProblem(p);
      console.log(`  ✓ ${r.finalStage} in ${(r.durationMs / 1000).toFixed(1)}s`);
      results.push(r);
    } catch (err) {
      console.log(`  ✗ ${err.message}`);
      results.push({
        problemId: p.id,
        pipelineId: null,
        finalStage: 'runner_error',
        durationMs: null,
        error: { message: err.message },
      });
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(REPO_ROOT, 'docs', 'dogfooding');
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `results-${args.label}-${stamp}.json`);
  writeFileSync(out, JSON.stringify({ label: args.label, ranAt: stamp, results }, null, 2));
  console.log(`\nReport written: ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
