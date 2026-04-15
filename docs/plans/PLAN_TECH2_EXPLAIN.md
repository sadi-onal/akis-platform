# TECH 2 — Explainability Interface (Agent Reasoning)

## Scientific Basis
Gartner TRiSM Framework (ScienceDirect, 2026) — Explainability Interface provides interpretable rationales for multi-agent decisions. EU AI Act (2024) requires transparency in AI systems.

## File Boundary
`backend/src/pipeline/core/explainability/` (NEW directory only)

## Structure
```
explainability/
├── ExplainabilityService.ts     ← Main service
├── ExplainabilityTypes.ts       ← Types
└── __tests__/
    └── ExplainabilityService.test.ts
```

## ExplainabilityTypes.ts

```typescript
export interface AgentReasoning {
  agentName: string; // 'scribe' | 'critic' | 'proto' | 'trace'
  timestamp: Date;
  decision: string;
  reasoning: string[];
  assumptions: string[];
  alternatives?: string[];
  confidence: {
    score: number;
    factors: string[];
  };
  risks?: string[];
}

export interface PipelineExplanation {
  pipelineId: string;
  stages: AgentReasoning[];
  overallNarrative: string;
  attentionPoints: Array<{
    stage: string;
    issue: string;
    severity: 'high' | 'medium' | 'low';
  }>;
}

export interface ExplainabilityConfig {
  verbosity: 'minimal' | 'standard' | 'detailed';
  includeAlternatives: boolean;
  includeRisks: boolean;
}
```

## ExplainabilityService.ts Spec

- `addReasoning(pipelineId: string, reasoning: AgentReasoning): void`
- `getExplanation(pipelineId: string): PipelineExplanation`
- `generateNarrative(pipelineId: string): string` — NO LLM — template-based
  - Template: "Scribe, kullanıcının '{idea}' fikrini analiz etti ve {confidence}% güvenle bir spesifikasyon üretti. {assumptions_count} varsayım yapıldı..."
- `getAttentionPoints(pipelineId: string): AttentionPoint[]`
  - Low critic score → attention point
  - Security issues → attention point
  - Fix loop triggered → attention point
- In-memory storage: `Map<string, AgentReasoning[]>`

## Tests (minimum 8 cases)
1. Add single reasoning, retrieve it
2. Add multiple stages, get full explanation
3. Generate narrative with template
4. Attention points for low confidence scores
5. Attention points for security-related findings
6. Empty pipeline returns empty explanation
7. Multiple pipelines stored independently
8. Narrative includes assumption count and confidence

## CONSTRAINTS
- Do NOT touch any files outside `backend/src/pipeline/core/explainability/`
- Do NOT modify .env files
- Run `pnpm -C backend typecheck` after implementation
- Run tests with `pnpm -C backend test:unit -- --testPathPattern explainability`
