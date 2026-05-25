/**
 * State-related helper functions extracted from PipelineOrchestrator.
 *
 * Kademe 1 refactor -- zero behavior change, pure mechanical extraction.
 * Every `this.X` dependency becomes an explicit parameter.
 */
import type { PipelineState, PipelineStage } from '../../contracts/PipelineTypes.js';
import { PipelineNotFoundError, InvalidStageError } from '../../contracts/PipelineErrors.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';
import type { ScribeState } from '../../../agents/scribe/ScribeAgent.js';

// ── Pure functions (no dependencies) ─────────────────────────

/** Check whether a stage is a terminal (no further transitions possible). */
export function isTerminalStage(stage: PipelineStage): boolean {
  return (
    stage === 'cancelled' ||
    stage === 'failed' ||
    stage === 'completed' ||
    stage === 'completed_partial'
  );
}

/** Derive a repo-name slug from a pipeline title. */
export function deriveRepoName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/** Assert that a pipeline is at the expected stage; throw InvalidStageError if not. */
export function assertStage(pipeline: PipelineState, expected: PipelineStage): void {
  if (pipeline.stage !== expected) {
    throw new InvalidStageError(expected, pipeline.stage);
  }
}

/**
 * Reconstruct a ScribeState from persisted pipeline data so Scribe
 * continuation can resume a clarifying conversation.
 */
export function reconstructScribeState(pipeline: PipelineState): ScribeState {
  const ideaMsg = pipeline.scribeConversation.find((m) => m.type === 'user_idea');
  const clarificationCount = pipeline.scribeConversation.filter(
    (m) => m.type === 'clarification'
  ).length;

  return {
    idea: typeof ideaMsg?.content === 'string' ? ideaMsg.content : '',
    conversation: [...pipeline.scribeConversation],
    clarificationRound: clarificationCount,
    phase: pipeline.stage === 'awaiting_approval' ? 'done' : 'clarifying',
    pendingQuestionIds: [],
    answeredQuestionIds: [],
  };
}

// ── Functions with store / callback dependencies ─────────────

/** Fetch a pipeline by ID; throw PipelineNotFoundError when missing. */
export async function getPipeline(id: string, store: PipelineStore): Promise<PipelineState> {
  const pipeline = await store.getById(id);
  if (!pipeline) throw new PipelineNotFoundError(id);
  return pipeline;
}

/** Check if pipeline was cancelled while background work was running. */
export async function isCancelled(pipelineId: string, store: PipelineStore): Promise<boolean> {
  try {
    const p = await store.getById(pipelineId);
    return p?.stage === 'cancelled';
  } catch {
    return false;
  }
}

/**
 * Resolve per-user GitHub token and owner, validating the token is still valid.
 * DOGFOOD_MODE bypasses real GitHub access.
 */
export async function validateGitHubAccess(
  userId: string,
  getGitHubToken: (userId: string) => Promise<string | null>,
  getGitHubOwner: (userId: string) => Promise<string>
): Promise<{ token: string; owner: string }> {
  // DOGFOOD_MODE: token-free + GitHub-free local exercise.
  if (process.env.DOGFOOD_MODE === 'true' && process.env.NODE_ENV !== 'production') {
    return { token: 'ghp_mock_dogfood', owner: 'dogfood-owner' };
  }
  const token = await getGitHubToken(userId);
  if (!token) {
    throw new Error(
      'GitHub bağlantısı bulunamadı. Ayarlar sayfasından GitHub hesabınızı bağlayın.'
    );
  }
  // Pre-validate token (skip in test/mock mode)
  if (!token.startsWith('ghp_mock')) {
    const ghRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    }).catch(() => null);
    if (ghRes && !ghRes.ok) {
      throw new Error(
        `GitHub token geçersiz (HTTP ${ghRes.status}). Ayarlar → GitHub bölümünden yeniden bağlayın.`
      );
    }
  }
  const owner = await getGitHubOwner(userId);
  return { token, owner };
}
