// Explainability Service — template-based reasoning explainer (NO LLM calls).
//
// PDP-2 Wave 2 (F-03 + F-11 / NFR-1): converted from a pure in-memory map to
// a write-through cache backed by `pipeline_reasonings`. Surface (method
// signatures) is unchanged so callers do not need to know about the DB.
//
// - addReasoning(...)  → cache update + DB upsert (sync API, fire-and-await DB)
// - getExplanation(id) → cache hit returns immediately; cache miss reads DB,
//                        populates cache, then assembles the explanation.
//
// See docs/product/03-architecture.md § 4.1, § 5.1, ADR-1.

import { and, asc, eq, isNull } from 'drizzle-orm';

import { db as defaultDb } from '../../../db/client.js';
import { pipelineReasonings, pipelines } from '../../../db/schema.js';
import type {
  AgentReasoning,
  AttentionPoint,
  IterationHistoryEntry,
  PipelineExplanation,
  ExplainabilityConfig,
} from './ExplainabilityTypes.js';
import { buildIterationTrajectory } from './reasoningFactory.js';

/**
 * Pipeline stages that mean "pipeline is done — no more reasoning will be
 * written." Only completed pipelines with zero reasoning rows should trip the
 * `persistencePreEpoch` flag; an actively-running pipeline that just hasn't
 * emitted yet is NOT legacy.
 */
const TERMINAL_STAGES: ReadonlySet<string> = new Set([
  'completed',
  'completed_partial',
  'failed',
  'cancelled',
]);

const DEFAULT_CONFIG: ExplainabilityConfig = {
  verbosity: 'standard',
  includeAlternatives: true,
  includeRisks: true,
};

/**
 * Minimal Drizzle-shape interface — typed against the methods we actually
 * call. Lets tests inject a fake without depending on the full
 * NodePgDatabase generic.
 */
export interface ExplainabilityDb {
  insert: (typeof defaultDb)['insert'];
  select: (typeof defaultDb)['select'];
}

export interface ExplainabilityServiceOptions extends Partial<ExplainabilityConfig> {
  /** Override the default Drizzle client. Pass `null` to disable persistence (cache-only). */
  db?: ExplainabilityDb | null;
}

export class ExplainabilityService {
  private readonly cache = new Map<string, AgentReasoning[]>();
  /**
   * Pipelines we have already attempted to read from DB. We use this to
   * distinguish "cache miss because never seen" from "cache miss but
   * persistence-pre-epoch (legacy empty)".
   */
  private readonly hydrated = new Set<string>();
  private readonly config: ExplainabilityConfig;
  private readonly db: ExplainabilityDb | null;

  constructor(options: ExplainabilityServiceOptions = {}) {
    const { db, ...configPartial } = options;
    this.config = { ...DEFAULT_CONFIG, ...configPartial };
    // `db === null` → caller explicitly opted out of persistence. `db === undefined`
    // → use the global default. `db === <instance>` → use the injected one.
    this.db = db === null ? null : (db ?? defaultDb);
  }

  /**
   * Record a new reasoning entry. Updates in-memory cache immediately and
   * upserts the row in `pipeline_reasonings`. Returns once both succeed —
   * callers can `await` to be sure the data survives a crash.
   */
  async addReasoning(pipelineId: string, reasoning: AgentReasoning): Promise<void> {
    this.upsertCache(pipelineId, reasoning);
    if (!this.db) return;
    const stage = this.stageKey(reasoning);
    await this.db
      .insert(pipelineReasonings)
      .values({
        pipelineId,
        stage,
        agentReasoning: reasoning,
      })
      .onConflictDoUpdate({
        target: [pipelineReasonings.pipelineId, pipelineReasonings.stage],
        set: {
          agentReasoning: reasoning,
          // NOTE: `recordedAt` is intentionally NOT updated on conflict.
          // `loadStages` orders by `recordedAt`, and re-adding a stage (e.g.
          // Scribe regeneration after Proto already ran) must NOT move the
          // row to the end of the chronological order. Cache and DB agree on
          // first-write-wins ordering this way.
          // Re-adding a stage clears any prior soft-delete.
          archivedAt: null,
        },
      });
  }

