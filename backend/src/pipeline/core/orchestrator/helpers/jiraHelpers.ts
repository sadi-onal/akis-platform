/**
 * Jira integration helper functions extracted from PipelineOrchestrator.
 *
 * Kademe 1 refactor -- zero behavior change, pure mechanical extraction.
 */
import type { StructuredSpec } from '../../contracts/PipelineTypes.js';
import type { PipelineStore } from '../PipelineOrchestrator.js';
import { JiraMCPService } from '../../../../services/mcp/adapters/JiraMCPService.js';
import { getConnectionStatus as getAtlassianStatus } from '../../../../services/atlassian/AtlassianMcpClient.js';
import {
  createJiraEpicFromSpec,
  commentJiraWithProtoResult,
  commentJiraWithTraceResult,
  commentJiraWithFailure,
} from '../../../integrations/jiraIntegration.js';
import { logger } from '../../../../lib/logger.js';

/** Create a Jira Epic from an approved spec and link it to the pipeline. */
export async function runJiraEpicCreation(
  pipelineId: string,
  userId: string,
  projectKey: string,
  spec: StructuredSpec,
  store: PipelineStore
): Promise<void> {
  const jira = await JiraMCPService.fromOAuth(userId);
  if (!jira) return;
  try {
    const epicKey = await createJiraEpicFromSpec(jira, projectKey, spec);
    if (epicKey) {
      let siteUrl = jira.siteUrl;
      if (!siteUrl) {
        try {
          const status = await getAtlassianStatus(userId);
          siteUrl = status.siteUrl;
        } catch (err) {
          logger.warn(
            { err, userId },
            '[Pipeline] Jira siteUrl resolve failed (Epic still linked, link will be missing)'
          );
        }
      }
      await store.update(pipelineId, {
        jiraConfig: { projectKey, enabled: true, epicKey, siteUrl },
      });
      logger.info(`[Pipeline] Jira Epic ${epicKey} linked to pipeline ${pipelineId}`);
    }
  } catch (err) {
    logger.warn({ err }, '[Pipeline] Jira Epic creation failed (non-fatal)');
  } finally {
    await jira.close();
  }
}

/**
 * Post a failure comment to the linked Jira Epic when there is one.
 * Safe to call unconditionally -- returns silently when no Epic is linked.
 */
export async function postJiraFailureComment(
  pipelineId: string,
  label: string,
  error: { code: string; message: string; retryable: boolean },
  store: PipelineStore
): Promise<void> {
  let pipeline;
  try {
    pipeline = await store.getById(pipelineId);
  } catch {
    return;
  }
  const epicKey = pipeline?.jiraConfig?.epicKey;
  const userId = pipeline?.userId;
  if (!epicKey || !userId) return;

  const jira = await JiraMCPService.fromOAuth(userId);
  if (!jira) return;

  try {
    await commentJiraWithFailure(jira, epicKey, {
      stage: label,
      errorCode: error.code,
      errorMessage: error.message,
      retryable: error.retryable,
      pipelineId,
    });
  } finally {
    await jira.close();
  }
}

/** Post a Proto completion comment to the linked Jira Epic. */
export async function runJiraProtoComment(
  userId: string,
  epicKey: string,
  result: { branch: string; repo: string; prUrl?: string; filesCreated: number }
): Promise<void> {
  const jira = await JiraMCPService.fromOAuth(userId);
  if (!jira) return;
  try {
    await commentJiraWithProtoResult(jira, epicKey, result);
  } catch (err) {
    logger.warn({ err }, '[Pipeline] Jira Proto comment failed (non-fatal)');
  } finally {
    await jira.close();
  }
}

/** Post a Trace completion comment to the linked Jira Epic. */
export async function runJiraTraceComment(
  userId: string,
  epicKey: string,
  result: { totalTests: number; coveragePercentage: number; passed: boolean }
): Promise<void> {
  const jira = await JiraMCPService.fromOAuth(userId);
  if (!jira) return;
  try {
    await commentJiraWithTraceResult(jira, epicKey, result);
  } catch (err) {
    logger.warn({ err }, '[Pipeline] Jira Trace comment failed (non-fatal)');
  } finally {
    await jira.close();
  }
}
