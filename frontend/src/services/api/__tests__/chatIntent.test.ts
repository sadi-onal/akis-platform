import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  getApiBaseUrl: () => 'http://localhost:3000/api',
}));

const { chatIntentApi } = await import('../chatIntent');

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('chatIntentApi.classify', () => {
  it('POSTs JSON to /api/chat/intent with cookies and headers', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ intent: 'BUILD', confidence: 0.91, reasoning: 'has imperative', threshold: 0.7 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const res = await chatIntentApi.classify({ message: 'build me a todo app', pipelineId: 'p-1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // trailing /api on base url is stripped by baseUrl()
    expect(url).toBe('http://localhost:3000/api/chat/intent');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ message: 'build me a todo app', pipelineId: 'p-1' });
    expect(res.intent).toBe('BUILD');
  });

  it('throws Error with server message when response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'rate-limited' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(chatIntentApi.classify({ message: 'hi' })).rejects.toThrow('rate-limited');
  });

  it('falls back to status-message when error body is unparseable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not json', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(chatIntentApi.classify({ message: 'hi' })).rejects.toThrow(/İstek başarısız: 500/);
  });

  it('falls back to status-message when error object lacks message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: {} }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(chatIntentApi.classify({ message: 'hi' })).rejects.toThrow(/İstek başarısız: 400/);
  });
});

describe('chatIntentApi.override', () => {
  it('PATCHes to /api/chat/intent/:classificationId with overrideIntent body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await chatIntentApi.override('cls-123', 'ASK');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/chat/intent/cls-123');
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ overrideIntent: 'ASK' });
  });

  it('encodes classificationId in the URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await chatIntentApi.override('cls/with spaces', 'CHAT');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('http://localhost:3000/api/chat/intent/cls%2Fwith%20spaces');
  });

  it('throws on non-2xx with the server message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'classification not found' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(chatIntentApi.override('cls-x', 'FEEDBACK')).rejects.toThrow('classification not found');
  });
});
