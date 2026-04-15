import { eq } from 'drizzle-orm';
import { crewRuns, jobs } from '../../db/schema.js';
import { CrewTaskBoard } from './CrewTaskBoard.js';
import { CrewMailbox } from './CrewMailbox.js';
import { CrewEventEmitter } from './CrewEventEmitter.js';
import type {
  CrewRunInput,
  CrewRunStatus,
} from './types.js';
import { DEFAULT_WORKER_COLORS as COLORS } from './types.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { logger } from '../../lib/logger.js';

/**
 * CrewRunManager — Central lifecycle manager for crew runs.
 * Orchestrates: create → plan → spawn workers → track → merge → complete.
 * 
 * Does NOT replace AgentOrchestrator — works alongside it.
 * Uses AgentOrchestrator (via submitJob callback) to create child jobs.
 * 
 * Maps to Claude Code Agent Teams' team lead orchestration pattern.
 */
export class CrewRunManager {
  private readonly taskBoard: CrewTaskBoard;
  private readonly mailbox: CrewMailbox;
  private readonly eventEmitter: CrewEventEmitter;

  constructor(
    private readonly db: NodePgDatabase<Record<string, unknown>>,
    private readonly submitJobFn: (payload: Record<string, unknown>) => Promise<{ id: string }>,
    eventEmitter?: CrewEventEmitter,
  ) {
    this.eventEmitter = eventEmitter ?? new CrewEventEmitter();
    this.taskBoard = new CrewTaskBoard(db);
    this.mailbox = new CrewMailbox(db, this.eventEmitter);
  }

  getTaskBoard(): CrewTaskBoard {
    return this.taskBoard;
  }

  getMailbox(): CrewMailbox {
    return this.mailbox;
  }

  getEventEmitter(): CrewEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Create and start a crew run.
   * 1. Create crew_runs row
   * 2. Spawn worker jobs for each role
   * 3. Create tasks on the task board
   * 4. Return crew run ID for tracking
   */
  async startCrewRun(userId: string, input: CrewRunInput): Promise<string> {
    // 1. Create crew run
    const workerRoles = input.workerRoles.map((wr, i) => ({
      ...wr,
      color: wr.color ?? COLORS[i % COLORS.length],
    }));

    const [crewRun] = await this.db.insert(crewRuns).values({
      userId,
      status: 'planning',
      goal: input.goal,
      workerRoles,
      mergeStrategy: input.mergeStrategy,
      failureStrategy: input.failureStrategy,
      autoApprove: input.autoApprove,
      totalWorkers: workerRoles.length,
    }).returning();

    const crewRunId = crewRun.id;
    logger.info(`[CrewRunManager] Crew run created: ${crewRunId}, workers: ${workerRoles.length}`);

    this.eventEmitter.emitStatusChange(crewRunId, '', 'planning');

    // 2. Transition to spawning and create worker jobs
    await this.updateStatus(crewRunId, 'spawning');

    const workerJobs: Array<{ jobId: string; role: string; color: string; index: number }> = [];

    for (let i = 0; i < workerRoles.length; i++) {
      const wr = workerRoles[i];
      try {
        const job = await this.submitJobFn({
          type: wr.agentType === 'worker' ? 'scribe' : wr.agentType,
          userId,
          taskDescription: wr.taskDescription,
          crewRunId,
          workerRole: wr.role,
          workerIndex: i,
          workerColor: wr.color,
          repo: input.repo,
          branch: input.branch,
          autoApprove: input.autoApprove,
        });

        workerJobs.push({ jobId: job.id, role: wr.role, color: wr.color, index: i });
        this.eventEmitter.emitWorkerSpawned(crewRunId, job.id, wr.role, wr.color, i);

        logger.info(`[CrewRunManager] Worker spawned: ${wr.role} → ${job.id}`);
      } catch (err) {
        logger.error(`[CrewRunManager] Failed to spawn worker: ${wr.role} ${err}`);
        if (input.failureStrategy === 'fail_fast') {
          await this.failCrewRun(crewRunId, `Failed to spawn worker: ${wr.role}`);
          return crewRunId;
        }
      }
    }

    // 3. Create tasks on the task board (one per worker)
    for (const wj of workerJobs) {
      const role = workerRoles.find(wr => wr.role === wj.role)!;
      const task = await this.taskBoard.createTask(crewRunId, {
        title: `${role.role}: ${role.taskDescription}`,
        description: role.taskDescription,
        priority: wj.index,
      });

      // Auto-claim the task for the worker
      await this.taskBoard.claimTask(task.id, wj.jobId);
      this.eventEmitter.emitTaskCreated(crewRunId, task.id, task.title, role.role);
      this.eventEmitter.emitTaskClaimed(crewRunId, task.id, wj.jobId, role.role);
    }

    // 4. Transition to running
    await this.updateStatus(crewRunId, 'running');

    return crewRunId;
  }

