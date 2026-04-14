import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Workflow, ConversationMessage, StructuredSpec } from '../../types/workflow';
import type { PipelineActivity } from '../../hooks/usePipelineStream';
import { SuggestionWizard } from './SuggestionWizard';
import { formatConfidence } from '../../utils/format';
import { TR } from '../../constants/tr';

// ═══ Agent Colors ═══
const AGENT_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  scribe: { bg: 'bg-ak-scribe/10', border: 'border-ak-scribe/30', text: 'text-ak-scribe', label: 'S' },
  proto:  { bg: 'bg-ak-proto/10',  border: 'border-ak-proto/30',  text: 'text-ak-proto',  label: 'P' },
  trace:  { bg: 'bg-ak-trace/10',  border: 'border-ak-trace/30',  text: 'text-ak-trace',  label: 'T' },
  system: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', label: '⚙' },
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: 'bg-red-500/20 text-red-400 border-red-500/30',
  P1: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  P2: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
};

// ═══ Props ═══
interface WorkflowChatViewProps {
  workflow: Workflow;
  onSendMessage: (message: string) => void;
  onApprove: (repoName: string, repoVisibility?: 'public' | 'private') => void;
  onReject?: (feedback?: string) => void;
  onRetry?: () => void;
  onOpenPreview?: () => void;
  onOpenFiles?: () => void;
  /** Real-time SSE activities from usePipelineStream */
  sseActivities?: PipelineActivity[];
  /** Whether SSE connection is active */
  sseConnected?: boolean;
  /** Progress percentage per stage from SSE */
  sseProgressByStage?: Record<string, number>;
}

// ═══ Helpers ═══

// displayConfidence is now imported from utils/format as formatConfidence

// ═══ Sub-Components ═══

