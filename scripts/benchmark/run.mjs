#!/usr/bin/env node
/**
 * AKIS thesis benchmark runner — Q1 + Q3 data collection.
 *
 * For each problem in docs/dogfooding/benchmark-set.yaml, this script:
 *   1. Signs up a fresh test user against the local backend.
 *   2. Activates the user (UPDATE users SET status='active' …).
 *   3. Creates a pipeline with the problem's `idea` text.
 *   4. Polls until the pipeline reaches a terminal state OR awaiting_approval.
 *   5. Fetches GET /api/pipelines/:id/explanation for that pipeline.
 *   6. Records completion outcome, per-stage confidence, Critic findings
 *      (with their categories + severities), durations, and attention points.
 *
 * The runner intentionally STOPS at awaiting_approval. Going further (Proto)
 * needs a real GitHub PAT and is irrelevant to Q1+Q3 — those questions are
 * about the Scribe → Critic verification chain, which is what every run
 * exercises.
 *
 * Usage:
 *   node scripts/benchmark/run.mjs [--problem todo-001] [--label baseline]
 *                                  [--model claude-haiku-4-5-20251001]
 *
 * Output: docs/dogfooding/results-<label>-<stamp>.json
 *
 * Pre-req:
 *   - ./scripts/dev-up.sh has booted backend (:3000)
 *   - backend/.env has AI_PROVIDER=anthropic + a working AI_API_KEY
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const API = process.env.AKIS_API_BASE ?? 'http://localhost:3000';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per problem (Anthropic real run)

const { values: args } = parseArgs({
  options: {
    problem: { type: 'string' },
    label: { type: 'string', default: 'baseline' },
    model: { type: 'string', default: 'claude-haiku-4-5-20251001' },
    dryRun: { type: 'boolean', default: false },
  },
});

// ─── YAML (minimal) ────────────────────────────────────────────

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
      if (current) {
        if (inIdea && ideaBuf.length) current.idea = ideaBuf.join('\n').trim();
        root.problems.push(current);
      }
      current = {
        id: line.split(':')[1].trim(),
        clarifying_answers: {},
        acceptance_criteria: [],
      };
      inAcceptance = inAnswers = inIdea = false;
      ideaBuf = [];
      continue;
    }
    if (!current) continue;
    // Flush the in-progress idea block before transitioning to another
    // section — the original implementation switched flags without
    // committing the buffer, so `clarifying_answers:` immediately after
    // `idea: |` made the idea field disappear.
    const flushIdea = () => {
      if (inIdea && ideaBuf.length) {
        current.idea = ideaBuf.join('\n').trim();
      }
      inIdea = false;
      ideaBuf = [];
    };

    if (/^    title:/.test(line)) {
      flushIdea();
      current.title = line.split(/:(.+)/)[1].trim();
    } else if (/^    idea: \|/.test(line)) {
      flushIdea();
      inIdea = true;
      inAcceptance = inAnswers = false;
      ideaBuf = [];
    } else if (/^    clarifying_answers:/.test(line)) {
      flushIdea();
      inAnswers = true;
      inAcceptance = false;
    } else if (/^    acceptance_criteria:/.test(line)) {
      flushIdea();
      inAcceptance = true;
      inAnswers = false;
    } else if (inIdea && /^      /.test(line)) {
      ideaBuf.push(line.replace(/^      /, ''));
    } else if (inAnswers && /^      \w+:/.test(line)) {
      const [k, ...rest] = line.trim().split(':');
      current.clarifying_answers[k.trim()] = rest.join(':').trim().replace(/^"|"$/g, '');
    } else if (inAcceptance && /^      - /.test(line)) {
      current.acceptance_criteria.push(line.replace(/^      - /, '').replace(/^"|"$/g, ''));
    }
  }
  if (current) {
    if (inIdea && ideaBuf.length) current.idea = ideaBuf.join('\n').trim();
    root.problems.push(current);
  }
  return root;
}

// ─── Auth ──────────────────────────────────────────────────────

async function freshUserCookie(label) {
  const email = `bench+${label}+${Date.now()}@akis.local`;
  const password = 'BenchTest123!';
  const signup = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Bench Runner' }),
  });
  if (!signup.ok) throw new Error(`signup ${email}: ${signup.status} ${await signup.text()}`);

  // requireAuth gates on status='active'; mock email provider leaves new
  // signups as pending_verification, so we promote directly.
  execSync(
    `PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d akis_v2 -c "UPDATE users SET status='active' WHERE email = '${email}';" >/dev/null`,
  );

  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login ${email}: ${login.status}`);
  const setCookie = login.headers.get('set-cookie') ?? '';
  const sid = /akis_sid=([^;]+)/.exec(setCookie)?.[1];
  if (!sid) throw new Error('no akis_sid cookie returned');
  return { email, cookie: `akis_sid=${sid}` };
}

async function api(cookie, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ─── Per-problem run ──────────────────────────────────────────

async function runProblem(problem, cookie) {
  const startedAt = Date.now();
  const created = await api(cookie, '/api/pipelines/', {
    method: 'POST',
    body: JSON.stringify({ idea: problem.idea, model: args.model }),
  });
  const pipelineId = created.pipeline.id;
  console.log(`  pipeline ${pipelineId} created`);

  // Poll until terminal-ish
  const TERMINAL_STAGES = new Set([
    'completed',
    'completed_partial',
    'failed',
    'cancelled',
    'awaiting_approval',
  ]);
  const start = Date.now();
  let lastStage = null;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const { pipeline } = await api(cookie, `/api/pipelines/${pipelineId}`);
    if (pipeline.stage !== lastStage) {
      console.log(`  → stage: ${pipeline.stage}`);
      lastStage = pipeline.stage;
    }
    if (TERMINAL_STAGES.has(pipeline.stage)) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Fetch final state + explanation
  const { pipeline: finalPipeline } = await api(cookie, `/api/pipelines/${pipelineId}`);
  let explanation = null;
  try {
    const e = await api(cookie, `/api/pipelines/${pipelineId}/explanation`);
    explanation = e.explanation;
  } catch (err) {
    console.log(`  ! explanation fetch failed: ${err.message}`);
  }

  // Pull the raw critic output too — gives us category info that the
  // explanation surface drops to keep its UI lean.
  const intermediate = finalPipeline.intermediateState ?? {};
  const criticSpecOutput = intermediate.criticSpecOutput ?? null;

  return {
    problemId: problem.id,
    problemTitle: problem.title,
    pipelineId,
    finalStage: finalPipeline.stage,
    durationMs: Date.now() - startedAt,
    error: finalPipeline.error ?? null,
    scribe: explanation?.stages?.find((s) => s.agentName === 'scribe') ?? null,
    critic: explanation?.stages?.find((s) => s.agentName === 'critic') ?? null,
    attentionPoints: explanation?.attentionPoints ?? [],
    criticSpecOutput, // raw — has finding categories + severities
    overallNarrative: explanation?.overallNarrative ?? null,
  };
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const yamlPath = resolve(REPO_ROOT, 'docs', 'dogfooding', 'benchmark-set.yaml');
  const set = parseSimpleYaml(readFileSync(yamlPath, 'utf8'));
  const targets = args.problem
    ? set.problems.filter((p) => p.id === args.problem)
    : set.problems;
  if (targets.length === 0) {
    console.error(`No problems matched (looked for: ${args.problem ?? '<all>'})`);
    process.exit(2);
  }
  if (args.dryRun) {
    console.log(JSON.stringify({ targets: targets.map((p) => p.id), model: args.model }, null, 2));
    return;
  }

  console.log(`▶ benchmark — label=${args.label} model=${args.model} N=${targets.length}`);
  const results = [];
  for (const p of targets) {
    console.log(`\n▶ problem ${p.id}: ${p.title}`);
    let user;
    try {
      user = await freshUserCookie(args.label);
      console.log(`  user ${user.email}`);
      const r = await runProblem(p, user.cookie);
      console.log(`  ✓ ${r.finalStage} in ${(r.durationMs / 1000).toFixed(1)}s`);
      if (r.scribe?.confidence) {
        console.log(`    scribe confidence: ${r.scribe.confidence.score}%`);
      }
      if (r.critic?.confidence) {
        console.log(`    critic score: ${r.critic.confidence.score}% (${r.critic.decision})`);
      }
      if (r.criticSpecOutput?.findings?.length) {
        const cats = r.criticSpecOutput.findings.reduce((acc, f) => {
          acc[f.category] = (acc[f.category] ?? 0) + 1;
          return acc;
        }, {});
        console.log(`    critic findings by category: ${JSON.stringify(cats)}`);
      }
      results.push(r);
    } catch (err) {
      console.log(`  ✗ ${err.message}`);
      results.push({
        problemId: p.id,
        problemTitle: p.title,
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
  const outPath = resolve(outDir, `results-${args.label}-${stamp}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      { label: args.label, model: args.model, ranAt: stamp, results },
      null,
      2,
    ),
  );
  console.log(`\n📊 ${results.length} results → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
