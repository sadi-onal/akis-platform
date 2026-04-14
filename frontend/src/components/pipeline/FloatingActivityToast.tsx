import { useState, useEffect, useRef } from 'react';
import { useI18n } from '../../i18n/useI18n';

interface FloatingActivityToastProps {
  activity: {
    stage: 'scribe' | 'proto' | 'trace';
    message: string;
    progress?: number;
    step?: string;
  } | null;
  isActive: boolean;
  pipelineStatus?: string;
  onClickNavigate?: () => void;
}

const AGENT_COLORS: Record<string, string> = {
  scribe: 'var(--ak-scribe, #3b82f6)',
  proto: 'var(--ak-proto, #f59e0b)',
  trace: 'var(--ak-trace, #8b5cf6)',
};

const AGENT_LABELS: Record<string, string> = {
  scribe: 'Scribe',
  proto: 'Proto',
  trace: 'Trace',
};

export function FloatingActivityToast({
  activity,
  isActive,
  pipelineStatus,
  onClickNavigate,
}: FloatingActivityToastProps) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPipelineStatus = useRef(pipelineStatus);

  useEffect(() => {
    if (isActive && activity && !dismissed) {
      setVisible(true);
      setExiting(false);
    } else if (!isActive && visible) {
      timeoutRef.current = setTimeout(() => {
        setExiting(true);
        setTimeout(() => setVisible(false), 300);
      }, 2000);
    }
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isActive, activity, dismissed, visible]);

  // Reset dismissed when pipeline status changes (new pipeline starts)
  useEffect(() => {
    if (pipelineStatus !== prevPipelineStatus.current) {
      prevPipelineStatus.current = pipelineStatus;
      setDismissed(false);
    }
  }, [pipelineStatus]);

  if (!visible) return null;

  const color = activity ? AGENT_COLORS[activity.stage] || '#10b981' : '#10b981';
  const label = activity ? AGENT_LABELS[activity.stage] || activity.stage : '';
  const isComplete =
    activity?.step === 'complete' || activity?.step === 'pipeline_complete';
  const message =
    isComplete
      ? t('chat.toast.completed')
      : activity?.message || (pipelineStatus === 'completed' ? t('chat.toast.pipelineCompleted') : t('chat.toast.running'));
  const progress = activity?.progress || 0;

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissed(true);
    setExiting(true);
    setTimeout(() => setVisible(false), 300);
  };

  return (
    <>
      <style>{`
        @keyframes ak-toast-float-in {
          from { transform: translateX(-50%) translateY(-20px); opacity: 0; }
          to   { transform: translateX(-50%) translateY(0);     opacity: 1; }
        }
        @keyframes ak-toast-pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.4; transform: scale(0.85); }
        }
      `}</style>

      <div
        role="status"
        aria-live="polite"
        onClick={onClickNavigate}
        className="fixed z-[9999] select-none"
        style={{
          top: 20,
          left: '50%',
          transform: `translateX(-50%) translateY(${exiting ? '-20px' : '0'})`,
          opacity: exiting ? 0 : 1,
          transition: 'transform 0.3s ease-out, opacity 0.3s ease-out',
          minWidth: 320,
          maxWidth: 480,
          animation: !exiting ? 'ak-toast-float-in 0.3s ease-out' : undefined,
          cursor: onClickNavigate ? 'pointer' : 'default',
        }}
      >
        {/* Glassmorphism container */}
        <div
          className="rounded-2xl border px-5 py-3 relative"
          style={{
            background: 'rgba(255, 255, 255, 0.88)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            borderColor: 'rgba(0, 0, 0, 0.08)',
            boxShadow:
              '0 8px 32px rgba(0, 0, 0, 0.08), 0 2px 8px rgba(0, 0, 0, 0.04)',
          }}
        >
          {/* Dismiss button */}
          <button
            onClick={handleDismiss}
            className="absolute top-1.5 right-2.5 text-ak-text-tertiary hover:text-ak-text-secondary transition-colors text-sm leading-none"
            aria-label="Kapat"
          >
            &times;
          </button>

          {/* Top row: pulse dot + agent label + separator + message */}
          <div className="flex items-center gap-2 pr-4">
            {/* Pulse dot */}
            <span
              className="flex-shrink-0 rounded-full"
              style={{
                width: 8,
                height: 8,
                backgroundColor: color,
                boxShadow: `0 0 8px ${color}60`,
                animation: isComplete
                  ? 'none'
                  : 'ak-toast-pulse-dot 1.5s ease-in-out infinite',
              }}
            />

            {/* Agent label */}
            <span
              className="text-[13px] font-semibold flex-shrink-0"
              style={{ color, transition: 'color 0.4s ease' }}
            >
              {label}
            </span>

            <span className="text-ak-text-tertiary text-[13px]">&middot;</span>

            {/* Message */}
            <span className="text-[13px] text-ak-text-secondary truncate flex-1">
              {message}
            </span>
          </div>

          {/* Progress bar */}
          {progress > 0 && !isComplete && (
            <div
              className="mt-2 h-[3px] rounded-full overflow-hidden"
              style={{ background: 'rgba(0, 0, 0, 0.06)' }}
            >
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${Math.min(progress, 100)}%`,
                  background: `linear-gradient(90deg, ${color}, ${color}cc)`,
                }}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
