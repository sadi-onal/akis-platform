import { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { db } from '../db/client.js';
import { agentTriggers, webhookDeliveries } from '../db/triggers-schema.js';
import { eq, and } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function resolveEventType(githubEvent: string, action?: string): string | null {
  if (githubEvent === 'pull_request') {
    if (action === 'opened') return 'pr_opened';
    if (action === 'closed') return 'pr_merged';
    return null;
  }
  if (githubEvent === 'push') return 'push';
  return null;
}

export async function webhookRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/api/webhooks/github',
    {
      config: { rawBody: true },
      schema: {
        description: 'GitHub webhook receiver',
        tags: ['webhooks'],
      },
    },
    async (request, reply) => {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      const rawBody =
        typeof request.body === 'string' ? request.body : JSON.stringify(request.body);

      if (secret) {
        const signature = request.headers['x-hub-signature-256'] as string | undefined;
        if (!signature || !verifyGitHubSignature(rawBody, signature, secret)) {
          return reply.code(401).send({
            error: {
              code: 'INVALID_SIGNATURE',
              message: 'Webhook signature verification failed',
            },
          });
        }
      }

      const deliveryId = request.headers['x-github-delivery'] as string | undefined;
      const githubEvent = request.headers['x-github-event'] as string | undefined;

      if (!githubEvent) {
        return reply.code(400).send({
          error: { code: 'MISSING_EVENT', message: 'X-GitHub-Event header is required' },
        });
      }

      const body =
        typeof request.body === 'string'
          ? JSON.parse(request.body)
          : (request.body as Record<string, unknown>);
      const action = body.action as string | undefined;
      const eventType = resolveEventType(githubEvent, action);

      if (!eventType) {
        return reply.code(200).send({
          status: 'ignored',
          reason: `Unsupported event: ${githubEvent}/${action || 'none'}`,
        });
      }

      if (eventType === 'pr_merged' && githubEvent === 'pull_request') {
        const pr = body.pull_request as Record<string, unknown> | undefined;
        if (action === 'closed' && !pr?.merged) {
          return reply.code(200).send({ status: 'ignored', reason: 'PR closed without merge' });
        }
      }

      const repo = body.repository as Record<string, unknown> | undefined;
      if (!repo) {
        return reply.code(400).send({
          error: { code: 'MISSING_REPO', message: 'Repository data is required' },
        });
      }

      const owner = ((repo.owner as Record<string, unknown>)?.login as string) || '';
      const repoName = (repo.name as string) || '';

      if (deliveryId) {
        const [existing] = await db
          .select({ id: webhookDeliveries.id })
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.deliveryId, deliveryId))
          .limit(1);

        if (existing) {
          return reply.code(200).send({ status: 'duplicate', deliveryId });
        }
      }

      const matchingTriggers = await db
        .select()
        .from(agentTriggers)
        .where(
          and(
            eq(agentTriggers.repoOwner, owner),
            eq(agentTriggers.repoName, repoName),
            eq(agentTriggers.eventType, eventType),
            eq(agentTriggers.enabled, true)
          )
        );

      // Log matched triggers — legacy orchestrator removed, webhook ingestion
      // is recorded but job dispatch is no longer wired here.
      for (const trigger of matchingTriggers) {
        logger.info(
          `[Webhook] Matched trigger ${trigger.id} for ${eventType} on ${owner}/${repoName}`
        );
        await db
          .update(agentTriggers)
          .set({ lastDeliveryId: deliveryId || null, updatedAt: new Date() })
          .where(eq(agentTriggers.id, trigger.id));
      }

      if (deliveryId) {
        await db.insert(webhookDeliveries).values({
          deliveryId,
          eventType,
          repoOwner: owner,
          repoName,
          jobId: null,
        });
      }

      return reply.code(200).send({
        status: 'processed',
        event: eventType,
        triggersMatched: matchingTriggers.length,
        jobsCreated: [],
      });
    }
  );
}
