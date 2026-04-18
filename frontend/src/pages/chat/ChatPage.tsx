import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';
import { ConversationSidebar } from '../../components/chat/ConversationSidebar';
import { ChatPanel } from '../../components/chat/ChatPanel';
import { EmptyState } from '../../components/chat/EmptyState';
import { useConversationState } from '../../hooks/useConversationState';
import { usePipelineStream } from '../../hooks/usePipelineStream';
import { useProfileCompleteness } from '../../hooks/useProfileCompleteness';
import { ProfileSetupBanner } from '../../components/onboarding/ProfileSetupBanner';
import { ProfileSetupWizard } from '../../components/onboarding/ProfileSetupWizard';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { toast } from '../../components/ui/Toast';
import { mapStageToMode } from '../../utils/mapPipelineEvent';
import type { ConversationListItem, ChatMessage, ConversationStatus } from '../../types/chat';
import type { Workflow, WorkflowStatus, ConversationMessage, StructuredSpec } from '../../types/workflow';
import type { UserFriendlyPlan } from '../../types/plan';
import type { PipelineStage } from '../../types/pipeline';
import { workflowsApi } from '../../services/api/workflows';
import { RepoSelector, type RepoMode, type SelectedRepo } from '../../components/chat/RepoSelector';
import type { RepoContext } from '../../services/api/github';
import { LOGO_MARK_SVG } from '../../theme/brand';
import type { ChatAttachment } from '../../components/chat/ChatInput';
import { ChatSkeleton } from '../../components/chat/ChatSkeleton';

function localizeError(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message.toLowerCase();
    if (m.includes('rate limit') || m.includes('usage limit') || m.includes('too many') || m.includes('çok fazla istek')) return 'API limiti aşıldı. Lütfen daha sonra tekrar deneyin.';
    if (m.includes('unauthorized') || m.includes('401') || m.includes('oturum süresi')) return 'Oturum süresi doldu. Tekrar giriş yapın.';
    if (m.includes('network') || m.includes('fetch') || m.includes('failed to fetch') || m.includes('bağlantı hatası')) return 'Bağlantı hatası. İnternet bağlantınızı kontrol edin.';
    if (m.includes('timeout') || m.includes('zaman aşımı')) return 'İstek zaman aşımına uğradı. Tekrar deneyin.';
    if (m.includes('sunucu geçici')) return 'Sunucu geçici olarak kullanılamıyor. Lütfen biraz bekleyip tekrar deneyin.';
    return e.message;
  }
  return 'Beklenmeyen bir hata oluştu.';
}

const PreviewPanel = lazy(() => import('../../components/workflow/PreviewPanel').then(m => ({ default: m.PreviewPanel })));

/* ── helpers ──────────────────────────────────────── */

const POLLING_STAGES: PipelineStage[] = [
  'scribe_clarifying', 'scribe_generating', 'proto_building', 'trace_testing', 'ci_running',
];

// Stages where the user is actively waiting for an AI reply — poll fast (5s).
// Other running stages do heavy backend work, so 20s (SSE up) / 8s (SSE down) is fine.
const INTERACTIVE_STAGES: PipelineStage[] = ['scribe_clarifying'];

function isRunningStage(stage?: PipelineStage): boolean {
  return !!stage && POLLING_STAGES.includes(stage);
}

function isInteractiveStage(stage?: PipelineStage): boolean {
  return !!stage && INTERACTIVE_STAGES.includes(stage);
}

/** Converts a human-readable title to a valid GitHub repo name */
function sanitizeRepoName(title: string): string {
  const TR_MAP: Record<string, string> = {
    ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I',
    ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U',
  };
  return title
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR_MAP[c] || c)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'project';
}

function workflowToListItem(w: Workflow): ConversationListItem {
  const statusMap: Record<WorkflowStatus, ConversationStatus> = {
    pending: 'idle',
    running: 'running',
    awaiting_approval: 'awaiting_approval',
    completed: 'idle',
    completed_partial: 'idle',
    failed: 'error',
    cancelled: 'idle',
  };
  return {
    id: w.id,
    title: w.title || 'Isimsiz',
    repoFullName: w.stages.proto.repo ?? w.title ?? '',
    repoShortName: w.title || 'Isimsiz',
    status: statusMap[w.status] ?? 'idle',
    fileCount: w.stages.proto.files?.length ?? 0,
    lastActivity: w.updatedAt ?? w.createdAt,
    branch: w.stages.proto.branch,
    prUrl: undefined,
  };
}

