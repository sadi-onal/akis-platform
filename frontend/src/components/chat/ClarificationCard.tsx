import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { cn } from '../../utils/cn';

export interface ClarificationQuestion {
  id: string;
  question: string;
  reason?: string;
  suggestions?: string[];
}

interface ClarificationCardProps {
  questions: ClarificationQuestion[];
  onSubmit: (combinedText: string) => void;
  onDismiss?: () => void;
}

const SWIPE_THRESHOLD = 50;

export function ClarificationCard({ questions, onSubmit, onDismiss }: ClarificationCardProps) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [customMode, setCustomMode] = useState<Record<string, boolean>>({});
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const rootRef = useRef<HTMLDivElement>(null);
  const touchStartXRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset when question set changes (new clarification round)
  const questionsKey = useMemo(() => questions.map((q) => q.id).join('|'), [questions]);
  useEffect(() => {
    setCurrentIdx(0);
    setAnswers({});
    setCustomMode({});
    setDirection('right');
  }, [questionsKey]);

  const total = questions.length;
  const currentQ = questions[currentIdx];
  const answeredCount = Object.values(answers).filter((v) => v.trim().length > 0).length;

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= total) return;
      setDirection(next > currentIdx ? 'right' : 'left');
      setCurrentIdx(next);
    },
    [currentIdx, total],
  );

  const goPrev = useCallback(() => goTo(currentIdx - 1), [currentIdx, goTo]);
  const goNext = useCallback(() => goTo(currentIdx + 1), [currentIdx, goTo]);

  const handleBadgeSelect = useCallback(
    (text: string) => {
      if (!currentQ) return;
      setAnswers((prev) => ({ ...prev, [currentQ.id]: text }));
      setCustomMode((prev) => ({ ...prev, [currentQ.id]: false }));
    },
    [currentQ],
  );

  const handleCustomToggle = useCallback(() => {
    if (!currentQ) return;
    setCustomMode((prev) => ({ ...prev, [currentQ.id]: !prev[currentQ.id] }));
    setAnswers((prev) => {
      const next = { ...prev };
      if (!prev[currentQ.id] || currentQ.suggestions?.includes(prev[currentQ.id] ?? '')) {
        next[currentQ.id] = '';
      }
      return next;
    });
  }, [currentQ]);

  const handleCustomInput = useCallback(
    (value: string) => {
      if (!currentQ) return;
      setAnswers((prev) => ({ ...prev, [currentQ.id]: value }));
    },
    [currentQ],
  );

  const handleSubmit = useCallback(() => {
    const combined = questions
      .map((q) => {
        const a = (answers[q.id] ?? '').trim();
        return `${q.question}\n→ ${a.length > 0 ? a : '(cevap yok)'}`;
      })
      .join('\n\n');
    onSubmit(combined);
  }, [questions, answers, onSubmit]);

  // Keyboard navigation
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't hijack arrow keys when user is typing in the custom textarea
      if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [goPrev, goNext]);

  // Focus textarea when custom mode opens
  useEffect(() => {
    if (currentQ && customMode[currentQ.id]) {
      textareaRef.current?.focus();
    }
  }, [currentQ, customMode]);

  // Touch swipe
  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('textarea, button, input')) return;
    touchStartXRef.current = e.clientX;
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    const start = touchStartXRef.current;
    touchStartXRef.current = null;
    if (start == null) return;
    const dx = e.clientX - start;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    if (dx < 0) goNext();
    else goPrev();
  };

  if (!currentQ) return null;

  const isLast = currentIdx === total - 1;
  const slideAnimClass =
    direction === 'right'
      ? 'animate-in fade-in slide-in-from-right-2 duration-200'
      : 'animate-in fade-in slide-in-from-left-2 duration-200';
  const currentAnswer = answers[currentQ.id] ?? '';
  const isCustomMode = !!customMode[currentQ.id];

  return (
    <div className="shrink-0 px-4 pt-2">
      <div
        ref={rootRef}
        tabIndex={-1}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        className={cn(
          'relative mx-auto max-w-[720px] rounded-2xl border p-4',
          'backdrop-blur-xl bg-ak-surface/85 border-ak-scribe/30',
          'shadow-lg shadow-ak-scribe/5',
          'animate-in fade-in slide-in-from-bottom-4 duration-300',
        )}
      >
        {/* Header */}
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-ak-scribe/15 text-xs font-bold text-ak-scribe">
              S
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-ak-scribe">
              Soru {currentIdx + 1}/{total}
            </span>
            <span className="text-[11px] text-ak-text-tertiary">
              • {answeredCount}/{total} cevaplandı
            </span>
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Kartı kapat"
              className="rounded-md p-1 text-ak-text-tertiary hover:bg-ak-surface-2 hover:text-ak-text-secondary transition-colors"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Body (animated per question) */}
        <div key={currentQ.id} className={slideAnimClass}>
          <p className="text-[15px] font-semibold text-ak-text-primary leading-snug">{currentQ.question}</p>
          {currentQ.reason && (
            <p className="mt-1.5 text-[13px] text-ak-text-tertiary leading-relaxed">{currentQ.reason}</p>
          )}

          {/* Suggestion chips */}
          {currentQ.suggestions && currentQ.suggestions.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {currentQ.suggestions.map((s, si) => {
                const isSelected = currentAnswer === s && !isCustomMode;
                return (
                  <button
                    key={si}
                    type="button"
                    onClick={() => handleBadgeSelect(s)}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-[13px] transition-all duration-150 cursor-pointer text-left break-words',
                      isSelected
                        ? 'border-ak-primary bg-ak-primary/15 text-ak-primary shadow-sm shadow-ak-primary/20'
                        : 'border-ak-border-subtle bg-ak-surface-2 text-ak-text-secondary hover:border-ak-primary/50 hover:text-ak-primary hover:scale-[1.02] active:scale-[0.98]',
                    )}
                  >
                    {s}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={handleCustomToggle}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-[13px] transition-all duration-150 cursor-pointer',
                  isCustomMode
                    ? 'border-ak-primary bg-ak-primary/15 text-ak-primary'
                    : 'border-dashed border-ak-border bg-transparent text-ak-text-tertiary hover:border-ak-primary/50 hover:text-ak-primary',
                )}
              >
                ✏ Kendi cevabım
              </button>
            </div>
          )}

          {/* Custom textarea */}
          {(isCustomMode || !currentQ.suggestions || currentQ.suggestions.length === 0) && (
            <textarea
              ref={textareaRef}
              value={currentAnswer}
              onChange={(e) => handleCustomInput(e.target.value)}
              rows={2}
              placeholder="Cevabınızı yazın... (boş bırakılabilir)"
              className={cn(
                'mt-2 w-full resize-none rounded-lg border bg-ak-surface-2/60 px-3 py-2 text-sm',
                'border-ak-border-subtle text-ak-text-primary placeholder:text-ak-text-tertiary',
                'focus:border-ak-primary/40 focus:outline-none focus:ring-1 focus:ring-ak-primary/20',
                'transition-colors duration-150',
              )}
            />
          )}
        </div>

        {/* Footer: navigation + submit */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={goPrev}
            disabled={currentIdx === 0}
            aria-label="Önceki soru"
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-lg border transition-colors',
              'border-ak-border-subtle text-ak-text-secondary',
              currentIdx === 0
                ? 'cursor-not-allowed opacity-30'
                : 'hover:border-ak-primary/50 hover:text-ak-primary',
            )}
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          {/* Dots */}
          <div className="flex items-center gap-1.5">
            {questions.map((q, i) => {
              const answered = (answers[q.id] ?? '').trim().length > 0;
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Soru ${i + 1}`}
                  className={cn(
                    'h-1.5 rounded-full transition-all duration-200 cursor-pointer',
                    i === currentIdx
                      ? 'w-5 bg-ak-primary'
                      : answered
                        ? 'w-1.5 bg-ak-primary/60 hover:bg-ak-primary/80'
                        : 'w-1.5 bg-ak-border hover:bg-ak-text-tertiary',
                  )}
                />
              );
            })}
          </div>

          {isLast ? (
            <button
              type="button"
              onClick={handleSubmit}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold',
                'bg-ak-primary text-[color:var(--ak-on-primary,#fff)]',
                'hover:brightness-110 hover:shadow-md hover:shadow-ak-primary/30 active:brightness-95',
                'transition-all duration-150',
              )}
            >
              Gönder
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              aria-label="Sonraki soru"
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-lg border transition-colors',
                'border-ak-border-subtle text-ak-text-secondary',
                'hover:border-ak-primary/50 hover:text-ak-primary',
              )}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
