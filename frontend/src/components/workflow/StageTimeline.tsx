import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../utils/cn';
import { formatConfidence } from '../../utils/format';
import { StatusBadge } from './StatusBadge';
import { SpecView } from './SpecView';
import { ActivityLog } from '../pipeline/ActivityLog';
import type { Workflow, StageResult } from '../../types/workflow';
import type { PipelineActivity } from '../../hooks/usePipelineStream';

const STAGE_META = [
  { key: 'scribe' as const, label: 'Scribe', role: 'Fikir → Spec', color: '#38bdf8', icon: '◆' },
  { key: 'approve' as const, label: 'İnsan Onayı', role: 'Human-in-the-loop', color: '#2dd4a8', icon: '✓' },
  { key: 'proto' as const, label: 'Proto', role: 'Spec → Scaffold', color: '#f59e0b', icon: '⬡' },
  { key: 'trace' as const, label: 'Trace', role: 'Kod → Test', color: '#a78bfa', icon: '◈' },
];

interface StageTimelineProps {
  workflow: Workflow;
  onApprove?: (repoName: string, repoVisibility?: 'public' | 'private') => void;
  onReject?: (feedback?: string) => void;
  onRetry?: () => void;
  activities?: PipelineActivity[];
  currentStep?: PipelineActivity | null;
  isConnected?: boolean;
  progressByStage?: Record<string, number>;
}

