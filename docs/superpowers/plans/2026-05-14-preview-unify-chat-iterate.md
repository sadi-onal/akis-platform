# Preview-Unify + Chat-Driven İterate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** awaiting_push_confirm state'inde tek bir preview render et; "GitHub'a gönder" / "İptal et" sağ panel sticky footer'a taşı; chat input'a yazılan FEEDBACK intent'ini iterate-with-feedback endpoint'ine yönlendir.

**Architecture:** Üç bağımsız frontend PR'ı (T1: yeni `PushGateFooter` + `PreviewPanel` slot, T2: `PushConfirmGate` compact rewrite, T3: `handleIntentFeedback` state-aware wiring + auto-open preview + state-aware classify fallback). Sonra T4 i18n cleanup ve T5 e2e spec. Backend değişmez — `confirmPush`/`cancelPush`/`iterateWithFeedback` client wrappers'ı zaten `workflows.ts:493,503,515`'te var.

**Tech Stack:** React 19, TypeScript strict, Tailwind v4, Vitest, Playwright, i18next, Fastify (backend dokunulmaz).

**Spec:** `docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md`

---

## File Structure

**Created:**

- `frontend/src/components/workflow/PushGateFooter.tsx` — confirm + cancel butonları, sticky footer (T1)
- `frontend/src/components/workflow/__tests__/PushGateFooter.test.tsx` — yeni komponent testleri (T1)
- `frontend/playwright/specs/push-gate-chat-iterate.spec.ts` — e2e (T5)

**Modified:**

- `frontend/src/components/workflow/PreviewPanel.tsx` — `pushGateProps` opsiyonel prop'u (T1)
- `frontend/src/components/workflow/__tests__/PreviewPanel.test.tsx` — footer slot testleri (T1) — *yoksa create*
- `frontend/src/components/pipeline/PushConfirmGate.tsx` — 203 → ~50 satır rewrite (T2)
- `frontend/src/components/pipeline/__tests__/PushConfirmGate.test.tsx` — eski testler silinir, compact testler eklenir (T2)
- `frontend/src/pages/chat/ChatPage.tsx` — `handleIntentFeedback` placeholder → state-aware (T3)
- `frontend/src/pages/chat/ChatPageLayout.tsx` — auto-open preview effect, `pushGateProps` prop drilling (T3)
- `frontend/src/hooks/useConversationState.ts` — placeholder string (T3)
- `frontend/src/components/chat/ChatRouter.tsx` — classify-error fallback state-aware (T3)
- `frontend/src/pages/chat/__tests__/ChatPage.intent.test.tsx` — yeni intent feedback testleri (T3)
- `frontend/src/i18n/locales/tr.json` — 6 key sil, 2 key ekle (T4)
- `frontend/src/i18n/locales/en.json` — aynı delta (T4)
- `frontend/src/i18n/i18n.types.ts` — auto-regen (T4)

---

## Parallelism Map

