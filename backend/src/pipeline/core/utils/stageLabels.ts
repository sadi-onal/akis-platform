import type { PipelineStage } from '../contracts/PipelineTypes.js';

/**
 * Maps internal pipeline stages to user-facing Turkish work labels used in
 * timeout / failure messages ("Kod üretim adımı 15 dakika yanıt vermedi.").
 * Unmapped stages fall back to "İşlem" so callers never get an empty string.
 */
const STAGE_LABELS_TR: Partial<Record<PipelineStage, string>> = {
  scribe_clarifying: 'Fikir analiz adımı',
  scribe_generating: 'Fikir analiz adımı',
  proto_building: 'Kod üretim adımı',
  trace_testing: 'Test üretim adımı',
  critic_reviewing_spec: 'İnceleme adımı',
  critic_reviewing_code: 'İnceleme adımı',
  fix_loop_iteration: 'Düzeltme döngüsü',
};

export function stageLabelTR(stage: PipelineStage): string {
  return STAGE_LABELS_TR[stage] ?? 'İşlem';
}