function AgentAvatar({ role }: { role: string }) {
  const colors = AGENT_COLORS[role] || AGENT_COLORS.system;
  return (
    <div
      className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border text-xs font-bold ${colors.bg} ${colors.border} ${colors.text}`}
    >
      {colors.label}
    </div>
  );
}

function ClarificationBlock({ message }: { message: ConversationMessage }) {
  const questions = message.questions || [];
  if (questions.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {questions.map((q, i) => (
        <div
          key={q.id || i}
          className="rounded-lg border border-ak-scribe/20 bg-ak-scribe/5 p-3"
        >
          <div className="flex items-start gap-2">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-ak-scribe/20 text-[10px] font-bold text-ak-scribe">
              {i + 1}
            </span>
            <div className="flex-1 space-y-1">
              <p className="text-sm text-ak-text-primary">{q.question}</p>
              {q.reason && (
                <p className="text-xs text-ak-text-tertiary">{q.reason}</p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══ Spec Markdown helpers ═══
function specToMarkdown(spec: StructuredSpec): string {
  let md = `# ${spec.title || 'Structured Spec'}\n\n`;
  if (spec.problemStatement) {
    md += '## Problem Statement\n\n';
    md += spec.problemStatement + '\n\n';
  }
  const stories = spec.userStories || [];
  if (stories.length > 0) {
    md += '## User Stories\n\n';
    stories.forEach((s, i) => {
      const priority = s.priority ? ` [${s.priority}]` : '';
      md += `${i + 1}.${priority} **As** ${s.persona || s.as}, **I want** ${s.action || s.iWant}, **so that** ${s.benefit || s.soThat}\n`;
    });
    md += '\n';
  }
  const criteria = spec.acceptanceCriteria || [];
  if (criteria.length > 0) {
    md += '## Acceptance Criteria\n\n';
    criteria.forEach((c, i) => {
      const id = c.id || `AC-${i + 1}`;
      md += `### ${id}${c.summary ? `: ${c.summary}` : ''}\n`;
      md += `- **Given** ${c.given}\n`;
      md += `- **When** ${c.when}\n`;
      md += `- **Then** ${c.then}\n\n`;
    });
  }
  const constraints = spec.technicalConstraints;
  if (constraints) {
    md += '## Technical Constraints\n\n';
    if (Array.isArray(constraints)) {
      constraints.forEach(t => { md += `- ${t}\n`; });
    } else {
      if (constraints.stack) md += `- Stack: ${constraints.stack}\n`;
      (constraints.integrations || []).forEach(t => { md += `- ${t}\n`; });
      (constraints.nonFunctional || []).forEach(t => { md += `- ${t}\n`; });
    }
    md += '\n';
  }
  const outOfScope = spec.outOfScope || [];
  if (outOfScope.length > 0) {
    md += '## Out of Scope\n\n';
    outOfScope.forEach(t => { md += `- ~~${t}~~\n`; });
  }
  return md;
}

function downloadSpec(spec: StructuredSpec) {
  const md = specToMarkdown(spec);
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(spec.title || 'spec').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function SpecBlock({
  spec,
  confidence,
  reviewNotes,
  assumptions,
  onApprove,
  onReject,
  showActions,
}: {
  spec: StructuredSpec;
  confidence?: number;
  reviewNotes?: string | { selfReviewPassed?: boolean; revisionsApplied?: string[]; assumptionsMade?: string[] };
  assumptions?: string[];
  onApprove: (repoName: string, repoVisibility?: 'public' | 'private') => void;
  onReject?: (feedback?: string) => void;
  showActions: boolean;
}) {
  const [expandedAC, setExpandedAC] = useState<Set<number>>(new Set());
  const [specView, setSpecView] = useState<'preview' | 'markdown'>('preview');
  const [copied, setCopied] = useState(false);
  // Spec starts collapsed — show summary line only; click to expand
  const [specExpanded, setSpecExpanded] = useState(false);
  // Auto-derive repo name from spec title
  const repoName = (spec.title || 'my-app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const repoVisibility: 'public' | 'private' = 'private';
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const [approving, setApproving] = useState(false);
  const stories = spec.userStories || [];
  const criteria = spec.acceptanceCriteria || [];
  const constraints = spec.technicalConstraints;
  const outOfScope = spec.outOfScope || [];

  const toggleAC = (idx: number) => {
    setExpandedAC(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(specToMarkdown(spec));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard not available */ }
  };

  return (
    <div className="mt-2 rounded-xl border border-ak-border bg-white">
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setSpecExpanded(!specExpanded)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left transition-colors hover:bg-gray-50"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`h-3 w-3 flex-shrink-0 text-ak-text-tertiary transition-transform ${specExpanded ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-ak-text-tertiary">
            {TR.structuredSpec}
          </span>
          {confidence != null && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600">
              {formatConfidence(confidence)}
            </span>
          )}
          {typeof reviewNotes === 'object' && reviewNotes?.selfReviewPassed && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
              ✓ Self-review
            </span>
          )}
          {assumptions && assumptions.length > 0 && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-600">
              ⚠ {assumptions.length} varsayım
            </span>
          )}
        </div>
        <span className="text-[11px] text-ak-text-tertiary">
          {stories.length} Hikaye · {criteria.length} Kriter · {Array.isArray(constraints) ? constraints.length : (constraints ? 1 : 0)} Kisit
        </span>
      </button>

      {/* Expanded content */}
      {specExpanded && (
        <div className="space-y-3 border-t border-ak-border px-4 pb-4 pt-3">
          {/* Verification badges */}
          {(assumptions?.length || (typeof reviewNotes === 'object' && reviewNotes?.revisionsApplied?.length)) && (
            <div className="space-y-2">
              {assumptions && assumptions.length > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                  <p className="text-[11px] font-semibold text-amber-400">⚠ Varsayımlar</p>
                  <ul className="mt-1 space-y-0.5">
                    {assumptions.map((a, i) => (
                      <li key={i} className="text-[11px] text-amber-300/80">• {a}</li>
                    ))}
                  </ul>
                </div>
              )}
              {typeof reviewNotes === 'object' && reviewNotes?.revisionsApplied && reviewNotes.revisionsApplied.length > 0 && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <p className="text-[11px] font-semibold text-emerald-400">✓ Self-Review Düzeltmeleri</p>
                  <ul className="mt-1 space-y-0.5">
                    {reviewNotes.revisionsApplied.map((r, i) => (
                      <li key={i} className="text-[11px] text-emerald-300/80">• {r}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {/* Toolbar */}
          <div className="flex items-center justify-end gap-1">
            <div className="flex rounded-md border border-ak-border bg-ak-surface-2 p-0.5">
              <button
                onClick={() => setSpecView('preview')}
                className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${specView === 'preview' ? 'bg-emerald-50 text-ak-primary' : 'text-ak-text-tertiary hover:text-ak-text-secondary'}`}
              >
                {TR.preview}
              </button>
              <button
                onClick={() => setSpecView('markdown')}
                className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${specView === 'markdown' ? 'bg-emerald-50 text-ak-primary' : 'text-ak-text-tertiary hover:text-ak-text-secondary'}`}
              >
                Markdown
              </button>
            </div>
            <button onClick={handleCopy} title="Markdown olarak kopyala" className="rounded-md p-1 text-ak-text-tertiary transition-colors hover:bg-ak-hover hover:text-ak-text-secondary">
              {copied ? (
                <svg className="h-3.5 w-3.5 text-ak-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
              ) : (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>
              )}
            </button>
            <button onClick={() => downloadSpec(spec)} title="Download as .md" className="rounded-md p-1 text-ak-text-tertiary transition-colors hover:bg-ak-hover hover:text-ak-text-secondary">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
            </button>
          </div>

      {/* Markdown raw view */}
      {specView === 'markdown' && (
        <pre className="max-h-80 overflow-auto rounded-lg bg-ak-surface-2 p-3 font-mono text-xs leading-relaxed text-ak-text-primary whitespace-pre-wrap">
          {specToMarkdown(spec)}
        </pre>
      )}

      {/* Preview view — Problem Statement */}
      {specView === 'preview' && spec.problemStatement && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-emerald-400">{TR.problemStatement}</h4>
          <div className="rounded-lg bg-ak-surface-2 p-3 text-sm leading-relaxed text-ak-text-primary">
            {spec.problemStatement}
          </div>
        </div>
      )}

      {/* User Stories */}
      {specView === 'preview' && stories.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-emerald-400">
            {TR.userStories} ({stories.length})
          </h4>
          <div className="space-y-1.5">
            {stories.map((story, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-lg border border-ak-border-subtle bg-ak-surface-2 p-2.5 text-sm"
              >
                {story.priority && (
                  <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold ${PRIORITY_COLORS[story.priority] || PRIORITY_COLORS.P2}`}>
                    {story.priority}
                  </span>
                )}
                <span className="text-ak-text-primary">
                  <span className="text-ak-text-tertiary">As </span>
                  <span className="font-medium">{story.persona || story.as}</span>
                  <span className="text-ak-text-tertiary">, I want </span>
                  <span className="font-medium">{story.action || story.iWant}</span>
                  <span className="text-ak-text-tertiary">, so that </span>
                  <span className="font-medium">{story.benefit || story.soThat}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Acceptance Criteria — Collapsible */}
      {specView === 'preview' && criteria.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-emerald-400">
            {TR.acceptanceCriteria} ({criteria.length})
          </h4>
          <div className="space-y-1">
            {criteria.map((ac, i) => {
              const isOpen = expandedAC.has(i);
              const acId = ac.id || `AC-${i + 1}`;
              const summary = ac.summary || `${ac.given.slice(0, 50)}...`;

              return (
                <div key={i} className="rounded-lg border border-ak-border-subtle bg-ak-surface-2">
                  <button
                    onClick={() => toggleAC(i)}
                    className="flex w-full items-center gap-2 p-2.5 text-left text-sm hover:bg-ak-hover transition-colors"
                  >
                    <svg
                      className={`h-3 w-3 flex-shrink-0 text-ak-text-tertiary transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                    <span className="font-mono text-[11px] font-bold text-ak-text-tertiary">{acId}</span>
                    <span className="text-ak-text-primary">{summary}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-ak-border-subtle px-3 pb-3 pt-2 text-sm">
                      <p><span className="font-semibold text-ak-text-tertiary">GIVEN </span><span className="text-ak-text-primary">{ac.given}</span></p>
                      <p><span className="font-semibold text-ak-text-tertiary">WHEN </span><span className="text-ak-text-primary">{ac.when}</span></p>
                      <p><span className="font-semibold text-ak-text-tertiary">THEN </span><span className="text-ak-text-primary">{ac.then}</span></p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Technical Constraints */}
      {specView === 'preview' && constraints && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-emerald-400">{TR.technicalConstraints}</h4>
          <div className="rounded-lg bg-ak-surface-2 p-2.5 text-sm text-ak-text-secondary">
            {Array.isArray(constraints)
              ? constraints.join(', ')
              : [constraints.stack, ...(constraints.integrations || []), ...(constraints.nonFunctional || [])].filter(Boolean).join(', ')
            }
          </div>
        </div>
      )}

      {/* Out of Scope */}
      {specView === 'preview' && outOfScope.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-emerald-400">{TR.outOfScope}</h4>
          <div className="flex flex-wrap gap-1.5">
            {outOfScope.map((item, i) => (
              <span key={i} className="rounded-md bg-red-500/10 px-2 py-0.5 text-xs text-red-400 line-through">
                {item}
              </span>
            ))}
          </div>
        </div>
      )}
        </div>
      )}

      {/* Approve / Reject actions — always visible when applicable */}
      {showActions && (
        <div className="space-y-3 border-t border-ak-border-subtle px-4 pb-4 pt-3">
          {/* Action buttons — repo name auto-derived from spec title */}
          <div className="flex gap-2">
            <button
              onClick={async () => {
                if (!repoName.trim()) return;
                setApproving(true);
                try { onApprove(repoName.trim(), repoVisibility); }
                finally { setApproving(false); }
              }}
              disabled={!repoName.trim() || approving}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {approving ? TR.approvingLabel : `✓ ${TR.approveAndContinue}`}
            </button>
            {onReject && !showRejectForm && (
              <button
                onClick={() => setShowRejectForm(true)}
                className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
              >
                {TR.reject}
              </button>
            )}
          </div>

          {/* Reject feedback form */}
          {showRejectForm && onReject && (
            <div className="space-y-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
              <textarea
                value={rejectFeedback}
                onChange={(e) => setRejectFeedback(e.target.value)}
                placeholder={TR.rejectReason}
                rows={2}
                className="w-full resize-none rounded-lg border border-red-500/20 bg-ak-surface-2 px-3 py-2 text-sm text-ak-text-primary placeholder:text-ak-text-tertiary focus:border-red-400 focus:outline-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { onReject(rejectFeedback || undefined); setShowRejectForm(false); }}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-600"
                >
                  {TR.reject}
                </button>
                <button
                  onClick={() => { setShowRejectForm(false); setRejectFeedback(''); }}
                  className="rounded-lg border border-ak-border px-3 py-1.5 text-sm text-ak-text-secondary transition-colors hover:bg-ak-hover"
                >
                  {TR.cancel}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProtoResultBlock({ message }: { message: ConversationMessage }) {
  const r = message.protoResult;
  if (!r) return null;
  const githubUrl = r.repo ? `https://github.com/${r.repo}/tree/${r.branch}` : null;
  const vr = r.verificationReport;
  return (
    <div className="mt-2 space-y-2">
      <div className="rounded-lg border border-ak-proto/20 bg-ak-proto/5 p-3 text-sm">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-lg font-bold text-ak-proto">{r.totalFiles}</p>
            <p className="text-[11px] text-ak-text-tertiary">{TR.filesLabel}</p>
          </div>
          <div>
            <p className="text-lg font-bold text-ak-proto">{r.totalLines}</p>
            <p className="text-[11px] text-ak-text-tertiary">{TR.linesLabel}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <code className="rounded bg-ak-surface-2 px-2 py-0.5 font-mono text-xs text-ak-proto">⑂ {r.branch}</code>
            {githubUrl && (
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-md border border-ak-proto/20 bg-ak-surface-2 px-2 py-0.5 text-[11px] text-ak-proto transition-colors hover:bg-ak-proto/10"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                GitHub
              </a>
            )}
          </div>
        </div>
      </div>
      {vr && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="rounded-full bg-ak-proto/10 px-2 py-0.5 font-medium text-ak-proto">
            ✓ Spec: {vr.specCoverage}
          </span>
          {vr.integrityIssues.length === 0 ? (
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400">
              ✓ Sorun yok
            </span>
          ) : (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-400">
              ⚠ {vr.integrityIssues.length} sorun
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TraceResultBlock({ message, workflow }: { message: ConversationMessage; workflow: Workflow }) {
  const [showMatrix, setShowMatrix] = useState(false);
  const r = message.traceResult;
  if (!r) return null;
  const protoMsg = workflow.conversation?.find(m => m.type === 'proto_result');
  const repo = protoMsg?.protoResult?.repo;
  const traceBranch = workflow.stages.proto.branch;
  const githubUrl = repo && traceBranch ? `https://github.com/${repo}/tree/${traceBranch}` : null;
  return (
    <div className="mt-2 space-y-2">
      <div className="rounded-lg border border-ak-trace/20 bg-ak-trace/5 p-3 text-sm">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-lg font-bold text-ak-trace">{r.testCount}</p>
            <p className="text-[11px] text-ak-text-tertiary">{TR.testsLabel}</p>
          </div>
          <div>
            <p className="text-lg font-bold text-ak-trace">{r.coverage}</p>
            <p className="text-[11px] text-ak-text-tertiary">{TR.coverageLabel}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {r.traceability && r.traceability.length > 0 && (
              <button
                onClick={() => setShowMatrix(!showMatrix)}
                className="rounded-md border border-ak-trace/20 bg-ak-surface-2 px-2 py-0.5 text-[11px] text-ak-trace transition-colors hover:bg-ak-trace/10"
              >
                {showMatrix ? 'Gizle' : 'Matris'}
              </button>
            )}
            {githubUrl && (
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-md border border-ak-trace/20 bg-ak-surface-2 px-2 py-0.5 text-[11px] text-ak-trace transition-colors hover:bg-ak-trace/10"
              >
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                GitHub
              </a>
            )}
          </div>
        </div>
      </div>
      {showMatrix && r.traceability && (
        <div className="rounded-lg border border-ak-trace/20 bg-ak-surface p-3">
          <p className="mb-2 text-[11px] font-semibold text-ak-trace">İzlenebilirlik Matrisi</p>
          <div className="space-y-1">
            {r.traceability.map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className={`w-4 text-center ${t.coverage === 'full' ? 'text-emerald-400' : t.coverage === 'partial' ? 'text-amber-400' : 'text-red-400'}`}>
                  {t.coverage === 'full' ? '✓' : t.coverage === 'partial' ? '◐' : '✗'}
                </span>
                <code className="rounded bg-ak-surface-2 px-1 py-0.5 font-mono text-ak-text-tertiary">{t.criterionId}</code>
                <span className="text-ak-text-secondary">{t.testName}</span>
                <span className="ml-auto font-mono text-ak-text-tertiary">{t.testFile.split('/').pop()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChatMessage({
  message,
  workflow,
  onApprove,
  onReject,
  wizardActive,
}: {
  message: ConversationMessage;
  workflow: Workflow;
  onApprove: (repoName: string, repoVisibility?: 'public' | 'private') => void;
  onReject?: (feedback?: string) => void;
  wizardActive?: boolean;
}) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const showApproveActions = message.type === 'spec' && workflow.status === 'awaiting_approval';

  // System messages — centered pill
  if (isSystem) {
    return (
      <div className="flex justify-center py-1">
        <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 text-xs text-emerald-400">
          {message.content}
        </span>
      </div>
    );
  }

  // User messages — right-aligned with bubble
  if (isUser) {
    return (
      <div className="flex justify-end mb-1">
        <div
          className="max-w-[85%] rounded-2xl px-4 py-2.5"
          style={{ backgroundColor: 'var(--ak-bg-bubble-user)' }}
        >
          <p className="text-sm text-ak-text-primary whitespace-pre-wrap leading-relaxed">{message.content}</p>
        </div>
      </div>
    );
  }

  // Agent messages — left-aligned, no bubble (Claude.ai style)
  const agentColors = AGENT_COLORS[message.role] || AGENT_COLORS.system;

  return (
    <div className="mb-1">
      {/* Agent header */}
      <div className="flex items-center gap-2 mb-1.5">
        <AgentAvatar role={message.role} />
        <span className={`text-sm font-semibold capitalize ${agentColors.text}`}>{message.role}</span>
      </div>
      {/* Message content — plain text, no bubble, indented to match avatar */}
      <div className="pl-9">
        <p className="text-sm text-ak-text-primary whitespace-pre-wrap leading-relaxed">{message.content}</p>

        {message.type === 'clarification' && (
          wizardActive ? (
            <p className="mt-1.5 text-xs text-ak-text-tertiary">
              Scribe {message.questions?.length || 0} soru sordu. Aşağıdan yanıtlayın. ↓
            </p>
          ) : (
            <ClarificationBlock message={message} />
          )
        )}
        {message.type === 'spec' && message.spec && (
          <SpecBlock
            spec={message.spec}
            confidence={message.confidence}
            reviewNotes={message.reviewNotes}
            assumptions={message.assumptions}
            onApprove={onApprove}
            onReject={onReject}
            showActions={showApproveActions}
          />
        )}
        {message.type === 'proto_result' && <ProtoResultBlock message={message} />}
        {message.type === 'trace_result' && <TraceResultBlock message={message} workflow={workflow} />}
      </div>
    </div>
  );
}

// ═══ Main Component ═══

// ═══ Agent Step Definitions ═══
interface AgentStep {
  label: string;
  status: 'done' | 'running' | 'pending';
}

const AGENT_STEPS: Record<string, AgentStep[]> = {
  scribe_analyzing: [
    { label: TR.analyzingIdea, status: 'done' },
    { label: TR.determinePlatform, status: 'done' },
    { label: TR.generateClarifications, status: 'running' },
    { label: TR.prepareDraft, status: 'pending' },
  ],
  scribe_generating: [
    { label: TR.analyzingIdea, status: 'done' },
    { label: TR.generateSpec, status: 'done' },
    { label: TR.acceptanceCriteria, status: 'running' },
    { label: TR.calculateConfidence, status: 'pending' },
  ],
  proto_building: [
    { label: TR.planFileStructure, status: 'done' },
    { label: TR.generateScaffold, status: 'done' },
    { label: TR.createGithubRepo, status: 'running' },
    { label: TR.pushToGithub, status: 'pending' },
  ],
  trace_testing: [
    { label: TR.readCodeFromGithub, status: 'done' },
    { label: TR.analyzeEndpoints, status: 'done' },
    { label: TR.writePlaywright, status: 'running' },
    { label: TR.coverageReport, status: 'pending' },
  ],
};

function getAgentSteps(agentName: string, hasUserAnswered: boolean): AgentStep[] {
  if (agentName === 'scribe') {
    return hasUserAnswered ? AGENT_STEPS.scribe_generating : AGENT_STEPS.scribe_analyzing;
  }
  if (agentName === 'proto') return AGENT_STEPS.proto_building;
  if (agentName === 'trace') return AGENT_STEPS.trace_testing;
  return AGENT_STEPS.scribe_analyzing;
}

// ═══ Thinking Indicator with Steps ═══
// Shows real-time SSE activities when available, falls back to static steps

interface ThinkingIndicatorProps {
  agentName: string;
  hasUserAnswered?: boolean;
  /** Real SSE activities for this pipeline */
  sseActivities?: PipelineActivity[];
  /** Whether SSE connection is active */
  sseConnected?: boolean;
  /** SSE progress for active stage */
  sseProgress?: number;
}

function ThinkingIndicator({ agentName, hasUserAnswered, sseActivities, sseConnected, sseProgress }: ThinkingIndicatorProps) {
  const colors = AGENT_COLORS[agentName] || AGENT_COLORS.system;
  const [isOpen, setIsOpen] = useState(true);

  // Filter SSE activities for this agent's stage
  const stageActivities = sseActivities?.filter(a => a.stage === agentName) ?? [];
  const hasSSE = sseConnected && stageActivities.length > 0;

  // Determine current display label from SSE or static fallback
  const staticSteps = getAgentSteps(agentName, !!hasUserAnswered);
  const staticRunningStep = staticSteps.find(s => s.status === 'running');
  const lastActivity = stageActivities.length > 0 ? stageActivities[stageActivities.length - 1] : null;
  const headerLabel = hasSSE && lastActivity
    ? lastActivity.message
    : (staticRunningStep?.label || TR.processing);

  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 mb-1.5">
        <AgentAvatar role={agentName} />
        <span className={`text-sm font-semibold capitalize ${colors.text}`}>{agentName}</span>
        {hasSSE && (
          <span className="flex items-center gap-1 text-[10px] text-emerald-400/70">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            canli
          </span>
        )}
      </div>
      <div className="pl-9">
        <div className="rounded-lg border border-ak-border bg-ak-surface overflow-hidden">
          {/* Progress bar (SSE only) */}
          {hasSSE && sseProgress !== undefined && sseProgress > 0 && (
            <div className="h-0.5 w-full bg-ak-border-subtle">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${sseProgress}%`,
                  backgroundColor: `var(--ak-${agentName}, var(--ak-primary))`,
                }}
              />
            </div>
          )}

          {/* Toggle header */}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-ak-surface-2"
          >
            <span className="flex gap-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-ak-text-tertiary animate-thinking" />
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-ak-text-tertiary animate-thinking" style={{ animationDelay: '0.2s' }} />
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-ak-text-tertiary animate-thinking" style={{ animationDelay: '0.4s' }} />
            </span>
            <span className="flex-1 text-sm text-ak-text-tertiary truncate">
              {headerLabel}
            </span>
            <svg
              className={`h-3 w-3 flex-shrink-0 text-ak-text-tertiary transition-transform ${isOpen ? 'rotate-90' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
          </button>

          {/* Steps/Activities list */}
          {isOpen && (
            <div className="border-t border-ak-border-subtle px-3 py-2 space-y-1 max-h-48 overflow-y-auto">
              {hasSSE ? (
                /* ═══ Real SSE Activities ═══ */
                <>
                  {stageActivities.map((activity, i) => {
                    const time = new Date(activity.timestamp).toLocaleTimeString('tr-TR', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    });
                    const isError = activity.step === 'error';
                    const isComplete = activity.step === 'complete' || activity.step === 'pipeline_complete';
                    const isAiCall = activity.step === 'ai_call';
                    const isLast = i === stageActivities.length - 1;

                    return (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className="flex-shrink-0 w-14 text-right font-mono text-[10px] text-ak-text-tertiary/50 tabular-nums">
                          {time}
                        </span>
                        <span className="flex-shrink-0 w-4 text-center">
                          {isError && (
                            <svg className="inline h-3.5 w-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          )}
                          {isComplete && (
                            <svg className="inline h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          )}
                          {!isError && !isComplete && isLast && (
                            <span className="inline-block h-2 w-2 rounded-full animate-pulse" style={{ backgroundColor: `var(--ak-${agentName}, var(--ak-primary))` }} />
                          )}
                          {!isError && !isComplete && !isLast && (
                            <svg className="inline h-3.5 w-3.5 text-ak-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          )}
                        </span>
                        <span className={
                          isError ? 'text-red-400' :
                          isComplete ? 'text-emerald-400' :
                          isAiCall ? 'text-ak-text-primary' :
                          isLast ? 'text-ak-text-primary' :
                          'text-ak-text-secondary'
                        }>
                          {activity.message}
                        </span>
                      </div>
                    );
                  })}
                </>
              ) : (
                /* ═══ Static Fallback Steps ═══ */
                staticSteps.map((step, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="flex-shrink-0 w-4 text-center">
                      {step.status === 'done' && (
                        <svg className="inline h-3.5 w-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                        </svg>
                      )}
                      {step.status === 'running' && (
                        <span className="inline-block h-2 w-2 rounded-full animate-pulse" style={{ backgroundColor: `var(--ak-${agentName})` }} />
                      )}
                      {step.status === 'pending' && (
                        <span className="inline-block h-2 w-2 rounded-full border border-ak-text-tertiary/40" />
                      )}
                    </span>
                    <span className={step.status === 'pending' ? 'text-ak-text-tertiary' : step.status === 'running' ? 'text-ak-text-primary' : 'text-ak-text-secondary'}>
                      {step.label}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDuration(startTime?: string, endTime?: string): string {
  if (!startTime || !endTime) return '';
  const ms = new Date(endTime).getTime() - new Date(startTime).getTime();
  if (ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function PipelineSummaryCard({
  workflow,
  onOpenPreview,
  onOpenFiles,
}: {
  workflow: Workflow;
  onOpenPreview?: () => void;
  onOpenFiles?: () => void;
}) {
  const navigate = useNavigate();
  const [cloneCopied, setCloneCopied] = useState(false);
  const s = workflow.stages;
  const protoMsg = workflow.conversation?.find(m => m.type === 'proto_result');
  const traceMsg = workflow.conversation?.find(m => m.type === 'trace_result');
  const repo = protoMsg?.protoResult?.repo;
  const branch = protoMsg?.protoResult?.branch || s.proto.branch;
  const githubUrl = repo && branch ? `https://github.com/${repo}/tree/${branch}` : null;

  // Parse owner/repoName from repo string
  const repoParts = repo?.split('/');
  const repoOwner = repoParts && repoParts.length === 2 ? repoParts[0] : null;
  const repoName = repoParts && repoParts.length === 2 ? repoParts[1] : repo;

  const scribeDuration = formatDuration(workflow.createdAt, s.scribe.endTime);
  const protoDuration = formatDuration(s.approve.endTime, s.proto.endTime);
  const traceDuration = formatDuration(s.proto.endTime, s.trace.endTime);

  // Spec summary counts
  const specMsg = workflow.conversation?.find(m => m.type === 'spec');
  const storyCount = specMsg?.spec?.userStories?.length ?? 0;
  const criteriaCount = specMsg?.spec?.acceptanceCriteria?.length ?? 0;

  const handleClone = async () => {
    if (!repo || !branch) return;
    const cmd = `git clone https://github.com/${repo}.git && cd ${repoName} && git checkout ${branch}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCloneCopied(true);
      setTimeout(() => setCloneCopied(false), 2500);
    } catch { /* noop */ }
  };

  const handleContinue = () => {
    navigate('/dashboard/workflows/new', {
      state: {
        prefillIdea: `Onceki proje: ${workflow.title}\n\nMevcut spec uzerine ek gereksinimler:\n`,
      },
    });
  };

  const compareUrl = repoOwner && repoName && branch
    ? `https://github.com/${repoOwner}/${repoName}/compare/main...${branch}?expand=1`
    : null;

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">✅</span>
          <span className="text-sm font-semibold text-ak-text-primary">{TR.pipelineCompleted2}</span>
        </div>
        {(() => {
          const totalDuration = formatDuration(workflow.createdAt, s.trace.endTime || s.proto.endTime || s.scribe.endTime);
          return totalDuration ? (
            <span className="text-xs text-ak-text-tertiary">{TR.total}: {totalDuration}</span>
          ) : null;
        })()}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {/* Scribe */}
        <div className="rounded-lg bg-white p-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-bold text-ak-scribe">Scribe</span>
            {scribeDuration && <span className="text-[10px] text-ak-text-tertiary">⏱ {scribeDuration}</span>}
          </div>
          <p className="text-xs text-ak-text-secondary">
            {s.scribe.confidence != null ? `${formatConfidence(s.scribe.confidence)} ${TR.confidenceLabel}` : ''}
            {storyCount > 0 && <span className="ml-1.5">{storyCount} {TR.storiesLabel}, {criteriaCount} {TR.criteriaLabel}</span>}
          </p>
        </div>

        {/* Proto */}
        <div className="rounded-lg bg-white p-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-bold text-ak-proto">Proto</span>
            {protoDuration && <span className="text-[10px] text-ak-text-tertiary">⏱ {protoDuration}</span>}
          </div>
          <p className="text-xs text-ak-text-secondary">
            {protoMsg?.protoResult?.totalFiles || 0} {TR.filesLabel.toLowerCase()}, {protoMsg?.protoResult?.totalLines || 0} {TR.linesLabel.toLowerCase()}
          </p>
        </div>

        {/* Trace */}
        <div className="rounded-lg bg-white p-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-bold text-ak-trace">Trace</span>
            {traceDuration && <span className="text-[10px] text-ak-text-tertiary">⏱ {traceDuration}</span>}
          </div>
          <p className="text-xs text-ak-text-secondary">
            {traceMsg?.traceResult?.testCount || 0} {TR.testsLabel.toLowerCase()}, {traceMsg?.traceResult?.coverage || '?'}
          </p>
        </div>
      </div>

      {/* Next steps label */}
      <p className="text-[10px] font-semibold uppercase tracking-wider text-ak-text-tertiary pt-1">{TR.nextSteps}</p>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleContinue}
          className="flex items-center gap-1.5 rounded-lg bg-ak-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-ak-primary/80"
        >
          🔄 {TR.continueDev}
        </button>
        {repo && branch && (
          <button
            onClick={handleClone}
            className="flex items-center gap-1.5 rounded-lg border border-ak-border px-3 py-1.5 text-xs font-medium text-ak-text-secondary transition-colors hover:bg-ak-hover"
          >
            {cloneCopied ? `✓ ${TR.copiedLabel}` : `📋 ${TR.cloneRepo}`}
          </button>
        )}
        {githubUrl && (
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-ak-border px-3 py-1.5 text-xs font-medium text-ak-text-secondary transition-colors hover:bg-ak-hover"
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            {TR.viewOnGithub}
          </a>
        )}
        {compareUrl && (
          <a
            href={compareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-ak-border px-3 py-1.5 text-xs font-medium text-ak-text-secondary transition-colors hover:bg-ak-hover"
          >
            {TR.createPR}
          </a>
        )}
        {onOpenPreview && (
          <button
            onClick={onOpenPreview}
            className="flex items-center gap-1.5 rounded-lg border border-ak-primary/30 bg-ak-primary/10 px-3 py-1.5 text-xs font-medium text-ak-primary transition-colors hover:bg-ak-primary/20"
          >
            ▶ {TR.preview}
          </button>
        )}
        {onOpenFiles && (
          <button
            onClick={onOpenFiles}
            className="flex items-center gap-1.5 rounded-lg border border-ak-border px-3 py-1.5 text-xs font-medium text-ak-text-secondary transition-colors hover:bg-ak-hover"
          >
            📁 {TR.viewFiles}
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorRetryBlock({
  workflow,
  onRetry,
}: {
  workflow: Workflow;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const errorMsg = workflow.stages.proto.error || workflow.stages.trace.error || workflow.stages.scribe.error || TR.pipelineFailed;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(errorMsg);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  };

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">❌</span>
        <span className="text-sm font-semibold text-red-600">{TR.pipelineFailed}</span>
      </div>
      <p className="text-sm text-ak-text-secondary">{errorMsg}</p>
      <div className="flex gap-2">
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-lg bg-ak-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-ak-primary/80"
        >
          🔄 {TR.retry}
        </button>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-lg border border-ak-border px-3 py-1.5 text-xs font-medium text-ak-text-secondary transition-colors hover:bg-ak-hover"
        >
          {copied ? `✓ ${TR.copiedLabel}` : `📋 ${TR.copyError}`}
        </button>
      </div>
    </div>
  );
}

export function WorkflowChatView({ workflow, onSendMessage, onApprove, onReject, onRetry, onOpenPreview, onOpenFiles, sseActivities, sseConnected, sseProgressByStage }: WorkflowChatViewProps) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [isWaitingResponse, setIsWaitingResponse] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = workflow.conversation || [];

  // Reset waiting state when new messages arrive
  useEffect(() => {
    setIsWaitingResponse(false);
  }, [messages.length]);

  // Auto-scroll on new messages, waiting indicator, or new SSE activities
  const sseActivityCount = sseActivities?.length ?? 0;
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isWaitingResponse, sseActivityCount]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  // Auto-focus textarea on mount
  useEffect(() => {
    const timer = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleSend = async (text?: string) => {
    const trimmed = (text || input).trim();
    if (!trimmed || sending) return;
    setSending(true);
    if (!text) setInput('');
    setIsWaitingResponse(true);
    try {
      await onSendMessage(trimmed);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Determine active state
  const isScribeActive = workflow.stages.scribe.status === 'running';
  const isProtoActive = workflow.stages.proto.status === 'running';
  const isTraceActive = workflow.stages.trace.status === 'running';
  const isAwaitingApproval = workflow.status === 'awaiting_approval';
  const isCompleted = workflow.status === 'completed' || workflow.status === 'completed_partial';
  const hasClarification = messages.some(m => m.type === 'clarification');

  // Which agent is currently working? (for thinking indicator)
  const activeAgent = isScribeActive ? 'scribe' : isProtoActive ? 'proto' : isTraceActive ? 'trace' : null;
  const showThinking = isWaitingResponse || (activeAgent !== null && !isAwaitingApproval);

  // Detect last clarification for wizard
  const lastClarification = messages
    .filter(m => m.type === 'clarification')
    .pop();
  const lastClarificationIndex = lastClarification
    ? messages.lastIndexOf(lastClarification)
    : -1;
  // Check if user already answered this clarification (any user message AFTER it)
  const userAnsweredLast = lastClarificationIndex >= 0 &&
    messages.slice(lastClarificationIndex + 1).some(m => m.role === 'user');

  const showWizard = lastClarification &&
    lastClarification.questions &&
    lastClarification.questions.length > 0 &&
    !userAnsweredLast &&
    !isWaitingResponse &&
    workflow.status !== 'awaiting_approval' &&
    workflow.status !== 'completed' &&
    workflow.status !== 'completed_partial' &&
    workflow.status !== 'failed' &&
    workflow.status !== 'cancelled';

  // Hide thinking indicator when wizard is active (Scribe is waiting, not working)
  const effectiveShowThinking = showThinking && !showWizard;

  let placeholder: string = TR.writeMessage;
  if (isScribeActive && hasClarification) placeholder = TR.answerQuestions;
  else if (isAwaitingApproval) placeholder = TR.specFeedback;
  else if (isCompleted) placeholder = TR.pipelineCompletedInput;

  const inputDisabled = isCompleted || workflow.status === 'failed' || workflow.status === 'cancelled';

  return (
    <div className="flex h-full flex-col">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto py-4">
        <div style={{ maxWidth: 768, margin: '0 auto', padding: '0 24px', width: '100%' }} className="space-y-5">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-ak-text-tertiary">{TR.pipelineStarting}</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessage
            key={i}
            message={msg}
            workflow={workflow}
            onApprove={onApprove}
            onReject={onReject}
            wizardActive={!!showWizard && msg === lastClarification}
          />
        ))}
        {effectiveShowThinking && (
          <ThinkingIndicator
            agentName={activeAgent || 'scribe'}
            hasUserAnswered={hasClarification && messages.some(m => m.role === 'user' && m.type === 'message')}
            sseActivities={sseActivities}
            sseConnected={sseConnected}
            sseProgress={sseProgressByStage?.[activeAgent || 'scribe']}
          />
        )}
        {isCompleted && (
          <PipelineSummaryCard
            workflow={workflow}
            onOpenPreview={onOpenPreview}
            onOpenFiles={onOpenFiles}
          />
        )}
        {workflow.status === 'failed' && onRetry && (
          <ErrorRetryBlock workflow={workflow} onRetry={onRetry} />
        )}
        </div>
        <div ref={chatEndRef} />
      </div>

      {/* Suggestion Wizard — replaces input bar when clarification is active */}
      {showWizard ? (
        <SuggestionWizard
          questions={lastClarification.questions!.map((q, i) => ({
            id: q.id || `q-${i}`,
            question: q.question,
            reason: q.reason,
            suggestions: q.suggestions || [],
          }))}
          onSubmit={(answers) => handleSend(answers)}
          onCancel={() => {/* wizard dismissed, user can type freely */}}
        />
      ) : (
        /* Input area — Claude.ai style rounded input bar */
        <div className="flex-shrink-0 px-4 py-3">
          <div style={{ maxWidth: 768, margin: '0 auto' }}>
            <div
              className="rounded-2xl border border-ak-border overflow-hidden"
              style={{ backgroundColor: 'var(--ak-bg-input)', boxShadow: 'var(--ak-shadow-sm)' }}
            >
              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                disabled={inputDisabled || sending}
                rows={1}
                className="w-full resize-none border-none bg-transparent px-4 pt-3 pb-1 text-sm text-ak-text-primary placeholder:text-ak-text-tertiary focus:outline-none disabled:opacity-50"
                style={{ minHeight: '24px', maxHeight: '160px' }}
              />
              {/* Git context bar — hidden on mobile */}
              <div className="hidden sm:block">
                {workflow.stages.proto.status === 'completed' && workflow.stages.proto.branch && (
                  <GitContextBar
                    branch={workflow.stages.proto.branch}
                    repoUrl={messages.find(m => m.protoResult)?.protoResult?.repo}
                  />
                )}
              </div>
              {/* Bottom bar — model selector + send button */}
              <div className="flex items-center justify-between px-3 pb-2 pt-1">
                <div className="flex items-center gap-3">
                  <select
                    className="rounded-md bg-transparent px-1 py-0.5 text-xs text-ak-text-tertiary cursor-pointer focus:outline-none"
                    defaultValue="sonnet"
                  >
                    <option value="sonnet">Sonnet 4.6</option>
                    <option value="haiku">Haiku 4.5</option>
                  </select>
                </div>
                <button
                  onClick={() => handleSend()}
                  disabled={!input.trim() || inputDisabled || sending}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-ak-primary text-white transition-all hover:bg-ak-primary/80 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {sending ? (
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  ) : (
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ Git Context Bar ═══
function GitContextBar({ branch, repoUrl }: { branch: string; repoUrl?: string }) {
  const [copied, setCopied] = useState(false);

  const repoName = repoUrl || '';
  const cloneUrl = repoName ? `https://github.com/${repoName}.git` : '';
  const cloneCommand = cloneUrl ? `git clone ${cloneUrl} && cd ${repoName.split('/')[1] || 'repo'} && git checkout ${branch}` : '';
  const githubUrl = repoName ? `https://github.com/${repoName}/tree/${branch}` : '';
  const prUrl = repoName ? `https://github.com/${repoName}/compare/main...${branch}?expand=1` : '';

  const handleCopyClone = async () => {
    if (!cloneCommand) return;
    try {
      await navigator.clipboard.writeText(cloneCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div className="flex items-center gap-2 border-t border-ak-border-subtle px-4 py-2 overflow-x-auto">
      {/* Branch badge */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <svg className="h-3.5 w-3.5 text-ak-proto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
        </svg>
        <code className="rounded bg-ak-surface-2 px-1.5 py-0.5 text-[11px] font-mono text-ak-proto">{branch}</code>
      </div>

      <div className="mx-1 h-4 w-px bg-ak-border flex-shrink-0" />

      {/* Clone button */}
      {cloneCommand && (
        <button
          onClick={handleCopyClone}
          className="flex items-center gap-1 rounded-md border border-ak-border bg-ak-surface px-2 py-1 text-[11px] font-medium text-ak-text-secondary transition-colors hover:bg-ak-hover hover:text-ak-text-primary flex-shrink-0"
          title={cloneCommand}
        >
          {copied ? (
            <>
              <svg className="h-3 w-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              {TR.copied}
            </>
          ) : (
            <>
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75" />
              </svg>
              {TR.cloneRepo}
            </>
          )}
        </button>
      )}

      {/* View on GitHub */}
      {githubUrl && (
        <a
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 rounded-md border border-ak-border bg-ak-surface px-2 py-1 text-[11px] font-medium text-ak-text-secondary transition-colors hover:bg-ak-hover hover:text-ak-text-primary flex-shrink-0"
        >
          <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          {TR.viewOnGithub}
        </a>
      )}

      {/* Create PR */}
      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 rounded-md border border-ak-primary/30 bg-ak-primary/5 px-2 py-1 text-[11px] font-medium text-ak-primary transition-colors hover:bg-ak-primary/10 flex-shrink-0"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
          {TR.createPR}
        </a>
      )}
    </div>
  );
}
