/**
 * Unified pipeline knowledge for downstream agents — combines patterns from:
 * - **Cursor-like**: one thread, full transcript + repo awareness
 * - **Claude-like**: clear sections, “contract” block first, explicit how-to-use instructions per role
 *
 * Bounded by character budget with **smart truncation** (preserves head + tail of transcript when needed).
 */
import type { RepoContext } from '../agents/repo-context/RepoContextTypes.js';
import type {
  PipelineState,
  ScribeMessageType,
  StructuredSpec,
} from './contracts/PipelineTypes.js';

const DEFAULT_MAX_CHARS = 32_000;
const MAX_FILE_TREE_CHARS = 12_000;
const SPEC_SNIPPET_CHARS = 800;
const PROBLEM_EXCERPT = 2_000;
/** When truncating transcript, keep start (context) and end (recent intent). */
const TRANSCRIPT_HEAD = 8_000;
const TRANSCRIPT_TAIL = 6_000;

export type UnifiedContextRole = 'proto' | 'trace' | 'generic';

export interface BuildUnifiedContextOptions {
  /** Downstream agent — adds role-specific instructions at the end. */
  role?: UnifiedContextRole;
  maxChars?: number;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

function truncateMiddle(s: string, keepHead: number, keepTail: number): string {
  if (s.length <= keepHead + keepTail + 80) return s;
  const head = s.slice(0, keepHead);
  const tail = s.slice(-keepTail);
  return `${head}\n\n[ … middle omitted (${s.length - keepHead - keepTail} chars) — recent content follows … ]\n\n${tail}`;
}

function roleInstructions(role: UnifiedContextRole): string {
  switch (role) {
    case 'proto':
      return [
        '## HOW TO USE THIS CONTEXT (Proto / scaffold)',
        '- **Approved specification** (if present) is the product contract — prefer it over informal chat when they conflict.',
        '- **Repository context** means you are extending an existing codebase: match stack, style, and file layout.',
        '- **Transcript** explains user intent and history; use it for nuance, not to override written acceptance criteria.',
        '',
      ].join('\n');
    case 'trace':
      return [
        '## HOW TO USE THIS CONTEXT (Trace / verification)',
        '- Map tests primarily to **acceptance criteria** in the approved specification.',
        '- **Transcript** and **user notes** capture emphasis (e.g. edge cases the user cares about).',
        '- **Repository / file tree** helps you place tests and imports correctly.',
        '',
      ].join('\n');
    default:
      return [
        '## HOW TO USE THIS CONTEXT',
        '- Prefer the **approved specification** over informal chat when they disagree.',
        '- Respect **repository** conventions when technical context is provided.',
        '',
      ].join('\n');
  }
}

/**
 * Short session header — orients the model before long transcript (Claude “project” style).
 * Returns empty string when there is nothing to add (avoid noise-only blocks).
 */
export function buildSessionBrief(pipeline: PipelineState): string {
  const bullets: string[] = [];

  if (pipeline.title?.trim()) {
    bullets.push(`- **Pipeline title:** ${pipeline.title.trim()}`);
  }

  if (pipeline.approvedSpec) {
    bullets.push(`- **Approved product:** ${pipeline.approvedSpec.title}`);
    bullets.push(
      `- **Problem (excerpt):** ${truncate(pipeline.approvedSpec.problemStatement, 500)}`
    );
  } else if (pipeline.scribeOutput?.spec?.title) {
    bullets.push(`- **Latest spec draft title:** ${pipeline.scribeOutput.spec.title}`);
  }

  const conv = pipeline.scribeConversation ?? [];
  const recentUser = [...conv]
    .reverse()
    .filter(
      (m): m is Extract<ScribeMessageType, { type: 'user_note' | 'user_answer' }> =>
        m.type === 'user_note' || m.type === 'user_answer'
    )
    .slice(0, 2);
  if (recentUser.length > 0) {
    bullets.push('- **Most recent user input:**');
    for (const m of recentUser.reverse()) {
      const label = m.type === 'user_note' ? 'note' : 'message';
      bullets.push(`  - (${label}) ${truncate(m.content.trim(), 400)}`);
    }
  }

  if (bullets.length === 0) return '';

  return ['## SESSION BRIEF', ...bullets, ''].join('\n');
}

/**
 * Canonical structured spec — highest signal for Proto/Trace (contract block).
 */
export function formatApprovedSpecificationBlock(spec: StructuredSpec): string {
  const ac = spec.acceptanceCriteria
    .map((c) => `- **${c.id}**: Given ${c.given} | When ${c.when} | Then ${c.then}`)
    .join('\n');

  const stories = spec.userStories
    .map((u) => `- ${u.persona}: ${u.action} → ${u.benefit}`)
    .join('\n');

  return [
    '## APPROVED SPECIFICATION (contract)',
    'If chat below disagrees with this block, **follow this block** unless the product explicitly defers.',
    '',
    `**Title:** ${spec.title}`,
    '',
    '**Problem statement:**',
    truncate(spec.problemStatement, PROBLEM_EXCERPT),
    '',
    '**User stories:**',
    stories || '_(none)_',
    '',
    '**Acceptance criteria:**',
    ac,
    '',
    '**Out of scope:**',
    spec.outOfScope.length ? spec.outOfScope.map((o) => `- ${o}`).join('\n') : '_(none)_',
    '',
    '**Technical constraints:**',
    `- Stack: ${spec.technicalConstraints.stack ?? '_(unspecified)_'}`,
    `- Integrations: ${spec.technicalConstraints.integrations?.join(', ') ?? '_(none)_'}`,
    '',
    '--- END APPROVED SPECIFICATION ---',
    '',
  ].join('\n');
}

function formatScribePlanHint(pipeline: PipelineState): string {
  const plan = pipeline.scribeOutput?.plan;
  if (!plan) return '';
  return [
    '## SCRIBE PLAN (reference)',
    `**Summary:** ${truncate(plan.summary, 600)}`,
    `**Requires tests:** ${plan.requiresTests ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}

/**
 * Human-readable transcript from persisted Scribe conversation (all message types).
 */
export function formatScribeConversationTranscript(messages: ScribeMessageType[]): string {
  if (!messages?.length) return '';

  const lines: string[] = ['## PIPELINE CHAT TRANSCRIPT (chronological)'];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const idx = i + 1;
    switch (m.type) {
      case 'user_idea':
        lines.push(`### [${idx}] User — initial idea\n${m.content.trim()}`);
        break;
      case 'user_answer':
        lines.push(`### [${idx}] User\n${m.content.trim()}`);
        break;
      case 'user_note':
        lines.push(
          `### [${idx}] User — note (post–Scribe phase; still binding intent)\n${m.content.trim()}`
        );
        break;
      case 'clarification': {
        const qs = m.content.questions.map((q) => `- [${q.id}] ${q.question}`).join('\n');
        lines.push(`### [${idx}] Assistant — clarification questions\n${qs}`);
        break;
      }
      case 'spec_draft': {
        const spec = m.content.spec;
        const raw = m.content.rawMarkdown?.trim() ?? '';
        lines.push(
          `### [${idx}] Assistant — spec draft\n**Title:** ${spec.title}\n\n**Problem:** ${truncate(spec.problemStatement, SPEC_SNIPPET_CHARS)}`
        );
        if (raw) lines.push(`\n**Raw excerpt:** ${truncate(raw, SPEC_SNIPPET_CHARS)}`);
        break;
      }
      case 'spec_approved':
        lines.push(
          `### [${idx}] Spec approved in UI\nTitle: ${m.content.title}; AC count: ${m.content.acceptanceCriteria?.length ?? 0}`
        );
        break;
      case 'spec_rejected':
        lines.push(`### [${idx}] User rejected spec\n${m.content.feedback.trim()}`);
        break;
      case 'user_feedback':
        // B5 — correction request issued at the push-confirm gate. Surface
        // it like a note so downstream agents see the intent.
        lines.push(
          `### [${idx}] User — correction request (push-confirm gate)\n${m.content.trim()}`
        );
        break;
      // Chat event-log types (proto_started, proto_completed, trace_started,
      // trace_completed, trace_failed) are system-level events, not conversation
      // turns. Skip them in transcript formatting.
      case 'proto_started':
      case 'proto_completed':
      case 'trace_started':
      case 'trace_completed':
      case 'trace_failed':
        break;
      default: {
        const _exhaustive: never = m;
        void _exhaustive;
      }
    }
    lines.push('');
  }

