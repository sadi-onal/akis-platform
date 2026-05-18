import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CriticAgent, type CriticAIDeps } from '../CriticAgent.js';
import type { CriticReviewInput } from '../CriticTypes.js';

// ─── Test Fixtures ────────────────────────────────

const goodSpec = {
  title: 'Todo Uygulamasi',
  problemStatement: 'Kullanicilarin gunluk gorevlerini takip edebilecekleri basit bir uygulama.',
  userStories: [
    { persona: 'Kayitli kullanici', action: 'Yeni gorev olusturma', benefit: 'Gunluk islerimi takip edebilmek' },
    { persona: 'Kayitli kullanici', action: 'Gorevi tamamlama', benefit: 'Ilerlemeyi gormek' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Giris yapmis kullanici dashboard sayfasinda', when: 'Yeni gorev butonuna tikladiginda', then: 'Gorev listesinde yeni gorev gorunur' },
    { id: 'ac-2', given: 'Gorev listesinde gorev varken', when: 'Tamamla butonuna tikladiginda', then: 'Gorev tamamlandi olarak isaretlenir' },
  ],
  technicalConstraints: { stack: 'React + Vite', integrations: ['Google OAuth'], nonFunctional: ['Mobile responsive'] },
  outOfScope: ['Admin paneli', 'Bildirimler'],
};

const badSpec = {
  title: '',
  problemStatement: '',
  userStories: [],
  acceptanceCriteria: [],
  technicalConstraints: {},
  outOfScope: [],
};

const goodCodeOutput = {
  ok: true,
  branch: 'main',
  repo: 'todo-app',
  repoUrl: 'https://github.com/user/todo-app',
  files: [
    { filePath: 'src/App.jsx', content: 'export default function App() { return <div>Todo App</div> }', linesOfCode: 5 },
    { filePath: 'package.json', content: '{"name":"todo-app","dependencies":{"react":"^18"}}', linesOfCode: 3 },
  ],
  setupCommands: ['npm install', 'npm run dev'],
  metadata: { filesCreated: 2, totalLinesOfCode: 8, stackUsed: 'React + Vite', committed: true },
};

const badCodeOutput = {
  ok: true,
  branch: 'main',
  repo: 'todo-app',
  repoUrl: 'https://github.com/user/todo-app',
  files: [],
  setupCommands: [],
  metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: '', committed: false },
};

// ─── Mock AI Response Builders ────────────────────

function makeApprovedSpecReview(): string {
  return JSON.stringify({
    approved: true,
    overallScore: 85,
    findings: [
      {
        severity: 'minor',
        category: 'ambiguity',
        description: 'AC-1 could be more specific about form fields',
        suggestion: 'Specify which fields the new task form should contain',
        location: 'acceptanceCriteria[0]',
      },
    ],
    summary: 'Spec is well-structured with clear user stories and testable acceptance criteria.',
    reviewType: 'spec_review',
    iteration: 1,
  });
}

function makeRejectedSpecReview(): string {
  return JSON.stringify({
    approved: false,
    overallScore: 40,
    findings: [
      {
        severity: 'critical',
        category: 'completeness',
        description: 'Problem statement is empty',
        suggestion: 'Add a clear problem statement describing what the app solves',
        location: 'problemStatement',
      },
      {
        severity: 'critical',
        category: 'completeness',
        description: 'No user stories defined',
        suggestion: 'Add at least 2 user stories covering core functionality',
        location: 'userStories',
      },
      {
        severity: 'critical',
        category: 'testability',
        description: 'No acceptance criteria defined',
        suggestion: 'Add Given/When/Then acceptance criteria for each user story',
        location: 'acceptanceCriteria',
      },
    ],
    summary: 'Spec is critically incomplete — missing problem statement, user stories, and acceptance criteria.',
    reviewType: 'spec_review',
    iteration: 1,
  });
}

function makeApprovedCodeReview(): string {
  return JSON.stringify({
    approved: true,
    overallScore: 80,
    findings: [
      {
        severity: 'minor',
        category: 'completeness',
        description: 'Only 2 files created, a real scaffold would need more',
        suggestion: 'Add index.html, vite.config.js, and component files',
        location: 'files',
      },
    ],
    summary: 'Code implements the core spec requirements with acceptable quality.',
    reviewType: 'code_review',
    iteration: 1,
  });
}

function makeRejectedCodeReview(): string {
  return JSON.stringify({
    approved: false,
    overallScore: 20,
    findings: [
      {
        severity: 'critical',
        category: 'spec_compliance',
        description: 'No files generated — spec requirements completely unmet',
        suggestion: 'Generate at minimum: index.html, App.jsx, package.json, and component files for each user story',
        location: 'files',
      },
      {
        severity: 'critical',
        category: 'completeness',
        description: 'Zero lines of code produced',
        suggestion: 'Implement the scaffold with working components',
        location: 'metadata',
      },
    ],
    summary: 'Code output is empty — no files were generated to implement the spec.',
    reviewType: 'code_review',
    iteration: 1,
  });
}

