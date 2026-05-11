#!/usr/bin/env node
// Bakkal-language audit — F-12 / NFR-5.1
//
// Scans i18n catalogue + UI strings for tech jargon and reports inconsistencies
// against the bakkal-language glossary (docs/product/02-ux.md § 6).
//
// Usage:
//   node scripts/lint/bakkal-language.mjs            # default scan (frontend only)
//   node scripts/lint/bakkal-language.mjs --all      # include backend prompts
//   node scripts/lint/bakkal-language.mjs --json     # machine-readable output
//   node scripts/lint/bakkal-language.mjs --quiet    # only show summary
//
// Exit code: 0 if findings are info-only (or none), 1 if any warn-or-higher hit.
//
// Per-line opt-out: append `// allow:term1,term2` to silence those terms on that line.
//
// No external dependencies — Node built-ins only.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const SEVERITY_RANK = { info: 0, warn: 1, error: 2 };
const FAIL_THRESHOLD = SEVERITY_RANK.warn;

// ---------- glossary ----------

export function loadGlossary(path = join(__dirname, 'bakkal-glossary.json')) {
  const raw = readFileSync(path, 'utf8');
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error('Glossary must be an array');
  for (const entry of list) {
    if (typeof entry.term !== 'string' || typeof entry.suggested !== 'string') {
      throw new Error(`Invalid glossary entry: ${JSON.stringify(entry)}`);
    }
    if (!(entry.severity in SEVERITY_RANK)) {
      throw new Error(`Invalid severity for term "${entry.term}": ${entry.severity}`);
    }
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      throw new Error(`Invalid note for term "${entry.term}": must be string`);
    }
  }
  // Sort by length DESC so multi-word terms ("pull request") match before "PR".
  list.sort((a, b) => b.term.length - a.term.length);
  return list;
}

// ---------- file discovery ----------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.turbo', '.cache', '__snapshots__', 'migrations', 'playwright-report',
  '.playwright', '.playwright-mcp', 'screenshots', 'test-results',
]);

