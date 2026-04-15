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

    it('should include image placeholder notes', () => {
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

      assert.ok(result.includes('--- UPLOADED IMAGE: screenshot.png'));
      assert.ok(result.includes('2KB'));
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
      assert.ok(result.includes('--- UPLOADED IMAGE: design.png'));
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
