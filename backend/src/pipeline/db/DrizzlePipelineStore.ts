/**
 * DrizzlePipelineStore — PostgreSQL-backed PipelineStore implementation.
 * Replaces InMemoryPipelineStore for production use.
 */
import { eq, desc, and, sql, lt, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PipelineState, PipelineStage } from '../core/contracts/PipelineTypes.js';
import type { PipelineStore } from '../core/orchestrator/PipelineOrchestrator.js';
import { pipelines } from '../../db/schema.js';
import type * as schema from '../../db/schema.js';

type DB = NodePgDatabase<typeof schema>;

/**
 * Thrown when a stage transition fails due to a concurrent update.
 * Indicates another process already changed the pipeline stage.
 */
export class StaleStateError extends Error {
  constructor(pipelineId: string, expectedVersion: number) {
    super(`Pipeline ${pipelineId} state is stale (expected version ${expectedVersion}). Another operation already updated the stage.`);
    this.name = 'StaleStateError';
  }
}

/** Safely coerce JSONB date strings to Date objects inside metrics. */
function parseMetrics(raw: Record<string, unknown> | null): PipelineState['metrics'] {
  if (!raw) return { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 };
  const toDate = (v: unknown): Date | undefined =>
    v == null ? undefined : (v instanceof Date ? v : new Date(String(v)));
  return {
    startedAt: toDate(raw.startedAt) ?? new Date(),
    scribeCompletedAt: toDate(raw.scribeCompletedAt),
    approvedAt: toDate(raw.approvedAt),
    protoCompletedAt: toDate(raw.protoCompletedAt),
    traceCompletedAt: toDate(raw.traceCompletedAt),
    totalDurationMs: raw.totalDurationMs as number | undefined,
    clarificationRounds: (raw.clarificationRounds as number) ?? 0,
    retryCount: (raw.retryCount as number) ?? 0,
    estimatedCost: raw.estimatedCost as number | undefined,
    inputTokens: raw.inputTokens as number | undefined,
    outputTokens: raw.outputTokens as number | undefined,
    totalTokens: raw.totalTokens as number | undefined,
  };
}

/**
 * Maps a Drizzle row to PipelineState. JSONB columns need casting.
 */
