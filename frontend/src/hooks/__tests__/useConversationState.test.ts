import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConversationState } from '../useConversationState';
import type { PipelineStage } from '../../types/pipeline';

describe('useConversationState', () => {
  // ── uiState mapping ──────────────────────────────

  describe('uiState mapping from pipeline stage', () => {
    it('maps scribe_clarifying to scribe_clarifying', () => {
      const { result } = renderHook(() => useConversationState('scribe_clarifying'));
      expect(result.current.uiState).toBe('scribe_clarifying');
    });

    it('maps scribe_generating to scribe_running', () => {
      const { result } = renderHook(() => useConversationState('scribe_generating'));
      expect(result.current.uiState).toBe('scribe_running');
    });

    it('maps critic_reviewing_spec to critic_running', () => {
      const { result } = renderHook(() => useConversationState('critic_reviewing_spec'));
      expect(result.current.uiState).toBe('critic_running');
      expect(result.current.runningAgentName).toBe('Critic');
      expect(result.current.showCancelButton).toBe(true);
      expect(result.current.inputPlaceholder).toContain('Critic');
    });

    it('maps awaiting_approval to awaiting_approval', () => {
      const { result } = renderHook(() => useConversationState('awaiting_approval'));
      expect(result.current.uiState).toBe('awaiting_approval');
    });

    it('maps proto_building to proto_running', () => {
      const { result } = renderHook(() => useConversationState('proto_building'));
      expect(result.current.uiState).toBe('proto_running');
    });

    it('maps trace_testing to trace_running', () => {
      const { result } = renderHook(() => useConversationState('trace_testing'));
      expect(result.current.uiState).toBe('trace_running');
    });

    it('maps ci_running to ci_running', () => {
      const { result } = renderHook(() => useConversationState('ci_running'));
      expect(result.current.uiState).toBe('ci_running');
    });

    it('maps completed to idle', () => {
      const { result } = renderHook(() => useConversationState('completed'));
      expect(result.current.uiState).toBe('idle');
    });

    it('maps failed to idle', () => {
      const { result } = renderHook(() => useConversationState('failed'));
      expect(result.current.uiState).toBe('idle');
    });

    it('maps cancelled to idle', () => {
      const { result } = renderHook(() => useConversationState('cancelled'));
      expect(result.current.uiState).toBe('idle');
    });

    it('defaults to idle when no stage provided', () => {
      const { result } = renderHook(() => useConversationState());
      expect(result.current.uiState).toBe('idle');
    });
  });

  // ── isInputEnabled ───────────────────────────────

  describe('isInputEnabled', () => {
    const allStages: PipelineStage[] = [
      'scribe_clarifying',
      'awaiting_approval',
      'completed',
      'cancelled',
      'scribe_generating',
      'proto_building',
      'trace_testing',
      'ci_running',
    ];

    it.each(allStages)('is always true for %s (user can always type)', (stage) => {
      const { result } = renderHook(() => useConversationState(stage));
      expect(result.current.isInputEnabled).toBe(true);
    });

    it('is true when no stage is set (idle)', () => {
      const { result } = renderHook(() => useConversationState());
      expect(result.current.isInputEnabled).toBe(true);
    });
  });

  // ── showCancelButton ─────────────────────────────

  describe('showCancelButton', () => {
    const showCancelStages: PipelineStage[] = [
      'scribe_generating',
      'proto_building',
      'trace_testing',
      'ci_running',
    ];
    const hideCancelStages: PipelineStage[] = [
      'scribe_clarifying',
      'awaiting_approval',
      'completed',
      'failed',
      'cancelled',
    ];

    it.each(showCancelStages)('is true for %s (running agent)', (stage) => {
      const { result } = renderHook(() => useConversationState(stage));
      expect(result.current.showCancelButton).toBe(true);
    });

    it.each(hideCancelStages)('is false for %s (not running)', (stage) => {
      const { result } = renderHook(() => useConversationState(stage));
      expect(result.current.showCancelButton).toBe(false);
    });
  });

  // ── runningAgentName ─────────────────────────────

  describe('runningAgentName', () => {
    it('returns Scribe for scribe_generating', () => {
      const { result } = renderHook(() => useConversationState('scribe_generating'));
      expect(result.current.runningAgentName).toBe('Scribe');
    });

    it('returns Proto for proto_building', () => {
      const { result } = renderHook(() => useConversationState('proto_building'));
      expect(result.current.runningAgentName).toBe('Proto');
    });

    it('returns Trace for trace_testing', () => {
      const { result } = renderHook(() => useConversationState('trace_testing'));
      expect(result.current.runningAgentName).toBe('Trace');
    });

    it('returns CI for ci_running', () => {
      const { result } = renderHook(() => useConversationState('ci_running'));
      expect(result.current.runningAgentName).toBe('CI');
    });

    it('returns null for idle state', () => {
      const { result } = renderHook(() => useConversationState('completed'));
      expect(result.current.runningAgentName).toBeNull();
    });
  });

  // ── inputPlaceholder ─────────────────────────────

  describe('inputPlaceholder', () => {
    it('shows clarification prompt when scribe is asking questions', () => {
      const { result } = renderHook(() => useConversationState('scribe_clarifying'));
      expect(result.current.inputPlaceholder).toContain('Soruları yanıtlayın');
    });

    it('shows approval prompt when awaiting approval', () => {
      const { result } = renderHook(() => useConversationState('awaiting_approval'));
      expect(result.current.inputPlaceholder).toContain('onaylayın');
    });

    it('shows agent running message when scribe is generating', () => {
      const { result } = renderHook(() => useConversationState('scribe_generating'));
      expect(result.current.inputPlaceholder).toContain('Scribe');
      expect(result.current.inputPlaceholder).toContain('çalışıyor');
    });

    it('shows terminal-state placeholder after completion', () => {
      const { result } = renderHook(() => useConversationState('completed'));
      expect(result.current.inputPlaceholder).toContain('Projeniz hazır');
    });

    // P8 — critic hard-block placeholder
    it('shows critic-resolution prompt when blocked', () => {
      const { result } = renderHook(() =>
        useConversationState('awaiting_critic_resolution' as PipelineStage),
      );
      expect(result.current.uiState).toBe('awaiting_critic_resolution');
      expect(result.current.inputPlaceholder).toContain('Kritik bulgu');
      expect(result.current.inputPlaceholder).toContain('sağdaki');
    });
  });

  // ── syncFromStage ────────────────────────────────

  describe('syncFromStage', () => {
    it('updates uiState when stage changes', () => {
      const { result } = renderHook(() => useConversationState('scribe_clarifying'));
      expect(result.current.uiState).toBe('scribe_clarifying');

      act(() => {
        result.current.syncFromStage('proto_building');
      });

      expect(result.current.uiState).toBe('proto_running');
      expect(result.current.isInputEnabled).toBe(true);
      expect(result.current.showCancelButton).toBe(true);
    });

    it('transitions from running to idle when completed', () => {
      const { result } = renderHook(() => useConversationState('proto_building'));
      expect(result.current.showCancelButton).toBe(true);

      act(() => {
        result.current.syncFromStage('completed');
      });

      expect(result.current.uiState).toBe('idle');
      expect(result.current.isInputEnabled).toBe(true);
      expect(result.current.showCancelButton).toBe(false);
    });

    it('maintains stable syncFromStage reference across renders', () => {
      const { result, rerender } = renderHook(() => useConversationState('scribe_clarifying'));
      const firstRef = result.current.syncFromStage;
      rerender();
      expect(result.current.syncFromStage).toBe(firstRef);
    });
  });
});
