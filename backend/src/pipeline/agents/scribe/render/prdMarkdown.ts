/**
 * PR-V-spec-artifacts — PRD markdown renderer
 *
 * Pure function that turns Scribe's structured output into a markdown PRD
 * (`docs/PRD.md`) for the generated project. The user asked for Scribe's
 * artifact to live alongside the code as the canonical "this is what we
 * built" document. This renderer is deterministic and side-effect free;
 * it is consumed by `proto/artifactInjector.ts` which merges the result
 * into the file set that Proto pushes to GitHub.
 *
 * Output language: Turkish (matches all other user-facing AKIS strings).
 * Empty fields are elided — never render the word "undefined" or empty
 * bullet lines.
 */
import type { StructuredSpec, UserFriendlyPlan } from '../../../core/contracts/PipelineTypes.js';

export interface RenderPRDInput {
  spec: StructuredSpec;
  plan?: UserFriendlyPlan;
  assumptions?: string[];
  /**
   * Override the "Üretildi: …" timestamp. Test-only — production code should
   * let the renderer call `new Date()`.
   */
  now?: Date;
}

const isNonEmpty = (v: string | undefined | null): v is string => !!v && v.trim().length > 0;

/** Render the PRD markdown document for the generated project repo. */
export function renderPRDMarkdown(input: RenderPRDInput): string {
  const { spec, plan, assumptions = [], now = new Date() } = input;
  const lines: string[] = [];

  const title = isNonEmpty(spec.title) ? spec.title : 'Proje';
  lines.push(`# ${title} — Proje Tanımı (PRD)`);
  lines.push('');
  lines.push(
    '> Bu döküman AKIS Scribe tarafından oluşturuldu. Proje gereksinimlerinin canonical kaynağıdır.'
  );
  lines.push('');

  // ── Özet (plan summary) ────────────────────────────
  if (plan && isNonEmpty(plan.summary)) {
    lines.push('## Özet');
    lines.push('');
    lines.push(plan.summary.trim());
    lines.push('');
  }

  // ── Problem Tanımı ─────────────────────────────────
  if (isNonEmpty(spec.problemStatement)) {
    lines.push('## Problem Tanımı');
    lines.push('');
    lines.push(spec.problemStatement.trim());
    lines.push('');
  }

  // ── Kullanıcı Hikayeleri ──────────────────────────
  const userStories = spec.userStories ?? [];
  if (userStories.length > 0) {
    lines.push(`## Kullanıcı Hikayeleri (${userStories.length})`);
    lines.push('');
    for (const us of userStories) {
      const persona = isNonEmpty(us.persona) ? us.persona : 'Kullanıcı';
      const action = isNonEmpty(us.action) ? us.action : '';
      const benefit = isNonEmpty(us.benefit) ? us.benefit : '';
      const parts = [`**${persona}**`];
      if (action) parts.push(action);
      const benefitPart = benefit ? ` → ${benefit}` : '';
      lines.push(`- ${parts.join(': ')}${benefitPart}`);
    }
    lines.push('');
  }

  // ── Kabul Kriterleri ──────────────────────────────
  const ac = spec.acceptanceCriteria ?? [];
  if (ac.length > 0) {
    lines.push(`## Kabul Kriterleri (${ac.length})`);
    lines.push('');
    ac.forEach((criterion, idx) => {
      const id = isNonEmpty(criterion.id) ? criterion.id : `AC-${idx + 1}`;
      lines.push(`### ${id}`);
      lines.push('');
      if (isNonEmpty(criterion.given)) lines.push(`- **Verildiğinde:** ${criterion.given.trim()}`);
      if (isNonEmpty(criterion.when)) lines.push(`- **Olduğunda:** ${criterion.when.trim()}`);
      if (isNonEmpty(criterion.then)) lines.push(`- **Sonuç:** ${criterion.then.trim()}`);
      lines.push('');
    });
  }

  // ── Teknik Kısıtlamalar ───────────────────────────
  const tc = spec.technicalConstraints ?? {};
  const stack = isNonEmpty(tc.stack) ? tc.stack : 'Proto seçecek';
  const integrations = (tc.integrations ?? []).filter(isNonEmpty);
  const nonFunctional = (tc.nonFunctional ?? []).filter(isNonEmpty);
  const hasAnyTechSection = stack || integrations.length > 0 || nonFunctional.length > 0;
  if (hasAnyTechSection) {
    lines.push('## Teknik Kısıtlamalar');
    lines.push('');
    lines.push(`- **Stack:** ${stack}`);
    if (integrations.length > 0) {
      lines.push(`- **Entegrasyonlar:** ${integrations.join(', ')}`);
    }
    if (nonFunctional.length > 0) {
      lines.push('- **Fonksiyonel olmayan gereksinimler:**');
      for (const nf of nonFunctional) {
        lines.push(`  - ${nf}`);
      }
    }
    lines.push('');
  }

  // ── Kapsam Dışı ───────────────────────────────────
  const oos = (spec.outOfScope ?? []).filter(isNonEmpty);
  if (oos.length > 0) {
    lines.push('## Kapsam Dışı');
    lines.push('');
    for (const item of oos) {
      lines.push(`- ${item.trim()}`);
    }
    lines.push('');
  }

  // ── Varsayımlar ───────────────────────────────────
  const cleanAssumptions = assumptions.filter(isNonEmpty);
  if (cleanAssumptions.length > 0) {
    lines.push('## Varsayımlar');
    lines.push('');
    for (const a of cleanAssumptions) {
      lines.push(`- ${a.trim()}`);
    }
    lines.push('');
  }

  // ── Özellikler (plan.features) ────────────────────
  const features = plan?.features ?? [];
  if (features.length > 0) {
    lines.push("## Özellikler (Proto'nun planladığı)");
    lines.push('');
    for (const f of features) {
      const name = isNonEmpty(f.name) ? f.name : 'Özellik';
      const desc = isNonEmpty(f.description) ? `: ${f.description.trim()}` : '';
      lines.push(`- **${name}**${desc}`);
    }
    lines.push('');
  }

  // ── Tech choices summary (plan.techChoices) ───────
  const techChoices = (plan?.techChoices ?? []).filter(isNonEmpty);
  if (techChoices.length > 0) {
    lines.push('## Teknoloji Seçimleri');
    lines.push('');
    for (const t of techChoices) {
      lines.push(`- ${t.trim()}`);
    }
    lines.push('');
  }

  // ── Footer ────────────────────────────────────────
  lines.push('---');
  lines.push(`Üretildi: ${now.toISOString()} · AKIS Scribe`);
  lines.push('');

  return lines.join('\n');
}
