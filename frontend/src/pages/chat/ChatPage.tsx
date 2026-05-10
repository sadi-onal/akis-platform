/**
 * ChatPage — orchestrator. Body split across ./hooks/* + ChatPageLayout +
 * chatPageHelpers as part of F-06. Phase 2 TODOs flag the next round of
 * extractions (useTraceToggle, useModelPicker).
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
import type { PipelineError } from '../../types/pipeline';
import { workflowsApi } from '../../services/api/workflows';
import type { SelectedRepo } from '../../components/chat/RepoSelector';
import { LOGO_MARK_SVG } from '../../theme/brand';

import { localizeError, sanitizeRepoName, workflowToListItem } from './chatPageHelpers';
import { ChatPageLayout } from './ChatPageLayout';
import { useConversationLoader } from './hooks/useConversationLoader';
import { useIterationChildPoll } from './hooks/useIterationChildPoll';
import { useGithubOAuthRestore } from './hooks/useGithubOAuthRestore';
import { useChatPageKeyboard } from './hooks/useChatPageKeyboard';
import { useHandleSend } from './hooks/useHandleSend';
import { useChatQaAsk } from './hooks/useChatQaAsk';
import { useSplitResize } from './hooks/useSplitResize';

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
  // TODO(F-06 Phase 2): useTraceToggle hook (consolidates traceEnabled + onChange).
  const [traceEnabled, setTraceEnabled] = useState(true);
  // TODO(F-06 Phase 2): useModelPicker hook (pendingModel + handleModelChange + locked flag).
  const [pendingModel, setPendingModel] = useState<string>('claude-haiku-4-5-20251001');
  const [selectedRepo, setSelectedRepo] = useState<SelectedRepo | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(50);
  const { splitContainerRef, handleDragStart } = useSplitResize({ setPreviewWidth });
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
      prev.some((c) => c.id === item.id) ? prev.map((c) => (c.id === item.id ? item : c)) : prev,
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

  const {
    activities: pipelineActivities,
    currentStep,
    createdFiles,
    isConnected,
  } = usePipelineStream(conversationId ?? '', isRunning);

  useEffect(() => {
    setIsConnectedHint(isConnected);
  }, [isConnected]);

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

  // Proto files for Sandpack preview
  const [protoFilesFromApi, setProtoFilesFromApi] = useState<Record<string, string> | null>(null);
  const protoFiles = useMemo(() => {
    if (activeWorkflow?.conversation) {
      for (const m of activeWorkflow.conversation) {
        if (m.type === 'proto_result' && m.protoResult?.files) {
          const files: Record<string, string> = {};
          for (const f of m.protoResult.files) {
            const path = f.path ?? f.name;
            if (path && f.content) files[path] = f.content;
          }
          if (Object.keys(files).length > 0) return files;
        }
      }
    }
    return protoFilesFromApi;
  }, [activeWorkflow, protoFilesFromApi]);

  useEffect(() => {
    if (protoFiles || !conversationId) return;
    const stage = activeWorkflow?.currentStage;
    if (stage === 'completed' || stage === 'completed_partial' || stage === 'trace_testing') {
      workflowsApi
        .getProtoFiles(conversationId)
        .then((res) => {
          if (res && Object.keys(res).length > 0) setProtoFilesFromApi(res);
        })
        .catch(() => {
          /* ignore */
        });
    }
  }, [conversationId, activeWorkflow?.currentStage, protoFiles]);

  const chatMode = useMemo(
    () => mapStageToMode(activeWorkflow?.currentStage),
    [activeWorkflow?.currentStage],
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
    [conversationId, navigate, lastMessagesKeyRef],
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

  const handleTogglePreview = useCallback(() => setShowPreview((p) => !p), []);
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
    [setMessages],
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

  const handleIntentFeedback = useCallback(
    (message: string) => intentPlaceholder('Geribildirim', message),
    [intentPlaceholder],
  );
  const handleIntentChat = useCallback(
    (message: string) => intentPlaceholder('Sohbet', message),
    [intentPlaceholder],
  );

  const handleSuggestBuild = useCallback(
    (sourceMessage: string) => {
      void handleSend(sourceMessage);
    },
    [handleSend],
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

  const approveInFlightRef = useRef(false);
  const handleApprove = useCallback(async () => {
    if (!conversationId || !activeWorkflow || approveInFlightRef.current) return;
    approveInFlightRef.current = true;
    try {
      const cucumberEnabled = localStorage.getItem('akis_cucumber_enabled') === 'true';
      await workflowsApi.approve(
        conversationId,
        sanitizeRepoName(activeWorkflow.title ?? 'project'),
        'private',
        { cucumberEnabled },
      );
      await refreshWorkflow();
      toast('Spec onaylandi, Proto baslatiliyor...', 'success');
    } catch (e) {
      toast(localizeError(e), 'error');
    } finally {
      approveInFlightRef.current = false;
    }
  }, [conversationId, activeWorkflow, refreshWorkflow]);

  const handleReject = useCallback(async () => {
    if (!conversationId) return;
    try {
      await workflowsApi.reject(conversationId);
      await refreshWorkflow();
      toast('Spec reddedildi.', 'info');
    } catch (e) {
      toast(localizeError(e), 'error');
    }
  }, [conversationId, refreshWorkflow]);

  const handleCancel = useCallback(async () => {
    if (!conversationId) return;
    try {
      await workflowsApi.cancel(conversationId);
      await refreshWorkflow();
      toast('Pipeline iptal edildi.', 'info');
    } catch (e) {
      toast(localizeError(e), 'error');
    }
  }, [conversationId, refreshWorkflow]);

  // BUG-N: capture pre-retry error so the banner stays visible during retry.
  const [retryingError, setRetryingError] = useState<PipelineError | null>(null);
  useEffect(() => {
    if (!retryingError) return;
    const stage = activeWorkflow?.currentStage;
    const nextError = activeWorkflow?.error;
    if (stage === 'completed' || stage === 'completed_partial') {
      setRetryingError(null);
      return;
    }
    if (stage === 'failed' && nextError) {
      setRetryingError(null);
    }
  }, [activeWorkflow?.currentStage, activeWorkflow?.error, retryingError]);

  const handleRetry = useCallback(async () => {
    if (!conversationId) return;
    const currentError = activeWorkflow?.error;
    if (currentError) setRetryingError(currentError);
    try {
      await workflowsApi.retry(conversationId);
      await refreshWorkflow();
      toast('Yeniden deneniyor...', 'info');
    } catch (e) {
      setRetryingError(null);
      toast(localizeError(e), 'error');
    }
  }, [conversationId, activeWorkflow?.error, refreshWorkflow]);

  const handleSkip = useCallback(async () => {
    if (!conversationId) return;
    try {
      await workflowsApi.skipTrace(conversationId);
      await refreshWorkflow();
      toast('Trace atlandi.', 'info');
    } catch (e) {
      toast(localizeError(e), 'error');
    }
  }, [conversationId, refreshWorkflow]);

  // TODO(F-06 Phase 2): useModelPicker hook (consolidate with pendingModel state).
  const handleModelChange = useCallback(
    async (modelId: string) => {
      if (!conversationId || conversationId === 'pending') return;
      try {
        await workflowsApi.updateModel(conversationId, modelId);
        await refreshWorkflow();
        toast(`Model güncellendi: ${modelId}`, 'info');
      } catch (e) {
        toast(localizeError(e), 'error');
      }
    },
    [conversationId, refreshWorkflow],
  );

  const pipelineError =
    retryingError ??
    (activeWorkflow?.currentStage === 'failed' ? activeWorkflow?.error : undefined);

  const layoutProps = {
    akisLogoUrl,
    sidebarOpen, setSidebarOpen, sidebarCollapsed, onToggleCollapse: handleToggleCollapse,
    sidebarConversations, conversationId, pendingConv,
    onNewConversation: handleNewConversation, onRename: handleRename, onDelete: handleDelete,
    pendingGithubIdea, onCancelGithubGate: () => setPendingGithubIdea(null),
    activeWorkflow, messages, uiState, isInputEnabled, showCancelButton, inputPlaceholder,
    creating, chatMode, recentTextMessages, currentStep, pipelineActivities, createdFiles,
    protoFiles, pipelineHasOutputs: hasPipelineOutputs(activeWorkflow), pipelineError,
    isRetrying: retryingError !== null,
    showPreview, previewWidth, onTogglePreview: handleTogglePreview, setShowPreview,
    splitContainerRef, handleDragStart,
    onSend: handleSend, onAsk: handleIntentAsk,
    onFeedback: handleIntentFeedback, onChat: handleIntentChat,
    onCancel: handleCancel, onApprove: handleApprove, onReject: handleReject,
    onRetry: handleRetry, onSkip: handleSkip, onBack: handleBack,
    onSuggestBuild: handleSuggestBuild,
    traceEnabled, setTraceEnabled, pendingModel, setPendingModel,
    onModelChange: handleModelChange, repoSelectorSlot,
  };

  return <ChatPageLayout {...layoutProps} />;
}
