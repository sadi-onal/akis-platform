import type { ChatMessage } from '../types/chat';
import type { ConversationMessage, StructuredSpec } from '../types/workflow';
import type { UserFriendlyPlan } from '../types/plan';
import type { PipelineStage } from '../types/pipeline';

type NarratorAgent = 'scribe' | 'proto' | 'trace';

const STAGE_NARRATOR: Partial<Record<PipelineStage, { agent: NarratorAgent; taskKey: string }>> = {
  scribe_clarifying: { agent: 'scribe', taskKey: 'pipeline.activity.scribe.analyzing_questions' },
  scribe_generating: { agent: 'scribe', taskKey: 'pipeline.activity.scribe.writing_spec' },
  proto_building: { agent: 'proto', taskKey: 'pipeline.activity.proto.creating_scaffold' },
  trace_testing: { agent: 'trace', taskKey: 'pipeline.activity.trace.writing_scenarios' },
};

// Stages where the spec card is still pending the user's decision — Critic spec
// review is also pre-approval because the Critic may have signed off internally
// but the user hasn't pressed "Onayla" yet.
const PRE_APPROVAL_STAGES: PipelineStage[] = [
  'scribe_clarifying',
  'scribe_generating',
  'critic_reviewing_spec',
  'awaiting_approval',
];

export function specToUserFriendlyPlan(spec: StructuredSpec): UserFriendlyPlan {
  const tc = spec.technicalConstraints;
  let techChoices: string[] = [];
  if (Array.isArray(tc)) {
    techChoices = tc;
  } else if (tc && typeof tc === 'object') {
    if (tc.stack) techChoices.push(tc.stack);
    if (tc.integrations) techChoices.push(...tc.integrations);
  }

  return {
    projectName: spec.title ?? 'Proje',
    summary: spec.problemStatement,
    features: spec.userStories.map((s) => {
      const action = s.action || s.iWant || '';
      const benefit = s.benefit || s.soThat || '';
      return {
        name: action,
        description: benefit,
      };
    }),
    techChoices,
    estimatedFiles: Math.max((spec.userStories?.length ?? 1) * 3, 5),
    requiresTests: true,
  };
}

