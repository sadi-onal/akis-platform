// AC Coverage Metric — per-AC binary checklist (PR-D)
//
// Replaces the mechanical Proto-confidence formula (committed && files≥6 → 88,
// committed → 70, else → 55) that 2024-2026 industry research (Stanford 2022,
// Qodo 2025, NASA SWE-189) flags as anti-pattern. Instead of a fuzzy "score",
// we compute a per-AC binary checklist:
//
//   • staticCovered  — Proto produced code that lightweight-matches the AC
//                      (keyword scan of the AC's description against the
//                      combined files[] content + filePath list).
//   • dynamicCovered — When Trace ran, the AC id appears in coverageMatrix
//                      OR the AC description matches the test file content.
//
// Both layers are intentionally cheap (no LLM, no AST) so the metric stays
// deterministic + reproducible. False positives are accepted in exchange for
// not over-promising: the UI surfaces "kapsanıyor / kapsanmıyor" as binary,
// never as a percentage that pretends to be calibrated.

import type { ScribeOutput, ProtoOutput, TraceOutput } from '../contracts/PipelineTypes.js';

export interface AcCoverageItem {
  acId: string;
  acDescription: string;
  /** True when at least one Proto file content/path matches an AC keyword. */
  staticCovered: boolean;
  /** True when Trace's coverageMatrix or test file contents reference this AC. */
  dynamicCovered: boolean;
  /** Up to 3 Proto file paths that triggered the static match. */
  coveringFiles: string[];
  /** Up to 3 Trace test file paths that triggered the dynamic match. */
  coveringTests: string[];
}

export interface AcCoverageReport {
  totalAcs: number;
  staticCoveredCount: number;
  dynamicCoveredCount: number;
  items: AcCoverageItem[];
}

const MAX_COVERING_FILES = 3;
const MAX_COVERING_TESTS = 3;

// Turkish + English stop words removed before keyword extraction. AC
// `given/when/then` clauses are conversational so the raw text contains a
// lot of noise that would false-positive against package.json / README.
const STOP_WORDS = new Set([
  // Turkish
  've',
  'ile',
  'için',
  'icin',
  'bir',
  'bu',
  'şu',
  'su',
  'o',
  'da',
  'de',
  'ki',
  'ya',
  'olarak',
  'olur',
  'olsun',
  'olduğunda',
  'oldugunda',
  'edildiğinde',
  'edildiginde',
  'basildiginda',
  'basıldığında',
  'basıldı',
  'basildi',
  'sonra',
  'önce',
  'once',
  'ise',
  'ama',
  'fakat',
  'çünkü',
  'cunku',
  'eğer',
  'eger',
  'tüm',
  'tum',
  'her',
  'gibi',
  'kadar',
  'kullanıcı',
  'kullanici',
  'sayfa',
  'ekran',
  'gösterilir',
  'gosterilir',
  'görünür',
  'gorunur',
  'tıklandığında',
  'tiklandiginda',
  'girildi',
  'girildiğinde',
  'girildiginde',
  // English
  'the',
  'a',
  'an',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'when',
  'then',
  'given',
  'as',
  'so',
  'that',
  'this',
  'it',
  'by',
  'from',
  'into',
  'user',
  'should',
  'must',
  'will',
  'can',
  'displayed',
  'shown',
  'clicked',
  'entered',
]);

/**
 * Build the human-readable description for an AC. Combines the `then` clause
 * (most informative) with `when` (action context). Falls back to the raw
 * record stringified if shape is unexpected.
 */
function describeAc(ac: { id: string; given?: string; when?: string; then?: string }): string {
  const parts = [ac.when, ac.then].filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (parts.length === 0) {
    // Fall back to `given` if neither when nor then is set — rarely happens
    // in production but keeps tests + legacy specs working.
    return ac.given ?? ac.id;
  }
  return parts.join(' ');
}

/**
 * Tokenize a string into lower-cased keyword candidates. Drops stop words,
 * non-word chars, and very short tokens (1-2 chars are too generic). Keeps
 * Turkish-specific characters intact (ç,ğ,ı,ö,ş,ü) so domain words like
 * "indirir" or "yükler" still match.
 */
