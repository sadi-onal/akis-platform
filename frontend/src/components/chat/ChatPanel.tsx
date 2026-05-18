import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { cn } from '../../utils/cn';
import type { ChatMessage as ChatMessageType, ConversationUIState } from '../../types/chat';
import { PipelineDetailRail } from '../pipeline/PipelineDetailRail';
import type { PipelineActivity } from '../../hooks/usePipelineStream';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ChatHeader } from './ChatHeader';
import { ModelPicker } from './ModelPicker';
import { EmptyState } from './EmptyState';
import { ChatSkeleton } from './ChatSkeleton';
import { ClarificationCard } from './ClarificationCard';
import { TraceProgressStepper } from './TraceProgressStepper';
import { PipelineErrorBanner } from './PipelineErrorBanner';
import type { PipelineError } from '../../types/pipeline';

function getAgentInfo(uiState: ConversationUIState) {
  if (uiState.includes('scribe')) return { label: 'Scribe', color: 'var(--ak-scribe, #3b82f6)' };
  if (uiState === 'critic_running') return { label: 'Critic', color: 'var(--ak-critic, #f43f5e)' };
  if (uiState === 'proto_running') return { label: 'Proto', color: 'var(--ak-proto, #f59e0b)' };
  if (uiState === 'trace_running') return { label: 'Trace', color: 'var(--ak-trace, #8b5cf6)' };
  if (uiState === 'ci_running') return { label: 'CI', color: 'var(--color-yellow-400, #facc15)' };
  return { label: 'Agent', color: 'var(--ak-primary, #07D1AF)' };
}

interface ChatPanelProps {
  conversationId?: string;
  repoShortName: string;
  repoFullName: string;
  repoUrl?: string;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  mode?: import('../../types/chat').ChatMode;
  hasPreview?: boolean;
  showPreview?: boolean;
  onTogglePreview?: () => void;
  messages: ChatMessageType[];
  uiState: ConversationUIState;
  isInputEnabled: boolean;
  isSending?: boolean;
  showCancelButton: boolean;
  inputPlaceholder: string;
  onSend: (message: string, attachments?: import('./ChatInput').ChatAttachment[]) => void;
  onCancel: () => void;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
  onSkip: () => void;
  /** F-09: invoked when user clicks the "[BUILD]" CTA on a chat_qa_response. */
  onSuggestBuild?: (sourceMessage: string) => void;
  onBack?: () => void;
  showBackButton?: boolean;
  currentStep?: PipelineActivity | null;
  activities?: PipelineActivity[];
  createdFiles?: string[];
  traceEnabled?: boolean;
  onTraceToggle?: (enabled: boolean) => void;
  repoSelectorSlot?: React.ReactNode;
  tokenUsage?: import('../../types/workflow').WorkflowTokenUsage;
  model?: string;
  onModelChange?: (modelId: string) => void | Promise<void>;
  modelProviderHint?: 'anthropic' | 'openai';
  modelLocked?: boolean;
  /** Pipeline error — present when stage === 'failed'. Renders error banner + disables input. */
  pipelineError?: PipelineError;
  /** #490 BUG-N: retry POST is in flight; banner swaps to a disabled loader. */
  isRetrying?: boolean;
  /**
   * F-04: when true, keeps `PipelineDetailRail` mounted even at idle with
   * an empty activity buffer (e.g. after backend restart drops the
   * in-memory stream). Parent derives this from the workflow's
   * proto/trace output presence.
   */
  pipelineHasOutputs?: boolean;
  /**
   * PDP-3 B4: cached scaffold files forwarded to the rail's PushConfirmGate
   * inline preview when the pipeline halts at `awaiting_push_confirm`.
   */
  protoFiles?: Record<string, string> | null;
  /**
   * PDP-3 B4: called after the user resolves the push gate so the parent
   * can refetch / refresh workflow state.
   */
  onPushResolved?: () => void;
}

