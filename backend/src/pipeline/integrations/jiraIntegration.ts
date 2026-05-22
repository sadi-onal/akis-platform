/**
 * Jira Integration — hooks for pipeline stage transitions.
 * Creates Jira Epics from specs and comments with Proto/Trace results.
 * All functions are safe to call — failures are logged but never thrown.
 */

import type { JiraMCPService } from '../../services/mcp/adapters/JiraMCPService.js';
import type { StructuredSpec } from '../core/contracts/PipelineTypes.js';
import { logger } from '../../lib/logger.js';

/** Race a promise against a timeout (ms). Rejects with descriptive error on timeout. */
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Jira timeout after ${ms}ms`)), ms)
    ),
  ]);

/** Default timeout for individual Jira API calls (ms). */
const JIRA_CALL_TIMEOUT = 5_000;

/**
 * Create a Jira Epic from a StructuredSpec.
 * Each user story becomes a sub-task linked to the Epic.
 * @returns The epic key (e.g. "PROJ-123") or null on failure.
 */
export async function createJiraEpicFromSpec(
  jira: JiraMCPService,
  projectKey: string,
  spec: StructuredSpec
): Promise<string | null> {
  try {
    const epic = await withTimeout(
      jira.createIssue(projectKey, {
        summary: spec.title,
        description: spec.problemStatement,
        issueType: 'Epic',
        labels: ['akis-pipeline'],
      }),
      JIRA_CALL_TIMEOUT
    );

    // Create child issues from user stories. Issue type fallback order:
    // 'Story' (Scrum template default) → 'Task' (Kanban default) → 'Hikaye'
    // (Jira-tr "Story") → 'Görev' (Jira-tr "Task"). The first that the
    // project accepts wins; we only fall through on the specific "invalid
    // issue type" error message, not on other failures.
    const CHILD_TYPE_FALLBACK = ['Story', 'Task', 'Hikaye', 'Görev'] as const;
    for (const story of spec.userStories) {
      let child: { key: string; id: string } | null = null;
      let lastErr: unknown;
      for (const issueType of CHILD_TYPE_FALLBACK) {
        try {
          child = await withTimeout(
            jira.createIssue(projectKey, {
              summary: `${story.persona}: ${story.action}`,
              description: `**Benefit:** ${story.benefit}`,
              issueType,
              labels: ['akis-pipeline'],
            }),
            JIRA_CALL_TIMEOUT
          );
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          // Only retry on the "invalid issue type" path; any other failure
          // is genuine — log and move on to the next story.
          if (!/issuetype|konu türü|issue.?type/i.test(msg)) break;
        }
      }
      try {
        if (!child) throw lastErr ?? new Error('all issue type fallbacks failed');
        // Link child to epic
        await withTimeout(
          jira.linkIssues(child.key, epic.key, 'is child of'),
          JIRA_CALL_TIMEOUT
        ).catch(() => {
          // Link type may vary — non-fatal
        });
      } catch (storyErr) {
        logger.warn(
          { err: storyErr },
          `[Jira] Failed to create sub-task for story "${story.action}"`
        );
      }
    }

    logger.info(`[Jira] Created Epic ${epic.key} with ${spec.userStories.length} stories`);
    return epic.key;
  } catch (err) {
    logger.warn({ err }, '[Jira] Failed to create Epic from spec');
    return null;
  }
}

/**
 * Add a comment to the Jira Epic with Proto build results.
 */
export async function commentJiraWithProtoResult(
  jira: JiraMCPService,
  epicKey: string,
  result: { branch: string; repo: string; prUrl?: string; filesCreated: number }
): Promise<void> {
  try {
    const lines = [
      `*AKIS Proto completed*`,
      `- Branch: \`${result.branch}\``,
      `- Repository: ${result.repo}`,
      `- Files created: ${result.filesCreated}`,
    ];
    if (result.prUrl) {
      lines.push(`- Pull Request: ${result.prUrl}`);
    }
    await withTimeout(jira.addComment(epicKey, lines.join('\n')), JIRA_CALL_TIMEOUT);
    logger.info(`[Jira] Commented Proto result on ${epicKey}`);
  } catch (err) {
    logger.warn({ err }, `[Jira] Failed to comment Proto result on ${epicKey}`);
  }
}

