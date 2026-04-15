/**
 * LearningService — Simple in-memory learning store (v1).
 *
 * Records pipeline outcomes per stage and retrieves relevant learnings
 * for future pipelines based on simple keyword matching.
 *
 * Upgrade path: v2 → pgvector for semantic similarity search (Horizon 2).
 */

import type {
  LearningOutcome,
  Learning,
  LearningStats,
} from './LearningTypes.js';

// ─── Keyword extraction ──────────────────────────

/**
 * Extract keywords from a text string.
 * Simple approach: lowercase, split on non-alphanumeric, deduplicate, filter short words.
 */
function extractKeywords(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  )];
}

/**
 * Compute a simple relevance score between two keyword sets.
 * Jaccard-like: intersection / union
 */
function keywordRelevance(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersection / union : 0;
}

// ─── LearningService ─────────────────────────────

export class LearningService {
  /** In-memory store: stage → outcomes */
  private store = new Map<string, LearningOutcome[]>();

  /** Maximum outcomes stored per stage (FIFO eviction) */
  private maxPerStage: number;

  constructor(maxPerStage = 100) {
    this.maxPerStage = maxPerStage;
  }

  /**
   * Record an outcome after a pipeline stage completes.
   */
  async recordOutcome(
    pipelineId: string,
    stage: string,
    outcome: {
      success: boolean;
      errorType?: string;
      solution?: string;
      duration: number;
      score?: number;
    },
    context?: string,
  ): Promise<void> {
    const record: LearningOutcome = {
      pipelineId,
      stage,
      timestamp: new Date(),
      success: outcome.success,
      errorType: outcome.errorType,
      solution: outcome.solution,
      duration: outcome.duration,
      score: outcome.score,
      keywords: context ? extractKeywords(context) : [],
    };

    const existing = this.store.get(stage) ?? [];
    existing.push(record);

    // FIFO eviction
    if (existing.length > this.maxPerStage) {
      existing.splice(0, existing.length - this.maxPerStage);
    }

    this.store.set(stage, existing);
  }

  /**
   * Get relevant learnings for a given stage and context.
   * Returns the top N outcomes sorted by relevance (keyword match).
   */
  async getRelevantLearnings(
    stage: string,
    context: string,
    limit = 5,
  ): Promise<Learning[]> {
    const outcomes = this.store.get(stage) ?? [];
    if (outcomes.length === 0) return [];

    const contextKeywords = extractKeywords(context);

    const scored: Learning[] = outcomes.map((outcome) => ({
      outcome,
      relevanceScore: keywordRelevance(contextKeywords, outcome.keywords ?? []),
    }));

    // Sort by relevance (descending), then by recency
    scored.sort((a, b) => {
      const diff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
      if (Math.abs(diff) > 0.01) return diff;
      return b.outcome.timestamp.getTime() - a.outcome.timestamp.getTime();
    });

    return scored.slice(0, limit);
  }

  /**
   * Get aggregated statistics for a stage.
   */
  async getStats(stage: string): Promise<LearningStats> {
    const outcomes = this.store.get(stage) ?? [];

    if (outcomes.length === 0) {
      return { totalOutcomes: 0, successRate: 0, avgDuration: 0, commonErrors: [] };
    }

    const successes = outcomes.filter((o) => o.success).length;
    const totalDuration = outcomes.reduce((sum, o) => sum + o.duration, 0);

    // Count error types
    const errorCounts = new Map<string, number>();
    for (const o of outcomes) {
      if (o.errorType) {
        errorCounts.set(o.errorType, (errorCounts.get(o.errorType) ?? 0) + 1);
      }
    }

    const commonErrors = [...errorCounts.entries()]
      .map(([errorType, count]) => ({ errorType, count }))
      .sort((a, b) => b.count - a.count);

    return {
      totalOutcomes: outcomes.length,
      successRate: successes / outcomes.length,
      avgDuration: totalDuration / outcomes.length,
      commonErrors,
    };
  }

  /**
   * Get all outcomes for a stage (for debugging/export).
   */
  async getAllOutcomes(stage: string): Promise<LearningOutcome[]> {
    return this.store.get(stage) ?? [];
  }

  /**
   * Build a learning-context string to inject into agent prompts.
   * Summarizes past outcomes relevant to the current task.
   */
  async buildPromptContext(stage: string, context: string): Promise<string> {
    const learnings = await this.getRelevantLearnings(stage, context, 3);
    if (learnings.length === 0) return '';

    const lines = ['## Past Learnings (auto-injected)'];
    for (const l of learnings) {
      const { outcome } = l;
      const status = outcome.success ? 'SUCCESS' : 'FAILED';
      let line = `- [${status}] ${outcome.stage} (${Math.round(outcome.duration / 1000)}s)`;
      if (outcome.errorType) line += ` — Error: ${outcome.errorType}`;
      if (outcome.solution) line += ` — Fix: ${outcome.solution}`;
      if (outcome.score !== undefined) line += ` — Score: ${outcome.score}`;
      lines.push(line);
    }
    return lines.join('\n');
  }

  /** Clear all stored learnings (for testing). */
  clear(): void {
    this.store.clear();
  }
}
