/**
 * Effort-based model routing for AKIS pipeline agents.
 *
 * Each agent scores its input complexity (1–10) and the system
 * automatically selects the most cost-effective Claude model:
 *   1–4  → Haiku   (fast, cheap)
 *   5+   → Sonnet  (balanced quality for complex specs)
 */

const MODEL_HAIKU_ANTHROPIC = 'claude-haiku-4-5-20251001';
const MODEL_SONNET_ANTHROPIC = 'claude-sonnet-4-6';
const MODEL_HAIKU_OPENROUTER = 'anthropic/claude-3.5-haiku';
const MODEL_SONNET_OPENROUTER = 'anthropic/claude-sonnet-4';

function selectModel(score: number): string {
  const provider = process.env.AI_PROVIDER ?? 'mock';
  const isOpenRouter = provider === 'openrouter';
  
  if (score >= 5) return isOpenRouter ? MODEL_SONNET_OPENROUTER : MODEL_SONNET_ANTHROPIC;
  return isOpenRouter ? MODEL_HAIKU_OPENROUTER : MODEL_HAIKU_ANTHROPIC;
}
export interface EffortScore {
  score: number;
  /** Suggested model — advisory only, user/config model takes priority */
  model: string;
  reasoning: string;
}

export function scoreScribeEffort(ideaText: string): EffortScore {
  const words = ideaText.trim().split(/\s+/).length;
  const hasTechnical =
    /database|auth|payment|microservice|api|oauth|jwt|redis|kubernetes|docker|websocket|graphql/i.test(
      ideaText,
    );
  const multipleFeatures = (
    ideaText.match(
      /\b(ve|ile|ayrıca|bunun yanı sıra|also|and|plus|including)\b/gi,
    ) ?? []
  ).length;

  let score = 3;
  if (words > 50) score += 1;
  if (words > 150) score += 1;
  if (hasTechnical) score += 2;
  if (multipleFeatures >= 3) score += 2;
  if (words > 300) score += 1;

  score = clamp(score);

  return {
    score,
    model: selectModel(score),
    reasoning: `words=${words} technical=${hasTechnical} multiFeature=${multipleFeatures} → ${score}`,
  };
}

export function scoreProtoEffort(spec: {
  userStories?: unknown[];
  acceptanceCriteria?: unknown[];
  technicalConstraints?: { stack?: string } | string;
}): EffortScore {
  const storyCount = spec.userStories?.length ?? 0;
  const criteriaCount = spec.acceptanceCriteria?.length ?? 0;
  const hasTechConstraints =
    typeof spec.technicalConstraints === 'string'
      ? spec.technicalConstraints.length > 50
      : !!(spec.technicalConstraints?.stack && spec.technicalConstraints.stack.length > 20);

  let score = 2;
  if (storyCount >= 3) score += 1;
  if (storyCount >= 5) score += 1;
  if (storyCount >= 8) score += 2;
  if (criteriaCount >= 5) score += 1;
  if (criteriaCount >= 10) score += 1;
  if (hasTechConstraints) score += 1;

  score = clamp(score);

  return {
    score,
    model: selectModel(score),
    reasoning: `stories=${storyCount} criteria=${criteriaCount} techConstraints=${hasTechConstraints} → ${score}`,
  };
}

export function scoreTraceEffort(protoResult: {
  files?: unknown[];
  fileCount?: number;
}): EffortScore {
  const fileCount = protoResult.files?.length ?? protoResult.fileCount ?? 0;

  let score = 2;
  if (fileCount >= 5) score += 1;
  if (fileCount >= 10) score += 2;
  if (fileCount >= 20) score += 2;
  if (fileCount >= 30) score += 2;

  score = clamp(score);

  return {
    score,
    model: selectModel(score),
    reasoning: `files=${fileCount} → ${score}`,
  };
}

function clamp(score: number): number {
  return Math.min(10, Math.max(1, score));
}
