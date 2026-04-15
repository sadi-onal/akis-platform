import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { cn } from '../../utils/cn';

interface ChatInputProps {
  onSend: (message: string) => void;
  onCancel?: () => void;
  disabled?: boolean;
  showCancel?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, onCancel, disabled, showCancel, placeholder }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea (1–6 lines, max ~144px)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [value]);

  // Focus on mount and when enabled
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setValue('');
        textareaRef.current?.blur();
      }
    },
    [handleSend],
  );

  return (
    <div className="shrink-0 px-6 pb-2 pt-4">
      {/* Floating pill container */}
      <div
        className={cn(
          'mx-auto flex max-w-3xl items-end gap-2',
          'rounded-3xl border border-ak-border/50 bg-ak-surface px-5 py-2',
          'shadow-lg',
          'transition-all duration-200',
          'focus-within:border-ak-primary/30 focus-within:shadow-[0_0_20px_rgba(7,209,175,0.10)]',
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder ?? 'Projenizi anlatın...'}
          rows={1}
          aria-label="Mesaj yaz"
          className={cn(
            'flex-1 resize-none border-none bg-transparent py-1 text-[15px] leading-relaxed text-ak-text-primary outline-none',
            'placeholder:text-gray-400',
            'min-h-[24px] max-h-36',
            disabled && 'cursor-not-allowed opacity-70 saturate-50',
          )}
        />
        {showCancel ? (
          <button
            onClick={onCancel}
            aria-label="İptal et"
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
              'bg-red-500/10 text-red-400',
              'hover:bg-red-500/20 active:scale-95',
              'transition-all duration-150',
            )}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={disabled || !value.trim()}
            aria-label="Gönder"
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
              'bg-[#07D1AF] text-white',
              'hover:brightness-110 active:scale-95',
              'transition-all duration-150',
              (disabled || !value.trim()) && 'cursor-not-allowed opacity-40',
            )}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
            </svg>
          </button>
        )}
      </div>

      {/* Helper text */}
      <div className="mx-auto mt-1.5 hidden max-w-3xl items-center justify-center gap-4 text-xs text-gray-400 sm:flex">
        <span><kbd className="rounded bg-ak-surface-2 px-1 py-0.5 font-mono text-[9px]">⏎</kbd> Gonder</span>
        <span><kbd className="rounded bg-ak-surface-2 px-1 py-0.5 font-mono text-[9px]">⇧⏎</kbd> Yeni satir</span>
        <span><kbd className="rounded bg-ak-surface-2 px-1 py-0.5 font-mono text-[9px]">Esc</kbd> Temizle</span>
      </div>
    </div>
  );
}
