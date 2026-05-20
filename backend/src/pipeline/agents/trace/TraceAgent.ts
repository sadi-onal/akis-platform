import type {
  StructuredSpec,
  TraceInput,
  TraceOutput,
} from '../../core/contracts/PipelineTypes.js';
import type { PipelineError } from '../../core/contracts/PipelineTypes.js';
import type { AnthropicImageBlock } from '../../../services/ai/multimodalClient.js';
import {
  PipelineErrorCode,
  createPipelineError,
  RETRY_CONFIG,
  GitHubTokenInvalidError,
} from '../../core/contracts/PipelineErrors.js';
import { createActivityEmitter } from '../../core/activityEmitter.js';
import { generateGherkinFromSpec } from '../../integrations/cucumberGenerator.js';
import {
  AKIS_E2E_WORKFLOW_PATH,
  mergeAkisCiWorkflowIntoTestFiles,
} from '../../templates/akisE2eWorkflow.js';
import { logger } from '../../../lib/logger.js';
import { parseAIJson } from '../../core/json-extract.js';
import type { AgenticLoopDeps } from '../../core/AgenticLoop.js';
import { runAgenticLoop } from '../../core/AgenticLoop.js';
import { TRACE_TOOLS, createTraceToolHandlers, type TraceToolDeps } from './trace-tools.js';
import type { SkillRegistry } from '../skills/index.js';
import {
  buildSystemPromptWithSkills,
  buildUseSkillTool,
  createUseSkillHandlers,
} from '../skills/index.js';

// ─── Dependency Interfaces ────────────────────────

export interface TraceAIDeps {
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
  /**
   * Optional multimodal path. When the pipeline forwarded user-uploaded
   * screenshots (e.g. UI mockups), Trace calls this instead of `generateText`
   * so the model can see the pixels while writing Playwright selectors.
   * Providers without multimodal support leave this undefined and Trace falls
   * back gracefully. Issue #464 BUG-C.
   */
  generateTextWithImages?(
    systemPrompt: string,
    userPrompt: string,
    images: readonly AnthropicImageBlock[]
  ): Promise<string>;
}

export interface TraceGitHubDeps {
  listFiles(owner: string, repo: string, branch: string): Promise<string[]>;
  getFileContent(owner: string, repo: string, branch: string, filePath: string): Promise<string>;
  commitFile(
    owner: string,
    repo: string,
    branch: string,
    filePath: string,
    content: string,
    message: string
  ): Promise<void>;
  pushFiles?(
    owner: string,
    repo: string,
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string
  ): Promise<void>;
  createBranch(owner: string, repo: string, branch: string, fromBranch?: string): Promise<void>;
  createPR(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string
  ): Promise<{ url: string }>;
}

export type TraceResult =
  | { type: 'output'; data: TraceOutput }
  | { type: 'error'; error: PipelineError };

// ─── Constants ────────────────────────────────────

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.css', '.html'];
const EXCLUDE_PATTERNS = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  '.next/',
  'coverage/',
  '.cache/',
  '__pycache__/',
];
const MAX_SOURCE_FILES = 80;
const MAX_FILE_SIZE_BYTES = 100_000; // 100KB per file
const AI_CALL_TIMEOUT_MS = RETRY_CONFIG.aiCallTimeoutMs;
const MAX_CODEBASE_CONTEXT_CHARS = RETRY_CONFIG.maxCodebaseContextChars;

/**
 * PR-V (2026-05-20): Build a bounded head+tail snippet of an AI response for
 * post-mortem debugging when all parse retries failed. Full 40-50K-char
 * payloads are noisy in pino logs and don't survive DB column limits — a
 * 600-char head + 600-char tail is enough to spot the truncation point and
 * the markdown fence pattern.
 */
function buildRawResponseSnippet(text: string, headLen = 600, tailLen = 600): string {
  if (text.length <= headLen + tailLen + 32) return text;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return `${head}\n…[${text.length - headLen - tailLen} chars elided]…\n${tail}`;
}

/** Timeout wrapper for individual AI calls (prevents indefinite hangs). */
function withAiTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`AI call timed out after ${Math.round(ms / 1000)}s`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

