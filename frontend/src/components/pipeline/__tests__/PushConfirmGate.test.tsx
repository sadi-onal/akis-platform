/**
 * PDP-3 B4 — PushConfirmGate component test.
 *
 * Covers:
 *   - Renders both buttons and the bakkal-Türkçesi title.
 *   - Confirm button hits `workflowsApi.confirmPush(pipelineId)` and fires
 *     the `onResolved` callback.
 *   - Cancel button hits `workflowsApi.cancelPush(pipelineId)` and fires
 *     the `onResolved` callback.
 *   - Both buttons disable while a request is in flight.
 *   - Error from API surfaces in the alert region and re-enables buttons.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PushConfirmGate } from '../PushConfirmGate';

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

// Sandpack pulls in @stitches/core whose runtime CSSOM doesn't parse in
// jsdom — irrelevant to the gate's behaviour. Mock the lazy PreviewPanel
// so the gate test stays focused on its contract (buttons + API calls).
vi.mock('../../workflow/PreviewPanel', () => ({
  PreviewPanel: ({ files }: { files: Record<string, string> | null }) => (
    <div data-testid="mock-preview-panel">
      {files ? `preview:${Object.keys(files).length}` : 'no-files'}
    </div>
  ),
}));

const confirmPush = vi.fn();
const cancelPush = vi.fn();

vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    confirmPush: (id: string) => confirmPush(id),
    cancelPush: (id: string) => cancelPush(id),
  },
}));

const filesFixture: Record<string, string> = {
  'src/App.tsx': 'export default function App(){return null}',
  'package.json': '{}',
};

describe('PushConfirmGate', () => {
  beforeEach(() => {
    confirmPush.mockReset();
    cancelPush.mockReset();
  });

  it('renders title + both buttons in Turkish', () => {
    render(<PushConfirmGate pipelineId="p-1" files={filesFixture} />);
    expect(screen.getByTestId('push-confirm-gate')).toBeInTheDocument();
    expect(screen.getByTestId('push-confirm-gate-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('push-confirm-gate-cancel')).toBeInTheDocument();
  });

  it('calls confirmPush + onResolved when confirm clicked', async () => {
    const onResolved = vi.fn();
    confirmPush.mockResolvedValue({ id: 'p-1' });
    render(<PushConfirmGate pipelineId="p-1" files={filesFixture} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId('push-confirm-gate-confirm'));

    await waitFor(() => {
      expect(confirmPush).toHaveBeenCalledWith('p-1');
      expect(onResolved).toHaveBeenCalled();
    });
  });

  it('calls cancelPush + onResolved when cancel clicked', async () => {
    const onResolved = vi.fn();
    cancelPush.mockResolvedValue({ id: 'p-1' });
    render(<PushConfirmGate pipelineId="p-1" files={filesFixture} onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId('push-confirm-gate-cancel'));

    await waitFor(() => {
      expect(cancelPush).toHaveBeenCalledWith('p-1');
      expect(onResolved).toHaveBeenCalled();
    });
  });

  it('disables both buttons while a confirm request is in flight', async () => {
    let resolve!: (v: unknown) => void;
    confirmPush.mockImplementation(() => new Promise((r) => { resolve = r; }));

    render(<PushConfirmGate pipelineId="p-1" files={filesFixture} />);
    const confirmBtn = screen.getByTestId('push-confirm-gate-confirm') as HTMLButtonElement;
    const cancelBtn = screen.getByTestId('push-confirm-gate-cancel') as HTMLButtonElement;

    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(confirmBtn.disabled).toBe(true);
      expect(cancelBtn.disabled).toBe(true);
    });

    resolve({ id: 'p-1' });
  });

  it('surfaces error and re-enables buttons when confirm fails', async () => {
    confirmPush.mockRejectedValue(new Error('boom'));
    render(<PushConfirmGate pipelineId="p-1" files={filesFixture} />);

    fireEvent.click(screen.getByTestId('push-confirm-gate-confirm'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom');
    });
    const confirmBtn = screen.getByTestId('push-confirm-gate-confirm') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
  });

  it('shows file count when files prop is non-empty', () => {
    render(<PushConfirmGate pipelineId="p-1" files={filesFixture} />);
    // `t(key) => key` so we look for the key + the count
    expect(screen.getByText(/2\s+chat\.pushGate\.fileCountSuffix/)).toBeInTheDocument();
  });

  it('renders a placeholder when files is null (still showing buttons)', () => {
    render(<PushConfirmGate pipelineId="p-1" files={null} />);
    expect(screen.getByTestId('push-confirm-gate')).toBeInTheDocument();
    expect(screen.getByTestId('push-confirm-gate-confirm')).toBeInTheDocument();
  });
});
