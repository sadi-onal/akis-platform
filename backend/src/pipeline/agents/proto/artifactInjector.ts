/**
 * PR-V-spec-artifacts — Proto artifact injector
 *
 * Merges three markdown artifacts into Proto's file set so they get pushed to
 * the generated project repo alongside the source code:
 *
 *   - docs/PRD.md                  — rendered from Scribe's structured spec
 *   - docs/TECHNICAL-ANALYSIS.md   — Proto's tech decisions (stack, file
 *                                    structure, data flow), derived from the
 *                                    generated files + Scribe spec
 *   - docs/API-CONTRACT.md         — only when the project exposes an API
 *                                    (heuristic detection on files + spec
 *                                    integrations); otherwise the file is
 *                                    skipped entirely
 *
 * The injector is a pure function. Called once at the orchestrator level
 * right after Proto returns `ok: true`, so every downstream path (dryRun
 * preview, push-confirm gate, iteration mode, legacy auto-push) sees the
 * same enriched file set. See PR-V-spec-artifacts brief.
 *
 * Idempotent: if Proto's output already contains a `docs/PRD.md` (or any of
 * the artifact paths), the existing file is kept and the injector does NOT
 * overwrite it.
 */
import type {
  ProtoOutput,
  ScribeOutput,
  StructuredSpec,
  UserFriendlyPlan,
} from '../../core/contracts/PipelineTypes.js';
import { renderPRDMarkdown } from '../scribe/render/prdMarkdown.js';

// Exported so tests + orchestrator can reference the canonical artifact paths.
export const PRD_PATH = 'docs/PRD.md';
export const TECH_ANALYSIS_PATH = 'docs/TECHNICAL-ANALYSIS.md';
export const API_CONTRACT_PATH = 'docs/API-CONTRACT.md';

export interface ArtifactInjectorInput {
  files: ProtoOutput['files'];
  scribeOutput?: ScribeOutput;
  /** Override timestamps for deterministic test fixtures. */
  now?: Date;
}

export interface ArtifactInjectorResult {
  files: ProtoOutput['files'];
  /** Which artifact paths were added on this pass (excludes those already present). */
  added: string[];
  /** Whether API contract was detected/included. */
  apiDetected: boolean;
}

/**
 * Inject docs/PRD.md, docs/TECHNICAL-ANALYSIS.md, and optionally
 * docs/API-CONTRACT.md into a Proto file set. Returns a new array — the
 * input array is not mutated.
 */
export function injectArtifacts(input: ArtifactInjectorInput): ArtifactInjectorResult {
  const { files, scribeOutput, now = new Date() } = input;
  const existingPaths = new Set(files.map((f) => f.filePath));
  const added: string[] = [];
  const out: ProtoOutput['files'] = files.map((f) => ({ ...f }));

  const push = (filePath: string, content: string): void => {
    if (existingPaths.has(filePath)) return;
    out.push({
      filePath,
      content,
      linesOfCode: content.split('\n').length,
    });
    added.push(filePath);
  };

  // 1. PRD.md — render from Scribe spec when available. If no scribeOutput is
  //    provided (legacy callers / tests), skip silently — the orchestrator
  //    always passes one in production.
  if (scribeOutput?.spec) {
    push(
      PRD_PATH,
      renderPRDMarkdown({
        spec: scribeOutput.spec,
        plan: scribeOutput.plan,
        assumptions: scribeOutput.assumptions,
        now,
      })
    );
  }

  // 2. TECHNICAL-ANALYSIS.md — always emit so the user sees Proto's "what I
  //    decided" doc in the repo. Derived from spec + generated files.
  push(
    TECH_ANALYSIS_PATH,
    renderTechnicalAnalysisMarkdown({
      files,
      spec: scribeOutput?.spec,
      plan: scribeOutput?.plan,
      now,
    })
  );

  // 3. API-CONTRACT.md — only when API endpoints / backend integration is
  //    detected. Stub-skip path: file is omitted entirely if no signal.
  const apiDetected = detectApiSurface({
    files,
    integrations: scribeOutput?.spec?.technicalConstraints?.integrations ?? [],
  });
  if (apiDetected) {
    push(
      API_CONTRACT_PATH,
      renderApiContractMarkdown({
        files,
        spec: scribeOutput?.spec,
        now,
      })
    );
  }

  return { files: out, added, apiDetected };
}

