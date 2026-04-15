// Explainability Service — template-based reasoning explainer (NO LLM calls)

import type { AgentReasoning, AttentionPoint, PipelineExplanation, ExplainabilityConfig } from './ExplainabilityTypes.js';

const DEFAULT_CONFIG: ExplainabilityConfig = {
  verbosity: 'standard',
  includeAlternatives: true,
  includeRisks: true,
};

export class ExplainabilityService {
  private readonly store = new Map<string, AgentReasoning[]>();
  private readonly config: ExplainabilityConfig;

  constructor(config?: Partial<ExplainabilityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  addReasoning(pipelineId: string, reasoning: AgentReasoning): void {
    const existing = this.store.get(pipelineId) ?? [];
    existing.push(reasoning);
    this.store.set(pipelineId, existing);
  }

  getExplanation(pipelineId: string): PipelineExplanation {
    const stages = this.store.get(pipelineId) ?? [];
    return {
      pipelineId,
      stages,
      overallNarrative: this.generateNarrative(pipelineId),
      attentionPoints: this.getAttentionPoints(pipelineId),
    };
  }

  generateNarrative(pipelineId: string): string {
    const stages = this.store.get(pipelineId) ?? [];
    if (stages.length === 0) {
      return 'Bu pipeline icin henuz bir aciklama bulunmuyor.';
    }

    const parts: string[] = [];

    for (const stage of stages) {
      parts.push(this.narrateStage(stage));
    }

    return parts.join(' ');
  }

  getAttentionPoints(pipelineId: string): AttentionPoint[] {
    const stages = this.store.get(pipelineId) ?? [];
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
      if (
        stage.agentName === 'trace' &&
        stage.decision.toLowerCase().includes('fix')
      ) {
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

  // --- private helpers ---

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

  private narrateProto(
    name: string,
    confidence: number,
    stage: AgentReasoning,
  ): string {
    let text = `${name}, onaylanan spesifikasyondan ${confidence}% guvenle MVP kodunu uretti.`;
    if (this.config.verbosity === 'detailed' && stage.alternatives && stage.alternatives.length > 0) {
      text += ` Alternatifler degerlendirildi: ${stage.alternatives.join(', ')}.`;
    }
    return text;
  }

  private narrateTrace(
    name: string,
    confidence: number,
    stage: AgentReasoning,
  ): string {
    let text = `${name}, uretilen kodu dogruladi ve ${confidence}% guvenle test senaryolari yazdi.`;
    if (stage.decision.toLowerCase().includes('fix')) {
      text += ' Duzeltme dongusu tetiklendi.';
    }
    return text;
  }

  private narrateCritic(
    name: string,
    confidence: number,
    stage: AgentReasoning,
  ): string {
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
