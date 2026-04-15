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
 *   DELETE /api/pipelines/:id          → Cancel pipeline
 */

import {
  StartPipelineRequestSchema,
  SendMessageRequestSchema,
  ApproveSpecRequestSchema,
  RejectSpecRequestSchema,
} from '../core/contracts/PipelineSchemas.js';
import type { PipelineOrchestrator } from '../core/orchestrator/PipelineOrchestrator.js';
import type { PipelineState } from '../core/contracts/PipelineTypes.js';
import { getActivities } from '../core/activityEmitter.js';

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
      throw Object.assign(new Error('Bu pipeline\'a erişim yetkiniz yok'), { statusCode: 403 });
    }
    return pipeline;
  }

  return {
    async startPipeline(request: unknown, _reply: unknown) {
      const userId = getUserId(request);

      // ── Auth + Usage Limit Guard ─────────────────────────────────────
      // Admins: unlimited, no restrictions
      // Users using own API key (active provider has configured key): relaxed limits (daily job limit still applies)
      // Users using AKIS built-in key: full plan limits (daily jobs + monthly token budget)
      try {
        const { requireAuth: _requireAuth } = await import('../../utils/auth.js');
        const user = await _requireAuth(request as import('fastify').FastifyRequest);
        if (user.role !== 'admin') {
          const { getMultiProviderStatus } = await import('../../services/ai/user-ai-keys.js');
          const keyStatus = await getMultiProviderStatus(user.id);

          // Determine if user is actively using their own key
          const activeProvider = keyStatus.activeProvider;
          const providers = keyStatus.providers as Record<string, { configured: boolean }>;
          const isUsingOwnKey = activeProvider
            ? providers[activeProvider]?.configured === true
            : false;

          if (!isUsingOwnKey) {
            // Using AKIS built-in key → enforce full plan limits (daily + token budget)
            const { checkUsageLimits } = await import('../../services/billing/BillingService.js');
            const limitCheck = await checkUsageLimits(user.id);
            if (!limitCheck.allowed) {
              throw Object.assign(
                new Error(limitCheck.reason || 'Gunluk pipeline limitinize ulastiniz (3/3). Kendi AI anahtarinizi eklerseniz sinirsiz kullanabilirsiniz.'),
                { statusCode: 429, code: limitCheck.code || 'DAILY_LIMIT_EXCEEDED' },
              );
            }
          }
          // isUsingOwnKey = true → skip token budget check, but daily job limit still tracked via incrementUsage
        }
      } catch (err) {
        if (err && typeof err === 'object' && 'statusCode' in err) {
          const status = (err as { statusCode: number }).statusCode;
          if (status === 403 || status === 429) throw err;
        }
        // Non-403/429 errors (auth lookup, DB) — proceed with pipeline start
      }

      const body = StartPipelineRequestSchema.parse((request as { body: unknown }).body);

      // Increment daily usage counter BEFORE starting pipeline
      // (prevents bypass by starting many pipelines simultaneously)
      try {
        const { incrementUsage: _incr } = await import('../../services/billing/BillingService.js');
        await _incr(userId, 0);
      } catch {
        // Non-blocking — if counter fails, pipeline still starts
      }

      const pipeline = await orchestrator.startPipeline(userId, {
        idea: body.idea,
        context: body.context,
        targetStack: body.targetStack,
        existingRepo: body.existingRepo,
      }, body.model, body.jiraConfig, body.parentPipelineId, body.skipScribe, body.traceEnabled);
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
      return { pipeline };
    },

    async getActivities(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      return { activities: getActivities(id) };
    },

    async sendMessage(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const body = SendMessageRequestSchema.parse((request as { body: unknown }).body);
      const pipeline = await orchestrator.sendMessage(id, body.message);
      return { pipeline };
    },

    async approveSpec(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const body = ApproveSpecRequestSchema.parse((request as { body: unknown }).body);
      const pipeline = await orchestrator.approveSpec(id, body.repoName, body.repoVisibility, body.spec, body.jiraConfig, body.cucumberEnabled);
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

    /** Level 4: Get pipeline explanation (explainability interface) */
    async getExplanation(request: unknown) {
      const { id } = (request as { params: { id: string } }).params;
      await assertOwnership(request, id);
      const explainability = orchestrator.getExplainability();
      const explanation = explainability.getExplanation(id);
      return { explanation };
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
      if (!filePath) throw new Error('File path is required');
      const pipeline = await assertOwnership(request, id);

      // Search in proto output files
      const protoFile = pipeline.protoOutput?.files?.find(
        (f) => f.filePath === filePath,
      );
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
      const traceFile = pipeline.traceOutput?.testFiles?.find(
        (f) => f.filePath === filePath,
      );
      if (traceFile) {
        return {
          path: traceFile.filePath,
          content: traceFile.content,
          language: detectLanguage(traceFile.filePath),
          lines: traceFile.testCount,
          agent: 'trace',
        };
      }

      throw new Error(`File not found: ${filePath}`);
    },
  };
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', html: 'html', css: 'css', scss: 'scss',
    md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'shell',
    py: 'python', sql: 'sql', toml: 'toml', xml: 'xml',
  };
  return langMap[ext] || 'text';
}
