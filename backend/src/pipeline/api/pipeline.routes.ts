/**
 * Pipeline API routes — Fastify plugin.
 * Will be mounted to the Fastify server in Phase 7 (integration).
 *
 * Routes:
 *   POST   /api/pipelines              → Start a new pipeline
 *   GET    /api/pipelines              → List user's pipelines
 *   GET    /api/pipelines/:id          → Get pipeline status
 *   POST   /api/pipelines/:id/message  → Send message to Scribe
 *   POST   /api/pipelines/:id/approve  → Approve spec, start Proto
 *   POST   /api/pipelines/:id/reject   → Reject spec with feedback
 *   POST   /api/pipelines/:id/retry    → Retry failed stage
 *   POST   /api/pipelines/:id/skip-trace → Skip Trace, mark completed_partial
 *   POST   /api/pipelines/:id/confirm-push → PDP-3 B4: confirm scaffold push to GitHub
 *   POST   /api/pipelines/:id/cancel-push  → PDP-3 B4: decline scaffold push, complete partial
 *   DELETE /api/pipelines/:id          → Cancel pipeline
 */

import {
  StartPipelineRequestSchema,
  SendMessageRequestSchema,
  ApproveSpecRequestSchema,
  RejectSpecRequestSchema,
  IterateFeedbackRequestSchema,
} from '../core/contracts/PipelineSchemas.js';
import type { PipelineOrchestrator } from '../core/orchestrator/PipelineOrchestrator.js';
import type { PipelineState } from '../core/contracts/PipelineTypes.js';
import { getRecentActivities } from '../core/activityEmitter.js';

export interface PipelineRoutesDeps {
  orchestrator: PipelineOrchestrator;
  getUserId: (request: unknown) => string;
}