  /**
   * Called when a worker job completes. Updates counters and checks if all done.
   */
  async onWorkerCompleted(crewRunId: string, jobId: string, role: string, result?: unknown) {
    // Update completed counter
    await this.db.execute(
      eq(crewRuns.id, crewRunId)
        ? undefined as never
        : undefined as never,
    ).catch(() => {});

    // Use raw SQL for atomic increment
    await this.db.execute(
      // Drizzle doesn't support atomic increment natively, use raw
      { sql: `UPDATE crew_runs SET completed_workers = completed_workers + 1, updated_at = now() WHERE id = $1`, params: [crewRunId] } as never,
    ).catch(async () => {
      // Fallback: read-modify-write
      const [run] = await this.db.select().from(crewRuns).where(eq(crewRuns.id, crewRunId));
      if (run) {
        await this.db.update(crewRuns)
          .set({ completedWorkers: run.completedWorkers + 1, updatedAt: new Date() })
          .where(eq(crewRuns.id, crewRunId));
      }
    });

    // Complete worker's tasks
    const workerTasks = await this.taskBoard.getWorkerTasks(jobId);
    for (const task of workerTasks) {
      if (task.status === 'in_progress') {
        await this.taskBoard.completeTask(task.id, result);
      }
    }

    this.eventEmitter.emitWorkerCompleted(crewRunId, jobId, role);

    // Send status report to crew
    await this.mailbox.sendMessage(
      crewRunId,
      { jobId, role },
      { jobId: null, role: null },
      `Task completed: ${role}`,
      'status_report',
    );

    // Check if all workers are done
    await this.checkCrewCompletion(crewRunId);
  }

  /**
   * Called when a worker job fails.
   */
  async onWorkerFailed(crewRunId: string, jobId: string, role: string, error: string) {
    const [run] = await this.db.select().from(crewRuns).where(eq(crewRuns.id, crewRunId));
    if (!run) return;

    await this.db.update(crewRuns)
      .set({ failedWorkers: run.failedWorkers + 1, updatedAt: new Date() })
      .where(eq(crewRuns.id, crewRunId));

    // Fail worker's tasks
    const workerTasks = await this.taskBoard.getWorkerTasks(jobId);
    for (const task of workerTasks) {
      if (task.status === 'in_progress') {
        await this.taskBoard.failTask(task.id, error);
      }
    }

    this.eventEmitter.emitWorkerFailed(crewRunId, jobId, role, error);

    if (run.failureStrategy === 'fail_fast') {
      await this.failCrewRun(crewRunId, `Worker failed: ${role} — ${error}`);
      return;
    }

    // best_effort: continue, check completion
    await this.checkCrewCompletion(crewRunId);
  }

  /**
   * Check if all workers are done and trigger merge if so.
   */
  private async checkCrewCompletion(crewRunId: string) {
    const [run] = await this.db.select().from(crewRuns).where(eq(crewRuns.id, crewRunId));
    if (!run || run.status !== 'running') return;

    const totalDone = run.completedWorkers + run.failedWorkers;
    if (totalDone < run.totalWorkers) return;

    // All workers done — start merge
    await this.startMerge(crewRunId);
  }

