/**
 * FileUploadService — processes uploaded files for pipeline context injection.
 * Supports text files (code, markdown, config) and images (png, jpeg, gif, webp).
 * Text files are extracted as UTF-8 strings; images are base64-encoded.
 */
import path from 'node:path';
import { logger } from '../../lib/logger.js';

// ─── Public Interfaces ───────────────────────────

export interface ProcessedAttachment {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  type: 'text' | 'image';
  extractedText?: string;
  base64Data?: string;
}

/**
 * Anthropic Messages API image content block. When an image is uploaded and
 * we call a multimodal-capable model, this is the shape expected inside
 * `messages[*].content` arrays.
 */
export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string; // raw base64 — NOT the data: URL
  };
}

// ─── Constants ───────────────────────────────────

const TEXT_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/html', 'text/css',
  'application/json', 'application/javascript',
  'text/typescript', 'text/x-typescript', 'text/jsx', 'text/tsx',
  'application/x-javascript', 'application/typescript',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.md', '.txt', '.json', '.html', '.css',
  '.yml', '.yaml', '.toml', '.xml', '.sh', '.sql', '.py', '.env',
  '.gitignore', '.dockerignore', '.editorconfig',
]);

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

// ─── Service ─────────────────────────────────────

export class FileUploadService {
  /**
   * Process a single multipart file part.
   * Calls part.toBuffer() to consume the stream, then classifies and extracts content.
   */
  async processMultipartFile(part: { filename: string; mimetype: string; toBuffer: () => Promise<Buffer> }): Promise<ProcessedAttachment> {
    const buffer = await part.toBuffer();
    const sizeBytes = buffer.length;

    if (sizeBytes > MAX_FILE_SIZE) {
      throw new Error(
        `Dosya boyutu çok büyük: ${part.filename} (${(sizeBytes / 1024 / 1024).toFixed(1)}MB). Maksimum dosya boyutu 10MB.`,
      );
    }

    const ext = path.extname(part.filename).toLowerCase();
    const mime = part.mimetype;
    const fileType = this.resolveFileType(ext, mime);

    if (!fileType) {
      throw new Error(
        `Desteklenmeyen dosya türü: ${part.filename} (${mime}). Desteklenen: metin dosyaları (.ts, .js, .json, .md, vb.) ve görseller (.png, .jpg, .gif, .webp).`,
      );
    }

    const attachment: ProcessedAttachment = {
      originalName: part.filename,
      mimeType: mime,
      sizeBytes,
      type: fileType,
    };

    if (fileType === 'text') {
      attachment.extractedText = buffer.toString('utf-8');
      logger.info({ file: part.filename, size: sizeBytes }, '[FileUpload] Metin dosyası işlendi');
    } else {
      attachment.base64Data = `data:${mime};base64,${buffer.toString('base64')}`;
      logger.info({ file: part.filename, size: sizeBytes }, '[FileUpload] Görsel dosyası işlendi');
    }

    return attachment;
  }

  /**
   * Build a context string from all processed attachments.
   * Text files are included inline; images get a placeholder note that
   * instructs the agent to acknowledge them (see issue #389 / BUG-09).
   *
   * Downstream, the agent should ALSO receive image content blocks via
   * {@link buildImageBlocks} so multimodal models can actually see the pixels.
   * This string is the fallback when the model is text-only, and also acts as
   * the "ack prompt" even for multimodal callers.
   */
  buildContextString(attachments: ProcessedAttachment[]): string {
    if (attachments.length === 0) return '';

    const parts: string[] = [];
    const imageNames: string[] = [];

    for (const att of attachments) {
      if (att.type === 'text' && att.extractedText) {
        parts.push(
          `--- UPLOADED FILE: ${att.originalName} ---\n` +
          att.extractedText +
          `\n--- END FILE ---`,
        );
      } else if (att.type === 'image') {
        imageNames.push(att.originalName);
      }
    }

    if (imageNames.length > 0) {
      const list = imageNames.map((n) => `- ${n}`).join('\n');
      parts.push(
        `--- UPLOADED IMAGES (${imageNames.length}) ---\n` +
        list +
        `\n\nKullanıcı yukarıdaki görsel(ler)i yükledi. İlk cevabında ` +
        `MUTLAKA görselde ne gördüğünü 1-2 cümleyle özetle ve kullanıcının ` +
        `isteğini nasıl yorumladığını açıkla. Görselleri yok sayma.\n` +
        `--- END IMAGES ---`,
      );
    }

    return parts.join('\n\n');
  }

  /**
   * Build Anthropic multimodal image blocks from processed attachments.
   * Returns [] when there are no images — the caller can then skip the
   * multimodal code path entirely and fall back to plain `generateText`.
   *
   * The `data:` URL prefix present on {@link ProcessedAttachment.base64Data}
   * is stripped because the Anthropic API expects raw base64 in
   * `source.data` plus `media_type` as a separate field.
   */
  buildImageBlocks(attachments: ProcessedAttachment[]): AnthropicImageBlock[] {
    const blocks: AnthropicImageBlock[] = [];

    for (const att of attachments) {
      if (att.type !== 'image' || !att.base64Data) continue;

      // base64Data is "data:image/png;base64,AAAA..." — strip the prefix.
      const commaIdx = att.base64Data.indexOf(',');
      const raw = commaIdx >= 0 ? att.base64Data.slice(commaIdx + 1) : att.base64Data;

      // Only the Anthropic-supported subset is allowed; validated at upload.
      const mediaType = att.mimeType as AnthropicImageBlock['source']['media_type'];
      if (!IMAGE_MIME_TYPES.has(mediaType)) {
        logger.warn({ file: att.originalName, mimeType: att.mimeType }, '[FileUpload] skipping unsupported mime for multimodal block');
        continue;
      }

      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: raw },
      });
    }

    return blocks;
  }

  /**
   * Validate file count against MAX_FILES limit.
   */
  validateFileCount(count: number): void {
    if (count > MAX_FILES) {
      throw new Error(
        `Çok fazla dosya yüklendi (${count}). Tek seferde en fazla ${MAX_FILES} dosya yüklenebilir.`,
      );
    }
  }

  // ─── Private Helpers ─────────────────────────────

  private resolveFileType(ext: string, mime: string): 'text' | 'image' | null {
    // Extension-based detection takes priority (MIME types from browsers can be unreliable)
    if (TEXT_EXTENSIONS.has(ext)) return 'text';
    if (IMAGE_MIME_TYPES.has(mime)) return 'image';
    if (TEXT_MIME_TYPES.has(mime)) return 'text';
    return null;
  }
}

// ─── Exported Constants (for tests) ──────────────

export { MAX_FILE_SIZE, MAX_FILES };
