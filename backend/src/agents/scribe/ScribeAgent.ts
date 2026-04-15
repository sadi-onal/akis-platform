import { BaseAgent } from '../../core/agents/BaseAgent.js';
import type { AgentDependencies } from '../../core/agents/AgentFactory.js';
import { GitHubMCPService } from '../../services/mcp/adapters/GitHubMCPService.js';
import type { AIService, Plan, Planner } from '../../services/ai/AIService.js';
import type { MCPTools } from '../../services/mcp/adapters/index.js';
import type { TraceRecorder } from '../../core/tracing/TraceRecorder.js';
import { getContractForPath, buildContractPrompt, detectDocFileType, type RepoContext, resolveDocPackConfig, targetToPath, type DocPack, type DocDepth, type ResolvedDocPackConfig } from './DocContract.js';
import { SCRIBE_GENERATE_SYSTEM_PROMPT } from '../../services/ai/prompt-constants.js';
import { createPlanGenerator, type PlanContext, type GeneratedPlan } from '../../core/planning/PlanGenerator.js';
import { db } from '../../db/client.js';
import { jobPlans } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { runScribeSkill, type ScribeSkillName } from '../../core/contracts/ScribeSkillContracts.js';
import { logger } from '../../lib/logger.js';

/**
 * ScribeTaskContext - Input payload for ScribeAgent
 */
export interface ScribeTaskContext {
  owner: string;
  repo: string;
  baseBranch: string; // e.g. 'main'
  featureBranch?: string; // e.g. 'feat/new-docs', if provided, edits happen here
  targetPath?: string; // e.g. 'README.md' or 'docs/'
  taskDescription?: string;
  /** Config-aware mode flag (S0.4.6) */
  mode?: 'from_config' | 'test' | 'run' | string;
  /** If true, do NOT write to GitHub; only simulate */
  dryRun?: boolean;
  /** Optional branch pattern, e.g. 'docs/scribe-{timestamp}' */
  branchPattern?: string;
  /** Optional PR title/body templates from agent config */
  prTitleTemplate?: string;
  prBodyTemplate?: string | null;
  /** PR-1: Whether this job requires human approval before execution */
  requiresApproval?: boolean;
  /** PR-1: Job ID for plan artifact storage */
  jobId?: string;
  /** Doc Pack level: readme | standard | full */
  docPack?: DocPack;
  /** Doc Depth: lite | standard | deep */
  docDepth?: DocDepth;
  /** Explicit output targets (e.g. ["README", "ARCHITECTURE"]) */
  outputTargets?: string[];
  /** Max output tokens (server-enforced cap) */
  maxOutputTokens?: number;
  /** Number of generation passes (1 or 2) */
  passes?: number;
  /** Analyze last N commits/PRs for context (optional) */
  analyzeLastNCommits?: number;
  /** Optional deterministic skill mode for contract-first output generation */
  skill?: ScribeSkillName;
  /** Skill input payload validated by per-skill schema */
  skillInput?: unknown;
}

/**
 * File target for documentation update
 */
interface DocFileTarget {
  path: string;
  existingContent: string;
  contract: ReturnType<typeof getContractForPath>;
  priority: number;
}

/**
 * ScribeAgent v2 - Contract-first Doc Specialist
 * 
 * Upgrades:
 * - Contract-driven documentation structure
 * - Multi-file support (docs/ directory targets)
 * - Playbook-driven workflow: scan → scope → plan → generate → review → commit/PR
 * - Enhanced AI integration with contract-compliant prompts
 * - Maintains explainability timeline
 * 
 * Phase 6.A: Uses GitHub MCP and AIService
 * S1.1: Explainability UI integration with TraceRecorder
 * S2.0: Contract-first multi-file Doc Specialist
 */
export class ScribeAgent extends BaseAgent {
  readonly type = 'scribe';
  private githubMCP?: GitHubMCPService;
  private aiService?: AIService;
  private traceRecorder?: TraceRecorder;
  /** PR-1: Generated plan for contract-first workflow */
  private generatedPlan?: GeneratedPlan;

  constructor(deps?: AgentDependencies) {
    super();
    // Inject dependencies
    if (deps?.tools?.githubMCP) {
      this.githubMCP = deps.tools.githubMCP as GitHubMCPService;
    }
    if (deps?.tools?.aiService) {
      this.aiService = deps.tools.aiService as AIService;
    }
    // S1.1: TraceRecorder for explainability
    if (deps?.traceRecorder) {
      this.traceRecorder = deps.traceRecorder;
    }

    // Enable planning phase
    this.playbook.requiresPlanning = true;
    // Disable orchestrator-level reflection because we do "reflect-before-commit" internally
    this.playbook.requiresReflection = false;
  }

  /**
   * PR-1: Generate and persist contract-first plan
   * This method creates the plan artifact and stores it in the database
   */
  async generateContractPlan(context: ScribeTaskContext): Promise<GeneratedPlan> {
    const planGenerator = createPlanGenerator(this.aiService);
    
    // Build plan context from task context
    const planContext: PlanContext = {
      jobId: context.jobId || 'unknown',
      agentType: this.type,
      taskDescription: context.taskDescription || 'Update documentation',
      targetPath: context.targetPath,
      repositoryOwner: context.owner,
      repositoryName: context.repo,
      baseBranch: context.baseBranch,
      featureBranch: context.featureBranch,
      dryRun: context.dryRun === true,
      requiresApproval: context.requiresApproval === true,
    };

    // Record plan generation start
    this.traceRecorder?.startStep('generate-plan', 'Generating contract-first plan');

    // Generate the plan
    const plan = await planGenerator.generatePlan(planContext);

    // Validate the plan
    const validation = planGenerator.validatePlan(plan.markdown);
    if (!validation.valid) {
      this.traceRecorder?.failStep('generate-plan', 'Plan validation failed', validation.errors.join('; '));
      throw new Error(`Plan validation failed: ${validation.errors.join('; ')}`);
    }

    // Record any warnings
    if (validation.warnings.length > 0) {
      this.traceRecorder?.recordInfo(`Plan warnings: ${validation.warnings.join('; ')}`);
    }

    // Store the plan
    this.generatedPlan = plan;

    // Persist to database if we have a jobId
    if (context.jobId) {
      await this.persistPlan(context.jobId, plan);
    }

    // Record plan artifact
    this.traceRecorder?.recordArtifact({
      artifactType: 'doc_read', // Use existing type for compatibility
      path: 'plan.md',
      operation: 'create',
      preview: plan.markdown.substring(0, 1000),
      sizeBytes: plan.markdown.length,
      metadata: {
        planVersion: plan.json.version,
        requiresApproval: plan.requiresApproval,
        sections: Object.keys(plan.json.sections),
      },
    });

    this.traceRecorder?.completeStep('generate-plan', 'Contract-first plan generated', {
      requiresApproval: plan.requiresApproval,
      sections: Object.keys(plan.json.sections).length,
    });

    // Record reasoning summary
    this.traceRecorder?.recordReasoning({
      phase: 'planning',
      summary: `Contract-first plan generated successfully. ` +
               `Approval ${plan.requiresApproval ? 'required' : 'not required'}. ` +
               `${plan.json.sections.plan.length} execution steps planned. ` +
               `Risk level: ${(plan.json.metadata as Record<string, unknown>)?.riskLevel || 'unknown'}.`,
    });

    return plan;
  }

