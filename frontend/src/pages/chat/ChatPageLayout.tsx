/**
 * ChatPageLayout — the JSX shell extracted from ChatPage.tsx as part of F-06.
 * Owns no state of its own: every interactive piece comes in via props from
 * ChatPage, which orchestrates the data hooks. This separation keeps the
 * orchestration (state, callbacks) and the layout (DOM structure) testable
 * independently. The F-06 finding describes this as `<ChatPageShell>`.
 */
import { Suspense, lazy } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';

import { ChatPanel } from '../../components/chat/ChatPanel';
import { ChatRouter } from '../../components/chat/ChatRouter';
import { ChatSkeleton } from '../../components/chat/ChatSkeleton';
import { ConversationSidebar } from '../../components/chat/ConversationSidebar';
import { EmptyStateCard } from '../../components/chat/EmptyStateCard';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { GithubConnectGate } from '../../components/onboarding/GithubConnectGate';
import type { ChatAttachment } from '../../components/chat/ChatInput';
import { useAutoOpenPreview } from '../../hooks/useAutoOpenPreview';
import type {
  ChatMessage,
  ChatMode,
  ConversationListItem,
  ConversationUIState,
} from '../../types/chat';
import type { Workflow } from '../../types/workflow';
import type { PipelineError } from '../../types/pipeline';
import type { PipelineActivity } from '../../hooks/usePipelineStream';
import { cn } from '../../utils/cn';

const PreviewPanel = lazy(() =>
  import('../../components/workflow/PreviewPanel').then((m) => ({ default: m.PreviewPanel }))
);

export interface ChatPageLayoutProps {
  // ── identity / branding ─────────────────────────
  akisLogoUrl: string;

  // ── responsive sidebar / mobile ─────────────────
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  onToggleCollapse: () => void;

