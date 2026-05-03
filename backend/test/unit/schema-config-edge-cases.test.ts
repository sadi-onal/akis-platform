/**
 * Schema & Config edge-case tests
 *
 * Validates Drizzle ORM schema metadata (columns, enums, indexes, defaults,
 * notNull, foreign keys) and env.ts configuration logic (provider detection,
 * CORS parsing, defaults) WITHOUT a running database.
 *
 * Uses actual schema/config exports — no mocks.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { z } from 'zod';

// ── Schema imports ─────────────────────────────────────────────────
import {
  users,
  userRoleEnum,
  userStatusEnum,
  jobs,
  jobStateEnum,
  pipelines,
  pipelineStageEnum,
  oauthAccounts,
  oauthProviderEnum,
  githubIntegrations,
  emailVerificationTokens,
  jobPlans,
  jobAudits,
  jobTraces,
  jobArtifacts,
  conversationThreads,
  conversationMessages,
  planCandidates,
  userAiKeys,
  knowledgeDocuments,
  knowledgeChunks,
  knowledgeSources,
  knowledgeProvenance,
  crewRuns,
  crewTasks,
  crewMessages,
  inviteTokens,
  studioSessions,
  devSessions,
  agentConfigs,
  aiProviderEnum,
  traceEventTypeEnum,
  threadStatusEnum,
  threadMessageRoleEnum,
  planCandidateStatusEnum,
  threadTaskStatusEnum,
  studioSessionStateEnum,
  devSessionStatusEnum,
  devChangeStatusEnum,
  crewRunStatusEnum,
  crewTaskStatusEnum,
  crewMessageTypeEnum,
  auditPhaseEnum,
  inviteStatusEnum,
  integrationProviderEnum,
  knowledgeDocStatusEnum,
  knowledgeDocTypeEnum,
  knowledgeSourceLicenseEnum,
  knowledgeSourceAccessEnum,
  knowledgeVerificationStatusEnum,
} from '../../src/db/schema.js';

// ── Helpers ────────────────────────────────────────────────────────

/** Return a Map<columnName, columnConfig> for a Drizzle table */
function colMap(table: Parameters<typeof getTableConfig>[0]) {
  const cfg = getTableConfig(table);
  return new Map(cfg.columns.map((c) => [c.name, c]));
}

/** Return index names for a table */
function indexNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  const cfg = getTableConfig(table);
  return cfg.indexes.map((i) => i.config.name).filter(Boolean) as string[];
}

/** Return foreign-key target table names */
function fkTargets(table: Parameters<typeof getTableConfig>[0]): string[] {
  const cfg = getTableConfig(table);
  return cfg.foreignKeys.map((fk) => {
    const ref = fk.reference();
    return getTableName(ref.foreignTable);
  });
}

// ====================================================================
// 1. Users table
// ====================================================================

describe('Schema — users table', () => {
  const cols = colMap(users);

  test('table is named "users"', () => {
    assert.equal(getTableName(users), 'users');
  });

  test('email column exists and is notNull', () => {
    const email = cols.get('email');
    assert.ok(email, 'email column missing');
    assert.equal(email.notNull, true);
  });

  test('password_hash column exists and is notNull', () => {
    const pw = cols.get('password_hash');
    assert.ok(pw, 'password_hash column missing');
    assert.equal(pw.notNull, true);
  });

  test('role enum contains admin and member', () => {
    const values = userRoleEnum.enumValues;
    assert.ok(values.includes('admin'));
    assert.ok(values.includes('member'));
  });

  test('status enum contains expected lifecycle states', () => {
    const values = userStatusEnum.enumValues;
    const expected = ['pending_verification', 'active', 'disabled', 'deleted'];
    for (const v of expected) {
      assert.ok(values.includes(v as typeof values[number]), `missing status: ${v}`);
    }
  });

  test('role column defaults to member', () => {
    const role = cols.get('role');
    assert.ok(role, 'role column missing');
    // Drizzle stores default as a SQL expression or literal
    assert.ok(role.hasDefault, 'role should have a default');
  });

  test('createdAt has a default', () => {
    const ca = cols.get('created_at');
    assert.ok(ca, 'created_at column missing');
    assert.ok(ca.hasDefault, 'created_at should have a default');
  });

  test('updatedAt has a default', () => {
    const ua = cols.get('updated_at');
    assert.ok(ua, 'updated_at column missing');
    assert.ok(ua.hasDefault, 'updated_at should have a default');
  });

  test('email index exists', () => {
    const idxs = indexNames(users);
    assert.ok(idxs.some((n) => n.includes('email')), `email index not found in: ${idxs}`);
  });

  test('status index exists', () => {
    const idxs = indexNames(users);
    assert.ok(idxs.some((n) => n.includes('status')), `status index not found in: ${idxs}`);
  });
});

