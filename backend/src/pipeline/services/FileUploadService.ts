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
   * Text files are included inline; images get a placeholder note.
   */
  buildContextString(attachments: ProcessedAttachment[]): string {
    if (attachments.length === 0) return '';

    const parts: string[] = [];

    for (const att of attachments) {
      if (att.type === 'text' && att.extractedText) {
        parts.push(
          `--- UPLOADED FILE: ${att.originalName} ---\n` +
          att.extractedText +
          `\n--- END FILE ---`,
        );
      } else if (att.type === 'image') {
        const sizeKB = Math.round(att.sizeBytes / 1024);
        parts.push(
          `--- UPLOADED IMAGE: ${att.originalName} (${sizeKB}KB) ---`,
        );
      }
    }

    return parts.join('\n\n');
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
