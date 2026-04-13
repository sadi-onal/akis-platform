import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { cn } from '../../utils/cn';
import type { ConversationStatus } from '../../types/chat';

interface ConversationItemProps {
  id: string;
  title: string;
  repoFullName: string;
  status: ConversationStatus;
  fileCount: number;
  lastActivity: string;
  isActive: boolean;
  collapsed?: boolean;
  onClick: () => void;
  onRename?: (newTitle: string) => void;
  onDelete?: () => void;
}

const STATUS_DOT: Record<ConversationStatus, string> = {
  idle: 'bg-green-400',
  running: 'bg-yellow-400 animate-pulse',
  awaiting_approval: 'bg-orange-400',
  error: 'bg-red-400',
};

function relativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'az önce';
    if (mins < 60) return `${mins}dk`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}sa`;
    const days = Math.floor(hrs / 24);
    return `${days}g`;
  } catch {
    return '';
  }
}

export function ConversationItem({
  title,
  repoFullName,
  status,
  fileCount,
  lastActivity,
  isActive,
  collapsed,
  onClick,
  onRename,
  onDelete,
}: ConversationItemProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showMenu]);

  const handleRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== title) {
      onRename?.(trimmed);
    }
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleRename();
    if (e.key === 'Escape') { setEditValue(title); setEditing(false); }
  };

  if (collapsed) {
    return (
      <button
        onClick={onClick}
        aria-label={title}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
          isActive ? 'bg-ak-primary/10 text-ak-primary' : 'text-ak-text-secondary hover:bg-ak-surface-2',
        )}
      >
        <div className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
      </button>
    );
  }

  return (
    <div className="group relative">
      <button
        onClick={onClick}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-all duration-150',
          isActive
            ? 'bg-ak-primary/[0.08] border-l-2 border-ak-primary pl-2.5'
            : 'border-l-2 border-transparent hover:bg-ak-surface-2/50 hover:scale-[1.01] hover:border-ak-border-subtle',
        )}
      >
        {/* Title row */}
        <div className="flex items-center gap-2">
          <div className={cn('h-2 w-2 flex-shrink-0 rounded-full', STATUS_DOT[status])} />
          {editing ? (
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleRename}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-ak-primary bg-ak-surface-2 px-1 py-0 text-[12px] font-medium text-ak-text-primary outline-none"
            />
          ) : (
            <span className={cn(
              'truncate text-[12px] font-medium',
              isActive ? 'text-ak-primary' : 'text-ak-text-primary',
            )}>{title}</span>
          )}
        </div>
        {/* Info row */}
        <div className="flex items-center gap-1 pl-4">
          <span className="truncate text-[10px] text-ak-text-tertiary">{repoFullName}</span>
          <span className="ml-auto flex-shrink-0 text-[10px] text-ak-text-tertiary">
            {fileCount > 0 && `${fileCount} dosya · `}{relativeTime(lastActivity)}
          </span>
        </div>
      </button>

      {/* Context menu trigger — appears on hover */}
      {!editing && (onRename || onDelete) && (
        <button
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
          className={cn(
            'absolute right-1 top-1.5 flex h-5 w-5 items-center justify-center rounded text-ak-text-tertiary transition-opacity',
            'opacity-0 hover:bg-ak-surface-2 hover:text-ak-text-secondary group-hover:opacity-100',
            showMenu && 'opacity-100',
          )}
          aria-label="Sohbet seçenekleri"
        >
          <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 16 16">
            <circle cx="8" cy="3" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="8" cy="13" r="1.5" />
          </svg>
        </button>
      )}

      {/* Dropdown menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="absolute right-0 top-8 z-50 w-36 rounded-lg border border-ak-border bg-ak-surface py-1 shadow-lg"
        >
          {onRename && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(false);
                setEditValue(title);
                setEditing(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
              </svg>
              Yeniden Adlandır
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-red-400 hover:bg-red-500/10"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
              Sil
            </button>
          )}
        </div>
      )}
    </div>
  );
}
