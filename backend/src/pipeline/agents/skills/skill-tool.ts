/**
 * `useSkill` tool — lets an AgenticLoop-based agent pull the body of an
 * opt-tier skill on demand. The tool's schema is built per-agent so its
 * `skill` enum only lists skills the caller is actually allowed to invoke.
 *
 * Core skills are pre-injected into the system prompt, so calling `useSkill`
 * on a core skill is wasteful but not harmful — the handler still returns the
 * body so retries and testing stay simple.
 */

import type { ToolDefinition, ToolHandlerMap } from '../../../services/ai/tool-schemas.js';
import type { SkillRegistry } from './skill-registry.js';
import type { AgentKey } from './types.js';

export const USE_SKILL_TOOL_NAME = 'useSkill';

/**
 * Build the `useSkill` tool definition for a specific agent. Returns `null`
 * when the agent has no opt skills — there is no point exposing a tool whose
 * enum would be empty.
 */
export function buildUseSkillTool(
  agent: AgentKey,
  registry: SkillRegistry,
): ToolDefinition | null {
  const available = registry.getOptNames(agent);
  if (available.length === 0) return null;

  const skillDescriptions = registry
    .getOpt(agent)
    .map((s) => `- ${s.frontmatter.name}: ${s.frontmatter.description}`)
    .join('\n');

  return {
    name: USE_SKILL_TOOL_NAME,
    description:
      'Retrieve the full guidance body of a specialized skill. Call this when one of the listed skills is relevant to the step you are working on.\n\nAvailable skills:\n' +
      skillDescriptions,
    inputSchema: {
      properties: {
        skill: {
          type: 'string',
          enum: available,
          description: 'Name of the skill to retrieve.',
        },
      },
      required: ['skill'],
    },
  };
}

/**
 * Build a handler map entry for `useSkill`. Merge the returned map with the
 * agent's existing handlers before passing to `runAgenticLoop`.
 */
export function createUseSkillHandlers(
  agent: AgentKey,
  registry: SkillRegistry,
): ToolHandlerMap {
  return {
    [USE_SKILL_TOOL_NAME]: async (input) => {
      const skill = String((input as { skill?: unknown }).skill ?? '');
      if (!skill) {
        return { error: 'missing "skill" parameter' };
      }
      try {
        return { skill, content: registry.getBodyForAgent(agent, skill) };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