T1 + T2 + T3 paralel dispatch edilebilir (farklı worktree'ler). T4 ve T5 hepsi main'e merge olduktan sonra ana repoda sırayla yapılır.

```
T1 ─┐
T2 ─┼──► merge ──► T4 ──► T5 ──► done
T3 ─┘
```

---

## Task 1: PushGateFooter komponenti + PreviewPanel slot

**Worktree:** `../akis-pgfooter` (branch: `feat/T1-push-gate-footer`)

**Files:**
- Create: `frontend/src/components/workflow/PushGateFooter.tsx`
- Create: `frontend/src/components/workflow/__tests__/PushGateFooter.test.tsx`
- Modify: `frontend/src/components/workflow/PreviewPanel.tsx`
- Modify/Create: `frontend/src/components/workflow/__tests__/PreviewPanel.test.tsx` (file may already exist; check first)

- [ ] **Step 1.1: Worktree bootstrap**

```bash
git worktree add ../akis-pgfooter -b feat/T1-push-gate-footer main
cd ../akis-pgfooter
ln -s /Users/omeryasironal/Projects/akis-platform/.claude .claude
ln -s /Users/omeryasironal/Projects/akis-platform/backend/.env backend/.env
pnpm -C frontend install
```

- [ ] **Step 1.2: Write failing test — PushGateFooter render**

Create `frontend/src/components/workflow/__tests__/PushGateFooter.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PushGateFooter } from '../PushGateFooter';
import { workflowsApi } from '../../../services/api/workflows';
import { I18nProvider } from '../../../i18n/I18nProvider';

vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    confirmPush: vi.fn(),
    cancelPush: vi.fn(),
  },
}));

function renderFooter(props = {}) {
  return render(
    <I18nProvider>
      <PushGateFooter pipelineId="p-1" {...props} />
    </I18nProvider>
  );
}

describe('PushGateFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders two action buttons', () => {
    renderFooter();
    expect(screen.getByRole('button', { name: /GitHub'a gönder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /İptal et/i })).toBeInTheDocument();
  });

  it('calls workflowsApi.confirmPush on confirm click and invokes onResolved', async () => {
    const onResolved = vi.fn();
    (workflowsApi.confirmPush as any).mockResolvedValue({});
    renderFooter({ onResolved });
    await userEvent.click(screen.getByRole('button', { name: /GitHub'a gönder/i }));
    await waitFor(() => expect(workflowsApi.confirmPush).toHaveBeenCalledWith('p-1'));
    expect(onResolved).toHaveBeenCalledWith('confirm');
  });

  it('calls workflowsApi.cancelPush on cancel click and invokes onResolved', async () => {
    const onResolved = vi.fn();
    (workflowsApi.cancelPush as any).mockResolvedValue({});
    renderFooter({ onResolved });
    await userEvent.click(screen.getByRole('button', { name: /İptal et/i }));
    await waitFor(() => expect(workflowsApi.cancelPush).toHaveBeenCalledWith('p-1'));
    expect(onResolved).toHaveBeenCalledWith('cancel');
  });

  it('shows error alert when confirm fails', async () => {
    (workflowsApi.confirmPush as any).mockRejectedValue(new Error('boom'));
    renderFooter();
    await userEvent.click(screen.getByRole('button', { name: /GitHub'a gönder/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/boom/));
  });

  it('disables both buttons while busy', async () => {
    let resolveConfirm: () => void = () => {};
    (workflowsApi.confirmPush as any).mockImplementation(
      () => new Promise<void>((res) => { resolveConfirm = res; })
    );
    renderFooter();
    const confirm = screen.getByRole('button', { name: /GitHub'a gönder/i });
    const cancel = screen.getByRole('button', { name: /İptal et/i });
    await userEvent.click(confirm);
    expect(confirm).toBeDisabled();
    expect(cancel).toBeDisabled();
    resolveConfirm();
  });
});
```

- [ ] **Step 1.3: Run failing test**

```bash
pnpm -C frontend test -- PushGateFooter
```

Expected: 5 tests FAIL with "Cannot find module '../PushGateFooter'".

- [ ] **Step 1.4: Implement PushGateFooter**

Create `frontend/src/components/workflow/PushGateFooter.tsx`:

```typescript
import { useState } from 'react';
import { useI18n } from '../../i18n/useI18n';
import { workflowsApi } from '../../services/api/workflows';
import { cn } from '../../utils/cn';

type BusyMode = 'confirm' | 'cancel' | null;

export interface PushGateFooterProps {
  pipelineId: string;
  onResolved?: (action: 'confirm' | 'cancel') => void;
  className?: string;
}

/**
 * Sticky footer rendered at the bottom of PreviewPanel when the pipeline is
 * at `awaiting_push_confirm`. Surfaces the two terminal actions that used to
 * live inside PushConfirmGate.
 *
 * Bakkal-Türkçesi: never use "push" / "branch" — only "GitHub'a gönder".
 */
export function PushGateFooter({ pipelineId, onResolved, className }: PushGateFooterProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<BusyMode>(null);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (busy) return;
    setBusy('confirm');
    setError(null);
    try {
      await workflowsApi.confirmPush(pipelineId);
      onResolved?.('confirm');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chat.pushGate.errorConfirm'));
      setBusy(null);
    }
  };

  const handleCancel = async () => {
    if (busy) return;
    setBusy('cancel');
    setError(null);
    try {
      await workflowsApi.cancelPush(pipelineId);
      onResolved?.('cancel');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('chat.pushGate.errorCancel'));
      setBusy(null);
    }
  };

  return (
    <footer
      data-testid="push-gate-footer"
      className={cn(
        'sticky bottom-0 border-t border-ak-border bg-ak-surface/95 px-4 py-3 backdrop-blur',
        className
      )}
    >
      {error && (
        <div
          role="alert"
          className="mb-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200"
        >
          {error}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleConfirm}
          disabled={busy !== null}
          data-testid="push-gate-footer-confirm"
          className="rounded-md bg-ak-primary px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-ak-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'confirm' ? t('chat.pushGate.confirming') : t('chat.pushGate.confirm')}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy !== null}
          data-testid="push-gate-footer-cancel"
          className="rounded-md border border-ak-border bg-ak-surface px-3 py-1.5 text-xs font-medium text-ak-text-primary hover:bg-ak-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'cancel' ? t('chat.pushGate.cancelling') : t('chat.pushGate.cancel')}
        </button>
      </div>
    </footer>
  );
}

export default PushGateFooter;
```

- [ ] **Step 1.5: Run PushGateFooter tests, verify pass**

```bash
pnpm -C frontend test -- PushGateFooter
```

Expected: 5 tests PASS.

- [ ] **Step 1.6: Add pushGateProps slot to PreviewPanel**

In `frontend/src/components/workflow/PreviewPanel.tsx`:

1. Add import at top:
```typescript
import { PushGateFooter, type PushGateFooterProps } from './PushGateFooter';
```

2. Extend `PreviewPanelProps` interface (around line 38):
```typescript
interface PreviewPanelProps {
  files: Record<string, string> | null;
  loading?: boolean;
  branch?: string;
  activities?: PipelineActivity[];
  createdFiles?: string[];
  repoUrl?: string;
  /** When provided, renders a sticky footer with confirm/cancel push actions. */
  pushGateProps?: PushGateFooterProps;
}
```

3. Destructure `pushGateProps` in the component function signature. Find the existing destructure (search for `function PreviewPanel(`) and add `pushGateProps`.

4. Render the footer at the bottom of the PreviewPanel's outermost return JSX. Wrap the existing return with a flex container if not already, and append the footer:

```tsx
return (
  <div className="flex h-full flex-col">
    {/* ... existing PreviewPanel content unchanged ... */}
    {pushGateProps && <PushGateFooter {...pushGateProps} />}
  </div>
);
```

If the existing root is already `<div className="flex h-full flex-col">`, just append the footer line. Otherwise wrap.

- [ ] **Step 1.7: Add/extend PreviewPanel test for footer slot**

Check if `frontend/src/components/workflow/__tests__/PreviewPanel.test.tsx` exists. If yes, add two new tests; if no, create the file with:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewPanel } from '../PreviewPanel';
import { I18nProvider } from '../../../i18n/I18nProvider';

vi.mock('@codesandbox/sandpack-react', () => ({
  SandpackProvider: ({ children }: any) => <div data-testid="sandpack">{children}</div>,
  SandpackLayout: ({ children }: any) => <div>{children}</div>,
  SandpackPreview: () => <div data-testid="sandpack-preview" />,
}));

vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: { confirmPush: vi.fn(), cancelPush: vi.fn() },
}));

describe('PreviewPanel pushGateProps slot', () => {
  it('does not render footer when pushGateProps is undefined', () => {
    render(
      <I18nProvider>
        <PreviewPanel files={{ '/App.tsx': 'export default () => null' }} />
      </I18nProvider>
    );
    expect(screen.queryByTestId('push-gate-footer')).not.toBeInTheDocument();
  });

  it('renders PushGateFooter when pushGateProps provided', () => {
    render(
      <I18nProvider>
        <PreviewPanel
          files={{ '/App.tsx': 'export default () => null' }}
          pushGateProps={{ pipelineId: 'p-1' }}
        />
      </I18nProvider>
    );
    expect(screen.getByTestId('push-gate-footer')).toBeInTheDocument();
  });
});
```

If the file already exists, just append these two `it()` blocks inside its describe block.

- [ ] **Step 1.8: Run all touched tests**

```bash
pnpm -C frontend test -- PushGateFooter PreviewPanel
```

Expected: all PASS.

- [ ] **Step 1.9: Typecheck + lint**

```bash
pnpm -C frontend typecheck && pnpm -C frontend lint
```

Expected: 0 errors.

- [ ] **Step 1.10: Commit**

```bash
git add frontend/src/components/workflow/PushGateFooter.tsx \
  frontend/src/components/workflow/__tests__/PushGateFooter.test.tsx \
  frontend/src/components/workflow/PreviewPanel.tsx \
  frontend/src/components/workflow/__tests__/PreviewPanel.test.tsx
