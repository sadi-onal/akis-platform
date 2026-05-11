/**
 * ScaffoldEnricher — F-08 / FR-6.5..6.8
 *
 * After Proto's AI generates a scaffold, this service adds the *portability
 * layer* the bakkal needs to actually run the project:
 *
 *   - install.sh   — single-command install + dev start (per stack)
 *   - README.md    — Turkish "Bilgisayarımda çalıştır" + "Sunucuya kur" + "GitHub'da gör" sections
 *   - Dockerfile   — optional, multi-stage where it makes sense
 *   - docker-compose.yml — optional companion to the Dockerfile
 *   - .env.example — Turkish-commented environment variables placeholder
 *
 * The bakkal's three destinations (PDP § 1, persona use case 4):
 *   1. **Bilgisayarımda çalıştır** — install.sh + 3-step copy-paste in README
 *   2. **Sunucuya kur** — Dockerfile + docker-compose.yml (when stack supports it)
 *   3. **GitHub'da gör**
 *      (depo URL placeholder filled by ProtoAgent at upload time)
 *
 * Wire-in: ProtoAgent calls `enricher.enrich(files, spec)` between the AI
 * generate step and the GitHub push step. See 03-architecture.md § 5.4.
 *
 * All user-facing strings are Turkish and bakkal-language (02-ux § 6 glossary +
 * NFR-5.1). No "repo", "PR", "branch", "commit", "endpoint" — only the
 * Turkish equivalents.
 */

// ─── Types ────────────────────────────────────────

/**
 * Generic scaffold file shape used by the enricher. Matches the {path, content}
 * shape used by the GitHub push tools. ProtoAgent's internal files use
 * `filePath` instead of `path` — the {@link toScaffoldFile} / {@link fromScaffoldFile}
 * helpers below bridge the two.
 */
export interface ScaffoldFile {
  path: string;
  content: string;
}

/** Recognized stacks we know how to enrich. */
export type Stack =
  | 'node-npm'
  | 'node-pnpm'
  | 'node-yarn'
  | 'python-pip'
  | 'python-poetry'
  | 'go'
  | 'rust'
  | 'static'
  | 'unknown';

export interface EnrichOptions {
  /** Generate Dockerfile when the stack supports it (default: true). */
  generateDockerfile?: boolean;
  /** Generate docker-compose.yml alongside Dockerfile (default: true if generateDockerfile). */
  generateCompose?: boolean;
}

interface EnrichSpec {
  title: string;
  description?: string;
}

// ─── Public service ───────────────────────────────

export class ScaffoldEnricher {
  /**
   * Enrich an AI-generated scaffold with portability files.
   *
   * Idempotent: if the AI already produced an `install.sh`, `README.md`, or
   * `.env.example`, the enricher will *not* overwrite them blindly — it
   * appends the bakkal sections to README and leaves a custom install.sh
   * alone. This protects rare cases where the AI produces a stack-specific
   * install.sh we wouldn't generate (e.g., a Makefile-driven build).
   */
  enrich(
    files: ScaffoldFile[],
    spec: EnrichSpec,
    opts: EnrichOptions = {},
  ): ScaffoldFile[] {
    const stack = this.detectStack(files);
    const generateDockerfile = opts.generateDockerfile ?? supportsDocker(stack);
    const generateCompose = opts.generateCompose ?? generateDockerfile;

    const out = files.map((f) => ({ ...f }));
    const has = (p: string): boolean => out.some((f) => normalizePath(f.path) === p);
    const upsert = (path: string, content: string): void => {
      const idx = out.findIndex((f) => normalizePath(f.path) === path);
      if (idx >= 0) out[idx] = { path, content };
      else out.push({ path, content });
    };

    // 1. install.sh — skip for 'unknown' (we don't know how to install) and
    //    skip if the AI already wrote one (respect AI's choice, e.g., Makefile).
    if (stack !== 'unknown' && !has('install.sh')) {
      upsert('install.sh', renderInstallScript(stack));
    }

    // 2. README sections — bakkal needs the 3 destinations regardless of stack.
    //    If a README already exists, append the sections; otherwise create one.
    const existingReadme = out.find((f) => /^readme\.md$/i.test(normalizePath(f.path)));
    const readmeSections = renderReadmeSections(stack, spec);
    if (existingReadme) {
      // Avoid double-appending if the user re-enriches the same files.
      if (!existingReadme.content.includes(README_MARKER)) {
        existingReadme.content =
          existingReadme.content.trimEnd() + '\n\n' + readmeSections;
      }
    } else {
      upsert('README.md', renderReadmeFull(stack, spec));
    }

    // 3. Dockerfile + docker-compose.yml — optional, skipped for unknown / static.
    if (generateDockerfile && supportsDocker(stack) && !has('Dockerfile')) {
      // F-08 review fix: for node stacks, detect whether the scaffold's
      // `package.json` exposes a `start` or `preview` script so the Dockerfile
      // CMD targets a real entry point (Vite scaffolds typically have only
      // `dev` + `preview`, no `start`). See renderDockerfile() comment.
      const nodeRuntime = isNodeStack(stack)
        ? detectNodeRuntime(out)
        : undefined;
      upsert('Dockerfile', renderDockerfile(stack, nodeRuntime));
    }
    if (generateCompose && supportsDocker(stack) && !has('docker-compose.yml')) {
      upsert('docker-compose.yml', renderCompose(stack, spec));
    }

    // 4. .env.example — every stack benefits from a starter env file.
    if (!has('.env.example')) {
      upsert('.env.example', renderEnvExample(stack));
    }

    return out;
  }

