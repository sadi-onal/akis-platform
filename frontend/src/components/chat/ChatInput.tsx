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

  // Auto-resize textarea (1-5 lines)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
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
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div className={cn(
        'mx-auto flex max-w-[720px] items-end gap-2 rounded-2xl border p-2',
        'backdrop-blur-xl bg-ak-surface/80 border-ak-border/50 shadow-lg',
        'transition-all duration-200',
        'focus-within:border-ak-primary/40 focus-within:shadow-[0_0_15px_rgba(7,209,175,0.08)]',
      )}>
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
            'flex-1 resize-none rounded-xl bg-transparent px-3 py-2 text-sm text-ak-text-primary',
            'placeholder:text-ak-text-tertiary',
            'focus:outline-none',
            'transition-colors duration-150',
            disabled && 'cursor-not-allowed opacity-70 saturate-50',
          )}
        />
        {showCancel ? (
          <button
            onClick={onCancel}
            aria-label="İptal et"
            className={cn(
              'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl',
              'bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:scale-105 active:scale-95',
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
              'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl',
              'bg-ak-primary text-[color:var(--ak-on-primary)]',
              'hover:brightness-110 hover:scale-105 active:brightness-95 active:scale-95',
              'transition-all duration-150',
              (disabled || !value.trim()) && 'cursor-not-allowed opacity-40',
            )}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        )}
      </div>
      <div className="mx-auto mt-1 hidden max-w-[720px] items-center justify-center gap-3 text-[10px] text-ak-text-tertiary sm:flex">
        <span><kbd className="rounded bg-ak-surface-2 px-1 py-0.5 font-mono text-[9px]">⏎</kbd> Gonder</span>
        <span><kbd className="rounded bg-ak-surface-2 px-1 py-0.5 font-mono text-[9px]">⇧⏎</kbd> Yeni satir</span>
        <span><kbd className="rounded bg-ak-surface-2 px-1 py-0.5 font-mono text-[9px]">Esc</kbd> Temizle</span>
      </div>
    </div>
  );
}