git commit -m "$(cat <<'EOF'
feat(T1): PushGateFooter component + PreviewPanel slot

New sticky footer rendered at PreviewPanel bottom when pushGateProps
provided. Surfaces confirm/cancel actions that previously lived inside
PushConfirmGate's chat card. Preview-unify spec § T1.

Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md
EOF
)"
```

- [ ] **Step 1.11: Push + open PR**

```bash
git push -u origin feat/T1-push-gate-footer
gh pr create --title "feat(T1): PushGateFooter + PreviewPanel slot" --body "$(cat <<'EOF'
## Summary
- New `PushGateFooter` component with confirm/cancel actions (uses existing `workflowsApi.confirmPush`/`cancelPush`)
- `PreviewPanel` gets opt-in `pushGateProps` slot — renders footer only when provided
- Backward compatible — undefined slot = no footer (current behavior preserved)

## Spec
`docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md` § T1

## Test plan
- [x] Unit: 5 PushGateFooter tests (render, confirm API, cancel API, error, busy disable)
- [x] Unit: 2 PreviewPanel slot tests (undefined → no footer; provided → footer)
- [x] Typecheck + lint pass
EOF
)"
```

---

## Task 2: PushConfirmGate compact rewrite

**Worktree:** `../akis-pgcompact` (branch: `feat/T2-push-gate-compact`)

**Files:**
- Modify: `frontend/src/components/pipeline/PushConfirmGate.tsx` (rewrite 203 → ~60 satır)
- Modify: `frontend/src/components/pipeline/__tests__/PushConfirmGate.test.tsx` (rewrite tests)
- Modify: `frontend/src/components/pipeline/PipelineDetailRail.tsx` (line 366 area — update props passed to PushConfirmGate)

- [ ] **Step 2.1: Worktree bootstrap**

```bash
git worktree add ../akis-pgcompact -b feat/T2-push-gate-compact main
cd ../akis-pgcompact
ln -s /Users/omeryasironal/Projects/akis-platform/.claude .claude
ln -s /Users/omeryasironal/Projects/akis-platform/backend/.env backend/.env
pnpm -C frontend install
```

- [ ] **Step 2.2: Rewrite PushConfirmGate.test.tsx (failing tests first)**

Replace `frontend/src/components/pipeline/__tests__/PushConfirmGate.test.tsx` with:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PushConfirmGate } from '../PushConfirmGate';
import { I18nProvider } from '../../../i18n/I18nProvider';

function renderGate(props: {
  fileCount?: number;
  previewOpen?: boolean;
  onOpenPreview?: () => void;
} = {}) {
  return render(
    <I18nProvider>
      <PushConfirmGate
        pipelineId="p-1"
        fileCount={props.fileCount ?? 19}
        previewOpen={props.previewOpen ?? true}
        onOpenPreview={props.onOpenPreview ?? (() => {})}
      />
    </I18nProvider>
  );
}

describe('PushConfirmGate (compact)', () => {
  it('renders the title and file count', () => {
    renderGate({ fileCount: 19 });
    expect(screen.getByText(/Kodu gözden geçir/i)).toBeInTheDocument();
    expect(screen.getByText(/19/)).toBeInTheDocument();
  });

  it('does NOT render an iframe or sandpack preview', () => {
    const { container } = renderGate();
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.queryByTestId('sandpack')).not.toBeInTheDocument();
  });

  it('does NOT render the old feedback textarea or Düzelt button', () => {
    renderGate();
    expect(screen.queryByTestId('push-confirm-gate-feedback-input')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Düzelt$/i })).not.toBeInTheDocument();
  });

  it('does NOT render GitHub gönder / İptal et buttons (they moved to footer)', () => {
    renderGate();
    expect(screen.queryByRole('button', { name: /GitHub'a gönder/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /İptal et/i })).not.toBeInTheDocument();
  });

  it('shows "Önizlemeyi aç" button only when previewOpen is false', async () => {
    const onOpenPreview = vi.fn();
    const { rerender } = renderGate({ previewOpen: false, onOpenPreview });
    const btn = screen.getByRole('button', { name: /Önizlemeyi aç/i });
    await userEvent.click(btn);
    expect(onOpenPreview).toHaveBeenCalledOnce();

    rerender(
      <I18nProvider>
        <PushConfirmGate pipelineId="p-1" fileCount={5} previewOpen={true} onOpenPreview={onOpenPreview} />
      </I18nProvider>
    );
    expect(screen.queryByRole('button', { name: /Önizlemeyi aç/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2.3: Run failing tests**

```bash
pnpm -C frontend test -- PushConfirmGate
```

Expected: tests FAIL (old behavior shown — iframe still rendered, old buttons exist).

- [ ] **Step 2.4: Rewrite PushConfirmGate.tsx**

Replace `frontend/src/components/pipeline/PushConfirmGate.tsx` entirely with:

```typescript
import { useI18n } from '../../i18n/useI18n';

export interface PushConfirmGateProps {
  pipelineId: string;
  /** Number of files in the dryRun preview — for the badge. */
  fileCount: number;
  /** Whether the right Preview Panel is currently visible. */
  previewOpen: boolean;
  /** Open the right Preview Panel (used when previewOpen is false). */
  onOpenPreview: () => void;
}

/**
 * Compact push-confirm card.
 *
 * Rendered inside PipelineDetailRail when the pipeline is in
 * `awaiting_push_confirm`. Lives in chat as a state announcement only:
 * the actual preview lives in the right PreviewPanel, the actions
 * (GitHub'a gönder / İptal et) live in PushGateFooter at the panel
 * bottom, and the "düzelt" loop happens via the chat input
 * (intent classifier → iterateWithFeedback).
 *
 * Bakkal-Türkçesi (NFR-5.1).
 */
