import { describe, it, expect } from 'vitest';
import { analyzePreviewCapability } from '../previewStrategy';

import {
  mapStageToUIState,
  mapStageToMode,
  mapStageToConversationStatus,
  getRunningAgentName,
} from '../mapPipelineEvent';
import { akisSandpackTheme } from '../sandpackTheme';
import type { PipelineStage } from '../../types/pipeline';

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
      'src/App.tsx': "// note: no real api here, just a stub\nexport default function App() { return <div>hi</div>; }",
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

  it('maps completed_partial to idle', () => {
    expect(mapStageToConversationStatus('completed_partial')).toBe('idle');
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
