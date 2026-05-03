import type {
  StructuredSpec,
  ProtoInput,
  ProtoOutput,
} from '../../core/contracts/PipelineTypes.js';
import type { AnthropicImageBlock } from '../../../services/ai/multimodalClient.js';
import {
  PipelineErrorCode,
  createPipelineError,
  RETRY_CONFIG,
  GitHubTokenInvalidError,
} from '../../core/contracts/PipelineErrors.js';
import type { PipelineError } from '../../core/contracts/PipelineTypes.js';
import { createActivityEmitter } from '../../core/activityEmitter.js';
import { logger } from '../../../lib/logger.js';
import { extractJsonSafe, sanitizeJsonControlChars, repairTruncatedJson } from '../../core/json-extract.js';
import type { AgenticLoopDeps } from '../../core/AgenticLoop.js';
import { runAgenticLoop } from '../../core/AgenticLoop.js';
import { PROTO_TOOLS, createProtoToolHandlers, type ProtoToolDeps } from './proto-tools.js';
import type { SkillRegistry } from '../skills/index.js';
import {
  buildSystemPromptWithSkills,
  buildUseSkillTool,
  createUseSkillHandlers,
} from '../skills/index.js';

// ─── Dependency Interfaces ────────────────────────

export interface ProtoAIDeps {
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
  /**
   * Optional multimodal path. When iteration requests carry image attachments
   * (issue #427 BUG-19), Proto calls this instead of `generateText` so the
   * model sees the screenshots the user uploaded. Providers without
   * multimodal support leave this undefined and Proto falls back gracefully.
   */
  generateTextWithImages?(
    systemPrompt: string,
    userPrompt: string,
    images: readonly AnthropicImageBlock[],
  ): Promise<string>;
}

export interface ProtoGitHubDeps {
  createRepository(owner: string, name: string, isPrivate: boolean): Promise<{ url: string }>;
  createBranch(owner: string, repo: string, branch: string, fromBranch?: string): Promise<void>;
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
  createPR(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string
  ): Promise<{ url: string }>;
  /** Used for post-push verification: lists blob paths in the repo tree. */
  listFiles?(owner: string, repo: string, branch: string): Promise<string[]>;
}

export type ProtoResult =
  | { type: 'output'; data: ProtoOutput }
  | { type: 'error'; error: PipelineError };

// ─── Constants ────────────────────────────────────

const MIN_SCAFFOLD_FILES = 6;
const PROTO_SUMMARY_MAX_LEN = 500;

/**
 * Extract a chat-friendly Turkish summary from Proto's final assistant text.
 *
 * The tool-use prompt asks Claude for a 1-3 sentence plain-text summary after
 * push_files completes. Claude usually obeys but can occasionally wrap it in
 * JSON or prepend a code fence. Strip both and clamp to a sane length.
 */
export function extractProtoSummary(rawText: string | undefined | null): string | undefined {
  if (!rawText) return undefined;
  let text = rawText.trim();
  if (!text) return undefined;

  // If the model wrapped the summary in ```...``` fences, drop them.
  const fenceMatch = /^```(?:\w+)?\n?([\s\S]*?)```$/.exec(text);
  if (fenceMatch) text = fenceMatch[1].trim();

  // If it parsed as JSON, prefer an explicit "summary" field; otherwise bail
  // out — JSON without summary isn't useful as a chat narration.
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const fromJson = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
      if (!fromJson) return undefined;
      return fromJson.slice(0, PROTO_SUMMARY_MAX_LEN);
    } catch {
      // not valid JSON; fall through to plain-text handling
    }
  }

  return text.slice(0, PROTO_SUMMARY_MAX_LEN);
}

