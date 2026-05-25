# S2 — Trace Test Execution & Report

## Problem

TraceAgent generates Playwright test files but **never executes them**. The system prompt explicitly says `"Do NOT run the tests — only write them"`. A fully implemented `TraceAutomationRunner` exists in `backend/src/services/trace/TraceAutomationRunner.ts` (spawns `npx playwright test`, parses JSON report, 120s timeout) but is **unwired from the pipeline**.

Users see:
- AI-estimated `coveragePercentage` (not real pass/fail data)
- CI badge linking to GitHub Actions (only after push)
- No way to know if generated tests actually pass before committing to GitHub

## Decision

Wire `TraceAutomationRunner` into the pipeline as a **pre-push gate**. Tests execute locally after Trace generates them, results gate the push confirmation. The user sees real pass/fail data before deciding to push.

## Architecture Change

### Current flow
```
Proto → Critic (code review) → Trace (generate tests) → awaiting_push_confirm → push → CI
```

### New flow
```
Proto → Critic (code review) → Trace (generate tests) → TraceRunner (execute tests)
                                                              ↓
                                                    trace_executing stage
                                                              ↓
                                                    awaiting_push_confirm
                                                    (with real test results)
                                                              ↓
                                                         push → CI
```

### New pipeline stage: `trace_executing`

Add to `pipeline_stage` enum between `trace_testing` and `awaiting_push_confirm`.

DB migration: `ALTER TYPE pipeline_stage ADD VALUE 'trace_executing' BEFORE 'awaiting_push_confirm';`

## Backend Changes

### 1. Wire TraceAutomationRunner into Orchestrator

In `PipelineOrchestrator`, after Trace completes successfully (`handleTraceResult`):

```
if (traceOutput.ok && traceOutput.testFiles.length > 0) {
  transition to 'trace_executing'
  emit activity: "Test dosyaları koşturuluyor..."
  
  // Build workspace: Proto's generated files + Trace's test files
  const workspace = mergeFiles(protoOutput.files, traceOutput.testFiles)
  
  // Run tests
  const runResult = await traceAutomationRunner.run(workspace, {
    timeout: TRACE_RUNNER_TIMEOUT_MS,  // env: default 120000
    keepArtifacts: false
  })
  
  // Store results on pipeline state
  updateState({ traceRunResults: runResult })
  
  transition to 'awaiting_push_confirm'
}
```

### 2. New state field: `traceRunResults`

Add to `PipelineState` and store in `pipelines.intermediate_state` JSONB:

```typescript
interface TraceRunResults {
  passed: boolean;              // all tests passed
  passRate: number;             // 0-100
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  durationMs: number;
  testDetails: Array<{
    name: string;
    file: string;
    status: 'passed' | 'failed' | 'skipped' | 'timedOut';
    durationMs: number;
    error?: {
      message: string;
      snippet?: string;         // first 500 chars of stack trace
    };
  }>;
  executedAt: string;           // ISO timestamp
  timedOut: boolean;
  runnerError?: string;         // if runner itself crashed (not a test failure)
}
```

### 3. TraceAutomationRunner adjustments

The existing runner in `backend/src/services/trace/TraceAutomationRunner.ts` is mostly ready. Adjustments:

- **Input:** Accept a merged file map (Proto files + test files) instead of just test files. Write all files to the temp workspace so Playwright can resolve imports.
- **Playwright config:** If Trace generated a `playwright.config.ts`, use it. Otherwise inject a minimal config targeting the workspace.
- **JSON reporter:** Already uses `--reporter=json` — parse `stdout` for structured results.
- **Cleanup:** Already handles temp directory cleanup. Honor `AKIS_TRACE_KEEP_ARTIFACTS=true` for debugging.
- **Return type:** Map the existing `TraceRunResult` to the new `TraceRunResults` interface.

### 4. Env configuration

| Variable | Default | Description |
|---|---|---|
| `TRACE_RUNNER_TIMEOUT_MS` | `120000` | Max time for test execution |
| `TRACE_RUNNER_ENABLED` | `true` | Feature flag to disable local execution (falls back to current behavior) |
| `AKIS_TRACE_KEEP_ARTIFACTS` | `false` | Keep temp workspace for debugging |

### 5. Error handling

| Scenario | Behavior |
|---|---|
| All tests pass | Green badge, normal push flow |
| Some tests fail | Red badge with failure details, user can still push (warn) or re-iterate |
| Runner timeout (120s) | Yellow badge "zaman aşımı", user can push anyway |
| Runner crash | Store error, skip execution, log warning, proceed to push confirm |
| No test files | Skip execution entirely (no `trace_executing` stage) |

### 6. Fix-loop integration

