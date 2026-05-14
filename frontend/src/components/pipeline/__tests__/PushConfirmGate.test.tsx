/**
 * PDP-3 T2 — PushConfirmGate compact card tests.
 *
 * Covers the rewritten contract:
 *   - Renders title + file count (header announcement)
 *   - Does NOT render an iframe or sandpack preview (moved to PreviewPanel)
 *   - Does NOT render feedback textarea / Düzelt button (moved to chat in T3)
 *   - Does NOT render GitHub gönder / İptal et buttons (moved to PushGateFooter in T1)
 *   - 'Önizlemeyi aç' button visible only when previewOpen=false; clicking it
 *     invokes onOpenPreview
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PushConfirmGate } from '../PushConfirmGate';

// Map the i18n keys actually used by the compact card to user-visible Turkish
// strings so regex assertions on rendered DOM (e.g. /Kodu gözden geçir/i)
// behave like the real catalogue would. Anything not in this map falls
// back to the raw key — which would fail loudly if the component referenced
// an unexpected key.
const TR_STUBS: Record<string, string> = {
  'chat.pushGate.ariaLabel': "GitHub'a gönderme kararı",
  'chat.pushGate.title': 'Kodu gözden geçir',
  'chat.pushGate.description':
    "Sağdaki önizlemeyi inceleyin. GitHub'a göndermek veya iptal etmek için sağdaki butonu kullanın. Düzeltme için aşağıdaki chat'e yazın.",
  'chat.pushGate.fileCountSuffix': 'dosya',
  'chat.pushGate.openPreview': 'Önizlemeyi aç',
};

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => TR_STUBS[key] ?? key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

function renderGate(
  props: {
    fileCount?: number;
    previewOpen?: boolean;
    onOpenPreview?: () => void;
  } = {}
) {
  return render(
    <PushConfirmGate
      pipelineId="p-1"
      fileCount={props.fileCount ?? 19}
      previewOpen={props.previewOpen ?? true}
      onOpenPreview={props.onOpenPreview ?? (() => {})}
    />
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
    expect(screen.queryByTestId('mock-preview-panel')).not.toBeInTheDocument();
  });

  it('does NOT render the old feedback textarea or Düzelt button', () => {
    renderGate();
    expect(
      screen.queryByTestId('push-confirm-gate-feedback-input')
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Düzelt$/i })).not.toBeInTheDocument();
  });

  it('does NOT render GitHub gönder / İptal et buttons (they moved to footer)', () => {
    renderGate();
    expect(
      screen.queryByRole('button', { name: /GitHub'a gönder/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /İptal et/i })).not.toBeInTheDocument();
  });

  it('shows "Önizlemeyi aç" button only when previewOpen is false', () => {
    const onOpenPreview = vi.fn();
    const { rerender } = renderGate({ previewOpen: false, onOpenPreview });
    const btn = screen.getByRole('button', { name: /Önizlemeyi aç/i });
    fireEvent.click(btn);
    expect(onOpenPreview).toHaveBeenCalledOnce();

    rerender(
      <PushConfirmGate
        pipelineId="p-1"
        fileCount={5}
        previewOpen={true}
        onOpenPreview={onOpenPreview}
      />
    );
    expect(
      screen.queryByRole('button', { name: /Önizlemeyi aç/i })
    ).not.toBeInTheDocument();
  });
});
