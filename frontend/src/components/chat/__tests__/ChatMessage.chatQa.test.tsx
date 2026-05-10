/**
 * Tests for the chat_qa_response renderer in ChatMessage (F-09 / FR-10).
 *
 * Covers: streaming pill, citation chips, optional [BUILD] CTA, and the
 * "no-CTA when needsBuild=false" guard. The ChatRouter handles dispatch; this
 * suite verifies the user-facing render contract once a chat_qa_response is
 * already in the message list.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatMessage } from '../ChatMessage';
import type { ChatMessage as ChatMessageType } from '../../../types/chat';

function qa(partial: Partial<Extract<ChatMessageType, { type: 'chat_qa_response' }>> = {}): Extract<
  ChatMessageType,
  { type: 'chat_qa_response' }
> {
  return {
    type: 'chat_qa_response',
    content: 'Şu an projende **3 dosya** var.',
    timestamp: new Date('2026-05-09T12:00:00Z').toISOString(),
    ...partial,
  };
}

describe('ChatMessage — chat_qa_response', () => {
  it('renders the answer content + heading', () => {
    render(<ChatMessage message={qa()} />);
    expect(screen.getByTestId('chat-qa-response')).toBeInTheDocument();
    expect(screen.getByTestId('chat-qa-content')).toHaveTextContent('3 dosya');
    expect(screen.getByText(/Sohbet yanıtı/)).toBeInTheDocument();
  });

  it('shows a "yazıyor…" pill when streaming', () => {
    render(<ChatMessage message={qa({ streaming: true })} />);
    expect(screen.getByTestId('chat-qa-streaming')).toHaveTextContent('yazıyor');
  });

  it('hides the streaming pill once streaming flips false', () => {
    render(<ChatMessage message={qa({ streaming: false })} />);
    expect(screen.queryByTestId('chat-qa-streaming')).toBeNull();
  });

  it('renders citation chips after streaming completes', () => {
    render(
      <ChatMessage
        message={qa({
          streaming: false,
          citations: [
            { source: 'spec', excerpt: 'Bakkal — Stok takibi', refKey: 'spec:Bakkal' },
            { source: 'proto', excerpt: '3 dosya: src/App.tsx, …', refKey: 'proto:files' },
          ],
        })}
      />,
    );
    const strip = screen.getByTestId('chat-qa-citations');
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveTextContent('Spec');
    expect(strip).toHaveTextContent('Kod');
    expect(strip).toHaveTextContent('spec:Bakkal');
  });

  it('hides citation strip while streaming (avoids flicker)', () => {
    render(
      <ChatMessage
        message={qa({
          streaming: true,
          citations: [{ source: 'spec', excerpt: 'x' }],
        })}
      />,
    );
    expect(screen.queryByTestId('chat-qa-citations')).toBeNull();
  });

  it('renders the [BUILD] CTA when needsBuild=true and fires onSuggestBuild', () => {
    const onSuggestBuild = vi.fn();
    render(
      <ChatMessage
        message={qa({
          streaming: false,
          needsBuild: true,
          sourceMessage: 'rapor sayfası ekle',
        })}
        onSuggestBuild={onSuggestBuild}
      />,
    );
    const cta = screen.getByTestId('chat-qa-build-cta');
    expect(cta).toHaveTextContent(/özellik olarak ekleyelim/i);
    fireEvent.click(cta);
    expect(onSuggestBuild).toHaveBeenCalledTimes(1);
    expect(onSuggestBuild).toHaveBeenCalledWith('rapor sayfası ekle');
  });

  it('does not render [BUILD] CTA when needsBuild=false', () => {
    render(
      <ChatMessage
        message={qa({ streaming: false, needsBuild: false, sourceMessage: 'kaç dosya?' })}
        onSuggestBuild={() => {}}
      />,
    );
    expect(screen.queryByTestId('chat-qa-build-cta')).toBeNull();
  });

  it('does not render [BUILD] CTA when streaming is still true', () => {
    render(
      <ChatMessage
        message={qa({
          streaming: true,
          needsBuild: true,
          sourceMessage: 'yapılır mı?',
        })}
        onSuggestBuild={() => {}}
      />,
    );
    expect(screen.queryByTestId('chat-qa-build-cta')).toBeNull();
  });

  it('does not render [BUILD] CTA when sourceMessage is missing', () => {
    render(
      <ChatMessage
        message={qa({
          streaming: false,
          needsBuild: true,
          // sourceMessage intentionally omitted
        })}
        onSuggestBuild={() => {}}
      />,
    );
    expect(screen.queryByTestId('chat-qa-build-cta')).toBeNull();
  });
});
