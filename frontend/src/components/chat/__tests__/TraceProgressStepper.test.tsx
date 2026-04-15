import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TraceProgressStepper } from '../TraceProgressStepper';
import type { PipelineActivity } from '../../../hooks/usePipelineStream';

// ─── Helpers ──────────────────────────────────────

const NOW = new Date().toISOString();
const EARLIER = new Date(Date.now() - 5000).toISOString();
const EVEN_EARLIER = new Date(Date.now() - 10000).toISOString();

function makeActivity(step: string, timestamp = NOW, extra?: Partial<PipelineActivity>): PipelineActivity {
  return {
    stage: 'trace',
    step,
    message: `Step: ${step}`,
    timestamp,
    ...extra,
  };
}

// ─── Tests ────────────────────────────────────────

describe('TraceProgressStepper', () => {
  it('renders the component title', () => {
    render(<TraceProgressStepper activities={[]} currentStep={null} />);
    expect(screen.getByText('Trace İlerlemesi')).toBeInTheDocument();
  });

  it('renders all 4 step labels', () => {
    render(<TraceProgressStepper activities={[]} currentStep={null} />);
    expect(screen.getByText('Kaynak dosyalar okunuyor')).toBeInTheDocument();
    expect(screen.getByText('Test stratejisi belirleniyor')).toBeInTheDocument();
    expect(screen.getByText('Playwright testleri oluşturuluyor')).toBeInTheDocument();
    expect(screen.getByText('Testler doğrulanıyor')).toBeInTheDocument();
  });

  it('shows all steps as pending when no activities', () => {
    const { container } = render(
      <TraceProgressStepper activities={[]} currentStep={null} />,
    );
    const listItems = container.querySelectorAll('li');
    expect(listItems.length).toBe(4);
  });

  it('highlights current step', () => {
    const activities = [makeActivity('fetching', EVEN_EARLIER)];
    const currentStep = makeActivity('fetching');

    render(
      <TraceProgressStepper activities={activities} currentStep={currentStep} />,
    );
    const fetchingLabel = screen.getByText('Kaynak dosyalar okunuyor');
    expect(fetchingLabel.className).toContain('font-medium');
  });

  it('shows completed steps with done styling', () => {
    const activities = [
      makeActivity('fetching', EVEN_EARLIER),
      makeActivity('analyzing', EARLIER),
    ];
    const currentStep = makeActivity('analyzing');

    render(
      <TraceProgressStepper activities={activities} currentStep={currentStep} />,
    );
    // First step (fetching) should be done since analyzing has started
    const fetchingLabel = screen.getByText('Kaynak dosyalar okunuyor');
    expect(fetchingLabel.className).toContain('text-ak-text-secondary');
  });

  it('shows retry count badge', () => {
    const activities = [makeActivity('fetching')];
    const currentStep = makeActivity('fetching', NOW, { retryCount: 2 });

    render(
      <TraceProgressStepper activities={activities} currentStep={currentStep} />,
    );
    expect(screen.getByText(/Yeniden deneniyor \(2\/3\)/)).toBeInTheDocument();
  });

  it('does not show retry badge when retryCount is 0', () => {
    const activities = [makeActivity('fetching')];
    const currentStep = makeActivity('fetching', NOW, { retryCount: 0 });

    render(
      <TraceProgressStepper activities={activities} currentStep={currentStep} />,
    );
    expect(screen.queryByText(/Yeniden deneniyor/)).not.toBeInTheDocument();
  });

  it('does not show retry badge when complete', () => {
    const activities = [
      makeActivity('fetching', EVEN_EARLIER),
      makeActivity('analyzing', EARLIER),
      makeActivity('ai_call', EARLIER),
      makeActivity('complete', NOW),
    ];
    const currentStep = makeActivity('complete', NOW, { retryCount: 1 });

    render(
      <TraceProgressStepper activities={activities} currentStep={currentStep} />,
    );
    expect(screen.queryByText(/Yeniden deneniyor/)).not.toBeInTheDocument();
  });

  it('shows elapsed time for started steps', () => {
    const activities = [makeActivity('fetching', EVEN_EARLIER)];
    const currentStep = makeActivity('fetching');

    render(
      <TraceProgressStepper activities={activities} currentStep={currentStep} />,
    );
    // Should show some elapsed time (at least "0s" or more)
    const timeElements = screen.getAllByText(/\d+s|\d+dk/);
    expect(timeElements.length).toBeGreaterThanOrEqual(1);
  });

  it('renders complete state correctly', () => {
    const activities = [
      makeActivity('fetching', EVEN_EARLIER),
      makeActivity('analyzing', EARLIER),
      makeActivity('ai_call', EARLIER),
      makeActivity('traceability', NOW),
      makeActivity('complete', NOW),
    ];
    const currentStep = makeActivity('complete');

    const { container } = render(
      <TraceProgressStepper activities={activities} currentStep={currentStep} />,
    );
    // All 4 steps should be rendered
    const listItems = container.querySelectorAll('li');
    expect(listItems.length).toBe(4);
  });
});
