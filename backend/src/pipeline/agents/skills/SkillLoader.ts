/**
 * SkillLoader — reads skill .md files from disk, parses frontmatter, and
 * exposes skills by name. Meant to be instantiated once at server startup.
 *
 * Frontmatter format (YAML-like, intentionally minimal):
 *
 *   ---
 *   name: system-design
 *   description: One-line summary
 *   agents: scribe, proto, critic
 *   tier: core
 *   version: 1
 *   ---
 *
 *   <markdown body>
 *
 * Values are strings unless the key is:
 *   - `agents` (comma-separated list → string[])
 *   - `version` (integer)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_KEYS, type AgentKey, type Skill, type SkillFrontmatter } from './types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const AGENT_KEY_SET = new Set<AgentKey>(AGENT_KEYS);

export class SkillLoadError extends Error {
  constructor(message: string, public readonly file?: string) {
    super(file ? `[${file}] ${message}` : message);
    this.name = 'SkillLoadError';
  }
}

export class SkillLoader {
  private skills = new Map<string, Skill>();
  private loaded = false;

  constructor(private readonly skillsDir: string) {}

  /**
   * Reads every `.md` file in the skills directory and parses it.
   * Throws SkillLoadError on any invalid file — skills are infrastructure,
   * a broken file should prevent server startup.
   */
  async loadAll(): Promise<void> {
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => path.join(this.skillsDir, e.name));

    for (const file of files) {
      const raw = await fs.readFile(file, 'utf-8');
      const skill = this.parseSkill(raw, file);
      const stem = path.basename(file, '.md');
      if (skill.frontmatter.name !== stem) {
        throw new SkillLoadError(
          `frontmatter name "${skill.frontmatter.name}" does not match file name "${stem}"`,
          file,
        );
      }
      if (this.skills.has(skill.frontmatter.name)) {
        throw new SkillLoadError(`duplicate skill name "${skill.frontmatter.name}"`, file);
      }
      this.skills.set(skill.frontmatter.name, skill);
    }
    this.loaded = true;
  }

  /** Returns the full skill (frontmatter + body) or throws if unknown. */
  get(name: string): Skill {
    this.assertLoaded();
    const skill = this.skills.get(name);
    if (!skill) throw new SkillLoadError(`unknown skill "${name}"`);
    return skill;
  }

  /** Returns just the markdown body — used for tool responses and prompt injection. */
  getContent(name: string): string {
    return this.get(name).body;
  }

  /** True when a skill with this name exists. */
  has(name: string): boolean {
    this.assertLoaded();
    return this.skills.has(name);
  }

  /** Names of all loaded skills. Useful for diagnostics + tool schema enums. */
  listNames(): string[] {
    this.assertLoaded();
    return Array.from(this.skills.keys()).sort();
  }

  /** All loaded skills. */
  listAll(): Skill[] {
    this.assertLoaded();
    return Array.from(this.skills.values());
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new SkillLoadError('SkillLoader.loadAll() was not called');
  }

  private parseSkill(raw: string, file: string): Skill {
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) {
      throw new SkillLoadError('missing or malformed frontmatter (expected --- ... ---)', file);
    }
    const [, fm, body] = match;
    const frontmatter = this.parseFrontmatter(fm, file);
    return { frontmatter, body: body.trim() };
  }

  private parseFrontmatter(raw: string, file: string): SkillFrontmatter {
    const entries: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const colon = line.indexOf(':');
      if (colon === -1) {
        throw new SkillLoadError(`frontmatter line missing ":" — ${JSON.stringify(line)}`, file);
      }
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      entries[key] = value;
    }

    const required = ['name', 'description', 'agents', 'tier', 'version'] as const;
    for (const key of required) {
      if (!(key in entries)) {
        throw new SkillLoadError(`frontmatter missing required key "${key}"`, file);
      }
    }

    const agents = this.parseAgents(entries.agents, file);
    const version = Number.parseInt(entries.version, 10);
    if (!Number.isFinite(version) || version < 1) {
      throw new SkillLoadError(`frontmatter "version" must be a positive integer`, file);
    }

    return {
      name: entries.name,
      description: entries.description,
      agents,
      tier: entries.tier,
      version,
    };
  }

  private parseAgents(raw: string, file: string): AgentKey[] {
    const tokens = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (tokens.length === 0) {
      throw new SkillLoadError(`frontmatter "agents" is empty`, file);
    }
    for (const t of tokens) {
      if (!AGENT_KEY_SET.has(t as AgentKey)) {
        throw new SkillLoadError(
          `unknown agent "${t}" in frontmatter "agents" (allowed: ${AGENT_KEYS.join(', ')})`,
          file,
        );
      }
    }
    return tokens as AgentKey[];
  }
}

/** Resolves the default skills directory relative to this module. */
export function defaultSkillsDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return here;
}