/**
 * Add a failure comment to the Jira Epic when a pipeline stage errors out.
 *
 * This closes a gap surfaced by the 2026-04-17 code review of the Jira
 * integration verify task (issue #396): success paths were instrumented,
 * but failures left the Epic silently "In Progress" forever. Now the Epic
 * gets an explicit failure log with the stage + error code so a Jira
 * watcher immediately sees what went wrong and can retry from AKIS.
 *
 * Stage/code/message are all optional — callers inside the orchestrator
 * may not have full context depending on where the failure bubbles up.
 * All field joins use "\n" so Jira renders them as separate lines.
 */
export async function commentJiraWithFailure(
  jira: JiraMCPService,
  epicKey: string,
  result: {
    stage: 'Scribe' | 'Proto' | 'Trace' | 'Critic' | 'FixLoop' | string;
    errorCode?: string;
    errorMessage?: string;
    retryable?: boolean;
    pipelineId?: string;
  }
): Promise<void> {
  try {
    const lines = [`*AKIS pipeline failed*`, `- Stage: ${result.stage}`];
    if (result.errorCode) lines.push(`- Error code: \`${result.errorCode}\``);
    if (result.errorMessage) {
      // Trim long error messages so Jira doesn't reject the comment payload.
      const trimmed =
        result.errorMessage.length > 500
          ? `${result.errorMessage.slice(0, 500)}…`
          : result.errorMessage;
      lines.push(`- Error: ${trimmed}`);
    }
    if (typeof result.retryable === 'boolean') {
      lines.push(
        `- Retryable: ${result.retryable ? 'yes — can be restarted from AKIS' : 'no — manual intervention required'}`
      );
    }
    if (result.pipelineId) lines.push(`- Pipeline: \`${result.pipelineId}\``);

    await withTimeout(jira.addComment(epicKey, lines.join('\n')), JIRA_CALL_TIMEOUT);
    logger.info(`[Jira] Commented failure on ${epicKey} (stage=${result.stage})`);
  } catch (err) {
    logger.warn({ err }, `[Jira] Failed to post failure comment on ${epicKey}`);
  }
}

/**
 * Add a comment to the Jira Epic with Trace test results.
 * Optionally transitions the Epic to "Done" if all tests passed.
 */
export async function commentJiraWithTraceResult(
  jira: JiraMCPService,
  epicKey: string,
  result: { totalTests: number; coveragePercentage: number; passed: boolean }
): Promise<void> {
  try {
    const status = result.passed ? 'All tests passed' : 'Some tests failed';
    const lines = [
      `*AKIS Trace completed*`,
      `- Status: ${status}`,
      `- Total tests: ${result.totalTests}`,
      `- Coverage: ${result.coveragePercentage}%`,
    ];
    await withTimeout(jira.addComment(epicKey, lines.join('\n')), JIRA_CALL_TIMEOUT);
    logger.info(`[Jira] Commented Trace result on ${epicKey}`);

    // Optionally transition to Done if all passed
    if (result.passed) {
      try {
        const { transitions } = await withTimeout(jira.getTransitions(epicKey), JIRA_CALL_TIMEOUT);
        const done = transitions.find(
          (t) => t.name.toLowerCase() === 'done' || t.name.toLowerCase() === 'tamamlandı'
        );
        if (done) {
          await withTimeout(jira.transitionIssue(epicKey, done.id), JIRA_CALL_TIMEOUT);
          logger.info(`[Jira] Transitioned ${epicKey} to Done`);
        }
      } catch (transErr) {
        // Transition ID varies per Jira instance — non-fatal
        logger.warn({ err: transErr }, `[Jira] Failed to transition ${epicKey} to Done`);
      }
    }
  } catch (err) {
    logger.warn({ err }, `[Jira] Failed to comment Trace result on ${epicKey}`);
  }
}
