#!/usr/bin/env node
/**
 * q4-capture-specs.mjs — populate docs/dogfooding/q4-specs-snapshot.json
 * with `specBodyMarkdown` per spec by reading `scribe_output.spec` from
 * Postgres for each pipelineId listed in the snapshot.
 *
 * The Q4 rubric form needs the actual spec body to be human-scoreable
 * (metadata alone — story/AC counts — doesn't carry enough signal).
 * Critic score/decision/findings are deliberately NOT copied in: the
 * form is bias-free by construction.
 *
 * Usage:
 *   node scripts/benchmark/q4-capture-specs.mjs
 *     # default: reads existing snapshot, fills specBodyMarkdown, writes back
 *
 *   node scripts/benchmark/q4-capture-specs.mjs --check
 *     # dry-run: reports which specs already have body / which are missing
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const SNAPSHOT_PATH = resolve(REPO, 'docs/dogfooding/q4-specs-snapshot.json');

function fetchSpec(pipelineId) {
  const sql = `SELECT scribe_output->'spec' FROM pipelines WHERE id='${pipelineId}';`;
  const out = execSync(
    `docker exec akis-dev-db psql -U postgres -d akis_v2 -t -A -c "${sql}"`,
    { encoding: 'utf-8' },
  ).trim();
  if (!out || out === '') return null;
  return JSON.parse(out);
}

function renderAC(ac) {
  // AC objects come in two shapes: plain string, or { id, given, when, then }.
  if (typeof ac === 'string') return ac;
  if (ac && typeof ac === 'object') {
    if (ac.given || ac.when || ac.then) {
      const parts = [];
      if (ac.given) parts.push(`**Verili**: ${ac.given}`);
      if (ac.when) parts.push(`**Durum**: ${ac.when}`);
      if (ac.then) parts.push(`**Sonuç**: ${ac.then}`);
      return parts.join(' · ');
    }
    if (ac.description) return ac.description;
  }
  return JSON.stringify(ac);
}

function renderMarkdown(spec) {
  if (!spec) return null;
  const lines = [];
  lines.push(`# ${spec.title || '(başlıksız)'}`);
  lines.push('');
  if (spec.problemStatement) {
    lines.push('## Problem');
    lines.push(spec.problemStatement);
    lines.push('');
  }
  if (Array.isArray(spec.userStories) && spec.userStories.length) {
    lines.push('## Kullanıcı hikâyeleri');
    spec.userStories.forEach((s, i) => {
      const persona = s.persona || s.asA || '';
      const action = s.action || s.iWant || '';
      const benefit = s.benefit || s.soThat || '';
      lines.push(`${i + 1}. **${persona}** olarak — ${action}, çünkü ${benefit}.`);
      if (Array.isArray(s.acceptanceCriteria) && s.acceptanceCriteria.length) {
        s.acceptanceCriteria.forEach((ac) => lines.push(`   - ${renderAC(ac)}`));
      }
    });
    lines.push('');
  }
  // Some specs hoist a global acceptanceCriteria
  if (Array.isArray(spec.acceptanceCriteria) && spec.acceptanceCriteria.length) {
    lines.push('## Kabul kriterleri (global)');
    spec.acceptanceCriteria.forEach((ac) => lines.push(`- ${renderAC(ac)}`));
    lines.push('');
  }
  if (Array.isArray(spec.outOfScope) && spec.outOfScope.length) {
    lines.push('## Kapsam dışı');
    spec.outOfScope.forEach((x) => lines.push(`- ${x}`));
    lines.push('');
  }
  if (spec.technicalConstraints) {
    lines.push('## Teknik kısıtlar');
    const tc = spec.technicalConstraints;
    if (typeof tc === 'string') {
      lines.push(tc);
    } else if (Array.isArray(tc)) {
      tc.forEach((x) => lines.push(`- ${x}`));
    } else if (typeof tc === 'object') {
      if (tc.stack) lines.push(`- Stack: ${tc.stack}`);
      if (Array.isArray(tc.integrations)) lines.push(`- Entegrasyonlar: ${tc.integrations.join(', ')}`);
      Object.entries(tc).forEach(([k, v]) => {
        if (k === 'stack' || k === 'integrations') return;
        lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      });
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function main() {
  const dryRun = process.argv.includes('--check');
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
  let filled = 0;
  let alreadyHad = 0;
  let missing = 0;
  for (const item of snapshot.specs) {
    if (item.specBodyMarkdown) {
      alreadyHad++;
      continue;
    }
    if (!item.pipelineId) {
      console.warn(`[${item.problemId}] no pipelineId, skipping`);
      missing++;
      continue;
    }
    const spec = fetchSpec(item.pipelineId);
    if (!spec) {
      console.warn(`[${item.problemId}] DB returned null for ${item.pipelineId}`);
      missing++;
      continue;
    }
    const md = renderMarkdown(spec);
    if (!md) {
      missing++;
      continue;
    }
    if (!dryRun) item.specBodyMarkdown = md;
    filled++;
    console.log(`[${item.problemId}] filled (${md.length} chars)`);
  }
  if (!dryRun) {
    snapshot.note = (snapshot.note || '') + ' (specBodyMarkdown filled by q4-capture-specs.mjs)';
    snapshot.capturedAt = new Date().toISOString();
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
    console.log(`\n✅ wrote ${SNAPSHOT_PATH} — ${filled} filled, ${alreadyHad} already had, ${missing} missing`);
  } else {
    console.log(`\nDry-run: ${filled} would fill, ${alreadyHad} already had, ${missing} missing`);
  }
}

main();
