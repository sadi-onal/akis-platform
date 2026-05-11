/**
 * useHandleSend — the chat send dispatcher, extracted from ChatPage.tsx as
 * part of F-06.
 *
 * This is a thin lift, not a refactor: the body matches the old `handleSend`
 * almost line-for-line. The motivation is purely structural — ChatPage was
 * 1400 lines and `handleSend` is responsible for ~200 of them.
 *
 * The dispatcher has three branches:
 *   1. New conversation (pendingConv && !conversationId) → `workflowsApi.create`.
 *   2. Iteration on a terminal pipeline → child pipeline + child polling.
 *   3. In-flight pipeline → `workflowsApi.sendMessage` + refresh.
 *
 * It also threads through the JIT GitHub gate (when an idea is sent without
 * GitHub linked) and a sendingRef in-flight guard against double-submits.
 *
 * TODO(F-06 Phase 2): split the three branches into sub-hooks (useCreate,
 * useIterate, useSendNote) — they share state but the branch logic is dense.
 */
import { useCallback, useRef } from 'react';
import type { NavigateFunction } from 'react-router-dom';

import { attachDocumentsToChat } from '../../../services/api/chatAttach';
import type { ChatAttachment } from '../../../components/chat/ChatInput';
import { toast } from '../../../components/ui/Toast';
import type { ChatMessage } from '../../../types/chat';
import type { PipelineStage } from '../../../types/pipeline';
import type { Workflow } from '../../../types/workflow';
import { conversationToChatMessages } from '../../../utils/conversationToChatMessages';
import { workflowsApi } from '../../../services/api/workflows';
import type { SelectedRepo } from '../../../components/chat/RepoSelector';

import { localizeError } from '../chatPageHelpers';

export interface UseHandleSendOptions {
  conversationId: string | undefined;
  navigate: NavigateFunction;
  hasGitHub: boolean;
  profileLoading: boolean;
  traceEnabled: boolean;
  pendingModel: string;
  selectedRepo: SelectedRepo | null;
  setSelectedRepo: React.Dispatch<React.SetStateAction<SelectedRepo | null>>;
  pendingConvRef: React.MutableRefObject<{ displayName: string } | null>;
  activeWorkflowRef: React.MutableRefObject<Workflow | null>;
  setPendingConv: React.Dispatch<React.SetStateAction<{ displayName: string } | null>>;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  setActiveWorkflow: React.Dispatch<React.SetStateAction<Workflow | null>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  loadedIdRef: React.MutableRefObject<string | undefined>;
  syncFromStage: (stage: PipelineStage) => void;
  /**
   * Re-fetch the active workflow. Returns the fetched `Workflow` so we can
   * read post-refresh fields (e.g. `currentStage`) without going through the
   * ref — React state updates after an `await` boundary are not guaranteed to
   * flush before the next microtask in concurrent mode, so `activeWorkflowRef`
   * can be stale here.
   */
  refreshWorkflow: () => Promise<Workflow | null>;
  refreshList: () => void;
  startIterationChildPoll: (childId: string) => void;
  setPendingGithubIdea: React.Dispatch<React.SetStateAction<string | null>>;
}

