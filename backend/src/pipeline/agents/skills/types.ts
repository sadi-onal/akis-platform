/**
 * Skill system types.
 *
 * A Skill is a reusable behavioral module authored as a Markdown file with
 * YAML-like frontmatter. Skills are loaded at startup and injected into agent
 * system prompts (core tier) or exposed via the `useSkill` tool (opt tier).
 */

export type AgentKey = 'scribe' | 'proto' | 'trace' | 'critic';

export const AGENT_KEYS: readonly AgentKey[] = ['scribe', 'proto', 'trace', 'critic'] as const;

export interface SkillFrontmatter {
  /** Unique skill identifier, kebab-case. Must match the file name stem. */
  name: string;
  /** One-line summary used for tool description + documentation. */
  description: string;
  /** Agents that may use this skill. */
  agents: AgentKey[];
  /** Optional version marker; bump when behavior changes materially. */
  version: number;
  /**
   * Raw tier field as written in frontmatter. Resolution to per-agent
   * core/opt is handled by the registry, not by the skill file itself,
   * so one skill can be "core" for one agent and "opt" for another.
   */
  tier: string;
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  /** The markdown body (everything after the closing `---`). */
  body: string;
}
