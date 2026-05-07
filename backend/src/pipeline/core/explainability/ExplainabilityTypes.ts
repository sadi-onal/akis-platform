// Explainability Interface — Types
// Provides interpretable rationales for multi-agent pipeline decisions.
// Gartner TRiSM Framework (ScienceDirect, 2026) & EU AI Act (2024) transparency.

export interface AgentReasoning {
  agentName: string; // 'scribe' | 'critic' | 'proto' | 'trace'
  timestamp: Date;
  decision: string;
  reasoning: string[];
  assumptions: string[];
  alternatives?: string[];
  confidence: {
    score: number; // 0-100
    factors: string[];
  };
  risks?: string[];
  /**
   * Optional structured findings — populated for the Critic agent only.
   * Allows the UI to group by category (testability / ambiguity /
   * completeness / …) and surface severity + suggestion alongside the
   * description, instead of flattening everything into `reasoning[]`.
   */
  findings?: ReasoningFinding[];
}

export interface ReasoningFinding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  category:
    | 'completeness'
    | 'ambiguity'
    | 'consistency'
    | 'testability'
    | 'spec_compliance'
    | 'security';
  description: string;
  suggestion: string;
  location?: string;
}

export interface AttentionPoint {
  stage: string;
  issue: string;
  severity: 'high' | 'medium' | 'low';
}

export interface PipelineExplanation {
  pipelineId: string;
  stages: AgentReasoning[];
  overallNarrative: string;
  attentionPoints: AttentionPoint[];
}

export interface ExplainabilityConfig {
  verbosity: 'minimal' | 'standard' | 'detailed';
  includeAlternatives: boolean;
  includeRisks: boolean;
}
