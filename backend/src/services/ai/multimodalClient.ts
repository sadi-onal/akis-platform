/**
 * Multimodal Anthropic client helper.
 *
 * Dedicated lightweight client for sending user messages that include image
 * content blocks (PNG / JPEG / GIF / WebP) to Anthropic's Messages API. The
 * main AIService.generateWorkArtifact path is text-only by design; when an
 * agent has image attachments it calls this helper instead of rewriting the
 * full request builder.
 *
 * Part of issue #402 (multimodal pixels → Anthropic). Step 1: helper + tests.
 * Step 2 (follow-up): wire into ScribeAIDeps so Scribe actually uses pixels.
 */
/**
 * Anthropic Messages API image content block shape. Defined locally to keep
 * this helper self-contained; FileUploadService (introduced by PR #403) also
 * exports an identical type and can import from here once that branch lands.
 */
export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface AnthropicMultimodalRequest {
  /** Raw Anthropic API key — never logged. */
  apiKey: string;
  /** Resolved model ID (e.g. `claude-sonnet-4-5-20250929`). */
  model: string;
  /** System prompt (prepended as `system` field in the Anthropic request). */
  systemPrompt: string;
  /** User text content — travels alongside images in the same user message. */
  userText: string;
  /** Ordered image blocks. Empty array falls back to a plain text request. */
  images: readonly AnthropicImageBlock[];
  /** Anthropic API base URL (default `https://api.anthropic.com`). */
  baseUrl?: string;
  /** Max output tokens. Anthropic default is 4096; callers often want more. */
  maxTokens?: number;
  /** Sampling temperature. Pipeline agents run at 0 (deterministic). */
  temperature?: number;
  /** Optional dependency injection of `fetch` for tests. */
  fetchFn?: typeof fetch;
}

export interface AnthropicMultimodalResponse {
  content: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Raw Anthropic stop_reason so callers can differentiate max-tokens vs. end. */
  stopReason?: string;
}

export class AnthropicMultimodalError extends Error {
  constructor(
    message: string,
    readonly code: 'IMAGE_API_ERROR' | 'IMAGE_MODEL_UNSUPPORTED' | 'IMAGE_BAD_RESPONSE',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AnthropicMultimodalError';
  }
}

/**
 * Build the request body for Anthropic's Messages API given system prompt +
 * user text + image blocks. Exported so callers that already have an HTTP
 * client can reuse the shape; the helper below uses it internally.
 */
export function buildAnthropicMultimodalBody(input: {
  model: string;
  systemPrompt: string;
  userText: string;
  images: readonly AnthropicImageBlock[];
  maxTokens?: number;
  temperature?: number;
}): Record<string, unknown> {
  const contentBlocks: Array<{ type: 'text'; text: string } | AnthropicImageBlock> = [];
  // Images go first so the model sees them before it processes the instructions
  // (mirrors the Anthropic docs sample).
  for (const img of input.images) {
    contentBlocks.push(img);
  }
  contentBlocks.push({ type: 'text', text: input.userText });

  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens ?? 4096,
    system: input.systemPrompt,
    messages: [
      {
        role: 'user',
        content: contentBlocks,
      },
    ],
  };
  if (input.temperature !== undefined) {
    body.temperature = input.temperature;
  }
  return body;
}

/**
 * Call Anthropic's Messages API with a multimodal user turn. Returns just
 * the first text block's content plus usage numbers.
 *
 * Throws {@link AnthropicMultimodalError} with a typed code on non-200 or
 * malformed responses; callers can decide whether to fall back to text-only.
 */
export async function callAnthropicMultimodal(
  req: AnthropicMultimodalRequest,
): Promise<AnthropicMultimodalResponse> {
  const baseUrl = req.baseUrl ?? 'https://api.anthropic.com';
  const fetchImpl = req.fetchFn ?? fetch;

  const body = buildAnthropicMultimodalBody({
    model: req.model,
    systemPrompt: req.systemPrompt,
    userText: req.userText,
    images: req.images,
    maxTokens: req.maxTokens,
    temperature: req.temperature,
  });

  const res = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Anthropic returns 400 with `"error": {"type": "invalid_request_error"}` when
    // the model doesn't support images. Upgrade the code so callers can branch.
    const lower = text.toLowerCase();
    if (res.status === 400 && (lower.includes('image') || lower.includes('vision'))) {
      throw new AnthropicMultimodalError(
        `Model does not support image input: ${text.slice(0, 200)}`,
        'IMAGE_MODEL_UNSUPPORTED',
        res.status,
      );
    }
    throw new AnthropicMultimodalError(
      `Anthropic API error ${res.status}: ${text.slice(0, 200)}`,
      'IMAGE_API_ERROR',
      res.status,
    );
  }

  const data: unknown = await res.json().catch(() => null);
  if (!data || typeof data !== 'object') {
    throw new AnthropicMultimodalError('Empty or invalid JSON response', 'IMAGE_BAD_RESPONSE');
  }

  const payload = data as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const textBlocks = (payload.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string');
  const content = textBlocks.map((b) => b.text as string).join('\n');
  if (!content) {
    throw new AnthropicMultimodalError('Response had no text blocks', 'IMAGE_BAD_RESPONSE');
  }

  return {
    content,
    stopReason: payload.stop_reason,
    usage: payload.usage
      ? {
          inputTokens: payload.usage.input_tokens,
          outputTokens: payload.usage.output_tokens,
        }
      : undefined,
  };
}