const TEST_GENERATION_PROMPT = `You are Trace, a code verifier and test writer for a software project pipeline.

Your task is to read a generated codebase and write comprehensive Playwright end-to-end tests.

Instructions:
1. Analyze the codebase:
   - Identify all routes/pages
   - Identify interactive components (forms, buttons, navigation)
   - Identify API endpoints (if any)
   - Note the tech stack and frameworks used

2. Map acceptance criteria to test scenarios:
   - Each acceptance criterion should have at least 1 test
   - Add tests for: page navigation, form validation, error states

3. Use Page Object Model pattern:
   - Create BasePage class with common utilities
   - Create page-specific classes extending BasePage
   - Tests should use page objects, not direct selectors

4. Generate coverage matrix:
   - Map each acceptance criteria ID to test file(s) that cover it

Output Format — respond ONLY with valid JSON:
{
  "testFiles": [
    {"filePath": "tests/e2e/auth.spec.ts", "content": "...", "testCount": 4},
    {"filePath": "tests/page-objects/BasePage.ts", "content": "...", "testCount": 0}
  ],
  "coverageMatrix": {
    "ac-1": ["tests/e2e/auth.spec.ts"],
    "ac-2": ["tests/e2e/crud.spec.ts"]
  },
  "testSummary": {
    "totalTests": 8,
    "coveragePercentage": 80,
    "coveredCriteria": ["ac-1", "ac-2"],
    "uncoveredCriteria": ["ac-5"]
  }
}

Also generate a playwright.config.ts file in the testFiles array.

Playwright Best Practices:
- PREFER semantic locators in this order: getByRole() > getByText() > getByTestId() > getByLabel() > CSS selectors (last resort)
- Use getByRole('button', { name: 'Submit' }) instead of page.locator('button.submit')
- Use getByText('expected text') for verifying visible content
- Use data-testid attributes only when semantic locators are ambiguous
- ALWAYS use web-first assertions: expect(locator).toBeVisible(), toHaveText(), toContainText(), toHaveValue()
- NEVER use manual waitForTimeout() — use expect(locator).toBeVisible() or page.waitForURL() instead
- Use await expect(page).toHaveURL(/pattern/) for navigation assertions
- Add descriptive messages to assertions: expect(btn).toBeVisible({ message: 'Login button should appear after page load' })

Turkish UI Text Handling:
- The target application may use Turkish UI labels (e.g. "Giriş Yap", "Kayıt Ol", "Gönder", "Ayarlar")
- Match visible text EXACTLY as it appears in the source code — do not translate Turkish labels to English in selectors
- Use getByText() or getByRole() with the Turkish label: getByRole('button', { name: 'Giriş Yap' })
- If i18n keys are present in code, use the resolved Turkish text for assertions, not the key
- Test file names and describe/it blocks should be in English, but text matchers must use the actual UI language

Test Reliability:
- Structure tests: test.describe('Feature', () => { test('should do X', async ({ page }) => { ... }) })
- Use beforeEach for common navigation: test.beforeEach(async ({ page }) => { await page.goto('/'); })
- Avoid brittle selectors: NO nth-child(), NO deeply nested CSS paths, NO auto-generated class names
- Use page.waitForLoadState('networkidle') only when necessary — prefer waiting for specific elements
- For forms: fill then assert, e.g. await input.fill('test'); await expect(input).toHaveValue('test')
- For async operations: await expect(successMsg).toBeVisible({ timeout: 10_000 })

Rules:
- Write ONLY end-to-end tests (no unit tests)
- Do NOT run the tests — only write them
- Do NOT modify existing source code
- Use TypeScript for all test files
- Use descriptive test names in English
- Use test.describe blocks to group related tests
- Include proper expect assertions with descriptive failure messages
- temperature=0

AFTER generating Playwright test files, perform TRACEABILITY CHECK:

For each Acceptance Criterion (AC) in the input spec:
- [ ] At least one test case covers this AC
- [ ] The test's setup (beforeEach/arrange) matches the "Given" condition
- [ ] The test's action (act) matches the "When" trigger
- [ ] The test's assertion (expect) matches the "Then" outcome

Include a "traceability" array in your JSON output mapping each AC to the test covering it:
[
  {"criterionId": "ac-1", "testFile": "tests/e2e/app.spec.ts", "testName": "should display initial state", "coverage": "full"},
  {"criterionId": "ac-2", "testFile": "tests/e2e/crud.spec.ts", "testName": "should add new item", "coverage": "full"}
]

"coverage" must be one of: "full" (Given+When+Then all covered), "partial" (some steps missing), "none".

If any criterion has no test coverage, add it to the "uncoveredCriteria" array in testSummary and explain why in the traceability entry with coverage: "none".`;

// ─── TraceAgent ───────────────────────────────────

export class TraceAgent {
  private ai: TraceAIDeps;
  private github: TraceGitHubDeps;
  private agenticDeps?: AgenticLoopDeps;
  private skillRegistry?: SkillRegistry;

