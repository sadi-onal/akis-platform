import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Pagination } from '../Pagination';

describe('Pagination', () => {
  it('renders nothing when nextCursor is null', () => {
    const { container } = render(
      <Pagination nextCursor={null} onNext={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the "Daha fazla" button when nextCursor is set', () => {
    render(<Pagination nextCursor="abc123" onNext={() => {}} />);
    expect(screen.getByRole('button', { name: 'Daha fazla' })).toBeInTheDocument();
  });

  it('calls onNext when button is clicked', () => {
    const handleNext = vi.fn();
    render(<Pagination nextCursor="abc123" onNext={handleNext} />);
    fireEvent.click(screen.getByRole('button'));
    expect(handleNext).toHaveBeenCalledOnce();
  });

  it('shows "Yükleniyor…" text when isLoading is true', () => {
    render(<Pagination nextCursor="abc123" onNext={() => {}} isLoading />);
    expect(screen.getByText('Yükleniyor…')).toBeInTheDocument();
  });

  it('disables button when isLoading is true', () => {
    render(<Pagination nextCursor="abc123" onNext={() => {}} isLoading />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
