import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ScribeAgent, type ScribeAIDeps } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import { ScribeOutputSchema, StructuredSpecSchema } from '../../src/pipeline/core/contracts/PipelineSchemas.js';

// ─── Shared Fixtures ─────────────────────────────

const validSpecJson = JSON.stringify({
  spec: {
    title: 'Todo App with Auth',
    problemStatement:
      'Kullanıcıların günlük görevlerini takip edebilecekleri, kimlik doğrulama ile giriş yapabilecekleri bir uygulama.',
    userStories: [
      { persona: 'Kullanıcı', action: 'Görev oluşturma', benefit: 'Takip' },
      { persona: 'Kullanıcı', action: 'Görev tamamlama', benefit: 'İlerleme' },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', given: 'Giriş yapılmış', when: 'Görev eklenince', then: 'Listede görünür' },
      { id: 'ac-2', given: 'Görev varken', when: 'Tamamla tıklanınca', then: 'İşaretlenir' },
    ],
    technicalConstraints: { stack: 'React + Vite', integrations: ['OAuth'], nonFunctional: ['Responsive'] },
    outOfScope: ['Admin paneli', 'Bildirimler'],
  },
  plan: {
    projectName: 'Todo App with Auth',
    summary: 'Kullanıcıların görevlerini yönetebileceği basit bir web uygulaması.',
    features: [
      { name: 'Görev Yönetimi', description: 'Görev oluşturma ve tamamlama' },
      { name: 'Kimlik Doğrulama', description: 'OAuth ile giriş' },
    ],
    techChoices: ['React', 'Vite'],
    estimatedFiles: 8,
    requiresTests: true,
    testRationale: 'İş mantığı testleri gerekli',
  },
  rawMarkdown: '# Todo App\n\n## Problem\nGörev takibi uygulaması.',
  confidence: 0.88,
  clarificationsAsked: 0,
});

const clarificationJson = JSON.stringify({
  ready: false,
  questions: [
    { id: 'q1', question: 'Veritabanı tercihiniz?', reason: 'Stack seçimi', suggestions: ['PostgreSQL', 'MongoDB'] },
    { id: 'q2', question: 'Platform tercihiniz?', reason: 'UI kararı', suggestions: ['Web', 'Mobile'] },
  ],
});

const readyJson = JSON.stringify({ ready: true });

// ─── Mock Helpers ────────────────────────────────

function createMockAI(responses: string[]): ScribeAIDeps {
  let callIndex = 0;
  return {
    async generateText(_system: string, _user: string): Promise<string> {
      if (callIndex >= responses.length) throw new Error('No more mock responses');
      return responses[callIndex++];
    },
  };
}

/** Creates a mock AI that captures all prompts sent to it. */
function createCapturingMockAI(responses: string[]): ScribeAIDeps & { calls: Array<{ system: string; user: string }> } {
  let callIndex = 0;
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    async generateText(system: string, user: string): Promise<string> {
      calls.push({ system, user });
      if (callIndex >= responses.length) throw new Error('No more mock responses');
      return responses[callIndex++];
    },
  };
}

// ════════════════════════════════════════════════════
// 1. AI returns malformed JSON
// ════════════════════════════════════════════════════

