/**
 * RepoSelector — lets users choose between "New Project" and "Existing Repo" modes.
 * When "Existing Repo" is selected, shows a dropdown of user's GitHub repos
 * and a preview card with tech stack and file tree.
 */
import { useState, useEffect, useCallback } from 'react';
import { cn } from '../../utils/cn';
import { githubApi, type GitHubRepo, type RepoContext } from '../../services/api/github';

export type RepoMode = 'new' | 'existing';

export interface SelectedRepo {
  owner: string;
  repo: string;
  branch: string;
}

interface RepoSelectorProps {
  mode: RepoMode;
  onModeChange: (mode: RepoMode) => void;
  selectedRepo: SelectedRepo | null;
  onRepoSelect: (repo: SelectedRepo | null) => void;
  repoContext: RepoContext | null;
  onRepoContextChange: (ctx: RepoContext | null) => void;
}

export function RepoSelector({
  mode,
  onModeChange,
  selectedRepo,
  onRepoSelect,
  repoContext,
  onRepoContextChange,
}: RepoSelectorProps) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [loadingContext, setLoadingContext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTree, setShowTree] = useState(false);

  // Fetch repos when switching to existing mode
  useEffect(() => {
    if (mode !== 'existing' || repos.length > 0) return;
    let cancelled = false;

    setLoadingRepos(true);
    setError(null);
    githubApi.listRepos()
      .then((r) => { if (!cancelled) setRepos(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Repolar yuklenemedi'); })
      .finally(() => { if (!cancelled) setLoadingRepos(false); });

    return () => { cancelled = true; };
  }, [mode, repos.length]);

  // Fetch repo context when a repo is selected
  const handleRepoSelect = useCallback(async (fullName: string) => {
    if (!fullName) {
      onRepoSelect(null);
      onRepoContextChange(null);
      return;
    }

    const [owner, repo] = fullName.split('/');
    if (!owner || !repo) return;

    onRepoSelect({ owner, repo, branch: 'main' });
    onRepoContextChange(null);
    setLoadingContext(true);

    try {
      const ctx = await githubApi.getRepoContext(owner, repo);
      onRepoContextChange(ctx);
    } catch {
      // Context fetch is best-effort — repo is still selected
    } finally {
      setLoadingContext(false);
    }
  }, [onRepoSelect, onRepoContextChange]);

  return (
    <div className="space-y-3">
      {/* Segmented control: New Project | Existing Repo */}
      <div className="flex rounded-lg bg-ak-surface p-0.5 border border-ak-border">
        <button
          type="button"
          aria-pressed={mode === 'new'}
          onClick={() => { onModeChange('new'); onRepoSelect(null); onRepoContextChange(null); }}
          className={cn(
            'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150',
            mode === 'new'
              ? 'bg-ak-primary text-white shadow-sm'
              : 'bg-ak-surface-2/40 text-ak-text-secondary ring-1 ring-inset ring-ak-border-subtle hover:bg-ak-surface-2/70 hover:text-ak-text-primary',
          )}
        >
          Yeni Proje
        </button>
        <button
          type="button"
          aria-pressed={mode === 'existing'}
          onClick={() => onModeChange('existing')}
          className={cn(
            'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150',
            mode === 'existing'
              ? 'bg-ak-primary text-white shadow-sm'
              : 'bg-ak-surface-2/40 text-ak-text-secondary ring-1 ring-inset ring-ak-border-subtle hover:bg-ak-surface-2/70 hover:text-ak-text-primary',
          )}
        >
          Mevcut Repo
        </button>
      </div>

      {/* Repo dropdown (existing mode) */}
      {mode === 'existing' && (
        <div className="space-y-2">
          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}

          <select
            className="w-full rounded-lg border border-ak-border bg-ak-surface px-3 py-2 text-sm text-ak-text-primary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary"
            value={selectedRepo ? `${selectedRepo.owner}/${selectedRepo.repo}` : ''}
            onChange={(e) => handleRepoSelect(e.target.value)}
            disabled={loadingRepos}
          >
            <option value="">
              {loadingRepos ? 'Repolar yukleniyor...' : 'Repo secin...'}
            </option>
            {repos.map((r) => (
              <option key={r.fullName} value={r.fullName}>
                {r.fullName} {r.private ? '(ozel)' : '(public)'}
              </option>
            ))}
          </select>

          {/* Repo preview card */}
          {selectedRepo && (
            <div className="rounded-lg border border-ak-border bg-ak-surface-2 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-ak-text-primary">
                  {selectedRepo.owner}/{selectedRepo.repo}
                </span>
                {loadingContext && (
                  <span className="text-[10px] text-ak-text-tertiary animate-pulse">
                    Analiz ediliyor...
                  </span>
                )}
              </div>

              {repoContext && (
                <>
                  {/* Tech stack badges */}
                  {repoContext.techStack.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {repoContext.techStack.map((tech) => (
                        <span
                          key={tech}
                          className="rounded-full bg-ak-primary/10 px-2 py-0.5 text-[10px] font-medium text-ak-primary"
                        >
                          {tech}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Stats */}
                  <div className="flex gap-3 text-[10px] text-ak-text-tertiary">
                    <span>{repoContext.structure.totalFiles} dosya</span>
                    <span>{repoContext.structure.directories.length} klasor</span>
                  </div>

                  {/* Collapsible file tree */}
                  <button
                    type="button"
                    onClick={() => setShowTree(!showTree)}
                    className="text-[10px] text-ak-primary hover:underline"
                  >
                    {showTree ? 'Dosya agacini gizle' : 'Dosya agacini goster'}
                  </button>

                  {showTree && (
                    <pre className="max-h-40 overflow-auto rounded bg-ak-bg p-2 text-[10px] text-ak-text-secondary font-mono leading-relaxed">
                      {repoContext.fileTree}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