  lines.push('--- END TRANSCRIPT ---');
  return lines.join('\n');
}

function formatRepoContextBlock(repoCtx: RepoContext): string {
  const tree =
    repoCtx.fileTree.length > MAX_FILE_TREE_CHARS
      ? `${repoCtx.fileTree.slice(0, MAX_FILE_TREE_CHARS)}\n… [file tree truncated]`
      : repoCtx.fileTree;

  return [
    '## EXISTING REPOSITORY (GitHub analysis)',
    `**Repo:** ${repoCtx.owner}/${repoCtx.repo} @ \`${repoCtx.branch}\``,
    `**Tech stack:** ${repoCtx.techStack.join(', ')}`,
    '',
    '**Summary:**',
    repoCtx.summary,
    '',
    '**File tree:**',
    '```',
    tree,
    '```',
    '',
    '**Instruction:** Generate code that fits this **existing** codebase — conventions, paths, and patterns.',
    '',
  ].join('\n');
}

function formatProtoAndLinks(pipeline: PipelineState): string {
  const lines: string[] = [];
  const existing = pipeline.intermediateState?.existingRepo as
    | { owner: string; repo: string; branch: string }
    | undefined;
  if (existing) {
    lines.push(
      `- **Linked repo (start):** \`${existing.owner}/${existing.repo}\` @ \`${existing.branch}\``
    );
  }
  const po = pipeline.protoOutput;
  if (po) {
    lines.push(`- **Proto scaffold:** ${po.repoUrl} (branch \`${po.branch}\`)`);
  }
  if (lines.length === 0) return '';
  return ['## GITHUB LINKS', ...lines, ''].join('\n');
}