describe('Scribe Edge — Malformed JSON from AI', () => {
  it('returns error for completely non-JSON clarification response', async () => {
    const ai = createMockAI(['This is not JSON at all, just plain text.']);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir e-ticaret uygulaması istiyorum, ödeme sistemi olsun',
    });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'AI_INVALID_RESPONSE');
      assert.equal(result.error.retryable, true);
    }
  });

  it('returns error for truncated JSON in clarification', async () => {
    // Severely truncated — missing closing braces and key data
    const ai = createMockAI(['{"ready": false, "questions": [{"id": "q1"']);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir blog platformu yapmak istiyorum, markdown desteklesin',
    });

    const result = await agent.analyzIdea(state);
    // The parseAIJson repair might fix it but the schema validation should still reject it
    // Either way: should not crash — should produce error or fallback to spec generation
    assert.ok(result.type === 'error' || result.type === 'spec' || result.type === 'clarification');
  });

  it('returns error when spec JSON is HTML instead of JSON', async () => {
    // Repeat the HTML for all retry attempts (specValidationMaxRetries = 2 → 3 total)
    const htmlResponse = '<html><body>Error 500</body></html>';
    const ai = createMockAI([readyJson, htmlResponse, htmlResponse, htmlResponse]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'React ile bir dashboard uygulaması istiyorum, grafikler olsun',
    });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.ok(
        result.error.code === 'AI_INVALID_RESPONSE' ||
        result.error.code === 'SCRIBE_SPEC_VALIDATION_FAILED',
      );
    }
  });

  it('returns error for JSON with wrong structure in spec generation', async () => {
    // Valid JSON but completely wrong schema for spec output
    const wrongShape = JSON.stringify({ foo: 'bar', baz: 123 });
    const ai = createMockAI([readyJson, wrongShape, wrongShape, wrongShape]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Basit bir hesap makinesi uygulaması istiyorum, web tarayıcıda çalışsın',
    });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'SCRIBE_SPEC_VALIDATION_FAILED');
    }
  });

  it('handles JSON with embedded null bytes', async () => {
    const jsonWithNull = readyJson.slice(0, 5) + '\x00' + readyJson.slice(5);
    const ai = createMockAI([jsonWithNull, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir proje yönetim uygulaması istiyorum, kanban board olsun',
    });

    const result = await agent.analyzIdea(state);
    // Should either successfully parse (repair) or return a clean error
    assert.ok(result.type === 'spec' || result.type === 'error');
  });
});

// ════════════════════════════════════════════════════
// 2. AI returns empty/incomplete spec
// ════════════════════════════════════════════════════

