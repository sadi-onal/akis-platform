/**
 * Skill system entry point.
 *
 * Call `initSkills()` once at server startup. After that, agents can use
 * `getSkillRegistry()` synchronously.
 *
 * `resetSkillsForTesting()` clears the cached instances — test-only.
 */

import { defaultSkillsDir, SkillLoader } from './SkillLoader.js';
import { SkillRegistry } from './skill-registry.js';

let loader: SkillLoader | null = null;
let registry: SkillRegistry | null = null;

export interface InitSkillsOptions {
  /** Override the default skills directory — primarily for tests. */
  skillsDir?: string;
}

export async function initSkills(options: InitSkillsOptions = {}): Promise<SkillRegistry> {
  if (registry) return registry;

  const dir = options.skillsDir ?? defaultSkillsDir();
  const newLoader = new SkillLoader(dir);
  await newLoader.loadAll();

  const newRegistry = new SkillRegistry(newLoader);
  newRegistry.validate();

  loader = newLoader;
  registry = newRegistry;
  return registry;
}

export function getSkillRegistry(): SkillRegistry {
  if (!registry) {
    throw new Error('Skill system not initialized — call initSkills() at startup');
  }
  return registry;
}

export function getSkillLoader(): SkillLoader {
  if (!loader) {
    throw new Error('Skill system not initialized — call initSkills() at startup');
  }
  return loader;
}

/** Test-only: clears cached instances so the next initSkills() rebuilds. */
export function resetSkillsForTesting(): void {
  loader = null;
  registry = null;
}

export { SkillLoader, SkillLoadError, defaultSkillsDir } from './SkillLoader.js';
export { SkillRegistry, buildSystemPromptWithSkills } from './skill-registry.js';
export { buildUseSkillTool, createUseSkillHandlers, USE_SKILL_TOOL_NAME } from './skill-tool.js';
export type { AgentKey, Skill, SkillFrontmatter } from './types.js';
