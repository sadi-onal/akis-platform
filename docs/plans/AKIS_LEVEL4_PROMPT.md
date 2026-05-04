# AKIS Level 4 Evolution — 6 Teknoloji Implementasyonu

## Bu promptu Claude Code'a yapıştır:

```
Read CLAUDE.md first. Then read docs/AKIS_VISION.md (or docs/plans/FINAL_REPORT.md for current state).

You will implement 3 technologies from AKIS's Vision document (Section 5) as production code, and 3 as architectural foundations. These are scientifically validated gaps identified through METR 2025, McKinsey 2026, Gartner TRiSM, and academic research (Reflexion, Self-Refine, LLMloop).

IMPORTANT: Launch 3 parallel Claude Code agents for the code tasks (Tech 1, 2, 5). Tech 3, 4, 6 are config/docs only — do them yourself sequentially after the parallel agents finish.

## YASAK KURALLAR (TÜM AGENT'LAR)
- .env dosyalarına ASLA dokunma
- Mevcut çalışan testleri kırma
- Her değişiklik sonrası pnpm -C backend typecheck çalıştır
- Agent'lar birbirinin dosyalarına DOKUNMAZ

---

## ADIM 0 — DISCOVERY

```bash
cd ~/Projects/akisflow
cat CLAUDE.md
ls backend/src/pipeline/agents/
ls backend/src/pipeline/core/
cat backend/src/pipeline/agents/critic/CriticAgent.ts | head -50
cat backend/src/pipeline/agents/critic/CriticTypes.ts
cat backend/src/pipeline/core/fix-loop/FixLoopTypes.ts
cat backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | head -100
cat backend/src/services/ai/AIService.ts | head -80
cd backend && pnpm typecheck && echo "BASELINE OK"
```

---

## ADIM 1 — Create 3 sub-plan files and launch parallel agents

### SUB-PLAN: TECH 1 — Deterministic Validator (AST + Lint + Type Check)

**File boundary:** `backend/src/pipeline/core/validator/` (NEW directory only)

**Scientific basis:** arXiv:2601.19106 — AST analysis achieves 100% precision, 87.6% recall for detecting hallucinated API calls and wrong function signatures in LLM-generated code.

**What to build:**
```
validator/
├── DeterministicValidator.ts    ← Main service
├── ValidatorTypes.ts            ← Types
├── checks/
│   ├── syntax-check.ts          ← Parse code, check for syntax errors
│   ├── import-check.ts          ← Verify all imports resolve to real packages
│   ├── type-consistency.ts      ← Check type annotations are internally consistent
│   └── security-check.ts        ← OWASP basic checks (hardcoded secrets, path traversal)
└── __tests__/
    └── DeterministicValidator.test.ts
```

**ValidatorTypes.ts:**
```typescript
export interface ValidationInput {
  files: Array<{
    path: string;
    content: string;
    language: string; // 'typescript' | 'javascript' | 'json' | 'html' | 'css'
  }>;
  spec?: unknown; // StructuredSpec for compliance checking
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  category: 'syntax' | 'import' | 'type' | 'security' | 'structure';
  file: string;
  line?: number;
  message: string;
  rule: string; // e.g., 'no-hardcoded-secrets', 'invalid-import', 'syntax-error'
}

export interface ValidationResult {
  passed: boolean;
  score: number; // 0-100
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    filesChecked: number;
    checksRun: string[];
  };
}
```

**DeterministicValidator.ts:**
- `validate(input: ValidationInput): ValidationResult`
- NO LLM calls — purely deterministic. This is the anchor between probabilistic steps.
- Syntax check: Try to parse each file. For TS/JS use a simple regex-based parser (don't require ts-compiler, keep it lightweight). Check matching braces, valid JSON, valid HTML structure.
- Import check: Extract import statements, verify against a known-packages list (top 500 npm packages hardcoded). Flag unknown packages as warnings. Flag relative imports that reference non-existent files as errors.
- Security check: Regex patterns for hardcoded secrets (API keys, passwords, tokens in code), SQL injection patterns, eval() usage, innerHTML without sanitization.
- Structure check: Every file must have content. Package.json must be valid JSON. Entry point file must exist.
- Score = 100 - (errors * 10) - (warnings * 3) - (infos * 1), minimum 0
- passed = score >= 60 AND errors === 0

**Tests:** At least 10 cases — clean code passes, syntax errors caught, hardcoded secrets caught, invalid imports caught, security issues caught, score calculation correct.

---

### SUB-PLAN: TECH 2 — Explainability Interface (Agent Reasoning)

**File boundary:** `backend/src/pipeline/core/explainability/` (NEW directory only)

**Scientific basis:** Gartner TRiSM Framework (ScienceDirect, 2026) — Explainability Interface provides interpretable rationales for multi-agent decisions. EU AI Act (2024) requires transparency in AI systems.

**What to build:**
```
explainability/
├── ExplainabilityService.ts     ← Main service
├── ExplainabilityTypes.ts       ← Types
└── __tests__/
    └── ExplainabilityService.test.ts
