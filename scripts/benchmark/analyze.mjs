#!/usr/bin/env node
/**
 * AKIS benchmark analyzer — Q1 + Q3 thesis tables.
 *
 * Reads docs/dogfooding/results-<label>-*.json, produces:
 *   - Per-problem completion table (Q1)
 *   - Per-stage confidence summary (Q1)
 *   - Critic finding category aggregate (Q3)
 *   - Approval rate
 *
 * Output: prints markdown tables to stdout. Pipe to a file or paste
 * into docs/learnings/benchmark-2026-may.md.
 *
 * Usage:
 *   node scripts/benchmark/analyze.mjs docs/dogfooding/results-baseline-*.json
 *   node scripts/benchmark/analyze.mjs --label baseline
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const { values, positionals } = parseArgs({
  options: {
    label: { type: 'string' },
  },
  allowPositionals: true,
});

function pickInputFile() {
  if (positionals.length > 0) return resolve(positionals[0]);
  const dir = resolve(REPO_ROOT, 'docs', 'dogfooding');
  const matches = readdirSync(dir)
    .filter((f) => f.startsWith(`results-${values.label ?? 'baseline'}-`))
    .sort();
  if (matches.length === 0) {
    throw new Error(`No results file found for label=${values.label ?? 'baseline'}`);
  }
  return resolve(dir, matches[matches.length - 1]); // most recent
}

const file = pickInputFile();
const report = JSON.parse(readFileSync(file, 'utf8'));
const results = report.results ?? [];

console.log(`# Benchmark analysis — ${report.label} (${report.model})`);
console.log(`Source: \`${file.split('/').slice(-3).join('/')}\``);
console.log(`Ran at: ${report.ranAt}\n`);

// ─── Q1: Per-problem completion table ─────────────────────────

console.log('## Q1.1 — Per-problem outcome\n');
console.log('| Problem | Final stage | Duration | Scribe conf | Critic score | Decision |');
console.log('|---------|-------------|----------|-------------|--------------|----------|');
for (const r of results) {
  const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
  const sConf = r.scribe?.confidence?.score ?? '—';
  const cScore = r.critic?.confidence?.score ?? '—';
  const decision = r.critic?.decision ?? r.error?.message ?? '—';
  console.log(`| ${r.problemId} | ${r.finalStage} | ${dur} | ${sConf}% | ${cScore}% | ${decision} |`);
}

// ─── Q1.2: Confidence summary ─────────────────────────────────

const scribeScores = results.map((r) => r.scribe?.confidence?.score).filter(Number.isFinite);
const criticScores = results.map((r) => r.critic?.confidence?.score).filter(Number.isFinite);
const avg = (a) => (a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : '—');
const min = (a) => (a.length ? Math.min(...a) : '—');
const max = (a) => (a.length ? Math.max(...a) : '—');

console.log('\n## Q1.2 — Confidence summary across runs\n');
console.log('| Stage | N | Mean | Min | Max |');
console.log('|-------|---|------|-----|-----|');
console.log(`| Scribe | ${scribeScores.length} | ${avg(scribeScores)}% | ${min(scribeScores)}% | ${max(scribeScores)}% |`);
console.log(`| Critic (spec) | ${criticScores.length} | ${avg(criticScores)}% | ${min(criticScores)}% | ${max(criticScores)}% |`);

// ─── Q1.3: Approval rate ──────────────────────────────────────

const approved = results.filter((r) => r.critic?.decision === 'Spec onaylandi').length;
const rejected = results.filter((r) => r.critic?.decision === 'Spec reddedildi').length;
const pct = results.length ? Math.round((approved / results.length) * 100) : 0;
console.log(`\n**Critic approval rate:** ${approved}/${results.length} = %${pct} onaylandı, ${rejected} reddedildi.\n`);

// ─── Q3: Finding categories aggregate ─────────────────────────

const catCounts = {};
const sevCounts = {};
const findingExamples = {}; // category → [example descriptions]
for (const r of results) {
  const findings = r.criticSpecOutput?.findings ?? [];
  for (const f of findings) {
    catCounts[f.category] = (catCounts[f.category] ?? 0) + 1;
    sevCounts[f.severity] = (sevCounts[f.severity] ?? 0) + 1;
    if (!findingExamples[f.category]) findingExamples[f.category] = [];
    if (findingExamples[f.category].length < 1) {
      findingExamples[f.category].push(f.description);
    }
  }
}
const totalFindings = Object.values(catCounts).reduce((s, n) => s + n, 0);

console.log('## Q3 — Critic finding categories aggregate\n');
console.log('| Category | Frequency | Share | Example |');
console.log('|----------|-----------|-------|---------|');
const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
for (const [cat, n] of sortedCats) {
  const share = totalFindings ? `%${Math.round((n / totalFindings) * 100)}` : '—';
  const ex = findingExamples[cat]?.[0]?.slice(0, 80).replace(/\|/g, '\\|') ?? '—';
  const exTrunc = findingExamples[cat]?.[0] && findingExamples[cat][0].length > 80 ? `${ex}…` : ex;
  console.log(`| ${cat} | ${n} | ${share} | ${exTrunc} |`);
}
console.log(`| **Total** | **${totalFindings}** | **100%** | |`);

console.log('\n## Q3.2 — Finding severity distribution\n');
console.log('| Severity | Count | Share |');
console.log('|----------|-------|-------|');
for (const sev of ['critical', 'major', 'minor', 'info']) {
  const n = sevCounts[sev] ?? 0;
  const share = totalFindings ? `%${Math.round((n / totalFindings) * 100)}` : '—';
  console.log(`| ${sev} | ${n} | ${share} |`);
}
console.log(`| **Total** | **${totalFindings}** | **100%** |`);

// ─── Footer: durations ────────────────────────────────────────

const durs = results.map((r) => r.durationMs).filter(Number.isFinite);
const totalSec = durs.reduce((s, x) => s + x, 0) / 1000;
console.log(`\n**Run summary:** ${results.length} pipelines, total ${totalSec.toFixed(1)}s wall clock, mean ${(totalSec / results.length).toFixed(1)}s per problem (${report.model}).`);
