import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../i18n/useI18n';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { toast } from '../../components/ui/Toast';
import { Skeleton } from '../../components/ui/Skeleton';
import { api } from '../../services/api/client';
import { AuthAPI } from '../../services/api/auth';
import AvatarCropModal from '../../components/settings/AvatarCropModal';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type Tab = 'profile' | 'ai-keys' | 'usage' | 'pipeline-stats' | 'integrations';

interface ProfileData {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  status: string;
  createdAt: string;
  /** GitHub OAuth avatar (cached); used as fallback when user hasn't uploaded their own. */
  githubAvatarUrl?: string | null;
  /** User-uploaded avatar (data URL). Takes priority over githubAvatarUrl. Issue #385. */
  avatarUrl?: string | null;
}

type Provider = 'anthropic' | 'openai' | 'google';

interface ProviderStatus {
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
}

interface MultiProviderStatus {
  activeProvider: Provider | null;
  providers: Record<Provider, ProviderStatus>;
  keySource?: 'akis' | 'own';
  canUseOwnKey?: boolean;
}

interface PipelineStatsData {
  totalPipelines: number;
  successRate: number;
  avgDurations: {
    scribeMs: number | null;
    protoMs: number | null;
    traceMs: number | null;
    totalMs: number | null;
  };
  recentPipelines: Array<{
    id: string;
    title: string | null;
    stage: string;
    createdAt: string;
    durationMs: number | null;
  }>;
  errorFrequency?: Array<{ code: string; count: number }>;
  modelDistribution?: Array<{ model: string; count: number }>;
  tokenUsage?: Array<{ agent: string; inputTokens: number; outputTokens: number }>;
  retryPatterns?: Array<{ stage: string; retries: number }>;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

// P12: All three providers are runtime-active. P1a brought OpenAI (#553) and
// P1c brought Google Gemini (#552); the "yakında" label was stale.
const PROVIDERS: { key: Provider; label: string; description: string; placeholder: string }[] = [
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    description: 'claude-haiku-4-5',
    placeholder: 'sk-ant-...',
  },
  { key: 'openai', label: 'OpenAI (GPT)', description: 'gpt-4o-mini', placeholder: 'sk-...' },
  {
    key: 'google',
    label: 'Google (Gemini)',
    description: 'gemini-1.5-flash',
    placeholder: 'AIza...',
  },
];