  constructor(
    ai: TraceAIDeps,
    github: TraceGitHubDeps,
    agenticDeps?: AgenticLoopDeps,
    skillRegistry?: SkillRegistry
  ) {
    this.ai = ai;
    this.github = github;
    this.agenticDeps = agenticDeps;
    this.skillRegistry = skillRegistry;
  }

  private enhance(basePrompt: string): string {
    if (!this.skillRegistry) return basePrompt;
    return buildSystemPromptWithSkills(basePrompt, 'trace', this.skillRegistry);
  }

  /**
   * Route Trace's test-generation AI call to either the multimodal or
   * text-only path. Mirrors Proto's dispatchIterationGenerate pattern so
   * providers without multimodal support keep working. Issue #464 BUG-C.
   */
  private async dispatchGenerate(
    systemPrompt: string,
    userPrompt: string,
    images?: readonly AnthropicImageBlock[]
  ): Promise<string> {
    const hasImages = images && images.length > 0;
    if (hasImages && this.ai.generateTextWithImages) {
      try {
        return await this.ai.generateTextWithImages(systemPrompt, userPrompt, images);
      } catch (err) {
        logger.warn(
          { err, imageCount: images.length },
          '[trace] multimodal path failed, falling back to text-only'
        );
      }
    }
    return this.ai.generateText(systemPrompt, userPrompt);
  }

