import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PipelineActivity } from '../usePipelineStream';

// ─────────────────────────────────────────────────────────
// useProfileCompleteness — pure-logic tests
//
// The hook itself fetches from /api/... and uses useAuth(),
// but the completeness computation is pure arithmetic on
// three booleans: hasName, hasGitHub, hasAiKey.
// We replicate that logic here to test each scenario.
// ─────────────────────────────────────────────────────────

function computeProfileCompleteness(user: { name?: string } | null, githubConnected: boolean, aiKeyConfigured: boolean) {
  const hasName = Boolean(user?.name?.trim());
  const hasGitHub = githubConnected;
  const hasAiKey = aiKeyConfigured;

  const missing: string[] = [];
  if (!hasName) missing.push('profile');
  if (!hasGitHub) missing.push('github');
  if (!hasAiKey) missing.push('ai-provider');

  const totalSteps = 3;
  const completedSteps = [hasName, hasGitHub, hasAiKey].filter(Boolean).length;

  return {
    isComplete: completedSteps === totalSteps,
    completedSteps,
    totalSteps,
    missingSteps: missing,
    hasName,
    hasGitHub,
    hasAiKey,
  };
}

describe('useProfileCompleteness (pure logic)', () => {
  it('returns empty missingSteps when all steps are complete', () => {
    const result = computeProfileCompleteness({ name: 'Omer' }, true, true);
    expect(result.isComplete).toBe(true);
    expect(result.completedSteps).toBe(3);
    expect(result.missingSteps).toEqual([]);
  });

  it('includes "github" when GitHub is not connected', () => {
    const result = computeProfileCompleteness({ name: 'Omer' }, false, true);
    expect(result.isComplete).toBe(false);
    expect(result.completedSteps).toBe(2);
    expect(result.missingSteps).toContain('github');
    expect(result.missingSteps).not.toContain('profile');
    expect(result.missingSteps).not.toContain('ai-provider');
  });

  it('includes "ai-provider" when AI key is not configured', () => {
    const result = computeProfileCompleteness({ name: 'Omer' }, true, false);
    expect(result.isComplete).toBe(false);
    expect(result.completedSteps).toBe(2);
    expect(result.missingSteps).toContain('ai-provider');
    expect(result.missingSteps).not.toContain('github');
  });

  it('returns all missing steps when user is null', () => {
    const result = computeProfileCompleteness(null, false, false);
    expect(result.isComplete).toBe(false);
    expect(result.completedSteps).toBe(0);
    expect(result.totalSteps).toBe(3);
    expect(result.missingSteps).toEqual(['profile', 'github', 'ai-provider']);
    expect(result.hasName).toBe(false);
    expect(result.hasGitHub).toBe(false);
    expect(result.hasAiKey).toBe(false);
  });

  it('treats empty name as missing profile', () => {
    const result = computeProfileCompleteness({ name: '   ' }, true, true);
    expect(result.hasName).toBe(false);
    expect(result.missingSteps).toContain('profile');
    expect(result.completedSteps).toBe(2);
  });

  it('treats undefined name as missing profile', () => {
    const result = computeProfileCompleteness({ name: undefined }, true, true);
    expect(result.hasName).toBe(false);
    expect(result.missingSteps).toContain('profile');
  });

  it('returns partial completeness for only name set', () => {
    const result = computeProfileCompleteness({ name: 'Omer' }, false, false);
    expect(result.completedSteps).toBe(1);
    expect(result.missingSteps).toEqual(['github', 'ai-provider']);
  });
});

// ─────────────────────────────────────────────────────────
// usePipelineStream — pure-logic tests
//
// The hook manages SSE + fetch, but its core logic is:
// 1. Activity dedup via key = `stage:step:timestamp`
// 2. progressByStage reduce
// 3. currentStep = last activity
// 4. SSE JSON parsing (valid / invalid)
//
// We extract and test these as pure functions.
// ─────────────────────────────────────────────────────────

/** Replicates the dedup key from usePipelineStream's ingest function */
function makeActivityKey(a: PipelineActivity): string {
  return `${a.stage}:${a.step}:${a.timestamp}`;
}