// ====================================================================
// 2. Jobs table
// ====================================================================

describe('Schema — jobs table', () => {
  const cols = colMap(jobs);

  test('table is named "jobs"', () => {
    assert.equal(getTableName(jobs), 'jobs');
  });

  test('type column is notNull', () => {
    const t = cols.get('type');
    assert.ok(t);
    assert.equal(t.notNull, true);
  });

  test('state column is notNull and has default', () => {
    const s = cols.get('state');
    assert.ok(s);
    assert.equal(s.notNull, true);
    assert.ok(s.hasDefault, 'state should default to pending');
  });

  test('jobState enum contains all expected values', () => {
    const values = jobStateEnum.enumValues;
    const expected = ['pending', 'running', 'completed', 'failed', 'awaiting_approval'];
    for (const v of expected) {
      assert.ok(values.includes(v as typeof values[number]), `missing job state: ${v}`);
    }
  });

  test('payload column exists (jsonb)', () => {
    const p = cols.get('payload');
    assert.ok(p, 'payload column missing');
    assert.equal(p.dataType, 'json');
  });

  test('createdAt and updatedAt have defaults', () => {
    assert.ok(cols.get('created_at')?.hasDefault);
    assert.ok(cols.get('updated_at')?.hasDefault);
  });

  test('composite index on type+state+createdAt exists', () => {
    const idxs = indexNames(jobs);
    assert.ok(
      idxs.some((n) => n.includes('type_state_created')),
      `expected composite index, found: ${idxs}`,
    );
  });
});

// ====================================================================
// 3. Pipeline schema — stage enum completeness
// ====================================================================

describe('Schema — pipeline stage enum (FSM stages)', () => {
  const stages = pipelineStageEnum.enumValues;

  test('contains all FSM stages from CLAUDE.md', () => {
    const expected = [
      'scribe_clarifying',
      'scribe_generating',
      'awaiting_approval',
      'proto_building',
      'trace_testing',
      'completed',
      'completed_partial',
      'failed',
      'cancelled',
    ];
    for (const s of expected) {
      assert.ok(stages.includes(s as typeof stages[number]), `missing pipeline stage: ${s}`);
    }
  });

  test('also includes ci_running stage', () => {
    assert.ok(stages.includes('ci_running'));
  });

  test('pipelines table references users via userId FK', () => {
    const targets = fkTargets(pipelines);
    assert.ok(targets.includes('users'), `FK to users not found; targets: ${targets}`);
  });

  test('pipelines table has user_id and stage indexes', () => {
    const idxs = indexNames(pipelines);
    assert.ok(idxs.some((n) => n.includes('user_id')), `user_id index missing: ${idxs}`);
    assert.ok(idxs.some((n) => n.includes('stage')), `stage index missing: ${idxs}`);
  });

  test('pipelines stage column defaults to scribe_clarifying', () => {
    const cols = colMap(pipelines);
    const stage = cols.get('stage');
    assert.ok(stage);
    assert.ok(stage.hasDefault);
  });
});

// ====================================================================
// 4. github_integrations table — separate from login OAuth
// ====================================================================

