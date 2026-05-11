import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  getApiBaseUrl: () => 'http://localhost:3000/api',
}));

const { attachDocumentsToChat } = await import('../chatAttach');

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeFile(name: string, body = 'hi'): File {
  return new File([body], name, { type: 'text/plain' });
}

describe('attachDocumentsToChat', () => {
  it('returns an empty result set without hitting the network when files is empty', async () => {
    const res = await attachDocumentsToChat('chat-1', []);
    expect(res).toEqual({ results: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs FormData with all files to /api/chats/:id/attach (strips trailing /api)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ filename: 'a.txt', documentId: 'd1', chunksCreated: 1, status: 'ok' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await attachDocumentsToChat('chat-1', [makeFile('a.txt'), makeFile('b.md')]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // base URL has trailing /api which should be stripped
    expect(url).toBe('http://localhost:3000/api/chats/chat-1/attach');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.getAll('files')).toHaveLength(2);
    expect(res.results[0].filename).toBe('a.txt');
  });

  it('throws an Error with the server-supplied message on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(attachDocumentsToChat('chat-1', [makeFile('a.txt')])).rejects.toThrow('quota exceeded');
  });

  it('falls back to "Dosya yükleme başarısız: <status>" when error body is unparseable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    );
    await expect(attachDocumentsToChat('chat-1', [makeFile('a.txt')])).rejects.toThrow(/Dosya yükleme başarısız: 500/);
  });

  it('falls back to default message when error body lacks message field', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: {} }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(attachDocumentsToChat('chat-1', [makeFile('a.txt')])).rejects.toThrow(/Dosya yükleme başarısız: 400/);
  });
});
