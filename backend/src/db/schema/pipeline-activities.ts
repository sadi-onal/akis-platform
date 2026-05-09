// pipeline_activities — append-only audit log of activity events emitted by
// the orchestrator. DB-backed counterpart of activityEmitter's ring buffer.
// See docs/product/03-architecture.md § 4.2 (NFR-1 / F-03 / F-11).

import { pgTable, bigserial, uuid, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

import { pipelines } from '../schema.js';

export interface ActivityReasoningSnippet {
  decision: string;
  snippet?: string;
  confidence?: number;
}

export const pipelineActivities = pgTable(
  'pipeline_activities',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    /** 'started' | 'progress' | 'complete' | 'error' | sub-step keys */
    step: text('step').notNull(),
    message: text('message'),
    progress: integer('progress'),
    retryCount: integer('retry_count').default(0),
    reasoningSnippet: jsonb('reasoning_snippet').$type<ActivityReasoningSnippet>(),
    emittedAt: timestamp('emitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pipelineTimeIdx: index('idx_activities_pipeline_time').on(t.pipelineId, t.emittedAt),
  }),
);

export type PipelineActivityRow = typeof pipelineActivities.$inferSelect;
export type PipelineActivityInsert = typeof pipelineActivities.$inferInsert;