// ─── TECHNICAL-ANALYSIS renderer ───────────────────

interface TechAnalysisInput {
  files: ProtoOutput['files'];
  spec?: StructuredSpec;
  plan?: UserFriendlyPlan;
  now: Date;
}

/**
 * Render a heuristic "Teknik Analiz" document from the generated file set.
 * Stack inference comes from package.json + file extensions; the file tree
 * is summarised by directory. Per PR-V brief this is intentionally a minimal
 * stub — richer Proto-reasoning output is parked for a follow-up PR.
 */
export function renderTechnicalAnalysisMarkdown(input: TechAnalysisInput): string {
  const { files, spec, plan, now } = input;
  const lines: string[] = [];

  lines.push('# Teknik Analiz');
  lines.push('');
  lines.push(
    '> Bu döküman AKIS Proto tarafından üretildi. Stack seçimini, dosya yapısını ve önemli kararları özetler.'
  );
  lines.push('');

  // ── Özet ──────────────────────────────────────────
  if (plan?.summary) {
    lines.push('## Özet');
    lines.push('');
    lines.push(plan.summary.trim());
    lines.push('');
  } else if (spec?.problemStatement) {
    lines.push('## Özet');
    lines.push('');
    lines.push(spec.problemStatement.trim());
    lines.push('');
  }

  // ── Stack ─────────────────────────────────────────
  const stack = inferStack(files, spec, plan);
  lines.push('## Stack');
  lines.push('');
  if (stack.length === 0) {
    lines.push('- Stack tespit edilemedi.');
  } else {
    for (const item of stack) {
      lines.push(`- ${item}`);
    }
  }
  lines.push('');

  // ── Dosya Yapısı ──────────────────────────────────
  lines.push('## Dosya Yapısı');
  lines.push('');
  const grouped = groupFilesByTopLevel(files);
  if (grouped.length === 0) {
    lines.push('- (henüz dosya yok)');
  } else {
    for (const { topLevel, count, examples } of grouped) {
      const exampleSuffix = examples.length > 0 ? ` — ${examples.join(', ')}` : '';
      lines.push(`- \`${topLevel}\` (${count} dosya)${exampleSuffix}`);
    }
  }
  lines.push('');

  // ── Önemli kararlar (heuristics) ──────────────────
  lines.push('## Önemli kararlar');
  lines.push('');
  const decisions = inferDecisions(files);
  if (decisions.length === 0) {
    lines.push('- Belirgin bir karar notu çıkarılamadı.');
  } else {
    for (const d of decisions) {
      lines.push(`- ${d}`);
    }
  }
  lines.push('');

  // ── Footer ────────────────────────────────────────
  lines.push('---');
  lines.push(`Üretildi: ${now.toISOString()} · AKIS Proto`);
  lines.push('');

  return lines.join('\n');
}

// ─── API-CONTRACT renderer ──────────────────────────

interface ApiContractInput {
  files: ProtoOutput['files'];
  spec?: StructuredSpec;
  now: Date;
}

/**
 * Render a starter API contract document. Lists detected endpoint signatures
 * by scanning common server-side route patterns (Express/Fastify/Next API).
 * If no endpoints can be parsed we still emit a "Endpoint tespit edilemedi"
 * line so the doc is honest about what the heuristic found.
 */
export function renderApiContractMarkdown(input: ApiContractInput): string {
  const { files, spec, now } = input;
  const lines: string[] = [];

  lines.push('# API Contract');
  lines.push('');
  lines.push(
    "> Bu döküman Proto'nun tespit ettiği endpoint'leri listeler. Tam contract için kodu inceleyin."
  );
  lines.push('');

  if (spec?.technicalConstraints?.integrations?.length) {
    lines.push('## Beklenen Entegrasyonlar');
    lines.push('');
    for (const i of spec.technicalConstraints.integrations) {
      lines.push(`- ${i}`);
    }
    lines.push('');
  }

  const endpoints = detectEndpoints(files);
  lines.push('## Endpoints');
  lines.push('');
  if (endpoints.length === 0) {
    lines.push(
      '- Endpoint otomatik olarak tespit edilemedi. Backend kodunda route tanımlarını gözden geçirin.'
    );
  } else {
    for (const ep of endpoints) {
      lines.push(`- \`${ep.method} ${ep.path}\` — \`${ep.file}\``);
    }
  }
  lines.push('');

  lines.push('## Notlar');
  lines.push('');
  lines.push('- Request/response şemaları bu sürümde otomatik üretilmiyor.');
  lines.push('- Auth/header gereksinimlerini route handler kodunda doğrulayın.');
  lines.push('');

  lines.push('---');
  lines.push(`Üretildi: ${now.toISOString()} · AKIS Proto`);
  lines.push('');

  return lines.join('\n');
}

