/**
 * AgentStartedLine — Claude-Code-style agent start/running/completed row.
 * Covers issue #390 / BUG-10 — visual contract only (no pipeline wiring).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentStartedLine } from '../AgentStartedLine';

// PR-A: AgentStartedLine now uses useI18n to translate the `task` i18n key.
// Stub returns the key verbatim so existing string-content assertions still match.
vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

describe('AgentStartedLine', () => {
  it('renders "Background agent started" + agent name by default', () => {
    render(<AgentStartedLine agent="scribe" />);
    expect(screen.getByText('Background agent started')).toBeInTheDocument();
    expect(screen.getByText('Scribe')).toBeInTheDocument();
  });

  it('renders "Background agent finished" when state is completed', () => {
    render(<AgentStartedLine agent="proto" state="completed" />);
    expect(screen.getByText('Background agent finished')).toBeInTheDocument();
    expect(screen.getByText('Proto')).toBeInTheDocument();
  });

  it('shows the task suffix after an em-dash when provided (i18n key passes through stub)', () => {
    render(<AgentStartedLine agent="trace" task="pipeline.activity.trace.writing_scenarios" />);
    expect(screen.getByText('Trace')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('pipeline.activity.trace.writing_scenarios')).toBeInTheDocument();
  });

  it('sets aria-live="polite" when state is running', () => {
    const { container } = render(<AgentStartedLine agent="scribe" state="running" />);
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  it('sets aria-live="off" when state is started (passive state)', () => {
    const { container } = render(<AgentStartedLine agent="scribe" state="started" />);
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('off');
  });

  it('renders the meta annotation in the gutter when provided', () => {
    render(<AgentStartedLine agent="proto" meta="2.4k tokens · 3.4s" />);
    expect(screen.getByText('2.4k tokens · 3.4s')).toBeInTheDocument();
  });

  it('applies agent-specific left-border color class', () => {
    const { container } = render(<AgentStartedLine agent="trace" />);
    const row = container.firstChild as HTMLElement;
    expect(row.className).toContain('border-purple-400/60');
  });

  it('adds a pulse animation when state=running', () => {
    const { container } = render(<AgentStartedLine agent="scribe" state="running" />);
    // The dot element is first child after the accent border — sibling index 0 inside row.
    const dot = container.querySelector('[aria-hidden]');
    expect(dot?.className).toContain('animate-pulse');
  });
});
