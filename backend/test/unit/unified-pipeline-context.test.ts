/**
 * Unified pipeline chat + repo context for Proto/Trace (Cursor + Claude-style packing)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionBrief,
  buildUnifiedAgentKnowledgeContext,
  formatApprovedSpecificationBlock,
  formatScribeConversationTranscript,
} from '../../src/pipeline/core/unifiedPipelineContext.js';
import type { PipelineState, StructuredSpec } from '../../src/pipeline/core/contracts/PipelineTypes.js';

const minimalSpec: StructuredSpec = {
  title: 'Todo App',
  problemStatement: 'Track tasks.',
  userStories: [{ persona: 'User', action: 'Add task', benefit: 'Stay organized' }],
  acceptanceCriteria: [{ id: 'ac-1', given: 'Open app', when: 'Add item', then: 'It appears' }],
  technicalConstraints: { stack: 'React' },
  outOfScope: ['Mobile native'],
};

const basePipeline = (): PipelineState =>
  ({
    id: 'p1',
    userId: 'u1',
    stage: 'proto_building',
    scribeConversation: [],
    traceEnabled: true,
    metrics: {
      startedAt: new Date(),
      clarificationRounds: 0,
      retryCount: 0,
    },
    attemptCount: 0,
    stageVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as PipelineState;

describe('unifiedPipelineContext', () => {
  it('formatScribeConversationTranscript uses chronological section', () => {
    const messages = [
      { type: 'user_idea' as const, content: 'Build a todo app' },
      { type: 'user_answer' as const, content: 'Use React' },
      { type: 'user_note' as const, content: 'Prefer dark mode' },
    ];
    const t = formatScribeConversationTranscript(messages);
    assert.ok(t.includes('PIPELINE CHAT TRANSCRIPT (chronological)'));
    assert.ok(t.includes('Build a todo app'));
    assert.ok(t.includes('Prefer dark mode'));
  });

  it('formatApprovedSpecificationBlock includes AC lines', () => {
    const block = formatApprovedSpecificationBlock(minimalSpec);
    assert.ok(block.includes('APPROVED SPECIFICATION'));
    assert.ok(block.includes('ac-1'));
    assert.ok(block.includes('Mobile native'));
  });

  it('buildUnifiedAgentKnowledgeContext merges brief, spec, transcript, attachment, repo, proto links', () => {
    const p = basePipeline();
    p.title = 'My pipeline';
    p.approvedSpec = minimalSpec;
    p.scribeConversation = [{ type: 'user_idea', content: 'Idea' }];
    p.intermediateState = { attachmentContext: 'FILE: notes.txt\nhello' };
    p.repoContext = {
      owner: 'o',
      repo: 'r',
      branch: 'main',
      fileTree: 'src/\n  app.ts',
      summary: 'A test repo',
      techStack: ['TypeScript'],
      keyFiles: [],
      structure: { totalFiles: 1, languages: { ts: 1 }, directories: ['src'] },
      fetchedAt: new Date().toISOString(),
    };
    p.protoOutput = {
      ok: true,
      branch: 'feat',
      repo: 'o/r',
      repoUrl: 'https://github.com/o/r',
      files: [{ filePath: 'a.ts', content: '//', linesOfCode: 1 }],
      setupCommands: ['pnpm i'],
      metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'ts', committed: true },
    };

    const ctx = buildUnifiedAgentKnowledgeContext(p, { role: 'proto' });
    assert.ok(ctx.includes('SESSION BRIEF'));
    assert.ok(ctx.includes('APPROVED SPECIFICATION'));
    assert.ok(ctx.includes('Idea'));
    assert.ok(ctx.includes('notes.txt'));
    assert.ok(ctx.includes('EXISTING REPOSITORY'));
    assert.ok(ctx.includes('github.com/o/r'));
    assert.ok(ctx.includes('HOW TO USE THIS CONTEXT (Proto'));
  });

  it('buildUnifiedAgentKnowledgeContext trace role adds Trace instructions', () => {
    const p = basePipeline();
    p.approvedSpec = minimalSpec;
    p.scribeConversation = [{ type: 'user_idea', content: 'x' }];
    const ctx = buildUnifiedAgentKnowledgeContext(p, { role: 'trace' });
    assert.ok(ctx.includes('Trace / verification'));
  });

  it('returns empty string when no signals', () => {
    assert.equal(buildUnifiedAgentKnowledgeContext(basePipeline()), '');
  });

  it('buildSessionBrief is empty when nothing to say', () => {
    assert.equal(buildSessionBrief(basePipeline()), '');
  });
});