function walk(dir, predicate, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, predicate, out);
    else if (st.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

export function discoverFiles(root = REPO_ROOT, { all = false } = {}) {
  const files = [];

  // tr.json (and tr.ts if present)
  const i18nDir = join(root, 'frontend', 'src', 'i18n', 'locales');
  if (existsSync(i18nDir)) {
    for (const f of readdirSync(i18nDir)) {
      if (f === 'tr.json' || f === 'tr.ts') {
        files.push(join(i18nDir, f));
      }
    }
  }
  const altI18nDir = join(root, 'frontend', 'src', 'i18n');
  if (existsSync(altI18nDir)) {
    for (const f of readdirSync(altI18nDir)) {
      if (f === 'tr.json' || f === 'tr.ts') {
        files.push(join(altI18nDir, f));
      }
    }
  }

  // frontend tsx/ts (UI strings only — we'll filter to inline strings inside files)
  const fe = join(root, 'frontend', 'src');
  if (existsSync(fe)) {
    files.push(
      ...walk(fe, (p) => /\.tsx$/.test(p) && !p.endsWith('.test.tsx') && !p.endsWith('.spec.tsx'))
    );
  }

  if (all) {
    // backend prompts / templates that surface to the user
    const promptDirs = [
      join(root, 'backend', 'src', 'pipeline', 'templates'),
      join(root, 'backend', 'src', 'pipeline', 'agents'),
      join(root, 'backend', 'src', 'agents'),
      // F-12 Phase 3: cover system-prompt builders too. Most strings here
      // are AI-facing English, but the heuristic Turkish-character filter
      // skips them — only any user-facing copy that surfaces (e.g. a
      // Turkish-tagged log line) will be flagged.
      join(root, 'backend', 'src', 'services', 'ai'),
    ];
    for (const d of promptDirs) {
      if (existsSync(d)) {
        files.push(...walk(d, (p) => /\.(ts|md|txt)$/.test(p) && !p.endsWith('.test.ts') && !p.endsWith('.spec.ts')));
      }
    }
  }

  return [...new Set(files)];
}

// ---------- scanner ----------

// Build a single regex per glossary, with longest-first alternation,
// using word boundaries that work for both ASCII and most punctuation.
// We compile case-insensitive but case-flag the term for reporting.
function buildScannerRegex(glossary) {
  const escaped = glossary.map((g) =>
    g.term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  );
  // Word-ish boundary that allows Turkish letters but treats them as boundaries:
  // we use lookarounds excluding ASCII word chars (no Turkish-specific letters)
  // because all glossary terms are ASCII English words. This keeps "report" from
  // matching "PR" inside "report".
  const pattern = `(?<![A-Za-z0-9_])(?:${escaped.join('|')})(?![A-Za-z0-9_])`;
  return new RegExp(pattern, 'gi');
}

const ALLOW_LINE_RE = /\/\/\s*allow\s*:\s*([^*\n]+?)(?:\s*\*\/)?\s*$/i;

function getAllowedTerms(line) {
  const m = ALLOW_LINE_RE.exec(line);
  if (!m) return new Set();
  return new Set(m[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
}

// For .tsx files, we want to focus on user-visible strings, not e.g. import
// names or variable identifiers. Heuristic:
//   - text inside JSX between `>` and `<` that contains a non-ASCII char (Turkish)
//   - string literals after specific JSX prop names (placeholder, aria-label,
//     title, label, alt) or t('...') / i18n keys with Turkish content
//   - top-level string literals in obvious user-visible contexts
// Using a heuristic line filter rather than a real parser: each line is kept
// if it contains at least one Turkish-specific character (ç, ş, ğ, ü, ö, ı, İ)
// — this strongly correlates with user-facing copy and excludes pure code.
const TURKISH_CHAR_RE = /[çÇşŞğĞüÜöÖıİ]/;

function isUserVisibleLine(filePath, line) {
  if (filePath.endsWith('.json')) return true;
  // For .tsx/.ts, require a Turkish character on the line — bakkal copy only.
  return TURKISH_CHAR_RE.test(line);
}

// For JSON i18n files we only want to lint the *value* part of `"key": "value"`,
// not the dotted key (where "auth.oauth.error.accountDisabled" would falsely
// trigger an "OAuth" hit).
//
// Strategy: in a flat JSON locale file each line is either a key/value pair or
// punctuation (`{`, `}`, `,`). When the line has the shape
//     "<key>": "<value>"<,?>
// we replace the key portion with spaces so its column offsets stay stable.
const JSON_KEY_VALUE_RE = /^(\s*")([^"\\]*(?:\\.[^"\\]*)*)("\s*:\s*")/;

function maskJsonKey(line) {
  const m = JSON_KEY_VALUE_RE.exec(line);
  if (!m) return line;
  const before = m[1];
  const key = m[2];
  const sep = m[3];
  const replaced = before + ' '.repeat(key.length) + sep;
  return replaced + line.slice(m[0].length);
}

export function scanContent(filePath, content, glossary, regex = buildScannerRegex(glossary)) {
  const findings = [];
  const glossaryByLower = new Map(glossary.map((g) => [g.term.toLowerCase(), g]));
  const lines = content.split(/\r?\n/);
  const isJson = filePath.endsWith('.json');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineForScan = isJson ? maskJsonKey(rawLine) : rawLine;
    if (!isUserVisibleLine(filePath, lineForScan)) continue;

    const allowed = getAllowedTerms(rawLine);
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(lineForScan)) !== null) {
      const matchedText = match[0];
      const lower = matchedText.toLowerCase();
      const entry = glossaryByLower.get(lower);
      if (!entry) continue;
      if (allowed.has(lower)) continue;

      findings.push({
        file: filePath,
        line: i + 1,
        column: match.index + 1,
        term: matchedText,
        canonical: entry.term,
        severity: entry.severity,
        suggested: entry.suggested,
        note: entry.note,
        snippet: rawLine.trim().slice(0, 160),
      });
    }
  }
  return findings;
}

export function scanFile(filePath, glossary, regex) {
  let content;
  try { content = readFileSync(filePath, 'utf8'); }
  catch { return []; }
  return scanContent(filePath, content, glossary, regex);
}

// ---------- runner ----------

export function runAudit({ root = REPO_ROOT, all = false } = {}) {
  const glossary = loadGlossary();
  const regex = buildScannerRegex(glossary);
  const files = discoverFiles(root, { all });

  const findings = [];
  for (const f of files) {
    findings.push(...scanFile(f, glossary, regex));
  }
  return { findings, files, glossary };
}

export function summarize(findings) {
  const bySeverity = { info: 0, warn: 0, error: 0 };
  const byTerm = new Map();
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    const key = f.canonical;
    byTerm.set(key, (byTerm.get(key) ?? 0) + 1);
  }
  const topTerms = [...byTerm.entries()]
    .sort((a, b) => b[1] - a[1]);
  return { bySeverity, topTerms };
}

export function exitCodeFor(findings) {
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] >= FAIL_THRESHOLD) return 1;
  }
  return 0;
}

