import { describe, it, expect } from 'vitest';
import { conversationToChatMessages } from '../conversationToChatMessages';
import type { ConversationMessage, StructuredSpec } from '../../types/workflow';

function spec(): StructuredSpec {
  return {
    title: 'Bakkal stoğu',
    problemStatement: 'Bakkal stoğu kalmadığında haber alsın.',
    userStories: [
      {
        asA: 'bakkal sahibi',
        action: 'düşük stoğa düşen ürünleri görmek',
        benefit: 'siparişimi zamanında verebilmek',
        acceptanceCriteria: ['Stok 5 birimin altına düştüğünde uyarı görünür.'],
      },
    ],
  } as unknown as StructuredSpec;
}

function specMsg(): ConversationMessage {
  return {
    role: 'scribe',
    type: 'spec',
    spec: spec(),
    content: 'Spec hazır.',
    timestamp: '2026-05-09T12:00:00Z',
  } as unknown as ConversationMessage;
}

describe('conversationToChatMessages — plan status by stage', () => {
  it("keeps the plan card 'active' while Scribe is still clarifying", () => {
    const msgs = conversationToChatMessages([specMsg()], 'scribe_clarifying');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan).toBeDefined();
    expect(plan && 'status' in plan && plan.status).toBe('active');
  });

  it("keeps the plan card 'active' during scribe_generating", () => {
    const msgs = conversationToChatMessages([specMsg()], 'scribe_generating');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('active');
  });

  it("keeps the plan card 'active' while Critic is reviewing the spec (regression: Bug A)", () => {
    // Bug A: previously the plan was flipped to 'approved' as soon as the
    // stage moved past awaiting_approval / scribe_*, which incorrectly
    // included critic_reviewing_spec — Critic may have signed off internally
    // but the user hasn't pressed "Onayla" yet.
    const msgs = conversationToChatMessages([specMsg()], 'critic_reviewing_spec');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('active');
  });

  it("keeps the plan card 'active' while awaiting_approval", () => {
    const msgs = conversationToChatMessages([specMsg()], 'awaiting_approval');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('active');
  });

  it("flips the plan to 'approved' once Proto kicks off", () => {
    const msgs = conversationToChatMessages([specMsg()], 'proto_building');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('approved');
  });

  it("flips the plan to 'approved' during critic_reviewing_code", () => {
    const msgs = conversationToChatMessages([specMsg()], 'critic_reviewing_code');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('approved');
  });

  it("a system 'reddedildi' message overrides plan status to 'rejected'", () => {
    const reject: ConversationMessage = {
      role: 'system',
      type: 'system',
      content: 'Plan reddedildi.',
      timestamp: '2026-05-09T12:00:01Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([specMsg(), reject], 'awaiting_approval');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('rejected');
  });
});

