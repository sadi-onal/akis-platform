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
import { useEffect, useMemo, useState } from 'react';

import { workflowsApi } from '../../../services/api/workflows';
import type { Workflow } from '../../../types/workflow';

export interface UseProtoFilesOptions {
  conversationId: string | undefined;
  activeWorkflow: Workflow | null;
}

export function useProtoFiles(
  options: UseProtoFilesOptions,
): Record<string, string> | null {
  const { conversationId, activeWorkflow } = options;
  const [protoFilesFromApi, setProtoFilesFromApi] = useState<Record<string, string> | null>(
    null,
  );

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
          /* ignore — preview is best-effort */
        });
    }
  }, [conversationId, activeWorkflow?.currentStage, protoFiles]);

  return protoFiles;
}
