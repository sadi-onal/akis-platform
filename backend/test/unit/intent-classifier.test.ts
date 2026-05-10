/**
 * Unit tests for IntentClassifier (FR-11.1..FR-11.4 / F-10).
 *
 * Mock-provider regex path: ensures each of the 4 classes wins on clear
 * messages with reasonable confidence, sub-threshold confidence on ambiguous
 * inputs, and ASCII-only privacy guarantees (we hash the message; never
 * persist prose).
 *
 * The DB path is exercised against an in-memory fake store that mimics the
 * subset of the drizzle insert/update API the classifier touches. Real DB
 * round-trips live in integration tests.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  classifyByRegex,
  hashMessage,
  IntentClassifier,
  type IntentLabel,
} from '../../src/pipeline/core/intent/IntentClassifier.ts';

// ─── fake AIService ────────────────────────────────────────────────────────
function makeAiServiceReturning(content: string) {
  return {
    async generateWorkArtifact() {
      return { content };
    },
  };
}

// ─── fake DB (drizzle-shaped just enough for IntentClassifier) ──────────────
interface FakeRow {
  id: bigint;
  userId: string;
  pipelineId: string | null;
  messageHash: string;
  intent: string;
  confidence: string;
  alternates: unknown;
  overrideIntent: string | null;
}

function createFakeDb() {
  const rows: FakeRow[] = [];
  let nextId = 1n;
  const db = {
    insert(_table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          return {
            returning(_pick: unknown) {
              const row: FakeRow = {
                id: nextId++,
                userId: String(v.userId),
                pipelineId: (v.pipelineId as string | null) ?? null,
                messageHash: String(v.messageHash),
                intent: String(v.intent),
                confidence: String(v.confidence),
                alternates: v.alternates,
                overrideIntent: null,
              };
              rows.push(row);
              return Promise.resolve([{ id: row.id }]);
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(s: Record<string, unknown>) {
          return {
            where(predicate: { __targetId: bigint }) {
              const row = rows.find((r) => r.id === predicate.__targetId);
              if (row && typeof s.overrideIntent === 'string') {
                row.overrideIntent = s.overrideIntent;
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
    rows,
  };
  return db;
}

// Replace drizzle's `eq()` predicate with a marker the fake db understands.
// We patch into the classifier indirectly by stubbing the bare-minimum
// `eq()` import? Instead — call overrideClassification through a thin shim.

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as import('pino').Logger;

// ─── classifyByRegex: pure decision tests (no DB / AIService) ──────────────
describe('classifyByRegex (mock provider)', () => {
  test('BUILD: imperative Turkish — "borç takibi sayfası ekle"', () => {
    const out = classifyByRegex('Borç takibi sayfası ekle');
    assert.strictEqual(out.intent, 'BUILD');
    assert.ok(out.confidence >= 0.7, `expected ≥ 0.7, got ${out.confidence}`);
  });

  test('BUILD: English imperative — "add a login form"', () => {
    const out = classifyByRegex('add a login form');
    assert.strictEqual(out.intent, 'BUILD');
    assert.ok(out.confidence >= 0.7);
  });

  test('ASK: explicit Turkish question — "rapor nedir?"', () => {
    const out = classifyByRegex('rapor nedir?');
    assert.strictEqual(out.intent, 'ASK');
    assert.ok(out.confidence >= 0.7);
  });

  test('ASK: English question with question mark', () => {
    const out = classifyByRegex('how does the scribe agent work?');
    assert.strictEqual(out.intent, 'ASK');
    assert.ok(out.confidence >= 0.7);
  });

  test('FEEDBACK: Turkish bug report', () => {
    const out = classifyByRegex('Müşteri silince eski borç kayıtları da silindi, bu olmamalıydı');
    assert.strictEqual(out.intent, 'FEEDBACK');
    assert.ok(out.confidence >= 0.6, `expected ≥ 0.6, got ${out.confidence}`);
  });

  test('FEEDBACK: English bug report', () => {
    const out = classifyByRegex("the export button is broken");
    assert.strictEqual(out.intent, 'FEEDBACK');
    assert.ok(out.confidence >= 0.7);
  });

  test('CHAT: greeting', () => {
    const out = classifyByRegex('merhaba');
    assert.strictEqual(out.intent, 'CHAT');
    assert.ok(out.confidence >= 0.6);
  });

  test('Ambiguous one-word input → confidence < 0.7 (forces disambiguation)', () => {
    const out = classifyByRegex('rapor');
    assert.ok(
      out.confidence < 0.7,
      `expected < 0.7 for ambiguous "rapor", got ${out.confidence} (intent=${out.intent})`,
    );
    // Alternates exist so the modal can render hints.
    assert.ok(Array.isArray(out.alternates));
  });

  test('Empty / no-signal input falls into low-confidence CHAT', () => {
    const out = classifyByRegex('asdfjkl');
    assert.strictEqual(out.intent, 'CHAT');
    assert.ok(out.confidence < 0.7);
  });

  test('Confidence is bounded to [0..0.97]', () => {
    const out = classifyByRegex('lütfen yeni bir rapor sayfası ekle, çünkü çalışmıyor?');
    // Hits BUILD + ASK + FEEDBACK signals — confidence should be capped.
    assert.ok(out.confidence <= 0.97);
    assert.ok(out.confidence >= 0);
  });

  test('Reasoning string is short and never echoes the message', () => {
    const message = 'super-secret data: order #42';
    const out = classifyByRegex(message);
    assert.ok(out.reasoning.length <= 280);
    assert.ok(!out.reasoning.includes('super-secret'));
    assert.ok(!out.reasoning.includes('order #42'));
  });
});

// ─── hashMessage: privacy guarantees ───────────────────────────────────────
describe('hashMessage (privacy)', () => {
  test('Hex output is deterministic and 64 chars (SHA-256)', () => {
    const a = hashMessage('hello');
    const b = hashMessage('hello');
    assert.strictEqual(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test('Different messages → different hashes', () => {
    assert.notStrictEqual(hashMessage('a'), hashMessage('b'));
  });

  test('Hash never contains the original message', () => {
    const msg = 'super-secret-token-XYZ';
    const h = hashMessage(msg);
    assert.ok(!h.includes('super-secret'));
    assert.ok(!h.includes('XYZ'));
  });
});

// ─── IntentClassifier — mock provider end-to-end with fake DB ──────────────
describe('IntentClassifier with mock provider + fake DB', () => {
  test('classify: persists hashed message, never raw text', async () => {
    const db = createFakeDb();
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });

    const message = 'borç takibi sayfası ekle';
    const result = await classifier.classify(
      '00000000-0000-0000-0000-000000000001',
      message,
      {},
    );

    assert.strictEqual(result.intent, 'BUILD');
    assert.ok(result.confidence >= 0.7);
    assert.ok(result.classificationId);

    // Persistence check: the row stores the hash, not the prose.
    assert.strictEqual(db.rows.length, 1);
    const row = db.rows[0];
    assert.strictEqual(row.messageHash, hashMessage(message));
    assert.notStrictEqual(row.messageHash, message);
    assert.strictEqual(row.intent, 'BUILD');
    // Confidence persisted as a 3-decimal string (numeric(4,3)).
    assert.match(row.confidence, /^0\.\d{3}$/);
  });

  test('classify: low-confidence "rapor" still persists', async () => {
    const db = createFakeDb();
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    const result = await classifier.classify(
      '00000000-0000-0000-0000-000000000002',
      'rapor',
      {},
    );
    assert.ok(result.confidence < 0.7);
    assert.strictEqual(db.rows.length, 1);
  });

  test('disambiguationThreshold defaults to 0.7', () => {
    const db = createFakeDb();
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    assert.strictEqual(classifier.disambiguationThreshold, 0.7);
  });

  test('overrideClassification: rejects malformed id', async () => {
    const db = createFakeDb();
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    await assert.rejects(
      classifier.overrideClassification(
        'not-a-bigint',
        'ASK',
        '00000000-0000-0000-0000-000000000007',
      ),
      /INVALID_CLASSIFICATION_ID/,
    );
  });

  test('overrideClassification: rejects invalid intent label', async () => {
    const db = createFakeDb();
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    await assert.rejects(
      classifier.overrideClassification(
        '1',
        'BAD' as IntentLabel,
        '00000000-0000-0000-0000-000000000007',
      ),
      /INVALID_INTENT/,
    );
  });
});

// ─── Turkish word-boundary regression (mock regex) ─────────────────────────
describe('classifyByRegex: Turkish word boundaries', () => {
  test('"yapı" (noun) does NOT match BUILD imperative "yap"', () => {
    // ASCII `\b` would falsely fire on `yap` inside "yapı" because `ı` is a
    // non-word char in JS — Turkish-aware boundaries fix that.
    const out = classifyByRegex('yapı');
    assert.notStrictEqual(
      out.intent,
      'BUILD',
      `"yapı" should not classify as BUILD (got intent=${out.intent}, conf=${out.confidence})`,
    );
  });

  test('"yapılan" (passive participle) does NOT match BUILD imperative "yap"', () => {
    const out = classifyByRegex('yapılan');
    assert.notStrictEqual(
      out.intent,
      'BUILD',
      `"yapılan" should not classify as BUILD (got intent=${out.intent}, conf=${out.confidence})`,
    );
  });

  test('"yap" (action imperative) DOES match BUILD', () => {
    const out = classifyByRegex('yap');
    assert.strictEqual(out.intent, 'BUILD');
  });
});

// ─── IDOR regression: ownership-scoped overrideClassification ──────────────
// The cross-user IDOR scenario (user A's row, user B PATCH → 404, row
// unchanged) is exercised in the integration test
// `intent-classifications-route.test.ts` against real Postgres + drizzle so
// the SQL WHERE is genuinely evaluated. At the unit layer we only verify the
// runtime contract — a non-matching update returns no rows → NOT_FOUND.
describe('IntentClassifier.overrideClassification: NOT_FOUND on no-match (IDOR fix)', () => {
  test('throws NOT_FOUND when update affects zero rows', async () => {
    // Fake update().set().where().returning() that resolves [] — i.e. the
    // SQL filter (id + userId) didn't match any row. The classifier must
    // surface this as NOT_FOUND so the route returns 404 instead of 200.
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([]),
          }),
        }),
      }),
    };
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    await assert.rejects(
      classifier.overrideClassification(
        '42',
        'ASK',
        '00000000-0000-0000-0000-00000000000B',
      ),
      /NOT_FOUND/,
    );
  });

  test('resolves OK when update affects at least one row', async () => {
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: 42n }]),
          }),
        }),
      }),
    };
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: makeAiServiceReturning('') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'mock',
    });
    await classifier.overrideClassification(
      '42',
      'ASK',
      '00000000-0000-0000-0000-00000000000A',
    );
    // No throw → success
  });
});

// ─── IntentClassifier — AI provider path with fake AIService ───────────────
describe('IntentClassifier with AI provider', () => {
  test('parses well-formed JSON response', async () => {
    const db = createFakeDb();
    const ai = makeAiServiceReturning(
      '{"intent":"ASK","confidence":0.92,"reasoning":"clear question","alternates":[{"intent":"CHAT","confidence":0.05}]}',
    );
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: ai as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'anthropic',
    });
    const result = await classifier.classify(
      '00000000-0000-0000-0000-000000000003',
      'rapor nedir?',
      {},
    );
    assert.strictEqual(result.intent, 'ASK');
    assert.ok(Math.abs(result.confidence - 0.92) < 1e-9);
    assert.ok(result.alternates && result.alternates[0].intent === 'CHAT');
  });

  test('strips ```json fences before parsing', async () => {
    const db = createFakeDb();
    const ai = makeAiServiceReturning(
      '```json\n{"intent":"BUILD","confidence":0.81,"reasoning":"imperative add"}\n```',
    );
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: ai as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'anthropic',
    });
    const result = await classifier.classify(
      '00000000-0000-0000-0000-000000000004',
      'add a button',
      {},
    );
    assert.strictEqual(result.intent, 'BUILD');
  });

  test('falls back to regex when AI returns garbage', async () => {
    const db = createFakeDb();
    const ai = makeAiServiceReturning('I have no idea what you are asking');
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: ai as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'anthropic',
    });
    const result = await classifier.classify(
      '00000000-0000-0000-0000-000000000005',
      'add a button',
      {},
    );
    // Regex fallback would still classify BUILD on the imperative.
    assert.strictEqual(result.intent, 'BUILD');
  });

  test('falls back to regex when AI returns out-of-range confidence', async () => {
    const db = createFakeDb();
    const ai = makeAiServiceReturning(
      '{"intent":"ASK","confidence":1.7,"reasoning":"x"}',
    );
    const classifier = new IntentClassifier({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiService: ai as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      logger: silentLogger,
      provider: 'anthropic',
    });
    const result = await classifier.classify(
      '00000000-0000-0000-0000-000000000006',
      'how does this work?',
      {},
    );
    // ASK by regex (question mark + "how").
    assert.strictEqual(result.intent, 'ASK');
  });
});