// ---------- CLI ----------

function formatFindingHuman(f, root) {
  const rel = relative(root, f.file);
  const sev = f.severity.toUpperCase().padEnd(4);
  const head = `  [${sev}] ${rel}:${f.line}:${f.column}  "${f.term}" → "${f.suggested}"`;
  const lines = [head, `         ${f.snippet}`];
  if (f.note) lines.push(`         note: ${f.note}`);
  return lines.join('\n');
}

function isMain() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMain()) {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const asJson = args.includes('--json');
  const quiet = args.includes('--quiet');

  const { findings, files } = runAudit({ all });
  const { bySeverity, topTerms } = summarize(findings);
  const exitCode = exitCodeFor(findings);

  if (asJson) {
    process.stdout.write(JSON.stringify({ findings, summary: { bySeverity, topTerms } }, null, 2) + '\n');
  } else {
    if (!quiet) {
      // Show warns first, then info.
      const warnFindings = findings.filter((f) => SEVERITY_RANK[f.severity] >= FAIL_THRESHOLD);
      const infoFindings = findings.filter((f) => SEVERITY_RANK[f.severity] < FAIL_THRESHOLD);
      if (warnFindings.length) {
        process.stdout.write(`\nBakkal-language audit — WARN findings (${warnFindings.length}):\n`);
        for (const f of warnFindings) process.stdout.write(formatFindingHuman(f, REPO_ROOT) + '\n');
      }
      if (infoFindings.length) {
        process.stdout.write(`\nBakkal-language audit — INFO findings (${infoFindings.length} — not blocking):\n`);
        for (const f of infoFindings.slice(0, 25)) process.stdout.write(formatFindingHuman(f, REPO_ROOT) + '\n');
        if (infoFindings.length > 25) process.stdout.write(`  ... (${infoFindings.length - 25} more, use --json for full list)\n`);
      }
    }

    process.stdout.write(`\nScanned ${files.length} files. Total findings: ${findings.length} `);
    process.stdout.write(`(warn=${bySeverity.warn}, info=${bySeverity.info}, error=${bySeverity.error}).\n`);
    if (topTerms.length) {
      process.stdout.write('Top terms:\n');
      for (const [term, count] of topTerms.slice(0, 10)) {
        process.stdout.write(`  ${term.padEnd(20)} ${count}\n`);
      }
    }
    if (exitCode !== 0) {
      process.stdout.write(`\nFAIL — ${bySeverity.warn + bySeverity.error} warn-or-higher findings.\n`);
      process.stdout.write('Add `// allow:term` on a line to opt out, or fix per the suggestion column.\n');
    } else {
      process.stdout.write('\nOK — no warn-or-higher findings.\n');
    }
  }

  process.exit(exitCode);
}
