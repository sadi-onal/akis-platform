import { BaseAgent } from '../../core/agents/BaseAgent.js';
import type { AgentDependencies } from '../../core/agents/AgentFactory.js';
import type { Plan, AIService } from '../../services/ai/AIService.js';
import type { MCPTools } from '../../services/mcp/adapters/index.js';
import type { TraceRecorder } from '../../core/tracing/TraceRecorder.js';
import { TRACE_GENERATE_SYSTEM_PROMPT } from '../../services/ai/prompt-constants.js';
import {
  runTraceAutomation,
  type TraceRunResult,
  type TraceTestSpec,
} from '../../services/trace/TraceAutomationRunner.js';
import { FlakyTestManager, type FlakySummary } from '../../services/trace/FlakyTestManager.js';
import { computeFlowCoverage, type FlowCoverageSummary } from './FlowCoverage.js';
import { analyzeEdgeCaseCoverage, type EdgeCaseCoverageSummary } from './EdgeCaseCatalog.js';
import { computeRiskWeightedCoverage, type RiskWeightedCoverageSummary } from './RiskModel.js';
import { logger } from '../../lib/logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Max files to scan for repo context */
const REPO_SCAN_CONFIG = {
  maxFiles: 80,
  maxDepth: 3,
  maxFilesPerDir: 8,
  previewLength: 4000,
  sourceExtensions: new Set([
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php',
  ]),
  skipDirs: new Set([
    'node_modules', 'dist', 'build', '.git', '__pycache__', '.next',
    'coverage', 'vendor', '.cache', 'out', '.turbo', '.vercel',
  ]),
  testDirs: ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'cypress'],
  routeDirs: ['routes', 'api', 'controllers', 'handlers', 'endpoints'],
};

/** Token budget per test depth */
const TOKEN_BUDGETS: Record<string, number> = {
  smoke: 8000,
  standard: 16000,
  deep: 32000,
};

/** Priority levels for test classification */
type TestPriority = 'P0' | 'P1' | 'P2' | 'P3';

interface PrioritizedScenario {
  name: string;
  steps: string[];
  priority: TestPriority;
  estimatedDurationMs: number;
  flakinessRisk: 'low' | 'medium' | 'high';
  testLayer: 'unit' | 'integration' | 'e2e';
  tags: string[];
}

interface TestLayerBudget {
  layer: 'unit' | 'integration' | 'e2e';
  tokenBudget: number;
  scenarioCount: number;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface TracePayload {
  spec: string;
  owner?: string;
  repo?: string;
  baseBranch?: string;
  branchStrategy?: 'auto' | 'manual';
  dryRun?: boolean;
  automationMode?: 'plan_only' | 'generate_and_run';
  targetBaseUrl?: string;
  featureLimit?: number;
  maxTokens?: number;
  tracePreferences?: {
    testDepth: 'smoke' | 'standard' | 'deep';
    authScope: 'public' | 'authenticated' | 'mixed';
    browserTarget: 'chromium' | 'cross_browser' | 'mobile';
    strictness: 'fast' | 'balanced' | 'strict';
  };
}

interface RepoContext {
  routes: string[];
  models: string[];
  services: string[];
  existingTests: string[];
  techStack: string[];
  sourceFiles: Array<{ path: string; preview: string }>;
  hasAuth: boolean;
  hasDocker: boolean;
  hasCI: boolean;
  projectType: string;
  fileCount: number;
}

interface TraceAutomationSummary {
  runner: 'playwright';
  targetBaseUrl: string;
  featuresTotal: number;
  featuresPassed: number;
  featuresFailed: number;
  featurePassRate: number;
  testCasesTotal: number;
  testCasesPassed: number;
  testCasesFailed: number;
  durationMs: number;
  failures: Array<{ feature: string; test: string; reason: string }>;
  generatedTestPath: string;
  mode: 'syntactic' | 'ai-enhanced' | 'real';
  totalScenarios: number;
  executedScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  passRate: number;
  featuresCovered: number;
  featureCoverageRate: number;
  priorityBreakdown?: Record<TestPriority, number>;
  layerBreakdown?: Record<string, number>;
  artifactPaths?: {
    reportPath?: string;
    traceArtifactPath?: string;
  };
}

interface TraceCoverageSnapshot {
  flowCoverage: FlowCoverageSummary;
  edgeCaseCoverage: EdgeCaseCoverageSummary;
  riskWeightedCoverage: RiskWeightedCoverageSummary;
}

type TraceFlakySnapshot = FlakySummary;

interface TraceExecutionInsights {
  automationExecution: TraceAutomationSummary;
  coverage: TraceCoverageSnapshot;
  flaky: TraceFlakySnapshot;
}

// ---------------------------------------------------------------------------
// TraceAgent
// ---------------------------------------------------------------------------

export class TraceAgent extends BaseAgent {
  readonly type = 'trace';
  private aiService?: AIService;
  private traceRecorder?: TraceRecorder;
  private readonly traceAutomationRunner: (opts: {
    specs: TraceTestSpec[];
    baseUrl: string;
    browserTarget?: string;
    timeoutMs?: number;
  }) => Promise<TraceRunResult>;
  private readonly flakyManager = new FlakyTestManager();

