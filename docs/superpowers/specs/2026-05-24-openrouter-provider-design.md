# S3b — OpenRouter Provider Integration

## Problem

`AI_PROVIDER` supports `anthropic | openai | google | mock`. OpenRouter was removed in PR-A but OSS users need it — single API key gives access to 200+ models. Re-adding is straightforward because OpenRouter uses the OpenAI-compatible chat completions API.

## Decision

Add `'openrouter'` as a provider option with a curated allowlist of ~8 models. Piggyback on the existing OpenAI request builder — only differences are base URL and two extra HTTP headers.

## Touch Points

### 1. Env config — `backend/src/config/env.ts`

Add `'openrouter'` to `AI_PROVIDER` Zod enum:

```typescript
AI_PROVIDER: z.enum(['openai', 'anthropic', 'google', 'openrouter', 'mock'])
```

Add OpenRouter defaults in `getAIConfig()`:

```typescript
case 'openrouter':
  return {
    provider: 'openrouter',
    apiKey: env.AI_API_KEY || env.OPENROUTER_API_KEY,
    baseUrl: env.AI_BASE_URL || 'https://openrouter.ai/api/v1',
    model: env.AI_MODEL || 'anthropic/claude-sonnet-4-6',
    modelPlanner: env.AI_MODEL_PLANNER || 'anthropic/claude-sonnet-4-6',
    modelDefault: env.AI_MODEL_DEFAULT || 'anthropic/claude-sonnet-4-6',
    modelValidation: env.AI_MODEL_VALIDATION || 'anthropic/claude-haiku-4-5',
  };
```

New env var: `OPENROUTER_API_KEY` (alias for `AI_API_KEY` when provider is openrouter).

### 2. DB schema migration

```sql
ALTER TYPE ai_provider ADD VALUE 'openrouter';
```

Drizzle enum in `backend/src/db/schema.ts`:

```typescript
export const aiProviderEnum = pgEnum('ai_provider', [
  'anthropic', 'openai', 'google', 'openrouter'
]);
```

### 3. AI Service — `backend/src/services/ai/AIService.ts`

In `buildOpenAIRequest()`, add OpenRouter-specific headers:

```typescript
if (this.provider === 'openrouter') {
  headers['HTTP-Referer'] = 'https://akis.dev';
  headers['X-Title'] = 'AKIS Platform';
}
```

No other changes to request/response handling — OpenRouter returns standard OpenAI chat completion responses.

Provider detection in `createAIService()`:
- Key prefix `sk-or-` → openrouter
- Model prefix `anthropic/`, `openai/`, `google/`, `meta-llama/`, `mistralai/`, `deepseek/` with `/` separator → openrouter

### 4. User AI keys — `backend/src/services/ai/user-ai-keys.ts`

Add `'openrouter'` to `AIKeyProvider` type:

```typescript
type AIKeyProvider = 'anthropic' | 'openai' | 'google' | 'openrouter';
```

Key validation: OpenRouter keys start with `sk-or-v1-` (64+ chars).

### 5. Model allowlist — `backend/src/services/ai/modelAllowlist.ts`

Curated OpenRouter models:

```typescript
openrouter: [
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-haiku-4-5',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-1.5-pro',
  'google/gemini-2.0-flash',
  'meta-llama/llama-3.1-70b-instruct',
  'deepseek/deepseek-chat-v3',
]
```

Note: OpenRouter model IDs use `provider/model` format. `detectProviderFromModel()` needs a new case: if model contains `/` and provider is `'openrouter'`, accept it.

### 6. Pricing — `backend/src/services/ai/pricing.ts`

Add OpenRouter model pricing (per 1M tokens):

| Model | Input | Output |
|---|---|---|
| anthropic/claude-sonnet-4-6 | $3.00 | $15.00 |
| anthropic/claude-haiku-4-5 | $0.80 | $4.00 |
| openai/gpt-4o | $2.50 | $10.00 |
| openai/gpt-4o-mini | $0.15 | $0.60 |
| google/gemini-1.5-pro | $1.25 | $5.00 |
| google/gemini-2.0-flash | $0.10 | $0.40 |
| meta-llama/llama-3.1-70b-instruct | $0.52 | $0.75 |
| deepseek/deepseek-chat-v3 | $0.27 | $1.10 |

OpenRouter adds ~0% markup on most models. These prices should be verified against OpenRouter's pricing page at implementation time.

### 7. Frontend — AI Keys Settings

Add OpenRouter provider card in Settings → AI Keys tab. Same pattern as existing Anthropic/OpenAI/Google cards:

- Provider logo/icon + name
- API key input (masked)
- Model selector dropdown (from allowlist)
- "Test connection" button (makes a minimal API call)
- Status indicator (connected/disconnected)

Provider card order: Anthropic → OpenAI → Google → OpenRouter (last, as "multi-model gateway" positioning).

OpenRouter card subtitle: "200+ model, tek API key" (TR) / "200+ models, single API key" (EN)

### 8. Scribe model allowlist

`AI_SCRIBE_MODEL_ALLOWLIST` env var already exists. For OpenRouter, the default Scribe allowlist:

```typescript
openrouter: [
  'anthropic/claude-sonnet-4-6',
  'openai/gpt-4o',
  'google/gemini-1.5-pro',
]
```

Only strong planning models — no small/fast models for Scribe.

## Request Flow

```
User selects OpenRouter + enters sk-or-v1-... key
  → createAIService({ provider: 'openrouter', ... })
  → buildOpenAIRequest() with:
      - baseUrl: https://openrouter.ai/api/v1
      - Authorization: Bearer sk-or-v1-...
      - HTTP-Referer: https://akis.dev
      - X-Title: AKIS Platform
      - model: "anthropic/claude-sonnet-4-6"
  → parseOpenAIResponse() (standard OpenAI format)
  → AICallMetrics recorded with provider: 'openrouter', model: 'anthropic/claude-sonnet-4-6'
```

## Acceptance Criteria

- [ ] `AI_PROVIDER=openrouter` accepted in env config
- [ ] DB migration adds `'openrouter'` to `ai_provider` enum
- [ ] OpenRouter requests use OpenAI-compatible endpoint with extra headers
- [ ] Key prefix `sk-or-` auto-detected as openrouter
- [ ] 8 curated models in allowlist
- [ ] Pricing map covers all allowlisted models
- [ ] User can add OpenRouter API key in Settings → AI Keys
- [ ] Model selector shows curated allowlist
- [ ] Pipeline runs successfully with OpenRouter provider
- [ ] `job_ai_calls` records provider as `'openrouter'` with correct model
- [ ] Cost estimation works for OpenRouter models
- [ ] i18n: TR + EN for provider card text

## Out of Scope

- Dynamic model list from OpenRouter API (future — `/api/v1/models` endpoint)
- OpenRouter-specific features: fallback routing, prompt caching, rate limit handling
- OpenRouter OAuth (they use simple API keys, not OAuth)
- Free-tier models (some OpenRouter models are free — not in curated list)
- Per-model capability detection (context window, vision, etc.)

## Risks

- **Pricing drift:** OpenRouter prices change frequently. Hardcoded pricing map will drift. Acceptable for MVP; future improvement could fetch from `/api/v1/models`.
- **Model removal:** OpenRouter may deprecate models. Allowlist should be easy to update.
- **Rate limits:** OpenRouter has per-key rate limits that differ from direct provider limits. Existing retry logic should handle this, but error codes may differ.
