import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FileUploadService, MAX_FILE_SIZE, MAX_FILES } from '../../src/pipeline/services/FileUploadService.js';
import type { ProcessedAttachment } from '../../src/pipeline/services/FileUploadService.js';

describe('FileUploadService', () => {
  const service = new FileUploadService();

  // ─── processMultipartFile ─────────────────────────

  describe('processMultipartFile', () => {
    it('should process a text file and extract UTF-8 content', async () => {
      const content = 'const x = 1;\nexport default x;';
      const fakePart = {
        filename: 'app.ts',
        mimetype: 'text/typescript',
        toBuffer: async () => Buffer.from(content, 'utf-8'),
      };

      const result = await service.processMultipartFile(fakePart);

      assert.strictEqual(result.originalName, 'app.ts');
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.extractedText, content);
      assert.strictEqual(result.base64Data, undefined);
      assert.strictEqual(result.sizeBytes, Buffer.byteLength(content));
    });

    it('should process an image file and produce base64 data', async () => {
      const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      const fakePart = {
        filename: 'logo.png',
        mimetype: 'image/png',
        toBuffer: async () => imageBytes,
      };

      const result = await service.processMultipartFile(fakePart);

      assert.strictEqual(result.originalName, 'logo.png');
      assert.strictEqual(result.type, 'image');
      assert.ok(result.base64Data?.startsWith('data:image/png;base64,'));
      assert.strictEqual(result.extractedText, undefined);
    });

    it('should detect text files by extension even with generic MIME type', async () => {
      const fakePart = {
        filename: 'config.json',
        mimetype: 'application/octet-stream',
        toBuffer: async () => Buffer.from('{"key":"value"}'),
      };

      const result = await service.processMultipartFile(fakePart);
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.extractedText, '{"key":"value"}');
    });

    it('should reject files exceeding MAX_FILE_SIZE', async () => {
      const bigBuffer = Buffer.alloc(MAX_FILE_SIZE + 1);
      const fakePart = {
        filename: 'huge.bin',
        mimetype: 'text/plain',
        toBuffer: async () => bigBuffer,
      };

      await assert.rejects(
        () => service.processMultipartFile(fakePart),
        /Dosya boyutu/,
      );
    });

    it('should reject unsupported file types', async () => {
      const fakePart = {
        filename: 'archive.zip',
        mimetype: 'application/zip',
        toBuffer: async () => Buffer.from('PK'),
      };

      await assert.rejects(
        () => service.processMultipartFile(fakePart),
        /Desteklenmeyen dosya/,
      );
    });
  });

  // ─── validateFileCount ────────────────────────────

  describe('validateFileCount', () => {
    it('should pass for count within limit', () => {
      assert.doesNotThrow(() => service.validateFileCount(1));
      assert.doesNotThrow(() => service.validateFileCount(MAX_FILES));
    });

    it('should throw for count exceeding limit', () => {
      assert.throws(
        () => service.validateFileCount(MAX_FILES + 1),
        /dosya/i,
      );
    });

    it('should pass for zero files', () => {
      assert.doesNotThrow(() => service.validateFileCount(0));
    });
  });

  // ─── buildContextString ───────────────────────────

  describe('buildContextString', () => {
    it('should format text attachments with file markers', () => {
      const attachments: ProcessedAttachment[] = [
        {
          originalName: 'app.ts',
          mimeType: 'text/typescript',
          sizeBytes: 100,
          type: 'text',
          extractedText: 'const x = 1;',
        },
      ];

      const result = service.buildContextString(attachments);

      assert.ok(result.includes('--- UPLOADED FILE: app.ts ---'));
      assert.ok(result.includes('const x = 1;'));
      assert.ok(result.includes('--- END FILE ---'));
    });

    it('should list uploaded images and force acknowledgement (issue #389)', () => {
      const attachments: ProcessedAttachment[] = [
        {
          originalName: 'screenshot.png',
          mimeType: 'image/png',
          sizeBytes: 2048,
          type: 'image',
          base64Data: 'data:image/png;base64,abc',
        },
      ];

      const result = service.buildContextString(attachments);

      assert.ok(result.includes('UPLOADED IMAGES (1)'));
      assert.ok(result.includes('- screenshot.png'));
      // Ack-forcing instruction must be present so the agent cannot silently ignore the image.
      assert.ok(result.includes('MUTLAKA'));
      assert.ok(result.includes('Görselleri yok sayma'));
    });

    it('should combine multiple attachments', () => {
      const attachments: ProcessedAttachment[] = [
        {
          originalName: 'index.ts',
          mimeType: 'text/typescript',
          sizeBytes: 50,
          type: 'text',
          extractedText: 'import React from "react";',
        },
        {
          originalName: 'design.png',
          mimeType: 'image/png',
          sizeBytes: 4096,
          type: 'image',
          base64Data: 'data:image/png;base64,xyz',
        },
      ];

      const result = service.buildContextString(attachments);

      assert.ok(result.includes('--- UPLOADED FILE: index.ts ---'));
      assert.ok(result.includes('UPLOADED IMAGES (1)'));
      assert.ok(result.includes('- design.png'));
    });

    it('should group multiple images into one block with correct count', () => {
      const attachments: ProcessedAttachment[] = [
        { originalName: 'a.png', mimeType: 'image/png', sizeBytes: 100, type: 'image', base64Data: 'data:image/png;base64,a' },
        { originalName: 'b.jpg', mimeType: 'image/jpeg', sizeBytes: 100, type: 'image', base64Data: 'data:image/jpeg;base64,b' },
        { originalName: 'c.webp', mimeType: 'image/webp', sizeBytes: 100, type: 'image', base64Data: 'data:image/webp;base64,c' },
      ];

      const result = service.buildContextString(attachments);

      assert.ok(result.includes('UPLOADED IMAGES (3)'));
      assert.ok(result.includes('- a.png'));
      assert.ok(result.includes('- b.jpg'));
      assert.ok(result.includes('- c.webp'));
    });

    it('should return empty string for no attachments', () => {
      assert.strictEqual(service.buildContextString([]), '');
    });

    it('should skip text attachments without extractedText', () => {
      const attachments: ProcessedAttachment[] = [
        {
          originalName: 'empty.txt',
          mimeType: 'text/plain',
          sizeBytes: 0,
          type: 'text',
          // no extractedText
        },
      ];

      const result = service.buildContextString(attachments);

      // Should not include file marker since there's no text content
      assert.ok(!result.includes('--- UPLOADED FILE: empty.txt ---'));
    });
  });

  // ─── buildImageBlocks ─────────────────────────────

  describe('buildImageBlocks (issue #389 — Anthropic multimodal helper)', () => {
    it('returns [] when no attachments', () => {
      assert.deepStrictEqual(service.buildImageBlocks([]), []);
    });

    it('ignores text attachments', () => {
      const atts: ProcessedAttachment[] = [
        { originalName: 'a.ts', mimeType: 'text/typescript', sizeBytes: 5, type: 'text', extractedText: 'x' },
      ];
      assert.deepStrictEqual(service.buildImageBlocks(atts), []);
    });

    it('strips the data URL prefix and produces raw base64 blocks', () => {
      const atts: ProcessedAttachment[] = [
        {
          originalName: 'hero.png',
          mimeType: 'image/png',
          sizeBytes: 4,
          type: 'image',
          base64Data: 'data:image/png;base64,AAECAw==',
        },
      ];

      const blocks = service.buildImageBlocks(atts);

      assert.strictEqual(blocks.length, 1);
      assert.strictEqual(blocks[0].type, 'image');
      assert.strictEqual(blocks[0].source.type, 'base64');
      assert.strictEqual(blocks[0].source.media_type, 'image/png');
      // Raw base64 only — no "data:" prefix.
      assert.strictEqual(blocks[0].source.data, 'AAECAw==');
    });

    it('preserves order and media_type for a mix of supported formats', () => {
      const atts: ProcessedAttachment[] = [
        { originalName: 'a.png', mimeType: 'image/png', sizeBytes: 1, type: 'image', base64Data: 'data:image/png;base64,AA' },
        { originalName: 'b.jpeg', mimeType: 'image/jpeg', sizeBytes: 1, type: 'image', base64Data: 'data:image/jpeg;base64,BB' },
        { originalName: 'c.webp', mimeType: 'image/webp', sizeBytes: 1, type: 'image', base64Data: 'data:image/webp;base64,CC' },
      ];

      const blocks = service.buildImageBlocks(atts);

      assert.strictEqual(blocks.length, 3);
      assert.strictEqual(blocks[0].source.media_type, 'image/png');
      assert.strictEqual(blocks[1].source.media_type, 'image/jpeg');
      assert.strictEqual(blocks[2].source.media_type, 'image/webp');
    });

    it('skips images with non-Anthropic-supported mime types', () => {
      const atts: ProcessedAttachment[] = [
        // bmp isn't in the Anthropic image_supported set; must be filtered out.
        { originalName: 'bad.bmp', mimeType: 'image/bmp', sizeBytes: 1, type: 'image', base64Data: 'data:image/bmp;base64,ZZ' },
        { originalName: 'ok.png', mimeType: 'image/png', sizeBytes: 1, type: 'image', base64Data: 'data:image/png;base64,YY' },
      ];

      const blocks = service.buildImageBlocks(atts);

      assert.strictEqual(blocks.length, 1);
      assert.strictEqual(blocks[0].source.media_type, 'image/png');
    });

    it('skips images missing base64 data (defensive)', () => {
      const atts: ProcessedAttachment[] = [
        { originalName: 'broken.png', mimeType: 'image/png', sizeBytes: 1, type: 'image' /* no base64Data */ },
      ];

      assert.deepStrictEqual(service.buildImageBlocks(atts), []);
    });
  });

  // ─── Constants ────────────────────────────────────

  describe('exported constants', () => {
    it('MAX_FILE_SIZE should be 10MB', () => {
      assert.strictEqual(MAX_FILE_SIZE, 10 * 1024 * 1024);
    });

    it('MAX_FILES should be 5', () => {
      assert.strictEqual(MAX_FILES, 5);
    });
  });
});
