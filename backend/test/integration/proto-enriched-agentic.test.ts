/**
 * Proto enriched-output integration test (agentic / tool_use path) —
 * F-08 review fix #2.
 *
 * Drives ProtoAgent's `executeWithTools` path with a mocked AgenticLoopDeps
 * (so we don't hit the real LLM API) and a capturing GitHub adapter, then
 * asserts the bytes that land at `pushFiles` include the bakkal portability
 * layer. This is the trickiest of the three push paths (closure-captured
 * `enrichedPushed`, double-mapping between `path`/`filePath`) and previously
 * had zero test coverage.
 *
 * Why this matters:
 *   The agentic path enriches inside the wrapped `pushFiles` handler
 *   (ProtoAgent.ts:556-569). If F-08 is silently broken there — e.g. the
 *   wrap is removed in a refactor — the LLM would still report success but
 *   install.sh + Turkish README would never reach GitHub. This test pins
 *   the contract.
 *
 * Run: pnpm -C backend test:integration
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProtoAgent,
  type ProtoAIDeps,
  type ProtoGitHubDeps,
} from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { ProtoInput, StructuredSpec } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { AgenticLoopDeps } from '../../src/pipeline/core/AgenticLoop.js';
import type { AnthropicResponse } from '../../src/services/ai/tool-schemas.js';

const spec: StructuredSpec = {
  title: 'Veresiye Defteri',
  problemStatement: 'Bakkal sahibinin müşteri borç takibini dijitalleştirmek.',
  userStories: [
    { persona: 'Bakkal sahibi', action: 'Müşteri borcu eklemek', benefit: 'Defter tutmaktan kurtulmak' },
  ],
  acceptanceCriteria: [
    { id: 'ac-1', given: 'Bakkal panelde', when: 'Yeni borç ekler', then: 'Borç kaydedilir ve listede görünür' },
  ],
  technicalConstraints: { stack: 'React + Vite', integrations: [], nonFunctional: [] },
  outOfScope: [],
};

// Mock AI for the legacy fallback path — never actually invoked because the
// agentic loop completes without throwing.
function createMockAI(): ProtoAIDeps {
  return { generateText: async () => '{"files":[],"setupCommands":[],"metadata":{}}' };
}

/**
 * Mocked agentic loop:
 *   iteration 1 → tool_use(push_files) with a minimal Vite scaffold (no
 *                 enricher artifacts — that's the enricher's job)
 *   iteration 2 → end_turn with a Turkish summary
 *
 * `create_repository` is filtered out of PROTO_TOOLS by ProtoAgent before the
 * loop starts (the repo is created above the loop), so we don't need to
 * emit it from the mock — the very first turn calls push_files directly.
 */
function createAgenticDeps(): AgenticLoopDeps {
  let iteration = 0;
  return {
    async callWithTools(_messages, _tools, _opts): Promise<AnthropicResponse> {
      iteration++;
      if (iteration === 1) {
        return {
          id: 'msg-1',
          stop_reason: 'tool_use',
          content: [{
            type: 'tool_use',
            id: 'toolu_push',
            name: 'push_files',
            input: {
              owner: 'testuser',
              repo: 'veresiye',
              branch: 'main',
              files: [
                { path: 'package.json', content: '{"name":"veresiye","scripts":{"dev":"vite","build":"vite build","preview":"vite preview"}}' },
                { path: 'index.html', content: '<!doctype html><html><body><div id="root"></div></body></html>' },
                { path: 'src/main.jsx', content: 'console.log("hi");' },
                { path: 'src/App.jsx', content: 'export default function App(){return <div>Borç</div>;}' },
                { path: 'src/App.css', content: 'body{}' },
                { path: '.gitignore', content: 'node_modules\n.env\n' },
              ],
              message: 'feat: initial scaffold',
            },
          }],
        };
      }
      return {
        id: 'msg-2',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Veresiye Defteri scaffold oluşturuldu.' }],
      };
    },
  };
}

function createCapturingGitHub(): ProtoGitHubDeps & {
  capturedPush?: { owner: string; repo: string; branch: string; files: Array<{ path: string; content: string }> };
} {
  const out: ProtoGitHubDeps & {
    capturedPush?: { owner: string; repo: string; branch: string; files: Array<{ path: string; content: string }> };
  } = {
    createRepository: async () => ({ url: 'https://github.com/testuser/veresiye' }),
    createBranch: async () => {},
    commitFile: async () => {},
    pushFiles: async (owner, repo, branch, files) => {
      out.capturedPush = { owner, repo, branch, files: [...files] };
    },
    createPR: async () => ({ url: 'https://github.com/testuser/veresiye/pull/1' }),
    // Must include the enricher's artifacts so verifyRepoPushed's auto_init
    // detector doesn't trip — the test asserts the *captured push payload*,
    // not the listFiles result.
    listFiles: async () => [
      'package.json', 'index.html', 'src/main.jsx', 'src/App.jsx', 'src/App.css', '.gitignore',
      'install.sh', 'README.md', '.env.example', 'Dockerfile', 'docker-compose.yml',
    ],
  };
  return out;
}

