import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ChatSkeleton } from '../ChatSkeleton';

describe('ChatSkeleton', () => {
  it('renders without crashing', () => {
    const { container } = render(<ChatSkeleton />);
    expect(container.firstChild).toBeTruthy();
  });

  it('renders skeleton placeholder elements', () => {
    const { container } = render(<ChatSkeleton />);
    // Skeleton component renders with animate-pulse class
    const skeletons = container.querySelectorAll('[class*="animate-pulse"], [class*="bg-"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders agent message skeletons (2 groups)', () => {
    const { container } = render(<ChatSkeleton />);
    // 2 agent message groups with flex gap-2.5
    const agentGroups = container.querySelectorAll('.flex.gap-2\\.5');
    expect(agentGroups.length).toBe(2);
  });

  it('renders user message skeleton (right-aligned)', () => {
    const { container } = render(<ChatSkeleton />);
    const rightAligned = container.querySelectorAll('.flex.justify-end');
    expect(rightAligned.length).toBe(1);
  });

  it('has fade-in animation', () => {
    const { container } = render(<ChatSkeleton />);
    expect(container.firstChild).toHaveClass('animate-in');
  });
});
