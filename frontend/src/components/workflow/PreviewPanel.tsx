import { useState, useEffect, useRef, useMemo } from 'react';
import { SandpackProvider, SandpackLayout, SandpackPreview as SandpackPreviewEmbed } from '@codesandbox/sandpack-react';
import { cn } from '../../utils/cn';
import { analyzePreviewCapability } from '../../utils/previewStrategy';
import { akisSandpackTheme } from '../../utils/sandpackTheme';
import type { PipelineActivity } from '../../hooks/usePipelineStream';

type PreviewView = 'web' | 'mobile';
type PanelTab = 'preview' | 'console' | 'files';

interface PreviewPanelProps {
  files: Record<string, string> | null;
  loading?: boolean;
  branch?: string;
  activities?: PipelineActivity[];
  createdFiles?: string[];
  repoUrl?: string;
}

function findMainFile(files: Record<string, string>): string {
  const priorities = [
    '/src/App.tsx', '/src/App.jsx', '/src/App.js',
    '/src/main.tsx', '/src/main.jsx', '/src/main.js',
    '/src/index.tsx', '/src/index.jsx', '/src/index.js',
    '/index.html',
  ];
  for (const p of priorities) {
    if (files[p]) return p;
  }
  const first = Object.keys(files)[0];
  return first?.startsWith('/') ? first : `/${first || 'index.html'}`;
}

/**
 * Convert Proto's file map to Sandpack-compatible format.
 *
 * Sandpack react-ts template expects /App.tsx at root level.
 * Proto generates src/App.tsx. We need to map Proto's paths to
 * Sandpack's expected structure so our files OVERRIDE the template defaults.
 *
 * Strategy:
 * 1. If Proto has /src/App.tsx → copy it to /App.tsx (Sandpack entry)
 * 2. If Proto has /src/main.tsx → copy it to /index.tsx (Sandpack entry)
 * 3. Keep all original paths too (for Files tab display)
 */
function toSandpackFiles(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    out[key.startsWith('/') ? key : `/${key}`] = value;
  }

  // Sandpack react-ts template has a DEFAULT /App.tsx that shows "Hello world".
  // We MUST override it with Proto's actual App component.
  // Key: always set (no guard), so template default is replaced.

  // 1. Map src/App.tsx|jsx|js → /App.tsx (ALWAYS override Sandpack template default)
  // Critical: Sandpack react-ts template expects /App.tsx. If Proto generates .jsx,
  // we MUST still write to /App.tsx to override the "Hello world" default.
  let appMapped = false;
  for (const srcPath of ['/src/App.tsx', '/src/App.jsx', '/src/App.js']) {
    if (out[srcPath]) {
      out['/App.tsx'] = out[srcPath];
      appMapped = true;
      break;
    }
  }
  // Also check root-level App files (Proto might output without src/ prefix)
  if (!appMapped) {
    for (const rootPath of ['/App.tsx', '/App.jsx', '/App.js']) {
      if (out[rootPath]) {
        out['/App.tsx'] = out[rootPath];
        appMapped = true;
        break;
      }
    }
  }

  // 2. If no App.tsx in src/, search deeper patterns
  if (!appMapped) {
    const appCandidates = [
      '/src/pages/index.tsx', '/src/pages/Index.tsx', '/src/pages/Home.tsx',
      '/src/pages/index.jsx', '/src/pages/Home.jsx',
      '/src/components/App.tsx', '/src/components/App.jsx',
      '/app/page.tsx', '/app/page.jsx',
      '/src/app/App.tsx', '/src/app/App.jsx',
    ];
    for (const alt of appCandidates) {
      if (out[alt]) {
        out['/App.tsx'] = out[alt];
        appMapped = true;
        break;
      }
    }
  }

  // 3. Last resort: if still no /App.tsx, find ANY .tsx/.jsx that exports a component
  if (!appMapped && !out['/App.tsx'] && !out['/App.jsx']) {
    const tsxFiles = Object.keys(out).filter(k =>
      (k.endsWith('.tsx') || k.endsWith('.jsx')) &&
      k !== '/index.tsx' && k !== '/index.jsx' &&
      !k.includes('main.')
    );
    if (tsxFiles.length === 1) {
      out['/App.tsx'] = out[tsxFiles[0]];
    } else {
      // Multiple files — pick the one with 'App' or 'Home' or 'Page' in name
      const best = tsxFiles.find(k => /\/(App|Home|Page|Main|Index)\./i.test(k));
      if (best) out['/App.tsx'] = out[best];
      else if (tsxFiles[0]) out['/App.tsx'] = out[tsxFiles[0]];
    }
  }

  // 4. Map entry points: src/main.tsx → /index.tsx
  for (const srcPath of ['/src/main.tsx', '/src/main.jsx', '/src/index.tsx', '/src/index.jsx']) {
    if (out[srcPath]) {
      const ext = srcPath.endsWith('x') ? 'tsx' : 'jsx';
      out[`/index.${ext}`] = out[srcPath];
      break;
    }
  }

  // 5. Map ALL CSS files (not just one)
  for (const cssPath of ['/src/index.css', '/src/App.css', '/src/styles.css', '/src/global.css']) {
    if (out[cssPath]) {
      const targetName = cssPath.split('/').pop()!;
      out[`/${targetName}`] = out[cssPath];
    }
  }

  // 6. Map src/** → /** for imports to work
  const srcPrefixes = ['/src/components/', '/src/lib/', '/src/utils/', '/src/hooks/', '/src/types/', '/src/styles/', '/src/context/', '/src/services/'];
  for (const [key, value] of Object.entries(out)) {
    for (const prefix of srcPrefixes) {
      if (key.startsWith(prefix) && !out[key.replace('/src/', '/')]) {
        out[key.replace('/src/', '/')] = value;
      }
    }
  }

  // 7. Final safety net: ensure /App.tsx exists (overrides Sandpack "Hello world")
  if (!out['/App.tsx'] && out['/App.jsx']) {
    out['/App.tsx'] = out['/App.jsx'];
  }
  if (!out['/App.tsx'] && out['/App.js']) {
    out['/App.tsx'] = out['/App.js'];
  }

  return out;
}

