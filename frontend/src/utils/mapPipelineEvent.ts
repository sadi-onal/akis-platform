import type { Pipeline, PipelineStage, CriticReviewOutput } from '../types/pipeline';
import type {
  ChatMessage,
  ChatMode,
  ConversationUIState,
  ConversationListItem,
  ConversationStatus,
} from '../types/chat';

/**
 * Maps a backend PipelineStage to the frontend ConversationUIState.
 */
export function mapStageToUIState(stage: PipelineStage): ConversationUIState {
  switch (stage) {
    case 'scribe_clarifying':
      return 'scribe_clarifying'; // Scribe finished — waiting for user answers
    case 'scribe_generating':
      return 'scribe_running';
    case 'critic_reviewing_spec':
    case 'critic_reviewing_code':
      return 'critic_running';
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'awaiting_push_confirm':
      return 'awaiting_push_confirm';
    case 'awaiting_critic_resolution':
      // P8: surface the hard-block as a distinct UI state so the rail can
      // render the resolution gate + score bar.
      return 'awaiting_critic_resolution';
    case 'proto_building':
      return 'proto_running';
    case 'trace_testing':
    case 'fix_loop_iteration':
      return 'trace_running';
    case 'ci_running':
      return 'ci_running';
    case 'completed':
    case 'completed_partial':
    case 'failed':
    case 'cancelled':
    default:
      return 'idle';
  }
}

/**
 * Maps a PipelineStage to a semantic chat mode (Plan/Act/Ask/Review).
 */
export function mapStageToMode(stage?: PipelineStage): ChatMode {
  switch (stage) {
    case 'scribe_clarifying':
      return 'ask';
    case 'scribe_generating':
    case 'critic_reviewing_spec':
    case 'awaiting_approval':
      return 'plan';
    case 'awaiting_push_confirm':
      // PDP-3 B4: gate sits between code generation and push — still in
      // the "act" phase from the user's perspective ("we're acting on the
      // approved plan; you decide whether to commit").
      return 'act';
    case 'awaiting_critic_resolution':
      // P8: Critic flagged the scaffold; user is reviewing findings. UX-wise
      // this is the "review" gate from the lens of the Plan/Act/Ask/Review
      // taxonomy — the chat is the place to push back / iterate.
      return 'review';
    case 'proto_building':
    case 'critic_reviewing_code':
    case 'trace_testing':
    case 'fix_loop_iteration':
    case 'ci_running':
      return 'act';
    case 'completed_partial':
    case 'failed':
      return 'review';
    case 'completed':
    default:
      return 'ask';
  }
}

/**
 * Maps a PipelineStage to a sidebar status indicator.
 */
