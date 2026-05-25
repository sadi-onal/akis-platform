# Orchestrator Kademe 4 — Structural Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce PipelineOrchestrator.ts from 4063 to ~900 LOC by applying 4 structural patterns: typed IntermediateState, scoped execution context cache, FSM transition guard table, and stage runner extraction — with zero behavioral change.

**Architecture:** Bottom-up layered approach matching the proven Kademe 1→2→3 progression. Layer 1 (types) removes 60+ unsafe casts. Layer 2 (context cache) eliminates ~35 redundant DB reads per pipeline run. Layer 3 (FSM guard) catches invalid transitions at compile-time. Layer 4 (extraction) moves 7 stage runners to standalone functions with deps injection. Each layer builds on the previous — types enable context cache, context cache feeds into runner deps, FSM guard wires through deps.

**Tech Stack:** TypeScript 5 strict mode, Node.js built-in test runner (via tsx), Drizzle ORM (JSONB column unchanged), Fastify 4 (no route changes).

**Spec:** `docs/superpowers/specs/2026-05-26-orchestrator-kademe4-refactor-design.md`

---

## File Structure

### New Files

| File | LOC | Purpose |
|---|---|---|
| `backend/src/pipeline/core/contracts/IntermediateState.ts` | ~130 | 9 domain interfaces + composed PipelineIntermediateState type |
| `backend/src/pipeline/core/contracts/PipelineTransitions.ts` | ~90 | VALID_TRANSITIONS table + assertValidTransition guard |
| `backend/src/pipeline/core/orchestrator/PipelineExecutionContext.ts` | ~40 | Scoped pipeline state cache |
| `backend/src/pipeline/core/orchestrator/stages/runScribeAnalysis.ts` | ~130 | Scribe analysis standalone function |
| `backend/src/pipeline/core/orchestrator/stages/runScribeContinuation.ts` | ~70 | Scribe continuation standalone function |
| `backend/src/pipeline/core/orchestrator/stages/runProtoAndTrace.ts` | ~420 | Proto+Trace pipeline standalone function |
| `backend/src/pipeline/core/orchestrator/stages/runTrace.ts` | ~340 | Trace standalone function |
| `backend/src/pipeline/core/orchestrator/stages/runIterationProto.ts` | ~160 | Iteration Proto standalone function |
| `backend/src/pipeline/core/orchestrator/stages/runConfirmedPush.ts` | ~130 | Push confirmation standalone function |
| `backend/src/pipeline/core/orchestrator/stages/runCiPolling.ts` | ~90 | CI workflow polling standalone function |
| `backend/test/unit/pipeline/PipelineTransitions.test.ts` | ~80 | Transition table unit tests |
| `backend/test/unit/pipeline/PipelineExecutionContext.test.ts` | ~60 | Context cache unit tests |

### Modified Files

| File | Change |
|---|---|
| `backend/src/pipeline/core/contracts/PipelineTypes.ts` | `intermediateState` type: `Record<string, unknown>` → `PipelineIntermediateState` |
| `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts` | 4063 → ~900 LOC (runners extracted, wrappers removed) |
| `backend/src/pipeline/core/orchestrator/helpers/activityHelpers.ts` | Remove `as Record<string, unknown>` casts |
| `backend/src/pipeline/core/orchestrator/helpers/reasoningHelpers.ts` | Remove casts |
| `backend/src/pipeline/core/orchestrator/helpers/criticHelpers.ts` | Remove casts |
| `backend/src/pipeline/core/orchestrator/stages/retryHandlers.ts` | Remove casts, use `transitionStage` pattern |
| `backend/src/pipeline/core/orchestrator/stages/iterateDispatchers.ts` | Remove casts, use `transitionStage` pattern |
| `backend/src/pipeline/core/orchestrator/outcomes/ProtoTraceOutcome.ts` | Remove casts, typed intermediateState |
| `backend/src/pipeline/core/orchestrator/outcomes/TraceOutcome.ts` | Remove casts, typed intermediateState |

---

## Task 1: Define PipelineIntermediateState Type

**Files:**
- Create: `backend/src/pipeline/core/contracts/IntermediateState.ts`

- [ ] **Step 1: Create IntermediateState.ts with all 9 domain interfaces**

```typescript
// backend/src/pipeline/core/contracts/IntermediateState.ts
import type { CriticReviewOutput } from '../../agents/critic/CriticTypes.js';
import type { AnthropicImageBlock } from '../../../services/ai/multimodalClient.js';
import type { CIResult } from '../../services/CIService.js';
import type { AcCoverageReport } from '../explainability/acCoverage.js';

// ─── Domain Group 1: Pipeline Origin ────────────
export interface OriginState {
  parentPipelineId?: string;
  existingRepo?: { owner: string; repo: string; branch: string };
  iterationRequest?: string;
  attachmentContext?: string;
  imageBlocks?: readonly AnthropicImageBlock[];
  cucumberEnabled?: boolean;
}

// ─── Domain Group 2: Agent Checkpoint ───────────
export interface CheckpointState {
  agent?: string;
  startedAt?: string;
  status?: 'in_progress' | 'completed' | 'failed';
  inputSummary?: string;
}

// ─── Domain Group 3: Deterministic Validation ───
export interface ValidationState {
  validationResult?: {
    passed: boolean;
    score: number;
    summary: { errors: number; warnings: number; checksRun: string[] };
  };
}

// ─── Domain Group 4: Critic Review ──────────────
export interface IterationHistoryEntry {
  iteration: number;
  protoConfidence: number | null;
  criticScore: number | null;
  criticFindingsCount: number;
  criticCriticalCount: number;
  timestamp: string;
  decision: string;
}

export interface CriticBlockState {
  blockedAt: string;
  overallScore: number;
  findingsCount: number;
  maxSeverity: string;
  manuallyOverridden?: boolean;
  overriddenAt?: string;
}

export interface CriticState {
  criticSpecOutput?: CriticReviewOutput;
  criticCodeOutput?: CriticReviewOutput;
  criticBlock?: CriticBlockState;
  criticIterateRetryCount?: number;
  iterationHistory?: IterationHistoryEntry[];
}

// ─── Domain Group 5: Trace Loop ─────────────────
export interface TraceLoopState {
  traceIterateRetryCount?: number;
  traceIterateLastFeedback?: string;
  traceIterateLastAt?: string;
  traceDryRunStatus?: 'success' | 'failed';
  traceDryRunErrorCode?: string;
  traceDryRunErrorAt?: string;
  traceDryRunCompletedAt?: string;
  lastFailedTraceResponse?: string;
  traceSkipReason?: string;
}

// ─── Domain Group 6: Auto-Approve ───────────────
export interface AutoApproveState {
  autoApproved?: boolean;
  autoApproveScore?: number;
}

// ─── Domain Group 7: CI Integration ─────────────
export interface CIIntegrationState {
  ciResult?: CIResult;
}

// ─── Domain Group 8: AC Coverage ────────────────
export interface CoverageState {
  acCoverage?: AcCoverageReport;
}

// ─── Domain Group 9: Explainability ─────────────
export interface ExplainabilityDegradedState {
  explainabilityDegraded?: boolean;
  explainabilityDegradedAt?: string;
}

// ─── Composed Type ──────────────────────────────
export type PipelineIntermediateState = OriginState &
  CheckpointState &
  ValidationState &
  CriticState &
  TraceLoopState &
  AutoApproveState &
  CIIntegrationState &
  CoverageState &
  ExplainabilityDegradedState;
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm -C backend typecheck`
Expected: PASS (new file has no consumers yet)

- [ ] **Step 3: Commit**

```bash
git add backend/src/pipeline/core/contracts/IntermediateState.ts
git commit -m "refactor(types): define PipelineIntermediateState — 9 domain interfaces (Kademe 4, step 1)"
```