function rowToState(row: typeof pipelines.$inferSelect): PipelineState {
  return {
    id: row.id,
    userId: row.userId,
    stage: row.stage as PipelineState['stage'],
    title: row.title ?? undefined,
    model: row.model ?? undefined,
    modelLockedAt: row.modelLockedAt ?? undefined,
    traceEnabled: row.traceEnabled,
    scribeConversation: (row.scribeConversation ?? []) as PipelineState['scribeConversation'],
    scribeOutput: row.scribeOutput as PipelineState['scribeOutput'],
    approvedSpec: row.approvedSpec as PipelineState['approvedSpec'],
    protoOutput: row.protoOutput as PipelineState['protoOutput'],
    traceOutput: row.traceOutput as PipelineState['traceOutput'],
    repoContext: row.repoContext as PipelineState['repoContext'],
    protoConfig: row.protoConfig as PipelineState['protoConfig'],
    jiraConfig: row.jiraConfig as PipelineState['jiraConfig'],
    metrics: parseMetrics(row.metrics as Record<string, unknown> | null),
    error: row.error as PipelineState['error'],
    intermediateState: row.intermediateState as PipelineState['intermediateState'],
    // H-7: Extract autoApprove fields from intermediateState JSONB
    autoApproveEnabled: (row.intermediateState as Record<string, unknown> | null)?.autoApproveEnabled as boolean | undefined,
    autoApproveThreshold: (row.intermediateState as Record<string, unknown> | null)?.autoApproveThreshold as number | undefined,
    attemptCount: row.attemptCount,
    stageVersion: row.stageVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzlePipelineStore implements PipelineStore {
  constructor(private db: DB) {}

  async create(userId: string): Promise<PipelineState> {
    const now = new Date();
    const metrics = {
      startedAt: now,
      clarificationRounds: 0,
      retryCount: 0,
    };

    const [row] = await this.db
      .insert(pipelines)
      .values({
        userId,
        stage: 'scribe_generating',
        scribeConversation: [],
        metrics,
        attemptCount: 0,
      })
      .returning();

    return rowToState(row);
  }

  async getById(id: string): Promise<PipelineState | null> {
    const [row] = await this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.id, id))
      .limit(1);

    return row ? rowToState(row) : null;
  }

  async listByUser(userId: string): Promise<PipelineState[]> {
    const rows = await this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.userId, userId))
      .orderBy(desc(pipelines.updatedAt));

    return rows.map(rowToState);
  }

  /**
   * List only root pipelines — those without an `intermediateState.parentPipelineId`.
   * Iteration children belong to their parent's chat timeline and must not appear
   * as separate sidebar entries (see issue #388 / BUG-08).
   */
  async listRootsByUser(userId: string): Promise<PipelineState[]> {
    const rows = await this.db
      .select()
      .from(pipelines)
      .where(
        and(
          eq(pipelines.userId, userId),
          // intermediate_state is NULL OR does not contain a parent pointer.
          // Using jsonb ->> operator; NULL coalesces safely.
          sql`(${pipelines.intermediateState} IS NULL
               OR ${pipelines.intermediateState} ->> 'parentPipelineId' IS NULL)`,
        ),
      )
      .orderBy(desc(pipelines.updatedAt));

    return rows.map(rowToState);
  }

  /**
   * List iteration children of a given parent pipeline, oldest first (chronological
   * order for chat timeline merge).
   */
  async listChildrenOf(parentPipelineId: string): Promise<PipelineState[]> {
    const rows = await this.db
      .select()
      .from(pipelines)
      .where(
        sql`${pipelines.intermediateState} ->> 'parentPipelineId' = ${parentPipelineId}`,
      )
      .orderBy(pipelines.createdAt);

    return rows.map(rowToState);
  }

  async update(
    id: string,
    data: Partial<PipelineState>,
    opts?: { expectedStageVersion?: number },
  ): Promise<PipelineState> {
    // Build update payload — only set fields that are explicitly passed
    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (data.stage !== undefined) updateData.stage = data.stage;
    if (data.title !== undefined) updateData.title = data.title;
    if (data.model !== undefined) updateData.model = data.model;
    if (data.modelLockedAt !== undefined) updateData.modelLockedAt = data.modelLockedAt;
    if (data.scribeConversation !== undefined) updateData.scribeConversation = data.scribeConversation;
    if (data.scribeOutput !== undefined) updateData.scribeOutput = data.scribeOutput;
    if (data.approvedSpec !== undefined) updateData.approvedSpec = data.approvedSpec;
    if (data.protoOutput !== undefined) updateData.protoOutput = data.protoOutput;
    if (data.traceOutput !== undefined) updateData.traceOutput = data.traceOutput;
    if (data.protoConfig !== undefined) updateData.protoConfig = data.protoConfig;
    if (data.jiraConfig !== undefined) updateData.jiraConfig = data.jiraConfig;
    if (data.metrics !== undefined) updateData.metrics = data.metrics;
    if (data.error !== undefined) updateData.error = data.error;
    if (data.intermediateState !== undefined) updateData.intermediateState = data.intermediateState;
    if (data.repoContext !== undefined) updateData.repoContext = data.repoContext;
    if (data.traceEnabled !== undefined) updateData.traceEnabled = data.traceEnabled;
    if (data.attemptCount !== undefined) updateData.attemptCount = data.attemptCount;

    // H-7: Persist autoApprove fields — no dedicated DB columns, so merge
    // into the intermediateState JSONB alongside any existing payload.
    if (data.autoApproveEnabled !== undefined || data.autoApproveThreshold !== undefined) {
      // Read current DB row's intermediateState to avoid overwriting existing keys
      const [currentRow] = await this.db
        .select({ intermediateState: pipelines.intermediateState })
        .from(pipelines)
        .where(eq(pipelines.id, id))
        .limit(1);
      const existingIntermediate =
        (updateData.intermediateState as Record<string, unknown> | undefined) ??
        (currentRow?.intermediateState as Record<string, unknown> | null) ??
        {};
      const merged = { ...existingIntermediate };
      if (data.autoApproveEnabled !== undefined) merged.autoApproveEnabled = data.autoApproveEnabled;
      if (data.autoApproveThreshold !== undefined) merged.autoApproveThreshold = data.autoApproveThreshold;
      updateData.intermediateState = merged;
    }

    // Optimistic locking: when stage changes, require version match + increment
    const isStageChange = data.stage !== undefined;
    if (isStageChange) {
      updateData.stageVersion = sql`${pipelines.stageVersion} + 1`;
    }

    const whereClause = isStageChange && opts?.expectedStageVersion !== undefined
      ? and(eq(pipelines.id, id), eq(pipelines.stageVersion, opts.expectedStageVersion))
      : eq(pipelines.id, id);

    const [row] = await this.db
      .update(pipelines)
      .set(updateData)
      .where(whereClause)
      .returning();

    if (!row && isStageChange && opts?.expectedStageVersion !== undefined) {
      throw new StaleStateError(id, opts.expectedStageVersion);
    }
    if (!row) throw new Error(`Pipeline ${id} not found`);
    return rowToState(row);
  }

  /** Find pipelines stuck in running stages longer than the threshold. */
  async listStuck(
    stages: PipelineStage[],
    olderThan: Date,
  ): Promise<Array<{ id: string; stage: PipelineStage; updatedAt: Date }>> {
    const rows = await this.db
      .select({ id: pipelines.id, stage: pipelines.stage, updatedAt: pipelines.updatedAt })
      .from(pipelines)
      .where(and(
        inArray(pipelines.stage, stages),
        lt(pipelines.updatedAt, olderThan),
      ));

    return rows.map((r) => ({
      id: r.id,
      stage: r.stage as PipelineStage,
      updatedAt: r.updatedAt,
    }));
  }
}