```

**ExplainabilityTypes.ts:**
```typescript
export interface AgentReasoning {
  agentName: string; // 'scribe' | 'critic' | 'proto' | 'trace'
  timestamp: Date;
  /** What the agent decided */
  decision: string;
  /** Why — key factors that led to this decision */
  reasoning: string[];
  /** What assumptions were made */
  assumptions: string[];
  /** What alternatives were considered */
  alternatives?: string[];
  /** Confidence level and why */
  confidence: {
    score: number;
    factors: string[]; // e.g., "Spec has clear AC → +15", "Ambiguous requirements → -10"
  };
  /** What could go wrong */
  risks?: string[];
}

export interface PipelineExplanation {
  pipelineId: string;
  stages: AgentReasoning[];
  overallNarrative: string; // Human-readable story of what happened and why
  /** Key decision points where human attention is needed */
  attentionPoints: Array<{
    stage: string;
    issue: string;
    severity: 'high' | 'medium' | 'low';
  }>;
}

export interface ExplainabilityConfig {
  /** How verbose should explanations be */
  verbosity: 'minimal' | 'standard' | 'detailed';
  /** Include alternatives considered */
  includeAlternatives: boolean;
  /** Include risk assessment */
  includeRisks: boolean;
}
```

**ExplainabilityService.ts:**
- `addReasoning(pipelineId, reasoning: AgentReasoning): void` — each agent calls this after its work
- `getExplanation(pipelineId): PipelineExplanation` — returns full pipeline explanation
- `generateNarrative(pipelineId): string` — generates human-readable story (NO LLM call — template-based)
  - Template: "Scribe, kullanıcının '{idea}' fikrini analiz etti ve {confidence}% güvenle bir spesifikasyon üretti. {assumptions_count} varsayım yapıldı. CriticSpec bu spesifikasyonu {critic_score}/100 puanla değerlendirdi ve {findings_count} bulgu raporladı..."
- `getAttentionPoints(pipelineId): AttentionPoint[]` — surfaces where human should look
  - Low critic score → attention point
  - Security issues from validator → attention point
  - Fix loop triggered → attention point
- In-memory storage (Map<string, AgentReasoning[]>), can be moved to DB later

**Integration hint (DO NOT modify other files — integration will be done separately):**
- Each agent will call `explainabilityService.addReasoning()` after completing work
- The reasoning data will come from agent prompts that include "explain your reasoning" instructions

**Tests:** At least 8 cases — add reasoning, generate narrative, attention points for low scores, attention points for security issues, multiple stages.

---

### SUB-PLAN: TECH 5 — Security Regression Gate

**File boundary:** `backend/src/pipeline/core/security-gate/` (NEW directory only)

**Scientific basis:** LLMloop (ICSME 2025) — iterative code generation caused 37.6% increase in critical vulnerabilities after 5 iterations with GPT-4o. A "no regression" gate is essential.

**What to build:**
```
security-gate/
├── SecurityGate.ts              ← Main service
├── SecurityGateTypes.ts         ← Types
└── __tests__/
    └── SecurityGate.test.ts
```

**SecurityGateTypes.ts:**
```typescript
export interface SecurityScanResult {
  timestamp: Date;
  iteration: number;
  issues: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: string; // 'hardcoded-secret' | 'injection' | 'xss' | 'path-traversal' | 'eval'
    file: string;
    line?: number;
    description: string;
  }>;
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

