/**
 * Unit tests for chatQaApi (F-09 / FR-10).
 *
 * Covers the SSE block parser + the async-iterable wrapper around fetch.
 * `fetch` is stubbed with a ReadableStream so we don't need a real server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chatQaApi, type QAEvent } from '../chatQa';

function sse(blocks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const b of blocks) controller.enqueue(encoder.encode(b));
      controller.close();
    },
  });
}

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(response: Response) {
  globalThis.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

beforeEach(() => {
  // Avoid leaking mocks between tests.
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('chatQaApi.ask', () => {
  it('yields chunk → done events parsed from SSE', async () => {
    mockFetch(
      new Response(
        sse([
          'event: chunk\ndata: {"text":"Şu an "}\n\n',
          'event: chunk\ndata: {"text":"projende **3 dosya** var."}\n\n',
          'event: done\ndata: {"answer":"Şu an projende **3 dosya** var.","citations":[],"needsBuild":false}\n\n',
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const events: QAEvent[] = [];
    for await (const ev of chatQaApi.ask({ message: 'kaç dosya?' })) {
      events.push(ev);
    }
    expect(events).toEqual([
      { type: 'chunk', text: 'Şu an ' },
      { type: 'chunk', text: 'projende **3 dosya** var.' },
      {
        type: 'done',
        answer: 'Şu an projende **3 dosya** var.',
        citations: [],
        needsBuild: false,
      },
    ]);
  });

  it('parses citation events into the {type:"citation"} shape', async () => {
    mockFetch(
      new Response(
        sse([
          'event: citation\ndata: {"source":"spec","excerpt":"Bakkal — stok takibi","refKey":"spec:Bakkal"}\n\n',
          'event: done\ndata: {"answer":"...","citations":[{"source":"spec","excerpt":"x"}],"needsBuild":true}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const events: QAEvent[] = [];
    for await (const ev of chatQaApi.ask({ message: 'merhaba' })) {
      events.push(ev);
    }
    expect(events[0]).toEqual({
      type: 'citation',
      citation: { source: 'spec', excerpt: 'Bakkal — stok takibi', refKey: 'spec:Bakkal' },
    });
    expect(events[1]).toMatchObject({ type: 'done', needsBuild: true });
  });

  it('handles a chunk split across multiple TCP frames (partial buffer)', async () => {
    mockFetch(
      new Response(
        sse([
          'event: chunk\n',
          'data: {"text":"hi"}\n\n',
          'event: done\ndata: {"answer":"hi","citations":[],"needsBuild":false}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const events: QAEvent[] = [];
    for await (const ev of chatQaApi.ask({ message: 'x' })) {
      events.push(ev);
    }
    expect(events[0]).toEqual({ type: 'chunk', text: 'hi' });
    expect(events[1].type).toBe('done');
  });

  it('skips heartbeat / comment lines', async () => {
    mockFetch(
      new Response(
        sse([
          ': heartbeat\n\n',
          'event: chunk\ndata: {"text":"ok"}\n\n',
          'event: done\ndata: {"answer":"ok","citations":[],"needsBuild":false}\n\n',
        ]),
        { status: 200 },
      ),
    );
    const events: QAEvent[] = [];
    for await (const ev of chatQaApi.ask({ message: 'x' })) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(['chunk', 'done']);
  });

  it('yields an error event when the response is non-2xx', async () => {
    mockFetch(
      new Response(JSON.stringify({ error: { message: 'oturum süresi doldu' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const events: QAEvent[] = [];
    for await (const ev of chatQaApi.ask({ message: 'soru' })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'HTTP_401',
      message: 'oturum süresi doldu',
    });
  });

  it('yields a synthetic error when response body is missing', async () => {
    // Hand-roll a response without a body (mimics a network glitch).
    const fakeResponse = {
      ok: true,
      status: 200,
      body: null,
      json: async () => ({}),
    } as unknown as Response;
    globalThis.fetch = vi.fn().mockResolvedValue(fakeResponse) as unknown as typeof fetch;
    const events: QAEvent[] = [];
    for await (const ev of chatQaApi.ask({ message: 'soru' })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });
});