export function useHandleSend(options: UseHandleSendOptions) {
  const sendingRef = useRef(false);

  // Capture options through a ref so the returned callback is stable. Every
  // field on `options` is allocated fresh per parent render (setters from
  // useState, refs that point to local state). Putting them all in a ref lets
  // ChatPage avoid re-running expensive memos that depend on `handleSend`'s
  // identity.
  const optsRef = useRef(options);
  optsRef.current = options;

  return useCallback(async (content: string, attachments?: ChatAttachment[]) => {
    if (sendingRef.current) return;
    const o = optsRef.current;

    // JIT GitHub gate: only intercept on the first send of a brand-new
    // conversation. Iteration sends in an existing pipeline reuse the
    // already-linked GitHub from earlier.
    const isNewConversationSend = o.pendingConvRef.current && !o.conversationId;
    if (isNewConversationSend && !o.profileLoading && !o.hasGitHub && content.trim().length >= 10) {
      o.setPendingGithubIdea(content);
      return;
    }

    sendingRef.current = true;

    try {
      // Thread image attachments onto the user message so the bubble can
      // render thumbnails + click-to-preview (BUG-C).
      const userImages = (attachments ?? [])
        .filter((a) => a.type === 'image' && a.preview)
        .map((a) => ({
          id: a.id,
          name: a.file.name,
          previewUrl: a.preview!,
          mimeType: a.file.type || 'image/png',
        }));
      const userMsg: ChatMessage = {
        type: 'user',
        content,
        timestamp: new Date().toISOString(),
        ...(userImages.length > 0 && { images: userImages }),
      };
      o.setMessages((prev) => [...prev, userMsg]);

      const currentPending = o.pendingConvRef.current;
      const currentWorkflow = o.activeWorkflowRef.current;

      // ─── Brand-new conversation → create pipeline ──
      if (currentPending && !o.conversationId) {
        if (content.trim().length < 10) {
          o.setMessages((prev) => [
            ...prev,
            {
              type: 'error',
              agent: 'system',
              message:
                'Fikrinizi en az 10 karakter ile açıklayın. Örn: "React ile basit bir todo uygulaması"',
              retryable: false,
              timestamp: new Date().toISOString(),
            },
          ]);
          return;
        }

        try {
          o.setCreating(true);
          const w = await workflowsApi.create(
            {
              idea: content,
              traceEnabled: o.traceEnabled,
              model: o.pendingModel,
              existingRepo: o.selectedRepo ?? undefined,
            },
            attachments,
          );
          o.setPendingConv(null);
          o.setSelectedRepo(null);
          o.loadedIdRef.current = w.id;
          o.setActiveWorkflow(w);
          o.setMessages(conversationToChatMessages(w.conversation ?? [], w.currentStage));
          o.syncFromStage(w.currentStage ?? 'completed');
          o.refreshList();
          o.navigate(`/chat/${w.id}`, { replace: true });
        } catch (e) {
          const errorMsg = localizeError(e);
          toast(errorMsg, 'error');
          o.setMessages((prev) => [
            ...prev,
            {
              type: 'error',
              agent: 'system',
              message: errorMsg,
              retryable: true,
              timestamp: new Date().toISOString(),
            },
          ]);
        } finally {
          o.setCreating(false);
        }
        return;
      }

      if (!o.conversationId) return;

      // ─── Iteration mode → create child pipeline ─────
      const isTerminal =
        currentWorkflow?.currentStage === 'completed' ||
        currentWorkflow?.currentStage === 'completed_partial';
      const protoRepo = currentWorkflow?.stages.proto?.repo;
      const protoBranch = currentWorkflow?.stages.proto?.branch;

      if (isTerminal && protoRepo && protoBranch) {
        const [repoOwner, repoName] = protoRepo.split('/');
        if (repoOwner && repoName) {
          try {
            o.setCreating(true);
            const child = await workflowsApi.create(
              {
                idea: content,
                traceEnabled: o.traceEnabled,
                existingRepo: { owner: repoOwner, repo: repoName, branch: protoBranch },
                parentPipelineId: o.conversationId,
                skipScribe: true,
              },
              attachments,
            );

            o.setMessages((prev) => [
              ...prev,
              {
                type: 'info',
                content: 'İterasyon başlatıldı — Proto mevcut depo üstüne değişiklikleri uyguluyor.',
                timestamp: new Date().toISOString(),
              },
            ]);

            o.startIterationChildPoll(child.id);
            o.refreshList();
          } catch (e) {
            if (import.meta.env.DEV) console.error('Failed to create iteration:', e);
            toast(localizeError(e), 'error');
            o.setMessages((prev) => [
              ...prev,
              {
                type: 'error',
                agent: 'system',
                message: 'İterasyon başlatılamadı. Lütfen tekrar deneyin.',
                retryable: true,
                timestamp: new Date().toISOString(),
              },
            ]);
          } finally {
            o.setCreating(false);
          }
          return;
        }
      }

      // ─── Existing pipeline → send + maybe index attachments ─
      const docAttachments = (attachments ?? []).filter((a) => a.type === 'document');
      if (docAttachments.length > 0) {
        try {
          const attachResp = await attachDocumentsToChat(
            o.conversationId,
            docAttachments.map((a) => a.file),
          );
          const indexed = attachResp.results.filter((r) => r.status === 'ok' && !r.deduplicated);
          const deduped = attachResp.results.filter((r) => r.deduplicated);
          const failed = attachResp.results.filter((r) => r.status === 'error');
          const quota = attachResp.results.filter((r) => r.status === 'quota_exceeded');
          if (indexed.length > 0) {
            const totalChunks = indexed.reduce((s, r) => s + r.chunksCreated, 0);
            toast(`${indexed.length} dosya indexlendi (${totalChunks} parça)`, 'success');
          }
          if (deduped.length > 0)
            toast(`${deduped.length} dosya zaten indexliydi, atlandı`, 'info');
          if (quota.length > 0)
            toast(`${quota.length} dosya çok büyük — 100 parça limitini aşıyor`, 'error');
          if (failed.length > 0) toast(`${failed.length} dosya indexlenemedi`, 'error');
        } catch (err) {
          if (import.meta.env.DEV) console.warn('[ChatPage] attach failed (non-fatal):', err);
          toast('Dosya indexleme başarısız, mesaj gönderilmeye devam ediyor', 'error');
        }
      }

      try {
        await workflowsApi.sendMessage(o.conversationId, content, attachments);
        // Read currentStage from the returned workflow rather than the ref —
        // the ref is updated by the parent's render-time assignment, which is
        // not guaranteed to have flushed by the time we resume here. The
        // returned `Workflow` is the fresh value we just fetched. See S-2 in
        // PR #525 review.
        const refreshed = await o.refreshWorkflow();
        o.refreshList();
        const stage = refreshed?.currentStage ?? o.activeWorkflowRef.current?.currentStage;
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
          o.setMessages((prev) => [
            ...prev,
            {
              type: 'info',
              content: stageMessages[stage] || 'Notunuz kaydedildi.',
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } catch (e) {
        if (import.meta.env.DEV) console.error('Failed to send:', e);
      }
    } finally {
      sendingRef.current = false;
    }
    // Deliberately empty deps: every external value is read via
    // `o = optsRef.current` above so the callback identity stays stable across
    // parent re-renders. The `react-hooks/exhaustive-deps` rule doesn't flag
    // this because the ref-indirection hides the closure variables, but if you
    // add a direct (non-`o.*`) reference to a parent variable inside this body,
    // ALSO add it to `optsRef` — otherwise it will silently capture a stale
    // value. (Reads via optsRef.current so callback identity stays stable.)
  }, []);
}