  async execute(input: TraceInput): Promise<TraceResult> {
    const emit = input.pipelineId ? createActivityEmitter(input.pipelineId, 'trace') : undefined;

    // PR-F2 (2026-05-19): when running pre-push-gate, the orchestrator passes
    // dryRun=true PLUS Proto's in-memory files as `inputFiles`. We must skip
    // both the agentic GitHub tool-use loop AND the legacy listFiles fetch —
    // the scaffold isn't on GitHub yet. Test execution is also skipped (we
    // only generate the test plan + coverage matrix).
    const useLocalFiles =
      input.dryRun === true && Array.isArray(input.inputFiles) && input.inputFiles.length > 0;

    // Agentic path: if tool_use deps available and not dryRun, use Claude with tools.
    // dryRun (with or without inputFiles) always takes the legacy path so we can
    // bypass GitHub I/O.
    if (this.agenticDeps && !input.dryRun && this.github.pushFiles) {
      try {
        return await this.executeWithTools(input, emit);
      } catch (err) {
        logger.error({ err }, '[Trace] Agentic execution failed, falling back to legacy path');
      }
    }

    // Legacy path: Step 1: Read codebase — either local inputFiles or GitHub.
    let files: Array<{ filePath: string; content: string }>;
    if (useLocalFiles) {
      emit?.(
        'fetching',
        `Lokal scaffold dosyaları okunuyor (${input.inputFiles!.length} dosya)...`,
        15,
        undefined,
        undefined,
        'pipeline.activity.trace.reading_repo'
      );
      // Filter to source-like files only (mirrors readCodebase's filter) but
      // keep the budget loose — Proto outputs are bounded by their own caps.
      files = input
        .inputFiles!.filter(
          (f) => this.isSourceFile(f.filePath) && f.content.length <= MAX_FILE_SIZE_BYTES
        )
        .slice(0, MAX_SOURCE_FILES)
        .map((f) => ({ filePath: f.filePath, content: f.content }));
    } else {
      emit?.(
        'fetching',
        'İskelet dalından kaynak dosyalar alınıyor...',
        15,
        undefined,
        undefined,
        'pipeline.activity.trace.reading_repo'
      );
      const codebaseResult = await this.readCodebase(
        input.repoOwner,
        input.repo,
        input.branch,
        emit
      );
      if (codebaseResult.type === 'error') {
        emit?.('error', 'Kod tabanı okunamadı', 0);
        return codebaseResult;
      }
      files = codebaseResult.data;
    }

    if (files.length === 0) {
      emit?.(
        'error',
        useLocalFiles ? 'Lokal scaffold dosyası bulunamadı' : 'Depoda kaynak dosya bulunamadı',
        0
      );
      return {
        type: 'error',
        error: createPipelineError(
          PipelineErrorCode.TRACE_EMPTY_CODEBASE,
          useLocalFiles
            ? 'No source files in supplied inputFiles'
            : 'No source files found in repository'
        ),
      };
    }

    emit?.('analyzing', `Test stratejisi belirleniyor (${files.length} dosya)`, 30);

    // Step 2: Generate tests via AI (with dedicated timeout)
    const totalChars = files.reduce((sum, f) => sum + f.content.length, 0);
    emit?.(
      'ai_call',
      `Claude AI ile Playwright testleri oluşturuluyor (${files.length} dosya, ${Math.round(totalChars / 1024)}KB)...`,
      45,
      undefined,
      undefined,
      'pipeline.activity.trace.writing_scenarios'
    );
    const testsResult = await this.generateTests(
      files,
      input.spec,
      emit,
      input.knowledgeContext,
      input.imageBlocks
    );
    if (testsResult.type === 'error') {
      emit?.('error', 'Test üretimi başarısız oldu', 0);
      return testsResult;
    }

    const { testFiles, coverageMatrix, testSummary } = testsResult.data;
    emit?.('parsing', `${testFiles.length} test dosyası hazırlandı`, 75);

    // Generate BDD/Gherkin feature files from spec (only when Cucumber is enabled)
    const gherkinResult =
      input.cucumberEnabled && input.spec
        ? generateGherkinFromSpec(input.spec)
        : { features: [], stepDefinitions: [] };

    if (input.dryRun) {
      return {
        type: 'output',
        data: {
          ok: true,
          testFiles,
          coverageMatrix,
          testSummary,
          gherkinFeatures: gherkinResult.features,
          stepDefinitions: gherkinResult.stepDefinitions,
        },
      };
    }

    // Step 3: Push test files + Gherkin features to Proto's branch
    const branchName = input.branch;
    emit?.('traceability', 'Testler doğrulanıyor', 85);

    // Combine Playwright test files with Gherkin feature/step files for push
    const allFilesToPush: TraceOutput['testFiles'] = mergeAkisCiWorkflowIntoTestFiles([
      ...testFiles,
      ...gherkinResult.features.map((f) => ({
        filePath: f.filePath,
        content: f.content,
        testCount: f.scenarioCount,
      })),
      ...gherkinResult.stepDefinitions.map((s) => ({
        filePath: s.filePath,
        content: s.content,
        testCount: 0,
      })),
    ]);

    const pushResult = await this.pushTestFiles(
      input.repoOwner,
      input.repo,
      branchName,
      allFilesToPush
    );
    if (pushResult.type === 'error') {
      emit?.('error', 'Test dosyaları yüklenemedi', 0);
      return pushResult;
    }

    // Step 5: Create PR (non-fatal)
    let prUrl: string | undefined;
    try {
      const pr = await this.github.createPR(
        input.repoOwner,
        input.repo,
        'test: add Playwright e2e tests',
        this.buildPRBody(testSummary, coverageMatrix, true),
        branchName,
        input.branch
      );
      prUrl = pr.url;
    } catch {
      // PR failure is non-fatal — tests are already pushed
    }

    emit?.('complete', `Tamamlandı — ${testFiles.length} test dosyası hazır`, 100);
    return {
      type: 'output',
      data: {
        ok: true,
        testFiles,
        coverageMatrix,
        testSummary,
        branch: branchName,
        prUrl,
        ciWorkflowPath: AKIS_E2E_WORKFLOW_PATH,
        gherkinFeatures: gherkinResult.features,
        stepDefinitions: gherkinResult.stepDefinitions,
      },
    };
  }

  // ─── Agentic Tool-Use Execution Path ────────────