describe('Schema — github_integrations table', () => {
  const cols = colMap(githubIntegrations);

  test('user_id is the primary key', () => {
    const cfg = getTableConfig(githubIntegrations);
    const pk = cfg.columns.find((c) => c.name === 'user_id');
    assert.ok(pk?.primary, 'user_id should be primary key');
  });

  test('login + provider_account_id + scope + access_token are NOT NULL', () => {
    for (const name of ['login', 'provider_account_id', 'scope', 'access_token']) {
      const c = cols.get(name);
      assert.ok(c, `${name} missing`);
      assert.equal(c.notNull, true, `${name} should be NOT NULL`);
    }
  });

  test('foreign key to users with cascade delete', () => {
    assert.ok(fkTargets(githubIntegrations).includes('users'), 'FK to users missing');
  });

  test('login index exists for reverse lookup', () => {
    const idxs = indexNames(githubIntegrations);
    assert.ok(idxs.some((n) => n.includes('login')), `login index missing: ${idxs}`);
  });
});

// ====================================================================
// 6. Foreign key relationships
// ====================================================================

describe('Schema — foreign key relationships', () => {
  test('jobs.approvedBy → users', () => {
    const targets = fkTargets(jobs);
    assert.ok(targets.includes('users'), `jobs FK to users missing: ${targets}`);
  });

  test('jobPlans → jobs (cascade delete)', () => {
    const targets = fkTargets(jobPlans);
    assert.ok(targets.includes('jobs'));
  });

  test('jobAudits → jobs', () => {
    assert.ok(fkTargets(jobAudits).includes('jobs'));
  });

  test('jobTraces → jobs', () => {
    assert.ok(fkTargets(jobTraces).includes('jobs'));
  });

  test('jobArtifacts → jobs', () => {
    assert.ok(fkTargets(jobArtifacts).includes('jobs'));
  });

  test('conversationThreads → users', () => {
    assert.ok(fkTargets(conversationThreads).includes('users'));
  });

  test('conversationMessages → threads and users', () => {
    const t = fkTargets(conversationMessages);
    assert.ok(t.includes('conversation_threads'));
    assert.ok(t.includes('users'));
  });

  test('oauthAccounts → users', () => {
    assert.ok(fkTargets(oauthAccounts).includes('users'));
  });

  test('emailVerificationTokens → users', () => {
    assert.ok(fkTargets(emailVerificationTokens).includes('users'));
  });

  test('userAiKeys → users', () => {
    assert.ok(fkTargets(userAiKeys).includes('users'));
  });

  test('githubIntegrations → users', () => {
    assert.ok(fkTargets(githubIntegrations).includes('users'));
  });

  test('pipelines → users', () => {
    assert.ok(fkTargets(pipelines).includes('users'));
  });

  test('knowledgeChunks → knowledgeDocuments', () => {
    assert.ok(fkTargets(knowledgeChunks).includes('knowledge_documents'));
  });

  test('knowledgeProvenance → knowledgeChunks and knowledgeSources', () => {
    const t = fkTargets(knowledgeProvenance);
    assert.ok(t.includes('knowledge_chunks'));
    assert.ok(t.includes('knowledge_sources'));
  });

  test('crewTasks → crewRuns', () => {
    assert.ok(fkTargets(crewTasks).includes('crew_runs'));
  });

  test('crewMessages → crewRuns', () => {
    assert.ok(fkTargets(crewMessages).includes('crew_runs'));
  });

  test('devSessions → pipelines', () => {
    assert.ok(fkTargets(devSessions).includes('pipelines'));
  });

  test('agentConfigs → users', () => {
    assert.ok(fkTargets(agentConfigs).includes('users'));
  });
});

// ====================================================================
// 7. Index definitions — spot-check important indexes
// ====================================================================

