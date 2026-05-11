/**
 * Chat-QA API client (FR-10).
 *
 * Wraps `POST /api/chat-qa/ask`. The backend streams an SSE response with
 * `chunk | citation | done | error` events. We expose the stream as an async
 * iterable so React components can `for await (const ev of chatQaApi.ask(...))`.
 *
 * Implementation: `fetch` + a manual reader pulled from `response.body`.
 * EventSource isn't suitable here because (a) the request is a POST and (b)
 * EventSource forces same-origin GET semantics.
 *
 * Anchors: 03-architecture § 5.3, 06-roadmap Wave 4 PR 4.2.
 */
import { getApiBaseUrl } from './config';

export type CitationSource = 'spec' | 'proto' | 'findings' | 'regression';

export interface QACitation {
  source: CitationSource;
  excerpt: string;
  refKey?: string;
}

export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskRequest {
  message: string;
  pipelineId?: string;
  history?: ChatHistoryEntry[];
  /**
   * Optional AbortSignal. When the signal aborts, the fetch is cancelled and
   * the iterator throws a `DOMException('aborted', 'AbortError')` that the
   * caller should swallow if expected (e.g. unmount, new send replacing old).
   */
  signal?: AbortSignal;
}

/**
 * Discriminated event type the iterator yields. The FE switches on
 * `event.type` to decide whether to append text, render a citation chip, or
 * finalize the message.
 */
export type QAEvent =
  | { type: 'chunk'; text: string }
  | { type: 'citation'; citation: QACitation }
  | { type: 'done'; answer: string; citations: QACitation[]; needsBuild: boolean }
  | { type: 'error'; code: string; message: string };

function baseUrl(): string {
  return getApiBaseUrl().replace(/\/$/, '').replace(/\/api\/?$/, '');
}

/**
 * Parse a single SSE block into a QAEvent. Returns null when the block is a
 * heartbeat or unparseable.
 */
function parseSSEBlock(block: string): QAEvent | null {
  if (!block.trim()) return null;
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // SSE comment / heartbeat
    if (line.startsWith('event: ')) event = line.slice('event: '.length).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
  }
  if (!event || dataLines.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
  switch (event) {
    case 'chunk': {
      const r = parsed as { text?: string };
      return typeof r.text === 'string' ? { type: 'chunk', text: r.text } : null;
    }
    case 'citation': {
      const r = parsed as QACitation;
      return r && typeof r.source === 'string' && typeof r.excerpt === 'string'
        ? { type: 'citation', citation: r }
        : null;
    }
    case 'done': {
      const r = parsed as { answer?: string; citations?: QACitation[]; needsBuild?: boolean };
      return {
        type: 'done',
        answer: typeof r.answer === 'string' ? r.answer : '',
        citations: Array.isArray(r.citations) ? r.citations : [],
        needsBuild: !!r.needsBuild,
      };
    }
    case 'error': {
      const r = parsed as { code?: string; message?: string };
      return {
        type: 'error',
        code: typeof r.code === 'string' ? r.code : 'CHAT_QA_FAILED',
        message: typeof r.message === 'string' ? r.message : 'Chat Q&A başarısız oldu.',
      };
    }
    default:
      return null;
  }
}

/**
 * Async iterator over the SSE stream. Splits the body buffer on the SSE block
 * delimiter (`\n\n`) and yields parsed QAEvents until the stream closes.
 *
 * Cancellation: when the optional `signal` aborts, the reader is cancelled and
 * the iterator throws a `DOMException('aborted', 'AbortError')`. Callers that
 * abort intentionally (unmount, superseded send) should catch and ignore it.
 */
async function* readSSEStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<QAEvent> {
  if (!response.body) {
    yield {
      type: 'error',
      code: 'NO_STREAM',
      message: 'Sunucudan veri alınamadı.',
    };
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // If the caller aborts, cancel the reader so the underlying fetch stops too.
  const onAbort = () => {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* already cancelled */
    }
    // Test-mode probe: when a Playwright e2e spec seeds the abort counter
    // before navigation (`window.__chatQaAbortCount = 0`), we bump it here
    // so the test can prove the AbortController cleanup actually fired.
    // No-op in normal usage (the counter is undefined).
    try {
      if (
        typeof window !== 'undefined' &&
        typeof (window as unknown as { __chatQaAbortCount?: number })
          .__chatQaAbortCount === 'number'
      ) {
        (window as unknown as { __chatQaAbortCount: number }).__chatQaAbortCount += 1;
      }
    } catch {
      /* ignore — never let the probe fail the stream */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Drain complete blocks; keep the trailing partial.
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseSSEBlock(block);
        if (ev) yield ev;
      }
    }
    // If we exited the loop because of an abort, surface it as AbortError
    // rather than a silent end-of-stream.
    if (signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    // Flush any trailing block (rare — most servers terminate cleanly with \n\n).
    if (buffer.trim()) {
      const ev = parseSSEBlock(buffer);
      if (ev) yield ev;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

export const chatQaApi = {
  /**
   * Ask a chat Q&A question. Returns an async iterable of QAEvents. Throws on
   * non-2xx HTTP status (auth / validation), surfaces `error` events for
   * runtime failures inside the stream.
   */
  async *ask(req: AskRequest): AsyncGenerator<QAEvent> {
    const { signal, ...payload } = req;
    const response = await fetch(`${baseUrl()}/api/chat-qa/ask`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      let message = `İstek başarısız: ${response.status}`;
      try {
        const data = (await response.json()) as { error?: { message?: string } };
        if (data.error?.message) message = data.error.message;
      } catch {
        /* ignore */
      }
      yield { type: 'error', code: `HTTP_${response.status}`, message };
      return;
    }
    yield* readSSEStream(response, signal);
  },
};
