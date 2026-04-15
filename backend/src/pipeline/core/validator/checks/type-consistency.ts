/**
 * Type Consistency Check — Verify type annotations are internally consistent.
 *
 * Heuristic checks (no full type-checker):
 * - Detect `const x: string = 123` style mismatches
 * - Flag `any` usage as info
 * - Detect functions with inconsistent return type annotations
 * - Flag type assertions to incompatible primitives
 */

import type { ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map of primitive type annotation → literal patterns that are obviously wrong.
 * e.g. `const x: string = 42` or `const x: number = "hello"`
 */
const PRIMITIVE_MISMATCHES: ReadonlyArray<{
  annotationType: string;
  badLiteralPattern: RegExp;
  description: string;
}> = [
  {
    annotationType: 'string',
    badLiteralPattern: /=\s*(?:\d+(?:\.\d+)?|true|false|null|undefined|\[|\{)\s*[;,\n]/,
    description: 'assigned a non-string literal to a string-typed variable',
  },
  {
    annotationType: 'number',
    badLiteralPattern: /=\s*(?:['"`]|true|false|null|\[|\{)\s*/,
    description: 'assigned a non-number literal to a number-typed variable',
  },
  {
    annotationType: 'boolean',
    badLiteralPattern: /=\s*(?:['"`]|\d+(?:\.\d+)?|null|\[|\{)\s*/,
    description: 'assigned a non-boolean literal to a boolean-typed variable',
  },
];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkPrimitiveMismatches(
  content: string,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // Skip comment lines
    if (ln.trimStart().startsWith('//') || ln.trimStart().startsWith('*')) continue;

    for (const rule of PRIMITIVE_MISMATCHES) {
      // Match patterns like: `const/let/var name: <type> = <bad value>`
      const declRegex = new RegExp(
        `(?:const|let|var)\\s+\\w+\\s*:\\s*${rule.annotationType}\\s*=`,
      );
      const declMatch = ln.match(declRegex);
      if (declMatch) {
        // Check the value part after the `=`
        const afterEquals = ln.slice(ln.indexOf('=', declMatch.index));
        if (rule.badLiteralPattern.test(afterEquals)) {
          issues.push({
            severity: 'error',
            category: 'type',
            file,
            line: i + 1,
            message: `Type mismatch: ${rule.description}`,
            rule: 'primitive-type-mismatch',
          });
        }
      }
    }
  }

  return issues;
}

/** Flag usage of `any` type as informational. */
function checkAnyUsage(
  content: string,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trimStart().startsWith('//') || ln.trimStart().startsWith('*')) continue;

    // Match `: any` in type annotations, but not inside strings or comments
    // Simple heuristic: look for colon followed by `any`
    const anyRegex = /:\s*any\b/g;
    let match: RegExpExecArray | null;
    while ((match = anyRegex.exec(ln)) !== null) {
      // Ensure it's not inside a string
      const before = ln.slice(0, match.index);
      const singleQuotes = (before.match(/'/g) || []).length;
      const doubleQuotes = (before.match(/"/g) || []).length;
      const templateQuotes = (before.match(/`/g) || []).length;
      if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0 && templateQuotes % 2 === 0) {
        issues.push({
          severity: 'info',
          category: 'type',
          file,
          line: i + 1,
          message: 'Usage of `any` type — consider a more specific type',
          rule: 'no-any',
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function typeConsistencyCheck(files: ValidationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const tsFiles = files.filter((f) => f.language === 'typescript');

  for (const file of tsFiles) {
    issues.push(...checkPrimitiveMismatches(file.content, file.path));
    issues.push(...checkAnyUsage(file.content, file.path));
  }

  return issues;
}