  /**
   * Build the full PipelineExplanation. Cache-first; on miss, hydrate from DB
   * (filtering out soft-deleted rows). The returned object includes a `meta`
   * field that flags "persistencePreEpoch" — true when a *terminal* pipeline
   * has no rows in `pipeline_reasonings`, which means it ran before this
   * persistence layer existed. Active/in-flight pipelines with zero rows do
   * NOT trip the flag — they just haven't emitted yet.
   */
  async getExplanation(pipelineId: string): Promise<PipelineExplanation> {
    const stages = await this.loadStages(pipelineId);
    const meta: PipelineExplanation['meta'] = {};
    if (stages.length === 0 && (await this.isTerminalPipeline(pipelineId))) {
      meta.persistencePreEpoch = true;
    }
    // T4: surface Critic-Proto iterate trajectory alongside the stage cards
    // so the frontend can render "Critic %52 → %67 → %84" without traversing
    // pipeline.intermediateState directly.
    const iterationTrajectory = await this.loadIterationTrajectory(pipelineId);
    return {
      pipelineId,
      stages,
      overallNarrative: this.narrateStages(stages),
      attentionPoints: this.collectAttentionPoints(stages),
      ...(iterationTrajectory ? { iterationTrajectory } : {}),
      meta,
    };
  }

  /**
   * T4: read `iterationHistory` off the pipeline row's intermediateState
   * (populated by PipelineOrchestrator after each completed Proto → Critic
   * pass) and hand it to the trajectory factory. Returns `undefined` when
   * the loop never ran, so callers can `...spread` it conditionally.
   */
  private async loadIterationTrajectory(pipelineId: string) {
    if (!this.db) return undefined;
    try {
      const rows = await this.db
        .select({ intermediateState: pipelines.intermediateState })
        .from(pipelines)
        .where(eq(pipelines.id, pipelineId));
      const intermediate = rows[0]?.intermediateState as Record<string, unknown> | null | undefined;
      const history = intermediate?.iterationHistory;
      if (!Array.isArray(history) || history.length === 0) return undefined;
      return buildIterationTrajectory(history as IterationHistoryEntry[]);
    } catch {
      // Best-effort: a DB read failure here must not break the rest of the
      // explanation surface.
      return undefined;
    }
  }

  /** Async sibling of generateNarrative kept for callers that only want the text. */
  async generateNarrative(pipelineId: string): Promise<string> {
    const stages = await this.loadStages(pipelineId);
    return this.narrateStages(stages);
  }

  /** Async sibling of getAttentionPoints. */
  async getAttentionPoints(pipelineId: string): Promise<AttentionPoint[]> {
    const stages = await this.loadStages(pipelineId);
    return this.collectAttentionPoints(stages);
  }

  /** Convenience for tests: clear the in-memory cache only. */
  clearCache(pipelineId?: string): void {
    if (pipelineId) {
      this.cache.delete(pipelineId);
      this.hydrated.delete(pipelineId);
      return;
    }
    this.cache.clear();
    this.hydrated.clear();
  }

  // --- private helpers ---------------------------------------------------

  /**
   * True iff the pipeline row exists AND its stage is one of the terminal
   * states. Used to gate the `persistencePreEpoch` banner — only a finished
   * pipeline with zero reasoning rows can be a "legacy pre-persistence" one.
   * Cache-only mode (db === null) returns `false` so unit tests that do not
   * set up a pipeline row don't get the banner accidentally.
   */
  private async isTerminalPipeline(pipelineId: string): Promise<boolean> {
    if (!this.db) return false;
    const rows = await this.db
      .select({ stage: pipelines.stage })
      .from(pipelines)
      .where(eq(pipelines.id, pipelineId))
      .limit(1);
    const stage = rows[0]?.stage;
    if (!stage) return false;
    return TERMINAL_STAGES.has(stage);
  }

