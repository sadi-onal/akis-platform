import { useEffect, useState } from 'react';
import type { AiCallEntry } from '../../types/pipeline';
import { workflowsApi } from '../../services/api/workflows';

// P5b: AI request log viewer panel.
//
// Renders each `job_ai_calls` row as a collapsable card so the demo can show
// "what we asked the model, and what it answered" — system prompt, user
// prompt, response text, optional Anthropic thinking blocks and tool calls.
//
// Mounting is gated by the parent (`PipelineDetailRail`) behind
// `isInternalUiVisible()` so the tab only appears for `?debug=1` /
// localStorage `akis_debug=true` / `VITE_SHOW_INTERNAL_UI=true`. Normal
// users never see it.

export interface AiCallsPanelProps {
  pipelineId: string;
  /** DI for tests — falls back to workflowsApi.getAiCalls */
  fetcher?: (id: string) => Promise<AiCallEntry[]>;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; calls: AiCallEntry[] }
  | { kind: 'error'; message: string };

/** Format token count, falling back to "—" when null. */
function fmtTokens(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('tr-TR');
}

function fmtMs(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

/** Render a possibly-large string in a <pre> block with safe wrapping. */
function PreText({ value }: { value: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-md bg-ak-surface-2 px-3 py-2 font-mono text-xs leading-relaxed text-ak-text-primary">
      {value}
    </pre>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <PreText value={text} />;
}

/** Collapsable section — single string body. */
function Section({
  title,
  body,
  defaultOpen,
}: {
  title: string;
  body: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div className="rounded-md border border-ak-border bg-ak-surface-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs font-semibold text-ak-text-secondary hover:bg-ak-surface-2"
      >
        <span>{title}</span>
        <span aria-hidden="true" className="text-ak-text-tertiary">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <div className="border-t border-ak-border-subtle px-3 py-2">{body}</div>}
    </div>
  );
}

function CallCard({ call, index }: { call: AiCallEntry; index: number }) {
  const [open, setOpen] = useState(index === 0);
  const hasSystem = !!call.systemPrompt;
  const hasUser = !!call.userPrompt;
  const hasResponse = !!call.responseText;
  const hasThinking = Array.isArray(call.thinkingBlocks) && call.thinkingBlocks.length > 0;
  const hasTools = Array.isArray(call.toolCalls) && call.toolCalls.length > 0;

  const statusGlyph = call.success ? '✓' : '✗';
  const statusClass = call.success
    ? 'text-emerald-600 dark:text-emerald-300'
    : 'text-rose-600 dark:text-rose-300';

  return (
    <article
      data-call-index={call.callIndex}
      className="rounded-lg border border-ak-border bg-ak-bg-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`AI çağrısı #${call.callIndex + 1} ${open ? 'kapat' : 'aç'}`}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs hover:bg-ak-surface-2"
      >
        <span className="font-mono text-ak-text-tertiary">#{call.callIndex + 1}</span>
        <span className="font-semibold text-ak-text-primary">
          {call.provider}/{call.model}
        </span>
        {call.purpose && (
          <span className="rounded-md border border-ak-border-subtle bg-ak-surface-1 px-1.5 py-0.5 text-ak-text-secondary">
            {call.purpose}
          </span>
        )}
        <span className="text-ak-text-tertiary">
          {fmtTokens(call.inputTokens)} → {fmtTokens(call.outputTokens)} token
        </span>
        <span className="text-ak-text-tertiary">{fmtMs(call.durationMs)}</span>
        <span className={`font-semibold ${statusClass}`}>
          {statusGlyph}
          {call.success ? '' : ` ${call.errorCode ?? 'hata'}`}
        </span>
        <span className="ml-auto text-ak-text-tertiary" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-ak-border-subtle px-3 py-2">
          {hasSystem && (
            <Section title="Sistem talimatı" body={<PreText value={call.systemPrompt!} />} />
          )}
          {hasUser && (
            <Section
              title="Kullanıcı sorusu"
              body={<PreText value={call.userPrompt!} />}
              defaultOpen
            />
          )}
          {hasResponse && (
            <Section title="Cevap" body={<PreText value={call.responseText!} />} defaultOpen />
          )}
          {hasThinking && (
            <Section
              title="Düşünce notları"
              body={<JsonBlock value={call.thinkingBlocks} />}
            />
          )}
          {hasTools && <Section title="Araç çağrıları" body={<JsonBlock value={call.toolCalls} />} />}
          {!hasSystem && !hasUser && !hasResponse && !hasThinking && !hasTools && (
            <p className="text-xs text-ak-text-tertiary">
              Bu çağrı için içerik kaydı yok (P5a öncesi veya truncate edilmiş).
            </p>
          )}
        </div>
      )}
    </article>
  );
}

export function AiCallsPanel({ pipelineId, fetcher }: AiCallsPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    if (!pipelineId) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    const fn = fetcher ?? workflowsApi.getAiCalls;
    fn(pipelineId)
      .then((calls) => {
        if (!cancelled) setState({ kind: 'ready', calls });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Yüklenemedi',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pipelineId, fetcher]);

  if (state.kind === 'loading') {
    return (
      <p className="px-1 py-2 text-xs text-ak-text-tertiary" data-testid="ai-calls-loading">
        AI çağrıları yükleniyor…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <p
        role="alert"
        className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200"
      >
        {state.message}
      </p>
    );
  }
  if (state.calls.length === 0) {
    return (
      <p className="px-1 py-2 text-xs text-ak-text-tertiary" data-testid="ai-calls-empty">
        Bu pipeline için kayıtlı AI çağrısı yok
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="ai-calls-list">
      {state.calls.map((call, idx) => (
        <CallCard key={call.id} call={call} index={idx} />
      ))}
    </div>
  );
}

export default AiCallsPanel;
