export interface DiscoveredTask {
  id: string;
  title: string;
  description: string;
  category: 'bug' | 'feature' | 'docs' | 'security' | 'test' | 'refactor';
  priority: 'critical' | 'high' | 'medium' | 'low';
  estimatedMinutes: number;
  affectedFiles: string[];
  complexity: 'simple' | 'moderate' | 'complex';
  rationale: string;
}

export interface TaskDiscoveryInput {
  repoContext: {
    owner: string;
    repo: string;
    files: Array<{ path: string; content?: string }>;
    readme?: string;
    packageJson?: Record<string, unknown>;
    recentCommits?: string[];
  };
  userHint?: string;
  maxTasks?: number;
}

export interface TaskDiscoveryOutput {
  tasks: DiscoveredTask[];
  repoHealth: {
    hasTests: boolean;
    hasCI: boolean;
    hasDocs: boolean;
    hasLinting: boolean;
    codeQualityScore: number; // 0-100
  };
  suggestedPlan: string;
  analysisTime: number;
}