  /**
   * Best-effort stack detection from the scaffold's filename set.
   * See 03-architecture.md § 3.3 for the heuristic table.
   */
  detectStack(files: ScaffoldFile[]): Stack {
    const names = new Set(files.map((f) => normalizePath(f.path)));

    if (names.has('package.json')) {
      if (names.has('pnpm-lock.yaml')) return 'node-pnpm';
      if (names.has('yarn.lock')) return 'node-yarn';
      return 'node-npm';
    }
    if (names.has('pyproject.toml')) {
      const py = files.find((f) => normalizePath(f.path) === 'pyproject.toml');
      if (py && /\[tool\.poetry\]/.test(py.content)) return 'python-poetry';
      return 'python-pip';
    }
    if (names.has('requirements.txt')) return 'python-pip';
    if (names.has('go.mod')) return 'go';
    if (names.has('Cargo.toml')) return 'rust';

    // Static-only check: at least one HTML file, and only HTML/CSS/JS asset files.
    const fileNames = files.map((f) => normalizePath(f.path));
    const hasHtml = fileNames.some((n) => n.endsWith('.html'));
    const allStaticish = fileNames.every((n) =>
      /\.(html?|css|js|mjs|cjs|svg|png|jpe?g|gif|webp|ico|md|txt|json|map)$/i.test(n) ||
      n === '.gitignore' ||
      n === 'LICENSE',
    );
    if (hasHtml && allStaticish && files.length > 0) return 'static';

    return 'unknown';
  }
}

// ─── Internal helpers ─────────────────────────────

/**
 * Sentinel string we plant in README sections so re-enriching the same files
 * doesn't duplicate the bakkal sections.
 */
const README_MARKER = '<!-- akis:scaffold-enricher -->';

const HEADER_COMMENT = `# Bu komut dosyası AKIS tarafından üretildi — projeni kendi bilgisayarında çalıştırmak için.`;

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

function supportsDocker(stack: Stack): boolean {
  return (
    stack === 'node-npm' ||
    stack === 'node-pnpm' ||
    stack === 'node-yarn' ||
    stack === 'python-pip' ||
    stack === 'python-poetry' ||
    stack === 'go' ||
    stack === 'rust'
  );
}

function isNodeStack(stack: Stack): boolean {
  return stack === 'node-npm' || stack === 'node-pnpm' || stack === 'node-yarn';
}

/**
 * Which runtime entry point the Node Dockerfile's CMD should target.
 *
 *   - `start`      → `package.json` has a `start` script (Express, Next, etc.)
 *   - `preview`    → `package.json` has `preview` but no `start` (Vite default)
 *   - `serve-dist` → neither — fall back to a static-file server over `dist/`
 *                    (covers built-output-only scaffolds and broken/missing scripts)
 *
 * The detector reads the scaffold's `package.json` from the in-memory file
 * list. If we can't parse it we default to `preview` because the AKIS
 * reference scaffold is React+Vite and the previous `start` default left
 * Vite containers exiting immediately on `docker compose up`.
 */