const STAGE_I18N_KEYS: Record<string, { key: string; color: string }> = {
  scribe_clarifying: {
    key: 'pipeline.stage.scribeClarifying',
    color: 'text-blue-400 bg-blue-400/10',
  },
  scribe_generating: {
    key: 'pipeline.stage.scribeGenerating',
    color: 'text-blue-400 bg-blue-400/10',
  },
  awaiting_approval: {
    key: 'pipeline.stage.awaitingApproval',
    color: 'text-yellow-400 bg-yellow-400/10',
  },
  proto_building: {
    key: 'pipeline.stage.protoBuilding',
    color: 'text-purple-400 bg-purple-400/10',
  },
  trace_testing: { key: 'pipeline.stage.traceTesting', color: 'text-cyan-400 bg-cyan-400/10' },
  ci_running: { key: 'pipeline.stage.ciRunning', color: 'text-orange-400 bg-orange-400/10' },
  completed: { key: 'pipeline.stage.completed', color: 'text-emerald-400 bg-emerald-400/10' },
  completed_partial: {
    key: 'pipeline.stage.completedPartial',
    color: 'text-emerald-300 bg-emerald-300/10',
  },
  failed: { key: 'pipeline.stage.failed', color: 'text-red-400 bg-red-400/10' },
  cancelled: { key: 'pipeline.stage.cancelled', color: 'text-ak-text-tertiary bg-ak-surface-2/50' },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number | null): string {
  if (ms == null || ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}sn`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}dk ${sec}sn` : `${min}dk`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('tr-TR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: Tab =
    tabParam === 'ai-keys'
      ? 'ai-keys'
      : tabParam === 'usage'
        ? 'usage'
        : tabParam === 'pipeline-stats'
          ? 'pipeline-stats'
          : tabParam === 'integrations'
            ? 'integrations'
            : 'profile';

  const setTab = (tab: Tab) => setSearchParams(tab === 'profile' ? {} : { tab });

  return (
    <div className="flex min-h-screen flex-col bg-ak-bg">
      {/* ── Header ─────────────────────────── */}
      <div className="sticky top-0 z-20 border-b border-ak-border bg-ak-bg/80 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 py-3">
          <button
            onClick={() => navigate('/chat')}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ak-text-secondary hover:bg-ak-surface-2 hover:text-ak-text-primary transition-colors"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            {t('settings.backToChat')}
          </button>
          <div className="flex-1" />
          <h1 className="text-sm font-semibold text-ak-text-primary">{t('settings.title')}</h1>
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl px-4 py-6">
        {/* Tab bar */}
        <div className="mb-6 flex flex-wrap gap-1 rounded-lg border border-ak-border bg-ak-surface p-1">
          <TabButton active={activeTab === 'profile'} onClick={() => setTab('profile')}>
            {t('settings.tab.profile')}
          </TabButton>
          <TabButton active={activeTab === 'ai-keys'} onClick={() => setTab('ai-keys')}>
            {t('settings.tab.aiKeys')}
          </TabButton>
          <TabButton active={activeTab === 'usage'} onClick={() => setTab('usage')}>
            {t('settings.tab.usage')}
          </TabButton>
          <TabButton
            active={activeTab === 'pipeline-stats'}
            onClick={() => setTab('pipeline-stats')}
          >
            {t('settings.tab.pipelineStats')}
          </TabButton>
          <TabButton active={activeTab === 'integrations'} onClick={() => setTab('integrations')}>
            {t('settings.tab.integrations')}
          </TabButton>
        </div>

        <ErrorBoundary fallbackPath="/settings" fallbackLabel="Ayarlar">
          <div key={activeTab} className="animate-in fade-in slide-in-from-bottom-2 duration-200">
            {activeTab === 'profile' && <ProfileTab />}
            {activeTab === 'ai-keys' && <AIKeysTab />}
            {activeTab === 'usage' && <UsageTab />}
            {activeTab === 'pipeline-stats' && <PipelineStatsTab />}
            {activeTab === 'integrations' && <IntegrationsTab />}
          </div>
        </ErrorBoundary>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-ak-surface-2 text-ak-text-primary shadow-sm'
          : 'text-ak-text-tertiary hover:text-ak-text-secondary'
      )}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile Tab                                                        */
/* ------------------------------------------------------------------ */

function ProfileTab() {
  const { user, setUser } = useAuth();
  const { t } = useI18n();
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  // Avatar upload state — issue #385 / BUG-05, #447 (crop), #448 (remove button).
  const avatarFileInputRef = useRef<HTMLInputElement>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  // Object URL for the file the user just picked — becomes the source for
  // <AvatarCropModal/>. Null ⇒ modal hidden. Revoked on unmount / next pick.
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);

  // Raw file cap is generous (8MB) — the crop modal downscales to ≤200KB
  // before upload, so server-side we only persist the optimized JPEG.
  const MAX_AVATAR_RAW_BYTES = 8_000_000;
  const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

  // Revoke the object URL when the modal closes so we don't leak blobs.
  useEffect(() => {
    return () => {
      if (cropImageSrc?.startsWith('blob:')) URL.revokeObjectURL(cropImageSrc);
    };
  }, [cropImageSrc]);

  function handleAvatarPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.size > MAX_AVATAR_RAW_BYTES) {
      toast('Resim 8MB limitini aşıyor — daha küçük bir resim seçin.', 'error');
      return;
    }
    if (!AVATAR_ACCEPT.split(',').includes(file.type)) {
      toast('JPG, PNG, WebP veya GIF yükleyin.', 'error');
      return;
    }
    // Revoke previous blob before replacing.
    if (cropImageSrc?.startsWith('blob:')) URL.revokeObjectURL(cropImageSrc);
    setCropImageSrc(URL.createObjectURL(file));
  }

  async function handleAvatarCropConfirm(dataUrl: string) {
    setAvatarSaving(true);
    try {
      const updated = await AuthAPI.updateAvatar(dataUrl);
      setUser({ ...user!, avatarUrl: updated.avatarUrl ?? null });
      toast(t('settings.profile.avatarUpdated'), 'success');
      // Close modal only on success — keep open on failure so user can retry.
      if (cropImageSrc?.startsWith('blob:')) URL.revokeObjectURL(cropImageSrc);
      setCropImageSrc(null);
    } catch {
      toast(t('settings.profile.avatarUploadFailed'), 'error');
    } finally {
      setAvatarSaving(false);
    }
  }

  function handleAvatarCropCancel() {
    if (cropImageSrc?.startsWith('blob:')) URL.revokeObjectURL(cropImageSrc);
    setCropImageSrc(null);
  }

  async function handleAvatarClear() {
    setAvatarSaving(true);
    try {
      const updated = await AuthAPI.updateAvatar(null);
      setUser({ ...user!, avatarUrl: updated.avatarUrl ?? null });
      toast(t('settings.profile.avatarRemoved'), 'success');
    } catch {
      toast(t('settings.profile.avatarRemoveFailed'), 'error');
    } finally {
      setAvatarSaving(false);
    }
  }

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/profile', { credentials: 'include' });
      if (res.ok) {
        const data: ProfileData = await res.json();
        setProfile(data);
        setNameInput(data.name);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleSaveName = async () => {
    if (!nameInput.trim() || nameInput.trim() === profile?.name) return;
    setSavingName(true);
    try {
      const res = await fetch('/api/settings/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: nameInput.trim() }),
      });
      if (!res.ok) throw new Error();
      const updated: ProfileData = await res.json();
      setProfile(updated);
      setUser({ ...user!, name: updated.name });
      toast(t('settings.profile.nameSaved'), 'success');
    } catch {
      toast(t('settings.profile.nameError'), 'error');
    } finally {
      setSavingName(false);
    }
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 8) {
      toast(t('settings.profile.passwordMinLength'), 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast(t('settings.profile.passwordMismatch'), 'error');
      return;
    }
    setSavingPassword(true);
    try {
      const res = await fetch('/api/settings/profile/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error?.message || data.message || '');
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast(t('settings.profile.passwordChanged'), 'success');
    } catch (e) {
      toast(
        e instanceof Error && e.message ? e.message : t('settings.profile.passwordError'),
        'error'
      );
    } finally {
      setSavingPassword(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3 rounded-xl border border-ak-border bg-ak-surface p-6">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  // Priority: user-uploaded > GitHub-cached > initials fallback (issue #385)
  const avatarUrl = user?.avatarUrl ?? profile?.githubAvatarUrl ?? undefined;
  const initials = (profile?.name ?? user?.name ?? '?')[0]?.toUpperCase() ?? '?';

  return (
    <>
      {/* Section A — Avatar & Name */}
      <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
        {t('settings.profile.title')}
      </h2>
      <div className="rounded-xl border border-ak-border bg-ak-surface p-4 mb-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="relative group">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="h-14 w-14 rounded-full object-cover" />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-ak-primary/20 text-lg font-semibold text-ak-primary">
                {initials}
              </div>
            )}
            <button
              type="button"
              onClick={() => avatarFileInputRef.current?.click()}
              disabled={avatarSaving}
              title="Profil resmi değiştir"
              aria-label="Profil resmi değiştir"
              className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 text-white opacity-0 transition-all group-hover:bg-black/50 group-hover:opacity-100 disabled:cursor-not-allowed"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
            <input
              ref={avatarFileInputRef}
              type="file"
              accept={AVATAR_ACCEPT}
              className="hidden"
              onChange={handleAvatarPick}
              aria-hidden
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ak-text-primary">
              {profile?.name ?? user?.name}
            </p>
            <div className="flex items-center gap-1.5">
              <p className="text-xs text-ak-text-tertiary">{profile?.email ?? user?.email}</p>
              {profile?.emailVerified && (
                <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                  {t('settings.profile.verified')}
                </span>
              )}
            </div>
            {user?.avatarUrl && (
              <button
                type="button"
                onClick={handleAvatarClear}
                disabled={avatarSaving}
                aria-label={t('settings.profile.avatarRemove')}
                className={cn(
                  'mt-2 inline-flex items-center gap-1 rounded-md border border-ak-border bg-ak-surface-2 px-2 py-1',
                  'text-[11px] font-medium text-ak-text-secondary',
                  'hover:border-red-400/40 hover:bg-red-400/10 hover:text-red-400 transition-colors',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                <svg
                  className="h-3 w-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"
                  />
                </svg>
                {t('settings.profile.avatarRemove')}
              </button>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-ak-text-secondary">
            {t('settings.profile.nameLabel')}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className={cn(
                'flex-1 rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2 text-xs text-ak-text-primary',
                'placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30'
              )}
            />
            <button
              onClick={handleSaveName}
              disabled={!nameInput.trim() || nameInput.trim() === profile?.name || savingName}
              className={cn(
                'rounded-lg bg-ak-primary px-3 py-2 text-xs font-medium text-[color:var(--ak-on-primary)]',
                (!nameInput.trim() || nameInput.trim() === profile?.name || savingName) &&
                  'opacity-50 cursor-not-allowed'
              )}
            >
              {savingName ? t('settings.ai.saving') : t('settings.ai.save')}
            </button>
          </div>
        </div>
      </div>

      {/* Section B — Password Change */}
      <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
        {t('settings.profile.passwordTitle')}
      </h2>
      <div className="rounded-xl border border-ak-border bg-ak-surface p-4 mb-6 space-y-3">
        <div>
          <label className="text-xs font-medium text-ak-text-secondary">
            {t('settings.profile.currentPassword')}
          </label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className={cn(
              'mt-1 w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2 text-xs text-ak-text-primary',
              'placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30'
            )}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-ak-text-secondary">
            {t('settings.profile.newPassword')}
          </label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className={cn(
              'mt-1 w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2 text-xs text-ak-text-primary',
              'placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30'
            )}
          />
          {newPassword.length > 0 && newPassword.length < 8 && (
            <p className="mt-1 text-[10px] text-red-400">
              {t('settings.profile.passwordMinLength')}
            </p>
          )}
        </div>
        <div>
          <label className="text-xs font-medium text-ak-text-secondary">
            {t('settings.profile.confirmPassword')}
          </label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={cn(
              'mt-1 w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2 text-xs text-ak-text-primary',
              'placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30'
            )}
          />
          {confirmPassword.length > 0 && newPassword !== confirmPassword && (
            <p className="mt-1 text-[10px] text-red-400">
              {t('settings.profile.passwordMismatch')}
            </p>
          )}
        </div>
        <button
          onClick={handleChangePassword}
          disabled={
            !currentPassword ||
            !newPassword ||
            newPassword.length < 8 ||
            newPassword !== confirmPassword ||
            savingPassword
          }
          className={cn(
            'rounded-lg bg-ak-primary px-4 py-2 text-xs font-medium text-[color:var(--ak-on-primary)]',
            (!currentPassword ||
              !newPassword ||
              newPassword.length < 8 ||
              newPassword !== confirmPassword ||
              savingPassword) &&
              'opacity-50 cursor-not-allowed'
          )}
        >
          {savingPassword ? t('settings.ai.saving') : t('settings.profile.changePassword')}
        </button>
      </div>

      {/* Section C — Account Info */}
      <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
        {t('settings.profile.accountInfo')}
      </h2>
      <div className="rounded-xl border border-ak-border bg-ak-surface p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-ak-text-secondary">
            {t('settings.profile.memberSince')}
          </span>
          <span className="text-xs font-medium text-ak-text-primary">
            {profile?.createdAt ? formatDate(profile.createdAt) : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-ak-text-secondary">
            {t('settings.profile.accountStatus')}
          </span>
          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
            {profile?.status ?? 'active'}
          </span>
        </div>
        <div className="border-t border-ak-border pt-3">
          <div className="group relative inline-block">
            <button
              disabled
              className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 opacity-50 cursor-not-allowed"
            >
              {t('settings.profile.deleteAccount')}
            </button>
            <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-ak-surface-2 px-2 py-1 text-[10px] text-ak-text-tertiary opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
              {t('settings.profile.deleteTooltip')}
            </span>
          </div>
        </div>
      </div>

      {/* Avatar crop modal — issue #447. Shown whenever cropImageSrc is set. */}
      {cropImageSrc && (
        <AvatarCropModal
          imageSrc={cropImageSrc}
          onConfirm={handleAvatarCropConfirm}
          onCancel={handleAvatarCropCancel}
          busy={avatarSaving}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  AI Keys Tab                                                        */
/* ------------------------------------------------------------------ */

function AIKeysTab() {
  const { t } = useI18n();
  const [status, setStatus] = useState<MultiProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/ai-keys/status', { credentials: 'include' });
      if (res.ok) setStatus(await res.json());
    } catch (e) {
      if (import.meta.env.DEV) console.warn('Failed to fetch AI key status:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleSave = async (provider: Provider) => {
    if (!apiKeyInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/ai-keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider, apiKey: apiKeyInput.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || t('settings.ai.saveError'));
      }
      setEditingProvider(null);
      setApiKeyInput('');
      await fetchStatus();
      toast(t('settings.ai.toast.saved'), 'success');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.ai.genericError'));
      toast(e instanceof Error ? e.message : t('settings.ai.toast.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (provider: Provider) => {
    if (!window.confirm(t('settings.ai.confirmDelete'))) return;
    try {
      await fetch('/api/settings/ai-keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider }),
      });
      await fetchStatus();
      toast(t('settings.ai.toast.removed'), 'success');
    } catch (e) {
      toast(t('settings.ai.toast.error'), 'error');
      if (import.meta.env.DEV) console.warn('Failed to delete AI key:', e);
    }
  };

  const handleSetActive = async (provider: Provider) => {
    try {
      await fetch('/api/settings/ai-provider/active', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ provider }),
      });
      await fetchStatus();
      toast(t('settings.ai.toast.activeSet'), 'success');
    } catch (e) {
      if (import.meta.env.DEV) console.warn('Failed to set active provider:', e);
    }
  };

  const keySource = status?.keySource ?? 'akis';
  const hasAnyOwnKey = status ? Object.values(status.providers).some((p) => p.configured) : false;

  return (
    <>
      {/* ── Section 1: Aktif Saglayici ──────────────────── */}
      <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
        {t('settings.ai.activeProvider')}
      </h2>

      {loading ? (
        <div className="space-y-3 mb-6">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : (
        <div className="space-y-2 mb-6">
          {/* AKIS Built-in Key Card */}
          <div
            className={cn(
              'rounded-xl border-2 p-4 transition-colors cursor-pointer',
              keySource === 'akis'
                ? 'border-ak-primary bg-ak-primary/5'
                : 'border-ak-border bg-ak-surface hover:border-ak-primary/30'
            )}
            onClick={() => {
              if (keySource !== 'akis') {
                toast(t('settings.ai.toast.switchToAkisHint'), 'info');
              }
            }}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                  keySource === 'akis' ? 'border-ak-primary' : 'border-ak-border'
                )}
              >
                {keySource === 'akis' && <div className="h-2.5 w-2.5 rounded-full bg-ak-primary" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ak-text-primary">
                    {t('settings.ai.akisBuiltinKey')}
                  </h3>
                  {keySource === 'akis' && (
                    <span className="rounded-full bg-ak-primary/10 px-2 py-0.5 text-[10px] font-medium text-ak-primary">
                      {t('settings.ai.active')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-ak-text-tertiary">
                  {t('settings.ai.akisBuiltinKey.desc')}
                </p>
              </div>
            </div>
          </div>

          {/* Own Key Card */}
          <div
            className={cn(
              'rounded-xl border-2 p-4 transition-colors',
              keySource === 'own'
                ? 'border-ak-primary bg-ak-primary/5'
                : 'border-ak-border bg-ak-surface'
            )}
          >
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2',
                  keySource === 'own' ? 'border-ak-primary' : 'border-ak-border'
                )}
              >
                {keySource === 'own' && <div className="h-2.5 w-2.5 rounded-full bg-ak-primary" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-ak-text-primary">
                    {t('settings.ai.ownKey')}
                  </h3>
                  {keySource === 'own' && (
                    <span className="rounded-full bg-ak-primary/10 px-2 py-0.5 text-[10px] font-medium text-ak-primary">
                      {t('settings.ai.active')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-ak-text-tertiary">
                  {hasAnyOwnKey
                    ? t('settings.ai.ownKey.descConfigured')
                    : t('settings.ai.ownKey.descEmpty')}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Section 2: Kullanilabilir Saglayicilar ──────── */}
      {!loading && (
        <>
          <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
            {t('settings.ai.title')}
          </h2>
          <div className="space-y-3 mb-6">
            {PROVIDERS.map((p) => {
              const ps = status?.providers[p.key];
              const isActive = status?.activeProvider === p.key && ps?.configured;
              const isEditing = editingProvider === p.key;

              return (
                <div key={p.key} className="rounded-xl border border-ak-border bg-ak-surface p-4">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-ak-text-primary">{p.label}</h3>
                        {isActive && (
                          <span className="rounded-full bg-ak-primary/10 px-2 py-0.5 text-[10px] font-medium text-ak-primary">
                            {t('settings.ai.default')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-ak-text-tertiary">
                        {ps?.configured
                          ? `API Key: ••••${ps.last4}`
                          : t('settings.ai.notConfigured')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {ps?.configured && !isActive && (
                        <button
                          onClick={() => handleSetActive(p.key)}
                          className="rounded-lg border border-ak-border px-2.5 py-1 text-[11px] font-medium text-ak-text-secondary hover:text-ak-primary transition-colors"
                        >
                          {t('settings.ai.makeDefault')}
                        </button>
                      )}
                      {ps?.configured && (
                        <button
                          onClick={() => handleDelete(p.key)}
                          className="rounded-lg border border-ak-border px-2.5 py-1 text-[11px] font-medium text-red-400 hover:bg-red-400/10 transition-colors"
                        >
                          {t('settings.ai.delete')}
                        </button>
                      )}
                      {!isEditing && (
                        <button
                          onClick={() => {
                            setEditingProvider(p.key);
                            setApiKeyInput('');
                            setError(null);
                          }}
                          className="rounded-lg bg-ak-primary/10 px-2.5 py-1 text-[11px] font-medium text-ak-primary hover:bg-ak-primary/20 transition-colors"
                        >
                          {ps?.configured ? t('settings.ai.update') : t('settings.ai.add')}
                        </button>
                      )}
                    </div>
                  </div>

                  {isEditing && (
                    <div className="mt-3 space-y-2">
                      <input
                        type="password"
                        value={apiKeyInput}
                        onChange={(e) => setApiKeyInput(e.target.value)}
                        placeholder={p.placeholder}
                        autoFocus
                        className={cn(
                          'w-full rounded-lg border border-ak-border bg-ak-surface-2 px-3 py-2 text-xs text-ak-text-primary font-mono',
                          'placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30'
                        )}
                      />
                      {error && <p className="text-xs text-red-400">{error}</p>}
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setEditingProvider(null);
                            setApiKeyInput('');
                            setError(null);
                          }}
                          className="rounded-lg border border-ak-border px-3 py-1.5 text-xs text-ak-text-secondary"
                        >
                          {t('settings.ai.cancel')}
                        </button>
                        <button
                          onClick={() => handleSave(p.key)}
                          disabled={!apiKeyInput.trim() || saving}
                          className={cn(
                            'rounded-lg bg-ak-primary px-3 py-1.5 text-xs font-medium text-[color:var(--ak-on-primary)]',
                            (!apiKeyInput.trim() || saving) && 'opacity-50 cursor-not-allowed'
                          )}
                        >
                          {saving ? t('settings.ai.saving') : t('settings.ai.save')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Pipeline Stats Tab                                                 */
/* ------------------------------------------------------------------ */

function PipelineStatsTab() {
  const { t } = useI18n();
  const [data, setData] = useState<PipelineStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings/pipeline-stats', { credentials: 'include' });
        if (!res.ok) throw new Error(t('settings.stats.error'));
        setData(await res.json());
      } catch (e) {
        setError(e instanceof Error ? e.message : t('settings.ai.genericError'));
      } finally {
        setLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="space-y-3 rounded-xl border border-ak-border bg-ak-surface p-6">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-xs text-red-400">
        {error}
      </div>
    );
  }

  if (!data) return null;

  return (
    <>
      {/* Stat cards */}
      <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StatCard label={t('settings.stats.totalPipelines')} value={String(data.totalPipelines)} />
        <StatCard
          label={t('settings.stats.successRate')}
          value={`%${data.successRate}`}
          accent={data.successRate >= 70}
        />
        <StatCard
          label={t('settings.stats.avgTotalDuration')}
          value={formatDuration(data.avgDurations.totalMs)}
        />
        <div className="rounded-xl border border-ak-border bg-ak-surface p-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ak-text-tertiary">
            {t('settings.stats.avgAgentDurations')}
          </p>
          <div className="space-y-1.5">
            <AgentDuration label="Scribe" ms={data.avgDurations.scribeMs} />
            <AgentDuration label="Proto" ms={data.avgDurations.protoMs} />
            <AgentDuration label="Trace" ms={data.avgDurations.traceMs} />
          </div>
        </div>
      </div>

      {/* Recent pipelines */}
      <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
        {t('settings.stats.recentPipelines')}
      </h2>
      {data.recentPipelines.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ak-border bg-ak-surface p-8 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-ak-surface-2">
            <svg
              className="h-5 w-5 text-ak-text-tertiary"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
              />
            </svg>
          </div>
          <p className="text-xs text-ak-text-tertiary">{t('settings.stats.empty')}</p>
          <p className="mt-1 text-[10px] text-ak-text-tertiary">{t('settings.stats.emptyState')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ak-border">
          <table className="w-full text-xs min-w-[500px]">
            <thead>
              <tr className="border-b border-ak-border bg-ak-surface">
                <th className="px-4 py-2.5 text-left font-semibold text-ak-text-tertiary">
                  {t('settings.stats.th.title')}
                </th>
                <th className="px-4 py-2.5 text-left font-semibold text-ak-text-tertiary">
                  {t('settings.stats.th.status')}
                </th>
                <th className="px-4 py-2.5 text-left font-semibold text-ak-text-tertiary">
                  {t('settings.stats.th.date')}
                </th>
                <th className="px-4 py-2.5 text-right font-semibold text-ak-text-tertiary">
                  {t('settings.stats.th.duration')}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.recentPipelines.map((p) => {
                const stageInfo = STAGE_I18N_KEYS[p.stage];
                const stageText = stageInfo ? t(stageInfo.key as Parameters<typeof t>[0]) : p.stage;
                const stageColor = stageInfo?.color ?? 'text-ak-text-tertiary bg-ak-surface-2/50';
                return (
                  <tr
                    key={p.id}
                    className="border-b border-ak-border/50 bg-ak-surface/50 last:border-b-0"
                  >
                    <td className="px-4 py-2.5 text-ak-text-primary font-medium truncate max-w-[200px]">
                      {p.title || (
                        <span className="text-ak-text-tertiary italic">
                          {t('settings.stats.unnamed')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          'inline-block rounded-full px-2 py-0.5 text-[10px] font-medium',
                          stageColor
                        )}
                      >
                        {stageText}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-ak-text-secondary">
                      {formatDate(p.createdAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-ak-text-secondary font-mono">
                      {formatDuration(p.durationMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Analytics: Error Breakdown ──────────────────────────────── */}
      {data.errorFrequency && data.errorFrequency.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
            {t('settings.stats.errors')}
          </h2>
          <div className="rounded-xl border border-ak-border bg-ak-surface p-4 space-y-2">
            {(() => {
              const maxCount = Math.max(...data.errorFrequency!.map((e) => e.count), 1);
              return data.errorFrequency!.map((e) => (
                <div key={e.code} className="flex items-center gap-2 text-sm">
                  <span className="w-40 font-mono text-xs truncate text-ak-text-secondary">
                    {e.code}
                  </span>
                  <div className="flex-1 h-4 bg-ak-surface-2 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-red-500/70 rounded-full transition-all"
                      style={{ width: `${(e.count / maxCount) * 100}%` }}
                    />
                  </div>
                  <span className="text-ak-text-secondary w-8 text-right text-xs">{e.count}</span>
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ── Analytics: Model Distribution — always shown ───────────── */}
      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
          {t('settings.stats.models')}
        </h2>
        {data.modelDistribution && data.modelDistribution.length > 0 ? (
          <div className="rounded-xl border border-ak-border bg-ak-surface p-4 flex items-center gap-6">
            {(() => {
              const total = data.modelDistribution!.reduce((s, m) => s + m.count, 0) || 1;
              const colors = ['#07D1AF', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6'];
              let cumPct = 0;
              const segments = data.modelDistribution!.map((m, i) => {
                const start = cumPct;
                const pct = (m.count / total) * 100;
                cumPct += pct;
                return { ...m, start, pct, color: colors[i % colors.length] };
              });
              const gradient = segments
                .map((s) => `${s.color} ${s.start}% ${s.start + s.pct}%`)
                .join(', ');
              return (
                <>
                  <div
                    className="w-28 h-28 rounded-full shrink-0"
                    style={{
                      background: `conic-gradient(${gradient})`,
                      mask: 'radial-gradient(circle at center, transparent 40%, black 41%)',
                      WebkitMask: 'radial-gradient(circle at center, transparent 40%, black 41%)',
                    }}
                  />
                  <div className="space-y-1.5 min-w-0">
                    {segments.map((s) => (
                      <div key={s.model} className="flex items-center gap-2 text-xs">
                        <span
                          className="w-3 h-3 rounded-sm shrink-0"
                          style={{ backgroundColor: s.color }}
                        />
                        <span className="text-ak-text-secondary truncate">{s.model}</span>
                        <span className="ml-auto font-mono text-ak-text-primary">{s.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-ak-border bg-ak-surface p-6 text-center">
            <p className="text-xs text-ak-text-tertiary">{t('settings.stats.empty')}</p>
          </div>
        )}
      </div>

      {/* ── Analytics: Token Usage — always shown ─────────────────── */}
      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
          {t('settings.stats.tokens')}
        </h2>
        {data.tokenUsage && data.tokenUsage.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-ak-border">
            <table className="w-full text-xs min-w-[400px]">
              <thead>
                <tr className="border-b border-ak-border bg-ak-surface">
                  <th className="px-4 py-2.5 text-left font-semibold text-ak-text-tertiary">
                    Agent
                  </th>
                  <th className="px-4 py-2.5 text-right font-semibold text-ak-text-tertiary">
                    Input
                  </th>
                  <th className="px-4 py-2.5 text-right font-semibold text-ak-text-tertiary">
                    Output
                  </th>
                  <th className="px-4 py-2.5 text-right font-semibold text-ak-text-tertiary">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.tokenUsage!.map((row) => (
                  <tr
                    key={row.agent}
                    className="border-b border-ak-border/50 bg-ak-surface/50 last:border-b-0"
                  >
                    <td className="px-4 py-2.5 text-ak-text-primary font-medium capitalize">
                      {row.agent}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-ak-text-secondary">
                      {row.inputTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-ak-text-secondary">
                      {row.outputTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-ak-text-primary">
                      {(row.inputTokens + row.outputTokens).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-ak-border bg-ak-surface p-6 text-center">
            <p className="text-xs text-ak-text-tertiary">{t('settings.stats.empty')}</p>
          </div>
        )}
      </div>

      {/* ── Analytics: Retry Heatmap ──────────────────────────────── */}
      {data.retryPatterns && data.retryPatterns.length > 0 && (
        <div className="mt-6 mb-4">
          <h2 className="mb-3 text-sm font-semibold text-ak-text-primary">
            {t('settings.stats.retries')}
          </h2>
          <div className="rounded-xl border border-ak-border bg-ak-surface p-4 flex flex-wrap gap-2">
            {data.retryPatterns!.map((rp) => {
              const bg =
                rp.retries === 0
                  ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                  : rp.retries <= 2
                    ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
                    : 'bg-red-500/20 text-red-400 border-red-500/30';
              const stageInfo = STAGE_I18N_KEYS[rp.stage];
              const label = stageInfo ? t(stageInfo.key as Parameters<typeof t>[0]) : rp.stage;
              return (
                <div
                  key={rp.stage}
                  className={cn('rounded-lg border px-3 py-2 text-xs font-medium', bg)}
                >
                  <div className="text-[10px] opacity-70">{label}</div>
                  <div className="font-mono text-sm">{rp.retries}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Small sub-components                                               */
/* ------------------------------------------------------------------ */

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-ak-border bg-ak-surface p-4">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ak-text-tertiary">
        {label}
      </p>
      <p className={cn('text-xl font-bold', accent ? 'text-ak-primary' : 'text-ak-text-primary')}>
        {value}
      </p>
    </div>
  );
}

function AgentDuration({ label, ms }: { label: string; ms: number | null }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-ak-text-secondary">{label}</span>
      <span className="text-[11px] font-mono text-ak-text-primary">{formatDuration(ms)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Integrations Tab                                                   */
/* ------------------------------------------------------------------ */

function IntegrationsTab() {
  return (
    <div className="space-y-4">
      <GitHubSection />
      <JiraSection />
    </div>
  );
}

/* -- Integration card status badge ------------------------------------ */

function StatusBadge({
  status,
}: {
  status: 'connected' | 'disconnected' | 'coming-soon' | 'active' | 'loading';
}) {
  const { t } = useI18n();
  if (status === 'loading') {
    return (
      <span className="rounded-full bg-ak-surface-2 px-2 py-0.5 text-[10px] font-medium text-ak-text-tertiary">
        ...
      </span>
    );
  }
  const styles: Record<string, string> = {
    connected: 'bg-emerald-500/10 text-emerald-400',
    active: 'bg-emerald-500/10 text-emerald-400',
    disconnected: 'bg-ak-surface-2 text-ak-text-tertiary',
    'coming-soon': 'bg-amber-500/10 text-amber-400',
  };
  const labels: Record<string, string> = {
    connected: t('integrations.status.connected'),
    active: t('integrations.status.active'),
    disconnected: t('integrations.status.disconnected'),
    'coming-soon': t('integrations.slack.comingSoon'),
  };
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', styles[status])}>
      {labels[status]}
    </span>
  );
}

/* -- GitHub Section --------------------------------------------------- */

function GitHubSection() {
  const { t } = useI18n();
  const [ghStatus, setGhStatus] = useState<{
    connected: boolean;
    login?: string;
    avatarUrl?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/integrations/github/status', { credentials: 'include' });
      if (res.ok) setGhStatus(await res.json());
    } catch {
      // treat as not connected
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const connected = ghStatus?.connected === true;

  const handleConnect = () => {
    window.location.href = '/api/integrations/github/oauth/start';
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await fetch('/api/integrations/github', { method: 'DELETE', credentials: 'include' });
      setGhStatus({ connected: false });
    } catch {
      // silent
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="rounded-xl border border-ak-border bg-ak-surface p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-ak-surface-2">
            <svg
              className="h-[18px] w-[18px] text-ak-text-primary"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
          </div>
          <div>
            <span className="text-sm font-medium text-ak-text-primary">
              {t('integrations.github.title')}
            </span>
            <p className="text-[11px] text-ak-text-tertiary">
              {t('integrations.github.cardDescription')}
            </p>
          </div>
        </div>
        <StatusBadge status={loading ? 'loading' : connected ? 'connected' : 'disconnected'} />
      </div>

      {/* Connected state — show user info */}
      {connected && ghStatus?.login && (
        <div className="flex items-center gap-3 rounded-lg bg-ak-surface-2 p-3">
          {ghStatus.avatarUrl ? (
            <img
              src={ghStatus.avatarUrl}
              alt=""
              className="h-8 w-8 rounded-full border border-ak-border"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ak-primary/10 text-xs font-bold text-ak-primary">
              {ghStatus.login.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-ak-text-primary truncate">{ghStatus.login}</p>
            <p className="text-[10px] text-ak-text-tertiary">
              {t('integrations.github.connectedAs')}
            </p>
          </div>
        </div>
      )}

      {/* Action button */}
      {connected ? (
        <button
          onClick={handleDisconnect}
          disabled={disconnecting}
          className={cn(
            'w-full rounded-lg border border-red-500/30 bg-red-500/5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors',
            disconnecting && 'opacity-50 cursor-not-allowed'
          )}
        >
          {disconnecting ? '...' : t('integrations.github.disconnectButton')}
        </button>
      ) : !loading ? (
        <button
          onClick={handleConnect}
          className="w-full rounded-lg bg-ak-primary/10 py-2 text-xs font-medium text-ak-primary hover:bg-ak-primary/20 transition-colors"
        >
          {t('integrations.github.connectButton')}
        </button>
      ) : null}
    </div>
  );
}

/* -- Jira / Atlassian OAuth Section ----------------------------------- */

function JiraSection() {
  const { t } = useI18n();
  const [atlStatus, setAtlStatus] = useState<{
    connected: boolean;
    configured: boolean;
    jiraAvailable?: boolean;
    confluenceAvailable?: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showPatFallback, setShowPatFallback] = useState(false);

  // PAT fallback state (stored securely on backend, not localStorage)
  const [patUrl, setPatUrl] = useState('');
  const [patToken, setPatToken] = useState('');
  const [patStatus, setPatStatus] = useState<'idle' | 'testing' | 'connected' | 'error'>('idle');
  const [patError, setPatError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const [atlRes, jiraRes] = await Promise.all([
        fetch('/api/integrations/atlassian/status', { credentials: 'include' }).catch((err) => {
          if (import.meta.env.DEV) console.warn('[Settings] Atlassian status fetch failed:', err);
          return null;
        }),
        fetch('/api/settings/integrations/jira/status', { credentials: 'include' }).catch((err) => {
          if (import.meta.env.DEV) console.warn('[Settings] Jira status fetch failed:', err);
          return null;
        }),
      ]);
      if (atlRes?.ok) setAtlStatus(await atlRes.json());
      if (jiraRes?.ok) {
        const jiraData = await jiraRes.json();
        if (jiraData.connected) {
          setPatUrl(jiraData.siteUrl ?? '');
          setPatStatus('connected');
        }
      }
    } catch {
      // treat as not connected
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const oauthConnected = atlStatus?.connected === true;
  const patConnected = patStatus === 'connected';
  const isConnected = oauthConnected || patConnected;

  const handleOAuthConnect = () => {
    window.location.href = '/api/integrations/atlassian/oauth/start';
  };

  const handleOAuthDisconnect = async () => {
    setDisconnecting(true);
    try {
      await fetch('/api/integrations/atlassian/disconnect', {
        method: 'POST',
        credentials: 'include',
      });
      setAtlStatus({ connected: false, configured: atlStatus?.configured ?? false });
    } catch {
      // silent
    } finally {
      setDisconnecting(false);
    }
  };

  const handlePatTest = async () => {
    const trimmedUrl = patUrl.trim();
    const trimmedToken = patToken.trim();
    if (!trimmedUrl || !trimmedToken) return;

    setPatStatus('testing');
    setPatError(null);

    try {
      const res = await fetch('/api/integrations/jira/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: trimmedUrl, token: trimmedToken }),
      });

      if (res.ok) {
        // Store securely on backend instead of localStorage
        await fetch('/api/settings/integrations/jira/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ siteUrl: trimmedUrl, email: 'user@jira', token: trimmedToken }),
        });
        setPatStatus('connected');
      } else {
        setPatStatus('error');
        const data = await res.json().catch(() => ({}));
        setPatError(data.message ?? t('integrations.jira.testError'));
      }
    } catch {
      if (trimmedUrl.startsWith('https://') && trimmedToken.length >= 8) {
        // Store securely on backend
        await fetch('/api/settings/integrations/jira/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ siteUrl: trimmedUrl, email: 'user@jira', token: trimmedToken }),
        }).catch((err) => {
          if (import.meta.env.DEV) console.warn('[Settings] Jira connect save failed:', err);
        });
        setPatStatus('connected');
      } else {
        setPatStatus('error');
        setPatError(t('integrations.jira.testError'));
      }
    }
  };

  const handlePatDisconnect = async () => {
    try {
      await fetch('/api/settings/integrations/jira/disconnect', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      /* best-effort */
    }
    setPatUrl('');
    setPatToken('');
    setPatStatus('idle');
    setPatError(null);
  };

  return (
    <div className="rounded-xl border border-ak-border bg-ak-surface p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10">
            <svg
              className="h-[18px] w-[18px] text-blue-500"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.593 24V12.518a1.005 1.005 0 0 0-1.022-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.232h2.13v2.057a5.216 5.216 0 0 0 5.215 5.215V6.742a.988.988 0 0 0-1.002-.985zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.074A5.218 5.218 0 0 0 24.013 12.5V.985A.988.988 0 0 0 23.013 0z" />
            </svg>
          </div>
          <div>
            <span className="text-sm font-medium text-ak-text-primary">
              {t('integrations.jira.title')}
            </span>
            <p className="text-[11px] text-ak-text-tertiary">
              {t('integrations.jira.cardDescription')}
            </p>
          </div>
        </div>
        <StatusBadge status={loading ? 'loading' : isConnected ? 'connected' : 'disconnected'} />
      </div>

      {/* OAuth connected state */}
      {oauthConnected && (
        <div className="rounded-lg bg-ak-surface-2 p-3 space-y-2">
          <span className="text-[10px] font-medium text-ak-text-tertiary uppercase tracking-wide">
            {t('integrations.jira.oauthLabel')}
          </span>
          {atlStatus?.jiraAvailable && (
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="text-xs text-ak-text-secondary">Jira</span>
            </div>
          )}
          {atlStatus?.confluenceAvailable && (
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="text-xs text-ak-text-secondary">Confluence</span>
            </div>
          )}
        </div>
      )}

      {/* PAT connected state */}
      {!oauthConnected && patConnected && (
        <div className="rounded-lg bg-ak-surface-2 p-3">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span className="text-xs text-ak-text-secondary">{patUrl}</span>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {oauthConnected ? (
        <button
          onClick={handleOAuthDisconnect}
          disabled={disconnecting}
          className={cn(
            'w-full rounded-lg border border-red-500/30 bg-red-500/5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors',
            disconnecting && 'opacity-50 cursor-not-allowed'
          )}
        >
          {disconnecting ? '...' : t('integrations.jira.disconnect')}
        </button>
      ) : patConnected ? (
        <button
          onClick={handlePatDisconnect}
          className="w-full rounded-lg border border-red-500/30 bg-red-500/5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
        >
          {t('integrations.jira.disconnect')}
        </button>
      ) : !loading ? (
        <div className="space-y-2">
          <button
            onClick={handleOAuthConnect}
            className="w-full rounded-lg bg-ak-primary/10 py-2 text-xs font-medium text-ak-primary hover:bg-ak-primary/20 transition-colors"
          >
            {t('integrations.jira.oauthConnect')}
          </button>

          {/* PAT fallback toggle */}
          <button
            onClick={() => setShowPatFallback(!showPatFallback)}
            className="w-full text-center text-[10px] text-ak-text-tertiary hover:text-ak-text-secondary transition-colors"
          >
            {showPatFallback
              ? t('integrations.jira.hidePatFallback')
              : t('integrations.jira.showPatFallback')}
          </button>

          {/* PAT fallback form */}
          {showPatFallback && (
            <div className="rounded-lg border border-ak-border bg-ak-surface-2 p-3 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ak-text-secondary">
                  {t('integrations.jira.instanceUrl')}
                </label>
                <input
                  type="url"
                  value={patUrl}
                  onChange={(e) => {
                    setPatUrl(e.target.value);
                    if (patStatus !== 'idle') setPatStatus('idle');
                  }}
                  placeholder={t('integrations.jira.instanceUrlPlaceholder')}
                  className="w-full rounded-lg border border-ak-border bg-ak-bg px-3 py-2 text-xs text-ak-text-primary font-mono placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ak-text-secondary">
                  {t('integrations.jira.apiToken')}
                </label>
                <input
                  type="password"
                  value={patToken}
                  onChange={(e) => {
                    setPatToken(e.target.value);
                    if (patStatus !== 'idle') setPatStatus('idle');
                  }}
                  placeholder={t('integrations.jira.apiTokenPlaceholder')}
                  className="w-full rounded-lg border border-ak-border bg-ak-bg px-3 py-2 text-xs text-ak-text-primary font-mono placeholder:text-ak-text-tertiary focus:border-ak-primary focus:outline-none focus:ring-1 focus:ring-ak-primary/30"
                />
              </div>
              {patError && <p className="text-xs text-red-400">{patError}</p>}
              <button
                onClick={handlePatTest}
                disabled={!patUrl.trim() || !patToken.trim() || patStatus === 'testing'}
                className={cn(
                  'w-full rounded-lg bg-ak-primary/10 py-2 text-xs font-medium text-ak-primary hover:bg-ak-primary/20 transition-colors',
                  (!patUrl.trim() || !patToken.trim() || patStatus === 'testing') &&
                    'opacity-50 cursor-not-allowed'
                )}
              >
                {patStatus === 'testing'
                  ? t('integrations.jira.testing')
                  : t('integrations.jira.testConnection')}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Usage Tab                                                          */
/* ------------------------------------------------------------------ */

function UsageTab() {
  const { t } = useI18n();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getUsage>> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getUsage()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-dashed border-ak-border bg-ak-surface p-8 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-ak-surface-2">
          <svg
            className="h-5 w-5 text-ak-text-tertiary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z"
            />
          </svg>
        </div>
        <p className="text-xs text-ak-text-tertiary">{t('settings.usage.noData')}</p>
        <p className="mt-1 text-[10px] text-ak-text-tertiary">{t('settings.usage.emptyState')}</p>
      </div>
    );
  }

  const userIsAdmin = Boolean(data.userIsAdmin);
  const costBreakdown = data.breakdown;
  const costLabel = userIsAdmin ? 'Gercek Maliyet (Wholesale)' : 'Tahmini Maliyet';

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-ak-border bg-ak-surface p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ak-text-primary">
            {t('settings.usage.title')}
          </h2>
          <span className="rounded-full bg-ak-primary/10 px-2 py-0.5 text-[10px] font-semibold text-ak-primary">
            Sinirsiz
          </span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <UsageStatCard
            label="Calistirilan Is"
            value={String(data.usage.jobCount)}
            icon="&#9889;"
            color="text-yellow-400"
          />
          <UsageStatCard
            label="Token Kullanimi"
            value={formatTokens(data.usage.totalTokens)}
            icon="&#9881;"
            color="text-blue-400"
          />
          <UsageStatCard
            label={costLabel}
            value={`$${data.usage.estimatedCostUsd.toFixed(4)}`}
            icon="&#36;"
            color="text-emerald-400"
          />
        </div>

        {userIsAdmin && costBreakdown && (
          <div className="mt-4 rounded-lg border border-purple-500/30 bg-purple-500/5 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-300">
                Admin
              </span>
              <span className="text-xs text-ak-text-secondary">
                Maliyet Dagilimi (markup {costBreakdown.markup.toFixed(2)}x)
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded bg-ak-surface-2 p-2">
                <p className="text-[10px] uppercase text-ak-text-tertiary">Wholesale</p>
                <p className="font-mono text-sm text-ak-text-primary">
                  ${costBreakdown.wholesale.toFixed(4)}
                </p>
              </div>
              <div className="rounded bg-ak-surface-2 p-2">
                <p className="text-[10px] uppercase text-ak-text-tertiary">Retail</p>
                <p className="font-mono text-sm text-ak-text-primary">
                  ${costBreakdown.retail.toFixed(4)}
                </p>
              </div>
              <div className="rounded bg-ak-surface-2 p-2">
                <p className="text-[10px] uppercase text-ak-text-tertiary">Margin</p>
                <p className="font-mono text-sm text-emerald-400">
                  ${costBreakdown.margin.toFixed(4)}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-ak-border bg-ak-surface p-4">
        <h3 className="mb-3 text-sm font-semibold text-ak-text-primary">Detayli Dagilim</h3>
        <div className="space-y-2">
          <BreakdownRow
            label={t('settings.usage.inputTokens')}
            value={formatTokens(data.usage.inputTokens)}
          />
          <BreakdownRow
            label={t('settings.usage.outputTokens')}
            value={formatTokens(data.usage.outputTokens)}
          />
          <BreakdownRow label="Toplam Token" value={formatTokens(data.usage.totalTokens)} accent />
        </div>
      </div>

      {data.daily && data.daily.length > 0 && (
        <div className="rounded-xl border border-ak-border bg-ak-surface p-4">
          <h3 className="mb-3 text-sm font-semibold text-ak-text-primary">Gunluk Aktivite</h3>
          <DailyChart days={data.daily} />
          <div className="mt-3 space-y-1.5">
            {data.daily
              .slice()
              .reverse()
              .map((d) => (
                <div
                  key={d.date}
                  className="flex items-center justify-between rounded-lg bg-ak-surface-2 px-3 py-2"
                >
                  <span className="text-xs text-ak-text-secondary">
                    {new Date(d.date).toLocaleDateString('tr-TR', {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                  <div className="flex items-center gap-4">
                    <span className="text-xs font-mono text-ak-text-secondary">{d.jobs} is</span>
                    <span className="text-xs font-mono text-blue-400">
                      {formatTokens(d.tokens)}
                    </span>
                    <span className="text-xs font-mono text-emerald-400">${d.cost.toFixed(4)}</span>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DailyChart({
  days,
}: {
  days: Array<{ date: string; tokens: number; cost: number; jobs: number }>;
}) {
  const maxTokens = Math.max(...days.map((d) => d.tokens), 1);
  return (
    <div className="flex items-end gap-1" style={{ height: 80 }}>
      {days.map((d) => {
        const h = Math.max(4, (d.tokens / maxTokens) * 100);
        return (
          <div
            key={d.date}
            className="group relative flex flex-1 flex-col items-center justify-end"
            style={{ height: '100%' }}
          >
            <div
              className="w-full rounded-t bg-ak-primary/60 hover:bg-ak-primary transition-colors cursor-default"
              style={{ height: `${h}%`, minHeight: 4 }}
            />
            <span className="mt-1 text-[10px] text-ak-text-secondary">
              {new Date(d.date).getDate()}
            </span>
            {/* Tooltip */}
            <div className="pointer-events-none absolute -top-10 left-1/2 z-10 hidden -translate-x-1/2 rounded bg-ak-bg px-2 py-1 text-xs text-ak-text-primary shadow-lg border border-ak-border group-hover:block whitespace-nowrap">
              {formatTokens(d.tokens)} token &middot; {d.jobs} is
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UsageStatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string;
  icon: string;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-ak-border bg-ak-surface-2 p-3 text-center">
      <span className={cn('text-lg', color)}>{icon}</span>
      <p className="mt-1 text-base font-bold text-ak-text-primary">{value}</p>
      <p className="text-[10px] text-ak-text-tertiary">{label}</p>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  accent,
  warn,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-ak-surface-2 px-3 py-2">
      <span className="text-xs text-ak-text-secondary">{label}</span>
      <span
        className={cn(
          'text-xs font-mono font-medium',
          warn ? 'text-red-400' : accent ? 'text-ak-primary' : 'text-ak-text-primary'
        )}
      >
        {value}
      </span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/* ------------------------------------------------------------------ */
/*  Plan Tab                                                           */
/* ------------------------------------------------------------------ */
