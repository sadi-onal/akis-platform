/**
 * ChatPage — orchestrator. Body split across ./hooks/* + ChatPageLayout +
 * chatPageHelpers as part of F-06. Phase 2 finished extracting the trace
 * toggle, model picker, split-pane preview, and proto-files data hook;
 * remaining inline state is route-level (sidebar, conversation list,
 * pipeline-control callbacks).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import { useConversationState } from '../../hooks/useConversationState';
import { usePipelineStream } from '../../hooks/usePipelineStream';
import { useProfileCompleteness } from '../../hooks/useProfileCompleteness';
import { toast } from '../../components/ui/Toast';
import { mapStageToMode } from '../../utils/mapPipelineEvent';
import type { ConversationListItem, ChatMessage, ConversationStatus } from '../../types/chat';
import { hasPipelineOutputs } from '../../types/workflow';
import type { Workflow } from '../../types/workflow';
import { workflowsApi } from '../../services/api/workflows';
import type { SelectedRepo } from '../../components/chat/RepoSelector';
import { LOGO_MARK_SVG } from '../../theme/brand';

import { workflowToListItem } from './chatPageHelpers';
import { ChatPageLayout } from './ChatPageLayout';
import { useConversationLoader } from './hooks/useConversationLoader';
import { useIterationChildPoll } from './hooks/useIterationChildPoll';
import { useGithubOAuthRestore } from './hooks/useGithubOAuthRestore';
import { useChatPageKeyboard } from './hooks/useChatPageKeyboard';
import { useHandleSend } from './hooks/useHandleSend';
import { useChatQaAsk } from './hooks/useChatQaAsk';
import { useTraceToggle } from './hooks/useTraceToggle';
import { useModelPicker } from './hooks/useModelPicker';
import { useShowPreview } from './hooks/useShowPreview';
import { useProtoFiles } from './hooks/useProtoFiles';
import { usePipelineControls } from './hooks/usePipelineControls';
import { useHandleIntentFeedback } from './hooks/useHandleIntentFeedback';

/* ── component ────────────────────────────────────── */