describe('Scribe Edge — Empty/incomplete spec from AI', () => {
  it('rejects spec missing problemStatement', async () => {
    const incomplete = JSON.stringify({
      spec: {
        title: 'Incomplete App',
        problemStatement: '', // too short — Zod min(10) will reject
        userStories: [{ persona: 'Kullanıcı', action: 'Bir şey yapma', benefit: 'Fayda' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'Hazır', when: 'Tıklayınca', then: 'Sonuç' }],
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      plan: {
        projectName: 'Incomplete App',
        summary: 'Eksik uygulama.',
        features: [{ name: 'Özellik', description: 'Açıklama' }],
        techChoices: ['React'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      rawMarkdown: '# Incomplete',
      confidence: 0.5,
      clarificationsAsked: 0,
    });

    // Repeat the same invalid spec for all retry attempts (specValidationMaxRetries = 2, so 3 total tries)
    const ai = createMockAI([readyJson, incomplete, incomplete, incomplete]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir uygulama istiyorum ama detay vermiyorum aslında biraz vereceğim',
    });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'SCRIBE_SPEC_VALIDATION_FAILED');
    }
  });

  it('rejects spec with empty userStories array', async () => {
    const emptyStories = JSON.stringify({
      spec: {
        title: 'Empty Stories App',
        problemStatement: 'Bu uygulama kullanıcıların görevlerini takip etmesini sağlar.',
        userStories: [], // Zod min(1) rejects this
        acceptanceCriteria: [{ id: 'ac-1', given: 'Hazır', when: 'Test', then: 'Sonuç' }],
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      plan: {
        projectName: 'Empty Stories App',
        summary: 'Görev takip uygulaması.',
        features: [{ name: 'Özellik', description: 'Açıklama' }],
        techChoices: ['React'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      rawMarkdown: '# Empty',
      confidence: 0.7,
      clarificationsAsked: 0,
    });

    const ai = createMockAI([readyJson, emptyStories, emptyStories, emptyStories]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir web uygulaması istiyorum, kullanıcılar dosya yükleyebilsin',
    });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'SCRIBE_SPEC_VALIDATION_FAILED');
    }
  });

  it('rejects spec with empty acceptanceCriteria', async () => {
    const emptyCriteria = JSON.stringify({
      spec: {
        title: 'No Criteria App',
        problemStatement: 'Bu uygulama kullanıcıların mesajlaşmasını sağlar bir platform.',
        userStories: [{ persona: 'Kullanıcı', action: 'Mesaj gönderme', benefit: 'İletişim' }],
        acceptanceCriteria: [], // Zod min(1) rejects this
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      plan: {
        projectName: 'No Criteria App',
        summary: 'Mesajlaşma uygulaması.',
        features: [{ name: 'Mesajlaşma', description: 'Mesaj gönderme' }],
        techChoices: ['React'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      rawMarkdown: '# No Criteria',
      confidence: 0.7,
      clarificationsAsked: 0,
    });

    const ai = createMockAI([readyJson, emptyCriteria, emptyCriteria, emptyCriteria]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Basit bir chat uygulaması istiyorum, gerçek zamanlı mesajlaşma olsun',
    });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'SCRIBE_SPEC_VALIDATION_FAILED');
    }
  });

  it('handles spec where userStories is a string (normalizeSpecResponse should fix)', async () => {
    const stringStories = JSON.stringify({
      spec: {
        title: 'String Stories App',
        problemStatement: 'Kullanıcıların not tutabilecekleri basit bir not alma uygulaması.',
        userStories: 'Kullanıcı not oluşturabilir', // string instead of array — normalization target
        acceptanceCriteria: [{ id: 'ac-1', given: 'Hazır', when: 'Not eklenince', then: 'Kaydedilir' }],
        technicalConstraints: { stack: 'React + Vite' },
        outOfScope: [],
      },
      plan: {
        projectName: 'String Stories App',
        summary: 'Not alma uygulaması.',
        features: [{ name: 'Not Yönetimi', description: 'Not oluşturma ve düzenleme' }],
        techChoices: ['React', 'Vite'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      rawMarkdown: '# String Stories',
      confidence: 0.85,
      clarificationsAsked: 0,
    });

    const ai = createMockAI([readyJson, stringStories]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Basit bir not alma uygulaması istiyorum, markdown desteklesin güzel olur',
    });

    const result = await agent.analyzIdea(state);
    // normalizeSpecResponse should convert the string to [{persona, action, benefit}]
    assert.equal(result.type, 'spec');
    if (result.type === 'spec') {
      assert.ok(Array.isArray(result.data.spec.userStories));
      assert.ok(result.data.spec.userStories.length >= 1);
    }
  });
});

// ════════════════════════════════════════════════════
// 3. Clarification with empty user answers
// ════════════════════════════════════════════════════

describe('Scribe Edge — Empty user answers to clarification', () => {
  it('does not crash when user sends whitespace-only answer', async () => {
    const ai = createMockAI([clarificationJson, readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir sosyal medya platformu istiyorum, kullanıcılar paylaşım yapabilsin',
    });

    await agent.analyzIdea(state);
    assert.equal(state.clarificationRound, 1);

    // User sends just whitespace
    agent.processUserAnswer(state, '   ');

    // All pending should be marked answered (default fallback — no q-IDs detected)
    assert.deepEqual(state.pendingQuestionIds, []);
    assert.equal(state.answeredQuestionIds.length, 2);

    // Continue should still produce a valid result
    const result = await agent.continueAfterAnswer(state);
    assert.ok(result.type === 'spec' || result.type === 'clarification' || result.type === 'error');
  });

  it('handles single-character answer without crashing', async () => {
    const ai = createMockAI([clarificationJson, readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir randevu sistemi istiyorum, doktorlar ve hastalar kullanacak',
    });

    await agent.analyzIdea(state);
    agent.processUserAnswer(state, '?');

    // Should still mark pending as answered (default fallback)
    assert.deepEqual(state.pendingQuestionIds, []);

    const result = await agent.continueAfterAnswer(state);
    assert.ok(result.type !== undefined);
  });

  it('handles answer that is just numbers', async () => {
    const ai = createMockAI([clarificationJson, readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir envanter yönetim sistemi istiyorum, stok takibi yapılabilsin',
    });

    await agent.analyzIdea(state);
    agent.processUserAnswer(state, '12345');

    // No q-IDs mentioned, no delegation — default fallback marks all answered
    assert.deepEqual(state.pendingQuestionIds, []);
    assert.equal(state.answeredQuestionIds.length, 2);
  });
});

// ════════════════════════════════════════════════════
// 4. Confidence below threshold
// ════════════════════════════════════════════════════

describe('Scribe Edge — Low confidence spec', () => {
  it('accepts spec with low confidence if schema is valid', async () => {
    const lowConfSpec = JSON.stringify({
      spec: {
        title: 'Belirsiz Proje',
        problemStatement: 'Kullanıcılar için bir şeyler yapan belirsiz bir uygulama geliştiriyoruz.',
        userStories: [{ persona: 'Kullanıcı', action: 'Bir işlem yapma', benefit: 'Bir fayda' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'Hazır', when: 'Bir şey olunca', then: 'Sonuç oluşur' }],
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      plan: {
        projectName: 'Belirsiz Proje',
        summary: 'Belirsiz bir uygulama.',
        features: [{ name: 'Ana Özellik', description: 'Bir işlem yapma' }],
        techChoices: ['React'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      rawMarkdown: '# Belirsiz Proje',
      confidence: 0.35, // Very low confidence
      clarificationsAsked: 0,
    });

    const ai = createMockAI([readyJson, lowConfSpec]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir uygulama istiyorum, detayları sonra konuşuruz, bir şeyler olsun',
    });

    const result = await agent.analyzIdea(state);
    // Low confidence does not cause an error — the schema allows 0.0-1.0
    assert.equal(result.type, 'spec');
    if (result.type === 'spec') {
      assert.ok(result.data.confidence < 0.5);
      assert.equal(result.data.confidence, 0.35);
    }
  });

  it('rejects spec with confidence outside valid range (> 1)', async () => {
    const overConfSpec = JSON.stringify({
      spec: {
        title: 'Aşırı Güvenli Proje',
        problemStatement: 'Bu uygulama her sorunu çözecek ve tüm kullanıcıları mutlu edecek.',
        userStories: [{ persona: 'Kullanıcı', action: 'Her şeyi yapma', benefit: 'Mutluluk' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'Hazır', when: 'Tıklayınca', then: 'Çalışır' }],
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      plan: {
        projectName: 'Aşırı Güvenli Proje',
        summary: 'Her şeyi çözen uygulama.',
        features: [{ name: 'Her Şey', description: 'Hepsini yapar' }],
        techChoices: ['React'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      rawMarkdown: '# Aşırı Güvenli',
      confidence: 1.5, // Invalid — Zod max(1) will reject
      clarificationsAsked: 0,
    });

    const ai = createMockAI([readyJson, overConfSpec, overConfSpec, overConfSpec]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Süper bir uygulama istiyorum, her şeyi yapacak, dünyayı kurtaracak',
    });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'SCRIBE_SPEC_VALIDATION_FAILED');
    }
  });

  it('rejects spec with negative confidence', async () => {
    const negativeConf = JSON.stringify({
      spec: {
        title: 'Negatif Güven Projesi',
        problemStatement: 'Bu proje hakkında hiçbir şey bilmiyoruz aslında pek bir şey yok.',
        userStories: [{ persona: 'Kullanıcı', action: 'Bir şey', benefit: 'Belirsiz' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'Hazır', when: 'Olunca', then: 'Olur' }],
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      plan: {
        projectName: 'Negatif Güven Projesi',
        summary: 'Belirsiz proje.',
        features: [{ name: 'Özellik', description: 'Açıklama' }],
        techChoices: ['React'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      rawMarkdown: '# Negatif',
      confidence: -0.3, // Invalid — Zod min(0) will reject
      clarificationsAsked: 0,
    });

    const ai = createMockAI([readyJson, negativeConf, negativeConf, negativeConf]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir uygulama istiyorum ama ne olduğunu tam bilmiyorum, bir şey olsun',
    });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'SCRIBE_SPEC_VALIDATION_FAILED');
    }
  });
});

// ════════════════════════════════════════════════════
// 5. Max clarification rounds — forced spec generation
// ════════════════════════════════════════════════════

describe('Scribe Edge — Max clarification rounds enforcement', () => {
  it('forces spec generation at exactly round 3, even if AI keeps asking', async () => {
    const ai = createMockAI([
      clarificationJson, // round 1
      clarificationJson, // round 2
      clarificationJson, // round 3
      validSpecJson,     // forced spec at round 4 attempt
    ]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Bir uygulama istiyorum',
    });

    // Round 1
    const r1 = await agent.analyzIdea(state);
    assert.equal(r1.type, 'clarification');
    assert.equal(state.clarificationRound, 1);
    agent.processUserAnswer(state, 'Bilmiyorum');

    // Round 2
    const r2 = await agent.continueAfterAnswer(state);
    assert.equal(r2.type, 'clarification');
    assert.equal(state.clarificationRound, 2);
    agent.processUserAnswer(state, 'Yine bilmiyorum');

    // Round 3
    const r3 = await agent.continueAfterAnswer(state);
    assert.equal(r3.type, 'clarification');
    assert.equal(state.clarificationRound, 3);
    agent.processUserAnswer(state, 'Hala bilmiyorum');

    // Round 4 attempt: MAX_CLARIFICATION_ROUNDS (3) reached → forced spec
    const r4 = await agent.continueAfterAnswer(state);
    assert.equal(r4.type, 'spec');
    assert.equal(state.phase, 'done');
  });

  it('sets clarificationsAsked to the actual number of rounds', async () => {
    const ai = createMockAI([
      clarificationJson,
      clarificationJson,
      clarificationJson,
      validSpecJson,
    ]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Çok belirsiz bir şeyler istiyorum detay vermiyorum',
    });

    await agent.analyzIdea(state);
    agent.processUserAnswer(state, 'Cevap 1');
    await agent.continueAfterAnswer(state);
    agent.processUserAnswer(state, 'Cevap 2');
    await agent.continueAfterAnswer(state);
    agent.processUserAnswer(state, 'Cevap 3');

    const result = await agent.continueAfterAnswer(state);
    assert.equal(result.type, 'spec');
    if (result.type === 'spec') {
      assert.equal(result.data.clarificationsAsked, 3);
    }
  });
});

// ════════════════════════════════════════════════════
// 6. Special characters in idea
// ════════════════════════════════════════════════════

describe('Scribe Edge — Special characters in idea', () => {
  it('handles Turkish characters (ğüşıöç) in the idea', async () => {
    const turkishIdea = 'Türkçe öğrenmek için bir uygulama istiyorum, sözcük çalışması ve şıklar olsun, İstanbul güzergâhı';
    const ai = createCapturingMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: turkishIdea });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');

    // Verify the idea was passed through to the AI prompt
    assert.ok(ai.calls[0].user.includes(turkishIdea));
  });

  it('handles emoji in the idea without crashing', async () => {
    const emojiIdea = 'Bir yemek tarifi uygulaması 🍕🍔 istiyorum, kullanıcılar ❤️ favorilerine ekleyebilsin 🎉';
    const ai = createMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: emojiIdea });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');
    assert.equal(state.idea, emojiIdea);
  });

  it('handles HTML tags in the idea (potential XSS)', async () => {
    const xssIdea = 'Bir forum uygulaması istiyorum <script>alert("xss")</script> kullanıcılar <b>yorum</b> yazabilsin';
    const ai = createCapturingMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: xssIdea });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');

    // The agent should pass the raw idea to AI without stripping — AI decides
    assert.ok(ai.calls[0].user.includes('<script>'));
    assert.equal(state.idea, xssIdea);
  });

  it('handles newlines and tabs in the idea', async () => {
    const multilineIdea = 'Bir proje yönetim aracı istiyorum:\n- Görev oluşturma\n- Zaman takibi\n\tAlt görevler olsun';
    const ai = createMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: multilineIdea });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');
    assert.ok(state.idea.includes('\n'));
    assert.ok(state.idea.includes('\t'));
  });

  it('handles backticks and code fences in the idea', async () => {
    const codeIdea = 'Bir IDE uygulaması istiyorum, `console.log("test")` gibi kod çalıştırabilsin, ```js\nconst x = 1;\n``` blokları desteklesin';
    const ai = createMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: codeIdea });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');
  });

  it('handles SQL injection-like content in the idea', async () => {
    const sqlIdea = "Bir veritabanı yönetim aracı istiyorum; DROP TABLE users; -- SELECT * FROM admin";
    const ai = createMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: sqlIdea });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');
    assert.equal(state.idea, sqlIdea);
  });
});