describe('conversationToChatMessages — message-type coverage', () => {
  it('emits a user bubble for role=user', () => {
    const userMsg: ConversationMessage = {
      role: 'user',
      type: 'message',
      content: 'Merhaba.',
      timestamp: '2026-05-09T12:00:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([userMsg]);
    expect(msgs).toEqual([
      { type: 'user', content: 'Merhaba.', timestamp: '2026-05-09T12:00:00Z' },
    ]);
  });

  it('falls back to a plain agent bubble when an agent message has no spec/clarification/trace_result', () => {
    // Hits the final `else` branch (line 159) — generic agent reply.
    const note: ConversationMessage = {
      role: 'proto',
      type: 'message',
      content: 'Proto bir not düşüyor.',
      timestamp: '2026-05-09T12:01:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([note]);
    expect(msgs).toEqual([
      {
        type: 'agent',
        agent: 'proto',
        content: 'Proto bir not düşüyor.',
        timestamp: '2026-05-09T12:01:00Z',
      },
    ]);
  });

  it('synthesises a fresh timestamp when the conversation message has none', () => {
    // Hits the `m.timestamp ?? new Date().toISOString()` fallback.
    const m: ConversationMessage = {
      role: 'user',
      type: 'message',
      content: 'no ts',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    expect(msgs).toHaveLength(1);
    expect(typeof (msgs[0] as { timestamp: string }).timestamp).toBe('string');
    expect((msgs[0] as { timestamp: string }).timestamp.length).toBeGreaterThan(0);
  });

  it('emits a clarification bubble when the scribe asks structured questions', () => {
    // Hits the `type === 'clarification' && questions.length` branch.
    const clarify: ConversationMessage = {
      role: 'scribe',
      type: 'clarification',
      content: 'Birkaç sorum var.',
      questions: [
        { id: 'q1', question: 'Kaç kullanıcı?', reason: 'Scaling' },
        { id: 'q2', question: 'Hangi dil?', reason: 'i18n', suggestions: ['TR', 'EN'] },
      ],
      timestamp: '2026-05-09T12:02:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([clarify]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      type: 'clarification',
      role: 'scribe',
      questions: [{ id: 'q1' }, { id: 'q2' }],
    });
  });

  it('falls through to a plain agent bubble when a clarification has no questions', () => {
    // Defensive — type=clarification but questions absent → generic agent path.
    const empty: ConversationMessage = {
      role: 'scribe',
      type: 'clarification',
      content: 'no questions yet',
      timestamp: '2026-05-09T12:02:30Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([empty]);
    expect(msgs[0]).toMatchObject({ type: 'agent', agent: 'scribe' });
  });

  it('emits a trace test_result with full coverage matrix + covered/uncovered ids', () => {
    // Hits 96–122 — trace_result branch incl. coverageMatrix dedupe + filter.
    const traceMsg: ConversationMessage = {
      role: 'trace',
      type: 'trace_result',
      content: 'Trace done.',
      traceResult: {
        testCount: 4,
        passing: 3,
        failing: 1,
        coverage: '82',
        duration: '1.2s',
        testFiles: [
          { name: 'a.test.ts', path: 'src/a.test.ts', type: 'file', lines: 10 },
          // path missing → fall back to name (line 105 ?? branch)
          { name: 'b.test.ts', type: 'file', lines: 5 },
        ],
        traceability: [
          { criterionId: 'C1', testFile: 'a.test.ts', testName: 't1', coverage: 'full' },
          // Same criterion, different file → exercises the array-push path.
          { criterionId: 'C1', testFile: 'b.test.ts', testName: 't2', coverage: 'partial' },
          { criterionId: 'C2', testFile: 'c.test.ts', testName: 't3', coverage: 'none' },
        ],
      },
      timestamp: '2026-05-09T12:03:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([traceMsg]);
    expect(msgs).toHaveLength(1);
    const result = msgs[0] as unknown as {
      type: string;
      passed: number;
      failed: number;
      total: number;
      coverage: string;
      testFiles: Array<{ filePath: string; testCount: number }>;
      coverageMatrix: Record<string, string[]>;
      coveredCriteria: string[];
      uncoveredCriteria: string[];
    };
    expect(result.type).toBe('test_result');
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(4);
    expect(result.coverage).toBe('82');
    expect(result.testFiles).toEqual([
      { filePath: 'src/a.test.ts', testCount: 10 },
      { filePath: 'b.test.ts', testCount: 5 },
    ]);
    expect(result.coverageMatrix.C1.sort()).toEqual(['a.test.ts', 'b.test.ts']);
    expect(result.coveredCriteria).toEqual(['C1']);
    expect(result.uncoveredCriteria).toEqual(['C2']);
  });

  it('defaults trace counters when traceResult fields are missing', () => {
    // Each `?? 0 / ?? '0'` fallback (lines 100–103).
    const sparse: ConversationMessage = {
      role: 'trace',
      type: 'trace_result',
      content: '',
      traceResult: {
        testCount: undefined,
        passing: undefined,
        failing: undefined,
        coverage: undefined,
        duration: '0s',
        testFiles: [],
      },
      timestamp: '2026-05-09T12:03:30Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([sparse]);
    expect(msgs[0]).toMatchObject({
      type: 'test_result',
      passed: 0,
      failed: 0,
      total: 0,
      coverage: '0',
    });
  });

  it('falls back to a plain agent bubble when trace_result is missing the traceResult payload', () => {
    // m.type === 'trace_result' but m.traceResult absent → generic else branch.
    const m: ConversationMessage = {
      role: 'trace',
      type: 'trace_result',
      content: 'unexpectedly empty',
      timestamp: '2026-05-09T12:03:45Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    expect(msgs[0]).toMatchObject({ type: 'agent', agent: 'trace' });
  });

  it('emits a gherkin_spec bubble when trace returns BDD features and sums scenario counts', () => {
    // Hits 124–134 — the gherkinFeatures branch.
    const trace: ConversationMessage = {
      role: 'trace',
      type: 'trace_result',
      content: 'with gherkin',
      traceResult: {
        testCount: 2,
        passing: 2,
        failing: 0,
        coverage: '100',
        duration: '0.5s',
        testFiles: [],
        gherkinFeatures: [
          {
            featureName: 'Login',
            filePath: 'features/login.feature',
            content: 'Feature: Login',
            scenarioCount: 3,
            mappedCriteria: ['C1'],
          },
          {
            featureName: 'Signup',
            filePath: 'features/signup.feature',
            content: 'Feature: Signup',
            scenarioCount: 2,
            mappedCriteria: ['C2'],
          },
        ],
      },
      timestamp: '2026-05-09T12:04:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([trace]);
    // [test_result, gherkin_spec]
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({
      type: 'gherkin_spec',
      totalScenarios: 5,
    });
    expect((msgs[1] as unknown as { features: unknown[] }).features).toHaveLength(2);
  });

  it('skips the gherkin_spec bubble when no features are returned', () => {
    const trace: ConversationMessage = {
      role: 'trace',
      type: 'trace_result',
      content: '',
      traceResult: {
        testCount: 0,
        passing: 0,
        failing: 0,
        coverage: '0',
        duration: '0s',
        testFiles: [],
        gherkinFeatures: [],
      },
      timestamp: '2026-05-09T12:04:30Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([trace]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'test_result' });
  });

  it("'onaylandı' system message pushes a Scribe→Proto agent_started marker (line 175)", () => {
    // Critical regression check: after the user approves the spec, we synthesise
    // a "Proto started" marker so the timeline shows the handover, even before
    // the backend's first proto activity arrives.
    const reject: ConversationMessage = {
      role: 'system',
      type: 'message',
      content: 'Spec onaylandı, Proto başlıyor.',
      timestamp: '2026-05-09T12:05:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([specMsg(), reject]);
    // Order is: plan card, agent_started (started), info bubble.
    const started = msgs.find(
      (m) => m.type === 'agent_started' && (m as unknown as { agent: string }).agent === 'proto'
    );
    expect(started).toBeDefined();
    expect((started as unknown as { state: string }).state).toBe('started');
  });

  it('system approval/rejection messages do nothing when no spec has been seen yet', () => {
    // Branch where specSeen=false short-circuits the plan-status update.
    const sys: ConversationMessage = {
      role: 'system',
      type: 'message',
      content: 'Spec onaylandı.',
      timestamp: '2026-05-09T12:05:30Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([sys]);
    // Just the info bubble, no agent_started marker and no plan flip.
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'info' });
  });
});

describe('conversationToChatMessages — live narrator marker', () => {
  it('appends a Scribe running marker while the pipeline is in scribe_clarifying', () => {
    // currentStage maps to STAGE_NARRATOR.scribe_clarifying → running marker for scribe.
    const msgs = conversationToChatMessages([], 'scribe_clarifying');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      type: 'agent_started',
      agent: 'scribe',
      state: 'running',
      task: 'pipeline.activity.scribe.analyzing_questions',
    });
  });

  it('appends a Proto running marker for proto_building', () => {
    const msgs = conversationToChatMessages([], 'proto_building');
    expect(msgs[0]).toMatchObject({
      type: 'agent_started',
      agent: 'proto',
      state: 'running',
      task: 'pipeline.activity.proto.creating_scaffold',
    });
  });

  it('appends a Trace running marker for trace_testing', () => {
    const msgs = conversationToChatMessages([], 'trace_testing');
    expect(msgs[0]).toMatchObject({
      type: 'agent_started',
      agent: 'trace',
      state: 'running',
      task: 'pipeline.activity.trace.writing_scenarios',
    });
  });

  it('does NOT append a running marker for stages without a STAGE_NARRATOR entry', () => {
    // critic_reviewing_spec is not in STAGE_NARRATOR → narrator is undefined.
    const msgs = conversationToChatMessages([], 'critic_reviewing_spec');
    expect(msgs).toHaveLength(0);
  });

  it('skips the running marker if the same agent already has a started/running mark', () => {
    // First we feed a system "approved" so a Proto 'started' marker fires, then
    // request proto_building — the narrator append should be deduped because the
    // marker tracking is by agent identity.
    const approved: ConversationMessage = {
      role: 'system',
      type: 'message',
      content: 'Spec onaylandı.',
      timestamp: '2026-05-09T12:06:00Z',
    } as unknown as ConversationMessage;
    // Need a prior spec so the 'onaylandı' branch fires.
    const msgs = conversationToChatMessages([specMsg(), approved], 'proto_building');
    const protoMarkers = msgs.filter(
      (m) => m.type === 'agent_started' && (m as unknown as { agent: string }).agent === 'proto'
    );
    // Wave-1 dedup fix: the `started` marker from the system message marks
    // the agent as seen, so the live-stage `running` marker is dropped to
    // avoid rendering two identical "Ajan başlatıldı  Proto — …" rows.
    expect(protoMarkers.length).toBe(1);
    expect((protoMarkers[0] as unknown as { state: string }).state).toBe('started');
  });
});

describe('conversationToChatMessages — event-log entries (2026-05-22)', () => {
  it("proto_started ConversationMessage emits an agent_started ChatMessage for 'proto'", () => {
    const m: ConversationMessage = {
      role: 'system',
      type: 'proto_started',
      content: '',
      timestamp: '2026-05-22T10:00:00Z',
      iteration: 1,
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const started = msgs.find(
      (x) => x.type === 'agent_started' && (x as unknown as { agent: string }).agent === 'proto'
    );
    expect(started).toBeDefined();
    expect((started as unknown as { state: string }).state).toBe('started');
    // Should NOT also push an info bubble for the empty system content row.
    const info = msgs.find((x) => x.type === 'info');
    expect(info).toBeUndefined();
  });

  it("trace_started ConversationMessage emits an agent_started ChatMessage for 'trace'", () => {
    const m: ConversationMessage = {
      role: 'system',
      type: 'trace_started',
      content: '',
      timestamp: '2026-05-22T10:01:00Z',
      iteration: 1,
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const started = msgs.find(
      (x) => x.type === 'agent_started' && (x as unknown as { agent: string }).agent === 'trace'
    );
    expect(started).toBeDefined();
    expect((started as unknown as { state: string }).state).toBe('started');
  });

  it('trace_failed ConversationMessage emits a trace_failure ChatMessage with errorCode + recoveryAction', () => {
    const m: ConversationMessage = {
      role: 'system',
      type: 'trace_failed',
      content: 'Trace zaman aşımı',
      timestamp: '2026-05-22T10:02:00Z',
      iteration: 2,
      errorCode: 'PIPELINE_TIMEOUT',
      errorMessage: 'Trace zaman aşımına uğradı',
      recoveryAction: 'retry',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const failure = msgs.find((x) => x.type === 'trace_failure');
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({
      type: 'trace_failure',
      errorCode: 'PIPELINE_TIMEOUT',
      errorMessage: 'Trace zaman aşımına uğradı',
      recoveryAction: 'retry',
      iteration: 2,
      timestamp: '2026-05-22T10:02:00Z',
    });
  });

  it('two sequential proto_result ConversationMessages render with iteration metadata exposed', () => {
    const iter1: ConversationMessage = {
      role: 'proto',
      type: 'proto_result',
      content: 'İlk tur özetidir.',
      timestamp: '2026-05-22T10:10:00Z',
      iteration: 1,
      protoResult: {
        branch: 'main',
        repo: '',
        files: [],
        totalFiles: 5,
        totalLines: 100,
        summary: 'İlk tur özetidir.',
      },
    } as unknown as ConversationMessage;
    const iter2: ConversationMessage = {
      role: 'proto',
      type: 'proto_result',
      content: 'İkinci tur özetidir.',
      timestamp: '2026-05-22T10:20:00Z',
      iteration: 2,
      protoResult: {
        branch: 'main',
        repo: '',
        files: [],
        totalFiles: 7,
        totalLines: 140,
        summary: 'İkinci tur özetidir.',
      },
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([iter1, iter2]);
    const agentMsgs = msgs.filter(
      (m) => m.type === 'agent' && (m as unknown as { agent: string }).agent === 'proto'
    );
    expect(agentMsgs).toHaveLength(2);
    expect((agentMsgs[0] as unknown as { iteration?: number }).iteration).toBe(1);
    expect((agentMsgs[1] as unknown as { iteration?: number }).iteration).toBe(2);
  });

  it('trace_completed ConversationMessage carries iteration onto the test_result ChatMessage', () => {
    const m: ConversationMessage = {
      role: 'trace',
      type: 'trace_result',
      content: 'Test yazıldı',
      timestamp: '2026-05-22T10:30:00Z',
      iteration: 3,
      traceResult: {
        testCount: 8,
        passing: 8,
        failing: 0,
        coverage: '90%',
        duration: '',
        testFiles: [],
      },
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const result = msgs.find((x) => x.type === 'test_result');
    expect(result).toBeDefined();
    expect((result as unknown as { iteration?: number }).iteration).toBe(3);
  });
});

describe('specToUserFriendlyPlan (via conversationToChatMessages) — edge cases', () => {
  // The exported helper is consumed indirectly through the spec branch; we
  // smoke-test the corner cases on the rendered plan payload.

  it('uses iWant/soThat fallbacks when action/benefit are missing on a user story', () => {
    const altSpec = {
      title: 'Stok',
      problemStatement: 'desc',
      userStories: [
        {
          asA: 'kullanıcı',
          iWant: 'haber almak',
          soThat: 'erken aksiyon',
          acceptanceCriteria: [],
        },
      ],
    };
    const m: ConversationMessage = {
      role: 'scribe',
      type: 'spec',
      spec: altSpec as unknown as StructuredSpec,
      content: 'spec',
      timestamp: '2026-05-09T12:07:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const plan = msgs.find((x) => x.type === 'plan') as unknown as {
      plan: { features: Array<{ name: string; description: string }> };
    };
    expect(plan.plan.features[0].name).toBe('haber almak');
    expect(plan.plan.features[0].description).toBe('erken aksiyon');
  });

  it('falls back to empty strings when neither action nor iWant is provided', () => {
    const altSpec = {
      title: 'X',
      problemStatement: 'p',
      userStories: [
        {
          asA: 'user',
          acceptanceCriteria: [],
        },
      ],
    };
    const m: ConversationMessage = {
      role: 'scribe',
      type: 'spec',
      spec: altSpec as unknown as StructuredSpec,
      content: 'spec',
      timestamp: '2026-05-09T12:07:30Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const plan = msgs.find((x) => x.type === 'plan') as unknown as {
      plan: { features: Array<{ name: string; description: string }> };
    };
    expect(plan.plan.features[0]).toEqual({ name: '', description: '' });
  });

  it('flattens a {stack, integrations} technicalConstraints object into techChoices', () => {
    const altSpec = {
      title: 'Y',
      problemStatement: 'p',
      userStories: [],
      technicalConstraints: {
        stack: 'Next.js + Postgres',
        integrations: ['Stripe', 'Sendgrid'],
      },
    };
    const m: ConversationMessage = {
      role: 'scribe',
      type: 'spec',
      spec: altSpec as unknown as StructuredSpec,
      content: 'spec',
      timestamp: '2026-05-09T12:08:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const plan = msgs.find((x) => x.type === 'plan') as unknown as {
      plan: { techChoices: string[] };
    };
    expect(plan.plan.techChoices).toEqual(['Next.js + Postgres', 'Stripe', 'Sendgrid']);
  });

  it('passes through a string-array technicalConstraints unchanged', () => {
    const altSpec = {
      title: 'Z',
      problemStatement: 'p',
      userStories: [],
      technicalConstraints: ['React 19', 'Tailwind v4'],
    };
    const m: ConversationMessage = {
      role: 'scribe',
      type: 'spec',
      spec: altSpec as unknown as StructuredSpec,
      content: 'spec',
      timestamp: '2026-05-09T12:08:30Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const plan = msgs.find((x) => x.type === 'plan') as unknown as {
      plan: { techChoices: string[] };
    };
    expect(plan.plan.techChoices).toEqual(['React 19', 'Tailwind v4']);
  });

  it('defaults projectName to "Proje" when the spec has no title', () => {
    const altSpec = {
      problemStatement: 'p',
      userStories: [],
    };
    const m: ConversationMessage = {
      role: 'scribe',
      type: 'spec',
      spec: altSpec as unknown as StructuredSpec,
      content: '',
      timestamp: '2026-05-09T12:09:00Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([m]);
    const plan = msgs.find((x) => x.type === 'plan') as unknown as {
      plan: { projectName: string; estimatedFiles: number };
    };
    expect(plan.plan.projectName).toBe('Proje');
    // 0 stories → max(0*3, 5) = 5
    expect(plan.plan.estimatedFiles).toBe(5);
  });
});
