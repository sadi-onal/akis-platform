import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelPicker } from '../ModelPicker';
import { shortModelLabel } from '../../../utils/modelLabel';

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    listSupportedModels: vi.fn().mockResolvedValue({
      provider: 'anthropic',
      models: [
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku', provider: 'anthropic', recommended: true },
        { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai', recommended: false },
      ],
    }),
  },
}));

describe('ModelPicker — trigger', () => {
  it('renders auto label when value is undefined', () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    expect(screen.getByText('chat.model.auto')).toBeInTheDocument();
  });

  it('renders shortened model label when value is provided', () => {
    render(<ModelPicker value="claude-haiku-4-5-20251001" onSelect={vi.fn()} />);
    expect(screen.getByText('claude-haiku-4-5')).toBeInTheDocument();
  });

  it('renders the full ID for short Anthropic IDs (no slash handling after PR-A)', () => {
    render(<ModelPicker value="claude-sonnet-4-6" onSelect={vi.fn()} />);
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
  });

  it('shows aria-expanded=false initially', () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'chat.model.ariaLabel' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('flips aria-expanded after click', () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'chat.model.ariaLabel' });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens the listbox after click', () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.model.ariaLabel' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('hides the listbox again after a second click', () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'chat.model.ariaLabel' });
    fireEvent.click(btn);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes the listbox when Escape is pressed', () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.model.ariaLabel' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('disables the trigger button when disabled prop is set', () => {
    render(<ModelPicker disabled onSelect={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'chat.model.ariaLabel' });
    expect(btn).toBeDisabled();
  });

  it('renders model option buttons after fetch resolves (issue #465 — no permanent loading state)', async () => {
    // Guards against the regression where `loading` in the useEffect dep array
    // caused a re-run/cleanup immediately after setLoading(true), permanently
    // cancelling the in-flight fetch and leaving the popover stuck on
    // "chat.model.loading" with zero <option> elements ever rendered.
    render(<ModelPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.model.ariaLabel' }));
    // findAllByRole internally polls until the query resolves or times out.
    // If `loading` never clears (the bug), this assertion will time out / fail.
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThanOrEqual(1);
  });
});

describe('shortModelLabel', () => {
  it('strips Anthropic date suffix', () => {
    expect(shortModelLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(shortModelLabel('claude-sonnet-4-20250514')).toBe('claude-sonnet-4');
  });

  it('leaves plain OpenAI IDs untouched', () => {
    expect(shortModelLabel('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(shortModelLabel('gpt-4.1')).toBe('gpt-4.1');
  });

  it('leaves Anthropic short-version IDs untouched (PR-A: no org/model slash handling)', () => {
    expect(shortModelLabel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(shortModelLabel('claude-opus-4-7')).toBe('claude-opus-4-7');
  });
});
