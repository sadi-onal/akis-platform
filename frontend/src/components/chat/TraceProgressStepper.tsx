import { cn } from '../../utils/cn';
import type { PipelineActivity } from '../../hooks/usePipelineStream';

interface TraceProgressStepperProps {
  activities: PipelineActivity[];
  currentStep: PipelineActivity | null;
}

interface StepDef {
  key: string;
  label: string;
  matches: string[];
}

const STEPS: StepDef[] = [
  { key: 'fetching', label: 'Kaynak dosyalar okunuyor', matches: ['fetching'] },
  { key: 'analyzing', label: 'Test stratejisi belirleniyor', matches: ['analyzing'] },
  { key: 'ai_call', label: 'Playwright testleri oluşturuluyor', matches: ['ai_call', 'parsing'] },
  { key: 'traceability', label: 'Testler doğrulanıyor', matches: ['traceability', 'complete'] },
];

function firstTimestampFor(activities: PipelineActivity[], step: StepDef): string | null {
  for (const a of activities) {
    if (a.stage !== 'trace') continue;
    if (step.matches.includes(a.step)) return a.timestamp;
  }
  return null;
}

function formatElapsed(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const diff = Math.max(0, Math.round((end - start) / 1000));
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}dk ${s}sn`;
}

export function TraceProgressStepper({ activities, currentStep }: TraceProgressStepperProps) {
  const traceActivities = activities.filter((a) => a.stage === 'trace');
  const lastStep = currentStep && currentStep.stage === 'trace' ? currentStep : null;
  const isComplete = lastStep?.step === 'complete';
  const isErrored = lastStep?.step === 'error';
  const retryCount = lastStep?.retryCount ?? 0;

  const currentStepKey = (() => {
    if (!lastStep) return null;
    for (const s of STEPS) {
      if (s.matches.includes(lastStep.step)) return s.key;
    }
    return null;
  })();

  return (
    <div className="rounded-xl border border-ak-trace/20 bg-ak-surface/70 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-4 w-4 items-center justify-center rounded bg-ak-trace/20">
            <svg className="h-2.5 w-2.5 text-ak-trace" fill="currentColor" viewBox="0 0 24 24">
              <path d="M14.5 2a.5.5 0 010 1H13v2.382a6.002 6.002 0 014.472 4.118h2.028a.5.5 0 010 1h-2.028a6.002 6.002 0 01-4.472 4.118V17h1.5a.5.5 0 010 1h-5a.5.5 0 010-1H11v-2.382a6.002 6.002 0 01-4.472-4.118H4.5a.5.5 0 010-1h2.028A6.002 6.002 0 0111 5.382V3H9.5a.5.5 0 010-1h5z" />
            </svg>
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ak-trace">
            Trace İlerlemesi
          </span>
        </div>
        {retryCount > 0 && !isComplete && !isErrored && (
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
            Yeniden deneniyor ({retryCount}/3)
          </span>
        )}
      </div>
      <ol className="space-y-1.5">
        {STEPS.map((step, idx) => {
          const startTs = firstTimestampFor(traceActivities, step);
          const nextStep = STEPS[idx + 1];
          const nextStartTs = nextStep ? firstTimestampFor(traceActivities, nextStep) : null;
          const isStarted = startTs !== null;
          const isDone = nextStartTs !== null || (isComplete && isStarted);
          const isCurrent = !isDone && isStarted && currentStepKey === step.key;
          const isPending = !isStarted;

          const icon = isErrored && isCurrent ? (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500/20 text-red-400 transition-all duration-300">
              <svg className="h-2.5 w-2.5 animate-scale-in" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </span>
          ) : isDone ? (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-ak-primary/20 text-ak-primary transition-all duration-300">
              <svg className="h-2.5 w-2.5 animate-scale-in" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </span>
          ) : isCurrent ? (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-ak-trace/20 transition-all duration-300 animate-border-glow border border-ak-trace/30">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ak-trace" />
            </span>
          ) : (
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-ak-border-subtle transition-all duration-300">
              <span className="h-1 w-1 rounded-full bg-ak-text-tertiary/40" />
            </span>
          );

          return (
            <li key={step.key} className="flex items-center gap-2">
              {icon}
              <span
                className={cn(
                  'flex-1 text-[12px] leading-snug',
                  isPending
                    ? 'text-ak-text-tertiary/60'
                    : isCurrent
                      ? 'text-ak-text-primary font-medium'
                      : 'text-ak-text-secondary',
                )}
              >
                {step.label}
              </span>
              {isStarted && (
                <span className="text-[10px] text-ak-text-tertiary tabular-nums">
                  {formatElapsed(startTs!, nextStartTs ?? (isComplete && lastStep ? lastStep.timestamp : null))}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