type NodeRuntime = 'start' | 'preview' | 'serve-dist';

function detectNodeRuntime(files: ScaffoldFile[]): NodeRuntime {
  const pkg = files.find((f) => normalizePath(f.path) === 'package.json');
  if (!pkg) return 'preview';
  let parsed: { scripts?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(pkg.content) as { scripts?: Record<string, unknown> };
  } catch {
    return 'preview';
  }
  const scripts = parsed?.scripts;
  if (scripts && typeof scripts === 'object') {
    if (typeof (scripts as Record<string, unknown>).start === 'string') return 'start';
    if (typeof (scripts as Record<string, unknown>).preview === 'string') return 'preview';
  }
  return 'serve-dist';
}

function renderNodeDockerCmd(pm: 'npm' | 'pnpm' | 'yarn', runtime: NodeRuntime): string {
  switch (runtime) {
    case 'start':
      return `CMD ["${pm}", "start"]`;
    case 'preview':
      return `CMD ["${pm}", "run", "preview"]`;
    case 'serve-dist':
      // `serve` is installed globally above so this works for any pm.
      return `CMD ["serve", "dist", "-l", "3000"]`;
  }
}

function renderNodeDockerCmdComment(runtime: NodeRuntime): string {
  switch (runtime) {
    case 'start':
      return '# CMD: package.json has `start` script.';
    case 'preview':
      return '# CMD: package.json has no `start` — using `preview` (Vite default).';
    case 'serve-dist':
      return '# CMD: package.json has no `start`/`preview` — serving built `dist/` statically.';
  }
}

// ─── install.sh templates ─────────────────────────

function renderInstallScript(stack: Stack): string {
  switch (stack) {
    case 'node-npm':
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'set -euo pipefail',
        '',
        '# 1) Bağımlılıkları yükle (paketleri internetten indir)',
        'npm install',
        '',
        '# 2) Geliştirme sunucusunu başlat',
        'npm run dev',
        '',
      ].join('\n');
    case 'node-pnpm':
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'set -euo pipefail',
        '',
        '# pnpm yüklü değilse: npm install -g pnpm',
        '# 1) Bağımlılıkları yükle',
        'pnpm install',
        '',
        '# 2) Geliştirme sunucusunu başlat',
        'pnpm dev',
        '',
      ].join('\n');
    case 'node-yarn':
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'set -euo pipefail',
        '',
        '# yarn yüklü değilse: npm install -g yarn',
        '# 1) Bağımlılıkları yükle',
        'yarn install',
        '',
        '# 2) Geliştirme sunucusunu başlat',
        'yarn dev',
        '',
      ].join('\n');
    case 'python-pip':
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'set -euo pipefail',
        '',
        '# 1) Sanal ortam oluştur (kütüphaneleri sistemden ayrı tut)',
        'python3 -m venv .venv',
        '',
        '# 2) Sanal ortamı etkinleştir',
        'source .venv/bin/activate',
        '',
        '# 3) Bağımlılıkları yükle',
        'pip install -r requirements.txt',
        '',
        '# 4) Uygulamayı başlat (giriş dosyasını projenize göre değiştirin)',
        'python main.py',
        '',
      ].join('\n');
    case 'python-poetry':
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'set -euo pipefail',
        '',
        '# poetry yüklü değilse: https://python-poetry.org/docs/#installation',
        '# 1) Bağımlılıkları yükle',
        'poetry install',
        '',
        '# 2) Uygulamayı başlat',
        'poetry run python main.py',
        '',
      ].join('\n');
    case 'go':
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'set -euo pipefail',
        '',
        '# 1) Modülleri çöz ve derle',
        'go build ./...',
        '',
        '# 2) Çalıştır (giriş paketinin yolunu projenize göre değiştirin)',
        'go run .',
        '',
      ].join('\n');
    case 'rust':
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'set -euo pipefail',
        '',
        '# 1) Bağımlılıkları indir ve derle',
        'cargo build',
        '',
        '# 2) Uygulamayı başlat',
        'cargo run',
        '',
      ].join('\n');
    case 'static':
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'set -euo pipefail',
        '',
        '# Statik site — kurulum gerekmez. Yerel sunucu başlatır.',
        '# Tarayıcıda aç: http://localhost:8000',
        'python3 -m http.server 8000',
        '',
      ].join('\n');
    case 'unknown':
      // Caller skips install.sh for unknown stacks; this branch is defensive.
      return [
        '#!/usr/bin/env bash',
        HEADER_COMMENT,
        'echo "Bu projenin kurulumu manuel yapılır — README dosyasındaki adımları izleyin."',
        '',
      ].join('\n');
  }
}