  constructor(deps?: AgentDependencies) {
    super();
    if (deps?.tools?.aiService) {
      this.aiService = deps.tools.aiService as AIService;
    }
    if (deps?.traceRecorder) {
      this.traceRecorder = deps.traceRecorder;
    }
    const toolset = deps?.tools as Record<string, unknown> | undefined;
    this.traceAutomationRunner =
      (toolset?.traceAutomationRunner as
        | ((opts: {
            specs: TraceTestSpec[];
            baseUrl: string;
            browserTarget?: string;
            timeoutMs?: number;
          }) => Promise<TraceRunResult>)
        | undefined) ?? runTraceAutomation;
    this.playbook.requiresPlanning = true;
    this.playbook.requiresReflection = false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private emitLog(message: string, data?: Record<string, unknown>) {
    if (this.traceRecorder) {
      this.traceRecorder.recordInfo(message, data);
    }
  }

  // ── Planning ─────────────────────────────────────────────────────────────

  async plan(
    planner: { plan(input: { agent: string; goal: string; context?: unknown }): Promise<Plan> },
    context: unknown
  ): Promise<Plan> {
    const payload = context as TracePayload;
    const preferenceSummary = this.renderPreferenceSummary(payload.tracePreferences);
    this.emitLog('Planning test generation strategy', { specLength: payload.spec?.length });
    return planner.plan({
      agent: 'trace',
      goal: `Generate a comprehensive test plan and coverage matrix from the following specification:\n\n${payload.spec}\n\n${preferenceSummary}`,
      context: {
        specLength: payload.spec?.length || 0,
        hasRepo: !!(payload.owner && payload.repo),
        tracePreferences: payload.tracePreferences ?? null,
      },
    });
  }

  // ── Simple execute (no tools) ────────────────────────────────────────────

  async execute(context: unknown): Promise<unknown> {
    const payload = context as TracePayload;
    if (!payload?.spec) {
      throw new Error('TraceAgent requires payload with "spec" field');
    }

    const spec = typeof payload.spec === 'string' ? payload.spec : String(payload.spec);
    const startedAt = Date.now();
    const scenarios = this.parseScenarios(spec);
    const prioritized = this.classifyScenarios(scenarios);
    const files = this.generateTestFiles(scenarios);
    const coverageMatrix = this.generateCoverageMatrix(scenarios);
    const executionInsights = await this.evaluateAutomationExecution(
      scenarios,
      coverageMatrix,
      files,
      payload,
      startedAt,
      prioritized
    );
    const testPlanMd = this.renderTestPlanMarkdown(
      scenarios,
      coverageMatrix,
      executionInsights.automationExecution,
      prioritized
    );

    return {
      ok: true, agent: 'trace', files, testPlan: testPlanMd, coverageMatrix,
      metadata: {
        scenarioCount: scenarios.length,
        totalTestCases: files.reduce((sum, f) => sum + f.cases.length, 0),
        specLength: spec.length,
        priorityBreakdown: this.getPriorityBreakdown(prioritized),
        layerBreakdown: this.getLayerBreakdown(prioritized),
        flowCoverage: executionInsights.coverage.flowCoverage,
        edgeCaseCoverage: executionInsights.coverage.edgeCaseCoverage,
        riskWeightedCoverage: executionInsights.coverage.riskWeightedCoverage,
        flaky: executionInsights.flaky,
        automationSummary: executionInsights.automationExecution,
        automationExecution: executionInsights.automationExecution,
      },
    };
  }

  // ── Full execute with tools ──────────────────────────────────────────────

  async executeWithTools(tools: MCPTools, plan?: Plan, context?: unknown): Promise<unknown> {
    const payload = context as TracePayload;
    if (!payload?.spec) {
      throw new Error('TraceAgent requires payload with "spec" field');
    }

    const spec = typeof payload.spec === 'string' ? payload.spec : String(payload.spec);
    const startedAt = Date.now();
    const depth = payload.tracePreferences?.testDepth ?? 'standard';
    const tokenBudget = payload.maxTokens ?? TOKEN_BUDGETS[depth] ?? 16000;

    // ── Phase 1: Gather repo context (if available) ──────────────────────
    let repoContext: RepoContext | null = null;
    if (payload.owner && payload.repo && tools.githubMCP) {
      this.traceRecorder?.recordReasoning({
        phase: 'Repository Analysis',
        summary: `Scanning ${payload.owner}/${payload.repo} for code context. Looking for routes, models, services, and existing tests to generate targeted test scenarios instead of generic ones.`,
      });
      this.emitLog('Scanning repository for code context', {
        owner: payload.owner, repo: payload.repo,
      });
      repoContext = await this.gatherRepoContext(
        tools.githubMCP, payload.owner, payload.repo, payload.baseBranch || 'main',
      );
      this.traceRecorder?.recordDecision({
        title: 'Repository Context Gathered',
        decision: `Found ${repoContext.fileCount} source files: ${repoContext.routes.length} routes, ${repoContext.models.length} models, ${repoContext.services.length} services, ${repoContext.existingTests.length} existing tests.`,
        reasoning: `Project type: ${repoContext.projectType} (${repoContext.techStack.join(', ')}). ${repoContext.hasAuth ? 'Auth detected — will prioritize authentication test scenarios.' : 'No auth detected.'} ${repoContext.existingTests.length > 0 ? `${repoContext.existingTests.length} existing tests found — will avoid duplicating coverage.` : 'No existing tests — full coverage needed.'}`,
      });
      this.emitLog('Repository scan complete', {
        routes: repoContext.routes.length,
        models: repoContext.models.length,
        services: repoContext.services.length,
        existingTests: repoContext.existingTests.length,
        techStack: repoContext.techStack,
        sourceFiles: repoContext.sourceFiles.length,
      });
    }

    // ── Phase 2: Parse and classify spec scenarios ─────────────────────
    this.traceRecorder?.recordPlanStep({
      stepId: 'parse-scenarios',
      title: 'Parse Test Specification',
      description: `Parsing specification (${spec.length} chars) into structured test scenarios`,
      reasoning: 'Extracting Gherkin scenarios, arrow-notation flows, and natural language test descriptions to build a structured scenario list for classification.',
      status: 'running',
    });
    this.emitLog('Parsing test specification', { specLength: spec.length });
    const scenarios = this.parseScenarios(spec);
    const prioritized = this.classifyScenarios(scenarios, repoContext);

    const priorityBreakdown = this.getPriorityBreakdown(prioritized);
    const layerBreakdown = this.getLayerBreakdown(prioritized);
    this.traceRecorder?.recordDecision({
      title: 'Scenario Classification Complete',
      decision: `Classified ${scenarios.length} scenarios: P0=${priorityBreakdown.P0}, P1=${priorityBreakdown.P1}, P2=${priorityBreakdown.P2}, P3=${priorityBreakdown.P3} across unit=${layerBreakdown.unit}, integration=${layerBreakdown.integration}, e2e=${layerBreakdown.e2e} layers.`,
      reasoning: `Priority assigned by keyword analysis: auth/security/payment keywords mark P0 (critical), CRUD operations mark P1 (high), display/search mark P2 (medium), visual/animation mark P3 (low). Test layers determined by scope: API/service keywords suggest integration tests, function/util keywords suggest unit tests, others default to e2e.`,
      alternatives: ['Could use LLM-based classification for higher accuracy', 'Could weight by code coverage data if available'],
    });
    this.traceRecorder?.recordPlanStep({
      stepId: 'parse-scenarios',
      title: 'Parse Test Specification',
      description: `Parsed ${scenarios.length} scenarios from specification`,
      reasoning: `Found ${scenarios.length} test scenarios. ${priorityBreakdown.P0 > 0 ? `${priorityBreakdown.P0} critical (P0) tests identified for auth/security flows.` : 'No P0 tests — specification may not cover auth/security.'} ${Object.values(layerBreakdown).filter(v => v > 0).length >= 2 ? 'Multi-layer coverage achieved.' : 'Single test layer — consider diversifying.'}`,
      status: 'completed',
    });
    this.emitLog('Scenarios parsed and classified', {
      count: scenarios.length,
      priorityBreakdown,
      layerBreakdown,
    });

    // ── Phase 3: Multi-pass AI test plan generation ──────────────────────
    let testPlanMd: string;
    let coverageMatrix: Record<string, string[]>;
    let files: Array<{ path: string; cases: Array<{ name: string; steps: string[] }> }>;
    const preferenceSummary = this.renderPreferenceSummary(payload.tracePreferences);
    let aiPlaywrightCode = '';

    if (this.aiService) {
      const contextSection = repoContext
        ? this.buildRepoContextPrompt(repoContext)
        : '';

      // Pass 1: Generate comprehensive test plan
      this.traceRecorder?.recordPlanStep({
        stepId: 'ai-pass-1',
        title: 'AI Pass 1/3: Generate Test Strategy',
        description: 'Generating comprehensive test plan with scenarios, coverage matrix, and risk assessment',
        reasoning: `Using ${depth} depth with ${tokenBudget} token budget (40% allocated to planning). ${repoContext ? `Repository context enriches test scenarios with real code paths from ${repoContext.routes.length} routes and ${repoContext.models.length} models.` : 'No repository context — generating from specification only.'}`,
        status: 'running',
      });
      this.emitLog('AI Pass 1/3: Generating test strategy and scenarios', { tokenBudget, depth });
      const layerBudgets = this.computeLayerBudgets(prioritized, tokenBudget);

      const planResult = await this.aiService.generateWorkArtifact({
        task: [
          'Generate a comprehensive, production-grade test plan with executable test cases.',
          '',
          '## Specification',
          spec,
          '',
          preferenceSummary,
          '',
          contextSection,
          '',
          '## Priority Classification Applied',
          ...prioritized.map(p => `- **${p.priority}** [${p.testLayer}] ${p.name} (flakiness: ${p.flakinessRisk})`),
          '',
          '## Required Output Format',
          'Return structured Markdown with these sections:',
          '1. **## Test Strategy** — Overall approach, test layers, prioritization rationale',
          '2. **## Test Scenarios** — Each scenario with Given/When/Then steps, priority (P0-P3), estimated run time, and flakiness risk',
          '3. **## Coverage Matrix** — Feature-to-test mapping table',
          '4. **## Risk Assessment** — Flakiness risks, untestable areas, recommendations',
          '5. **## Gap Analysis** — What\'s NOT covered and why',
        ].join('\n'),
        context: {
          plan: plan?.steps.map(s => s.title),
          tracePreferences: payload.tracePreferences ?? null,
          repoHasAuth: repoContext?.hasAuth ?? false,
          existingTestCount: repoContext?.existingTests.length ?? 0,
          layerBudgets,
        },
        maxTokens: Math.floor(tokenBudget * 0.4),
        systemPrompt: TRACE_GENERATE_SYSTEM_PROMPT,
      });

      testPlanMd = planResult.content;
      this.traceRecorder?.recordPlanStep({
        stepId: 'ai-pass-1',
        title: 'AI Pass 1/3: Test Strategy Generated',
        description: `Generated test plan (${testPlanMd.length} chars) with strategy, scenarios, coverage matrix, and risk assessment`,
        reasoning: `Test plan covers ${prioritized.length} scenarios across ${Object.values(layerBreakdown).filter(v => v > 0).length} test layers. Plan includes Given/When/Then steps, priority labels, and flakiness risk for each scenario.`,
        status: 'completed',
      });
      this.emitLog('AI Pass 1 complete: Test plan generated', { length: testPlanMd.length });

      // Pass 2: Generate executable Playwright test code
      this.traceRecorder?.recordPlanStep({
        stepId: 'ai-pass-2',
        title: 'AI Pass 2/3: Generate Playwright Tests',
        description: 'Generating production-ready Playwright test code in TypeScript',
        reasoning: `Converting ${prioritized.length} test scenarios into executable Playwright code. Using page.getByRole() and page.getByText() selectors for resilient tests. Target base URL: ${payload.targetBaseUrl || 'https://akisflow.com'}.`,
        status: 'running',
      });
      this.emitLog('AI Pass 2/3: Generating executable Playwright test code');

      const codeResult = await this.aiService.generateWorkArtifact({
        task: [
          'Generate production-ready Playwright test code (TypeScript) for the following test scenarios.',
          'IMPORTANT: Generate REAL, EXECUTABLE test code — not comments or pseudocode.',
          '',
          '## Scenarios to implement:',
          ...prioritized.map(p => [
            `### ${p.priority} [${p.testLayer}] ${p.name}`,
            `Steps: ${p.steps.join(' → ')}`,
            `Tags: ${p.tags.join(', ')}`,
            `Estimated duration: ${p.estimatedDurationMs}ms`,
            '',
          ].join('\n')),
          '',
          contextSection ? `## Repository Context\n${contextSection}` : '',
          '',
          '## Requirements:',
          '- Use `import { test, expect } from "@playwright/test";`',
          '- Use `test.describe()` to group related tests',
          '- Include `test.beforeEach()` for common setup (navigation, auth)',
          '- Use realistic selectors: `page.getByRole()`, `page.getByText()`, `page.getByTestId()`',
          '- Add proper `await` for all async operations',
          '- Include `expect()` assertions with meaningful error messages',
          '- Handle loading states with `page.waitForLoadState()`',
          '- Add test tags via `test()` annotations',
          `- Base URL: ${payload.targetBaseUrl || 'https://akisflow.com'}`,
          '',
          'Return ONLY TypeScript code wrapped in a single code block. No Markdown outside the code block.',
        ].join('\n'),
        context: { scenarioCount: prioritized.length, testPlanLength: testPlanMd.length },
        maxTokens: Math.floor(tokenBudget * 0.4),
        systemPrompt: TRACE_GENERATE_SYSTEM_PROMPT,
      });

      aiPlaywrightCode = codeResult.content;
      this.traceRecorder?.recordPlanStep({
        stepId: 'ai-pass-2',
        title: 'AI Pass 2/3: Playwright Tests Generated',
        description: `Generated ${aiPlaywrightCode.length} chars of executable Playwright test code`,
        reasoning: `Playwright code generated for ${prioritized.length} scenarios with proper imports, test.describe() grouping, beforeEach() setup, and expect() assertions.`,
        status: 'completed',
      });
      this.emitLog('AI Pass 2 complete: Playwright code generated', { length: aiPlaywrightCode.length });

      // Pass 3: Generate coverage matrix analysis
      this.traceRecorder?.recordPlanStep({
        stepId: 'ai-pass-3',
        title: 'AI Pass 3/3: Coverage Analysis',
        description: 'Analyzing test coverage gaps and generating risk assessment',
        reasoning: `Final pass uses remaining 20% of token budget (${Math.floor(tokenBudget * 0.2)} tokens) to analyze coverage completeness, identify flaky test risks, and recommend improvements.`,
        status: 'running',
      });
      this.emitLog('AI Pass 3/3: Generating coverage analysis and risk assessment');

      const coverageResult = await this.aiService.generateWorkArtifact({
        task: [
          'Analyze the following test scenarios and generate:',
          '1. A detailed coverage matrix mapping every code path / feature to test cases',
          '2. A risk assessment identifying flaky tests, race conditions, and untestable areas',
          '3. Recommendations for improving test reliability',
          '',
          '## Scenarios:',
          ...prioritized.map(p => `- ${p.priority} [${p.testLayer}] ${p.name}: ${p.steps.join(' → ')}`),
          '',
          contextSection,
          '',
          'Return structured Markdown.',
        ].join('\n'),
        context: { scenarioCount: prioritized.length },
        maxTokens: Math.floor(tokenBudget * 0.2),
        systemPrompt: TRACE_GENERATE_SYSTEM_PROMPT,
      });

      this.traceRecorder?.recordPlanStep({
        stepId: 'ai-pass-3',
        title: 'AI Pass 3/3: Coverage Analysis Complete',
        description: `Generated coverage analysis (${coverageResult.content.length} chars) with gap identification and risk assessment`,
        reasoning: 'Coverage matrix maps every feature to its test cases. Risk assessment identifies flaky tests, race conditions, and untestable areas.',
        status: 'completed',
      });
      this.emitLog('AI Pass 3 complete: Coverage analysis generated', { length: coverageResult.content.length });

      // Merge AI coverage into coverage matrix
      files = this.generateTestFiles(scenarios);
      coverageMatrix = this.generateCoverageMatrix(scenarios);

      // Append AI coverage analysis to test plan
      testPlanMd = `${testPlanMd.trimEnd()}\n\n${coverageResult.content}`;
    } else {
      files = this.generateTestFiles(scenarios);
      coverageMatrix = this.generateCoverageMatrix(scenarios);
      testPlanMd = this.renderTestPlanMarkdown(scenarios, coverageMatrix, undefined, prioritized);
    }

    // ── Phase 4: Automation evaluation ───────────────────────────────────
    const derivedScenarios = files.map((f) => ({
      name: f.cases[0]?.name ?? f.path,
      steps: f.cases[0]?.steps ?? [],
    }));
    const executionInsights = await this.evaluateAutomationExecution(
      derivedScenarios,
      coverageMatrix,
      files,
      payload,
      startedAt,
      prioritized
    );
    const automationExecution = executionInsights.automationExecution;
    if (!testPlanMd.includes('## Automation Execution Summary')) {
      testPlanMd = `${testPlanMd.trimEnd()}\n\n${this.renderAutomationExecutionMarkdown(automationExecution)}`;
    }

    // ── Phase 5: Build artifacts ─────────────────────────────────────────
    this.traceRecorder?.recordReasoning({
      phase: 'Artifact Generation',
      summary: `Building 4 test artifacts: test plan document, executable Playwright tests, coverage matrix, and risk assessment. ${aiPlaywrightCode ? 'AI-generated Playwright code will be used (preferred over template-based generation).' : 'Using template-based Playwright code generation (no AI code available).'}`,
    });
    this.emitLog('Building test artifacts');
    const artifacts: Array<{ filePath: string; content: string }> = [];

    artifacts.push({ filePath: 'docs/test-plan.md', content: testPlanMd });

    // Generate executable test code: prefer AI-generated if available
    const testCode = aiPlaywrightCode
      ? this.cleanPlaywrightCode(aiPlaywrightCode)
      : this.generatePlaywrightTestCode(prioritized, payload.targetBaseUrl);

    artifacts.push({ filePath: 'tests/generated/trace-tests.test.ts', content: testCode });

    const coverageMd = this.renderCoverageMatrixMarkdown(coverageMatrix);
    artifacts.push({ filePath: 'docs/coverage-matrix.md', content: coverageMd });

    // Generate risk assessment artifact
    const riskMd = this.renderRiskAssessment(prioritized);
    artifacts.push({ filePath: 'docs/risk-assessment.md', content: riskMd });

    // Record artifacts to DB for quality scoring + frontend Outputs tab
    for (const artifact of artifacts) {
      this.traceRecorder?.recordFileCreated(
        artifact.filePath,
        artifact.content.length,
        artifact.content.substring(0, 500),
      );
    }

    this.emitLog('Artifacts built', { count: artifacts.length });

    // ── Phase 6: Commit to GitHub (if not dry run) ───────────────────────
    if (!payload.dryRun && payload.owner && payload.repo && tools.githubMCP) {
      const github = tools.githubMCP;
      const branchName = payload.branchStrategy === 'manual'
        ? payload.baseBranch || 'main'
        : `trace/run-${Date.now()}`;

      try {
        this.emitLog('Committing artifacts to GitHub', { branch: branchName });

        if (payload.branchStrategy !== 'manual') {
          await github.createBranch(payload.owner, payload.repo, branchName, payload.baseBranch || 'main');
          this.emitLog('Branch created', { branch: branchName });
        }

        for (const artifact of artifacts) {
          await github.commitFile(
            payload.owner, payload.repo, branchName,
            artifact.filePath, artifact.content,
            `trace: generate ${artifact.filePath}`
          );
          this.emitLog('File committed', { file: artifact.filePath });
        }

        let prUrl: string | undefined;
        try {
          const prResult = await github.createPRDraft(
            payload.owner, payload.repo,
            `[Trace] Test plan and coverage matrix`,
            `Auto-generated by AKIS Trace agent.\n\n## Artifacts\n${artifacts.map(a => `- \`${a.filePath}\``).join('\n')}\n\n## Stats\n- Scenarios: ${scenarios.length}\n- Test cases: ${files.reduce((s, f) => s + f.cases.length, 0)}\n- Coverage features: ${Object.keys(coverageMatrix).length}`,
            branchName, payload.baseBranch || 'main',
          );
          prUrl = (prResult as { url?: string })?.url;
          this.emitLog('Pull request created', { url: prUrl });
        } catch {
          // PR creation is optional
        }

        return {
          ok: true, agent: 'trace', files, testPlan: testPlanMd, coverageMatrix,
          artifacts: artifacts.map(a => ({ filePath: a.filePath })),
          branch: branchName, prUrl,
          metadata: {
            scenarioCount: files.length,
            totalTestCases: files.reduce((sum, f) => sum + f.cases.length, 0),
            specLength: spec.length,
            committed: true,
            priorityBreakdown: this.getPriorityBreakdown(prioritized),
            layerBreakdown: this.getLayerBreakdown(prioritized),
            repoContext: repoContext ? { fileCount: repoContext.fileCount, routes: repoContext.routes.length, models: repoContext.models.length } : null,
            flowCoverage: executionInsights.coverage.flowCoverage,
            edgeCaseCoverage: executionInsights.coverage.edgeCaseCoverage,
            riskWeightedCoverage: executionInsights.coverage.riskWeightedCoverage,
            flaky: executionInsights.flaky,
            automationSummary: automationExecution,
            automationExecution,
          },
        };
      } catch (githubError) {
        logger.error(`[TraceAgent] GitHub operations failed: ${githubError}`);
        this.emitLog('GitHub commit failed, returning artifacts inline', {
          error: githubError instanceof Error ? githubError.message : String(githubError),
        });
        return {
          ok: true, agent: 'trace', files, testPlan: testPlanMd, coverageMatrix,
          artifacts: artifacts.map(a => ({ filePath: a.filePath, content: a.content })),
          metadata: {
            scenarioCount: files.length,
            totalTestCases: files.reduce((sum, f) => sum + f.cases.length, 0),
            specLength: spec.length, committed: false,
            priorityBreakdown: this.getPriorityBreakdown(prioritized),
            layerBreakdown: this.getLayerBreakdown(prioritized),
            githubError: githubError instanceof Error ? githubError.message : String(githubError),
            flowCoverage: executionInsights.coverage.flowCoverage,
            edgeCaseCoverage: executionInsights.coverage.edgeCaseCoverage,
            riskWeightedCoverage: executionInsights.coverage.riskWeightedCoverage,
            flaky: executionInsights.flaky,
            automationSummary: automationExecution, automationExecution,
          },
        };
      }
    }

