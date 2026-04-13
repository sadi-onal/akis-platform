/**
 * OpenAI Embeddings Service for AKIS RAG system.
 *
 * Uses text-embedding-3-small (1536 dimensions, $0.02/1M tokens).
 * Supports single and batch embedding with retry logic.
 */

import { logger } from '../../lib/logger.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = 1536;
const MAX_BATCH_SIZE = 100; // OpenAI max per request
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 5000];

export { EMBEDDING_DIMENSIONS };

export interface EmbeddingServiceConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

export class EmbeddingService {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: EmbeddingServiceConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.model ?? EMBEDDING_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const allEmbeddings: number[][] = new Array(texts.length);

    // Process in chunks of MAX_BATCH_SIZE
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const batchResults = await this.callEmbeddingAPI(batch);

      for (let j = 0; j < batchResults.length; j++) {
        allEmbeddings[i + j] = batchResults[j];
      }
    }

    return allEmbeddings;
  }

  private async callEmbeddingAPI(inputs: string[]): Promise<number[][]> {
    // Truncate very long inputs (embedding API has ~8191 token limit)
    const sanitized = inputs.map(t => t.slice(0, 30000));

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: sanitized,
            dimensions: EMBEDDING_DIMENSIONS,
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text();
          if (response.status === 429 && attempt < MAX_RETRIES) {
            const delay = RETRY_DELAYS[attempt] ?? 5000;
            logger.warn(`[EmbeddingService] Rate limited, retrying in ${delay}ms (attempt ${attempt + 1})`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw new Error(`OpenAI Embedding API error ${response.status}: ${errorBody.slice(0, 200)}`);
        }

        const data: OpenAIEmbeddingResponse = await response.json();

        // Sort by index to maintain order
        data.data.sort((a, b) => a.index - b.index);

        logger.debug(`[EmbeddingService] Generated ${data.data.length} embeddings, tokens: ${data.usage.total_tokens}`);

        return data.data.map(d => d.embedding);
      } catch (err) {
        if (attempt < MAX_RETRIES && !(err instanceof Error && err.message.includes('API error'))) {
          const delay = RETRY_DELAYS[attempt] ?? 5000;
          logger.warn(`[EmbeddingService] Request failed (attempt ${attempt + 1}), retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    throw new Error('[EmbeddingService] All retries exhausted');
  }
}

// ─── Singleton ────────────────────────────────────

let _instance: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService | null {
  if (_instance) return _instance;

  const apiKey = process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.info('[EmbeddingService] No OPENAI_EMBEDDING_API_KEY or OPENAI_API_KEY set — embedding disabled');
    return null;
  }

  _instance = new EmbeddingService({ apiKey });
  logger.info('[EmbeddingService] Initialized with text-embedding-3-small (1536d)');
  return _instance;
}

/**
 * Mock embedding service for tests — returns deterministic zero vectors.
 */
export class MockEmbeddingService extends EmbeddingService {
  constructor() {
    super({ apiKey: 'mock' });
  }

  override async embed(_text: string): Promise<number[]> {
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }

  override async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0));
  }
}
