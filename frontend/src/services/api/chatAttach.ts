/**
 * Chat-scoped document attachment API (issue #463).
 *
 * POST /api/chats/:chatId/attach — upload documents for RAG retrieval
 */

import { getApiBaseUrl } from './config';

export interface AttachResult {
  filename: string;
  documentId: string;
  chunksCreated: number;
  status: 'ok' | 'quota_exceeded' | 'unsupported' | 'error';
  deduplicated?: boolean;
  message?: string;
}

export interface AttachResponse {
  results: AttachResult[];
}

/**
 * Upload document files to a chat for RAG indexing.
 * Only text-based files are accepted (.txt, .md, .ts, .js, .json, .pdf, etc.).
 * Images are silently filtered out (handled by /attach-image, BUG-C #464).
 *
 * Returns AttachResponse with per-file results.
 */
export async function attachDocumentsToChat(
  chatId: string,
  files: File[],
): Promise<AttachResponse> {
  if (files.length === 0) return { results: [] };

  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file, file.name);
  }

  const baseUrl = getApiBaseUrl().replace(/\/$/, '').replace(/\/api\/?$/, '');
  const response = await fetch(`${baseUrl}/api/chats/${chatId}/attach`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  if (!response.ok) {
    let message = `Dosya yükleme başarısız: ${response.status}`;
    try {
      const data = await response.json();
      const err = data?.error;
      if (err && typeof err.message === 'string') message = err.message;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  return response.json() as Promise<AttachResponse>;
}