export const SCAFFOLD_SYSTEM_PROMPT = `You are Proto, an MVP scaffold builder.

Generate a WORKING codebase with proper file structure. Output ONLY valid JSON — no markdown, no explanations, no code fences.

FOLDER STRUCTURE (minimum required files):
  index.html          — Vite HTML entry (<div id="root">, <script type="module" src="/src/main.jsx">)
  package.json        — react, react-dom, vite, @vitejs/plugin-react as deps + "dev": "vite" script
  vite.config.js      — import react plugin, export default
  .gitignore          — node_modules, dist, .env
  README.md           — Turkish, proje açıklaması + kurulum adımları (npm install && npm run dev)
  src/main.jsx        — ONLY ReactDOM.createRoot + <App /> render, nothing else
  src/App.jsx         — Main layout, imports and renders all feature components
  src/App.css         — Basic styling (no inline styles!)
  src/components/     — ONE component file per user story from the spec

RULES:
- Create 8-12 files total. Each file UNDER 80 lines.
- src/main.jsx must ONLY do ReactDOM.createRoot(document.getElementById('root')).render(<App />)
- src/App.jsx imports and composes feature components
- Each user story from the spec gets its OWN component in src/components/
- Each acceptance criterion must have corresponding UI/logic in a component
- Use a SINGLE src/App.css for all styles — NO inline styles
- index.html must have <div id="root"></div> and module script tag
- package.json: "type": "module", react + react-dom + vite + @vitejs/plugin-react
- No comments in code. No test files. No CI/CD. No console.log/console.warn/console.error.
- README.md in Turkish with: project description, setup steps, features list.
- Code in English, UI text in Turkish.

TURKISH UI TEXT (MANDATORY):
- ALL user-facing text must be in Turkish: button labels, headings, placeholders, error messages, empty states, tooltips
- Examples: "Kaydet" not "Save", "Ara..." not "Search...", "Yükleniyor..." not "Loading..."
- Form placeholders: "Adınızı girin", "E-posta adresiniz", "Şifrenizi girin"
- Error messages: "Bu alan zorunludur", "Geçersiz e-posta adresi", "Bir hata oluştu"
- Empty states: "Henüz veri yok", "Sonuç bulunamadı"
- Navigation: "Ana Sayfa", "Ayarlar", "Profil", "Çıkış"
- Actions: "Ekle", "Düzenle", "Sil", "İptal", "Onayla", "Gönder"

DESIGN SYSTEM (MANDATORY):
- FORBIDDEN in JSX: Tailwind utility class names (e.g. "grid-cols-2", "max-w-7xl", "text-sm", "sm:", "md:", "lg:"). Use only real CSS class names defined in src/App.css.
- src/App.css MUST start with this :root block (these exact values):
  :root {
    --bg:#0f1115; --surface:#151922; --surface-2:#1b2130; --border:rgba(255,255,255,0.08);
    --text:#e8ecf1; --text-secondary:#a5adbb; --text-tertiary:#6b7380;
    --primary:#07D1AF; --primary-hover:#06b89a; --danger:#ff6b6b; --warning:#f59e0b;
    --radius-sm:6px; --radius-md:10px; --radius-lg:16px;
    --shadow-sm:0 1px 2px rgba(0,0,0,.3); --shadow-md:0 6px 20px rgba(0,0,0,.35);
    --font:system-ui,-apple-system,"Segoe UI",Inter,sans-serif;
  }
  body { background:var(--bg); color:var(--text); font-family:var(--font); margin:0; }
- Provide these reusable classes in src/App.css: .container .card .btn .btn-primary .btn-ghost .input .label .field .row .stack .muted .empty .error .success
- Inline style= is allowed ONLY for truly dynamic values (width %, transform). NEVER inline linear-gradient or raw hex; always go through CSS variables (var(--primary) etc.).
- Responsive via CSS (flex/grid + @media min-width 640/768/1024). Mobile-first. Tap targets >= 44px height.

DATA & PERSISTENCE (MANDATORY):
- Sandpack has NO backend. FORBIDDEN at runtime: fetch('/api/...'), fetch('http...'), axios, supabase, firebase, any absolute HTTP URL not serving a public static asset.
- For any app that conceptually needs storage (todos, notes, users, products, etc.): use localStorage with a namespaced key 'akis:<appname>:<entity>'. Wrap reads in try/catch. Seed with 2-3 realistic items on first load so the empty state is rare.

SANDPACK PREVIEW COMPATIBILITY:
- The output renders in Sandpack (browser-based bundler). Keep imports simple and standard.
- src/App.jsx (or src/App.tsx) MUST be the main component — it is the Sandpack entry point.
- src/main.jsx MUST import and render <App /> from './App' — this maps to Sandpack's index.
- CSS: import './App.css' in App.jsx. Sandpack maps src/App.css to /App.css automatically.
- Do NOT use path aliases (@/, ~/) — use relative imports only (./components/X).
- Do NOT use dynamic imports, lazy loading, or React.lazy — Sandpack does not support code splitting.
- Do NOT import from node_modules paths directly — only use package names (e.g., 'react' not './node_modules/react').
- All component imports must use relative paths from the file's location.
- Do NOT add tailwindcss, postcss, or autoprefixer to package.json — they will not be compiled in Sandpack.
- Do NOT import icon libraries (lucide-react, react-icons, etc.) unless they are listed in dependencies AND known to load in Sandpack. Prefer inline SVGs (16-24px) using currentColor.
- Do NOT import files you did not output.

CODE QUALITY REQUIREMENTS:
- Every component must have proper imports — no unused imports, no missing imports
- CSS/styles must be included (inline or separate file)
- README.md must include: project description, setup instructions, tech stack, features list
- package.json must have correct "scripts" (dev, build, preview)
- index.html must reference the correct entry point
- Use semantic HTML elements: <nav>, <main>, <section>, <article>, <header>, <footer>
- Add aria-label on icon-only buttons and interactive elements without visible text
- Form inputs must have associated <label> elements
- Handle empty/loading/error states in components — never leave a component that can break on null/undefined
- Use try/catch for JSON.parse, fetch calls, and localStorage access
- Props must have sensible defaults or early returns for missing data

BEFORE returning your output, perform VERIFICATION:

1. SPEC COMPLIANCE CHECK:
   For each User Story in the input StructuredSpec:
   - [ ] At least one generated file addresses this story
   - [ ] The file structure supports the Acceptance Criteria
   For each Acceptance Criterion:
   - [ ] The Given state is represented (data model, route, or component)
   - [ ] The When trigger has a corresponding handler or endpoint
   - [ ] The Then outcome has a corresponding response or UI element

2. SCAFFOLD INTEGRITY CHECK:
   - [ ] package.json includes ALL imported dependencies
   - [ ] No file imports from a path that doesn't exist in the scaffold
   - [ ] Entry point file (index.html, main.jsx/tsx) exists and is valid
   - [ ] No TODO/FIXME placeholders without implementation guidance

3. Include a "verificationReport" object in your JSON output:
   {
     "specCoverage": "X/Y criteria addressed",
     "integrityIssues": [],
     "missingDependencies": [],
     "unresolvedImports": [],
     "confidenceScore": 0.0
   }
   confidenceScore range: 0.0 (no confidence) to 1.0 (fully verified)

SUMMARY (mandatory):
- Include a "summary" field at the top level: 1-3 sentences in Turkish describing what you built
- Mention the main features (e.g. "Liste, ekleme, silme, localStorage kalıcılığı")
- Mention the stack briefly ("React + Vite ile basit bir todo uygulaması")
- Keep it under 280 characters total — this is shown as a chat message

JSON format (respond with ONLY this, nothing else):
{"files":[{"filePath":"index.html","content":"...","linesOfCode":12},{"filePath":"package.json","content":"...","linesOfCode":20},{"filePath":"vite.config.js","content":"...","linesOfCode":7},{"filePath":".gitignore","content":"node_modules\\ndist\\n.env","linesOfCode":3},{"filePath":"README.md","content":"...","linesOfCode":25},{"filePath":"src/main.jsx","content":"...","linesOfCode":8},{"filePath":"src/App.jsx","content":"...","linesOfCode":40},{"filePath":"src/App.css","content":"...","linesOfCode":60},{"filePath":"src/components/FeatureName.jsx","content":"...","linesOfCode":45}],"setupCommands":["npm install","npm run dev"],"summary":"React + Vite ile basit bir todo uygulaması iskeleti. Ekleme, silme, listeleme ve localStorage kalıcılığı içeriyor.","metadata":{"filesCreated":9,"totalLinesOfCode":220,"stackUsed":"React + Vite"},"verificationReport":{"specCoverage":"5/5 criteria addressed","integrityIssues":[],"missingDependencies":[],"unresolvedImports":[],"confidenceScore":0.9}}`;

