import { useState, useCallback, useMemo } from 'react';
import type { ConversationUIState } from '../types/chat';
import type { PipelineStage } from '../types/pipeline';
import { mapStageToUIState, getRunningAgentName } from '../utils/mapPipelineEvent';
import { useI18n } from '../i18n/useI18n';

interface ConversationStateReturn {
  uiState: ConversationUIState;
  isInputEnabled: boolean;
  showCancelButton: boolean;
  runningAgentName: string | null;
  inputPlaceholder: string;
  syncFromStage: (stage: PipelineStage) => void;
}

const RUNNING_STATES: ConversationUIState[] = [
  'scribe_running',
  'scribe_revise',
  'critic_running',
  'proto_running',
  'trace_running',
  'ci_running',
];

export function useConversationState(initialStage?: PipelineStage): ConversationStateReturn {
  const { t } = useI18n();
  const [uiState, setUIState] = useState<ConversationUIState>(
    initialStage ? mapStageToUIState(initialStage) : 'idle'
  );

  // Track the raw pipeline stage so we can distinguish terminal-idle (failed/
  // completed/cancelled — should show stage-specific placeholder) from
  // empty-idle (no pipeline yet — default placeholder).
  //
  // B4 (2026-05-23): turned this from `useRef` → `useState` so the
  // `inputPlaceholder` useMemo dependency triggers re-render when only the
  // stage changes (uiState stays 'idle' for all terminal stages, so without
  // a state change the placeholder would stick on the initial-mount value).
  // User-reported: direct URL → failed pipeline → placeholder stuck as
  // "Projenizi anlatın..." instead of "Pipeline başarısız oldu...".
  const [currentStage, setCurrentStage] = useState<PipelineStage | undefined>(initialStage);

  const syncFromStage = useCallback((stage: PipelineStage) => {
    setCurrentStage(stage);
    setUIState(mapStageToUIState(stage));
  }, []);

  // Chat input is ALWAYS enabled — users can send messages in any pipeline state
  const isInputEnabled = true;
  const showCancelButton = RUNNING_STATES.includes(uiState);
  const runningAgentName = getRunningAgentName(uiState);

  const inputPlaceholder = useMemo(() => {
    if (uiState === 'scribe_clarifying') return t('chat.placeholder.scribeClarifying');
    if (uiState === 'awaiting_approval') return t('chat.placeholder.awaitingApproval');
    if (uiState === 'awaiting_push_confirm')
      // PDP-3 T3 (preview-unify): the right Preview Panel hosts the
      // confirm/cancel buttons; the chat is the primary surface for
      // free-form corrections (FEEDBACK intent → iterateWithFeedback).
      return t('chat.placeholder.awaitingPushConfirm');
    if (uiState === 'awaiting_critic_resolution')
      // P8 + PR-A Fix 2: critic flagged bulgu(s) — chat-driven fix or the
      // right-pane override button are the two ways forward.
      return t('chat.placeholder.awaitingCriticResolution');
    if (uiState === 'scribe_running' || uiState === 'scribe_revise')
      return t('chat.placeholder.scribeRunning');
    // T5: display-only rename — Critic → Evaluator
    if (uiState === 'critic_running') return t('chat.placeholder.criticRunning');
    if (uiState === 'proto_running') return t('chat.placeholder.protoRunning');
    if (uiState === 'trace_running') return t('chat.placeholder.traceRunning');
    if (uiState === 'ci_running') return t('chat.placeholder.ciRunning');
    // Terminal states
    if (uiState === 'idle' && currentStage) {
      if (currentStage === 'completed') return t('chat.placeholder.completed');
      if (currentStage === 'completed_partial') return t('chat.placeholder.completedPartial');
      if (currentStage === 'failed') return t('chat.placeholder.failed');
    }
    return t('chat.input.placeholder');
  }, [uiState, currentStage, t]);

  return {
    uiState,
    isInputEnabled,
    showCancelButton,
    runningAgentName,
    inputPlaceholder,
    syncFromStage,
  };
}