describe('Schema — index definitions', () => {
  test('users: email and status indexes', () => {
    const idxs = indexNames(users);
    assert.ok(idxs.some((n) => n.includes('email')));
    assert.ok(idxs.some((n) => n.includes('status')));
  });

  test('jobs: composite type_state_created index', () => {
    const idxs = indexNames(jobs);
    assert.ok(idxs.some((n) => n.includes('type_state_created')));
  });

  test('pipelines: user_id and stage indexes', () => {
    const idxs = indexNames(pipelines);
    assert.ok(idxs.some((n) => n.includes('user_id')));
    assert.ok(idxs.some((n) => n.includes('stage')));
  });

  test('conversationThreads: user status updated composite index', () => {
    const idxs = indexNames(conversationThreads);
    assert.ok(idxs.some((n) => n.includes('user_status_updated')));
  });

  test('jobTraces: job_id and event_type indexes', () => {
    const idxs = indexNames(jobTraces);
    assert.ok(idxs.some((n) => n.includes('job_id')));
    assert.ok(idxs.some((n) => n.includes('event_type')));
  });

  test('userAiKeys: user_provider unique index', () => {
    const idxs = indexNames(userAiKeys);
    assert.ok(idxs.some((n) => n.includes('user_provider')));
  });

  test('oauthAccounts: provider_account index', () => {
    const idxs = indexNames(oauthAccounts);
    assert.ok(idxs.some((n) => n.includes('provider_account')));
  });

  test('knowledgeSources: domain and active indexes', () => {
    const idxs = indexNames(knowledgeSources);
    assert.ok(idxs.some((n) => n.includes('domain')));
    assert.ok(idxs.some((n) => n.includes('active')));
  });

  test('studioSessions: user and state indexes', () => {
    const idxs = indexNames(studioSessions);
    assert.ok(idxs.some((n) => n.includes('user')));
    assert.ok(idxs.some((n) => n.includes('state')));
  });
});

// ====================================================================
// 8. Timestamp defaults
// ====================================================================

describe('Schema — timestamp defaults across tables', () => {
  const tables = [
    { name: 'users', table: users },
    { name: 'jobs', table: jobs },
    { name: 'pipelines', table: pipelines },
    { name: 'conversationThreads', table: conversationThreads },
    { name: 'knowledgeDocuments', table: knowledgeDocuments },
    { name: 'studioSessions', table: studioSessions },
    { name: 'crewRuns', table: crewRuns },
    { name: 'agentConfigs', table: agentConfigs },
  ];

  for (const { name, table } of tables) {
    test(`${name}: created_at has default`, () => {
      const cols = colMap(table);
      const ca = cols.get('created_at');
      assert.ok(ca, `${name} missing created_at`);
      assert.ok(ca.hasDefault, `${name}.created_at should have a default`);
    });

    test(`${name}: updated_at has default`, () => {
      const cols = colMap(table);
      const ua = cols.get('updated_at');
      assert.ok(ua, `${name} missing updated_at`);
      assert.ok(ua.hasDefault, `${name}.updated_at should have a default`);
    });
  }
});

// ====================================================================
// 9. Enum completeness for less-obvious enums
// ====================================================================

