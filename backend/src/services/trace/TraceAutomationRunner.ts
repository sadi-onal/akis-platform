/**
 * TraceAutomationRunner — executes generated Playwright tests and parses results.
 *
 * In S0.5 this runs tests via child_process with the Playwright JSON reporter.
 * The runner never uses shell: true (security).
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { TraceAutomationError } from '../../lib/errors.js';

export interface TraceTestSpec {
  featureName: string;
  scenarios: { name: string; steps: string[] }[];
}

export interface TraceRunResult {
  runner: 'playwright';
  mode: 'real';
  totalFeatures: number;
  passedFeatures: number;
  failedFeatures: number;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  passRate: number;
  durationMs: number;
  failures: { feature: string; scenario: string; reason: string }[];
  generatedTestPath: string;
  reportPath?: string;
  traceArtifactPath?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const ALLOWED_BROWSERS = ['chromium', 'firefox', 'webkit'] as const;

type BrowserTarget = (typeof ALLOWED_BROWSERS)[number];

function sanitizeBrowser(raw?: string): BrowserTarget {
  if (raw && ALLOWED_BROWSERS.includes(raw as BrowserTarget)) return raw as BrowserTarget;
  return 'chromium';
}

/**
 * Generate a Playwright test file from parsed specs.
 * Uses JSON.stringify for titles and URL so names with quotes/newlines cannot break TS syntax.
 */
export function buildTestFileContent(
  specs: TraceTestSpec[],
  baseUrl: string,
  browser: BrowserTarget
): string {
  const lines: string[] = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test.use({ browserName: '${browser}' });`,
    ``,
  ];
  for (const spec of specs) {
    lines.push(`test.describe(${JSON.stringify(spec.featureName)}, () => {`);
    for (const scenario of spec.scenarios) {
      lines.push(`  test(${JSON.stringify(scenario.name)}, async ({ page }) => {`);
      lines.push(
        `    await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: 'domcontentloaded' });`
      );
      lines.push(`    await expect(page.locator('body')).toBeVisible({ timeout: 15_000 });`);
      for (const step of scenario.steps) {
        const safe = String(step).replace(/\r?\n/g, ' ').replace(/\*\//g, '* /');
        lines.push(`    // ${safe}`);
      }
      lines.push(`  });`);
    }
    lines.push(`});`);
    lines.push(``);
  }
  return lines.join('\n');
}

/**
 * Parse Playwright JSON reporter output into structured results.
 */
function parseJsonReport(
  raw: string,
  specs: TraceTestSpec[]
): Omit<TraceRunResult, 'durationMs' | 'generatedTestPath'> {
  let report: {
    suites?: {
      title: string;
      specs?: { title: string; tests?: { results?: { status: string }[] }[] }[];
    }[];
  };
  try {
    report = JSON.parse(raw);
  } catch {
    // Fallback: assume all failed
    return buildFallbackResult(specs, 'JSON report parse error');
  }

  const failures: TraceRunResult['failures'] = [];
  let passed = 0;
  let failed = 0;
  const featureResults = new Map<string, boolean>();

  for (const suite of report.suites ?? []) {
    const featureName = suite.title || 'Unknown';
    let featurePassed = true;
    for (const spec of suite.specs ?? []) {
      const lastResult = spec.tests?.[0]?.results?.[0];
      const status = lastResult?.status ?? 'failed';
      if (status === 'passed' || status === 'expected') {
        passed++;
      } else {
        failed++;
        featurePassed = false;
        failures.push({ feature: featureName, scenario: spec.title, reason: status });
      }
    }
    featureResults.set(featureName, featureResults.get(featureName) !== false && featurePassed);
  }

  const totalScenarios = passed + failed;
  const passedFeatures = [...featureResults.values()].filter(Boolean).length;
  const totalFeatures = featureResults.size || specs.length;

  return {
    runner: 'playwright',
    mode: 'real',
    totalFeatures,
    passedFeatures,
    failedFeatures: totalFeatures - passedFeatures,
    totalScenarios,
    passedScenarios: passed,
    failedScenarios: failed,
    passRate: totalScenarios > 0 ? Math.round((passed / totalScenarios) * 100) : 0,
    failures,
  };
}

function buildFallbackResult(
  specs: TraceTestSpec[],
  reason: string
): Omit<TraceRunResult, 'durationMs' | 'generatedTestPath'> {
  const scenarios = specs.flatMap((s) => s.scenarios);
  return {
    runner: 'playwright',
    mode: 'real',
    totalFeatures: specs.length,
    passedFeatures: 0,
    failedFeatures: specs.length,
    totalScenarios: scenarios.length,
    passedScenarios: 0,
    failedScenarios: scenarios.length,
    passRate: 0,
    failures: scenarios.map((sc) => ({ feature: '', scenario: sc.name, reason })),
  };
}

export interface RunOptions {
  specs: TraceTestSpec[];
  baseUrl: string;
  browserTarget?: string;
  timeoutMs?: number;
}

/**
 * Execute Playwright tests and return structured results.
 * Creates a temp workspace, writes generated tests, runs npx playwright test,
 * and parses the JSON reporter output.
 */
export async function runTraceAutomation(opts: RunOptions): Promise<TraceRunResult> {
  const { specs, baseUrl, browserTarget, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const browser = sanitizeBrowser(browserTarget);
  const workDir = join(tmpdir(), `akis-trace-${randomUUID()}`);
  const testFile = join(workDir, 'trace.spec.ts');
  const reportFile = join(workDir, 'results.json');
  const outputDir = join(workDir, 'playwright-output');
  const traceArtifactPath = join(outputDir, 'trace.zip');

  await mkdir(workDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(testFile, buildTestFileContent(specs, baseUrl, browser), 'utf-8');

  const start = Date.now();

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(
        'npx',
        [
          'playwright',
          'test',
          testFile,
          '--reporter=json',
          '--workers=1',
          '--trace',
          'on-first-retry',
          '--output',
          outputDir,
        ],
        {
          cwd: workDir,
          shell: false,
          timeout: timeoutMs,
          env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
        }
      );

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(
          new TraceAutomationError(
            'TRACE_AUTOMATION_TIMEOUT',
            `Playwright run exceeded ${timeoutMs}ms timeout`
          )
        );
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new TraceAutomationError(
            'TRACE_AUTOMATION_LAUNCH_FAILED',
            `Failed to launch Playwright: ${err.message}`
          )
        );
      });
    });

    let reportJson = '{}';
    try {
      reportJson = await readFile(reportFile, 'utf-8');
    } catch {
      // Report file may not exist if all tests failed to start
      if (exitCode !== 0) {
        return {
          ...buildFallbackResult(specs, `Playwright exited with code ${exitCode}`),
          durationMs: Date.now() - start,
          generatedTestPath: testFile,
          reportPath: reportFile,
        };
      }
    }

    const parsed = parseJsonReport(reportJson, specs);
    return {
      ...parsed,
      durationMs: Date.now() - start,
      generatedTestPath: testFile,
      reportPath: reportFile,
      traceArtifactPath,
    };
  } finally {
    // Cleanup is optional to keep generated artifacts accessible after run.
    // Caller can remove temp workspaces via host-level cleanup jobs.
    if (process.env.AKIS_TRACE_KEEP_ARTIFACTS !== 'true') {
      rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
