/**
 * EngineerPage — 4-step wizard for Engineer Rental Mode.
 *
 * Step 1: Repo Selection
 * Step 2: Task Discovery
 * Step 3: Time & Budget
 * Step 4: Confirmation
 */
import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { githubApi, type GitHubRepo } from '../../services/api/github';
import {
  engineerApi,
  type DiscoveredTask,
  type TaskCategory,
} from '../../services/api/engineer';

// ─── Constants ───────────────────────────────────────────

const MAX_TASKS = 5;

const CATEGORY_STYLES: Record<TaskCategory, { bg: string; text: string; label: string }> = {
  bug:      { bg: 'bg-red-500/20',    text: 'text-red-400',    label: 'Hata' },
  feature:  { bg: 'bg-[#07D1AF]/20',  text: 'text-[#07D1AF]',  label: 'Ozellik' },
  docs:     { bg: 'bg-blue-500/20',   text: 'text-blue-400',   label: 'Dokumantasyon' },
  security: { bg: 'bg-orange-500/20', text: 'text-orange-400', label: 'Guvenlik' },
  test:     { bg: 'bg-purple-500/20', text: 'text-purple-400', label: 'Test' },
  refactor: { bg: 'bg-gray-500/20',   text: 'text-gray-400',   label: 'Refactor' },
};

interface TimeBudgetPreset {
  minutes: number;
  label: string;
  cost: number;
}

const TIME_PRESETS: TimeBudgetPreset[] = [
  { minutes: 30,  label: '30 dk', cost: 0.50 },
  { minutes: 60,  label: '1 saat', cost: 1.00 },
  { minutes: 120, label: '2 saat', cost: 2.00 },
  { minutes: 180, label: '3 saat', cost: 3.00 },
];

