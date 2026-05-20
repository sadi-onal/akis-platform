import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock with our actual trajectory templates so the test asserts on the
// rendered Turkish text, not on un-interpolated keys.
const TEMPLATES: Record<string, string> = {
  'pipeline.iteration.trajectory.title': 'İterasyon geçmişi',
  'pipeline.iteration.trajectory.iterRow': 'İter {n}: Proto %{p} · Critic %{c}',
  'pipeline.iteration.trajectory.iterRowNoProto': 'İter {n}: Critic %{c}',
  'pipeline.iteration.trajectory.approved': 'onaylandı',
  'pipeline.iteration.trajectory.rejected': 'reddedildi',
  'pipeline.iteration.trajectory.blocked': 'engellendi',
  'pipeline.iteration.trajectory.findings': '{n} bulgu ({k} kritik)',
};

vi.mock('../../../i18n/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, args?: Record<string, string | number>) => {
      const template = TEMPLATES[key] ?? key;
      if (!args) return template;
      return Object.entries(args).reduce(
        (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
        template
      );
    },
    locale: 'tr',
    availableLocales: ['tr', 'en'],
    status: 'ready',
    setLocale: vi.fn(),
  }),
}));

import { IterationTrajectory } from '../IterationTrajectory';
import type { IterationTrajectory as Trajectory } from '../../../types/pipeline';

const traj = (entries: Trajectory['entries']): Trajectory => ({
  entries,
  criticScoreDelta:
    entries.length >= 2 &&
    typeof entries[0]!.criticScore === 'number' &&
    typeof entries[entries.length - 1]!.criticScore === 'number'
      ? entries[entries.length - 1]!.criticScore! - entries[0]!.criticScore!
      : null,
  finalDecision: entries[entries.length - 1]?.decision ?? null,
});

describe('IterationTrajectory — render gating', () => {
  it('renders nothing when trajectory is undefined', () => {
    const { container } = render(<IterationTrajectory trajectory={undefined} variant="full" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when trajectory has zero entries', () => {
    const { container } = render(
      <IterationTrajectory
        trajectory={{ entries: [], criticScoreDelta: null, finalDecision: null }}
        variant="full"
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('IterationTrajectory — full variant', () => {
  it('renders one row per iteration with Proto + Critic scores and decision', () => {
    render(
      <IterationTrajectory
        variant="full"
        trajectory={traj([
          {
            iteration: 1,
            protoConfidence: 0.62,
            criticScore: 52,
            criticFindingsCount: 8,
            criticCriticalCount: 3,
            timestamp: '2026-05-20T12:00:00.000Z',
            decision: 'rejected',
          },
          {
            iteration: 2,
            protoConfidence: 0.78,
            criticScore: 67,
            criticFindingsCount: 5,
            criticCriticalCount: 1,
            timestamp: '2026-05-20T12:05:00.000Z',
            decision: 'rejected',
          },
          {
            iteration: 3,
            protoConfidence: 0.91,
            criticScore: 84,
            criticFindingsCount: 2,
            criticCriticalCount: 0,
            timestamp: '2026-05-20T12:10:00.000Z',
            decision: 'approved',
          },
        ])}
      />
    );
    expect(screen.getByTestId('iteration-trajectory-row-1')).toHaveTextContent(
      /Proto %62.*Critic %52/
    );
    expect(screen.getByTestId('iteration-trajectory-row-2')).toHaveTextContent(
      /Proto %78.*Critic %67/
    );
    expect(screen.getByTestId('iteration-trajectory-row-3')).toHaveTextContent(
      /Proto %91.*Critic %84/
    );
    expect(screen.getByTestId('iteration-trajectory-row-3')).toHaveTextContent(/onaylandı/);
  });

  it('falls back to the no-proto row template when protoConfidence is null', () => {
    render(
      <IterationTrajectory
        variant="full"
        trajectory={traj([
          {
            iteration: 1,
            protoConfidence: null,
            criticScore: 70,
            criticFindingsCount: 1,
            criticCriticalCount: 0,
            timestamp: '2026-05-20T12:00:00.000Z',
            decision: 'approved',
          },
        ])}
      />
    );
    expect(screen.getByTestId('iteration-trajectory-row-1')).toHaveTextContent(/Critic %70/);
    expect(screen.getByTestId('iteration-trajectory-row-1').textContent).not.toMatch(/Proto/);
  });

  it('marks the final entry as blocked when the loop hit max retries', () => {
    render(
      <IterationTrajectory
        variant="full"
        trajectory={traj([
          {
            iteration: 1,
            protoConfidence: 0.5,
            criticScore: 40,
            criticFindingsCount: 10,
            criticCriticalCount: 4,
            timestamp: '2026-05-20T12:00:00.000Z',
            decision: 'rejected',
          },
          {
            iteration: 2,
            protoConfidence: 0.5,
            criticScore: 42,
            criticFindingsCount: 9,
            criticCriticalCount: 4,
            timestamp: '2026-05-20T12:02:00.000Z',
            decision: 'rejected',
          },
          {
            iteration: 3,
            protoConfidence: 0.5,
            criticScore: 41,
            criticFindingsCount: 9,
            criticCriticalCount: 4,
            timestamp: '2026-05-20T12:04:00.000Z',
            decision: 'blocked',
          },
        ])}
      />
    );
    expect(screen.getByTestId('iteration-trajectory-row-3')).toHaveTextContent(/engellendi/);
  });
});

describe('IterationTrajectory — compact variant', () => {
  it('renders critic scores separated by →', () => {
    render(
      <IterationTrajectory
        variant="compact"
        trajectory={traj([
          {
            iteration: 1,
            protoConfidence: 0.5,
            criticScore: 52,
            criticFindingsCount: 1,
            criticCriticalCount: 0,
            timestamp: '2026-05-20T12:00:00.000Z',
            decision: 'rejected',
          },
          {
            iteration: 2,
            protoConfidence: 0.6,
            criticScore: 67,
            criticFindingsCount: 1,
            criticCriticalCount: 0,
            timestamp: '2026-05-20T12:01:00.000Z',
            decision: 'approved',
          },
        ])}
      />
    );
    const el = screen.getByTestId('iteration-trajectory-compact');
    expect(el).toHaveTextContent(/52/);
    expect(el).toHaveTextContent(/67/);
    expect(el).toHaveTextContent(/→/);
  });
});
