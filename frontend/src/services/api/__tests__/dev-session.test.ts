import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('../HttpClient', () => ({
  HttpClient: class MockHttpClient {
    get = mockGet;
    post = mockPost;
    patch = mockPatch;
    delete = mockDelete;
  },
}));

vi.mock('../config', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
}));

const { devSessionApi } = await import('../dev-session');

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('devSessionApi', () => {
  it('startSession POSTs /api/pipelines/:id/dev/start', async () => {
    mockPost.mockResolvedValueOnce({ sessionId: 's-1', fileTree: [], messages: [] });
    const res = await devSessionApi.startSession('p-1');
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-1/dev/start');
    expect(res.sessionId).toBe('s-1');
  });

  it('getSession GETs /api/pipelines/:id/dev/session', async () => {
    mockGet.mockResolvedValueOnce({ session: {}, messages: [] });
    await devSessionApi.getSession('p-1');
    expect(mockGet).toHaveBeenCalledWith('/api/pipelines/p-1/dev/session');
  });

  it('chat uses raw fetch with JSON body and credentials include', async () => {
    const fakeResponse = new Response('ok', { status: 200 });
    fetchMock.mockResolvedValueOnce(fakeResponse);

    const res = await devSessionApi.chat('p-1', 's-1', 'hello');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/pipelines/p-1/dev/chat');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ sessionId: 's-1', message: 'hello' });
    expect(res).toBe(fakeResponse);
  });

  it('pushChanges POSTs sessionId + messageId', async () => {
    mockPost.mockResolvedValueOnce({ commitSha: 'sha', commitUrl: 'https://x' });
    const res = await devSessionApi.pushChanges('p-1', 's-1', 'm-1');
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-1/dev/push', {
      sessionId: 's-1',
      messageId: 'm-1',
    });
    expect(res.commitSha).toBe('sha');
  });

  it('rejectChanges POSTs to /reject', async () => {
    mockPost.mockResolvedValueOnce({ ok: true });
    await devSessionApi.rejectChanges('p-1', 's-1', 'm-1');
    expect(mockPost).toHaveBeenCalledWith('/api/pipelines/p-1/dev/reject', {
      sessionId: 's-1',
      messageId: 'm-1',
    });
  });

  it('chat returns the raw response even on non-2xx (SSE caller decides)', async () => {
    const errResponse = new Response('err', { status: 500 });
    fetchMock.mockResolvedValueOnce(errResponse);
    const res = await devSessionApi.chat('p-1', 's-1', 'x');
    expect(res.status).toBe(500);
  });
});
