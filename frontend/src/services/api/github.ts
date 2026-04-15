/**
 * GitHub API client — wraps backend GitHub endpoints.
 */
import { HttpClient } from './HttpClient';
import { getApiBaseUrl } from './config';

const http = new HttpClient(getApiBaseUrl());

export interface GitHubRepo {
  name: string;
  fullName: string;
  private: boolean;
  url: string;
  updatedAt: string;
}

export interface RepoContext {
  owner: string;
  repo: string;
  branch: string;
  fileTree: string;
  summary: string;
  techStack: string[];
  keyFiles: Array<{ path: string; content: string; language: string; size: number }>;
  structure: {
    totalFiles: number;
    languages: Record<string, number>;
    directories: string[];
  };
  fetchedAt: string;
}

export const githubApi = {
  listRepos: async (): Promise<GitHubRepo[]> => {
    const res = await http.get<{ repos: GitHubRepo[] }>('/api/github/repos');
    return res.repos ?? [];
  },

  getRepoContext: async (owner: string, repo: string, branch?: string): Promise<RepoContext> => {
    const params = branch ? `?branch=${encodeURIComponent(branch)}` : '';
    const res = await http.get<{ context: RepoContext }>(`/api/github/repos/${owner}/${repo}/context${params}`);
    return res.context;
  },
};
