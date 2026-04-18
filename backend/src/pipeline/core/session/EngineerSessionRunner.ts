/**
 * EngineerSessionRunner — bridges the Engineer Rental Mode session queue
 * to the existing PipelineOrchestrator so each selected task actually
 * executes Scribe → Proto → Trace instead of sitting inert in memory.
 *
 * Responsibilities:
 *   1. Start the session timer via SessionManager.
 *   2. For each queued task: drive a full pipeline run to terminal state,
 *      auto-approving the human gate (engineer sessions are autonomous).
 *   3. Record the pipeline's prUrl + critic score on the task via
 *      SessionManager.completeTask() so the UI and session report can
 *      link back to the real work produced.
 *
 * The runner does NOT construct pipelines itself — it depends on a
 * narrow orchestrator-shaped interface so tests can provide a stub
 * without pulling in the DB / AI / GitHub layers.
 */
import type {
  PipelineState,
  ScribeInput,
  StructuredSpec,
} from '../contracts/PipelineTypes.js';
import type {
  EngineerSession,
  SelectedTask,
} from './SessionTypes.js';
import type { SessionManager } from './SessionManager.js';
import { logger } from '../../../lib/logger.js';

// ─── Orchestrator Contract ──────────────────────────

/**
 * Minimal surface of PipelineOrchestrator the runner actually needs.
 * Keeping it narrow makes the runner trivially testable and prevents
 * accidental coupling to unrelated orchestrator methods.
 */
export interface EngineerSessionOrchestrator {
  startPipeline(
    userId: string,
    input: ScribeInput,
    model?: string,
    engineerSessionId?: string,
  ): Promise<PipelineState>;

  getStatus(pipelineId: string): Promise<PipelineState>;

  approveSpec(
    pipelineId: string,
    repoName: string,
    repoVisibility: 'public' | 'private',
    editedSpec?: StructuredSpec,
  ): Promise<PipelineState>;
}

// ─── Runner Dependencies ────────────────────────────

export interface EngineerSessionRunnerDeps {
  sessionManager: SessionManager;
  orchestrator: EngineerSessionOrchestrator;
  /**
   * Translate a selected task (discovered by TaskDiscoveryService) into
   * the ScribeInput fed to the pipeline. Injected so the caller decides
   * stack/context/repo — the runner itself is pipeline-agnostic.
   */
  taskToScribeInput: (task: SelectedTask, session: EngineerSession) => ScribeInput;
  /** Poll interval in ms while waiting for a pipeline to advance. Default 2000. */
  pollIntervalMs?: number;
  /** Max time to wait for a single pipeline to reach a terminal stage. Default 10 min. */
  pipelineTimeoutMs?: number;
  /** Override model for pipeline AI calls — passed through to orchestrator. */
  model?: string;
}

// ─── Stage Classification ───────────────────────────

const TERMINAL_STAGES = new Set<PipelineState['stage']>([
  'completed',
  'completed_partial',
  'failed',
  'cancelled',
]);

const SUCCESS_STAGES = new Set<PipelineState['stage']>([
  'completed',
  'completed_partial',
]);

function extractPrUrl(state: PipelineState): string | undefined {
  // Proto writes the PR URL; Trace may also attach one when it opens a test PR.
  return state.protoOutput?.prUrl ?? state.traceOutput?.prUrl;
}

function extractCriticScore(state: PipelineState): number | undefined {
  // ScribeOutput.confidence is the closest always-present proxy; callers can
  // layer richer critic scoring once CriticAgent's output is surfaced on state.
  return state.scribeOutput?.confidence;
}

// ─── Runner ─────────────────────────────────────────

export class EngineerSessionRunner {
  constructor(private readonly deps: EngineerSessionRunnerDeps) {}

  /**
   * Drive the session forward: start the timer, then for each queued task
   * run a pipeline to completion and record the result. Returns after the
   * session reaches a terminal status (completed / cancelled / expired).
   */
  async run(sessionId: string, userId: string): Promise<void> {
    const { sessionManager } = this.deps;

    // Only call startSession if still in 'created' — callers may have already
    // started it from the HTTP layer, in which case we just continue.
    const initial = sessionManager.getSession(sessionId);
    if (!initial) {
      throw new Error(`EngineerSessionRunner: session not found: ${sessionId}`);
    }
    if (initial.status === 'created') {
      sessionManager.startSession(sessionId);
    }

    const pollInterval = this.deps.pollIntervalMs ?? 2000;

    while (true) {
      const session = sessionManager.getSession(sessionId);
      if (!session) return;

      // Paused is not terminal — wait it out and re-check. Resume() sets the
      // status back to 'running' and we pick up the queue where we left off.
      if (session.status === 'paused') {
        await sleep(pollInterval);
        continue;
      }

      if (session.status !== 'running') return;

      const currentTask = sessionManager.getCurrentTask(sessionId);
      if (!currentTask) return;

      let criticScore: number | undefined;
      let prUrl: string | undefined;

      try {
        const final = await this.runPipelineForTask(userId, session, currentTask);
        criticScore = extractCriticScore(final);
        prUrl = extractPrUrl(final);
        if (!SUCCESS_STAGES.has(final.stage)) {
          logger.warn(
            { sessionId, taskId: currentTask.taskId, stage: final.stage },
            '[EngineerSessionRunner] Pipeline finished non-successfully',
          );
        }
      } catch (err) {
        logger.error(
          { err, sessionId, taskId: currentTask.taskId },
          '[EngineerSessionRunner] Pipeline run threw; recording task as complete-with-no-output',
        );
      }

      sessionManager.completeTask(sessionId, { criticScore, prUrl });
    }
  }

  // ─── Single-task drive ────────────────────────────

  private async runPipelineForTask(
    userId: string,
    session: EngineerSession,
    task: SelectedTask,
  ): Promise<PipelineState> {
    const scribeInput = this.deps.taskToScribeInput(task, session);
    const started = await this.deps.orchestrator.startPipeline(
      userId,
      scribeInput,
      this.deps.model,
      session.id,
    );

    return this.driveToTerminal(started.id, session);
  }

  /**
   * Poll the pipeline until it reaches a terminal stage, auto-approving
   * the human gate when it appears (engineer sessions are autonomous).
   */
  private async driveToTerminal(
    pipelineId: string,
    session: EngineerSession,
  ): Promise<PipelineState> {
    const pollInterval = this.deps.pollIntervalMs ?? 2000;
    const timeout = this.deps.pipelineTimeoutMs ?? 10 * 60 * 1000;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const state = await this.deps.orchestrator.getStatus(pipelineId);

      if (TERMINAL_STAGES.has(state.stage)) {
        return state;
      }

      if (state.stage === 'awaiting_approval') {
        // Engineer sessions bypass the human gate. Re-use the session's
        // existing repo (Proto will operate on it via existingRepo).
        await this.deps.orchestrator.approveSpec(pipelineId, session.repo, 'private');
        // Loop again; the next getStatus will observe the post-approval stage.
        continue;
      }

      await sleep(pollInterval);
    }

    throw new Error(
      `EngineerSessionRunner: pipeline ${pipelineId} did not reach a terminal stage within ${timeout}ms`,
    );
  }
}

// ─── Utilities ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
