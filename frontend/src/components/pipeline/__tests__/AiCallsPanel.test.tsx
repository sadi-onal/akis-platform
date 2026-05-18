import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { AiCallsPanel } from '../AiCallsPanel';
import type { AiCallEntry } from '../../../types/pipeline';

const mkCall = (overrides: Partial<AiCallEntry> = {}): AiCallEntry => ({
  id: 'c-1',
  callIndex: 0,
  provider: 'mock',
  model: 'mock-model',
  purpose: 'plan',
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  durationMs: 1200,
  success: true,
  errorCode: null,
  timestamp: new Date('2026-05-18T12:00:00Z').toISOString(),
  systemPrompt: 'You are AKIS, an AI assistant.',
  userPrompt: 'Build a TODO list app',
  responseText: '{"plan":"step-1"}',
  thinkingBlocks: null,
  toolCalls: null,
  ...overrides,
});

describe('AiCallsPanel — load states', () => {
  it('shows loading while fetching', () => {
    const fetcher = vi.fn(() => new Promise<AiCallEntry[]>(() => {})); // never resolves
    render(<AiCallsPanel pipelineId="p-1" fetcher={fetcher} />);
    expect(screen.getByTestId('ai-calls-loading')).toBeInTheDocument();
  });

  it('renders empty state when no calls', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    render(<AiCallsPanel pipelineId="p-1" fetcher={fetcher} />);
    expect(await screen.findByTestId('ai-calls-empty')).toBeInTheDocument();
    expect(screen.getByText(/kayıtlı AI çağrısı yok/)).toBeInTheDocument();
  });

  it('renders error state when fetch fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    render(<AiCallsPanel pipelineId="p-1" fetcher={fetcher} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });

  it('renders one card per entry with provider/model/purpose summary', async () => {
    const fetcher = vi.fn().mockResolvedValue([
      mkCall({ id: 'a', callIndex: 0, purpose: 'plan' }),
      mkCall({ id: 'b', callIndex: 1, purpose: 'execute' }),
      mkCall({ id: 'c', callIndex: 2, purpose: 'validate', success: false, errorCode: 'AI_TIMEOUT' }),
    ]);
    render(<AiCallsPanel pipelineId="p-1" fetcher={fetcher} />);
    const list = await screen.findByTestId('ai-calls-list');
    expect(list).toBeInTheDocument();
    const cards = list.querySelectorAll('article');
    expect(cards.length).toBe(3);
    // Index labels shift to 1-based for readability — #1, #2, #3.
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#3')).toBeInTheDocument();
    // Failed call surfaces error code.
    expect(screen.getByText(/AI_TIMEOUT/)).toBeInTheDocument();
  });
});

describe('AiCallsPanel — section expansion', () => {
  it('first card is open by default; clicking header toggles', async () => {
    const fetcher = vi.fn().mockResolvedValue([
      mkCall({ id: 'a', callIndex: 0 }),
      mkCall({ id: 'b', callIndex: 1 }),
    ]);
    render(<AiCallsPanel pipelineId="p-1" fetcher={fetcher} />);
    await screen.findByTestId('ai-calls-list');

    // Default-open content: "Kullanıcı sorusu" section is rendered with the
    // userPrompt visible for the first card.
    expect(screen.getAllByText('Kullanıcı sorusu').length).toBeGreaterThan(0);
    expect(screen.getByText('Build a TODO list app')).toBeInTheDocument();

    // Second card is collapsed — clicking its header opens it.
    const cards = screen.getAllByRole('button', { name: /AI çağrısı/ });
    fireEvent.click(cards[1]!); // second card
    await waitFor(() => {
      // Now two userPrompt sections visible.
      const matches = screen.getAllByText('Build a TODO list app');
      expect(matches.length).toBe(2);
    });
  });

  it('only shows sections that have content (no empty placeholders)', async () => {
    const fetcher = vi.fn().mockResolvedValue([
      mkCall({
        systemPrompt: 'sys',
        userPrompt: null,
        responseText: null,
        thinkingBlocks: null,
        toolCalls: null,
      }),
    ]);
    render(<AiCallsPanel pipelineId="p-1" fetcher={fetcher} />);
    await screen.findByTestId('ai-calls-list');
    expect(screen.getByText('Sistem talimatı')).toBeInTheDocument();
    expect(screen.queryByText('Kullanıcı sorusu')).toBeNull();
    expect(screen.queryByText('Cevap')).toBeNull();
  });

  it('renders thinking + tool blocks when present', async () => {
    const fetcher = vi.fn().mockResolvedValue([
      mkCall({
        thinkingBlocks: [{ type: 'thinking', text: 'reasoning step' }],
        toolCalls: [{ name: 'github_search', input: { q: 'tests' } }],
      }),
    ]);
    render(<AiCallsPanel pipelineId="p-1" fetcher={fetcher} />);
    await screen.findByTestId('ai-calls-list');
    expect(screen.getByText('Düşünce notları')).toBeInTheDocument();
    expect(screen.getByText('Araç çağrıları')).toBeInTheDocument();
  });

  it('shows "no content" hint for pre-P5a rows with all-null content', async () => {
    const fetcher = vi.fn().mockResolvedValue([
      mkCall({
        systemPrompt: null,
        userPrompt: null,
        responseText: null,
        thinkingBlocks: null,
        toolCalls: null,
      }),
    ]);
    render(<AiCallsPanel pipelineId="p-1" fetcher={fetcher} />);
    await screen.findByTestId('ai-calls-list');
    expect(screen.getByText(/içerik kaydı yok/)).toBeInTheDocument();
  });
});