/** Replicates the progressByStage reduce from usePipelineStream */
function computeProgressByStage(activities: PipelineActivity[]): Record<string, number> {
  return activities.reduce<Record<string, number>>((acc, a) => {
    if (a.progress !== undefined) acc[a.stage] = a.progress;
    return acc;
  }, {});
}

/** Replicates the SSE onmessage parsing logic */
function parseSSEMessage(rawData: string): PipelineActivity | null {
  try {
    const data = JSON.parse(rawData);
    if (data.type === 'connected') return null;
    return data as PipelineActivity;
  } catch {
    return null;
  }
}

/** Replicates the ingest + dedup logic against an accumulator */
function ingestActivities(incoming: PipelineActivity[]): PipelineActivity[] {
  const seen = new Set<string>();
  const result: PipelineActivity[] = [];
  for (const activity of incoming) {
    const key = makeActivityKey(activity);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(activity);
  }
  return result;
}

function makeActivity(overrides: Partial<PipelineActivity> = {}): PipelineActivity {
  return {
    pipelineId: 'pipe-1',
    stage: 'scribe',
    step: 'analyzing',
    message: 'Analyzing idea',
    timestamp: '2026-04-14T10:00:00Z',
    ...overrides,
  };
}

describe('usePipelineStream (pure logic)', () => {
  // ── SSE message parsing ─────────────────────────

  describe('SSE message parsing', () => {
    it('parses valid JSON into PipelineActivity', () => {
      const activity = makeActivity({ message: 'Building scaffold' });
      const parsed = parseSSEMessage(JSON.stringify(activity));
      expect(parsed).toEqual(activity);
    });

    it('returns null for invalid JSON', () => {
      const parsed = parseSSEMessage('not valid json {{{');
      expect(parsed).toBeNull();
    });

    it('returns null for empty string', () => {
      const parsed = parseSSEMessage('');
      expect(parsed).toBeNull();
    });

    it('returns null for "connected" type messages', () => {
      const parsed = parseSSEMessage(JSON.stringify({ type: 'connected' }));
      expect(parsed).toBeNull();
    });

    it('parses activity with all optional fields', () => {
      const activity = makeActivity({
        detail: 'src/index.ts',
        progress: 75,
        retryCount: 1,
      });
      const parsed = parseSSEMessage(JSON.stringify(activity));
      expect(parsed).not.toBeNull();
      expect(parsed!.progress).toBe(75);
      expect(parsed!.detail).toBe('src/index.ts');
      expect(parsed!.retryCount).toBe(1);
    });
  });

  // ── Activity dedup ──────────────────────────────

  describe('activity dedup', () => {
    it('does not add the same activity twice', () => {
      const a = makeActivity();
      const result = ingestActivities([a, a, a]);
      expect(result).toHaveLength(1);
    });

    it('allows activities with different timestamps', () => {
      const a1 = makeActivity({ timestamp: '2026-04-14T10:00:00Z' });
      const a2 = makeActivity({ timestamp: '2026-04-14T10:00:01Z' });
      const result = ingestActivities([a1, a2]);
      expect(result).toHaveLength(2);
    });

    it('allows activities with different steps at the same timestamp', () => {
      const a1 = makeActivity({ step: 'analyzing' });
      const a2 = makeActivity({ step: 'generating' });
      const result = ingestActivities([a1, a2]);
      expect(result).toHaveLength(2);
    });

    it('allows activities with different stages at the same timestamp', () => {
      const a1 = makeActivity({ stage: 'scribe' });
      const a2 = makeActivity({ stage: 'proto' });
      const result = ingestActivities([a1, a2]);
      expect(result).toHaveLength(2);
    });

    it('deduplicates when hydrated history and live stream overlap', () => {
      const history = [
        makeActivity({ step: 'step1', timestamp: '2026-04-14T10:00:00Z' }),
        makeActivity({ step: 'step2', timestamp: '2026-04-14T10:00:01Z' }),
      ];
      const live = [
        makeActivity({ step: 'step2', timestamp: '2026-04-14T10:00:01Z' }), // duplicate
        makeActivity({ step: 'step3', timestamp: '2026-04-14T10:00:02Z' }), // new
      ];
      const result = ingestActivities([...history, ...live]);
      expect(result).toHaveLength(3);
      expect(result.map(a => a.step)).toEqual(['step1', 'step2', 'step3']);
    });
  });

  // ── Activity sorting / ordering ─────────────────

  describe('activity ordering', () => {
    it('maintains insertion order (activities are appended)', () => {
      const activities = [
        makeActivity({ step: 'step1', timestamp: '2026-04-14T10:00:00Z' }),
        makeActivity({ step: 'step3', timestamp: '2026-04-14T10:00:02Z' }),
        makeActivity({ step: 'step2', timestamp: '2026-04-14T10:00:01Z' }),
      ];
      const result = ingestActivities(activities);
      expect(result.map(a => a.step)).toEqual(['step1', 'step3', 'step2']);
    });

    it('activities can be sorted by timestamp', () => {
      const activities = [
        makeActivity({ step: 'step3', timestamp: '2026-04-14T10:00:02Z' }),
        makeActivity({ step: 'step1', timestamp: '2026-04-14T10:00:00Z' }),
        makeActivity({ step: 'step2', timestamp: '2026-04-14T10:00:01Z' }),
      ];
      const sorted = [...activities].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
      expect(sorted.map(a => a.step)).toEqual(['step1', 'step2', 'step3']);
    });
  });

  // ── progressByStage ─────────────────────────────

  describe('progressByStage', () => {
    it('returns empty object when no activities have progress', () => {
      const activities = [makeActivity({ progress: undefined })];
      expect(computeProgressByStage(activities)).toEqual({});
    });

    it('tracks progress per stage', () => {
      const activities = [
        makeActivity({ stage: 'scribe', progress: 50 }),
        makeActivity({ stage: 'proto', progress: 25 }),
      ];
      expect(computeProgressByStage(activities)).toEqual({ scribe: 50, proto: 25 });
    });

    it('uses last progress value when multiple activities for same stage', () => {
      const activities = [
        makeActivity({ stage: 'proto', step: 'step1', progress: 25, timestamp: '2026-04-14T10:00:00Z' }),
        makeActivity({ stage: 'proto', step: 'step2', progress: 75, timestamp: '2026-04-14T10:00:01Z' }),
        makeActivity({ stage: 'proto', step: 'step3', progress: 100, timestamp: '2026-04-14T10:00:02Z' }),
      ];
      expect(computeProgressByStage(activities)).toEqual({ proto: 100 });
    });

    it('ignores activities without progress field', () => {
      const activities = [
        makeActivity({ stage: 'scribe', progress: 50 }),
        makeActivity({ stage: 'scribe', step: 'step2', progress: undefined, timestamp: '2026-04-14T10:00:01Z' }),
      ];
      expect(computeProgressByStage(activities)).toEqual({ scribe: 50 });
    });
  });

  // ── currentStep (last activity) ─────────────────

  describe('currentStep derivation', () => {
    it('is null when activities array is empty', () => {
      const activities: PipelineActivity[] = [];
      const currentStep = activities.length > 0 ? activities[activities.length - 1] : null;
      expect(currentStep).toBeNull();
    });

    it('returns the last activity in the list', () => {
      const activities = [
        makeActivity({ step: 'step1' }),
        makeActivity({ step: 'step2', timestamp: '2026-04-14T10:00:01Z' }),
        makeActivity({ step: 'step3', timestamp: '2026-04-14T10:00:02Z' }),
      ];
      const currentStep = activities[activities.length - 1];
      expect(currentStep.step).toBe('step3');
    });
  });

  // ── dedup key generation ────────────────────────

  describe('dedup key generation', () => {
    it('generates key from stage:step:timestamp', () => {
      const a = makeActivity({ stage: 'proto', step: 'pushing', timestamp: '2026-04-14T12:00:00Z' });
      expect(makeActivityKey(a)).toBe('proto:pushing:2026-04-14T12:00:00Z');
    });

    it('different step produces different key', () => {
      const a = makeActivity({ step: 'analyzing' });
      const b = makeActivity({ step: 'generating' });
      expect(makeActivityKey(a)).not.toBe(makeActivityKey(b));
    });

    it('different stage produces different key', () => {
      const a = makeActivity({ stage: 'scribe' });
      const b = makeActivity({ stage: 'proto' });
      expect(makeActivityKey(a)).not.toBe(makeActivityKey(b));
    });
  });
});
