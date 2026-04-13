import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '../../utils/cn';
import { LOGO_MARK_SVG } from '../../theme/brand';
import type { ConversationListItem } from '../../types/chat';
import { ConversationItem } from './ConversationItem';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../theme/useTheme';

interface ConversationSidebarProps {
  conversations: ConversationListItem[];
  activeId?: string;
  onNewConversation: () => void;
  onRename?: (id: string, newTitle: string) => void;
  onDelete?: (id: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function ConversationSidebar({
  conversations,
  activeId,
  onNewConversation,
  onRename,
  onDelete,
  collapsed,
  onToggleCollapse,
}: ConversationSidebarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  // Debounce search input by 300ms
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filtered = useMemo(() => {
    if (!search.trim()) return conversations;
    const q = search.toLocaleLowerCase('tr');
    return conversations.filter(
      (c) => c.title.toLocaleLowerCase('tr').includes(q) || c.repoFullName.toLocaleLowerCase('tr').includes(q),
    );
  }, [conversations, search]);

  // Date-grouped conversations (Bugün, Dün, Bu Hafta, Daha Eski)
  const grouped = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const weekAgo = new Date(today.getTime() - 7 * 86400000);

    const groups: { label: string; items: typeof filtered }[] = [
      { label: 'Bugün', items: [] },
      { label: 'Dün', items: [] },
      { label: 'Bu Hafta', items: [] },
      { label: 'Daha Eski', items: [] },
    ];

    for (const c of filtered) {
      const d = new Date(c.lastActivity);
      if (d >= today) groups[0].items.push(c);
      else if (d >= yesterday) groups[1].items.push(c);
      else if (d >= weekAgo) groups[2].items.push(c);
      else groups[3].items.push(c);
    }

    return groups.filter((g) => g.items.length > 0);
  }, [filtered]);

  const isSettingsActive = location.pathname === '/settings';

