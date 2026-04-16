import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentFeatureCard } from '../AgentFeatureCard';

const icon = <svg data-testid="mock-icon" />;

describe('AgentFeatureCard', () => {
  it('renders title and description', () => {
    render(
      <AgentFeatureCard agent="scribe" title="Scribe" description="Writes specs" icon={icon} />,
    );
    expect(screen.getByText('Scribe')).toBeInTheDocument();
    expect(screen.getByText('Writes specs')).toBeInTheDocument();
  });

  it('renders the icon', () => {
    render(
      <AgentFeatureCard agent="proto" title="Proto" description="Builds code" icon={icon} />,
    );
    expect(screen.getByTestId('mock-icon')).toBeInTheDocument();
  });

  it('applies scribe agent styling', () => {
    const { container } = render(
      <AgentFeatureCard agent="scribe" title="Scribe" description="desc" icon={icon} />,
    );
    const el = container.querySelector('[class*="ak-scribe"]');
    expect(el).toBeTruthy();
  });

  it('applies proto agent styling', () => {
    const { container } = render(
      <AgentFeatureCard agent="proto" title="Proto" description="desc" icon={icon} />,
    );
    const el = container.querySelector('[class*="ak-proto"]');
    expect(el).toBeTruthy();
  });

  it('applies trace agent styling', () => {
    const { container } = render(
      <AgentFeatureCard agent="trace" title="Trace" description="desc" icon={icon} />,
    );
    const el = container.querySelector('[class*="ak-trace"]');
    expect(el).toBeTruthy();
  });

  it('applies animation delay when delay > 0', () => {
    const { container } = render(
      <AgentFeatureCard agent="scribe" title="Scribe" description="desc" icon={icon} delay={200} />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.animationDelay).toBe('200ms');
  });

  it('does not set animation delay when delay is 0', () => {
    const { container } = render(
      <AgentFeatureCard agent="scribe" title="Scribe" description="desc" icon={icon} delay={0} />,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.animationDelay).toBe('');
  });
});
