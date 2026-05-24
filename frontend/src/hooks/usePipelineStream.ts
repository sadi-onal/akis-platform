import { useEffect, useRef, useState } from 'react';

export interface PipelineActivity {
  pipelineId: string;
  /**
   * Stage type. `critic` and `fix-loop` were added when adversarial review
   * and self-repair phases became first-class. Older callers that filter
   * on `'scribe' | 'proto' | 'trace'` should ignore unknown values rather
   * than crashing.
   */
  stage: 'scribe' | 'proto' | 'trace' | 'critic' | 'fix-loop';
  step: string;
  message: string;
  detail?: string;
  progress?: number;
  /**
   * PR-V5: explicit stage lifecycle signal. Backend emits exactly one
   * `status: 'completed'` activity per stage success (with progress 100,
   * `step: 'stage_completed'`) BEFORE transitioning to the next stage.
   * The cinema/rail UIs use this Set-based signal to mark a stage as
   * complete instead of inferring it from "no longer the latest activity"
   * — a heuristic that produced premature checkmarks at every handoff.
   * `undefined` for older or intermediate events.
   */
  status?: 'completed';
  retryCount?: number;
  /** i18n key (e.g. `pipeline.activity.proto.writing_files`) — use this if present, fall back to `message`. */
  activityKey?: string;
  /**
   * PR-A Fix 4: critic agent runs twice per pipeline (once on the spec
   * before Proto, once on the code after Proto). `criticPhase` lets the
   * cinema render the two reviews as separate columns without inventing
   * a fake stage on the backend.
   */
  criticPhase?: 'spec' | 'code';
  /**
   * Optional reasoning snippet — present on critic/fix-loop completion
   * events to drive the cinema/explainability UI without a second fetch.
   */
  reasoning?: {
    decision: string;
    snippet?: string;
    confidence?: number;
  };
  timestamp: string;
}

interface UsePipelineStreamResult {
  activities: PipelineActivity[];
  currentStep: PipelineActivity | null;
  isConnected: boolean;
  progressByStage: Record<string, number>;
  createdFiles: string[];
}

export function usePipelineStream(
  pipelineId: string | undefined,
  _isActive: boolean
): UsePipelineStreamResult {
  const [activities, setActivities] = useState<PipelineActivity[]>([]);
  const [createdFiles, setCreatedFiles] = useState<string[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Clear activities synchronously before establishing new connection
    // (prevents race condition where old activities leak into new pipeline)
    setActivities([]);
    setCreatedFiles([]);

    if (!pipelineId) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
        setIsConnected(false);
      }
      return;
    }

    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const seenTimestamps = new Set<string>();

    const ingest = (activity: PipelineActivity) => {
      // Dedupe so hydrated history + live stream don't stack duplicates
      const key = `${activity.stage}:${activity.step}:${activity.timestamp}`;
      if (seenTimestamps.has(key)) return;
      seenTimestamps.add(key);
      setActivities((prev) => [...prev, activity]);

      if (activity.step === 'file_created' && activity.detail) {
        setCreatedFiles((prev) => [...prev, activity.detail!]);
      }
    };

    // Always hydrate buffered activities for the pipeline — even when
    // `isActive` is false (e.g. awaiting_approval, completed). The Level-4
    // rail and any timeline UI need past progress to render correctly
    // when the user lands on a paused/finished pipeline.
    fetch(`/api/pipelines/${pipelineId}/activities`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const list = (data as { activities?: PipelineActivity[] }).activities ?? [];
        for (const a of list) ingest(a);
      })
      .catch(() => {
        // Non-fatal — the live stream still takes over
      });

    // PR-T3 S1: previously we'd close the SSE stream whenever `isActive`
    // (a.k.a. `isRunning`) flipped false — which happens the instant the
    // pipeline lands on `awaiting_push_confirm` / `awaiting_critic_resolution`
    // / `completed`. The frontend then missed any tail-end activities
    // (e.g. the synthetic `gate_open` event that arrives right at the
    // transition), leaving the UI on a stale placeholder until the user
    // reloaded. Keep the stream open as long as we have a pipelineId; the
    // backend manages connection lifecycle (heartbeat + 30-min max-age) so
    // dangling connections are bounded. `isActive` is now informational
    // only — we still hydrate buffered activities first.

    function connect() {
      if (cancelled) return;
      const es = new EventSource(`/api/pipelines/${pipelineId}/stream`);
      esRef.current = es;

      es.onopen = () => {
        setIsConnected(true);
        retryCount = 0;
      };

      es.onerror = () => {
        setIsConnected(false);
        es.close();
        esRef.current = null;
        // Reconnect with exponential backoff (max 30s)
        if (!cancelled && retryCount < 10) {
          const delay = Math.min(1000 * 2 ** retryCount, 30000);
          retryCount++;
          retryTimer = setTimeout(connect, delay);
        }
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'connected') return;
          ingest(data as PipelineActivity);
        } catch {
          // parse error — ignore
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (esRef.current) esRef.current.close();
      esRef.current = null;
      setIsConnected(false);
    };
  }, [pipelineId]);

  const currentStep = activities.length > 0 ? activities[activities.length - 1] : null;

  const progressByStage = activities.reduce<Record<string, number>>((acc, a) => {
    if (a.progress !== undefined) acc[a.stage] = a.progress;
    return acc;
  }, {});

  return { activities, currentStep, isConnected, progressByStage, createdFiles };
}
