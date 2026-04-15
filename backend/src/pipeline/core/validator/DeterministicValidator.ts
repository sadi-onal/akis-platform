/**
 * DeterministicValidator — Main validation service.
 *
 * Runs all deterministic checks and computes a quality score.
 * NO LLM calls — this is the anchor between probabilistic pipeline steps.
 *
 * Score = 100 - (errors * 10) - (warnings * 3) - (infos * 1), minimum 0
 * passed = score >= 60 AND errors === 0
 */

import type {
  ValidationInput,
  ValidationResult,
  ValidationIssue,
  CheckFn,
} from './ValidatorTypes.js';
import { syntaxCheck } from './checks/syntax-check.js';
import { importCheck } from './checks/import-check.js';
import { typeConsistencyCheck } from './checks/type-consistency.js';
import { securityCheck } from './checks/security-check.js';

// ---------------------------------------------------------------------------
// Check registry — add new checks here
// ---------------------------------------------------------------------------

const CHECK_REGISTRY: ReadonlyArray<{ name: string; fn: CheckFn }> = [
  { name: 'syntax', fn: syntaxCheck },
  { name: 'import', fn: importCheck },
  { name: 'type-consistency', fn: typeConsistencyCheck },
  { name: 'security', fn: securityCheck },
];

// ---------------------------------------------------------------------------
// Score calculation
// ---------------------------------------------------------------------------

function computeScore(issues: ValidationIssue[]): number {
  let errors = 0;
  let warnings = 0;
  let infos = 0;

  for (const issue of issues) {
    switch (issue.severity) {
      case 'error':
        errors++;
        break;
      case 'warning':
        warnings++;
        break;
      case 'info':
        infos++;
        break;
    }
  }

  const raw = 100 - errors * 10 - warnings * 3 - infos * 1;
  return Math.max(0, raw);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DeterministicValidator {
  /**
   * Run all deterministic checks against the provided files.
   */
  validate(input: ValidationInput): ValidationResult {
    const allIssues: ValidationIssue[] = [];
    const checksRun: string[] = [];

    for (const check of CHECK_REGISTRY) {
      const issues = check.fn(input.files);
      allIssues.push(...issues);
      checksRun.push(check.name);
    }

    // Structure checks — always run
    checksRun.push('structure');
    allIssues.push(...this.structureCheck(input));

    const score = computeScore(allIssues);
    const errors = allIssues.filter((i) => i.severity === 'error').length;
    const warnings = allIssues.filter((i) => i.severity === 'warning').length;
    const infos = allIssues.filter((i) => i.severity === 'info').length;

    return {
      passed: score >= 60 && errors === 0,
      score,
      issues: allIssues,
      summary: {
        errors,
        warnings,
        infos,
        filesChecked: input.files.length,
        checksRun,
      },
    };
  }

  /**
   * Structural validation:
   * - Every file must have content
   * - package.json must be valid JSON
   * - Entry point (index.ts/js or main.ts/js) should exist
   */
  private structureCheck(input: ValidationInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check for package.json validity
    const pkgJson = input.files.find(
      (f) => f.path.endsWith('package.json') && f.language === 'json',
    );
    if (pkgJson) {
      try {
        JSON.parse(pkgJson.content);
      } catch {
        issues.push({
          severity: 'error',
          category: 'structure',
          file: pkgJson.path,
          message: 'package.json is not valid JSON',
          rule: 'valid-package-json',
        });
      }
    }

    // Check that an entry point exists
    const hasEntryPoint = input.files.some((f) => {
      const name = f.path.split('/').pop() ?? '';
      return /^(?:index|main|app|server)\.(ts|tsx|js|jsx|mjs)$/.test(name);
    });

    if (input.files.length > 1 && !hasEntryPoint) {
      issues.push({
        severity: 'info',
        category: 'structure',
        file: '(project)',
        message: 'No entry point file found (index/main/app/server)',
        rule: 'has-entry-point',
      });
    }

    return issues;
  }
}