  /**
   * PR-1: Persist plan to database
   */
  private async persistPlan(jobId: string, plan: GeneratedPlan): Promise<void> {
    try {
      // Check if plan already exists for this job
      const existing = await db.select().from(jobPlans).where(eq(jobPlans.jobId, jobId)).limit(1);

      if (existing.length > 0) {
        // Update existing plan
        await db.update(jobPlans)
          .set({
            planMarkdown: plan.markdown,
            planJson: plan.json,
            updatedAt: new Date(),
          })
          .where(eq(jobPlans.jobId, jobId));
      } else {
        // Insert new plan
        await db.insert(jobPlans).values({
          jobId,
          planMarkdown: plan.markdown,
          planJson: plan.json,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    } catch (error) {
      // Log but don't fail - plan persistence is not critical to execution
      logger.error(`Failed to persist plan: ${error}`);
      this.traceRecorder?.recordError('Plan persistence failed', 'PLAN_PERSIST_ERROR', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * PR-1: Get the generated plan (for external access)
   */
  getGeneratedPlan(): GeneratedPlan | undefined {
    return this.generatedPlan;
  }

  /**
   * Configuration for full-repo context scanning
   */
  private static readonly REPO_SCAN_CONFIG = {
    maxFiles: 150,
    maxBytesPerFile: 20000,
    previewLength: 8000,
    maxDepth: 3,
    maxFilesPerDir: 10,
  };

  /**
   * Priority score for file paths (lower = higher priority)
   */
  private getFilePriority(path: string): number {
    // Root config/readme files - highest priority
    if (/^README(\..+)?$/i.test(path)) return 1;
    if (/^package\.json$/i.test(path)) return 2;
    if (/^LICENSE/i.test(path)) return 3;
    if (/^\.env\.example$/i.test(path)) return 4;
    if (/^tsconfig(\..+)?\.json$/i.test(path)) return 5;
    if (/^Dockerfile/i.test(path)) return 6;
    if (/^docker-compose.*\.ya?ml$/i.test(path)) return 7;
    if (/^Makefile$/i.test(path)) return 8;
    
    // Docs folder - high priority
    if (/^docs?\//i.test(path)) return 10;
    if (/^\.github\//i.test(path)) return 11;
    
    // Backend source - medium priority
    if (/^backend\/.*\.(ts|js|json|md)$/i.test(path)) return 20;
    if (/^backend\/package\.json$/i.test(path)) return 15;
    
    // Frontend source - medium priority
    if (/^frontend\/.*\.(ts|tsx|js|jsx|json|md)$/i.test(path)) return 25;
    if (/^frontend\/package\.json$/i.test(path)) return 16;
    
    // Src folder - medium priority
    if (/^src\/.*\.(ts|tsx|js|jsx|json|md)$/i.test(path)) return 30;
    
    // Config files anywhere
    if (/\.(json|ya?ml|toml)$/i.test(path)) return 40;
    
    // Source files anywhere
    if (/\.(ts|tsx|js|jsx)$/i.test(path)) return 50;
    
    // Documentation files anywhere
    if (/\.(md|mdx|txt)$/i.test(path)) return 60;
    
    // Default low priority
    return 100;
  }

  /**
   * Check if a file should be excluded from repo scanning
   */
  private shouldExcludeFile(path: string): boolean {
    const excludePatterns = [
      // Directories (with leading ^ for start of path)
      /^node_modules\//i,
      /^\.git\//i,
      /^dist\//i,
      /^build\//i,
      /^\.next\//i,
      /^coverage\//i,
      /^\.cache\//i,
      /^\.turbo\//i,
      /^__pycache__\//i,
      /^\.venv\//i,
      /^venv\//i,
      /^vendor\//i,
      /^\.idea\//i,
      /^\.vscode\//i,
      
      // Lock files
      /package-lock\.json$/i,
      /pnpm-lock\.yaml$/i,
      /yarn\.lock$/i,
      /Gemfile\.lock$/i,
      /poetry\.lock$/i,
      /composer\.lock$/i,
      
      // Binary/media files
      /\.(png|jpg|jpeg|gif|svg|ico|webp|bmp|tiff)$/i,
      /\.(woff|woff2|ttf|eot|otf)$/i,
      /\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i,
      /\.(zip|tar|gz|rar|7z|bz2)$/i,
      /\.(mp3|mp4|avi|mov|wav|flac|ogg|webm)$/i,
      /\.(exe|dll|so|dylib|bin)$/i,
      
      // Database files
      /\.(sqlite|sqlite3|db)$/i,
      /\.mdb$/i,
      
      // Generated/minified
      /\.min\.(js|css)$/i,
      /\.map$/i,
      /\.d\.ts$/i,
      /\.bundle\.(js|css)$/i,
      
      // OS/system files
      /\.DS_Store$/i,
      /Thumbs\.db$/i,
      /desktop\.ini$/i,
      
      // Log files
      /\.log$/i,
      /npm-debug\.log/i,
    ];
    
    return excludePatterns.some(p => p.test(path));
  }

  /**
   * Safely list directory contents using GitHub MCP
   * Returns null if listing fails (e.g., path not found or not a directory)
   */
  private async listDirectorySafe(
    owner: string,
    repo: string,
    branch: string,
    path: string
  ): Promise<Array<{ name: string; type: 'file' | 'dir'; path: string }> | null> {
    if (!this.githubMCP) return null;
    
    try {
      // GitHub's get_file_contents returns array for directories
      const result = await this.githubMCP.callToolRaw('get_file_contents', {
        owner,
        repo,
        path: path || '.',
        branch,
      });
      
      // Check if result is an array (directory listing)
      if (Array.isArray(result)) {
        return result.map((item: { name?: string; type?: string; path?: string }) => ({
          name: String(item.name || ''),
          type: item.type === 'dir' ? 'dir' : 'file',
          path: String(item.path || item.name || ''),
        }));
      }
      
      // Not a directory - return null
      return null;
    } catch {
      // Directory not found or other error - return null silently
      logger.debug(`[Scribe] Could not list directory: ${path}`);
      return null;
    }
  }

  /**
   * Recursively scan a directory, accumulating discovered files
   */
  private async scanDirectoryRecursive(
    owner: string,
    repo: string,
    branch: string,
    dirPath: string,
    depth: number,
    maxDepth: number,
    accumulated: { path: string; type: 'file' | 'dir' }[]
  ): Promise<void> {
    if (depth > maxDepth) return;
    if (accumulated.length >= ScribeAgent.REPO_SCAN_CONFIG.maxFiles) return;

    const listing = await this.listDirectorySafe(owner, repo, branch, dirPath);
    if (!listing) return;

    for (const item of listing) {
      if (accumulated.length >= ScribeAgent.REPO_SCAN_CONFIG.maxFiles) break;
      if (this.shouldExcludeFile(item.path)) continue;

      accumulated.push({ path: item.path, type: item.type });

      if (item.type === 'dir' && depth < maxDepth) {
        await this.scanDirectoryRecursive(owner, repo, branch, item.path, depth + 1, maxDepth, accumulated);
      }
    }
  }

  /**
   * Analyze discovered files to build a source structure map
   */
  private analyzeSourceStructure(
    allFiles: { path: string; type: 'file' | 'dir' }[]
  ): NonNullable<import('./DocContract.js').RepoContext['sourceStructure']> {
    const structure = {
      entryPoints: [] as string[],
      routes: [] as string[],
      models: [] as string[],
      middleware: [] as string[],
      testDirs: [] as string[],
      configFiles: [] as string[],
    };

    for (const f of allFiles) {
      if (f.type !== 'file') continue;
      const p = f.path.toLowerCase();
      if (/^(src\/)?(index|main|app|server)\.(ts|js|tsx|jsx)$/.test(p)) structure.entryPoints.push(f.path);
      if (/route/i.test(p) && /\.(ts|js|tsx|jsx|py|go|rb)$/.test(p)) structure.routes.push(f.path);
      if (/(model|schema|entity)/i.test(p) && /\.(ts|js|tsx|jsx|py|go|rb)$/.test(p)) structure.models.push(f.path);
      if (/(middleware|interceptor|guard)/i.test(p) && /\.(ts|js|py|go|rb)$/.test(p)) structure.middleware.push(f.path);
      if (/(test|spec|__tests__)/i.test(p)) structure.testDirs.push(f.path);
      if (/\.(json|ya?ml|toml|env)$/.test(p) && !p.includes('node_modules')) structure.configFiles.push(f.path);
    }

    return structure;
  }

  /**
   * Auto-detect the appropriate DocPack level from repo analysis
   */
  private detectRequiredDocuments(repoContext: RepoContext): DocPack {
    const fileCount = repoContext.fileCount ?? 0;
    const structure = repoContext.sourceStructure;
    const hasRoutes = (structure?.routes.length ?? 0) > 0;
    const hasModels = (structure?.models.length ?? 0) > 0;

    if (fileCount >= 50 || (hasRoutes && hasModels)) return 'full';
    if (fileCount >= 10 || hasRoutes || repoContext.hasDockerfile) return 'standard';
    return 'readme';
  }

  /**
   * Detect project type based on existing files and directories
   */
  private detectProjectType(
    files: Set<string>,
    dirs: Set<string>
  ): 'node-express' | 'react' | 'next' | 'node-generic' | 'python' | 'go' | 'rust' | 'unknown' {
    // Check for Node.js project
    if (files.has('package.json')) {
      // Next.js
      if (files.has('next.config.js') || files.has('next.config.mjs') || files.has('next.config.ts')) {
        return 'next';
      }
      // React (Vite, CRA, etc.)
      if (dirs.has('src') && (files.has('vite.config.ts') || files.has('vite.config.js'))) {
        return 'react';
      }
      // Express/Node backend
      if (files.has('server.js') || files.has('app.js') || files.has('index.js')) {
        return 'node-express';
      }
      return 'node-generic';
    }
    
    // Python project
    if (files.has('requirements.txt') || files.has('setup.py') || files.has('pyproject.toml')) {
      return 'python';
    }
    
    // Go project
    if (files.has('go.mod')) {
      return 'go';
    }
    
    // Rust project
    if (files.has('Cargo.toml')) {
      return 'rust';
    }
    
    return 'unknown';
  }

  /**
   * Gather comprehensive repository context for grounded documentation
   * Reads docs + source code + configs to provide full evidence for AI generation
   * 
   * Strategy:
   * 1. Try to read commonly expected files at known paths
   * 2. Prioritize by importance (README > package.json > docs > source)
   * 3. Cap at maxFiles to avoid token overflow
   * 4. Truncate large files to previewLength
   */
  private async gatherRepoContext(owner: string, repo: string, branch: string): Promise<RepoContext> {
    const context: RepoContext = {
      keyFiles: [],
      techStack: [],
      fileCount: 0,
      hasDockerfile: false,
      hasRouteOrController: false,
    };

    if (!this.githubMCP) {
      return context;
    }

    const { maxFiles, previewLength, maxDepth, maxFilesPerDir } = ScribeAgent.REPO_SCAN_CONFIG;
    const readFiles: { path: string; content: string; priority: number }[] = [];

    // STEP 1: Discover repo structure
    await this.traceRecorder?.emitLog('info', 'Scanning root directory structure...');
    const rootListing = await this.listDirectorySafe(owner, repo, branch, '');

    if (rootListing) {
      const rootFiles = new Set(rootListing.filter(f => f.type === 'file').map(f => f.name));
      const rootDirs = new Set(rootListing.filter(f => f.type === 'dir').map(f => f.name));

      const projectType = this.detectProjectType(rootFiles, rootDirs);
      context.projectType = projectType;
      await this.traceRecorder?.emitLog('info', `Detected project type: ${projectType}`);
      this.traceRecorder?.recordInfo(`Detected project type: ${projectType}, root files: ${Array.from(rootFiles).slice(0, 10).join(', ')}`);

      // STEP 2: Build targeted file list from root
      const filesToRead: string[] = [];

      for (const name of rootFiles) {
        if (!this.shouldExcludeFile(name)) filesToRead.push(name);
      }

      // Detect Dockerfile
      if (rootFiles.has('Dockerfile') || rootFiles.has('docker-compose.yml') || rootFiles.has('docker-compose.yaml')) {
        context.hasDockerfile = true;
      }

      // STEP 3: Deep recursive scan for source directories
      const sourceDirs = ['src', 'lib', 'app', 'server', 'backend', 'frontend', 'api', 'routes', 'controllers', 'models', 'middleware', 'services'];
      const allDiscovered: { path: string; type: 'file' | 'dir' }[] = [];

      for (const dir of sourceDirs) {
        if (rootDirs.has(dir)) {
          await this.traceRecorder?.emitLog('info', `Scanning ${dir}/ recursively...`);
          await this.scanDirectoryRecursive(owner, repo, branch, dir, 0, maxDepth, allDiscovered);
        }
      }

      // Also scan docs/ recursively for .md files
      if (rootDirs.has('docs')) {
        await this.scanDirectoryRecursive(owner, repo, branch, 'docs', 0, 2, allDiscovered);
      }

      context.fileCount = rootFiles.size + allDiscovered.filter(f => f.type === 'file').length;

      // Analyze source structure
      context.sourceStructure = this.analyzeSourceStructure(allDiscovered);
      context.hasRouteOrController = context.sourceStructure.routes.length > 0 || context.sourceStructure.middleware.length > 0;

      // Add source files to read list (prioritized, capped per dir)
      const sourceExtensions = /\.(ts|js|tsx|jsx|py|go|rs|java|rb|php)$/i;
      const dirFileCounts = new Map<string, number>();

      for (const item of allDiscovered) {
        if (item.type !== 'file') continue;
        if (this.shouldExcludeFile(item.path)) continue;
        if (!sourceExtensions.test(item.path) && !/\.(md|json|ya?ml|toml)$/i.test(item.path)) continue;

        const dir = item.path.split('/').slice(0, -1).join('/');
        const count = dirFileCounts.get(dir) || 0;
        if (count >= maxFilesPerDir) continue;
        dirFileCounts.set(dir, count + 1);

        filesToRead.push(item.path);
      }

      // STEP 4: Read discovered files
      const uniquePaths = [...new Set(filesToRead)];
      uniquePaths.sort((a, b) => this.getFilePriority(a) - this.getFilePriority(b));

      for (const filePath of uniquePaths.slice(0, maxFiles)) {
        const fileData = await this.githubMCP.getFileContentSafe(owner, repo, branch, filePath);
        if (fileData) {
          readFiles.push({
            path: filePath,
            content: fileData.content,
            priority: this.getFilePriority(filePath),
          });
          await this.traceRecorder?.emitLog('info', `Reading ${filePath} (${fileData.content.length} bytes)`);
        }
      }
    } else {
      // Fallback: minimal targeted probes
      await this.traceRecorder?.emitLog('info', 'Root listing failed, using minimal probe fallback');

      const minimalPaths = [
        'README.md', 'package.json', 'server.js', 'index.js', 'app.js',
        'src/index.ts', 'src/App.tsx', 'src/main.tsx',
      ];

      for (const filePath of minimalPaths) {
        if (readFiles.length >= maxFiles) break;
        const fileData = await this.githubMCP.getFileContentSafe(owner, repo, branch, filePath);
        if (fileData) {
          readFiles.push({
            path: filePath,
            content: fileData.content,
            priority: this.getFilePriority(filePath),
          });
        }
      }
    }

    // Sort by priority and take top maxFiles
    readFiles.sort((a, b) => a.priority - b.priority);
    const topFiles = readFiles.slice(0, maxFiles);

    // Build context
    let totalBytes = 0;
    for (const file of topFiles) {
      const preview = file.content.length > previewLength
        ? file.content.substring(0, previewLength) + '\n... [truncated]'
        : file.content;

      context.keyFiles!.push({ path: file.path, preview });
      totalBytes += file.content.length;

      if (/package\.json$/i.test(file.path)) {
        this.detectTechStack(file.content, context);
      }
      if (/^LICENSE/i.test(file.path)) {
        this.detectLicense(file.content, context);
      }

      this.traceRecorder?.recordDocRead(file.path, file.content.length, preview.substring(0, 100));
    }

    await this.traceRecorder?.emitLog('info', `Context gathering complete: ${topFiles.length} files read, ${Math.round(totalBytes / 1024)}KB analyzed`);
    logger.debug(`[gatherRepoContext] Read ${topFiles.length} files for ${owner}/${repo}:${branch}`);

    return context;
  }

  /**
   * Detect tech stack from package.json content
   */
  private detectTechStack(content: string, context: RepoContext): void {
    try {
      const pkg = JSON.parse(content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      
      if (deps.react) context.techStack!.push('React');
      if (deps.vue) context.techStack!.push('Vue');
      if (deps.next) context.techStack!.push('Next.js');
      if (deps.nuxt) context.techStack!.push('Nuxt');
      if (deps.svelte) context.techStack!.push('Svelte');
      if (deps.fastify) context.techStack!.push('Fastify');
      if (deps.express) context.techStack!.push('Express');
      if (deps.koa) context.techStack!.push('Koa');
      if (deps.nestjs || deps['@nestjs/core']) context.techStack!.push('NestJS');
      if (deps.typescript) context.techStack!.push('TypeScript');
      if (deps.vite) context.techStack!.push('Vite');
      if (deps.tailwindcss) context.techStack!.push('Tailwind CSS');
      if (deps['drizzle-orm']) context.techStack!.push('Drizzle ORM');
      if (deps.prisma || deps['@prisma/client']) context.techStack!.push('Prisma');
      if (deps.zod) context.techStack!.push('Zod');
      if (deps.trpc || deps['@trpc/server']) context.techStack!.push('tRPC');
      if (deps.graphql || deps['apollo-server']) context.techStack!.push('GraphQL');
      if (deps.postgresql || deps.pg) context.techStack!.push('PostgreSQL');
      if (deps.mongodb || deps.mongoose) context.techStack!.push('MongoDB');
      if (deps.redis || deps.ioredis) context.techStack!.push('Redis');
      
      // Detect package manager
      if (pkg.packageManager?.includes('pnpm')) {
        context.packageManager = 'pnpm';
      } else if (pkg.packageManager?.includes('yarn')) {
        context.packageManager = 'yarn';
      } else {
        context.packageManager = 'npm';
      }

      // Remove duplicates
      context.techStack = [...new Set(context.techStack)];
    } catch {
      // JSON parse failed, skip
    }
  }

  /**
   * Detect license type from LICENSE file content
   */
  private detectLicense(content: string, context: RepoContext): void {
    const lowerContent = content.toLowerCase();
    if (lowerContent.includes('mit license')) context.license = 'MIT';
    else if (lowerContent.includes('apache license')) context.license = 'Apache-2.0';
    else if (lowerContent.includes('gnu general public license') || lowerContent.includes('gpl')) context.license = 'GPL';
    else if (lowerContent.includes('isc license')) context.license = 'ISC';
    else if (lowerContent.includes('bsd')) context.license = 'BSD';
    else if (lowerContent.includes('mozilla public license')) context.license = 'MPL-2.0';
    else context.license = 'See LICENSE file';
  }

  /**
   * Plan execution steps
   */
  async plan(planner: Planner, context: unknown): Promise<Plan> {
    if (!this.isValidContext(context)) {
      throw new Error('ScribeAgent requires valid ScribeTaskContext');
    }
    const task = context as ScribeTaskContext;

    return planner.plan({
      agent: this.type,
      goal: task.taskDescription || `Update documentation in ${task.targetPath || 'README.md'}`,
      context: task
    });
  }

  /**
   * Execute Scribe workflow with tools and plan
   * S1.1: Enhanced with explainability tracing
   */
  async executeWithTools(_tools: MCPTools, plan?: Plan, context?: unknown): Promise<unknown> {
    // Note: We use this.githubMCP injected via constructor to ensure we have the token-aware instance
    // _tools might contain the global generic tools
    
    if (!this.isValidContext(context)) {
      throw new Error('ScribeAgent requires valid ScribeTaskContext');
    }
    const task = context as ScribeTaskContext;
    const dryRun = task.dryRun === true;

    if (task.skill) {
      return {
        ok: true,
        agent: 'scribe-v2',
        mode: 'contract-first-doc-specialist',
        skill: task.skill,
        skillResult: runScribeSkill(task.skill, task.skillInput ?? {}),
        targetsProduced: [],
        documentsRead: 0,
        filesProduced: 0,
      };
    }

    // Resolve doc pack configuration with defaults
    let docPackConfig: ResolvedDocPackConfig = resolveDocPackConfig({
      docPack: task.docPack,
      docDepth: task.docDepth,
      outputTargets: task.outputTargets,
      maxOutputTokens: task.maxOutputTokens,
      passes: task.passes,
    });

    // S1.1: Record initial reasoning
    this.traceRecorder?.recordReasoning({
      phase: 'initialization',
      summary: `Starting Scribe workflow for ${task.owner}/${task.repo}. ` +
               `Target: ${task.targetPath || 'README.md'}. ` +
               `Doc Pack: ${docPackConfig.docPack}, Depth: ${docPackConfig.docDepth}, Passes: ${docPackConfig.passes}. ` +
               `Targets: ${docPackConfig.outputTargets.join(', ')}. ` +
               `Mode: ${dryRun ? 'dry-run (no changes will be written)' : 'execute (changes will be written)'}.`,
    });

    if (!this.githubMCP) {
      throw new Error(
        'GitHubMCPService not injected into ScribeAgent. ' +
        'This usually means: 1) GitHub OAuth is not connected for this user, or ' +
        '2) GITHUB_MCP_BASE_URL is not configured. ' +
        'Please connect GitHub at /agents/scribe or check your environment configuration.'
      );
    }
    if (!this.aiService) {
      throw new Error(
        'AIService not injected into ScribeAgent. ' +
        'This usually means AI provider is not configured. ' +
        'Please check AI_PROVIDER and related environment variables.'
      );
    }

    const results: Record<string, unknown> = { plan, docPackConfig };

    // Step 1: Branch Management
    this.traceRecorder?.recordPlanStep({
      stepId: 'branch-management',
      title: 'Branch Management',
      description: 'Determine working branch for documentation updates',
      reasoning: dryRun 
        ? 'In dry-run mode, we simulate branch operations without making changes.'
        : 'Creating or using an existing feature branch to isolate documentation changes.',
      status: 'running',
    });

    const baseBranch = task.baseBranch;
    let workingBranch =
      task.featureBranch && task.featureBranch.length > 0 ? task.featureBranch : baseBranch;

    // Config-driven branch creation when featureBranch is not explicitly provided
    // PR-2: Properly interpolate all template placeholders
    if (!dryRun && (!task.featureBranch || task.featureBranch === baseBranch)) {
      const pattern = task.branchPattern || 'docs/scribe-{timestamp}';
      const ts = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\..+$/, '')
        .replace('T', '-'); // YYYYMMDD-HHMMSS
      
      // Replace all supported placeholders
      workingBranch = pattern
        .replace('{timestamp}', ts)
        .replace('{agent}', 'scribe')  // PR-2: Interpolate agent type
        .replace('{date}', ts.split('-')[0]); // YYYYMMDD format for {date}
    }

        results.branch = workingBranch;

    // Create branch if needed (best-effort, idempotent)
    if (!dryRun && workingBranch !== baseBranch) {
      const branchStartTime = Date.now();
      try {
        this.traceRecorder?.recordToolCall({
          toolName: 'github.createBranch',
          asked: `Create branch "${workingBranch}" from "${baseBranch}"`,
          did: 'Calling GitHub API to create a new branch for documentation changes',
          why: 'Creating a separate branch ensures the base branch remains unchanged until changes are reviewed.',
          inputSummary: `owner: ${task.owner}, repo: ${task.repo}, branch: ${workingBranch}, base: ${baseBranch}`,
          success: true,
          durationMs: Date.now() - branchStartTime,
        });
        await this.githubMCP.createBranch(task.owner, task.repo, workingBranch, baseBranch);
        results.branchCreated = true;
        
        this.traceRecorder?.recordDecision({
          title: 'Branch created successfully',
          decision: `Created new branch "${workingBranch}"`,
          reasoning: 'The branch was created successfully and will be used for all subsequent operations.',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // GitHub returns a "reference already exists" error if branch exists; treat as OK.
        if (msg.toLowerCase().includes('already exists')) {
          results.branchCreated = false;
          this.traceRecorder?.recordDecision({
            title: 'Branch already exists',
            decision: `Using existing branch "${workingBranch}"`,
            reasoning: 'The branch already existed, which is acceptable. We will use it for documentation updates.',
          });
        } else {
          throw e;
        }
      }
    }

    this.traceRecorder?.recordPlanStep({
      stepId: 'branch-management',
      title: 'Branch Management',
      description: `Working branch: ${workingBranch}`,
      reasoning: dryRun ? 'Dry-run: no branch changes made' : `Branch ${results.branchCreated ? 'created' : 'exists'}`,
      status: 'completed',
    });

    // Step 2: Gather Repository Context FIRST (enables auto-detection)
    this.traceRecorder?.recordPlanStep({
      stepId: 'gather-context',
      title: 'Gather Repository Context',
      description: 'Deep scanning repository for documentation evidence',
      reasoning: 'Grounded documentation requires reading actual repository files. Deep scan enables auto-detection of required docs.',
      status: 'running',
    });

    const repoContext = await this.gatherRepoContext(task.owner, task.repo, baseBranch);

    this.traceRecorder?.recordPlanStep({
      stepId: 'gather-context',
      title: 'Gather Repository Context',
      description: `Gathered context from ${repoContext.keyFiles?.length || 0} key files (${repoContext.fileCount || 0} total discovered)`,
      reasoning: `Found: ${repoContext.techStack?.join(', ') || 'unknown stack'}, ${repoContext.packageManager || 'unknown'} package manager`,
      status: 'completed',
    });

    // Auto-detect docPack if not explicitly set
    if (!task.docPack) {
      const detectedPack = this.detectRequiredDocuments(repoContext);
      if (detectedPack !== 'readme') {
        docPackConfig = resolveDocPackConfig({
          docPack: detectedPack,
          docDepth: task.docDepth,
          maxOutputTokens: task.maxOutputTokens,
          passes: task.passes,
        });

        this.traceRecorder?.recordDecision({
          title: 'Auto-detected doc pack level',
          decision: `Upgraded to "${detectedPack}" based on repo analysis`,
          reasoning: `Repository has ${repoContext.fileCount || 0} files. Routes: ${repoContext.sourceStructure?.routes.length || 0}, Models: ${repoContext.sourceStructure?.models.length || 0}. Dockerfile: ${repoContext.hasDockerfile ? 'yes' : 'no'}.`,
        });

        await this.traceRecorder?.emitLog('info', `Auto-detected doc pack: ${detectedPack} (${docPackConfig.outputTargets.length} targets)`);
      }
    }

    // Step 3: Repo Scan & Scope Lock (contract-first playbook)
    const targetPath = task.targetPath || 'README.md';
    const isDirectory = targetPath.endsWith('/');

    this.traceRecorder?.recordPlanStep({
      stepId: 'repo-scan',
      title: 'Resolve Documentation Targets',
      description: `Resolving targets for: ${targetPath}`,
      reasoning: isDirectory
        ? 'Target is a directory. Will discover existing documentation files and select appropriate targets based on the task.'
        : docPackConfig.outputTargets.length > 1
          ? `Doc pack "${docPackConfig.docPack}" with ${docPackConfig.outputTargets.length} target(s)`
          : 'Target is a specific file. Will read existing content and apply documentation contract.',
      status: 'running',
    });

    // Discover file targets
    const fileTargets: DocFileTarget[] = [];

    // Use doc pack targets when available (explicit or auto-detected)
    if (docPackConfig.outputTargets.length > 0) {
      this.traceRecorder?.recordDecision({
        title: 'Doc Pack mode active',
        decision: `Using doc pack "${docPackConfig.docPack}" with ${docPackConfig.outputTargets.length} target(s)`,
        reasoning: `Pack configuration overrides filesystem discovery. Targets: ${docPackConfig.outputTargets.join(', ')}`,
      });

      for (const target of docPackConfig.outputTargets) {
        const filePath = targetToPath(target);
        const fileData = await this.githubMCP.getFileContentSafe(task.owner, task.repo, workingBranch, filePath);
        const contract = getContractForPath(filePath);
        fileTargets.push({
          path: filePath,
          existingContent: fileData?.content || '',
          contract,
          priority: docPackConfig.outputTargets.indexOf(target) + 1,
        });
      }
    } else if (isDirectory) {
      // Multi-file mode: scan directory for doc files
      this.traceRecorder?.recordDecision({
        title: 'Multi-file documentation mode',
        decision: `Scanning directory "${targetPath}" for documentation files`,
        reasoning: 'When target is a directory, Scribe v2 can update multiple related documentation files in a single operation.',
      });

      // Common doc file patterns in docs/ directory
      const candidatePaths = [
        'docs/README.md',
        'docs/DEV_SETUP.md',
        'docs/CONTRIBUTING.md',
        'docs/ARCHITECTURE.md',
        'docs/API.md',
      ];

      for (const candidatePath of candidatePaths) {
        // Use safe read to avoid ERROR spam for expected missing files
        const fileData = await this.githubMCP.getFileContentSafe(task.owner, task.repo, workingBranch, candidatePath);
        if (fileData) {
          const contract = getContractForPath(candidatePath);
          fileTargets.push({
            path: candidatePath,
            existingContent: fileData.content,
            contract,
            priority: candidatePath.includes('README') ? 1 : 2,
          });
          this.traceRecorder?.recordDocRead(candidatePath, fileData.content.length, fileData.content.substring(0, 200));
        }
        // If file doesn't exist, silently skip (no error log)
      }

      // If no files found, select a default target
      if (fileTargets.length === 0) {
        const defaultPath = 'docs/README.md';
        const contract = getContractForPath(defaultPath);
        fileTargets.push({
          path: defaultPath,
          existingContent: '',
          contract,
          priority: 1,
        });
        this.traceRecorder?.recordDecision({
          title: 'No existing docs found',
          decision: `Will create new file: ${defaultPath}`,
          reasoning: 'No documentation files exist in the target directory. Creating a new README as the primary documentation entry point.',
        });
      }
    } else {
      // Single-file mode
    let currentContent = '';
      let fileMissing = false;
      const readStartTime = Date.now();
      
      // Use safe read to avoid ERROR spam for expected missing files
      const fileData = await this.githubMCP.getFileContentSafe(task.owner, task.repo, workingBranch, targetPath);
      
      if (fileData) {
        this.traceRecorder?.recordToolCall({
          toolName: 'github.getFileContent',
          asked: `Read the contents of "${targetPath}" from branch "${workingBranch}"`,
          did: 'Calling GitHub API to retrieve file contents',
          why: 'Reading existing content to understand current documentation structure and maintain consistency.',
          inputSummary: `owner: ${task.owner}, repo: ${task.repo}, branch: ${workingBranch}, path: ${targetPath}`,
          success: true,
          durationMs: Date.now() - readStartTime,
        });
        currentContent = fileData.content;
        this.traceRecorder?.recordDocRead(targetPath, currentContent.length, currentContent.substring(0, 200));
      } else {
        fileMissing = true;
        this.traceRecorder?.recordDecision({
          title: 'File not found',
          decision: `Will create new file "${targetPath}"`,
          reasoning: 'The target file does not exist. We will create it following the appropriate documentation contract.',
        });
      }

      const contract = getContractForPath(targetPath);
      fileTargets.push({
        path: targetPath,
        existingContent: currentContent,
        contract,
        priority: 1,
      });
      
      results.fileMissing = fileMissing;
    }

    // Sort by priority (lower number = higher priority)
    fileTargets.sort((a, b) => a.priority - b.priority);
    
    this.traceRecorder?.recordPlanStep({
      stepId: 'repo-scan',
      title: 'Repository Scan',
      description: `Found ${fileTargets.length} documentation target(s)`,
      reasoning: `Identified ${fileTargets.length} file(s) for documentation updates: ${fileTargets.map(f => f.path).join(', ')}`,
      status: 'completed',
    });

    this.traceRecorder?.recordDecision({
      title: 'Scope Locked',
      decision: `Will update ${fileTargets.length} file(s): ${fileTargets.map(f => f.path).join(', ')}`,
      reasoning: `Selected files based on task requirements and documentation contracts. Priority order: ${fileTargets.map(f => `${f.path} (priority ${f.priority})`).join(', ')}`,
    });

    // Step 4: Generate contract-compliant content for each target
    this.traceRecorder?.recordPlanStep({
      stepId: 'generate-content',
      title: 'Generate Documentation',
      description: `Generating repo-grounded content for ${fileTargets.length} file(s)`,
      reasoning: 'Using documentation contracts + repository evidence to ensure accurate, non-hallucinated content.',
      status: 'running',
    });

    const updatedFiles: Array<{ path: string; content: string; linesAdded: number }> = [];
    const perFileTokenBudget = Math.floor(docPackConfig.maxOutputTokens / Math.max(fileTargets.length, 1));

    for (const target of fileTargets) {
      const docType = detectDocFileType(target.path);
      
      this.traceRecorder?.recordReasoning({
        phase: 'generation',
        summary: `Generating ${docType} documentation for ${target.path}. ` +
                 `Contract requires ${target.contract.sections.filter(s => s.required).length} mandatory sections. ` +
                 `Using ${repoContext.keyFiles?.length || 0} repo files as evidence. ` +
                 `${target.existingContent ? `Existing content: ${target.existingContent.length} bytes.` : 'Creating new file.'}`,
      });

      // Build contract-driven prompt WITH repo context
      const contractPrompt = buildContractPrompt(
        target.contract,
        target.existingContent,
        task.taskDescription || `Update ${target.path} with comprehensive documentation`,
        repoContext
      );

      // Call AI with contract-compliant, repo-grounded prompt
      const genStartTime = Date.now();
      this.traceRecorder?.recordToolCall({
        toolName: 'ai.generate',
        asked: `Generate repo-grounded ${docType} documentation for ${target.path}`,
        did: 'Calling AI service with documentation contract + repository evidence',
        why: `Using structured contract + actual repo files ensures accurate documentation with no hallucination.`,
        inputSummary: `docType: ${docType}, existingLength: ${target.existingContent.length} bytes, repoFiles: ${repoContext.keyFiles?.length || 0}, requiredSections: ${target.contract.sections.filter(s => s.required).map(s => s.name).join(', ')}`,
        success: true,
        durationMs: Date.now() - genStartTime,
      });

      // Generate content using AI with depth-aware token budget
      await this.traceRecorder?.emitLog('info', `Generating ${target.path} (${fileTargets.indexOf(target) + 1}/${fileTargets.length})...`);
      const aiResult = await this.aiService.generateWorkArtifact({
        task: contractPrompt,
        context: { ...task, filePath: target.path, docType },
        maxTokens: perFileTokenBudget,
        systemPrompt: SCRIBE_GENERATE_SYSTEM_PROMPT,
      });
      const newContent = aiResult.content;

      const linesAdded = newContent.split('\n').length - target.existingContent.split('\n').length;
      await this.traceRecorder?.emitLog('info', `Generated ${target.path}: ${newContent.split('\n').length} lines`);

      updatedFiles.push({
        path: target.path,
        content: newContent,
        linesAdded,
      });

      this.traceRecorder?.recordDecision({
        title: `Content generated for ${target.path}`,
        decision: `Generated ${newContent.length} bytes (${linesAdded > 0 ? '+' : ''}${linesAdded} lines)`,
        reasoning: `Successfully generated repo-grounded ${docType} documentation using ${repoContext.keyFiles?.length || 0} source files.`,
      });
    }
    
    this.traceRecorder?.recordPlanStep({
      stepId: 'generate-content',
      title: 'Generate Documentation',
      description: `Generated content for ${updatedFiles.length} file(s)`,
      reasoning: `All files generated successfully following their respective documentation contracts.`,
      status: 'completed',
    });

    // Step 3b: Pass-2 Review (only for multi-pass configurations)
    if (docPackConfig.passes === 2 && updatedFiles.length > 1) {
      this.traceRecorder?.recordPlanStep({
        stepId: 'pass2-review',
        title: 'Pass 2: Cross-Document Review',
        description: `Reviewing ${updatedFiles.length} documents for gaps and cross-links`,
        reasoning: 'Multi-pass mode reviews all generated docs together to ensure consistency, cross-links, and completeness.',
        status: 'running',
      });

      const allDocsContext = updatedFiles
        .map(f => `## ${f.path}\n${f.content.substring(0, 2000)}`)
        .join('\n\n---\n\n');

      const reviewPrompt = `You are reviewing a documentation pack for consistency and completeness.

Documents generated:
${allDocsContext}

Review for:
1. Missing cross-links between documents (e.g., README should link to docs/*)
2. Inconsistent terminology or project descriptions
3. Gaps in coverage (e.g., mentioned but not documented topics)
4. Missing table of contents or navigation

Output a JSON array of issues. Each issue: { "file": "path", "issue": "description", "severity": "low"|"medium"|"high" }
If no issues, output: []`;

      try {
        const reviewResult = await this.aiService.generateWorkArtifact({
          task: reviewPrompt,
          context: { ...task, phase: 'pass2-review' },
        });

        this.traceRecorder?.recordReasoning({
          phase: 'pass2-review',
          summary: `Pass 2 review completed. Result preview: ${reviewResult.content.substring(0, 200)}`,
        });
      } catch (reviewError) {
        this.traceRecorder?.recordInfo(
          `Pass 2 review skipped due to error: ${reviewError instanceof Error ? reviewError.message : String(reviewError)}`
        );
      }

      this.traceRecorder?.recordPlanStep({
        stepId: 'pass2-review',
        title: 'Pass 2: Cross-Document Review',
        description: 'Review complete',
        reasoning: 'Cross-document consistency check finished.',
        status: 'completed',
      });
    }

    // Safety truncation fallback (AI call already respects perFileTokenBudget)
    const safetyCharLimit = perFileTokenBudget * 4;
    for (const file of updatedFiles) {
      if (file.content.length > safetyCharLimit) {
        file.content = file.content.substring(0, safetyCharLimit) + '\n\n<!-- Content truncated: exceeded token budget -->';
        this.traceRecorder?.recordInfo(`Safety truncated ${file.path} to ~${perFileTokenBudget} tokens`);
      }
    }

    // Step 4: Reflect (Critique before commit) - review all generated files
    this.traceRecorder?.recordPlanStep({
      stepId: 'reflect-critique',
      title: 'AI Review',
      description: `Reviewing ${updatedFiles.length} generated file(s)`,
      reasoning: 'AI review ensures documentation quality, verifies contract compliance, and catches potential issues before commit.',
      status: 'running',
    });

    const critiques = [];
    for (const file of updatedFiles) {
      await this.traceRecorder?.emitLog('info', `Reviewing ${file.path} for quality...`);
      const critiqueStartTime = Date.now();
      this.traceRecorder?.recordToolCall({
        toolName: 'ai.critique',
        asked: `Review the generated documentation for ${file.path}`,
        did: 'Calling AI service to critique the documentation',
        why: 'Pre-commit review ensures high-quality, accurate documentation and contract compliance.',
        inputSummary: `file: ${file.path}, length: ${file.content.length} bytes`,
        success: true,
        durationMs: Date.now() - critiqueStartTime,
      });

    const critique = await this.aiService.reflector.critique({
        artifact: file.content,
        context: { ...task, filePath: file.path }
      });
      
      critiques.push({ path: file.path, critique });
      await this.traceRecorder?.emitLog('info', `Review complete for ${file.path}: ${critique.issues?.length || 0} issue(s)`);

      this.traceRecorder?.recordReasoning({
        phase: 'review',
        summary: critique.issues && critique.issues.length > 0
          ? `${file.path}: Found ${critique.issues.length} issue(s) to consider. ${critique.issues.join('; ')}`
          : `${file.path}: Quality verified, no issues found.`,
        stepId: 'reflect-critique',
      });
    }
    
    results.critiques = critiques;
    const totalIssues = critiques.reduce((sum, c) => sum + (c.critique.issues?.length || 0), 0);
    const targetsProduced = updatedFiles.map((file) => file.path);
    const documentsRead = repoContext.keyFiles?.length || 0;
    const filesProduced = updatedFiles.length;

    this.traceRecorder?.recordPlanStep({
      stepId: 'reflect-critique',
      title: 'AI Review',
      description: totalIssues > 0 ? `Found ${totalIssues} total issue(s) across ${updatedFiles.length} file(s)` : 'All files passed review',
      reasoning: 'Review complete. Proceeding with commit.',
      status: 'completed',
    });

    // Step 5: Commit (skip in dryRun) - commit all updated files
    if (dryRun) {
      this.traceRecorder?.recordDecision({
        title: 'Dry-run mode: Skipping commit',
        decision: `No changes written to GitHub (${updatedFiles.length} file(s) prepared)`,
        reasoning: 'In dry-run mode, we simulate the workflow without making actual changes. This allows testing the contract-first workflow safely.',
      });

      // S2.1: Record preview artifacts for dryRun visibility in Job Details UI
      for (const file of updatedFiles) {
        this.traceRecorder?.recordFilePreview({
          path: file.path,
          sizeBytes: file.content.length,
          // Provide a safe preview (first 500 chars, no secrets)
          preview: file.content.substring(0, 500),
          linesAdded: file.linesAdded,
          diffPreview: file.linesAdded > 0 
            ? `+${file.linesAdded} lines (new content)` 
            : 'Content generated',
        });
      }

      results.dryRun = true;
      results.preview = {
        branch: workingBranch,
        files: updatedFiles.map(f => ({
          path: f.path,
          contentLength: f.content.length,
          linesAdded: f.linesAdded,
        })),
        commitMessage: updatedFiles.length === 1 
          ? `docs: update ${updatedFiles[0].path} via Scribe v2`
          : `docs: update ${updatedFiles.length} files via Scribe v2`,
      };

      this.traceRecorder?.recordReasoning({
        phase: 'completion',
        summary: `Dry-run completed successfully. Would have updated ${updatedFiles.length} file(s) on branch ${workingBranch}: ${updatedFiles.map(f => `${f.path} (${f.content.length} bytes)`).join(', ')}`,
      });

      return {
        ok: true,
        agent: 'scribe-v2',
        mode: 'contract-first-doc-specialist',
        filesUpdated: updatedFiles.length,
        targetsProduced,
        documentsRead,
        filesProduced,
        ...results,
        diagnostics: {
          mode: 'dry-run',
          operations: updatedFiles.map(f => ({
            file: f.path,
            bytes: f.content.length,
            linesChanged: f.linesAdded,
          })),
          targets: updatedFiles.map(f => f.path),
        },
      };
    }

    this.traceRecorder?.recordPlanStep({
      stepId: 'commit-changes',
      title: 'Commit Changes',
      description: `Committing ${updatedFiles.length} file(s)`,
      reasoning: 'Persisting all documentation changes to the repository in a logical commit.',
      status: 'running',
    });

    const commits = [];
    for (const file of updatedFiles) {
      await this.traceRecorder?.emitLog('info', `Committing ${file.path} to ${workingBranch}...`);
      const commitStartTime = Date.now();
      this.traceRecorder?.recordToolCall({
        toolName: 'github.commitFile',
        asked: `Commit updated content to "${file.path}" on branch "${workingBranch}"`,
        did: 'Calling GitHub API to create a commit with the updated file',
        why: 'Each file is committed to preserve the documentation updates in version control.',
        inputSummary: `path: ${file.path}, branch: ${workingBranch}, size: ${file.content.length} bytes`,
        success: true,
        durationMs: Date.now() - commitStartTime,
      });

    const commitResult = await this.githubMCP.commitFile(
      task.owner,
      task.repo,
      workingBranch,
        file.path,
        file.content,
        updatedFiles.length === 1
          ? `docs: update ${file.path} via Scribe v2`
          : `docs: update ${file.path} (part of ${updatedFiles.length}-file doc set)`
      );
      
      commits.push({ path: file.path, commit: commitResult });

      // Record file modification with diff preview
      this.traceRecorder?.recordFileModified({
        path: file.path,
        sizeBytes: file.content.length,
        preview: file.content.substring(0, 500),
        linesAdded: file.linesAdded,
        diffPreview: file.linesAdded > 0 ? `+${file.linesAdded} lines` : `${file.linesAdded} lines modified`,
      });

      this.traceRecorder?.recordDecision({
        title: `Committed ${file.path}`,
        decision: `File successfully committed to ${workingBranch}`,
        reasoning: `Documentation update persisted: ${file.content.length} bytes, ${file.linesAdded > 0 ? '+' : ''}${file.linesAdded} lines.`,
      });
    }

    results.commits = commits;

    this.traceRecorder?.recordPlanStep({
      stepId: 'commit-changes',
      title: 'Commit Changes',
      description: `Successfully committed ${commits.length} file(s)`,
      reasoning: `All documentation updates are now saved in the repository on branch ${workingBranch}.`,
      status: 'completed',
    });

    // Step 6: Create PR (only if workingBranch differs from baseBranch)
    if (workingBranch !== baseBranch) {
      this.traceRecorder?.recordPlanStep({
        stepId: 'create-pr',
        title: 'Create Pull Request',
        description: `Opening PR from ${workingBranch} to ${baseBranch}`,
        reasoning: 'Creating a pull request enables team review before merging documentation changes.',
        status: 'running',
      });

      // Build PR title and body with file summaries
      const titleTemplate = task.prTitleTemplate || 
        (updatedFiles.length === 1 ? `docs: update ${updatedFiles[0].path}` : `docs: update ${updatedFiles.length} documentation files`);
      
      const bodyTemplate = task.prBodyTemplate || 
        `Automated documentation update via Scribe v2 (contract-first Doc Specialist).\n\n` +
        `## Files Updated (${updatedFiles.length})\n` +
        updatedFiles.map(f => `- \`${f.path}\` (${f.linesAdded > 0 ? '+' : ''}${f.linesAdded} lines)`).join('\n') +
        `\n\n## Task\n${task.taskDescription || 'Documentation update'}\n\n` +
        `Branch: \`${workingBranch}\` → \`${baseBranch}\`\n` +
        `Generated: ${new Date().toISOString()}`;

      const templatePath =
        typeof task.targetPath === 'string' && task.targetPath.length > 0
          ? task.targetPath
          : updatedFiles.length === 1
            ? updatedFiles[0].path
            : 'docs/';

      // Generate a safe summary from taskDescription (first 50 chars, sanitized)
      const safeSummary = (task.taskDescription || `update ${templatePath}`)
        .replace(/[^a-zA-Z0-9\s\-_]/g, '')
        .substring(0, 50)
        .trim() || `update ${templatePath}`;

      const prTitle = titleTemplate
        .replace('{timestamp}', new Date().toISOString())
        .replace('{branch}', workingBranch)
        .replace('{path}', templatePath)
        .replace('{agent}', 'scribe')
        .replace('{summary}', safeSummary)
        .replace('{count}', String(updatedFiles.length));

      const prBody = bodyTemplate
        .replace('{timestamp}', new Date().toISOString())
        .replace('{branch}', workingBranch)
        .replace('{path}', templatePath)
        .replace('{agent}', 'scribe')
        .replace('{summary}', safeSummary)
        .replace('{count}', String(updatedFiles.length));

      const prStartTime = Date.now();
      this.traceRecorder?.recordToolCall({
        toolName: 'github.createPRDraft',
        asked: `Create a draft pull request for ${updatedFiles.length} documentation file(s)`,
        did: 'Calling GitHub API to create a draft pull request',
        why: 'A draft PR allows team members to review the documentation changes before they are merged.',
        inputSummary: `title: "${prTitle}", head: ${workingBranch}, base: ${baseBranch}`,
        success: true,
        durationMs: Date.now() - prStartTime,
      });

      const pr = await this.githubMCP.createPRDraft(
        task.owner,
        task.repo,
        prTitle,
        prBody,
        workingBranch,
        baseBranch
      );

      results.pullRequest = pr;

      this.traceRecorder?.recordPlanStep({
        stepId: 'create-pr',
        title: 'Create Pull Request',
        description: `PR created: ${pr.url || 'success'}`,
        reasoning: 'Pull request is ready for team review.',
        status: 'completed',
      });
    }

    const prUrl = results.pullRequest && typeof results.pullRequest === 'object' && 'url' in results.pullRequest 
      ? (results.pullRequest as { url: string }).url 
      : null;
    
    this.traceRecorder?.recordReasoning({
      phase: 'completion',
      summary: `Scribe v2 workflow completed successfully. Updated ${updatedFiles.length} file(s) (${updatedFiles.map(f => f.path).join(', ')}) on branch ${workingBranch}. ` +
               (prUrl ? `Pull request created for review: ${prUrl}` : 'Changes committed directly.'),
    });

    return {
      ok: true,
      agent: 'scribe-v2',
      mode: 'contract-first-doc-specialist',
      filesUpdated: updatedFiles.length,
      targetsProduced,
      documentsRead,
      filesProduced,
      ...results,
      diagnostics: {
        mode: dryRun ? 'dry-run' : 'execute',
        operations: updatedFiles.map(f => ({
          file: f.path,
          bytes: f.content.length,
          linesChanged: f.linesAdded,
        })),
        targets: updatedFiles.map(f => f.path),
      },
    };
  }

  /**
   * Default execute implementation (required by BaseAgent)
   * Delegates to executeWithTools with empty tools/plan if called directly
   */
  async execute(context: unknown): Promise<unknown> {
    return this.executeWithTools({}, undefined, context);
  }

  private isValidContext(context: unknown): boolean {
    if (!context || typeof context !== 'object') return false;
    const c = context as Record<string, unknown>;
    return (
      typeof c.owner === 'string' &&
      typeof c.repo === 'string' &&
      typeof c.baseBranch === 'string'
    );
  }
}