export function PushConfirmGate({
  pipelineId: _pipelineId,
  fileCount,
  previewOpen,
  onOpenPreview,
}: PushConfirmGateProps) {
  const { t } = useI18n();

  return (
    <section
      data-testid="push-confirm-gate"
      aria-label={t('chat.pushGate.ariaLabel')}
      className="rounded-lg border border-ak-primary/30 bg-ak-primary/5 p-3"
    >
      <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ak-text-primary">{t('chat.pushGate.title')}</h3>
        {fileCount > 0 && (
          <span className="text-xs text-ak-text-secondary">
            {`${fileCount} ${t('chat.pushGate.fileCountSuffix')}`}
          </span>
        )}
      </header>

      <p className="mb-2 text-xs leading-relaxed text-ak-text-secondary">
        {t('chat.pushGate.description')}
      </p>

      {!previewOpen && (
        <button
          type="button"
          onClick={onOpenPreview}
          data-testid="push-confirm-gate-open-preview"
          className="rounded-md border border-ak-primary/50 bg-ak-surface px-3 py-1.5 text-xs font-medium text-ak-primary hover:bg-ak-primary/10"
        >
          {t('chat.pushGate.openPreview')}
        </button>
      )}
    </section>
  );
}

export default PushConfirmGate;
```

- [ ] **Step 2.5: Add temporary i18n key locally for testing**

Since T4 owns the full i18n cleanup but this task needs `chat.pushGate.openPreview` and an updated `chat.pushGate.description` to compile + render, add them now in tr.json and en.json. T4 will reconcile the full delta.

In `frontend/src/i18n/locales/tr.json`, find the `chat.pushGate` block (~line 315-331) and:

1. Replace the value of `chat.pushGate.description` with:
```
"chat.pushGate.description": "Sağdaki önizlemeyi inceleyin. GitHub'a göndermek veya iptal etmek için sağdaki butonu kullanın. Düzeltme için aşağıdaki chat'e yazın.",
```

2. Add after `chat.pushGate.fileCountSuffix`:
```
"chat.pushGate.openPreview": "Önizlemeyi aç",
```

In `frontend/src/i18n/locales/en.json`, mirror:
- `"chat.pushGate.description": "Inspect the preview on the right. Use the buttons on the right to send to GitHub or cancel. For corrections, type in the chat below."`
- `"chat.pushGate.openPreview": "Open preview"`

(Other deletions / additions handled in T4 to avoid conflict.)

- [ ] **Step 2.6: Update PipelineDetailRail.tsx prop wiring**

Open `frontend/src/components/pipeline/PipelineDetailRail.tsx`, find the `<PushConfirmGate` JSX (~line 366). Replace the props with new shape:

```tsx
<PushConfirmGate
  pipelineId={pipelineId}
  fileCount={protoFiles ? Object.keys(protoFiles).length : 0}
  previewOpen={showPreview ?? false}
  onOpenPreview={() => onTogglePreview?.()}
/>
```

You will likely need to add `showPreview` and `onTogglePreview` to `PipelineDetailRail`'s props interface and pipe them in. Check the current prop interface near the top of the file. Add:

```typescript
interface PipelineDetailRailProps {
  // ... existing
  showPreview?: boolean;
  onTogglePreview?: () => void;
}
```

And destructure them in the component signature. The caller (ChatPanel or whoever mounts the rail) needs to pass these — but if they're not threaded through yet, do so in T3 (PipelineDetailRail is consumed by ChatPanel which is mounted by ChatPageLayout, which already has both values in scope). For T2's atomic correctness, accept `undefined` and default to `false` / no-op.

- [ ] **Step 2.7: Run tests**

```bash
pnpm -C frontend test -- PushConfirmGate
```

Expected: 5 compact tests PASS.

- [ ] **Step 2.8: Typecheck + lint**

```bash
pnpm -C frontend typecheck && pnpm -C frontend lint
```

Expected: 0 errors.

NOTE: If typecheck fails because callers of `PushConfirmGate` still pass `files`/`onResolved`, search-and-update them:

```bash
grep -rn "<PushConfirmGate" frontend/src --include="*.tsx"
```

Update each call site to use the new props.

- [ ] **Step 2.9: Run full frontend test suite**

```bash
pnpm -C frontend test
```

Expected: PASS overall. If any unrelated test breaks, investigate — likely a snapshot tied to the old card body. Update snapshots if appropriate.

- [ ] **Step 2.10: Commit**

```bash
git add frontend/src/components/pipeline/PushConfirmGate.tsx \
  frontend/src/components/pipeline/__tests__/PushConfirmGate.test.tsx \
  frontend/src/components/pipeline/PipelineDetailRail.tsx \
  frontend/src/i18n/locales/tr.json \
  frontend/src/i18n/locales/en.json
git commit -m "$(cat <<'EOF'
feat(T2): PushConfirmGate compact rewrite

203 → ~60 satır. Card no longer renders the duplicate preview iframe,
confirm/cancel buttons (moved to PushGateFooter in T1), or the feedback
textarea + Düzelt button (replaced by chat-driven iteration in T3).
Card now announces the gate state and offers an 'Önizlemeyi aç' button
when the right panel is closed.

Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T2
EOF
)"
```

- [ ] **Step 2.11: Push + open PR**

```bash
git push -u origin feat/T2-push-gate-compact
gh pr create --title "feat(T2): PushConfirmGate compact rewrite" --body "$(cat <<'EOF'
## Summary
- PushConfirmGate trimmed from 203 → ~60 satır
- Removed: inline preview iframe, confirm/cancel buttons, feedback textarea, Düzelt button
- Added: 'Önizlemeyi aç' fallback when right panel is closed
- i18n: locally added `chat.pushGate.openPreview` and updated `chat.pushGate.description` (full delta cleanup lands in T4)

## Spec
`docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md` § T2

## Test plan
- [x] Unit: 5 new compact tests
- [x] Verified: no iframe / sandpack in rendered DOM
- [x] Verified: no Düzelt textarea, no confirm/cancel buttons in card

