/**
 * Unit tests for the Google Gemini direct adapter (P1c).
 *
 * Scope:
 *   1. `buildGoogleRequest` — verifies endpoint key query param, system →
 *      `systemInstruction`, role mapping (assistant → model), and
 *      `generationConfig` placement.
 *   2. `parseGoogleResponse` — verifies candidates → content concat and
 *      usageMetadata → AIUsage map.
 *   3. `createAIService({ provider: 'google' })` returns a RealAIService
 *      (not a mock, not a throw) outside test mode.
 *   4. `detectProviderFromModel('gemini-*')` resolves to 'google'.
 *
 * `buildGoogleRequest` + `parseGoogleResponse` are private methods on
 * RealAIService. Following the pattern of ai-service-multimodal.test.ts,
 * we mirror the production code 1:1 in pure test helpers. If the
 * production method's control-flow drifts from these replicas the tests
 * stop documenting reality — gate is the comment + this header.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectProviderFromModel as detectFromModelAllowlist } from '../../src/services/ai/modelAllowlist.js';

// ─── Test replicas of private RealAIService methods ────────────────────────

interface ReplicaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Mirror of `RealAIService.buildGoogleRequest`. Keep in sync with AIService.ts.
 */
function buildGoogleRequest(
  cfg: { baseUrl: string; apiKey: string },
  messages: ReplicaChatMessage[],
  model: string,
  options: { temperature?: number; maxTokens?: number },
): { endpoint: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const endpoint =
    `${cfg.baseUrl}/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(cfg.apiKey)}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const systemMessages = messages.filter((m) => m.role === 'system');
  const nonSystemMessages = messages.filter((m) => m.role !== 'system');

  const contents = nonSystemMessages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      maxOutputTokens: options.maxTokens ?? 4096,
    },
  };

  if (systemMessages.length > 0) {
    const systemText = systemMessages.map((m) => m.content).join('\n\n');
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  return { endpoint, headers, body };
}

/**
 * Mirror of `RealAIService.parseGoogleResponse`. Keep in sync with AIService.ts.
 * Returns null on empty candidates so the test can assert the throw branch.
 */
function parseGoogleResponse(data: Record<string, unknown>): {
  content: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
} {
  const candidates = (data.candidates ?? []) as Array<Record<string, unknown>>;
  if (candidates.length === 0) {
    throw new Error('Gemini API returned no candidates');
  }

  const firstCandidate = candidates[0];
  const candidateContent = firstCandidate.content as
    | { parts?: Array<{ text?: string }> }
    | undefined;
  const parts = candidateContent?.parts ?? [];
  const content = parts.map((p) => p.text ?? '').join('');

  const rawUsage = data.usageMetadata as
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined;
  const usage = rawUsage
    ? {
        inputTokens: rawUsage.promptTokenCount,
        outputTokens: rawUsage.candidatesTokenCount,
        totalTokens:
          rawUsage.totalTokenCount ??
          (rawUsage.promptTokenCount ?? 0) + (rawUsage.candidatesTokenCount ?? 0),
      }
    : undefined;

  return { content, usage };
}

// ─── buildGoogleRequest ────────────────────────────────────────────────────

describe('buildGoogleRequest (P1c)', () => {
  const cfg = {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIzaTESTKEY123',
  };

  it('embeds the API key as a query string (NOT a header) on the endpoint', () => {
    const { endpoint, headers } = buildGoogleRequest(
      cfg,
      [{ role: 'user', content: 'hello' }],
      'gemini-1.5-flash',
      {},
    );

    assert.match(endpoint, /\?key=AIzaTESTKEY123$/);
    assert.match(endpoint, /\/models\/gemini-1\.5-flash:generateContent/);
    // Auth header must NOT be set — Gemini auths via query string only.
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers['Authorization'], undefined);
    assert.equal(headers['x-goog-api-key'], undefined);
  });

  it('URL-encodes the API key + model to defend against odd characters', () => {
    const odd = buildGoogleRequest(
      { baseUrl: cfg.baseUrl, apiKey: 'key with space' },
      [{ role: 'user', content: 'x' }],
      'gemini-1.5-flash',
      {},
    );
    assert.match(odd.endpoint, /\?key=key%20with%20space$/);
  });

  it('puts system prompts under systemInstruction (not in contents[])', () => {
    const { body } = buildGoogleRequest(
      cfg,
      [
        { role: 'system', content: 'You are Scribe.' },
        { role: 'user', content: 'Generate a spec.' },
      ],
      'gemini-1.5-flash',
      {},
    );

    const sys = body.systemInstruction as { parts: Array<{ text: string }> };
    assert.equal(sys.parts[0].text, 'You are Scribe.');

    const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    assert.equal(contents.length, 1);
    assert.equal(contents[0].role, 'user');
    assert.equal(contents[0].parts[0].text, 'Generate a spec.');
  });

  it("maps role 'assistant' → 'model' (Gemini's role name for AI turns)", () => {
    const { body } = buildGoogleRequest(
      cfg,
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'more' },
      ],
      'gemini-1.5-flash',
      {},
    );

    const contents = body.contents as Array<{ role: string }>;
    assert.deepEqual(
      contents.map((c) => c.role),
      ['user', 'model', 'user'],
    );
  });

  it('puts temperature + maxOutputTokens under generationConfig', () => {
    const { body } = buildGoogleRequest(
      cfg,
      [{ role: 'user', content: 'x' }],
      'gemini-1.5-flash',
      { temperature: 0.2, maxTokens: 2048 },
    );

    const cfg2 = body.generationConfig as { temperature?: number; maxOutputTokens: number };
    assert.equal(cfg2.temperature, 0.2);
    assert.equal(cfg2.maxOutputTokens, 2048);
  });

  it('defaults maxOutputTokens to 4096 when not provided', () => {
    const { body } = buildGoogleRequest(
      cfg,
      [{ role: 'user', content: 'x' }],
      'gemini-1.5-flash',
      {},
    );

    const cfg2 = body.generationConfig as { maxOutputTokens: number };
    assert.equal(cfg2.maxOutputTokens, 4096);
  });

  it('omits temperature key when not provided (preserves Gemini default)', () => {
    const { body } = buildGoogleRequest(
      cfg,
      [{ role: 'user', content: 'x' }],
      'gemini-1.5-flash',
      {},
    );

    const cfg2 = body.generationConfig as Record<string, unknown>;
    assert.equal('temperature' in cfg2, false);
  });

  it('concatenates multiple system messages with \\n\\n (matches Anthropic builder)', () => {
    const { body } = buildGoogleRequest(
      cfg,
      [
        { role: 'system', content: 'A' },
        { role: 'system', content: 'B' },
        { role: 'user', content: 'q' },
      ],
      'gemini-1.5-flash',
      {},
    );
    const sys = body.systemInstruction as { parts: Array<{ text: string }> };
    assert.equal(sys.parts[0].text, 'A\n\nB');
  });
});

// ─── parseGoogleResponse ───────────────────────────────────────────────────

describe('parseGoogleResponse (P1c)', () => {
  it('joins candidate text parts into a single string', () => {
    const data = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello ' }, { text: 'world.' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 7,
        candidatesTokenCount: 4,
        totalTokenCount: 11,
      },
    };

    const { content, usage } = parseGoogleResponse(data);
    assert.equal(content, 'Hello world.');
    assert.deepEqual(usage, { inputTokens: 7, outputTokens: 4, totalTokens: 11 });
  });

  it('handles single-part candidates', () => {
    const { content } = parseGoogleResponse({
      candidates: [{ content: { parts: [{ text: 'just one' }] } }],
    });
    assert.equal(content, 'just one');
  });

  it('returns content="" when parts are missing', () => {
    const { content } = parseGoogleResponse({
      candidates: [{ content: {} }],
    });
    assert.equal(content, '');
  });

  it('computes totalTokens when usageMetadata lacks it', () => {
    const { usage } = parseGoogleResponse({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    });
    assert.equal(usage?.totalTokens, 8);
  });

  it('omits usage entirely when usageMetadata is absent', () => {
    const { usage } = parseGoogleResponse({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });
    assert.equal(usage, undefined);
  });

  it('throws when candidates array is empty (Gemini safety filter blocked)', () => {
    assert.throws(
      () => parseGoogleResponse({ candidates: [] }),
      /Gemini API returned no candidates/,
    );
  });

  it('throws when candidates field is missing entirely', () => {
    assert.throws(() => parseGoogleResponse({}), /Gemini API returned no candidates/);
  });
});

// ─── detectProviderFromModel (gemini- prefix) ──────────────────────────────

describe('detectProviderFromModel — Gemini (P1c)', () => {
  it('detects all default Gemini models as google', () => {
    assert.equal(detectFromModelAllowlist('gemini-1.5-flash'), 'google');
    assert.equal(detectFromModelAllowlist('gemini-1.5-pro'), 'google');
    assert.equal(detectFromModelAllowlist('gemini-1.5-flash-8b'), 'google');
  });

  it('detects future Gemini models by prefix (forward-compatible)', () => {
    assert.equal(detectFromModelAllowlist('gemini-2.0-flash-exp'), 'google');
    assert.equal(detectFromModelAllowlist('gemini-2.5-pro'), 'google');
  });

  it('does not mistake unrelated names for Gemini', () => {
    assert.equal(detectFromModelAllowlist('claude-haiku-4-5-20251001'), 'anthropic');
    assert.equal(detectFromModelAllowlist('gpt-4o'), 'openai');
    assert.equal(detectFromModelAllowlist('mistral-small'), null);
  });
});

// ─── createAIService factory for provider='google' ─────────────────────────

describe('createAIService — Google Gemini (P1c)', () => {
  it("returns a RealAIService (not mock, not a throw) when provider='google' + apiKey present", async () => {
    // NODE_ENV=test short-circuits to MockAIService; flip to production so the
    // google branch is exercised exactly like aiservice-openai-blocked.test.ts.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { createAIService } = await import('../../src/services/ai/AIService.js');
      const config = {
        provider: 'google' as const,
        apiKey: 'AIzaSyTEST_KEY_PLACEHOLDER',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelDefault: 'gemini-1.5-flash',
        modelPlanner: 'gemini-1.5-flash',
        modelValidation: 'gemini-1.5-pro',
      };

      const service = createAIService(config);
      const summary = service.getConfigSummary();

      assert.equal(summary.provider, 'google');
      assert.equal(summary.models.default, 'gemini-1.5-flash');
      assert.equal(summary.models.validation, 'gemini-1.5-pro');
      assert.equal(summary.hasApiKey, true);
      // Must NOT be the mock provider — RealAIService surfaces the real baseUrl.
      assert.match(summary.baseUrl, /generativelanguage\.googleapis\.com/);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("falls back to mock when provider='google' but apiKey missing (matches Anthropic behaviour)", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { createAIService } = await import('../../src/services/ai/AIService.js');
      const config = {
        provider: 'google' as const,
        // apiKey intentionally missing
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        modelDefault: 'gemini-1.5-flash',
        modelPlanner: 'gemini-1.5-flash',
        modelValidation: 'gemini-1.5-flash',
      };

      const service = createAIService(config);
      const summary = service.getConfigSummary();
      assert.equal(summary.provider, 'mock');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