export function conversationToChatMessages(
  conv: ConversationMessage[],
  currentStage?: PipelineStage
): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  let specSeen = false;
  // Chat narrator (2026-05-23) — when the event-log already contains a
  // `scribe_completed` row, the rendered Scribe bubble embeds the plan card
  // (`embeddedPlan`) directly. Suppress the legacy standalone `'plan'`
  // ChatMessage in that case so the user doesn't see the same plan twice.
  // Older pipelines (without scribe_completed) keep the standalone fallback.
  const scribeCompletedExists = conv.some(
    (m) => (m as { type?: string }).type === 'scribe_completed'
  );
  // Track whether we've already emitted a marker for each agent in this render
  // so we don't duplicate when the conversation already contained a transition
  // signal (e.g. spec_approved → proto marker).
  const agentMarked = new Set<NarratorAgent>();
  // Default task keys when we don't know the exact sub-stage (e.g. transition
  // markers fired before backend activities arrive). AgentStartedLine renders
  // these via `t(task)` so EN locale gets English.
  const defaultTaskKey: Record<NarratorAgent, string> = {
    scribe: 'pipeline.activity.scribe.writing_spec',
    proto: 'pipeline.activity.proto.creating_scaffold',
    trace: 'pipeline.activity.trace.writing_scenarios',
  };
  const pushAgentStarted = (
    agent: NarratorAgent,
    state: 'started' | 'running' | 'completed',
    timestamp: string,
    taskKey?: string
  ) => {
    // PR-F1 (2026-05-19): Defensive — modern stack pattern says Critic
    // guardrail runs in the background; users do not see "Critic started"
    // rows in the chat timeline. The NarratorAgent type already restricts
    // the agent to scribe/proto/trace, but we add a runtime guard so future
    // refactors (e.g. someone widening NarratorAgent) don't silently leak
    // Critic markers into the chat.
    if ((agent as string) === 'critic') return;
    // De-dup across BOTH `started` and `running` — earlier the set only
    // tracked `running`, so a `started` marker (emitted on a spec-approved
    // system message) plus the live-stage `running` marker rendered TWO
    // identical "Ajan başlatıldı  Proto — İskelet üretiliyor" rows in the
    // chat thread. Treat the first emission for an agent as canonical.
    if (state !== 'completed' && agentMarked.has(agent)) return;
    if (state !== 'completed') agentMarked.add(agent);
    msgs.push({
      type: 'agent_started',
      agent,
      task: taskKey ?? defaultTaskKey[agent],
      state,
      timestamp,
    });
  };

  for (const m of conv) {
    const ts = m.timestamp ?? new Date().toISOString();
    switch (m.role) {
      case 'user':
        msgs.push({ type: 'user', content: m.content, timestamp: ts });
        break;
      case 'scribe':
      case 'proto':
      case 'trace':
        // Chat narrator (2026-05-23) — `scribe_completed` row builds a Scribe
        // agent bubble with embedded plan, summary, sub-steps, and a
        // server-truth `durationMs`. Handled ahead of the legacy spec /
        // clarification / trace_result branches because its `role` is
        // 'scribe' but its `type` doesn't match any of them.
        if (m.type === 'scribe_completed') {
          msgs.push({
            type: 'agent',
            agent: 'scribe',
            content: m.summary ?? m.content ?? 'Plan hazırlandı.',
            timestamp: ts,
            ...(m.summary ? { summary: m.summary } : {}),
            ...(m.iteration !== undefined ? { iteration: m.iteration } : {}),
            ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
            ...(m.subSteps && m.subSteps.length > 0 ? { subSteps: m.subSteps } : {}),
            ...(m.embeddedPlan ? { embeddedPlan: m.embeddedPlan } : {}),
          } as ChatMessage);
          break;
        }
        if (m.type === 'trace_result' && m.traceResult) {
          const tr = m.traceResult;
          msgs.push({
            type: 'test_result',
            passed: tr.passing ?? 0,
            failed: tr.failing ?? 0,
            total: tr.testCount ?? 0,
            coverage: tr.coverage ?? '0',
            testFiles: tr.testFiles?.map((f) => ({
              filePath: f.path ?? f.name,
              testCount: f.lines ?? 0,
            })),
            coverageMatrix: tr.traceability?.reduce<Record<string, string[]>>((acc, t) => {
              if (!acc[t.criterionId]) acc[t.criterionId] = [];
              acc[t.criterionId].push(t.testFile);
              return acc;
            }, {}),
            coveredCriteria: tr.traceability
              ?.filter((t) => t.coverage !== 'none')
              .map((t) => t.criterionId)
              .filter((v, i, a) => a.indexOf(v) === i),
            uncoveredCriteria: tr.traceability
              ?.filter((t) => t.coverage === 'none')
              .map((t) => t.criterionId)
              .filter((v, i, a) => a.indexOf(v) === i),
            timestamp: ts,
            // Chat event-log (2026-05-22) — expose iteration when the message
            // originated from a `trace_completed` event so the UI can show
            // "İterasyon N" badges. Snapshot-derived messages omit this.
            ...(m.iteration !== undefined ? { iteration: m.iteration } : {}),
            // Chat narrator (2026-05-23) — LLM Türkçe summary + server-truth
            // duration + collapsed sub-step disclosure (includes Critic +
            // Validator entries tagged via `source`). All optional — older
            // pipelines (snapshot-derived rows) omit them and the renderer
            // falls back to the numeric pass/fail/coverage block.
            ...(m.summary ? { summary: m.summary } : {}),
            ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
            ...(m.subSteps && m.subSteps.length > 0 ? { subSteps: m.subSteps } : {}),
          });
          // Append BDD/Gherkin spec message if features were generated
          if (tr.gherkinFeatures?.length) {
            msgs.push({
              type: 'gherkin_spec',
              features: tr.gherkinFeatures,
              totalScenarios: tr.gherkinFeatures.reduce(
                (sum: number, f: { scenarioCount: number }) => sum + f.scenarioCount,
                0
              ),
              timestamp: ts,
            });
          }
        } else if (m.type === 'clarification' && m.questions?.length) {
          msgs.push({
            type: 'clarification',
            role: m.role,
            content: m.content,
            questions: m.questions,
            timestamp: ts,
          });
        } else if (m.type === 'spec' && m.spec) {
          specSeen = true;
          // Chat narrator (2026-05-23) — when the conversation also contains
          // a `scribe_completed` event, the rendered Scribe bubble embeds the
          // plan card (DL-7). Suppress the standalone plan ChatMessage so the
          // user doesn't see the same plan twice. Older pipelines (without
          // `scribe_completed`) keep the snapshot-derived fallback.
          if (scribeCompletedExists) {
            break;
          }
          const plan = specToUserFriendlyPlan(m.spec);
          let planStatus: 'active' | 'approved' | 'rejected' | 'edited' | 'reviewing' = 'active';
          if (currentStage && !PRE_APPROVAL_STAGES.includes(currentStage)) {
            planStatus = 'approved';
          } else if (currentStage === 'critic_reviewing_spec') {
            planStatus = 'reviewing';
          } else if (
            currentStage &&
            currentStage !== 'awaiting_approval' &&
            currentStage !== 'awaiting_critic_resolution'
          ) {
            planStatus = 'edited';
          }
          msgs.push({
            type: 'plan',
            plan,
            version: 1,
            status: planStatus,
            spec: m.spec,
            // PR-V6 — surface Scribe's assumption list through to PlanCard
            // so the user can expand it as a disclosure beneath the plan.
            assumptions: m.assumptions,
            timestamp: ts,
          });
        } else {
          // Proto F-6 (2026-05-22): when this is a Proto stage `proto_result`
          // message, thread the human-language `summary` and metadata fields
          // through to the agent ChatMessage so the renderer can lead with the
          // narration and demote the file/line counts to a secondary line.
          // Non-Proto rows (Scribe message, Trace progress narration) leave
          // these undefined and render via the legacy content-only path.
          const isProtoResult = m.role === 'proto' && m.type === 'proto_result' && !!m.protoResult;
          const protoFields = isProtoResult
            ? {
                ...(m.protoResult?.summary ? { summary: m.protoResult.summary } : {}),
                ...(m.protoResult?.totalFiles !== undefined
                  ? { totalFiles: m.protoResult.totalFiles }
                  : {}),
                ...(m.protoResult?.totalLines !== undefined
                  ? { totalLines: m.protoResult.totalLines }
                  : {}),
                ...(m.protoResult?.branch ? { branch: m.protoResult.branch } : {}),
                // Chat narrator (2026-05-23) — server-truth duration + sub-step
                // disclosure piggyback on the event-log payload. Older
                // pipelines (snapshot fallback) omit them; renderer treats
                // the absent state as "skip the footer / disclosure".
                ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
                ...(m.subSteps && m.subSteps.length > 0 ? { subSteps: m.subSteps } : {}),
              }
            : {};
          msgs.push({
            type: 'agent',
            agent: m.role,
            content: m.content,
            timestamp: ts,
            // Chat event-log (2026-05-22) — surface iteration on event-log-derived
            // proto_result / trace_result rows so each tour renders as a distinct
            // identifiable bubble instead of looking like duplicate text.
            ...(m.iteration !== undefined ? { iteration: m.iteration } : {}),
            ...protoFields,
          });
        }
        break;
      case 'system':
        // Chat event-log (2026-05-22) — typed system rows from the orchestrator's
        // event log. Handle these first so they don't fall through to the legacy
        // info-bubble + approval-string-match path.
        if (m.type === 'proto_started') {
          // pushAgentStarted's `agentMarked` set dedups against earlier system
          // 'onaylandı' markers; that's intentional for the FIRST iteration
          // (we don't want two "Proto başlatıldı" rows back-to-back). Iteration
          // 2+ would dedup too — but the iteration column on the proto_result
          // bubble already surfaces the new tour, so a second start marker is
          // not required for the timeline to read correctly.
          pushAgentStarted('proto', 'started', ts);
          break;
        }
        if (m.type === 'trace_started') {
          pushAgentStarted('trace', 'started', ts);
          break;
        }
        if (m.type === 'trace_failed') {
          msgs.push({
            type: 'trace_failure',
            errorCode: m.errorCode ?? 'UNKNOWN',
            errorMessage: m.errorMessage ?? m.content,
            ...(m.recoveryAction !== undefined ? { recoveryAction: m.recoveryAction } : {}),
            ...(m.iteration !== undefined ? { iteration: m.iteration } : {}),
            timestamp: ts,
          });
          break;
        }
        // Check if system message indicates approval/rejection and update last plan
        if (specSeen && (m.content.includes('onaylandı') || m.content.includes('reddedildi'))) {
          for (let j = msgs.length - 1; j >= 0; j--) {
            if (msgs[j].type === 'plan') {
              (msgs[j] as { status: string }).status = m.content.includes('onaylandı')
                ? 'approved'
                : 'rejected';
              break;
            }
          }
          // Scribe → Proto transition marker when user approved the spec.
          if (m.content.includes('onaylandı')) {
            pushAgentStarted('proto', 'started', ts);
            // #639: spec-approved info pill removed from the scrollable chat
            // timeline. The approval signal is now rendered as a fixed chip
            // in PipelineDetailRail (above the chat scroll container) so it
            // stays visible regardless of how many Proto iterations follow.
            break;
          }
        }
        msgs.push({ type: 'info', content: m.content, timestamp: ts });
        break;
    }
  }

  // Append a live "running" marker for the currently-active agent so users
  // see a Claude-Code-style status line while the pipeline progresses.
  const narrator = currentStage ? STAGE_NARRATOR[currentStage] : undefined;
  if (narrator && !agentMarked.has(narrator.agent)) {
    pushAgentStarted(narrator.agent, 'running', new Date().toISOString(), narrator.taskKey);
  }

  // Chat narrator (2026-05-23, F-6) — stable timestamp sort so out-of-order
  // event-log entries (system chips inserted mid-stream, late-arriving
  // proto_completed) render in chronological order. JS Array.sort is stable
  // (ES2019+) so ties keep their original push order. Pre-compute timestamps
  // to avoid O(n log n) Date allocations inside the comparator.
  const tsMap = new Map<(typeof msgs)[number], number>();
  for (const msg of msgs) {
    const raw = (msg as { timestamp: string }).timestamp;
    const t = raw ? new Date(raw).getTime() : 0;
    tsMap.set(msg, Number.isFinite(t) ? t : 0);
  }
  msgs.sort((a, b) => (tsMap.get(a) ?? 0) - (tsMap.get(b) ?? 0));

  return msgs;
}