  /**
   * Merge worker outputs into final result.
   */
  private async startMerge(crewRunId: string) {
    await this.updateStatus(crewRunId, 'merging');
    this.eventEmitter.emitMergeStarted(crewRunId);

    try {
      // Gather worker job results
      const workerJobs = await this.db.select().from(jobs)
        .where(eq(jobs.crewRunId, crewRunId));

      const workerOutputs = workerJobs.map(j => ({
        role: j.workerRole ?? 'unknown',
        jobId: j.id,
        output: j.result,
        status: (j.state === 'completed' ? 'completed' : 'failed') as 'completed' | 'failed',
        tokenUsage: j.aiTotalTokens ?? undefined,
        costUsd: j.aiEstimatedCostUsd ? parseFloat(j.aiEstimatedCostUsd) : undefined,
      }));

      const totalTokens = workerOutputs.reduce((sum, w) => sum + (w.tokenUsage ?? 0), 0);
      const totalCostUsd = workerOutputs.reduce((sum, w) => sum + (w.costUsd ?? 0), 0);

      // Build merged content based on strategy
      const [run] = await this.db.select().from(crewRuns).where(eq(crewRuns.id, crewRunId));
      if (!run) return;

      const mergedContent = this.mergeOutputs(run.mergeStrategy, workerOutputs);
      const messageCount = await this.mailbox.getMessageCount(crewRunId);

      const mergedOutput = {
        mergedContent,
        workerResults: workerOutputs,
        taskBoard: (await this.taskBoard.getAllTasks(crewRunId)).map(t => ({
          taskId: t.id,
          title: t.title,
          status: t.status,
          assignedTo: t.assignedTo ?? undefined,
        })),
        messageCount,
        totalTokens,
        totalCostUsd,
      };

      // Update crew run with merged output
      await this.db.update(crewRuns)
        .set({
          status: 'completed',
          mergedOutput,
          totalTokens,
          totalCostUsd: totalCostUsd.toFixed(6),
          updatedAt: new Date(),
        })
        .where(eq(crewRuns.id, crewRunId));

      this.eventEmitter.emitMergeCompleted(crewRunId, totalTokens, totalCostUsd);
      this.eventEmitter.emitStatusChange(crewRunId, 'merging', 'completed');

      logger.info(`[CrewRunManager] Crew run completed: ${crewRunId}, tokens: ${totalTokens}, cost: ${totalCostUsd}`);
    } catch (err) {
      logger.error(`[CrewRunManager] Merge failed: ${crewRunId} ${err}`);
      await this.failCrewRun(crewRunId, `Merge failed: ${String(err)}`);
    }
  }

  private mergeOutputs(
    strategy: string,
    outputs: Array<{ role: string; output: unknown; status: string }>,
  ): string {
    const completedOutputs = outputs.filter(o => o.status === 'completed');

    switch (strategy) {
      case 'concatenate':
        return completedOutputs
          .map(o => `## ${o.role}\n\n${this.extractContent(o.output)}`)
          .join('\n\n---\n\n');

      case 'structured':
        return JSON.stringify(
          completedOutputs.reduce((acc, o) => {
            acc[o.role] = o.output;
            return acc;
          }, {} as Record<string, unknown>),
          null,
          2,
        );

      case 'synthesize':
      default:
        return completedOutputs
          .map(o => `### ${o.role}\n\n${this.extractContent(o.output)}`)
          .join('\n\n');
    }
  }

  private extractContent(output: unknown): string {
    if (typeof output === 'string') return output;
    if (output && typeof output === 'object') {
      const obj = output as Record<string, unknown>;
      if (typeof obj.content === 'string') return obj.content;
      if (typeof obj.markdown === 'string') return obj.markdown;
      if (typeof obj.result === 'string') return obj.result;
      return JSON.stringify(output, null, 2);
    }
    return String(output ?? '');
  }

  async getCrewRun(crewRunId: string) {
    const [run] = await this.db.select().from(crewRuns).where(eq(crewRuns.id, crewRunId));
    return run ?? null;
  }

  async getCrewRunWithWorkers(crewRunId: string) {
    const [run] = await this.db.select().from(crewRuns).where(eq(crewRuns.id, crewRunId));
    if (!run) return null;

    const workerJobs = await this.db.select().from(jobs).where(eq(jobs.crewRunId, crewRunId));
    const tasks = await this.taskBoard.getAllTasks(crewRunId);
    const messages = await this.mailbox.getMessages(crewRunId, { limit: 50 });

    return { ...run, workers: workerJobs, tasks, messages };
  }

  async getUserCrewRuns(userId: string) {
    return this.db.select().from(crewRuns)
      .where(eq(crewRuns.userId, userId))
      .orderBy(crewRuns.createdAt);
  }

  async cancelCrewRun(crewRunId: string) {
    await this.failCrewRun(crewRunId, 'Cancelled by user');
  }

  private async updateStatus(crewRunId: string, status: CrewRunStatus) {
    const [current] = await this.db.select().from(crewRuns).where(eq(crewRuns.id, crewRunId));
    const oldStatus = current?.status ?? '';

    await this.db.update(crewRuns)
      .set({ status, updatedAt: new Date() })
      .where(eq(crewRuns.id, crewRunId));

    this.eventEmitter.emitStatusChange(crewRunId, oldStatus, status);
  }

  private async failCrewRun(crewRunId: string, error: string) {
    await this.db.update(crewRuns)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(crewRuns.id, crewRunId));

    this.eventEmitter.emitStatusChange(crewRunId, 'running', 'failed');
    logger.error(`[CrewRunManager] Crew run failed: ${crewRunId} — ${error}`);
  }
}
