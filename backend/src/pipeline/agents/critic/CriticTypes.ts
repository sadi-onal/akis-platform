// ─── Critic Agent Types ──────────────────────────

export interface CriticReviewInput {
  /** What is being reviewed: spec or code */
  reviewType: 'spec_review' | 'code_review';
  /** The artifact to review (Scribe's spec or Proto's code output) */
  artifact: unknown;
  /** Original user idea (for context) */
  originalIdea: string;
  /** If code_review, the spec is also needed for compliance checking */
  referenceSpec?: unknown;
}

export interface CriticFinding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  category:
    | 'completeness'
    | 'ambiguity'
    | 'consistency'
    | 'testability'
    | 'spec_compliance'
    | 'security';
  description: string;
  suggestion: string;
  /** Which section/area the finding relates to */
  location?: string;
}

export interface CriticReviewOutput {
  approved: boolean;
  overallScore: number; // 0-100
  findings: CriticFinding[];
  summary: string;
  reviewType: 'spec_review' | 'code_review';
  /** Which review iteration this is */
  iteration: number;
}
