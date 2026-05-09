import {
  pgTable,
  bigserial,
  uuid,
  text,
  numeric,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Intent classification audit log (FR-11).
 *
 * Every user message classified by `IntentClassifier` is appended here so we
 * have:
 *   - audit trail of how intents were assigned (BUILD/ASK/FEEDBACK/CHAT)
 *   - dataset for future model fine-tuning
 *   - record of disambiguation overrides chosen by the user
 *
 * Privacy: We never persist the raw message text. We store a SHA-256 hash so
 * the same message can be deduped/correlated for telemetry without exposing
 * the user's prose. The `reasoning` column stores a short classifier-emitted
 * sentence (no message verbatim) and is safe to keep.
 *
 * Anchors: 03-architecture § 3.1 + § 4.3, 06-roadmap Wave 4 PR 4.1, F-10 in
 * 05-findings, FR-11.1..FR-11.4 in 01-requirements.
 */
export const intentClassifications = pgTable(
  'intent_classifications',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),

    /** Owner of the classified message. Cascade-deletes with the user. */
    userId: uuid('user_id').notNull(),

    /**
     * Optional pipeline this classification is contextually attached to.
     * Set NULL on pipeline delete so audit history survives.
     */
    pipelineId: uuid('pipeline_id'),

    /**
     * SHA-256 of the raw user message (hex). Lets us join classifier
     * decisions to user behaviour without ever storing prose.
     */
    messageHash: text('message_hash').notNull(),

    /** 'BUILD' | 'ASK' | 'FEEDBACK' | 'CHAT'. */
    intent: text('intent').notNull(),

    /** 0..1, three decimals (precision 4 / scale 3). */
    confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),

    /**
     * Runner-up intents — array of `{ intent, confidence }`.
     * Used to render the disambiguation modal options when confidence < 0.7.
     */
    alternates: jsonb('alternates'),

    /**
     * If the user resolved a low-confidence prompt via the disambiguation
     * modal, the chosen intent is stamped here. NULL = no override (the
     * classifier's pick was used as-is).
     */
    overrideIntent: text('override_intent'),

    classifiedAt: timestamp('classified_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userTimeIdx: index('idx_intent_user_time').on(t.userId, t.classifiedAt),
  }),
);

export type IntentClassificationInsert = typeof intentClassifications.$inferInsert;
export type IntentClassificationSelect = typeof intentClassifications.$inferSelect;
