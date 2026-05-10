/**
 * useTraceToggle — owns the `traceEnabled` flag for ChatPage.
 *
 * Trivial state hook extracted from ChatPage.tsx as part of F-06 Phase 2. The
 * flag controls whether the Trace stage runs after Proto. Defaulted to `true`
 * because most users expect the verification step.
 *
 * Kept as its own hook (rather than inlined in ChatPage) so that the model
 * picker, trace toggle, and preview pane all live alongside their siblings —
 * each Phase 2 hook owns one concern.
 */
import { useState } from 'react';

export interface UseTraceToggleResult {
  traceEnabled: boolean;
  setTraceEnabled: (next: boolean) => void;
}

export function useTraceToggle(initial = true): UseTraceToggleResult {
  const [traceEnabled, setTraceEnabled] = useState<boolean>(initial);
  return { traceEnabled, setTraceEnabled };
}
