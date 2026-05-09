#!/usr/bin/env node
/**
 * Q4 Calibration aggregator.
 *
 * Reads N rater JSONs (output of q4-rubric-form.html) and a Critic baseline
 * results JSON; emits markdown for the thesis chapter:
 *   - Per-spec manual normalized score (mean across raters) vs Critic score
 *   - Pearson r (manual mean × Critic) — descriptive only at N=5 specs
 *   - Sapma analizi: hangi spec'lerde manuel/Critic uyuştu, hangilerinde sapma
 *   - ASCII scatter sketch
 *
 * Usage:
 *   node scripts/benchmark/q4-aggregate.mjs <raters-dir> [<results-baseline.json>]
 *
 * Defaults:
 *   raters-dir = docs/dogfooding/q4-responses
 *   results    = docs/dogfooding/results-baseline-2026-05-07T11-32-30-706Z.json
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const RATERS_DIR = resolve(process.argv[2] ?? 'docs/dogfooding/q4-responses');
const BASELINE = resolve(
  process.argv[3] ??
    'docs/dogfooding/results-baseline-2026-05-07T11-32-30-706Z.json',
);

if (!existsSync(BASELINE)) {
  console.error(`Baseline file not found: ${BASELINE}`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

let files = [];
try {
  files = readdirSync(RATERS_DIR).filter((f) => f.endsWith('.json'));
} catch {
  console.error(`Cannot read ${RATERS_DIR}. Place rater JSONs there first.`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(
    `No JSONs in ${RATERS_DIR}. Have at least one rater download their form responses there.`,
  );
  process.exit(2);
}

const RATERS = files.map((f) => JSON.parse(readFileSync(resolve(RATERS_DIR, f), 'utf8')));
const N = RATERS.length;

const PROBLEM_IDS = baseline.results.map((r) => r.problemId);
const CRIT_BY_ID = Object.fromEntries(
  baseline.results.map((r) => [
    r.problemId,
    {
      title: r.problemTitle,
      criticScore: r.criticSpecOutput?.overallScore ?? null,
      criticApproved: r.criticSpecOutput?.approved ?? null,
      scribeScore: r.scribe?.confidence?.score ?? null,
    },
  ]),
);

// ─── Reshape: spec → array of normalized manual scores (one per rater) ───

function manualScoreForRater(rater, problemId) {
  const responses = (rater.responses ?? []).filter(
    (r) => r.problemId === problemId && r.score != null,
  );
  if (!responses.length) return null;
  const sum = responses.reduce((s, r) => s + r.score, 0);
  // Each criterion is 0-10 — total over N criteria. Normalize to %.
  const max = responses.length * 10;
  return { sum, max, normalizedPct: (sum / max) * 100, criteriaCount: responses.length };
}

const manualByProblem = {};
for (const pid of PROBLEM_IDS) {
  manualByProblem[pid] = [];
  for (const rater of RATERS) {
    const s = manualScoreForRater(rater, pid);
    if (s) manualByProblem[pid].push(s.normalizedPct);
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

function pearsonR(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

function fmt(v, digits = 1) {
  return v == null || Number.isNaN(v) ? '—' : v.toFixed(digits);
}

console.log(`# Q4 Kalibrasyon Analizi (N=${N} rater × ${PROBLEM_IDS.length} spec)`);
console.log(`Rater dir: \`${RATERS_DIR}\``);
console.log(`Baseline:  \`${BASELINE}\``);
console.log(`Files:     ${files.join(', ')}\n`);

// ─── 3.7.1 — Per-spec table

console.log('## 3.7.1 — Spec başına manuel skor vs Critic skoru\n');
console.log('| Spec | Critic skoru | Manuel ort | Manuel SD | Δ (Manuel − Critic) | Yön |');
console.log('|------|--------------|------------|-----------|---------------------|-----|');
const xs = []; // critic
const ys = []; // manual mean
const rows = [];
for (const pid of PROBLEM_IDS) {
  const c = CRIT_BY_ID[pid];
  const stats = meanSd(manualByProblem[pid] ?? []);
  if (c.criticScore != null && stats.mean != null) {
    xs.push(c.criticScore);
    ys.push(stats.mean);
  }
  const delta = c.criticScore != null && stats.mean != null
    ? stats.mean - c.criticScore
    : null;
  const dir =
    delta == null
      ? '—'
      : Math.abs(delta) < 5
        ? 'uyumlu'
        : delta > 0
          ? 'manuel daha cömert'
          : 'manuel daha sert';
  rows.push({ pid, c, stats, delta, dir });
  console.log(
    `| ${pid} | ${fmt(c.criticScore, 0)}% | ${fmt(stats.mean)}% | ${fmt(stats.sd)} | ${fmt(delta)} | ${dir} |`,
  );
}

// ─── 3.7.2 — Pearson r

console.log('\n## 3.7.2 — Korelasyon (Pearson r)\n');
const r = pearsonR(xs, ys);
const rText =
  r == null
    ? '—'
    : Math.abs(r) >= 0.7
      ? 'güçlü korelasyon'
      : Math.abs(r) >= 0.5
        ? 'orta korelasyon'
        : Math.abs(r) >= 0.3
          ? 'zayıf-orta korelasyon'
          : 'zayıf/yok';
const rSign = r == null ? '' : r > 0 ? 'pozitif' : 'negatif';
console.log(`- **n (spec çiftleri):** ${xs.length}`);
console.log(`- **Pearson r:** ${fmt(r, 3)} (${rSign} ${rText})`);
console.log(
  `- **Yorum (THESIS_FOCUS § 3 Q4):** ${
    r == null
      ? 'Hesaplanamadı (yetersiz veri).'
      : Math.abs(r) >= 0.7
        ? 'Critic skor ↔ insan değerlendirmesi güçlü uyum: kalibre.'
        : Math.abs(r) >= 0.4
          ? 'Orta uyum: Critic sinyal taşıyor ama kesin değil. Threshold ayarı düşünülebilir.'
          : Math.abs(r) >= 0.2
            ? 'Zayıf uyum: Critic skoru kalibrasyon istiyor; threshold tek başına karar için yeterli değil.'
            : 'Korelasyon yok: Critic skor ve insan yargısı bağımsız. Bu bir kalibrasyon sorunu.'
  }`,
);
console.log(`\n> N=${xs.length} küçük; Pearson r anlamlılık testi anlamlı sonuç vermez. "Small-N illustrative correlation" olarak raporlanır.`);

// ─── 3.7.3 — Scatter (ASCII)

console.log('\n## 3.7.3 — Scatter (ASCII gösterim)\n');
console.log('```');
console.log('       0%        25%        50%        75%       100%  manuel mean');
const W = 50; // columns 0..50 = 0..100%
const H = 11; // rows 0..10 = 100..0%  (top = high critic)
const grid = Array.from({ length: H }, () => Array.from({ length: W + 1 }, () => ' '));
for (let i = 0; i < xs.length; i++) {
  const cx = Math.round((ys[i] / 100) * W);
  const cy = Math.round(((100 - xs[i]) / 100) * (H - 1));
  if (cy >= 0 && cy < H && cx >= 0 && cx <= W) {
    const cur = grid[cy][cx];
    grid[cy][cx] = cur === ' ' ? String(i + 1) : '+';
  }
}
const yLabels = ['100%', '90%', '80%', '70%', '60%', '50%', '40%', '30%', '20%', '10%', '  0%'];
for (let row = 0; row < H; row++) {
  const yLab = yLabels[row];
  console.log(`${yLab} | ${grid[row].join('')}`);
}
console.log('     +' + '-'.repeat(W + 1));
console.log('       0%        25%        50%        75%       100%  manuel mean');
console.log('       (y ekseni = Critic skoru)');
console.log('```\n');
console.log('Noktalar: ' + rows
  .map((r, i) => `${i + 1}=${r.pid}`)
  .join(', '));

// ─── 3.7.4 — Sapma analizi

console.log('\n## 3.7.4 — Sapma analizi\n');
const aligned = rows.filter((r) => r.delta != null && Math.abs(r.delta) < 5);
const generous = rows.filter((r) => r.delta != null && r.delta >= 5);
const harsh = rows.filter((r) => r.delta != null && r.delta <= -5);

console.log(`- **Uyumlu (|Δ| < 5pt):** ${aligned.length}/${rows.length} — ${aligned.map((x) => x.pid).join(', ') || '—'}`);
console.log(`- **Manuel cömert (Δ ≥ +5pt; Critic gereksiz sert):** ${generous.length} — ${generous.map((x) => `${x.pid} (+${fmt(x.delta)})`).join(', ') || '—'}`);
console.log(`- **Manuel sert (Δ ≤ −5pt; Critic gereksiz cömert):** ${harsh.length} — ${harsh.map((x) => `${x.pid} (${fmt(x.delta)})`).join(', ') || '—'}`);

// Approval-decision check: did Critic's approve/reject align with manual's
// 80%-threshold? (matches the orchestrator's approval threshold ≥80%)
const APPROVE_THRESHOLD = 80;
console.log('\n### Onay kararı uyumu (Critic approved vs manual ≥80% eşiği)\n');
console.log('| Spec | Critic kararı | Manuel %≥80? | Uyum |');
console.log('|------|---------------|--------------|------|');
let agree = 0, total = 0;
for (const row of rows) {
  if (row.c.criticApproved == null || row.stats.mean == null) {
    console.log(`| ${row.pid} | — | — | (eksik) |`);
    continue;
  }
  const manualApprove = row.stats.mean >= APPROVE_THRESHOLD;
  const ok = row.c.criticApproved === manualApprove;
  if (ok) agree++;
  total++;
  console.log(
    `| ${row.pid} | ${row.c.criticApproved ? 'onaylandı' : 'reddedildi'} | ${manualApprove ? 'evet' : 'hayır'} | ${ok ? '✓' : '✗'} |`,
  );
}
if (total > 0) {
  console.log(`\nKarar uyumu: ${agree}/${total} = ${((agree / total) * 100).toFixed(0)}%`);
}

// ─── 3.7.5 — Rater notes (qualitative)

console.log('\n## 3.7.5 — Rater notları (niteliksel)\n');
let anyNotes = false;
for (const rater of RATERS) {
  const id = rater.demographics?.raterId ?? '(anon)';
  const c = (rater.comment ?? '').trim();
  if (c) {
    anyNotes = true;
    console.log(`- **${id} (genel):** ${c}`);
  }
  for (const [pid, note] of Object.entries(rater.notes ?? {})) {
    if (note.trim()) {
      anyNotes = true;
      console.log(`- **${id} → ${pid}:** ${note.trim()}`);
    }
  }
}
if (!anyNotes) console.log('_Açık uçlu yorum yok._');

console.log(`\n---\n*Generated ${new Date().toISOString()} — N raters: ${N}, n specs paired: ${xs.length}.*`);