// ─── README templates ─────────────────────────────

/**
 * Sections appended to an existing README (or used as the body of a new one).
 * Always Turkish, bakkal-language.
 */
function renderReadmeSections(stack: Stack, spec: EnrichSpec): string {
  const installCmd = primaryInstallCommand(stack);
  const localSection = renderLocalSection(stack, installCmd);
  const serverSection = renderServerSection(stack);
  const githubSection = renderGithubSection(spec);

  return [README_MARKER, '', localSection, '', serverSection, '', githubSection].join('\n');
}

function renderReadmeFull(stack: Stack, spec: EnrichSpec): string {
  const desc = spec.description?.trim()
    ? spec.description.trim()
    : 'Bu proje AKIS tarafından senin için oluşturuldu.';
  return [
    `# ${spec.title || 'Proje'}`,
    '',
    desc,
    '',
    renderReadmeSections(stack, spec),
    '',
  ].join('\n');
}

function renderLocalSection(stack: Stack, installCmd: string): string {
  if (stack === 'unknown') {
    return [
      `## Bu projeyi kendi bilgisayarında çalıştır`,
      '',
      'Bu proje için otomatik kurulum hazırlanamadı. Kullandığın teknolojiye uygun adımları takip et:',
      '',
      '1. Projeyi indir (üstteki "Code → Download ZIP" düğmesinden ya da `git clone` ile).',
      '2. Klasöre gir.',
      '3. Kullandığın dilin/araçların kurulum komutunu çalıştır.',
    ].join('\n');
  }
  return [
    `## Bu projeyi kendi bilgisayarında çalıştır`,
    '',
    'Üç adımda hazır:',
    '',
    '```bash',
    `# 1) Projeyi indir`,
    'git clone <depo-adresin>',
    '# 2) Klasöre gir',
    'cd <klasör-adı>',
    `# 3) Kurulumu başlat (her şeyi yükler ve geliştirme sunucusunu açar)`,
    'bash install.sh',
    '```',
    '',
    `Tek satır tercih edersen: \`${installCmd}\``,
  ].join('\n');
}

function renderServerSection(stack: Stack): string {
  if (supportsDocker(stack)) {
    return [
      `## Sunucuya kur`,
      '',
      'Sunucuda Docker yüklü ise, tek komutla ayağa kalkar:',
      '',
      '```bash',
      'docker compose up --build -d',
      '```',
      '',
      'Bağlantı noktası (port) ve gizli anahtarlar için `.env.example` dosyasını kopyalayıp `.env` olarak doldur:',
      '',
      '```bash',
      'cp .env.example .env',
      '# .env dosyasını metin editöründe aç ve değerleri doldur',
      '```',
    ].join('\n');
  }
  if (stack === 'static') {
    return [
      `## Sunucuya kur`,
      '',
      'Statik bir site olduğu için tek yapman gereken HTML/CSS/JS dosyalarını bir hosting servisine yüklemek:',
      '',
      '- Netlify, Vercel veya GitHub Pages: depoyu bağla, otomatik yayına alır.',
      '- Kendi sunucunda: `nginx` ya da `apache` ile bu klasörü servis et.',
    ].join('\n');
  }
  return [
    `## Sunucuya kur`,
    '',
    'Bu proje için sunucu kurulumu manuel yapılır:',
    '',
    '1. Sunucuya gerekli çalışma ortamını kur (örneğin Node.js, Python, Go).',
    '2. `install.sh` dosyasını çalıştır.',
    '3. Servisi `systemd`, `supervisor` veya `pm2` gibi bir yöneticiye bağla ki sunucu yeniden başladığında uygulama da kalksın.',
  ].join('\n');
}

