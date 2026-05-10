import { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import type { ChatMessage as ChatMessageType, AgentName, UserMessageImage } from '../../types/chat';
import { PlanCard } from './PlanCard';
import { AgentStartedLine } from './AgentStartedLine';

/** Lightweight inline markdown renderer — no external deps, handles code blocks, bold, inline code */
function SimpleMarkdown({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let key = 0;

  // Split by fenced code blocks first
  const segments = text.split(/(```[\s\S]*?```)/g);
  for (const seg of segments) {
    if (seg.startsWith('```')) {
      const match = seg.match(/^```(\w*)\n?([\s\S]*?)```$/);
      const lang = match?.[1] || '';
      const code = match?.[2]?.trimEnd() || seg.slice(3, -3);
      parts.push(
        <pre key={key++} className="my-2 overflow-x-auto rounded-lg bg-ak-surface-2 p-3 text-xs font-mono text-ak-text-primary">
          {lang && <span className="mb-1 block text-[10px] font-semibold uppercase text-ak-text-tertiary">{lang}</span>}
          <code>{code}</code>
        </pre>
      );
    } else {
      // Process inline markdown
      const lines = seg.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nodes: React.ReactNode[] = [];
        // Replace **bold** and `inline code`
        const inlineRegex = /(\*\*(.+?)\*\*|`([^`]+)`)/g;
        let lastIdx = 0;
        let m: RegExpExecArray | null;
        while ((m = inlineRegex.exec(line)) !== null) {
          if (m.index > lastIdx) nodes.push(line.slice(lastIdx, m.index));
          if (m[2]) nodes.push(<strong key={key++} className="font-semibold text-ak-text-primary">{m[2]}</strong>);
          else if (m[3]) nodes.push(<code key={key++} className="rounded bg-ak-surface-2 px-1 py-0.5 text-xs font-mono">{m[3]}</code>);
          lastIdx = m.index + m[0].length;
        }
        if (lastIdx < line.length) nodes.push(line.slice(lastIdx));
        if (nodes.length === 0 && line === '') {
          parts.push(<br key={key++} />);
        } else {
          parts.push(<span key={key++}>{nodes}{i < lines.length - 1 ? '\n' : ''}</span>);
        }
      }
    }
  }
  return <div className="whitespace-pre-wrap text-sm text-ak-text-secondary">{parts}</div>;
}

interface ChatMessageProps {
  message: ChatMessageType;
  onApprove?: () => void;
  onReject?: () => void;
  onRetry?: () => void;
  onSkip?: () => void;
  /**
   * F-09 / FR-10.4: when a `chat_qa_response` carries `needsBuild=true`, this
   * callback is invoked when the user clicks the "[BUILD] Bunu özellik olarak
   * ekleyelim mi?" CTA below the answer.
   */
  onSuggestBuild?: (sourceMessage: string) => void;
}

const AGENT_COLORS: Record<AgentName, { bg: string; border: string; text: string; label: string }> = {
  scribe: { bg: 'bg-ak-scribe/10', border: 'border-ak-scribe/30', text: 'text-ak-scribe', label: 'Scribe' },
  proto: { bg: 'bg-ak-proto/10', border: 'border-ak-proto/30', text: 'text-ak-proto', label: 'Proto' },
  trace: { bg: 'bg-ak-trace/10', border: 'border-ak-trace/30', text: 'text-ak-trace', label: 'Trace' },
};

function AgentAvatar({ agent }: { agent: AgentName }) {
  const c = AGENT_COLORS[agent];
  const initials = agent[0].toUpperCase();
  return (
    <div className={cn('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border', c.bg, c.border)}>
      <span className={cn('text-xs font-bold', c.text)}>{initials}</span>
    </div>
  );
}

function JiraBadge({ epicKey }: { epicKey?: string }) {
  if (!epicKey) return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-blue-500/10 text-blue-400">
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
        <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.593 24V12.518a1.005 1.005 0 0 0-1.022-1.005z" />
      </svg>
      {epicKey}
    </span>
  );
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function ClarificationMessage({
  message,
}: {
  message: Extract<ChatMessageType, { type: 'clarification' }>;
}) {
  const cc = AGENT_COLORS[message.role];

  return (
    <div className="flex gap-2.5 animate-in fade-in slide-in-from-left-2 duration-200">
      <AgentAvatar agent={message.role} />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2">
          <span className={cn('text-xs font-semibold', cc.text)}>{AGENT_COLORS[message.role].label}</span>
          <span className="text-[10px] text-ak-text-tertiary">{formatTime(message.timestamp)}</span>
        </div>
        <p className="mb-2 whitespace-pre-wrap text-sm text-ak-text-secondary">{message.content}</p>
        <div className="space-y-2">
          {message.questions.map((q, i) => (
            <div key={q.id} className={cn('rounded-lg border p-3', cc.border, cc.bg)}>
              <p className="text-sm font-medium text-ak-text-primary">
                {i + 1}. {q.question}
              </p>
              {q.reason && (
                <p className="mt-1 text-xs text-ak-text-tertiary">{q.reason}</p>
              )}
              {q.suggestions && q.suggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {q.suggestions.map((s, si) => (
                    <span
                      key={si}
                      className="rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-1 text-xs font-medium text-ak-text-secondary"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * User chat bubble — renders the text and any attached image thumbnails.
 *
 * Thumbnails:
 * - Max 200x200 per image (object-fit: cover)
 * - Rounded corners, subtle border, hover scale
 * - Click → full-size preview modal (portal-less; fixed-overlay close on Esc or backdrop click)
 * - 2+ images: CSS grid layout (2 columns on mobile, up to 3 on wider rows)
 * Issue #464 BUG-C.
 */
function UserBubble({ message }: { message: Extract<ChatMessageType, { type: 'user' }> }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const images = message.images ?? [];
  const hasImages = images.length > 0;

  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewIndex(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIndex]);

  return (
    <div className="flex justify-end animate-in fade-in slide-in-from-right-2 duration-200">
      <div className="max-w-[85%] rounded-2xl bg-ak-primary px-4 py-2.5 text-sm text-[color:var(--ak-on-primary,#fff)]">
        {message.content && <p className="whitespace-pre-wrap">{message.content}</p>}
        {hasImages && (
          <UserImageThumbnails
            images={images}
            hasText={message.content.length > 0}
            onOpen={(i) => setPreviewIndex(i)}
          />
        )}
        <span className="mt-1 block text-right text-[10px] text-[color:var(--ak-on-primary,#fff)] opacity-60">{formatTime(message.timestamp)}</span>
      </div>
      {previewIndex !== null && images[previewIndex] && (
        <UserImagePreviewModal
          image={images[previewIndex]}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}

function UserImageThumbnails({
  images,
  hasText,
  onOpen,
}: {
  images: UserMessageImage[];
  hasText: boolean;
  onOpen: (index: number) => void;
}) {
  // Layout decision: single image → max 200x200 block; multiple → grid
  const isSingle = images.length === 1;
  return (
    <div
      className={cn(
        hasText ? 'mt-2' : '',
        isSingle
          ? 'flex'
          : 'grid grid-cols-2 gap-1.5 sm:grid-cols-3',
      )}
    >
      {images.map((img, i) => (
        <button
          key={img.id}
          type="button"
          onClick={() => onOpen(i)}
          aria-label={`${img.name} — büyüt`}
          className={cn(
            'group relative overflow-hidden rounded-lg border border-white/20 bg-black/10',
            'transition-transform duration-150 hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
            isSingle ? 'max-h-[200px] max-w-[200px]' : 'aspect-square w-full',
          )}
        >
          <img
            src={img.previewUrl}
            alt={img.name}
            className={cn(
              'h-full w-full',
              isSingle ? 'object-contain max-h-[200px] max-w-[200px]' : 'object-cover',
            )}
            loading="lazy"
          />
        </button>
      ))}
    </div>
  );
}

function UserImagePreviewModal({ image, onClose }: { image: UserMessageImage; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={image.previewUrl}
          alt={image.name}
          className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
        />
        <div className="mt-2 flex items-center justify-between gap-3 text-white">
          <span className="truncate text-xs text-white/70">{image.name}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            className="rounded-lg border border-white/20 bg-black/40 px-3 py-1 text-xs hover:bg-white/10"
          >
            Kapat
          </button>
        </div>
      </div>
    </div>
  );
}

export function ChatMessage({ message, onApprove, onReject, onRetry, onSkip, onSuggestBuild }: ChatMessageProps) {
  switch (message.type) {
    case 'user':
      return <UserBubble message={message} />;

    case 'agent': {
      const c = AGENT_COLORS[message.agent];
      return (
        <div className="group flex gap-2.5 animate-in fade-in slide-in-from-left-2 duration-200">
          <AgentAvatar agent={message.agent} />
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-center gap-2">
              <span className={cn('text-xs font-semibold', c.text)}>{c.label}</span>
              <span className="text-[10px] text-ak-text-tertiary">{formatTime(message.timestamp)}</span>
              <JiraBadge epicKey={message.jiraEpicKey} />
              <button
                onClick={() => navigator.clipboard.writeText(message.content)}
                title="Kopyala"
                aria-label="Mesajı kopyala"
                className="ml-auto rounded p-1 text-ak-text-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-ak-surface-2 hover:text-ak-primary"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
            <SimpleMarkdown text={message.content} />
          </div>
        </div>
      );
    }

    case 'clarification':
      return <ClarificationMessage message={message} />;


    case 'plan':
      return (
        <div className="animate-in fade-in zoom-in-[0.98] duration-200">
          <PlanCard
            plan={message.plan}
            version={message.version}
            status={message.status}
            isChangeRequest={false}
            onApprove={message.status === 'active' ? onApprove : undefined}
            onReject={message.status === 'active' ? onReject : undefined}
          />
        </div>
      );

    case 'file_created':
      return (
        <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-2 duration-200">
          <span className="text-green-400">✓</span>
          <span className="font-mono text-xs text-ak-text-secondary">{message.path}</span>
        </div>
      );

    case 'pr_opened':
      return (
        <div className="rounded-xl border border-ak-proto/20 bg-ak-surface p-4 animate-in fade-in slide-in-from-left-2 duration-200">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-ak-proto">
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
                <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
              </svg>
            </span>
            <span className="text-sm font-semibold text-ak-text-primary">{message.title}</span>
            <JiraBadge epicKey={message.jiraEpicKey} />
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-ak-text-tertiary">
            <span className="rounded bg-ak-surface-2 px-2 py-0.5 font-mono">{message.branch}</span>
            <span>{message.filesChanged} dosya</span>
            <span>{message.linesChanged} satır</span>
          </div>
          {message.url && (
            <a
              href={message.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-ak-proto hover:underline"
            >
              GitHub'da Gör ↗
            </a>
          )}
        </div>
      );

    case 'test_result':
      return (
        <div className="rounded-xl border border-ak-trace/20 bg-ak-surface p-4 animate-in fade-in slide-in-from-left-2 duration-200">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-ak-trace">🧪</span>
            <span className="text-sm font-semibold text-ak-text-primary">Test Sonuçları</span>
            <JiraBadge epicKey={message.jiraEpicKey} />
          </div>
          <div className="flex gap-4 text-xs">
            <div>
              <span className="text-lg font-bold text-green-400">{message.passed}</span>
              <span className="ml-1 text-ak-text-tertiary">başarılı</span>
            </div>
            {message.failed > 0 && (
              <div>
                <span className="text-lg font-bold text-red-400">{message.failed}</span>
                <span className="ml-1 text-ak-text-tertiary">başarısız</span>
              </div>
            )}
            <div>
              <span className="text-lg font-bold text-ak-text-primary">{message.coverage}%</span>
              <span className="ml-1 text-ak-text-tertiary">kapsam</span>
            </div>
          </div>
          {message.failures && message.failures.length > 0 && (
            <div className="mt-3 space-y-1">
              {message.failures.map((f, i) => (
                <div key={i} className="text-xs text-red-400">
                  {f.file}:{f.line} — {f.message}
                </div>
              ))}
            </div>
          )}

          {/* Uncovered criteria warning — always visible */}
          {message.uncoveredCriteria && message.uncoveredCriteria.length > 0 && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
              <p className="text-xs font-semibold text-red-400">
                ⚠ {message.uncoveredCriteria.length} kriter kapsanmadı
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {message.uncoveredCriteria.map((c) => (
                  <li key={c} className="flex items-center gap-1.5 text-xs text-red-400/80">
                    <span className="text-red-400">✗</span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Test files — collapsible */}
          {message.testFiles && message.testFiles.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-ak-text-secondary transition-colors hover:text-ak-text-primary">
                Test Dosyaları ({message.testFiles.length})
              </summary>
              <ul className="mt-2 space-y-1">
                {message.testFiles.map((f) => (
                  <li key={f.filePath} className="flex items-center gap-2 font-mono text-xs text-ak-text-secondary">
                    <span className="text-green-500">✓</span>
                    {f.filePath}
                    <span className="text-ak-text-tertiary">({f.testCount} test)</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* Acceptance criteria coverage — collapsible */}
          {message.coverageMatrix && Object.keys(message.coverageMatrix).length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-ak-text-secondary transition-colors hover:text-ak-text-primary">
                Kriter Kapsamı ({Object.keys(message.coverageMatrix).length})
              </summary>
              <div className="mt-2 space-y-1.5">
                {Object.entries(message.coverageMatrix).map(([criterion, files]) => {
                  const isCovered = files.length > 0;
                  return (
                    <div key={criterion} className="text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={isCovered ? 'text-green-500' : 'text-red-400'}>
                          {isCovered ? '✓' : '✗'}
                        </span>
                        <span className="font-medium text-ak-text-primary">{criterion}</span>
                      </div>
                      {isCovered && (
                        <div className="ml-5 mt-0.5 space-y-0.5">
                          {files.map((tf) => (
                            <span key={tf} className="block font-mono text-ak-text-tertiary">{tf}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {message.failed > 0 && (
            <div className="mt-3 flex gap-2">
              {onRetry && (
                <button onClick={onRetry} className="rounded-lg border border-ak-trace/20 px-3 py-1.5 text-xs font-medium text-ak-trace hover:bg-ak-trace/10 transition-colors">
                  🔄 Trace'e Düzelttir
                </button>
              )}
              {onSkip && (
                <button onClick={onSkip} className="rounded-lg border border-ak-border px-3 py-1.5 text-xs font-medium text-ak-text-tertiary hover:text-ak-text-secondary transition-colors">
                  ⏭ Geç
                </button>
              )}
            </div>
          )}
        </div>
      );

    case 'error': {
      const maxRetries = message.maxRetries ?? 3;
      return (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 animate-in fade-in slide-in-from-left-2 duration-200 animate-shake-subtle">
          {/* Header: title + error code badge */}
          <div className="mb-2 flex items-center gap-2 flex-wrap">
            <span className="text-red-400">⚠</span>
            <span className="text-sm font-semibold text-red-400">Hata</span>
            {message.code && (
              <span className="rounded-full bg-red-500/10 px-2 py-0.5 font-mono text-[10px] font-medium text-red-400 border border-red-500/20">
                {message.code}
              </span>
            )}
          </div>

          {/* Error message */}
          <p className="text-xs text-ak-text-secondary">{message.message}</p>

          {/* Retryable indicator + retry count */}
          <div className="mt-2 flex items-center gap-3 flex-wrap">
            {message.retryable ? (
              <span className="flex items-center gap-1.5 text-[11px] text-green-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400" />
                Tekrar denenebilir
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-red-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-400" />
                Tekrar denenemez
              </span>
            )}
            {message.retryCount != null && (
              <span className="text-[11px] text-ak-text-tertiary">
                Deneme: {message.retryCount}/{maxRetries}
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div className="mt-3 flex gap-2 flex-wrap">
            {/* Standard retry button */}
            {message.retryable && onRetry && (
              <button onClick={onRetry} className="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors">
                Tekrar Dene
              </button>
            )}
            {/* Recovery action: edit_spec */}
            {message.recoveryAction === 'edit_spec' && onReject && (
              <button onClick={onReject} className="rounded-lg border border-blue-500/20 px-3 py-1.5 text-xs font-medium text-blue-400 hover:bg-blue-500/10 transition-colors">
                Spec'i Duzenle
              </button>
            )}
            {/* Recovery action: reconnect_github */}
            {message.recoveryAction === 'reconnect_github' && (
              <a href="/settings" className="rounded-lg border border-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-400 hover:bg-amber-500/10 transition-colors inline-flex items-center gap-1">
                GitHub'i Yeniden Bagla
              </a>
            )}
            {/* Recovery action: start_over */}
            {message.recoveryAction === 'start_over' && (
              <a href="/chat" className="rounded-lg border border-ak-primary/20 px-3 py-1.5 text-xs font-medium text-ak-primary hover:bg-ak-primary/10 transition-colors inline-flex items-center gap-1">
                Yeni Pipeline Baslat
              </a>
            )}
            {/* Skip button (always available on retryable errors) */}
            {onSkip && (
              <button onClick={onSkip} className="rounded-lg border border-ak-border px-3 py-1.5 text-xs font-medium text-ak-text-tertiary hover:text-ak-text-secondary transition-colors">
                Atla
              </button>
            )}
          </div>
        </div>
      );
    }

    case 'info':
      return (
        <div className="flex justify-center animate-in fade-in duration-200">
          <div className="rounded-full border border-ak-border-subtle bg-ak-surface-2 px-4 py-1.5 text-xs text-ak-text-tertiary">
            {message.content}
          </div>
        </div>
      );

    case 'agent_started':
      return (
        <div className="animate-in fade-in slide-in-from-left-1 duration-200">
          <AgentStartedLine
            agent={message.agent}
            task={message.task}
            state={message.state}
            meta={message.meta}
          />
        </div>
      );

    case 'pipeline_complete': {
      const isPartial = message.status === 'completed_partial';
      return (
        <div className={cn(
          'rounded-2xl border p-5 animate-in fade-in slide-in-from-bottom-3 duration-300',
          isPartial ? 'border-amber-500/30 bg-amber-500/5' : 'border-ak-primary/30 bg-ak-primary/5',
        )}>
          <div className="mb-3 flex items-center gap-2">
            <span className="text-lg">{isPartial ? '⚠' : '✅'}</span>
            <span className="text-[15px] font-semibold text-ak-text-primary">
              {isPartial ? 'Pipeline Kısmen Tamamlandı' : 'Pipeline Tamamlandı'}
            </span>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-ak-text-secondary">
            {message.repoUrl && (
              <span className="flex items-center gap-1.5">
                <span>📁</span>
                <a href={message.repoUrl} target="_blank" rel="noopener noreferrer" className="text-ak-primary hover:underline font-mono text-xs">
                  {message.repoUrl.replace('https://github.com/', '')}
                </a>
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span>🌿</span>
              <span className="font-mono text-xs">{message.branch}</span>
            </span>
            <span>{message.fileCount} dosya · {message.lineCount} satır</span>
            {message.testCount != null && (
              <span>🧪 {message.testCount} test{message.coverage ? ` · %${message.coverage} kapsam` : ''}</span>
            )}
          </div>

          {message.cloneCommand && (
            <div className="mt-3 rounded-lg bg-ak-surface-2 p-3">
              <p className="mb-1.5 text-xs text-ak-text-tertiary">Projenize başlamak için:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono text-ak-text-secondary break-all">{message.cloneCommand}</code>
                <button
                  onClick={() => navigator.clipboard.writeText(message.cloneCommand)}
                  aria-label="Komutu kopyala"
                  className="flex-shrink-0 rounded-md border border-ak-border px-2 py-1 text-xs text-ak-text-tertiary hover:text-ak-text-secondary hover:bg-ak-surface transition-colors"
                >
                  📋 Kopyala
                </button>
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {message.repoUrl && (
              <a
                href={message.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-ak-primary/20 px-3 py-1.5 text-xs font-medium text-ak-primary hover:bg-ak-primary/10 transition-colors"
              >
                🔗 GitHub'da Aç
              </a>
            )}
            {isPartial && onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ak-trace/20 px-3 py-1.5 text-xs font-medium text-ak-trace hover:bg-ak-trace/10 transition-colors"
              >
                🔄 Trace'i Tekrar Dene
              </button>
            )}
          </div>

          <p className="mt-3 text-[13px] text-ak-text-tertiary">
            💬 Projenizle ilgili soru sorabilir veya notlarınızı bırakabilirsiniz.
          </p>
        </div>
      );
    }

    case 'critic_review': {
      const isSpec = message.reviewType === 'spec_review';
      const scoreColor = message.score >= 75 ? 'text-green-400' : message.score >= 50 ? 'text-amber-400' : 'text-red-400';
      const scoreBg = message.score >= 75 ? 'bg-green-500/10 border-green-500/20' : message.score >= 50 ? 'bg-amber-500/10 border-amber-500/20' : 'bg-red-500/10 border-red-500/20';
      const SEVERITY_COLORS: Record<string, string> = {
        critical: 'text-red-400 bg-red-500/10',
        major: 'text-amber-400 bg-amber-500/10',
        minor: 'text-blue-400 bg-blue-500/10',
        info: 'text-ak-text-tertiary bg-ak-surface-2',
      };
      return (
        <div className={cn('rounded-xl border p-4 animate-in fade-in slide-in-from-left-2 duration-200', scoreBg)}>
          <div className="mb-2 flex items-center gap-2 flex-wrap">
            <span className="text-lg">{isSpec ? '📋' : '🔍'}</span>
            <span className="text-sm font-semibold text-ak-text-primary">
              {isSpec ? 'Spec İncelemesi' : 'Kod İncelemesi'}
            </span>
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', scoreColor, scoreBg)}>
              {message.score}/100
            </span>
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', message.approved ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400')}>
              {message.approved ? 'Onaylandı' : 'Reddedildi'}
            </span>
          </div>
          {message.summary && (
            <p className="mb-3 text-xs text-ak-text-secondary">{message.summary}</p>
          )}
          {message.findings.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer text-xs font-medium text-ak-text-secondary hover:text-ak-text-primary transition-colors">
                {message.findings.length} bulgu
              </summary>
              <div className="mt-2 space-y-1.5">
                {message.findings.map((f, i) => (
                  <div key={i} className="rounded-lg border border-ak-border-subtle bg-ak-surface/60 p-2">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold', SEVERITY_COLORS[f.severity] ?? SEVERITY_COLORS.info)}>
                        {f.severity}
                      </span>
                      <span className="text-[10px] text-ak-text-tertiary">{f.category}</span>
                    </div>
                    <p className="text-xs text-ak-text-primary">{f.description}</p>
                    {f.suggestion && (
                      <p className="mt-0.5 text-[11px] text-ak-text-tertiary">💡 {f.suggestion}</p>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      );
    }

    case 'chat_qa_response': {
      const { content, citations, needsBuild, streaming, sourceMessage } = message;
      const SOURCE_LABELS: Record<string, string> = {
        spec: 'Spec',
        proto: 'Kod',
        findings: 'Bulgular',
        regression: 'Regresyon',
      };
      return (
        <div
          data-testid="chat-qa-response"
          className="rounded-xl border border-ak-border bg-ak-surface p-4 animate-in fade-in slide-in-from-left-2 duration-200"
        >
          <div className="mb-2 flex items-center gap-2">
            <span aria-hidden="true" className="text-ak-primary">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
            </span>
            <span className="text-xs font-semibold text-ak-text-primary">Sohbet yanıtı</span>
            <span className="text-[10px] text-ak-text-tertiary">{formatTime(message.timestamp)}</span>
            {streaming && (
              <span
                aria-live="polite"
                data-testid="chat-qa-streaming"
                className="text-[10px] text-ak-text-tertiary italic"
              >
                yazıyor…
              </span>
            )}
          </div>
          <div data-testid="chat-qa-content">
            <SimpleMarkdown text={content || '...'} />
          </div>
          {!streaming && citations && citations.length > 0 && (
            <div
              data-testid="chat-qa-citations"
              className="mt-3 flex flex-wrap gap-1.5"
            >
              {citations.map((c, i) => (
                <span
                  key={i}
                  title={c.excerpt}
                  className="rounded-full border border-ak-border bg-ak-surface-2 px-2 py-0.5 text-[10px] text-ak-text-secondary"
                >
                  <span className="font-semibold">{SOURCE_LABELS[c.source] ?? c.source}</span>
                  {c.refKey ? <span className="ml-1 font-mono text-[10px] text-ak-text-tertiary">· {c.refKey}</span> : null}
                </span>
              ))}
            </div>
          )}
          {!streaming && needsBuild && sourceMessage && onSuggestBuild && (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                data-testid="chat-qa-build-cta"
                onClick={() => onSuggestBuild(sourceMessage)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-ak-primary/30 bg-ak-primary/10 px-3 py-1.5 text-xs font-medium text-ak-primary hover:bg-ak-primary/20 transition-colors"
              >
                <span aria-hidden="true">+</span>
                <span>Bunu özellik olarak ekleyelim mi?</span>
              </button>
              <span className="text-[10px] text-ak-text-tertiary">Tıklarsan yeni bir build başlatırız.</span>
            </div>
          )}
        </div>
      );
    }

    case 'gherkin_spec': {
      const { features, totalScenarios } = message;
      return (
        <div className="rounded-xl border border-green-500/20 bg-ak-surface p-4 animate-in fade-in slide-in-from-left-2 duration-200 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg text-green-500">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
              </svg>
            </span>
            <span className="font-semibold text-ak-text-primary">BDD Spesifikasyonlari</span>
            <span className="text-xs text-ak-text-tertiary">({totalScenarios} senaryo)</span>
          </div>
          {features.map((f, i) => (
            <details key={i} className="group">
              <summary className="cursor-pointer text-sm font-medium text-ak-text-secondary hover:text-ak-text-primary flex items-center gap-2 transition-colors">
                <span className="text-green-500">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </span>
                {f.featureName}
                <span className="text-xs text-ak-text-tertiary">({f.scenarioCount} senaryo)</span>
              </summary>
              <div className="mt-2 ml-6">
                <pre className="text-xs bg-ak-surface-2 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                  {f.content.split('\n').map((line, li) => (
                    <div key={li}>
                      {/^(\s*)(Feature|Scenario|Given|When|Then|And|But):?/.test(line) ? (
                        <span>
                          <span className="text-green-400 font-semibold">
                            {line.match(/^(\s*)(Feature|Scenario|Given|When|Then|And|But):?/)?.[0]}
                          </span>
                          {line.replace(/^(\s*)(Feature|Scenario|Given|When|Then|And|But):?/, '')}
                        </span>
                      ) : line}
                    </div>
                  ))}
                </pre>
                {f.mappedCriteria.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {f.mappedCriteria.map((c, ci) => (
                      <span key={ci} className="px-2 py-0.5 rounded-full text-xs bg-purple-500/10 text-purple-400">
                        {c.length > 60 ? c.slice(0, 57) + '...' : c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      );
    }

    default:
      if (import.meta.env.DEV) {
        console.warn('[ChatMessage] Unknown message type:', (message as Record<string, unknown>).type);
      }
      return null;
  }
}