function StageContent({ stageKey, stage, workflow, onApprove, onReject, onRetry }: {
  stageKey: string;
  stage: StageResult;
  workflow: Workflow;
  onApprove?: (repoName: string, repoVisibility?: 'public' | 'private') => void;
  onReject?: (feedback?: string) => void;
  onRetry?: () => void;
}) {
  if (stageKey === 'scribe' && stage.status === 'completed' && stage.spec) {
    return <SpecView spec={stage.spec} />;
  }

  if (stageKey === 'approve') {
    if (stage.status === 'completed') {
      return (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-600">
          ✓ Spec kullanıcı tarafından onaylandı · İnsan onayı geçildi
        </div>
      );
    }
    if (stage.status === 'pending' && workflow.status === 'awaiting_approval') {
      return <ApproveSection onApprove={onApprove} onReject={onReject} defaultRepoName={workflow.title} />;
    }
    return null;
  }

  if (stageKey === 'proto') {
    if (stage.status === 'completed' && stage.branch) {
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-ak-text-secondary">Branch:</span>
            <code className="rounded bg-ak-surface-2 px-2 py-0.5 font-mono text-xs text-ak-proto">{stage.branch}</code>
          </div>
          {stage.files && stage.files.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-ak-text-secondary">Dosyalar ({stage.files.length}):</p>
              <div className="space-y-0.5">
                {stage.files.map((f, i) => (
                  <p key={i} className="font-mono text-xs text-ak-text-primary/70">{f}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }
    if (stage.status === 'running') {
      return (
        <div className="flex items-center gap-2 text-sm text-ak-text-secondary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-ak-proto" />
          Scaffold oluşturuluyor...
          {stage.elapsed && <span className="font-mono text-xs">{stage.elapsed}</span>}
        </div>
      );
    }
    if (stage.status === 'failed') {
      return (
        <div className="space-y-2">
          <p className="text-sm text-red-500">{stage.error || 'Proto başarısız oldu'}</p>
          <button
            onClick={onRetry}
            className="rounded-lg border border-ak-proto/30 px-3 py-1.5 text-sm font-medium text-ak-proto transition-colors hover:bg-ak-proto/10"
          >
            Tekrar Dene
          </button>
        </div>
      );
    }
    return null;
  }

  if (stageKey === 'trace') {
    if (stage.status === 'completed') {
      return (
        <div className="flex gap-6">
          <div>
            <p className="text-2xl font-bold text-ak-trace">{stage.tests ?? 0}</p>
            <p className="text-xs text-ak-text-secondary">Yazılan Test</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-ak-trace">{stage.coverage ?? 'N/A'}</p>
            <p className="text-xs text-ak-text-secondary">Kapsam</p>
          </div>
        </div>
      );
    }
    if (stage.status === 'failed') {
      return (
        <div className="space-y-2">
          <p className="text-sm text-red-500">{stage.error || 'Trace başarısız oldu'}</p>
          <button
            onClick={onRetry}
            className="rounded-lg border border-ak-trace/30 px-3 py-1.5 text-sm font-medium text-ak-trace transition-colors hover:bg-ak-trace/10"
          >
            Tekrar Dene
          </button>
        </div>
      );
    }
    if (stage.status === 'running') {
      return (
        <div className="flex items-center gap-2 text-sm text-ak-text-secondary">
          <span className="h-2 w-2 animate-pulse rounded-full bg-ak-trace" />
          Testler yazılıyor...
        </div>
      );
    }
    return null;
  }

  return null;
}

function ApproveSection({
  onApprove,
  onReject,
  defaultRepoName,
}: {
  onApprove?: (repoName: string, repoVisibility?: 'public' | 'private') => void;
  onReject?: (feedback?: string) => void;
  defaultRepoName?: string;
}) {
  const deriveSlug = (title?: string) =>
    (title || 'my-app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const repoName = deriveSlug(defaultRepoName);

  return (
    <div className="space-y-3">
      <p className="text-sm text-ak-text-secondary">Spec'i inceleyin ve nasıl devam edileceğine karar verin.</p>
      <div className="flex gap-2">
        <button
          onClick={() => repoName.trim() && onApprove?.(repoName.trim(), 'private')}
          disabled={!repoName.trim()}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          ✓ Onayla ve Devam Et
        </button>
        <button
          onClick={() => onReject?.()}
          className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-red-500/10"
        >
          Reddet
        </button>
      </div>
    </div>
  );
}

export function StageTimeline({ workflow, onApprove, onReject, onRetry, activities, currentStep, isConnected, progressByStage }: StageTimelineProps) {
  const [expandedStage, setExpandedStage] = useState<string | null>(() => {
    // Auto-expand the current active stage
    if (workflow.status === 'awaiting_approval') return 'approve';
    const stages = workflow.stages;
    if (stages.trace.status === 'running' || stages.trace.status === 'failed') return 'trace';
    if (stages.proto.status === 'running') return 'proto';
    if (stages.scribe.status === 'completed' && stages.scribe.spec) return 'scribe';
    return null;
  });

  // Respect the OS-level reduced-motion preference (issue #394): no animations at all
  // if the user has explicitly asked for reduced motion in their system settings.
  const reduced = useReducedMotion();
  const fadeProps = reduced
    ? {}
    : {
        initial: { opacity: 0, y: -4 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -4 },
        transition: { duration: 0.22, ease: 'easeOut' as const },
      };
  const rowProps = reduced
    ? {}
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.18, ease: 'easeOut' as const },
      };

  return (
    <div className="space-y-0">
      {STAGE_META.map((meta, idx) => {
        const stage = workflow.stages[meta.key];
        const isExpanded = expandedStage === meta.key;
        const isLast = idx === STAGE_META.length - 1;
        const hasContent = stage.status !== 'idle';

        return (
          <motion.div key={meta.key} className="relative" {...rowProps} layout={!reduced}>
            {/* Connector line */}
            {!isLast && (
              <div
                className={cn(
                  'absolute left-[16px] top-[34px] w-0.5',
                  isExpanded ? 'h-[calc(100%-34px)]' : 'h-[calc(100%-14px)]',
                  stage.status === 'completed' ? 'bg-emerald-500/40' : 'bg-ak-border',
                )}
              />
            )}

            {/* Stage header */}
            <button
              onClick={() => hasContent && setExpandedStage(isExpanded ? null : meta.key)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors',
                hasContent && 'cursor-pointer hover:bg-ak-hover',
                !hasContent && 'cursor-default opacity-50',
              )}
            >
              {/* Stage icon */}
              <div
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-sm font-bold"
                style={{
                  background: stage.status === 'completed' || stage.status === 'running' ? `${meta.color}12` : 'var(--ak-surface-2)',
                  color: stage.status !== 'idle' ? meta.color : 'var(--ak-text-tertiary)',
                  border: `1.5px solid ${stage.status !== 'idle' ? `${meta.color}40` : 'var(--ak-border)'}`,
                }}
              >
                {meta.icon}
              </div>

              {/* Label + role */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ak-text-primary">{meta.label}</span>
                  <span className="text-xs text-ak-text-tertiary">{meta.role}</span>
                </div>
                {stage.confidence != null && stage.confidence > 0 && (
                  <span className="text-xs text-ak-text-secondary">Güven: {formatConfidence(stage.confidence)}</span>
                )}
              </div>

              {/* Status badge */}
              {stage.status !== 'idle' && <StatusBadge status={stage.status} size="small" />}

              {/* Expand indicator */}
              {hasContent && (
                <svg
                  className={cn('h-4 w-4 text-ak-text-tertiary transition-transform', isExpanded && 'rotate-180')}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              )}
            </button>

            {/* Expanded content — fades in/out smoothly when user toggles or stage transitions */}
            <AnimatePresence initial={false}>
              {isExpanded && hasContent && (
                <motion.div
                  key={`content-${meta.key}`}
                  className="ml-11 mt-1 mb-3 rounded-lg border border-ak-border bg-ak-surface p-4 overflow-hidden"
                  {...fadeProps}
                >
                  <StageContent
                    stageKey={meta.key}
                    stage={stage}
                    workflow={workflow}
                    onApprove={onApprove}
                    onReject={onReject}
                    onRetry={onRetry}
                  />
                  {stage.status === 'running' && meta.key !== 'approve' && (
                    <>
                      <ActivityLog
                        activities={activities ?? []}
                        currentStep={currentStep ?? null}
                        isRunning={true}
                        stageName={meta.key as 'scribe' | 'proto' | 'trace'}
                        progress={progressByStage?.[meta.key]}
                      />
                      {isConnected === false && (
                        <div className="text-xs opacity-40 flex items-center gap-1 mt-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
                          <span>Yeniden bağlanıyor...</span>
                        </div>
                      )}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        );
      })}
    </div>
  );
}
