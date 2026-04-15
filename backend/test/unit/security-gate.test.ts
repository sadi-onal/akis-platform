/**
 * SecurityGate — Unit Tests (node:test)
 * Tech 5: Security regression gate — no-regression rule for fix loop
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityGate } from '../../src/pipeline/core/security-gate/SecurityGate.js';
import type { SecurityScanResult } from '../../src/pipeline/core/security-gate/SecurityGateTypes.js';

const gate = new SecurityGate();

describe('SecurityGate', () => {
  // 1. Clean code passes scan with 0 issues
  it('passes clean code with zero issues', () => {
    const result = gate.scan([
      { path: '/src/index.ts', content: 'const x: number = 42;\nconsole.log(x);\n' },
    ]);
    assert.equal(result.counts.total, 0);
    assert.equal(result.counts.critical, 0);
    assert.equal(result.issues.length, 0);
  });

  // 2. Hardcoded secret detected as critical
  it('detects hardcoded secrets as critical', () => {
    const result = gate.scan([
      { path: '/src/config.ts', content: 'const api_key = "sk-live-1234567890abcdef";\n' },
    ]);
    assert.ok(result.counts.critical > 0, 'should find critical issue');
    const secret = result.issues.find((i) => i.category === 'hardcoded-secret');
    assert.ok(secret, 'should have hardcoded-secret category');
    assert.equal(secret.severity, 'critical');
  });

  // 3. eval() detected as high
  it('detects eval() as high severity', () => {
    const result = gate.scan([
      { path: '/src/util.ts', content: 'const x = eval("1+1");\n' },
    ]);
    assert.ok(result.counts.high > 0);
    const evalIssue = result.issues.find((i) => i.category === 'eval');
    assert.ok(evalIssue);
    assert.equal(evalIssue.severity, 'high');
  });

  // 4. Regression blocked (new critical appeared)
  it('blocks regression when critical count increases', () => {
    const previous: SecurityScanResult = {
      timestamp: new Date(),
      iteration: 1,
      issues: [],
      counts: { critical: 0, high: 1, medium: 0, low: 0, total: 1 },
    };
    const current: SecurityScanResult = {
      timestamp: new Date(),
      iteration: 2,
      issues: [{ severity: 'critical', category: 'hardcoded-secret', file: '/src/a.ts', description: 'secret' }],
      counts: { critical: 1, high: 1, medium: 0, low: 0, total: 2 },
    };
    const decision = gate.evaluate(current, previous);
    assert.equal(decision.allowed, false);
    assert.ok(decision.reason.includes('regression'));
  });

  // 5. Improvement allowed (critical decreased)
  it('allows when security improves', () => {
    const previous: SecurityScanResult = {
      timestamp: new Date(),
      iteration: 1,
      issues: [
        { severity: 'critical', category: 'injection', file: '/a.ts', description: 'sql' },
        { severity: 'high', category: 'eval', file: '/a.ts', description: 'eval' },
      ],
      counts: { critical: 1, high: 1, medium: 0, low: 0, total: 2 },
    };
    const current: SecurityScanResult = {
      timestamp: new Date(),
      iteration: 2,
      issues: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    };
    const decision = gate.evaluate(current, previous);
    assert.equal(decision.allowed, true);
    assert.ok(decision.regression);
    assert.ok(decision.regression.resolvedIssues > 0);
  });

  // 6. First iteration with criticals blocked
  it('blocks first iteration with critical issues', () => {
    const scan = gate.scan([
      { path: '/src/db.ts', content: 'const password = "admin123";\n' },
    ]);
    const decision = gate.evaluate(scan);
    assert.equal(decision.allowed, false);
    assert.ok(decision.reason.includes('critical'));
  });

  // 7. First iteration clean allowed
  it('allows first iteration when clean', () => {
    const scan = gate.scan([
      { path: '/src/index.ts', content: 'console.log("hello");\n' },
    ]);
    const decision = gate.evaluate(scan);
    assert.equal(decision.allowed, true);
  });

  // 8. Scan counts are correct
  it('counts severities correctly', () => {
    const result = gate.scan([
      {
        path: '/src/mixed.ts',
        content: [
          'const secret = "mypassword123";',
          'const x = eval("1");',
          'const url = "http://example.com/api";',
        ].join('\n'),
      },
    ]);
    assert.ok(result.counts.critical >= 1, 'should have critical (hardcoded secret)');
    assert.ok(result.counts.high >= 1, 'should have high (eval)');
    assert.ok(result.counts.medium >= 1, 'should have medium (insecure http)');
    assert.equal(result.counts.total, result.issues.length);
  });

  // 9. Multiple patterns in same file
  it('detects multiple patterns in same file', () => {
    const result = gate.scan([
      {
        path: '/src/bad.ts',
        content: [
          'const token = "my-secret-token";',
          'document.write("<script>alert(1)</script>");',
          'const data = eval(userInput);',
          'const img = "http://cdn.example.com/img.png";',
        ].join('\n'),
      },
    ]);
    const categories = new Set(result.issues.map((i) => i.category));
    assert.ok(categories.size >= 3, `expected >=3 categories, got ${categories.size}: ${[...categories].join(', ')}`);
  });

  // 10. Insecure HTTP detected but localhost allowed
  it('detects insecure HTTP but allows localhost', () => {
    const result = gate.scan([
      {
        path: '/src/api.ts',
        content: [
          'const local = "http://localhost:3000/api";',
          'const remote = "http://example.com/api";',
        ].join('\n'),
      },
    ]);
    const httpIssues = result.issues.filter((i) => i.category === 'insecure-http');
    assert.equal(httpIssues.length, 1, 'should only flag non-localhost HTTP');
    assert.ok(httpIssues[0].description.includes('Insecure HTTP'));
  });

  // 11. checkRegression detects degradation
  it('checkRegression returns true on degradation', () => {
    const prev: SecurityScanResult = {
      timestamp: new Date(), iteration: 1, issues: [],
      counts: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    };
    const curr: SecurityScanResult = {
      timestamp: new Date(), iteration: 2, issues: [],
      counts: { critical: 0, high: 1, medium: 0, low: 0, total: 1 },
    };
    assert.equal(gate.checkRegression(curr, prev), true);
  });

  // 12. checkRegression returns false when improved
  it('checkRegression returns false when improved', () => {
    const prev: SecurityScanResult = {
      timestamp: new Date(), iteration: 1, issues: [],
      counts: { critical: 1, high: 2, medium: 0, low: 0, total: 3 },
    };
    const curr: SecurityScanResult = {
      timestamp: new Date(), iteration: 2, issues: [],
      counts: { critical: 1, high: 1, medium: 0, low: 0, total: 2 },
    };
    assert.equal(gate.checkRegression(curr, prev), false);
  });

  // 13. XSS patterns detected
  it('detects XSS patterns (innerHTML, dangerouslySetInnerHTML)', () => {
    const result = gate.scan([
      { path: '/src/ui.ts', content: 'el.innerHTML = userInput;\n' },
    ]);
    const xssIssues = result.issues.filter((i) => i.category === 'xss');
    assert.ok(xssIssues.length > 0);
    assert.equal(xssIssues[0].severity, 'high');
  });

  // 14. SQL injection detected
  it('detects SQL injection via string concatenation', () => {
    const result = gate.scan([
      { path: '/src/db.ts', content: 'db.query("SELECT * FROM users WHERE id=" + userId);\n' },
    ]);
    const sqlIssues = result.issues.filter((i) => i.category === 'injection');
    assert.ok(sqlIssues.length > 0);
    assert.equal(sqlIssues[0].severity, 'critical');
  });
});