function specToUserFriendlyPlan(spec: StructuredSpec): UserFriendlyPlan {
  const tc = spec.technicalConstraints;
  let techChoices: string[] = [];
  if (Array.isArray(tc)) {
    techChoices = tc;
  } else if (tc && typeof tc === 'object') {
    if (tc.stack) techChoices.push(tc.stack);
    if (tc.integrations) techChoices.push(...tc.integrations);
  }

  return {
    projectName: spec.title ?? 'Proje',
    summary: spec.problemStatement,
    features: spec.userStories.map((s) => {
      const action = s.action || s.iWant || '';
      const benefit = s.benefit || s.soThat || '';
      return {
        name: action,
        description: benefit,
      };
    }),
    techChoices,
    estimatedFiles: Math.max((spec.userStories?.length ?? 1) * 3, 5),
    requiresTests: true,
  };
}

/**
 * Stage → agent name mapping for Claude-Code-style "Background agent started"
 * markers injected into the chat timeline (issue #390 / BUG-10 MVP).
 */
const STAGE_TO_AGENT: Partial<Record<PipelineStage, 'scribe' | 'proto' | 'trace'>> = {
  scribe_clarifying: 'scribe',
  scribe_generating: 'scribe',
  proto_building: 'proto',
  trace_testing: 'trace',
};

const AGENT_RUNNING_TASK: Record<'scribe' | 'proto' | 'trace', string> = {
  scribe: 'Spec yazıyor',
  proto: 'Scaffold üretiyor',
  trace: 'Testleri yazıyor',
};

function conversationToChatMessages(conv: ConversationMessage[], currentStage?: PipelineStage): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  let specSeen = false;
  // Track whether we've already emitted a marker for each agent in this render
  // so we don't duplicate when the conversation already contained a transition
  // signal (e.g. spec_approved → proto marker).
  const agentMarked = new Set<'scribe' | 'proto' | 'trace'>();
  const pushAgentStarted = (
    agent: 'scribe' | 'proto' | 'trace',
    state: 'started' | 'running' | 'completed',
    timestamp: string,
  ) => {
    if (state === 'running' && agentMarked.has(agent)) return;
    if (state === 'running') agentMarked.add(agent);
    msgs.push({
      type: 'agent_started',
      agent,
      task: AGENT_RUNNING_TASK[agent],
      state,
      timestamp,
    });
  };

  for (const m of conv) {
    const ts = m.timestamp ?? new Date().toISOString();
    switch (m.role) {
      case 'user':
        msgs.push({ type: 'user', content: m.content, timestamp: ts });
        break;
      case 'scribe':
      case 'proto':
      case 'trace':
        if (m.type === 'trace_result' && m.traceResult) {
          const tr = m.traceResult;
          msgs.push({
            type: 'test_result',
            passed: tr.passing ?? 0,
            failed: tr.failing ?? 0,
            total: tr.testCount ?? 0,
            coverage: tr.coverage ?? '0',
            testFiles: tr.testFiles?.map((f) => ({ filePath: f.path ?? f.name, testCount: f.lines ?? 0 })),
            coverageMatrix: tr.traceability?.reduce<Record<string, string[]>>((acc, t) => {
              if (!acc[t.criterionId]) acc[t.criterionId] = [];
              acc[t.criterionId].push(t.testFile);
              return acc;
            }, {}),
            coveredCriteria: tr.traceability?.filter((t) => t.coverage !== 'none').map((t) => t.criterionId).filter((v, i, a) => a.indexOf(v) === i),
            uncoveredCriteria: tr.traceability?.filter((t) => t.coverage === 'none').map((t) => t.criterionId).filter((v, i, a) => a.indexOf(v) === i),
            timestamp: ts,
          });
          // Append BDD/Gherkin spec message if features were generated
          if (tr.gherkinFeatures?.length) {
            msgs.push({
              type: 'gherkin_spec',
              features: tr.gherkinFeatures,
              totalScenarios: tr.gherkinFeatures.reduce((sum: number, f: { scenarioCount: number }) => sum + f.scenarioCount, 0),
              timestamp: ts,
            });
          }
        } else if (m.type === 'clarification' && m.questions?.length) {
          msgs.push({ type: 'clarification', role: m.role, content: m.content, questions: m.questions, timestamp: ts });
        } else if (m.type === 'spec' && m.spec) {
          specSeen = true;
          const plan = specToUserFriendlyPlan(m.spec);
          // Determine plan status from pipeline stage
          let planStatus: 'active' | 'approved' | 'rejected' = 'active';
          if (currentStage && currentStage !== 'awaiting_approval' && currentStage !== 'scribe_clarifying' && currentStage !== 'scribe_generating') {
            planStatus = 'approved';
          }
          msgs.push({
            type: 'plan',
            plan,
            version: 1,
            status: planStatus,
            spec: m.spec,
            timestamp: ts,
          });
        } else {
          msgs.push({ type: 'agent', agent: m.role, content: m.content, timestamp: ts });
        }
        break;
      case 'system':
        // Check if system message indicates approval/rejection and update last plan
        if (specSeen && (m.content.includes('onaylandı') || m.content.includes('reddedildi'))) {
          for (let j = msgs.length - 1; j >= 0; j--) {
            if (msgs[j].type === 'plan') {
              (msgs[j] as { status: string }).status = m.content.includes('onaylandı') ? 'approved' : 'rejected';
              break;
            }
          }
          // Scribe → Proto transition marker when user approved the spec.
          if (m.content.includes('onaylandı')) {
            pushAgentStarted('proto', 'started', ts);
          }
        }
        msgs.push({ type: 'info', content: m.content, timestamp: ts });
        break;
    }
  }

  // Append a live "running" marker for the currently-active agent so users
  // see a Claude-Code-style status line while the pipeline progresses.
  const activeAgent = currentStage ? STAGE_TO_AGENT[currentStage] : undefined;
  if (activeAgent && !agentMarked.has(activeAgent)) {
    const nowIso = new Date().toISOString();
    pushAgentStarted(activeAgent, 'running', nowIso);
  }

  return msgs;
}