---

## Task 2: Wire IntermediateState into PipelineTypes

**Files:**
- Modify: `backend/src/pipeline/core/contracts/PipelineTypes.ts` (line ~407)
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts` (line ~217, PipelineStateUpdate)

- [ ] **Step 1: Update PipelineState.intermediateState type**

In `backend/src/pipeline/core/contracts/PipelineTypes.ts`, add the import and change the field:

```typescript
// Add import at the top of the file, after other imports:
import type { PipelineIntermediateState } from './IntermediateState.js';

// Change line ~407 from:
//   intermediateState?: Record<string, unknown>;
// to:
  intermediateState?: PipelineIntermediateState;
```

- [ ] **Step 2: Update PipelineStateUpdate.intermediateState type**

In `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`, add the import and change the field in `PipelineStateUpdate`:

```typescript
// Add import at the top (with the other contract imports):
import type { PipelineIntermediateState } from '../contracts/IntermediateState.js';

// Change line ~217 from:
//   intermediateState: Record<string, unknown>;
// to:
  intermediateState: PipelineIntermediateState;
```

- [ ] **Step 3: Run typecheck — expect compiler errors**

Run: `pnpm -C backend typecheck 2>&1 | head -80`

Expected: Multiple type errors across files where `intermediateState` is accessed via `as Record<string, unknown>` or assigned from an incompatible type. This is correct — the compiler is now surfacing every unsafe access point.

Count and note the errors — they'll be fixed in Task 3.

- [ ] **Step 4: Commit (WIP — compiles with errors)**

```bash
git add backend/src/pipeline/core/contracts/PipelineTypes.ts backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
git commit -m "refactor(types): wire PipelineIntermediateState into PipelineState + PipelineStateUpdate [WIP — cast fixes in next commit]"
```

---

## Task 3: Fix All IntermediateState Cast Sites

**Files:**
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`
- Modify: `backend/src/pipeline/core/orchestrator/helpers/activityHelpers.ts`
- Modify: `backend/src/pipeline/core/orchestrator/helpers/reasoningHelpers.ts`
- Modify: `backend/src/pipeline/core/orchestrator/helpers/criticHelpers.ts`
- Modify: `backend/src/pipeline/core/orchestrator/stages/retryHandlers.ts`
- Modify: `backend/src/pipeline/core/orchestrator/stages/iterateDispatchers.ts`
- Modify: `backend/src/pipeline/core/orchestrator/outcomes/ProtoTraceOutcome.ts`
- Modify: `backend/src/pipeline/core/orchestrator/outcomes/TraceOutcome.ts`

The principle is the same for every file: remove `as Record<string, unknown>` casts and use direct typed property access. Below are the specific patterns per file.

- [ ] **Step 1: Fix PipelineOrchestrator.ts cast sites**

Across the file, apply these transformations. Each `as Record<string, unknown>` or `as X | undefined` cast on `intermediateState` becomes direct typed access:

**Pattern A: Read access — remove cast, use optional chaining**
```typescript
// BEFORE:
const existingRepo = pipeline.intermediateState?.existingRepo as
  | { owner: string; repo: string; branch?: string }
  | undefined;

// AFTER:
const existingRepo = pipeline.intermediateState?.existingRepo;
```

**Pattern B: Write access — remove Record cast on existing state**
```typescript
// BEFORE:
const existingIntermediate = (currentState?.intermediateState ?? {}) as Record<string, unknown>;
await this.store.update(pipelineId, {
  intermediateState: { ...existingIntermediate, criticCodeOutput: criticResult },
});

// AFTER:
await this.store.update(pipelineId, {
  intermediateState: { ...(currentState?.intermediateState ?? {}), criticCodeOutput: criticResult },
});
```

**Pattern C: Conditional read — remove cast, type is now known**
```typescript
// BEFORE:
const cucumberEnabled =
  (pipelineForCucumber.intermediateState as Record<string, unknown> | undefined)
    ?.cucumberEnabled === true;

// AFTER:
const cucumberEnabled = pipelineForCucumber.intermediateState?.cucumberEnabled === true;
```

Apply to every `intermediateState` access site in the file. Use the compiler errors from Task 2 Step 3 as your guide — each error is a cast site to fix.

- [ ] **Step 2: Fix helpers/ cast sites**

**activityHelpers.ts** — accesses `validationResult`, `criticSpecOutput`, `criticCodeOutput`:
```typescript
// BEFORE:
const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
const validationResult = intermediate.validationResult as { passed?: boolean; score?: number; ... } | undefined;

// AFTER:
const validationResult = pipeline.intermediateState?.validationResult;
```

**reasoningHelpers.ts** — accesses `explainabilityDegraded`, `acCoverage`:
```typescript
// BEFORE:
const existing = (currentState?.intermediateState ?? {}) as Record<string, unknown>;
await store.update(pipelineId, {
  intermediateState: { ...existing, explainabilityDegraded: true },
});

// AFTER:
await store.update(pipelineId, {
  intermediateState: { ...(currentState?.intermediateState ?? {}), explainabilityDegraded: true },
});
```

**criticHelpers.ts** — accesses `traceIterateRetryCount`, `criticIterateRetryCount`:
```typescript
// BEFORE:
const intermediate = (currentState?.intermediateState ?? {}) as Record<string, unknown>;
const retryCount = (intermediate.criticIterateRetryCount as number) ?? 0;

// AFTER:
const retryCount = currentState?.intermediateState?.criticIterateRetryCount ?? 0;
```

- [ ] **Step 3: Fix stages/ and outcomes/ cast sites**

**retryHandlers.ts** — accesses `traceDryRunStatus`, `traceDryRunErrorCode`:
```typescript
// BEFORE:
const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;

// AFTER — remove cast, access directly:
const intermediate = pipeline.intermediateState ?? {};
```

**iterateDispatchers.ts** — accesses and writes `traceIterateRetryCount`, `criticIterateRetryCount`, and feedback/timestamp fields:
```typescript
// BEFORE:
const intermediate = (pipeline.intermediateState ?? {}) as Record<string, unknown>;
const currentCount = (intermediate.traceIterateRetryCount as number) ?? 0;

// AFTER:
const currentCount = pipeline.intermediateState?.traceIterateRetryCount ?? 0;
```

**ProtoTraceOutcome.ts** and **TraceOutcome.ts** — read/write `intermediateState` in outcome handlers:
```typescript
// BEFORE:
const intermediate = (currentState?.intermediateState ?? {}) as Record<string, unknown>;

// AFTER:
const intermediate = currentState?.intermediateState ?? {};
```

- [ ] **Step 4: Fix updatePipelineConfig dead read**

In `PipelineOrchestrator.ts`, the `updatePipelineConfig` method (line ~2854) calls `getPipeline` but never uses the result. Remove the dead call:

```typescript
// BEFORE:
async updatePipelineConfig(pipelineId: string, config: Record<string, unknown>): Promise<PipelineState> {
  await this.getPipeline(pipelineId);  // ← dead read
  const update: Partial<PipelineStateUpdate> = {};

// AFTER:
async updatePipelineConfig(pipelineId: string, config: Record<string, unknown>): Promise<PipelineState> {
  const update: Partial<PipelineStateUpdate> = {};
```

- [ ] **Step 5: Run typecheck — expect zero errors**

Run: `pnpm -C backend typecheck`
Expected: PASS (0 errors)

- [ ] **Step 6: Run full test suite**

Run: `pnpm -C backend test`
Expected: All existing tests pass

- [ ] **Step 7: Verify zero `as Record<string, unknown>` casts remain in orchestrator tree**

Run: `grep -rn 'as Record<string, unknown>' backend/src/pipeline/core/orchestrator/`
Expected: Zero matches

