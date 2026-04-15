/**
 * RepoContextAgent — fetches and analyzes an existing GitHub repository
 * to provide context to Scribe, Proto, and chat responses.
 *
 * Uses the existing GitHubServiceLike adapter — does NOT create its own GitHub client.
 */
import type { RepoContextInput, RepoContext, RepoFile } from './RepoContextTypes.js';
import { REPO_SUMMARIZE_SYSTEM_PROMPT } from './prompts/summarize-repo.js';
import { logger } from '../../../lib/logger.js';

// ─── Dependency Interfaces ──────────────────────

export interface RepoContextAIDeps {
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface RepoContextGitHubDeps {
  listFiles(owner: string, repo: string, branch: string): Promise<string[]>;
  getFileContent(owner: string, repo: string, branch: string, filePath: string): Promise<string>;
}

// ─── Constants ──────────────────────────────────

const MAX_KEY_FILES = 10;
const MAX_LINES_PER_FILE = 500;
const MAX_TREE_DEPTH = 3;

/** Files to always try reading when present (order = priority). */
const PRIORITY_FILES = [
  'README.md',
  'readme.md',
  'package.json',
  'tsconfig.json',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  '.env.example',
  'docker-compose.yml',
  'Dockerfile',
];

/** Patterns that indicate an entry-point source file. */
const ENTRY_POINT_PATTERNS = [
  /^src\/index\.[tj]sx?$/,
  /^src\/main\.[tj]sx?$/,
  /^src\/app\.[tj]sx?$/,
  /^src\/server\.[tj]sx?$/,
  /^src\/App\.[tj]sx?$/,
  /^app\/page\.[tj]sx?$/,
  /^pages\/index\.[tj]sx?$/,
  /^index\.[tj]sx?$/,
  /^main\.[tj]sx?$/,
  /^server\.[tj]sx?$/,
  /^app\.[tj]sx?$/,
];

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.rb',
  '.java', '.kt', '.swift', '.vue', '.svelte', '.css', '.scss',
  '.html', '.sql', '.sh', '.yaml', '.yml', '.toml',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.cache', 'coverage', '.turbo', '.vercel', 'target', 'vendor',
]);

// ─── Language Detection ─────────────────────────

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', rb: 'Ruby', java: 'Java',
  kt: 'Kotlin', swift: 'Swift', vue: 'Vue', svelte: 'Svelte',
  css: 'CSS', scss: 'SCSS', html: 'HTML', sql: 'SQL', sh: 'Shell',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', json: 'JSON', md: 'Markdown',
};

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG_MAP[ext] ?? 'text';
}

function getExtension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() ?? '';
}

// ─── Agent ──────────────────────────────────────

export class RepoContextAgent {
  constructor(
    private ai: RepoContextAIDeps,
    private github: RepoContextGitHubDeps,
  ) {}

