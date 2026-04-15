/**
 * SecurityGate — Regex-based security scanner with regression detection.
 *
 * NO LLM calls — purely pattern-matching.
 * Designed to prevent security regression across iterative code generation.
 *
 * Reference: LLMloop (ICSME 2025) — iterative generation caused 37.6%
 * increase in critical vulnerabilities after 5 iterations with GPT-4o.
 */

import type {
  FileInput,
  SecurityIssue,
  SecurityScanResult,
  SecurityGateDecision,
  SeverityCounts,
  Severity,
  IssueCategory,
} from './SecurityGateTypes.js';

interface PatternRule {
  pattern: RegExp;
  severity: Severity;
  category: IssueCategory;
  description: string;
}

const SECURITY_PATTERNS: PatternRule[] = [
  {
    pattern: /(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]+['"]/gi,
    severity: 'critical',
    category: 'hardcoded-secret',
    description: 'Hardcoded secret or credential detected',
  },
  {
    pattern: /(?:query|exec|execute)\s*\([^)]*\+/gi,
    severity: 'critical',
    category: 'injection',
    description: 'Potential SQL injection via string concatenation',
  },
  {
    pattern: /innerHTML\s*=|dangerouslySetInnerHTML|document\.write/gi,
    severity: 'high',
    category: 'xss',
    description: 'Potential XSS via unsafe DOM manipulation',
  },
  {
    pattern: /\.\.\//g,
    severity: 'high',
    category: 'path-traversal',
    description: 'Path traversal pattern detected',
  },
  {
    pattern: /\beval\s*\(|new\s+Function\s*\(/gi,
    severity: 'high',
    category: 'eval',
    description: 'Dynamic code execution via eval or new Function',
  },
  {
    pattern: /http:\/\/(?!localhost)/gi,
    severity: 'medium',
    category: 'insecure-http',
    description: 'Insecure HTTP URL (non-localhost)',
  },
];

function countSeverities(issues: SecurityIssue[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const issue of issues) {
    counts[issue.severity]++;
    counts.total++;
  }
  return counts;
}

function getLineNumber(content: string, matchIndex: number): number {
  let line = 1;
  for (let i = 0; i < matchIndex && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

export class SecurityGate {
  /**
   * Scan file contents for security issues using regex patterns.
   */
  scan(files: FileInput[], iteration = 1): SecurityScanResult {
    const issues: SecurityIssue[] = [];

    for (const file of files) {
      for (const rule of SECURITY_PATTERNS) {
        // Reset lastIndex for global regexes
        const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
        let match: RegExpExecArray | null;

        while ((match = regex.exec(file.content)) !== null) {
          issues.push({
            severity: rule.severity,
            category: rule.category,
            file: file.path,
            line: getLineNumber(file.content, match.index),
            description: rule.description,
          });
        }
      }
    }

    return {
      timestamp: new Date(),
      iteration,
      issues,
      counts: countSeverities(issues),
    };
  }

  /**
   * Check if security has regressed between two scans.
   * Returns true if the current scan is worse than the previous.
   */
  checkRegression(
    current: SecurityScanResult,
    previous: SecurityScanResult,
  ): boolean {
    return (
      current.counts.critical > previous.counts.critical ||
      current.counts.high > previous.counts.high
    );
  }

  /**
   * Evaluate a scan result and decide whether to allow the iteration.
   *
   * First iteration (no previous): allowed if critical === 0.
   * Subsequent: allowed if no regression in critical or high counts.
   */
  evaluate(
    currentScan: SecurityScanResult,
    previousScan?: SecurityScanResult,
  ): SecurityGateDecision {
    // First iteration — no baseline to compare against
    if (!previousScan) {
      const allowed = currentScan.counts.critical === 0;
      return {
        allowed,
        reason: allowed
          ? `First iteration passed: 0 critical issues (${currentScan.counts.total} total)`
          : `First iteration blocked: ${currentScan.counts.critical} critical issue(s) found`,
        currentScan,
      };
    }

    // Subsequent iterations — check for regression
    const hasRegression = this.checkRegression(currentScan, previousScan);
    const netChange = currentScan.counts.total - previousScan.counts.total;
    const newIssues = Math.max(0, netChange);
    const resolvedIssues = Math.max(0, -netChange);

    const regression = { newIssues, resolvedIssues, netChange };

    if (hasRegression) {
      const reasons: string[] = [];
      if (currentScan.counts.critical > previousScan.counts.critical) {
        reasons.push(
          `critical: ${previousScan.counts.critical} -> ${currentScan.counts.critical}`,
        );
      }
      if (currentScan.counts.high > previousScan.counts.high) {
        reasons.push(
          `high: ${previousScan.counts.high} -> ${currentScan.counts.high}`,
        );
      }

      return {
        allowed: false,
        reason: `Security regression detected: ${reasons.join(', ')}`,
        currentScan,
        previousScan,
        regression,
      };
    }

    return {
      allowed: true,
      reason: `No regression: critical ${currentScan.counts.critical}/${previousScan.counts.critical}, high ${currentScan.counts.high}/${previousScan.counts.high}`,
      currentScan,
      previousScan,
      regression,
    };
  }
}
