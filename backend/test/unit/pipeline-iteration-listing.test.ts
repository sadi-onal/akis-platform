/**
 * Unit tests for iteration-aware pipeline listing.
 * Covers issue #388 / BUG-08: iteration children must NOT appear as separate
 * sidebar entries, and parents must expose their children via a dedicated method.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  PipelineOrchestrator,
  type PipelineStore,
  type PipelineStateUpdate,
} from '../../src/pipeline/core/orchestrator/PipelineOrchestrator.js';
import type { PipelineState } from '../../src/pipeline/core/contracts/PipelineTypes.js';
import type { ScribeAgent } from '../../src/pipeline/agents/scribe/ScribeAgent.js';
import type { ProtoAgent } from '../../src/pipeline/agents/proto/ProtoAgent.js';
import type { TraceAgent } from '../../src/pipeline/agents/trace/TraceAgent.js';

/** Store that distinguishes root vs. child pipelines via `intermediateState.parentPipelineId`. */
class IterationAwareStore implements PipelineStore {
  private pipelines = new Map<string, PipelineState>();

  async create(userId: string): Promise<PipelineState> {
    const id = crypto.randomUUID();
    const p: PipelineState = {
      id,
      userId,
      stage: 'scribe_generating',
      scribeConversation: [],
      metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.pipelines.set(id, p);
    return { ...p };
  }

  async getById(id: string): Promise<PipelineState | null> {
    const p = this.pipelines.get(id);
    return p ? { ...p } : null;
  }

  async listByUser(userId: string): Promise<PipelineState[]> {
    return [...this.pipelines.values()]
      .filter((p) => p.userId === userId)
      .map((p) => ({ ...p }));
  }

  async listRootsByUser(userId: string): Promise<PipelineState[]> {
    return [...this.pipelines.values()]
      .filter((p) => {
        if (p.userId !== userId) return false;
        const parent = (p.intermediateState as Record<string, unknown> | undefined)?.parentPipelineId;
        return parent == null;
      })
      .map((p) => ({ ...p }));
  }

  async listChildrenOf(parentPipelineId: string): Promise<PipelineState[]> {
    return [...this.pipelines.values()]
      .filter(
        (p) =>
          (p.intermediateState as Record<string, unknown> | undefined)?.parentPipelineId ===
          parentPipelineId,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => ({ ...p }));
  }

  async update(id: string, data: Partial<PipelineStateUpdate>): Promise<PipelineState> {
    const existing = this.pipelines.get(id);
    if (!existing) throw new Error(`not found: ${id}`);
    const updated: PipelineState = { ...existing, ...data, updatedAt: new Date() } as PipelineState;
    this.pipelines.set(id, updated);
    return { ...updated };
  }

  /** Helper used only by tests — seed a pre-built pipeline. */
  seed(p: PipelineState): void {
    this.pipelines.set(p.id, p);
  }
}

/** Bare minimum orchestrator — we only exercise listing methods here. */
function buildOrchestrator(store: PipelineStore): PipelineOrchestrator {
  const noopAgent = {} as unknown as ScribeAgent;
  return new PipelineOrchestrator(
    store,
    noopAgent,
    {} as unknown as ProtoAgent,
    {} as unknown as TraceAgent,
    async () => 'testuser',
    async () => 'ghp_mock',
    () => ({
      createRepository: async () => ({ url: '' }),
      createBranch: async () => {},
      commitFile: async () => {},
      pushFiles: async () => {},
      createPR: async () => ({ url: '' }),
      listFiles: async () => [],
      getFileContent: async () => '',
    }),
  );
}

function fakePipeline(overrides: Partial<PipelineState> & { id: string; userId: string }): PipelineState {
  return {
    stage: 'completed',
    scribeConversation: [],
    metrics: { startedAt: new Date(), clarificationRounds: 0, retryCount: 0 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PipelineState;
}

describe('listPipelines — sidebar filter for iteration children', () => {
  it('returns only root pipelines when the store supports listRootsByUser', async () => {
    const store = new IterationAwareStore();
    const userId = 'user-a';

    const root = fakePipeline({ id: 'root-1', userId, title: 'Todo App' });
    const child1 = fakePipeline({
      id: 'child-1',
      userId,
      title: 'Todo App (iter 1)',
      intermediateState: { parentPipelineId: 'root-1', iterationRequest: 'tema mavi' },
    });
    const child2 = fakePipeline({
      id: 'child-2',
      userId,
      title: 'Todo App (iter 2)',
      intermediateState: { parentPipelineId: 'root-1', iterationRequest: 'buton büyüt' },
    });
    store.seed(root);
    store.seed(child1);
    store.seed(child2);

    const orch = buildOrchestrator(store);
    const result = await orch.listPipelines(userId);

    assert.equal(result.length, 1, 'sidebar should show one root entry, not three');
    assert.equal(result[0].id, 'root-1');
  });

  it('listAllPipelines includes children for admin/internal use', async () => {
    const store = new IterationAwareStore();
    const userId = 'user-b';
    store.seed(fakePipeline({ id: 'r', userId }));
    store.seed(
      fakePipeline({
        id: 'c',
        userId,
        intermediateState: { parentPipelineId: 'r' },
      }),
    );

    const orch = buildOrchestrator(store);
    const all = await orch.listAllPipelines(userId);
    assert.equal(all.length, 2);
  });

  it('falls back to listByUser when store does not implement listRootsByUser (backward compat)', async () => {
    class MinimalStore extends IterationAwareStore {
      listRootsByUser = undefined as unknown as IterationAwareStore['listRootsByUser'];
      listChildrenOf = undefined as unknown as IterationAwareStore['listChildrenOf'];
    }
    const store = new MinimalStore();
    const userId = 'user-c';
    store.seed(fakePipeline({ id: 'root', userId }));
    store.seed(
      fakePipeline({
        id: 'child',
        userId,
        intermediateState: { parentPipelineId: 'root' },
      }),
    );

    const orch = buildOrchestrator(store);
    const result = await orch.listPipelines(userId);
    // Minimal store falls back to listByUser → returns all (including child)
    assert.equal(result.length, 2);
  });
});

describe('listChildren — iteration timeline merge', () => {
  it('returns children in chronological order', async () => {
    const store = new IterationAwareStore();
    const userId = 'user-d';
    store.seed(fakePipeline({ id: 'root', userId }));
    const earlier = new Date('2026-04-10T10:00:00Z');
    const later = new Date('2026-04-11T11:00:00Z');
    store.seed(
      fakePipeline({
        id: 'child-later',
        userId,
        createdAt: later,
        intermediateState: { parentPipelineId: 'root', iterationRequest: 'step 2' },
      }),
    );
    store.seed(
      fakePipeline({
        id: 'child-earlier',
        userId,
        createdAt: earlier,
        intermediateState: { parentPipelineId: 'root', iterationRequest: 'step 1' },
      }),
    );

    const orch = buildOrchestrator(store);
    const children = await orch.listChildren('root');
    assert.equal(children.length, 2);
    assert.equal(children[0].id, 'child-earlier', 'earliest iteration should be first');
    assert.equal(children[1].id, 'child-later');
  });

  it('returns [] for a pipeline with no iterations', async () => {
    const store = new IterationAwareStore();
    store.seed(fakePipeline({ id: 'solo', userId: 'user-e' }));
    const orch = buildOrchestrator(store);
    const children = await orch.listChildren('solo');
    assert.deepEqual(children, []);
  });

  it('returns [] when the store does not implement listChildrenOf', async () => {
    class MinimalStore extends IterationAwareStore {
      listRootsByUser = undefined as unknown as IterationAwareStore['listRootsByUser'];
      listChildrenOf = undefined as unknown as IterationAwareStore['listChildrenOf'];
    }
    const orch = buildOrchestrator(new MinimalStore());
    const children = await orch.listChildren('any-id');
    assert.deepEqual(children, []);
  });
});
