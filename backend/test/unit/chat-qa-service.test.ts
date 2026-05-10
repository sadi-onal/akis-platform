/**
 * Unit tests for ChatQAService (FR-10 / F-09).
 *
 * Mock-provider path: deterministic answer templates + needsBuild heuristic.
 * The DB path is exercised via an in-memory fake store; real DB round-trips
 * live in the integration test.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  ChatQAService,
  buildCitations,
  detectNeedsBuild,
  mockAnswer,
  type Citation,
} from '../../src/pipeline/core/chat-qa/ChatQAService.ts';

// ─── fake AIService ────────────────────────────────────────────────────────
function makeAiServiceReturning(content: string) {
  return {
    async generateWorkArtifact() {
      return { content };
    },
  };
}

// ─── fake DB (drizzle-shaped just enough for ChatQAService) ────────────────
interface FakeRow {
  id: string;
  userId: string;
  approvedSpec: unknown;
  scribeOutput: unknown;
  protoOutput: unknown;
  metrics: unknown;
}

function createFakeDb(rows: FakeRow[] = []) {
  return {
    select(_pick: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(predicate: { __targetId: string } | unknown) {
              const id = (predicate as { __targetId?: string })?.__targetId;
              return {
                limit(_n: number) {
                  return Promise.resolve(
                    rows.filter((r) => (id ? r.id === id : true)),
                  );
                },
              };
            },
          };
        },
      };
    },
    rows,
  };
}

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as import('pino').Logger;

// ─── detectNeedsBuild ──────────────────────────────────────────────────────
describe('detectNeedsBuild', () => {
  test('Turkish: "ekleyebilirim" → true', () => {
    assert.strictEqual(
      detectNeedsBuild('Bunu yeni bir özellik olarak ekleyebilirim, ister misin?'),
      true,
    );
  });

  test('Turkish: "yapabilirim" → true', () => {
    assert.strictEqual(detectNeedsBuild('İstersen bunu yapabilirim.'), true);
  });

  test('Turkish: "kodlayabilirim" → true', () => {
    assert.strictEqual(detectNeedsBuild('Kısa bir kodlayabilirim.'), true);
  });

  test('English: "I can add" → true', () => {
    assert.strictEqual(detectNeedsBuild('Sure, I can add that for you.'), true);
  });

  test('English: "let me build" → true', () => {
    assert.strictEqual(detectNeedsBuild('Let me build that next.'), true);
  });

  test('Pure explainer answer → false', () => {
    assert.strictEqual(
      detectNeedsBuild('Şu an projende **12 dosya** var. Çoğunlukla src altında.'),
      false,
    );
  });

  test('Empty → false', () => {
    assert.strictEqual(detectNeedsBuild(''), false);
  });
});

// ─── buildCitations ────────────────────────────────────────────────────────
describe('buildCitations', () => {
  test('Empty context → empty array', () => {
    assert.deepStrictEqual(buildCitations(null), []);
  });

  test('Spec with projectName + acceptance criteria → 2 spec chips', () => {
    const out = buildCitations({
      spec: {
        projectName: 'Bakkal',
        description: 'Mahalle bakkalı için stok takibi',
        acceptanceCriteria: ['Ana sayfa yüklenir', 'Stok listelenir'],
      },
      protoOutput: null,
      metrics: null,
    });
    assert.ok(out.length >= 2);
    assert.ok(out.some((c) => c.source === 'spec' && c.refKey === 'spec:Bakkal'));
    assert.ok(out.some((c) => c.source === 'spec' && c.refKey === 'spec:acceptance'));
  });

  test('Proto output with files → proto chip with file list', () => {
    const out = buildCitations({
      spec: null,
      protoOutput: {
        files: [
          { filePath: 'src/App.tsx' },
          { filePath: 'src/main.tsx' },
        ],
      },
      metrics: null,
    });
    const proto = out.find((c) => c.source === 'proto');
    assert.ok(proto, 'expected a proto citation');
    assert.match(proto!.excerpt, /src\/App\.tsx/);
    assert.match(proto!.excerpt, /src\/main\.tsx/);
  });

  test('Citations are capped at 4', () => {
    const out = buildCitations({
      spec: {
        projectName: 'X',
        description: 'desc',
        acceptanceCriteria: ['a', 'b', 'c'],
      },
      protoOutput: { files: [{ filePath: 'f.ts' }] },
      metrics: { regression: { pass: 5 } },
    });
    assert.ok(out.length <= 4);
  });
});

// ─── mockAnswer ────────────────────────────────────────────────────────────
describe('mockAnswer (deterministic)', () => {
  test('"kaç dosya" → mentions file count from proto context', () => {
    const out = mockAnswer('Kaç dosya var?', {
      spec: null,
      protoOutput: { files: [{ filePath: 'a.ts' }, { filePath: 'b.ts' }] },
      metrics: null,
    });
    assert.match(out, /2 dosya/);
  });

  test('"how does X work" → explainer template', () => {
    const out = mockAnswer('how does scribe work?', null);
    assert.ok(out.length > 10);
    assert.match(out, /spec/i);
  });

  test('Fallback always contains a needsBuild cue', () => {
    const out = mockAnswer('asdfjkl xyz', null);
    assert.strictEqual(detectNeedsBuild(out), true);
  });
});

// ─── ChatQAService.answer — mock provider ──────────────────────────────────
describe('ChatQAService with mock provider', () => {
  test('answer: streams chunks via onChunk and returns final QAResponse', async () => {
    const db = createFakeDb();
    const service = new ChatQAService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });

    const chunks: string[] = [];
    const result = await service.answer({
      pipelineId: null,
      userId: 'user-1',
      message: 'Kaç dosya üretildi?',
      onChunk: (c) => chunks.push(c),
    });

    assert.ok(result.answer.length > 0);
    assert.ok(chunks.length > 0, 'expected at least one chunk emitted');
    // Reassembling the chunks reproduces the answer.
    assert.strictEqual(chunks.join(''), result.answer);
    // No citations for null pipelineId.
    assert.deepStrictEqual(result.citations, []);
  });

  test('answer: emits citations for a pipeline with spec + proto', async () => {
    const db = createFakeDb([
      {
        id: 'pipe-1',
        userId: 'user-1',
        approvedSpec: {
          projectName: 'Bakkal',
          description: 'Stok takibi',
          acceptanceCriteria: ['A', 'B'],
        },
        scribeOutput: null,
        protoOutput: { files: [{ filePath: 'src/App.tsx' }] },
        metrics: null,
      },
    ]);
    // Patch the predicate so the fake `where()` understands which row we want.
    // The real classifier uses drizzle's `eq(pipelines.id, pipelineId)`. Our
    // ChatQAService loader passes the result of `eq(...)` to `where()`; the
    // fake DB ignores the predicate and returns all rows. That's fine because
    // we seeded a single row.

    const service = new ChatQAService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });

    const seenCitations: Citation[] = [];
    const result = await service.answer({
      pipelineId: 'pipe-1',
      userId: 'user-1',
      message: 'Kaç dosya?',
      onCitation: (c) => seenCitations.push(c),
    });

    // The mock template hits the "kaç dosya" branch and reports 1 file.
    assert.match(result.answer, /1 dosya/);
    assert.ok(result.citations.length >= 1);
    assert.ok(seenCitations.length >= 1);
    // Citations include both spec + proto when both are present.
    const sources = new Set(result.citations.map((c) => c.source));
    assert.ok(sources.has('spec'));
    assert.ok(sources.has('proto'));
  });

  test('answer: returns empty context when pipelineId belongs to another user', async () => {
    const db = createFakeDb([
      {
        id: 'pipe-1',
        userId: 'other-user',
        approvedSpec: { projectName: 'X' },
        scribeOutput: null,
        protoOutput: null,
        metrics: null,
      },
    ]);
    const service = new ChatQAService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    const result = await service.answer({
      pipelineId: 'pipe-1',
      userId: 'user-1',
      message: 'kaç dosya?',
    });
    // No leak — citations from a foreign pipeline are not surfaced.
    assert.deepStrictEqual(result.citations, []);
  });

  test('answer: needsBuild is true when assistant suggests adding feature', async () => {
    const db = createFakeDb();
    const service = new ChatQAService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    // Hits the fallback template which always emits "ekleyebilirim".
    const result = await service.answer({
      pipelineId: null,
      userId: 'user-1',
      message: 'qwertyuio',
    });
    assert.strictEqual(result.needsBuild, true);
  });

  test('answer: needsBuild is false on a pure explainer', async () => {
    const db = createFakeDb();
    const service = new ChatQAService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    const result = await service.answer({
      pipelineId: null,
      userId: 'user-1',
      message: 'kaç dosya üretildi?',
    });
    assert.strictEqual(result.needsBuild, false);
  });
});

// ─── ChatQAService.answer — real-provider path ─────────────────────────────
describe('ChatQAService with real provider', () => {
  test('answer: returns whole AI content as one chunk and surfaces it as answer', async () => {
    const db = createFakeDb();
    const ai = makeAiServiceReturning(
      'Şu an proje için bilgi yok. Eğer istersen **ekleyebilirim**.',
    );
    const service = new ChatQAService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: ai as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'anthropic',
    });
    const chunks: string[] = [];
    const result = await service.answer({
      pipelineId: null,
      userId: 'user-1',
      message: 'rapor nedir?',
      onChunk: (c) => chunks.push(c),
    });
    assert.ok(result.answer.includes('ekleyebilirim'));
    assert.strictEqual(result.needsBuild, true);
    assert.strictEqual(chunks.length, 1, 'real-provider path emits one chunk for now');
  });

  test('answer: rethrows when AI fails (caller emits error event)', async () => {
    const db = createFakeDb();
    const ai = {
      async generateWorkArtifact() {
        throw new Error('AI provider down');
      },
    };
    const service = new ChatQAService({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: ai as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'anthropic',
    });
    await assert.rejects(
      service.answer({
        pipelineId: null,
        userId: 'user-1',
        message: 'soru',
      }),
      /AI provider down/,
    );
  });
});