export function createPipelineRoutes(deps: PipelineRoutesDeps) {
  const { orchestrator, getUserId } = deps;

  /** Verify the authenticated user owns this pipeline. Returns the pipeline. Throws 403 on mismatch. */
  async function assertOwnership(request: unknown, pipelineId: string): Promise<PipelineState> {
    const userId = getUserId(request);
    const pipeline = await orchestrator.getStatus(pipelineId);
    if (pipeline.userId !== userId) {
      throw Object.assign(new Error("Bu pipeline'a erişim yetkiniz yok"), { statusCode: 403 });
    }
    return pipeline;
  }

  return {
    async startPipeline(
      request: unknown,
      _reply: unknown,
      attachmentContext?: string,
      imageBlocks?: readonly import('../../services/ai/multimodalClient.js').AnthropicImageBlock[]
    ) {
      const userId = getUserId(request);

      const body = StartPipelineRequestSchema.parse((request as { body: unknown }).body);

      const pipeline = await orchestrator.startPipeline(
        userId,
        {
          idea: body.idea,
          context: body.context,
          targetStack: body.targetStack,
          existingRepo: body.existingRepo,
          attachmentContext,
          imageBlocks: imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined,
        },
        body.model,
        body.jiraConfig,
        body.parentPipelineId,
        body.skipScribe,
        body.traceEnabled
      );
      return { pipeline };
    },

    async listPipelines(request: unknown) {
      const userId = getUserId(request);
      const pipelines = await orchestrator.listPipelines(userId);
      return { pipelines };
    },

    async getStatus(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      const pipeline = await assertOwnership(request, id);
      // Attach iteration children summary so the chat UI can merge them into the
      // timeline without a second round-trip (see issue #388 / BUG-08).
      const children = await orchestrator.listChildren(id);

      // Compute live token usage for the chat gauge (issue #438). Reuses the
      // DB-persisted metrics + any in-memory accumulator the orchestrator has
      // not yet flushed, so the gauge stays accurate mid-stage.
      const { getContextWindow } = await import('../../services/ai/pricing.js');
      const model = pipeline.model ?? 'claude-sonnet-4-6';
      const live = orchestrator.getLiveTokenUsage(id, pipeline.metrics);
      const contextWindow = getContextWindow(model);
      const percentUsed =
        contextWindow > 0 ? Number(((live.totalTokens / contextWindow) * 100).toFixed(2)) : 0;

      return {
        pipeline,
        children: children.map((c) => ({
          id: c.id,
          stage: c.stage,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          iterationRequest:
            (c.intermediateState as Record<string, unknown> | null)?.iterationRequest ?? null,
          protoOutput: c.protoOutput,
          traceOutput: c.traceOutput,
          error: c.error,
        })),
        tokenUsage: {
          inputTokens: live.inputTokens,
          outputTokens: live.outputTokens,
          totalTokens: live.totalTokens,
          contextWindow,
          percentUsed,
          model,
        },
      };
    },

    async listChildren(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const children = await orchestrator.listChildren(id);
      return { children };
    },

    async getActivities(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      // PDP-2 Wave 2 (NFR-1): falls back to pipeline_activities when the
      // ring buffer is cold so reloads after a backend restart still work.
      return { activities: await getRecentActivities(id) };
    },

    async sendMessage(request: unknown, attachmentContext?: string) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const body = SendMessageRequestSchema.parse((request as { body: unknown }).body);
      const pipeline = await orchestrator.sendMessage(id, body.message, attachmentContext);
      return { pipeline };
    },

    async approveSpec(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const body = ApproveSpecRequestSchema.parse((request as { body: unknown }).body);
      const pipeline = await orchestrator.approveSpec(
        id,
        body.repoName,
        body.repoVisibility,
        body.spec,
        body.jiraConfig,
        body.cucumberEnabled
      );
      return { pipeline };
    },

    async rejectSpec(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const body = RejectSpecRequestSchema.parse((request as { body: unknown }).body);
      const pipeline = await orchestrator.rejectSpec(id, body.feedback);
      return { pipeline };
    },

    async retryStage(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const pipeline = await orchestrator.retryStage(id);
      return { pipeline };
    },

    async skipTrace(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const pipeline = await orchestrator.skipTrace(id);
      return { pipeline };
    },

    /**
     * PDP-3 B4 — user reviewed the Sandpack preview and confirmed they want
     * to push the scaffold to GitHub. Transitions out of
     * `awaiting_push_confirm` into `proto_building → trace_testing`.
     */
    async confirmPush(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const pipeline = await orchestrator.confirmPush(id);
      return { pipeline };
    },

    /**
     * PDP-3 B4 — user reviewed the Sandpack preview and decided not to push.
     * Pipeline terminates as `completed_partial`; the cached scaffold files
     * stay on the pipeline so the user can still copy/inspect them.
     */
    async cancelPush(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const pipeline = await orchestrator.cancelPush(id);
      return { pipeline };
    },

    /**
     * PDP-3 B5: user-driven Proto re-iteration at the push-confirm gate.
     * Body: `{ feedback: string }` (3-2000 chars). Valid at both
     * `awaiting_push_confirm` (B5 origin) and `awaiting_critic_resolution`
     * (P8 hard-block); orchestrator enforces the stage rejection.
     * Spec: docs/product/wave3/b5-feedback-iteration.md
     */
    async iterateWithFeedback(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const body = IterateFeedbackRequestSchema.parse((request as { body: unknown }).body);
      const pipeline = await orchestrator.iterateProtoFromFeedback(id, body.feedback);
      return { pipeline };
    },

    /**
     * P8: user manually overrode the Critic hard-block at
     * `awaiting_critic_resolution`. Pipeline advances to
     * `awaiting_push_confirm` so the existing PushGateFooter can drive the
     * final commit decision.
     */
    async criticOverride(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const pipeline = await orchestrator.criticOverride(id);
      return { pipeline };
    },

    async toggleTrace(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const { enabled } = (request as { body: { enabled: boolean } }).body;
      if (typeof enabled !== 'boolean') {
        throw Object.assign(new Error('enabled field must be a boolean'), { statusCode: 400 });
      }
      const pipeline = await orchestrator.toggleTrace(id, enabled);
      return { pipeline };
    },

    /**
     * PATCH /api/pipelines/:id/model — switch this chat's AI model between
     * turns (issue #437). Validates the model against the combined allowlist
     * and provider compatibility before persisting; subsequent Scribe /
     * Proto / Trace calls pick up the new model via `pipeline.model`.
     */
    async setModel(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      const userId = getUserId(request);
      await assertOwnership(request, id);
      const body = (request as { body: { model?: unknown } }).body ?? {};
      const rawModel = body.model;
      if (typeof rawModel !== 'string' || rawModel.trim().length === 0) {
        throw Object.assign(new Error('model field must be a non-empty string'), {
          statusCode: 400,
        });
      }
      const model = rawModel.trim();
      if (model.length > 255) {
        throw Object.assign(new Error('model too long (max 255 chars)'), { statusCode: 400 });
      }

      const { getAllKnownModels, isModelAllowed } = await import(
        '../../services/ai/modelAllowlist.js'
      );
      const allowlist = getAllKnownModels();
      if (!isModelAllowed(model, allowlist)) {
        throw Object.assign(new Error(`Model '${model}' is not in the allowlist`), {
          statusCode: 400,
          code: 'MODEL_NOT_ALLOWED',
        });
      }

      const pipeline = await orchestrator.setModel(id, userId, model);
      return { pipeline };
    },

    /** Level 4: Get pipeline explanation (explainability interface) */
    async getExplanation(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const explainability = orchestrator.getExplainability();
      const explanation = await explainability.getExplanation(id);
      return { explanation };
    },

    /** Tier 1.A: Get regression confidence report for a pipeline. */
    async getRegression(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const regression = orchestrator.getRegressionService();
      const report = await regression.getReport(id);
      return { report };
    },

    /**
     * P5b: AI request log viewer.
     *
     * Returns the persisted `job_ai_calls` rows for this pipeline, including
     * the P5a content fields (`systemPrompt`, `userPrompt`, `responseText`,
     * `thinkingBlocks`, `toolCalls`). The admin/debug rail tab renders
     * each entry as a collapsable card so the demo can answer "what did we
     * ask the model, and what did it say?" without re-running the call.
     *
     * Ownership is enforced before the lookup; pipelines without recorded
     * AI calls yield `{ calls: [] }` and the UI shows the empty state.
     */
    async getAiCalls(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const svc = orchestrator.getAiCallsService();
      const calls = await svc.getCalls(id);
      return { calls };
    },

    /** Level 4: Configure adaptive autonomy — auto-approve threshold */
    async setAutoApprove(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const body = (request as { body: { enabled?: boolean; threshold?: number } }).body;

      const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
      const threshold = typeof body.threshold === 'number' ? body.threshold : undefined;

      if (threshold !== undefined && (threshold < 50 || threshold > 100)) {
        throw Object.assign(new Error('threshold must be between 50 and 100'), { statusCode: 400 });
      }

      const update: Record<string, unknown> = {};
      if (enabled !== undefined) update.autoApproveEnabled = enabled;
      if (threshold !== undefined) update.autoApproveThreshold = threshold;

      const pipeline = await orchestrator.updatePipelineConfig(id, update);
      return { pipeline };
    },

    async cancelPipeline(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const pipeline = await orchestrator.cancelPipeline(id);
      return { pipeline };
    },

    async getAllFiles(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      const pipeline = await assertOwnership(request, id);

      const files: Record<string, string> = {};

      // Collect proto output files
      if (pipeline.protoOutput?.files) {
        for (const f of pipeline.protoOutput.files) {
          if (f.content) {
            files[f.filePath] = f.content;
          }
        }
      }

      // Collect trace output files
      if (pipeline.traceOutput?.testFiles) {
        for (const f of pipeline.traceOutput.testFiles) {
          if (f.content) {
            files[f.filePath] = f.content;
          }
        }
      }

      return {
        files,
        title: pipeline.title || 'AKIS Preview',
      };
    },

    async updateTitle(request: unknown) {
      const userId = getUserId(request);
      const { id } = (request as { params: { id: string } }).params;
      const { title } = (request as { body: { title: string } }).body;
      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        throw Object.assign(new Error('Title is required'), { statusCode: 400 });
      }
      const trimmed = title.trim().slice(0, 200);
      const pipeline = await orchestrator.updateTitle(id, userId, trimmed);
      return { pipeline };
    },

    async getMetrics(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const metricsService = orchestrator.getMetricsService();
      const runMetrics = metricsService.getRunMetrics(id);
      return { metrics: runMetrics ?? null, summary: metricsService.getSummary() };
    },

    async getFileContent(request: unknown) {
      const { id, '*': filePath } = (request as { params: { id: string; '*': string } }).params;
      if (!filePath) throw Object.assign(new Error('File path is required'), { statusCode: 400 });
      // Guard against path traversal attempts
      if (filePath.includes('..') || filePath.startsWith('/')) {
        throw Object.assign(new Error('Invalid file path'), { statusCode: 400 });
      }
      const pipeline = await assertOwnership(request, id);

      // Search in proto output files
      const protoFile = pipeline.protoOutput?.files?.find((f) => f.filePath === filePath);
      if (protoFile) {
        return {
          path: protoFile.filePath,
          content: protoFile.content,
          language: detectLanguage(protoFile.filePath),
          lines: protoFile.linesOfCode,
          agent: 'proto',
        };
      }

      // Search in trace output files
      const traceFile = pipeline.traceOutput?.testFiles?.find((f) => f.filePath === filePath);
      if (traceFile) {
        return {
          path: traceFile.filePath,
          content: traceFile.content,
          language: detectLanguage(traceFile.filePath),
          lines: traceFile.testCount,
          agent: 'trace',
        };
      }

      throw Object.assign(new Error('File not found'), { statusCode: 404 });
    },
  };
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    html: 'html',
    css: 'css',
    scss: 'scss',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
    py: 'python',
    sql: 'sql',
    toml: 'toml',
    xml: 'xml',
  };
  return langMap[ext] || 'text';
}