  // ── conversation list (sidebar data) ────────────
  sidebarConversations: ConversationListItem[];
  conversationId: string | undefined;
  pendingConv: { displayName: string } | null;
  onNewConversation: () => void;
  onRename: (id: string, newTitle: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;

  // ── github JIT gate ─────────────────────────────
  pendingGithubIdea: string | null;
  onCancelGithubGate: () => void;

  // ── chat panel data ─────────────────────────────
  activeWorkflow: Workflow | null;
  messages: ChatMessage[];
  uiState: ConversationUIState;
  isInputEnabled: boolean;
  showCancelButton: boolean;
  inputPlaceholder: string;
  creating: boolean;
  chatMode: ChatMode;
  recentTextMessages: string[];
  currentStep: PipelineActivity | null;
  pipelineActivities: PipelineActivity[];
  createdFiles: string[];
  protoFiles: Record<string, string> | null;
  pipelineHasOutputs: boolean;
  pipelineError: PipelineError | undefined;
  isRetrying: boolean;

  // ── preview pane (Sandpack) ─────────────────────
  showPreview: boolean;
  previewWidth: number;
  onTogglePreview: () => void;
  setShowPreview: (open: boolean) => void;
  splitContainerRef: RefObject<HTMLDivElement | null>;
  handleDragStart: (e: ReactMouseEvent) => void;

  // ── chat panel actions ──────────────────────────
  onSend: (content: string, attachments?: ChatAttachment[]) => Promise<void> | void;
  onAsk: (content: string) => Promise<void> | void;
  onFeedback: (content: string) => void;
  onChat: (content: string) => void;
  onCancel: () => Promise<void> | void;
  onApprove: () => Promise<void> | void;
  onReject: () => Promise<void> | void;
  onRetry: () => Promise<void> | void;
  onSkip: () => Promise<void> | void;
  onBack: () => void;
  onSuggestBuild: (sourceMessage: string) => void;
  /**
   * PDP-3 B4: called after the user resolves the push-confirm gate so the
   * workflow can refetch and reflect the new stage (proto_building → trace
   * → completed, or completed_partial on cancel).
   */
  onPushResolved?: () => Promise<unknown> | unknown;

  // ── trace toggle + model picker ─────────────────
  traceEnabled: boolean;
  setTraceEnabled: (enabled: boolean) => void;
  pendingModel: string;
  setPendingModel: (model: string) => void;
  onModelChange: (modelId: string) => Promise<void> | void;
  repoSelectorSlot: ReactNode | undefined;

  // ── B3 onboarding empty state ───────────────────
  /**
   * Fire a brand-new pipeline from a pre-filled idea. Skips the composer
   * and goes straight to `useHandleSend`'s new-conversation branch.
   */
  onDemoSelect: (idea: string) => void;
}

export function ChatPageLayout(props: ChatPageLayoutProps) {
  const {
    akisLogoUrl,
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    onToggleCollapse,
    sidebarConversations,
    conversationId,
    pendingConv,
    onNewConversation,
    onRename,
    onDelete,
    pendingGithubIdea,
    onCancelGithubGate,
    activeWorkflow,
    messages,
    uiState,
    isInputEnabled,
    showCancelButton,
    inputPlaceholder,
    creating,
    chatMode,
    recentTextMessages,
    currentStep,
    pipelineActivities,
    createdFiles,
    protoFiles,
    pipelineHasOutputs,
    pipelineError,
    isRetrying,
    showPreview,
    previewWidth,
    onTogglePreview,
    setShowPreview,
    splitContainerRef,
    handleDragStart,
    onSend,
    onAsk,
    onFeedback,
    onChat,
    onCancel,
    onApprove,
    onReject,
    onRetry,
    onSkip,
    onBack,
    onSuggestBuild,
    onPushResolved,
    traceEnabled,
    setTraceEnabled,
    pendingModel,
    setPendingModel,
    onModelChange,
    repoSelectorSlot,
    onDemoSelect,
  } = props;

  // T3 (preview-unify): auto-open the right Preview Panel when the
  // pipeline transitions into `awaiting_push_confirm`. Extracted to a
  // hook so the effect is testable in isolation.
  useAutoOpenPreview(uiState, showPreview, setShowPreview);

  return (
    <div className="flex h-dvh overflow-hidden bg-ak-bg" role="application" aria-label="AKIS Chat">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar:
          Mobile (<768): hidden, slide-in overlay via hamburger
          Tablet (768-1023): collapsed 64px, relative in flow
          Desktop (≥1024): full 280px, relative in flow */}
      <div
        className={cn(
          'flex-shrink-0 transition-transform duration-200 ease-out',
          'fixed inset-y-0 left-0 z-40',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          'md:sticky md:top-0 md:z-auto md:translate-x-0 md:h-dvh'
        )}
      >
        <ConversationSidebar
          conversations={sidebarConversations}
          activeId={conversationId ?? (pendingConv ? 'pending' : undefined)}
          onNewConversation={onNewConversation}
          onRename={onRename}
          onDelete={onDelete}
          collapsed={sidebarCollapsed}
          onToggleCollapse={onToggleCollapse}
        />
      </div>

      {/* Mobile top bar — only visible below md */}
      <div className="fixed left-0 right-0 top-0 z-20 flex items-center gap-3 border-b border-ak-border bg-ak-surface px-4 py-3 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Menü"
          className="rounded-lg p-1.5 text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
            />
          </svg>
        </button>
        <img src={akisLogoUrl} alt="AKIS" className="h-7 w-7 object-contain" />
        <span className="text-[15px] font-extrabold tracking-tight text-ak-primary">AKIS</span>
      </div>

      {/* GitHub JIT gate — surfaces when user submits an idea without GitHub.
          Lives outside the chat flow so it can preserve the idea across the
          OAuth redirect and auto-resume the send on return. */}
      {pendingGithubIdea && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-ak-bg/80 px-4 py-8 backdrop-blur-sm">
          <GithubConnectGate pendingIdea={pendingGithubIdea} onCancel={onCancelGithubGate} />
        </div>
      )}