export interface SecurityGateDecision {
  allowed: boolean;
  reason: string;
  currentScan: SecurityScanResult;
  previousScan?: SecurityScanResult;
  regression?: {
    newIssues: number;
    resolvedIssues: number;
    netChange: number;
  };
}
```

**SecurityGate.ts:**
- `scan(files: Array<{path: string, content: string}>): SecurityScanResult` — runs security checks (reuse patterns from DeterministicValidator's security-check.ts but more comprehensive)
- `evaluate(currentScan: SecurityScanResult, previousScan?: SecurityScanResult): SecurityGateDecision`
  - First iteration (no previous): allowed if critical === 0
  - Subsequent iterations: allowed if critical <= previous.critical AND high <= previous.high (no regression rule)
  - If regression detected: allowed = false, reason explains what got worse
- `checkRegression(current: SecurityScanResult, previous: SecurityScanResult): boolean` — true if security degraded

**Security patterns to detect:**
- Hardcoded secrets: `/(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]+['"]/gi`
- SQL injection: `/(?:query|exec|execute)\s*\([^)]*\+/gi` (string concatenation in queries)
- XSS: `/innerHTML\s*=|dangerouslySetInnerHTML|document\.write/gi`
- Path traversal: `/\.\.\//g` in file operations
- Eval: `/\beval\s*\(|new\s+Function\s*\(/gi`
- Insecure HTTP: `/http:\/\/(?!localhost)/gi`

**Tests:** At least 8 cases — clean code passes, hardcoded secret detected, regression blocked, improvement allowed, first iteration with criticals blocked, scan counts correct.

---

## ADIM 2 — LAUNCH PARALLEL AGENTS

Write the 3 sub-plans to docs/plans/ then launch:

```bash
PROJECT_DIR=~/Projects/akisflow

# Tech 1 — Deterministic Validator
claude --model claude-opus-4-6-20250710 --max-turns 80 -p \
  "Proje: $PROJECT_DIR. Read CLAUDE.md. Create backend/src/pipeline/core/validator/ with DeterministicValidator, ValidatorTypes, checks/ (syntax, import, security, type-consistency), and tests. See docs/plans/PLAN_TECH1_VALIDATOR.md for full spec. Purely deterministic — NO LLM calls. Run typecheck + tests. Write report to docs/plans/REPORT_TECH1.md. .env OFF LIMITS." \
  > /tmp/akis_tech1.log 2>&1 &

# Tech 2 — Explainability
claude --model claude-opus-4-6-20250710 --max-turns 60 -p \
  "Proje: $PROJECT_DIR. Read CLAUDE.md. Create backend/src/pipeline/core/explainability/ with ExplainabilityService, ExplainabilityTypes, and tests. See docs/plans/PLAN_TECH2_EXPLAIN.md for full spec. Template-based narratives, no LLM. Run typecheck + tests. Write report to docs/plans/REPORT_TECH2.md. .env OFF LIMITS." \
  > /tmp/akis_tech2.log 2>&1 &

# Tech 5 — Security Gate
claude --model claude-opus-4-6-20250710 --max-turns 60 -p \
  "Proje: $PROJECT_DIR. Read CLAUDE.md. Create backend/src/pipeline/core/security-gate/ with SecurityGate, SecurityGateTypes, and tests. See docs/plans/PLAN_TECH5_SECURITY.md for full spec. No-regression rule for fix loop. Run typecheck + tests. Write report to docs/plans/REPORT_TECH5.md. .env OFF LIMITS." \
  > /tmp/akis_tech5.log 2>&1 &

wait
echo "All 3 agents completed"
```

---

## ADIM 3 — CHECK REPORTS

```bash
for r in docs/plans/REPORT_TECH*.md; do echo "=== $r ==="; cat "$r"; done
```

All must show PASS. Fix any failures.

---

## ADIM 4 — TECH 3, 4, 6 (Config/Docs — do sequentially)

### TECH 3 — Confidence-Based Adaptive Autonomy

Add to `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`:

A configurable threshold system. When CriticAgent returns a score:
- score >= 85 AND user has enabled auto-approve → skip human gate, proceed automatically
- score 75-84 → human gate as normal (current behavior)
- score < 75 → human gate + attention flag in UI

Implementation:
1. Add `autoApproveThreshold` to pipeline config (default: disabled / 85)
2. In the orchestrator, after critic_reviewing_spec completes:
   ```typescript
   if (pipeline.autoApproveEnabled && criticScore >= pipeline.autoApproveThreshold) {
     // Skip awaiting_approval, go directly to proto_building
     this.logActivity('Auto-approved: critic score ' + criticScore + ' >= threshold ' + pipeline.autoApproveThreshold);
   }
   ```
3. Add `autoApproveEnabled: boolean` and `autoApproveThreshold: number` to PipelineState
4. Add to DB schema: `auto_approve_enabled` (boolean, default false), `auto_approve_threshold` (integer, default 85)
5. Add API: PATCH /api/pipelines/:id/auto-approve { enabled: boolean, threshold?: number }

### TECH 4 — Persistent Learning Foundation

Create the docs structure (LEARNINGS.md files already exist from Level 3 work, enhance them):

1. Read existing `docs/learnings/` files
2. Add a `backend/src/pipeline/core/learning/LearningService.ts`:
   ```typescript
   // Simple file-based learning store (v1 — upgrade to pgvector in Horizon 2)
   export class LearningService {
     async recordOutcome(pipelineId: string, stage: string, outcome: {
       success: boolean;
       errorType?: string;
       solution?: string;
       duration: number;
       score?: number;
     }): Promise<void>;
     
     async getRelevantLearnings(stage: string, context: string): Promise<Learning[]>;
     // Returns last N outcomes for this stage, sorted by relevance (simple keyword match)
   }
   ```
3. Create `backend/src/pipeline/core/learning/LearningTypes.ts` with types
4. Create `backend/src/pipeline/core/learning/__tests__/LearningService.test.ts`

### TECH 6 — Domain-Agnostic Verification Foundation

Create `docs/architecture/ADR-005-domain-agnostic-verification.md`:

```markdown
# ADR-005: Domain-Agnostic Verification Architecture

## Status: Proposed (Horizon 3)

## Context
AKIS currently verifies software development outputs only. The same Produce → Review → Approve pattern applies to legal, financial, marketing, and other domains.

## Decision
Design the verification chain as a pluggable system:
1. Agent interface is domain-agnostic: Input → Output with typed contracts
2. Critic rules are domain-specific plugins: CriticRuleSet interface
3. Validation is domain-specific: ValidatorPlugin interface
4. Human gate is universal

## Proposed Interfaces
- CriticRuleSet: { domain: string, rules: CriticRule[], scoringWeights: Record<string, number> }
- ValidatorPlugin: { domain: string, validate(output: unknown): ValidationResult }
- DomainConfig: { name: string, stages: StageDefinition[], criticRules: CriticRuleSet, validator: ValidatorPlugin }

## ACP (Agents Context Protocol)
- Standard message format for agent-to-agent communication
- Artifact envelope: { output, decisions, constraints, confidence, openQuestions }
- Session isolation requirement: reviewer agents MUST run in fresh context
```

Also create `docs/architecture/ACP_PROTOCOL_DRAFT.md` with the initial ACP protocol spec:
- Message types: TaskRequest, TaskResult, ReviewRequest, ReviewResult
- Envelope format
- Trust metadata: confidence score, verification chain hash, human approval status
- Session isolation rules

---

## ADIM 5 — INTEGRATION

After all parallel agents complete and Tech 3/4/6 are done:

1. **Integrate DeterministicValidator into pipeline:**
   - After Proto generates code, run validator BEFORE CriticCode
   - After each FixLoop iteration, run validator
   - Add new FSM state: `validating_code` between `proto_building` and `critic_reviewing_code`
   - If validator.passed === false AND validator.issues has errors → fail immediately (don't waste LLM tokens on Critic)

2. **Integrate SecurityGate into FixLoop:**
   - FixLoopService calls securityGate.scan() after each iteration
   - FixLoopService calls securityGate.evaluate() to check regression
   - If regression detected → terminate loop with reason 'security_regression'

3. **Integrate ExplainabilityService:**
   - Each agent calls explainabilityService.addReasoning() after completion
   - Add GET /api/pipelines/:id/explanation endpoint
   - Response includes narrative + attention points

4. **Integrate LearningService:**
   - Record outcome after each pipeline completion
   - On new pipeline, inject relevant learnings into agent prompts

5. **Run full test suite:**
   ```bash
   cd backend && pnpm typecheck
   cd backend && pnpm test:unit
   ```

6. **Write final report to docs/plans/FINAL_REPORT_LEVEL4.md**

---

## ADIM 6 — VISION DOC PLACEMENT

Copy the vision documents to their permanent locations:
```bash
cp docs/plans/AKIS_Vizyon_Kultur_Strateji.docx docs/
cp docs/plans/AKIS_VISION.md docs/
# Also add reference in CLAUDE.md
```

Add to CLAUDE.md under a new section:
```markdown
## Vizyon & Strateji
- Resmi doküman: `docs/AKIS_Vizyon_Kultur_Strateji.docx`
- Özet: `docs/AKIS_VISION.md`  
- Bilimsel temeller: TRiSM (Gartner), Reflexion/Self-Refine (NeurIPS 2023), METR 2025, McKinsey 2026
- Kültür ilkesi: "AI üretir, AI denetler, insan karar verir"
```
```
