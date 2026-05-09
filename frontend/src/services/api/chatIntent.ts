/**
 * Chat-intent API client (FR-11).
 *
 * Wraps the backend `/api/chat/intent` endpoints (POST classify + PATCH
 * override). The classifier is deliberately stateless from the FE's
 * perspective: classify returns a `classificationId` we pass to override if
 * the user resolves a low-confidence prompt via the disambiguation modal.
 *
 * Anchors: 03-architecture § 3.1 + § 5.2 (sequence), 02-ux § 5.9.
 */
import { getApiBaseUrl } from './config';

export type IntentLabel = 'BUILD' | 'ASK' | 'FEEDBACK' | 'CHAT';

export interface IntentAlternate {
  intent: IntentLabel;
  confidence: number;
}

export interface IntentClassification {
  intent: IntentLabel;
  confidence: number;
  reasoning: string;
  alternates?: IntentAlternate[];
  classificationId?: string;
  /** Confidence threshold below which the FE should show disambiguation. */
  threshold: number;
}

export interface ClassifyRequest {
  message: string;
  pipelineId?: string;
  recentMessages?: string[];
}

function baseUrl(): string {
  return getApiBaseUrl().replace(/\/$/, '').replace(/\/api\/?$/, '');
}

async function readError(response: Response): Promise<string> {
  let message = `İstek başarısız: ${response.status}`;
  try {
    const data = await response.json();
    const err = data?.error;
    if (err && typeof err.message === 'string') message = err.message;
  } catch {
    // ignore parse errors
  }
  return message;
}

export const chatIntentApi = {
  async classify(req: ClassifyRequest): Promise<IntentClassification> {
    const response = await fetch(`${baseUrl()}/api/chat/intent`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await readError(response));
    return (await response.json()) as IntentClassification;
  },

  async override(classificationId: string, intent: IntentLabel): Promise<void> {
    const response = await fetch(
      `${baseUrl()}/api/chat/intent/${encodeURIComponent(classificationId)}`,
      {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrideIntent: intent }),
      },
    );
    if (!response.ok) throw new Error(await readError(response));
  },
};