function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  // Split on anything that isn't a letter or digit (unicode-aware via \p{L}).
  const tokens = lower.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (STOP_WORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Static AC↔code match. An AC counts as covered when at least one of its
 * non-stop-word keywords appears (case-insensitive substring) in the
 * combined Proto file list. We require at least 1 keyword match; with the
 * stop-word filter above, a hit corresponds to a meaningful domain word.
 */
function findCoveringFiles(
  keywords: string[],
  files: ReadonlyArray<{ filePath: string; content: string }>
): string[] {
  if (keywords.length === 0 || files.length === 0) return [];
  const matched: string[] = [];
  for (const file of files) {
    if (matched.length >= MAX_COVERING_FILES) break;
    // Lower-case once per file to keep the loop O(N·M) cheap.
    const haystack = `${file.filePath}\n${file.content}`.toLowerCase();
    const hit = keywords.some((k) => haystack.includes(k));
    if (hit) matched.push(file.filePath);
  }
  return matched;
}

/**
 * Dynamic AC↔test match. Priority order:
 *  1. Trace's own `coverageMatrix` (AC id → test names) — authoritative.
 *  2. AC keyword substring match against test file content/path.
 */
function findCoveringTests(
  acId: string,
  keywords: string[],
  trace: TraceOutput | undefined
): string[] {
  if (!trace) return [];
  const matched: string[] = [];

  // 1. Authoritative source — Trace itself recorded coverage for this AC.
  const matrix = trace.coverageMatrix ?? {};
  const direct = matrix[acId];
  if (Array.isArray(direct) && direct.length > 0) {
    // coverageMatrix values are test names, not file paths — try to look up
    // the file that contains that test name. Fall back to the test name
    // itself so the UI can still display something useful.
    for (const testRef of direct) {
      if (matched.length >= MAX_COVERING_TESTS) break;
      const matchingFile = (trace.testFiles ?? []).find((tf) => tf.content.includes(testRef));
      matched.push(matchingFile?.filePath ?? testRef);
    }
    if (matched.length > 0) return matched;
  }

  // 2. Keyword-substring fallback against test files.
  const testFiles = trace.testFiles ?? [];
  if (keywords.length === 0 || testFiles.length === 0) return matched;
  for (const tf of testFiles) {
    if (matched.length >= MAX_COVERING_TESTS) break;
    const haystack = `${tf.filePath}\n${tf.content}`.toLowerCase();
    const hit = keywords.some((k) => haystack.includes(k));
    if (hit) matched.push(tf.filePath);
  }
  return matched;
}

/**
 * Compute the AC coverage report for a pipeline. Safe to call with any
 * combination of stage outputs present/absent:
 *   • scribeOutput undefined  → totalAcs = 0, items = []
 *   • protoOutput undefined   → staticCovered = false for every AC
 *   • traceOutput undefined   → dynamicCovered = false for every AC
 */
export function buildAcCoverage(
  scribeOutput: ScribeOutput | undefined,
  protoOutput: ProtoOutput | undefined,
  traceOutput?: TraceOutput
): AcCoverageReport {
  const acs = scribeOutput?.spec?.acceptanceCriteria ?? [];
  if (acs.length === 0) {
    return {
      totalAcs: 0,
      staticCoveredCount: 0,
      dynamicCoveredCount: 0,
      items: [],
    };
  }

  const protoFiles = protoOutput?.files ?? [];
  const items: AcCoverageItem[] = acs.map((ac) => {
    const description = describeAc(ac);
    const keywords = extractKeywords(description);

    const coveringFiles = findCoveringFiles(keywords, protoFiles);
    const coveringTests = findCoveringTests(ac.id, keywords, traceOutput);

    return {
      acId: ac.id,
      acDescription: description,
      staticCovered: coveringFiles.length > 0,
      dynamicCovered: coveringTests.length > 0,
      coveringFiles,
      coveringTests,
    };
  });

  return {
    totalAcs: items.length,
    staticCoveredCount: items.filter((i) => i.staticCovered).length,
    dynamicCoveredCount: items.filter((i) => i.dynamicCovered).length,
    items,
  };
}
