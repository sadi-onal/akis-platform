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
  isSending?: boolean;
  showCancel?: boolean;
  placeholder?: string;
}

const ACCEPT_TYPES = 'image/png,image/jpeg,image/gif,image/webp,.pdf,.md,.txt,.json,.ts,.tsx,.js,.jsx,.html,.css';
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// Expanded textarea max-height is viewport-aware so long-form drafting stays usable on laptops
// without scrolling the page underneath the input.
const COLLAPSED_MAX_H_CAP = 360;
const EXPANDED_MAX_H_CAP = 600;

function computeTextareaMaxHeight(expanded: boolean): number {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  return expanded
    ? Math.min(vh * 0.7, EXPANDED_MAX_H_CAP)
    : Math.min(vh * 0.4, COLLAPSED_MAX_H_CAP);
}

let _attachId = 0;

// Height in pixels above which we consider the textarea "overflowing" the collapsed
// view and start offering the expand toggle. Below this threshold the expand button is
// hidden so it doesn't clutter the UI when the user is writing a one-line prompt.
// Issue #391 / BUG-11: "expand butonu gerektiğinde çıksın sadece".
const EXPAND_THRESHOLD_PX = 200;

export function ChatInput({ onSend, onCancel, disabled, isSending, showCancel, placeholder }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastSendAtRef = useRef<number>(0);

  // Auto-resize textarea; max-height is viewport-aware and grows when expanded.
  // Also tracks whether the content has grown past EXPAND_THRESHOLD_PX so the
  // expand button can be hidden until it's actually useful.
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

  // Focus on mount and when enabled
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  // NOTE: blob preview URLs are intentionally NOT revoked when attachments
  // change or on send — the sent user message bubble reuses the same URL to
  // render its inline thumbnail (issue #464 BUG-C). They are revoked only
  // when the user explicitly removes a chip before sending (see
  // `removeAttachment`), and we rely on the browser reclaiming blob URLs on
  // tab/document unload for the rest.

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
    if (isSending || disabled) return;
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    const now = Date.now();
    if (now - lastSendAtRef.current < 400) return;
    lastSendAtRef.current = now;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setValue('');
    setAttachments([]);
    setExpanded(false);
  }, [value, attachments, disabled, isSending, onSend]);

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
        setAttachments([]);
        textareaRef.current?.blur();
      }
    },
    [handleSend, isSending, disabled],
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
  const showOuterPreviews = !expanded && attachments.length > 0;
  const showInnerPreviews = expanded && attachments.length > 0;

  return (
    <div
      data-expanded={expanded ? 'true' : 'false'}
      className={cn(
        'shrink-0 mx-auto w-full px-3 sm:px-6 pt-4 pb-2',
        expanded ? 'max-w-5xl' : 'max-w-3xl md:max-w-4xl xl:max-w-5xl',
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Attachment previews — above the pill (collapsed mode only) */}
      {showOuterPreviews && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att) => (
            <AttachmentChip key={att.id} att={att} onRemove={removeAttachment} />
          ))}
        </div>
      )}

      {/* Claude-Code-style input card — dark surface, rounded-2xl, vertical layout */}
      <div
        className={cn(
          'flex flex-col rounded-2xl border transition-all duration-200',
          'bg-white border-black/10 shadow-[0_1px_0_rgba(0,0,0,0.02),0_8px_24px_-12px_rgba(0,0,0,0.12)]',
          'dark:bg-[#12181B] dark:border-white/[0.08] dark:shadow-[0_1px_0_rgba(255,255,255,0.04),0_8px_24px_-12px_rgba(0,0,0,0.6)]',
          isDragOver && 'border-[#07D1AF]/60 ring-2 ring-[#07D1AF]/15',
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_TYPES}
          multiple
          onChange={handleFileChange}
          className="hidden"
          aria-hidden
        />

        {/* Textarea area — full-width at the top, lots of room */}
        <div className="px-4 sm:px-5 pt-3.5 sm:pt-4">
          {showInnerPreviews && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachments.map((att) => (
                <AttachmentChip key={att.id} att={att} onRemove={removeAttachment} />
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={disabled || isSending}
            placeholder={placeholder ?? 'Projenizi anlatın...'}
            rows={3}
            aria-label="Mesaj yaz"
            className={cn(
              'w-full border-none outline-none resize-none text-[15px] leading-relaxed bg-transparent',
              'text-gray-900 placeholder:text-gray-400',
              'dark:text-white dark:placeholder:text-white/30',
              // Taller default — Claude Code feel. 112px min (~4 visible lines) collapsed, 280px expanded.
              expanded ? 'min-h-[280px]' : 'min-h-[112px]',
              (disabled || isSending) && 'cursor-not-allowed opacity-70 saturate-50',
            )}
          />
        </div>

        {/* Footer strip — attachment + expand on left, send on right, like Claude Code */}
        <div className="flex items-center gap-1 px-2 sm:px-3 pb-2.5 pt-1">
          {/* Attachment button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attachments.length >= MAX_FILES}
            title="Dosya ekle"
            aria-label="Dosya ekle"
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
              'text-gray-400 hover:bg-black/5 hover:text-gray-600',
              'dark:hover:bg-white/[0.06] dark:hover:text-white/80',
              'transition-colors duration-150',
              (disabled || attachments.length >= MAX_FILES) && 'cursor-not-allowed opacity-40',
            )}
          >
            <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
          </button>

          {/* Expand / collapse toggle — only render when content overflows or already expanded. */}
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
              !expanded && !isOverflowing && 'hidden',
            )}
          >
            {expanded ? (
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
              </svg>
            ) : (
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9M20.25 20.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            )}
          </button>

          <div className="flex-1" />

          {/* Send / Cancel button */}
          {showCancel ? (
            <button
              onClick={onCancel}
              aria-label="İptal et"
              className={cn(
                'h-8 w-8 rounded-lg flex items-center justify-center transition-colors shrink-0',
                'bg-red-500/10 text-red-400 hover:bg-red-500/20 active:scale-95',
              )}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed dark:bg-white/[0.06] dark:text-white/20',
              )}
            >
              <svg className="h-[18px] w-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Helper text row (hidden on mobile) */}
      <div className="text-xs text-gray-400/60 mt-1.5 text-center hidden sm:block">
        ⏎ Gönder&nbsp;&nbsp;⇧⏎ Yeni satır&nbsp;&nbsp;Esc Temizle
      </div>

      {/* Drag overlay message */}
      {isDragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-[#07D1AF] bg-white/90 dark:bg-[#0A1215]/90 px-8 py-6 text-center">
            <p className="text-sm font-medium text-[#07D1AF]">Dosyaları buraya bırakın</p>
            <p className="mt-1 text-xs text-gray-400">Resim, PDF, kod dosyaları</p>
          </div>
        </div>
      )}
    </div>
  );
}

interface AttachmentChipProps {
  att: ChatAttachment;
  onRemove: (id: string) => void;
}

function AttachmentChip({ att, onRemove }: AttachmentChipProps) {
  return (
    <div className="group relative flex items-center gap-2 rounded-lg border border-black/5 bg-gray-50 px-2.5 py-1.5 dark:border-white/10 dark:bg-white/[0.05]">
      {att.type === 'image' && att.preview ? (
        <img src={att.preview} alt={att.file.name} className="h-8 w-8 rounded object-cover" />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded bg-gray-100 text-gray-400 dark:bg-white/[0.08] dark:text-gray-500">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        </div>
      )}
      <span className="max-w-[120px] truncate text-xs text-gray-500 dark:text-gray-400">{att.file.name}</span>
      <button
        onClick={() => onRemove(att.id)}
        className="ml-0.5 rounded-full p-0.5 text-gray-400 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
        aria-label={`${att.file.name} ekini kaldır`}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