export default function ChatPage() {
  const akisLogoUrl = LOGO_MARK_SVG;
  // Single splat route: /chat/* — extract id from the splat param
  const { '*': splatParam } = useParams();
  const conversationId = splatParam || undefined;
  const navigate = useNavigate();

  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    const w = window.innerWidth;
    return w >= 768 && w < 1024;
  });
  const [pendingConv, setPendingConv] = useState<{ displayName: string } | null>(null);
  const { traceEnabled, setTraceEnabled } = useTraceToggle();
  const [selectedRepo, setSelectedRepo] = useState<SelectedRepo | null>(null);
  const {
    showPreview,
    setShowPreview,
    previewWidth,
    splitContainerRef,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
  } = useShowPreview();
  const { hasGitHub, loading: profileLoading } = useProfileCompleteness();

  // Close mobile sidebar overlay when navigating to a conversation
  useEffect(() => {
    setSidebarOpen(false);
  }, [conversationId]);

  // Auto-collapse sidebar on tablet resize + re-sync on mount/navigation
  useEffect(() => {
    const syncCollapse = () => {
      const w = window.innerWidth;
      if (w >= 768 && w < 1024) setSidebarCollapsed(true);
      else if (w >= 1024) setSidebarCollapsed(false);
    };
    syncCollapse();
    window.addEventListener('resize', syncCollapse);
    return () => window.removeEventListener('resize', syncCollapse);
  }, []);

  // Sidebar item updater — wraps setConversations so the loader hook can push
  // refreshed workflow snapshots without owning the list state.
  const upsertSidebarConversation = useCallback((w: Workflow) => {
    const item = workflowToListItem(w);
    setConversations((prev) =>
      prev.some((c) => c.id === item.id) ? prev.map((c) => (c.id === item.id ? item : c)) : prev
    );
  }, []);

  const refreshList = useCallback(() => {
    workflowsApi
      .list()
      .then((workflows) => {
        setConversations(workflows.filter((w) => w.status !== 'cancelled').map(workflowToListItem));
      })
      .catch((e) => {
        if (import.meta.env.DEV) console.warn('Failed to load conversation list:', e);
      });
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  const { uiState, isInputEnabled, showCancelButton, inputPlaceholder, syncFromStage } =
    useConversationState(undefined);

  // ─── Conversation loader (F-06 hook 1) ───────────
  // Owns activeWorkflow, messages, and the F-01 message-key cache. We feed
  // back isConnected via local state so the hook can adjust the polling
  // cadence — isRunning is derived inside the hook from the workflow stage.
  const [isConnectedHint, setIsConnectedHint] = useState(false);
  const loader = useConversationLoader({
    conversationId,
    isConnected: isConnectedHint,
    syncFromStage,
    onWorkflowSnapshot: upsertSidebarConversation,
    navigate,
  });
  const {
    activeWorkflow,
    setActiveWorkflow,
    messages,
    setMessages,
    loadedIdRef,
    lastMessagesKeyRef,
    refreshWorkflow,
    isRunning,
  } = loader;

  const activeWorkflowRef = useRef(activeWorkflow);
  activeWorkflowRef.current = activeWorkflow;
  const pendingConvRef = useRef(pendingConv);
  pendingConvRef.current = pendingConv;

  // ─── Model picker (F-06 Phase 2 hook) ─────────────
  // Wired here because handleModelChange depends on `refreshWorkflow` from the
  // conversation loader. The pre-pipeline path uses `setPendingModel` directly
  // via the ChatPageLayout wiring (see `onModelChange={pendingConv ? setPendingModel : onModelChange}`).
  const { pendingModel, setPendingModel, handleModelChange } = useModelPicker({
    conversationId,
    activeWorkflow,
    refreshWorkflow,
  });

  const {
    activities: pipelineActivities,
    currentStep,
    createdFiles,
    isConnected,
  } = usePipelineStream(conversationId ?? '', isRunning);

  useEffect(() => {
    setIsConnectedHint(isConnected);
  }, [isConnected]);

  // PR-H bug-3 (2026-05-19): SSE-driven workflow refresh on stage transitions.
  //
  // Before this fix the SSE stream only fed the activity rail; workflow state
  // (currentStage, traceOutput, intermediate gate flags) was refreshed by the
  // 8-20s polling loop in `useConversationLoader`. So when a pipeline moved
  // proto_building → trace_testing → awaiting_push_confirm in <30s, the chat
  // sat on stale stage data and the user had to manually refresh.
  //
  // Strategy: watch `pipelineActivities` for two signals that demand an
  // immediate workflow snapshot:
  //   1. The activity's `stage` differs from the last activity we saw —
  //      means the orchestrator just transitioned to a new pipeline stage.
  //   2. The activity's `step` is `pipeline_complete` — terminal signal,
  //      ensures the chat lands on `completed`/`awaiting_push_confirm` even
  //      if polling teared down already (isRunning flips false).
  //
  // PR-U1 M14: previously this used a 250ms `setTimeout` debounce — when
  // multiple stage-transitioning activities landed in <250ms (e.g. critic
  // → proto → trace in a fast iterate-loop), the 2nd/3rd timer kept
  // resetting the 1st, but if processing took >250ms only the LAST
  // captured snapshot reached `refreshWorkflow`. Middle transitions could
  // be skipped because `lastStageRef.current` was already updated.
  // RAF coalescing fixes both: every effect run marks the refresh as
  // "needed" and only one rAF tick fires per frame regardless of how many
  // activities arrive within it. The rAF callback re-reads the latest
  // ref so it never operates on stale snapshots.
  const lastStageRef = useRef<string | undefined>(undefined);
  const refreshPendingRef = useRef(false);
  const refreshRafRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (pipelineActivities.length === 0) return;
    const latest = pipelineActivities[pipelineActivities.length - 1];
    const stageChanged =
      lastStageRef.current !== undefined && lastStageRef.current !== latest.stage;
    // PR-T3 S1: `gate_open` is the explicit signal emitted by the
    // orchestrator when the pipeline lands on `awaiting_push_confirm` or
    // `awaiting_critic_resolution`. Treat it as terminal-equivalent so the
    // chat refreshes even when no stage label changed (e.g. Trace stayed
    // `trace`, only the pipeline-level state moved).
    const isTerminal = latest.step === 'pipeline_complete' || latest.step === 'gate_open';
    lastStageRef.current = latest.stage;
    if (!stageChanged && !isTerminal) return;
    refreshPendingRef.current = true;
    if (refreshRafRef.current !== undefined) return; // already scheduled this frame
    refreshRafRef.current = requestAnimationFrame(() => {
      refreshRafRef.current = undefined;
      if (!refreshPendingRef.current) return;
      refreshPendingRef.current = false;
      void refreshWorkflow();
    });
    return () => {
      if (refreshRafRef.current !== undefined) {
        cancelAnimationFrame(refreshRafRef.current);
        refreshRafRef.current = undefined;
      }
    };
  }, [pipelineActivities, refreshWorkflow]);

  // Sidebar conversations: real + pending
  const sidebarConversations = useMemo(() => {
    const list = [...conversations];
    if (pendingConv) {
      list.unshift({
        id: 'pending',
        title: pendingConv.displayName,
        repoFullName: '',
        repoShortName: pendingConv.displayName,
        status: 'idle' as ConversationStatus,
        fileCount: 0,
        lastActivity: new Date().toISOString(),
      });
    }
    return list;
  }, [conversations, pendingConv]);

  // Proto files for Sandpack preview (extracted to ./hooks/useProtoFiles).
  const protoFiles = useProtoFiles({ conversationId, activeWorkflow });

  const chatMode = useMemo(
    () => mapStageToMode(activeWorkflow?.currentStage),
    [activeWorkflow?.currentStage]
  );

  const handleRename = useCallback(async (id: string, newTitle: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)));
    try {
      await workflowsApi.rename(id, newTitle);
    } catch {
      // Polling will eventually correct; silently ignore
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      if (id === 'pending') {
        setPendingConv(null);
        return;
      }
      try {
        await workflowsApi.cancel(id);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (conversationId === id) {
          // F-01: reset the message-key cache before leaving.
          lastMessagesKeyRef.current = '';
          navigate('/chat', { replace: true });
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error('Failed to delete:', e);
      }
    },
    [conversationId, navigate, lastMessagesKeyRef]
  );

  const handleNewConversation = useCallback(() => {
    setPendingConv({ displayName: '' });
    setMessages([]);
    setActiveWorkflow(null);
    loadedIdRef.current = undefined;
    // F-01: reset the message-key cache.
    lastMessagesKeyRef.current = '';
    navigate('/chat');
  }, [navigate, loadedIdRef, lastMessagesKeyRef, setMessages, setActiveWorkflow]);

  const handleTogglePreview = useCallback(() => setShowPreview((p) => !p), [setShowPreview]);
  const handleBack = useCallback(() => {
    setPendingConv(null);
    lastMessagesKeyRef.current = '';
    navigate('/chat');
  }, [navigate, lastMessagesKeyRef]);
  const handleToggleCollapse = useCallback(() => setSidebarCollapsed((c) => !c), []);

  // RepoSelector intentionally removed for v0.6.5 ship.
  const repoSelectorSlot = undefined;

  // ─── Global Keyboard Shortcuts (F-06 hook 4) ─────
  useChatPageKeyboard({ onNewConversation: handleNewConversation });

  // ─── Iteration child polling (F-06 hook 2) ───────
  const { startPolling: startIterationChildPoll } = useIterationChildPoll({
    refreshWorkflow,
    refreshList,
    setMessages,
  });

  // ─── GitHub JIT OAuth restore (F-06 hook 3) ──────
  // handleSend referenced through a forward closure — the hook stores the
  // latest closure in a ref each render so a stale-at-mount value is fine.
  const githubOAuth = useGithubOAuthRestore({
    hasGitHub,
    handleSend: (idea) => handleSend(idea),
  });
  const { pendingGithubIdea, setPendingGithubIdea } = githubOAuth;

  // ─── Send dispatcher (F-06 extraction) ───────────
  // Three branches (new conversation / iteration / send-note), JIT GitHub
  // gate, attachment indexing. Body lifted to ./hooks/useHandleSend.ts
  // verbatim — see that module for the BUG-17 / BUG-08 / BUG-C history.
  const handleSend = useHandleSend({
    conversationId,
    navigate,
    hasGitHub,
    profileLoading,
    traceEnabled,
    pendingModel,
    selectedRepo,
    setSelectedRepo,
    pendingConvRef,
    activeWorkflowRef,
    setPendingConv,
    setCreating,
    setActiveWorkflow,
    setMessages,
    loadedIdRef,
    syncFromStage,
    refreshWorkflow,
    refreshList,
    startIterationChildPoll,
    setPendingGithubIdea,
  });

  // ─── Intent placeholders (FEEDBACK + CHAT until later waves) ─
  const intentPlaceholder = useCallback(
    (label: string, message: string) => {
      const stamp = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        { type: 'user', content: message, timestamp: stamp },
        {
          type: 'info',
          content: `${label}: bu özellik yakında — şimdilik soru veya geri bildirimini chat'e bırakabilirsin.`,
          timestamp: stamp,
        },
      ]);
      toast(`${label}: yakında.`, 'info');
    },
    [setMessages]
  );

  // ─── ASK intent — F-09 / FR-10 streaming RAG (F-06 extraction) ─
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const handleIntentAsk = useChatQaAsk({
    conversationId,
    messagesRef,
    setMessages,
  });

  // T3 (preview-unify): at awaiting_push_confirm, FEEDBACK → iterate-with-feedback
  // endpoint (optimistic echo + Proto re-run). Outside the gate, fall back to
  // the legacy placeholder so messages aren't silently dropped.
  const handleIntentFeedback = useHandleIntentFeedback({
    uiState,
    pipelineId: conversationId,
    setMessages,
    fallback: intentPlaceholder,
  });
  const handleIntentChat = useCallback(
    (message: string) => intentPlaceholder('Sohbet', message),
    [intentPlaceholder]
  );

  const handleSuggestBuild = useCallback(
    (sourceMessage: string) => {
      void handleSend(sourceMessage);
    },
    [handleSend]
  );

  // B3 onboarding: demo template click → seed a pending conversation and fire
  // the create call in the same tick. The pending state is mirrored onto the
  // ref synchronously so `useHandleSend`'s "new conversation" branch (which
  // reads `pendingConvRef.current` before the first await) sees it without
  // waiting for React to commit.
  const handleDemoSelect = useCallback(
    (idea: string) => {
      const seed = { displayName: '' };
      pendingConvRef.current = seed;
      setPendingConv(seed);
      setMessages([]);
      setActiveWorkflow(null);
      loadedIdRef.current = undefined;
      void handleSend(idea);
    },
    [handleSend, setActiveWorkflow, setMessages, loadedIdRef]
  );

  const recentTextMessages = useMemo(() => {
    return messages
      .filter((m) => m.type === 'user' || m.type === 'agent')
      .slice(-8)
      .map((m) => {
        const content =
          (m as { content?: string; message?: string }).content ??
          (m as { message?: string }).message ??
          '';
        return typeof content === 'string' ? content : '';
      })
      .filter((c) => c.length > 0);
  }, [messages]);

  // ─── Pipeline control callbacks (F-06 Phase 2 hook) ─
  // approve / reject / cancel / retry / skip + retryingError capture.
  const {
    handleApprove,
    handleReject,
    handleCancel,
    handleRetry,
    handleSkip,
    pipelineError,
    isRetrying,
  } = usePipelineControls({ conversationId, activeWorkflow, refreshWorkflow });

  const layoutProps = {
    akisLogoUrl,
    sidebarOpen,
    setSidebarOpen,
    sidebarCollapsed,
    onToggleCollapse: handleToggleCollapse,
    sidebarConversations,
    conversationId,
    pendingConv,
    onNewConversation: handleNewConversation,
    onRename: handleRename,
    onDelete: handleDelete,
    pendingGithubIdea,
    onCancelGithubGate: () => setPendingGithubIdea(null),
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
    pipelineHasOutputs: hasPipelineOutputs(activeWorkflow),
    pipelineError,
    isRetrying,
    showPreview,
    previewWidth,
    onTogglePreview: handleTogglePreview,
    setShowPreview,
    splitContainerRef,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    onSend: handleSend,
    onAsk: handleIntentAsk,
    onFeedback: handleIntentFeedback,
    onChat: handleIntentChat,
    onCancel: handleCancel,
    onApprove: handleApprove,
    onReject: handleReject,
    onRetry: handleRetry,
    onSkip: handleSkip,
    onBack: handleBack,
    onSuggestBuild: handleSuggestBuild,
    // PDP-3 B4: after the user resolves the push gate, refresh the
    // workflow so the new stage (proto_building → trace → completed, or
    // completed_partial on cancel) reaches the chat surface.
    onPushResolved: refreshWorkflow,
    traceEnabled,
    setTraceEnabled,
    pendingModel,
    setPendingModel,
    onModelChange: handleModelChange,
    repoSelectorSlot,
    onDemoSelect: handleDemoSelect,
  };

  return <ChatPageLayout {...layoutProps} />;
}
