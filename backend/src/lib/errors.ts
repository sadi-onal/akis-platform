/**
 * Structured error types for API boundaries
 */

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} not found`);
    this.name = 'JobNotFoundError';
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(jobId: string, currentState: string, attemptedTransition: string) {
    super(`Cannot ${attemptedTransition} job ${jobId}: current state is ${currentState}`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class DatabaseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`Database error: ${message}`);
    this.name = 'DatabaseError';
    this.cause = cause;
  }
}

export class SkillContractViolationError extends Error {
  readonly code = 'CONTRACT_VIOLATION' as const;
  readonly skill: string;
  readonly issues: string;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(skill: string, issues: string, attempts: number, retryable = true) {
    super(`Skill ${skill} contract violation after ${attempts} attempt(s): ${issues}`);
    this.name = 'SkillContractViolationError';
    this.skill = skill;
    this.issues = issues;
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

export class AgentContractViolationError extends Error {
  readonly code = 'CONTRACT_VIOLATION' as const;
  readonly agentType: string;
  readonly phase: 'input' | 'output';
  readonly issues: string[];
  readonly retryable: boolean;

  constructor(agentType: string, phase: 'input' | 'output', issues: string[], retryable = false) {
    super(`Agent ${agentType} ${phase} contract violation: ${issues.join('; ')}`);
    this.name = 'AgentContractViolationError';
    this.agentType = agentType;
    this.phase = phase;
    this.issues = issues;
    this.retryable = retryable;
  }
}

export class VerificationGateBlockedError extends Error {
  readonly code = 'VERIFICATION_BLOCKED' as const;
  readonly agentType: string;
  readonly rolloutMode: string;
  readonly failures: string[];
  readonly retryable: boolean;

  constructor(agentType: string, rolloutMode: string, failures: string[], retryable = false) {
    super(`Verification blocked for ${agentType} in mode ${rolloutMode}: ${failures.join(', ')}`);
    this.name = 'VerificationGateBlockedError';
    this.agentType = agentType;
    this.rolloutMode = rolloutMode;
    this.failures = failures;
    this.retryable = retryable;
  }
}

/**
 * AI-related error codes for job error classification
 */
export type AIErrorCode =
  | 'AI_RATE_LIMITED'
  | 'AI_PROVIDER_ERROR'
  | 'AI_INVALID_RESPONSE'
  | 'AI_NETWORK_ERROR'
  | 'AI_AUTH_ERROR'
  | 'AI_KEY_MISSING'
  | 'AI_MODEL_NOT_FOUND'
  | 'MODEL_NOT_ALLOWED';

/**
 * AI Provider Error - base class for AI-related errors
 */
export class AIProviderError extends Error {
  readonly code: AIErrorCode;
  readonly provider: string;
  readonly statusCode?: number;
  readonly retryAfter?: number;

  constructor(
    code: AIErrorCode,
    message: string,
    provider: string,
    statusCode?: number,
    retryAfter?: number
  ) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    this.provider = provider;
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

/**
 * AI Rate Limited Error - thrown when AI provider returns 429
 */
export class AIRateLimitedError extends AIProviderError {
  constructor(provider: string, retryAfter?: number, rawMessage?: string) {
    const message = rawMessage
      ? `AI provider ${provider} is rate limited: ${rawMessage}`
      : `AI provider ${provider} is temporarily rate limited. Please try again later.`;
    super('AI_RATE_LIMITED', message, provider, 429, retryAfter);
    this.name = 'AIRateLimitedError';
  }
}

export class MissingAIKeyError extends AIProviderError {
  constructor(provider: string, customMessage?: string) {
    super(
      'AI_KEY_MISSING',
      customMessage ||
        `AI API key is not configured for provider ${provider}. Please add a key in Settings > API Keys.`,
      provider
    );
    this.name = 'MissingAIKeyError';
  }
}

/**
 * Trace automation error codes
 */
export type TraceAutomationErrorCode =
  | 'TRACE_AUTOMATION_TIMEOUT'
  | 'TRACE_AUTOMATION_RUN_FAILED'
  | 'TRACE_AUTOMATION_LAUNCH_FAILED';

export class TraceAutomationError extends Error {
  readonly code: TraceAutomationErrorCode;
  readonly retryable: boolean;

  constructor(code: TraceAutomationErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'TraceAutomationError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class ModelNotAllowedError extends AIProviderError {
  readonly model: string;
  readonly allowlist: string[];

  constructor(provider: string, model: string, allowlist: string[]) {
    super(
      'MODEL_NOT_ALLOWED',
      `Model "${model}" is not allowed. Choose an allowlisted model.`,
      provider
    );
    this.name = 'ModelNotAllowedError';
    this.model = model;
    this.allowlist = allowlist;
  }
}
