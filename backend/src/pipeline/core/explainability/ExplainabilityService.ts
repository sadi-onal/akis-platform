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
import { pipelineReasonings } from '../../../db/schema.js';
import type {
  AgentReasoning,
  AttentionPoint,
  PipelineExplanation,
  ExplainabilityConfig,
} from './ExplainabilityTypes.js';

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
          recordedAt: new Date(),
          // Re-adding a stage clears any prior soft-delete.
          archivedAt: null,
        },
      });
  }

  /**
   * Build the full PipelineExplanation. Cache-first; on miss, hydrate from DB
   * (filtering out soft-deleted rows). The returned object includes a `meta`
   * field that flags "persistencePreEpoch" — true when the DB has no rows for
   * a known-completed pipeline so the frontend can show the legacy banner.
   */
  async getExplanation(pipelineId: string): Promise<PipelineExplanation> {
    const stages = await this.loadStages(pipelineId);
    const meta: PipelineExplanation['meta'] = {};
    if (stages.length === 0) {
      meta.persistencePreEpoch = true;
    }
    return {
      pipelineId,
      stages,
      overallNarrative: this.narrateStages(stages),
      attentionPoints: this.collectAttentionPoints(stages),
      meta,
    };
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
        and(
          eq(pipelineReasonings.pipelineId, pipelineId),
          isNull(pipelineReasonings.archivedAt),
        ),
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
      return 'Bu pipeline icin henuz bir aciklama bulunmuyor.';
    }
    return stages.map((s) => this.narrateStage(s)).join(' ');
  }

  private collectAttentionPoints(stages: AgentReasoning[]): AttentionPoint[] {
    const points: AttentionPoint[] = [];

    for (const stage of stages) {
      // Low confidence → high severity
      if (stage.confidence.score < 70) {
        points.push({
          stage: stage.agentName,
          issue: `Dusuk guven skoru: ${stage.confidence.score}%. Faktörler: ${stage.confidence.factors.join(', ')}`,
          severity: 'high',
        });
      } else if (stage.confidence.score < 85) {
        // Medium confidence → medium severity
        points.push({
          stage: stage.agentName,
          issue: `Orta guven skoru: ${stage.confidence.score}%. Faktörler: ${stage.confidence.factors.join(', ')}`,
          severity: 'medium',
        });
      }

      // Critic with security reasoning
      if (
        stage.agentName.includes('critic') &&
        stage.reasoning.some((r) => r.toLowerCase().includes('security'))
      ) {
        points.push({
          stage: stage.agentName,
          issue: `Guvenlik ile ilgili bulgular tespit edildi: ${stage.decision}`,
          severity: 'high',
        });
      }

      // Trace with fix loop
      if (stage.agentName === 'trace' && stage.decision.toLowerCase().includes('fix')) {
        points.push({
          stage: stage.agentName,
          issue: `Duzeltme dongusu tetiklendi: ${stage.decision}`,
          severity: 'medium',
        });
      }

      // Risks surfaced
      if (this.config.includeRisks && stage.risks && stage.risks.length > 0) {
        points.push({
          stage: stage.agentName,
          issue: `Tanimlanan riskler: ${stage.risks.join('; ')}`,
          severity: 'low',
        });
      }
    }

    return points;
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
    stage: AgentReasoning,
  ): string {
    let text = `${name}, kullanicinin fikrini analiz etti ve ${confidence}% guvenle bir spesifikasyon uretti. ${assumptionCount} varsayim yapildi.`;
    if (this.config.verbosity === 'detailed' && stage.assumptions.length > 0) {
      text += ` Varsayimlar: ${stage.assumptions.join(', ')}.`;
    }
    return text;
  }

  private narrateProto(name: string, confidence: number, stage: AgentReasoning): string {
    let text = `${name}, onaylanan spesifikasyondan ${confidence}% guvenle MVP kodunu uretti.`;
    if (
      this.config.verbosity === 'detailed' &&
      stage.alternatives &&
      stage.alternatives.length > 0
    ) {
      text += ` Alternatifler degerlendirildi: ${stage.alternatives.join(', ')}.`;
    }
    return text;
  }

  private narrateTrace(name: string, confidence: number, stage: AgentReasoning): string {
    let text = `${name}, uretilen kodu dogruladi ve ${confidence}% guvenle test senaryolari yazdi.`;
    if (stage.decision.toLowerCase().includes('fix')) {
      text += ' Duzeltme dongusu tetiklendi.';
    }
    return text;
  }

  private narrateCritic(name: string, confidence: number, stage: AgentReasoning): string {
    return `${name}, ciktiyi inceledi ve ${confidence}% guvenle degerlendirme tamamladi. Karar: ${stage.decision}.`;
  }

  private narrateGeneric(
    name: string,
    confidence: number,
    assumptionCount: number,
    stage: AgentReasoning,
  ): string {
    return `${name}, islemini ${confidence}% guvenle tamamladi. ${assumptionCount} varsayim yapildi. Karar: ${stage.decision}.`;
  }

  private formatAgentName(agentName: string): string {
    return agentName.charAt(0).toUpperCase() + agentName.slice(1);
  }
}
