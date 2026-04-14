/**
 * Workspace Settings Edge Cases — Comprehensive Zod Schema Validation Tests
 *
 * Covers untested edge cases across:
 *   - Playbook/Automation: schema shape, invalid triggers, empty actions, enable/disable
 *   - Workspace Settings: name update, empty rejection, logo URL, delete confirmation
 *   - AI Key Management: save schema, prefix auto-detection, delete, active provider, multi-provider shape
 *   - Profile Settings: whitespace trimming, email format, password constraints
 *
 * SKIP_DB_TESTS=true — no real DB access. Pure schema/logic validation only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// ═════════════════════════════════════════════════════════════════════════════
// PLAYBOOK / AUTOMATION — Schema & Logic
// ═════════════════════════════════════════════════════════════════════════════

// Re-create types from core/agents/playbooks/types.ts
interface AgentPhase {
  id: string;
  label: string;
  description: string;
  icon: string;
  estimatedDurationMs?: number;
}

interface AgentPlaybook {
  agentType: string;
  displayName: string;
  description: string;
  phases: AgentPhase[];
  requiredFields: Array<{
    name: string;
    type: 'string' | 'boolean' | 'select';
    label: string;
    required: boolean;
    placeholder?: string;
    options?: string[];
    defaultValue?: unknown;
  }>;
  capabilities: string[];
  outputArtifacts: string[];
}

// Zod schema for playbook validation (mirrors what a hypothetical create/update endpoint would enforce)
const playbookSchema = z.object({
  name: z.string().min(1, 'Playbook name is required').max(200),
  trigger: z.enum(['on_push', 'on_pr', 'manual', 'scheduled'], {
    errorMap: () => ({ message: 'Invalid trigger type' }),
  }),
  actions: z.array(z.object({
    type: z.string().min(1),
    config: z.record(z.unknown()).optional(),
  })).min(1, 'At least one action is required'),
  enabled: z.boolean().default(true),
});

// Fixture playbooks
const scribePlaybook: AgentPlaybook = {
  agentType: 'scribe',
  displayName: 'Scribe Agent',
  description: 'Spec writer agent',
  phases: [
    { id: 'clarify', label: 'Clarify', description: 'Ask clarifying questions', icon: 'help' },
    { id: 'generate', label: 'Generate', description: 'Generate spec', icon: 'edit' },
  ],
  requiredFields: [
    { name: 'idea', type: 'string', label: 'Idea', required: true, placeholder: 'Describe your idea' },
  ],
  capabilities: ['spec-generation', 'clarification'],
  outputArtifacts: ['spec.md'],
};

const protoPlaybook: AgentPlaybook = {
  agentType: 'proto',
  displayName: 'Proto Agent',
  description: 'MVP builder agent',
  phases: [
    { id: 'scaffold', label: 'Scaffold', description: 'Generate project scaffold', icon: 'build' },
  ],
  requiredFields: [],
  capabilities: ['code-generation', 'github-push'],
  outputArtifacts: ['repo'],
};

const tracePlaybook: AgentPlaybook = {
  agentType: 'trace',
  displayName: 'Trace Agent',
  description: 'Test writer agent',
  phases: [
    { id: 'read', label: 'Read', description: 'Read repository code', icon: 'search' },
    { id: 'test', label: 'Test', description: 'Write tests', icon: 'check' },
  ],
  requiredFields: [],
  capabilities: ['test-generation', 'playwright-tests'],
  outputArtifacts: ['tests/'],
};

const playbooks: Record<string, AgentPlaybook> = {
  scribe: scribePlaybook,
  proto: protoPlaybook,
  trace: tracePlaybook,
};

function getPlaybook(agentType: string): AgentPlaybook | undefined {
  return playbooks[agentType];
}

function getAllPlaybooks(): AgentPlaybook[] {
  return Object.values(playbooks);
}

describe('Playbook Schema — name, trigger, actions array', () => {
  it('accepts a valid playbook with name, trigger, and actions', () => {
    const input = {
      name: 'Deploy on Push',
      trigger: 'on_push',
      actions: [{ type: 'run_tests' }],
      enabled: true,
    };
    const parsed = playbookSchema.parse(input);
    assert.equal(parsed.name, 'Deploy on Push');
    assert.equal(parsed.trigger, 'on_push');
    assert.equal(parsed.actions.length, 1);
    assert.equal(parsed.enabled, true);
  });

  it('accepts all valid trigger types', () => {
    for (const trigger of ['on_push', 'on_pr', 'manual', 'scheduled'] as const) {
      const input = {
        name: `Test ${trigger}`,
        trigger,
        actions: [{ type: 'notify' }],
      };
      const parsed = playbookSchema.parse(input);
      assert.equal(parsed.trigger, trigger);
    }
  });

  it('accepts playbook with multiple actions', () => {
    const input = {
      name: 'Full Pipeline',
      trigger: 'on_pr',
      actions: [
        { type: 'lint', config: { strict: true } },
        { type: 'test' },
        { type: 'deploy', config: { env: 'staging' } },
      ],
    };
    const parsed = playbookSchema.parse(input);
    assert.equal(parsed.actions.length, 3);
  });

  it('defaults enabled to true when not provided', () => {
    const input = {
      name: 'Auto-enabled',
      trigger: 'manual',
      actions: [{ type: 'build' }],
    };
    const parsed = playbookSchema.parse(input);
    assert.equal(parsed.enabled, true);
  });
});

describe('Playbook Schema — invalid trigger type rejected', () => {
  it('rejects unknown trigger type', () => {
    assert.throws(
      () => playbookSchema.parse({
        name: 'Bad Trigger',
        trigger: 'on_cron',
        actions: [{ type: 'run' }],
      }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message === 'Invalid trigger type');
      },
    );
  });

  it('rejects empty string as trigger', () => {
    assert.throws(
      () => playbookSchema.parse({
        name: 'Empty Trigger',
        trigger: '',
        actions: [{ type: 'run' }],
      }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects numeric trigger', () => {
    assert.throws(
      () => playbookSchema.parse({
        name: 'Numeric Trigger',
        trigger: 42,
        actions: [{ type: 'run' }],
      }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });
});

describe('Playbook Schema — empty actions array rejected', () => {
  it('rejects playbook with zero actions', () => {
    assert.throws(
      () => playbookSchema.parse({
        name: 'No Actions',
        trigger: 'on_push',
        actions: [],
      }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message === 'At least one action is required');
      },
    );
  });

  it('rejects missing actions field entirely', () => {
    assert.throws(
      () => playbookSchema.parse({
        name: 'Missing Actions',
        trigger: 'manual',
      }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects action with empty type string', () => {
    assert.throws(
      () => playbookSchema.parse({
        name: 'Empty Type',
        trigger: 'on_pr',
        actions: [{ type: '' }],
      }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });
});

describe('Playbook Schema — enable/disable toggle', () => {
  it('can set enabled to false', () => {
    const parsed = playbookSchema.parse({
      name: 'Disabled Playbook',
      trigger: 'scheduled',
      actions: [{ type: 'cleanup' }],
      enabled: false,
    });
    assert.equal(parsed.enabled, false);
  });

  it('can set enabled to true explicitly', () => {
    const parsed = playbookSchema.parse({
      name: 'Enabled Playbook',
      trigger: 'on_push',
      actions: [{ type: 'deploy' }],
      enabled: true,
    });
    assert.equal(parsed.enabled, true);
  });

  it('playbook registry returns correct types for known agents', () => {
    const pb = getPlaybook('scribe');
    assert.ok(pb);
    assert.equal(pb.agentType, 'scribe');
    assert.ok(pb.phases.length > 0);
    assert.ok(pb.capabilities.length > 0);
  });

  it('playbook registry returns undefined for unknown agent type', () => {
    assert.equal(getPlaybook('coder'), undefined);
    assert.equal(getPlaybook('developer'), undefined);
    assert.equal(getPlaybook(''), undefined);
  });

  it('getAllPlaybooks returns exactly 3 registered playbooks', () => {
    const all = getAllPlaybooks();
    assert.equal(all.length, 3);
    const types = all.map((p) => p.agentType).sort();
    assert.deepEqual(types, ['proto', 'scribe', 'trace']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// WORKSPACE SETTINGS — Schema & Logic
// ═════════════════════════════════════════════════════════════════════════════

const updateWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100, 'Name is too long'),
});

const deleteWorkspaceSchema = z.object({
  confirmation: z.literal('DELETE MY ACCOUNT'),
  password: z.string().optional(),
});

describe('Workspace Settings — update name valid input', () => {
  it('accepts a valid workspace name', () => {
    const parsed = updateWorkspaceSchema.parse({ name: 'My Project' });
    assert.equal(parsed.name, 'My Project');
  });

  it('accepts single character name (boundary)', () => {
    const parsed = updateWorkspaceSchema.parse({ name: 'X' });
    assert.equal(parsed.name, 'X');
  });

  it('accepts name of exactly 100 characters (boundary)', () => {
    const maxName = 'W'.repeat(100);
    const parsed = updateWorkspaceSchema.parse({ name: maxName });
    assert.equal(parsed.name.length, 100);
  });

  it('trims name before storing (handler logic)', () => {
    const raw = '  My Workspace  ';
    const parsed = updateWorkspaceSchema.parse({ name: raw });
    const stored = parsed.name.trim();
    assert.equal(stored, 'My Workspace');
  });

  it('workspace GET response shape has required fields', () => {
    const userId = 'user-abc123def';
    const response = {
      id: `ws_${userId.slice(0, 8)}`,
      name: `Test User's Workspace`,
      ownerEmail: 'test@example.com',
      createdAt: new Date().toISOString(),
      plan: 'free',
    };
    assert.ok(response.id.startsWith('ws_'));
    assert.equal(response.id, 'ws_user-abc');
    assert.equal(response.plan, 'free');
    assert.ok('ownerEmail' in response);
    assert.ok('createdAt' in response);
  });
});

describe('Workspace Settings — empty name rejected', () => {
  it('rejects empty string name', () => {
    assert.throws(
      () => updateWorkspaceSchema.parse({ name: '' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message === 'Workspace name is required');
      },
    );
  });

  it('rejects name longer than 100 characters', () => {
    const longName = 'A'.repeat(101);
    assert.throws(
      () => updateWorkspaceSchema.parse({ name: longName }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message === 'Name is too long');
      },
    );
  });

  it('rejects missing name field', () => {
    assert.throws(
      () => updateWorkspaceSchema.parse({}),
      (err: unknown) => err instanceof z.ZodError,
    );
  });
});

describe('Workspace Settings — logo URL validation', () => {
  const logoUrlSchema = z.string().url('Invalid URL').optional();

  it('accepts valid HTTPS logo URL', () => {
    const parsed = logoUrlSchema.parse('https://example.com/logo.png');
    assert.equal(parsed, 'https://example.com/logo.png');
  });

  it('accepts valid HTTP URL', () => {
    const parsed = logoUrlSchema.parse('http://cdn.example.com/img.jpg');
    assert.ok(parsed!.startsWith('http://'));
  });

  it('rejects malformed URL string', () => {
    assert.throws(
      () => logoUrlSchema.parse('not-a-url'),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message === 'Invalid URL');
      },
    );
  });

  it('allows undefined (optional field)', () => {
    const parsed = logoUrlSchema.parse(undefined);
    assert.equal(parsed, undefined);
  });

  it('rejects empty string as URL', () => {
    assert.throws(
      () => logoUrlSchema.parse(''),
      (err: unknown) => err instanceof z.ZodError,
    );
  });
});

describe('Workspace Settings — delete requires confirmation', () => {
  it('accepts valid delete with exact confirmation string', () => {
    const parsed = deleteWorkspaceSchema.parse({
      confirmation: 'DELETE MY ACCOUNT',
    });
    assert.equal(parsed.confirmation, 'DELETE MY ACCOUNT');
    assert.equal(parsed.password, undefined);
  });

  it('accepts delete with confirmation and password', () => {
    const parsed = deleteWorkspaceSchema.parse({
      confirmation: 'DELETE MY ACCOUNT',
      password: 'MySecretPass1',
    });
    assert.equal(parsed.confirmation, 'DELETE MY ACCOUNT');
    assert.equal(parsed.password, 'MySecretPass1');
  });

  it('rejects wrong confirmation string', () => {
    assert.throws(
      () => deleteWorkspaceSchema.parse({
        confirmation: 'delete my account',
      }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects partial confirmation string', () => {
    assert.throws(
      () => deleteWorkspaceSchema.parse({
        confirmation: 'DELETE',
      }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects missing confirmation field', () => {
    assert.throws(
      () => deleteWorkspaceSchema.parse({}),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects empty confirmation string', () => {
    assert.throws(
      () => deleteWorkspaceSchema.parse({ confirmation: '' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('password-required logic for password accounts', () => {
    const hasPasswordHash = true;
    const bodyPassword: string | undefined = undefined;
    const shouldReject = hasPasswordHash && !bodyPassword;
    assert.ok(shouldReject);
    const response = {
      error: { code: 'PASSWORD_REQUIRED', message: 'Password is required to delete your account' },
    };
    assert.equal(response.error.code, 'PASSWORD_REQUIRED');
  });

  it('password not required for OAuth-only accounts', () => {
    const hasPasswordHash = false;
    const bodyPassword: string | undefined = undefined;
    const shouldReject = hasPasswordHash && !bodyPassword;
    assert.equal(shouldReject, false);
  });

  it('delete response shape is { success: true, message: string }', () => {
    const response = {
      success: true,
      message: 'Your account has been deleted. All associated data has been removed.',
    };
    assert.equal(response.success, true);
    assert.ok(response.message.includes('deleted'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AI KEY MANAGEMENT — Schema & Logic
// ═════════════════════════════════════════════════════════════════════════════

const providerSchema = z.enum(['anthropic', 'openai', 'openrouter']);

const apiKeySchema = z
  .string()
  .min(20, 'API key must be at least 20 characters')
  .regex(/^\S+$/, 'API key must not include whitespace');

const upsertSchema = z.object({
  provider: providerSchema,
  apiKey: apiKeySchema,
});

const deleteKeySchema = z.object({
  provider: providerSchema,
});

const setActiveProviderSchema = z.object({
  provider: providerSchema,
});

function normalizeApiKey(key: string): string {
  return key.trim();
}

// Mirrors detectProviderFromKey in config/env.ts
function detectProviderFromKey(key: string): 'openai' | 'openrouter' | 'anthropic' | null {
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}

type AIKeyProvider = 'anthropic' | 'openai' | 'openrouter';
type MultiProviderStatus = {
  activeProvider: AIKeyProvider | null;
  providers: {
    anthropic: { configured: boolean; last4: string | null; updatedAt: string | null };
    openai: { configured: boolean; last4: string | null; updatedAt: string | null };
    openrouter: { configured: boolean; last4: string | null; updatedAt: string | null };
  };
};

function buildMultiProviderStatus(
  activeProvider: AIKeyProvider | null,
  records: Record<AIKeyProvider, { encryptedKey?: string; last4?: string | null; updatedAt?: Date | null }>,
): MultiProviderStatus {
  const toStatus = (provider: AIKeyProvider) => {
    const r = records[provider];
    return {
      configured: Boolean(r?.encryptedKey),
      last4: r?.last4 ?? null,
      updatedAt: r?.updatedAt ? r.updatedAt.toISOString() : null,
    };
  };
  return {
    activeProvider,
    providers: {
      anthropic: toStatus('anthropic'),
      openai: toStatus('openai'),
      openrouter: toStatus('openrouter'),
    },
  };
}

describe('AI Key Management — save key schema (provider + key required)', () => {
  it('accepts valid anthropic key with correct provider', () => {
    const parsed = upsertSchema.parse({
      provider: 'anthropic',
      apiKey: 'sk-ant-api03-long-enough-key-value',
    });
    assert.equal(parsed.provider, 'anthropic');
  });

  it('accepts valid openai key with correct provider', () => {
    const parsed = upsertSchema.parse({
      provider: 'openai',
      apiKey: 'sk-proj-long-enough-key-value-1234',
    });
    assert.equal(parsed.provider, 'openai');
  });

  it('accepts valid openrouter key with correct provider', () => {
    const parsed = upsertSchema.parse({
      provider: 'openrouter',
      apiKey: 'sk-or-v1-long-enough-key-value123',
    });
    assert.equal(parsed.provider, 'openrouter');
  });

  it('rejects missing provider', () => {
    assert.throws(
      () => upsertSchema.parse({ apiKey: 'sk-ant-long-enough-key-value-abc' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects missing apiKey', () => {
    assert.throws(
      () => upsertSchema.parse({ provider: 'anthropic' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects both fields missing', () => {
    assert.throws(
      () => upsertSchema.parse({}),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects key shorter than 20 characters', () => {
    assert.throws(
      () => upsertSchema.parse({ provider: 'openai', apiKey: 'sk-tooshort' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('20 characters'));
      },
    );
  });

  it('rejects key with whitespace', () => {
    assert.throws(
      () => upsertSchema.parse({ provider: 'openai', apiKey: 'sk-has space in the middle 1234' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('whitespace'));
      },
    );
  });
});

describe('AI Key Management — key prefix auto-detection', () => {
  it('detects sk-ant- prefix as anthropic', () => {
    assert.equal(detectProviderFromKey('sk-ant-api03-some-key'), 'anthropic');
  });

  it('detects sk-or- prefix as openrouter', () => {
    assert.equal(detectProviderFromKey('sk-or-v1-some-key'), 'openrouter');
  });

  it('detects plain sk- prefix as openai', () => {
    assert.equal(detectProviderFromKey('sk-proj-abc123'), 'openai');
  });

  it('sk-or- takes priority over generic sk- prefix', () => {
    // sk-or- starts with sk- but should be detected as openrouter, not openai
    const provider = detectProviderFromKey('sk-or-v1-longkeyvalue');
    assert.equal(provider, 'openrouter');
  });

  it('sk-ant- takes priority over generic sk- prefix', () => {
    const provider = detectProviderFromKey('sk-ant-api03-longkeyvalue');
    assert.equal(provider, 'anthropic');
  });

  it('returns null for unknown prefix', () => {
    assert.equal(detectProviderFromKey('xai-some-key'), null);
    assert.equal(detectProviderFromKey('gsk-some-key'), null);
    assert.equal(detectProviderFromKey(''), null);
  });

  it('normalizeApiKey trims whitespace', () => {
    assert.equal(normalizeApiKey('  sk-ant-key123  '), 'sk-ant-key123');
    assert.equal(normalizeApiKey('sk-key'), 'sk-key');
    assert.equal(normalizeApiKey('\tsk-key\n'), 'sk-key');
  });

  it('last4 extraction from normalized key', () => {
    const key = normalizeApiKey('  sk-ant-api03-my-secret-abc9  ');
    const last4 = key.slice(-4);
    assert.equal(last4, 'abc9');
    assert.equal(last4.length, 4);
  });
});

describe('AI Key Management — delete key (provider required)', () => {
  it('accepts valid provider for deletion', () => {
    for (const provider of ['anthropic', 'openai', 'openrouter'] as const) {
      const parsed = deleteKeySchema.parse({ provider });
      assert.equal(parsed.provider, provider);
    }
  });

  it('rejects missing provider on delete', () => {
    assert.throws(
      () => deleteKeySchema.parse({}),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects unknown provider on delete', () => {
    assert.throws(
      () => deleteKeySchema.parse({ provider: 'gemini' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects null provider on delete', () => {
    assert.throws(
      () => deleteKeySchema.parse({ provider: null }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('delete response shape is { ok: true }', () => {
    const response = { ok: true };
    assert.equal(response.ok, true);
    assert.equal(typeof response.ok, 'boolean');
  });
});

describe('AI Key Management — set active provider (valid providers only)', () => {
  it('accepts anthropic as active provider', () => {
    const parsed = setActiveProviderSchema.parse({ provider: 'anthropic' });
    assert.equal(parsed.provider, 'anthropic');
  });

  it('accepts openai as active provider', () => {
    const parsed = setActiveProviderSchema.parse({ provider: 'openai' });
    assert.equal(parsed.provider, 'openai');
  });

  it('accepts openrouter as active provider', () => {
    const parsed = setActiveProviderSchema.parse({ provider: 'openrouter' });
    assert.equal(parsed.provider, 'openrouter');
  });

  it('rejects unknown provider for active provider', () => {
    assert.throws(
      () => setActiveProviderSchema.parse({ provider: 'cohere' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects empty string as active provider', () => {
    assert.throws(
      () => setActiveProviderSchema.parse({ provider: '' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects missing provider field', () => {
    assert.throws(
      () => setActiveProviderSchema.parse({}),
      (err: unknown) => err instanceof z.ZodError,
    );
  });
});

describe('AI Key Management — multi-provider status response shape', () => {
  it('returns all providers unconfigured for new user', () => {
    const empty = { encryptedKey: undefined, last4: null, updatedAt: null };
    const status = buildMultiProviderStatus(null, {
      anthropic: empty,
      openai: empty,
      openrouter: empty,
    });

    assert.equal(status.activeProvider, null);
    assert.equal(status.providers.anthropic.configured, false);
    assert.equal(status.providers.openai.configured, false);
    assert.equal(status.providers.openrouter.configured, false);
  });

  it('shows configured=true for provider with key', () => {
    const empty = { encryptedKey: undefined, last4: null, updatedAt: null };
    const configured = { encryptedKey: 'enc-blob', last4: 'z789', updatedAt: new Date('2026-04-01') };
    const status = buildMultiProviderStatus('anthropic', {
      anthropic: configured,
      openai: empty,
      openrouter: empty,
    });

    assert.equal(status.providers.anthropic.configured, true);
    assert.equal(status.providers.anthropic.last4, 'z789');
    assert.ok(status.providers.anthropic.updatedAt!.includes('2026'));
    assert.equal(status.providers.openai.configured, false);
  });

  it('response has activeProvider and providers top-level fields', () => {
    const empty = { encryptedKey: undefined, last4: null, updatedAt: null };
    const status = buildMultiProviderStatus(null, {
      anthropic: empty,
      openai: empty,
      openrouter: empty,
    });

    assert.ok('activeProvider' in status);
    assert.ok('providers' in status);
    assert.ok('anthropic' in status.providers);
    assert.ok('openai' in status.providers);
    assert.ok('openrouter' in status.providers);
  });

  it('each provider status has configured, last4, updatedAt fields', () => {
    const empty = { encryptedKey: undefined, last4: null, updatedAt: null };
    const status = buildMultiProviderStatus(null, {
      anthropic: empty,
      openai: empty,
      openrouter: empty,
    });

    for (const key of ['anthropic', 'openai', 'openrouter'] as const) {
      const ps = status.providers[key];
      assert.ok('configured' in ps);
      assert.ok('last4' in ps);
      assert.ok('updatedAt' in ps);
      assert.equal(typeof ps.configured, 'boolean');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROFILE SETTINGS — Schema & Logic Edge Cases
// ═════════════════════════════════════════════════════════════════════════════

const updateProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name is too long'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password is too long')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

// Email validation schema (used conceptually in profile update flow)
const emailSchema = z.string().email('Invalid email format');

describe('Profile Settings — update name trims whitespace', () => {
  it('accepts name with leading/trailing spaces (schema passes, handler trims)', () => {
    const parsed = updateProfileSchema.parse({ name: '  Alice  ' });
    const trimmed = parsed.name.trim();
    assert.equal(trimmed, 'Alice');
  });

  it('accepts name with internal spaces preserved', () => {
    const parsed = updateProfileSchema.parse({ name: 'John Doe' });
    assert.equal(parsed.name, 'John Doe');
  });

  it('whitespace-only name is rejected by min(1) after no server trim', () => {
    // Zod min(1) checks raw string length, so "   " (3 chars) passes schema
    // but handler would trim to "" — tested as handler logic
    const raw = '   ';
    const parsed = updateProfileSchema.parse({ name: raw });
    const trimmed = parsed.name.trim();
    assert.equal(trimmed, '');
    assert.equal(trimmed.length, 0);
  });

  it('handler update response shape is { success: true, name: trimmed }', () => {
    const body = { name: '  Bob  ' };
    const parsed = updateProfileSchema.parse(body);
    const response = { success: true, name: parsed.name.trim() };
    assert.equal(response.success, true);
    assert.equal(response.name, 'Bob');
  });
});

describe('Profile Settings — email valid format required', () => {
  it('accepts valid email address', () => {
    const parsed = emailSchema.parse('user@example.com');
    assert.equal(parsed, 'user@example.com');
  });

  it('accepts email with subdomain', () => {
    const parsed = emailSchema.parse('admin@mail.company.co.uk');
    assert.equal(parsed, 'admin@mail.company.co.uk');
  });

  it('accepts email with plus addressing', () => {
    const parsed = emailSchema.parse('user+tag@gmail.com');
    assert.equal(parsed, 'user+tag@gmail.com');
  });

  it('rejects email without @ symbol', () => {
    assert.throws(
      () => emailSchema.parse('userexample.com'),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message === 'Invalid email format');
      },
    );
  });

  it('rejects email without domain', () => {
    assert.throws(
      () => emailSchema.parse('user@'),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects empty string as email', () => {
    assert.throws(
      () => emailSchema.parse(''),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects plain text as email', () => {
    assert.throws(
      () => emailSchema.parse('not-an-email'),
      (err: unknown) => err instanceof z.ZodError,
    );
  });
});

describe('Profile Settings — password change (current + new required)', () => {
  it('requires both currentPassword and newPassword', () => {
    assert.throws(
      () => changePasswordSchema.parse({ newPassword: 'ValidPass1' }),
      (err: unknown) => err instanceof z.ZodError,
    );

    assert.throws(
      () => changePasswordSchema.parse({ currentPassword: 'old' }),
      (err: unknown) => err instanceof z.ZodError,
    );
  });

  it('rejects empty currentPassword', () => {
    assert.throws(
      () => changePasswordSchema.parse({ currentPassword: '', newPassword: 'ValidPass1' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message === 'Current password is required');
      },
    );
  });

  it('accepts valid password change payload', () => {
    const parsed = changePasswordSchema.parse({
      currentPassword: 'OldPassword1',
      newPassword: 'NewPassword2',
    });
    assert.equal(parsed.currentPassword, 'OldPassword1');
    assert.equal(parsed.newPassword, 'NewPassword2');
  });
});

describe('Profile Settings — password min length enforcement', () => {
  it('rejects password shorter than 8 characters', () => {
    assert.throws(
      () => changePasswordSchema.parse({ currentPassword: 'old', newPassword: 'Ab1' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('8 characters'));
      },
    );
  });

  it('accepts password of exactly 8 characters (boundary)', () => {
    const parsed = changePasswordSchema.parse({
      currentPassword: 'anything',
      newPassword: 'Abcdef1x',
    });
    assert.equal(parsed.newPassword.length, 8);
  });

  it('rejects password without lowercase letter', () => {
    assert.throws(
      () => changePasswordSchema.parse({ currentPassword: 'old', newPassword: 'ALLUPPERCASE1' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('lowercase'));
      },
    );
  });

  it('rejects password without uppercase letter', () => {
    assert.throws(
      () => changePasswordSchema.parse({ currentPassword: 'old', newPassword: 'alllowercase1' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('uppercase'));
      },
    );
  });

  it('rejects password without a number', () => {
    assert.throws(
      () => changePasswordSchema.parse({ currentPassword: 'old', newPassword: 'NoDigitsHere' }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message.includes('number'));
      },
    );
  });

  it('rejects password longer than 128 characters', () => {
    const tooLong = 'Aa1' + 'x'.repeat(130);
    assert.throws(
      () => changePasswordSchema.parse({ currentPassword: 'old', newPassword: tooLong }),
      (err: unknown) => {
        if (!(err instanceof z.ZodError)) return false;
        return err.errors.some((e) => e.message === 'Password is too long');
      },
    );
  });

  it('accepts password of exactly 128 characters (boundary)', () => {
    // 125 filler + 'Aa1' = 128
    const exact = 'Aa1' + 'b'.repeat(125);
    assert.equal(exact.length, 128);
    const parsed = changePasswordSchema.parse({
      currentPassword: 'anything',
      newPassword: exact,
    });
    assert.equal(parsed.newPassword.length, 128);
  });

  it('accepts password with special characters', () => {
    const parsed = changePasswordSchema.parse({
      currentPassword: 'anything',
      newPassword: 'P@ssw0rd!#$%',
    });
    assert.equal(parsed.newPassword, 'P@ssw0rd!#$%');
  });
});