function renderGithubSection(spec: EnrichSpec): string {
  const safeTitle = spec.title?.trim() || 'projen';
  return [
    `## GitHub'da gör`,
    '',
    `${safeTitle} senin GitHub hesabında bir depoya kaydedildi. Linki AKIS arayüzünden "GitHub'da gör" düğmesiyle açabilirsin.`,
    '',
    'Depo linkin:',
    '',
    '```',
    'https://github.com/<kullanici-adin>/<depo-adi>',
    '```',
    '',
    `Bu adres, AKIS senin için depoyu açtığında otomatik olarak doldurulur.`,
  ].join('\n');
}

function primaryInstallCommand(stack: Stack): string {
  switch (stack) {
    case 'node-npm':
      return 'npm install && npm run dev';
    case 'node-pnpm':
      return 'pnpm install && pnpm dev';
    case 'node-yarn':
      return 'yarn install && yarn dev';
    case 'python-pip':
      return 'python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python main.py';
    case 'python-poetry':
      return 'poetry install && poetry run python main.py';
    case 'go':
      return 'go build ./... && go run .';
    case 'rust':
      return 'cargo build && cargo run';
    case 'static':
      return 'python3 -m http.server 8000';
    case 'unknown':
    default:
      return 'bash install.sh';
  }
}

// ─── Dockerfile templates ─────────────────────────

function renderDockerfile(stack: Stack, nodeRuntime?: NodeRuntime): string {
  switch (stack) {
    case 'node-npm':
    case 'node-pnpm':
    case 'node-yarn': {
      const pm = stack === 'node-pnpm' ? 'pnpm' : stack === 'node-yarn' ? 'yarn' : 'npm';
      const installCmd = pm === 'npm' ? 'npm ci || npm install' : pm === 'yarn' ? 'yarn install --frozen-lockfile || yarn install' : 'pnpm install --frozen-lockfile || pnpm install';
      // F-08 review fix: pick the runtime CMD based on what's actually in
      // `package.json`. Three cases — in priority order:
      //   1) `start`   → CMD ["<pm>", "start"]            (Express/Next/etc.)
      //   2) `preview` → CMD ["<pm>", "run", "preview"]   (Vite default)
      //   3) (none)    → CMD ["npx", "serve", "dist", ...]
      // We default to `preview` when the package.json wasn't readable so
      // Vite scaffolds (the AKIS reference) don't get a broken CMD.
      // We also drop the `|| true` from RUN so real build failures surface.
      const runtime = nodeRuntime ?? 'preview';
      const cmdLine = renderNodeDockerCmd(pm, runtime);
      const cmdComment = renderNodeDockerCmdComment(runtime);
      return [
        '# AKIS tarafından üretilen Dockerfile — basit, çok aşamalı.',
        'FROM node:20-alpine AS builder',
        'WORKDIR /app',
        'COPY package*.json ./',
        ...(stack === 'node-pnpm' ? ['COPY pnpm-lock.yaml ./', 'RUN npm install -g pnpm'] : []),
        ...(stack === 'node-yarn' ? ['COPY yarn.lock ./'] : []),
        `RUN ${installCmd}`,
        'COPY . .',
        `RUN ${pm} run build`,
        '',
        'FROM node:20-alpine AS runner',
        'WORKDIR /app',
        'COPY --from=builder /app /app',
        'ENV NODE_ENV=production',
        'EXPOSE 3000',
        ...(runtime === 'serve-dist' ? ['RUN npm install -g serve'] : []),
        cmdComment,
        cmdLine,
        '',
      ].join('\n');
    }
    case 'python-pip':
      return [
        '# AKIS tarafından üretilen Dockerfile — Python pip tabanlı.',
        'FROM python:3.12-slim',
        'WORKDIR /app',
        'COPY requirements.txt ./',
        'RUN pip install --no-cache-dir -r requirements.txt',
        'COPY . .',
        'EXPOSE 8000',
        'CMD ["python", "main.py"]',
        '',
      ].join('\n');
    case 'python-poetry':
      return [
        '# AKIS tarafından üretilen Dockerfile — Python poetry tabanlı.',
        'FROM python:3.12-slim',
        'WORKDIR /app',
        'RUN pip install --no-cache-dir poetry',
        'COPY pyproject.toml poetry.lock* ./',
        'RUN poetry config virtualenvs.create false && poetry install --no-interaction --no-ansi --no-root',
        'COPY . .',
        'EXPOSE 8000',
        'CMD ["poetry", "run", "python", "main.py"]',
        '',
      ].join('\n');
    case 'go':
      return [
        '# AKIS tarafından üretilen Dockerfile — Go çok aşamalı.',
        'FROM golang:1.22-alpine AS builder',
        'WORKDIR /src',
        'COPY go.mod go.sum* ./',
        'RUN go mod download',
        'COPY . .',
        'RUN CGO_ENABLED=0 GOOS=linux go build -o /out/app .',
        '',
        'FROM alpine:3.20',
        'WORKDIR /app',
        'COPY --from=builder /out/app /app/app',
        'EXPOSE 8080',
        'CMD ["/app/app"]',
        '',
      ].join('\n');
    case 'rust':
      return [
        '# AKIS tarafından üretilen Dockerfile — Rust çok aşamalı.',
        'FROM rust:1.78-slim AS builder',
        'WORKDIR /src',
        'COPY . .',
        'RUN cargo build --release',
        '',
        'FROM debian:bookworm-slim',
        'WORKDIR /app',
        'COPY --from=builder /src/target/release/* /app/',
        'EXPOSE 8080',
        'CMD ["/app/app"]',
        '',
      ].join('\n');
    default:
      // Defensive fallback; supportsDocker() gates the caller.
      return '# AKIS — bu stack için Dockerfile şablonu yok.\n';
  }
}