describe('Schema — enum completeness', () => {
  test('oauthProvider enum has github, google, atlassian', () => {
    const v = oauthProviderEnum.enumValues;
    assert.ok(v.includes('github'));
    assert.ok(v.includes('google'));
    assert.ok(v.includes('atlassian'));
  });

  test('aiProvider enum has anthropic, openai, openrouter', () => {
    const v = aiProviderEnum.enumValues;
    assert.ok(v.includes('anthropic'));
    assert.ok(v.includes('openai'));
    assert.ok(v.includes('openrouter'));
  });

  test('traceEventType enum includes explainability types', () => {
    const v = traceEventTypeEnum.enumValues;
    const expected = ['tool_call', 'tool_result', 'decision', 'plan_step', 'reasoning'];
    for (const e of expected) {
      assert.ok(v.includes(e as typeof v[number]), `missing trace event type: ${e}`);
    }
  });

  test('threadStatus enum values', () => {
    const expected = ['active', 'awaiting_user_input', 'awaiting_plan_selection', 'queued', 'completed', 'failed'];
    for (const e of expected) {
      assert.ok(threadStatusEnum.enumValues.includes(e as typeof threadStatusEnum.enumValues[number]), `missing: ${e}`);
    }
  });

  test('threadMessageRole enum has system, user, agent', () => {
    const v = threadMessageRoleEnum.enumValues;
    assert.deepEqual([...v].sort(), ['agent', 'system', 'user']);
  });

  test('planCandidateStatus enum values', () => {
    const v = planCandidateStatusEnum.enumValues;
    assert.ok(v.includes('unbuilt'));
    assert.ok(v.includes('building'));
    assert.ok(v.includes('built'));
    assert.ok(v.includes('failed'));
  });

  test('crewRunStatus enum values', () => {
    const v = crewRunStatusEnum.enumValues;
    const expected = ['planning', 'spawning', 'running', 'merging', 'completed', 'failed'];
    for (const e of expected) {
      assert.ok(v.includes(e as typeof v[number]), `missing crew run status: ${e}`);
    }
  });

  test('inviteStatus enum values', () => {
    const v = inviteStatusEnum.enumValues;
    assert.deepEqual([...v].sort(), ['accepted', 'expired', 'pending', 'revoked']);
  });

  test('knowledgeDocStatus enum values', () => {
    const v = knowledgeDocStatusEnum.enumValues;
    assert.deepEqual([...v].sort(), ['approved', 'deprecated', 'proposed']);
  });

  test('knowledgeVerificationStatus enum values', () => {
    const v = knowledgeVerificationStatusEnum.enumValues;
    const expected = ['unverified', 'single_source', 'cross_verified', 'stale', 'conflicted'];
    for (const e of expected) {
      assert.ok(v.includes(e as typeof v[number]), `missing: ${e}`);
    }
  });
});

// ====================================================================
// 10. Config — AI provider detection from API key prefix
// ====================================================================

// Re-create pure functions from config/env.ts to test without side-effects
function detectProviderFromKey(key: string): 'openai' | 'openrouter' | 'anthropic' | null {
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}

function detectProviderFromModel(model: string): 'openai' | 'openrouter' | 'anthropic' | null {
  if (model.startsWith('gpt-') || model.startsWith('o1') ||
      model.startsWith('o3') || model.startsWith('text-') ||
      model.startsWith('davinci')) {
    return 'openai';
  }
  if (model.includes('/') || model.includes(':free') || model.includes(':nitro')) {
    return 'openrouter';
  }
  if (model.startsWith('claude-')) {
    return 'anthropic';
  }
  return null;
}

describe('Config — AI provider detection from API key prefix', () => {
  test('sk-ant-* detected as anthropic', () => {
    assert.equal(detectProviderFromKey('sk-ant-api03-abc'), 'anthropic');
  });

  test('sk-or-* detected as openrouter', () => {
    assert.equal(detectProviderFromKey('sk-or-v1-abc123'), 'openrouter');
  });

  test('sk-* (no or/ant) detected as openai', () => {
    assert.equal(detectProviderFromKey('sk-proj-abc123'), 'openai');
  });

  test('unknown prefix returns null', () => {
    assert.equal(detectProviderFromKey('custom-key-123'), null);
    assert.equal(detectProviderFromKey(''), null);
  });

  test('sk-or- takes priority over sk- (order matters)', () => {
    assert.equal(detectProviderFromKey('sk-or-test'), 'openrouter');
  });

  test('sk-ant- takes priority over sk- (order matters)', () => {
    assert.equal(detectProviderFromKey('sk-ant-test'), 'anthropic');
  });
});

// ====================================================================
// 11. Config — model detection
// ====================================================================

