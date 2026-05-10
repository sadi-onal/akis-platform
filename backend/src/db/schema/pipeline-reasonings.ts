// pipeline_reasonings — DB-backed counterpart of ExplainabilityService's
// in-memory map. One row per (pipeline, stage). Survives backend restarts.
// See docs/product/03-architecture.md § 4.1 (NFR-1 / F-03 / F-11).

import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import type { AgentReasoning } from '../../pipeline/core/explainability/ExplainabilityTypes.js';

import { pipelines } from '../schema.js';

export const pipelineReasonings = pgTable(
  'pipeline_reasonings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    /** 'scribe' | 'critic-spec' | 'proto' | 'critic-code' | 'trace' (etc.) */
    stage: text('stage').notNull(),
    agentReasoning: jsonb('agent_reasoning').$type<AgentReasoning>().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft-delete column — `archivedAt IS NULL` is the default visibility filter (NFR-1.3). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    uniqStage: uniqueIndex('uniq_pipeline_stage').on(t.pipelineId, t.stage),
    pipelineIdx: index('idx_reasonings_pipeline').on(t.pipelineId),
  }),
);

export type PipelineReasoningRow = typeof pipelineReasonings.$inferSelect;
export type PipelineReasoningInsert = typeof pipelineReasonings.$inferInsert;