export const ChatPanel = memo(function ChatPanel({
  conversationId,
  repoShortName,
  repoFullName,
  repoUrl,
  branch,
  prUrl,
  prNumber,
  mode,
  hasPreview,
  showPreview,
  onTogglePreview,
  messages,
  uiState,
  isInputEnabled,
  isSending,
  showCancelButton,
  inputPlaceholder,
  onSend,
  onCancel,
  onApprove,
  onReject,
  onRetry,
  onSkip,
  onSuggestBuild,
  onBack,
  showBackButton,
  currentStep,
  activities,
  createdFiles,
  traceEnabled,
  onTraceToggle,
  repoSelectorSlot,
  tokenUsage,
  model,
  onModelChange,
  modelProviderHint,
  modelLocked,
  pipelineError,
  isRetrying = false,
  pipelineHasOutputs = false,
  protoFiles,
  onPushResolved,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const [showScrollDown, setShowScrollDown] = useState(false);

  // Auto-scroll only when user is at bottom or sent a new message
  useEffect(() => {
    const newCount = messages.length;
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = newCount;

    if (newCount <= prevCount) return;

    // Check if the newest message is from the user (they just sent it)
    const lastMsg = messages[newCount - 1];
    const isUserMessage = lastMsg?.type === 'user';

    if (isAtBottomRef.current || isUserMessage) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, messages]);

  // Track scroll position and show "new messages" button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      isAtBottomRef.current = atBottom;
      setShowScrollDown(!atBottom && messages.length > 0);
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [messages.length]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Pending clarification: render above input when the latest message is an unanswered question set
  const pendingClarification = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'user') return null;
      if (msg.type === 'clarification') return msg;
    }
    return null;
  })();

  const handleClarificationSubmit = useCallback(
    (combined: string) => {
      onSend(combined);
    },
    [onSend]
  );

  const isPending = conversationId === 'pending';
  const isEmpty = !conversationId || (isPending && messages.length === 0);
  const isInitialLoad = !!conversationId && !isPending && messages.length === 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col min-h-0">
      {/* Header */}
      {conversationId && (
        <ChatHeader
          repoShortName={repoShortName || 'Yeni Sohbet'}
          repoFullName={repoFullName || ''}
          repoUrl={repoUrl}
          branch={branch}
          prUrl={prUrl}
          prNumber={prNumber}
          mode={mode}
          isFailed={!!pipelineError}
          hasPreview={hasPreview}
          showPreview={showPreview}
          onTogglePreview={onTogglePreview}
          onBack={onBack}
          showBackButton={showBackButton}
          tokenUsage={tokenUsage}
        />
      )}

      {/* Error banner — rendered immediately below header when pipeline has failed */}
      {pipelineError && (
        <PipelineErrorBanner
          error={pipelineError}
          onRetry={onRetry}
          onSkipTrace={onSkip}
          isRetrying={isRetrying}
        />
      )}

      {/* Level-4 pipeline detail rail — opt-in cinema + explanation surface */}
      {conversationId && conversationId !== 'pending' && (
        <PipelineDetailRail
          pipelineId={conversationId}
          uiState={uiState}
          activities={activities ?? []}
          currentStep={currentStep ?? null}
          pipelineHasOutputs={pipelineHasOutputs}
          protoFiles={protoFiles}
          onPushResolved={onPushResolved}
          showPreview={showPreview}
          onTogglePreview={onTogglePreview}
        />
      )}

      {/* Stage glow — shows colored gradient when an agent is running */}
      {(uiState === 'scribe_running' ||
        uiState === 'scribe_revise' ||
        uiState === 'critic_running' ||
        uiState === 'proto_running' ||
        uiState === 'trace_running') && (
        <div
          className="h-[2px] w-full animate-glow-pulse flex-shrink-0"
          style={{
            background: uiState.includes('scribe')
              ? 'linear-gradient(90deg, transparent, #38bdf8, transparent)'
              : uiState === 'critic_running'
                ? 'linear-gradient(90deg, transparent, #f43f5e, transparent)'
                : uiState === 'proto_running'
                  ? 'linear-gradient(90deg, transparent, #f59e0b, transparent)'
                  : 'linear-gradient(90deg, transparent, #a78bfa, transparent)',
          }}
        />
      )}

      {/* P9: early hint — when Proto is running and Trace is enabled, tell
          the user upfront that the verification step will follow. Otherwise
          the Trace stage feels like it "appeared from nowhere" and the
          alternative ("Trace hiç çalışmadı") signal is harder to spot. */}
      {conversationId &&
        traceEnabled === true &&
        (uiState === 'proto_running' || uiState === 'awaiting_approval') && (
          <div
            data-testid="trace-pending-hint"
            className="mx-auto w-full max-w-3xl px-4 sm:px-6"
          >
            <div className="mt-2 flex items-center gap-2 rounded-md border border-ak-trace/30 bg-ak-trace/5 px-3 py-1.5 text-xs text-ak-text-secondary">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: 'var(--ak-trace, #8b5cf6)' }}
              />
              <span>
                Bu pipeline&apos;da Trace çalışacak — Proto kodu üretildikten sonra Playwright testleri otomatik yazılır.
              </span>
            </div>
          </div>
        )}

      {/* Messages */}
      {isEmpty ? (
        <EmptyState variant={conversationId ? 'new-conversation' : 'no-conversation'} />
      ) : isInitialLoad ? (
        <div className="flex-1 overflow-y-auto">
          <ChatSkeleton />
        </div>
      ) : (
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto min-h-0">
          {/* Spacer pushes the conversation toward the composer when there
              are only a few messages — fills the otherwise-empty bottom
              gap that made the chat feel "floating in the middle". */}
          <div aria-hidden="true" className="min-h-[40%]" />
          <div className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6">
            {messages.map((msg, i) => (
              <div
                key={`${msg.type}-${msg.timestamp ?? ''}-${i}`}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}
              >
                <ChatMessage
                  message={msg}
                  onApprove={onApprove}
                  onReject={onReject}
                  onRetry={onRetry}
                  onSkip={onSkip}
                  onSuggestBuild={onSuggestBuild}
                />
              </div>
            ))}

            {/* Activity indicator for running agents */}
            {(uiState === 'scribe_running' ||
              uiState === 'scribe_revise' ||
              uiState === 'critic_running' ||
              uiState === 'proto_running' ||
              uiState === 'trace_running' ||
              uiState === 'ci_running') &&
              (() => {
                const { label: agentLabel, color: agentColor } = getAgentInfo(uiState);
                const progress = currentStep?.progress;
                const retryCount = currentStep?.retryCount ?? 0;
                const completedSteps = activities
                  ?.filter((a) => a.step !== 'complete' && a.step !== 'error' && a !== currentStep)
                  .slice(-3);
                const showTraceStepper = uiState === 'trace_running';

                return (
                  <div key={uiState} className="flex gap-2.5 animate-in fade-in duration-200">
                    <div
                      className={cn(
                        'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border transition-colors duration-300',
                        uiState.includes('scribe')
                          ? 'border-ak-scribe/30 bg-ak-scribe/10'
                          : uiState === 'critic_running'
                            ? 'border-rose-500/30 bg-rose-500/10'
                            : uiState === 'proto_running'
                              ? 'border-ak-proto/30 bg-ak-proto/10'
                              : uiState === 'ci_running'
                                ? 'border-yellow-400/30 bg-yellow-400/10'
                                : 'border-ak-trace/30 bg-ak-trace/10'
                      )}
                    >
                      <span
                        className="h-2 w-2 rounded-full animate-pulse"
                        style={{ backgroundColor: agentColor }}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      {showTraceStepper && (activities?.length ?? 0) > 0 ? (
                        <TraceProgressStepper
                          activities={activities ?? []}
                          currentStep={currentStep ?? null}
                        />
                      ) : currentStep ? (
                        <>
                          <div className="text-sm leading-snug flex items-center gap-1.5 flex-wrap">
                            {/*
                             * Skip the agent label when the activity message
                             * already starts with that name (otherwise we end
                             * up with "Scribe Scribe analizi başarısız oldu").
                             */}
                            {!currentStep.message
                              ?.toLowerCase()
                              .startsWith(agentLabel.toLowerCase()) && (
                              <span className="font-semibold" style={{ color: agentColor }}>
                                {agentLabel}
                              </span>
                            )}
                            <span className="text-ak-text-primary">{currentStep.message}</span>
                            {retryCount > 0 && (
                              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] text-amber-400">
                                yeniden deneniyor ({retryCount}/3)
                              </span>
                            )}
                          </div>
                          {progress != null && progress > 0 && (
                            <div
                              className="mt-1.5 w-full h-1 rounded-full overflow-hidden"
                              style={{
                                backgroundColor: 'var(--ak-border, rgba(255,255,255,0.08))',
                              }}
                            >
                              <div
                                className="h-full rounded-full transition-all duration-500 ease-out"
                                style={{ width: `${progress}%`, backgroundColor: agentColor }}
                              />
                            </div>
                          )}
                          {completedSteps && completedSteps.length > 0 && (
                            <div className="mt-1 space-y-0.5">
                              {completedSteps.map((a, i) => (
                                <div key={i} className="text-xs text-ak-text-tertiary truncate">
                                  {'✓ '}
                                  {a.message}
                                </div>
                              ))}
                            </div>
                          )}
                          {createdFiles &&
                            createdFiles.length > 0 &&
                            currentStep?.stage === 'proto' && (
                              <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                                {createdFiles.slice(-5).map((f) => (
                                  <div
                                    key={f}
                                    className="flex items-center gap-2 text-xs text-ak-text-secondary animate-fade-in"
                                  >
                                    <span className="text-green-500">&#10003;</span>
                                    <span className="font-mono truncate">{f}</span>
                                  </div>
                                ))}
                                {createdFiles.length > 5 && (
                                  <span className="text-xs text-ak-text-tertiary">
                                    +{createdFiles.length - 5} daha...
                                  </span>
                                )}
                              </div>
                            )}
                        </>
                      ) : (
                        <div className="flex gap-0.5 pt-2">
                          <span className="h-1 w-1 animate-bounce rounded-full bg-ak-text-tertiary [animation-delay:0ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-ak-text-tertiary [animation-delay:150ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-ak-text-tertiary [animation-delay:300ms]" />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

            <div ref={bottomRef} />
          </div>

          {/* Scroll-to-bottom button */}
          {showScrollDown && (
            <button
              onClick={scrollToBottom}
              tabIndex={0}
              role="button"
              aria-label="En alta kaydır"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  scrollToBottom();
                }
              }}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-ak-border bg-ak-surface px-4 py-1.5 text-xs font-medium text-ak-text-secondary shadow-lg hover:text-ak-text-primary transition-colors animate-in fade-in slide-in-from-bottom-2 duration-200"
            >
              ↓ Yeni mesajlar
            </button>
          )}
        </div>
      )}

      {/* Clarification card (above input) */}
      {conversationId && pendingClarification && pendingClarification.questions.length > 0 && (
        <ClarificationCard
          questions={pendingClarification.questions}
          onSubmit={handleClarificationSubmit}
        />
      )}

      {/* Repo selector slot */}
      {repoSelectorSlot && <div className="px-4 py-2">{repoSelectorSlot}</div>}

      {/* Trace toggle + model picker — width aligned with ChatInput's max-w container */}
      {(onTraceToggle || onModelChange) && (
        <div className="mx-auto w-full max-w-4xl px-3 pt-1 sm:px-6 md:max-w-5xl xl:max-w-6xl">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {onTraceToggle && (
              <div
                className="flex items-center gap-2"
                data-testid="trace-toggle"
                title={
                  traceEnabled
                    ? 'Trace açık — Proto kodu üretildikten sonra Playwright testleri otomatik yazılacak'
                    : 'Trace kapalı — sadece kod üretilecek, test yazılmayacak'
                }
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={traceEnabled}
                  aria-label={
                    traceEnabled
                      ? 'Trace açık — testler üretilecek'
                      : 'Trace kapalı — sadece kod üretilecek'
                  }
                  onClick={() => onTraceToggle(!traceEnabled)}
                  className={cn(
                    'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ak-primary focus-visible:ring-offset-2',
                    traceEnabled ? 'bg-ak-primary' : 'bg-ak-border'
                  )}
                >
                  <span
                    className={cn(
                      'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out',
                      traceEnabled ? 'translate-x-4' : 'translate-x-0'
                    )}
                  />
                </button>
                <div className="flex flex-col">
                  <span
                    className={cn(
                      'text-xs font-medium transition-colors',
                      traceEnabled ? 'text-ak-primary' : 'text-ak-text-tertiary'
                    )}
                    data-testid="trace-toggle-label"
                  >
                    {traceEnabled
                      ? 'Trace açık — testler üretilecek'
                      : 'Trace kapalı — sadece kod'}
                  </span>
                  <span className="text-[10px] text-ak-text-tertiary">
                    {traceEnabled
                      ? 'Kod sonrası Playwright testleri otomatik yazılır'
                      : 'Trace agent çalışmayacak'}
                  </span>
                </div>
              </div>
            )}
            {onTraceToggle && onModelChange && (
              <span aria-hidden="true" className="hidden h-6 w-px bg-ak-border-subtle sm:block" />
            )}
            {onModelChange && (
              <ModelPicker
                value={model}
                onSelect={onModelChange}
                providerHint={modelProviderHint}
                locked={modelLocked}
              />
            )}
          </div>
        </div>
      )}

      {/* Input */}
      {conversationId && (
        <ChatInput
          onSend={onSend}
          onCancel={onCancel}
          disabled={!isInputEnabled}
          isSending={isSending}
          showCancel={showCancelButton}
          placeholder={inputPlaceholder}
        />
      )}
    </div>
  );
});
