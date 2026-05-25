/**
 * T1 — PushGateFooter component test.
 *
 * Covers:
 *   - Renders two action buttons (confirm + cancel).
 *   - Confirm click hits `workflowsApi.confirmPush(pipelineId)` and fires
 *     the `onResolved('confirm')` callback.
 *   - Cancel click hits `workflowsApi.cancelPush(pipelineId)` and fires
 *     the `onResolved('cancel')` callback.
 *   - Confirm failure surfaces an alert region with the error message.
 *   - Both buttons disable while a request is in flight.
 *
 * The i18n provider is mocked the same way the legacy `PushConfirmGate`
 * test does — bypassing the async catalog load gate so assertions stay
 * synchronous and locale-independent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { PushGateFooter } from '../PushGateFooter';

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

const confirmPush = vi.fn();
const cancelPush = vi.fn();

vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    confirmPush: (id: string) => confirmPush(id),
    cancelPush: (id: string) => cancelPush(id),
  },
}));

describe('PushGateFooter', () => {
  beforeEach(() => {
    confirmPush.mockReset();
    cancelPush.mockReset();
  });

  it('renders two action buttons', () => {
    render(<PushGateFooter pipelineId="p-1" />);
    expect(screen.getByTestId('push-gate-footer')).toBeInTheDocument();
    expect(screen.getByTestId('push-gate-footer-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('push-gate-footer-cancel')).toBeInTheDocument();
  });

  it('calls workflowsApi.confirmPush on confirm click and invokes onResolved("confirm")', async () => {
    const onResolved = vi.fn();
    confirmPush.mockResolvedValue({ id: 'p-1' });
    render(<PushGateFooter pipelineId="p-1" onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId('push-gate-footer-confirm'));

    await waitFor(() => {
      expect(confirmPush).toHaveBeenCalledWith('p-1');
    });
    expect(onResolved).toHaveBeenCalledWith('confirm');
    expect(cancelPush).not.toHaveBeenCalled();
  });

  it('calls workflowsApi.cancelPush on cancel click and invokes onResolved("cancel")', async () => {
    const onResolved = vi.fn();
    cancelPush.mockResolvedValue({ id: 'p-1' });
    render(<PushGateFooter pipelineId="p-1" onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId('push-gate-footer-cancel'));

    await waitFor(() => {
      expect(cancelPush).toHaveBeenCalledWith('p-1');
    });
    expect(onResolved).toHaveBeenCalledWith('cancel');
    expect(confirmPush).not.toHaveBeenCalled();
  });

  it('shows an error alert when confirm fails', async () => {
    confirmPush.mockRejectedValue(new Error('boom'));
    render(<PushGateFooter pipelineId="p-1" />);

    fireEvent.click(screen.getByTestId('push-gate-footer-confirm'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom');
    });
    // Re-enabled so the user can retry.
    expect(screen.getByTestId('push-gate-footer-confirm')).not.toBeDisabled();
    expect(screen.getByTestId('push-gate-footer-cancel')).not.toBeDisabled();
  });

  it('disables both buttons while a confirm request is in flight', async () => {
    let resolveConfirm: (value: { id: string }) => void = () => {};
    confirmPush.mockImplementation(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    render(<PushGateFooter pipelineId="p-1" />);
    const confirm = screen.getByTestId('push-gate-footer-confirm');
    const cancel = screen.getByTestId('push-gate-footer-cancel');

    fireEvent.click(confirm);

    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    expect(cancel).toBeDisabled();

    resolveConfirm({ id: 'p-1' });
  });

  // #637 — stage conflict: show friendly message + call onResolved
  it('shows friendly message and calls onResolved on INVALID_STAGE confirm error', async () => {
    const stageErr = Object.assign(
      new Error('Invalid stage: expected awaiting_push_confirm, got proto_building'),
      { code: 'INVALID_STAGE', statusCode: 400 },
    );
    confirmPush.mockRejectedValue(stageErr);
    const onResolved = vi.fn();
    render(<PushGateFooter pipelineId="p-1" onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId('push-gate-footer-confirm'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('chat.stageConflict');
      expect(onResolved).toHaveBeenCalledWith('confirm');
    });
  });

  it('shows friendly message and calls onResolved on INVALID_STAGE cancel error', async () => {
    const stageErr = Object.assign(
      new Error('Invalid stage: expected awaiting_push_confirm, got proto_building'),
      { code: 'INVALID_STAGE', statusCode: 400 },
    );
    cancelPush.mockRejectedValue(stageErr);
    const onResolved = vi.fn();
    render(<PushGateFooter pipelineId="p-1" onResolved={onResolved} />);

    fireEvent.click(screen.getByTestId('push-gate-footer-cancel'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('chat.stageConflict');
      expect(onResolved).toHaveBeenCalledWith('cancel');
    });
  });
});
