import { describe, it, expect } from 'vitest';
import { analyzePreviewCapability } from '../previewStrategy';

import {
  mapStageToUIState,
  mapStageToMode,
  mapStageToConversationStatus,
  getRunningAgentName,
  mapPipelineToConversationItem,
  mapPipelineToChatMessages,
} from '../mapPipelineEvent';
import { akisSandpackTheme } from '../sandpackTheme';
import type { Pipeline, PipelineStage, CriticReviewOutput } from '../../types/pipeline';

// ─────────────────────────────────────────────────────────
// previewStrategy — analyzePreviewCapability
// ─────────────────────────────────────────────────────────

function makePkg(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): string {
  return JSON.stringify({ dependencies: deps, devDependencies: devDeps });
}

describe('analyzePreviewCapability', () => {
  it('detects React app as sandpack-capable', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ react: '^19.0.0', 'react-dom': '^19.0.0' }),
      'src/App.tsx': 'export default function App() { return <div>Hello</div>; }',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('sandpack');
    expect(result.framework).toBe('react');
    expect(result.hasBackendDependency).toBe(false);
    expect(result.hasMobilePlatform).toBe(false);
  });

  it('detects Vue app as sandpack-capable', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ vue: '^3.4.0' }),
      'src/App.vue': '<template><div>Hello</div></template>',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('sandpack');
    expect(result.framework).toBe('vue');
  });

  it('marks Node.js backend with express as not-previewable', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ express: '^4.18.0' }),
      'src/index.ts': 'import express from "express";',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('not-previewable');
    expect(result.hasBackendDependency).toBe(true);
  });

  it('marks Node.js backend with fastify as not-previewable', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ fastify: '^4.0.0' }),
      'src/server.ts': 'import Fastify from "fastify";',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('not-previewable');
    expect(result.hasBackendDependency).toBe(true);
  });

  it('marks Python project (no package.json) with .py files as vanilla sandpack', () => {
    const files: Record<string, string> = {
      'main.py': 'print("hello")',
      'requirements.txt': 'flask==3.0',
    };
    const result = analyzePreviewCapability(files);
    // No package.json, no JSX => vanilla framework, sandpack capable
    expect(result.framework).toBe('vanilla');
    expect(result.capability).toBe('sandpack');
  });

  it('marks Go project (no package.json) as vanilla sandpack', () => {
    const files: Record<string, string> = {
      'main.go': 'package main',
      'go.mod': 'module example.com/foo',
    };
    const result = analyzePreviewCapability(files);
    expect(result.framework).toBe('vanilla');
    expect(result.capability).toBe('sandpack');
  });

  it('detects static HTML project as sandpack with vanilla template', () => {
    const files: Record<string, string> = {
      'index.html': '<html><body>Hello</body></html>',
      'style.css': 'body { color: red; }',
      'script.js': 'console.log("hi")',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('sandpack');
    expect(result.framework).toBe('vanilla');
    expect(result.hasBackendDependency).toBe(false);
    expect(result.hasMobilePlatform).toBe(false);
  });

  it('marks empty files record as sandpack vanilla (no package.json)', () => {
    const files: Record<string, string> = {};
    const result = analyzePreviewCapability(files);
    expect(result.framework).toBe('vanilla');
    expect(result.capability).toBe('sandpack');
  });

  it('marks React Native project as not-previewable', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ 'react-native': '^0.73.0', react: '^18.0.0' }),
      'App.tsx': 'import { View } from "react-native";',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('not-previewable');
    expect(result.hasMobilePlatform).toBe(true);
  });

  it('marks Expo project as not-previewable', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ expo: '^50.0.0', react: '^18.0.0' }),
      'App.tsx': 'import { Text } from "react-native";',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('not-previewable');
    expect(result.hasMobilePlatform).toBe(true);
  });

  it('prioritizes mobile detection over backend detection', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ 'react-native': '^0.73.0', express: '^4.18.0' }),
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('not-previewable');
    // Mobile check comes first in the code
    expect(result.hasMobilePlatform).toBe(true);
    expect(result.hasBackendDependency).toBe(true);
  });

  it('handles malformed package.json gracefully', () => {
    const files: Record<string, string> = {
      'package.json': '{ broken json !!!',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('sandpack');
    expect(result.framework).toBe('vanilla');
  });

  it('detects JSX files without package.json as react framework', () => {
    const files: Record<string, string> = {
      'App.tsx': 'export default function App() { return <div />; }',
      'index.tsx': 'ReactDOM.render(<App />, document.getElementById("root"));',
    };
    const result = analyzePreviewCapability(files);
    expect(result.framework).toBe('react');
    expect(result.capability).toBe('sandpack');
  });

  it('detects database-only deps (prisma) as backend', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ '@prisma/client': '^5.0.0' }),
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('not-previewable');
    expect(result.hasBackendDependency).toBe(true);
  });

  it('detects fetch(/api/...) in source as not-previewable', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ react: '^19.0.0' }),
      'src/App.tsx': "fetch('/api/users').then(r => r.json());",
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('not-previewable');
    expect(result.hasBackendDependency).toBe(true);
    expect(result.reason).toContain('API sunucusu');
  });

  it('detects axios import as not-previewable', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ react: '^19.0.0' }),
      'src/api.ts': "import axios from 'axios';\nexport const get = () => axios.get('/users');",
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('not-previewable');
    expect(result.hasBackendDependency).toBe(true);
  });

  it('does not flag source that only mentions "api" in a comment', () => {
    const files: Record<string, string> = {
      'package.json': makePkg({ react: '^19.0.0' }),
      'src/App.tsx':
        '// note: no real api here, just a stub\nexport default function App() { return <div>hi</div>; }',
    };
    const result = analyzePreviewCapability(files);
    expect(result.capability).toBe('sandpack');
    expect(result.hasBackendDependency).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// mapPipelineEvent — stage mapping functions
// ─────────────────────────────────────────────────────────

describe('mapStageToUIState', () => {
  it('maps scribe_clarifying to scribe_clarifying', () => {
    expect(mapStageToUIState('scribe_clarifying')).toBe('scribe_clarifying');
  });

  it('maps scribe_generating to scribe_running', () => {
    expect(mapStageToUIState('scribe_generating')).toBe('scribe_running');
  });

  it('maps critic_reviewing_spec to critic_running (Critic owns its own UI state)', () => {
    expect(mapStageToUIState('critic_reviewing_spec')).toBe('critic_running');
  });

  it('maps critic_reviewing_code to critic_running', () => {
    expect(mapStageToUIState('critic_reviewing_code')).toBe('critic_running');
  });

  it('maps awaiting_approval to awaiting_approval', () => {
    expect(mapStageToUIState('awaiting_approval')).toBe('awaiting_approval');
  });

  it('maps proto_building to proto_running', () => {
    expect(mapStageToUIState('proto_building')).toBe('proto_running');
  });

  it('maps trace_testing to trace_running', () => {
    expect(mapStageToUIState('trace_testing')).toBe('trace_running');
  });

  it('maps ci_running to ci_running', () => {
    expect(mapStageToUIState('ci_running')).toBe('ci_running');
  });

  it('maps completed to idle', () => {
    expect(mapStageToUIState('completed')).toBe('idle');
  });

  it('maps completed_partial to idle', () => {
    expect(mapStageToUIState('completed_partial')).toBe('idle');
  });

  it('maps failed to idle', () => {
    expect(mapStageToUIState('failed')).toBe('idle');
  });

  it('maps cancelled to idle', () => {
    expect(mapStageToUIState('cancelled')).toBe('idle');
  });

  it('maps unknown stage to idle (default case)', () => {
    expect(mapStageToUIState('some_unknown_stage' as PipelineStage)).toBe('idle');
  });
});

describe('mapStageToMode', () => {
  it('maps scribe_clarifying to ask mode', () => {
    expect(mapStageToMode('scribe_clarifying')).toBe('ask');
  });

  it('maps scribe_generating to plan mode', () => {
    expect(mapStageToMode('scribe_generating')).toBe('plan');
  });

  it('maps awaiting_approval to plan mode', () => {
    expect(mapStageToMode('awaiting_approval')).toBe('plan');
  });

  it('maps proto_building to act mode', () => {
    expect(mapStageToMode('proto_building')).toBe('act');
  });

  it('maps trace_testing to act mode', () => {
    expect(mapStageToMode('trace_testing')).toBe('act');
  });

  it('maps ci_running to act mode', () => {
    expect(mapStageToMode('ci_running')).toBe('act');
  });

  it('maps failed to review mode', () => {
    expect(mapStageToMode('failed')).toBe('review');
  });

  it('maps completed_partial to review mode', () => {
    expect(mapStageToMode('completed_partial')).toBe('review');
  });

  it('maps completed to ask mode (default)', () => {
    expect(mapStageToMode('completed')).toBe('ask');
  });

  it('returns ask for undefined stage', () => {
    expect(mapStageToMode(undefined)).toBe('ask');
  });

  it('returns ask for unknown stage (default)', () => {
    expect(mapStageToMode('bogus_stage' as PipelineStage)).toBe('ask');
  });
});

describe('mapStageToConversationStatus', () => {
  const runningStages: PipelineStage[] = [
    'scribe_clarifying',
    'scribe_generating',
    'proto_building',
    'trace_testing',
    'ci_running',
  ];

  for (const stage of runningStages) {
    it(`maps ${stage} to running`, () => {
      expect(mapStageToConversationStatus(stage)).toBe('running');
    });
  }

  it('maps awaiting_approval to awaiting_approval', () => {
    expect(mapStageToConversationStatus('awaiting_approval')).toBe('awaiting_approval');
  });

  it('maps failed to error', () => {
    expect(mapStageToConversationStatus('failed')).toBe('error');
  });

  it('maps completed to idle', () => {
    expect(mapStageToConversationStatus('completed')).toBe('idle');
  });

  it('maps completed_partial to partial (PR-U2 #2)', () => {
    // Sidebar previously showed a green "Hazır" pill for partial pipelines,
    // identical to a clean success. Now surfaced distinctly so the user can
    // tell at a glance that the pipeline did not produce its full deliverable.
    expect(mapStageToConversationStatus('completed_partial')).toBe('partial');
  });

  it('maps cancelled to idle', () => {
    expect(mapStageToConversationStatus('cancelled')).toBe('idle');
  });
});

describe('getRunningAgentName', () => {
  it('returns Scribe for scribe_running', () => {
    expect(getRunningAgentName('scribe_running')).toBe('Scribe');
  });

  it('returns Scribe for scribe_revise', () => {
    expect(getRunningAgentName('scribe_revise')).toBe('Scribe');
  });

  it('returns Critic for critic_running', () => {
    expect(getRunningAgentName('critic_running')).toBe('Critic');
  });

  it('returns Proto for proto_running', () => {
    expect(getRunningAgentName('proto_running')).toBe('Proto');
  });

  it('returns Trace for trace_running', () => {
    expect(getRunningAgentName('trace_running')).toBe('Trace');
  });

  it('returns CI for ci_running', () => {
    expect(getRunningAgentName('ci_running')).toBe('CI');
  });

  it('returns null for idle', () => {
    expect(getRunningAgentName('idle')).toBeNull();
  });

  it('returns null for awaiting_approval', () => {
    expect(getRunningAgentName('awaiting_approval')).toBeNull();
  });

  it('returns null for scribe_clarifying', () => {
    expect(getRunningAgentName('scribe_clarifying')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// sandpackTheme — AKIS theme structure validation
// ─────────────────────────────────────────────────────────

describe('akisSandpackTheme', () => {
  it('has required color properties', () => {
    const { colors } = akisSandpackTheme;
    expect(colors).toBeDefined();
    expect(colors!.surface1).toBeDefined();
    expect(colors!.surface2).toBeDefined();
    expect(colors!.base).toBeDefined();
    expect(colors!.accent).toBeDefined();
    expect(colors!.error).toBeDefined();
  });

  it('has syntax highlighting definitions', () => {
    const { syntax } = akisSandpackTheme;
    expect(syntax).toBeDefined();
    expect(syntax!.plain).toBeDefined();
    expect(syntax!.keyword).toBeDefined();
    expect(syntax!.tag).toBeDefined();
    expect(syntax!.string).toBeDefined();
    expect(syntax!.comment).toBeDefined();
  });

  it('has font configuration', () => {
    const { font } = akisSandpackTheme;
    expect(font).toBeDefined();
    expect(font!.body).toBeDefined();
    expect(font!.mono).toBeDefined();
    expect(font!.size).toBeDefined();
  });

  it('uses AKIS brand accent color (#3ECFA0 teal family)', () => {
    expect(akisSandpackTheme.colors!.accent).toBe('#3ECFA0');
    expect(akisSandpackTheme.colors!.hover).toBe('#3ECFA0');
  });

  it('uses dark background surfaces matching AKIS theme', () => {
    const s1 = akisSandpackTheme.colors!.surface1!;
    const s2 = akisSandpackTheme.colors!.surface2!;
    // Both should be dark hex values (start with #0 or #1)
    expect(s1.startsWith('#0') || s1.startsWith('#1')).toBe(true);
    expect(s2.startsWith('#0') || s2.startsWith('#1')).toBe(true);
  });

  it('includes monospace font for code', () => {
    expect(akisSandpackTheme.font!.mono).toContain('JetBrains Mono');
  });
});

// ─────────────────────────────────────────────────────────
// mapPipelineEvent — mapPipelineToConversationItem
// ─────────────────────────────────────────────────────────

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'pipe-1',
    userId: 'user-1',
    stage: 'scribe_clarifying',
    traceEnabled: true,
    scribeConversation: [],
    metrics: {
      startedAt: '2026-05-01T10:00:00Z',
      clarificationRounds: 0,
      retryCount: 0,
    },
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-01T10:05:00Z',
    ...overrides,
  };
}

describe('mapPipelineToConversationItem', () => {
  it('uses protoConfig.repoName as primary repo identifier', () => {
    const p = makePipeline({
      protoConfig: { repoName: 'my-app', repoVisibility: 'private' },
      title: 'irrelevant title',
    });
    const item = mapPipelineToConversationItem(p);
    expect(item.repoShortName).toBe('my-app');
  });

  it('falls back to pipeline.title when protoConfig is absent', () => {
    const p = makePipeline({ title: 'Some chat' });
    const item = mapPipelineToConversationItem(p);
    expect(item.repoShortName).toBe('Some chat');
  });

  it('falls back to "Isimsiz" when both protoConfig and title are missing', () => {
    const p = makePipeline({ title: undefined });
    const item = mapPipelineToConversationItem(p);
    expect(item.repoShortName).toBe('Isimsiz');
  });

  it('builds repoFullName as owner/repo when protoOutput.repo is present', () => {
    const p = makePipeline({
      protoConfig: { repoName: 'my-app', repoVisibility: 'public' },
      protoOutput: {
        ok: true,
        branch: 'main',
        repo: 'omeryasir/my-app',
        repoUrl: 'https://github.com/omeryasir/my-app',
        files: [],
        setupCommands: [],
        metadata: {
          filesCreated: 0,
          totalLinesOfCode: 0,
          stackUsed: 'next',
          committed: true,
        },
      },
    });
    const item = mapPipelineToConversationItem(p);
    expect(item.repoFullName).toBe('omeryasir/my-app');
  });

  it('falls back to just repoShortName when protoOutput.repo has no owner', () => {
    const p = makePipeline({
      protoConfig: { repoName: 'my-app', repoVisibility: 'public' },
    });
    const item = mapPipelineToConversationItem(p);
    expect(item.repoFullName).toBe('my-app');
  });

  it('mapPipelineToConversationItem: protoOutput.repo without slash falls back to empty owner segment', () => {
    // TODO(follow-up): malformed `repo` (no slash) currently produces a
    // structurally wrong `repoFullName` like `just-owner/my-app` because
    // `split('/')[0]` returns the whole string when there is no `/`.
    // This test locks in the current behaviour so a future source fix has a
    // failing canary to flip. Prefer fixing `mapPipelineToConversationItem`
    // in a follow-up to make `repoFullName` equal to `repoShortName` (or null)
    // when `protoOutput.repo` lacks a `/`.
    const p = makePipeline({
      protoConfig: { repoName: 'my-app', repoVisibility: 'public' },
      protoOutput: {
        ok: true,
        branch: 'main',
        repo: 'just-owner', // malformed — no slash
        repoUrl: 'https://github.com/just-owner',
        files: [],
        setupCommands: [],
        metadata: {
          filesCreated: 0,
          totalLinesOfCode: 0,
          stackUsed: 'next',
          committed: true,
        },
      },
    });
    const item = mapPipelineToConversationItem(p);
    // Documents current (buggy) behaviour: the whole `repo` string becomes the
    // owner segment because split('/')[0] returns it unchanged.
    expect(item.repoFullName).toBe('just-owner/my-app');
  });

  it('reports running status for in-progress stages', () => {
    const item = mapPipelineToConversationItem(makePipeline({ stage: 'proto_building' }));
    expect(item.status).toBe('running');
  });

  it('reports awaiting_approval status for awaiting_approval stage', () => {
    const item = mapPipelineToConversationItem(makePipeline({ stage: 'awaiting_approval' }));
    expect(item.status).toBe('awaiting_approval');
  });

  it('reports error status for failed pipelines', () => {
    const item = mapPipelineToConversationItem(makePipeline({ stage: 'failed' }));
    expect(item.status).toBe('error');
  });

  it('counts files from protoOutput', () => {
    const p = makePipeline({
      protoOutput: {
        ok: true,
        branch: 'main',
        repo: 'o/r',
        repoUrl: 'u',
        files: [
          { filePath: 'a.ts', content: '', linesOfCode: 1 },
          { filePath: 'b.ts', content: '', linesOfCode: 1 },
          { filePath: 'c.ts', content: '', linesOfCode: 1 },
        ],
        setupCommands: [],
        metadata: { filesCreated: 3, totalLinesOfCode: 3, stackUsed: 'next', committed: true },
      },
    });
    const item = mapPipelineToConversationItem(p);
    expect(item.fileCount).toBe(3);
  });

  it('defaults fileCount to 0 when no protoOutput', () => {
    const item = mapPipelineToConversationItem(makePipeline());
    expect(item.fileCount).toBe(0);
  });

  it('passes through branch and prUrl from protoOutput', () => {
    const p = makePipeline({
      protoOutput: {
        ok: true,
        branch: 'feat/x',
        repo: 'o/r',
        repoUrl: 'u',
        prUrl: 'https://github.com/o/r/pull/1',
        files: [],
        setupCommands: [],
        metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'next', committed: true },
      },
    });
    const item = mapPipelineToConversationItem(p);
    expect(item.branch).toBe('feat/x');
    expect(item.prUrl).toBe('https://github.com/o/r/pull/1');
  });

  it('sets prNumber to undefined (not derived from URL)', () => {
    const item = mapPipelineToConversationItem(makePipeline());
    expect(item.prNumber).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────
// mapPipelineEvent — mapPipelineToChatMessages
// ─────────────────────────────────────────────────────────

describe('mapPipelineToChatMessages', () => {
  it('returns empty array for pipeline with no conversation, output, or error', () => {
    const messages = mapPipelineToChatMessages(makePipeline());
    expect(messages).toEqual([]);
  });

  it('maps user_idea to a user message', () => {
    const p = makePipeline({
      scribeConversation: [{ type: 'user_idea', content: 'I want a blog' }],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'user', content: 'I want a blog' });
  });

  it('maps user_answer to a user message', () => {
    const p = makePipeline({
      scribeConversation: [{ type: 'user_answer', content: 'Next.js please' }],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({ type: 'user', content: 'Next.js please' });
  });

  it('maps user_note to a user message', () => {
    const p = makePipeline({
      scribeConversation: [{ type: 'user_note', content: 'random note' }],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({ type: 'user', content: 'random note' });
  });

  it('coerces non-string user content to string and tolerates missing content', () => {
    const p = makePipeline({
      scribeConversation: [
        // @ts-expect-error — exercise the runtime guard for non-string content
        { type: 'user_idea', content: 42 },
        // @ts-expect-error — exercise the runtime guard for missing content
        { type: 'user_answer', content: undefined },
      ],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({ type: 'user', content: '42' });
    expect(messages[1]).toMatchObject({ type: 'user', content: '' });
  });

  it('maps clarification to a clarification message with questions', () => {
    const p = makePipeline({
      scribeConversation: [
        {
          type: 'clarification',
          content: {
            questions: [
              {
                id: 'q1',
                question: 'Which framework?',
                reason: 'tech stack',
                suggestions: ['Next', 'Remix'],
              },
            ],
          },
        },
      ],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({
      type: 'clarification',
      role: 'scribe',
      questions: [expect.objectContaining({ id: 'q1', question: 'Which framework?' })],
    });
  });

  it('uses fallback content for clarification when no message string is present', () => {
    const p = makePipeline({
      scribeConversation: [
        {
          type: 'clarification',
          // @ts-expect-error — runtime tolerates missing message and uses fallback
          content: { questions: [] },
        },
      ],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({
      type: 'clarification',
      content: 'Fikrini daha iyi anlayabilmem için birkaç sorum var:',
      questions: [],
    });
  });

  it('uses custom clarification message string when provided', () => {
    const p = makePipeline({
      scribeConversation: [
        {
          type: 'clarification',
          // @ts-expect-error — runtime accepts an extra message property
          content: { message: 'Custom prompt', questions: [] },
        },
      ],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({ content: 'Custom prompt' });
  });

  it('falls back to empty questions array when content.questions is not an array', () => {
    const p = makePipeline({
      scribeConversation: [
        {
          type: 'clarification',
          // @ts-expect-error — exercise the Array.isArray guard
          content: { message: 'hi', questions: 'not-array' },
        },
      ],
    });
    const messages = mapPipelineToChatMessages(p);
    expect((messages[0] as { questions: unknown[] }).questions).toEqual([]);
  });

  it('maps spec_draft to a scribe agent message when content.spec is present', () => {
    const p = makePipeline({
      scribeConversation: [
        {
          type: 'spec_draft',
          // @ts-expect-error — minimal shape: we only check spec presence
          content: { spec: { title: 'X' } },
        },
      ],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({
      type: 'agent',
      agent: 'scribe',
      content: 'Plan hazır. Lütfen inceleyin ve onaylayın.',
    });
  });

  it('does not emit a message for spec_draft without a spec field', () => {
    const p = makePipeline({
      scribeConversation: [
        {
          type: 'spec_draft',
          // @ts-expect-error — minimal shape, no spec
          content: {},
        },
      ],
    });
    expect(mapPipelineToChatMessages(p)).toHaveLength(0);
  });

  it('maps spec_approved to an info message', () => {
    const p = makePipeline({
      // @ts-expect-error — minimal shape for spec_approved (content unused in mapping)
      scribeConversation: [{ type: 'spec_approved', content: {} }],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({ type: 'info', content: 'Plan onaylandı.' });
  });

  it('maps spec_rejected to an info message', () => {
    const p = makePipeline({
      scribeConversation: [{ type: 'spec_rejected', content: { feedback: 'no' } }],
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({ type: 'info', content: 'Plan reddedildi.' });
  });

  it('appends a critic_review for spec when intermediateState.criticSpecOutput is set', () => {
    const critic: CriticReviewOutput = {
      approved: true,
      overallScore: 85,
      findings: [
        { severity: 'minor', category: 'completeness', description: 'd', suggestion: 's' },
      ],
      summary: 'Good',
      reviewType: 'spec_review',
      iteration: 1,
    };
    const p = makePipeline({
      intermediateState: { criticSpecOutput: critic },
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({
      type: 'critic_review',
      reviewType: 'spec_review',
      approved: true,
      score: 85,
      summary: 'Good',
    });
    expect((messages[0] as { findings: unknown[] }).findings).toHaveLength(1);
  });

  it('uses defaults when critic findings/summary are missing', () => {
    const critic = {
      approved: false,
      overallScore: 20,
      reviewType: 'spec_review',
      iteration: 1,
    } as unknown as CriticReviewOutput;
    const p = makePipeline({ intermediateState: { criticSpecOutput: critic } });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({ type: 'critic_review', summary: '' });
    expect((messages[0] as { findings: unknown[] }).findings).toEqual([]);
  });

  it('emits a pr_opened message when protoOutput.ok is true', () => {
    const p = makePipeline({
      title: 'Blog',
      protoOutput: {
        ok: true,
        branch: 'main',
        repo: 'o/r',
        repoUrl: 'https://github.com/o/r',
        prUrl: 'https://github.com/o/r/pull/1',
        files: [
          { filePath: 'a.ts', content: '', linesOfCode: 10 },
          { filePath: 'b.ts', content: '', linesOfCode: 5 },
        ],
        setupCommands: [],
        metadata: {
          filesCreated: 2,
          totalLinesOfCode: 15,
          stackUsed: 'next',
          committed: true,
        },
      },
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({
      type: 'pr_opened',
      url: 'https://github.com/o/r/pull/1',
      branch: 'main',
      filesChanged: 2,
      linesChanged: 15,
    });
  });

  it('uses repoUrl as fallback when prUrl is missing', () => {
    const p = makePipeline({
      protoOutput: {
        ok: true,
        branch: 'main',
        repo: 'o/r',
        repoUrl: 'https://github.com/o/r',
        files: [],
        setupCommands: [],
        metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'next', committed: true },
      },
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({ type: 'pr_opened', url: 'https://github.com/o/r' });
  });

  it('does not emit pr_opened when protoOutput.ok is false', () => {
    const p = makePipeline({
      protoOutput: {
        ok: false,
        branch: 'main',
        repo: 'o/r',
        repoUrl: 'u',
        files: [],
        setupCommands: [],
        metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'next', committed: false },
      },
    });
    expect(mapPipelineToChatMessages(p)).toHaveLength(0);
  });

  it('appends critic_review for code when intermediateState.criticCodeOutput is set', () => {
    const critic: CriticReviewOutput = {
      approved: false,
      overallScore: 50,
      findings: [],
      summary: 'Needs polish',
      reviewType: 'code_review',
      iteration: 2,
    };
    const p = makePipeline({ intermediateState: { criticCodeOutput: critic } });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({
      type: 'critic_review',
      reviewType: 'code_review',
      approved: false,
      score: 50,
    });
  });

  it('emits a test_result message when traceOutput is present', () => {
    const p = makePipeline({
      traceOutput: {
        ok: true,
        testFiles: [
          { filePath: 'a.test.ts', content: '', testCount: 3 },
          { filePath: 'b.test.ts', content: '', testCount: 2 },
        ],
        coverageMatrix: { c1: ['t1'] },
        testSummary: {
          totalTests: 5,
          coveragePercentage: 80,
          coveredCriteria: ['c1', 'c2'],
          uncoveredCriteria: ['c3'],
        },
      },
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({
      type: 'test_result',
      passed: 5,
      total: 5,
      coverage: '80',
    });
    expect((messages[0] as { testFiles: unknown[] }).testFiles).toHaveLength(2);
    expect((messages[0] as { coveredCriteria: string[] }).coveredCriteria).toEqual(['c1', 'c2']);
    expect((messages[0] as { uncoveredCriteria: string[] }).uncoveredCriteria).toEqual(['c3']);
  });

  it('uses defaults when traceOutput.testSummary is partially populated', () => {
    const p = makePipeline({
      traceOutput: {
        ok: true,
        testFiles: [],
        coverageMatrix: {},
        // @ts-expect-error — partial summary exercises fallbacks
        testSummary: {},
      },
    });
    const messages = mapPipelineToChatMessages(p);
    expect(messages[0]).toMatchObject({
      type: 'test_result',
      passed: 0,
      total: 0,
      coverage: '0',
    });
  });

  it('emits pipeline_complete on completed stage with clone command derived from repoUrl', () => {
    const p = makePipeline({
      stage: 'completed',
      title: 'My App',
      protoOutput: {
        ok: true,
        branch: 'main',
        repo: 'omer/my-app',
        repoUrl: 'https://github.com/omer/my-app',
        files: [{ filePath: 'a.ts', content: '', linesOfCode: 1 }],
        setupCommands: ['npm install'],
        metadata: { filesCreated: 1, totalLinesOfCode: 1, stackUsed: 'next', committed: true },
      },
    });
    const messages = mapPipelineToChatMessages(p);
    const complete = messages.find((m) => m.type === 'pipeline_complete');
    expect(complete).toBeDefined();
    expect(complete).toMatchObject({
      status: 'completed',
      repoUrl: 'https://github.com/omer/my-app',
      branch: 'main',
      fileCount: 1,
      lineCount: 1,
      cloneCommand:
        'git clone https://github.com/omer/my-app.git && cd my-app && npm install && npm run dev',
      setupCommands: ['npm install'],
    });
  });

  it('emits pipeline_complete on completed_partial stage with empty cloneCommand when no repoUrl', () => {
    const p = makePipeline({ stage: 'completed_partial' });
    const messages = mapPipelineToChatMessages(p);
    const complete = messages.find((m) => m.type === 'pipeline_complete');
    expect(complete).toMatchObject({
      status: 'completed_partial',
      repoUrl: '',
      branch: 'main',
      fileCount: 0,
      lineCount: 0,
      cloneCommand: '',
    });
  });

  it('does not emit pipeline_complete for non-terminal stages', () => {
    const p = makePipeline({ stage: 'proto_building' });
    const messages = mapPipelineToChatMessages(p);
    expect(messages.find((m) => m.type === 'pipeline_complete')).toBeUndefined();
  });

  it('emits an error message when pipeline.error is set', () => {
    const p = makePipeline({
      stage: 'failed',
      error: {
        code: 'PROTO_FAILED',
        message: 'Could not push branch',
        retryable: true,
        recoveryAction: 'reconnect_github',
      },
      metrics: {
        startedAt: '2026-05-01T10:00:00Z',
        clarificationRounds: 0,
        retryCount: 2,
      },
    });
    const messages = mapPipelineToChatMessages(p);
    const err = messages.find((m) => m.type === 'error');
    expect(err).toMatchObject({
      type: 'error',
      agent: 'failed', // first segment of stage before "_"
      message: 'Could not push branch',
      code: 'PROTO_FAILED',
      retryable: true,
      recoveryAction: 'reconnect_github',
      retryCount: 2,
      maxRetries: 3,
    });
  });

  it('defaults retryable to false and retryCount to 0 when not provided', () => {
    const p = makePipeline({
      stage: 'failed',
      error: {
        code: 'X',
        message: 'm',
        // @ts-expect-error — minimal shape exercises the ?? defaults
        retryable: undefined,
      },
    });
    const messages = mapPipelineToChatMessages(p);
    const err = messages.find((m) => m.type === 'error');
    expect(err).toMatchObject({ retryable: false, retryCount: 0 });
  });

  it('uses "pipeline" as agent fallback when stage is missing (defensive ?. in mapPipelineEvent)', () => {
    // Pipeline.stage is typed non-optional, but mapPipelineEvent.ts:250 uses
    // `pipeline.stage?.split('_')[0] ?? 'pipeline'` — explicit defensive code
    // for hydration races where the runtime payload arrives before the stage
    // field is populated. The cast exercises that guard; @ts-expect-error
    // documents the type/runtime gap rather than hiding it.
    const p = makePipeline({
      // @ts-expect-error — type says stage is non-optional, but source intentionally guards against runtime undefined
      stage: undefined,
      error: { code: 'X', message: 'm', retryable: false },
    });
    const messages = mapPipelineToChatMessages(p);
    const err = messages.find((m) => m.type === 'error');
    expect(err).toMatchObject({ agent: 'pipeline' });
  });

  it('preserves emission order: conversation → critic spec → proto → critic code → trace → complete → error', () => {
    const critic: CriticReviewOutput = {
      approved: true,
      overallScore: 90,
      findings: [],
      summary: 'ok',
      reviewType: 'spec_review',
      iteration: 1,
    };
    const p = makePipeline({
      stage: 'completed',
      scribeConversation: [{ type: 'user_idea', content: 'Build a blog' }],
      intermediateState: {
        criticSpecOutput: critic,
        criticCodeOutput: { ...critic, reviewType: 'code_review' },
      },
      protoOutput: {
        ok: true,
        branch: 'main',
        repo: 'o/r',
        repoUrl: 'https://github.com/o/r',
        files: [],
        setupCommands: [],
        metadata: { filesCreated: 0, totalLinesOfCode: 0, stackUsed: 'next', committed: true },
      },
      traceOutput: {
        ok: true,
        testFiles: [],
        coverageMatrix: {},
        testSummary: {
          totalTests: 1,
          coveragePercentage: 100,
          coveredCriteria: [],
          uncoveredCriteria: [],
        },
      },
      error: { code: 'X', message: 'm', retryable: false },
    });
    const types = mapPipelineToChatMessages(p).map((m) => m.type);
    expect(types).toEqual([
      'user',
      'critic_review',
      'pr_opened',
      'critic_review',
      'test_result',
      'pipeline_complete',
      'error',
    ]);
  });
});
