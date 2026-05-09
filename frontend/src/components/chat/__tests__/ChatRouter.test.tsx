import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatRouter } from '../ChatRouter';
import type { IntentClassification } from '../../../services/api/chatIntent';

/**
 * Tests for ChatRouter (FR-11.1..FR-11.4).
 *
 * The router is headless: it consumes a `classify` API result and dispatches
 * to onBuild/onAsk/onFeedback/onChat. We stub the API via the `api` prop so
 * tests don't touch fetch / MSW.
 */

function classification(
  partial: Partial<IntentClassification> & Pick<IntentClassification, 'intent' | 'confidence'>,
): IntentClassification {
  return {
    threshold: 0.7,
    reasoning: 'test',
    classificationId: '1',
    ...partial,
  };
}

interface Renderable {
  classify: ReturnType<typeof vi.fn>;
  override: ReturnType<typeof vi.fn>;
  onBuild: ReturnType<typeof vi.fn>;
  onAsk: ReturnType<typeof vi.fn>;
  onFeedback: ReturnType<typeof vi.fn>;
  onChat: ReturnType<typeof vi.fn>;
}

function setup(returnedClassification: IntentClassification): Renderable {
  const classify = vi.fn().mockResolvedValue(returnedClassification);
  const override = vi.fn().mockResolvedValue(undefined);
  const onBuild = vi.fn();
  const onAsk = vi.fn();
  const onFeedback = vi.fn();
  const onChat = vi.fn();

  render(
    <ChatRouter
      onBuild={onBuild}
      onAsk={onAsk}
      onFeedback={onFeedback}
      onChat={onChat}
      api={{ classify, override }}
    >
      {({ send }) => (
        <button type="button" onClick={() => void send('test message')}>
          send
        </button>
      )}
    </ChatRouter>,
  );

  return { classify, override, onBuild, onAsk, onFeedback, onChat };
}

describe('ChatRouter', () => {
  it('routes high-confidence BUILD to onBuild without showing the modal', async () => {
    const t = setup(classification({ intent: 'BUILD', confidence: 0.95 }));
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(t.onBuild).toHaveBeenCalledTimes(1));
    expect(t.onBuild).toHaveBeenCalledWith('test message', undefined);
    expect(t.onAsk).not.toHaveBeenCalled();
    expect(t.onFeedback).not.toHaveBeenCalled();
    expect(t.onChat).not.toHaveBeenCalled();
    expect(screen.queryByTestId('intent-disambiguation-modal')).toBeNull();
  });

  it('routes high-confidence ASK to onAsk', async () => {
    const t = setup(classification({ intent: 'ASK', confidence: 0.85 }));
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(t.onAsk).toHaveBeenCalledTimes(1));
    expect(t.onAsk).toHaveBeenCalledWith('test message');
  });

  it('routes high-confidence FEEDBACK to onFeedback', async () => {
    const t = setup(classification({ intent: 'FEEDBACK', confidence: 0.81 }));
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(t.onFeedback).toHaveBeenCalledTimes(1));
  });

  it('routes high-confidence CHAT to onChat', async () => {
    const t = setup(classification({ intent: 'CHAT', confidence: 0.75 }));
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(t.onChat).toHaveBeenCalledTimes(1));
  });

  it('opens DisambiguationModal when confidence < threshold', async () => {
    const t = setup(classification({ intent: 'BUILD', confidence: 0.55 }));
    fireEvent.click(screen.getByText('send'));
    await waitFor(() =>
      expect(screen.getByTestId('intent-disambiguation-modal')).toBeInTheDocument(),
    );
    // Handlers should not have fired yet — we're awaiting the user's pick.
    expect(t.onBuild).not.toHaveBeenCalled();
    expect(t.onAsk).not.toHaveBeenCalled();
  });

  it('modal selection: PATCHes override + invokes the chosen handler', async () => {
    const t = setup(
      classification({
        intent: 'BUILD',
        confidence: 0.5,
        classificationId: '42',
      }),
    );
    fireEvent.click(screen.getByText('send'));
    await waitFor(() =>
      expect(screen.getByTestId('intent-disambiguation-modal')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId('intent-option-ASK'));
    await waitFor(() => expect(t.onAsk).toHaveBeenCalledTimes(1));
    expect(t.onAsk).toHaveBeenCalledWith('test message');
    expect(t.onBuild).not.toHaveBeenCalled();
    // override is best-effort; we shouldn't await it but it must have fired.
    expect(t.override).toHaveBeenCalledWith('42', 'ASK');
    // modal closes after selection
    expect(screen.queryByTestId('intent-disambiguation-modal')).toBeNull();
  });

  it('Vazgeç closes the modal without invoking any handler', async () => {
    const t = setup(classification({ intent: 'BUILD', confidence: 0.5 }));
    fireEvent.click(screen.getByText('send'));
    await waitFor(() =>
      expect(screen.getByTestId('intent-disambiguation-modal')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('intent-option-cancel'));
    expect(screen.queryByTestId('intent-disambiguation-modal')).toBeNull();
    expect(t.onBuild).not.toHaveBeenCalled();
    expect(t.onAsk).not.toHaveBeenCalled();
    expect(t.onFeedback).not.toHaveBeenCalled();
    expect(t.override).not.toHaveBeenCalled();
  });

  it('falls back to onBuild when classify throws', async () => {
    const classify = vi.fn().mockRejectedValue(new Error('network down'));
    const override = vi.fn();
    const onBuild = vi.fn();
    const onAsk = vi.fn();
    const onFeedback = vi.fn();
    const onChat = vi.fn();

    render(
      <ChatRouter
        onBuild={onBuild}
        onAsk={onAsk}
        onFeedback={onFeedback}
        onChat={onChat}
        api={{ classify, override }}
      >
        {({ send }) => (
          <button type="button" onClick={() => void send('test message')}>
            send
          </button>
        )}
      </ChatRouter>,
    );
    fireEvent.click(screen.getByText('send'));
    await waitFor(() => expect(onBuild).toHaveBeenCalledTimes(1));
  });

  it('skips empty messages without calling classify', async () => {
    const classify = vi.fn().mockResolvedValue(classification({ intent: 'BUILD', confidence: 0.95 }));
    const override = vi.fn();
    const onBuild = vi.fn();

    render(
      <ChatRouter
        onBuild={onBuild}
        onAsk={vi.fn()}
        onFeedback={vi.fn()}
        onChat={vi.fn()}
        api={{ classify, override }}
      >
        {({ send }) => (
          <button type="button" onClick={() => void send('   ')}>
            send
          </button>
        )}
      </ChatRouter>,
    );
    fireEvent.click(screen.getByText('send'));
    // Give microtasks a chance to flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(classify).not.toHaveBeenCalled();
    expect(onBuild).not.toHaveBeenCalled();
  });
});
