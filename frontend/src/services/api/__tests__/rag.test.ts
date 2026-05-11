import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { ragApi } = await import('../rag');

describe('ragApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getStatus GETs /api/rag/status', async () => {
    mockGet.mockResolvedValueOnce({ configured: true, healthy: true });
    const res = await ragApi.getStatus();
    expect(mockGet).toHaveBeenCalledWith('/api/rag/status');
    expect(res.configured).toBe(true);
  });

  it('query POSTs payload to /api/rag/query', async () => {
    mockPost.mockResolvedValueOnce({ question: 'q', answer: 'a', sources: [], model: 'm', backend: 'b' });
    await ragApi.query({ question: 'hello?', top_k: 5, temperature: 0.2 });
    expect(mockPost).toHaveBeenCalledWith('/api/rag/query', {
      question: 'hello?',
      top_k: 5,
      temperature: 0.2,
    });
  });

  it('search POSTs payload to /api/rag/search', async () => {
    mockPost.mockResolvedValueOnce({ query: 'q', results: [] });
    await ragApi.search({ query: 'lookup' });
    expect(mockPost).toHaveBeenCalledWith('/api/rag/search', { query: 'lookup' });
  });

  it('hybridSearch POSTs to /api/knowledge/retrieval/hybrid', async () => {
    mockPost.mockResolvedValueOnce({ query: 'q', count: 0, results: [] });
    await ragApi.hybridSearch({ query: 'hybrid', topK: 3, keywordWeight: 0.5 });
    expect(mockPost).toHaveBeenCalledWith('/api/knowledge/retrieval/hybrid', {
      query: 'hybrid',
      topK: 3,
      keywordWeight: 0.5,
    });
  });

  it('webSearch POSTs to /api/rag/web-search', async () => {
    mockPost.mockResolvedValueOnce({
      query: 'q',
      web_results: [],
      learned: false,
      chunks_added: 0,
      total_chunks: 0,
      answer: '',
      sources: [],
      source_name: '',
    });
    await ragApi.webSearch({ query: 'foo', max_results: 5, auto_learn: true });
    expect(mockPost).toHaveBeenCalledWith('/api/rag/web-search', {
      query: 'foo',
      max_results: 5,
      auto_learn: true,
    });
  });

  it('learn POSTs to /api/rag/learn', async () => {
    mockPost.mockResolvedValueOnce({ message: 'ok', chunks_added: 1, total_chunks: 10, source: 's', char_count: 100 });
    await ragApi.learn({ text: 'remember this', source_name: 'manual', chunk_size: 500 });
    expect(mockPost).toHaveBeenCalledWith('/api/rag/learn', {
      text: 'remember this',
      source_name: 'manual',
      chunk_size: 500,
    });
  });

  it('getStats GETs /api/rag/stats', async () => {
    mockGet.mockResolvedValueOnce({ status: 'ok' });
    await ragApi.getStats();
    expect(mockGet).toHaveBeenCalledWith('/api/rag/stats');
  });

  describe('listKnowledgeDocuments', () => {
    it('omits query string when no params', async () => {
      mockGet.mockResolvedValueOnce({ items: [], total: 0 });
      await ragApi.listKnowledgeDocuments();
      expect(mockGet).toHaveBeenCalledWith('/api/knowledge/documents');
    });

    it('builds query string with status, limit, offset', async () => {
      mockGet.mockResolvedValueOnce({ items: [], total: 0 });
      await ragApi.listKnowledgeDocuments({ status: 'approved', limit: 10, offset: 20 });
      expect(mockGet).toHaveBeenCalledWith(
        '/api/knowledge/documents?status=approved&limit=10&offset=20',
      );
    });

    it('handles only some params provided', async () => {
      mockGet.mockResolvedValueOnce({ items: [], total: 0 });
      await ragApi.listKnowledgeDocuments({ limit: 5 });
      expect(mockGet).toHaveBeenCalledWith('/api/knowledge/documents?limit=5');
    });

    it('keeps offset 0 (typeof number guard) in the URL', async () => {
      mockGet.mockResolvedValueOnce({ items: [], total: 0 });
      await ragApi.listKnowledgeDocuments({ offset: 0 });
      expect(mockGet).toHaveBeenCalledWith('/api/knowledge/documents?offset=0');
    });
  });

  it('approveKnowledgeDocument POSTs to /approve route', async () => {
    mockPost.mockResolvedValueOnce({ ok: true, document: null });
    await ragApi.approveKnowledgeDocument('doc-1');
    expect(mockPost).toHaveBeenCalledWith('/api/knowledge/documents/doc-1/approve', {});
  });

  it('deprecateKnowledgeDocument POSTs to /deprecate route', async () => {
    mockPost.mockResolvedValueOnce({ ok: true, document: null });
    await ragApi.deprecateKnowledgeDocument('doc-1');
    expect(mockPost).toHaveBeenCalledWith('/api/knowledge/documents/doc-1/deprecate', {});
  });

  it('uploadKnowledgeDocument POSTs payload to upload route', async () => {
    mockPost.mockResolvedValueOnce({
      ok: true,
      result: { documentId: 'd', title: 't', chunksCreated: 3, isNew: true },
      document: null,
    });
    const payload = { title: 't', content: 'hello' };
    await ragApi.uploadKnowledgeDocument(payload);
    expect(mockPost).toHaveBeenCalledWith('/api/knowledge/documents/upload', payload);
  });

  it('syncReleaseSignal POSTs to /api/knowledge/signals/releases/sync', async () => {
    mockPost.mockResolvedValueOnce({ ok: true, owner: 'me', repo: 'r', persisted: true, result: {} });
    await ragApi.syncReleaseSignal({ owner: 'me', repo: 'r' });
    expect(mockPost).toHaveBeenCalledWith(
      '/api/knowledge/signals/releases/sync',
      { owner: 'me', repo: 'r' },
    );
  });

  it('syncCveSignals POSTs to /api/knowledge/signals/cve/sync', async () => {
    mockPost.mockResolvedValueOnce({ ok: true, summary: {} });
    await ragApi.syncCveSignals({ advisories: [] });
    expect(mockPost).toHaveBeenCalledWith(
      '/api/knowledge/signals/cve/sync',
      { advisories: [] },
    );
  });

  it('runEvaluation POSTs to /api/rag/evaluation/run', async () => {
    mockPost.mockResolvedValueOnce({ runId: 'r', executedAt: 'now', config: {}, metrics: {}, queries: [] });
    await ragApi.runEvaluation({ queries: ['q1'], topK: 2 });
    expect(mockPost).toHaveBeenCalledWith(
      '/api/rag/evaluation/run',
      { queries: ['q1'], topK: 2 },
    );
  });

  it('lets HttpClient errors bubble (e.g. status fetch)', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'));
    await expect(ragApi.getStatus()).rejects.toThrow('boom');
  });
});