## Note
Depends on T1's PushGateFooter for confirm/cancel actions to work end-to-end. Until T1 merges, gate actions are unreachable — but T1 ships in parallel.
EOF
)"
```

---

## Task 3: handleIntentFeedback wiring + auto-open + state-aware fallback

**Worktree:** `../akis-feedback-routing` (branch: `feat/T3-feedback-routing`)

**Files:**
- Modify: `frontend/src/pages/chat/ChatPage.tsx` (line 305-308 — `handleIntentFeedback`)
- Modify: `frontend/src/pages/chat/ChatPageLayout.tsx` (auto-open effect + pushGateProps prop drilling)
- Modify: `frontend/src/hooks/useConversationState.ts` (line 45-49 — placeholder string)
- Modify: `frontend/src/components/chat/ChatRouter.tsx` (line 120-125 — classify-error fallback state-aware)
- Modify: `frontend/src/i18n/locales/tr.json` + `en.json` (add `chat.feedback.optimisticEcho`)
- Create or modify: `frontend/src/pages/chat/__tests__/ChatPage.intent.test.tsx` (or extend existing)

- [ ] **Step 3.1: Worktree bootstrap**

```bash
git worktree add ../akis-feedback-routing -b feat/T3-feedback-routing main
cd ../akis-feedback-routing
ln -s /Users/omeryasironal/Projects/akis-platform/.claude .claude
ln -s /Users/omeryasironal/Projects/akis-platform/backend/.env backend/.env
pnpm -C frontend install
```

- [ ] **Step 3.2: Update useConversationState placeholder**

Open `frontend/src/hooks/useConversationState.ts`. Line 45-49 currently:

```typescript
if (uiState === 'awaiting_push_confirm')
  return "Kodu inceleyin ve GitHub'a göndermek için yukarıdan onaylayın...";
```

Replace with:

```typescript
if (uiState === 'awaiting_push_confirm')
  return "Ne değişsin? Örn: 'renkleri pembe yap'. Veya sağdaki butonla GitHub'a gönder.";
```

- [ ] **Step 3.3: Add chat.feedback.optimisticEcho i18n key**

In `frontend/src/i18n/locales/tr.json`, add (near `chat.pushGate.*` block):

```json
"chat.feedback.optimisticEcho": "Düzeltme gönderildi: \"{snippet}\". Proto güncelleniyor...",
```

In `frontend/src/i18n/locales/en.json`:

```json
"chat.feedback.optimisticEcho": "Correction sent: \"{snippet}\". Proto is updating...",
```

If `i18n.types.ts` auto-derives keys, regen will happen in lint/typecheck. If manual, add the key to the `MessageKey` union.

- [ ] **Step 3.4: Wire handleIntentFeedback to iterate endpoint**

Open `frontend/src/pages/chat/ChatPage.tsx`. Find `handleIntentFeedback` (around line 305-308):

```typescript
const handleIntentFeedback = useCallback(
  (message: string) => intentPlaceholder('Geribildirim', message),
  [intentPlaceholder]
);
```

Replace with:

```typescript
const handleIntentFeedback = useCallback(
  async (message: string) => {
    const isPushConfirm = activeWorkflow?.uiState === 'awaiting_push_confirm';
    if (!isPushConfirm || !activeWorkflow?.id) {
      return intentPlaceholder('Geribildirim', message);
    }
    const stamp = new Date().toISOString();
    const snippet = message.length > 60 ? message.slice(0, 60) + '…' : message;
    // Optimistic: add user message + system echo before API resolves
    setMessages((prev) => [
      ...prev,
      { type: 'user', content: message, timestamp: stamp },
      {
        type: 'info',
        content: t('chat.feedback.optimisticEcho', { snippet }),
        timestamp: stamp,
      },
    ]);
    try {
      await workflowsApi.iterateWithFeedback(activeWorkflow.id, message);
      // Pipeline transitions to proto_building; the polling hook picks up
      // new files and re-renders the gate.
    } catch (e) {
      toast(
        e instanceof Error ? e.message : 'Düzeltme gönderilemedi.',
        'error'
      );
    }
  },
  [activeWorkflow, intentPlaceholder, setMessages, t, toast]
);
```

You'll need to ensure `workflowsApi`, `toast`, and `t` are already imported / in scope. Search the file for `workflowsApi` and `toast` imports; add if missing:

```typescript
import { workflowsApi } from '../../services/api/workflows';
import { useI18n } from '../../i18n/useI18n';
// ...inside component:
const { t } = useI18n();
```

(`toast` is likely already imported since `intentPlaceholder` uses it.)

- [ ] **Step 3.5: Auto-open Preview Panel in ChatPageLayout**

Open `frontend/src/pages/chat/ChatPageLayout.tsx`. Locate where `showPreview` and `setShowPreview` are received as props (`~line 75-78`). Inside the component body (after the destructure, before the return), add:

```typescript
import { useEffect } from 'react';  // ensure imported
// ...inside the component:
useEffect(() => {
  if (uiState === 'awaiting_push_confirm' && !showPreview) {
    setShowPreview(true);
  }
}, [uiState, showPreview, setShowPreview]);
```

- [ ] **Step 3.6: Pass pushGateProps to PreviewPanel**

In `ChatPageLayout.tsx`, find the `<PreviewPanel` render (~line 349-355). Update to pass `pushGateProps` when state matches:

```tsx
<PreviewPanel
  files={protoFiles}
  branch={activeWorkflow?.stages?.proto?.branch}
  activities={pipelineActivities}
  createdFiles={createdFiles}
  pushGateProps={
    uiState === 'awaiting_push_confirm' && conversationId
      ? {
          pipelineId: conversationId,
          onResolved: onPushResolved,
        }
      : undefined
  }
/>
```

`onPushResolved` should already be in scope (line 303 passes it to `ChatPanel`). If not, thread it through.

- [ ] **Step 3.7: ChatRouter state-aware classify-error fallback**

Open `frontend/src/components/chat/ChatRouter.tsx`. Add a new optional prop `pipelineUiState`:

```typescript
export interface ChatRouterProps {
  // ... existing
  /** Current pipeline state — used to bias classify-error fallback. */
  pipelineUiState?: string;
}

