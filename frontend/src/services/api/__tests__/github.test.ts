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

const { githubApi } = await import('../github');

describe('githubApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listRepos', () => {
    it('unwraps res.repos when present', async () => {
      mockGet.mockResolvedValueOnce({
        repos: [{ name: 'a', fullName: 'me/a', private: false, url: 'u', updatedAt: 'now' }],
      });
      const res = await githubApi.listRepos();
      expect(mockGet).toHaveBeenCalledWith('/api/github/repos');
      expect(res).toHaveLength(1);
      expect(res[0].fullName).toBe('me/a');
    });

    it('falls back to empty array when repos is missing', async () => {
      mockGet.mockResolvedValueOnce({});
      const res = await githubApi.listRepos();
      expect(res).toEqual([]);
    });
  });

  describe('getRepoContext', () => {
    it('GETs /api/github/repos/:owner/:repo/context without branch when undefined', async () => {
      mockGet.mockResolvedValueOnce({ context: { owner: 'me', repo: 'r' } });
      await githubApi.getRepoContext('me', 'r');
      expect(mockGet).toHaveBeenCalledWith('/api/github/repos/me/r/context');
    });

    it('appends encoded branch query when provided', async () => {
      mockGet.mockResolvedValueOnce({ context: { owner: 'me', repo: 'r', branch: 'feat/x y' } });
      await githubApi.getRepoContext('me', 'r', 'feat/x y');
      expect(mockGet).toHaveBeenCalledWith('/api/github/repos/me/r/context?branch=feat%2Fx%20y');
    });

    it('returns the unwrapped context', async () => {
      const ctx = {
        owner: 'me',
        repo: 'r',
        branch: 'main',
        fileTree: '',
        summary: '',
        techStack: [],
        keyFiles: [],
        structure: { totalFiles: 0, languages: {}, directories: [] },
        fetchedAt: 'now',
      };
      mockGet.mockResolvedValueOnce({ context: ctx });
      const res = await githubApi.getRepoContext('me', 'r', 'main');
      expect(res).toEqual(ctx);
    });

    it('lets errors bubble', async () => {
      mockGet.mockRejectedValueOnce(new Error('GITHUB_NOT_CONNECTED'));
      await expect(githubApi.getRepoContext('me', 'r')).rejects.toThrow('GITHUB_NOT_CONNECTED');
    });
  });
});
