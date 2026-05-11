/**
 * Demo project templates for the onboarding empty state (B3).
 *
 * Each entry is a "ready-made idea" a first-time user can click to skip the
 * blank-canvas problem. Labels are i18n keys (TR + EN). **Idea text is
 * intentionally Turkish-only**: AKIS's Scribe agent is Turkish-tuned (Q1
 * baseline was 100% Turkish prompts), so submitting an English idea would
 * degrade plan quality. Keeping the idea body here (not in i18n catalogs)
 * makes that single-locale decision explicit instead of hiding it as a
 * "missing translation".
 *
 * Q1 baseline (2026-05-07) validated todo / currency / qr end-to-end with
 * the mock + real providers. The markdown editor idea is spec-listed but
 * was NOT in the Q1 baseline (see review #535 §3) — works against mock
 * but a real-provider smoke is still a follow-up.
 *
 * Idea text length: `useHandleSend` rejects ideas shorter than 10 chars,
 * so each `idea` here is comfortably above that.
 */
export type DemoProjectIconName = 'todo' | 'currency' | 'qr' | 'markdown';

export interface DemoProject {
  /** Stable id used as React key and test selector. */
  id: 'todo' | 'currency' | 'qr' | 'markdown';
  /** i18n key for the short label rendered on the button. */
  labelKey: string;
  /** Turkish idea text submitted verbatim to the pipeline (NOT translated; see file header). */
  idea: string;
  /** Logical icon slot — the card renders a matching inline SVG. */
  icon: DemoProjectIconName;
}

export const DEMO_PROJECTS: readonly DemoProject[] = [
  {
    id: 'todo',
    labelKey: 'chat.empty.demo.todo.label',
    idea:
      "Tek kullanıcılı, tarayıcıda çalışan basit bir görev listesi uygulaması istiyorum. Görev ekleyebilmeli, tamamlandı olarak işaretleyebilmeli, silebilmeliyim. Veri tarayıcının localStorage'ında saklansın.",
    icon: 'todo',
  },
  {
    id: 'currency',
    labelKey: 'chat.empty.demo.currency.label',
    idea:
      'USD ve TRY arasında çeviri yapabilen tek sayfa bir uygulama. Statik bir kur kullansın (örn. 1 USD = 32 TRY) — gerçek API entegrasyonu istemiyorum.',
    icon: 'currency',
  },
  {
    id: 'qr',
    labelKey: 'chat.empty.demo.qr.label',
    idea: "Bir input'a metin yaz, QR kodu üret. Sayfa içinde, yapay zeka API kullanmadan.",
    icon: 'qr',
  },
  {
    id: 'markdown',
    labelKey: 'chat.empty.demo.markdown.label',
    idea:
      "Solda yazdığım Markdown'ı sağda canlı önizleyen tek sayfa bir editör. localStorage'da otomatik kaydetsin.",
    icon: 'markdown',
  },
] as const;
