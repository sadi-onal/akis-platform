import { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import type { UserFriendlyPlan, ChangePlan, PlanStatus } from '../../types/plan';
import type { StructuredSpec } from '../../types/workflow';
import { ScribeOutputDisclosures } from '../pipeline/ScribeOutputDisclosures';

export type JiraApproveConfig = { projectKey: string };

interface PlanCardProps {
  plan: UserFriendlyPlan | ChangePlan;
  version: number;
  status: PlanStatus;
  isChangeRequest: boolean;
  /**
   * Called when the user clicks Onayla. The optional `jiraConfig` carries the
   * Jira project the user opted into (via the picker). Undefined when:
   * Atlassian not connected, picker toggle off, or this is a change-request
   * card (no Jira flow on those).
   */
  onApprove?: (jiraConfig?: JiraApproveConfig) => void;
  onReject?: () => void;
  /**
   * PR-V6 — full Scribe structured spec. When present, the card renders
   * `<details>` disclosures below the summary so AC, user stories, problem
   * statement, and out-of-scope are reachable. Optional so the change-plan
   * path (no spec) keeps working.
   */
  spec?: StructuredSpec | null;
  /**
   * PR-V6 — Scribe assumptions surfaced through the same disclosure UI.
   */
  assumptions?: string[] | null;
}

const STATUS_LABELS: Record<PlanStatus, string> = {
  active: 'Aktif',
  edited: 'Düzenlendi',
  reviewing: 'İnceleniyor',
  approved: 'Onaylandı',
  rejected: 'Reddedildi',
  cancelled: 'İptal Edildi',
};

const STATUS_COLORS: Record<PlanStatus, string> = {
  active: 'bg-ak-primary/10 text-ak-primary',
  edited: 'bg-yellow-500/10 text-yellow-400',
  reviewing: 'bg-blue-500/10 text-blue-400',
  approved: 'bg-green-500/10 text-green-400',
  rejected: 'bg-red-500/10 text-red-400',
  cancelled: 'bg-ak-surface text-ak-text-tertiary',
};

function PlanIcon({ isChangeRequest }: { isChangeRequest: boolean }) {
  return (
    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-ak-primary/10 text-ak-primary">
      {isChangeRequest ? (
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
          />
        </svg>
      ) : (
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
          />
        </svg>
      )}
    </div>
  );
}

export function PlanCard({
  plan,
  version,
  status,
  isChangeRequest,
  onApprove,
  onReject,
  spec,
  assumptions,
}: PlanCardProps) {
  const [expanded, setExpanded] = useState(status === 'active');
  const isActive = status === 'active';

  // Jira project picker — only relevant on the spec-approval card. Fetches
  // once when the card becomes active. Renders different states depending on
  // the user's Jira setup, so they know what to do when the picker isn't
  // populated (vs the old behaviour of silent hide which looked like a bug).
  type JiraPickerStatus =
    | 'loading'
    | 'not_connected'
    | 'jira_not_installed'
    | 'jira_not_granted'
    | 'no_projects'
    | 'ok'
    | 'error';
  const [jiraStatus, setJiraStatus] = useState<JiraPickerStatus>('loading');
  const [jiraProjects, setJiraProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [jiraEnabled, setJiraEnabled] = useState(false);
  const [jiraProjectKey, setJiraProjectKey] = useState<string>('');
  const showJiraPicker = isActive && !isChangeRequest;
  useEffect(() => {
    if (!showJiraPicker) return;
    let cancelled = false;
    fetch('/api/integrations/jira/projects', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { status: 'error', projects: [] }))
      .then(
        (data: { status?: JiraPickerStatus; projects?: Array<{ key: string; name: string }> }) => {
          if (cancelled) return;
          const projects = data.projects ?? [];
          setJiraProjects(projects);
          setJiraStatus(data.status ?? 'error');
          if (projects.length > 0) setJiraProjectKey(projects[0].key);
        }
      )
      .catch(() => {
        if (!cancelled) setJiraStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [showJiraPicker]);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border backdrop-blur-xl transition-all duration-300',
        isActive
          ? 'border-ak-primary/40 bg-gradient-to-br from-ak-surface/90 to-ak-surface-2/70 shadow-xl shadow-ak-primary/10 ring-1 ring-ak-primary/20'
          : 'border-ak-border-subtle bg-ak-surface-2/40 opacity-75'
      )}
    >
      {/* Header */}
      <div className="relative flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <PlanIcon isChangeRequest={isChangeRequest} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-ak-text-primary">
                {isChangeRequest ? 'Değişiklik Planı' : 'Proje Planı'}
                {': '}
                {'projectName' in plan ? plan.projectName : (plan as ChangePlan).changeName}
              </span>
              {version > 1 && (
                <span className="flex-shrink-0 rounded bg-ak-surface-2 px-1.5 py-0.5 text-[10px] text-ak-text-tertiary">
                  v{version}
                </span>
              )}
            </div>
          </div>
        </div>
        {!isActive && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-medium',
                STATUS_COLORS[status],
                status === 'reviewing' && 'animate-pulse'
              )}
            >
              {STATUS_LABELS[status]}
            </span>
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[11px] text-ak-text-tertiary hover:text-ak-text-secondary transition-colors"
            >
              {expanded ? 'Gizle' : 'Detayları göster'}
            </button>
          </div>
        )}
        {isActive && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-ak-primary/30 to-transparent"
            aria-hidden
          />
        )}
      </div>

      {/* Body */}
      {(isActive || expanded) && (
        <div className="space-y-3 border-t border-ak-border-subtle px-4 py-3 animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Summary — bumped from text-xs for readability (issue #392) */}
          <p className="text-sm leading-relaxed text-ak-text-secondary">{plan.summary}</p>

          {/* Features / Modified Files */}
          {!isChangeRequest && 'features' in plan ? (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ak-text-tertiary">
                Özellikler
              </h4>
              <div className="grid gap-2 sm:grid-cols-2">
                {(plan as UserFriendlyPlan).features.map((f, i) => (
                  // PR-U4 M9: compound key for stable identity when features
                  // are re-ordered (rare today but no extra cost).
                  <div
                    key={`${i}-${f.name.slice(0, 30)}`}
                    className="rounded-lg border border-ak-border-subtle bg-ak-surface/60 p-3 backdrop-blur-sm transition-colors hover:border-ak-primary/30"
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-ak-primary/15 text-[11px] font-semibold text-ak-primary">
                        {i + 1}
                      </span>
                      <span className="text-sm font-semibold leading-snug text-ak-text-primary">
                        {f.name}
                      </span>
                    </div>
                    {f.description && (
                      <p className="mt-1.5 text-xs leading-relaxed text-ak-text-secondary">
                        {f.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {'modifiedFiles' in plan && (plan as ChangePlan).modifiedFiles.length > 0 && (
                <div>
                  <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-ak-text-tertiary">
                    Değişecek Dosyalar
                  </h4>
                  {(plan as ChangePlan).modifiedFiles.map((f, i) => (
                    <div
                      key={`${i}-${f.path}`}
                      className="flex gap-1.5 text-xs text-ak-text-secondary"
                    >
                      <span className="text-yellow-400">📝</span>
                      <span className="font-mono text-ak-text-primary">{f.path}</span>
                      <span className="text-ak-text-tertiary">— {f.description}</span>
                    </div>
                  ))}
                </div>
              )}
              {'newFiles' in plan && (plan as ChangePlan).newFiles.length > 0 && (
                <div>
                  <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-ak-text-tertiary">
                    Yeni Dosyalar
                  </h4>
                  {(plan as ChangePlan).newFiles.map((f, i) => (
                    <div key={`${i}-${f}`} className="flex gap-1.5 text-xs text-ak-text-secondary">
                      <span>📄</span>
                      <span className="font-mono text-ak-text-primary">{f}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tech Choices — chip badges */}
          {'techChoices' in plan && (plan as UserFriendlyPlan).techChoices.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ak-text-tertiary">
                Teknik Seçimler
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {(plan as UserFriendlyPlan).techChoices.map((t, i) => (
                  <span
                    key={`${i}-${t}`}
                    className="rounded-full border border-ak-primary/20 bg-ak-primary/10 px-3 py-1 text-xs font-medium text-ak-primary"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Stats row */}
          <div className="flex flex-wrap items-center gap-2">
            {'estimatedFiles' in plan && (
              <div className="flex items-center gap-1.5 rounded-lg bg-ak-surface-2/40 px-2.5 py-1.5">
                <svg
                  className="h-3.5 w-3.5 text-ak-text-tertiary"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                  />
                </svg>
                <span className="text-xs text-ak-text-secondary">
                  ~{(plan as UserFriendlyPlan).estimatedFiles} dosya
                </span>
              </div>
            )}
            <div className="flex items-center gap-1.5 rounded-lg bg-ak-surface-2/40 px-2.5 py-1.5">
              <svg
                className="h-3.5 w-3.5 text-ak-trace"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="text-xs text-ak-text-secondary">
                {plan.requiresTests ? 'Test yazılacak' : 'Test gerekmiyor'}
              </span>
            </div>
          </div>

          {plan.testRationale && (
            <p className="text-xs leading-relaxed italic text-ak-text-tertiary">
              {plan.testRationale}
            </p>
          )}

          {/* PR-V6 — full Scribe outputs (problem, AC, user stories,
              out-of-scope, assumptions) as native disclosures. Renders
              nothing when neither spec nor assumptions carry content,
              so change-plan / pre-Scribe paths stay unchanged. */}
          <ScribeOutputDisclosures spec={spec} assumptions={assumptions} />
        </div>
      )}

      {/* Jira section — surfaces the picker when ready and explains the
          situation when it's not (rather than silently hiding, which looks
          like a bug). Hidden entirely only when the user hasn't connected
          Atlassian at all — that's the explicit "no Jira workflow" choice. */}
      {showJiraPicker && jiraStatus !== 'loading' && jiraStatus !== 'not_connected' && (
        <div className="border-t border-ak-border-subtle px-4 py-3 space-y-2">
          {jiraStatus === 'ok' && (
            <>
              <label className="flex items-center gap-2 text-xs text-ak-text-secondary cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={jiraEnabled}
                  onChange={(e) => setJiraEnabled(e.target.checked)}
                  className="h-3.5 w-3.5 accent-ak-primary"
                />
                <span>Bu pipeline'ı Jira'ya bağla</span>
              </label>
              {jiraEnabled && (
                <select
                  value={jiraProjectKey}
                  onChange={(e) => setJiraProjectKey(e.target.value)}
                  className="w-full rounded-md border border-ak-border bg-ak-bg px-2 py-1.5 text-xs text-ak-text-primary focus:border-ak-primary focus:outline-none"
                >
                  {jiraProjects.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name} ({p.key})
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          {jiraStatus === 'jira_not_installed' && (
            <p className="text-[11px] text-ak-text-tertiary">
              <span className="font-medium text-ak-text-secondary">Jira bağlantısı:</span> Atlassian
              site'ında Jira yüklü değil.{' '}
              <a
                href="https://www.atlassian.com/software/jira/free"
                target="_blank"
                rel="noopener noreferrer"
                className="text-ak-primary hover:underline"
              >
                Önce site'a Jira ekle
              </a>
              , sonra Ayarlar'dan Atlassian'ı yeniden bağla.
            </p>
          )}
          {jiraStatus === 'jira_not_granted' && (
            <p className="text-[11px] text-ak-text-tertiary">
              <span className="font-medium text-ak-text-secondary">Jira bağlantısı:</span> Bağlandın
              ama Jira erişimi yok — büyük olasılıkla Jira siteye sonradan eklendi.{' '}
              <a href="/settings?tab=integrations" className="text-ak-primary hover:underline">
                Ayarlar'dan Disconnect → Connect
              </a>{' '}
              ile yeni izin ver.
            </p>
          )}
          {jiraStatus === 'no_projects' && (
            <p className="text-[11px] text-ak-text-tertiary">
              <span className="font-medium text-ak-text-secondary">Jira bağlantısı:</span> Jira'da
              henüz bir proje yok. Atlassian site'ında bir proje aç, sonra bu sayfayı yenile.
            </p>
          )}
          {jiraStatus === 'error' && (
            <p className="text-[11px] text-ak-text-tertiary">
              Jira proje listesi alınamadı. Bağlantı kontrol edilemedi — Onayla ile devam
              edebilirsin, Jira'ya bağlanmadan çalışır.
            </p>
          )}
        </div>
      )}

      {/* Action Buttons — only for active plan */}
      {isActive && (
        <div className="flex gap-2 border-t border-ak-border-subtle px-4 py-3">
          <button
            onClick={() =>
              onApprove?.(
                jiraEnabled && jiraProjectKey ? { projectKey: jiraProjectKey } : undefined
              )
            }
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-ak-primary px-4 py-2 text-sm font-semibold text-[color:var(--ak-on-primary)]',
              'hover:brightness-110 hover:-translate-y-px hover:shadow-lg hover:shadow-ak-primary/20',
              'active:translate-y-0 active:brightness-95 transition-all duration-150',
              'sm:flex-none'
            )}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            Onayla
          </button>
          <button
            onClick={onReject}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-ak-border px-4 py-2 text-sm font-medium text-ak-text-secondary',
              'hover:border-red-400 hover:text-red-400 hover:-translate-y-px',
              'active:translate-y-0 transition-all duration-150',
              'sm:flex-none'
            )}
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            İptal
          </button>
        </div>
      )}
    </div>
  );
}