// Destructure it in the component signature.
```

Find the classify catch block (around line 120-125):

```typescript
} catch {
  await dispatch('BUILD', message, attachments);
  return;
}
```

Replace with:

```typescript
} catch {
  // State-aware fallback: at the push-confirm gate, prefer FEEDBACK so a
  // classifier hiccup doesn't kick the user back to BUILD (which would
  // restart the whole pipeline).
  const fallback = pipelineUiState === 'awaiting_push_confirm' ? 'FEEDBACK' : 'BUILD';
  await dispatch(fallback as IntentLabel, message, attachments);
  return;
}
```

In `ChatPageLayout.tsx`, pass `pipelineUiState={uiState}` to the `<ChatRouter>` (around line 255).

- [ ] **Step 3.8: Write intent-feedback tests**

Check if `frontend/src/pages/chat/__tests__/ChatPage.intent.test.tsx` exists. If yes, append; if no, create:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { workflowsApi } from '../../../services/api/workflows';
// import { renderChatPage } from '../testHelpers'; // use the existing helper if there is one

vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    iterateWithFeedback: vi.fn(),
    confirmPush: vi.fn(),
    cancelPush: vi.fn(),
  },
}));

describe('ChatPage handleIntentFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls iterateWithFeedback when state is awaiting_push_confirm', async () => {
    // TODO: render ChatPage with mocked activeWorkflow.uiState='awaiting_push_confirm'
    //       simulate FEEDBACK intent dispatch
    //       assert workflowsApi.iterateWithFeedback called with workflow.id + message
    // If renderChatPage helper exists, use it. Else build a minimal mount that
    // injects activeWorkflow via the data provider or props.
    expect(true).toBe(true); // PLACEHOLDER — replace with real assertion
  });

  it('falls back to placeholder when state is not awaiting_push_confirm', async () => {
    expect(true).toBe(true); // PLACEHOLDER
  });

  it('adds optimistic echo message on iterate', async () => {
    expect(true).toBe(true); // PLACEHOLDER
  });

  it('shows toast on iterate error', async () => {
    expect(true).toBe(true); // PLACEHOLDER
  });
});
```

**Subagent note:** The placeholder `expect(true).toBe(true)` lines MUST be replaced with real test bodies. If the existing `ChatPage` test scaffolding (look in `frontend/src/pages/chat/__tests__/`) doesn't make this easy, write a more isolated test using a small wrapper that exercises just `handleIntentFeedback` — extract it to a custom hook if needed. **Do not commit placeholder tests.**

- [ ] **Step 3.9: ChatRouter state-aware fallback test**

In `frontend/src/components/chat/__tests__/ChatRouter.test.tsx`, add:

```typescript
it('falls back to FEEDBACK on classify error when state is awaiting_push_confirm', async () => {
  const onFeedback = vi.fn();
  const onBuild = vi.fn();
  const api = {
    classify: vi.fn().mockRejectedValue(new Error('network')),
    override: vi.fn(),
  };
  render(
    <ChatRouter
      pipelineUiState="awaiting_push_confirm"
      onBuild={onBuild}
      onAsk={() => {}}
      onFeedback={onFeedback}
      onChat={() => {}}
      api={api}
    >
      {({ send }) => <button onClick={() => send('renkleri pembe yap')}>send</button>}
    </ChatRouter>
  );
  await userEvent.click(screen.getByText('send'));
  await waitFor(() => expect(onFeedback).toHaveBeenCalled());
  expect(onBuild).not.toHaveBeenCalled();
});

it('falls back to BUILD on classify error when state is not awaiting_push_confirm', async () => {
  const onFeedback = vi.fn();
  const onBuild = vi.fn();
  const api = {
    classify: vi.fn().mockRejectedValue(new Error('network')),
    override: vi.fn(),
  };
  render(
    <ChatRouter
      pipelineUiState="idle"
      onBuild={onBuild}
      onAsk={() => {}}
      onFeedback={onFeedback}
      onChat={() => {}}
      api={api}
    >
      {({ send }) => <button onClick={() => send('build something')}>send</button>}
    </ChatRouter>
  );
  await userEvent.click(screen.getByText('send'));
  await waitFor(() => expect(onBuild).toHaveBeenCalled());
  expect(onFeedback).not.toHaveBeenCalled();
});
```

- [ ] **Step 3.10: Auto-open test**

In `frontend/src/pages/chat/__tests__/` (use existing layout test file or create `ChatPageLayout.auto-open.test.tsx`):

```typescript
it('auto-opens preview when uiState becomes awaiting_push_confirm', () => {
  const setShowPreview = vi.fn();
  // Render ChatPageLayout with uiState='awaiting_push_confirm' and showPreview=false
  // Expect setShowPreview(true) called once.
  // (Use the existing layout-test scaffolding if present.)
});
```

If wiring a full layout test is too heavy, extract the effect into a small custom hook `useAutoOpenPreview(uiState, showPreview, setShowPreview)` and test that hook in isolation:

```typescript
// frontend/src/hooks/useAutoOpenPreview.ts
import { useEffect } from 'react';
export function useAutoOpenPreview(
  uiState: string,
  showPreview: boolean,
  setShowPreview: (v: boolean) => void
) {
  useEffect(() => {
    if (uiState === 'awaiting_push_confirm' && !showPreview) {
      setShowPreview(true);
    }
  }, [uiState, showPreview, setShowPreview]);
}
```

Test:

```typescript
import { renderHook } from '@testing-library/react';
import { useAutoOpenPreview } from '../useAutoOpenPreview';

it('opens preview when state becomes awaiting_push_confirm', () => {
  const setShowPreview = vi.fn();
  const { rerender } = renderHook(
    ({ s, o }: { s: string; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
    { initialProps: { s: 'idle', o: false } }
  );
  expect(setShowPreview).not.toHaveBeenCalled();
  rerender({ s: 'awaiting_push_confirm', o: false });
  expect(setShowPreview).toHaveBeenCalledWith(true);
});

it('does not re-open when user has manually closed', () => {
  const setShowPreview = vi.fn();
  const { rerender } = renderHook(
    ({ s, o }: { s: string; o: boolean }) => useAutoOpenPreview(s, o, setShowPreview),
    { initialProps: { s: 'awaiting_push_confirm', o: true } }
  );
  expect(setShowPreview).not.toHaveBeenCalled();
});
```

Then use this hook in `ChatPageLayout.tsx`.

- [ ] **Step 3.11: Run tests**

```bash
pnpm -C frontend test -- ChatPage ChatRouter useAutoOpenPreview
```

Expected: PASS.

- [ ] **Step 3.12: Typecheck + lint**

```bash
pnpm -C frontend typecheck && pnpm -C frontend lint
```

Expected: 0 errors.

- [ ] **Step 3.13: Full suite**

