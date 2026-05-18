import type {
  CriticFinding,
  CriticReviewInput,
  CriticReviewOutput,
} from './CriticTypes.js';
import {
  SPEC_REVIEW_SYSTEM_PROMPT,
  buildSpecReviewUserPrompt,
} from './prompts/spec-review.js';
import {
  CODE_REVIEW_SYSTEM_PROMPT,
  buildCodeReviewUserPrompt,
} from './prompts/code-review.js';
import { parseAIJson } from '../../core/json-extract.js';
import type { SkillRegistry } from '../skills/index.js';
import { buildSystemPromptWithSkills } from '../skills/index.js';

// ─── Dependency Interface ────────────────────────

export interface CriticAIDeps {
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ─── Result Type ─────────────────────────────────

export type CriticResult =
  | { type: 'review'; data: CriticReviewOutput }
  | { type: 'error'; error: { code: string; message: string } };

// ─── Constants ───────────────────────────────────

/**
 * Default minimum score for a CriticReviewOutput to count as approved.
 * P8 — this used to be the hard-coded threshold; it now serves as the
 * fallback when no env-driven value is injected into the agent.
 */
export const DEFAULT_APPROVAL_THRESHOLD = 75;

// ─── CriticAgent ─────────────────────────────────

export class CriticAgent {
  private ai: CriticAIDeps;
  private skillRegistry?: SkillRegistry;
  private approvalThreshold: number;

  constructor(
    ai: CriticAIDeps,
    skillRegistry?: SkillRegistry,
    approvalThreshold: number = DEFAULT_APPROVAL_THRESHOLD,
  ) {
    this.ai = ai;
    this.skillRegistry = skillRegistry;
    // Clamp to the valid score range so a misconfigured env var can never
    // crash review parsing.
    this.approvalThreshold = Math.max(0, Math.min(100, Math.floor(approvalThreshold)));
  }

  /** Exposed for orchestrator/UI so the same threshold can be surfaced alongside the score. */
  getApprovalThreshold(): number {
    return this.approvalThreshold;
  }

  private enhance(basePrompt: string): string {
    if (!this.skillRegistry) return basePrompt;
    return buildSystemPromptWithSkills(basePrompt, 'critic', this.skillRegistry);
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
      responseText = await this.ai.generateText(this.enhance(SPEC_REVIEW_SYSTEM_PROMPT), userPrompt);
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
      responseText = await this.ai.generateText(this.enhance(CODE_REVIEW_SYSTEM_PROMPT), userPrompt);
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

    // PR-F: compute severity aggregates from findings array so the
    // orchestrator can decide between guardrail-mode (non-blocking advice)
    // and hard-block (severity=critical) without re-walking the list.
    const SEVERITY_ORDER: Record<CriticFinding['severity'], number> = {
      info: 0,
      minor: 1,
      major: 2,
      critical: 3,
    };
    let maxSeverity: CriticFinding['severity'] = 'info';
    for (const f of findings) {
      if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[maxSeverity]) {
        maxSeverity = f.severity;
      }
    }
    const hasCriticalFinding = maxSeverity === 'critical';

    return {
      approved: overallScore >= this.approvalThreshold,
      overallScore,
      findings,
      summary,
      reviewType,
      iteration,
      hasCriticalFinding,
      maxSeverity,
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