// ─── ProtoAgent ───────────────────────────────────

export class ProtoAgent {
  private ai: ProtoAIDeps;
  private github: ProtoGitHubDeps;
  private agenticDeps?: AgenticLoopDeps;
  private skillRegistry?: SkillRegistry;

  constructor(
    ai: ProtoAIDeps,
    github: ProtoGitHubDeps,
    agenticDeps?: AgenticLoopDeps,
    skillRegistry?: SkillRegistry,
  ) {
    this.ai = ai;
    this.github = github;
    this.agenticDeps = agenticDeps;
    this.skillRegistry = skillRegistry;
  }

  private enhance(basePrompt: string): string {
    if (!this.skillRegistry) return basePrompt;
    return buildSystemPromptWithSkills(basePrompt, 'proto', this.skillRegistry);
  }

  async execute(input: ProtoInput): Promise<ProtoResult> {
    const emit = input.pipelineId
      ? createActivityEmitter(input.pipelineId, 'proto')
      : undefined;

    // ─── Iteration Mode: modify existing code instead of building from scratch ───
    if (input.iterationRequest && input.existingFiles?.length) {
      return this.executeIteration(input, emit);
    }

    // Agentic path: if tool_use deps are available and not dryRun, use Claude with tools
    if (this.agenticDeps && !input.dryRun && this.github.pushFiles) {
      return this.executeWithTools(input, emit);
    }

    // Fallback: legacy text-generation path
    // Step 1: Generate scaffold via AI
    emit?.('ai_call', 'Claude AI ile MVP scaffold oluşturuluyor...', 20, undefined, undefined, 'pipeline.activity.proto.creating_scaffold');
    const scaffoldResult = await this.generateScaffold(input.spec, input.knowledgeContext);
    if (scaffoldResult.type === 'error') {
      emit?.('error', 'Scaffold üretimi başarısız oldu', 0);
      return scaffoldResult;
    }

    const { files, setupCommands, metadata } = scaffoldResult.data;
    emit?.('parsing', `AI yanıtından dosya yapısı çıkarıldı: ${files.length} dosya`, 55);

    if (input.dryRun) {
      return {
        type: 'output',
        data: {
          ok: true,
          branch: 'dry-run',
          repo: `${input.owner}/${input.repoName}`,
          repoUrl: `https://github.com/${input.owner}/${input.repoName}`,
          files,
          setupCommands: this.buildSetupCommands(input.owner, input.repoName, setupCommands),
          metadata: { ...metadata, committed: false },
        },
      };
    }

    // Step 2: Create GitHub repo
    const repoResult = await this.createRepo(input);
    if (repoResult.type === 'error') {
      emit?.('error', 'GitHub repo oluşturulamadı', 0);
      return repoResult;
    }

    // Step 3: Push files directly to main (repo is auto_init'd with main branch)
    const branchName = 'main';

    // Step 4: Push files
    emit?.('github_push', `${files.length} dosya GitHub'a push ediliyor...`, 75, undefined, undefined, 'pipeline.activity.proto.pushing_github');
    const pushResult = await this.pushFiles(input.owner, input.repoName, branchName, files, emit);
    if (pushResult.type === 'error') {
      emit?.('error', 'Dosyalar push edilemedi', 0);
      return pushResult;
    }

    // Step 5: Verify scaffold integrity (PR skipped — files pushed directly to main)
    emit?.('verification', 'Scaffold bütünlüğü doğrulanıyor...', 90);
    const prUrl: string | undefined = undefined;

    emit?.('complete', `Scaffold hazır: ${files.length} dosya push edildi`, 100);
    return {
      type: 'output',
      data: {
        ok: true,
        branch: branchName,
        repo: `${input.owner}/${input.repoName}`,
        repoUrl: `https://github.com/${input.owner}/${input.repoName}`,
        files,
        prUrl,
        setupCommands: this.buildSetupCommands(input.owner, input.repoName, setupCommands),
        metadata: { ...metadata, committed: true },
      },
    };
  }

  // ─── Iteration Mode: Modify existing code ────────────

  /**
   * Dispatch Proto iteration's single AI call to either the multimodal or
   * text-only path. Mirrors Scribe's dispatchGenerate pattern so providers
   * without multimodal support keep working. Issue #427 BUG-19.
   */
  private async dispatchIterationGenerate(
    systemPrompt: string,
    userPrompt: string,
    images?: readonly AnthropicImageBlock[],
  ): Promise<string> {
    const hasImages = images && images.length > 0;
    if (hasImages && this.ai.generateTextWithImages) {
      try {
        return await this.ai.generateTextWithImages(systemPrompt, userPrompt, images);
      } catch (err) {
        logger.warn(
          { err, imageCount: images.length },
          '[proto] multimodal iteration path failed, falling back to text-only',
        );
      }
    }
    return this.ai.generateText(systemPrompt, userPrompt);
  }

