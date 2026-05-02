import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ─── Shared mocks ───────────────────────────────────────────────────
vi.mock('../../hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

vi.mock('../../theme/brand', () => ({
  LOGO_MARK_SVG: 'data:image/svg+xml,<svg/>',
}));

// ─── Imports (after mocks) ──────────────────────────────────────────
import { SuggestionWizard } from '../workflow/SuggestionWizard';
import { PlanCard } from '../chat/PlanCard';
import type { UserFriendlyPlan, ChangePlan } from '../../types/plan';

// ─── Fixtures ───────────────────────────────────────────────────────
const wizardQuestions = [
  {
    id: 'q1',
    question: 'What language do you prefer?',
    reason: 'Helps pick the right stack',
    suggestions: ['TypeScript', 'Python', 'Go'],
  },
  {
    id: 'q2',
    question: 'What kind of app?',
    suggestions: ['Web', 'Mobile', 'CLI'],
  },
  {
    id: 'q3',
    question: 'Need a database?',
    suggestions: ['Yes', 'No'],
  },
];

const singleQuestion = [
  {
    id: 'q1',
    question: 'Pick a framework',
    suggestions: ['React', 'Vue'],
  },
];

const mockPlan: UserFriendlyPlan = {
  projectName: 'Test Project',
  summary: 'A test project summary',
  features: [
    { name: 'Auth', description: 'User authentication' },
    { name: 'Dashboard', description: 'Admin dashboard' },
  ],
  techChoices: ['React', 'Node.js', 'PostgreSQL'],
  estimatedFiles: 15,
  requiresTests: true,
  testRationale: 'Critical auth flow needs coverage',
};

const mockChangePlan: ChangePlan = {
  changeName: 'Add dark mode',
  summary: 'Adds dark mode support',
  modifiedFiles: [{ path: 'src/theme.ts', description: 'Add dark theme tokens' }],
  newFiles: ['src/dark.css'],
  requiresTests: false,
};

// =====================================================================
// 1. SuggestionWizard
// =====================================================================
describe('SuggestionWizard', () => {
  it('renders the first question text', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('What language do you prefer?')).toBeInTheDocument();
  });

  it('renders the question reason when provided', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('Helps pick the right stack')).toBeInTheDocument();
  });

  it('renders all suggestion chips for current question', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
    expect(screen.getByText('Python')).toBeInTheDocument();
    expect(screen.getByText('Go')).toBeInTheDocument();
  });

  it('shows step counter 1/N', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('suggestion chips are clickable and enable next button', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Next button should be disabled initially (no selection)
    const nextBtn = screen.getByText('İleri');
    expect(nextBtn).toBeDisabled();

    // Click a suggestion
    fireEvent.click(screen.getByText('TypeScript'));

    // Next button should now be enabled
    expect(nextBtn).not.toBeDisabled();
  });

  it('navigates to next question on next click', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Select answer and go next
    fireEvent.click(screen.getByText('TypeScript'));
    fireEvent.click(screen.getByText('İleri'));

    // Should show second question
    expect(screen.getByText('What kind of app?')).toBeInTheDocument();
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  it('back navigation returns to previous question', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Go to question 2
    fireEvent.click(screen.getByText('TypeScript'));
    fireEvent.click(screen.getByText('İleri'));
    expect(screen.getByText('What kind of app?')).toBeInTheDocument();

    // Go back
    fireEvent.click(screen.getByText('Geri'));
    expect(screen.getByText('What language do you prefer?')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
  });

  it('shows cancel button on first step instead of back', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('İptal')).toBeInTheDocument();
    expect(screen.queryByText('Geri')).not.toBeInTheDocument();
  });

  it('cancel button calls onCancel', () => {
    const onCancel = vi.fn();
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText('İptal'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows submit button on last question instead of next', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Navigate to last question
    fireEvent.click(screen.getByText('TypeScript'));
    fireEvent.click(screen.getByText('İleri'));
    fireEvent.click(screen.getByText('Web'));
    fireEvent.click(screen.getByText('İleri'));

    // Should show "Gonder" instead of "Ileri"
    expect(screen.getByText('Gönder')).toBeInTheDocument();
    expect(screen.queryByText('İleri')).not.toBeInTheDocument();
  });

  it('submit sends all selected answers as formatted string', () => {
    const onSubmit = vi.fn();
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    // Answer all questions
    fireEvent.click(screen.getByText('TypeScript'));
    fireEvent.click(screen.getByText('İleri'));
    fireEvent.click(screen.getByText('Web'));
    fireEvent.click(screen.getByText('İleri'));
    fireEvent.click(screen.getByText('Yes'));
    fireEvent.click(screen.getByText('Gönder'));

    expect(onSubmit).toHaveBeenCalledOnce();
    const result = onSubmit.mock.calls[0][0] as string;
    expect(result).toContain('1. TypeScript');
    expect(result).toContain('2. Web');
    expect(result).toContain('3. Yes');
  });

  it('custom answer mode toggles and shows text input', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Click custom answer option
    fireEvent.click(screen.getByText('Kendi cevabımı yazayım'));

    // Should show text input
    expect(screen.getByPlaceholderText('Cevabınızı yazın...')).toBeInTheDocument();
  });

  it('custom text input enables submit when filled', () => {
    render(
      <SuggestionWizard
        questions={singleQuestion}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Switch to custom mode
    fireEvent.click(screen.getByText('Kendi cevabımı yazayım'));
    const input = screen.getByPlaceholderText('Cevabınızı yazın...');

    // Button should be disabled with empty input
    expect(screen.getByText('Gönder')).toBeDisabled();

    // Type custom answer
    fireEvent.change(input, { target: { value: 'Svelte' } });

    // Button should now be enabled
    expect(screen.getByText('Gönder')).not.toBeDisabled();
  });

  it('submit with custom answer includes custom text', () => {
    const onSubmit = vi.fn();
    render(
      <SuggestionWizard
        questions={singleQuestion}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Kendi cevabımı yazayım'));
    fireEvent.change(screen.getByPlaceholderText('Cevabınızı yazın...'), {
      target: { value: 'Svelte' },
    });
    fireEvent.click(screen.getByText('Gönder'));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0][0]).toContain('Svelte');
  });

  it('selecting a suggestion after custom mode deactivates custom input', () => {
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Enter custom mode
    fireEvent.click(screen.getByText('Kendi cevabımı yazayım'));
    expect(screen.getByPlaceholderText('Cevabınızı yazın...')).toBeInTheDocument();

    // Click a suggestion chip to go back to suggestion mode
    fireEvent.click(screen.getByText('Python'));

    // Custom input should be gone
    expect(screen.queryByPlaceholderText('Cevabınızı yazın...')).not.toBeInTheDocument();
  });

  it('returns null when questions array is empty', () => {
    const { container } = render(
      <SuggestionWizard
        questions={[]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('preserves previous answers when navigating back and forth', () => {
    const onSubmit = vi.fn();
    render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    // Select answer on q1 and advance
    fireEvent.click(screen.getByText('Go'));
    fireEvent.click(screen.getByText('İleri'));

    // Select answer on q2 and go back
    fireEvent.click(screen.getByText('Mobile'));
    fireEvent.click(screen.getByText('Geri'));

    // Go forward again -- next should still be enabled (answer preserved)
    const nextBtn = screen.getByText('İleri');
    expect(nextBtn).not.toBeDisabled();
  });

  it('renders progress bar segments matching question count', () => {
    const { container } = render(
      <SuggestionWizard
        questions={wizardQuestions}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Progress bar has one segment per question
    const segments = container.querySelectorAll('.rounded-full.h-1');
    expect(segments).toHaveLength(3);
  });
});

// =====================================================================
// 2. PlanCard — additional coverage beyond PlanCard.test.tsx
// =====================================================================
describe('PlanCard — tech choices & change plans', () => {
  it('displays tech choice chips', () => {
    render(
      <PlanCard
        plan={mockPlan}
        version={1}
        status="active"
        isChangeRequest={false}
      />,
    );
    expect(screen.getByText('React')).toBeInTheDocument();
    expect(screen.getByText('Node.js')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
  });

  it('shows all features with descriptions', () => {
    render(
      <PlanCard
        plan={mockPlan}
        version={1}
        status="active"
        isChangeRequest={false}
      />,
    );
    expect(screen.getByText('Auth')).toBeInTheDocument();
    expect(screen.getByText('User authentication')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Admin dashboard')).toBeInTheDocument();
  });

  it('shows estimated files count', () => {
    render(
      <PlanCard
        plan={mockPlan}
        version={1}
        status="active"
        isChangeRequest={false}
      />,
    );
    expect(screen.getByText(/~15 dosya/)).toBeInTheDocument();
  });

  it('shows test requirement indicator', () => {
    render(
      <PlanCard
        plan={mockPlan}
        version={1}
        status="active"
        isChangeRequest={false}
      />,
    );
    expect(screen.getByText(/Test yazılacak/)).toBeInTheDocument();
  });

  it('shows test rationale when provided', () => {
    render(
      <PlanCard
        plan={mockPlan}
        version={1}
        status="active"
        isChangeRequest={false}
      />,
    );
    expect(screen.getByText('Critical auth flow needs coverage')).toBeInTheDocument();
  });

  it('renders change plan with modified files', () => {
    render(
      <PlanCard
        plan={mockChangePlan}
        version={1}
        status="active"
        isChangeRequest={true}
      />,
    );
    expect(screen.getByText('src/theme.ts')).toBeInTheDocument();
    expect(screen.getByText(/Add dark theme tokens/)).toBeInTheDocument();
  });

  it('renders change plan with new files', () => {
    render(
      <PlanCard
        plan={mockChangePlan}
        version={1}
        status="active"
        isChangeRequest={true}
      />,
    );
    expect(screen.getByText('src/dark.css')).toBeInTheDocument();
  });

  it('shows "Test gerekmiyor" when requiresTests is false', () => {
    render(
      <PlanCard
        plan={mockChangePlan}
        version={1}
        status="active"
        isChangeRequest={true}
      />,
    );
    expect(screen.getByText(/Test gerekmiyor/)).toBeInTheDocument();
  });

  it('approve callback fires on button click', () => {
    const onApprove = vi.fn();
    render(
      <PlanCard
        plan={mockPlan}
        version={1}
        status="active"
        isChangeRequest={false}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Onayla'));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it('reject callback fires on button click', () => {
    const onReject = vi.fn();
    render(
      <PlanCard
        plan={mockPlan}
        version={1}
        status="active"
        isChangeRequest={false}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByText('İptal'));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it('non-active plan hides action buttons', () => {
    render(
      <PlanCard
        plan={mockPlan}
        version={1}
        status="approved"
        isChangeRequest={false}
      />,
    );
    expect(screen.queryByText('Onayla')).not.toBeInTheDocument();
  });
});

