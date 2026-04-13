/**
 * Workflow API wrapper — wraps pipeline backend endpoints with "workflow" terminology.
 * Backend endpoints remain /api/pipelines/*; frontend says "workflow".
 */
import { HttpClient } from './HttpClient';
import { getApiBaseUrl } from './config';
import type { Workflow, WorkflowStages, WorkflowStatus, StageResult, ConversationMessage } from '../../types/workflow';
import type { Pipeline, PipelineStage, ScribeOutput, ProtoOutput, TraceOutput, ScribeMessageType, ScribeClarification } from '../../types/pipeline';

const http = new HttpClient(getApiBaseUrl());

function mapStageStatus(pipelineStage: PipelineStage): { workflowStatus: WorkflowStatus; stages: WorkflowStages } {
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
      stages.trace.status = 'completed';
      workflowStatus = 'completed';
      break;
    case 'completed_partial':
      stages.scribe.status = 'completed';
      stages.approve.status = 'completed';
      stages.proto.status = 'completed';
      stages.trace.status = 'failed';
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
  return {
    confidence: scribeOutput.confidence,
    spec: spec ? {
      title: spec.title,
      problemStatement: spec.problemStatement,
      userStories: spec.userStories.map(s => ({
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
    } : undefined,
  };
}

function mapProtoOutput(protoOutput?: ProtoOutput): Partial<StageResult> {
  if (!protoOutput) return {};
  return {
    branch: protoOutput.branch,
    repo: protoOutput.repo,
    repoUrl: protoOutput.repoUrl,
    files: protoOutput.files.map(f => f.filePath),
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
            userStories: specOutput.spec.userStories.map(s => ({
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
    messages.push({
      role: 'proto',
      type: 'proto_result',
      content: `Scaffold oluşturuldu — ${pipeline.protoOutput.metadata.filesCreated} dosya, ${pipeline.protoOutput.metadata.totalLinesOfCode} satır`,
      timestamp: pipeline.metrics?.protoCompletedAt || new Date().toISOString(),
      protoResult: {
        branch: pipeline.protoOutput.branch,
        repo: pipeline.protoOutput.repo,
        files: pipeline.protoOutput.files.map(f => ({
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
        testFiles: pipeline.traceOutput.testFiles.map(f => ({
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
  }

  return messages;
}

export function mapPipelineToWorkflow(pipeline: Pipeline): Workflow {
  const { workflowStatus, stages } = mapStageStatus(pipeline.stage);

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

  return {
    id: pipeline.id,
    title: pipeline.title || (
      pipeline.scribeConversation?.[0]?.type === 'user_idea' &&
      typeof (pipeline.scribeConversation[0] as Record<string, unknown>)?.content === 'string'
        ? ((pipeline.scribeConversation[0] as Record<string, unknown>).content as string).slice(0, 60)
        : 'Isimsiz Is Akisi'
    ),
    status: workflowStatus,
    currentStage: pipeline.stage,
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
    stages,
    conversation: mapConversation(pipeline),
  };
}

// Backend wraps responses: { pipeline: ... } or { pipelines: [...] }
interface PipelineResponse { pipeline: Pipeline }
interface PipelinesResponse { pipelines: Pipeline[] }

export const workflowsApi = {
  list: async (): Promise<Workflow[]> => {
    const res = await http.get<PipelinesResponse>('/api/pipelines');
    const pipelines = res.pipelines;
    return (Array.isArray(pipelines) ? pipelines : []).map(mapPipelineToWorkflow);
  },

  get: async (id: string): Promise<Workflow> => {
    const res = await http.get<PipelineResponse>(`/api/pipelines/${id}`);
    return mapPipelineToWorkflow(res.pipeline);
  },

  create: async (data: {
    idea: string;
    context?: string;
    targetStack?: string;
    model?: string;
    existingRepo?: { owner: string; repo: string; branch: string };
    parentPipelineId?: string;
  }): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>('/api/pipelines', data);
    return mapPipelineToWorkflow(res.pipeline);
  },

  approve: async (
    id: string,
    repoName: string,
    repoVisibility: 'public' | 'private' = 'private',
    options?: { jiraConfig?: { projectKey: string; enabled: boolean }; cucumberEnabled?: boolean },
  ): Promise<Workflow> => {
    const body: Record<string, unknown> = { repoName, repoVisibility };
    if (options?.jiraConfig) body.jiraConfig = options.jiraConfig;
    if (options?.cucumberEnabled != null) body.cucumberEnabled = options.cucumberEnabled;
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/approve`, body);
    return mapPipelineToWorkflow(res.pipeline);
  },

  reject: async (id: string, feedback?: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/reject`, feedback ? { feedback } : undefined);
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

  rename: async (id: string, title: string): Promise<void> => {
    await http.patch(`/api/pipelines/${id}/title`, { title });
  },

  cancel: async (id: string): Promise<void> => {
    await http.delete(`/api/pipelines/${id}`);
  },

  poll: async (id: string): Promise<Workflow> => {
    const res = await http.get<PipelineResponse>(`/api/pipelines/${id}`);
    return mapPipelineToWorkflow(res.pipeline);
  },

  sendMessage: async (id: string, message: string): Promise<Workflow> => {
    const res = await http.post<PipelineResponse>(`/api/pipelines/${id}/message`, { message });
    return mapPipelineToWorkflow(res.pipeline);
  },

  getAllFiles: async (pipelineId: string): Promise<{
    files: Record<string, string>;
    title: string;
  }> => {
    return http.get(`/api/pipelines/${pipelineId}/files-all`);
  },

  getProtoFiles: async (pipelineId: string): Promise<Record<string, string>> => {
    try {
      const res = await http.get<{ files: Record<string, string> }>(`/api/pipelines/${pipelineId}/files-all`);
      return res.files ?? {};
    } catch {
      return {};
    }
  },

  getFileContent: async (pipelineId: string, filePath: string): Promise<{
    path: string;
    content: string;
    language: string;
    lines: number;
    agent: 'proto' | 'trace';
  }> => {
    return http.get(`/api/pipelines/${pipelineId}/files/${filePath}`);
  },
};
