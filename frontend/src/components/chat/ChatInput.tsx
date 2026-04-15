import { useState, useRef, useCallback, useEffect, type KeyboardEvent, type DragEvent, type ChangeEvent } from 'react';
import { cn } from '../../utils/cn';
import { toast } from '../ui/Toast';

export interface ChatAttachment {
  id: string;
  file: File;
  preview?: string;   // data URL for images
  type: 'image' | 'document';
}

interface ChatInputProps {
  onSend: (message: string, attachments?: ChatAttachment[]) => void;
  onCancel?: () => void;
  disabled?: boolean;
  showCancel?: boolean;
  placeholder?: string;
}

const ACCEPT_TYPES = 'image/png,image/jpeg,image/gif,image/webp,.pdf,.md,.txt,.json,.ts,.tsx,.js,.jsx,.html,.css';
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

let _attachId = 0;

export function ChatInput({ onSend, onCancel, disabled, showCancel, placeholder }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea (1–6 lines)
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

  // Cleanup preview URLs
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.preview) URL.revokeObjectURL(a.preview);
      });
    };
  }, [attachments]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const newAttachments: ChatAttachment[] = [];
    const acceptedExtensions = ACCEPT_TYPES.split(',');

    for (const file of fileArray) {
      if (attachments.length + newAttachments.length >= MAX_FILES) {
        toast('Maksimum 5 dosya yüklenebilir.', 'error');
        break;
      }
      if (file.size > MAX_FILE_SIZE) {
        toast(`Dosya çok büyük: ${file.name}. Maksimum dosya boyutu 10MB.`, 'error');
        continue;
      }

      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      const isAccepted = file.type.startsWith('image/') || acceptedExtensions.includes(file.type) || acceptedExtensions.includes(ext);
      if (!isAccepted) {
        toast(`Desteklenmeyen dosya türü: ${file.name}`, 'error');
        continue;
      }

      const isImage = file.type.startsWith('image/');
      const attachment: ChatAttachment = {
        id: `att-${++_attachId}`,
        file,
        type: isImage ? 'image' : 'document',
        preview: isImage ? URL.createObjectURL(file) : undefined,
      };
      newAttachments.push(attachment);
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
  }, [attachments.length]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled) return;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setValue('');
    setAttachments([]);
  }, [value, attachments, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setValue('');
        setAttachments([]);
        textareaRef.current?.blur();
      }
    },
    [handleSend],
  );

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) addFiles(e.target.files);
      e.target.value = '';
    },
    [addFiles],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles],
  );

  const hasContent = value.trim().length > 0 || attachments.length > 0;

  return (
    <div className="shrink-0 px-4 pb-3 pt-3">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'mx-auto max-w-3xl',
          'rounded-2xl border bg-ak-surface',
          'shadow-lg shadow-black/10',
          'transition-all duration-200',
          isDragOver
            ? 'border-ak-primary/50 shadow-[0_0_24px_rgba(7,209,175,0.15)] ring-2 ring-ak-primary/20'
            : 'border-ak-border/40 focus-within:border-ak-primary/30 focus-within:shadow-[0_0_20px_rgba(7,209,175,0.08)]',
        )}
      >
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="group relative flex items-center gap-2 rounded-lg border border-ak-border-subtle bg-ak-surface-2/60 px-2.5 py-1.5"
              >
                {att.type === 'image' && att.preview ? (
                  <img
                    src={att.preview}
                    alt={att.file.name}
                    className="h-8 w-8 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded bg-ak-surface-2 text-ak-text-tertiary">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                    </svg>
                  </div>
                )}
                <span className="max-w-[120px] truncate text-xs text-ak-text-secondary">{att.file.name}</span>
                <button
                  onClick={() => removeAttachment(att.id)}
                  className="ml-0.5 rounded-full p-0.5 text-ak-text-tertiary opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                  aria-label={`${att.file.name} ekini kaldır`}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <div className="px-4 pt-3 pb-1.5">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={disabled}
            placeholder={placeholder ?? 'Projenizi anlatın...'}
            rows={1}
            aria-label="Mesaj yaz"
            className={cn(
              'w-full resize-none border-none bg-transparent text-[15px] leading-relaxed text-ak-text-primary outline-none',
              'placeholder:text-ak-text-tertiary/60',
              'min-h-[24px] max-h-36',
              disabled && 'cursor-not-allowed opacity-70 saturate-50',
            )}
          />
        </div>

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-3 pb-2.5">
          {/* Left: action buttons */}
          <div className="flex items-center gap-0.5">
            {/* Attachment button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || attachments.length >= MAX_FILES}
              title="Dosya ekle"
              aria-label="Dosya ekle"
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg',
                'text-ak-text-tertiary hover:bg-ak-surface-2 hover:text-ak-text-secondary',
                'transition-colors duration-150',
                (disabled || attachments.length >= MAX_FILES) && 'cursor-not-allowed opacity-40',
              )}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_TYPES}
              multiple
              onChange={handleFileChange}
              className="hidden"
              aria-hidden
            />

            {/* Image button */}
            <button
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.multiple = true;
                input.onchange = (e) => {
                  const files = (e.target as HTMLInputElement).files;
                  if (files) addFiles(files);
                };
                input.click();
              }}
              disabled={disabled || attachments.length >= MAX_FILES}
              title="Resim ekle"
              aria-label="Resim ekle"
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-lg',
                'text-ak-text-tertiary hover:bg-ak-surface-2 hover:text-ak-text-secondary',
                'transition-colors duration-150',
                (disabled || attachments.length >= MAX_FILES) && 'cursor-not-allowed opacity-40',
              )}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
              </svg>
            </button>

            {/* Separator */}
            <div className="mx-1 h-4 w-px bg-ak-border-subtle" />

            {/* Shortcuts hint */}
            <div className="hidden items-center gap-2 text-[11px] text-ak-text-tertiary/50 sm:flex">
              <span><kbd className="rounded bg-ak-surface-2/60 px-1 py-0.5 font-mono text-[9px]">⏎</kbd> Gonder</span>
              <span><kbd className="rounded bg-ak-surface-2/60 px-1 py-0.5 font-mono text-[9px]">⇧⏎</kbd> Yeni satir</span>
            </div>
          </div>

          {/* Right: send/cancel */}
          <div className="flex items-center gap-2">
            {showCancel ? (
              <button
                onClick={onCancel}
                aria-label="İptal et"
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg',
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
                disabled={disabled || !hasContent}
                aria-label="Gönder"
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg',
                  'transition-all duration-150',
                  hasContent && !disabled
                    ? 'bg-ak-primary text-white hover:brightness-110 active:scale-95'
                    : 'bg-ak-surface-2 text-ak-text-tertiary cursor-not-allowed opacity-50',
                )}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Drag overlay message */}
      {isDragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-ak-primary bg-ak-surface/90 px-8 py-6 text-center">
            <p className="text-sm font-medium text-ak-primary">Dosyaları buraya bırakın</p>
            <p className="mt-1 text-xs text-ak-text-tertiary">Resim, PDF, kod dosyaları</p>
          </div>
        </div>
      )}
    </div>
  );
}
