/**
 * RepoContextAgent types — input/output for repo analysis.
 */

export interface RepoContextInput {
  owner: string;
  repo: string;
  branch?: string; // default: "main"
  maxDepth?: number; // file tree depth limit, default: 3
}

export interface RepoFile {
  path: string;
  content: string;
  language: string;
  size: number;
}

export interface RepoContext {
  owner: string;
  repo: string;
  branch: string;
  fileTree: string; // tree-style string representation
  summary: string; // AI-generated repo summary
  techStack: string[]; // detected: ["TypeScript", "React", "Fastify", ...]
  keyFiles: RepoFile[]; // README, package.json, main entry points
  structure: {
    totalFiles: number;
    languages: Record<string, number>; // { "ts": 45, "tsx": 12, ... }
    directories: string[]; // top-level dirs
  };
  fetchedAt: string; // ISO timestamp for cache staleness check
}
