import { useState, useEffect, useRef, useMemo } from 'react';
import { cn } from '../../utils/cn';
import type { PipelineActivity } from '../../hooks/usePipelineStream';

type PreviewView = 'web' | 'mobile';
type PanelTab = 'preview' | 'console' | 'files';

interface PreviewPanelProps {
  files: Record<string, string> | null;
  title?: string;
  loading?: boolean;
  branch?: string;
  activities?: PipelineActivity[];
  createdFiles?: string[];
}

/** Strip leading slashes from file keys — StackBlitz expects 'src/App.tsx', not '/src/App.tsx' */
function normalizeFiles(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const clean = key.startsWith('/') ? key.slice(1) : key;
    out[clean] = value;
  }

  // Inject StackBlitz startCommand into package.json if missing
  if (out['package.json']) {
    try {
      const pkg = JSON.parse(out['package.json']);
      if (!pkg.stackblitz) {
        pkg.stackblitz = {
          installDependencies: true,
          startCommand: pkg.scripts?.dev ? 'npm run dev'
            : pkg.scripts?.start ? 'npm start'
            : 'npm run dev',
        };
        out['package.json'] = JSON.stringify(pkg, null, 2);
      }
    } catch { /* preserve original */ }
  }

  return out;
}

function findMainFile(files: Record<string, string>): string {
  const priorities = [
    'src/App.tsx', 'src/App.jsx', 'src/App.js',
    'src/index.tsx', 'src/index.jsx', 'src/index.js',
    'src/main.tsx', 'src/main.jsx', 'src/main.js',
    'index.html', 'App.jsx', 'App.js',
  ];
  for (const p of priorities) {
    if (files[p]) return p;
  }
  return Object.keys(files)[0] || 'index.html';
}

function detectTemplate(files: Record<string, string>): 'node' | 'html' {
  if (files['package.json']) return 'node';
  if (files['index.html']) return 'html';
  return 'node';
}

/* ── Language icon helper ─────────────────── */
const LANG_ICONS: Record<string, { icon: string; color: string }> = {
  tsx: { icon: 'TS', color: '#3178c6' },
  ts: { icon: 'TS', color: '#3178c6' },
  jsx: { icon: 'JS', color: '#f7df1e' },
  js: { icon: 'JS', color: '#f7df1e' },
  json: { icon: '{}', color: '#a0a0a0' },
  css: { icon: '#', color: '#264de4' },
  html: { icon: '<>', color: '#e34c26' },
  md: { icon: 'M', color: '#ffffff' },
  svg: { icon: 'SV', color: '#ffb13b' },
};

function getFileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_ICONS[ext] ?? { icon: '·', color: '#666' };
}

function countLines(content: string) {
  return content.split('\n').length;
}

/* ── Console Log Entry ────────────────────── */
function ConsoleEntry({ activity }: { activity: PipelineActivity }) {
  const isError = activity.step === 'error';
  const isComplete = activity.step === 'complete';
  const time = activity.timestamp ? new Date(activity.timestamp).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

  return (
    <div className={cn(
      'flex gap-2 px-3 py-1 font-mono text-xs leading-relaxed',
      isError ? 'text-red-400 bg-red-500/5' : isComplete ? 'text-green-400' : 'text-ak-text-secondary',
    )}>
      <span className="flex-shrink-0 text-ak-text-tertiary">{time}</span>
      <span className={cn(
        'flex-shrink-0 w-5 text-center',
        activity.stage === 'scribe' ? 'text-blue-400' :
        activity.stage === 'proto' ? 'text-orange-400' :
        activity.stage === 'trace' ? 'text-purple-400' : 'text-ak-text-tertiary',
      )}>
        {activity.stage === 'scribe' ? 'S' : activity.stage === 'proto' ? 'P' : activity.stage === 'trace' ? 'T' : '-'}
      </span>
      <span className="min-w-0 flex-1 break-words">{activity.message}</span>
    </div>
  );
}