    return {
      ok: true, agent: 'trace', files, testPlan: testPlanMd, coverageMatrix,
      artifacts: artifacts.map(a => ({ filePath: a.filePath, content: a.content })),
      metadata: {
        scenarioCount: files.length,
        totalTestCases: files.reduce((sum, f) => sum + f.cases.length, 0),
        specLength: spec.length, committed: false,
        priorityBreakdown: this.getPriorityBreakdown(prioritized),
        layerBreakdown: this.getLayerBreakdown(prioritized),
        repoContext: repoContext ? { fileCount: repoContext.fileCount, routes: repoContext.routes.length, models: repoContext.models.length } : null,
        tracePreferences: payload.tracePreferences ?? null,
        flowCoverage: executionInsights.coverage.flowCoverage,
        edgeCaseCoverage: executionInsights.coverage.edgeCaseCoverage,
        riskWeightedCoverage: executionInsights.coverage.riskWeightedCoverage,
        flaky: executionInsights.flaky,
        automationSummary: automationExecution, automationExecution,
      },
    };
  }

  // ── Repository context gathering ─────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async gatherRepoContext(github: any, owner: string, repo: string, branch: string): Promise<RepoContext> {
    const ctx: RepoContext = {
      routes: [], models: [], services: [], existingTests: [],
      techStack: [], sourceFiles: [], hasAuth: false, hasDocker: false,
      hasCI: false, projectType: 'unknown', fileCount: 0,
    };