function baseInput(overrides?: Partial<ProtoInput>): ProtoInput {
  return {
    spec,
    repoName: 'veresiye',
    repoVisibility: 'private',
    owner: 'testuser',
    ...overrides,
  };
}

describe('ProtoAgent + ScaffoldEnricher integration — agentic path (F-08)', () => {
  it('executeWithTools() pushes enriched files including install.sh', async () => {
    const ai = createMockAI();
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github, createAgenticDeps());

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output', 'agentic path should succeed');
    if (result.type !== 'output') return;

    const pushed = github.capturedPush;
    assert.ok(pushed, 'pushFiles should have been invoked through the wrapped tool handler');
    const pathSet = new Set(pushed.files.map((f) => f.path));

    // The LLM emitted 6 files; the enricher must layer on the bakkal artifacts.
    assert.ok(pathSet.has('install.sh'), 'install.sh must be in agentic push payload');
    assert.ok(pathSet.has('README.md'), 'README.md must be in agentic push payload');
    assert.ok(pathSet.has('.env.example'), '.env.example must be in agentic push payload');
    assert.ok(pathSet.has('Dockerfile'), 'Dockerfile must be in agentic push payload');
    assert.ok(pathSet.has('docker-compose.yml'), 'docker-compose.yml must be in agentic push payload');

    // The LLM's original 6 files must still be present.
    assert.ok(pathSet.has('package.json'));
    assert.ok(pathSet.has('src/App.jsx'));
  });

  it('executeWithTools() README contains all three Turkish bakkal sections', async () => {
    const ai = createMockAI();
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github, createAgenticDeps());

    await agent.execute(baseInput());
    const readme = github.capturedPush?.files.find((f) => f.path === 'README.md');
    assert.ok(readme, 'README.md should be present in agentic push');
    assert.match(readme.content, /## Bu projeyi kendi bilgisayarında çalıştır/);
    assert.match(readme.content, /## Sunucuya kur/);
    assert.match(readme.content, /## GitHub'da gör/);
  });

  it('executeWithTools() install.sh contains AKIS header + npm dev command', async () => {
    const ai = createMockAI();
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github, createAgenticDeps());

    await agent.execute(baseInput());
    const sh = github.capturedPush?.files.find((f) => f.path === 'install.sh');
    assert.ok(sh, 'install.sh should be present in agentic push');
    assert.match(sh.content, /Bu komut dosyası AKIS tarafından üretildi/);
    assert.match(sh.content, /npm install/);
    assert.match(sh.content, /npm run dev/);
  });

  it('executeWithTools() Dockerfile uses preview CMD for Vite scaffolds', async () => {
    // The mocked LLM emits a Vite-shaped package.json (no `start` script).
    // The Dockerfile fix #1 demands CMD ["npm","run","preview"], not
    // CMD ["npm","start"], for that case.
    const ai = createMockAI();
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github, createAgenticDeps());

    await agent.execute(baseInput());
    const docker = github.capturedPush?.files.find((f) => f.path === 'Dockerfile');
    assert.ok(docker, 'Dockerfile should be present in agentic push');
    assert.match(docker.content, /CMD \["npm", "run", "preview"\]/);
    assert.doesNotMatch(docker.content, /CMD \["npm", "start"\]/);
    // Build step must not swallow failures.
    assert.doesNotMatch(docker.content, /run build \|\| true/);
  });

  it('executeWithTools() metadata.filesCreated reflects the enriched count', async () => {
    const ai = createMockAI();
    const github = createCapturingGitHub();
    const agent = new ProtoAgent(ai, github, createAgenticDeps());

    const result = await agent.execute(baseInput());
    assert.equal(result.type, 'output');
    if (result.type !== 'output') return;

    assert.equal(
      result.data.metadata.filesCreated,
      result.data.files.length,
      'metadata.filesCreated must equal the post-enrichment files length',
    );
    // The LLM produced 6 files; enricher adds 5 (install.sh, README.md,
    // .env.example, Dockerfile, docker-compose.yml). Final count >= 11.
    assert.ok(result.data.files.length >= 11);
  });
});