/* ── Main Component ───────────────────────── */
export function PreviewPanel({ files, title, loading: externalLoading, branch, activities, createdFiles }: PreviewPanelProps) {
  const [tab, setTab] = useState<PanelTab>('preview');
  const [view, setView] = useState<PreviewView>('web');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Auto-scroll console to bottom
  useEffect(() => {
    if (tab === 'console' && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activities?.length, tab]);

  // StackBlitz embed
  useEffect(() => {
    if (!files || Object.keys(files).length === 0 || !containerRef.current) return;

    const container = containerRef.current;
    let cancelled = false;

    async function loadPreview() {
      try {
        setStatus('loading');
        setError(null);
        container.innerHTML = '';

        // Ensure container is mounted and visible before embedding
        if (!container.isConnected || container.offsetParent === null) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (cancelled || !container.isConnected) return;

        const sdk = await import('@stackblitz/sdk');
        if (cancelled) return;

        const normalized = normalizeFiles(files!);
        const template = detectTemplate(normalized);
        const mainFile = findMainFile(normalized);

        await sdk.default.embedProject(
          container,
          { title: title || 'AKIS Preview', description: 'Generated by AKIS Pipeline', template, files: normalized },
          { openFile: mainFile, view: 'preview', hideNavigation: true, height: '100%' },
        );

        if (!cancelled) setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          if (import.meta.env.DEV) console.error('Preview error:', err);
          const msg = err instanceof Error ? err.message : 'Önizleme yüklenemedi';
          setError(msg.includes('Invalid Element') ? 'Önizleme başlatılamadı — lütfen "Tekrar Dene" butonunu kullanın.' : msg);
          setStatus('error');
        }
      }
    }

    loadPreview();
    return () => { cancelled = true; container.innerHTML = ''; };
  }, [files, title, retryKey]);

  const isLoading = externalLoading || status === 'loading';

  // Build file tree structure
  type FileEntry = { path: string; content: string; lines: number };
  const fileTree = useMemo((): { folders: Map<string, FileEntry[]>; root: FileEntry[] } => {
    const folders = new Map<string, FileEntry[]>();
    const root: FileEntry[] = [];
    if (!files) return { folders, root };
    const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));

    for (const [path, content] of entries) {
      const parts = path.split('/');
      if (parts.length > 1) {
        const folder = parts.slice(0, -1).join('/');
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder)!.push({ path, content, lines: countLines(content) });
      } else {
        root.push({ path, content, lines: countLines(content) });
      }
    }
    return { folders, root };
  }, [files]);

  const tabItems: { id: PanelTab; label: string; icon: string; count?: number }[] = [
    { id: 'preview', label: 'Preview', icon: '▶' },
    { id: 'console', label: 'Console', icon: '>', count: activities?.length },
    { id: 'files', label: 'Files', icon: '📁', count: files ? Object.keys(files).length : 0 },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-ak-surface">
      {/* Tab bar */}
      <div className="flex flex-shrink-0 items-center border-b border-ak-border">
        <div className="flex flex-1">
          {tabItems.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'relative flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors',
                tab === t.id
                  ? 'text-ak-text-primary'
                  : 'text-ak-text-tertiary hover:text-ak-text-secondary',
              )}
            >
              <span className="font-mono text-[10px]">{t.icon}</span>
              {t.label}
              {t.count != null && t.count > 0 && (
                <span className={cn(
                  'rounded-full px-1.5 py-0.5 text-[9px] font-bold',
                  tab === t.id ? 'bg-ak-primary/20 text-ak-primary' : 'bg-ak-surface-2 text-ak-text-tertiary',
                )}>
                  {t.count}
                </span>
              )}
              {tab === t.id && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-ak-primary" />
              )}
            </button>
          ))}
        </div>

        {/* View toggle — only for preview tab */}
        {tab === 'preview' && (
          <div className="mr-3 flex rounded-md border border-ak-border bg-ak-surface-2 p-0.5">
            <button
              onClick={() => setView('web')}
              className={cn('rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                view === 'web' ? 'bg-ak-primary/20 text-ak-primary' : 'text-ak-text-tertiary hover:text-ak-text-secondary',
              )}
            >
              Web
            </button>
            <button
              onClick={() => setView('mobile')}
              className={cn('rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                view === 'mobile' ? 'bg-ak-primary/20 text-ak-primary' : 'text-ak-text-tertiary hover:text-ak-text-secondary',
              )}
            >
              Mobile
            </button>
          </div>
        )}
      </div>

      {/* ── TAB: Preview ─────────────────────── */}
      {tab === 'preview' && (
        <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-ak-bg p-2">
          {isLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-ak-surface gap-3">
              <div className="relative h-8 w-8">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-ak-primary border-t-transparent" />
                <span className="absolute inset-0 flex items-center justify-center text-xs">⚡</span>
              </div>
              <p className="text-sm font-medium text-ak-text-secondary">
                {externalLoading ? 'Dosyalar getiriliyor...' : 'Önizleme başlatılıyor...'}
              </p>
              <div className="mt-1 h-1 w-32 overflow-hidden rounded-full bg-ak-border">
                <div className="h-full rounded-full bg-ak-primary/50" style={{ width: externalLoading ? '30%' : '60%', animation: 'pulse 2s ease-in-out infinite' }} />
              </div>
            </div>
          )}

          {error && !isLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-ak-surface gap-3 px-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10">
                <svg className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-red-400">Önizleme yüklenemedi</p>
              <p className="text-xs text-ak-text-tertiary">{error}</p>
              <button onClick={() => setRetryKey(k => k + 1)} className="mt-2 rounded-lg bg-ak-primary/10 px-4 py-2 text-xs font-medium text-ak-primary hover:bg-ak-primary/20">
                Tekrar Dene
              </button>
            </div>
          )}

          {!files && !externalLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-ak-surface gap-2 text-center">
              <p className="text-xs text-ak-text-tertiary">Henüz dosya yok. Proto tamamlandığında preview burada görünecek.</p>
            </div>
          )}

          <div
            className="overflow-hidden transition-all duration-300"
            style={view === 'mobile'
              ? { width: 390, height: 844, maxHeight: '100%', border: '8px solid var(--ak-border)', borderRadius: 32, margin: '16px auto', boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }
              : { width: '100%', height: '100%' }
            }
          >
            <div ref={containerRef} className="h-full w-full" />
          </div>
        </div>
      )}

      {/* ── TAB: Console ─────────────────────── */}
      {tab === 'console' && (
        <div className="flex flex-1 flex-col overflow-hidden bg-[#0d1117]">
          <div className="flex-1 overflow-y-auto py-2">
            {(!activities || activities.length === 0) ? (
              <div className="flex h-full items-center justify-center">
                <p className="font-mono text-xs text-ak-text-tertiary">Pipeline başlatıldığında loglar burada görünecek...</p>
              </div>
            ) : (
              <>
                {activities.map((a, i) => (
                  <ConsoleEntry key={`${a.step}-${i}`} activity={a} />
                ))}
                <div ref={consoleEndRef} />
              </>
            )}
          </div>
          {/* Console footer */}
          <div className="flex items-center justify-between border-t border-ak-border bg-ak-surface px-3 py-1.5">
            <span className="font-mono text-[10px] text-ak-text-tertiary">
              {activities?.length ?? 0} log entries
            </span>
            {createdFiles && createdFiles.length > 0 && (
              <span className="font-mono text-[10px] text-green-400">
                {createdFiles.length} files created
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── TAB: Files ───────────────────────── */}
      {tab === 'files' && (
        <div className="flex flex-1 overflow-hidden">
          {/* File tree sidebar */}
          <div className="w-56 flex-shrink-0 overflow-y-auto border-r border-ak-border bg-ak-surface py-1">
            {files && Object.keys(files).length > 0 ? (
              <>
                {/* Root files */}
                {fileTree.root?.map((f) => {
                  const icon = getFileIcon(f.path);
                  return (
                    <button
                      key={f.path}
                      onClick={() => setSelectedFile(f.path)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1 text-left text-xs transition-colors',
                        selectedFile === f.path ? 'bg-ak-primary/10 text-ak-primary' : 'text-ak-text-secondary hover:bg-ak-surface-2',
                      )}
                    >
                      <span className="flex-shrink-0 font-mono text-[9px] font-bold" style={{ color: icon.color }}>{icon.icon}</span>
                      <span className="truncate font-mono">{f.path}</span>
                      <span className="ml-auto flex-shrink-0 text-[10px] text-ak-text-tertiary">{f.lines}L</span>
                    </button>
                  );
                })}
                {/* Folders */}
                {fileTree.folders && [...fileTree.folders.entries()].map(([folder, folderFiles]) => (
                  <div key={folder}>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ak-text-tertiary">
                      <span>📂</span> {folder}
                    </div>
                    {folderFiles.map((f) => {
                      const icon = getFileIcon(f.path);
                      const fileName = f.path.split('/').pop();
                      return (
                        <button
                          key={f.path}
                          onClick={() => setSelectedFile(f.path)}
                          className={cn(
                            'flex w-full items-center gap-2 pl-6 pr-3 py-1 text-left text-xs transition-colors',
                            selectedFile === f.path ? 'bg-ak-primary/10 text-ak-primary' : 'text-ak-text-secondary hover:bg-ak-surface-2',
                          )}
                        >
                          <span className="flex-shrink-0 font-mono text-[9px] font-bold" style={{ color: icon.color }}>{icon.icon}</span>
                          <span className="truncate font-mono">{fileName}</span>
                          <span className="ml-auto flex-shrink-0 text-[10px] text-ak-text-tertiary">{f.lines}L</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </>
            ) : (
              <div className="flex h-full items-center justify-center px-4">
                <p className="text-center text-xs text-ak-text-tertiary">Henüz dosya yok</p>
              </div>
            )}
          </div>

          {/* File content viewer */}
          <div className="flex flex-1 flex-col overflow-hidden bg-[#0d1117]">
            {selectedFile && files?.[selectedFile] ? (
              <>
                <div className="flex items-center gap-2 border-b border-ak-border bg-ak-surface px-3 py-1.5">
                  <span className="font-mono text-[9px] font-bold" style={{ color: getFileIcon(selectedFile).color }}>
                    {getFileIcon(selectedFile).icon}
                  </span>
                  <span className="truncate font-mono text-xs text-ak-text-primary">{selectedFile}</span>
                  <span className="ml-auto text-[10px] text-ak-text-tertiary">{countLines(files[selectedFile])} lines</span>
                </div>
                <pre className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-ak-text-secondary">
                  {files[selectedFile].split('\n').map((line, i) => (
                    <div key={i} className="flex">
                      <span className="mr-4 inline-block w-8 flex-shrink-0 text-right text-ak-text-tertiary select-none">{i + 1}</span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{line || ' '}</span>
                    </div>
                  ))}
                </pre>
              </>
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-xs text-ak-text-tertiary">Dosya seçin</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      {branch && tab === 'preview' && (
        <div className="flex items-center justify-between border-t border-ak-border px-3 py-1.5">
          <span className="font-mono text-[10px] text-ak-text-tertiary">⑂ {branch}</span>
          <span className="text-[10px] text-ak-text-tertiary">Powered by StackBlitz SDK</span>
        </div>
      )}
    </div>
  );
}