function assembleParts(parts: string[]): string {
  return parts.filter((p) => p.trim().length > 0).join('\n');
}

/**
 * Apply max length: shrink transcript middle first, then hard tail cut.
 */
function applyBudget(raw: string, maxChars: number): string {
  if (raw.length <= maxChars) return raw;

  const marker = '\n## PIPELINE CHAT TRANSCRIPT (chronological)';
  const idx = raw.indexOf(marker);
  if (idx !== -1) {
    const before = raw.slice(0, idx);
    let transcriptPart = raw.slice(idx);
    if (transcriptPart.length > TRANSCRIPT_HEAD + TRANSCRIPT_TAIL) {
      transcriptPart = truncateMiddle(transcriptPart, TRANSCRIPT_HEAD, TRANSCRIPT_TAIL);
    }
    const merged = before + transcriptPart;
    if (merged.length <= maxChars) return merged;
    raw = merged;
  }

  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n\n--- [CONTEXT TRUNCATED — increase budget or shorten pipeline] ---\n`;
}

/**
 * Full unified string for Proto/Trace `knowledgeContext`.
 */
export function buildUnifiedAgentKnowledgeContext(
  pipeline: PipelineState,
  options?: BuildUnifiedContextOptions
): string {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const role = options?.role ?? 'generic';

  const mainParts: string[] = [];

  const brief = buildSessionBrief(pipeline);
  if (brief.trim()) mainParts.push(brief);

  if (pipeline.approvedSpec) {
    mainParts.push(formatApprovedSpecificationBlock(pipeline.approvedSpec));
  }

  const planHint = formatScribePlanHint(pipeline);
  if (planHint) mainParts.push(planHint);

  const transcript = formatScribeConversationTranscript(pipeline.scribeConversation);
  if (transcript) mainParts.push(transcript);

  const att = pipeline.intermediateState?.attachmentContext as string | undefined;
  if (att?.trim()) {
    mainParts.push(
      `## USER ATTACHMENTS / UPLOADED TEXT\n\n${att.trim()}\n\n--- END ATTACHMENTS ---\n`
    );
  }

  if (pipeline.repoContext) {
    mainParts.push(formatRepoContextBlock(pipeline.repoContext));
  }

  const meta = formatProtoAndLinks(pipeline);
  if (meta) mainParts.push(meta);

  const body = assembleParts(mainParts);
  if (!body.trim()) return '';

  const roleBlock = roleInstructions(role);
  const reserved = roleBlock.length + 24;
  const bodyBudget = Math.max(0, maxChars - reserved);
  const bodyCapped = applyBudget(body, bodyBudget);
  return `${bodyCapped}\n\n${roleBlock}`;
}
