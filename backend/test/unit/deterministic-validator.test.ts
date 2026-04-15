/**
 * DeterministicValidator — Unit Tests (node:test)
 * Tech 1: AST-based deterministic validation — 20 test cases
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicValidator } from '../../src/pipeline/core/validator/DeterministicValidator.js';
import type { ValidationInput, ValidationFile } from '../../src/pipeline/core/validator/ValidatorTypes.js';

function makeInput(files: ValidationFile[]): ValidationInput {
  return { files };
}

function singleTsFile(content: string, path = '/src/index.ts'): ValidationInput {
  return makeInput([{ path, content, language: 'typescript' }]);
}

const validator = new DeterministicValidator();

describe('DeterministicValidator', () => {
  // 1. Clean code passes with score 100
  it('passes clean code with a perfect score', () => {
    const input = makeInput([
      {
        path: '/src/index.ts',
        content: `import { readFile } from 'node:fs';\n\nconst x: number = 42;\nconsole.log(x);\n`,
        language: 'typescript',
      },
    ]);
    const result = validator.validate(input);
    assert.equal(result.passed, true);
    assert.equal(result.score, 100);
    assert.equal(result.summary.errors, 0);
    assert.equal(result.summary.warnings, 0);
  });

  // 2. Syntax errors caught (mismatched braces)
  it('catches mismatched braces', () => {
    const input = singleTsFile(
      `function foo() {\n  if (true) {\n    console.log("ok");\n  \n}\n`,
    );
    const result = validator.validate(input);
    const braceIssues = result.issues.filter((i) => i.rule === 'brace-balance');
    assert.ok(braceIssues.length > 0, 'should have brace-balance issues');
    assert.equal(braceIssues[0].severity, 'error');
    assert.equal(result.passed, false);
  });

  // 3. Invalid JSON caught
  it('catches invalid JSON', () => {
    const input = makeInput([
      { path: '/package.json', content: '{ "name": "test", invalid }', language: 'json' },
    ]);
    const result = validator.validate(input);
    const jsonIssues = result.issues.filter((i) => i.rule === 'json-parse');
    assert.ok(jsonIssues.length > 0);
    assert.equal(jsonIssues[0].severity, 'error');
  });

  // 4. Hardcoded secrets detected
  it('detects hardcoded secrets', () => {
    const input = singleTsFile(
      `const api_key = "sk-ant-1234567890abcdef1234567890abcdef";\n`,
    );
    const result = validator.validate(input);
    const secretIssues = result.issues.filter((i) => i.rule === 'no-hardcoded-secret');
    assert.ok(secretIssues.length > 0, 'should detect hardcoded secret');
    assert.equal(secretIssues[0].severity, 'error');
  });

  // 5. Unknown npm packages flagged as warnings
  it('flags unknown npm packages as warnings', () => {
    const input = singleTsFile(
      `import { something } from 'super-obscure-nonexistent-pkg-xyz';\nconsole.log(something);\n`,
    );
    const result = validator.validate(input);
    const importWarnings = result.issues.filter(
      (i) => i.rule === 'known-package' && i.severity === 'warning',
    );
    assert.equal(importWarnings.length, 1);
    assert.ok(importWarnings[0].message.includes('super-obscure-nonexistent-pkg-xyz'));
  });

  // 6. Relative imports to nonexistent files flagged as errors
  it('flags relative imports to nonexistent files as errors', () => {
    const input = makeInput([
      {
        path: '/src/index.ts',
        content: `import { helper } from './utils/nonexistent.js';\nconsole.log(helper);\n`,
        language: 'typescript',
      },
    ]);
    const result = validator.validate(input);
    const relativeErrors = result.issues.filter((i) => i.rule === 'relative-import-exists');
    assert.equal(relativeErrors.length, 1);
    assert.equal(relativeErrors[0].severity, 'error');
  });

  // 7. eval() usage detected
  it('detects eval() usage', () => {
    const input = singleTsFile(`const code = "1+1";\nconst result = eval(code);\n`);
    const result = validator.validate(input);
    const evalIssues = result.issues.filter((i) => i.rule === 'no-eval');
    assert.ok(evalIssues.length > 0);
    assert.equal(evalIssues[0].severity, 'error');
  });

  // 8. innerHTML usage detected
  it('detects innerHTML assignment', () => {
    const input = singleTsFile(
      `const el = document.getElementById("app");\nel.innerHTML = "<div>" + userInput + "</div>";\n`,
    );
    const result = validator.validate(input);
    const htmlIssues = result.issues.filter((i) => i.rule === 'no-inner-html');
    assert.ok(htmlIssues.length > 0);
    assert.equal(htmlIssues[0].severity, 'warning');
  });

  // 9. Score calculation correct (multiple issues)
  it('computes score correctly with multiple issues', () => {
    const input = singleTsFile([
      'const el = document.getElementById("app");',
      'el.innerHTML = "<div>unsafe</div>";',
      'const x = eval("1+1");',
      '',
    ].join('\n'));
    const result = validator.validate(input);
    const { errors, warnings, infos } = result.summary;
    const expected = Math.max(0, 100 - errors * 10 - warnings * 3 - infos * 1);
    assert.equal(result.score, expected);
  });

  // 10. passed=false when errors > 0 even if score >= 60
  it('fails when there are errors even if score is above 60', () => {
    const input = singleTsFile(`const x = eval("1");\n`);
    const result = validator.validate(input);
    assert.ok(result.score >= 60, 'score should be >= 60');
    assert.ok(result.summary.errors > 0, 'should have errors');
    assert.equal(result.passed, false);
  });

  // 11. SQL injection patterns detected
  it('detects SQL injection patterns', () => {
    const input = singleTsFile(
      'const result = db.query(`SELECT * FROM users WHERE id = ${userId}`);\n',
    );
    const result = validator.validate(input);
    const sqlIssues = result.issues.filter((i) => i.rule === 'no-sql-injection');
    assert.ok(sqlIssues.length > 0, 'should detect SQL injection');
  });

  // 12. Known imports pass without warnings
  it('accepts known npm packages without warnings', () => {
    const input = singleTsFile([
      "import express from 'express';",
      "import { z } from 'zod';",
      "import React from 'react';",
      '',
      'console.log(express, z, React);',
      '',
    ].join('\n'));
    const result = validator.validate(input);
    const importWarnings = result.issues.filter((i) => i.category === 'import');
    assert.equal(importWarnings.length, 0);
  });

  // 13. Score minimum is 0
  it('clamps score at 0 for many issues', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`const x${i} = eval("${i}");`);
    const input = singleTsFile(lines.join('\n') + '\n');
    const result = validator.validate(input);
    assert.equal(result.score, 0);
    assert.equal(result.passed, false);
  });

  // 14. Summary contains correct checksRun list
  it('lists all checks in summary', () => {
    const input = singleTsFile('const x = 1;\n');
    const result = validator.validate(input);
    assert.ok(result.summary.checksRun.includes('syntax'));
    assert.ok(result.summary.checksRun.includes('import'));
    assert.ok(result.summary.checksRun.includes('security'));
    assert.ok(result.summary.checksRun.includes('structure'));
  });

  // 15. Valid relative imports not flagged
  it('accepts valid relative imports that resolve to project files', () => {
    const input = makeInput([
      {
        path: '/src/index.ts',
        content: `import { helper } from './utils/helper.js';\nconsole.log(helper);\n`,
        language: 'typescript',
      },
      {
        path: '/src/utils/helper.ts',
        content: `export function helper() { return 1; }\n`,
        language: 'typescript',
      },
    ]);
    const result = validator.validate(input);
    const relativeIssues = result.issues.filter((i) => i.rule === 'relative-import-exists');
    assert.equal(relativeIssues.length, 0);
  });

  // 16. Insecure HTTP URL detected
  it('detects insecure HTTP URLs', () => {
    const input = singleTsFile(
      `const url = "http://example.com/api/data";\nfetch(url);\n`,
    );
    const result = validator.validate(input);
    const httpIssues = result.issues.filter((i) => i.rule === 'prefer-https');
    assert.ok(httpIssues.length > 0);
    assert.equal(httpIssues[0].severity, 'warning');
  });

  // 17. Mismatched HTML tags caught
  it('catches mismatched HTML tags', () => {
    const input = makeInput([
      {
        path: '/public/index.html',
        content: '<html><body><div><span>text</div></span></body></html>',
        language: 'html',
      },
    ]);
    const result = validator.validate(input);
    const htmlIssues = result.issues.filter(
      (i) => i.rule === 'html-tag-balance' && i.severity === 'error',
    );
    assert.ok(htmlIssues.length > 0, 'should catch mismatched HTML tags');
  });

  // 18. Type any usage flagged as info
  it('flags any type usage as info', () => {
    const input = singleTsFile(
      `function process(data: any): void {\n  console.log(data);\n}\n`,
    );
    const result = validator.validate(input);
    const anyIssues = result.issues.filter((i) => i.rule === 'no-any');
    assert.ok(anyIssues.length > 0);
    assert.equal(anyIssues[0].severity, 'info');
  });

  // 19. Valid JSON and HTML pass
  it('validates well-formed HTML', () => {
    const input = makeInput([
      {
        path: '/public/index.html',
        content: '<html><head><title>Test</title></head><body><div>Hello</div></body></html>',
        language: 'html',
      },
    ]);
    const result = validator.validate(input);
    const htmlIssues = result.issues.filter((i) => i.rule === 'html-tag-balance');
    assert.equal(htmlIssues.length, 0);
  });

  // 20. package.json structure check
  it('flags invalid package.json via structure check', () => {
    const input = makeInput([
      { path: '/package.json', content: '{ broken json', language: 'json' },
      { path: '/src/index.ts', content: 'console.log("hi");\n', language: 'typescript' },
    ]);
    const result = validator.validate(input);
    const structureIssues = result.issues.filter((i) => i.category === 'structure');
    assert.ok(structureIssues.length > 0, 'should flag invalid package.json');
  });
});
