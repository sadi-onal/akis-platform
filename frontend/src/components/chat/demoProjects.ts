/**
 * Demo project templates for the onboarding empty state (B3).
 *
 * Each entry is a "ready-made idea" a first-time user can click to skip the
 * blank-canvas problem. The labels + idea bodies are i18n keys so the same
 * shape works for TR and EN. Idea text is intentionally long enough that
 * Scribe has something to chew on — `useHandleSend` rejects ideas shorter
 * than 10 characters.
 *
 * Q1 baseline (2026-05-07) already validated all four ideas produce
 * sensible plans end-to-end with the mock + real providers, so no backend
 * work is required to support them.
 */
export type DemoProjectIconName = 'todo' | 'currency' | 'qr' | 'markdown';

export interface DemoProject {
  /** Stable id used as React key and test selector. */
  id: 'todo' | 'currency' | 'qr' | 'markdown';
  /** i18n key for the short label rendered on the button. */
  labelKey: string;
  /** i18n key for the full idea text submitted to the pipeline. */
  ideaKey: string;
  /** Logical icon slot — the card renders a matching inline SVG. */
  icon: DemoProjectIconName;
}

export const DEMO_PROJECTS: readonly DemoProject[] = [
  {
    id: 'todo',
    labelKey: 'chat.empty.demo.todo.label',
    ideaKey: 'chat.empty.demo.todo.idea',
    icon: 'todo',
  },
  {
    id: 'currency',
    labelKey: 'chat.empty.demo.currency.label',
    ideaKey: 'chat.empty.demo.currency.idea',
    icon: 'currency',
  },
  {
    id: 'qr',
    labelKey: 'chat.empty.demo.qr.label',
    ideaKey: 'chat.empty.demo.qr.idea',
    icon: 'qr',
  },
  {
    id: 'markdown',
    labelKey: 'chat.empty.demo.markdown.label',
    ideaKey: 'chat.empty.demo.markdown.idea',
    icon: 'markdown',
  },
] as const;
