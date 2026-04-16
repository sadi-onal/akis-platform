/**
 * AKIS E2E GitHub Actions template — merge behavior and YAML shape
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AKIS_E2E_WORKFLOW_PATH,
  getAkisE2eWorkflowYaml,
  hasAkisE2eWorkflowInBatch,
  mergeAkisCiWorkflowIntoTestFiles,
} from '../../src/pipeline/templates/akisE2eWorkflow.js';

describe('akisE2eWorkflow template', () => {
  it('exports stable workflow path', () => {
    assert.strictEqual(AKIS_E2E_WORKFLOW_PATH, '.github/workflows/akis-e2e.yml');
  });

  it('getAkisE2eWorkflowYaml includes Playwright job and GitHub expressions', () => {
    const yaml = getAkisE2eWorkflowYaml();
    assert.ok(yaml.includes('name: AKIS E2E'));
    assert.ok(yaml.includes('Playwright E2E'));
    assert.ok(yaml.includes('npx playwright install --with-deps chromium'));
    assert.ok(yaml.includes('npx playwright test'));
    assert.ok(yaml.includes('${{ github.workflow }}'));
    assert.ok(yaml.includes("hashFiles('features/**/*.feature')"));
  });

  it('mergeAkisCiWorkflowIntoTestFiles appends workflow when missing', () => {
    const merged = mergeAkisCiWorkflowIntoTestFiles([
      { filePath: 'tests/e2e/app.spec.ts', content: '// t', testCount: 1 },
    ]);
    assert.strictEqual(merged.length, 2);
    assert.strictEqual(merged[1].filePath, AKIS_E2E_WORKFLOW_PATH);
    assert.ok(merged[1].content.length > 100);
    assert.strictEqual(merged[1].testCount, 0);
  });

  it('mergeAkisCiWorkflowIntoTestFiles is idempotent when AKIS workflow exists', () => {
    const yaml = getAkisE2eWorkflowYaml();
    const merged = mergeAkisCiWorkflowIntoTestFiles([
      { filePath: AKIS_E2E_WORKFLOW_PATH, content: yaml, testCount: 0 },
      { filePath: 'tests/e2e/app.spec.ts', content: '// t', testCount: 1 },
    ]);
    assert.strictEqual(merged.length, 2);
  });

  it('still adds akis-e2e when another workflow file is present (not a duplicate blocker)', () => {
    const merged = mergeAkisCiWorkflowIntoTestFiles([
      { filePath: '.github/workflows/ci.yml', content: 'name: CI\n', testCount: 0 },
      { filePath: 'tests/e2e/app.spec.ts', content: '// t', testCount: 1 },
    ]);
    assert.strictEqual(merged.length, 3);
    assert.ok(merged.some((f) => f.filePath === AKIS_E2E_WORKFLOW_PATH));
  });

  it('hasAkisE2eWorkflowInBatch normalizes backslashes', () => {
    assert.strictEqual(
      hasAkisE2eWorkflowInBatch([
        { filePath: '.github\\workflows\\akis-e2e.yml', content: 'x', testCount: 0 },
      ]),
      true,
    );
  });
});