function extractDependencies(files: Record<string, string>): Record<string, string> {
  const pkgContent = files['package.json'] ?? files['/package.json'];
  if (!pkgContent) return {};
  try {
    return JSON.parse(pkgContent).dependencies ?? {};
  } catch {
    return {};
  }
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

/* ── Not Previewable Fallback ─────────────── */
function NotPreviewable({ reason, repoUrl }: { reason: string; repoUrl?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ak-surface-2">
        <svg className="h-7 w-7 text-ak-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
        </svg>
      </div>
      <p className="max-w-sm text-sm leading-relaxed text-ak-text-secondary">{reason}</p>
      {repoUrl && (
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-ak-primary/40 px-4 py-2 text-xs font-medium text-ak-primary hover:bg-ak-primary/10 transition-colors"
        >
          Projeyi GitHub'da Aç
        </a>
      )}
    </div>
  );
}

/* ── Main Component ───────────────────────── */
export function PreviewPanel({ files, loading: externalLoading, branch, activities, createdFiles, repoUrl }: PreviewPanelProps) {
  const [tab, setTab] = useState<PanelTab>('preview');
  const [view, setView] = useState<PreviewView>('web');
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    if (tab === 'console' && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activities?.length, tab]);

  const analysis = useMemo(() => {
    if (!files) return null;
    return analyzePreviewCapability(files);
  }, [files]);

  const sandpackFiles = useMemo(() => files ? toSandpackFiles(files) : null, [files]);

  // Build file tree structure
  type FileEntry = { path: string; content: string; lines: number };
  const fileTree = useMemo((): { folders: Map<string, FileEntry[]>; root: FileEntry[] } => {
    const folders = new Map<string, FileEntry[]>();
    const root: FileEntry[] = [];
    if (!files) return { folders, root };
    const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));

    for (const [path, content] of entries) {
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      const parts = cleanPath.split('/');
      if (parts.length > 1) {
        const folder = parts.slice(0, -1).join('/');
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder)!.push({ path: cleanPath, content, lines: countLines(content) });
      } else {
        root.push({ path: cleanPath, content, lines: countLines(content) });
      }
    }
    return { folders, root };
  }, [files]);

  const tabItems: { id: PanelTab; label: string; icon: string; count?: number }[] = [
    { id: 'preview', label: 'Onizleme', icon: '▶' },
    { id: 'console', label: 'Konsol', icon: '>', count: activities?.length },
    { id: 'files', label: 'Dosyalar', icon: '📁', count: files ? Object.keys(files).length : 0 },
  ];

  // Sandpack template: provides runtime (React, bundler) — our files override its defaults
  const template = analysis?.framework === 'react' ? 'react-ts' as const
    : analysis?.framework === 'vue' ? 'vue-ts' as const
    : 'vanilla-ts' as const;

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
        <div className="relative flex-1 overflow-hidden bg-ak-bg" style={{ minHeight: 0 }}>
          {externalLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-ak-surface gap-3">
              <div className="relative h-8 w-8">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-ak-primary border-t-transparent" />
                <span className="absolute inset-0 flex items-center justify-center text-xs">⚡</span>
              </div>
              <p className="text-sm font-medium text-ak-text-secondary">Dosyalar getiriliyor...</p>
              <div className="mt-1 h-1 w-32 overflow-hidden rounded-full bg-ak-border">
                <div className="h-full rounded-full bg-ak-primary/50" style={{ width: '30%', animation: 'pulse 2s ease-in-out infinite' }} />
              </div>
            </div>
          )}

          {!files && !externalLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-ak-surface gap-2 text-center">
              <p className="text-xs text-ak-text-tertiary">Henüz dosya yok. Proto tamamlandığında preview burada görünecek.</p>
            </div>
          )}

          {files && !externalLoading && analysis?.capability === 'not-previewable' && (
            <NotPreviewable reason={analysis.reason} repoUrl={repoUrl} />
          )}

          {files && !externalLoading && analysis?.capability === 'sandpack' && sandpackFiles && (
            <div className="absolute inset-0 overflow-hidden">
              {/* CSS override: force ALL Sandpack internal elements to fill container */}
              <style>{`
                .akis-sandpack-wrapper,
                .akis-sandpack-wrapper > div,
                .akis-sandpack-wrapper .sp-wrapper,
                .akis-sandpack-wrapper .sp-layout,
                .akis-sandpack-wrapper .sp-stack,
                .akis-sandpack-wrapper .sp-preview-container,
                .akis-sandpack-wrapper .sp-preview,
                .akis-sandpack-wrapper .sp-preview iframe,
                .akis-sandpack-wrapper [class*="sp-c-"] {
                  height: 100% !important;
                  max-height: 100% !important;
                }
                .akis-sandpack-wrapper .sp-layout {
                  border: none !important;
                  border-radius: 0 !important;
                }
              `}</style>
              <div
                className={cn(
                  'akis-sandpack-wrapper',
                  view === 'mobile' ? 'mx-auto max-w-sm h-full p-3' : 'h-full w-full',
                )}
              >
                <div
                  className="h-full w-full overflow-hidden"
                  style={view === 'mobile'
                    ? { border: '4px solid var(--ak-border)', borderRadius: 24, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }
                    : undefined
                  }
                >
                  <SandpackProvider
                    template={template}
                    files={sandpackFiles}
                    theme={akisSandpackTheme}
                    options={{
                      activeFile: findMainFile(sandpackFiles),
                      visibleFiles: Object.keys(sandpackFiles).slice(0, 8),
                      recompileMode: 'delayed',
                      recompileDelay: 500,
                    }}
                    customSetup={{
                      dependencies: extractDependencies(files),
                    }}
                  >
                    <SandpackLayout>
                      <SandpackPreviewEmbed
                        showOpenInCodeSandbox={false}
                        showRefreshButton
                      />
                    </SandpackLayout>
                  </SandpackProvider>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Console ─────────────────────── */}
      {tab === 'console' && (
        <div className="flex flex-1 flex-col overflow-hidden bg-ak-bg">
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
          <div className="flex items-center justify-between border-t border-ak-border bg-ak-surface px-3 py-1.5">
            <span className="font-mono text-[10px] text-ak-text-tertiary">
              {activities?.length ?? 0} log kaydi
            </span>
            {createdFiles && createdFiles.length > 0 && (
              <span className="font-mono text-[10px] text-green-400">
                {createdFiles.length} dosya olusturuldu
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── TAB: Files ───────────────────────── */}
      {tab === 'files' && (
        <div className="flex flex-1 overflow-hidden">
          <div className="w-56 flex-shrink-0 overflow-y-auto border-r border-ak-border bg-ak-surface py-1">
            {files && Object.keys(files).length > 0 ? (
              <>
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

          <div className="flex flex-1 flex-col overflow-hidden bg-ak-bg">
            {selectedFile && files?.[selectedFile] ? (
              <>
                <div className="flex items-center gap-2 border-b border-ak-border bg-ak-surface px-3 py-1.5">
                  <span className="font-mono text-[9px] font-bold" style={{ color: getFileIcon(selectedFile).color }}>
                    {getFileIcon(selectedFile).icon}
                  </span>
                  <span className="truncate font-mono text-xs text-ak-text-primary">{selectedFile}</span>
                  <span className="ml-auto text-[10px] text-ak-text-tertiary">{countLines(files[selectedFile])} satir</span>
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
          <span className="text-[10px] text-ak-text-tertiary">Sandpack</span>
        </div>
      )}
    </div>
  );
}