// ─── Heuristics ─────────────────────────────────────

const API_INTEGRATION_KEYWORDS = ['api', 'rest', 'endpoint', 'backend', 'http', 'graphql'];

interface DetectApiSurfaceInput {
  files: ProtoOutput['files'];
  integrations: string[];
}

/** True if the project likely exposes an HTTP API (heuristic). */
export function detectApiSurface(input: DetectApiSurfaceInput): boolean {
  const { files, integrations } = input;
  // Signal 1 — spec integrations mention "API/REST/endpoint/backend".
  for (const i of integrations) {
    const lower = i.toLowerCase();
    if (API_INTEGRATION_KEYWORDS.some((k) => lower.includes(k))) return true;
  }
  // Signal 2 — files include backend-like structures.
  for (const f of files) {
    const p = f.filePath.toLowerCase();
    if (
      p.startsWith('routes/') ||
      p.includes('/routes/') ||
      p.startsWith('api/') ||
      p.includes('/api/') ||
      p.startsWith('pages/api/') || // Next.js pages router
      p.startsWith('app/api/') || // Next.js app router
      /(^|\/)server\.(?:ts|js|mjs)$/.test(p) ||
      /(^|\/)app\.(?:ts|js|mjs)$/.test(p)
    ) {
      // Be a bit stricter — match only if the file content also looks like a
      // server (express/fastify route registration, etc.). Otherwise random
      // src/api/ folders in pure frontend apps would trip the heuristic.
      if (isLikelyServerFile(f.content)) return true;
    }
  }
  return false;
}

