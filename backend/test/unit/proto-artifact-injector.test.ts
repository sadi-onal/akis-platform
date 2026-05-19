/**
 * PR-V-spec-artifacts — Proto artifact injector tests
 *
 * Covers:
 *   - PRD.md + TECHNICAL-ANALYSIS.md always injected when scribeOutput provided
 *   - TECHNICAL-ANALYSIS.md injected even when scribeOutput is absent (Proto-only)
 *   - API-CONTRACT.md skipped when no API surface detected
 *   - API-CONTRACT.md included when integrations declare an API
 *   - API-CONTRACT.md included when server route files are detected
 *   - Idempotent: existing docs/* files are NOT overwritten
 *   - Original files preserved + linesOfCode populated
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  injectArtifacts,
  detectApiSurface,
  detectEndpoints,
  renderTechnicalAnalysisMarkdown,
  PRD_PATH,
  TECH_ANALYSIS_PATH,
  API_CONTRACT_PATH,
} from '../../src/pipeline/agents/proto/artifactInjector.js';
import type {
  ProtoOutput,
  ScribeOutput,
  StructuredSpec,
  UserFriendlyPlan,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

const FIXED_DATE = new Date('2026-05-20T10:00:00.000Z');

const baseSpec: StructuredSpec = {
  title: 'Demo',
  problemStatement: 'Bir problem.',
  userStories: [{ persona: 'Kullanıcı', action: 'iş yapmak', benefit: 'fayda görmek' }],
  acceptanceCriteria: [{ id: 'AC-1', given: 'G', when: 'W', then: 'T' }],
  technicalConstraints: { stack: 'React + Vite' },
  outOfScope: [],
};

const basePlan: UserFriendlyPlan = {
  projectName: 'Demo',
  summary: 'Demo özeti.',
  features: [{ name: 'X', description: 'Y' }],
  techChoices: ['React', 'Vite'],
  estimatedFiles: 5,
  requiresTests: false,
};

const scribeOutput: ScribeOutput = {
  spec: baseSpec,
  plan: basePlan,
  rawMarkdown: '...',
  confidence: 0.9,
  clarificationsAsked: 0,
  assumptions: ['Tek tarayıcı.'],
};

const baseFiles: ProtoOutput['files'] = [
  {
    filePath: 'package.json',
    content: '{"dependencies":{"react":"19","vite":"7"}}',
    linesOfCode: 1,
  },
  {
    filePath: 'src/App.jsx',
    content: 'export default function App() { return <div/>; }',
    linesOfCode: 1,
  },
];

describe('injectArtifacts', () => {
  it('adds docs/PRD.md and docs/TECHNICAL-ANALYSIS.md when scribeOutput is provided', () => {
    const result = injectArtifacts({
      files: baseFiles,
      scribeOutput,
      now: FIXED_DATE,
    });

    const paths = result.files.map((f) => f.filePath);
    assert.ok(paths.includes(PRD_PATH), 'PRD.md should be present');
    assert.ok(paths.includes(TECH_ANALYSIS_PATH), 'TECHNICAL-ANALYSIS.md should be present');
    assert.deepEqual(result.added.sort(), [PRD_PATH, TECH_ANALYSIS_PATH].sort());

    // PRD content sanity
    const prd = result.files.find((f) => f.filePath === PRD_PATH)!;
    assert.match(prd.content, /^# Demo — Proje Tanımı \(PRD\)/);
    assert.ok(prd.linesOfCode > 1);

    // Technical analysis sanity
    const ta = result.files.find((f) => f.filePath === TECH_ANALYSIS_PATH)!;
    assert.match(ta.content, /^# Teknik Analiz/);
    assert.match(ta.content, /React/);
    assert.match(ta.content, /Vite/);
  });

  it('still adds docs/TECHNICAL-ANALYSIS.md even when scribeOutput is missing', () => {
    const result = injectArtifacts({ files: baseFiles, now: FIXED_DATE });
    const paths = result.files.map((f) => f.filePath);
    assert.ok(!paths.includes(PRD_PATH), 'PRD should be skipped without spec');
    assert.ok(paths.includes(TECH_ANALYSIS_PATH));
    assert.deepEqual(result.added, [TECH_ANALYSIS_PATH]);
  });

  it('skips docs/API-CONTRACT.md when no API surface is detected', () => {
    const result = injectArtifacts({
      files: baseFiles,
      scribeOutput,
      now: FIXED_DATE,
    });
    const paths = result.files.map((f) => f.filePath);
    assert.ok(!paths.includes(API_CONTRACT_PATH));
    assert.equal(result.apiDetected, false);
  });

  it('includes docs/API-CONTRACT.md when integrations declare REST/API', () => {
    const apiScribe: ScribeOutput = {
      ...scribeOutput,
      spec: {
        ...baseSpec,
        technicalConstraints: {
          stack: 'Node + Express',
          integrations: ['REST API for payments'],
        },
      },
    };
    const result = injectArtifacts({
      files: baseFiles,
      scribeOutput: apiScribe,
      now: FIXED_DATE,
    });
    const paths = result.files.map((f) => f.filePath);
    assert.ok(paths.includes(API_CONTRACT_PATH));
    assert.equal(result.apiDetected, true);
    const contract = result.files.find((f) => f.filePath === API_CONTRACT_PATH)!;
    assert.match(contract.content, /^# API Contract/);
  });

  it('includes docs/API-CONTRACT.md when route files are detected', () => {
    const apiFiles: ProtoOutput['files'] = [
      ...baseFiles,
      {
        filePath: 'server.js',
        content:
          "import express from 'express'; const app = express(); app.get('/items', (req,res)=>{}); app.post('/items', (req,res)=>{});",
        linesOfCode: 1,
      },
    ];
    const result = injectArtifacts({
      files: apiFiles,
      scribeOutput,
      now: FIXED_DATE,
    });
    assert.equal(result.apiDetected, true);
    const contract = result.files.find((f) => f.filePath === API_CONTRACT_PATH)!;
    assert.match(contract.content, /GET \/items/);
    assert.match(contract.content, /POST \/items/);
  });

  it('is idempotent — does not overwrite a pre-existing docs/PRD.md', () => {
    const filesWithPrd: ProtoOutput['files'] = [
      ...baseFiles,
      { filePath: PRD_PATH, content: '# Custom PRD\n', linesOfCode: 1 },
    ];
    const result = injectArtifacts({
      files: filesWithPrd,
      scribeOutput,
      now: FIXED_DATE,
    });
    const prd = result.files.find((f) => f.filePath === PRD_PATH)!;
    assert.equal(prd.content, '# Custom PRD\n', 'existing PRD must be preserved');
    assert.ok(!result.added.includes(PRD_PATH));
    // Technical analysis still added.
    assert.ok(result.added.includes(TECH_ANALYSIS_PATH));
  });

  it('preserves all input files', () => {
    const result = injectArtifacts({
      files: baseFiles,
      scribeOutput,
      now: FIXED_DATE,
    });
    const originalPaths = baseFiles.map((f) => f.filePath);
    for (const p of originalPaths) {
      assert.ok(
        result.files.some((f) => f.filePath === p),
        `original ${p} must remain`
      );
    }
  });

  it('returns a new array (does not mutate input)', () => {
    const filesCopy = baseFiles.map((f) => ({ ...f }));
    const result = injectArtifacts({
      files: baseFiles,
      scribeOutput,
      now: FIXED_DATE,
    });
    assert.equal(baseFiles.length, filesCopy.length);
    assert.notEqual(result.files, baseFiles);
  });
});

describe('detectApiSurface', () => {
  it('returns false for pure frontend scaffolds', () => {
    assert.equal(detectApiSurface({ files: baseFiles, integrations: [] }), false);
  });

  it('returns true when integrations mention API keywords', () => {
    assert.equal(detectApiSurface({ files: baseFiles, integrations: ['Backend REST'] }), true);
    assert.equal(detectApiSurface({ files: baseFiles, integrations: ['GraphQL endpoint'] }), true);
  });

  it('returns false for src/api/ folder without server code', () => {
    // A pure frontend with a service folder shouldn't trigger.
    const files: ProtoOutput['files'] = [
      ...baseFiles,
      {
        filePath: 'src/api/client.js',
        content: 'export const fetchItems = () => fetch("/items");',
        linesOfCode: 1,
      },
    ];
    assert.equal(detectApiSurface({ files, integrations: [] }), false);
  });

  it('returns true for Next.js app router route handler', () => {
    const files: ProtoOutput['files'] = [
      ...baseFiles,
      {
        filePath: 'app/api/items/route.ts',
        content: 'export async function GET() { return Response.json([]); }',
        linesOfCode: 1,
      },
    ];
    assert.equal(detectApiSurface({ files, integrations: [] }), true);
  });
});

describe('detectEndpoints', () => {
  it('parses express-style route declarations', () => {
    const files: ProtoOutput['files'] = [
      {
        filePath: 'server.js',
        content: "app.get('/foo', () => {}); app.post('/bar', () => {});",
        linesOfCode: 1,
      },
    ];
    const eps = detectEndpoints(files);
    assert.equal(eps.length, 2);
    assert.deepEqual(
      eps.map((e) => `${e.method} ${e.path}`).sort(),
      ['GET /foo', 'POST /bar'].sort()
    );
  });

  it('parses Next.js app router routes from file path', () => {
    const files: ProtoOutput['files'] = [
      {
        filePath: 'app/api/items/route.ts',
        content:
          'export async function GET() { return Response.json([]); }\nexport async function POST() {}',
        linesOfCode: 1,
      },
    ];
    const eps = detectEndpoints(files);
    assert.equal(eps.length, 2);
    assert.ok(eps.every((e) => e.path.startsWith('/api/items')));
  });

  it('returns empty array when no endpoints found', () => {
    assert.deepEqual(detectEndpoints(baseFiles), []);
  });
});

describe('renderTechnicalAnalysisMarkdown', () => {
  it('emits all major sections', () => {
    const md = renderTechnicalAnalysisMarkdown({
      files: baseFiles,
      spec: baseSpec,
      plan: basePlan,
      now: FIXED_DATE,
    });
    assert.match(md, /^# Teknik Analiz/);
    assert.match(md, /## Özet/);
    assert.match(md, /## Stack/);
    assert.match(md, /## Dosya Yapısı/);
    assert.match(md, /## Önemli kararlar/);
    assert.match(md, /Üretildi: 2026-05-20T10:00:00\.000Z · AKIS Proto/);
  });

  it('reports stack from file extensions when plan/spec is absent', () => {
    const md = renderTechnicalAnalysisMarkdown({
      files: [...baseFiles, { filePath: 'src/main.tsx', content: 'export {}', linesOfCode: 1 }],
      now: FIXED_DATE,
    });
    assert.match(md, /TypeScript/);
  });
});
