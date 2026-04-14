import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<ChatInput onSend={vi.fn()} onCancel={onCancel} showCancel />);
    fireEvent.click(screen.getByRole('button', { name: 'İptal et' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('textarea has cursor-not-allowed class when disabled', () => {
    render(<ChatInput onSend={vi.fn()} disabled />);
    const textarea = screen.getByRole('textbox');
    expect(textarea.className).toContain('cursor-not-allowed');
  });

  // ─── Keyboard hint text ────────────────────────────────────────────────────

  it('renders keyboard hint labels (Gonder, Yeni satir, Temizle)', () => {
    render(<ChatInput onSend={vi.fn()} />);
    expect(screen.getByText('Gonder')).toBeInTheDocument();
    expect(screen.getByText('Yeni satir')).toBeInTheDocument();
    expect(screen.getByText('Temizle')).toBeInTheDocument();
  });

  it('renders keyboard shortcut symbols in hints', () => {
    const { container } = render(<ChatInput onSend={vi.fn()} />);
    const kbds = container.querySelectorAll('kbd');
    // Expect 3 kbd elements: Enter, Shift+Enter, Esc
    expect(kbds.length).toBe(3);
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
});
