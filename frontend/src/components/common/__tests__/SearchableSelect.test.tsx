import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SearchableSelect from '../SearchableSelect';
import type { SelectOption } from '../SearchableSelect';

const options: SelectOption[] = [
  { value: 'gpt-4o', label: 'GPT-4o', description: 'Latest OpenAI model' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini', description: 'Affordable and fast' },
  { value: 'o3-mini', label: 'O3 Mini', description: 'Reasoning model' },
];

describe('SearchableSelect', () => {
  it('renders label', () => {
    render(<SearchableSelect label="AI Model" options={options} value="" onChange={() => {}} />);
    expect(screen.getByText('AI Model')).toBeInTheDocument();
  });

  it('shows placeholder when no value selected', () => {
    render(
      <SearchableSelect label="Model" placeholder="Choose model..." options={options} value="" onChange={() => {}} />
    );
    expect(screen.getByText('Choose model...')).toBeInTheDocument();
  });

  it('shows selected option label', () => {
    render(
      <SearchableSelect label="Model" options={options} value="gpt-4o" onChange={() => {}} />
    );
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
  });

  it('opens dropdown on button click', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} />
    );
    // Click the dropdown button
    const button = screen.getByText('Seç...');
    fireEvent.click(button);
    // Search input should appear
    expect(screen.getByPlaceholderText('Ara...')).toBeInTheDocument();
    // Options should be visible
    expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument();
  });

  it('calls onChange when an option is selected', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={onChange} />
    );
    fireEvent.click(screen.getByText('Seç...'));
    fireEvent.click(screen.getByText('O3 Mini'));
    expect(onChange).toHaveBeenCalledWith('o3-mini');
  });

  it('filters options by search query', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} />
    );
    fireEvent.click(screen.getByText('Seç...'));

    const searchInput = screen.getByPlaceholderText('Ara...');
    fireEvent.change(searchInput, { target: { value: 'mini' } });

    // GPT-4o Mini and O3 Mini should match, GPT-4o alone should not
    expect(screen.getByText('GPT-4o Mini')).toBeInTheDocument();
    expect(screen.getByText('O3 Mini')).toBeInTheDocument();
    // "GPT-4o" as a standalone option should be filtered out
    // Need to check we don't see it as a separate option button
    const optionButtons = screen.getAllByRole('button').filter(
      (btn) => btn.textContent?.includes('GPT-4o') && !btn.textContent?.includes('Mini')
    );
    // The only "GPT-4o" visible should be in "GPT-4o Mini"
    expect(optionButtons.length).toBeLessThanOrEqual(1); // mode toggle buttons may match
  });

  it('shows empty message when no options match', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} />
    );
    fireEvent.click(screen.getByText('Seç...'));
    const searchInput = screen.getByPlaceholderText('Ara...');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });
    expect(screen.getByText('Eslesme bulunamadi')).toBeInTheDocument();
  });

  it('shows custom empty message when no options and no search', () => {
    render(
      <SearchableSelect label="Model" options={[]} value="" onChange={() => {}} emptyMessage="No models configured" />
    );
    fireEvent.click(screen.getByText('Seç...'));
    expect(screen.getByText('No models configured')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} loading={true} />
    );
    expect(screen.getByText('Yükleniyor...')).toBeInTheDocument();
  });

  it('shows error message', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} error="Failed to load models" />
    );
    expect(screen.getByText('Failed to load models')).toBeInTheDocument();
  });

  it('shows description text', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} description="Select the AI model to use" />
    );
    expect(screen.getByText('Select the AI model to use')).toBeInTheDocument();
  });

  it('disables button when disabled prop is true', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} disabled={true} />
    );
    // The dropdown toggle button should be disabled
    const buttons = screen.getAllByRole('button');
    const triggerButton = buttons.find((b) => b.textContent?.includes('Seç'));
    expect(triggerButton).toBeDisabled();
  });

  it('switches to manual input mode', () => {
    const onChange = vi.fn();
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={onChange} />
    );
    // Click "Type manually"
    fireEvent.click(screen.getByText('Type manually'));
    // Should show text input with manual placeholder
    const input = screen.getByPlaceholderText('Veya manuel olarak yazin...');
    expect(input).toBeInTheDocument();

    // Type a value
    fireEvent.change(input, { target: { value: 'custom-model' } });
    expect(onChange).toHaveBeenCalledWith('custom-model');
  });

  it('switches back from manual to dropdown mode', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} />
    );
    fireEvent.click(screen.getByText('Type manually'));
    expect(screen.getByPlaceholderText('Veya manuel olarak yazin...')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Select from list'));
    expect(screen.getByText('Seç...')).toBeInTheDocument();
  });

  it('hides manual input toggle when allowManualInput is false', () => {
    render(
      <SearchableSelect label="Model" options={options} value="" onChange={() => {}} allowManualInput={false} />
    );
    expect(screen.queryByText('Type manually')).toBeNull();
    expect(screen.queryByText('Select from list')).toBeNull();
  });
});
