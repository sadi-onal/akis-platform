import { desc, eq } from 'drizzle-orm';
import { agentActivities, type AgentActivityInsert, type AgentActivitySelect } from '../db/agent-activity-schema.js';

export interface AgentActivityDeps {
  db: {
    insert(table: typeof agentActivities): { values(data: AgentActivityInsert): Promise<unknown> };
    select(): {
      from(table: typeof agentActivities): {
        where(condition: unknown): { orderBy(order: unknown): { limit(n: number): Promise<AgentActivitySelect[]> } };
        orderBy(order: unknown): { limit(n: number): Promise<AgentActivitySelect[]> };
      };
    };
  };
}

export interface AgentAggregateMetrics {
  agent: string;
  totalRuns: number;
  avgConfidence: number | null;
  avgResponseTimeMs: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgFilesGenerated: number | null;
  avgTestsPassed: number | null;
}

export class AgentActivityService {
  constructor(private deps: AgentActivityDeps) {}

  async record(entry: AgentActivityInsert): Promise<void> {
    try {
      await this.deps.db.insert(agentActivities).values(entry);
    } catch (err) {
      // Non-fatal — don't block pipeline for audit logging
      // Non-fatal — don't block pipeline for audit logging (use console as logger may not be available)
      if (typeof globalThis.console !== 'undefined') console.warn('[AgentActivity] Failed to record activity:', err);
    }
  }

  async listByPipeline(pipelineId: string, limit = 50): Promise<AgentActivitySelect[]> {
    return this.deps.db
      .select()
      .from(agentActivities)
      .where(eq(agentActivities.pipelineId, pipelineId))
      .orderBy(desc(agentActivities.createdAt))
      .limit(limit);
  }

  async listRecent(limit = 100): Promise<AgentActivitySelect[]> {
    return this.deps.db
      .select()
      .from(agentActivities)
      .orderBy(desc(agentActivities.createdAt))
      .limit(limit);
  }
}