function renderCompose(stack: Stack, spec: EnrichSpec): string {
  const port =
    stack === 'go' || stack === 'rust' ? 8080 : stack === 'python-pip' || stack === 'python-poetry' ? 8000 : 3000;
  const serviceName = (spec.title || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  return [
    '# AKIS tarafından üretilen docker-compose.yml — tek servisli basit kurulum.',
    'services:',
    `  ${serviceName}:`,
    '    build: .',
    '    ports:',
    `      - "${port}:${port}"`,
    '    env_file:',
    '      - .env',
    '    restart: unless-stopped',
    '',
  ].join('\n');
}

// ─── .env.example template ────────────────────────

function renderEnvExample(stack: Stack): string {
  const defaultPort =
    stack === 'go' || stack === 'rust' ? 8080 : stack === 'python-pip' || stack === 'python-poetry' ? 8000 : 3000;
  const lines = [
    '# AKIS tarafından üretildi — gerçek değerleri buraya değil, .env dosyasına yaz.',
    '# Bu dosyayı kopyalayıp ".env" olarak kaydet ve değerleri doldur:',
    '#   cp .env.example .env',
    '',
    '# bu değer: uygulamanın çalışacağı bağlantı noktası (port). Bu portu açık tut.',
    `PORT=${defaultPort}`,
    '',
    '# bu değer: çalışma ortamı (development | production). Yerelde development bırak.',
    'NODE_ENV=development',
    '',
    "# bu değer: OpenAI'dan alacağın anahtar — eğer projen OpenAI kullanıyorsa doldur, kullanmıyorsa boş bırak.",
    '# https://platform.openai.com/api-keys adresinden oluşturabilirsin.',
    'OPENAI_API_KEY=',
    '',
    '# bu değer: veritabanı bağlantı adresi (kullanıyorsa). Örnek: postgres://user:pass@host:5432/db',
    'DATABASE_URL=',
    '',
    '# bu değer: oturum/giriş için rastgele uzun bir gizli anahtar. Üretmek için: openssl rand -hex 32',
    'AUTH_SECRET=',
    '',
  ];
  return lines.join('\n');
}

// ─── Bridge helpers (ProtoAgent uses {filePath, content, linesOfCode}) ──────

/**
 * Convert a Proto-shape file ({filePath, content, ...}) to {@link ScaffoldFile}.
 */
export function toScaffoldFile<T extends { filePath: string; content: string }>(f: T): ScaffoldFile {
  return { path: f.filePath, content: f.content };
}

/**
 * Convert a {@link ScaffoldFile} back to Proto's internal shape, recomputing
 * line count.
 */
export function fromScaffoldFile(
  f: ScaffoldFile,
): { filePath: string; content: string; linesOfCode: number } {
  return {
    filePath: f.path,
    content: f.content,
    linesOfCode: f.content.split('\n').length,
  };
}
