#!/usr/bin/env node
/**
 * Q2 Likert aggregator.
 *
 * Reads N participant JSONs (output of q2-likert-form.html) and emits
 * markdown tables for the thesis chapter:
 *   - Per-question A vs B mean (paired)
 *   - Per-problem A vs B mean
 *   - Demographic distribution
 *   - Sign of difference (B − A) for each question (descriptive — no
 *     real significance test claim with N≤5)
 *
 * Usage:
 *   node scripts/benchmark/q2-aggregate.mjs <participants-dir>
 *   node scripts/benchmark/q2-aggregate.mjs docs/dogfooding/q2-responses/
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'docs/dogfooding/q2-responses');
let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.json'));
} catch {
  console.error(`Cannot read ${dir}. Place participant JSONs there first.`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`No JSONs in ${dir}. Have at least one participant download their form responses there.`);
  process.exit(2);
}

const PARTICIPANTS = files.map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')));
const N = PARTICIPANTS.length;

// ─── Reshape: { problem, condition, q, scores[] } ─────────────

const QUESTIONS = ['q1', 'q2', 'q3'];
const Q_TEXT = {
  q1: 'Bu çıktıya güvenebileceğimi hissediyorum.',
  q2: 'Eğer bir hata olsaydı, ekranda gördüklerimden onu fark edebilirdim.',
  q3: 'Bu pipeline\'ı kendim için yararlı buluyorum.',
};
const PROBLEMS = ['todo-001', 'calc-002', 'currency-003', 'blog-004', 'qr-005'];

function bucketKey(probId, cond, qid) {
  return `${probId}::${cond}::${qid}`;
}

const buckets = new Map();
for (const p of PARTICIPANTS) {
  for (const r of p.responses ?? []) {
    if (r.score == null) continue;
    const k = bucketKey(r.problemId, r.condition, r.questionId);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r.score);
  }
}

function meanSd(arr) {
  if (!arr || arr.length === 0) return { n: 0, mean: null, sd: null };
  const n = arr.length;
  const mean = arr.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { n, mean, sd: null };
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  return { n, mean, sd: Math.sqrt(variance) };
}

function fmt(v, digits = 2) {
  return v == null ? '—' : v.toFixed(digits);
}

console.log(`# Q2 Likert aggregate (N=${N} katılımcı)`);
console.log(`Source: \`${dir}\``);
console.log(`Files: ${files.join(', ')}\n`);

// ─── Per-question A vs B (averaged across all problems × participants)

console.log('## Q2.1 — Soru bazlı A vs B (tüm problem ve katılımcı ortalaması)\n');
console.log('| # | Soru | A ort | A SD | B ort | B SD | Δ (B−A) |');
console.log('|---|------|-------|------|-------|------|---------|');
for (const qid of QUESTIONS) {
  const aScores = [];
  const bScores = [];
  for (const prob of PROBLEMS) {
    const a = buckets.get(bucketKey(prob, 'A', qid)) ?? [];
    const b = buckets.get(bucketKey(prob, 'B', qid)) ?? [];
    aScores.push(...a);
    bScores.push(...b);
  }
  const a = meanSd(aScores);
  const b = meanSd(bScores);
  const delta = a.mean != null && b.mean != null ? b.mean - a.mean : null;
  console.log(
    `| ${qid} | ${Q_TEXT[qid].slice(0, 50)} | ${fmt(a.mean)} | ${fmt(a.sd)} | ${fmt(b.mean)} | ${fmt(b.sd)} | ${delta != null ? (delta > 0 ? '+' : '') + delta.toFixed(2) : '—'} |`
  );
}

// ─── Per-problem A vs B (overall — average over questions)

console.log('\n## Q2.2 — Problem bazlı genel ortalama (sorular birleşik)\n');
console.log('| Problem | A ort | B ort | Δ |');
console.log('|---------|-------|-------|---|');
for (const prob of PROBLEMS) {
  const aScores = [];
  const bScores = [];
  for (const qid of QUESTIONS) {
    aScores.push(...(buckets.get(bucketKey(prob, 'A', qid)) ?? []));
    bScores.push(...(buckets.get(bucketKey(prob, 'B', qid)) ?? []));
  }
  const a = meanSd(aScores);
  const b = meanSd(bScores);
  const delta = a.mean != null && b.mean != null ? b.mean - a.mean : null;
  console.log(
    `| ${prob} | ${fmt(a.mean)} | ${fmt(b.mean)} | ${delta != null ? (delta > 0 ? '+' : '') + delta.toFixed(2) : '—'} |`
  );
}

// ─── Sign-of-difference (descriptive — no significance with N ≤ 5)

console.log('\n## Q2.3 — Yön analizi (paired sign — B>A=+, B<A=−, B=A=0)\n');
console.log('| Soru | + (B daha yüksek) | − (A daha yüksek) | 0 (eşit) | Yorum |');
console.log('|------|-------------------|-------------------|----------|-------|');
for (const qid of QUESTIONS) {
  let plus = 0, minus = 0, equal = 0;
  for (const p of PARTICIPANTS) {
    for (const prob of PROBLEMS) {
      const aResp = (p.responses ?? []).find(
        (r) => r.problemId === prob && r.condition === 'A' && r.questionId === qid && r.score != null,
      );
      const bResp = (p.responses ?? []).find(
        (r) => r.problemId === prob && r.condition === 'B' && r.questionId === qid && r.score != null,
      );
      if (!aResp || !bResp) continue;
      if (bResp.score > aResp.score) plus++;
      else if (bResp.score < aResp.score) minus++;
      else equal++;
    }
  }
  const total = plus + minus + equal;
  const dominant =
    plus > minus + equal
      ? 'B baskın'
      : minus > plus + equal
        ? 'A baskın'
        : equal > plus + minus
          ? 'fark yok'
          : 'karışık';
  console.log(`| ${qid} | ${plus} | ${minus} | ${equal} | ${dominant} (n=${total}) |`);
}

// ─── Demographics

console.log('\n## Q2.4 — Demografik özet\n');
const aiTool = {};
const age = {};
const exp = [];
for (const p of PARTICIPANTS) {
  const d = p.demographics ?? {};
  if (d.aiTool) aiTool[d.aiTool] = (aiTool[d.aiTool] ?? 0) + 1;
  if (d.ageBand) age[d.ageBand] = (age[d.ageBand] ?? 0) + 1;
  if (d.experience && /^\d+/.test(d.experience)) exp.push(parseFloat(d.experience));
}
console.log(`- **N:** ${N}`);
const avgExp = exp.length ? (exp.reduce((s, x) => s + x, 0) / exp.length).toFixed(1) : '—';
console.log(`- **Ortalama yazılım deneyimi:** ${avgExp} yıl`);
console.log(`- **AI araç kullanımı dağılımı:** ${Object.entries(aiTool).map(([k, v]) => `${k} (${v})`).join(', ') || '—'}`);
console.log(`- **Yaş bantları:** ${Object.entries(age).map(([k, v]) => `${k} (${v})`).join(', ') || '—'}`);

// ─── Sample comments

console.log('\n## Q2.5 — Açık uçlu yorumlar\n');
for (const p of PARTICIPANTS) {
  const c = (p.comment ?? '').trim();
  const id = p.demographics?.participantId ?? '(anon)';
  if (c) console.log(`- **${id}:** ${c}`);
}

console.log(`\n---\n*Generated ${new Date().toISOString()} — N=${N}.*`);