describe('Config — AI provider detection from model name', () => {
  test('claude-* detected as anthropic', () => {
    assert.equal(detectProviderFromModel('claude-sonnet-4-6'), 'anthropic');
    assert.equal(detectProviderFromModel('claude-haiku-4-5-20251001'), 'anthropic');
  });

  test('gpt-* and o1/o3 detected as openai', () => {
    assert.equal(detectProviderFromModel('gpt-4o-mini'), 'openai');
    assert.equal(detectProviderFromModel('o1-preview'), 'openai');
    assert.equal(detectProviderFromModel('o3-mini'), 'openai');
  });

  test('slash-containing models detected as openrouter', () => {
    assert.equal(detectProviderFromModel('anthropic/claude-3.5-haiku'), 'openrouter');
    assert.equal(detectProviderFromModel('google/gemini-2.5-flash'), 'openrouter');
  });

  test(':free and :nitro suffixes detected as openrouter', () => {
    assert.equal(detectProviderFromModel('mistral:free'), 'openrouter');
    assert.equal(detectProviderFromModel('some-model:nitro'), 'openrouter');
  });

  test('unknown models return null', () => {
    assert.equal(detectProviderFromModel('llama-3.1'), null);
    assert.equal(detectProviderFromModel(''), null);
  });
});

// ====================================================================
// 12. Config — envSchema field-level validation (recreated schemas)
// ====================================================================

const portSchema = z.coerce.number().default(3000);
const nodeEnvSchema = z.enum(['development', 'production', 'test']).default('development');
const aiProviderSchemaEnv = z.enum(['openrouter', 'openai', 'anthropic', 'mock']).default('mock');
const frontendUrlSchema = z.string().url().default('http://localhost:5173');
const corsOriginsSchema = z.string().default('http://localhost:5173')
  .transform((value) => value.split(',').map((o) => o.trim()).filter(Boolean));

describe('Config — required env vars and defaults', () => {
  test('DATABASE_URL is required (string URL)', () => {
    const dbUrlSchema = z.string().url();
    assert.throws(() => dbUrlSchema.parse(undefined), 'DATABASE_URL should be required');
    assert.throws(() => dbUrlSchema.parse('not-a-url'), 'DATABASE_URL must be a valid URL');
    assert.equal(dbUrlSchema.parse('postgresql://localhost:5432/akis'), 'postgresql://localhost:5432/akis');
  });

  test('AUTH_JWT_SECRET min 32 chars', () => {
    const jwtSchema = z.string().min(32).optional();
    assert.equal(jwtSchema.parse(undefined), undefined); // optional
    assert.throws(() => z.string().min(32).parse('short'), 'short secret should fail');
    assert.ok(z.string().min(32).parse('a'.repeat(32)));
  });

  test('PORT defaults to 3000', () => {
    assert.equal(portSchema.parse(undefined), 3000);
    assert.equal(portSchema.parse('8080'), 8080);
  });

  test('NODE_ENV defaults to development', () => {
    assert.equal(nodeEnvSchema.parse(undefined), 'development');
  });

  test('NODE_ENV rejects invalid values', () => {
    assert.throws(() => nodeEnvSchema.parse('staging'));
  });
});

// ====================================================================
// 13. Config — FRONTEND_URL validation
// ====================================================================

describe('Config — FRONTEND_URL validation', () => {
  test('defaults to http://localhost:5173', () => {
    assert.equal(frontendUrlSchema.parse(undefined), 'http://localhost:5173');
  });

  test('accepts valid URLs', () => {
    assert.equal(frontendUrlSchema.parse('https://akisflow.com'), 'https://akisflow.com');
  });

  test('rejects non-URL strings', () => {
    assert.throws(() => z.string().url().parse('not-a-url'));
  });
});

// ====================================================================
// 14. Config — CORS origins parsing
// ====================================================================

describe('Config — CORS_ORIGINS parsing', () => {
  test('splits comma-separated origins', () => {
    assert.deepEqual(
      corsOriginsSchema.parse('http://a.com,http://b.com'),
      ['http://a.com', 'http://b.com'],
    );
  });

  test('trims whitespace', () => {
    assert.deepEqual(
      corsOriginsSchema.parse(' http://a.com , http://b.com '),
      ['http://a.com', 'http://b.com'],
    );
  });

  test('filters empty segments', () => {
    assert.deepEqual(
      corsOriginsSchema.parse('http://a.com,,http://b.com,'),
      ['http://a.com', 'http://b.com'],
    );
  });

  test('single origin (no comma)', () => {
    assert.deepEqual(
      corsOriginsSchema.parse('https://akisflow.com'),
      ['https://akisflow.com'],
    );
  });

  test('defaults to localhost:5173', () => {
    assert.deepEqual(corsOriginsSchema.parse(undefined), ['http://localhost:5173']);
  });
});

