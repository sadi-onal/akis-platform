import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// P12: dropdown now fetches all three providers in parallel; the mock returns
// a different payload per provider so the grouped-render assertions are real.
vi.mock('../../../services/api/workflows', () => ({
  workflowsApi: {
    listSupportedModels: vi.fn((provider?: 'anthropic' | 'openai' | 'google') => {
      if (provider === 'openai') {
        return Promise.resolve({
          provider: 'openai',
          models: [
            { id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai', recommended: false },
            { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', recommended: true },
          ],
        });
      }
      if (provider === 'google') {
        return Promise.resolve({
          provider: 'google',
          models: [
            { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'google', recommended: true },
          ],
        });
      }
      // Default + 'anthropic'
      return Promise.resolve({
        provider: 'anthropic',
        models: [
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku', provider: 'anthropic', recommended: true },
        ],
      });
    }),
  },
}));

import { workflowsApi } from '../../../services/api/workflows';

beforeEach(() => {
  vi.mocked(workflowsApi.listSupportedModels).mockClear();
});

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

// P12: dropdown now lists every provider — not just one. These specs guard
// the parallel fetch + grouped render so future "single provider only"
// regressions get caught early.
describe('ModelPicker — multi-provider dropdown (P12)', () => {
  it('fetches all three providers in parallel when opened', async () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.model.ariaLabel' }));
    // Wait for options to appear so the parallel fetch has actually fired.
    await screen.findAllByRole('option');
    const mock = vi.mocked(workflowsApi.listSupportedModels);
    const providers = mock.mock.calls.map((c) => c[0]);
    expect(providers).toEqual(expect.arrayContaining(['anthropic', 'openai', 'google']));
    expect(providers).toHaveLength(3);
  });

  it('renders one model option per fetched model across providers (merged list)', async () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.model.ariaLabel' }));
    const options = await screen.findAllByRole('option');
    // Mock returns 1 anthropic + 2 openai + 1 google = 4 total
    expect(options).toHaveLength(4);
    expect(screen.getByText('claude-haiku-4-5-20251001')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText('gemini-1.5-flash')).toBeInTheDocument();
  });

  it('renders a provider-group header for each non-empty provider', async () => {
    render(<ModelPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.model.ariaLabel' }));
    await screen.findAllByRole('option');
    // Group headers — rendered as plain text labels above the option buttons.
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Google')).toBeInTheDocument();
  });

  it('still resolves when one provider fetch rejects (graceful degrade)', async () => {
    const mock = vi.mocked(workflowsApi.listSupportedModels);
    mock.mockReset();
    mock.mockImplementation((provider?: 'anthropic' | 'openai' | 'google') => {
      if (provider === 'google') return Promise.reject(new Error('boom'));
      return Promise.resolve({
        provider: provider ?? 'anthropic',
        models: [
          { id: `${provider}-model`, name: 'M', provider: provider ?? 'anthropic', recommended: false },
        ],
      });
    });
    render(<ModelPicker onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.model.ariaLabel' }));
    // The 2 successful provider fetches still produce options; the google
    // rejection is swallowed by the per-provider .catch().
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(2);
    });
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