  return (
    <div
      className={cn(
        'flex h-full flex-col border-r border-ak-border bg-[var(--ak-bg-sidebar,var(--ak-bg))]',
        'transition-[width] duration-200 ease-out',
      )}
      style={{ width: collapsed ? 64 : 280 }}
    >
      {/* Logo */}
      <div className={cn(
        'flex items-center pt-4 pb-3',
        collapsed ? 'justify-center px-2' : 'px-5',
      )}>
        {collapsed ? (
          <img src={LOGO_MARK_SVG} alt="AKIS" className="h-8 w-8 object-contain" />
        ) : (
          <div className="flex items-center gap-2.5">
            <img src={LOGO_MARK_SVG} alt="AKIS" className="h-12 w-12 object-contain" />
            <div className="flex flex-col">
              <span className="text-xl font-extrabold leading-tight tracking-tight text-ak-primary">AKIS</span>
              <span className="text-[9px] font-semibold uppercase tracking-[0.2em] text-ak-text-tertiary">Platform</span>
            </div>
          </div>
        )}
      </div>

      {/* Search + New */}
      {!collapsed && (
        <div className="space-y-2 px-3 pb-2">
          <input
            type="text"
            data-sidebar-search
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Sohbet ara... (Ctrl+K)"
            aria-label="Sohbet ara"
            className={cn(
              'w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-1.5 text-xs text-ak-text-primary',
              'placeholder:text-ak-text-tertiary',
              'focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30',
            )}
          />
          <button
            onClick={onNewConversation}
            className={cn(
              'flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs font-medium text-ak-text-secondary',
              'hover:border-emerald-400 hover:text-ak-primary hover:bg-ak-surface-2/50 transition-colors',
            )}
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Yeni Sohbet
          </button>
        </div>
      )}

      {collapsed && (
        <div className="flex justify-center px-2 pb-2">
          <button
            onClick={onNewConversation}
            aria-label="Yeni Sohbet"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-dashed border-gray-300 text-ak-text-secondary hover:border-emerald-400 hover:text-ak-primary transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      )}

      {/* Divider */}
      <div className="mx-3 border-t border-ak-border-subtle" />

      {/* Conversation list — date grouped */}
      <div className={cn('flex-1 overflow-y-auto', collapsed ? 'px-2 py-2 space-y-1' : 'px-2 py-2')}>
        {filtered.length === 0 && !collapsed && (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <svg className="h-8 w-8 text-ak-text-tertiary/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              {search ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
              )}
            </svg>
            <p className="text-[11px] text-ak-text-tertiary">
              {search ? 'Sonuç bulunamadı.' : 'Henüz sohbet yok.'}
            </p>
            {!search && (
              <button
                onClick={onNewConversation}
                className="mt-1 rounded-lg border border-dashed border-ak-primary/40 px-3 py-1.5 text-[11px] font-medium text-ak-primary hover:bg-ak-primary/10 transition-colors"
              >
                Yeni Sohbet Başlat
              </button>
            )}
          </div>
        )}
        {!collapsed ? (
          grouped.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-ak-text-tertiary">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((conv) => (
                  <ConversationItem
                    key={conv.id}
                    {...conv}
                    isActive={conv.id === activeId}
                    collapsed={collapsed}
                    onClick={() => navigate(`/chat/${conv.id}`)}
                    onRename={onRename ? (newTitle) => onRename(conv.id, newTitle) : undefined}
                    onDelete={onDelete ? () => {
                      if (window.confirm('Bu sohbeti silmek istediğinize emin misiniz?')) {
                        onDelete(conv.id);
                      }
                    } : undefined}
                  />
                ))}
              </div>
            </div>
          ))
        ) : (
          filtered.map((conv) => (
            <ConversationItem
              key={conv.id}
              {...conv}
              isActive={conv.id === activeId}
              collapsed={collapsed}
              onClick={() => navigate(`/chat/${conv.id}`)}
              onRename={onRename ? (newTitle) => onRename(conv.id, newTitle) : undefined}
              onDelete={onDelete ? () => {
                      if (window.confirm('Bu sohbeti silmek istediğinize emin misiniz?')) {
                        onDelete(conv.id);
                      }
                    } : undefined}
            />
          ))
        )}
      </div>

      {/* Divider */}
      <div className="mx-3 border-t border-ak-border-subtle" />

      {/* Bottom nav */}
      <div className={cn('space-y-0.5 px-2 py-2', collapsed && 'flex flex-col items-center')}>
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className={cn(
            'flex items-center gap-2.5 rounded-lg text-[13px] font-medium transition-colors',
            collapsed ? 'h-9 w-9 justify-center' : 'w-full px-3 py-2',
            'text-ak-text-secondary hover:bg-ak-surface-2/50 hover:text-ak-text-primary',
          )}
          aria-label={isDark ? 'Aydınlık mod' : 'Karanlık mod'}
        >
          {isDark ? (
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
            </svg>
          ) : (
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
            </svg>
          )}
          {!collapsed && (isDark ? 'Aydınlık Mod' : 'Karanlık Mod')}
        </button>
        <button
          onClick={() => navigate('/settings')}
          className={cn(
            'flex items-center gap-2.5 rounded-lg text-[13px] font-medium transition-colors',
            collapsed ? 'h-9 w-9 justify-center' : 'w-full px-3 py-2',
            isSettingsActive ? 'bg-ak-surface-2 text-ak-text-primary' : 'text-ak-text-secondary hover:bg-ak-surface-2/50 hover:text-ak-text-primary',
          )}
          aria-label="Ayarlar"
        >
          <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {!collapsed && 'Ayarlar'}
        </button>
      </div>

      {/* User info */}
      {user && !collapsed && (
        <div className="border-t border-ak-border-subtle px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-ak-primary/20 text-xs font-semibold text-ak-primary">
              {user.name?.[0]?.toUpperCase() ?? user.email?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-ak-text-primary">{user.name ?? user.email}</p>
            </div>
            <button
              onClick={() => { logout(); navigate('/login'); }}
              aria-label="Çıkış"
              className="flex-shrink-0 rounded p-1 text-ak-text-tertiary hover:text-red-400 transition-colors"
              title="Çıkış Yap"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Version */}
      <div className={cn('border-t border-ak-border-subtle px-3 py-2', collapsed && 'px-0 text-center')}>
        {collapsed ? (
          <button
            onClick={onToggleCollapse}
            aria-label="Genişlet"
            className="mx-auto flex h-7 w-7 items-center justify-center rounded-lg text-ak-text-tertiary hover:bg-ak-surface-2 hover:text-ak-text-secondary"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-ak-text-tertiary">AKIS v0.5.0</span>
            <button
              onClick={onToggleCollapse}
              aria-label="Daralt"
              className="hidden rounded-lg p-1 text-ak-text-tertiary hover:bg-ak-surface-2 hover:text-ak-text-secondary lg:flex"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