// Removed RUNNING_STATUSES — polling now uses isRunningStage(currentStage)

/* ── component ────────────────────────────────────── */

export default function ChatPage() {
  const akisLogoUrl = LOGO_MARK_SVG;
  // Single splat route: /chat/* — extract id from the splat param
  const { '*': splatParam } = useParams();
  const conversationId = splatParam || undefined;
  const navigate = useNavigate();

  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeWorkflow, setActiveWorkflow] = useState<Workflow | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [creating, setCreating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Sidebar collapse: tablet (md-lg) collapsed, desktop (lg+) expanded
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    const w = window.innerWidth;
    return w >= 768 && w < 1024;
  });
  // Pending new conversation — created locally, pipeline not yet started on backend
  const [pendingConv, setPendingConv] = useState<{ displayName: string } | null>(null);
  // Trace toggle — off by default
  const [traceEnabled, setTraceEnabled] = useState(false);
  // Repo selector state
  const [repoMode, setRepoMode] = useState<RepoMode>('new');
  const [selectedRepo, setSelectedRepo] = useState<SelectedRepo | null>(null);
  const [repoContext, setRepoContext] = useState<RepoContext | null>(null);
  // Key source badge state
  const [keySourceBadge, setKeySourceBadge] = useState<{ source: 'akis' | 'own'; jobsRemaining: number; jobsLimit: number } | null>(null);
  const [showProfileWizard, setShowProfileWizard] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // Resizable preview panel (percentage of container width, 30-70%)
  const [previewWidth, setPreviewWidth] = useState(50);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const { missingSteps, loading: profileLoading } = useProfileCompleteness();

  // Drag-to-resize handler for the split pane
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = ((rect.right - ev.clientX) / rect.width) * 100;
      setPreviewWidth(Math.max(25, Math.min(70, pct)));
    };

    const onUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // Close mobile sidebar overlay when navigating to a conversation
  useEffect(() => { setSidebarOpen(false); }, [conversationId]);

  // Auto-collapse sidebar on tablet resize + re-sync on mount/navigation
  useEffect(() => {
    const syncCollapse = () => {
      const w = window.innerWidth;
      if (w >= 768 && w < 1024) setSidebarCollapsed(true);
      else if (w >= 1024) setSidebarCollapsed(false);
      // < 768: mobile uses sidebarOpen (overlay), not collapsed
    };
    // Re-sync immediately on mount (handles navigation/refresh)
    syncCollapse();
    window.addEventListener('resize', syncCollapse);
    return () => window.removeEventListener('resize', syncCollapse);
  }, []);

  const stage = activeWorkflow?.currentStage;
  const { uiState, isInputEnabled, showCancelButton, inputPlaceholder, syncFromStage } =
    useConversationState(stage);

  const loadedIdRef = useRef<string | undefined>(undefined);
  const sendingRef = useRef(false);
  const lastMessagesKeyRef = useRef('');
  const activeWorkflowRef = useRef(activeWorkflow);
  activeWorkflowRef.current = activeWorkflow;
  const pendingConvRef = useRef(pendingConv);
  pendingConvRef.current = pendingConv;

  const isRunning = activeWorkflow ? isRunningStage(activeWorkflow.currentStage) : false;
  const { activities: pipelineActivities, currentStep, createdFiles, isConnected } = usePipelineStream(conversationId ?? '', isRunning);

  // Load conversation list — only on mount and after mutations, NOT on every chat switch
  const refreshList = useCallback(() => {
    workflowsApi.list().then((workflows) => {
      // Hide cancelled pipelines from sidebar
      setConversations(workflows.filter((w) => w.status !== 'cancelled').map(workflowToListItem));
    }).catch((e) => {
      if (import.meta.env.DEV) console.warn('Failed to load conversation list:', e);
    });
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  // Fetch key source badge (once on mount)
  useEffect(() => {
    fetch('/api/settings/ai-keys/status', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        const source: 'akis' | 'own' = data.keySource ?? 'akis';
        const jobsUsed = data.usage?.jobsUsedToday ?? 0;
        const jobsLimit = data.usage?.jobsLimit ?? 3;
        setKeySourceBadge({ source, jobsRemaining: Math.max(0, jobsLimit - jobsUsed), jobsLimit });
      })
      .catch(() => { /* best-effort */ });
  }, []);

  // Load active conversation — keep old content visible until new data arrives
  useEffect(() => {
    if (!conversationId) {
      // Going to /chat (no id) — only clear if we had a conversation before
      if (loadedIdRef.current) {
        setActiveWorkflow(null);
        setMessages([]);
        loadedIdRef.current = undefined;
      }
      return;
    }

    // Same chat — skip
    if (loadedIdRef.current === conversationId) return;

    // Mark immediately to prevent double-fetch on rapid navigation
    const targetId = conversationId;
    loadedIdRef.current = targetId;

    // Different chat — load without clearing (keeps old content visible during fetch)
    workflowsApi.get(targetId).then((w) => {
      // Stale response guard: skip if user navigated away during fetch
      if (loadedIdRef.current !== targetId) return;
      setActiveWorkflow(w);
      const convLen = w.conversation?.length ?? 0;
      const lastTs = w.conversation?.[convLen - 1]?.timestamp ?? '';
      const key = `${targetId}:${convLen}:${lastTs}`;
      if (key !== lastMessagesKeyRef.current) {
        lastMessagesKeyRef.current = key;
        setMessages(conversationToChatMessages(w.conversation ?? [], w.currentStage));
      }
      syncFromStage(w.currentStage ?? 'completed');
    }).catch(() => {
      if (loadedIdRef.current !== targetId) return;
      navigate('/chat', { replace: true });
    });
  }, [conversationId, navigate, syncFromStage]);

  // Polling for updates — only when agent is running
  const prevConvLenRef = useRef(0);
  const activeStageRef = useRef(activeWorkflow?.currentStage);
  activeStageRef.current = activeWorkflow?.currentStage;
  const consecutiveErrorsRef = useRef(0);
  // SSE provides real-time updates — polling is a fallback, so use longer interval
  const backoffRef = useRef(8000);
  const connectionLostRef = useRef(false);

  const currentStageForPolling = activeWorkflow?.currentStage;
  useEffect(() => {
    if (!conversationId || !isRunning) return;
    // Interactive stages (scribe_clarifying): user is waiting for an AI reply — poll fast.
    // Non-interactive running stages: SSE up → 20s, SSE down → 8s + backoff on failures.
    const baseInterval = isInteractiveStage(currentStageForPolling)
      ? 5000
      : (isConnected ? 20000 : 8000);
    backoffRef.current = baseInterval;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (controller.signal.aborted) return;
      try {
        const w = await workflowsApi.get(conversationId);
        if (controller.signal.aborted) return;

        // Success — reset error tracking
        consecutiveErrorsRef.current = 0;
        backoffRef.current = baseInterval;
        if (connectionLostRef.current) {
          connectionLostRef.current = false;
          toast('Bağlantı yeniden kuruldu.', 'success');
        }

        const convLen = w.conversation?.length ?? 0;
        const stageChanged = w.currentStage !== activeStageRef.current;
        if (convLen !== prevConvLenRef.current || stageChanged) {
          prevConvLenRef.current = convLen;
          setActiveWorkflow(w);
          const lastTs = w.conversation?.[convLen - 1]?.timestamp ?? '';
          const key = `${conversationId}:${convLen}:${lastTs}`;
          if (key !== lastMessagesKeyRef.current) {
            lastMessagesKeyRef.current = key;
            setMessages(conversationToChatMessages(w.conversation ?? [], w.currentStage));
          }
          syncFromStage(w.currentStage ?? 'completed');
        }
      } catch {
        if (controller.signal.aborted) return;
        consecutiveErrorsRef.current += 1;
        backoffRef.current = Math.min(backoffRef.current * 2, 30000);
        if (consecutiveErrorsRef.current >= 5 && !connectionLostRef.current) {
          connectionLostRef.current = true;
          toast('Sunucuya bağlanılamıyor. Yeniden denenecek...', 'warning');
        }
      }

      if (!controller.signal.aborted) {
        timeoutId = setTimeout(poll, backoffRef.current);
      }
    };

    timeoutId = setTimeout(poll, backoffRef.current);
    return () => { controller.abort(); clearTimeout(timeoutId); };
  }, [conversationId, isRunning, isConnected, currentStageForPolling, syncFromStage]);

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
    // Method 1: Extract from conversation messages (has file content embedded)
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
    // Method 2: Use files fetched directly from API
    return protoFilesFromApi;
  }, [activeWorkflow, protoFilesFromApi]);

  // Fetch proto files from API when pipeline is completed but conversation doesn't have them
  useEffect(() => {
    if (protoFiles || !conversationId) return;
    const stage = activeWorkflow?.currentStage;
    if (stage === 'completed' || stage === 'completed_partial' || stage === 'trace_testing') {
      workflowsApi.getProtoFiles(conversationId).then((res) => {
        if (res && Object.keys(res).length > 0) setProtoFilesFromApi(res);
      }).catch(() => { /* ignore */ });
    }
  }, [conversationId, activeWorkflow?.currentStage, protoFiles]);

  // Chat mode (Plan/Act/Ask/Review)
  const chatMode = useMemo(() => mapStageToMode(activeWorkflow?.currentStage), [activeWorkflow?.currentStage]);

  const handleRename = useCallback(async (id: string, newTitle: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)),
    );
    try {
      await workflowsApi.rename(id, newTitle);
    } catch {
      // Polling will eventually correct; silently ignore
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (id === 'pending') {
      setPendingConv(null);
      return;
    }
    try {
      await workflowsApi.cancel(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (conversationId === id) navigate('/chat', { replace: true });
    } catch (e) {
      if (import.meta.env.DEV) console.error('Failed to delete:', e);
    }
  }, [conversationId, navigate]);

  const refreshWorkflow = useCallback(async () => {
    if (!conversationId) return;
    const w = await workflowsApi.get(conversationId);
    loadedIdRef.current = conversationId;
    setActiveWorkflow(w);
    const convLen = w.conversation?.length ?? 0;
    const lastTs = w.conversation?.[convLen - 1]?.timestamp ?? '';
    const key = `${conversationId}:${convLen}:${lastTs}`;
    if (key !== lastMessagesKeyRef.current) {
      lastMessagesKeyRef.current = key;
      setMessages(conversationToChatMessages(w.conversation ?? [], w.currentStage));
    }
    syncFromStage(w.currentStage ?? 'completed');
    // Update sidebar item in-place (no full list refetch)
    const item = workflowToListItem(w);
    setConversations((prev) =>
      prev.some((c) => c.id === item.id) ? prev.map((c) => (c.id === item.id ? item : c)) : [item, ...prev],
    );
  }, [conversationId, syncFromStage]);

  // "Yeni Sohbet" — no modal, open empty chat directly
  const handleNewConversation = useCallback(() => {
    setPendingConv({ displayName: '' });
    setMessages([]);
    setActiveWorkflow(null);
    loadedIdRef.current = undefined;
    navigate('/chat');
  }, [navigate]);

  // Stable handlers for memoized children (ChatPanel, ConversationSidebar)
  const handleTogglePreview = useCallback(() => setShowPreview((p) => !p), []);
  const handleBack = useCallback(() => {
    setPendingConv(null);
    navigate('/chat');
  }, [navigate]);
  const handleToggleCollapse = useCallback(() => setSidebarCollapsed((c) => !c), []);

  // Stable JSX slot for ChatPanel — prevents fresh React element on every render
  const repoSelectorSlot = useMemo(() => {
    if (!pendingConv) return undefined;
    return (
      <RepoSelector
        mode={repoMode}
        onModeChange={setRepoMode}
        selectedRepo={selectedRepo}
        onRepoSelect={setSelectedRepo}
        repoContext={repoContext}
        onRepoContextChange={setRepoContext}
      />
    );
  }, [pendingConv, repoMode, selectedRepo, repoContext]);

  // ─── Global Keyboard Shortcuts ────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      // Ctrl/Cmd+K → focus sidebar search
      if (isMod && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('[data-sidebar-search]');
        searchInput?.focus();
      }
      // Ctrl/Cmd+Shift+N → new conversation
      if (isMod && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        handleNewConversation();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleNewConversation]);

  const handleSend = useCallback(async (content: string, attachments?: ChatAttachment[]) => {
    // In-flight guard — blocks duplicate submits from double-Enter / slow network
    if (sendingRef.current) return;
    sendingRef.current = true;

    try {
      const userMsg: ChatMessage = { type: 'user', content, timestamp: new Date().toISOString() };
      setMessages((prev) => [...prev, userMsg]);

      const currentPending = pendingConvRef.current;
      const currentWorkflow = activeWorkflowRef.current;

      // If pending new conversation — create pipeline with first message as idea
      if (currentPending && !conversationId) {
        // Client-side validation: idea must be at least 10 chars
        if (content.trim().length < 10) {
          setMessages((prev) => [...prev, {
            type: 'error',
            agent: 'system',
            message: 'Fikrinizi en az 10 karakter ile açıklayın. Örn: "React ile basit bir todo uygulaması"',
            retryable: false,
            timestamp: new Date().toISOString(),
          }]);
          return;
        }

        try {
          setCreating(true);
          const w = await workflowsApi.create({
            idea: content,
            traceEnabled,
            existingRepo: selectedRepo ?? undefined,
          }, attachments);
          setPendingConv(null);
          // Reset repo selector state after pipeline creation
          setRepoMode('new');
          setSelectedRepo(null);
          setRepoContext(null);
          loadedIdRef.current = w.id;
          setActiveWorkflow(w);
          setMessages(conversationToChatMessages(w.conversation ?? [], w.currentStage));
          syncFromStage(w.currentStage ?? 'completed');
          refreshList();
          navigate(`/chat/${w.id}`, { replace: true });
        } catch (e) {
          const errorMsg = localizeError(e);
          toast(errorMsg, 'error');
          setMessages((prev) => [...prev, {
            type: 'error',
            agent: 'system',
            message: errorMsg,
            retryable: true,
            timestamp: new Date().toISOString(),
          }]);
        } finally {
          setCreating(false);
        }
        return;
      }

      if (!conversationId) return;

      // ─── Iteration Mode: completed pipeline + protoOutput → create follow-up pipeline in same chat ───
      const isTerminal = currentWorkflow?.currentStage === 'completed' || currentWorkflow?.currentStage === 'completed_partial';
      const protoRepo = currentWorkflow?.stages.proto?.repo;
      const protoBranch = currentWorkflow?.stages.proto?.branch;

      if (isTerminal && protoRepo && protoBranch) {
        const [repoOwner, repoName] = protoRepo.split('/');
        if (repoOwner && repoName) {
          try {
            setCreating(true);
            const w = await workflowsApi.create({
              idea: content,
              traceEnabled,
              existingRepo: { owner: repoOwner, repo: repoName, branch: protoBranch },
              parentPipelineId: conversationId,
              skipScribe: true,
            }, attachments);
            loadedIdRef.current = w.id;
            setActiveWorkflow(w);
            setMessages((prev) => [...prev, ...conversationToChatMessages(w.conversation ?? [], w.currentStage)]);
            syncFromStage(w.currentStage ?? 'completed');
            refreshList();
            navigate(`/chat/${w.id}`);
          } catch (e) {
            if (import.meta.env.DEV) console.error('Failed to create iteration:', e);
            toast(localizeError(e), 'error');
            const errMsg: ChatMessage = {
              type: 'error',
              agent: 'system',
              message: 'İterasyon başlatılamadı. Lütfen tekrar deneyin.',
              retryable: true,
              timestamp: new Date().toISOString(),
            };
            setMessages(prev => [...prev, errMsg]);
          } finally {
            setCreating(false);
          }
          return;
        }
      }

      // Send message to the existing pipeline — works for ALL stages including terminal ones.
      // Backend saves it as a user_note (terminal) or processes it as a Scribe answer (clarifying).
      try {
        await workflowsApi.sendMessage(conversationId, content, attachments);
        await refreshWorkflow();
        refreshList();

        // Show feedback when pipeline is not in an interactive state
        const stage = activeWorkflowRef.current?.currentStage;
        if (stage && stage !== 'scribe_clarifying' && stage !== 'awaiting_approval') {
          const stageMessages: Record<string, string> = {
            scribe_generating: 'Notunuz kaydedildi. Scribe spec oluşturma işlemi devam ediyor.',
            proto_building: 'Notunuz kaydedildi. Proto kod üretimi devam ediyor.',
            trace_testing: 'Notunuz kaydedildi. Trace test yazımı devam ediyor.',
            ci_running: 'Notunuz kaydedildi. CI kontrolü devam ediyor.',
            completed: 'Notunuz kaydedildi.',
            completed_partial: 'Notunuz kaydedildi.',
            failed: 'Notunuz kaydedildi. Yeniden denemek için Retry butonunu kullanabilirsiniz.',
          };
          const infoMsg: ChatMessage = {
            type: 'info',
            content: stageMessages[stage] || 'Notunuz kaydedildi.',
            timestamp: new Date().toISOString(),
          };
          setMessages(prev => [...prev, infoMsg]);
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error('Failed to send:', e);
      }
    } finally {
      sendingRef.current = false;
    }
  }, [conversationId, refreshWorkflow, refreshList, navigate, traceEnabled, selectedRepo, syncFromStage]);

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
    } catch (e) { toast(localizeError(e), 'error'); }
    finally { approveInFlightRef.current = false; }
  }, [conversationId, activeWorkflow, refreshWorkflow]);

  const handleReject = useCallback(async () => {
    if (!conversationId) return;
    try { await workflowsApi.reject(conversationId); await refreshWorkflow(); toast('Spec reddedildi.', 'info'); }
    catch (e) { toast(localizeError(e), 'error'); }
  }, [conversationId, refreshWorkflow]);

  const handleCancel = useCallback(async () => {
    if (!conversationId) return;
    try { await workflowsApi.cancel(conversationId); await refreshWorkflow(); toast('Pipeline iptal edildi.', 'info'); }
    catch (e) { toast(localizeError(e), 'error'); }
  }, [conversationId, refreshWorkflow]);

  const handleRetry = useCallback(async () => {
    if (!conversationId) return;
    try { await workflowsApi.retry(conversationId); await refreshWorkflow(); toast('Yeniden deneniyor...', 'info'); }
    catch (e) { toast(localizeError(e), 'error'); }
  }, [conversationId, refreshWorkflow]);

  const handleSkip = useCallback(async () => {
    if (!conversationId) return;
    try { await workflowsApi.skipTrace(conversationId); await refreshWorkflow(); toast('Trace atlandi.', 'info'); }
    catch (e) { toast(localizeError(e), 'error'); }
  }, [conversationId, refreshWorkflow]);

  return (
    <div className="flex h-dvh overflow-hidden bg-ak-bg" role="application" aria-label="AKIS Chat">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar:
          Mobile (<768): hidden, slide-in overlay via hamburger
          Tablet (768-1023): collapsed 64px, relative in flow
          Desktop (≥1024): full 280px, relative in flow */}
      <div
        className={cn(
          'flex-shrink-0 transition-transform duration-200 ease-out',
          // Mobile: fixed overlay, hidden by default
          'fixed inset-y-0 left-0 z-40',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
          // Tablet+: sticky in flow, always visible, fixed height so it doesn't scroll with chat
          'md:sticky md:top-0 md:z-auto md:translate-x-0 md:h-dvh',
        )}
      >
        <ConversationSidebar
          conversations={sidebarConversations}
          activeId={conversationId ?? (pendingConv ? 'pending' : undefined)}
          onNewConversation={handleNewConversation}
          onRename={handleRename}
          onDelete={handleDelete}
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleCollapse}
        />
      </div>

      {/* Mobile top bar — only visible below md */}
      <div className="fixed left-0 right-0 top-0 z-20 flex items-center gap-3 border-b border-ak-border bg-ak-surface px-4 py-3 md:hidden">
        <button
          onClick={() => setSidebarOpen(true)}
          aria-label="Menü"
          className="rounded-lg p-1.5 text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <img src={akisLogoUrl} alt="AKIS" className="h-7 w-7 object-contain" />
        <span className="text-[15px] font-extrabold tracking-tight text-ak-primary">AKIS</span>
      </div>

      {/* Profile setup wizard modal */}
      {showProfileWizard && (
        <ProfileSetupWizard onClose={() => setShowProfileWizard(false)} />
      )}

      {/* Main content — top padding only on mobile for the top bar */}
      <div className={cn('flex min-w-0 flex-1 flex-col min-h-0', 'pt-[52px] md:pt-0')}>
        {/* Profile completeness banner */}
        {!profileLoading && missingSteps.length > 0 && !conversationId && !pendingConv && (
          <ProfileSetupBanner
            missingSteps={missingSteps}
            onSetup={() => setShowProfileWizard(true)}
          />
        )}

        {conversationId || pendingConv ? (
          <div ref={splitContainerRef} className="flex min-w-0 flex-1 min-h-0">
            {/* Chat panel — takes remaining width */}
            <div
              className="min-w-0 flex-1 flex flex-col min-h-0"
              style={showPreview ? { flexBasis: `${100 - previewWidth}%`, flexGrow: 0, flexShrink: 0 } : undefined}
            >
              <ErrorBoundary>
                <ChatPanel
                  conversationId={conversationId ?? 'pending'}
                  repoShortName={activeWorkflow?.title ?? pendingConv?.displayName ?? ''}
                  repoFullName={activeWorkflow?.stages?.proto?.repo ?? ''}
                  repoUrl={activeWorkflow?.stages?.proto?.repoUrl}
                  branch={activeWorkflow?.stages?.proto?.branch}
                  mode={chatMode}
                  hasPreview={!!protoFiles}
                  showPreview={showPreview}
                  onTogglePreview={handleTogglePreview}
                  messages={messages}
                  uiState={uiState}
                  isInputEnabled={pendingConv ? !creating : (creating ? false : isInputEnabled)}
                  isSending={creating}
                  showCancelButton={showCancelButton}
                  inputPlaceholder={pendingConv
                    ? (repoMode === 'existing' && selectedRepo
                      ? 'Bu repoda ne degistirmek istiyorsunuz...'
                      : 'Projenizi anlatın...')
                    : inputPlaceholder}
                  onSend={handleSend}
                  onCancel={handleCancel}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onRetry={handleRetry}
                  onSkip={handleSkip}
                  onBack={handleBack}
                  showBackButton
                  currentStep={currentStep}
                  activities={pipelineActivities}
                  createdFiles={createdFiles}
                  traceEnabled={traceEnabled}
                  onTraceToggle={pendingConv ? setTraceEnabled : undefined}
                  repoSelectorSlot={repoSelectorSlot}
                  keySourceBadge={pendingConv ? keySourceBadge : null}
                />
              </ErrorBoundary>
            </div>

            {/* Resizable preview panel with drag handle */}
            {showPreview && (
              <>
                {/* Drag handle — desktop only */}
                <div
                  onMouseDown={handleDragStart}
                  className="group hidden w-1 flex-shrink-0 cursor-col-resize bg-ak-border transition-colors hover:bg-ak-primary/50 active:bg-ak-primary lg:block"
                  title="Sürükleyerek boyutlandır"
                >
                  <div className="flex h-full items-center justify-center">
                    <div className="h-8 w-0.5 rounded-full bg-ak-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </div>

                {/* Preview panel — mobile: full-screen overlay, desktop: inline split */}
                {/* Mobile overlay backdrop */}
                <div
                  className="fixed inset-0 z-50 bg-black/50 lg:hidden"
                  onClick={() => setShowPreview(false)}
                />
                <div
                  className={cn(
                    // Mobile: fixed full-screen overlay
                    'fixed inset-0 z-50 overflow-hidden lg:relative lg:inset-auto lg:z-auto',
                  )}
                  style={{ flexBasis: `${previewWidth}%`, flexGrow: 0, flexShrink: 0 }}
                >
                  {/* Mobile close button */}
                  <button
                    onClick={() => setShowPreview(false)}
                    className="absolute right-3 top-3 z-10 rounded-lg bg-ak-surface-2 p-1.5 text-ak-text-secondary hover:text-ak-text-primary lg:hidden"
                    aria-label="Önizlemeyi kapat"
                  >
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
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
                      />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              </>
            )}
          </div>
        ) : (
          <EmptyState variant="no-conversation" onNewConversation={handleNewConversation} />
        )}
      </div>

    </div>
  );
}