```bash
pnpm -C frontend test
```

If `useConversationState.test.ts` has a snapshot of the old placeholder, update it. Bakkal-language audit:

```bash
pnpm -C frontend exec node scripts/bakkal-language-audit.mjs 2>/dev/null || true
```

(Path may vary — check `package.json` for the actual script name.)

- [ ] **Step 3.14: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(T3): chat-driven iterate routing + auto-open preview

- handleIntentFeedback wired to workflowsApi.iterateWithFeedback when
  pipeline state is awaiting_push_confirm; otherwise falls back to the
  existing placeholder.
- Optimistic echo: user msg + system "Düzeltme gönderildi" appended.
- ChatPageLayout auto-opens the right Preview Panel when state
  becomes awaiting_push_confirm (via new useAutoOpenPreview hook).
- ChatRouter classify-error fallback is now state-aware: at the
  push-confirm gate it falls back to FEEDBACK (not BUILD) so a
  classifier hiccup doesn't restart the pipeline.
- useConversationState placeholder updated for awaiting_push_confirm.

Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T3
EOF
)"
```

- [ ] **Step 3.15: Push + open PR**

```bash
git push -u origin feat/T3-feedback-routing
gh pr create --title "feat(T3): chat-driven iterate + auto-open preview" --body "$(cat <<'EOF'
## Summary
- handleIntentFeedback now wires to iterateWithFeedback at push-confirm state
- ChatPageLayout auto-opens right Preview Panel at push-confirm transition
- ChatRouter classify-error fallback is state-aware (FEEDBACK at push-confirm)
- New useAutoOpenPreview hook (testable in isolation)
- Placeholder for awaiting_push_confirm: 'Ne değişsin? ...'

## Spec
`docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md` § T3

## Test plan
- [x] Hook test for useAutoOpenPreview (2 cases)
- [x] ChatRouter state-aware fallback (2 cases)
- [x] ChatPage handleIntentFeedback (real assertions, not placeholders)
EOF
)"
```

---

## Task 4: i18n delta cleanup

**Branch:** ana repo (`chore/T4-i18n-cleanup`)
**Depends on:** T1 + T2 + T3 merged

**Files:**
- Modify: `frontend/src/i18n/locales/tr.json`
- Modify: `frontend/src/i18n/locales/en.json`
- Modify: `frontend/src/i18n/i18n.types.ts` (auto or manual)

- [ ] **Step 4.1: Pull main**

```bash
cd /Users/omeryasironal/Projects/akis-platform
git checkout main && git pull
git checkout -b chore/T4-i18n-cleanup
```

- [ ] **Step 4.2: Remove deprecated keys**

In `frontend/src/i18n/locales/tr.json`, delete these keys (they are unused after T2/T3):

```
chat.pushGate.previewLoading
chat.pushGate.feedback.title
chat.pushGate.feedback.hint
chat.pushGate.feedback.placeholder
chat.pushGate.feedback.submit
chat.pushGate.feedback.iterating
chat.pushGate.errorIterate
```

Mirror deletions in `en.json`.

- [ ] **Step 4.3: Verify no remaining references**

```bash
for key in chat.pushGate.previewLoading chat.pushGate.feedback.title \
  chat.pushGate.feedback.hint chat.pushGate.feedback.placeholder \
  chat.pushGate.feedback.submit chat.pushGate.feedback.iterating \
  chat.pushGate.errorIterate; do
  echo "=== $key ==="
  grep -rn "$key" frontend/src --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v __tests__ || echo "clean"
done
```

Expected: every block says "clean".

- [ ] **Step 4.4: Regen / update i18n.types.ts**

```bash
pnpm -C frontend typecheck
```

If typecheck complains about missing keys in `i18n.types.ts` union, regenerate:

```bash
pnpm -C frontend generate:types 2>/dev/null || true
# If that script doesn't exist, manually edit i18n.types.ts:
#   - Remove the deleted keys from the MessageKey union.
#   - Keep chat.pushGate.openPreview and chat.feedback.optimisticEcho.
```

- [ ] **Step 4.5: Bakkal-language audit**

```bash
pnpm -C frontend exec node scripts/bakkal-language-audit.mjs 2>/dev/null \
  || pnpm -C frontend exec scripts/bakkal-lang.mjs 2>/dev/null \
  || node frontend/scripts/bakkal-language-audit.mjs 2>/dev/null \
  || echo "audit script path differs — check package.json"
```

Find the right path; expect 0 warn.

- [ ] **Step 4.6: Run frontend tests**

```bash
pnpm -C frontend test
```

Expected: PASS.

- [ ] **Step 4.7: Commit + PR**

```bash
git add frontend/src/i18n/
git commit -m "$(cat <<'EOF'
chore(T4): drop deprecated pushGate.feedback.* i18n keys

After T2 (PushConfirmGate compact) and T3 (chat-driven iterate), the
following keys are unreferenced and safe to remove:

- chat.pushGate.previewLoading (no inline iframe)
- chat.pushGate.feedback.title / .hint / .placeholder / .submit /
  .iterating / .errorIterate (textarea + Düzelt deleted)

Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T4
EOF
)"
git push -u origin chore/T4-i18n-cleanup
gh pr create --title "chore(T4): drop deprecated pushGate.feedback.* i18n keys" --body "$(cat <<'EOF'
## Summary
- Removes 7 unused i18n keys (chat.pushGate.previewLoading + chat.pushGate.feedback.*)
- Verified zero references in source code (grep clean)
- Bakkal-language audit: 0 warn

## Spec
`docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md` § T4
EOF
)"
```

---

## Task 5: E2E spec — push-gate-chat-iterate

**Branch:** ana repo (`test/T5-push-gate-iterate-e2e`)
**Depends on:** T1 + T2 + T3 merged (T4 ideally too)

**Files:**
- Create: `frontend/playwright/specs/push-gate-chat-iterate.spec.ts`

- [ ] **Step 5.1: Branch**

```bash
cd /Users/omeryasironal/Projects/akis-platform
git checkout main && git pull
git checkout -b test/T5-push-gate-iterate-e2e
```

- [ ] **Step 5.2: Write the spec**

Create `frontend/playwright/specs/push-gate-chat-iterate.spec.ts`. Use existing e2e helpers — look at `frontend/playwright/specs/intent-disambiguation.spec.ts` (PR #526) for the pattern (auth setup, mock provider, walkthrough steps).

```typescript
import { test, expect } from '@playwright/test';
import { setupTestUser, startNewPipeline, waitForPipelineStage } from './helpers';
// Adjust helper imports to match the existing test infrastructure;
// inspect ./helpers/* to find the right exports.