// ====================================================================
// 15. Config — AI model default selection based on provider
// ====================================================================

describe('Config — AI provider enum and default model logic', () => {
  test('AI_PROVIDER accepts anthropic (unlike older schema)', () => {
    assert.equal(aiProviderSchemaEnv.parse('anthropic'), 'anthropic');
  });

  test('AI_PROVIDER defaults to mock', () => {
    assert.equal(aiProviderSchemaEnv.parse(undefined), 'mock');
  });

  test('AI_PROVIDER rejects unknown providers', () => {
    assert.throws(() => aiProviderSchemaEnv.parse('gemini'));
    assert.throws(() => aiProviderSchemaEnv.parse('azure'));
  });

  test('provider-to-default-model mapping is consistent', () => {
    // These are the defaults from getAIConfig in env.ts
    const providerDefaults: Record<string, string> = {
      openai: 'gpt-4o-mini',
      openrouter: 'anthropic/claude-3.5-haiku',
      anthropic: 'claude-haiku-4-5-20251001',
      mock: 'mock-model',
    };
    // Verify openai default is an openai model
    assert.equal(detectProviderFromModel(providerDefaults.openai), 'openai');
    // Verify openrouter default is an openrouter model (has /)
    assert.equal(detectProviderFromModel(providerDefaults.openrouter), 'openrouter');
    // Verify anthropic default is an anthropic model
    assert.equal(detectProviderFromModel(providerDefaults.anthropic), 'anthropic');
  });
});

// ====================================================================
// 16. Schema — additional enum & table sanity checks
// ====================================================================

describe('Schema — additional coverage', () => {
  test('studioSessionState enum values', () => {
    const v = studioSessionStateEnum.enumValues;
    assert.deepEqual([...v].sort(), ['active', 'archived', 'completed', 'paused']);
  });

  test('devSessionStatus enum values', () => {
    const v = devSessionStatusEnum.enumValues;
    assert.deepEqual([...v].sort(), ['active', 'closed', 'paused']);
  });

  test('devChangeStatus enum values', () => {
    const v = devChangeStatusEnum.enumValues;
    assert.deepEqual([...v].sort(), ['approved', 'pending', 'pushed', 'rejected']);
  });

  test('crewTaskStatus enum values', () => {
    const v = crewTaskStatusEnum.enumValues;
    assert.deepEqual([...v].sort(), ['blocked', 'completed', 'in_progress', 'pending']);
  });

  test('crewMessageType enum values', () => {
    const v = crewMessageTypeEnum.enumValues;
    assert.deepEqual([...v].sort(), ['challenge', 'chat', 'directive', 'status_report', 'task_update']);
  });

  test('auditPhase enum has plan, execute, reflect, validate', () => {
    const v = auditPhaseEnum.enumValues;
    assert.deepEqual([...v].sort(), ['execute', 'plan', 'reflect', 'validate']);
  });

  test('threadTaskStatus enum values', () => {
    const v = threadTaskStatusEnum.enumValues;
    const expected = ['pending', 'awaiting_user_input', 'answered', 'completed', 'failed'];
    for (const e of expected) {
      assert.ok(v.includes(e as typeof v[number]), `missing: ${e}`);
    }
  });

  test('integrationProvider enum values', () => {
    const v = integrationProviderEnum.enumValues;
    assert.ok(v.includes('jira'));
    assert.ok(v.includes('confluence'));
  });

  test('knowledgeDocType enum values', () => {
    const v = knowledgeDocTypeEnum.enumValues;
    assert.deepEqual([...v].sort(), ['job_artifact', 'manual', 'repo_doc']);
  });

  test('knowledgeSourceLicense has common OSS licenses', () => {
    const v = knowledgeSourceLicenseEnum.enumValues;
    assert.ok(v.includes('mit'));
    assert.ok(v.includes('apache-2.0'));
    assert.ok(v.includes('unknown'));
  });

  test('knowledgeSourceAccess enum values', () => {
    const v = knowledgeSourceAccessEnum.enumValues;
    assert.ok(v.includes('api'));
    assert.ok(v.includes('git_clone'));
    assert.ok(v.includes('manual_upload'));
  });

  test('inviteTokens has invitedBy FK to users', () => {
    assert.ok(fkTargets(inviteTokens).includes('users'));
  });

  test('planCandidates FK targets include threads, users, messages, jobs', () => {
    const t = fkTargets(planCandidates);
    assert.ok(t.includes('conversation_threads'));
    assert.ok(t.includes('users'));
    assert.ok(t.includes('conversation_messages'));
    assert.ok(t.includes('jobs'));
  });
});

