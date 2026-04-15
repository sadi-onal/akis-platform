/**
 * Security Check — OWASP basic patterns for LLM-generated code.
 *
 * Detects:
 * - Hardcoded secrets (API keys, passwords, tokens)
 * - SQL injection patterns (string concatenation in queries)
 * - eval() / Function() usage
 * - innerHTML / outerHTML without sanitization
 * - Path traversal patterns
 * - Insecure HTTP URLs (non-localhost)
 */

import type { ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface SecurityPattern {
  pattern: RegExp;
  severity: 'error' | 'warning';
  message: string;
  rule: string;
}

const SECURITY_PATTERNS: ReadonlyArray<SecurityPattern> = [
  // ── Hardcoded secrets ──────────────────────────────────────────────────
  {
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
    severity: 'error',
    message: 'Hardcoded API key detected',
    rule: 'no-hardcoded-secret',
  },
  {
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/i,
    severity: 'error',
    message: 'Hardcoded password detected',
    rule: 'no-hardcoded-secret',
  },
  {
    pattern: /(?:secret|token|auth[_-]?token|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-/.]{16,}['"]/i,
    severity: 'error',
    message: 'Hardcoded secret/token detected',
    rule: 'no-hardcoded-secret',
  },
  {
    pattern: /(?:sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]{20,}|sk_test_[a-zA-Z0-9]{20,})/,
    severity: 'error',
    message: 'Hardcoded Stripe/OpenAI-style secret key detected',
    rule: 'no-hardcoded-secret',
  },
  {
    pattern: /(?:AKIA[0-9A-Z]{16})/,
    severity: 'error',
    message: 'Hardcoded AWS access key detected',
    rule: 'no-hardcoded-secret',
  },

  // ── eval / dangerous code execution ────────────────────────────────────
  {
    pattern: /\beval\s*\(/,
    severity: 'error',
    message: 'Usage of eval() — potential code injection risk',
    rule: 'no-eval',
  },
  {
    pattern: /new\s+Function\s*\(/,
    severity: 'error',
    message: 'Usage of new Function() — potential code injection risk',
    rule: 'no-eval',
  },

  // ── innerHTML / DOM injection ──────────────────────────────────────────
  {
    pattern: /\.innerHTML\s*=/,
    severity: 'warning',
    message: 'Direct innerHTML assignment — risk of XSS. Use textContent or a sanitizer.',
    rule: 'no-inner-html',
  },
  {
    pattern: /\.outerHTML\s*=/,
    severity: 'warning',
    message: 'Direct outerHTML assignment — risk of XSS.',
    rule: 'no-inner-html',
  },

  // ── SQL injection ──────────────────────────────────────────────────────
  {
    pattern: /(?:query|execute|exec)\s*\(\s*['"`].*\$\{/,
    severity: 'error',
    message: 'String interpolation in SQL query — SQL injection risk',
    rule: 'no-sql-injection',
  },
  {
    pattern: /(?:query|execute|exec)\s*\(\s*['"].*\+\s*(?:req\.|params\.|body\.|query\.)/,
    severity: 'error',
    message: 'String concatenation with user input in SQL query — SQL injection risk',
    rule: 'no-sql-injection',
  },

  // ── Path traversal ─────────────────────────────────────────────────────
  {
    pattern: /\.\.[/\\]/,
    severity: 'warning',
    message: 'Path traversal pattern detected (../) — verify input is sanitized',
    rule: 'no-path-traversal',
  },

  // ── Insecure HTTP ──────────────────────────────────────────────────────
  {
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    severity: 'warning',
    message: 'Insecure HTTP URL — use HTTPS instead',
    rule: 'prefer-https',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function securityCheck(files: ValidationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const checkableFiles = files.filter(
    (f) =>
      f.language === 'typescript' ||
      f.language === 'javascript' ||
      f.language === 'html',
  );

  for (const file of checkableFiles) {
    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];

      // Skip comment-only lines
      const trimmed = ln.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) {
        continue;
      }

      for (const pat of SECURITY_PATTERNS) {
        if (pat.pattern.test(ln)) {
          issues.push({
            severity: pat.severity,
            category: 'security',
            file: file.path,
            line: i + 1,
            message: pat.message,
            rule: pat.rule,
          });
        }
      }
    }
  }

  return issues;
}