  private async executeWithTools(
    input: TraceInput,
    emit?: ReturnType<typeof createActivityEmitter>
  ): Promise<TraceResult> {
    emit?.('ai_call', 'Claude AI tool_use ile test yazılıyor...', 10);

    // Issue #397: generate Gherkin features alongside Playwright tests when the
    // BDD toggle is on. Previously this only ran in the legacy path — the
    // agentic path (production default) silently ignored `cucumberEnabled`.
    const gherkin =
      input.cucumberEnabled && input.spec
        ? generateGherkinFromSpec(input.spec)
        : {
            features: [] as ReturnType<typeof generateGherkinFromSpec>['features'],
            stepDefinitions: [] as ReturnType<typeof generateGherkinFromSpec>['stepDefinitions'],
          };
    // We inject the .feature + .steps.ts files into the first successful
    // push_files call so everything lands in the same branch + commit. The
    // flag prevents duplicate additions across multi-push loops.
    let gherkinAttached = false;

    const toolDeps: TraceToolDeps = {
      listFiles: (owner, repo, branch) => this.github.listFiles(owner, repo, branch),
      getFileContent: (owner, repo, branch, filePath) =>
        this.github.getFileContent(owner, repo, branch, filePath),
      pushFiles: (owner, repo, branch, files, message) => {
        const extraFiles: Array<{ path: string; content: string }> = [];
        if (!gherkinAttached && gherkin.features.length > 0) {
          extraFiles.push(
            ...gherkin.features.map((f) => ({ path: f.filePath, content: f.content })),
            ...gherkin.stepDefinitions.map((s) => ({ path: s.filePath, content: s.content }))
          );
          gherkinAttached = true;
        }
        const combined = [...files, ...extraFiles];
        const merged = mergeAkisCiWorkflowIntoTestFiles(
          combined.map((f) => ({
            filePath: f.path,
            content: f.content,
            testCount: 0,
          }))
        );
        return this.github.pushFiles!(
          owner,
          repo,
          branch,
          merged.map((f) => ({ path: f.filePath, content: f.content })),
          message
        );
      },
      createBranch: (owner, repo, branch, fromBranch) =>
        this.github.createBranch(owner, repo, branch, fromBranch),
    };
    const handlers = createTraceToolHandlers(toolDeps);

    const specContext = input.spec
      ? `\nSpec:\n- Title: ${input.spec.title}\n- Acceptance Criteria:\n${input.spec.acceptanceCriteria.map((ac) => `  ${ac.id}: WHEN ${ac.when} THEN ${ac.then}`).join('\n')}`
      : '';

    const pipelineKnowledge = input.knowledgeContext?.trim()
      ? `\n--- FULL PIPELINE CONTEXT (chat + GitHub signals) ---\n${input.knowledgeContext.trim()}\n--- END FULL PIPELINE CONTEXT ---\n\n`
      : '';

    const hasImages = (input.imageBlocks?.length ?? 0) > 0;
    const imageAck = hasImages
      ? `\n\nThe user attached ${input.imageBlocks!.length} screenshot(s) — treat them as authoritative for visible labels and layout when writing selectors/assertions.`
      : '';

    const userPrompt = `${pipelineKnowledge}Write Playwright e2e tests for the project at GitHub: ${input.repoOwner}/${input.repo} (branch: ${input.branch})
${specContext}${imageAck}

Steps:
1. Call list_files to see what source files exist
2. Call read_file for key source files (App.jsx, components, etc.) to understand the code
3. Write comprehensive Playwright tests that verify each acceptance criterion
4. Create a test branch "trace/tests" from main
5. Call push_files to push test files to the test branch

After pushing, respond with a JSON summary:
{
  "testFiles": [{"filePath": "...", "testCount": N}],
  "coverageMatrix": {"AC-1": ["test-file.spec.ts"], ...},
  "testSummary": {"totalTests": N, "coveragePercentage": N, "coveredCriteria": [...], "uncoveredCriteria": [...]}
}`;

    const traceTools = [...TRACE_TOOLS];
    let allHandlers = handlers;
    if (this.skillRegistry) {
      const skillTool = buildUseSkillTool('trace', this.skillRegistry);
      if (skillTool) {
        traceTools.push(skillTool);
        allHandlers = { ...handlers, ...createUseSkillHandlers('trace', this.skillRegistry) };
      }
    }

    const result = await runAgenticLoop(
      this.agenticDeps!,
      this.enhance(TEST_GENERATION_PROMPT),
      userPrompt,
      traceTools,
      allHandlers,
      {
        maxIterations: 15,
        maxTokens: 32768,
        temperature: 0,
        // Issue #464 BUG-C: forward user-uploaded screenshots into the initial
        // user message so the vision-capable model can reference them while
        // writing test selectors. Non-multimodal providers ignore these.
        initialImages: hasImages ? input.imageBlocks : undefined,
        onToolCall: (name) => {
          if (name === 'list_files') emit?.('fetching', 'Dosya listesi okunuyor...', 20);
          if (name === 'read_file') emit?.('fetching', 'Kaynak dosya okunuyor...', 40);
          if (name === 'push_files')
            emit?.(
              'github_push',
              'Test dosyaları yükleniyor...',
              80,
              undefined,
              undefined,
              'pipeline.activity.trace.pushing_tests'
            );
        },
      }
    );

    // Parse the final JSON summary from Claude's text response
    try {
      const jsonMatch = result.text.match(/\{[\s\S]*"testFiles"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          testFiles?: Array<{ filePath: string; testCount: number }>;
          coverageMatrix?: Record<string, string[]>;
          testSummary?: {
            totalTests: number;
            coveragePercentage: number;
            coveredCriteria: string[];
            uncoveredCriteria: string[];
          };
        };

        emit?.(
          'complete',
          `Testler yazıldı: ${parsed.testSummary?.totalTests ?? 0} test (tool_use)`,
          100
        );
        return {
          type: 'output',
          data: {
            ok: true,
            testFiles: (parsed.testFiles ?? []).map((f) => ({
              filePath: f.filePath,
              content: '',
              testCount: f.testCount,
            })),
            coverageMatrix: parsed.coverageMatrix ?? {},
            testSummary: parsed.testSummary ?? {
              totalTests: 0,
              coveragePercentage: 0,
              coveredCriteria: [],
              uncoveredCriteria: [],
            },
            branch: 'trace/tests',
            ciWorkflowPath: AKIS_E2E_WORKFLOW_PATH,
            gherkinFeatures: gherkin.features,
            stepDefinitions: gherkin.stepDefinitions,
          },
        };
      }
    } catch {
      /* fall through to default */
    }

    // Default: could not parse structured output
    emit?.('complete', 'Test yazımı tamamlandı (tool_use)', 100);
    return {
      type: 'output',
      data: {
        ok: true,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 0,
          coveragePercentage: 0,
          coveredCriteria: [],
          uncoveredCriteria: [],
        },
        gherkinFeatures: gherkin.features,
        stepDefinitions: gherkin.stepDefinitions,
      },
    };
  }

  // ─── Code Reading ──────────────────────────────

  private async readCodebase(
    owner: string,
    repo: string,
    branch: string,
    emit?: ReturnType<typeof createActivityEmitter>
  ): Promise<
    | { type: 'output'; data: Array<{ filePath: string; content: string }> }
    | { type: 'error'; error: PipelineError }
  > {
    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const allFiles = await this.github.listFiles(owner, repo, branch);
        const sourceFiles = allFiles.filter((f) => this.isSourceFile(f)).slice(0, MAX_SOURCE_FILES);

        emit?.('fetching', `${sourceFiles.length} kaynak dosya okunuyor...`, 18);

        const contents: Array<{ filePath: string; content: string }> = [];
        let totalChars = 0;
        for (let i = 0; i < sourceFiles.length; i++) {
          const filePath = sourceFiles[i];
          const content = await this.github.getFileContent(owner, repo, branch, filePath);
          if (content.length > MAX_FILE_SIZE_BYTES) continue;

          // Enforce total context budget
          if (totalChars + content.length > MAX_CODEBASE_CONTEXT_CHARS) {
            logger.info(
              `[Trace] Context budget reached at file ${i + 1}/${sourceFiles.length} (${totalChars} chars). Stopping.`
            );
            break;
          }

          contents.push({ filePath, content });
          totalChars += content.length;

          // Emit progress every 3 files
          if ((i + 1) % 3 === 0 || i === sourceFiles.length - 1) {
            const pct = 15 + Math.round(((i + 1) / sourceFiles.length) * 12);
            emit?.('fetching', `${i + 1}/${sourceFiles.length} dosya okundu...`, pct);
          }
        }

        return { type: 'output', data: contents };
      } catch (err) {
        // PR-V-github-401-graceful — when GitHub returns 401, the user's
        // token is invalid. Retrying with the same dead credential burns
        // backoff time for nothing and the eventual failure surfaces as a
        // vague TRACE_CODE_READ_FAILED. Short-circuit with a dedicated
        // GITHUB_TOKEN_INVALID error so the banner renders a "Reconnect
        // GitHub" CTA and the orchestrator can drop the stale row from
        // `github_integrations` instead of trying again.
        if (err instanceof GitHubTokenInvalidError) {
          logger.warn(
            { owner, repo, branch, attempt: attempt + 1 },
            '[Trace] readCodebase: 401 detected — surfacing GITHUB_TOKEN_INVALID without retry'
          );
          return {
            type: 'error',
            error: createPipelineError(PipelineErrorCode.GITHUB_TOKEN_INVALID, err.message),
          };
        }
        if (attempt < RETRY_CONFIG.maxRetries) {
          emit?.(
            'retry',
            `Dosya okuma yeniden deneniyor (${attempt + 1})...`,
            15,
            undefined,
            attempt + 1
          );
          await this.delay(RETRY_CONFIG.backoffDelays[attempt]);
          continue;
        }
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.TRACE_CODE_READ_FAILED,
            `Failed to read codebase: ${err instanceof Error ? err.message : String(err)}`
          ),
        };
      }
    }

    return {
      type: 'error',
      error: createPipelineError(PipelineErrorCode.TRACE_CODE_READ_FAILED, 'Unreachable'),
    };
  }

  private isSourceFile(filePath: string): boolean {
    if (EXCLUDE_PATTERNS.some((p) => filePath.includes(p))) return false;
    return SOURCE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
  }

  // ─── Test Generation ───────────────────────────

  private async generateTests(
    files: Array<{ filePath: string; content: string }>,
    spec?: StructuredSpec,
    emit?: ReturnType<typeof createActivityEmitter>,
    knowledgeContext?: string,
    imageBlocks?: readonly AnthropicImageBlock[]
  ): Promise<
    | { type: 'output'; data: Pick<TraceOutput, 'testFiles' | 'coverageMatrix' | 'testSummary'> }
    | { type: 'error'; error: PipelineError }
  > {
    const codebaseContext = files.map((f) => `--- ${f.filePath} ---\n${f.content}`).join('\n\n');
    const specContext = spec ? JSON.stringify(spec, null, 2) : 'No specification provided.';
    const hasImages = (imageBlocks?.length ?? 0) > 0;
    const imageAckSection = hasImages
      ? `\n\n## User-Uploaded Screenshots\n\nThe user attached ${imageBlocks!.length} screenshot(s) alongside the original request. Use them to disambiguate selectors, expected visible labels, and assertion text. Treat the screenshots as authoritative for what the UI is supposed to look like — if a label appears in the screenshot, prefer matching that exact text in your Playwright selectors.\n`
      : '';
    const userPrompt = `## Codebase\n\n${codebaseContext}\n\n## Specification\n\n${specContext}${imageAckSection}`;

    for (let attempt = 0; attempt <= RETRY_CONFIG.specValidationMaxRetries; attempt++) {
      let responseText: string;
      try {
        if (attempt === 0) {
          emit?.('ai_call', `Playwright testleri oluşturuluyor (deneme ${attempt + 1})...`, 45);
        } else {
          emit?.(
            'ai_call',
            `Playwright testleri oluşturuluyor (deneme ${attempt + 1})...`,
            45,
            undefined,
            attempt
          );
        }
        const traceSystemPrompt = knowledgeContext
          ? `${this.enhance(TEST_GENERATION_PROMPT)}\n\n--- RETRIEVED KNOWLEDGE ---\n${knowledgeContext}\n--- END KNOWLEDGE ---`
          : this.enhance(TEST_GENERATION_PROMPT);
        const aiPromise = this.dispatchGenerate(traceSystemPrompt, userPrompt, imageBlocks);
        responseText = await withAiTimeout(aiPromise, AI_CALL_TIMEOUT_MS);
        emit?.('parsing', 'AI yanıtı alındı, ayrıştırılıyor...', 65);
      } catch (err) {
        const isTimeout = err instanceof Error && err.message.includes('timed out');
        if (isTimeout) {
          logger.warn(
            `[Trace] AI call timed out after ${AI_CALL_TIMEOUT_MS / 1000}s (attempt ${attempt + 1})`
          );
          emit?.('retry', `AI yanıt vermedi, tekrar deneniyor...`, 40, undefined, attempt + 1);
        }
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        return {
          type: 'error',
          error: createPipelineError(
            isTimeout
              ? PipelineErrorCode.TRACE_AI_CALL_TIMEOUT
              : PipelineErrorCode.TRACE_TEST_GENERATION_FAILED,
            isTimeout
              ? `AI call timed out after ${AI_CALL_TIMEOUT_MS / 1000}s`
              : 'AI call failed after retries'
          ),
        };
      }

      let parsed: unknown;
      try {
        parsed = parseAIJson(responseText);
      } catch (parseErr) {
        logger.warn(
          `[Trace] JSON parse failed (attempt ${attempt + 1}, responseLen=${responseText.length}): ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
        );
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        // PR-V (2026-05-20): when all parse attempts fail, capture a bounded
        // head+tail snippet of the raw AI response in `technicalDetail` so
        // the orchestrator can persist it onto `intermediateState.lastFailedTraceResponse`.
        // Future debugging no longer needs to grep pino logs for the broken
        // 40K-char blob — it lives on the pipeline row.
        const snippet = buildRawResponseSnippet(responseText);
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.TRACE_TEST_GENERATION_FAILED,
            `Invalid JSON from test generation (len=${responseText.length}). Snippet:\n${snippet}`
          ),
        };
      }

      const obj = parsed as Record<string, unknown>;
      const testFiles = obj.testFiles as TraceOutput['testFiles'] | undefined;
      const coverageMatrix = obj.coverageMatrix as Record<string, string[]> | undefined;
      const testSummary = obj.testSummary as TraceOutput['testSummary'] | undefined;

      if (!testFiles || !Array.isArray(testFiles) || testFiles.length === 0) {
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.TRACE_TEST_GENERATION_FAILED,
            'No test files generated'
          ),
        };
      }

      const normalizedFiles = testFiles.map((f) => ({
        filePath: String(f.filePath),
        content: String(f.content),
        testCount: typeof f.testCount === 'number' ? f.testCount : 0,
      }));

      const totalTests = normalizedFiles.reduce((sum, f) => sum + f.testCount, 0);
      const specCriteria = spec?.acceptanceCriteria?.map((ac) => ac.id) ?? [];
      const coveredCriteria = coverageMatrix
        ? Object.keys(coverageMatrix).filter((k) => specCriteria.includes(k))
        : [];
      const uncoveredCriteria = specCriteria.filter((id) => !coveredCriteria.includes(id));

      return {
        type: 'output',
        data: {
          testFiles: normalizedFiles,
          coverageMatrix: coverageMatrix ?? {},
          testSummary: testSummary ?? {
            totalTests,
            coveragePercentage:
              specCriteria.length > 0
                ? Math.round((coveredCriteria.length / specCriteria.length) * 100)
                : 100,
            coveredCriteria,
            uncoveredCriteria,
          },
        },
      };
    }

    return {
      type: 'error',
      error: createPipelineError(
        PipelineErrorCode.TRACE_TEST_GENERATION_FAILED,
        'All retries exhausted'
      ),
    };
  }

  // ─── Push Test Files ───────────────────────────

  private async pushTestFiles(
    owner: string,
    repo: string,
    branch: string,
    files: TraceOutput['testFiles']
  ): Promise<{ type: 'output' } | { type: 'error'; error: PipelineError }> {
    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        if (this.github.pushFiles) {
          await this.github.pushFiles(
            owner,
            repo,
            branch,
            files.map((f) => ({ path: f.filePath, content: f.content })),
            `test: playwright tests generated by AKIS Trace (${files.length} files)`
          );
        } else {
          for (const file of files) {
            await this.github.commitFile(
              owner,
              repo,
              branch,
              file.filePath,
              file.content,
              `test: add ${file.filePath}`
            );
          }
        }
        return { type: 'output' };
      } catch (err) {
        if (attempt < RETRY_CONFIG.maxRetries) {
          await this.delay(RETRY_CONFIG.backoffDelays[attempt]);
          continue;
        }
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.TRACE_TEST_GENERATION_FAILED,
            `Push failed after ${RETRY_CONFIG.maxRetries} retries: ${err instanceof Error ? err.message : String(err)}`
          ),
        };
      }
    }

    return {
      type: 'error',
      error: createPipelineError(PipelineErrorCode.TRACE_TEST_GENERATION_FAILED, 'Unreachable'),
    };
  }

  // ─── Helpers ────────────────────────────────────

  private buildPRBody(
    summary: TraceOutput['testSummary'],
    matrix: Record<string, string[]>,
    includeCiHint = false
  ): string {
    const lines = [
      '## Playwright E2E Tests',
      '',
      `- ${summary.totalTests} test yazıldı`,
      `- ${summary.coveragePercentage}% acceptance criteria coverage`,
      '',
    ];

    if (includeCiHint) {
      lines.push(
        '### GitHub Actions',
        '',
        `Bu depoya \`${AKIS_E2E_WORKFLOW_PATH}\` eklendi: yükleme veya değişiklik teklifi sonrası Playwright E2E ve (varsa) Cucumber özellik dosyaları koşar.`,
        'Sonuçlar **Actions** sekmesinde; başarısızlıkta `playwright-report` artifact yüklenir.',
        ''
      );
    }

    if (Object.keys(matrix).length > 0) {
      lines.push('### Coverage Matrix');
      for (const [criteria, tests] of Object.entries(matrix)) {
        lines.push(`- **${criteria}**: ${tests.join(', ')}`);
      }
      lines.push('');
    }

    if (summary.uncoveredCriteria.length > 0) {
      lines.push('### Uncovered Criteria');
      lines.push(...summary.uncoveredCriteria.map((c) => `- ${c}`));
      lines.push('');
    }

    lines.push('> Bu testler AKIS Trace agent tarafından otomatik oluşturuldu.'); // allow:push
    return lines.join('\n');
  }

  // JSON extraction and repair are now in shared utility:
  // import { parseAIJson, extractJsonSafe } from '../../core/json-extract.js';

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
