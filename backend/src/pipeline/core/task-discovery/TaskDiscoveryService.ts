import type { AIServiceLike } from '../pipeline-factory.js';
import type {
  DiscoveredTask,
  TaskDiscoveryInput,
  TaskDiscoveryOutput,
} from './TaskDiscoveryTypes.js';
import { DISCOVER_TASKS_SYSTEM_PROMPT } from './prompts/discover-tasks.js';
import { parseAIJson } from '../json-extract.js';

const DEFAULT_MAX_TASKS = 10;
const HARD_MAX_TASKS = 20;

interface RepoHealth {
  hasTests: boolean;
  hasCI: boolean;
  hasDocs: boolean;
  hasLinting: boolean;
  codeQualityScore: number;
}

export class TaskDiscoveryService {
  private readonly aiService: AIServiceLike;

  constructor(deps: { aiService: AIServiceLike }) {
    this.aiService = deps.aiService;
  }

  async discoverTasks(input: TaskDiscoveryInput): Promise<TaskDiscoveryOutput> {
    const startTime = Date.now();
    const maxTasks = Math.min(input.maxTasks ?? DEFAULT_MAX_TASKS, HARD_MAX_TASKS);
    const repoHealth = this.calculateRepoHealth(input.repoContext.files);
    const prompt = this.buildPrompt(input, maxTasks);

    let tasks: DiscoveredTask[] = [];
    let suggestedPlan = '';

    try {
      const result = await this.aiService.generateWorkArtifact({
        systemPrompt: DISCOVER_TASKS_SYSTEM_PROMPT,
        task: prompt,
        maxTokens: 4096,
      });

      const parsed = parseAIJson<{ tasks: DiscoveredTask[]; suggestedPlan: string }>(
        result.content,
      );

      tasks = this.validateAndTrimTasks(parsed.tasks ?? [], maxTasks);
      suggestedPlan = parsed.suggestedPlan ?? '';
    } catch {
      tasks = [];
      suggestedPlan = 'Analysis could not be completed due to an AI service error.';
    }

    return {
      tasks,
      repoHealth,
      suggestedPlan,
      analysisTime: Date.now() - startTime,
    };
  }

  private buildPrompt(input: TaskDiscoveryInput, maxTasks: number): string {
    const parts: string[] = [];

    parts.push(`Repository: ${input.repoContext.owner}/${input.repoContext.repo}`);
    parts.push(`Maximum tasks to return: ${maxTasks}`);

    if (input.userHint) {
      parts.push(`\nUser hint: ${input.userHint}`);
    }

    if (input.repoContext.readme) {
      parts.push(`\nREADME:\n${input.repoContext.readme}`);
    }

    if (input.repoContext.packageJson) {
      parts.push(`\npackage.json:\n${JSON.stringify(input.repoContext.packageJson, null, 2)}`);
    }

    if (input.repoContext.files.length > 0) {
      parts.push('\nFile listing:');
      for (const file of input.repoContext.files) {
        if (file.content) {
          parts.push(`\n--- ${file.path} ---\n${file.content}`);
        } else {
          parts.push(`- ${file.path}`);
        }
      }
    }

    if (input.repoContext.recentCommits && input.repoContext.recentCommits.length > 0) {
      parts.push(`\nRecent commits:\n${input.repoContext.recentCommits.join('\n')}`);
    }

    return parts.join('\n');
  }

  private validateAndTrimTasks(tasks: unknown[], maxTasks: number): DiscoveredTask[] {
    if (!Array.isArray(tasks)) return [];

    const validCategories = new Set(['bug', 'feature', 'docs', 'security', 'test', 'refactor']);
    const validPriorities = new Set(['critical', 'high', 'medium', 'low']);
    const validComplexities = new Set(['simple', 'moderate', 'complex']);

    const validated: DiscoveredTask[] = [];

    for (const task of tasks) {
      if (validated.length >= maxTasks) break;
      if (!task || typeof task !== 'object') continue;

      const t = task as Record<string, unknown>;
      if (
        typeof t.id === 'string' &&
        typeof t.title === 'string' &&
        typeof t.description === 'string' &&
        typeof t.category === 'string' &&
        validCategories.has(t.category) &&
        typeof t.priority === 'string' &&
        validPriorities.has(t.priority) &&
        typeof t.estimatedMinutes === 'number' &&
        Array.isArray(t.affectedFiles) &&
        typeof t.complexity === 'string' &&
        validComplexities.has(t.complexity) &&
        typeof t.rationale === 'string'
      ) {
        validated.push(t as unknown as DiscoveredTask);
      }
    }

    return validated;
  }

  calculateRepoHealth(files: Array<{ path: string; content?: string }>): RepoHealth {
    const paths = files.map((f) => f.path.toLowerCase());

    const hasTests = paths.some(
      (p) =>
        p.includes('test') ||
        p.includes('spec') ||
        p.includes('__tests__') ||
        p.endsWith('.test.ts') ||
        p.endsWith('.test.js') ||
        p.endsWith('.spec.ts') ||
        p.endsWith('.spec.js'),
    );

    const hasCI = paths.some(
      (p) =>
        p.includes('.github/workflows') ||
        p.includes('.gitlab-ci') ||
        p.includes('jenkinsfile') ||
        p.includes('.circleci') ||
        p.includes('.travis.yml'),
    );

    const hasDocs = paths.some(
      (p) =>
        p === 'readme.md' ||
        p === 'readme.txt' ||
        p === 'readme' ||
        p.startsWith('docs/') ||
        p.includes('/docs/'),
    );

    const hasLinting = paths.some(
      (p) =>
        p.includes('.eslintrc') ||
        p.includes('eslint.config') ||
        p.includes('.prettierrc') ||
        p.includes('prettier.config') ||
        p.includes('biome.json') ||
        p.includes('.stylelintrc'),
    );

    let score = 40; // base score
    if (hasTests) score += 20;
    if (hasCI) score += 15;
    if (hasDocs) score += 15;
    if (hasLinting) score += 10;

    return { hasTests, hasCI, hasDocs, hasLinting, codeQualityScore: score };
  }
}