  private async loadStages(pipelineId: string): Promise<AgentReasoning[]> {
    const cached = this.cache.get(pipelineId);
    if (cached !== undefined) return cached;
    if (!this.db) {
      this.cache.set(pipelineId, []);
      this.hydrated.add(pipelineId);
      return [];
    }
    const rows = await this.db
      .select({
        agentReasoning: pipelineReasonings.agentReasoning,
        recordedAt: pipelineReasonings.recordedAt,
      })
      .from(pipelineReasonings)
      .where(
        and(eq(pipelineReasonings.pipelineId, pipelineId), isNull(pipelineReasonings.archivedAt))
      )
      .orderBy(asc(pipelineReasonings.recordedAt));
    const stages = rows.map((r) => this.rehydrateReasoning(r.agentReasoning));
    this.cache.set(pipelineId, stages);
    this.hydrated.add(pipelineId);
    return stages;
  }

  private upsertCache(pipelineId: string, reasoning: AgentReasoning): void {
    const existing = this.cache.get(pipelineId);
    const list = existing ? [...existing] : [];
    const stage = this.stageKey(reasoning);
    const idx = list.findIndex((r) => this.stageKey(r) === stage);
    if (idx >= 0) {
      list[idx] = reasoning;
    } else {
      list.push(reasoning);
    }
    this.cache.set(pipelineId, list);
    this.hydrated.add(pipelineId);
  }

  /**
   * jsonb round-trips dates as strings. Re-coerce so consumers keep working
   * against the typed `Date` field (mostly the narrative templates).
   */
  private rehydrateReasoning(raw: AgentReasoning): AgentReasoning {
    const ts = raw.timestamp;
    return ts instanceof Date ? raw : { ...raw, timestamp: new Date(ts as unknown as string) };
  }

  /**
   * DB stage key. Falls back to `agentName` when the builder did not set a
   * more specific key. Critics in particular set `stageKey` to
   * `'critic-spec' | 'critic-code'` so each review gets its own row.
   */
  private stageKey(reasoning: AgentReasoning): string {
    return reasoning.stageKey ?? reasoning.agentName;
  }

  private narrateStages(stages: AgentReasoning[]): string {
    if (stages.length === 0) {
      return 'Bu pipeline için henüz bir açıklama bulunmuyor.';
    }
    return stages.map((s) => this.narrateStage(s)).join(' ');
  }