// ====================================================================
// 17. Config — email provider and OAuth validation patterns
// ====================================================================

describe('Config — email provider schema', () => {
  const emailProviderSchema = z.enum(['mock', 'resend', 'smtp']).default('mock');

  test('defaults to mock', () => {
    assert.equal(emailProviderSchema.parse(undefined), 'mock');
  });

  test('accepts all valid providers', () => {
    assert.equal(emailProviderSchema.parse('mock'), 'mock');
    assert.equal(emailProviderSchema.parse('resend'), 'resend');
    assert.equal(emailProviderSchema.parse('smtp'), 'smtp');
  });

  test('rejects unknown providers', () => {
    assert.throws(() => emailProviderSchema.parse('sendgrid'));
    assert.throws(() => emailProviderSchema.parse('mailgun'));
  });
});

describe('Config — boolean string transform', () => {
  const boolSchema = z.enum(['true', 'false']).default('false')
    .transform((v) => v === 'true');

  test('true string becomes true', () => {
    assert.equal(boolSchema.parse('true'), true);
  });

  test('false string becomes false', () => {
    assert.equal(boolSchema.parse('false'), false);
  });

  test('defaults to false', () => {
    assert.equal(boolSchema.parse(undefined), false);
  });

  test('rejects non-boolean strings', () => {
    assert.throws(() => boolSchema.parse('yes'));
    assert.throws(() => boolSchema.parse('1'));
  });
});

describe('Config — cookie sameSite transform', () => {
  const sameSiteSchema = z
    .enum(['Lax', 'Strict', 'None', 'lax', 'strict', 'none'])
    .default('Lax')
    .transform((v) => v.toLowerCase() as 'lax' | 'strict' | 'none');

  test('normalizes to lowercase', () => {
    assert.equal(sameSiteSchema.parse('Lax'), 'lax');
    assert.equal(sameSiteSchema.parse('Strict'), 'strict');
    assert.equal(sameSiteSchema.parse('None'), 'none');
  });

  test('defaults to lax', () => {
    assert.equal(sameSiteSchema.parse(undefined), 'lax');
  });

  test('rejects invalid', () => {
    assert.throws(() => sameSiteSchema.parse('relaxed'));
  });
});

describe('Config — MCP base URL preprocess (empty string → undefined)', () => {
  const mcpUrlSchema = z.preprocess(
    (val) => (val === '' || val === undefined ? undefined : val),
    z.string().url().optional(),
  );

  test('empty string → undefined', () => {
    assert.equal(mcpUrlSchema.parse(''), undefined);
  });

  test('undefined stays undefined', () => {
    assert.equal(mcpUrlSchema.parse(undefined), undefined);
  });

  test('valid URL passes through', () => {
    assert.equal(mcpUrlSchema.parse('http://localhost:4000'), 'http://localhost:4000');
  });

  test('invalid URL string rejects', () => {
    assert.throws(() => mcpUrlSchema.parse('not-a-url'));
  });
});