    try {
      // Scan root to detect project type
      const rootFiles = await this.safeListDir(github, owner, repo, branch, '');
      if (!rootFiles) return ctx;

      for (const f of rootFiles) {
        const name = f.name?.toLowerCase() || '';
        if (name === 'package.json') ctx.techStack.push('node');
        if (name === 'tsconfig.json') ctx.techStack.push('typescript');
        if (name === 'requirements.txt' || name === 'pyproject.toml') ctx.techStack.push('python');
        if (name === 'go.mod') ctx.techStack.push('go');
        if (name === 'cargo.toml') ctx.techStack.push('rust');
        if (name === 'dockerfile' || name === 'docker-compose.yml') ctx.hasDocker = true;
        if (name === '.github') ctx.hasCI = true;
      }

      ctx.projectType = ctx.techStack.includes('typescript') ? 'typescript'
        : ctx.techStack.includes('node') ? 'javascript'
        : ctx.techStack.includes('python') ? 'python'
        : ctx.techStack[0] || 'unknown';

      // Recursively scan source directories
      const dirsToScan = ['src', 'lib', 'app', 'server', 'backend', 'frontend', 'api',
        ...REPO_SCAN_CONFIG.routeDirs, ...REPO_SCAN_CONFIG.testDirs, 'docs'];

      for (const dir of dirsToScan) {
        const dirEntry = rootFiles.find((f: { name: string }) => f.name === dir);
        if (dirEntry) {
          await this.scanDirectoryRecursive(github, owner, repo, branch, dir, ctx, 0);
        }
      }

      // Detect auth presence
      ctx.hasAuth = ctx.sourceFiles.some(f =>
        f.path.includes('auth') || f.path.includes('login') || f.path.includes('session')
      );

    } catch (error) {
      this.emitLog('Repository scan error (partial results used)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return ctx;
  }

  private async scanDirectoryRecursive(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    github: any, owner: string, repo: string, branch: string,
    dirPath: string, ctx: RepoContext, depth: number
  ): Promise<void> {
    if (depth > REPO_SCAN_CONFIG.maxDepth) return;
    if (ctx.fileCount >= REPO_SCAN_CONFIG.maxFiles) return;

    const entries = await this.safeListDir(github, owner, repo, branch, dirPath);
    if (!entries) return;

    let filesInDir = 0;

    for (const entry of entries) {
      if (ctx.fileCount >= REPO_SCAN_CONFIG.maxFiles) break;
      if (filesInDir >= REPO_SCAN_CONFIG.maxFilesPerDir) break;

      const fullPath = `${dirPath}/${entry.name}`;
      const nameLower = entry.name.toLowerCase();

      if (entry.type === 'dir') {
        if (REPO_SCAN_CONFIG.skipDirs.has(nameLower)) continue;
        await this.scanDirectoryRecursive(github, owner, repo, branch, fullPath, ctx, depth + 1);
        continue;
      }

      // Classify file
      const ext = '.' + entry.name.split('.').pop()?.toLowerCase();
      if (!REPO_SCAN_CONFIG.sourceExtensions.has(ext)) continue;

      filesInDir++;
      ctx.fileCount++;

      // Categorize
      const isTest = REPO_SCAN_CONFIG.testDirs.some(td => fullPath.includes(`/${td}/`))
        || nameLower.includes('.test.') || nameLower.includes('.spec.');
      const isRoute = REPO_SCAN_CONFIG.routeDirs.some(rd => fullPath.includes(`/${rd}/`))
        || nameLower.includes('route') || nameLower.includes('controller') || nameLower.includes('handler');
      const isModel = nameLower.includes('model') || nameLower.includes('schema') || nameLower.includes('entity');
      const isService = nameLower.includes('service') || nameLower.includes('provider') || nameLower.includes('middleware');

      if (isTest) ctx.existingTests.push(fullPath);
      if (isRoute) ctx.routes.push(fullPath);
      if (isModel) ctx.models.push(fullPath);
      if (isService) ctx.services.push(fullPath);

      // Read file preview for important files (routes, models, tests)
      if ((isRoute || isModel || isService) && ctx.sourceFiles.length < 30) {
        try {
          const content = await github.readFileContent(owner, repo, branch, fullPath);
          if (content) {
            const preview = typeof content === 'string'
              ? content.substring(0, REPO_SCAN_CONFIG.previewLength)
              : '';
            ctx.sourceFiles.push({ path: fullPath, preview });
            // Record doc read for quality scoring
            this.traceRecorder?.recordDocRead(fullPath, preview.length, preview.substring(0, 200));
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async safeListDir(github: any, owner: string, repo: string, branch: string, path: string): Promise<any[] | null> {
    try {
      return await github.listDirectory(owner, repo, branch, path);
    } catch {
      return null;
    }
  }

  // ── Build repo context prompt section ────────────────────────────────────

  private buildRepoContextPrompt(ctx: RepoContext): string {
    const sections: string[] = ['## Repository Context (from code analysis)'];

    sections.push(`Project type: ${ctx.projectType} | Tech stack: ${ctx.techStack.join(', ')}`);
    sections.push(`Files scanned: ${ctx.fileCount} | Has auth: ${ctx.hasAuth} | Has Docker: ${ctx.hasDocker} | Has CI: ${ctx.hasCI}`);

    if (ctx.routes.length > 0) {
      sections.push(`\n### Routes/Controllers (${ctx.routes.length} files)`);
      sections.push(ctx.routes.slice(0, 15).map(r => `- ${r}`).join('\n'));
    }

    if (ctx.models.length > 0) {
      sections.push(`\n### Models/Schema (${ctx.models.length} files)`);
      sections.push(ctx.models.slice(0, 10).map(m => `- ${m}`).join('\n'));
    }

    if (ctx.services.length > 0) {
      sections.push(`\n### Services/Middleware (${ctx.services.length} files)`);
      sections.push(ctx.services.slice(0, 10).map(s => `- ${s}`).join('\n'));
    }

    if (ctx.existingTests.length > 0) {
      sections.push(`\n### Existing Tests (${ctx.existingTests.length} files)`);
      sections.push(ctx.existingTests.slice(0, 10).map(t => `- ${t}`).join('\n'));
    }

    // Include source file previews
    const previews = ctx.sourceFiles.slice(0, 10);
    if (previews.length > 0) {
      sections.push('\n### Source Code Previews');
      for (const f of previews) {
        sections.push(`\n#### ${f.path}`);
        sections.push('```');
        sections.push(f.preview);
        sections.push('```');
      }
    }

    return sections.join('\n');
  }

  // ── Preference summary ───────────────────────────────────────────────────

  private renderPreferenceSummary(payload?: TracePayload['tracePreferences']): string {
    if (!payload) {
      return 'Preference Profile: default (standard depth, balanced strictness, chromium, mixed auth scope).';
    }
    return [
      'Preference Profile:',
      `- Test Depth: ${payload.testDepth}`,
      `- Auth Scope: ${payload.authScope}`,
      `- Browser Target: ${payload.browserTarget}`,
      `- Strictness: ${payload.strictness}`,
      'Use this profile to tailor test scenarios, edge cases, and prioritization.',
    ].join('\n');
  }

  // ── Scenario parsing ─────────────────────────────────────────────────────

  private parseScenarios(spec: string): Array<{ name: string; steps: string[] }> {
    const scenarios: Array<{ name: string; steps: string[] }> = [];

    // Parse ALL Gherkin scenarios
    const gherkinPattern = /Scenario(?:\s+Outline)?:\s*(.+?)(?:\n|$)/gi;
    let gherkinMatch;
    const scenarioBlocks: Array<{ name: string; startIndex: number }> = [];
    while ((gherkinMatch = gherkinPattern.exec(spec)) !== null) {
      scenarioBlocks.push({ name: gherkinMatch[1].trim(), startIndex: gherkinMatch.index });
    }

    if (scenarioBlocks.length > 0) {
      for (let i = 0; i < scenarioBlocks.length; i++) {
        const block = scenarioBlocks[i];
        const endIndex = i + 1 < scenarioBlocks.length ? scenarioBlocks[i + 1].startIndex : spec.length;
        const blockText = spec.substring(block.startIndex, endIndex);
        const steps: string[] = [];
        const stepPattern = /(?:Given|When|Then|And|But)\s+(.+?)(?:\n|$)/gi;
        let stepMatch;
        while ((stepMatch = stepPattern.exec(blockText)) !== null) {
          steps.push(stepMatch[1].trim());
        }
        if (steps.length > 0) {
          scenarios.push({ name: block.name, steps });
        }
      }
      if (scenarios.length > 0) return scenarios;
    }

    if (spec.includes('->')) {
      const parts = spec.split('->').map((p) => p.trim());
      if (parts.length >= 2) {
        scenarios.push({ name: `Test: ${parts[0]}`, steps: parts });
        return scenarios;
      }
    }

    const colonMatch = spec.match(/^([^:]+):\s*(.+)$/);
    if (colonMatch) {
      scenarios.push({
        name: `Test: ${colonMatch[1].trim()}`,
        steps: colonMatch[2].trim().split(/[.,;]/).map((s) => s.trim()).filter((s) => s.length > 0),
      });
      return scenarios;
    }

    // Natural language: split by sentences
    const sentences = spec.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 5);
    if (sentences.length > 0) {
      scenarios.push({ name: 'Test: Generated from spec', steps: sentences });
    } else {
      const parts = spec.split(/[\n,]+/).map((p) => p.trim()).filter((p) => p.length > 0);
      if (parts.length > 0) {
        scenarios.push({ name: 'Test: Generated from spec', steps: parts });
      }
    }

    return scenarios;
  }

  // ── Test file generation ─────────────────────────────────────────────────

  private generateTestFiles(scenarios: Array<{ name: string; steps: string[] }>) {
    if (scenarios.length === 0) {
      return [{ path: 'tests/generated/default.test.ts', cases: [{ name: 'default test case', steps: ['No scenarios found in spec'] }] }];
    }

    return [...scenarios].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })).map((scenario, idx) => {
      const sanitizedName = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
      return {
        path: `tests/generated/${sanitizedName || `test-${idx}`}.test.ts`,
        cases: [{ name: scenario.name, steps: scenario.steps }],
      };
    });
  }

  // ── Coverage matrix ──────────────────────────────────────────────────────

  private generateCoverageMatrix(scenarios: Array<{ name: string; steps: string[] }>): Record<string, string[]> {
    const matrix: Record<string, string[]> = {};
    for (const scenario of scenarios) {
      for (const step of scenario.steps) {
        const feature = step.split(' ').slice(0, 3).join(' ');
        if (!matrix[feature]) matrix[feature] = [];
        if (!matrix[feature].includes(scenario.name)) {
          matrix[feature].push(scenario.name);
        }
      }
    }
    return matrix;
  }

  // ── Markdown renderers ───────────────────────────────────────────────────

  private renderTestPlanMarkdown(
    scenarios: Array<{ name: string; steps: string[] }>,
    coverageMatrix: Record<string, string[]>,
    automationExecution?: TraceAutomationSummary,
    prioritized?: PrioritizedScenario[],
  ): string {
    const lines: string[] = ['# Test Plan\n', `Generated: ${new Date().toISOString()}\n`];

    // Add priority summary if available
    if (prioritized && prioritized.length > 0) {
      const breakdown = this.getPriorityBreakdown(prioritized);
      const layerBreakdown = this.getLayerBreakdown(prioritized);
      lines.push('## Summary\n');
      lines.push(`- **Total scenarios:** ${prioritized.length}`);
      lines.push(`- **P0 (Critical):** ${breakdown.P0} | **P1 (High):** ${breakdown.P1} | **P2 (Medium):** ${breakdown.P2} | **P3 (Low):** ${breakdown.P3}`);
      lines.push(`- **Unit:** ${layerBreakdown.unit} | **Integration:** ${layerBreakdown.integration} | **E2E:** ${layerBreakdown.e2e}`);
      lines.push(`- **Estimated total duration:** ${Math.round(prioritized.reduce((s, p) => s + p.estimatedDurationMs, 0) / 1000)}s`);
      lines.push('');
    }

    lines.push('## Test Scenarios\n');
    const scenariosToRender = prioritized ?? scenarios;
    for (const s of scenariosToRender) {
      const prio = (s as PrioritizedScenario).priority;
      const layer = (s as PrioritizedScenario).testLayer;
      const header = prio ? `### ${prio} [${layer}] ${s.name}` : `### ${s.name}`;
      lines.push(`${header}\n`);
      if ((s as PrioritizedScenario).flakinessRisk) {
        lines.push(`> Flakiness: ${(s as PrioritizedScenario).flakinessRisk} | Tags: ${(s as PrioritizedScenario).tags?.join(', ') || 'none'}\n`);
      }
      for (const step of s.steps) {
        lines.push(`- ${step}`);
      }
      lines.push('');
    }
    lines.push('## Coverage Matrix\n');
    lines.push('| Feature | Covered By |');
    lines.push('|---------|-----------|');
    for (const [feature, tests] of Object.entries(coverageMatrix)) {
      lines.push(`| ${feature} | ${tests.join(', ')} |`);
    }
    if (automationExecution) lines.push(`\n${this.renderAutomationExecutionMarkdown(automationExecution)}`);
    return lines.join('\n');
  }

  private renderCoverageMatrixMarkdown(coverageMatrix: Record<string, string[]>): string {
    const lines: string[] = ['# Coverage Matrix\n', `Generated: ${new Date().toISOString()}\n`];
    lines.push('| Feature | Test Coverage |');
    lines.push('|---------|--------------|');
    for (const [feature, tests] of Object.entries(coverageMatrix)) {
      lines.push(`| ${feature} | ${tests.join(', ')} |`);
    }
    return lines.join('\n');
  }

  private renderAutomationExecutionMarkdown(automationExecution: TraceAutomationSummary): string {
    const lines = [
      '## Automation Execution Summary',
      '',
      `- Runner: ${automationExecution.runner}`,
      `- Target base URL: ${automationExecution.targetBaseUrl}`,
      `- Mode: ${automationExecution.mode}`,
      `- Scenarios executed: ${automationExecution.executedScenarios}/${automationExecution.totalScenarios}`,
      `- Scenarios passed: ${automationExecution.passedScenarios}`,
      `- Scenarios failed: ${automationExecution.failedScenarios}`,
      `- Scenario pass rate: ${automationExecution.passRate}%`,
      `- Features passed: ${automationExecution.featuresPassed}/${automationExecution.featuresTotal} (${automationExecution.featurePassRate}%)`,
      `- Test cases passed: ${automationExecution.testCasesPassed}/${automationExecution.testCasesTotal}`,
      `- Execution duration: ${automationExecution.durationMs}ms`,
      `- Generated test path: ${automationExecution.generatedTestPath}`,
      `- Feature coverage: ${automationExecution.featuresCovered}/${automationExecution.featuresTotal} (${automationExecution.featureCoverageRate}%)`,
    ];

    if (automationExecution.artifactPaths?.reportPath) {
      lines.push(`- JSON report: ${automationExecution.artifactPaths.reportPath}`);
    }
    if (automationExecution.artifactPaths?.traceArtifactPath) {
      lines.push(`- Trace artifact: ${automationExecution.artifactPaths.traceArtifactPath}`);
    }

    return lines.join('\n');
  }

  // ── Scenario classification ──────────────────────────────────────────────

  private classifyScenarios(
    scenarios: Array<{ name: string; steps: string[] }>,
    repoCtx?: RepoContext | null,
  ): PrioritizedScenario[] {
    return scenarios.map(s => {
      const nameLower = s.name.toLowerCase();
      const stepsJoined = s.steps.join(' ').toLowerCase();
      const allText = `${nameLower} ${stepsJoined}`;

      // Priority classification
      let priority: TestPriority = 'P2';
      if (allText.includes('auth') || allText.includes('login') || allText.includes('password') ||
          allText.includes('payment') || allText.includes('security') || allText.includes('delete')) {
        priority = 'P0';
      } else if (allText.includes('create') || allText.includes('submit') || allText.includes('save') ||
                 allText.includes('register') || allText.includes('signup')) {
        priority = 'P1';
      } else if (allText.includes('display') || allText.includes('view') || allText.includes('list') ||
                 allText.includes('search') || allText.includes('filter')) {
        priority = 'P2';
      } else if (allText.includes('tooltip') || allText.includes('animation') || allText.includes('color') ||
                 allText.includes('style') || allText.includes('hover')) {
        priority = 'P3';
      }

      // Test layer detection
      let testLayer: 'unit' | 'integration' | 'e2e' = 'e2e';
      if (allText.includes('api') || allText.includes('endpoint') || allText.includes('route') ||
          allText.includes('service') || allText.includes('middleware')) {
        testLayer = 'integration';
      }
      if (allText.includes('function') || allText.includes('util') || allText.includes('helper') ||
          allText.includes('parse') || allText.includes('validate') || allText.includes('calculate')) {
        testLayer = 'unit';
      }

      // Flakiness risk
      let flakinessRisk: 'low' | 'medium' | 'high' = 'low';
      if (allText.includes('animation') || allText.includes('timing') || allText.includes('wait') ||
          allText.includes('async') || allText.includes('network') || allText.includes('scroll')) {
        flakinessRisk = 'high';
      } else if (allText.includes('load') || allText.includes('navigation') || allText.includes('redirect')) {
        flakinessRisk = 'medium';
      }

      // Tags
      const tags: string[] = [];
      if (priority === 'P0') tags.push('critical');
      if (allText.includes('auth')) tags.push('auth');
      if (allText.includes('api')) tags.push('api');
      if (allText.includes('ui') || allText.includes('page') || allText.includes('button')) tags.push('ui');
      if (repoCtx?.hasAuth && allText.includes('login')) tags.push('auth-flow');
      tags.push(testLayer);

      // Duration estimate
      const estimatedDurationMs =
        testLayer === 'unit' ? 100 :
        testLayer === 'integration' ? 2000 :
        s.steps.length * 3000 + 5000;

      return { ...s, priority, estimatedDurationMs, flakinessRisk, testLayer, tags };
    });
  }

  private getPriorityBreakdown(prioritized: PrioritizedScenario[]): Record<TestPriority, number> {
    const breakdown: Record<TestPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const s of prioritized) breakdown[s.priority]++;
    return breakdown;
  }

  private getLayerBreakdown(prioritized: PrioritizedScenario[]): Record<string, number> {
    const breakdown: Record<string, number> = { unit: 0, integration: 0, e2e: 0 };
    for (const s of prioritized) breakdown[s.testLayer]++;
    return breakdown;
  }

  private computeLayerBudgets(prioritized: PrioritizedScenario[], totalBudget: number): TestLayerBudget[] {
    const layers = ['unit', 'integration', 'e2e'] as const;
    const counts = layers.map(l => ({ layer: l, count: prioritized.filter(s => s.testLayer === l).length }));
    const total = counts.reduce((s, c) => s + c.count, 0) || 1;
    return counts.map(c => ({
      layer: c.layer,
      tokenBudget: Math.floor((c.count / total) * totalBudget),
      scenarioCount: c.count,
    }));
  }

  // ── Executable Playwright code generation ───────────────────────────────

  private generatePlaywrightTestCode(
    prioritized: PrioritizedScenario[],
    targetBaseUrl = 'https://akisflow.com',
  ): string {
    const lines: string[] = [
      `import { test, expect } from '@playwright/test';`,
      '',
      `// Auto-generated by AKIS Trace Agent`,
      `// Base URL: ${targetBaseUrl}`,
      `// Generated: ${new Date().toISOString()}`,
      '',
    ];

    // Group by test layer
    const byLayer = { unit: [] as PrioritizedScenario[], integration: [] as PrioritizedScenario[], e2e: [] as PrioritizedScenario[] };
    for (const s of prioritized) byLayer[s.testLayer].push(s);

    for (const [layer, scenarios] of Object.entries(byLayer)) {
      if (scenarios.length === 0) continue;

      lines.push(`test.describe('${layer.toUpperCase()} Tests', () => {`);

      if (layer === 'e2e') {
        lines.push(`  test.beforeEach(async ({ page }) => {`);
        lines.push(`    await page.goto('${targetBaseUrl}');`);
        lines.push(`    await page.waitForLoadState('networkidle');`);
        lines.push(`  });`);
        lines.push('');
      }

      for (const scenario of scenarios) {
        const tagStr = scenario.tags.length > 0 ? ` @${scenario.tags.join(' @')}` : '';
        lines.push(`  // Priority: ${scenario.priority} | Flakiness: ${scenario.flakinessRisk} | Est: ${scenario.estimatedDurationMs}ms`);
        lines.push(`  test('${scenario.name.replace(/'/g, "\\'")}${tagStr}', async ({ page }) => {`);

        for (const step of scenario.steps) {
          const stepLower = step.toLowerCase();
          if (stepLower.includes('navigate') || stepLower.includes('visit') || stepLower.includes('go to')) {
            const pathMatch = step.match(/(?:to|visit|navigate)\s+(?:the\s+)?(.+?)(?:\s+page)?$/i);
            const path = pathMatch ? pathMatch[1].toLowerCase().replace(/\s+/g, '-') : '/';
            lines.push(`    // ${step}`);
            lines.push(`    await page.goto('${targetBaseUrl}/${path}');`);
            lines.push(`    await page.waitForLoadState('domcontentloaded');`);
          } else if (stepLower.includes('click') || stepLower.includes('press')) {
            const target = step.match(/(?:click|press)\s+(?:the\s+)?(.+?)$/i)?.[1] || 'button';
            lines.push(`    // ${step}`);
            lines.push(`    await page.getByRole('button', { name: /${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i }).click();`);
          } else if (stepLower.includes('enter') || stepLower.includes('type') || stepLower.includes('fill')) {
            const fieldMatch = step.match(/(?:enter|type|fill)\s+(?:in\s+)?(?:the\s+)?(.+?)$/i);
            const field = fieldMatch?.[1] || 'input';
            lines.push(`    // ${step}`);
            lines.push(`    await page.getByRole('textbox', { name: /${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i }).fill('test-value');`);
          } else if (stepLower.includes('see') || stepLower.includes('display') || stepLower.includes('show') || stepLower.includes('appear')) {
            const expectedText = step.match(/(?:see|display|show|appear)\s+(?:the\s+)?(.+?)$/i)?.[1] || 'expected content';
            lines.push(`    // ${step}`);
            lines.push(`    await expect(page.getByText(/${expectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/i)).toBeVisible();`);
          } else if (stepLower.includes('error') || stepLower.includes('fail')) {
            lines.push(`    // ${step}`);
            lines.push(`    await expect(page.getByRole('alert')).toBeVisible();`);
          } else if (stepLower.includes('redirect') || stepLower.includes('url')) {
            lines.push(`    // ${step}`);
            lines.push(`    await page.waitForURL(/.*/, { timeout: 10000 });`);
          } else {
            lines.push(`    // TODO: ${step}`);
            lines.push(`    // await page.locator('/* selector for: ${step.replace(/'/g, "\\'")} */').click();`);
          }
          lines.push('');
        }

        lines.push(`  });`);
        lines.push('');
      }

      lines.push(`});`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private cleanPlaywrightCode(raw: string): string {
    // Extract code from markdown code blocks if present
    const codeBlockMatch = raw.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();

    // If no code block, check if it looks like valid TypeScript
    if (raw.includes('import') && raw.includes('test')) return raw.trim();

    // Fallback: wrap in basic structure
    return `// AI-generated test code\n${raw.trim()}`;
  }

  // ── Risk assessment ─────────────────────────────────────────────────────

  private renderRiskAssessment(prioritized: PrioritizedScenario[]): string {
    const lines: string[] = [
      '# Risk Assessment',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Priority Distribution',
      '',
      `| Priority | Count | Description |`,
      `|----------|-------|-------------|`,
      `| P0 (Critical) | ${prioritized.filter(s => s.priority === 'P0').length} | Auth, payments, data integrity |`,
      `| P1 (High) | ${prioritized.filter(s => s.priority === 'P1').length} | Core business logic, CRUD |`,
      `| P2 (Medium) | ${prioritized.filter(s => s.priority === 'P2').length} | Display, navigation, search |`,
      `| P3 (Low) | ${prioritized.filter(s => s.priority === 'P3').length} | Visual, animations, tooltips |`,
      '',
      '## Test Layer Distribution',
      '',
      `| Layer | Count | Avg Duration |`,
      `|-------|-------|-------------|`,
      `| Unit | ${prioritized.filter(s => s.testLayer === 'unit').length} | ~100ms |`,
      `| Integration | ${prioritized.filter(s => s.testLayer === 'integration').length} | ~2000ms |`,
      `| E2E | ${prioritized.filter(s => s.testLayer === 'e2e').length} | ~${Math.round(prioritized.filter(s => s.testLayer === 'e2e').reduce((s, p) => s + p.estimatedDurationMs, 0) / Math.max(1, prioritized.filter(s => s.testLayer === 'e2e').length))}ms |`,
      '',
      '## Flakiness Risk Assessment',
      '',
    ];

    const highRisk = prioritized.filter(s => s.flakinessRisk === 'high');
    const mediumRisk = prioritized.filter(s => s.flakinessRisk === 'medium');

    if (highRisk.length > 0) {
      lines.push('### High Risk (need retry strategy or stabilization)');
      for (const s of highRisk) {
        lines.push(`- **${s.name}** — ${s.steps.join(' → ')}`);
      }
      lines.push('');
    }

    if (mediumRisk.length > 0) {
      lines.push('### Medium Risk (monitor for flakiness)');
      for (const s of mediumRisk) {
        lines.push(`- **${s.name}** — ${s.steps.join(' → ')}`);
      }
      lines.push('');
    }

    const totalDuration = prioritized.reduce((s, p) => s + p.estimatedDurationMs, 0);
    lines.push('## Estimated Total Execution Time');
    lines.push('');
    lines.push(`- Sequential: ${Math.round(totalDuration / 1000)}s`);
    lines.push(`- Parallel (4 workers): ~${Math.round(totalDuration / 4000)}s`);
    lines.push('');

    lines.push('## Recommendations');
    lines.push('');
    lines.push('1. Run P0 tests on every commit (CI gate)');
    lines.push('2. Run P0+P1 tests on PR creation');
    lines.push('3. Run full suite nightly or pre-release');
    lines.push('4. Add retry logic for high-flakiness scenarios');
    if (highRisk.length > 2) {
      lines.push('5. Consider splitting high-risk E2E tests into API-level integration tests');
    }

    return lines.join('\n');
  }

  // ── Automation evaluation ────────────────────────────────────────────────

  private buildCoverageSnapshot(
    scenarios: Array<{ name: string; steps: string[] }>,
    prioritized: PrioritizedScenario[]
  ): TraceCoverageSnapshot {
    return {
      flowCoverage: computeFlowCoverage(scenarios),
      edgeCaseCoverage: analyzeEdgeCaseCoverage(scenarios),
      riskWeightedCoverage: computeRiskWeightedCoverage(
        prioritized.map((scenario) => ({
          name: scenario.name,
          priority: scenario.priority,
          steps: scenario.steps,
        }))
      ),
    };
  }

  private resolveAutomationMode(payload: TracePayload): 'plan_only' | 'generate_and_run' {
    return payload.automationMode ?? 'plan_only';
  }

  private resolveTargetBaseUrl(payload: TracePayload): string {
    return payload.targetBaseUrl?.trim() || 'https://akisflow.com';
  }

  private resolveRunnerBrowserTarget(payload: TracePayload): 'chromium' | 'firefox' | 'webkit' {
    const browserTarget = payload.tracePreferences?.browserTarget;
    if (browserTarget === 'cross_browser') return 'chromium';
    if (browserTarget === 'mobile') return 'chromium';
    return 'chromium';
  }

  private buildTraceSpecs(scenarios: PrioritizedScenario[]): TraceTestSpec[] {
    return scenarios.map((scenario) => ({
      featureName: scenario.name,
      scenarios: [{ name: scenario.name, steps: scenario.steps }],
    }));
  }

  private estimatePlanFlakiness(prioritized: PrioritizedScenario[]): TraceFlakySnapshot {
    const riskBase: Record<PrioritizedScenario['flakinessRisk'], number> = {
      low: 0.15,
      medium: 0.45,
      high: 0.75,
    };
    const scenarioScores: Record<string, number> = {};
    for (const scenario of prioritized) {
      scenarioScores[scenario.name] = riskBase[scenario.flakinessRisk];
    }

    const total = Math.max(prioritized.length, 1);
    const pfsLite =
      Object.values(scenarioScores).reduce((sum, value) => sum + value, 0) / total;

    return {
      pfsLite: Number(pfsLite.toFixed(4)),
      retryCount: 0,
      quarantinedScenarios: [],
      flakyPassedScenarios: [],
      scenarioScores,
    };
  }

  private evaluatePlanOnlyAutomationExecution(
    scenarios: Array<{ name: string; steps: string[] }>,
    coverageMatrix: Record<string, string[]>,
    files: Array<{ path: string; cases: Array<{ name: string; steps: string[] }> }>,
    targetBaseUrl: string,
    startedAt = Date.now(),
    prioritized: PrioritizedScenario[],
  ): TraceAutomationSummary {
    const totalScenarios = scenarios.length;
    const passedScenarios = scenarios.filter(
      (scenario) => scenario.steps.length >= 2 && scenario.steps.every((step) => step.trim().length >= 5)
    ).length;
    const failedScenarios = Math.max(0, totalScenarios - passedScenarios);
    const executedScenarios = totalScenarios;
    const passRate = totalScenarios > 0 ? Math.round((passedScenarios / totalScenarios) * 100) : 0;
    const featuresTotal = Object.keys(coverageMatrix).length;
    const featuresPassed = Object.values(coverageMatrix).filter((tests) => tests.length > 0).length;
    const featuresFailed = Math.max(0, featuresTotal - featuresPassed);
    const featuresCovered = featuresPassed;
    const featureCoverageRate = featuresTotal > 0 ? Math.round((featuresCovered / featuresTotal) * 100) : 0;
    const testCasesTotal = files.reduce((sum, file) => sum + file.cases.length, 0);
    const testCasesPassed = Math.min(testCasesTotal, passedScenarios);
    const testCasesFailed = Math.max(0, testCasesTotal - testCasesPassed);
    const featurePassRate = featuresTotal > 0 ? Math.round((featuresPassed / featuresTotal) * 100) : 0;
    const failures = scenarios
      .filter((scenario) => !(scenario.steps.length >= 2 && scenario.steps.every((step) => step.trim().length >= 5)))
      .map((scenario) => ({
        feature: scenario.steps[0] ? scenario.steps[0].split(' ').slice(0, 3).join(' ') : scenario.name,
        test: scenario.name,
        reason: 'Scenario is under-specified for deterministic automation run',
      }));

    return {
      runner: 'playwright',
      targetBaseUrl,
      featuresTotal, featuresPassed, featuresFailed, featurePassRate,
      testCasesTotal, testCasesPassed, testCasesFailed,
      durationMs: Math.max(1, Date.now() - startedAt),
      failures,
      generatedTestPath: 'tests/generated/trace-tests.test.ts',
      totalScenarios, executedScenarios, passedScenarios, failedScenarios, passRate,
      featuresCovered, featureCoverageRate,
      mode: this.aiService ? 'ai-enhanced' : 'syntactic',
      priorityBreakdown: this.getPriorityBreakdown(prioritized),
      layerBreakdown: this.getLayerBreakdown(prioritized),
    };
  }

  private mapScenarioToFeature(
    scenarioName: string,
    coverageMatrix: Record<string, string[]>
  ): string {
    for (const [feature, tests] of Object.entries(coverageMatrix)) {
      if (tests.includes(scenarioName)) return feature;
    }
    return scenarioName;
  }

  private async evaluateAutomationExecution(
    scenarios: Array<{ name: string; steps: string[] }>,
    coverageMatrix: Record<string, string[]>,
    files: Array<{ path: string; cases: Array<{ name: string; steps: string[] }> }>,
    payload: TracePayload,
    startedAt = Date.now(),
    prioritized?: PrioritizedScenario[],
  ): Promise<TraceExecutionInsights> {
    const prioritizedScenarios = prioritized ?? this.classifyScenarios(scenarios);
    const coverage = this.buildCoverageSnapshot(scenarios, prioritizedScenarios);
    const targetBaseUrl = this.resolveTargetBaseUrl(payload);
    const automationMode = this.resolveAutomationMode(payload);

    if (automationMode !== 'generate_and_run') {
      const automationExecution = this.evaluatePlanOnlyAutomationExecution(
        scenarios,
        coverageMatrix,
        files,
        targetBaseUrl,
        startedAt,
        prioritizedScenarios
      );
      return {
        automationExecution,
        coverage,
        flaky: this.estimatePlanFlakiness(prioritizedScenarios),
      };
    }

    if (!payload.targetBaseUrl) {
      throw new Error('targetBaseUrl is required when automationMode=generate_and_run');
    }

    const specs = this.buildTraceSpecs(prioritizedScenarios);
    const flakyEvaluation = await this.flakyManager.evaluate(
      () =>
        this.traceAutomationRunner({
          specs,
          baseUrl: targetBaseUrl,
          browserTarget: this.resolveRunnerBrowserTarget(payload),
        }),
      prioritizedScenarios.map((scenario) => ({
        name: scenario.name,
        priority: scenario.priority,
        flakinessRisk: scenario.flakinessRisk,
      })),
      { strictness: payload.tracePreferences?.strictness }
    );

    const run = flakyEvaluation.finalRun;
    const failedScenarioSet = new Set(run.failures.map((failure) => failure.scenario));
    const featureEntries = Object.entries(coverageMatrix);
    const featuresTotal = featureEntries.length;
    const featuresPassed = featureEntries.filter(([, tests]) =>
      tests.every((scenarioName) => !failedScenarioSet.has(scenarioName))
    ).length;
    const featuresFailed = Math.max(0, featuresTotal - featuresPassed);
    const featuresCovered = featuresPassed;
    const featureCoverageRate = featuresTotal > 0 ? Math.round((featuresCovered / featuresTotal) * 100) : 0;
    const featurePassRate = featuresTotal > 0 ? Math.round((featuresPassed / featuresTotal) * 100) : 0;
    const testCasesTotal = files.reduce((sum, file) => sum + file.cases.length, 0);
    const testCasesPassed = Math.min(testCasesTotal, run.passedScenarios);
    const testCasesFailed = Math.max(0, testCasesTotal - testCasesPassed);

    const automationExecution: TraceAutomationSummary = {
      runner: 'playwright',
      targetBaseUrl,
      featuresTotal,
      featuresPassed,
      featuresFailed,
      featurePassRate,
      testCasesTotal,
      testCasesPassed,
      testCasesFailed,
      durationMs: Math.max(run.durationMs, Date.now() - startedAt),
      failures: run.failures.map((failure) => ({
        feature: failure.feature || this.mapScenarioToFeature(failure.scenario, coverageMatrix),
        test: failure.scenario,
        reason: failure.reason,
      })),
      generatedTestPath: run.generatedTestPath,
      totalScenarios: run.totalScenarios,
      executedScenarios: run.totalScenarios,
      passedScenarios: run.passedScenarios,
      failedScenarios: run.failedScenarios,
      passRate: run.passRate,
      featuresCovered,
      featureCoverageRate,
      mode: 'real',
      priorityBreakdown: this.getPriorityBreakdown(prioritizedScenarios),
      layerBreakdown: this.getLayerBreakdown(prioritizedScenarios),
      artifactPaths: {
        reportPath: run.reportPath,
        traceArtifactPath: run.traceArtifactPath,
      },
    };

    return {
      automationExecution,
      coverage,
      flaky: flakyEvaluation.flaky,
    };
  }
}
