import { useState, useCallback, useMemo, useRef } from 'react';
import type { ConversationUIState } from '../types/chat';
import type { PipelineStage } from '../types/pipeline';
import { mapStageToUIState, getRunningAgentName } from '../utils/mapPipelineEvent';

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
  const [uiState, setUIState] = useState<ConversationUIState>(
    initialStage ? mapStageToUIState(initialStage) : 'idle'
  );

  // Track the raw pipeline stage so we can distinguish terminal-idle from empty-idle
  const currentStageRef = useRef<PipelineStage | undefined>(initialStage);

  const syncFromStage = useCallback((stage: PipelineStage) => {
    currentStageRef.current = stage;
    setUIState(mapStageToUIState(stage));
  }, []);

  // Chat input is ALWAYS enabled — users can send messages in any pipeline state
  const isInputEnabled = true;
  const showCancelButton = RUNNING_STATES.includes(uiState);
  const runningAgentName = getRunningAgentName(uiState);

  const inputPlaceholder = useMemo(() => {
    if (uiState === 'scribe_clarifying') return 'Soruları yanıtlayın...';
    if (uiState === 'awaiting_approval') return 'Planı düzenlemek için yazın veya onaylayın...';
    if (uiState === 'scribe_running' || uiState === 'scribe_revise')
      return 'Scribe çalışıyor... Mesaj bırakabilirsiniz.';
    if (uiState === 'critic_running') return 'Critic inceliyor... Mesaj bırakabilirsiniz.';
    if (uiState === 'proto_running') return 'Proto scaffold oluşturuyor... Mesaj bırakabilirsiniz.';
    if (uiState === 'trace_running') return 'Trace test yazıyor... Mesaj bırakabilirsiniz.';
    if (uiState === 'ci_running') return 'CI çalışıyor... Mesaj bırakabilirsiniz.';
    // Terminal states
    if (uiState === 'idle' && currentStageRef.current) {
      if (currentStageRef.current === 'completed')
        return 'Projeniz hazır! Değişiklik isteği yazarak yeni iterasyon başlatın.';
      if (currentStageRef.current === 'completed_partial')
        return 'Pipeline kısmen tamamlandı. Değişiklik isteği yazabilirsiniz.';
      if (currentStageRef.current === 'failed')
        return 'Pipeline başarısız oldu. Yeniden deneyebilir veya sorununuzu yazabilirsiniz.';
    }
    return 'Projenizi anlatın...';
  }, [uiState]);

  return {
    uiState,
    isInputEnabled,
    showCancelButton,
    runningAgentName,
    inputPlaceholder,
    syncFromStage,
  };
}