      {/* Main content — top padding only on mobile for the top bar */}
      <div className={cn('flex min-w-0 flex-1 flex-col min-h-0', 'pt-[52px] md:pt-0')}>
        {conversationId || pendingConv ? (
          <div ref={splitContainerRef} className="flex min-w-0 flex-1 min-h-0">
            <div
              className="min-w-0 flex-1 flex flex-col min-h-0"
              style={
                showPreview
                  ? { flexBasis: `${100 - previewWidth}%`, flexGrow: 0, flexShrink: 0 }
                  : undefined
              }
            >
              <ErrorBoundary>
                <ChatRouter
                  pipelineId={conversationId}
                  pipelineUiState={uiState}
                  recentMessages={recentTextMessages}
                  onBuild={onSend}
                  onAsk={onAsk}
                  onFeedback={onFeedback}
                  onChat={onChat}
                >
                  {({ send: routedSend, busy: intentBusy }) => (
                    <ChatPanel
                      conversationId={conversationId ?? 'pending'}
                      repoShortName={activeWorkflow?.title ?? pendingConv?.displayName ?? ''}
                      repoFullName={activeWorkflow?.stages?.proto?.repo ?? ''}
                      repoUrl={activeWorkflow?.stages?.proto?.repoUrl}
                      branch={activeWorkflow?.stages?.proto?.branch}
                      mode={chatMode}
                      hasPreview={!!protoFiles}
                      showPreview={showPreview}
                      onTogglePreview={onTogglePreview}
                      messages={messages}
                      uiState={uiState}
                      isInputEnabled={pendingConv ? !creating : creating ? false : isInputEnabled}
                      isSending={creating || intentBusy}
                      showCancelButton={showCancelButton}
                      inputPlaceholder={pendingConv ? 'Projenizi anlatın...' : inputPlaceholder}
                      onSend={routedSend}
                      onCancel={onCancel}
                      onApprove={onApprove}
                      onReject={onReject}
                      onRetry={onRetry}
                      onSkip={onSkip}
                      onSuggestBuild={onSuggestBuild}
                      onBack={onBack}
                      showBackButton
                      currentStep={currentStep}
                      activities={pipelineActivities}
                      createdFiles={createdFiles}
                      traceEnabled={traceEnabled}
                      onTraceToggle={pendingConv ? setTraceEnabled : undefined}
                      repoSelectorSlot={repoSelectorSlot}
                      tokenUsage={activeWorkflow?.tokenUsage}
                      model={pendingConv ? pendingModel : activeWorkflow?.model}
                      onModelChange={pendingConv ? setPendingModel : onModelChange}
                      modelLocked={pendingConv ? false : Boolean(activeWorkflow?.modelLockedAt)}
                      pipelineError={pipelineError}
                      isRetrying={isRetrying}
                      pipelineHasOutputs={pipelineHasOutputs}
                      protoFiles={protoFiles}
                      onPushResolved={onPushResolved}
                      criticReview={activeWorkflow?.criticReview}
                      onCriticResolved={
                        onPushResolved
                          ? () => {
                              void onPushResolved();
                            }
                          : undefined
                      }
                    />
                  )}
                </ChatRouter>
              </ErrorBoundary>
            </div>

            {showPreview && (
              <>
                <div
                  onMouseDown={handleDragStart}
                  className="group hidden w-1 flex-shrink-0 cursor-col-resize bg-ak-border transition-colors hover:bg-ak-primary/50 active:bg-ak-primary lg:block"
                  title="Sürükleyerek boyutlandır"
                >
                  <div className="flex h-full items-center justify-center">
                    <div className="h-8 w-0.5 rounded-full bg-ak-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </div>

                <div
                  className="fixed inset-0 z-50 bg-black/50 lg:hidden"
                  onClick={() => setShowPreview(false)}
                />
                <div
                  className={cn(
                    'fixed inset-0 z-50 overflow-hidden lg:relative lg:inset-auto lg:z-auto'
                  )}
                  style={{ flexBasis: `${previewWidth}%`, flexGrow: 0, flexShrink: 0 }}
                >
                  <button
                    onClick={() => setShowPreview(false)}
                    className="absolute right-3 top-3 z-10 rounded-lg bg-ak-surface-2 p-1.5 text-ak-text-secondary hover:text-ak-text-primary lg:hidden"
                    aria-label="Önizlemeyi kapat"
                  >
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                  <ErrorBoundary fallbackPath="/chat" fallbackLabel="Chat">
                    <Suspense fallback={<ChatSkeleton />}>
                      <PreviewPanel
                        files={protoFiles}
                        branch={activeWorkflow?.stages?.proto?.branch}
                        activities={pipelineActivities}
                        createdFiles={createdFiles}
                        pushGateProps={
                          uiState === 'awaiting_push_confirm' && conversationId
                            ? {
                                pipelineId: conversationId,
                                onResolved: onPushResolved
                                  ? () => {
                                      void onPushResolved();
                                    }
                                  : undefined,
                              }
                            : undefined
                        }
                      />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              </>
            )}
          </div>
        ) : (
          // B3 onboarding card — always shown when there's no active
          // conversation, regardless of whether the user has prior chats.
          // (Earlier condition gated on conversations.length === 0, which
          // hid the demo templates from returning users.)
          <EmptyStateCard onDemoSelect={onDemoSelect} onManualStart={onNewConversation} />
        )}
      </div>
    </div>
  );
}