  private collectAttentionPoints(stages: AgentReasoning[]): AttentionPoint[] {
    const points: AttentionPoint[] = [];
    // Prefer the granular stageKey when present so the banner can tell
    // critic-spec from critic-code (Bulgu E — two near-identical Critic
    // rows used to confuse users). Falls back to agentName for callers
    // that haven't been migrated to stageKey yet.
    const stageLabelFor = (stage: AgentReasoning) => stage.stageKey ?? stage.agentName;

    for (const stage of stages) {
      // Bulgu E + H — `stageLabel` uses the granular stageKey when present
      // (so critic-spec/critic-code stay distinct) while the wrapper text
      // is the bakkal-Türkçesi version that frames *why* the user should
      // look. Raw factor / decision / risk payloads still come straight
      // from the agent and may be technical; the wrapper only sets context.
      const stageLabel = stageLabelFor(stage);
      const factors = stage.confidence.factors.join(', ');
      if (stage.confidence.score < 70) {
        points.push({
          stage: stageLabel,
          issue: `Bu adımdan emin değiliz (%${stage.confidence.score}). Yayınlamadan önce dikkatlice incele. Etkileyen noktalar: ${factors}`,
          severity: 'high',
        });
      } else if (stage.confidence.score < 85) {
        points.push({
          stage: stageLabel,
          issue: `Bu adımdan kısmen eminiz (%${stage.confidence.score}). Önemli yerleri gözden geçirmen iyi olur. Etkileyen noktalar: ${factors}`,
          severity: 'medium',
        });
      }

      if (
        stage.agentName.includes('critic') &&
        stage.reasoning.some((r) => r.toLowerCase().includes('security'))
      ) {
        points.push({
          stage: stageLabel,
          issue: `Bir güvenlik konusu tespit ettik — gözden geçirmeni öneririz. Karar: ${stage.decision}`,
          severity: 'high',
        });
      }

      if (stage.agentName === 'trace' && stage.decision.toLowerCase().includes('fix')) {
        points.push({
          stage: stageLabel,
          issue: `Testler ilk seferde geçmedi, AKIS otomatik düzeltme denedi. Karar: ${stage.decision}`,
          severity: 'medium',
        });
      }

      if (this.config.includeRisks && stage.risks && stage.risks.length > 0) {
        points.push({
          stage: stageLabel,
          issue: `Bilmen gereken riskler: ${stage.risks.join('; ')}`,
          severity: 'low',
        });
      }
    }

    // De-dupe identical (stage, issue, severity) tuples. Multiple stages
    // can independently bubble the same risk text (e.g. critic-spec and
    // critic-code both flagging the same low-confidence factor list).
    // Without this the banner showed two visually-identical rows.
    const seen = new Set<string>();
    return points.filter((p) => {
      const key = `${p.stage}|${p.severity}|${p.issue}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private narrateStage(stage: AgentReasoning): string {
    const name = this.formatAgentName(stage.agentName);
    const confidence = stage.confidence.score;
    const assumptionCount = stage.assumptions.length;

    switch (stage.agentName) {
      case 'scribe':
        return this.narrateScribe(name, confidence, assumptionCount, stage);
      case 'proto':
        return this.narrateProto(name, confidence, stage);
      case 'trace':
        return this.narrateTrace(name, confidence, stage);
      case 'critic':
        return this.narrateCritic(name, confidence, stage);
      default:
        return this.narrateGeneric(name, confidence, assumptionCount, stage);
    }
  }

  private narrateScribe(
    name: string,
    confidence: number,
    assumptionCount: number,
    stage: AgentReasoning
  ): string {
    let text = `${name}, kullanıcının fikrini analiz etti ve %${confidence} güvenle bir spec üretti. ${assumptionCount} varsayım yapıldı.`;
    if (this.config.verbosity === 'detailed' && stage.assumptions.length > 0) {
      text += ` Varsayımlar: ${stage.assumptions.join(', ')}.`;
    }
    return text;
  }

  private narrateProto(name: string, confidence: number, stage: AgentReasoning): string {
    let text = `${name}, onaylanan spec'ten %${confidence} güvenle MVP kodunu üretti.`;
    if (
      this.config.verbosity === 'detailed' &&
      stage.alternatives &&
      stage.alternatives.length > 0
    ) {
      text += ` Alternatifler değerlendirildi: ${stage.alternatives.join(', ')}.`;
    }
    return text;
  }

  private narrateTrace(name: string, confidence: number, stage: AgentReasoning): string {
    let text = `${name}, üretilen kodu doğruladı ve %${confidence} güvenle test senaryoları yazdı.`;
    if (stage.decision.toLowerCase().includes('fix')) {
      text += ' Düzeltme döngüsü tetiklendi.';
    }
    return text;
  }

  private narrateCritic(name: string, confidence: number, stage: AgentReasoning): string {
    return `${name}, çıktıyı inceledi ve %${confidence} güvenle değerlendirme tamamladı. Karar: ${stage.decision}.`;
  }

  private narrateGeneric(
    name: string,
    confidence: number,
    assumptionCount: number,
    stage: AgentReasoning
  ): string {
    return `${name}, işlemini %${confidence} güvenle tamamladı. ${assumptionCount} varsayım yapıldı. Karar: ${stage.decision}.`;
  }

  private formatAgentName(agentName: string): string {
    return agentName.charAt(0).toUpperCase() + agentName.slice(1);
  }
}