- [ ] **Step 8: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/ backend/src/pipeline/core/contracts/
git commit -m "refactor(types): remove all intermediateState unsafe casts — compile-time type safety (Kademe 4, step 2)"
```

---

## Task 4: Create PipelineExecutionContext

**Files:**
- Create: `backend/src/pipeline/core/orchestrator/PipelineExecutionContext.ts`
- Create: `backend/test/unit/pipeline/PipelineExecutionContext.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// backend/test/unit/pipeline/PipelineExecutionContext.test.ts
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineExecutionContext } from '../../../src/pipeline/core/orchestrator/PipelineExecutionContext.js';

const makeMockStore = (pipeline: Record<string, unknown> | null = { id: 'p1', stage: 'proto_building' }) => ({
  getById: mock.fn(async () => pipeline),
  create: mock.fn(),
  listByUser: mock.fn(),
  update: mock.fn(),
});

describe('PipelineExecutionContext', () => {
  it('fetches from DB on first get()', async () => {
    const store = makeMockStore();
    const ctx = new PipelineExecutionContext(store as any, 'p1');
    const result = await ctx.get();
    assert.equal(result.id, 'p1');
    assert.equal(store.getById.mock.callCount(), 1);
    assert.equal(ctx.dbReads, 1);
  });

  it('returns cached value on second get()', async () => {
    const store = makeMockStore();
    const ctx = new PipelineExecutionContext(store as any, 'p1');
    await ctx.get();
    await ctx.get();
    assert.equal(store.getById.mock.callCount(), 1);
    assert.equal(ctx.dbReads, 1);
  });

  it('re-fetches after invalidate()', async () => {
    const store = makeMockStore();
    const ctx = new PipelineExecutionContext(store as any, 'p1');
    await ctx.get();
    ctx.invalidate();
    await ctx.get();
    assert.equal(store.getById.mock.callCount(), 2);
    assert.equal(ctx.dbReads, 2);
  });

  it('throws when pipeline not found', async () => {
    const store = makeMockStore(null);
    const ctx = new PipelineExecutionContext(store as any, 'missing');
    await assert.rejects(() => ctx.get(), /Pipeline not found: missing/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline/PipelineExecutionContext.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create PipelineExecutionContext.ts**

```typescript
// backend/src/pipeline/core/orchestrator/PipelineExecutionContext.ts
import type { PipelineState } from '../contracts/PipelineTypes.js';
import type { PipelineStore } from './PipelineOrchestrator.js';

export class PipelineExecutionContext {
  private snapshot: PipelineState | null = null;
  private _dbReads = 0;

  constructor(
    private readonly store: PipelineStore,
    readonly pipelineId: string
  ) {}

  async get(): Promise<PipelineState> {
    if (!this.snapshot) {
      const row = await this.store.getById(this.pipelineId);
      if (!row) throw new Error(`Pipeline not found: ${this.pipelineId}`);
      this.snapshot = row;
      this._dbReads++;
    }
    return this.snapshot;
  }

  invalidate(): void {
    this.snapshot = null;
  }

  get dbReads(): number {
    return this._dbReads;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline/PipelineExecutionContext.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Run full typecheck + test suite**

Run: `pnpm -C backend typecheck && pnpm -C backend test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/PipelineExecutionContext.ts backend/test/unit/pipeline/PipelineExecutionContext.test.ts
git commit -m "refactor: add PipelineExecutionContext — scoped pipeline state cache (Kademe 4, step 3)"
```

---

## Task 5: Create FSM Transition Guard Table

**Files:**
- Create: `backend/src/pipeline/core/contracts/PipelineTransitions.ts`
- Create: `backend/test/unit/pipeline/PipelineTransitions.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// backend/test/unit/pipeline/PipelineTransitions.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VALID_TRANSITIONS, assertValidTransition } from '../../../src/pipeline/core/contracts/PipelineTransitions.js';

describe('VALID_TRANSITIONS', () => {
  it('covers all 15 PipelineStage values', () => {
    const stages = [
      'scribe_clarifying', 'scribe_generating', 'critic_reviewing_spec',
      'awaiting_approval', 'proto_building', 'critic_reviewing_code',
      'awaiting_critic_resolution', 'awaiting_push_confirm', 'trace_testing',
      'fix_loop_iteration', 'ci_running', 'completed', 'completed_partial',
      'failed', 'cancelled',
    ] as const;
    for (const stage of stages) {
      assert.ok(stage in VALID_TRANSITIONS, `Missing stage: ${stage}`);
    }
    assert.equal(Object.keys(VALID_TRANSITIONS).length, stages.length);
  });

  it('cancelled has no outgoing transitions', () => {
    assert.deepEqual(VALID_TRANSITIONS.cancelled, []);
  });

  it('failed can transition to retry targets + cancelled', () => {
    const fromFailed = VALID_TRANSITIONS.failed;
    assert.ok(fromFailed.includes('proto_building'));
    assert.ok(fromFailed.includes('trace_testing'));
    assert.ok(fromFailed.includes('cancelled'));
  });

  it('every transition target is itself a valid stage', () => {
    const allStages = new Set(Object.keys(VALID_TRANSITIONS));
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const target of targets) {
        assert.ok(allStages.has(target), `${from} → ${target}: target is not a valid stage`);
      }
    }
  });
});

describe('assertValidTransition', () => {
  it('allows valid transition', () => {
    assert.doesNotThrow(() => assertValidTransition('awaiting_approval', 'proto_building', 'test-id'));
  });

  it('throws on invalid transition in non-production', () => {
    assert.throws(
      () => assertValidTransition('completed', 'proto_building', 'test-id'),
      /Invalid FSM transition: completed → proto_building/
    );
  });

  it('allows cancelled from completed', () => {
    assert.doesNotThrow(() => assertValidTransition('completed', 'cancelled', 'test-id'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline/PipelineTransitions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create PipelineTransitions.ts**

```typescript
// backend/src/pipeline/core/contracts/PipelineTransitions.ts
import type { PipelineStage } from './PipelineTypes.js';
import { logger } from '../../../lib/logger.js';

export const VALID_TRANSITIONS: Record<PipelineStage, readonly PipelineStage[]> = {
  scribe_generating:      ['scribe_clarifying', 'awaiting_approval', 'critic_reviewing_spec', 'failed'],
  scribe_clarifying:      ['scribe_generating', 'failed'],
  critic_reviewing_spec:  ['awaiting_approval', 'proto_building', 'failed'],
  awaiting_approval:      ['proto_building', 'scribe_generating', 'failed', 'cancelled'],
  proto_building:         ['critic_reviewing_code', 'trace_testing', 'awaiting_push_confirm', 'completed', 'completed_partial', 'ci_running', 'failed', 'cancelled'],
  critic_reviewing_code:  ['proto_building', 'awaiting_critic_resolution', 'trace_testing', 'awaiting_push_confirm', 'failed', 'cancelled'],
  awaiting_critic_resolution: ['awaiting_push_confirm', 'proto_building', 'failed', 'cancelled'],
  trace_testing:          ['completed', 'completed_partial', 'awaiting_push_confirm', 'fix_loop_iteration', 'proto_building', 'failed', 'cancelled'],
  fix_loop_iteration:     ['completed', 'completed_partial', 'failed', 'cancelled'],
  ci_running:             ['completed', 'completed_partial', 'failed', 'cancelled'],
  awaiting_push_confirm:  ['proto_building', 'completed', 'completed_partial', 'ci_running', 'failed', 'cancelled'],
  completed:              ['cancelled'],
  completed_partial:      ['cancelled'],
  failed:                 ['scribe_clarifying', 'scribe_generating', 'proto_building', 'trace_testing', 'awaiting_push_confirm', 'cancelled'],
  cancelled:              [],
} as const;

export function assertValidTransition(
  from: PipelineStage,
  to: PipelineStage,
  pipelineId: string
): void {
  const allowed = VALID_TRANSITIONS[from];
  if (allowed.includes(to)) return;

  const msg = `Invalid FSM transition: ${from} → ${to} (pipeline ${pipelineId}). Allowed: [${allowed.join(', ')}]`;
  if (process.env.NODE_ENV === 'production') {
    logger.error({ pipelineId, from, to }, msg);
  } else {
    throw new Error(msg);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C backend exec tsx --test test/unit/pipeline/PipelineTransitions.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full typecheck + test suite**

Run: `pnpm -C backend typecheck && pnpm -C backend test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/pipeline/core/contracts/PipelineTransitions.ts backend/test/unit/pipeline/PipelineTransitions.test.ts
git commit -m "refactor: add FSM transition guard table — 15 stages, compile-time complete (Kademe 4, step 4)"
```

---

## Task 6: Add transitionStage Helper to Orchestrator

**Files:**
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`

- [ ] **Step 1: Add transitionStage helper method**

Add this private method to the PipelineOrchestrator class, near the existing `emitEvent` method:

```typescript
// Add import at the top of the file:
import { assertValidTransition } from '../contracts/PipelineTransitions.js';

// Add the method to the class body (near emitEvent):

  /**
   * FSM-guarded stage transition. Validates the from→to transition against
   * VALID_TRANSITIONS before writing to DB. In dev/test, throws on invalid
   * transitions; in production, logs and allows (fail-open).
   */
  private async transitionStage(
    pipelineId: string,
    from: PipelineStage,
    to: PipelineStage,
    extraUpdate?: Partial<PipelineStateUpdate>,
    opts?: { expectedStageVersion?: number }
  ): Promise<PipelineState> {
    assertValidTransition(from, to, pipelineId);
    return this.store.update(pipelineId, { stage: to, ...extraUpdate }, opts);
  }
```

- [ ] **Step 2: Run typecheck + tests**

Run: `pnpm -C backend typecheck && pnpm -C backend test`
Expected: PASS (method is added but not yet called — no behavioral change)

- [ ] **Step 3: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
git commit -m "refactor: add transitionStage FSM-guarded helper to orchestrator (Kademe 4, step 5)"
```

---

## Task 7: Extract runScribeAnalysis + runScribeContinuation

**Files:**
- Create: `backend/src/pipeline/core/orchestrator/stages/runScribeAnalysis.ts`
- Create: `backend/src/pipeline/core/orchestrator/stages/runScribeContinuation.ts`
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`

- [ ] **Step 1: Create runScribeAnalysis.ts**

Move the `runScribeAnalysis` method body (PipelineOrchestrator.ts lines 789–909) into a standalone function. The function signature follows the existing pattern from `retryHandlers.ts`:

```typescript
// backend/src/pipeline/core/orchestrator/stages/runScribeAnalysis.ts
import type { PipelineMetrics, ScribeInput, ScribeMessageType } from '../../contracts/PipelineTypes.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';
import type { ScribeAgent, ScribeState, ScribeResult } from '../../../agents/scribe/ScribeAgent.js';
import type { AgentSet } from '../PipelineOrchestrator.js';
import type { PipelineExecutionContext } from '../PipelineExecutionContext.js';
import type { TokenUsageCallback } from '../../pipeline-factory.js';
import { createActivityEmitter } from '../../activityEmitter.js';
import { withRetry } from '../../retryWrapper.js';
import { scoreScribeEffort } from '../../effortScorer.js';
import { logger } from '../../../../lib/logger.js';
import { pipelineCallContext } from '../../ai-calls/pipelineCallContext.js';
import { buildUnifiedAgentKnowledgeContext } from '../../unifiedPipelineContext.js';
import { RETRY_CONFIG } from '../../contracts/PipelineErrors.js';

const STAGE_TIMEOUT = RETRY_CONFIG.stageTimeoutMs;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} stage timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export interface RunScribeAnalysisDeps {
  store: PipelineStore;
  ctx: PipelineExecutionContext;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  markStageStarted: (pipelineId: string, stage: 'scribe' | 'proto' | 'trace') => number;
  writeCheckpoint: (pipelineId: string, agentName: string, input: unknown) => Promise<void>;
  handleScribeResult: (
    pipelineId: string, metrics: PipelineMetrics,
    conversation: ScribeMessageType[], result: ScribeResult,
    clarificationRound?: number
  ) => Promise<void>;
  fetchRepoContext: (userId: string, owner: string, repo: string, branch?: string) => Promise<any>;
  applyChatMemory: (pipeline: any, existing: string | undefined, query: string, opts?: { messageIndex?: number }) => Promise<string | undefined>;
}

export async function runScribeAnalysis(
  pipelineId: string,
  metrics: PipelineMetrics,
  input: ScribeInput,
  conversation: ScribeMessageType[],
  model: string | undefined,
  deps: RunScribeAnalysisDeps
): Promise<void> {
  // Move the ENTIRE body of PipelineOrchestrator.runScribeAnalysis here.
  // Replace:
  //   this.getPipeline(pipelineId) → deps.ctx.get()
  //   this.getAgents(...) → deps.getAgents(...)
  //   this.markStageStarted(...) → deps.markStageStarted(...)
  //   this.writeCheckpoint(...) → deps.writeCheckpoint(...)
  //   this.handleScribeResult(...) → deps.handleScribeResult(...)
  //   this.fetchRepoContext(...) → deps.fetchRepoContext(...)
  //   this.applyChatMemory(...) → deps.applyChatMemory(...)
  //   this.store → deps.store
  //
  // The function body is the same logic — only `this.X` becomes `deps.X`.
  // After store.update calls that are followed by reads, add deps.ctx.invalidate().

  pipelineCallContext.enterWith({ pipelineId });
  const emit = createActivityEmitter(pipelineId, 'scribe');
  emit('start', 'Kullanıcı fikri analiz ediliyor...', 5);
  deps.markStageStarted(pipelineId, 'scribe');

  const pipeline = await deps.ctx.get();
  const existingRepo = pipeline.intermediateState?.existingRepo;
  let repoKnowledge = '';

  if (existingRepo) {
    try {
      emit('start', 'Mevcut repo analiz ediliyor...', 10);
      const repoContext = await deps.fetchRepoContext(
        pipeline.userId, existingRepo.owner, existingRepo.repo, existingRepo.branch
      );
      await deps.store.update(pipelineId, { repoContext });
      deps.ctx.invalidate();

      repoKnowledge =
        `\n\n--- EXISTING REPOSITORY CONTEXT ---\n` +
        `Repository: ${repoContext.owner}/${repoContext.repo} (branch: ${repoContext.branch})\n` +
        `Tech Stack: ${repoContext.techStack.join(', ')}\n` +
        `Summary: ${repoContext.summary}\n\n` +
        `File Tree:\n${repoContext.fileTree}\n` +
        `--- END REPOSITORY CONTEXT ---\n` +
        `\nIMPORTANT: You are writing a spec for a CHANGE to this existing codebase, not a new project. ` +
        `The spec should describe what to ADD or MODIFY in the existing code.`;
      logger.info({ pipelineId, owner: existingRepo.owner, repo: existingRepo.repo }, '[Pipeline] RepoContext fetched');
    } catch (err) {
      logger.warn({ err, pipelineId }, '[Pipeline] RepoContext fetch failed, continuing without context');
      emit('progress', 'Repo analizi atlandı, devam ediliyor...', 15);
    }
  }

  const effort = scoreScribeEffort(input.idea);
  const effectiveModel = model ?? effort.model;
  logger.info(`[Scribe] Effort: ${effort.score}/10 → Model: ${effectiveModel} (${effort.reasoning})`);

  const agents = deps.getAgents(effectiveModel, pipelineId);
  const scribeState = agents.scribe.createInitialState(input);
  scribeState.pipelineId = pipelineId;

  if (input.imageBlocks && input.imageBlocks.length > 0) {
    scribeState.imageBlocks = input.imageBlocks;
  }
  if (repoKnowledge) {
    scribeState.knowledgeContext = (scribeState.knowledgeContext ?? '') + repoKnowledge;
  }

  const attachmentContext = (await deps.ctx.get()).intermediateState?.attachmentContext;
  if (attachmentContext) {
    scribeState.knowledgeContext = (scribeState.knowledgeContext ?? '') + '\n\n' + attachmentContext;
  }

  const scribeFirstPipeline = await deps.ctx.get();
  scribeState.knowledgeContext = await deps.applyChatMemory(
    scribeFirstPipeline, scribeState.knowledgeContext, input.idea, { messageIndex: 0 }
  );

  await deps.writeCheckpoint(pipelineId, 'scribe', input.idea);
  const result = await withRetry(
    (attempt) => {
      if (attempt > 1) emit('retry', `Scribe yeniden deneniyor (deneme ${attempt})...`, 30);
      return withTimeout(agents.scribe.analyzIdea(scribeState), STAGE_TIMEOUT, 'Scribe');
    },
    {
      maxAttempts: 3,
      onError: (err, attempt) => logger.warn({ err, attempt }, '[Pipeline] Scribe analyzIdea attempt failed'),
    }
  );

  await deps.handleScribeResult(pipelineId, metrics, conversation, result);

  if (result.type === 'clarification') {
    emit('clarification', 'Açıklayıcı sorular oluşturuldu', 100);
  } else if (result.type === 'error') {
    emit('error', 'Scribe analizi başarısız oldu', 0);
  }
}
```

- [ ] **Step 2: Create runScribeContinuation.ts**

Same extraction pattern for `runScribeContinuation` (PipelineOrchestrator.ts lines 1014–1071):

```typescript
// backend/src/pipeline/core/orchestrator/stages/runScribeContinuation.ts
import type { PipelineMetrics, ScribeMessageType } from '../../contracts/PipelineTypes.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';
import type { ScribeState, ScribeResult } from '../../../agents/scribe/ScribeAgent.js';
import type { AgentSet } from '../PipelineOrchestrator.js';
import type { PipelineExecutionContext } from '../PipelineExecutionContext.js';
import { createActivityEmitter } from '../../activityEmitter.js';
import { withRetry } from '../../retryWrapper.js';
import { logger } from '../../../../lib/logger.js';
import { pipelineCallContext } from '../../ai-calls/pipelineCallContext.js';
import { RETRY_CONFIG } from '../../contracts/PipelineErrors.js';

const STAGE_TIMEOUT = RETRY_CONFIG.stageTimeoutMs;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} stage timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export interface RunScribeContinuationDeps {
  store: PipelineStore;
  ctx: PipelineExecutionContext;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  handleScribeResult: (
    pipelineId: string, metrics: PipelineMetrics,
    conversation: ScribeMessageType[], result: ScribeResult,
    clarificationRound?: number
  ) => Promise<void>;
  applyChatMemory: (pipeline: any, existing: string | undefined, query: string, opts?: { messageIndex?: number }) => Promise<string | undefined>;
}

export async function runScribeContinuation(
  pipelineId: string,
  metrics: PipelineMetrics,
  scribeState: ScribeState,
  conversation: ScribeMessageType[],
  model: string | undefined,
  deps: RunScribeContinuationDeps
): Promise<void> {
  pipelineCallContext.enterWith({ pipelineId });
  const emit = createActivityEmitter(pipelineId, 'scribe');
  emit('start', 'Kullanıcı yanıtıyla devam ediliyor...', 10);
  scribeState.pipelineId = pipelineId;

  const agents = deps.getAgents(model, pipelineId);

  const latestUserMsg = [...conversation].reverse()
    .find((m) => m.type === 'user_answer' || m.type === 'user_note' || m.type === 'user_idea');
  const continuationQuery = typeof latestUserMsg?.content === 'string' ? latestUserMsg.content : '';
  const pipelineForMemory = await deps.ctx.get();
  scribeState.knowledgeContext = await deps.applyChatMemory(
    pipelineForMemory, scribeState.knowledgeContext, continuationQuery,
    { messageIndex: conversation.length }
  );

  const result = await withRetry(
    (attempt) => {
      if (attempt > 1) emit('retry', `Scribe devamı yeniden deneniyor (deneme ${attempt})...`, 35);
      return withTimeout(agents.scribe.continueAfterAnswer(scribeState), STAGE_TIMEOUT, 'Scribe');
    },
    {
      maxAttempts: 3,
      onError: (err, attempt) => logger.warn({ err, attempt }, '[Pipeline] Scribe continueAfterAnswer attempt failed'),
    }
  );

  await deps.handleScribeResult(pipelineId, metrics, conversation, result, scribeState.clarificationRound);

  if (result.type === 'clarification') {
    emit('clarification', 'Ek sorular oluşturuldu', 100);
  } else if (result.type === 'error') {
    emit('error', 'Scribe devamı başarısız oldu', 0);
  }
}
```

- [ ] **Step 3: Wire the orchestrator to use extracted functions**

In `PipelineOrchestrator.ts`:

```typescript
// Add imports:
import { runScribeAnalysis as runScribeAnalysisStage, type RunScribeAnalysisDeps } from './stages/runScribeAnalysis.js';
import { runScribeContinuation as runScribeContinuationStage, type RunScribeContinuationDeps } from './stages/runScribeContinuation.js';

// Replace the runScribeAnalysis method body with:
private async runScribeAnalysis(
  pipelineId: string, metrics: PipelineMetrics, input: ScribeInput,
  conversation: ScribeMessageType[], model?: string
): Promise<void> {
  const ctx = new PipelineExecutionContext(this.store, pipelineId);
  return runScribeAnalysisStage(pipelineId, metrics, input, conversation, model, {
    store: this.store,
    ctx,
    getAgents: (m, pid) => this.getAgents(m, pid),
    markStageStarted: (pid, stage) => this.markStageStarted(pid, stage),
    writeCheckpoint: (pid, agent, input) => this.writeCheckpoint(pid, agent, input),
    handleScribeResult: (pid, m, conv, result, round) => this.handleScribeResult(pid, m, conv, result, round),
    fetchRepoContext: (userId, owner, repo, branch) => this.fetchRepoContext(userId, owner, repo, branch),
    applyChatMemory: (pipeline, existing, query, opts) => this.applyChatMemory(pipeline, existing, query, opts),
  });
}

// Replace the runScribeContinuation method body with:
private async runScribeContinuation(
  pipelineId: string, metrics: PipelineMetrics, scribeState: ScribeState,
  conversation: ScribeMessageType[], model?: string
): Promise<void> {
  const ctx = new PipelineExecutionContext(this.store, pipelineId);
  return runScribeContinuationStage(pipelineId, metrics, scribeState, conversation, model, {
    store: this.store,
    ctx,
    getAgents: (m, pid) => this.getAgents(m, pid),
    handleScribeResult: (pid, m, conv, result, round) => this.handleScribeResult(pid, m, conv, result, round),
    applyChatMemory: (pipeline, existing, query, opts) => this.applyChatMemory(pipeline, existing, query, opts),
  });
}
```

- [ ] **Step 4: Run typecheck + tests**

Run: `pnpm -C backend typecheck && pnpm -C backend test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/stages/runScribeAnalysis.ts backend/src/pipeline/core/orchestrator/stages/runScribeContinuation.ts backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
git commit -m "refactor: extract runScribeAnalysis + runScribeContinuation to standalone stages (Kademe 4, step 6)"
```

---

## Task 8: Extract runProtoAndTrace

This is the largest extraction — 560 LOC → standalone function.

**Files:**
- Create: `backend/src/pipeline/core/orchestrator/stages/runProtoAndTrace.ts`
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`

- [ ] **Step 1: Create runProtoAndTrace.ts with deps interface**

The deps interface combines fields from the orchestrator that the method uses. Follow the same pattern as `HandleProtoTraceOutcomeDeps` but extended for the full method:

```typescript
// backend/src/pipeline/core/orchestrator/stages/runProtoAndTrace.ts
import type {
  PipelineState, PipelineStage, PipelineMetrics,
  StructuredSpec, ProtoOutput, ScribeMessageType,
} from '../../contracts/PipelineTypes.js';
import type { PipelineStore, PipelineStateUpdate, AgentSet } from '../PipelineOrchestrator.js';
import type { PipelineExecutionContext } from '../PipelineExecutionContext.js';
import type { CriticAgent } from '../../../agents/critic/CriticAgent.js';
import type { CriticReviewOutput } from '../../../agents/critic/CriticTypes.js';
import type { HandleProtoTraceOutcomeDeps } from '../outcomes/ProtoTraceOutcome.js';
import type { ProtoTraceOutcome } from '../outcomes/ProtoTraceOutcome.js';
import type { DeterministicValidator } from '../../validator/DeterministicValidator.js';
import type { PipelineMetricsService } from '../../metrics/PipelineMetricsService.js';
import type { TokenUsageCallback } from '../../pipeline-factory.js';
import type { GitHubServiceLike } from '../../pipeline-factory.js';
import type { AnthropicImageBlock } from '../../../../services/ai/multimodalClient.js';
import type { PipelineIntermediateState } from '../../contracts/IntermediateState.js';

import { handleProtoTraceOutcome } from '../outcomes/ProtoTraceOutcome.js';
import { createActivityEmitter, emitActivity } from '../../activityEmitter.js';
import { withRetry } from '../../retryWrapper.js';
import { scoreProtoEffort } from '../../effortScorer.js';
import { logger } from '../../../../lib/logger.js';
import { pipelineCallContext } from '../../ai-calls/pipelineCallContext.js';
import { buildUnifiedAgentKnowledgeContext } from '../../unifiedPipelineContext.js';
import { buildCriticReasoning } from '../../explainability/reasoningFactory.js';
import { RETRY_CONFIG } from '../../contracts/PipelineErrors.js';

const STAGE_TIMEOUT = RETRY_CONFIG.stageTimeoutMs;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} stage timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function readPipelineImageBlocks(
  intermediateState: PipelineIntermediateState | undefined | null
): readonly AnthropicImageBlock[] | undefined {
  if (!intermediateState) return undefined;
  const raw = intermediateState.imageBlocks;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw;
}

export interface RunProtoAndTraceDeps {
  store: PipelineStore;
  ctx: PipelineExecutionContext;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  createAgentsForModel?: (model: string, ghSvc?: GitHubServiceLike, tokenCb?: TokenUsageCallback) => AgentSet;
  createTokenCallback: (pipelineId: string) => TokenUsageCallback;
  emitEvent: (pipelineId: string, type: 'stage_change' | 'error' | 'completed', stage?: PipelineStage, data?: unknown) => void;
  emitStageCompleted: (pipelineId: string, stage: 'scribe' | 'proto' | 'trace', summary?: string) => void;
  transitionStage: (pipelineId: string, from: PipelineStage, to: PipelineStage, extra?: Partial<PipelineStateUpdate>, opts?: { expectedStageVersion?: number }) => Promise<PipelineState>;
  isCancelled: (pipelineId: string) => Promise<boolean>;
  writeCheckpoint: (pipelineId: string, agentName: string, input: unknown) => Promise<void>;
  logActivity: (pipelineId: string, agent: 'scribe' | 'proto' | 'trace', action: string, data: Record<string, unknown>) => void;
  applyChatMemory: (pipeline: any, existing: string | undefined, query: string, opts?: { messageIndex?: number }) => Promise<string | undefined>;

  // Kademe 3 outcome handler deps
  buildProtoTraceOutcomeDeps: () => HandleProtoTraceOutcomeDeps;

  // Services
  validator: DeterministicValidator;
  metricsService: PipelineMetricsService;
  criticAgent?: CriticAgent;

  // Helpers
  persistReasoning: (pipelineId: string, reasoning: any) => void;
  recordProtoReasoning: (pipelineId: string, output: ProtoOutput, scribeOutput?: any) => void;
  applyArtifactInjection: (protoOutput: ProtoOutput, scribeOutput?: any) => ProtoOutput;
  persistAcCoverage: (pipelineId: string, protoOutput: ProtoOutput, scribeOutput: any, traceOutput?: any) => Promise<void>;
  appendProtoStarted: (pipelineId: string) => Promise<number>;
  runCriticCodeReview: (pipelineId: string, protoOutput: ProtoOutput, spec: StructuredSpec, originalIdea: string) => Promise<CriticReviewOutput | null>;
  evaluateCriticIterateLoop: (pipelineId: string, criticResult: CriticReviewOutput, spec?: StructuredSpec) => Promise<any>;

  // Stage dispatch
  runTrace: (pipelineId: string, metrics: PipelineMetrics, owner: string, repo: string, branch: string, spec?: StructuredSpec, model?: string, options?: any) => Promise<PipelineState>;

  // Config
  previewGateEnabled: boolean;
}

export async function runProtoAndTrace(
  pipelineId: string,
  metrics: PipelineMetrics,
  spec: StructuredSpec,
  repoName: string,
  repoVisibility: 'public' | 'private',
  owner: string,
  model: string | undefined,
  userGithubService: GitHubServiceLike | undefined,
  feedbackContext: string | undefined,
  deps: RunProtoAndTraceDeps
): Promise<void> {
  // Move the ENTIRE body of PipelineOrchestrator.runProtoAndTrace
  // (lines 1509-2069) here.
  //
  // Replacement rules:
  //   this.getPipeline(pipelineId) → deps.ctx.get()
  //   this.store → deps.store
  //   this.getAgents(...) → deps.getAgents(...)
  //   this.createAgentsForModel?.(...) → deps.createAgentsForModel?.(...)
  //   this.createTokenCallback(...) → deps.createTokenCallback(...)
  //   this.emitEvent(...) → deps.emitEvent(...)
  //   this.emitStageCompleted(...) → deps.emitStageCompleted(...)
  //   this.isCancelled(...) → deps.isCancelled(...)
  //   this.writeCheckpoint(...) → deps.writeCheckpoint(...)
  //   this.logActivity(...) → deps.logActivity(...)
  //   this.applyChatMemory(...) → deps.applyChatMemory(...)
  //   this.validator → deps.validator
  //   this.metricsService → deps.metricsService
  //   this.criticAgent → deps.criticAgent
  //   this.persistReasoning(...) → deps.persistReasoning(...)
  //   this.recordProtoReasoning(...) → deps.recordProtoReasoning(...)
  //   this.applyArtifactInjection(...) → deps.applyArtifactInjection(...)
  //   this.persistAcCoverage(...) → deps.persistAcCoverage(...)
  //   this.appendProtoStarted(...) → deps.appendProtoStarted(...)
  //   this.runCriticCodeReview(...) → deps.runCriticCodeReview(...)
  //   this.evaluateCriticIterateLoop(...) → deps.evaluateCriticIterateLoop(...)
  //   this.buildProtoTraceOutcomeDeps() → deps.buildProtoTraceOutcomeDeps()
  //   this.runTrace(...) → deps.runTrace(...)
  //   this.store.update(id, { stage: X, ...rest }) → deps.transitionStage(id, currentStage, X, rest)
  //     (for calls that change .stage — non-stage updates keep deps.store.update)
  //   process.env.AUTO_PUSH_AFTER_PROTO → deps.previewGateEnabled (already computed)
  //   readPipelineImageBlocks → local function (defined above)
  //
  //   After deps.store.update(...) calls that write intermediateState and
  //   are followed by deps.ctx.get() later, insert deps.ctx.invalidate().
  //
  // The exact method body with these substitutions applied is ~400 LOC.
  // Copy the full method body from PipelineOrchestrator.ts and apply
  // the substitutions mechanically.
}
```

**IMPORTANT:** The comment block above is instruction for the implementer — the actual function body should contain the real code from `PipelineOrchestrator.ts` lines 1509-2069 with the listed substitutions applied. Do NOT leave the comment block as a placeholder.

- [ ] **Step 2: Wire the orchestrator**

In `PipelineOrchestrator.ts`:

```typescript
// Add imports:
import { runProtoAndTrace as runProtoAndTraceStage, type RunProtoAndTraceDeps } from './stages/runProtoAndTrace.js';
import { PipelineExecutionContext } from './PipelineExecutionContext.js';

// Replace the runProtoAndTrace method body:
private async runProtoAndTrace(
  pipelineId: string, metrics: PipelineMetrics, spec: StructuredSpec,
  repoName: string, repoVisibility: 'public' | 'private', owner: string,
  model?: string, userGithubService?: import('../pipeline-factory.js').GitHubServiceLike,
  feedbackContext?: string
): Promise<void> {
  const ctx = new PipelineExecutionContext(this.store, pipelineId);
  return runProtoAndTraceStage(pipelineId, metrics, spec, repoName, repoVisibility, owner, model, userGithubService, feedbackContext, {
    store: this.store,
    ctx,
    getAgents: (m, pid) => this.getAgents(m, pid),
    createAgentsForModel: this.createAgentsForModel,
    createTokenCallback: (pid) => this.createTokenCallback(pid),
    emitEvent: (pid, type, stage, data) => this.emitEvent(pid, type, stage, data),
    emitStageCompleted: (pid, stage, summary) => this.emitStageCompleted(pid, stage, summary),
    transitionStage: (pid, from, to, extra, opts) => this.transitionStage(pid, from, to, extra, opts),
    isCancelled: (pid) => this.isCancelled(pid),
    writeCheckpoint: (pid, agent, input) => this.writeCheckpoint(pid, agent, input),
    logActivity: (pid, agent, action, data) => this.logActivity(pid, agent, action, data),
    applyChatMemory: (pipeline, existing, query, opts) => this.applyChatMemory(pipeline, existing, query, opts),
    buildProtoTraceOutcomeDeps: () => this.buildProtoTraceOutcomeDeps(),
    validator: this.validator,
    metricsService: this.metricsService,
    criticAgent: this.criticAgent,
    persistReasoning: (pid, reasoning) => this.persistReasoning(pid, reasoning),
    recordProtoReasoning: (pid, output, scribe) => this.recordProtoReasoning(pid, output, scribe),
    applyArtifactInjection: (proto, scribe) => this.applyArtifactInjection(proto, scribe),
    persistAcCoverage: (pid, proto, scribe, trace) => this.persistAcCoverage(pid, proto, scribe, trace),
    appendProtoStarted: (pid) => this.appendProtoStarted(pid),
    runCriticCodeReview: (pid, proto, spec, idea) => this.runCriticCodeReview(pid, proto, spec, idea),
    evaluateCriticIterateLoop: (pid, critic, spec) => this.evaluateCriticIterateLoop(pid, critic, spec),
    runTrace: (pid, metrics, owner, repo, branch, spec, model, opts) => this.runTrace(pid, metrics, owner, repo, branch, spec, model, opts),
    previewGateEnabled: process.env.AUTO_PUSH_AFTER_PROTO !== 'true',
  });
}
```

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm -C backend typecheck && pnpm -C backend test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/stages/runProtoAndTrace.ts backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
git commit -m "refactor: extract runProtoAndTrace to standalone stage — 560 LOC → deps-injected function (Kademe 4, step 7)"
```

---

## Task 9: Extract runTrace

**Files:**
- Create: `backend/src/pipeline/core/orchestrator/stages/runTrace.ts`
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`

- [ ] **Step 1: Create runTrace.ts with deps interface**

Same pattern as Task 8. Move `PipelineOrchestrator.runTrace` (lines 3195-3512) into a standalone function:

```typescript
// backend/src/pipeline/core/orchestrator/stages/runTrace.ts

export interface RunTraceDeps {
  store: PipelineStore;
  ctx: PipelineExecutionContext;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  emitEvent: (pipelineId: string, type: string, stage?: PipelineStage, data?: unknown) => void;
  isCancelled: (pipelineId: string) => Promise<boolean>;
  writeCheckpoint: (pipelineId: string, agentName: string, input: unknown) => Promise<void>;
  logActivity: (pipelineId: string, agent: string, action: string, data: Record<string, unknown>) => void;
  applyChatMemory: (pipeline: any, existing: string | undefined, query: string, opts?: any) => Promise<string | undefined>;
  buildTraceOutcomeDeps: () => HandleTraceOutcomeDeps;

  // Services
  securityGate: SecurityGate;
  metricsService: PipelineMetricsService;
  fixLoopService: FixLoopService;

  // Helpers
  appendTraceStarted: (pipelineId: string) => Promise<number>;
  appendTraceFailed: (pipelineId: string, iteration: number, code: string, msg: string, recovery?: string) => Promise<void>;
  maybeInvalidateGitHubTokenOnAuthError: (pipelineId: string, code: string) => Promise<void>;
  evaluateTraceIterateLoop: (pipelineId: string, traceOutput: TraceOutput, spec?: StructuredSpec) => Promise<any>;
}

export async function runTrace(
  pipelineId: string, metrics: PipelineMetrics,
  owner: string, repo: string, branch: string,
  spec: StructuredSpec | undefined, model: string | undefined,
  options: { dryRun?: boolean; inputFiles?: Array<{ filePath: string; content: string }>; postSuccess?: 'completed' | 'awaiting_push_confirm' } | undefined,
  deps: RunTraceDeps
): Promise<PipelineState> {
  // Move the body of PipelineOrchestrator.runTrace (lines 3195-3512)
  // here, applying the same this.X → deps.X substitutions as Task 8.
}
```

- [ ] **Step 2: Wire the orchestrator**

Replace `runTrace` method body in `PipelineOrchestrator.ts` with a thin deps-builder + call:

```typescript
private async runTrace(...args): Promise<PipelineState> {
  const ctx = new PipelineExecutionContext(this.store, pipelineId);
  return runTraceStage(pipelineId, metrics, owner, repo, branch, spec, model, options, {
    store: this.store, ctx, /* ... all deps ... */
  });
}
```

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm -C backend typecheck && pnpm -C backend test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/stages/runTrace.ts backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
git commit -m "refactor: extract runTrace to standalone stage (Kademe 4, step 8)"
```

---

## Task 10: Extract Remaining Stage Runners

**Files:**
- Create: `backend/src/pipeline/core/orchestrator/stages/runIterationProto.ts`
- Create: `backend/src/pipeline/core/orchestrator/stages/runConfirmedPush.ts`
- Create: `backend/src/pipeline/core/orchestrator/stages/runCiPolling.ts`
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`

These three runners are smaller (80-160 LOC each) and follow the identical pattern established in Tasks 7-9.

- [ ] **Step 1: Create runIterationProto.ts**

Move `runIterationProtoAndTrace` (PipelineOrchestrator.ts lines 1216-1358) + `readRepoFiles` (lines 1361-1417):

```typescript
export interface RunIterationProtoDeps {
  store: PipelineStore;
  ctx: PipelineExecutionContext;
  getAgents: (model?: string, pipelineId?: string) => AgentSet;
  createAgentsForModel?: (...) => AgentSet;
  createTokenCallback: (pipelineId: string) => TokenUsageCallback;
  emitEvent: (...) => void;
  isCancelled: (pipelineId: string) => Promise<boolean>;
  validateGitHubAccess: (userId: string) => Promise<{ token: string; owner: string }>;
  createGitHubService: (token: string) => GitHubServiceLike;
  writeCheckpoint: (...) => Promise<void>;
  logActivity: (...) => void;
  applyChatMemory: (...) => Promise<string | undefined>;
  applyArtifactInjection: (...) => ProtoOutput;
}

export async function runIterationProtoAndTrace(..., deps: RunIterationProtoDeps): Promise<void> {
  // Move body, substitute this.X → deps.X
}
```

- [ ] **Step 2: Create runConfirmedPush.ts**

Move `runConfirmedPush` (PipelineOrchestrator.ts lines 2370-2478):

```typescript
export interface RunConfirmedPushDeps {
  store: PipelineStore;
  ctx: PipelineExecutionContext;
  emitEvent: (...) => void;
  isCancelled: (pipelineId: string) => Promise<boolean>;
  runJiraProtoComment: (...) => Promise<void>;
  runCiPolling: (pipelineId: string, userId: string, owner: string, repo: string, branch: string) => Promise<void>;
}

export async function runConfirmedPush(..., deps: RunConfirmedPushDeps): Promise<void> {
  // Move body, substitute this.X → deps.X
}
```

- [ ] **Step 3: Create runCiPolling.ts**

Move `runCiPolling` (PipelineOrchestrator.ts lines 2487-2557) + `finishCiUnpolled` (lines 2559-2564):

```typescript
export interface RunCiPollingDeps {
  store: PipelineStore;
  ctx: PipelineExecutionContext;
  emitEvent: (...) => void;
  validateGitHubAccess: (userId: string) => Promise<{ token: string; owner: string }>;
}

export async function runCiPolling(..., deps: RunCiPollingDeps): Promise<void> {
  // Move body, substitute this.X → deps.X
}
```

- [ ] **Step 4: Wire all three into the orchestrator**

Replace each method body in `PipelineOrchestrator.ts` with the thin deps-builder + call pattern.

- [ ] **Step 5: Run typecheck + tests**

Run: `pnpm -C backend typecheck && pnpm -C backend test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/stages/runIterationProto.ts backend/src/pipeline/core/orchestrator/stages/runConfirmedPush.ts backend/src/pipeline/core/orchestrator/stages/runCiPolling.ts backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
git commit -m "refactor: extract runIterationProto + runConfirmedPush + runCiPolling stages (Kademe 4, step 9)"
```

---

## Task 11: Remove Dead Thin Wrappers + Final Cleanup

**Files:**
- Modify: `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`

- [ ] **Step 1: Remove thin wrappers that are no longer needed**

After stage extraction, the following thin wrappers are only called from within extracted stage runners (via deps), not from the orchestrator itself. They can be replaced with direct deps references:

Check each of these methods — if the only caller is a deps closure, the method can be inlined into the deps builder:

- `markStageStarted` → used in deps builders only? If yes, inline
- `getStageDurationMs` → same check
- `clearStageStarts` → still used in `failPipeline` and `_cancelPipeline` → keep
- `writeCheckpoint` → used in deps builders only → inline
- `deriveRepoName` → check callers; if unused, remove

For each thin wrapper that survives (called from public API methods that stay on the class), keep it.

- [ ] **Step 2: Update stages/index.ts barrel export**

If a barrel export exists at `stages/index.ts`, add the new stage runner exports. If not, no action needed — each runner is imported individually.

- [ ] **Step 3: Verify final line count**

Run: `wc -l backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`
Expected: ≤ 1200 lines (AC-4)

- [ ] **Step 4: Verify zero Record<string, unknown> casts**

Run: `grep -rn 'as Record<string, unknown>' backend/src/pipeline/core/orchestrator/`
Expected: Zero matches (AC-5)

- [ ] **Step 5: Verify no direct process.env access**

Run: `grep -n 'process\.env\.AUTO_PUSH' backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`
Expected: Zero matches in orchestrator (the read is now in the deps builder closure — AC-9)

- [ ] **Step 6: Run full verification suite**

```bash
pnpm -C backend typecheck && pnpm -C backend lint && pnpm -C backend test
```
Expected: All PASS

- [ ] **Step 7: Verify no frontend changes**

Run: `git diff --name-only frontend/`
Expected: No files

- [ ] **Step 8: Commit**

```bash
git add backend/src/pipeline/core/orchestrator/
git commit -m "refactor: remove dead wrappers + final cleanup — orchestrator ≤1200 LOC (Kademe 4, step 10)"
```

---

## Task 12: Final Acceptance Verification

- [ ] **Step 1: Run all acceptance criteria checks**

```bash
# AC-1: Typecheck
pnpm -C backend typecheck

# AC-2: Lint
pnpm -C backend lint

# AC-3: All tests pass
pnpm -C backend test

# AC-4: Orchestrator ≤ 1200 LOC
wc -l backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts

# AC-5: Zero unsafe casts in orchestrator tree
grep -rn 'as Record<string, unknown>' backend/src/pipeline/core/orchestrator/ | wc -l

# AC-6: Transition table covers all stages (compile-time — if it builds, it's covered)
echo "AC-6: PASS (Record<PipelineStage, ...> enforced by TypeScript)"

# AC-7: Transition guard tests pass
pnpm -C backend exec tsx --test test/unit/pipeline/PipelineTransitions.test.ts

# AC-8: Context cache tests pass
pnpm -C backend exec tsx --test test/unit/pipeline/PipelineExecutionContext.test.ts

# AC-9: No direct process.env in orchestrator
grep -n 'process\.env\.AUTO_PUSH' backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | wc -l

# AC-10: New stage runner files exist
ls -la backend/src/pipeline/core/orchestrator/stages/run*.ts

# AC-11: Zero frontend changes
git diff --name-only frontend/ | wc -l
```

Expected: All checks PASS

- [ ] **Step 2: Squash-friendly commit log check**

Run: `git log --oneline --since="1 hour ago"`

Verify the commit chain is clean. All commits should have the `(Kademe 4, step N)` suffix.

---

## Summary

| Task | What | Est. LOC Changed | Key Risk |
|---|---|---|---|
| 1 | IntermediateState type definition | +130 new | None — additive |
| 2 | Wire type into PipelineTypes | ~5 lines | Triggers compiler errors (expected) |
| 3 | Fix all cast sites | ~200 lines changed | Pattern is mechanical, but wide blast radius |
| 4 | PipelineExecutionContext | +100 new (impl + test) | None — new class, no wiring yet |
| 5 | FSM Transition Guard | +170 new (impl + test) | Transition table completeness (validated by test) |
| 6 | transitionStage helper | +15 lines | None — added but not called yet |
| 7 | Extract Scribe runners | +200 new, -200 orchestrator | First extraction — establishes pattern |
| 8 | Extract runProtoAndTrace | +420 new, -560 orchestrator | Largest extraction, most deps |
| 9 | Extract runTrace | +340 new, -320 orchestrator | FixLoop complexity |
| 10 | Extract remaining runners | +360 new, -350 orchestrator | Three parallel extractions |
| 11 | Cleanup | ~-100 orchestrator | Dead code removal |
| 12 | Verification | 0 | Acceptance criteria gate |
