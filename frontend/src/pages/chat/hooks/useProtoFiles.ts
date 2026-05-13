/**
 * useProtoFiles — resolves the proto-output file map for the Sandpack preview.
 *
 * Two sources, in order:
 *   1. The active workflow conversation — Scan for the latest `proto_result`
 *      message and read its `protoResult.files` payload. Cheap, in-memory.
 *   2. `workflowsApi.getProtoFiles(id)` — fallback fetch when (1) returns
 *      nothing but the pipeline is in a stage that should have produced files
 *      (`completed`, `completed_partial`, `trace_testing`).
 *
 * Returns the merged map (conversation source preferred). Returns `null` until
 * either source resolves. Extracted from ChatPage.tsx as part of F-06 Phase 2
 * to keep the orchestrator focused on routing/state rather than data fetching.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { workflowsApi } from '../../../services/api/workflows';
import type { PipelineStage } from '../../../types/pipeline';
import type { Workflow } from '../../../types/workflow';

export interface UseProtoFilesOptions {
  conversationId: string | undefined;
  activeWorkflow: Workflow | null;
}

const GENERATION_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>([
  'scribe_clarifying',
  'scribe_generating',
  'critic_reviewing_spec',
  'proto_building',
  'critic_reviewing_code',
]);

export function useProtoFiles(options: UseProtoFilesOptions): Record<string, string> | null {
  const { conversationId, activeWorkflow } = options;
  const [protoFilesFromApi, setProtoFilesFromApi] = useState<Record<string, string> | null>(null);

  const stage = activeWorkflow?.currentStage;
  // Bulgu F — drop the cached API files when the source context changes:
  // (1) different conversation entirely, or (2) the same pipeline re-enters a
  // generation stage (iterate), which will produce fresh files. Without this
  // the drawer flashes stale content from the previous run.
  const prevContextRef = useRef<{ id: string | undefined; stage: PipelineStage | undefined }>({
    id: conversationId,
    stage,
  });
  useEffect(() => {
    const prev = prevContextRef.current;
    const conversationChanged = prev.id !== conversationId;
    const restartedGeneration =
      prev.stage !== stage && stage !== undefined && GENERATION_STAGES.has(stage);
    if (conversationChanged || restartedGeneration) {
      setProtoFilesFromApi(null);
    }
    prevContextRef.current = { id: conversationId, stage };
  }, [conversationId, stage]);

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
    // PDP-3 B4: `awaiting_push_confirm` is the new pre-push gate. The
    // scaffold lives in protoOutput.files at this point, so the FE must
    // be able to render Sandpack for the user to inspect before they
    // press "GitHub'a gönder".
    if (
      stage === 'completed' ||
      stage === 'completed_partial' ||
      stage === 'trace_testing' ||
      stage === 'awaiting_push_confirm'
    ) {
      workflowsApi
        .getProtoFiles(conversationId)
        .then((res) => {
          if (res && Object.keys(res).length > 0) setProtoFilesFromApi(res);
        })
        .catch(() => {
          /* ignore — preview is best-effort */
        });
    }
  }, [conversationId, activeWorkflow?.currentStage, protoFiles]);

  return protoFiles;
}