export function mapStageToConversationStatus(stage: PipelineStage): ConversationStatus {
  switch (stage) {
    case 'scribe_clarifying':
    case 'scribe_generating':
    case 'critic_reviewing_spec':
    case 'proto_building':
    case 'critic_reviewing_code':
    case 'trace_testing':
    case 'fix_loop_iteration':
    case 'ci_running':
      return 'running';
    case 'awaiting_approval':
    case 'awaiting_push_confirm':
    case 'awaiting_critic_resolution':
      // PDP-3 B4 + P8: sidebar treats every "needs your input next" gate
      // the same — both push-confirm and critic-resolution show as
      // awaiting_approval in the sidebar status pill.
      return 'awaiting_approval';
    case 'completed_partial':
      // PR-U2 #2: surface partial completion distinctly — user cancelled
      // mid-flight or Trace soft-failed; the pipeline produced something
      // but not the full deliverable. Yellow warning dot, "Kısmen
      // tamamlandı" label.
      return 'partial';
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * Maps a backend Pipeline to a ConversationListItem for the sidebar.
 */
export function mapPipelineToConversationItem(pipeline: Pipeline): ConversationListItem {
  const repoName = pipeline.protoConfig?.repoName ?? pipeline.title ?? 'Isimsiz';
  const owner = pipeline.protoOutput?.repo?.split('/')?.[0] ?? '';

  return {
    id: pipeline.id,
    title: pipeline.title ?? repoName,
    repoFullName: owner ? `${owner}/${repoName}` : repoName,
    repoShortName: repoName,
    status: mapStageToConversationStatus(pipeline.stage),
    fileCount: pipeline.protoOutput?.files?.length ?? 0,
    lastActivity: pipeline.updatedAt,
    branch: pipeline.protoOutput?.branch,
    prUrl: pipeline.protoOutput?.prUrl,
    prNumber: undefined,
  };
}

/**
 * Maps the scribeConversation array from a Pipeline into ChatMessage[].
 */
export function mapPipelineToChatMessages(pipeline: Pipeline): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const now = new Date().toISOString();

  for (const msg of pipeline.scribeConversation ?? []) {
    switch (msg.type) {
      case 'user_idea':
      case 'user_answer':
      case 'user_note':
        messages.push({
          type: 'user',
          content: typeof msg.content === 'string' ? msg.content : String(msg.content ?? ''),
          timestamp: now,
        });
        break;
      case 'clarification': {
        const clar = (msg.content ?? {}) as unknown as Record<string, unknown>;
        messages.push({
          type: 'clarification',
          role: 'scribe' as const,
          content:
            typeof clar.message === 'string'
              ? clar.message
              : 'Fikrini daha iyi anlayabilmem için birkaç sorum var:',
          questions: Array.isArray(clar.questions) ? clar.questions : [],
          timestamp: now,
        });
        break;
      }
      case 'spec_draft': {
        const draft = (msg.content ?? {}) as unknown as Record<string, unknown>;
        if (draft.spec) {
          messages.push({
            type: 'agent',
            agent: 'scribe',
            content: 'Plan hazır. Lütfen inceleyin ve onaylayın.',
            timestamp: now,
          });
        }
        break;
      }
      case 'spec_approved':
        messages.push({ type: 'info', content: 'Plan onaylandı.', timestamp: now });
        break;
      case 'spec_rejected':
        messages.push({ type: 'info', content: 'Plan reddedildi.', timestamp: now });
        break;
    }
  }

  // Critic spec review result
  const criticSpec = pipeline.intermediateState?.criticSpecOutput as CriticReviewOutput | undefined;
  if (criticSpec) {
    messages.push({
      type: 'critic_review',
      reviewType: 'spec_review',
      approved: criticSpec.approved,
      score: criticSpec.overallScore,
      findings: criticSpec.findings ?? [],
      summary: criticSpec.summary ?? '',
      timestamp: now,
    });
  }

  // Proto result — surface the "scaffold pushed" card whenever Proto
  // succeeded, UNLESS this is the PDP-3 B4 dry-run cache from
  // `awaiting_push_confirm` (where `committed` is *explicitly* false and
  // `branch` is the placeholder `'dry-run'`). Legacy pipelines leave
  // `committed` undefined; they should keep showing the card.
  const dryRunCache = pipeline.protoOutput?.metadata?.committed === false;
  if (pipeline.protoOutput?.ok && !dryRunCache) {
    const po = pipeline.protoOutput;
    messages.push({
      type: 'pr_opened',
      url: po.prUrl ?? po.repoUrl ?? '',
      number: 0,
      title: `Scaffold: ${pipeline.title ?? ''}`,
      branch: po.branch,
      filesChanged: po.files?.length ?? 0,
      linesChanged: po.metadata?.totalLinesOfCode ?? 0,
      timestamp: now,
    });
  }

  // Critic code review result
  const criticCode = pipeline.intermediateState?.criticCodeOutput as CriticReviewOutput | undefined;
  if (criticCode) {
    messages.push({
      type: 'critic_review',
      reviewType: 'code_review',
      approved: criticCode.approved,
      score: criticCode.overallScore,
      findings: criticCode.findings ?? [],
      summary: criticCode.summary ?? '',
      timestamp: now,
    });
  }

  // Trace result
  if (pipeline.traceOutput) {
    const to = pipeline.traceOutput;
    messages.push({
      type: 'test_result',
      passed: to.testSummary?.totalTests ?? 0,
      failed: 0,
      total: to.testSummary?.totalTests ?? 0,
      coverage: to.testSummary?.coveragePercentage?.toString() ?? '0',
      testFiles: to.testFiles?.map((f) => ({ filePath: f.filePath, testCount: f.testCount })),
      coverageMatrix: to.coverageMatrix,
      coveredCriteria: to.testSummary?.coveredCriteria,
      uncoveredCriteria: to.testSummary?.uncoveredCriteria,
      timestamp: now,
    });
  }

  // Pipeline completion card
  if (pipeline.stage === 'completed' || pipeline.stage === 'completed_partial') {
    const po = pipeline.protoOutput;
    const to = pipeline.traceOutput;
    const repoUrl = po?.repoUrl ?? '';
    const repoName = po?.repo?.split('/')?.[1] ?? '';
    messages.push({
      type: 'pipeline_complete',
      status: pipeline.stage,
      repoUrl,
      branch: po?.branch ?? 'main',
      fileCount: po?.files?.length ?? 0,
      lineCount: po?.metadata?.totalLinesOfCode ?? 0,
      testCount: to?.testSummary?.totalTests,
      coverage: to?.testSummary?.coveragePercentage?.toString(),
      cloneCommand: repoUrl
        ? `git clone ${repoUrl}.git && cd ${repoName} && npm install && npm run dev`
        : '',
      setupCommands: po?.setupCommands,
      timestamp: now,
    });
  }

  // Error
  if (pipeline.error) {
    messages.push({
      type: 'error',
      agent: pipeline.stage?.split('_')[0] ?? 'pipeline',
      message: pipeline.error.message,
      retryable: pipeline.error.retryable ?? false,
      code: pipeline.error.code,
      recoveryAction: pipeline.error.recoveryAction,
      retryCount: pipeline.metrics?.retryCount ?? 0,
      maxRetries: 3,
      timestamp: now,
    });
  }

  return messages;
}

/**
 * Returns the running agent name for the current stage.
 */
export function getRunningAgentName(state: ConversationUIState): string | null {
  switch (state) {
    case 'scribe_running':
    case 'scribe_revise':
      return 'Scribe';
    case 'critic_running':
      // T5: display-only rename
      return 'Değerlendirme';
    case 'proto_running':
      return 'Proto';
    case 'trace_running':
      return 'Trace';
    case 'ci_running':
      return 'CI';
    default:
      return null;
  }
}
