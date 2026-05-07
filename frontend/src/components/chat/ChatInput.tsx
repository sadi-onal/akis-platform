import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { cn } from '../../utils/cn';

// Type kept for historical-message rendering and the workflows API client.
// The composer below no longer creates new attachments.
export interface ChatAttachment {
  id: string;
  file: File;
  preview?: string;
  type: 'image' | 'document';
}

interface ChatInputProps {
  onSend: (message: string, attachments?: ChatAttachment[]) => void;
  onCancel?: () => void;
  disabled?: boolean;
  isSending?: boolean;
  showCancel?: boolean;
  placeholder?: string;
}

const COLLAPSED_MAX_H_CAP = 360;
const EXPANDED_MAX_H_CAP = 600;
const EXPAND_THRESHOLD_PX = 200;

function computeTextareaMaxHeight(expanded: boolean): number {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  return expanded
    ? Math.min(vh * 0.7, EXPANDED_MAX_H_CAP)
    : Math.min(vh * 0.4, COLLAPSED_MAX_H_CAP);
}

export function ChatInput({
  onSend,
  onCancel,
  disabled,
  isSending,
  showCancel,
  placeholder,
}: ChatInputProps) {
  const [value, setValue] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastSendAtRef = useRef<number>(0);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const maxH = computeTextareaMaxHeight(expanded);
    el.style.maxHeight = `${maxH}px`;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, maxH);
    el.style.height = `${next}px`;
    setIsOverflowing(el.scrollHeight > EXPAND_THRESHOLD_PX);
  }, [value, expanded]);

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const handleSend = useCallback(() => {
    if (isSending || disabled) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const now = Date.now();
    if (now - lastSendAtRef.current < 400) return;
    lastSendAtRef.current = now;
    onSend(trimmed);
    setValue('');
    setExpanded(false);
  }, [value, disabled, isSending, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isSending || disabled) return;
        handleSend();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setValue('');
        textareaRef.current?.blur();
      }
    },
    [handleSend, isSending, disabled]
  );

  const hasContent = value.trim().length > 0;

  return (
    <div
      data-expanded={expanded ? 'true' : 'false'}
      className={cn(
        'shrink-0 mx-auto w-full px-3 sm:px-6 pt-2 pb-2',
        expanded ? 'max-w-6xl' : 'max-w-4xl md:max-w-5xl xl:max-w-6xl'
      )}
    >
      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border px-3 py-2 transition-all duration-200',
          'bg-white border-black/10 shadow-[0_1px_0_rgba(0,0,0,0.02),0_8px_24px_-12px_rgba(0,0,0,0.12)]',
          'dark:bg-[#12181B] dark:border-white/[0.08] dark:shadow-[0_1px_0_rgba(255,255,255,0.04),0_8px_24px_-12px_rgba(0,0,0,0.6)]',
          // When the pipeline is running the composer is disabled but still
          // accepts a "deferred" message — surface that with a soft primary
          // halo so the user feels the system is busy, not broken.
          disabled && 'border-ak-primary/40 shadow-[0_0_0_3px_rgba(7,209,175,0.10)]'
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isSending}
          placeholder={placeholder ?? 'Projenizi anlatın...'}
          rows={1}
          aria-label="Mesaj yaz"
          className={cn(
            'flex-1 self-center border-none outline-none resize-none bg-transparent',
            'text-[15px] leading-6 py-1',
            'text-gray-900 placeholder:text-gray-400',
            'dark:text-white dark:placeholder:text-white/30',
            expanded ? 'min-h-[240px]' : 'min-h-[24px]',
            (disabled || isSending) && 'cursor-not-allowed opacity-70 saturate-50'
          )}
        />

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Küçült' : 'Büyük yaz'}
          aria-pressed={expanded}
          title={expanded ? 'Küçült' : 'Büyük yaz'}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            'text-gray-400 hover:bg-black/5 hover:text-gray-600',
            'dark:hover:bg-white/[0.06] dark:hover:text-white/80',
            'transition-colors duration-150',
            !expanded && !isOverflowing && 'hidden'
          )}
        >
          {expanded ? (
            <svg
              className="h-[18px] w-[18px]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25"
              />
            </svg>
          ) : (
            <svg
              className="h-[18px] w-[18px]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.8}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9M20.25 20.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
              />
            </svg>
          )}
        </button>

        {showCancel ? (
          <button
            onClick={onCancel}
            aria-label="İptal et"
            className={cn(
              'h-8 w-8 rounded-lg flex items-center justify-center transition-colors shrink-0',
              'bg-red-500/10 text-red-400 hover:bg-red-500/20 active:scale-95'
            )}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={disabled || isSending || !hasContent}
            aria-busy={isSending ? 'true' : undefined}
            aria-label="Gönder"
            className={cn(
              'h-8 w-8 rounded-lg flex items-center justify-center transition-colors shrink-0',
              hasContent && !disabled && !isSending
                ? 'bg-[#07D1AF] hover:bg-[#06B89A] text-white active:scale-95'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-white/[0.06] dark:text-white/20'
            )}
          >
            <svg
              className="h-[18px] w-[18px]"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.4}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18"
              />
            </svg>
          </button>
        )}
      </div>

      <div className="text-[10px] text-gray-400/40 mt-1 text-center hidden sm:block">
        ⏎ Gönder&nbsp;&nbsp;⇧⏎ Yeni satır&nbsp;&nbsp;Esc Temizle
      </div>
    </div>
  );
}
