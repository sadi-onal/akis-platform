import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { buildApp } from '../../src/server.app.js';
import { db } from '../../src/db/client.js';
import { jobs, users } from '../../src/db/schema.js';
import { sign } from '../../src/services/auth/jwt.js';
import { env as authEnv } from '../../src/lib/env.js';
import { hashPassword } from '../../src/services/auth/password.js';

const hasDatabase = !!process.env.DATABASE_URL;

async function waitForTerminalState(
  jobId: string,
  expectedState: 'completed' | 'failed',
  timeoutMs: number = 8000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [job] = await db
      .select({ state: jobs.state })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    if (job?.state === expectedState) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const [latest] = await db
    .select({ state: jobs.state })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  throw new Error(`Timed out waiting for job ${jobId} to reach ${expectedState}. Last state: ${latest?.state}`);
}

test('Agents approval flow', { skip: !hasDatabase }, async (t) => {
  if (!hasDatabase) {
    return;
  }

  let schemaReady = true;
  try {
    const hasCrewRunColumn = await db.execute(sql`
      select 1
      from information_schema.columns
      where table_name = 'jobs'
        and column_name = 'crew_run_id'
      limit 1
    `);
    const hasRequiresApproval = await db.execute(sql`
      select 1
      from information_schema.columns
      where table_name = 'jobs'
        and column_name = 'requires_approval'
      limit 1
    `);
    const hasAwaitingApprovalEnum = await db.execute(sql`
      select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      where t.typname = 'job_state'
        and e.enumlabel = 'awaiting_approval'
      limit 1
    `);
    schemaReady =
      hasCrewRunColumn.rows.length > 0 &&
      hasRequiresApproval.rows.length > 0 &&
      hasAwaitingApprovalEnum.rows.length > 0;
  } catch {
    schemaReady = false;
  }

  if (!schemaReady) {
    t.skip('Approval test skipped because jobs table schema is behind current Drizzle model');
    return;
  }

  const app = await buildApp();
  await app.ready();

  const userId = randomUUID();
  const userEmail = `approval-flow-${Date.now()}@test.local`;
  const passwordHash = await hashPassword('approval-flow-password');

  try {
    await db.insert(users).values({
      id: userId,
      name: 'Approval Flow User',
      email: userEmail,
      passwordHash,
      status: 'active',
      emailVerified: true,
    });

    const jwt = await sign({ sub: userId, email: userEmail, name: 'Approval Flow User' });
    const cookie = `${authEnv.AUTH_COOKIE_NAME}=${jwt as unknown as string}`;

    let approvalJobId = '';

    await t.test('requiresApproval=true pauses execution at awaiting_approval', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agents/jobs',
        headers: { cookie },
        payload: {
          type: 'trace',
          requiresApproval: true,
          payload: {
            spec: 'Create deterministic approval-flow trace plan',
            useEnvAI: true,
            automationMode: 'plan_only',
          },
        },
      });

      if (response.statusCode !== 200) {
        throw new Error(`Job submit failed: ${response.statusCode} ${response.body}`);
      }
      const body = response.json() as { jobId: string; state: string };
      assert.equal(body.state, 'awaiting_approval');
      approvalJobId = body.jobId;

      const [job] = await db
        .select({ state: jobs.state, requiresApproval: jobs.requiresApproval })
        .from(jobs)
        .where(eq(jobs.id, body.jobId))
        .limit(1);

      assert.equal(job?.state, 'awaiting_approval');
      assert.equal(job?.requiresApproval, true);
    });

    await t.test('approve resumes and completes real execution', async () => {
      const approveResponse = await app.inject({
        method: 'POST',
        url: `/api/agents/jobs/${approvalJobId}/approve`,
        headers: { cookie },
        payload: { comment: 'Approved in integration test' },
      });

      if (approveResponse.statusCode !== 200) {
        throw new Error(`Approve failed: ${approveResponse.statusCode} ${approveResponse.body}`);
      }
      const approveBody = approveResponse.json() as { success: boolean; message: string };
      assert.equal(approveBody.success, true);

      await waitForTerminalState(approvalJobId, 'completed');

      const [job] = await db
        .select({
          state: jobs.state,
          result: jobs.result,
          approvedBy: jobs.approvedBy,
          approvedAt: jobs.approvedAt,
        })
        .from(jobs)
        .where(eq(jobs.id, approvalJobId))
        .limit(1);

      assert.equal(job?.state, 'completed');
      assert.equal(job?.approvedBy, userId);
      assert.ok(job?.approvedAt);
      const result = (job?.result ?? {}) as Record<string, unknown>;
      const message = typeof result.message === 'string' ? result.message : '';
      assert.equal(
        message.includes('Full execution continuation pending PR-1 Phase 2 implementation.'),
        false
      );
    });

    await t.test('requiresApproval=false keeps existing non-blocking behavior', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agents/jobs',
        headers: { cookie },
        payload: {
          type: 'trace',
          requiresApproval: false,
          payload: {
            spec: 'Trace flow without approval gate',
            useEnvAI: true,
            automationMode: 'plan_only',
          },
        },
      });

      if (response.statusCode !== 200) {
        throw new Error(`Non-approval submit failed: ${response.statusCode} ${response.body}`);
      }
      const body = response.json() as { state: string };
      assert.notEqual(body.state, 'awaiting_approval');
    });
  } finally {
    await db
      .delete(jobs)
      .where(sql`(${jobs.payload}->>'userId')::text = ${userId}`);
    await db.delete(users).where(eq(users.id, userId));
    await app.close();
  }
});