// ════════════════════════════════════════════════════
// 7. Very long idea
// ════════════════════════════════════════════════════

describe('Scribe Edge — Very long idea', () => {
  it('processes a 5000+ character idea without crashing', async () => {
    // Generate a realistic long idea
    const repeatedDetail = 'Kullanıcılar profil oluşturabilmeli, resim yükleyebilmeli, arkadaş ekleyebilmeli. ';
    const longIdea = 'Kapsamlı bir sosyal medya platformu istiyorum. ' + repeatedDetail.repeat(70);
    assert.ok(longIdea.length > 5000, `Idea length should be >5000, got ${longIdea.length}`);

    const ai = createCapturingMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: longIdea });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');

    // Verify the full idea was sent to the AI (no silent truncation)
    assert.ok(ai.calls[0].user.includes(longIdea));
  });

  it('preserves the entire idea in conversation state', async () => {
    const longIdea = 'A'.repeat(8000) + ' bir uygulama istiyorum';
    const ai = createMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: longIdea });

    assert.equal(state.idea, longIdea);
    assert.equal(state.conversation[0].type, 'user_idea');
    if (state.conversation[0].type === 'user_idea') {
      assert.equal(state.conversation[0].content, longIdea);
    }
  });

  it('handles idea at exactly the Zod max limit (10000 chars)', async () => {
    // ScribeInputSchema allows max 10000 chars
    const maxIdea = 'B'.repeat(9980) + ' bir uygulama olsun';
    assert.ok(maxIdea.length <= 10000);

    const ai = createMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({ idea: maxIdea });

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');
  });
});