// ─── Mock AI ──────────────────────────────────────

function createMockAI(responses: string[]): CriticAIDeps {
  let callIndex = 0;
  return {
    async generateText(_system: string, _user: string): Promise<string> {
      if (callIndex >= responses.length) {
        throw new Error('No more mock responses');
      }
      return responses[callIndex++];
    },
  };
}

function createFailingAI(): CriticAIDeps {
  return {
    async generateText(): Promise<string> {
      throw new Error('AI provider error');
    },
  };
}

// ─── Spec Review Tests ───────────────────────────

describe('CriticAgent — reviewSpec', () => {
  it('approves a good spec (score >= 75)', async () => {
    const ai = createMockAI([makeApprovedSpecReview()]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'Todo uygulamasi istiyorum',
    };

    const result = await agent.reviewSpec(input);
    assert.equal(result.type, 'review');
    if (result.type === 'review') {
      assert.equal(result.data.approved, true);
      assert.ok(result.data.overallScore >= 75);
      assert.equal(result.data.reviewType, 'spec_review');
      assert.equal(result.data.iteration, 1);
      assert.ok(result.data.findings.length >= 1);
      assert.equal(typeof result.data.summary, 'string');
    }
  });

  it('rejects a bad spec (score < 75)', async () => {
    const ai = createMockAI([makeRejectedSpecReview()]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: badSpec,
      originalIdea: 'Bir sey yap',
    };

    const result = await agent.reviewSpec(input);
    assert.equal(result.type, 'review');
    if (result.type === 'review') {
      assert.equal(result.data.approved, false);
      assert.ok(result.data.overallScore < 75);
      assert.ok(result.data.findings.length >= 2);
      const criticals = result.data.findings.filter(f => f.severity === 'critical');
      assert.ok(criticals.length >= 1, 'Should have at least one critical finding');
    }
  });

  it('returns error for wrong reviewType', async () => {
    const ai = createMockAI([]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'code_review',
      artifact: goodSpec,
      originalIdea: 'test',
    };

    const result = await agent.reviewSpec(input);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'CRITIC_INVALID_INPUT');
    }
  });

  it('handles AI provider failure gracefully', async () => {
    const ai = createFailingAI();
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'test',
    };

    const result = await agent.reviewSpec(input);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'CRITIC_AI_ERROR');
    }
  });

  it('supports custom iteration number', async () => {
    const ai = createMockAI([makeApprovedSpecReview()]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'Todo app',
    };

    const result = await agent.reviewSpec(input, 3);
    assert.equal(result.type, 'review');
    if (result.type === 'review') {
      assert.equal(result.data.iteration, 3);
    }
  });
});

// ─── Code Review Tests ───────────────────────────

describe('CriticAgent — reviewCode', () => {
  it('approves good code output', async () => {
    const ai = createMockAI([makeApprovedCodeReview()]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'code_review',
      artifact: goodCodeOutput,
      originalIdea: 'Todo uygulamasi',
      referenceSpec: goodSpec,
    };

    const result = await agent.reviewCode(input);
    assert.equal(result.type, 'review');
    if (result.type === 'review') {
      assert.equal(result.data.approved, true);
      assert.ok(result.data.overallScore >= 75);
      assert.equal(result.data.reviewType, 'code_review');
    }
  });

  it('rejects bad code output', async () => {
    const ai = createMockAI([makeRejectedCodeReview()]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'code_review',
      artifact: badCodeOutput,
      originalIdea: 'Todo uygulamasi',
      referenceSpec: goodSpec,
    };

    const result = await agent.reviewCode(input);
    assert.equal(result.type, 'review');
    if (result.type === 'review') {
      assert.equal(result.data.approved, false);
      assert.ok(result.data.overallScore < 75);
    }
  });

  it('returns error when referenceSpec is missing', async () => {
    const ai = createMockAI([]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'code_review',
      artifact: goodCodeOutput,
      originalIdea: 'test',
    };

    const result = await agent.reviewCode(input);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'CRITIC_MISSING_SPEC');
    }
  });

  it('returns error for wrong reviewType', async () => {
    const ai = createMockAI([]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: goodCodeOutput,
      originalIdea: 'test',
      referenceSpec: goodSpec,
    };

    const result = await agent.reviewCode(input);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'CRITIC_INVALID_INPUT');
    }
  });
});

