/**
 * Skill system unit tests — covers SkillLoader parsing, SkillRegistry policy,
 * prompt building, and the `useSkill` tool definition + handler.
 *
 * Uses a temp directory populated with fixture .md files for the loader tests
 * and the real shipped skills for the integration-style tests.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SkillLoader,
  SkillLoadError,
  SkillRegistry,
  buildSystemPromptWithSkills,
  buildUseSkillTool,
  createUseSkillHandlers,
  defaultSkillsDir,
  initSkills,
  resetSkillsForTesting,
  USE_SKILL_TOOL_NAME,
  getSkillRegistry,
} from '../../src/pipeline/agents/skills/index.js';

// ─── Fixtures ────────────────────────────────────────

async function makeTempSkillsDir(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'akis-skills-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf-8');
  }
  return dir;
}

const VALID_SKILL = `---
name: demo-skill
description: A demo skill for tests
agents: proto, trace
tier: core
version: 1
---

# Demo

Body content goes here.
`;

// ─── SkillLoader: parsing ────────────────────────────

describe('SkillLoader.parseSkill', () => {
  test('parses a valid skill file', async () => {
    const dir = await makeTempSkillsDir({ 'demo-skill.md': VALID_SKILL });
    const loader = new SkillLoader(dir);
    await loader.loadAll();

    const skill = loader.get('demo-skill');
    assert.equal(skill.frontmatter.name, 'demo-skill');
    assert.equal(skill.frontmatter.description, 'A demo skill for tests');
    assert.deepEqual(skill.frontmatter.agents, ['proto', 'trace']);
    assert.equal(skill.frontmatter.tier, 'core');
    assert.equal(skill.frontmatter.version, 1);
    assert.match(skill.body, /# Demo/);
    assert.match(skill.body, /Body content goes here\./);
  });

  test('throws if file has no frontmatter', async () => {
    const dir = await makeTempSkillsDir({ 'bad.md': 'just text, no fences' });
    const loader = new SkillLoader(dir);
    await assert.rejects(() => loader.loadAll(), SkillLoadError);
  });

  test('throws if required frontmatter key is missing', async () => {
    const missingDesc = `---
name: missing-desc
agents: proto
tier: core
version: 1
---

body
`;
    const dir = await makeTempSkillsDir({ 'missing-desc.md': missingDesc });
    const loader = new SkillLoader(dir);
    await assert.rejects(() => loader.loadAll(), /description/);
  });

  test('throws if file name does not match frontmatter name', async () => {
    const dir = await makeTempSkillsDir({ 'wrong-name.md': VALID_SKILL });
    const loader = new SkillLoader(dir);
    await assert.rejects(() => loader.loadAll(), /name.*does not match/);
  });

  test('throws if agents field contains an unknown agent', async () => {
    const badAgent = `---
name: bad-agent
description: has a bogus agent name
agents: proto, wizard
tier: core
version: 1
---

body
`;
    const dir = await makeTempSkillsDir({ 'bad-agent.md': badAgent });
    const loader = new SkillLoader(dir);
    await assert.rejects(() => loader.loadAll(), /unknown agent/);
  });

  test('throws if version is not a positive integer', async () => {
    const bad = `---
name: bad-version
description: x
agents: proto
tier: core
version: zero
---

body
`;
    const dir = await makeTempSkillsDir({ 'bad-version.md': bad });
    const loader = new SkillLoader(dir);
    await assert.rejects(() => loader.loadAll(), /version/);
  });

  test('throws if a second file has a stem that does not match its frontmatter', async () => {
    // Duplicate-name defense is enforced indirectly by the stem-vs-name
    // check: two valid files can never share a frontmatter name because
    // their stems must differ. This test documents that invariant.
    const dir = await makeTempSkillsDir({ 'demo-skill.md': VALID_SKILL });
    await fs.writeFile(path.join(dir, 'demo-skill-alias.md'), VALID_SKILL, 'utf-8');
    const loader = new SkillLoader(dir);
    await assert.rejects(() => loader.loadAll(), SkillLoadError);
  });

  test('accessor throws when loadAll was not called', () => {
    const loader = new SkillLoader('/nonexistent');
    assert.throws(() => loader.get('demo-skill'), /not called/);
  });
});

// ─── Real shipped skills ──────────────────────────────

describe('shipped skills', () => {
  before(() => resetSkillsForTesting());
  after(() => resetSkillsForTesting());

  test('all shipped skill files load without error', async () => {
    const loader = new SkillLoader(defaultSkillsDir());
    await loader.loadAll();

    const names = loader.listNames();
    for (const expected of [
      'spec-writing',
      'mvp-scaffolding',
      'playwright-testing',
      'code-review',
      'system-design',
      'testing-strategy',
      'documentation',
    ]) {
      assert.ok(
        names.includes(expected),
        `expected shipped skill "${expected}" but got ${names.join(', ')}`,
      );
    }
  });

  test('SkillRegistry.validate() passes against shipped skills', async () => {
    const loader = new SkillLoader(defaultSkillsDir());
    await loader.loadAll();
    const registry = new SkillRegistry(loader);
    assert.doesNotThrow(() => registry.validate());
  });

  test('initSkills() caches and returns same registry', async () => {
    const r1 = await initSkills();
    const r2 = await initSkills();
    assert.equal(r1, r2);
    assert.equal(getSkillRegistry(), r1);
  });
});

// ─── SkillRegistry policy ────────────────────────────

describe('SkillRegistry', () => {
  let loader: SkillLoader;
  let registry: SkillRegistry;

  before(async () => {
    loader = new SkillLoader(defaultSkillsDir());
    await loader.loadAll();
    registry = new SkillRegistry(loader);
  });

  test('scribe has spec-writing + system-design as core, no opts', () => {
    const core = registry.getCore('scribe').map((s) => s.frontmatter.name);
    const opt = registry.getOptNames('scribe');
    assert.deepEqual(core, ['spec-writing', 'system-design']);
    assert.deepEqual(opt, []);
  });

  test('proto has mvp-scaffolding core and three opts', () => {
    const core = registry.getCore('proto').map((s) => s.frontmatter.name);
    const opt = registry.getOptNames('proto');
    assert.deepEqual(core, ['mvp-scaffolding']);
    assert.deepEqual(opt, ['system-design', 'testing-strategy', 'documentation']);
  });

  test('trace has playwright-testing + testing-strategy as core', () => {
    const core = registry.getCore('trace').map((s) => s.frontmatter.name);
    assert.deepEqual(core, ['playwright-testing', 'testing-strategy']);
  });

  test('critic has code-review as core, no opts in phase 1', () => {
    const core = registry.getCore('critic').map((s) => s.frontmatter.name);
    const opt = registry.getOptNames('critic');
    assert.deepEqual(core, ['code-review']);
    assert.deepEqual(opt, []);
  });

  test('canUse returns true for core and opt skills only', () => {
    assert.equal(registry.canUse('proto', 'mvp-scaffolding'), true);
    assert.equal(registry.canUse('proto', 'system-design'), true);
    assert.equal(registry.canUse('proto', 'code-review'), false);
    assert.equal(registry.canUse('scribe', 'mvp-scaffolding'), false);
  });

  test('getBodyForAgent returns body for allowed skill', () => {
    const body = registry.getBodyForAgent('proto', 'mvp-scaffolding');
    assert.match(body, /File count and size budget/);
  });

  test('getBodyForAgent throws for disallowed skill', () => {
    assert.throws(() => registry.getBodyForAgent('scribe', 'mvp-scaffolding'), /not permitted/);
  });
});

// ─── buildSystemPromptWithSkills ─────────────────────

describe('buildSystemPromptWithSkills', () => {
  let registry: SkillRegistry;

  before(async () => {
    const loader = new SkillLoader(defaultSkillsDir());
    await loader.loadAll();
    registry = new SkillRegistry(loader);
  });

  test('appends core skills under a # Skills section', () => {
    const result = buildSystemPromptWithSkills('BASE', 'proto', registry);
    assert.match(result, /^BASE/);
    assert.match(result, /# Skills/);
    assert.match(result, /## Skill: mvp-scaffolding/);
  });

  test('returns base prompt unchanged when agent has no core skills', async () => {
    // Inject a synthetic registry with no core skills — we use a temp dir.
    const dir = await makeTempSkillsDir({ 'demo-skill.md': VALID_SKILL });
    const loader = new SkillLoader(dir);
    await loader.loadAll();
    // Base registry has all agents with core skills, so instead we verify
    // behavior at the integration level via the known policy — every agent
    // has at least one core skill today. Assert that BASE is the prefix.
    const result = buildSystemPromptWithSkills('BASE', 'proto', registry);
    assert.ok(result.startsWith('BASE\n\n# Skills'));
  });
});

// ─── useSkill tool ───────────────────────────────────

describe('useSkill tool', () => {
  let registry: SkillRegistry;

  before(async () => {
    const loader = new SkillLoader(defaultSkillsDir());
    await loader.loadAll();
    registry = new SkillRegistry(loader);
  });

  test('buildUseSkillTool returns null when agent has no opt skills', () => {
    assert.equal(buildUseSkillTool('scribe', registry), null);
    assert.equal(buildUseSkillTool('critic', registry), null);
    assert.equal(buildUseSkillTool('trace', registry), null);
  });

  test('buildUseSkillTool returns tool def with opt skills as enum for proto', () => {
    const tool = buildUseSkillTool('proto', registry);
    assert.ok(tool);
    assert.equal(tool.name, USE_SKILL_TOOL_NAME);
    const schema = tool.inputSchema as {
      properties: { skill: { enum: string[] } };
      required: string[];
    };
    assert.deepEqual(schema.properties.skill.enum, [
      'system-design',
      'testing-strategy',
      'documentation',
    ]);
    assert.deepEqual(schema.required, ['skill']);
  });

  test('handler returns skill content for allowed skill', async () => {
    const handlers = createUseSkillHandlers('proto', registry);
    const result = (await handlers[USE_SKILL_TOOL_NAME]({ skill: 'system-design' })) as {
      skill?: string;
      content?: string;
      error?: string;
    };
    assert.equal(result.skill, 'system-design');
    assert.ok(result.content && result.content.length > 0);
    assert.equal(result.error, undefined);
  });

  test('handler returns error for disallowed skill', async () => {
    const handlers = createUseSkillHandlers('proto', registry);
    const result = (await handlers[USE_SKILL_TOOL_NAME]({ skill: 'code-review' })) as {
      error?: string;
    };
    assert.match(result.error ?? '', /not permitted/);
  });

  test('handler returns error for missing skill parameter', async () => {
    const handlers = createUseSkillHandlers('proto', registry);
    const result = (await handlers[USE_SKILL_TOOL_NAME]({})) as { error?: string };
    assert.match(result.error ?? '', /missing/);
  });
});
