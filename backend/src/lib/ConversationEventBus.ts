import { EventEmitter } from 'events';

export type ConversationEventType = 'thread' | 'message' | 'plan' | 'task' | 'trust';

export interface ConversationStreamEvent {
  eventId: number;
  type: ConversationEventType;
  ts: string;
  threadId: string;
  payload?: Record<string, unknown>;
}

const MAX_EVENTS_PER_THREAD = 500;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

class ConversationEventBusImpl extends EventEmitter {
  private eventHistory = new Map<string, ConversationStreamEvent[]>();
  private eventCounters = new Map<string, number>();
  private lastSeenAt = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.setMaxListeners(200);
    this.startCleanup();
  }

  private getNextEventId(threadId: string): number {
    const next = (this.eventCounters.get(threadId) ?? 0) + 1;
    this.eventCounters.set(threadId, next);
    return next;
  }

  emitEvent(
    threadId: string,
    type: ConversationEventType,
    payload?: Record<string, unknown>
  ): ConversationStreamEvent {
    const event: ConversationStreamEvent = {
      eventId: this.getNextEventId(threadId),
      type,
      ts: new Date().toISOString(),
      threadId,
      payload,
    };
    const history = this.eventHistory.get(threadId) ?? [];
    history.push(event);
    if (history.length > MAX_EVENTS_PER_THREAD) history.shift();
    this.eventHistory.set(threadId, history);
    this.lastSeenAt.set(threadId, Date.now());
    this.emit(`thread:${threadId}`, event);
    return event;
  }

  subscribe(threadId: string, callback: (event: ConversationStreamEvent) => void): void {
    this.on(`thread:${threadId}`, callback);
  }

  unsubscribe(threadId: string, callback: (event: ConversationStreamEvent) => void): void {
    this.off(`thread:${threadId}`, callback);
  }

  getHistory(threadId: string): ConversationStreamEvent[] {
    return this.eventHistory.get(threadId) ?? [];
  }

  getHistoryAfter(threadId: string, afterEventId: number): ConversationStreamEvent[] {
    return this.getHistory(threadId).filter((event) => event.eventId > afterEventId);
  }

  getCurrentEventId(threadId: string): number {
    return this.eventCounters.get(threadId) ?? 0;
  }

  formatForSSE(event: ConversationStreamEvent): string {
    return `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  clearThread(threadId: string): void {
    this.eventHistory.delete(threadId);
    this.eventCounters.delete(threadId);
    this.lastSeenAt.delete(threadId);
    this.removeAllListeners(`thread:${threadId}`);
  }

  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [threadId, lastSeen] of this.lastSeenAt.entries()) {
        if (now - lastSeen > STALE_AFTER_MS) {
          this.clearThread(threadId);
        }
      }
    }, CLEANUP_INTERVAL_MS);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }
}

export const conversationEventBus = new ConversationEventBusImpl();
