/**
 * LearningTypes — Types for the Persistent Learning Foundation.
 *
 * v1: file-based store (upgrade to pgvector in Horizon 2).
 * Records pipeline outcomes for pattern detection and prompt improvement.
 */

export interface LearningOutcome {
  pipelineId: string;
  stage: string;
  timestamp: Date;
  success: boolean;
  errorType?: string;
  solution?: string;
  duration: number;
  score?: number;
  /** Keywords extracted from the pipeline context for relevance matching */
  keywords?: string[];
}

export interface Learning {
  outcome: LearningOutcome;
  /** Relevance score when retrieved via getRelevantLearnings (0-1) */
  relevanceScore?: number;
}

export interface LearningStats {
  totalOutcomes: number;
  successRate: number;
  avgDuration: number;
  commonErrors: Array<{ errorType: string; count: number }>;
}
