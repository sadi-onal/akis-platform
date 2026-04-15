/**
 * Local Embedding Service for AKIS RAG system.
 *
 * Uses Transformers.js with all-MiniLM-L6-v2 model (384 dimensions).
 * Runs entirely locally — no API key, no cost, no external dependency.
 * Model is downloaded once (~80MB) and cached in ~/.cache/
 */

import { logger } from '../../lib/logger.js';

const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMENSIONS = 384;

export { EMBEDDING_DIMENSIONS };

// Lazy-loaded pipeline — model downloads on first use
let _pipeline: ((texts: string[], options?: Record<string, unknown>) => Promise<{ data: Float32Array }[]>) | null = null;
let _loading: Promise<void> | null = null;

async function loadPipeline(): Promise<void> {
  if (_pipeline) return;
  if (_loading) { await _loading; return; }

  _loading = (async () => {
    try {
      logger.info('[EmbeddingService] Loading local embedding model (all-MiniLM-L6-v2)...');
      // Dynamic import — Transformers.js is ESM
      const { pipeline } = await import('@xenova/transformers');
      const extractor = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        quantized: true, // Use quantized model for faster inference
      });
      _pipeline = extractor as unknown as typeof _pipeline;
      logger.info('[EmbeddingService] Local embedding model loaded (384d, quantized)');
    } catch (err) {
      logger.warn(`[EmbeddingService] Failed to load model: ${err instanceof Error ? err.message : String(err)}`);
      _pipeline = null;
    }
  })();

  await _loading;
}

export class EmbeddingService {
  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    await loadPipeline();
    if (!_pipeline) {
      throw new Error('[EmbeddingService] Model not loaded — embedding unavailable');
    }

    const results: number[][] = [];
    // Process one at a time to avoid OOM on large batches
    for (const text of texts) {
      const truncated = text.slice(0, 8000); // MiniLM max ~512 tokens ≈ 2000 chars, but truncation is safe
      const output = await _pipeline([truncated], { pooling: 'mean', normalize: true });
      results.push(Array.from(output[0].data));
    }

    logger.debug(`[EmbeddingService] Generated ${results.length} embeddings (local, ${EMBEDDING_DIMENSIONS}d)`);
    return results;
  }
}

// ─── Singleton ────────────────────────────────────

let _instance: EmbeddingService | null = null;

export function getEmbeddingService(): EmbeddingService {
  if (_instance) return _instance;
  _instance = new EmbeddingService();
  return _instance;
}

/**
 * Mock embedding service for tests — returns deterministic zero vectors.
 */
export class MockEmbeddingService extends EmbeddingService {
  override async embed(_text: string): Promise<number[]> {
    return new Array(EMBEDDING_DIMENSIONS).fill(0);
  }

  override async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0));
  }
}
