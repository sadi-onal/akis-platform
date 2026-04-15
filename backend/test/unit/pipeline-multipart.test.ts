/**
 * Tests for multipart file upload → pipeline integration.
 *
 * Covers:
 * 1. parseMultipartRequest field parsing (JSON.parse for structured values, passthrough for strings)
 * 2. FileUploadService.buildContextString additional edge cases
 * 3. Integration scenario: attachment context flows into orchestrator intermediateState
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FileUploadService, type ProcessedAttachment } from '../../src/pipeline/services/FileUploadService.js';

// ─── FileUploadService.buildContextString — Extended Coverage ────────

describe('FileUploadService.buildContextString — extended', () => {
  const service = new FileUploadService();

  it('formats multiple text files with separators between them', () => {
    const attachments: ProcessedAttachment[] = [
      {
        originalName: 'index.ts',
        mimeType: 'text/typescript',
        sizeBytes: 40,
        type: 'text',
        extractedText: 'export default function App() {}',
      },
      {
        originalName: 'utils.ts',
        mimeType: 'text/typescript',
        sizeBytes: 30,
        type: 'text',
        extractedText: 'export const add = (a, b) => a + b;',
      },
      {
        originalName: 'config.json',
        mimeType: 'application/json',
        sizeBytes: 25,
        type: 'text',
        extractedText: '{"port": 3000}',
      },
    ];

    const result = service.buildContextString(attachments);

    // Each file should have its own block
    assert.ok(result.includes('--- UPLOADED FILE: index.ts ---'));
    assert.ok(result.includes('--- UPLOADED FILE: utils.ts ---'));
    assert.ok(result.includes('--- UPLOADED FILE: config.json ---'));

    // Each block should end with END FILE
    const endFileCount = (result.match(/--- END FILE ---/g) || []).length;
    assert.equal(endFileCount, 3);

    // Blocks should be separated by double newlines
    assert.ok(result.includes('--- END FILE ---\n\n--- UPLOADED FILE:'));

    // Content should be present in correct order
    assert.ok(result.includes('export default function App() {}'));
    assert.ok(result.includes('export const add = (a, b) => a + b;'));
    assert.ok(result.includes('{"port": 3000}'));
  });

  it('excludes image content from context string (images get placeholder only)', () => {
    const attachments: ProcessedAttachment[] = [
      {
        originalName: 'readme.md',
        mimeType: 'text/markdown',
        sizeBytes: 20,
        type: 'text',
        extractedText: '# Hello World',
      },
      {
        originalName: 'screenshot.png',
        mimeType: 'image/png',
        sizeBytes: 50_000,
        type: 'image',
        base64Data: 'data:image/png;base64,iVBORw0KGgoAAAANS...',
      },
      {
        originalName: 'diagram.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 120_000,
        type: 'image',
        base64Data: 'data:image/jpeg;base64,/9j/4AAQ...',
      },
    ];

    const result = service.buildContextString(attachments);

    // Text file is included fully
    assert.ok(result.includes('--- UPLOADED FILE: readme.md ---'));
    assert.ok(result.includes('# Hello World'));
    assert.ok(result.includes('--- END FILE ---'));

    // Images get placeholders with size, not base64 content
    assert.ok(result.includes('--- UPLOADED IMAGE: screenshot.png (49KB) ---'));
    assert.ok(result.includes('--- UPLOADED IMAGE: diagram.jpg (117KB) ---'));

    // Base64 data must NOT appear in the context string
    assert.ok(!result.includes('iVBORw0KGgoAAAANS'));
    assert.ok(!result.includes('/9j/4AAQ'));
  });

  it('handles empty extractedText gracefully (skips file block)', () => {
    const attachments: ProcessedAttachment[] = [
      {
        originalName: 'empty.ts',
        mimeType: 'text/typescript',
        sizeBytes: 0,
        type: 'text',
        extractedText: '',
      },
      {
        originalName: 'real.ts',
        mimeType: 'text/typescript',
        sizeBytes: 15,
        type: 'text',
        extractedText: 'const x = 42;',
      },
    ];

    const result = service.buildContextString(attachments);

    // Empty file should be skipped (empty string is falsy)
    assert.ok(!result.includes('--- UPLOADED FILE: empty.ts ---'));
    // Real file should be present
    assert.ok(result.includes('--- UPLOADED FILE: real.ts ---'));
    assert.ok(result.includes('const x = 42;'));
  });

  it('handles only image attachments (no text files)', () => {
    const attachments: ProcessedAttachment[] = [
      {
        originalName: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: 8192,
        type: 'image',
        base64Data: 'data:image/png;base64,abc',
      },
    ];

    const result = service.buildContextString(attachments);

    assert.ok(result.includes('--- UPLOADED IMAGE: photo.png (8KB) ---'));
    assert.ok(!result.includes('--- END FILE ---'));
  });

  it('handles single text file without trailing separator issues', () => {
    const attachments: ProcessedAttachment[] = [
      {
        originalName: 'solo.ts',
        mimeType: 'text/typescript',
        sizeBytes: 10,
        type: 'text',
        extractedText: 'let a = 1;',
      },
    ];

    const result = service.buildContextString(attachments);

    assert.ok(result.startsWith('--- UPLOADED FILE: solo.ts ---'));
    assert.ok(result.endsWith('--- END FILE ---'));
    assert.ok(result.includes('let a = 1;'));
  });
});

// ─── Multipart Field Parsing Logic ──────────────────────────────────
// The parseMultipartRequest function in pipeline.plugin.ts uses JSON.parse
// on field values, falling back to raw string on parse failure.
// We test this logic in isolation since parseMultipartRequest is not exported.

describe('Multipart field parsing logic (JSON.parse fallback)', () => {
  // Replicate the field parsing logic from parseMultipartRequest:
  // try { fields[name] = JSON.parse(value) } catch { fields[name] = value }
  function parseFieldValue(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  it('string "true" parses to boolean true (for skipScribe)', () => {
    const result = parseFieldValue('true');
    assert.strictEqual(result, true);
    assert.strictEqual(typeof result, 'boolean');
  });

  it('string "false" parses to boolean false', () => {
    const result = parseFieldValue('false');
    assert.strictEqual(result, false);
    assert.strictEqual(typeof result, 'boolean');
  });

  it('JSON string for existingRepo parses to object', () => {
    const repoJson = JSON.stringify({ owner: 'testuser', repo: 'my-app', branch: 'main' });
    const result = parseFieldValue(repoJson);

    assert.deepStrictEqual(result, { owner: 'testuser', repo: 'my-app', branch: 'main' });
  });

  it('regular string (idea text) passes through as string', () => {
    const idea = 'Build a todo app with React and TypeScript';
    const result = parseFieldValue(idea);
    assert.strictEqual(result, idea);
    assert.strictEqual(typeof result, 'string');
  });

  it('numeric string parses to number', () => {
    const result = parseFieldValue('42');
    assert.strictEqual(result, 42);
    assert.strictEqual(typeof result, 'number');
  });

  it('JSON array string parses to array', () => {
    const result = parseFieldValue('["react","vite"]');
    assert.deepStrictEqual(result, ['react', 'vite']);
  });

  it('empty string stays as empty string (not parsed)', () => {
    const result = parseFieldValue('');
    assert.strictEqual(result, '');
  });

  it('string "null" parses to null', () => {
    const result = parseFieldValue('null');
    assert.strictEqual(result, null);
  });

  it('malformed JSON stays as raw string', () => {
    const result = parseFieldValue('{invalid json}');
    assert.strictEqual(result, '{invalid json}');
    assert.strictEqual(typeof result, 'string');
  });

  it('multiline text stays as raw string', () => {
    const text = 'Line one\nLine two\nLine three';
    const result = parseFieldValue(text);
    assert.strictEqual(result, text);
  });
});

// ─── End-to-End: FileUploadService builds context for orchestrator ──

describe('File upload → context string → orchestrator shape', () => {
  const service = new FileUploadService();

  it('builds non-empty attachmentContext from processed text files', async () => {
    const fakePart = {
      filename: 'requirements.md',
      mimetype: 'text/markdown',
      toBuffer: async () => Buffer.from('# Requirements\n- Auth with Google\n- CRUD operations'),
    };

    const attachment = await service.processMultipartFile(fakePart);
    const context = service.buildContextString([attachment]);

    assert.ok(context.length > 0);
    assert.ok(context.includes('--- UPLOADED FILE: requirements.md ---'));
    assert.ok(context.includes('# Requirements'));
    assert.ok(context.includes('--- END FILE ---'));
  });

  it('builds context from multiple files matching orchestrator input shape', async () => {
    const parts = [
      { filename: 'api.ts', mimetype: 'text/typescript', toBuffer: async () => Buffer.from('export function getUser() {}') },
      { filename: 'schema.sql', mimetype: 'text/plain', toBuffer: async () => Buffer.from('CREATE TABLE users (id SERIAL);') },
      { filename: 'wireframe.png', mimetype: 'image/png', toBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ];

    const attachments: ProcessedAttachment[] = [];
    for (const part of parts) {
      attachments.push(await service.processMultipartFile(part));
    }

    const context = service.buildContextString(attachments);

    // This is the string that would be passed as input.attachmentContext to orchestrator
    assert.ok(typeof context === 'string');
    assert.ok(context.includes('export function getUser() {}'));
    assert.ok(context.includes('CREATE TABLE users'));
    assert.ok(context.includes('--- UPLOADED IMAGE: wireframe.png'));
    // Image content should not leak
    assert.ok(!context.includes('base64'));
  });

  it('returns undefined-equivalent for zero attachments (orchestrator skips storage)', () => {
    const context = service.buildContextString([]);
    // Empty string is falsy, so `if (input.attachmentContext)` in orchestrator will skip
    assert.strictEqual(context, '');
    assert.ok(!context); // falsy check matches orchestrator guard
  });
});
