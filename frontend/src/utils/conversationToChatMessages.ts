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
          const plan = specToUserFriendlyPlan(m.spec);
          let planStatus: 'active' | 'approved' | 'rejected' = 'active';
          if (currentStage && !PRE_APPROVAL_STAGES.includes(currentStage)) {
            planStatus = 'approved';
          }
          msgs.push({
            type: 'plan',
            plan,
            version: 1,
            status: planStatus,
            spec: m.spec,
            timestamp: ts,
          });
        } else {
          msgs.push({ type: 'agent', agent: m.role, content: m.content, timestamp: ts });
        }
        break;
      case 'system':
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

  return msgs;
}
