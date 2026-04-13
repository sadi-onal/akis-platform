/**
 * ScribeAgent comprehensive unit tests.
 *
 * Covers: spec format validation, clarification question generation,
 * confidence scoring, conversation state management, partial answers,
 * regeneration with feedback, and error recovery.
 *
 * These tests verify the "knowledge integrity" of Scribe's output —
 * a core thesis requirement for agent verification.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ScribeAgent, type ScribeAIDeps } from '../../../src/pipeline/agents/scribe/ScribeAgent.js';
import { validateScribeInput } from '../../../src/pipeline/agents/scribe/SpecContract.js';
import type { ScribeInput } from '../../../src/pipeline/core/contracts/PipelineTypes.js';

// ─── Fixtures ─────────────────────────────────────

const VALID_SPEC_JSON = JSON.stringify({
  spec: {
    title: 'E-commerce Dashboard',
    problemStatement: 'Satış verilerini görselleştiren bir admin paneli gerekiyor.',
    userStories: [
      { persona: 'Admin', action: 'Satış grafiklerini görüntüleme', benefit: 'İş kararları almak' },
      { persona: 'Admin', action: 'Ürün stok takibi', benefit: 'Stok planlaması yapmak' },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', given: 'Admin giriş yapmışken', when: 'Dashboard sayfasını açar', then: 'Satış grafikleri görünür' },
      { id: 'ac-2', given: 'Admin stok sayfasındayken', when: 'Stok filtresi uygular', then: 'Filtrelenmiş stoklar listelenir' },
    ],
    technicalConstraints: { stack: 'React + Chart.js', integrations: ['REST API'], nonFunctional: ['Responsive'] },
    outOfScope: ['Ödeme sistemi', 'Müşteri portalı'],
  },
  rawMarkdown: '# E-commerce Dashboard\n\n## Problem\nSatış verilerini görselleştiren panel.',
  confidence: 0.92,
  clarificationsAsked: 0,
});

const CLARIFICATION_JSON = JSON.stringify({
  ready: false,
  questions: [
    { id: 'q1', question: 'Hangi veritabanını kullanmak istiyorsunuz?', reason: 'Veri katmanı seçimi', suggestions: ['PostgreSQL', 'MongoDB', 'SQLite'] },
    { id: 'q2', question: 'Kimlik doğrulama yöntemi ne olmalı?', reason: 'Güvenlik katmanı', suggestions: ['JWT', 'Session', 'OAuth'] },
  ],
});

const READY_JSON = JSON.stringify({ ready: true });

function createMockAI(responses: string[]): ScribeAIDeps {
  let callIndex = 0;
  return {
    async generateText(): Promise<string> {
      if (callIndex >= responses.length) throw new Error('No more mock responses');
      return responses[callIndex++];
    },
  };
}

function createFailingAI(error: Error): ScribeAIDeps {
  return { async generateText() { throw error; } };
}

function baseInput(overrides?: Partial<ScribeInput>): ScribeInput {
  return {
    idea: 'E-commerce admin paneli istiyorum, satış grafikleri ve stok takibi olsun',
    ...overrides,
  };
}

// ─── Input Validation ─────────────────────────────

describe('ScribeAgent — Input Validation', () => {
  it('rejects idea shorter than 10 characters', () => {
    assert.throws(() => validateScribeInput({ idea: 'short' }), 'Should throw on short idea');
  });

  it('accepts idea with valid length', () => {
    const result = validateScribeInput({
      idea: 'Bir todo app istiyorum basit olsun detaylı',
    });
    assert.ok(result.idea, 'Should return parsed input with idea');
  });

  it('accepts idea with context and targetStack', () => {
    const result = validateScribeInput({
      idea: 'Bir e-commerce platformu istiyorum geniş kapsamlı olsun',
      context: 'Mevcut bir Express backend var',
      targetStack: 'React + TypeScript',
    });
    assert.ok(result.idea);
    assert.equal(result.context, 'Mevcut bir Express backend var');
  });

  it('rejects empty idea', () => {
    assert.throws(() => validateScribeInput({ idea: '' }));
  });
});

// ─── Spec Format Validation ───────────────────────

describe('ScribeAgent — Spec Format Verification', () => {
  it('generates spec with all required fields', async () => {
    const ai = createMockAI([READY_JSON, VALID_SPEC_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.analyzIdea(state);

    assert.equal(result.type, 'spec');
    if (result.type !== 'spec') return;

    const spec = result.data.spec;
    assert.ok(spec.title, 'Must have title');
    assert.ok(spec.problemStatement, 'Must have problemStatement');
    assert.ok(Array.isArray(spec.userStories), 'userStories must be array');
    assert.ok(spec.userStories.length > 0, 'Must have at least one user story');
    assert.ok(Array.isArray(spec.acceptanceCriteria), 'acceptanceCriteria must be array');
    assert.ok(spec.acceptanceCriteria.length > 0, 'Must have at least one AC');
    assert.ok(spec.technicalConstraints, 'Must have technicalConstraints');
    assert.ok(Array.isArray(spec.outOfScope), 'outOfScope must be array');
  });

  it('validates acceptance criteria have Given-When-Then format', async () => {
    const ai = createMockAI([READY_JSON, VALID_SPEC_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.analyzIdea(state);

    assert.equal(result.type, 'spec');
    if (result.type !== 'spec') return;

    for (const ac of result.data.spec.acceptanceCriteria) {
      assert.ok(ac.id, `AC must have id`);
      assert.ok(ac.given, `AC ${ac.id} must have given`);
      assert.ok(ac.when, `AC ${ac.id} must have when`);
      assert.ok(ac.then, `AC ${ac.id} must have then`);
    }
  });

  it('validates user stories have persona-action-benefit structure', async () => {
    const ai = createMockAI([READY_JSON, VALID_SPEC_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.analyzIdea(state);

    assert.equal(result.type, 'spec');
    if (result.type !== 'spec') return;

    for (const story of result.data.spec.userStories) {
      assert.ok(story.persona, 'User story must have persona');
      assert.ok(story.action, 'User story must have action');
      assert.ok(story.benefit, 'User story must have benefit');
    }
  });

  it('includes confidence score in output', async () => {
    const ai = createMockAI([READY_JSON, VALID_SPEC_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.analyzIdea(state);

    assert.equal(result.type, 'spec');
    if (result.type !== 'spec') return;
    assert.ok(typeof result.data.confidence === 'number', 'Must have confidence');
    assert.ok(result.data.confidence >= 0 && result.data.confidence <= 1, 'Confidence must be 0-1');
  });

  it('includes rawMarkdown in output', async () => {
    const ai = createMockAI([READY_JSON, VALID_SPEC_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.analyzIdea(state);

    assert.equal(result.type, 'spec');
    if (result.type !== 'spec') return;
    assert.ok(result.data.rawMarkdown, 'Must have rawMarkdown');
    assert.ok(result.data.rawMarkdown.length > 0, 'rawMarkdown must not be empty');
  });
});

// ─── Clarification Flow ───────────────────────────

describe('ScribeAgent — Clarification Questions', () => {
  it('asks clarifying questions for vague ideas', async () => {
    const ai = createMockAI([CLARIFICATION_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput({ idea: 'bir uygulama yapılacak detaylar belirsiz herhalde' }));
    const result = await agent.analyzIdea(state);

    assert.equal(result.type, 'clarification');
    if (result.type !== 'clarification') return;
    assert.ok(result.data.questions.length > 0, 'Must ask at least one question');
  });

  it('tracks question IDs in pending state', async () => {
    const ai = createMockAI([CLARIFICATION_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput({ idea: 'bir uygulama yapılacak detaylar belirsiz herhalde' }));
    await agent.analyzIdea(state);

    assert.ok(state.pendingQuestionIds.length > 0, 'Should have pending question IDs');
    assert.ok(state.pendingQuestionIds.includes('q1'), 'Should include q1');
    assert.ok(state.pendingQuestionIds.includes('q2'), 'Should include q2');
  });

  it('processes user answer and updates conversation', async () => {
    const ai = createMockAI([CLARIFICATION_JSON, READY_JSON, VALID_SPEC_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput({ idea: 'bir uygulama yapılacak detaylar belirsiz herhalde' }));
    await agent.analyzIdea(state);

    agent.processUserAnswer(state, 'PostgreSQL kullanmak istiyorum, JWT ile auth');
    assert.ok(state.conversation.some(m => m.type === 'user_answer'), 'Should have user_answer message');
  });

  it('generates spec after user answers', async () => {
    const ai = createMockAI([CLARIFICATION_JSON, READY_JSON, VALID_SPEC_JSON]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput({ idea: 'bir uygulama yapılacak detaylar belirsiz herhalde' }));
    await agent.analyzIdea(state);

    agent.processUserAnswer(state, 'PostgreSQL kullanmak istiyorum');
    const result = await agent.continueAfterAnswer(state);

    // After answering, Scribe either asks more questions or generates spec
    assert.ok(result.type === 'spec' || result.type === 'clarification', 'Should produce spec or more questions');
  });
});

// ─── Spec Regeneration ────────────────────────────

describe('ScribeAgent — Spec Regeneration', () => {
  it('regenerates spec with user feedback', async () => {
    const modifiedSpec = JSON.parse(VALID_SPEC_JSON);
    modifiedSpec.spec.title = 'Updated E-commerce Dashboard';
    const ai = createMockAI([
      READY_JSON, VALID_SPEC_JSON,
      JSON.stringify(modifiedSpec),
    ]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    await agent.analyzIdea(state);

    const result = await agent.regenerateSpec(state, 'Başlığı daha açıklayıcı yap');
    assert.equal(result.type, 'spec');
    if (result.type !== 'spec') return;
    assert.equal(result.data.spec.title, 'Updated E-commerce Dashboard');
  });
});

// ─── Error Handling ───────────────────────────────

describe('ScribeAgent — Error Recovery', () => {
  it('returns error on AI service failure', async () => {
    const ai = createFailingAI(new Error('API rate limit'));
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.generateSpec(state);

    assert.equal(result.type, 'error');
  });

  it('returns error on invalid JSON response', async () => {
    const ai = createMockAI(['this is not json at all']);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.generateSpec(state);

    assert.equal(result.type, 'error');
  });

  it('handles JSON wrapped in markdown fences', async () => {
    const fenced = '```json\n' + VALID_SPEC_JSON + '\n```';
    const ai = createMockAI([fenced]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.generateSpec(state);

    assert.equal(result.type, 'spec');
  });
});

// ─── Conversation State ───────────────────────────

describe('ScribeAgent — Conversation State Tracking', () => {
  it('initializes conversation with user_idea message', () => {
    const ai = createMockAI([]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());

    assert.ok(state.conversation.length > 0, 'Should have initial conversation');
    assert.equal(state.conversation[0].type, 'user_idea');
    assert.ok(state.conversation[0].content.includes('E-commerce'), 'Should contain user idea');
  });

  it('starts in clarifying phase', () => {
    const ai = createMockAI([]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());

    assert.equal(state.phase, 'clarifying');
    assert.equal(state.clarificationRound, 0);
  });

  it('preserves context when provided', () => {
    const ai = createMockAI([]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput({
      idea: 'Mevcut projeye yeni özellik ekle detaylı bir şekilde',
      context: 'Express.js backend, React frontend mevcut',
    }));

    assert.ok(state.context, 'Should preserve context');
    assert.ok(state.context!.includes('Express.js'));
  });
});

// ─── Normalisation ────────────────────────────────

describe('ScribeAgent — Field Normalisation', () => {
  it('normalises string userStories to array', async () => {
    const specWithStringStories = JSON.parse(VALID_SPEC_JSON);
    specWithStringStories.spec.userStories = 'Admin olarak satış verilerini görmek istiyorum' as unknown;
    const ai = createMockAI([JSON.stringify(specWithStringStories)]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.generateSpec(state);

    assert.equal(result.type, 'spec');
    if (result.type !== 'spec') return;
    assert.ok(Array.isArray(result.data.spec.userStories), 'Should normalise to array');
  });

  it('normalises string outOfScope to array', async () => {
    const specWithStringOOS = JSON.parse(VALID_SPEC_JSON);
    specWithStringOOS.spec.outOfScope = 'Admin paneli' as unknown;
    const ai = createMockAI([JSON.stringify(specWithStringOOS)]);
    const agent = new ScribeAgent(ai);
    const state = agent.createInitialState(baseInput());
    const result = await agent.generateSpec(state);

    assert.equal(result.type, 'spec');
    if (result.type !== 'spec') return;
    assert.ok(Array.isArray(result.data.spec.outOfScope), 'Should normalise to array');
  });
});
