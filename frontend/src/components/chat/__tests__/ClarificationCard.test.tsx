import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClarificationCard, type ClarificationQuestion } from '../ClarificationCard';

const Q: ClarificationQuestion[] = [
  {
    id: 'q1',
    question: 'Hangi platform?',
    reason: 'Stack seçimi için',
    suggestions: ['Web', 'Mobile', 'Desktop'],
  },
  {
    id: 'q2',
    question: 'Auth gerekli mi?',
    suggestions: ['Evet', 'Hayır'],
  },
  {
    id: 'q3',
    question: 'DB tercihi?',
  },
];

describe('ClarificationCard', () => {
  it('renders first question with counter', () => {
    render(<ClarificationCard questions={Q} onSubmit={() => {}} />);
    expect(screen.getByText('Soru 1/3')).toBeInTheDocument();
    expect(screen.getByText('Hangi platform?')).toBeInTheDocument();
    expect(screen.getByText('Stack seçimi için')).toBeInTheDocument();
  });

  it('renders suggestion chips for the first question', () => {
    render(<ClarificationCard questions={Q} onSubmit={() => {}} />);
    expect(screen.getByRole('button', { name: 'Web' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mobile' })).toBeInTheDocument();
  });

  it('navigates to next question with arrow button', () => {
    render(<ClarificationCard questions={Q} onSubmit={() => {}} />);
    fireEvent.click(screen.getByLabelText('Sonraki soru'));
    expect(screen.getByText('Soru 2/3')).toBeInTheDocument();
    expect(screen.getByText('Auth gerekli mi?')).toBeInTheDocument();
  });

  it('prev button disabled on first question', () => {
    render(<ClarificationCard questions={Q} onSubmit={() => {}} />);
    const prev = screen.getByLabelText('Önceki soru') as HTMLButtonElement;
    expect(prev).toBeDisabled();
  });

  it('selecting a suggestion updates answer count and does not submit', () => {
    const onSubmit = vi.fn();
    render(<ClarificationCard questions={Q} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Web' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/1\/3 cevaplandı/)).toBeInTheDocument();
  });

  it('clicking dots jumps to that question', () => {
    render(<ClarificationCard questions={Q} onSubmit={() => {}} />);
    const dots = screen.getAllByLabelText(/^Soru \d$/);
    fireEvent.click(dots[2]);
    expect(screen.getByText('Soru 3/3')).toBeInTheDocument();
    expect(screen.getByText('DB tercihi?')).toBeInTheDocument();
  });

  it('last question shows Gönder button and submits combined text', () => {
    const onSubmit = vi.fn();
    render(<ClarificationCard questions={Q} onSubmit={onSubmit} />);

    // Answer Q1
    fireEvent.click(screen.getByRole('button', { name: 'Web' }));
    // Move to Q2, answer
    fireEvent.click(screen.getByLabelText('Sonraki soru'));
    fireEvent.click(screen.getByRole('button', { name: 'Evet' }));
    // Move to Q3 (no suggestions), leave blank
    fireEvent.click(screen.getByLabelText('Sonraki soru'));

    const sendBtn = screen.getByRole('button', { name: /Gönder/ });
    fireEvent.click(sendBtn);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const combined = onSubmit.mock.calls[0][0] as string;
    expect(combined).toContain('Hangi platform?\n→ Web');
    expect(combined).toContain('Auth gerekli mi?\n→ Evet');
    expect(combined).toContain('DB tercihi?\n→ (cevap yok)');
  });

  it('custom input mode replaces chip selection', () => {
    render(<ClarificationCard questions={Q} onSubmit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Web' }));
    fireEvent.click(screen.getByRole('button', { name: /Kendi cevabım/ }));
    const textarea = screen.getByPlaceholderText(/Cevabınızı yazın/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'IoT cihazları' } });
    expect(textarea.value).toBe('IoT cihazları');
  });

  it('question without suggestions shows textarea by default', () => {
    render(<ClarificationCard questions={Q} onSubmit={() => {}} />);
    const dots = screen.getAllByLabelText(/^Soru \d$/);
    fireEvent.click(dots[2]);
    expect(screen.getByPlaceholderText(/Cevabınızı yazın/)).toBeInTheDocument();
  });

  it('counter updates live as the user selects answers across questions (F-07)', () => {
    const FOUR: ClarificationQuestion[] = [
      { id: 'a', question: 'Q1?', suggestions: ['A1', 'A2'] },
      { id: 'b', question: 'Q2?', suggestions: ['B1', 'B2'] },
      { id: 'c', question: 'Q3?', suggestions: ['C1', 'C2'] },
      { id: 'd', question: 'Q4?', suggestions: ['D1', 'D2'] },
    ];
    render(<ClarificationCard questions={FOUR} onSubmit={() => {}} />);

    // Baseline 0/4
    expect(screen.getByText(/0\/4 cevaplandı/)).toBeInTheDocument();

    // Click an answer on Q1 → 1/4 immediately (no Next press)
    fireEvent.click(screen.getByRole('button', { name: 'A1' }));
    expect(screen.getByText(/1\/4 cevaplandı/)).toBeInTheDocument();

    // Move to Q2, click an answer → 2/4 immediately
    fireEvent.click(screen.getByLabelText('Sonraki soru'));
    fireEvent.click(screen.getByRole('button', { name: 'B1' }));
    expect(screen.getByText(/2\/4 cevaplandı/)).toBeInTheDocument();

    // Go back to Q1 and re-select a different option → still 2/4 (re-select doesn't increment)
    fireEvent.click(screen.getByLabelText('Önceki soru'));
    fireEvent.click(screen.getByRole('button', { name: 'A2' }));
    expect(screen.getByText(/2\/4 cevaplandı/)).toBeInTheDocument();
  });

  it('answered question shows ✓ marker in its header (F-07)', () => {
    render(<ClarificationCard questions={Q} onSubmit={() => {}} />);

    // No marker yet
    expect(screen.queryByLabelText('Bu soru cevaplandı')).not.toBeInTheDocument();

    // Answer Q1
    fireEvent.click(screen.getByRole('button', { name: 'Web' }));

    // Marker now visible while we're still on Q1
    expect(screen.getByText('Soru 1/3')).toBeInTheDocument();
    expect(screen.getByLabelText('Bu soru cevaplandı')).toBeInTheDocument();

    // Move to Q2 (unanswered) — marker disappears for the current header
    fireEvent.click(screen.getByLabelText('Sonraki soru'));
    expect(screen.getByText('Soru 2/3')).toBeInTheDocument();
    expect(screen.queryByLabelText('Bu soru cevaplandı')).not.toBeInTheDocument();
  });
});