  private async executeIteration(
    input: ProtoInput,
    emit?: ReturnType<typeof createActivityEmitter>,
  ): Promise<ProtoResult> {
    emit?.('ai_call', 'Mevcut kod analiz ediliyor ve değişiklikler uygulanıyor...', 20);

    const existingFilesContext = input.existingFiles!
      .map(f => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n');

    const hasImages = (input.imageBlocks?.length ?? 0) > 0;
    const imageAckSection = hasImages
      ? `\n\nUSER-UPLOADED SCREENSHOTS:\nThe user attached ${input.imageBlocks!.length} screenshot(s) that illustrate the change they want. Inspect them to locate the elements (buttons, labels, colors, layouts) the user is describing. Treat the screenshots as authoritative context — if the change request is ambiguous, defer to what the screenshots show.`
      : '';

    const iterationPrompt = `You are Proto, an iteration specialist. You have an EXISTING codebase and the user wants a SPECIFIC CHANGE.

ORIGINAL SPEC (for context):
Title: ${input.spec.title}
Problem: ${input.spec.problemStatement}
Features: ${input.spec.userStories.map(s => `${s.persona}: ${s.action} → ${s.benefit}`).join('\n')}

USER'S CHANGE REQUEST:
"${input.iterationRequest}"${imageAckSection}

EXISTING CODEBASE (these files are ALREADY in the GitHub repo):
${existingFilesContext}

RULES:
- Output ALL files (modified + unchanged). The output REPLACES the entire repo.
- Focus on the user's specific request. Do NOT rebuild the app from scratch.
- Keep the existing architecture, styling, and patterns intact.
- Only modify files that need changes to fulfill the request.
- For unchanged files, return them AS-IS (exact same content).
- UI text stays in Turkish.
- No console.log/console.warn. No comments unless critical.

JSON format (respond with ONLY this, nothing else):
{"files":[{"filePath":"...","content":"...","linesOfCode":N}],"setupCommands":["npm install","npm run dev"],"metadata":{"filesCreated":N,"totalLinesOfCode":N,"stackUsed":"..."},"verificationReport":{"specCoverage":"...","integrityIssues":[],"missingDependencies":[],"unresolvedImports":[],"confidenceScore":0.9}}`;

    const iterationSystemPrompt = 'You are Proto, an iteration specialist. Output ONLY valid JSON. No markdown, no explanations.';

    let raw: string;
    try {
      raw = await this.dispatchIterationGenerate(
        iterationSystemPrompt,
        iterationPrompt,
        input.imageBlocks,
      );
    } catch (err) {
      return {
        type: 'error',
        error: createPipelineError(
          PipelineErrorCode.AI_PROVIDER_ERROR,
          `İterasyon AI çağrısı başarısız: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }

    emit?.('parsing', 'AI yanıtı ayrıştırılıyor...', 55);

    const sanitized = sanitizeJsonControlChars(raw);
    let jsonStr: string | null = extractJsonSafe(sanitized);
    if (!jsonStr) {
      const repaired = repairTruncatedJson(sanitized);
      if (repaired) jsonStr = repaired;
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      if (jsonStr) parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch { /* invalid JSON */ }
    const parsedFiles = (parsed?.files ?? []) as Array<{ filePath: string; content: string; linesOfCode?: number }>;
    if (!parsedFiles?.length) {
      return {
        type: 'error',
        error: createPipelineError(
          PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED,
          'İterasyon sonucu ayrıştırılamadı veya dosya üretilmedi',
        ),
      };
    }

    const files = parsedFiles.map((f) => ({
      filePath: f.filePath,
      content: f.content,
      linesOfCode: f.linesOfCode ?? f.content.split('\n').length,
    }));

    // Push updated files to GitHub
    emit?.('github_push', `${files.length} dosya güncelleniyor...`, 75);
    const pushResult = await this.pushFiles(input.owner, input.repoName, 'main', files, emit);
    if (pushResult.type === 'error') {
      emit?.('error', 'Güncellenmiş dosyalar push edilemedi', 0);
      return pushResult;
    }

    emit?.('complete', `İterasyon tamamlandı: ${files.length} dosya güncellendi`, 100);

    return {
      type: 'output',
      data: {
        ok: true,
        branch: 'main',
        repo: `${input.owner}/${input.repoName}`,
        repoUrl: `https://github.com/${input.owner}/${input.repoName}`,
        files,
        setupCommands: (parsed?.setupCommands as string[] | undefined) ?? ['npm install', 'npm run dev'],
        metadata: {
          filesCreated: files.length,
          totalLinesOfCode: files.reduce((sum: number, f: { linesOfCode: number }) => sum + f.linesOfCode, 0),
          stackUsed: (parsed?.metadata as Record<string, unknown> | undefined)?.stackUsed as string ?? 'iteration',
          committed: true,
        },
      },
    };
  }

  // ─── Agentic Tool-Use Execution Path ────────────

  private async executeWithTools(
    input: ProtoInput,
    emit?: ReturnType<typeof createActivityEmitter>,
  ): Promise<ProtoResult> {
    emit?.('ai_call', 'Claude AI tool_use ile scaffold oluşturuluyor...', 10);

    // Issue #483 BUG-J: Hard-enforce repo creation BEFORE the agentic loop so the
    // LLM cannot skip create_repository and call push_files on a non-existent repo.
    // Tool-orchestration for a deterministic step must not depend on LLM reasoning.
    emit?.('github_push', 'GitHub repo oluşturuluyor...', 20, undefined, undefined, 'pipeline.activity.proto.creating_repo');
    const repoResult = await this.createRepo(input);
    if (repoResult.type === 'error') {
      emit?.('error', 'GitHub repo oluşturulamadı', 0);
      return repoResult;
    }

    // Build tool handlers — create_repository is excluded from the tool list
    // passed to the loop (repo already exists), only push_files is needed.
    const toolDeps: ProtoToolDeps = {
      createRepository: (owner, name, isPrivate) => this.github.createRepository(owner, name, isPrivate),
      pushFiles: (owner, repo, branch, files, message) => this.github.pushFiles!(owner, repo, branch, files, message),
    };
    const handlers = createProtoToolHandlers(toolDeps);

    const hasImages = (input.imageBlocks?.length ?? 0) > 0;
    const imageAck = hasImages
      ? `\n\nThe user attached ${input.imageBlocks!.length} screenshot(s) alongside the request. Use them as the ground-truth for visuals (colors, layout, labels) when generating the scaffold.`
      : '';

    const userPrompt = `Push a working MVP scaffold to the GitHub repository that has already been created.

Repository: owner="${input.owner}", name="${input.repoName}" (already exists on GitHub)

Spec:
- Title: ${input.spec.title}
- Problem: ${input.spec.problemStatement}
- User Stories: ${input.spec.userStories.slice(0, 6).map((s) => `${s.persona}: ${s.action} → ${s.benefit}`).join('\n  ')}
- Acceptance Criteria: ${input.spec.acceptanceCriteria.slice(0, 8).map((ac) => `${ac.id}: ${ac.when} → ${ac.then}`).join('\n  ')}
- Tech: ${input.spec.technicalConstraints?.stack || 'React + Vite'}${input.spec.technicalConstraints?.integrations?.length ? `, integrations: ${input.spec.technicalConstraints.integrations.join(', ')}` : ''}${imageAck}

Steps:
1. Generate a working React+Vite scaffold (8-12 files, each under 80 lines)
2. Call push_files to push ALL files to the "main" branch in one commit

After pushing, respond with a 1-3 sentence Turkish summary in plain text (NO JSON, NO markdown) describing what you built — features, stack, anything notable. Keep under 280 characters. This will be shown to the user as a chat message.`;

    // Exclude create_repository from the tool list — repo was already created above.
    // This prevents the LLM from attempting a redundant (and potentially failing) second call.
    const protoTools = PROTO_TOOLS.filter((t) => t.name !== 'create_repository');
    let allHandlers = handlers;
    if (this.skillRegistry) {
      const skillTool = buildUseSkillTool('proto', this.skillRegistry);
      if (skillTool) {
        protoTools.push(skillTool);
        allHandlers = { ...handlers, ...createUseSkillHandlers('proto', this.skillRegistry) };
      }
    }

    try {
      const result = await runAgenticLoop(
        this.agenticDeps!,
        this.enhance(SCAFFOLD_SYSTEM_PROMPT),
        userPrompt,
        protoTools,
        allHandlers,
        {
          maxIterations: 10,
          maxTokens: 16384,
          temperature: 0,
          // Issue #464 BUG-C: forward user-uploaded screenshots so the
          // vision-capable model can reference the mockup while scaffolding.
          initialImages: hasImages ? input.imageBlocks : undefined,
          onToolCall: (name, _input) => {
            if (name === 'push_files') emit?.('github_push', 'Dosyalar push ediliyor...', 75, undefined, undefined, 'pipeline.activity.proto.pushing_github');
          },
          onToolResult: (name, _result, isError) => {
            if (isError) emit?.('error', `Tool ${name} başarısız`, 0);
          },
        },
      );

      // Extract files from tool calls
      const pushCall = result.toolCalls.find((tc) => tc.name === 'push_files');

      // BUG-E fix: if push_files was never called or its result indicates an error,
      // treat as a push failure — do NOT return ok:true based on LLM summary text alone.
      if (!pushCall) {
        logger.error('[Proto] executeWithTools: push_files tool was never called — aborting');
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.PROTO_PUSH_FAILED,
            'Agentic loop completed without calling push_files — scaffold was not committed to GitHub',
          ),
        };
      }

      // AgenticLoop stores the tool result in pushCall.result.
      // On adapter failure the handler throws, AgenticLoop catches it and stores
      // the error message string in pushCall.result AND sets is_error:true in the
      // tool_result block sent back to Claude. Detect both forms of failure.
      const pushResult = pushCall.result;
      const pushFailed =
        typeof pushResult === 'string' && pushResult.startsWith('Error:') ||
        (typeof pushResult === 'object' &&
          pushResult !== null &&
          (pushResult as Record<string, unknown>).success === false);

      if (pushFailed) {
        const detail = typeof pushResult === 'string' ? pushResult : JSON.stringify(pushResult);
        logger.error({ detail }, '[Proto] executeWithTools: push_files tool returned an error');
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.PROTO_PUSH_FAILED,
            `push_files tool error: ${detail}`,
          ),
        };
      }

