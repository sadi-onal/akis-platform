import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock HttpClient before importing target module ──
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

const { agentsApi } = await import('../agents');

describe('agentsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listAgents', () => {
    it('returns the in-memory agent catalogue', async () => {
      const agents = await agentsApi.listAgents();
      expect(agents).toHaveLength(3);
      expect(agents.map((a) => a.id).sort()).toEqual(['proto', 'scribe', 'trace']);
      expect(agents[0]).toHaveProperty('name');
      expect(agents[0]).toHaveProperty('description');
      expect(agents[0]).toHaveProperty('capabilities');
      // No HTTP call should be made for the static list
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('runAgent', () => {
    it('POSTs the request to /api/agents/jobs with credentials', async () => {
      mockPost.mockResolvedValueOnce({ jobId: 'j-1', state: 'pending' });
      const res = await agentsApi.runAgent({ type: 'scribe', payload: { x: 1 } });
      expect(mockPost).toHaveBeenCalledWith(
        '/api/agents/jobs',
        { type: 'scribe', payload: { x: 1 } },
        { credentials: 'include' },
      );
      expect(res).toEqual({ jobId: 'j-1', state: 'pending' });
    });

    it('forwards runtimeOverride and requiresStrictValidation', async () => {
      mockPost.mockResolvedValueOnce({ jobId: 'j-2', state: 'pending' });
      await agentsApi.runAgent({
        type: 'proto',
        payload: { repo: 'foo' },
        runtimeOverride: { runtimeProfile: 'creative', temperatureValue: 0.7, commandLevel: 3 },
        requiresStrictValidation: true,
      });
      expect(mockPost.mock.calls[0][1]).toMatchObject({
        type: 'proto',
        runtimeOverride: { runtimeProfile: 'creative', temperatureValue: 0.7, commandLevel: 3 },
        requiresStrictValidation: true,
      });
    });

    it('lets errors bubble up', async () => {
      mockPost.mockRejectedValueOnce(new Error('boom'));
      await expect(agentsApi.runAgent({ type: 'scribe', payload: {} })).rejects.toThrow('boom');
    });
  });

  describe('getJob', () => {
    it('builds the URL without include when no options provided', async () => {
      mockGet.mockResolvedValueOnce({ id: 'j-1', type: 'scribe', state: 'completed' });
      await agentsApi.getJob('j-1');
      expect(mockGet).toHaveBeenCalledWith('/api/agents/jobs/j-1', { credentials: 'include' });
    });

    it('joins multiple include flags with commas', async () => {
      mockGet.mockResolvedValueOnce({ id: 'j-1' });
      await agentsApi.getJob('j-1', { include: ['plan', 'audit', 'trace'] });
      expect(mockGet).toHaveBeenCalledWith(
        '/api/agents/jobs/j-1?include=plan,audit,trace',
        { credentials: 'include' },
      );
    });

    it('omits the include query when array is empty', async () => {
      mockGet.mockResolvedValueOnce({ id: 'j-1' });
      await agentsApi.getJob('j-1', { include: [] });
      expect(mockGet).toHaveBeenCalledWith('/api/agents/jobs/j-1', { credentials: 'include' });
    });
  });

  describe('getRunningJobs', () => {
    it('hits /api/agents/jobs/running', async () => {
      mockGet.mockResolvedValueOnce({ jobs: [] });
      const res = await agentsApi.getRunningJobs();
      expect(mockGet).toHaveBeenCalledWith('/api/agents/jobs/running', { credentials: 'include' });
      expect(res).toEqual({ jobs: [] });
    });
  });

  describe('cancelJob', () => {
    it('POSTs to /api/agents/jobs/:id/cancel with empty body', async () => {
      mockPost.mockResolvedValueOnce({ id: 'j-1', state: 'cancelled', message: 'ok' });
      const res = await agentsApi.cancelJob('j-1');
      expect(mockPost).toHaveBeenCalledWith(
        '/api/agents/jobs/j-1/cancel',
        {},
        { credentials: 'include' },
      );
      expect(res.state).toBe('cancelled');
    });
  });

  describe('listJobs', () => {
    it('omits query string when no options', async () => {
      mockGet.mockResolvedValueOnce({ items: [], nextCursor: null });
      await agentsApi.listJobs();
      expect(mockGet).toHaveBeenCalledWith('/api/agents/jobs', { credentials: 'include' });
    });

    it('encodes limit when provided', async () => {
      mockGet.mockResolvedValueOnce({ items: [], nextCursor: null });
      await agentsApi.listJobs({ limit: 25 });
      expect(mockGet).toHaveBeenCalledWith('/api/agents/jobs?limit=25', { credentials: 'include' });
    });

    it('treats limit:0 as falsy and skips the param', async () => {
      mockGet.mockResolvedValueOnce({ items: [], nextCursor: null });
      await agentsApi.listJobs({ limit: 0 });
      expect(mockGet).toHaveBeenCalledWith('/api/agents/jobs', { credentials: 'include' });
    });
  });
});
