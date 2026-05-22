/**
 * Workflow API wrapper — wraps pipeline backend endpoints with "workflow" terminology.
 * Backend endpoints remain /api/pipelines/*; frontend says "workflow".
 */
import { HttpClient } from './HttpClient';
import { getApiBaseUrl } from './config';
import type {
  Workflow,
  WorkflowStages,
  WorkflowStatus,
  StageResult,
  ConversationMessage,
} from '../../types/workflow';
import type {
  Pipeline,
  PipelineStage,
  ScribeOutput,
  ProtoOutput,
  TraceOutput,
  ScribeMessageType,
  ScribeClarification,
  PipelineExplanation,
  RegressionReport,
  AiCallEntry,
} from '../../types/pipeline';
import type { ChatAttachment } from '../../components/chat/ChatInput';

const http = new HttpClient(getApiBaseUrl());

function mapStageStatus(
  pipelineStage: PipelineStage,
  traceEnabled?: boolean,
  protoCommitted?: boolean
): { workflowStatus: WorkflowStatus; stages: WorkflowStages } {
  const idle: StageResult = { status: 'idle' };

  const stages: WorkflowStages = {
    scribe: { ...idle },
    approve: { ...idle },
    proto: { ...idle },
    trace: { ...idle },
  };

  let workflowStatus: WorkflowStatus = 'pending';

  switch (pipelineStage) {
    case 'scribe_clarifying':
    case 'scribe_generating':
      stages.scribe.status = 'running';
      workflowStatus = 'running';
      break;
    case 'awaiting_approval':
      stages.scribe.status = 'completed';
      stages.approve.status = 'pending';
      workflowStatus = 'awaiting_approval';
      break;
    case 'proto_building':
      stages.scribe.status = 'completed';
      stages.approve.status = 'completed';
      stages.proto.status = 'running';
      workflowStatus = 'running';
      break;
    case 'awaiting_push_confirm':
      // PDP-3 B4: Proto generated the scaffold but is awaiting the user's
      // explicit "push to GitHub" confirmation. Treat the workflow status
      // as `awaiting_approval` so the UI uses the same "needs your input"
      // visual treatment as the spec-approval moment.
      stages.scribe.status = 'completed';
      stages.approve.status = 'completed';
      stages.proto.status = 'completed';
      workflowStatus = 'awaiting_approval';
      break;
    case 'trace_testing':
      stages.scribe.status = 'completed';
      stages.approve.status = 'completed';
      stages.proto.status = 'completed';
      stages.trace.status = 'running';
      workflowStatus = 'running';
      break;
    case 'completed':
      stages.scribe.status = 'completed';
      stages.approve.status = 'completed';
      stages.proto.status = 'completed';
      stages.trace.status = traceEnabled === false ? 'idle' : 'completed';
      workflowStatus = 'completed';
      break;
    case 'completed_partial':
      stages.scribe.status = 'completed';
      stages.approve.status = 'completed';
      // PDP-3 B4: completed_partial has two distinct causes — (a) the user
      // cancelled at the push-confirm gate (protoOutput.metadata.committed
      // === false: nothing was ever pushed) and (b) Trace failed after a
      // successful push. The first case should NOT show Proto as completed
      // or Trace as failed — the user deliberately stopped before either
      // happened. The second case keeps the legacy "Trace: failed" look.
      if (protoCommitted === false) {
        stages.proto.status = 'idle';
        stages.trace.status = 'idle';
      } else {
        stages.proto.status = 'completed';
        stages.trace.status = 'failed';
      }
      workflowStatus = 'completed_partial';
      break;
    case 'failed':
      workflowStatus = 'failed';
      stages.scribe.status = 'completed';
      break;
    case 'cancelled':
      workflowStatus = 'cancelled';
      break;
  }

  return { workflowStatus, stages };
}