// ─── Helper Components ───────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 mb-8">
      {Array.from({ length: total }, (_, i) => {
        const step = i + 1;
        const isActive = step === current;
        const isDone = step < current;
        return (
          <div key={step} className="flex items-center gap-2">
            <div
              className={`
                flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-all
                ${isActive ? 'bg-[#07D1AF] text-black' : ''}
                ${isDone ? 'bg-[#07D1AF]/30 text-[#07D1AF]' : ''}
                ${!isActive && !isDone ? 'bg-white/[0.06] text-white/40' : ''}
              `}
            >
              {isDone ? (
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                step
              )}
            </div>
            {step < total && (
              <div className={`h-px w-8 ${step < current ? 'bg-[#07D1AF]/40' : 'bg-white/[0.06]'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ComplexityDots({ level }: { level: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3].map((dot) => (
        <div
          key={dot}
          className={`h-2 w-2 rounded-full ${
            dot <= level ? 'bg-[#07D1AF]' : 'bg-white/[0.1]'
          }`}
        />
      ))}
    </div>
  );
}

function CategoryBadge({ category }: { category: TaskCategory }) {
  const style = CATEGORY_STYLES[category];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

// ─── Step Components ─────────────────────────────────────

function Step1RepoSelection({
  repos,
  loading,
  selectedRepo,
  onSelect,
}: {
  repos: GitHubRepo[];
  loading: boolean;
  selectedRepo: GitHubRepo | null;
  onSelect: (repo: GitHubRepo) => void;
}) {
  const [search, setSearch] = useState('');

  const filtered = repos.filter((r) =>
    r.fullName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-white flex items-center gap-3">
          <span className="text-2xl">&#x1F527;</span>
          Muhendis Modu
        </h2>
        <p className="mt-2 text-white/50">
          Reponuzu secin, AI muhendisiniz calismaya baslasin
        </p>
      </div>

      <div className="mb-4">
        <input
          type="text"
          placeholder="Repo ara..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg bg-white/[0.03] border border-white/[0.06] px-4 py-3 text-white placeholder:text-white/30 focus:border-[#07D1AF]/40 focus:outline-none focus:ring-1 focus:ring-[#07D1AF]/20"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#07D1AF] border-t-transparent" />
        </div>
      ) : (
        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <p className="text-center text-white/40 py-8">Repo bulunamadi</p>
          ) : (
            filtered.map((repo) => (
              <button
                key={repo.fullName}
                onClick={() => onSelect(repo)}
                className={`
                  w-full text-left rounded-xl border px-4 py-3 transition-all
                  ${
                    selectedRepo?.fullName === repo.fullName
                      ? 'border-[#07D1AF]/50 bg-[#07D1AF]/[0.08]'
                      : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.05] hover:border-white/[0.1]'
                  }
                `}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">{repo.fullName}</p>
                    <p className="text-xs text-white/40 mt-0.5">
                      {repo.private ? 'Ozel' : 'Acik'} &middot; {new Date(repo.updatedAt).toLocaleDateString('tr-TR')}
                    </p>
                  </div>
                  {selectedRepo?.fullName === repo.fullName && (
                    <svg className="h-5 w-5 text-[#07D1AF]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Step2TaskDiscovery({
  tasks,
  loading,
  selectedIds,
  onToggle,
}: {
  tasks: DiscoveredTask[];
  loading: boolean;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-[#07D1AF] border-t-transparent mb-4" />
        <p className="text-white/50">Muhendis reponuzu analiz ediyor...</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-white">Gorev Secimi</h2>
          <p className="mt-1 text-white/50">Muhendisin calismasini istediginiz gorevleri secin</p>
        </div>
        <div className="rounded-full bg-white/[0.06] px-3 py-1.5 text-sm text-white/70">
          <span className={selectedIds.size >= MAX_TASKS ? 'text-orange-400' : 'text-[#07D1AF]'}>
            {selectedIds.size}
          </span>
          /{MAX_TASKS} gorev secildi
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tasks.map((task) => {
          const isSelected = selectedIds.has(task.id);
          const isDisabled = !isSelected && selectedIds.size >= MAX_TASKS;
          const isExpanded = expandedId === task.id;

          return (
            <div
              key={task.id}
              className={`
                rounded-xl border p-4 transition-all
                ${isSelected
                  ? 'border-[#07D1AF]/50 bg-[#07D1AF]/[0.08]'
                  : isDisabled
                    ? 'border-white/[0.04] bg-white/[0.01] opacity-50'
                    : 'border-white/[0.06] bg-white/[0.03] hover:border-white/[0.1]'
                }
              `}
            >
              <div className="flex items-start gap-3">
                <button
                  onClick={() => !isDisabled && onToggle(task.id)}
                  disabled={isDisabled}
                  className={`
                    mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all
                    ${isSelected
                      ? 'border-[#07D1AF] bg-[#07D1AF] text-black'
                      : 'border-white/20 hover:border-white/40'
                    }
                    ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}
                  `}
                >
                  {isSelected && (
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CategoryBadge category={task.category} />
                    <span className="text-xs text-white/40">{task.estimatedMinutes} dk</span>
                    <ComplexityDots level={task.complexity} />
                  </div>
                  <p className="mt-1.5 text-sm font-medium text-white leading-snug">{task.title}</p>
                  <p className="mt-1 text-xs text-white/40 line-clamp-2">{task.description}</p>

                  <button
                    onClick={() => setExpandedId(isExpanded ? null : task.id)}
                    className="mt-2 text-xs text-[#07D1AF]/70 hover:text-[#07D1AF] transition-colors"
                  >
                    {isExpanded ? 'Dosyalari gizle' : `${task.affectedFiles.length} dosya`}
                  </button>

                  {isExpanded && (
                    <div className="mt-2 space-y-1">
                      {task.affectedFiles.map((file) => (
                        <p key={file} className="text-xs text-white/30 font-mono">{file}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Step3TimeBudget({
  selectedTasks,
  selectedMinutes,
  onSelectMinutes,
}: {
  selectedTasks: DiscoveredTask[];
  selectedMinutes: number;
  onSelectMinutes: (minutes: number) => void;
}) {
  const totalEstimated = selectedTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
  const selectedPreset = TIME_PRESETS.find((p) => p.minutes === selectedMinutes);
  const isTimeTight = selectedMinutes < totalEstimated;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-white">Zaman ve Butce</h2>
        <p className="mt-1 text-white/50">Muhendisinize ne kadar sure verin</p>
      </div>

      {/* Preset buttons */}
      <div className="flex gap-3 mb-8">
        {TIME_PRESETS.map((preset) => (
          <button
            key={preset.minutes}
            onClick={() => onSelectMinutes(preset.minutes)}
            className={`
              flex-1 rounded-xl border px-4 py-4 text-center transition-all
              ${selectedMinutes === preset.minutes
                ? 'border-[#07D1AF]/50 bg-[#07D1AF]/[0.12] ring-1 ring-[#07D1AF]/20'
                : 'border-white/[0.06] bg-white/[0.03] hover:border-white/[0.1]'
              }
            `}
          >
            <p className={`text-lg font-semibold ${selectedMinutes === preset.minutes ? 'text-[#07D1AF]' : 'text-white'}`}>
              {preset.label}
            </p>
            <p className="text-sm text-white/40 mt-1">${preset.cost.toFixed(2)}</p>
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
        <h3 className="text-sm font-medium text-white/70 mb-4">Ozet</h3>
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-white/50">Secili gorevler</span>
            <span className="text-white">{selectedTasks.length} gorev</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-white/50">Tahmini sure</span>
            <span className="text-white">{totalEstimated} dakika</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-white/50">Tahsis edilen sure</span>
            <span className={selectedMinutes > 0 ? 'text-[#07D1AF]' : 'text-white/30'}>
              {selectedMinutes > 0 ? `${selectedMinutes} dakika` : 'Seciniz'}
            </span>
          </div>
          <div className="border-t border-white/[0.06] pt-3 flex justify-between text-sm">
            <span className="text-white/50">Maliyet</span>
            <span className="text-white font-semibold">
              {selectedPreset ? `$${selectedPreset.cost.toFixed(2)}` : '-'}
            </span>
          </div>
        </div>
      </div>

      {isTimeTight && selectedMinutes > 0 && (
        <div className="mt-4 rounded-lg border border-orange-500/30 bg-orange-500/10 px-4 py-3">
          <p className="text-sm text-orange-400">
            Tahsis edilen sure ({selectedMinutes} dk) tahmini sureden ({totalEstimated} dk) az.
            Bazi gorevler tamamlanamayabilir.
          </p>
        </div>
      )}
    </div>
  );
}

function Step4Confirmation({
  selectedTasks,
  selectedMinutes,
  cost,
  onConfirm,
  confirming,
}: {
  selectedTasks: DiscoveredTask[];
  selectedMinutes: number;
  cost: number;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const hours = Math.floor(selectedMinutes / 60);
  const mins = selectedMinutes % 60;
  const timeLabel = hours > 0
    ? mins > 0
      ? `${hours} saat ${mins} dk`
      : `${hours} saat`
    : `${mins} dk`;

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold text-white">Onay</h2>
        <p className="mt-1 text-white/50">Hersey hazir mi? Kontrol edin ve baslatin</p>
      </div>

      {/* Big summary */}
      <div className="rounded-xl border border-[#07D1AF]/30 bg-[#07D1AF]/[0.06] p-6 mb-6 text-center">
        <p className="text-3xl font-bold text-white">
          {selectedTasks.length} gorev &middot; {timeLabel} &middot; ${cost.toFixed(2)}
        </p>
      </div>

      {/* Task list */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] divide-y divide-white/[0.06]">
        {selectedTasks.map((task, i) => (
          <div key={task.id} className="flex items-center gap-3 px-4 py-3">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.06] text-xs text-white/50">
              {i + 1}
            </span>
            <CategoryBadge category={task.category} />
            <span className="text-sm text-white flex-1 truncate">{task.title}</span>
            <span className="text-xs text-white/40">{task.estimatedMinutes} dk</span>
          </div>
        ))}
      </div>

      {/* Start button */}
      <button
        onClick={onConfirm}
        disabled={confirming}
        className="mt-8 w-full rounded-xl bg-[#07D1AF] px-6 py-4 text-lg font-semibold text-black transition-all hover:bg-[#07D1AF]/90 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {confirming ? (
          <span className="flex items-center justify-center gap-2">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-black/30 border-t-black" />
            Baslatiliyor...
          </span>
        ) : (
          'Muhendisi Baslat'
        )}
      </button>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────

export default function EngineerPage() {
  const navigate = useNavigate();

  // Wizard state
  const [step, setStep] = useState(1);

  // Step 1 — Repo
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);

  // Step 2 — Tasks
  const [tasks, setTasks] = useState<DiscoveredTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());

  // Step 3 — Time
  const [selectedMinutes, setSelectedMinutes] = useState(0);

  // Step 4 — Confirm
  const [confirming, setConfirming] = useState(false);

  // Fetch repos on mount
  useEffect(() => {
    let cancelled = false;
    githubApi.listRepos()
      .then((data) => { if (!cancelled) setRepos(data); })
      .catch(() => { /* toast error would go here */ })
      .finally(() => { if (!cancelled) setReposLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Discover tasks when repo changes
  const discoverTasks = useCallback(async (repo: GitHubRepo) => {
    setTasksLoading(true);
    setTasks([]);
    setSelectedTaskIds(new Set());
    try {
      const [owner, name] = repo.fullName.split('/');
      const res = await engineerApi.discoverTasks(owner, name);
      setTasks(res.tasks);
    } catch {
      // Error handling
    } finally {
      setTasksLoading(false);
    }
  }, []);

  // Handle repo selection
  const handleRepoSelect = useCallback((repo: GitHubRepo) => {
    setSelectedRepo(repo);
    setStep(2);
    discoverTasks(repo);
  }, [discoverTasks]);

  // Toggle task selection
  const handleTaskToggle = useCallback((id: string) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_TASKS) {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Confirm and start
  const handleConfirm = useCallback(async () => {
    if (!selectedRepo || selectedTaskIds.size === 0 || selectedMinutes === 0) return;
    setConfirming(true);
    try {
      const [owner, name] = selectedRepo.fullName.split('/');
      const { session } = await engineerApi.createSession({
        owner,
        repo: name,
        selectedTaskIds: Array.from(selectedTaskIds),
        timeBudgetMinutes: selectedMinutes,
      });
      await engineerApi.startSession(session.id);
      navigate(`/engineer/session/${session.id}`);
    } catch {
      // Error handling
      setConfirming(false);
    }
  }, [selectedRepo, selectedTaskIds, selectedMinutes, navigate]);

  // Derived
  const selectedTasks = tasks.filter((t) => selectedTaskIds.has(t.id));
  const cost = TIME_PRESETS.find((p) => p.minutes === selectedMinutes)?.cost ?? 0;

  const canProceedStep2 = selectedTaskIds.size > 0;
  const canProceedStep3 = selectedMinutes > 0;

  return (
    <div className="min-h-screen bg-[#0A1215]">
      <div className="mx-auto max-w-3xl px-4 py-12">
        {/* Back to chat */}
        <button
          onClick={() => navigate('/chat')}
          className="mb-6 flex items-center gap-1.5 text-sm text-white/40 hover:text-white/60 transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
          Chat'e don
        </button>

        <StepIndicator current={step} total={4} />

        {/* Step content */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-sm p-6 md:p-8">
          {step === 1 && (
            <Step1RepoSelection
              repos={repos}
              loading={reposLoading}
              selectedRepo={selectedRepo}
              onSelect={handleRepoSelect}
            />
          )}

          {step === 2 && (
            <Step2TaskDiscovery
              tasks={tasks}
              loading={tasksLoading}
              selectedIds={selectedTaskIds}
              onToggle={handleTaskToggle}
            />
          )}

          {step === 3 && (
            <Step3TimeBudget
              selectedTasks={selectedTasks}
              selectedMinutes={selectedMinutes}
              onSelectMinutes={setSelectedMinutes}
            />
          )}

          {step === 4 && (
            <Step4Confirmation
              selectedTasks={selectedTasks}
              selectedMinutes={selectedMinutes}
              cost={cost}
              onConfirm={handleConfirm}
              confirming={confirming}
            />
          )}
        </div>

        {/* Navigation buttons */}
        {step > 1 && step < 4 && (
          <div className="mt-6 flex items-center justify-between">
            <button
              onClick={() => setStep((s) => s - 1)}
              className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-5 py-2.5 text-sm text-white/70 hover:bg-white/[0.06] transition-all"
            >
              Geri
            </button>
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={step === 2 ? !canProceedStep2 : !canProceedStep3}
              className="rounded-lg bg-[#07D1AF] px-5 py-2.5 text-sm font-medium text-black hover:bg-[#07D1AF]/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Devam Et
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="mt-4 text-center">
            <button
              onClick={() => setStep(3)}
              className="text-sm text-white/40 hover:text-white/60 transition-colors"
            >
              Geri don
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
