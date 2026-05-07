import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PipelineDetailRail } from '../PipelineDetailRail';
import type { PipelineActivity } from '../../../hooks/usePipelineStream';
import type { PipelineExplanation } from '../../../types/pipeline';

vi.mock('../../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

const mkExpl = (overrides: Partial<PipelineExplanation> = {}): PipelineExplanation => ({
  pipelineId: 'p-1',
  stages: [
    {
      agentName: 'scribe',
      timestamp: new Date().toISOString(),
      decision: 'Spec uretildi',
      reasoning: ['1 soru'],
      assumptions: [],
      confidence: { score: 90, factors: [] },
    },
  ],
  overallNarrative: 'Tamamlandı.',
  attentionPoints: [],
  ...overrides,
});

const mkActivity = (stage: PipelineActivity['stage'], progress = 50): PipelineActivity => ({
  pipelineId: 'p-1',
  stage,
  step: 'progress',
  message: 'çalışıyor',
  progress,
  timestamp: new Date().toISOString(),
});

describe('PipelineDetailRail — render gating', () => {
  it('renders nothing when no pipelineId', () => {
    const { container } = render(
      <PipelineDetailRail
        pipelineId={undefined}
        uiState="idle"
        activities={[]}
        currentStep={null}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when pipelineId is 'pending'", () => {
    const { container } = render(
      <PipelineDetailRail pipelineId="pending" uiState="idle" activities={[]} currentStep={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when idle and no activities', () => {
    const { container } = render(
      <PipelineDetailRail pipelineId="p-1" uiState="idle" activities={[]} currentStep={null} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders when there are activities even in idle state', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('scribe')]}
        currentStep={mkActivity('scribe')}
      />
    );
    expect(screen.getByLabelText('Pipeline detayı')).toBeInTheDocument();
  });
});

describe('PipelineDetailRail — auto state', () => {
  it('auto-collapses when idle/completed', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="idle"
        activities={[mkActivity('scribe')]}
        currentStep={null}
      />
    );
    const region = screen.getByLabelText('Pipeline detayı');
    expect(region).toHaveAttribute('data-collapsed', 'true');
  });

  it('auto-expands while running with Akış tab active', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    const region = screen.getByLabelText('Pipeline detayı');
    expect(region).toHaveAttribute('data-collapsed', 'false');
    expect(region).toHaveAttribute('data-active-tab', 'flow');
  });

  it('auto-expands at awaiting_approval with Açıklama tab active', () => {
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="awaiting_approval"
        activities={[]}
        currentStep={null}
        explanationFetcher={fetcher}
      />
    );
    const region = screen.getByLabelText('Pipeline detayı');
    expect(region).toHaveAttribute('data-collapsed', 'false');
    expect(region).toHaveAttribute('data-active-tab', 'why');
  });
});

describe('PipelineDetailRail — interactions', () => {
  it('user can manually collapse an auto-expanded rail', () => {
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
      />
    );
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-collapsed', 'false');
    fireEvent.click(screen.getByText(/Pipeline detayı/));
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-collapsed', 'true');
  });

  it('user can manually switch tabs', async () => {
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        explanationFetcher={fetcher}
      />
    );
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-active-tab', 'flow');
    fireEvent.click(screen.getByRole('tab', { name: 'Açıklama' }));
    expect(screen.getByLabelText('Pipeline detayı')).toHaveAttribute('data-active-tab', 'why');
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('p-1'));
  });

  it('shows attention point count badge in header when present', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mkExpl({
        attentionPoints: [
          { severity: 'high', stage: 'critic', issue: 'XSS' },
          { severity: 'medium', stage: 'scribe', issue: 'belirsiz' },
        ],
      })
    );
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="awaiting_approval"
        activities={[]}
        currentStep={null}
        explanationFetcher={fetcher}
      />
    );
    expect(await screen.findByText(/2 dikkat noktası/)).toBeInTheDocument();
  });

  it('does not fetch explanation while in flow tab', async () => {
    const fetcher = vi.fn().mockResolvedValue(mkExpl());
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="proto_running"
        activities={[mkActivity('proto')]}
        currentStep={mkActivity('proto')}
        explanationFetcher={fetcher}
      />
    );
    // settle one microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renders fetcher error when explanation request fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Network down'));
    render(
      <PipelineDetailRail
        pipelineId="p-1"
        uiState="awaiting_approval"
        activities={[]}
        currentStep={null}
        explanationFetcher={fetcher}
      />
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
  });
});