function isLikelyServerFile(content: string): boolean {
  if (!content) return false;
  // Express/Fastify route handlers
  if (/\b(?:app|router|fastify|server)\.(?:get|post|put|delete|patch)\s*\(/.test(content))
    return true;
  // Next.js route handlers (app router)
  if (/\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b/.test(content)) return true;
  // Generic handler exports (Next.js pages api)
  if (/\bexport\s+default\s+(?:async\s+)?function\s+handler\b/.test(content)) return true;
  return false;
}

interface DetectedEndpoint {
  method: string;
  path: string;
  file: string;
}

/**
 * Find HTTP endpoints in the file set using regex over common server
 * libraries. Best-effort — we only report what we are confident about.
 */
export function detectEndpoints(files: ProtoOutput['files']): DetectedEndpoint[] {
  const result: DetectedEndpoint[] = [];
  for (const f of files) {
    if (!isLikelyServerFile(f.content)) continue;
    const expressRe =
      /\b(?:app|router|fastify|server)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let match: RegExpExecArray | null;
    while ((match = expressRe.exec(f.content)) !== null) {
      const method = match[1].toUpperCase();
      const path = match[2];
      result.push({ method, path, file: f.filePath });
    }
    // Next.js route handlers (app router) — file path IS the route.
    const nextRouteRe = /\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)\b/g;
    while ((match = nextRouteRe.exec(f.content)) !== null) {
      const method = match[1];
      // Derive route from file path: app/api/foo/route.ts → /api/foo
      const route = f.filePath
        .replace(/^.*?(app\/api\/.*|pages\/api\/.*)$/, '/$1')
        .replace(/\/route\.(?:ts|js|tsx|jsx)$/, '')
        .replace(/^\/app\//, '/')
        .replace(/^\/pages\//, '/')
        .replace(/\.(ts|tsx|js|jsx)$/, '');
      result.push({ method, path: route || f.filePath, file: f.filePath });
    }
  }
  // De-dup
  const seen = new Set<string>();
  return result.filter((ep) => {
    const k = `${ep.method} ${ep.path} ${ep.file}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ─── Stack inference ────────────────────────────────

function inferStack(
  files: ProtoOutput['files'],
  spec?: StructuredSpec,
  plan?: UserFriendlyPlan
): string[] {
  const found: string[] = [];

  // Plan-declared tech choices win when present.
  for (const t of plan?.techChoices ?? []) {
    if (t && t.trim()) found.push(t.trim());
  }

  // Spec-declared stack.
  const specStack = spec?.technicalConstraints?.stack;
  if (specStack && specStack.trim()) {
    if (!found.some((x) => x.toLowerCase() === specStack.toLowerCase())) {
      found.push(specStack.trim());
    }
  }

  // File-based heuristics.
  const has = (predicate: (path: string, content: string) => boolean): boolean =>
    files.some((f) => predicate(f.filePath, f.content));
  const pkg = files.find((f) => /(^|\/)package\.json$/.test(f.filePath));
  if (pkg) {
    const c = pkg.content;
    if (/"react"\s*:/.test(c)) push(found, 'React');
    if (/"vite"\s*:/.test(c)) push(found, 'Vite');
    if (/"next"\s*:/.test(c)) push(found, 'Next.js');
    if (/"express"\s*:/.test(c)) push(found, 'Express');
    if (/"fastify"\s*:/.test(c)) push(found, 'Fastify');
    if (/"typescript"\s*:/.test(c)) push(found, 'TypeScript');
    if (/"tailwindcss"\s*:/.test(c)) push(found, 'Tailwind CSS');
  }
  if (has((p) => /\.tsx?$/.test(p)) && !found.some((s) => s.includes('TypeScript'))) {
    push(found, 'TypeScript');
  }
  if (has((p) => /\.py$/.test(p))) push(found, 'Python');
  if (has((p) => p.endsWith('Dockerfile') || /(^|\/)Dockerfile$/.test(p))) push(found, 'Docker');

  return found;
}

function push(arr: string[], v: string): void {
  if (!arr.some((x) => x.toLowerCase() === v.toLowerCase())) arr.push(v);
}

// ─── File tree grouping ─────────────────────────────

interface DirGroup {
  topLevel: string;
  count: number;
  examples: string[];
}

function groupFilesByTopLevel(files: ProtoOutput['files']): DirGroup[] {
  const map = new Map<string, { count: number; examples: string[] }>();
  for (const f of files) {
    const slash = f.filePath.indexOf('/');
    const topLevel = slash === -1 ? '(root)' : f.filePath.slice(0, slash) + '/';
    const entry = map.get(topLevel) ?? { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3) {
      entry.examples.push(slash === -1 ? f.filePath : f.filePath.slice(slash + 1));
    }
    map.set(topLevel, entry);
  }
  return Array.from(map.entries())
    .map(([topLevel, { count, examples }]) => ({ topLevel, count, examples }))
    .sort((a, b) => a.topLevel.localeCompare(b.topLevel));
}

// ─── Decision notes ─────────────────────────────────

function inferDecisions(files: ProtoOutput['files']): string[] {
  const out: string[] = [];
  const hasFile = (regex: RegExp): boolean => files.some((f) => regex.test(f.filePath));
  const anyFileMatches = (regex: RegExp): boolean => files.some((f) => regex.test(f.content));

  if (hasFile(/(^|\/)package\.json$/) && hasFile(/(^|\/)vite\.config\.[jt]s$/)) {
    out.push('Vite tabanlı bir frontend iskeleti tercih edildi (hızlı HMR + basit build).');
  }
  if (hasFile(/(^|\/)Dockerfile$/)) {
    out.push("Dockerfile eklendi — projeyi sunucuya kurmak için container'lı dağıtım hazır.");
  }
  if (hasFile(/(^|\/)docker-compose\.ya?ml$/)) {
    out.push('docker-compose.yml ile servis topolojisi tanımlandı.');
  }
  if (hasFile(/(^|\/)\.env\.example$/)) {
    out.push("Ortam değişkenleri için .env.example sağlandı — secret'lar repo'ya girmesin.");
  }
  if (anyFileMatches(/localStorage\.(?:setItem|getItem)/)) {
    out.push('Veri kalıcılığı için localStorage kullanıldı — backend bağımlılığı yok.');
  }
  if (anyFileMatches(/\b(?:app|router|fastify|server)\.(?:get|post|put|delete|patch)\s*\(/)) {
    out.push("HTTP endpoint'leri tanımlandı — ayrıntılar için docs/API-CONTRACT.md.");
  }
  return out;
}
