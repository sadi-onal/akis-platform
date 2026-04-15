export interface RetrievalFilter {
  workspaceId?: string;
  projectId?: string;
  agentType?: string;
  docType?: 'repo_doc' | 'job_artifact' | 'manual';
  status?: 'proposed' | 'approved' | 'deprecated';
}

export interface RetrievalResult {
  documentId: string;
  chunkId: string;
  content: string;
  score: number;
  keywordScore?: number;
  semanticScore?: number;
  retrievalMethod?: 'keyword' | 'semantic' | 'hybrid';
  provenance: {
    title: string;
    sourcePath?: string;
    commitSha?: string;
    docType: string;
  };
}

export interface RetrievalOptions {
  maxResults?: number;
  maxTokens?: number;
  filters?: RetrievalFilter;
  includeProposed?: boolean;
  semanticWeight?: number;
  keywordWeight?: number;
}

export interface ContextBudget {
  maxTokens: number;
  maxChunks: number;
}