// ─── Edge Cases ──────────────────────────────────

describe('CriticAgent — Edge cases', () => {
  it('handles malformed JSON response from AI', async () => {
    const ai = createMockAI(['this is not json at all']);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'test',
    };

    const result = await agent.reviewSpec(input);
    assert.equal(result.type, 'error');
    if (result.type === 'error') {
      assert.equal(result.error.code, 'CRITIC_PARSE_ERROR');
    }
  });

  it('normalizes out-of-range scores to 0-100', async () => {
    const overflowResponse = JSON.stringify({
      approved: true,
      overallScore: 150,
      findings: [],
      summary: 'test',
      reviewType: 'spec_review',
      iteration: 1,
    });
    const ai = createMockAI([overflowResponse]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'test',
    };

    const result = await agent.reviewSpec(input);
    assert.equal(result.type, 'review');
    if (result.type === 'review') {
      assert.ok(result.data.overallScore <= 100, 'Score should be capped at 100');
      assert.equal(result.data.approved, true);
    }
  });

  it('handles JSON wrapped in markdown code fences', async () => {
    const fencedResponse = '```json\n' + makeApprovedSpecReview() + '\n```';
    const ai = createMockAI([fencedResponse]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'test',
    };

    const result = await agent.reviewSpec(input);
    assert.equal(result.type, 'review');
    if (result.type === 'review') {
      assert.equal(result.data.approved, true);
    }
  });

  it('normalizes unknown severity/category to defaults', async () => {
    const weirdResponse = JSON.stringify({
      approved: true,
      overallScore: 80,
      findings: [
        {
          severity: 'catastrophic',
          category: 'unknown_category',
          description: 'test finding',
          suggestion: 'test suggestion',
        },
      ],
      summary: 'test',
      reviewType: 'spec_review',
      iteration: 1,
    });
    const ai = createMockAI([weirdResponse]);
    const agent = new CriticAgent(ai);
    const input: CriticReviewInput = {
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'test',
    };

    const result = await agent.reviewSpec(input);
    assert.equal(result.type, 'review');
    if (result.type === 'review') {
      assert.equal(result.data.findings[0].severity, 'info');
      assert.equal(result.data.findings[0].category, 'completeness');
    }
  });
});

// ─── P8: env-configurable approval threshold ──────

describe('CriticAgent — approval threshold injection (P8)', () => {
  function makeFixedScoreReview(score: number): string {
    return JSON.stringify({
      approved: true /* ignored — agent decides from threshold */,
      overallScore: score,
      findings: [],
      summary: 'fixed-score',
      reviewType: 'spec_review',
      iteration: 1,
    });
  }

  it('defaults the approval threshold to 75 when none injected', async () => {
    const ai = createMockAI([makeFixedScoreReview(74), makeFixedScoreReview(75)]);
    const agent = new CriticAgent(ai);
    assert.equal(agent.getApprovalThreshold(), 75);

    const below = await agent.reviewSpec({
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'x',
    });
    const atBoundary = await agent.reviewSpec({
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'x',
    });
    if (below.type === 'review') assert.equal(below.data.approved, false);
    if (atBoundary.type === 'review') assert.equal(atBoundary.data.approved, true);
  });

  it('uses an injected threshold (e.g. 85) for the approved decision', async () => {
    const ai = createMockAI([makeFixedScoreReview(80), makeFixedScoreReview(85)]);
    const agent = new CriticAgent(ai, undefined, 85);
    assert.equal(agent.getApprovalThreshold(), 85);

    const below = await agent.reviewSpec({
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'x',
    });
    const atBoundary = await agent.reviewSpec({
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'x',
    });
    if (below.type === 'review') {
      assert.equal(below.data.approved, false);
      assert.equal(below.data.overallScore, 80);
    }
    if (atBoundary.type === 'review') {
      assert.equal(atBoundary.data.approved, true);
      assert.equal(atBoundary.data.overallScore, 85);
    }
  });

  it('clamps an out-of-range injected threshold to [0, 100]', async () => {
    const high = new CriticAgent(createMockAI([]), undefined, 250);
    assert.equal(high.getApprovalThreshold(), 100);

    const low = new CriticAgent(createMockAI([]), undefined, -10);
    assert.equal(low.getApprovalThreshold(), 0);
  });

  it('flips approval when threshold is 0 (every score is approved)', async () => {
    const ai = createMockAI([makeFixedScoreReview(0)]);
    const agent = new CriticAgent(ai, undefined, 0);
    const result = await agent.reviewSpec({
      reviewType: 'spec_review',
      artifact: goodSpec,
      originalIdea: 'x',
    });
    if (result.type === 'review') assert.equal(result.data.approved, true);
  });
});
