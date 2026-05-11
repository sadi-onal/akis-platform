/**
 * ChatPage helper functions — extracted from ChatPage.tsx as part of F-06.
 * Pure functions; no React, no API calls. Easy to unit-test in isolation.
 *
 * Note: `isRunningStage` lives inside `useConversationLoader` now since that
 * hook owns the polling cadence. If you need it from another module, lift it
 * back here.
 */
import type { ConversationListItem, ConversationStatus } from '../../types/chat';
import type { Workflow, WorkflowStatus } from '../../types/workflow';

/**
 * Maps a backend error to a user-facing Turkish localized string. Tries to
 * pattern-match common cases (rate limit, auth, network, timeout) before
 * falling back to the raw error message.
 */
export function localizeError(e: unknown): string {
  if (e instanceof Error) {
    const m = e.message.toLowerCase();
    if (
      m.includes('rate limit') ||
      m.includes('usage limit') ||
      m.includes('too many') ||
      m.includes('çok fazla istek')
    )
      return 'API limiti aşıldı. Lütfen daha sonra tekrar deneyin.';
    if (m.includes('unauthorized') || m.includes('401') || m.includes('oturum süresi'))
      return 'Oturum süresi doldu. Tekrar giriş yapın.';
    if (
      m.includes('network') ||
      m.includes('fetch') ||
      m.includes('failed to fetch') ||
      m.includes('bağlantı hatası')
    )
      return 'Bağlantı hatası. İnternet bağlantınızı kontrol edin.';
    if (m.includes('timeout') || m.includes('zaman aşımı'))
      return 'İstek zaman aşımına uğradı. Tekrar deneyin.';
    if (m.includes('sunucu geçici'))
      return 'Sunucu geçici olarak kullanılamıyor. Lütfen biraz bekleyip tekrar deneyin.';
    return e.message;
  }
  return 'Beklenmeyen bir hata oluştu.';
}

/** Converts a human-readable title to a valid GitHub repo name */
export function sanitizeRepoName(title: string): string {
  const TR_MAP: Record<string, string> = {
    ç: 'c',
    Ç: 'C',
    ğ: 'g',
    Ğ: 'G',
    ı: 'i',
    İ: 'I',
    ö: 'o',
    Ö: 'O',
    ş: 's',
    Ş: 'S',
    ü: 'u',
    Ü: 'U',
  };
  return (
    title
      .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR_MAP[c] || c)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'project'
  );
}

/**
 * Maps a full `Workflow` to the slim `ConversationListItem` shape used by
 * `ConversationSidebar`. Status-icon mapping is opinionated:
 * `completed_partial` is treated as `idle` (the user can still iterate);
 * `cancelled` is also `idle` so its sidebar dot doesn't claim attention.
 */
export function workflowToListItem(w: Workflow): ConversationListItem {
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
