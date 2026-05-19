import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// PR-V7: ChatInput now renders ModelPicker as a chip when onModelChange is
// provided. ModelPicker pulls translations via useI18n and fetches model lists
// over the network — mock both so the chip is visible without an I18nProvider
// or a real API.
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
    listSupportedModels: vi.fn(() => Promise.resolve({ provider: 'anthropic', models: [] })),
  },
}));

import { ChatInput } from '../ChatInput';

describe('ChatInput', () => {
  it('renders with default placeholder', () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByPlaceholderText('Projenizi anlatın...')).toBeInTheDocument();
  });

  it('renders with custom placeholder', () => {
    render(<ChatInput onSend={vi.fn()} placeholder="Type your idea..." />);
    expect(screen.getByPlaceholderText('Type your idea...')).toBeInTheDocument();
  });

  it('send button is disabled when input is empty', () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Gönder' })).toBeDisabled();
  });

  it('send button is enabled when text is entered', () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Hello world' } });
    expect(screen.getByRole('button', { name: 'Gönder' })).not.toBeDisabled();
  });

  it('calls onSend with trimmed text on button click', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '  my idea  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gönder' }));
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith('my idea');
  });

  it('calls onSend on Enter key', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'test message' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith('test message');
  });

  it('Shift+Enter does NOT trigger send', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'multiline text' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('clears input after send', () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'some text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gönder' }));
    expect(textarea).toHaveValue('');
  });

  it('shows cancel button when showCancel=true', () => {
    render(<ChatInput onSend={vi.fn()} showCancel />);
    expect(screen.getByRole('button', { name: 'İptal et' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gönder' })).not.toBeInTheDocument();
  });

  it('calls onCancel when cancel button is clicked AND user confirms', () => {
    const onCancel = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ChatInput onSend={vi.fn()} onCancel={onCancel} showCancel />);
    fireEvent.click(screen.getByRole('button', { name: 'İptal et' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    confirmSpy.mockRestore();
  });

  it('does NOT call onCancel when user cancels the confirm dialog', () => {
    const onCancel = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<ChatInput onSend={vi.fn()} onCancel={onCancel} showCancel />);
    fireEvent.click(screen.getByRole('button', { name: 'İptal et' }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('textarea has cursor-not-allowed class when disabled', () => {
    render(<ChatInput onSend={vi.fn()} disabled />);
    const textarea = screen.getByRole('textbox');
    expect(textarea.className).toContain('cursor-not-allowed');
  });

  // ─── Keyboard hint text (single helper row, no <kbd>) ─────────────────────

  it('renders keyboard helper row (Gönder, Yeni satır, Temizle)', () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByText(/⏎ Gönder.*⇧⏎ Yeni satır.*Esc Temizle/s)).toBeInTheDocument();
  });

  // ─── Escape key clears input ──────────────────────────────────────────────

  it('Escape key clears the input text', () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'some draft text' } });
    expect(textarea).toHaveValue('some draft text');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(textarea).toHaveValue('');
  });

  it('Escape key does not trigger send', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'test message' } });
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onSend).not.toHaveBeenCalled();
  });

  // ─── Enter with empty input does not send ─────────────────────────────────

  it('Enter on empty input does not trigger send', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  // ─── In-flight guard (T3) ────────────────────────────────────────────────

  it('fires onSend once when Enter is pressed twice within 300ms', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'rapid message' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    // Second Enter lands within 400ms debounce window (ardışık sync çağrılar <1ms)
    fireEvent.change(textarea, { target: { value: 'rapid message' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('disables input and marks send button aria-busy when isSending', () => {
    const onSend = vi.fn();
    const { rerender } = render(<ChatInput onSend={onSend} />);
    const textarea = screen.getByRole('textbox');
    // Put text in first (textarea is enabled), then flip isSending=true via rerender
    fireEvent.change(textarea, { target: { value: 'queued message' } });
    rerender(<ChatInput onSend={onSend} isSending />);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
    const sendBtn = screen.getByRole('button', { name: 'Gönder' });
    expect(sendBtn).toBeDisabled();
    expect(sendBtn).toHaveAttribute('aria-busy', 'true');
    expect(textarea).toBeDisabled();
  });

  // ─── Expand toggle (T1) ──────────────────────────────────────────────────

  it('clicking expand toggle flips the data-expanded attribute and aria label', () => {
    const { container } = render(<ChatInput onSend={vi.fn()} />);
    const wrapper = container.querySelector('[data-expanded]') as HTMLElement;
    expect(wrapper.dataset.expanded).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Büyük yaz' }));
    expect(wrapper.dataset.expanded).toBe('true');
    expect(screen.getByRole('button', { name: 'Küçült' })).toBeInTheDocument();
  });

  it('returns to collapsed mode after a successful send', () => {
    const onSend = vi.fn();
    const { container } = render(<ChatInput onSend={onSend} />);
    const wrapper = container.querySelector('[data-expanded]') as HTMLElement;

    fireEvent.click(screen.getByRole('button', { name: 'Büyük yaz' }));
    expect(wrapper.dataset.expanded).toBe('true');

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'my long idea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gönder' }));

    expect(onSend).toHaveBeenCalledOnce();
    expect(wrapper.dataset.expanded).toBe('false');
    expect(screen.getByRole('button', { name: 'Büyük yaz' })).toBeInTheDocument();
  });

  it('textarea max-height inline style grows when expanded', () => {
    render(<ChatInput onSend={vi.fn()} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    const collapsedMax = parseFloat(textarea.style.maxHeight);
    expect(collapsedMax).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Büyük yaz' }));
    const expandedMax = parseFloat(textarea.style.maxHeight);
    expect(expandedMax).toBeGreaterThan(collapsedMax);
  });

  // ─── PR-V7: Trace + Model chips inside composer ───────────────────────────

  describe('PR-V7 chip cluster', () => {
    it('renders trace chip when onTraceToggle is provided', () => {
      render(<ChatInput onSend={vi.fn()} onTraceToggle={vi.fn()} traceEnabled={false} />);
      expect(screen.getByTestId('trace-toggle')).toBeInTheDocument();
      expect(screen.getByTestId('trace-toggle-label').textContent).toMatch(/Trace kapalı/);
    });

    it('does NOT render trace chip when onTraceToggle is undefined', () => {
      render(<ChatInput onSend={vi.fn()} />);
      expect(screen.queryByTestId('trace-toggle')).not.toBeInTheDocument();
    });

    it('trace chip reflects aria-checked=true when traceEnabled is true', () => {
      render(<ChatInput onSend={vi.fn()} onTraceToggle={vi.fn()} traceEnabled={true} />);
      const chip = screen.getByTestId('trace-toggle');
      expect(chip).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('trace-toggle-label').textContent).toMatch(
        /Trace açık — testler üretilecek/
      );
    });

    it('trace chip click flips the value via onTraceToggle', () => {
      const onTraceToggle = vi.fn();
      render(<ChatInput onSend={vi.fn()} onTraceToggle={onTraceToggle} traceEnabled={true} />);
      fireEvent.click(screen.getByTestId('trace-toggle'));
      expect(onTraceToggle).toHaveBeenCalledWith(false);
    });

    it('renders ModelPicker chip when onModelChange is provided', () => {
      render(<ChatInput onSend={vi.fn()} onModelChange={vi.fn()} />);
      // ModelPicker renders an accessible "model" button via its aria-label
      // (chat.model.ariaLabel). Just assert that some button beyond the
      // default Gönder / Büyük yaz exists by checking the picker's chevron.
      expect(screen.getByRole('button', { name: /chat\.model\.ariaLabel/i })).toBeInTheDocument();
    });

    it('does NOT render ModelPicker chip when onModelChange is undefined', () => {
      render(<ChatInput onSend={vi.fn()} />);
      expect(
        screen.queryByRole('button', { name: /chat\.model\.ariaLabel/i })
      ).not.toBeInTheDocument();
    });
  });
});
