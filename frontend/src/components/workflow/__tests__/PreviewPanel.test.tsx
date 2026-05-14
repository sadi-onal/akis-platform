/**
 * T1 — PreviewPanel pushGateProps slot test.
 *
 * The slot is opt-in: omitting `pushGateProps` must preserve the previous
 * footer-less render (backward compatible). Passing the prop must mount the
 * sticky {@link PushGateFooter} so the right-rail surfaces confirm/cancel
 * actions while the pipeline is at `awaiting_push_confirm`.
 *
 * Sandpack pulls in @stitches/core whose runtime CSSOM doesn't parse cleanly
 * in jsdom — irrelevant here, mocked away.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PreviewPanel } from '../PreviewPanel';

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

vi.mock('@codesandbox/sandpack-react', () => ({
  SandpackProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sandpack">{children}</div>
  ),
  SandpackLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SandpackPreview: () => <div data-testid="sandpack-preview" />,
}));

vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    confirmPush: vi.fn(),
    cancelPush: vi.fn(),
  },
}));

const filesFixture: Record<string, string> = {
  '/App.tsx': 'export default () => null',
};

describe('PreviewPanel pushGateProps slot', () => {
  it('does not render the push-gate footer when pushGateProps is undefined', () => {
    render(<PreviewPanel files={filesFixture} />);
    expect(screen.queryByTestId('push-gate-footer')).not.toBeInTheDocument();
  });

  it('renders the PushGateFooter when pushGateProps is provided', () => {
    render(
      <PreviewPanel
        files={filesFixture}
        pushGateProps={{ pipelineId: 'p-1' }}
      />,
    );
    expect(screen.getByTestId('push-gate-footer')).toBeInTheDocument();
    expect(screen.getByTestId('push-gate-footer-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('push-gate-footer-cancel')).toBeInTheDocument();
  });
});