function mapScribeOutput(scribeOutput?: ScribeOutput): Partial<StageResult> {
  if (!scribeOutput) return {};
  const spec = scribeOutput.spec;
  // PR-V6-fix (2026-05-20): forward `assumptions` so ChatPageLayout can
  // surface them through PipelineDetailRail → ExplanationPanel. Previously
  // the chat-side PlanCard already had assumptions (via
  // `ConversationMessage.assumptions` from `spec_draft`), but the Açıklama
  // tab's disclosure section was always undefined because the mapper dropped
  // them on the floor.
  return {
    confidence: scribeOutput.confidence,
    assumptions: scribeOutput.assumptions,
    spec: spec
      ? {
          title: spec.title,
          problemStatement: spec.problemStatement,
          userStories: spec.userStories.map((s) => ({
            persona: s.persona,
            as: s.persona,
            action: s.action,
            iWant: s.action,
            benefit: s.benefit,
            soThat: s.benefit,
          })),
          acceptanceCriteria: spec.acceptanceCriteria,
          technicalConstraints: spec.technicalConstraints,
          outOfScope: spec.outOfScope,
        }
      : undefined,
  };
}

function mapProtoOutput(protoOutput?: ProtoOutput): Partial<StageResult> {
  if (!protoOutput) return {};
  return {
    branch: protoOutput.branch,
    repo: protoOutput.repo,
    repoUrl: protoOutput.repoUrl,
    files: protoOutput.files.map((f) => f.filePath),
  };
}

function mapTraceOutput(traceOutput?: TraceOutput): Partial<StageResult> {
  if (!traceOutput) return {};
  return {
    tests: traceOutput.testSummary.totalTests,
    coverage: `${traceOutput.testSummary.coveragePercentage}%`,
  };
}

