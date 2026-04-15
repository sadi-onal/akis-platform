/**
 * EngineerSessionPage — Live session view for Engineer Rental Mode.
 *
 * Shows countdown timer, current task, completed/queued tasks,
 * and final report on completion.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  engineerApi,
  type SessionProgress,
  type SessionReport,
  type SessionTask,
  type TaskCategory,
} from '../../services/api/engineer';

// ─── Constants ───────────────────────────────────────────

const POLL_INTERVAL_MS = 3000;

const CATEGORY_STYLES: Record<TaskCategory, { bg: string; text: string; label: string }> = {
  bug:      { bg: 'bg-red-500/20',    text: 'text-red-400',    label: 'Hata' },
  feature:  { bg: 'bg-[#07D1AF]/20',  text: 'text-[#07D1AF]',  label: 'Ozellik' },
  docs:     { bg: 'bg-blue-500/20',   text: 'text-blue-400',   label: 'Dokumantasyon' },
  security: { bg: 'bg-orange-500/20', text: 'text-orange-400', label: 'Guvenlik' },
  test:     { bg: 'bg-purple-500/20', text: 'text-purple-400', label: 'Test' },
  refactor: { bg: 'bg-gray-500/20',   text: 'text-gray-400',   label: 'Refactor' },
};

// ─── Helpers ─────────────────────────────────────────────

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getTimerColor(seconds: number): string {
  if (seconds <= 0) return 'text-red-500 animate-pulse';
  if (seconds < 300) return 'text-orange-400';
  return 'text-[#07D1AF]';
}

function CategoryBadge({ category }: { category: TaskCategory }) {
  const style = CATEGORY_STYLES[category];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

// ─── Sub-Components ──────────────────────────────────────

function CountdownTimer({ seconds }: { seconds: number }) {
  return (
    <div className="text-center py-6">
      <p className="text-xs uppercase tracking-widest text-white/40 mb-2">Kalan Sure</p>
      <p className={`text-6xl font-mono font-bold tabular-nums ${getTimerColor(seconds)}`}>
        {formatTime(seconds)}
      </p>
    </div>
  );
}

function CurrentTaskCard({ task }: { task: SessionTask }) {
  return (
    <div className="rounded-xl border border-[#07D1AF]/30 bg-[#07D1AF]/[0.06] p-6">
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex h-3 w-3">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#07D1AF] opacity-75" />
          <span className="relative inline-flex h-3 w-3 rounded-full bg-[#07D1AF]" />
        </div>
        <span className="text-sm font-medium text-[#07D1AF]">Calisiyor...</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <CategoryBadge category={task.category} />
      </div>
      <h3 className="text-lg font-semibold text-white">{task.title}</h3>
    </div>
  );
}

function CompletedTaskItem({ task }: { task: SessionTask }) {
  const mins = Math.floor(task.timeSpentSeconds / 60);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <svg className="h-5 w-5 text-green-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{task.title}</p>
        <div className="flex items-center gap-3 mt-0.5">
          <CategoryBadge category={task.category} />
          {task.criticScore !== null && (
            <span className="text-xs text-white/40">Puan: {task.criticScore}</span>
          )}
          {mins > 0 && <span className="text-xs text-white/40">{mins} dk</span>}
        </div>
      </div>
    </div>
  );
}

function QueuedTaskItem({ task, index }: { task: SessionTask; index: number }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 opacity-40">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/[0.06] text-xs text-white/50">
        {index}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{task.title}</p>
        <CategoryBadge category={task.category} />
      </div>
    </div>
  );
}

function SessionControls({
  status,
  onPause,
  onResume,
  onCancel,
}: {
  status: string;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-3 justify-center mt-4">
      {status === 'running' && (
        <button
          onClick={onPause}
          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 py-2 text-sm text-white/70 hover:bg-white/[0.06] transition-all"
        >
          Duraklat
        </button>
      )}
      {status === 'paused' && (
        <button
          onClick={onResume}
          className="rounded-lg bg-[#07D1AF] px-4 py-2 text-sm font-medium text-black hover:bg-[#07D1AF]/90 transition-all"
        >
          Devam Et
        </button>
      )}
      {(status === 'running' || status === 'paused') && (
        <button
          onClick={onCancel}
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 hover:bg-red-500/20 transition-all"
        >
          Iptal Et
        </button>
      )}
    </div>
  );
}

// ─── Completed / Report View ─────────────────────────────

function CompletedReport({
  report,
  onNewSession,
}: {
  report: SessionReport;
  onNewSession: () => void;
}) {
  const hours = Math.floor(report.totalTimeSeconds / 3600);
  const mins = Math.floor((report.totalTimeSeconds % 3600) / 60);
  const timeLabel = hours > 0 ? `${hours}s ${mins}dk` : `${mins} dk`;
  const completedCount = report.tasks.filter((t) => t.status === 'completed').length;

  return (
    <div>
      {/* Success banner */}
      <div className="text-center py-8">
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-[#07D1AF]/20 mb-4">
          <svg className="h-8 w-8 text-[#07D1AF]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-white">
          {report.status === 'completed' ? 'Tamamlandi!' : 'Iptal Edildi'}
        </h2>
        <p className="text-white/50 mt-1">
          {report.owner}/{report.repo}
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-center">
          <p className="text-2xl font-bold text-white">{completedCount}/{report.tasks.length}</p>
          <p className="text-xs text-white/40 mt-1">Gorev</p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-center">
          <p className="text-2xl font-bold text-white">{timeLabel}</p>
          <p className="text-xs text-white/40 mt-1">Toplam Sure</p>
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-center">
          <p className="text-2xl font-bold text-white">${report.totalCost.toFixed(2)}</p>
          <p className="text-xs text-white/40 mt-1">Maliyet</p>
        </div>
      </div>

      {/* PR Link */}
      {report.prUrl && (
        <a
          href={report.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-6 flex items-center justify-center gap-2 rounded-xl bg-[#07D1AF] px-6 py-3 text-sm font-semibold text-black hover:bg-[#07D1AF]/90 transition-all"
        >
          <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          Pull Request'i Gor
        </a>
      )}

      {/* Task results table */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="px-4 py-3 text-left text-xs font-medium text-white/50">Gorev</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-white/50">Durum</th>
              <th className="px-4 py-3 text-center text-xs font-medium text-white/50">Puan</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-white/50">Sure</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {report.tasks.map((task) => {
              const taskMins = Math.floor(task.timeSpentSeconds / 60);
              return (
                <tr key={task.id}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <CategoryBadge category={task.category} />
                      <span className="text-sm text-white truncate max-w-[200px]">{task.title}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {task.status === 'completed' ? (
                      <span className="text-xs text-green-400">Tamamlandi</span>
                    ) : task.status === 'failed' ? (
                      <span className="text-xs text-red-400">Basarisiz</span>
                    ) : (
                      <span className="text-xs text-white/40">Beklemede</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {task.criticScore !== null ? (
                      <span className={`text-sm font-medium ${
                        task.criticScore >= 90 ? 'text-green-400' :
                        task.criticScore >= 70 ? 'text-[#07D1AF]' :
                        'text-orange-400'
                      }`}>
                        {task.criticScore}
                      </span>
                    ) : (
                      <span className="text-xs text-white/30">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-sm text-white/60">
                    {taskMins > 0 ? `${taskMins} dk` : '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* New session button */}
      <div className="mt-8 text-center">
        <button
          onClick={onNewSession}
          className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-6 py-3 text-sm text-white/70 hover:bg-white/[0.06] transition-all"
        >
          Yeni Oturum
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────

export default function EngineerSessionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [progress, setProgress] = useState<SessionProgress | null>(null);
  const [report, setReport] = useState<SessionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localTimeRemaining, setLocalTimeRemaining] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll for progress
  const fetchProgress = useCallback(async () => {
    if (!id) return;
    try {
      const res = await engineerApi.getSessionProgress(id);
      setProgress(res.progress);
      setLocalTimeRemaining(res.progress.timeRemainingSeconds);
      setError(null);

      // If completed or cancelled, fetch report and stop polling
      if (res.progress.status === 'completed' || res.progress.status === 'cancelled') {
        const reportRes = await engineerApi.getSessionReport(id);
        setReport(reportRes.report);
        if (pollRef.current) clearInterval(pollRef.current);
      }
    } catch {
      setError('Oturum durumu alinamadi');
    }
  }, [id]);

  // Start polling
  useEffect(() => {
    fetchProgress();
    pollRef.current = setInterval(fetchProgress, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchProgress]);

  // Local countdown timer (decrements every second between polls)
  useEffect(() => {
    if (progress?.status !== 'running') {
      if (countdownRef.current) clearInterval(countdownRef.current);
      return;
    }
    countdownRef.current = setInterval(() => {
      setLocalTimeRemaining((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [progress?.status]);

  // Actions
  const handlePause = useCallback(async () => {
    if (!id) return;
    await engineerApi.pauseSession(id);
    fetchProgress();
  }, [id, fetchProgress]);

  const handleResume = useCallback(async () => {
    if (!id) return;
    await engineerApi.resumeSession(id);
    fetchProgress();
  }, [id, fetchProgress]);

  const handleCancel = useCallback(async () => {
    if (!id) return;
    await engineerApi.cancelSession(id);
    fetchProgress();
  }, [id, fetchProgress]);

  // Loading state
  if (!progress && !error) {
    return (
      <div className="min-h-screen bg-[#0A1215] flex items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-[#07D1AF] border-t-transparent" />
      </div>
    );
  }

  // Error state
  if (error && !progress) {
    return (
      <div className="min-h-screen bg-[#0A1215] flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <button
            onClick={() => navigate('/engineer')}
            className="text-sm text-[#07D1AF] hover:underline"
          >
            Muhendis Modu'na don
          </button>
        </div>
      </div>
    );
  }

  // Report view (completed/cancelled)
  if (report) {
    return (
      <div className="min-h-screen bg-[#0A1215]">
        <div className="mx-auto max-w-3xl px-4 py-12">
          <CompletedReport
            report={report}
            onNewSession={() => navigate('/engineer')}
          />
        </div>
      </div>
    );
  }

  // Live session view
  const currentTask = progress?.currentTask ?? null;
  const completedTasks = progress?.completedTasks ?? [];
  const queuedTasks = progress?.queuedTasks ?? [];
  const timeRemaining = localTimeRemaining ?? progress?.timeRemainingSeconds ?? 0;

  return (
    <div className="min-h-screen bg-[#0A1215]">
      <div className="mx-auto max-w-3xl px-4 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <button
            onClick={() => navigate('/engineer')}
            className="flex items-center gap-1.5 text-sm text-white/40 hover:text-white/60 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
            </svg>
            Muhendis Modu
          </button>
          {progress && (
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${
              progress.status === 'running' ? 'bg-[#07D1AF]/20 text-[#07D1AF]' :
              progress.status === 'paused' ? 'bg-orange-500/20 text-orange-400' :
              'bg-white/[0.06] text-white/50'
            }`}>
              {progress.status === 'running' ? 'Calisiyor' :
               progress.status === 'paused' ? 'Duraklatildi' :
               progress.status}
            </span>
          )}
        </div>

        {/* Countdown */}
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-sm mb-6">
          <CountdownTimer seconds={timeRemaining} />
          <SessionControls
            status={progress?.status ?? ''}
            onPause={handlePause}
            onResume={handleResume}
            onCancel={handleCancel}
          />
          <div className="h-4" />
        </div>

        {/* Current task */}
        {currentTask && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-white/50 mb-3">Mevcut Gorev</h3>
            <CurrentTaskCard task={currentTask} />
          </div>
        )}

        {/* Two columns: completed + queued */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Completed */}
          <div>
            <h3 className="text-sm font-medium text-white/50 mb-3">
              Tamamlanan ({completedTasks.length})
            </h3>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] divide-y divide-white/[0.06]">
              {completedTasks.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-white/30">Henuz tamamlanan gorev yok</p>
              ) : (
                completedTasks.map((task) => <CompletedTaskItem key={task.id} task={task} />)
              )}
            </div>
          </div>

          {/* Queued */}
          <div>
            <h3 className="text-sm font-medium text-white/50 mb-3">
              Sirada ({queuedTasks.length})
            </h3>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] divide-y divide-white/[0.06]">
              {queuedTasks.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-white/30">Tum gorevler islendi</p>
              ) : (
                queuedTasks.map((task, i) => (
                  <QueuedTaskItem key={task.id} task={task} index={i + 1} />
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
