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

const { agentActivitiesApi } = await import('../agent-activities');

describe('agentActivitiesApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list', () => {
    it('uses default limit=100 and unwraps response', async () => {
      mockGet.mockResolvedValueOnce({
        activities: [{ id: 'a', pipelineId: 'p', agent: 'scribe', action: 'x', inputTokens: 1, outputTokens: 2, createdAt: 'now' }],
      });
      const res = await agentActivitiesApi.list();
      expect(mockGet).toHaveBeenCalledWith('/api/agent-activities?limit=100');
      expect(res).toHaveLength(1);
      expect(res[0].id).toBe('a');
    });

    it('forwards custom limit', async () => {
      mockGet.mockResolvedValueOnce({ activities: [] });
      await agentActivitiesApi.list(25);
      expect(mockGet).toHaveBeenCalledWith('/api/agent-activities?limit=25');
    });

    it('falls back to empty array when activities is missing', async () => {
      mockGet.mockResolvedValueOnce({});
      const res = await agentActivitiesApi.list();
      expect(res).toEqual([]);
    });
  });

  describe('getByPipeline', () => {
    it('GETs /api/agent-activities/:pipelineId', async () => {
      mockGet.mockResolvedValueOnce({ activities: [] });
      await agentActivitiesApi.getByPipeline('pid');
      expect(mockGet).toHaveBeenCalledWith('/api/agent-activities/pid');
    });

    it('falls back to empty array for missing field', async () => {
      mockGet.mockResolvedValueOnce({});
      const res = await agentActivitiesApi.getByPipeline('pid');
      expect(res).toEqual([]);
    });

    it('lets errors bubble', async () => {
      mockGet.mockRejectedValueOnce(new Error('404'));
      await expect(agentActivitiesApi.getByPipeline('pid')).rejects.toThrow('404');
    });
  });
});