If tests fail and the user doesn't push, the existing iterate-loop (`evaluateTraceIterateLoop`) can be triggered. But now it has **real failure data** instead of just "uncovered criteria":

- Feed `traceRunResults.testDetails` (failed tests with error messages) back to Proto as feedback
- Proto regenerates code addressing specific test failures
- Trace regenerates tests
- TraceRunner re-executes
- Loop up to `TRACE_MAX_ITERATE_RETRIES` times

## Frontend Changes

### PushConfirmGate — Test Results Panel

Add a collapsible section to the existing `PushConfirmGate` component (which already shows preview, trace dry-run status, and AC coverage).

#### Layout
```
┌─────────────────────────────────────────────┐
│ Test Sonuçları                    ✓ 27/29   │
│ ┌─────────────────────────────────────────┐ │
│ │ ✓ auth.spec.ts (5/5)              1.2s  │ │
│ │ ✓ dashboard.spec.ts (8/8)         2.4s  │ │
│ │ ✗ pipeline.spec.ts (12/14)        3.1s  │ │
│ │   └ ✗ should show error on fail   0.8s  │ │
│ │     Error: Expected "Hata" but got...   │ │
│ │   └ ✗ should retry on timeout     1.2s  │ │
│ │     Error: Timeout waiting for...       │ │
│ │ ✓ settings.spec.ts (2/2)          0.9s  │ │
│ └─────────────────────────────────────────┘ │
│ Süre: 7.6s  │  Başarı: %93                 │
└─────────────────────────────────────────────┘
```

#### Styling
- Pass: `text-emerald-400` with `✓` icon
- Fail: `text-red-400` with `✗` icon
- Skip: `text-gray-500` with `○` icon
- File row: `bg-gray-900 hover:bg-gray-800 rounded-lg px-3 py-2 cursor-pointer`
- Expanded error: `bg-red-950/30 border-l-2 border-red-500 px-4 py-2 text-sm font-mono`
- Summary bar: `bg-gray-900 border-t border-gray-800 px-4 py-3`

#### States
- **Loading:** Skeleton with pulsing bars + "Testler koşturuluyor..." text
- **All pass:** Green summary, collapsed by default
- **Some fail:** Red summary, auto-expanded to show failures
- **Timeout:** Yellow summary, "Zaman aşımı — testler tamamlanamadı"
- **Runner error:** Gray summary, "Test altyapısı hatası — testler atlandı"

### Chat timeline events

New event types in `ScribeMessageType`:

- `trace_executing_started`: `{ testCount: number }`
- `trace_executing_completed`: `{ passed: boolean, passRate: number, passedTests: number, failedTests: number, durationMs: number }`
- `trace_executing_failed`: `{ error: string, timedOut: boolean }`

### PipelineCinema

Add `trace_executing` to `STAGE_ORDER` after `trace_testing`. Activity messages: "Testler koşturuluyor...", "27/29 test başarılı", etc.

## Acceptance Criteria

- [ ] New `trace_executing` pipeline stage in DB enum
- [ ] TraceAutomationRunner wired into orchestrator after Trace completion
- [ ] Proto files + test files merged into temp workspace
- [ ] Playwright tests execute with JSON reporter, results parsed
- [ ] `traceRunResults` stored in pipeline `intermediateState`
- [ ] 120s timeout with graceful handling
- [ ] `TRACE_RUNNER_ENABLED` feature flag (disable → skip execution)
- [ ] PushConfirmGate shows test result panel with per-file pass/fail
- [ ] Failed tests expandable to show error message + snippet
- [ ] Summary shows pass rate + duration
- [ ] Loading state with skeleton during execution
- [ ] Timeout and runner-error states handled gracefully
- [ ] Fix-loop feeds real test failures back to Proto (not just coverage gaps)
- [ ] Cinema column shows trace_executing activity
- [ ] Chat timeline events for execution start/complete/fail
- [ ] i18n: TR + EN strings for all UI text

## Out of Scope

- HTML report generation (Playwright's built-in HTML reporter) — future
- Screenshot capture on failure — future
- Parallel test execution across multiple workers — default Playwright parallelism is fine
- Test result history / flakiness tracking (FlakyTestManager exists but out of scope)
- Re-running individual failed tests (user re-iterates the full loop)

## Risks

- **Playwright not installed in backend env:** The runner spawns `npx playwright test`. In Docker/production, Playwright + browsers must be available. May need `playwright install --with-deps chromium` in Dockerfile.
- **Generated tests may not be runnable:** AI-generated tests can have import errors, missing fixtures, etc. Runner must handle subprocess crashes gracefully.
- **120s may be tight for large test suites:** 29 tests should finish well within 120s. Monitor and adjust.