function mapConversation(pipeline: Pipeline): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const scribeConv = pipeline.scribeConversation;

  if (!Array.isArray(scribeConv)) return messages;

  for (const entry of scribeConv) {
    const msg = entry as ScribeMessageType;

    switch (msg.type) {
      case 'user_idea':
        messages.push({
          role: 'user',
          type: 'message',
          content: msg.content,
          timestamp: pipeline.createdAt,
        });
        break;
      case 'clarification': {
        const clarification = msg.content as ScribeClarification | undefined;
        messages.push({
          role: 'scribe',
          type: 'clarification',
          content: 'Fikrini daha iyi anlayabilmem için birkaç sorum var:',
          questions: clarification?.questions ?? [],
          timestamp: new Date().toISOString(),
        });
        break;
      }
      case 'user_answer':
      case 'user_note':
        messages.push({
          role: 'user',
          type: 'message',
          content: typeof msg.content === 'string' ? msg.content : String(msg.content ?? ''),
          timestamp: new Date().toISOString(),
        });
        break;
      case 'spec_draft': {
        const specOutput = msg.content as ScribeOutput | undefined;
        if (!specOutput?.spec) break;
        messages.push({
          role: 'scribe',
          type: 'spec',
          content: 'Spec oluşturuldu:',
          spec: {
            title: specOutput.spec.title,
            problemStatement: specOutput.spec.problemStatement,
            userStories: specOutput.spec.userStories.map((s) => ({
              persona: s.persona,
              as: s.persona,
              action: s.action,
              iWant: s.action,
              benefit: s.benefit,
              soThat: s.benefit,
            })),
            acceptanceCriteria: specOutput.spec.acceptanceCriteria,
            technicalConstraints: specOutput.spec.technicalConstraints,
            outOfScope: specOutput.spec.outOfScope,
          },
          confidence: specOutput.confidence,
          reviewNotes: specOutput.reviewNotes,
          assumptions: specOutput.assumptions,
          timestamp: pipeline.metrics?.scribeCompletedAt || new Date().toISOString(),
        });
        break;
      }
      case 'spec_approved':
        messages.push({
          role: 'system',
          type: 'message',
          content: 'Spec onaylandı — Proto aşamasına geçiliyor.',
          timestamp: pipeline.metrics?.approvedAt || new Date().toISOString(),
        });
        break;
      case 'spec_rejected': {
        const rejection = msg.content as { feedback: string };
        messages.push({
          role: 'system',
          type: 'message',
          content: `Spec reddedildi: ${rejection.feedback}`,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }
  }

  // Add proto result message if completed
  if (pipeline.protoOutput?.ok) {
    // PR-T3 S4: protoOutput sadece son iterasyonu saklıyor (backend overwrite
    // ediyor); manuel testte kullanıcı "scaffold 14 dosya" gördükten sonra
    // sayfa yenileyince "10 dosya"ya dönüştüğünü farkedip iterasyon olduğunu
    // anlamamıştı. `iterationHistory` her tamamlanan Proto+Değerlendirme
    // turunu içeriyor — uzunluğu o anki iterasyon numarasını veriyor.
    // criticIterateRetryCount sadece otomatik döngüyü sayıyordu, manuel
    // iterasyonları kaçırıyordu; trajectory ile aynı kaynaktan beslesin.
    const iterHistory = pipeline.intermediateState?.iterationHistory;
    const iterCount = Array.isArray(iterHistory) ? iterHistory.length : 0;
    const iterNote =
      iterCount > 1
        ? `\n\n_Değerlendirme geri bildirimi sonrası ${iterCount}. iterasyon._`
        : '';
    const stat = `Scaffold oluşturuldu — ${pipeline.protoOutput.metadata.filesCreated} dosya, ${pipeline.protoOutput.metadata.totalLinesOfCode} satır${iterNote}`;
    const summary = pipeline.protoOutput.summary;
    messages.push({
      role: 'proto',
      type: 'proto_result',
      content: summary ? `${stat}\n\n${summary}` : stat,
      timestamp: pipeline.metrics?.protoCompletedAt || new Date().toISOString(),
      protoResult: {
        branch: pipeline.protoOutput.branch,
        repo: pipeline.protoOutput.repo,
        files: pipeline.protoOutput.files.map((f) => ({
          name: f.filePath.split('/').pop() || f.filePath,
          type: 'file' as const,
          path: f.filePath,
          content: f.content,
          lines: f.linesOfCode,
          agent: 'proto' as const,
          status: 'new' as const,
        })),
        totalFiles: pipeline.protoOutput.metadata.filesCreated,
        totalLines: pipeline.protoOutput.metadata.totalLinesOfCode,
        ...(summary ? { summary } : {}),
        verificationReport: pipeline.protoOutput.verificationReport,
      },
    });
  }

  // Add trace result message if completed
  if (pipeline.traceOutput) {
    const ts = pipeline.traceOutput.testSummary;
    messages.push({
      role: 'trace',
      type: 'trace_result',
      content: `Test yazıldı — ${ts.totalTests} test, %${ts.coveragePercentage} coverage`,
      timestamp: pipeline.metrics?.traceCompletedAt || new Date().toISOString(),
      traceResult: {
        testCount: ts.totalTests,
        passing: ts.totalTests, // backend doesn't separate pass/fail in summary
        failing: 0,
        coverage: `${ts.coveragePercentage}%`,
        duration: '',
        testFiles: pipeline.traceOutput.testFiles.map((f) => ({
          name: f.filePath.split('/').pop() || f.filePath,
          type: 'file' as const,
          path: f.filePath,
          lines: f.testCount,
          agent: 'trace' as const,
          status: 'test' as const,
        })),
        traceability: pipeline.traceOutput.traceability,
      },
    });
  } else if (
    // PR-H bug-2 (2026-05-19): Trace dryRun failed → orchestrator parks the
    // pipeline at `awaiting_push_confirm` without persisting `traceOutput` or
    // `error` (soft failure — user still has a scaffold to push). Without a
    // synthetic chat message, the timeline ends at "Proto Scaffold oluşturuldu"
    // and the user thinks the pipeline is stuck. Add an info row so the chat
    // narrates the missing tests instead of going silent. Same handling for
    // post-Proto stages where Trace would have run but didn't produce output.
    pipeline.protoOutput?.ok &&
    (pipeline.stage === 'awaiting_push_confirm' ||
      pipeline.stage === 'completed' ||
      pipeline.stage === 'completed_partial')
  ) {
    // PR-fix (2026-05-21): when Critic was manually overridden, Trace was
    // intentionally skipped (not failed). Use a different message so the
    // user understands the cause instead of seeing a misleading
    // "model output couldn't be parsed" claim.
    const criticBlock = pipeline.intermediateState?.criticBlock as
      | { manuallyOverridden?: boolean }
      | undefined;
    const traceSkippedByOverride =
      criticBlock?.manuallyOverridden === true && !pipeline.traceOutput;
    messages.push({
      role: 'system',
      type: 'message',
      content: traceSkippedByOverride
        ? 'Test üretimi atlandı — Değerlendirme bulguları geçildiği için Trace çalıştırılmadı. Önizleme + scaffold hazır.'
        : 'Trace test üretimi tamamlanamadı (modelin çıktısı bütünleşmedi). Önizleme + scaffold hazır — testsiz devam edebilir veya iyileştirme isteyebilirsin.',
      timestamp: pipeline.metrics?.protoCompletedAt || new Date().toISOString(),
    });
  }

  return messages;
}

export function mapPipelineToWorkflow(
  pipeline: Pipeline,
  tokenUsage?: import('../../types/workflow').WorkflowTokenUsage
): Workflow {
  const protoCommitted = pipeline.protoOutput?.metadata?.committed;
  const { workflowStatus, stages } = mapStageStatus(
    pipeline.stage,
    pipeline.traceEnabled,
    protoCommitted
  );

  // Enrich stages with actual output data
  const scribeData = mapScribeOutput(pipeline.scribeOutput);
  stages.scribe = { ...stages.scribe, ...scribeData };

  const metrics = pipeline.metrics;
  if (metrics?.scribeCompletedAt) {
    stages.scribe.endTime = metrics.scribeCompletedAt;
  }
  if (metrics?.approvedAt) {
    stages.approve.status = 'completed';
    stages.approve.endTime = metrics.approvedAt;
  }

  const protoData = mapProtoOutput(pipeline.protoOutput);
  stages.proto = { ...stages.proto, ...protoData };
  if (metrics?.protoCompletedAt) {
    stages.proto.endTime = metrics.protoCompletedAt;
  }

  const traceData = mapTraceOutput(pipeline.traceOutput);
  stages.trace = { ...stages.trace, ...traceData };
  if (metrics?.traceCompletedAt) {
    stages.trace.endTime = metrics.traceCompletedAt;
  }

  // If pipeline has error, mark the current running stage as failed
  if (pipeline.error) {
    if (pipeline.stage === 'completed_partial') {
      // Trace failed gracefully — carry error to trace stage
      stages.trace.status = 'failed';
      stages.trace.error = pipeline.error.message;
    } else if (stages.trace.status === 'running' || pipeline.stage === 'trace_testing') {
      stages.trace.status = 'failed';
      stages.trace.error = pipeline.error.message;
    } else if (stages.proto.status === 'running' || pipeline.stage === 'proto_building') {
      stages.proto.status = 'failed';
      stages.proto.error = pipeline.error.message;
    } else if (stages.scribe.status === 'running') {
      stages.scribe.status = 'failed';
      stages.scribe.error = pipeline.error.message;
    }
  }

  const fallbackTitle = (() => {
    const first = pipeline.scribeConversation?.[0];
    if (first?.type !== 'user_idea') return 'Isimsiz Is Akisi';
    const content = (first as Record<string, unknown>).content;
    if (typeof content !== 'string') return 'Isimsiz Is Akisi';
    // Some ideas inline title + description separated by '\n\n'; keep only the
    // first line so the chat header doesn't render them concatenated mid-word
    // (BUG-25).
    const firstLine = content.split('\n')[0].trim();
    return firstLine.slice(0, 60) || 'Isimsiz Is Akisi';
  })();

  // P8 — surface the Critic code review + hard-block audit so ChatPanel
  // can render the score bar + resolution gate without reaching into
  // `intermediateState` itself.
  const criticReview = pipeline.intermediateState?.criticCodeOutput;
  const rawCriticBlock = pipeline.intermediateState?.criticBlock;
  const criticBlock =
    rawCriticBlock && typeof rawCriticBlock === 'object'
      ? (rawCriticBlock as Workflow['criticBlock'])
      : undefined;

  // PR-D: surface the per-AC binary coverage checklist alongside critic
  // metadata so the Explanation panel's Proto card can render it without
  // having to traverse intermediateState itself.
  const acCoverage = pipeline.intermediateState?.acCoverage;

  // PR-U3 M3: surface the Trace dryRun outcome so PushConfirmGate can
  // render in one of three modes (success / failed / pending) instead of
  // always showing the enabled confirm button. Backend sets one of
  // `'success' | 'failed'` on the success/failure handoffs; when the gate
  // opens before Trace has finished we fall through to `'pending'`.
  const rawDryRun = pipeline.intermediateState?.traceDryRunStatus as
    | 'success'
    | 'failed'
    | undefined;
  const traceDryRunStatus: 'success' | 'failed' | 'pending' =
    rawDryRun ?? (pipeline.stage === 'awaiting_push_confirm' ? 'pending' : 'success');
  const traceDryRunErrorCode = pipeline.intermediateState?.traceDryRunErrorCode as
    | string
    | undefined;

  // PR-U3 M7: explainability degraded flag — surfaces a banner when the
  // reasoning persistence layer failed after retries.
  const explainabilityDegraded = Boolean(pipeline.intermediateState?.explainabilityDegraded);

  // T3: GitHub Actions CI run result. The backend writes this into
  // `intermediateState.ciResult` once the polling step finishes; we lift it
  // to a top-level field so consumers (PipelineDetailRail) don't need to
  // know about the intermediate-state contract.
  const rawCiResult = pipeline.intermediateState?.ciResult as
    | { ok: boolean; runId: number; status: string; conclusion: string | null; htmlUrl: string }
    | undefined;

  return {
    id: pipeline.id,
    traceEnabled: pipeline.traceEnabled ?? false,
    title: pipeline.title || fallbackTitle,
    status: workflowStatus,
    currentStage: pipeline.stage,
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
    stages,
    conversation: mapConversation(pipeline),
    tokenUsage,
    model: pipeline.model ?? tokenUsage?.model,
    modelLockedAt: pipeline.modelLockedAt,
    error: pipeline.error,
    criticReview,
    criticBlock,
    acCoverage,
    traceDryRunStatus,
    ...(traceDryRunErrorCode ? { traceDryRunErrorCode } : {}),
    explainabilityDegraded,
    // T2: jiraConfig (project + epicKey + siteUrl) flows straight from the
    // pipeline record so the rail can render the "Jira Epic: PROJ-123" link
    // when the Epic was successfully created.
    ...(pipeline.jiraConfig ? { jiraConfig: pipeline.jiraConfig } : {}),
    ...(rawCiResult ? { ciResult: rawCiResult } : {}),
  };
}

// Backend wraps responses: { pipeline: ... } or { pipelines: [...] }
// Since #388 (BUG-08) the single-pipeline response also carries the pipeline's
// iteration children so the chat UI can render their progress without a second
// round-trip. Older callers that only read `.pipeline` continue to work.
interface PipelineChildSummary {
  id: string;
  stage?: string;
  createdAt?: string;
  updatedAt?: string;
  iterationRequest?: string | null;
  protoOutput?: unknown;
  traceOutput?: unknown;
  error?: unknown;
}
interface PipelineResponse {
  pipeline: Pipeline;
  children?: PipelineChildSummary[];
  tokenUsage?: import('../../types/workflow').WorkflowTokenUsage;
}
interface PipelinesResponse {
  pipelines: Pipeline[];
}

export const workflowsApi = {
  list: async (): Promise<Workflow[]> => {
    const res = await http.get<PipelinesResponse>('/api/pipelines');
    const pipelines = res.pipelines;
    return (Array.isArray(pipelines) ? pipelines : []).map((p) => mapPipelineToWorkflow(p));
  },

  get: async (id: string, opts?: { signal?: AbortSignal }): Promise<Workflow> => {
    // PR-U4 H2: accept an AbortSignal so callers (e.g. useConversationLoader
    // on rapid sidebar navigation) can cancel an in-flight fetch instead of
    // just discarding its result. Existing call sites that omit `opts` keep
    // their previous behavior.
    const res = await http.get<PipelineResponse>(`/api/pipelines/${id}`, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    return mapPipelineToWorkflow(res.pipeline, res.tokenUsage);
  },

  create: async (
    data: {
      idea: string;
      context?: string;
      targetStack?: string;
      model?: string;
      existingRepo?: { owner: string; repo: string; branch: string };
      parentPipelineId?: string;
      skipScribe?: boolean;
      traceEnabled?: boolean;
    },
    attachments?: ChatAttachment[]
  ): Promise<Workflow> => {
    if (attachments && attachments.length > 0) {
      const formData = new FormData();
      formData.append('idea', data.idea);
      if (data.context) formData.append('context', data.context);
      if (data.targetStack) formData.append('targetStack', data.targetStack);
      if (data.model) formData.append('model', data.model);
      if (data.traceEnabled != null) formData.append('traceEnabled', String(data.traceEnabled));
      if (data.skipScribe != null) formData.append('skipScribe', String(data.skipScribe));
      if (data.existingRepo) formData.append('existingRepo', JSON.stringify(data.existingRepo));
      if (data.parentPipelineId) formData.append('parentPipelineId', data.parentPipelineId);
      for (const att of attachments) {
        formData.append('files', att.file);
      }
      const res = await http.postFormData<PipelineResponse>('/api/pipelines', formData);
      return mapPipelineToWorkflow(res.pipeline);
    }
    const res = await http.post<PipelineResponse>('/api/pipelines', data);
    return mapPipelineToWorkflow(res.pipeline);
  },

  approve: async (
    id: string,
    repoName: string,
    repoVisibility: 'public' | 'private' = 'private',
    options?: { jiraConfig?: { projectKey: string; enabled: boolean }; cucumberEnabled?: boolean }
  ): Promise<Workflow> => {
    const body: Record<string, unknown> = { repoName, repoVisibility };
    if (options?.jiraConfig) body.jiraConfig = options.jiraConfig;
    if (options?.cucumberEnabled != null) body.cucumberEnabled = options.cucumberEnabled;
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/approve`, body);
    return mapPipelineToWorkflow(res.pipeline);
  },

  reject: async (id: string, feedback?: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(
      `/api/pipelines/${id}/reject`,
      feedback ? { feedback } : undefined
    );
    return mapPipelineToWorkflow(res.pipeline);
  },

  retry: async (id: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/retry`);
    return mapPipelineToWorkflow(res.pipeline);
  },

  skipTrace: async (id: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/skip-trace`);
    return mapPipelineToWorkflow(res.pipeline);
  },

  /**
   * PDP-3 B4: confirm the previewed scaffold should be pushed to GitHub.
   * Transitions the pipeline out of `awaiting_push_confirm` into the push
   * + Trace flow.
   */
  confirmPush: async (id: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/confirm-push`);
    return mapPipelineToWorkflow(res.pipeline);
  },

  /**
   * PDP-3 B4: decline the push — the pipeline ends as `completed_partial`,
   * the cached scaffold files remain on the pipeline so the user can still
   * inspect / copy them.
   */
  cancelPush: async (id: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/cancel-push`);
    return mapPipelineToWorkflow(res.pipeline);
  },

  /**
   * PDP-3 B5: re-run Proto with the user's correction request while the
   * pipeline is still at the push-confirm gate (or the P8 critic-resolution
   * gate). Backend overwrites `protoOutput.files`; the pipeline transitions
   * `awaiting_*` → `proto_building` → … → `awaiting_push_confirm` (or
   * `awaiting_critic_resolution` again if the new score is still
   * below threshold).
   * Spec: docs/product/wave3/b5-feedback-iteration.md
   */
  iterateWithFeedback: async (id: string, feedback: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/iterate-with-feedback`, {
      feedback,
    });
    return mapPipelineToWorkflow(res.pipeline);
  },

  /**
   * P8: user accepted the Critic findings and wants to push anyway. Advances
   * the pipeline from `awaiting_critic_resolution` to `awaiting_push_confirm`
   * so the existing PushGateFooter takes over the final commit decision.
   */
  criticOverride: async (id: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/critic-override`);
    return mapPipelineToWorkflow(res.pipeline);
  },

  toggleTrace: async (id: string, enabled: boolean): Promise<Workflow> => {
    const res = await http.patch<PipelineResponse>(`/api/pipelines/${id}/trace-toggle`, {
      enabled,
    });
    return mapPipelineToWorkflow(res.pipeline);
  },

  updateModel: async (id: string, model: string): Promise<Workflow> => {
    const res = await http.patch<PipelineResponse>(`/api/pipelines/${id}/model`, { model });
    return mapPipelineToWorkflow(res.pipeline);
  },

  listSupportedModels: async (
    provider?: 'anthropic' | 'openai' | 'google'
  ): Promise<{
    provider: string;
    models: Array<{ id: string; name: string; provider: string; recommended: boolean }>;
  }> => {
    const qs = provider ? `?provider=${provider}` : '';
    return http.get(`/api/ai/supported-models${qs}`);
  },

  rename: async (id: string, title: string): Promise<void> => {
    await http.patch(`/api/pipelines/${id}/title`, { title });
  },

  cancel: async (id: string): Promise<void> => {
    await http.delete(`/api/pipelines/${id}`);
  },

  /** Level 4 — fetch explainability narrative for a pipeline. */
  getExplanation: async (id: string): Promise<PipelineExplanation> => {
    const res = await http.get<{ explanation: PipelineExplanation }>(
      `/api/pipelines/${id}/explanation`
    );
    return res.explanation;
  },

  /** Tier 1.A — fetch regression confidence report for a pipeline. */
  getRegression: async (id: string): Promise<RegressionReport> => {
    const res = await http.get<{ report: RegressionReport }>(`/api/pipelines/${id}/regression`);
    return res.report;
  },

  /**
   * P5b — fetch AI request log entries for a pipeline (admin/debug viewer).
   * Returns each persisted `job_ai_calls` row including the P5a content
   * fields (systemPrompt, userPrompt, responseText, thinkingBlocks,
   * toolCalls). Empty array when the pipeline never recorded any.
   */
  getAiCalls: async (id: string): Promise<AiCallEntry[]> => {
    const res = await http.get<{ calls: AiCallEntry[] }>(`/api/pipelines/${id}/ai-calls`);
    return res.calls;
  },

  poll: async (id: string): Promise<Workflow> => {
    const res = await http.get<PipelineResponse>(`/api/pipelines/${id}`);
    return mapPipelineToWorkflow(res.pipeline);
  },

  sendMessage: async (
    id: string,
    message: string,
    attachments?: ChatAttachment[]
  ): Promise<Workflow> => {
    if (attachments && attachments.length > 0) {
      const formData = new FormData();
      formData.append('message', message);
      for (const att of attachments) {
        formData.append('files', att.file);
      }
      const res = await http.postFormData<PipelineResponse>(
        `/api/pipelines/${id}/message`,
        formData
      );
      return mapPipelineToWorkflow(res.pipeline);
    }
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/message`, { message });
    return mapPipelineToWorkflow(res.pipeline);
  },

  getAllFiles: async (
    pipelineId: string
  ): Promise<{
    files: Record<string, string>;
    title: string;
  }> => {
    return http.get(`/api/pipelines/${pipelineId}/files-all`);
  },

  getProtoFiles: async (pipelineId: string): Promise<Record<string, string>> => {
    try {
      const res = await http.get<{ files: Record<string, string> }>(
        `/api/pipelines/${pipelineId}/files-all`
      );
      return res.files ?? {};
    } catch {
      return {};
    }
  },

  getFileContent: async (
    pipelineId: string,
    filePath: string
  ): Promise<{
    path: string;
    content: string;
    language: string;
    lines: number;
    agent: 'proto' | 'trace';
  }> => {
    return http.get(`/api/pipelines/${pipelineId}/files/${filePath}`);
  },
};
