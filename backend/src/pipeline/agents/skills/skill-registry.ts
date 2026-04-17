/**
 * Skill registry — the policy mapping from agent → (core, opt) skills.
 *
 * `core`  skills are injected into the agent's system prompt on every call.
 * `opt`   skills are callable by the agent via the `useSkill` tool, so the
 *         agent pays the token cost only when it decides the guidance is
 *         useful for the current task.
 *
 * Only agents that run on `AgenticLoop` (Proto, Trace today) can use `opt`
 * skills. For agents that do single-shot `generateText`, `opt` is unreachable
 * and left empty by design.
 */

import type { AgentKey, Skill } from './types.js';
import type { SkillLoader } from './SkillLoader.js';

interface AgentSkillPolicy {
  core: string[];
  opt: string[];
}

const POLICY: Record<AgentKey, AgentSkillPolicy> = {
  scribe: {
    core: ['spec-writing', 'system-design'],
    opt: [],
  },
  proto: {
    core: ['mvp-scaffolding'],
    opt: ['system-design', 'testing-strategy', 'documentation'],
  },
  trace: {
    core: ['playwright-testing', 'testing-strategy'],
    opt: [],
  },
  critic: {
    core: ['code-review'],
    opt: [],
  },
};

export class SkillRegistry {
  constructor(private readonly loader: SkillLoader) {}

  /** Skills injected into the agent's system prompt. */
  getCore(agent: AgentKey): Skill[] {
    return POLICY[agent].core.map((name) => this.loader.get(name));
  }

  /** Skills callable via `useSkill` tool. Empty for non-AgenticLoop agents. */
  getOpt(agent: AgentKey): Skill[] {
    return POLICY[agent].opt.map((name) => this.loader.get(name));
  }

  /** Names of opt skills for an agent — used to build the tool's enum schema. */
  getOptNames(agent: AgentKey): string[] {
    return [...POLICY[agent].opt];
  }

  /** Whether an agent is allowed to invoke a given skill by name. */
  canUse(agent: AgentKey, skillName: string): boolean {
    const policy = POLICY[agent];
    return policy.core.includes(skillName) || policy.opt.includes(skillName);
  }

  /**
   * Returns the skill body for an agent, throwing if the agent is not
   * permitted to use it. Used by the `useSkill` tool handler.
   */
  getBodyForAgent(agent: AgentKey, skillName: string): string {
    if (!this.canUse(agent, skillName)) {
      throw new Error(`agent "${agent}" is not permitted to use skill "${skillName}"`);
    }
    return this.loader.get(skillName).body;
  }

  /**
   * Validates that every referenced skill actually exists. Call after
   * `loader.loadAll()` so missing files become startup errors.
   */
  validate(): void {
    for (const agent of Object.keys(POLICY) as AgentKey[]) {
      const { core, opt } = POLICY[agent];
      for (const name of [...core, ...opt]) {
        if (!this.loader.has(name)) {
          throw new Error(
            `[SkillRegistry] agent "${agent}" references unknown skill "${name}"`,
          );
        }
      }
    }
  }
}

/**
 * Builds an agent system prompt by appending its core skills to the base
 * prompt under a `# Skills` section. Order within the section matches POLICY
 * so prompt diffs are deterministic across runs.
 */
export function buildSystemPromptWithSkills(
  basePrompt: string,
  agent: AgentKey,
  registry: SkillRegistry,
): string {
  const core = registry.getCore(agent);
  if (core.length === 0) return basePrompt;

  const section = core
    .map((s) => `## Skill: ${s.frontmatter.name}\n${s.body}`)
    .join('\n\n');

  return `${basePrompt}\n\n# Skills\n\n${section}`;
}
