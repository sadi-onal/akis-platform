// Tests for bakkal-language audit script.
// Uses node:test (no jest/vitest; mirrors backend convention).
//
// Run:
//   node --test scripts/lint/__tests__/bakkal-language.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadGlossary,
  scanContent,
  exitCodeFor,
  summarize,
} from '../bakkal-language.mjs';

const glossary = loadGlossary();

test('glossary loads and contains expected core terms', () => {
  assert.ok(glossary.length >= 12, 'glossary should have at least 12 entries');
  const terms = new Set(glossary.map((g) => g.term.toLowerCase()));
  for (const expected of ['repo', 'repository', 'pull request', 'commit', 'branch', 'scaffold']) {
    assert.ok(terms.has(expected), `missing core term: ${expected}`);
  }
  // Severity values must be one of info | warn | error.
  for (const g of glossary) {
    assert.ok(['info', 'warn', 'error'].includes(g.severity), `bad severity: ${g.severity}`);
  }
});

test('detects "repo" in a sample TSX string', () => {
  const sample = `
import React from 'react';
export function X() {
  return <div>Yeni bir repo açıyoruz</div>;
}
`;
  const findings = scanContent('/x/sample.tsx', sample, glossary);
  const repoHits = findings.filter((f) => f.canonical === 'repo');
  assert.equal(repoHits.length, 1);
  assert.equal(repoHits[0].severity, 'warn');
  assert.equal(repoHits[0].suggested, 'depo');
});

test('does not match "repo" inside a longer word like "report" or "reposed"', () => {
  const sample = `<div>Bu bir öneri raporudur, report değil ama repository var</div>`;
  const findings = scanContent('/x/sample.tsx', sample, glossary);
  // We expect "repository" to match (exact term), but not "report".
  const terms = findings.map((f) => f.canonical);
  assert.ok(terms.includes('repository'));
  assert.ok(!terms.includes('repo') || findings.find((f) => f.canonical === 'repo')?.term === 'repo');
  // Ensure "report" did not produce a "repo" hit.
  const reportLine = `<div>Bu bir rapor — report — burada</div>`;
  const f2 = scanContent('/x/r.tsx', reportLine, glossary);
  assert.equal(f2.length, 0, 'report should not match repo');
});

test('multi-word terms beat single-word terms (pull request > PR)', () => {
  const sample = `<div>Bir pull request açıldı, ardından PR onaylandı.</div>`;
  const findings = scanContent('/x/sample.tsx', sample, glossary);
  const canon = findings.map((f) => f.canonical);
  assert.ok(canon.includes('pull request'), 'expected pull request hit');
  assert.ok(canon.includes('PR'), 'expected PR hit');
});

test('skips lines with `// allow:repo`', () => {
  const sample = `<div>Yeni bir repo açıyoruz öyle gerekiyor</div> // allow:repo`;
  const findings = scanContent('/x/sample.tsx', sample, glossary);
  const repoHits = findings.filter((f) => f.canonical === 'repo');
  assert.equal(repoHits.length, 0, 'allow:repo should suppress repo hit');
});

test('allow comma list silences multiple terms', () => {
  const sample = `<div>repo ve commit yapıyoruz</div> // allow:repo,commit`;
  const findings = scanContent('/x/sample.tsx', sample, glossary);
  assert.equal(findings.length, 0, 'allow list should silence both');
});

test('non-Turkish lines in tsx are skipped (heuristic)', () => {
  const sample = `import { useRepo } from './repo'; // pure code`;
  const findings = scanContent('/x/sample.tsx', sample, glossary);
  assert.equal(findings.length, 0, 'lines without Turkish chars are skipped in tsx');
});

test('json files are scanned regardless of Turkish chars', () => {
  const sample = `{"key": "Use a fresh repo for this commit."}`;
  const findings = scanContent('/x/tr.json', sample, glossary);
  const canon = findings.map((f) => f.canonical);
  assert.ok(canon.includes('repo'));
  assert.ok(canon.includes('commit'));
});

test('json keys are NOT scanned (e.g. auth.oauth.error.foo does not flag oauth)', () => {
  const sample = `  "auth.oauth.error.accountDisabled": "Hesabınız devre dışı bırakılmış."`;
  const findings = scanContent('/x/tr.json', sample, glossary);
  const canon = findings.map((f) => f.canonical);
  assert.ok(!canon.includes('OAuth'), 'oauth in JSON key should not be flagged');
});

test('json values ARE scanned (oauth in user-visible value still matches)', () => {
  const sample = `  "x.y": "OAuth ile devam et"`;
  const findings = scanContent('/x/tr.json', sample, glossary);
  const canon = findings.map((f) => f.canonical);
  assert.ok(canon.includes('OAuth'), 'OAuth in JSON value should be flagged');
});

test('exit code is 1 when warn finding present, 0 with info-only', () => {
  const warnish = [{ severity: 'warn' }, { severity: 'info' }];
  assert.equal(exitCodeFor(warnish), 1);

  const infoOnly = [{ severity: 'info' }, { severity: 'info' }];
  assert.equal(exitCodeFor(infoOnly), 0);

  assert.equal(exitCodeFor([]), 0, 'empty findings = exit 0');
});

test('summarize returns counts by severity and term', () => {
  const sample = `<div>repo, repo, pull request ve commit yapıldı</div>`;
  const findings = scanContent('/x/sample.tsx', sample, glossary);
  const { bySeverity, topTerms } = summarize(findings);
  assert.ok(bySeverity.warn >= 3);
  const topTerm = topTerms[0][0];
  assert.equal(topTerm, 'repo');
  assert.equal(topTerms[0][1], 2);
});

test('end-to-end: temp file with mixed terms produces correct summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bakkal-lang-'));
  const tsx = join(dir, 'Sample.tsx');
  writeFileSync(
    tsx,
    `
export function S() {
  return (
    <>
      <p>Yeni bir repo oluşturuyoruz.</p>
      <p>Pipeline başlıyor — Akış sürüyor.</p>
      <p>İşte commit kaydedildi.</p>
      <p>İskelet hazır</p> {/* allow:scaffold (none in this line anyway) */}
    </>
  );
}
`,
    'utf8'
  );
  const tr = join(dir, 'tr.json');
  writeFileSync(tr, JSON.stringify({ a: 'pull request açıldı' }), 'utf8');

  // We import scanFile dynamically for path-correct read.
  return import('../bakkal-language.mjs').then(({ scanFile }) => {
    const all = [...scanFile(tsx, glossary), ...scanFile(tr, glossary)];
    const canon = all.map((f) => f.canonical);
    assert.ok(canon.includes('repo'));
    assert.ok(canon.includes('commit'));
    assert.ok(canon.includes('pipeline'));
    assert.ok(canon.includes('pull request'));
    assert.equal(exitCodeFor(all), 1);
  });
});