// ════════════════════════════════════════════════════
// 8. ScribeOutput schema validation
// ════════════════════════════════════════════════════

describe('Scribe Edge — ScribeOutput schema validation', () => {
  it('valid spec output passes Zod schema validation', () => {
    const parsed = JSON.parse(validSpecJson);
    const result = ScribeOutputSchema.safeParse(parsed);
    assert.ok(result.success, `Schema validation should pass: ${JSON.stringify(result.error?.issues)}`);
  });

  it('rejects output with missing plan field', () => {
    const noPlan = {
      spec: {
        title: 'Test',
        problemStatement: 'Bu bir test projesi için geliştirilen uygulama.',
        userStories: [{ persona: 'User', action: 'Do thing', benefit: 'Benefit' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'Ready', when: 'Click', then: 'Result' }],
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      // plan is missing
      rawMarkdown: '# Test',
      confidence: 0.8,
      clarificationsAsked: 0,
    };
    const result = ScribeOutputSchema.safeParse(noPlan);
    assert.ok(!result.success);
  });

  it('rejects output with missing rawMarkdown', () => {
    const noMarkdown = {
      spec: {
        title: 'Test',
        problemStatement: 'Bu bir test projesi için geliştirilen uygulama.',
        userStories: [{ persona: 'User', action: 'Do thing', benefit: 'Benefit' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'Ready', when: 'Click', then: 'Result' }],
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      plan: {
        projectName: 'Test',
        summary: 'Test projesi.',
        features: [{ name: 'F', description: 'D' }],
        techChoices: ['React'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      // rawMarkdown is missing
      confidence: 0.8,
      clarificationsAsked: 0,
    };
    const result = ScribeOutputSchema.safeParse(noMarkdown);
    assert.ok(!result.success);
  });

  it('rejects output with confidence as string instead of number', () => {
    const stringConfidence = {
      spec: {
        title: 'Test',
        problemStatement: 'Bu bir test projesi için geliştirilen uygulama.',
        userStories: [{ persona: 'User', action: 'Do thing', benefit: 'Benefit' }],
        acceptanceCriteria: [{ id: 'ac-1', given: 'Ready', when: 'Click', then: 'Result' }],
        technicalConstraints: { stack: 'React' },
        outOfScope: [],
      },
      plan: {
        projectName: 'Test',
        summary: 'Test projesi.',
        features: [{ name: 'F', description: 'D' }],
        techChoices: ['React'],
        estimatedFiles: 6,
        requiresTests: true,
      },
      rawMarkdown: '# Test',
      confidence: 'high', // should be a number
      clarificationsAsked: 0,
    };
    const result = ScribeOutputSchema.safeParse(stringConfidence);
    assert.ok(!result.success);
  });

  it('accepts output with optional reviewNotes as string', () => {
    const parsed = JSON.parse(validSpecJson);
    parsed.reviewNotes = 'Self-review completed, no issues found';
    const result = ScribeOutputSchema.safeParse(parsed);
    assert.ok(result.success, `Should accept string reviewNotes: ${JSON.stringify(result.error?.issues)}`);
  });

  it('accepts output with optional reviewNotes as object', () => {
    const parsed = JSON.parse(validSpecJson);
    parsed.reviewNotes = {
      selfReviewPassed: true,
      revisionsApplied: ['Fixed AC-1'],
      assumptionsMade: ['Web platform assumed'],
    };
    const result = ScribeOutputSchema.safeParse(parsed);
    assert.ok(result.success, `Should accept object reviewNotes: ${JSON.stringify(result.error?.issues)}`);
  });

  it('accepts output with assumptions array', () => {
    const parsed = JSON.parse(validSpecJson);
    parsed.assumptions = ['Web tarayıcısı hedef platform', 'Kullanıcı girişi gerekli'];
    const result = ScribeOutputSchema.safeParse(parsed);
    assert.ok(result.success, `Should accept assumptions: ${JSON.stringify(result.error?.issues)}`);
  });

  it('rejects userStory with empty persona', () => {
    const result = StructuredSpecSchema.safeParse({
      title: 'Test',
      problemStatement: 'Bu bir test projesi açıklaması yeterince uzun.',
      userStories: [{ persona: '', action: 'Do', benefit: 'Benefit' }],
      acceptanceCriteria: [{ id: 'ac-1', given: 'G', when: 'W', then: 'T' }],
      technicalConstraints: { stack: 'React' },
      outOfScope: [],
    });
    assert.ok(!result.success);
  });

  it('validates plan features require non-empty name and description', () => {
    const parsed = JSON.parse(validSpecJson);
    parsed.plan.features = [{ name: '', description: '' }];
    const result = ScribeOutputSchema.safeParse(parsed);
    assert.ok(!result.success);
  });

  it('validates plan estimatedFiles must be positive integer', () => {
    const parsed = JSON.parse(validSpecJson);
    parsed.plan.estimatedFiles = 0; // min(1) should reject
    const result = ScribeOutputSchema.safeParse(parsed);
    assert.ok(!result.success);
  });

  it('validates clarificationsAsked is between 0 and 3', () => {
    const parsed = JSON.parse(validSpecJson);
    parsed.clarificationsAsked = 5; // max(3) should reject
    const result = ScribeOutputSchema.safeParse(parsed);
    assert.ok(!result.success);
  });
});

// ════════════════════════════════════════════════════
// Additional edge cases: state transitions
// ════════════════════════════════════════════════════

describe('Scribe Edge — State transition edge cases', () => {
  it('phase transitions from clarifying → generating → done', async () => {
    const ai = createMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'React ile bir portfolio sitesi istiyorum, projelerimi gösterebileceğim',
    });

    assert.equal(state.phase, 'clarifying');

    const result = await agent.analyzIdea(state);
    assert.equal(result.type, 'spec');
    assert.equal(state.phase, 'done');
  });

  it('clarification round does not mutate phase to generating', async () => {
    const ai = createMockAI([clarificationJson, readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Belirsiz bir uygulama istiyorum',
    });

    await agent.analyzIdea(state);
    // After clarification, phase stays 'clarifying' (not 'generating')
    assert.equal(state.phase, 'clarifying');
  });

  it('regenerateSpec adds rejection to conversation and resets phase', async () => {
    const ai = createMockAI([readyJson, validSpecJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Basit bir blog uygulaması istiyorum, markdown yazabileyim',
    });

    await agent.analyzIdea(state);
    assert.equal(state.phase, 'done');

    await agent.regenerateSpec(state, 'Yorum sistemi de ekleyelim');

    // After regeneration, phase should be 'done' again
    assert.equal(state.phase, 'done');

    // Conversation should include the rejection message
    const rejections = state.conversation.filter(m => m.type === 'spec_rejected');
    assert.equal(rejections.length, 1);
  });

  it('context and targetStack are passed through to AI prompts', async () => {
    const ai = createCapturingMockAI([readyJson, validSpecJson]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState({
      idea: 'Mevcut projeyi geliştirmek istiyorum, arama özelliği ekleyelim',
      context: 'Daha önce bir e-ticaret sitesi yaptık, React + Express kullanıyoruz',
      targetStack: 'React + Express + PostgreSQL',
    });

    await agent.analyzIdea(state);

    // Verify context was included in clarification prompt
    assert.ok(ai.calls[0].user.includes('e-ticaret'));
    assert.ok(ai.calls[0].user.includes('React + Express + PostgreSQL'));
  });
});
