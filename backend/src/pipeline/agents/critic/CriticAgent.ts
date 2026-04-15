import type { CriticReviewInput, CriticReviewOutput } from './CriticTypes.js';
import {
  SPEC_REVIEW_SYSTEM_PROMPT,
  buildSpecReviewUserPrompt,
} from './prompts/spec-review.js';
import {
  CODE_REVIEW_SYSTEM_PROMPT,
  buildCodeReviewUserPrompt,
} from './prompts/code-review.js';
import { parseAIJson } from '../../core/json-extract.js';

// ─── Dependency Interface ────────────────────────

export interface CriticAIDeps {
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ─── Result Type ─────────────────────────────────

export type CriticResult =
  | { type: 'review'; data: CriticReviewOutput }
  | { type: 'error'; error: { code: string; message: string } };

// ─── Constants ───────────────────────────────────

const APPROVAL_THRESHOLD = 75;

// ─── CriticAgent ─────────────────────────────────

export class CriticAgent {
  private ai: CriticAIDeps;

  constructor(ai: CriticAIDeps) {
    this.ai = ai;
  }

  /**
   * Review a StructuredSpec produced by Scribe.
   * Uses a fresh LLM session — no shared context with Scribe.
   */
  async reviewSpec(input: CriticReviewInput, iteration = 1): Promise<CriticResult> {
    if (input.reviewType !== 'spec_review') {
      return {
        type: 'error',
        error: { code: 'CRITIC_INVALID_INPUT', message: 'reviewSpec requires reviewType "spec_review"' },
      };
    }

    const userPrompt = buildSpecReviewUserPrompt(
      input.artifact,
      input.originalIdea,
      iteration,
    );

    let responseText: string;
    try {
      responseText = await this.ai.generateText(SPEC_REVIEW_SYSTEM_PROMPT, userPrompt);
    } catch {
      return {
        type: 'error',
        error: { code: 'CRITIC_AI_ERROR', message: 'Spec review AI call failed' },
      };
    }

    return this.parseReviewResponse(responseText, 'spec_review', iteration);
  }

  /**
   * Review code output produced by Proto against the approved spec.
   * Uses a fresh LLM session — no shared context with Proto.
   */
  async reviewCode(input: CriticReviewInput, iteration = 1): Promise<CriticResult> {
    if (input.reviewType !== 'code_review') {
      return {
        type: 'error',
        error: { code: 'CRITIC_INVALID_INPUT', message: 'reviewCode requires reviewType "code_review"' },
      };
    }

    if (!input.referenceSpec) {
      return {
        type: 'error',
        error: { code: 'CRITIC_MISSING_SPEC', message: 'Code review requires referenceSpec for compliance check' },
      };
    }

    const userPrompt = buildCodeReviewUserPrompt(
      input.artifact,
      input.originalIdea,
      input.referenceSpec,
      iteration,
    );

    let responseText: string;
    try {
      responseText = await this.ai.generateText(CODE_REVIEW_SYSTEM_PROMPT, userPrompt);
    } catch {
      return {
        type: 'error',
        error: { code: 'CRITIC_AI_ERROR', message: 'Code review AI call failed' },
      };
    }

    return this.parseReviewResponse(responseText, 'code_review', iteration);
  }

  // ─── Private Helpers ────────────────────────────

  private parseReviewResponse(
    responseText: string,
    reviewType: 'spec_review' | 'code_review',
    iteration: number,
  ): CriticResult {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseAIJson<Record<string, unknown>>(responseText);
    } catch {
      return {
        type: 'error',
        error: { code: 'CRITIC_PARSE_ERROR', message: 'Failed to parse critic AI response as JSON' },
      };
    }

    const output = this.normalizeReviewOutput(parsed, reviewType, iteration);
    return { type: 'review', data: output };
  }

  private normalizeReviewOutput(
    raw: Record<string, unknown>,
    reviewType: 'spec_review' | 'code_review',
    iteration: number,
  ): CriticReviewOutput {
    const overallScore = typeof raw.overallScore === 'number'
      ? Math.max(0, Math.min(100, raw.overallScore))
      : 0;

    const findings = Array.isArray(raw.findings)
      ? raw.findings.map((f: Record<string, unknown>) => ({
          severity: this.normalizeSeverity(f.severity),
          category: this.normalizeCategory(f.category),
          description: typeof f.description === 'string' ? f.description : 'No description',
          suggestion: typeof f.suggestion === 'string' ? f.suggestion : 'No suggestion',
          location: typeof f.location === 'string' ? f.location : undefined,
        }))
      : [];

    const summary = typeof raw.summary === 'string' ? raw.summary : 'No summary provided';

    return {
      approved: overallScore >= APPROVAL_THRESHOLD,
      overallScore,
      findings,
      summary,
      reviewType,
      iteration,
    };
  }

  private normalizeSeverity(val: unknown): 'critical' | 'major' | 'minor' | 'info' {
    const valid = ['critical', 'major', 'minor', 'info'];
    return typeof val === 'string' && valid.includes(val)
      ? (val as 'critical' | 'major' | 'minor' | 'info')
      : 'info';
  }

  private normalizeCategory(
    val: unknown,
  ): 'completeness' | 'ambiguity' | 'consistency' | 'testability' | 'spec_compliance' | 'security' {
    const valid = ['completeness', 'ambiguity', 'consistency', 'testability', 'spec_compliance', 'security'];
    return typeof val === 'string' && valid.includes(val)
      ? (val as 'completeness' | 'ambiguity' | 'consistency' | 'testability' | 'spec_compliance' | 'security')
      : 'completeness';
  }
}