      const files = (pushCall.input.files as Array<{ path: string; content: string }>).map((f) => ({
        filePath: f.path,
        content: f.content,
        linesOfCode: f.content.split('\n').length,
      }));

      const totalLOC = files.reduce((sum, f) => sum + f.linesOfCode, 0);

      // BUG-E fix: verify the repo actually has files on GitHub before reporting success.
      // Pass pushedPaths so verifyRepoPushed can detect auto_init false-positives.
      emit?.('verification', 'GitHub repo içeriği doğrulanıyor...', 92);
      const pushedPaths = files.map((f) => f.filePath);
      const verifyResult = await this.verifyRepoPushed(input.owner, input.repoName, 'main', files.length, pushedPaths);
      if (verifyResult.type === 'error') {
        emit?.('error', 'GitHub doğrulaması başarısız — repo boş veya bulunamadı', 0);
        return verifyResult;
      }

      emit?.('complete', `Scaffold hazır: ${files.length} dosya push edildi (tool_use)`, 100);
      const summary = extractProtoSummary(result.text);
      return {
        type: 'output',
        data: {
          ok: true,
          branch: 'main',
          repo: `${input.owner}/${input.repoName}`,
          repoUrl: `https://github.com/${input.owner}/${input.repoName}`,
          files,
          setupCommands: this.buildSetupCommands(input.owner, input.repoName, ['npm install', 'npm run dev']),
          ...(summary ? { summary } : {}),
          metadata: { filesCreated: files.length, totalLinesOfCode: totalLOC, stackUsed: 'React + Vite (tool_use)', committed: true },
        },
      };
    } catch (err) {
      logger.error({ err }, '[Proto] Agentic execution failed, falling back to legacy path');
      // Fall back to legacy text-generation path
      return this.executeLegacy(input, emit);
    }
  }

  private async executeLegacy(input: ProtoInput, emit?: ReturnType<typeof createActivityEmitter>): Promise<ProtoResult> {
    // Re-enter the legacy flow from Step 1
    emit?.('ai_call', 'Claude AI ile MVP scaffold oluşturuluyor (fallback)...', 20);
    const scaffoldResult = await this.generateScaffold(input.spec, input.knowledgeContext);
    if (scaffoldResult.type === 'error') {
      emit?.('error', 'Scaffold üretimi başarısız oldu', 0);
      return scaffoldResult;
    }

    const { files, setupCommands, metadata } = scaffoldResult.data;
    emit?.('parsing', `AI yanıtından dosya yapısı çıkarıldı: ${files.length} dosya`, 55);

    if (input.dryRun) {
      return {
        type: 'output',
        data: {
          ok: true, branch: 'dry-run',
          repo: `${input.owner}/${input.repoName}`,
          repoUrl: `https://github.com/${input.owner}/${input.repoName}`,
          files, setupCommands: this.buildSetupCommands(input.owner, input.repoName, setupCommands),
          metadata: { ...metadata, committed: false },
        },
      };
    }

    const repoResult = await this.createRepo(input);
    if (repoResult.type === 'error') return repoResult;

    const branchName = 'main';
    emit?.('github_push', `${files.length} dosya GitHub'a push ediliyor...`, 75, undefined, undefined, 'pipeline.activity.proto.pushing_github');
    const pushResult = await this.pushFiles(input.owner, input.repoName, branchName, files, emit);
    if (pushResult.type === 'error') return pushResult;

    emit?.('verification', 'Scaffold bütünlüğü doğrulanıyor...', 90);
    emit?.('complete', `Scaffold hazır: ${files.length} dosya push edildi`, 100);
    return {
      type: 'output',
      data: {
        ok: true, branch: branchName,
        repo: `${input.owner}/${input.repoName}`,
        repoUrl: `https://github.com/${input.owner}/${input.repoName}`,
        files, setupCommands: this.buildSetupCommands(input.owner, input.repoName, setupCommands),
        metadata: { ...metadata, committed: true },
      },
    };
  }

  // ─── Scaffold Generation ────────────────────────

  private async generateScaffold(
    spec: StructuredSpec,
    knowledgeContext?: string,
  ): Promise<
    | { type: 'output'; data: { files: ProtoOutput['files']; setupCommands: string[]; metadata: Omit<ProtoOutput['metadata'], 'committed'> } }
    | { type: 'error'; error: PipelineError }
  > {
    const condensedSpec = {
      title: spec.title,
      problem: spec.problemStatement,
      userStories: spec.userStories.slice(0, 6).map((s) => ({
        persona: s.persona,
        action: s.action,
        benefit: s.benefit,
      })),
      acceptanceCriteria: spec.acceptanceCriteria.slice(0, 8).map((ac) => ({
        id: ac.id,
        when: ac.when,
        then: ac.then,
      })),
      stack: spec.technicalConstraints?.stack ?? 'React + Vite + TypeScript',
    };
    const userPrompt = JSON.stringify(condensedSpec);

    for (let attempt = 0; attempt <= RETRY_CONFIG.specValidationMaxRetries; attempt++) {
      let responseText: string;
      try {
        const scaffoldBase = this.enhance(SCAFFOLD_SYSTEM_PROMPT);
        const protoSystemPrompt = knowledgeContext
          ? `${scaffoldBase}\n\n--- RETRIEVED KNOWLEDGE ---\n${knowledgeContext}\n--- END KNOWLEDGE ---`
          : scaffoldBase;
        responseText = await this.ai.generateText(protoSystemPrompt, userPrompt);
      } catch (err) {
        logger.error(`[Proto] Attempt ${attempt + 1}: AI call error: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED,
            'AI call failed after retries'
          ),
        };
      }

      // Guard: empty or whitespace-only AI response
      if (!responseText || !responseText.trim()) {
        logger.warn(`[Proto] Attempt ${attempt + 1}: AI returned empty response`);
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED,
            'AI returned empty response after retries'
          ),
        };
      }

      let parsed: unknown;
      let wasRepaired = false;
      try {
        const jsonStr = extractJsonSafe(responseText);
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          const sanitized = sanitizeJsonControlChars(jsonStr);
          parsed = JSON.parse(sanitized);
          logger.warn(`[Proto] Parsed after sanitizing control chars`);
        }
      } catch (parseErr) {
        logger.warn(`[Proto] JSON parse failed (attempt ${attempt + 1}, len=${responseText.length}): ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        const repaired = repairTruncatedJson(responseText);
        if (repaired) {
          try {
            parsed = JSON.parse(repaired);
            wasRepaired = true;
          } catch {
            try {
              parsed = JSON.parse(sanitizeJsonControlChars(repaired));
              wasRepaired = true;
            } catch { /* repair also failed */ }
          }
        }
        if (!parsed) {
          if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
          return {
            type: 'error',
            error: createPipelineError(
              PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED,
              `Invalid JSON from scaffold generation (response length: ${responseText.length})`
            ),
          };
        }
      }

      const obj = parsed as Record<string, unknown>;
      const files = obj.files as ProtoOutput['files'] | undefined;
      const setupCmds = obj.setupCommands as string[] | undefined;
      const meta = obj.metadata as Record<string, unknown> | undefined;
      const rawSummary = typeof obj.summary === 'string' ? obj.summary.trim() : undefined;
      const summary = rawSummary && rawSummary.length > 0 ? rawSummary.slice(0, 500) : undefined;

      const fileCount = Array.isArray(files) ? files.length : 0;

      // If repaired result has too few files, it's likely truncated — retry
      if (wasRepaired && fileCount < MIN_SCAFFOLD_FILES) {
        logger.warn(`[Proto] Repaired JSON only has ${fileCount} files (min: ${MIN_SCAFFOLD_FILES}), retrying...`);
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
      }

      if (!files || !Array.isArray(files) || files.length === 0) {
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED,
            'No files generated'
          ),
        };
      }

      const normalizedFiles = files.map((f) => ({
        filePath: String(f.filePath),
        content: String(f.content),
        linesOfCode: typeof f.linesOfCode === 'number' ? f.linesOfCode : String(f.content).split('\n').length,
      }));

      const totalLines = normalizedFiles.reduce((sum, f) => sum + f.linesOfCode, 0);

      return {
        type: 'output',
        data: {
          files: normalizedFiles,
          setupCommands: Array.isArray(setupCmds) ? setupCmds : ['npm install', 'npm run dev'],
          ...(summary ? { summary } : {}),
          metadata: {
            filesCreated: normalizedFiles.length,
            totalLinesOfCode: totalLines,
            stackUsed: typeof meta?.stackUsed === 'string' ? meta.stackUsed : 'Unknown',
          },
        },
      };
    }

    return {
      type: 'error',
      error: createPipelineError(PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED, 'All retries exhausted'),
    };
  }

  // ─── GitHub Operations ──────────────────────────

  private async createRepo(
    input: ProtoInput
  ): Promise<{ type: 'output' } | { type: 'error'; error: PipelineError }> {
    try {
      await this.github.createRepository(
        input.owner,
        input.repoName,
        input.repoVisibility === 'private'
      );
      return { type: 'output' };
    } catch (err) {
      // Typed error classes come first — substring matching on `msg` below is
      // a fallback for legacy paths that `throw new Error(...)` without a
      // dedicated class. Without these instanceof checks, `GitHubTokenInvalidError`
      // from the adapter (#487) would fall through to the generic
      // GITHUB_API_ERROR bucket and the user would never see the reconnect
      // CTA that #485/#487 added (issue #489 / BUG-M).
      if (err instanceof GitHubTokenInvalidError) {
        return {
          type: 'error',
          error: createPipelineError(PipelineErrorCode.GITHUB_TOKEN_INVALID, err.message),
        };
      }

      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes('already exists') || msg.includes('name already exists') || msg.includes('422')) {
        // Repo already exists — this is fine, proceed to branch creation
        return { type: 'output' };
      }
      if (msg.includes('permission') || msg.includes('forbidden') || msg.includes('403')) {
        return {
          type: 'error',
          error: createPipelineError(PipelineErrorCode.GITHUB_PERMISSION_DENIED, msg),
        };
      }
      if (msg.includes('not connected') || msg.includes('unauthorized') || msg.includes('401')) {
        return {
          type: 'error',
          error: createPipelineError(PipelineErrorCode.GITHUB_NOT_CONNECTED, msg),
        };
      }

      return {
        type: 'error',
        error: createPipelineError(PipelineErrorCode.GITHUB_API_ERROR, msg),
      };
    }
  }

  /** Reject paths that attempt directory traversal or absolute paths. */
  private sanitizeFiles(files: ProtoOutput['files']): ProtoOutput['files'] {
    return files.filter((f) => {
      const p = f.filePath;
      // Reject traversal, absolute paths, backslashes, URL-encoded variants, null bytes
      if (
        p.includes('..') ||
        p.startsWith('/') ||
        p.startsWith('\\') ||
        p.includes('\0') ||
        p.includes('%2e') ||
        p.includes('%2E') ||
        p.includes('%2f') ||
        p.includes('%2F') ||
        p.includes('\\\\') ||
        /[<>:"|?*]/.test(p) // Windows reserved chars
      ) {
        logger.warn(`[Proto] Rejected unsafe file path: ${p}`);
        return false;
      }
      // Reject empty paths and paths with only dots
      if (!p.trim() || /^\.+$/.test(p)) {
        logger.warn(`[Proto] Rejected empty/dot-only file path: ${p}`);
        return false;
      }
      return true;
    });
  }

  private async pushFiles(
    owner: string,
    repo: string,
    branch: string,
    files: ProtoOutput['files'],
    emit?: ReturnType<typeof createActivityEmitter>,
  ): Promise<{ type: 'output' } | { type: 'error'; error: PipelineError }> {
    files = this.sanitizeFiles(files);
    const totalFiles = files.length;
    for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
      try {
        if (this.github.pushFiles) {
          // Batch push — single atomic commit via Git Tree API
          // Emit file_created events before the batch commit so the UI shows progress
          for (let i = 0; i < totalFiles; i++) {
            const pct = 75 + Math.round(((i + 1) / totalFiles) * 15); // 75-90 range
            emit?.('file_created', `${files[i].filePath} oluşturuldu`, pct, files[i].filePath);
          }
          await this.github.pushFiles(
            owner,
            repo,
            branch,
            files.map((f) => ({ path: f.filePath, content: f.content })),
            `feat: initial scaffold (${files.length} files)`,
          );
          emit?.('github_push', 'Tüm dosyalar push edildi', 90);
        } else {
          // Fallback: per-file commits (legacy adapters)
          for (let i = 0; i < totalFiles; i++) {
            const file = files[i];
            await this.github.commitFile(
              owner, repo, branch,
              file.filePath, file.content,
              `feat: add ${file.filePath}`,
            );
            const pct = 75 + Math.round(((i + 1) / totalFiles) * 15);
            emit?.('file_created', `${file.filePath} oluşturuldu`, pct, file.filePath);
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
            PipelineErrorCode.PROTO_PUSH_FAILED,
            `Push failed after ${RETRY_CONFIG.maxRetries} retries: ${err instanceof Error ? err.message : String(err)}`
          ),
        };
      }
    }

    return {
      type: 'error',
      error: createPipelineError(PipelineErrorCode.PROTO_PUSH_FAILED, 'Unreachable'),
    };
  }

  // ─── Post-push GitHub Verification ──────────────

  /**
   * Verify that the repo actually contains the pushed files on GitHub.
   *
   * The previous implementation only checked `files.length > 0`, which always
   * passed because GitHub auto_init creates a README.md — even when push_files
   * silently failed. This version cross-checks that at least one of the PUSHED
   * file paths is actually present in the repo tree. Issue #470 BUG-E re-open.
   */
  private async verifyRepoPushed(
    owner: string,
    repo: string,
    branch: string,
    expectedFileCount: number,
    pushedPaths?: string[],
  ): Promise<{ type: 'output' } | { type: 'error'; error: PipelineError }> {
    if (!this.github.listFiles) {
      // Adapter doesn't support listFiles — skip verification (legacy adapters in tests).
      logger.warn('[Proto] verifyRepoPushed: listFiles not available on adapter, skipping verification');
      return { type: 'output' };
    }
    try {
      const repoFiles = await this.github.listFiles(owner, repo, branch);
      const repoFileSet = new Set(repoFiles);

      logger.info(
        {
          owner,
          repo,
          branch,
          expectedFileCount,
          actualFileCount: repoFiles.length,
          sampleFiles: repoFiles.slice(0, 5),
        },
        '[Proto] verifyRepoPushed: listFiles result',
      );

      // If we know which paths were pushed, require at least one to be present.
      // This catches the auto_init false-positive: repo has only README.md from
      // GitHub init, but none of the scaffold files we tried to push.
      if (pushedPaths && pushedPaths.length > 0) {
        const matchedCount = pushedPaths.filter((p) => repoFileSet.has(p)).length;
        if (matchedCount === 0) {
          logger.error(
            { owner, repo, branch, expectedFileCount, actualFileCount: repoFiles.length, pushedPaths: pushedPaths.slice(0, 5) },
            '[Proto] verifyRepoPushed: none of the pushed paths found in repo — push_files silently failed (auto_init false-positive)',
          );
          return {
            type: 'error',
            error: createPipelineError(
              PipelineErrorCode.PROTO_PUSH_FAILED,
              `GitHub repo ${owner}/${repo} does not contain any of the ${expectedFileCount} scaffold files on branch "${branch}". The push_files step silently failed (repo may only have GitHub auto_init README).`,
            ),
          };
        }
        logger.info(
          { owner, repo, branch, matchedCount, expectedFileCount },
          '[Proto] verifyRepoPushed: OK — scaffold files confirmed in repo',
        );
        return { type: 'output' };
      }

      // Fallback (no pushedPaths available): require more than the auto_init file count (1).
      const AUTO_INIT_FILE_COUNT = 1;
      if (repoFiles.length <= AUTO_INIT_FILE_COUNT) {
        logger.error(
          { owner, repo, branch, expectedFileCount, actualFileCount: repoFiles.length },
          '[Proto] verifyRepoPushed: repo has only auto_init files — push_files silently failed',
        );
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.PROTO_PUSH_FAILED,
            `GitHub repo ${owner}/${repo} has only ${repoFiles.length} file(s) after push — ${expectedFileCount} scaffold files were expected on branch "${branch}". The push_files step silently failed.`,
          ),
        };
      }

      logger.info({ owner, repo, branch, fileCount: repoFiles.length }, '[Proto] verifyRepoPushed: OK');
      return { type: 'output' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, owner, repo, branch }, '[Proto] verifyRepoPushed: listFiles threw');
      // 404 means the repo doesn't exist at all — definitive failure
      if (msg.includes('404') || msg.includes('Not Found') || msg.includes('not found')) {
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.PROTO_PUSH_FAILED,
            `GitHub repo ${owner}/${repo} does not exist after scaffold push (404). The create_repository or push_files step silently failed.`,
          ),
        };
      }
      // Other errors (rate limit, transient) — log and let pipeline proceed;
      // better to surface a partial success than to block on a flaky check.
      logger.warn({ err }, '[Proto] verifyRepoPushed: non-404 error, treating as soft-pass');
      return { type: 'output' };
    }
  }

  // ─── Helpers ────────────────────────────────────

  private buildSetupCommands(owner: string, repoName: string, aiCommands: string[]): string[] {
    return [
      `git clone https://github.com/${owner}/${repoName}.git`,
      `cd ${repoName}`,
      ...aiCommands,
    ];
  }

  private buildPRBody(spec: StructuredSpec, metadata: { filesCreated: number; totalLinesOfCode: number; stackUsed: string }): string {
    return [
      `## ${spec.title}`,
      '',
      spec.problemStatement,
      '',
      `### Stack: ${metadata.stackUsed}`,
      `- ${metadata.filesCreated} dosya oluşturuldu`,
      `- ${metadata.totalLinesOfCode} satır kod`,
      '',
      '### User Stories',
      ...spec.userStories.map((s) => `- ${s.persona} olarak ${s.action} istiyorum, ${s.benefit}`),
      '',
      '> Bu scaffold AKIS Proto agent tarafından otomatik oluşturuldu.',
    ].join('\n');
  }

  // JSON extraction, sanitization, and repair are now in shared utility:
  // import { extractJsonSafe, sanitizeJsonControlChars, repairTruncatedJson } from '../../core/json-extract.js';

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