test.describe('Push-gate chat-driven iterate flow', () => {
  test('preview opens automatically, footer surfaces actions, chat iterates', async ({ page }) => {
    await setupTestUser(page);
    await startNewPipeline(page, 'QR kod üretici web sayfası, tek dosya');

    // Wait until pipeline reaches awaiting_push_confirm.
    await waitForPipelineStage(page, 'awaiting_push_confirm', { timeout: 60_000 });

    // Right preview panel auto-opened
    await expect(page.getByTestId('preview-panel')).toBeVisible();

    // Compact card present but no inline iframe
    const card = page.getByTestId('push-confirm-gate');
    await expect(card).toBeVisible();
    await expect(card.locator('iframe')).toHaveCount(0);

    // Footer surfaces both actions
    await expect(page.getByTestId('push-gate-footer-confirm')).toBeVisible();
    await expect(page.getByTestId('push-gate-footer-cancel')).toBeVisible();

    // Chat: type a feedback message
    const chatInput = page.getByPlaceholder(/Ne değişsin/i);
    await chatInput.fill('başlığı büyült');
    await chatInput.press('Enter');

    // Optimistic echo appears
    await expect(page.getByText(/Düzeltme gönderildi:/i)).toBeVisible({ timeout: 5_000 });

    // Pipeline cycles: proto_building → back to awaiting_push_confirm
    await waitForPipelineStage(page, 'proto_running', { timeout: 30_000 });
    await waitForPipelineStage(page, 'awaiting_push_confirm', { timeout: 120_000 });
  });

  test('cancel action ends the pipeline', async ({ page }) => {
    await setupTestUser(page);
    await startNewPipeline(page, 'Counter web app, single file');
    await waitForPipelineStage(page, 'awaiting_push_confirm', { timeout: 60_000 });

    await page.getByTestId('push-gate-footer-cancel').click();
    await waitForPipelineStage(page, 'idle', { timeout: 30_000 });
  });
});
```

If helpers like `waitForPipelineStage` don't exist, write inline:

```typescript
async function waitForPipelineStage(page, stage, opts = {}) {
  await page.waitForFunction(
    (s) => document.body.dataset.pipelineState === s,
    stage,
    opts
  );
}
```

(Or read the actual pattern from existing e2e specs and copy.)

- [ ] **Step 5.3: Run the e2e spec locally**

```bash
./scripts/dev-up.sh
# Wait until backend reports ready in dev-logs
pnpm -C frontend exec playwright test push-gate-chat-iterate.spec.ts --headed=false
```

Expected: tests PASS. If they flake on timing, use the existing helper pattern (polling DOM attributes the way intent-disambiguation.spec.ts does).

- [ ] **Step 5.4: Commit + PR**

```bash
git add frontend/playwright/specs/push-gate-chat-iterate.spec.ts
git commit -m "$(cat <<'EOF'
test(T5): e2e spec for push-gate chat-driven iterate flow

End-to-end coverage of the unified preview + chat-iterate flow:
- auto-open right Preview Panel at awaiting_push_confirm
- compact card has no inline iframe
- footer surfaces confirm/cancel actions
- chat input → optimistic echo → proto re-iterate → back to gate

Spec: docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md § T5
EOF
)"
git push -u origin test/T5-push-gate-iterate-e2e
gh pr create --title "test(T5): e2e spec for push-gate chat-iterate" --body "$(cat <<'EOF'
## Summary
- New Playwright spec covering the full preview-unify + chat-iterate flow
- Verifies auto-open, no inline iframe, footer actions, optimistic echo, iterate cycle

## Spec
`docs/superpowers/specs/2026-05-14-preview-unify-chat-iterate-design.md` § T5
EOF
)"
```

---

## Worktree cleanup (after all PRs merged)

```bash
cd /Users/omeryasironal/Projects/akis-platform
git worktree remove ../akis-pgfooter
git worktree remove ../akis-pgcompact
git worktree remove ../akis-feedback-routing
git branch -D feat/T1-push-gate-footer feat/T2-push-gate-compact feat/T3-feedback-routing
```

---

## Definition of Done

- [ ] T1 PR merged + CI green
- [ ] T2 PR merged + CI green
- [ ] T3 PR merged + CI green
- [ ] T4 i18n cleanup PR merged + bakkal-language audit 0 warn
- [ ] T5 e2e PR merged + Playwright spec green in CI
- [ ] `grep -rn "chat.pushGate.feedback" frontend/src` → 0 hits
- [ ] `grep -rn "iframe" frontend/src/components/pipeline/PushConfirmGate.tsx` → 0 hits
- [ ] Manuel doğrulama (localhost:5173):
  - Push gate'e geç → sağ panel otomatik açıldı
  - Compact card iframe içermez
  - Sağ footer'da iki buton var
  - Chat'e "renkleri kırmızı yap" yaz → echo + proto re-runs
- [ ] `/review` çıktısı: high/medium 0
- [ ] Memory: `b4-ci-debug-pending.md` silinir (geçersiz)

---

## Self-review notes (writing-plans skill required)

- **Spec coverage:** all 8 FR-PU + 6 NFR-PU mapped to tasks. ✓
- **Placeholder scan:** T3 step 3.8 contains explicit `expect(true).toBe(true)` placeholders for ChatPage.intent tests. The subagent executing T3 MUST replace these with real assertions before commit — flagged in the step text. ⚠ Acceptable (no other way to give real test bodies without a mounted ChatPage harness specific to this repo; subagent picks the harness pattern).
- **Type consistency:** `PushGateFooterProps.onResolved` signature is `(action: 'confirm' | 'cancel') => void` everywhere (T1 component, T1 test, T3 caller). ✓
- **PushConfirmGate** prop name `onOpenPreview` consistent in T2 component, T2 test, T2 PipelineDetailRail call site. ✓
- **i18n key names** consistent: `chat.pushGate.openPreview` and `chat.feedback.optimisticEcho` referenced identically in T2, T3, T4. ✓