  /**
   * Fetch repository context: file tree, key files, AI summary.
   * Total context budget: ~30K tokens max.
   */
  async fetchContext(input: RepoContextInput): Promise<RepoContext> {
    const branch = input.branch ?? 'main';
    const maxDepth = input.maxDepth ?? MAX_TREE_DEPTH;

    // Step 1: Get file tree
    let allFiles: string[];
    try {
      allFiles = await this.github.listFiles(input.owner, input.repo, branch);
    } catch (err) {
      logger.warn({ err, owner: input.owner, repo: input.repo, branch }, '[RepoContext] Failed to list files');
      throw new Error(`Repository dosya listesi alinamadi: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Filter out ignored directories
    const filteredFiles = allFiles.filter((f) => {
      const parts = f.split('/');
      return !parts.some((p) => IGNORE_DIRS.has(p));
    });

    // Build tree string (depth-limited)
    const fileTree = this.buildTreeString(filteredFiles, maxDepth);

    // Compute structure stats
    const structure = this.computeStructure(filteredFiles);

    // Step 2: Read key files (priority files first, then entry points)
    const keyFiles = await this.readKeyFiles(input.owner, input.repo, branch, filteredFiles);

    // Step 3: AI summary
    const { summary, techStack } = await this.generateSummary(
      input.owner, input.repo, fileTree, keyFiles,
    );

    return {
      owner: input.owner,
      repo: input.repo,
      branch,
      fileTree,
      summary,
      techStack,
      keyFiles,
      structure,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Build a tree-style string representation, limited to maxDepth levels.
   */
  buildTreeString(files: string[], maxDepth: number): string {
    // Group files into a nested structure
    const tree: Record<string, unknown> = {};

    for (const file of files) {
      const parts = file.split('/');
      if (parts.length > maxDepth + 1) continue; // skip files deeper than maxDepth

      let current = tree;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) {
          // Leaf file
          current[part] = null;
        } else {
          if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {};
          }
          current = current[part] as Record<string, unknown>;
        }
      }
    }

    // Render tree
    const lines: string[] = [];
    this.renderTree(tree, '', lines);

    // Cap at 200 lines to avoid context overflow
    if (lines.length > 200) {
      return lines.slice(0, 200).join('\n') + `\n... (${lines.length - 200} more entries)`;
    }
    return lines.join('\n');
  }

  private renderTree(node: Record<string, unknown>, prefix: string, lines: string[]): void {
    const entries = Object.keys(node).sort((a, b) => {
      // Directories first
      const aIsDir = node[a] !== null;
      const bIsDir = node[b] !== null;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.localeCompare(b);
    });

    for (let i = 0; i < entries.length; i++) {
      const name = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const isDir = node[name] !== null;

      lines.push(`${prefix}${connector}${isDir ? name + '/' : name}`);

      if (isDir) {
        const childPrefix = prefix + (isLast ? '    ' : '│   ');
        this.renderTree(node[name] as Record<string, unknown>, childPrefix, lines);
      }
    }
  }

  /**
   * Compute repository structure statistics.
   */
  computeStructure(files: string[]): RepoContext['structure'] {
    const languages: Record<string, number> = {};
    const topDirs = new Set<string>();

    for (const file of files) {
      const ext = getExtension(file);
      if (ext) {
        languages[ext] = (languages[ext] ?? 0) + 1;
      }

      const firstDir = file.split('/')[0];
      if (file.includes('/')) {
        topDirs.add(firstDir);
      }
    }

    return {
      totalFiles: files.length,
      languages,
      directories: [...topDirs].sort(),
    };
  }

  /**
   * Read key files: config files first, then entry points.
   * Truncates each file to MAX_LINES_PER_FILE lines.
   */
  async readKeyFiles(
    owner: string, repo: string, branch: string, allFiles: string[],
  ): Promise<RepoFile[]> {
    const filesToRead: string[] = [];
    const fileSet = new Set(allFiles);

    // 1. Priority config files
    for (const pf of PRIORITY_FILES) {
      if (fileSet.has(pf) && filesToRead.length < MAX_KEY_FILES) {
        filesToRead.push(pf);
      }
    }

    // 2. Entry point source files
    for (const file of allFiles) {
      if (filesToRead.length >= MAX_KEY_FILES) break;
      if (filesToRead.includes(file)) continue;
      if (ENTRY_POINT_PATTERNS.some((p) => p.test(file))) {
        filesToRead.push(file);
      }
    }

    // 3. Fill remaining slots with important-looking source files
    if (filesToRead.length < MAX_KEY_FILES) {
      const sourceFiles = allFiles
        .filter((f) => {
          const ext = `.${getExtension(f)}`;
          return SOURCE_EXTENSIONS.has(ext) && !filesToRead.includes(f);
        })
        // Prefer shallower files (more likely to be important)
        .sort((a, b) => a.split('/').length - b.split('/').length);

      for (const sf of sourceFiles) {
        if (filesToRead.length >= MAX_KEY_FILES) break;
        filesToRead.push(sf);
      }
    }

    // Read files in parallel
    const results = await Promise.allSettled(
      filesToRead.map(async (filePath): Promise<RepoFile> => {
        const content = await this.github.getFileContent(owner, repo, branch, filePath);
        const truncated = this.truncateContent(content, MAX_LINES_PER_FILE);
        return {
          path: filePath,
          content: truncated,
          language: detectLanguage(filePath),
          size: content.length,
        };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<RepoFile> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * Truncate file content to maxLines, appending a notice if truncated.
   */
  truncateContent(content: string, maxLines: number): string {
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;
    return lines.slice(0, maxLines).join('\n') + `\n\n// ... truncated (${lines.length - maxLines} more lines)`;
  }

  /**
   * Call AI to summarize the repo: tech stack, architecture, patterns.
   */
  private async generateSummary(
    owner: string,
    repo: string,
    fileTree: string,
    keyFiles: RepoFile[],
  ): Promise<{ summary: string; techStack: string[] }> {
    const fileContents = keyFiles
      .map((f) => `--- ${f.path} (${f.language}) ---\n${f.content}`)
      .join('\n\n');

    const userPrompt = `Repository: ${owner}/${repo}

FILE TREE:
${fileTree}

KEY FILES:
${fileContents}

Analyze this repository and respond with the JSON format specified.`;

    try {
      const response = await this.ai.generateText(REPO_SUMMARIZE_SYSTEM_PROMPT, userPrompt);

      // Parse JSON from response (handle potential markdown fences)
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned) as {
        summary?: string;
        techStack?: string[];
      };

      return {
        summary: parsed.summary ?? `${owner}/${repo} repository`,
        techStack: parsed.techStack ?? [],
      };
    } catch (err) {
      logger.warn({ err, owner, repo }, '[RepoContext] AI summary failed, using fallback');
      // Fallback: detect tech stack from file extensions
      const techStack = this.detectTechStackFromFiles(keyFiles);
      return {
        summary: `${owner}/${repo} — a ${techStack.join(', ')} project.`,
        techStack,
      };
    }
  }

  /**
   * Fallback tech stack detection from key files (no AI needed).
   */
  private detectTechStackFromFiles(keyFiles: RepoFile[]): string[] {
    const stack: Set<string> = new Set();
    for (const f of keyFiles) {
      if (f.path === 'package.json') {
        try {
          const pkg = JSON.parse(f.content);
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps.react) stack.add('React');
          if (allDeps.next) stack.add('Next.js');
          if (allDeps.vue) stack.add('Vue');
          if (allDeps.svelte) stack.add('Svelte');
          if (allDeps.fastify) stack.add('Fastify');
          if (allDeps.express) stack.add('Express');
          if (allDeps.typescript) stack.add('TypeScript');
          if (allDeps['drizzle-orm']) stack.add('Drizzle ORM');
          if (allDeps.prisma) stack.add('Prisma');
          if (allDeps.tailwindcss) stack.add('Tailwind CSS');
          if (allDeps.vite) stack.add('Vite');
          if (allDeps.playwright) stack.add('Playwright');
          if (allDeps.vitest) stack.add('Vitest');
        } catch { /* ignore parse errors */ }
      }
      if (f.path === 'tsconfig.json') stack.add('TypeScript');
      if (f.path === 'requirements.txt' || f.path === 'pyproject.toml') stack.add('Python');
      if (f.path === 'Cargo.toml') stack.add('Rust');
      if (f.path === 'go.mod') stack.add('Go');
    }
    return [...stack];
  }
}
