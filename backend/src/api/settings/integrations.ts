/**
 * Integration Settings API
 * Manages Jira PAT connections securely (encrypted storage, no localStorage)
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationCredentials } from '../../db/schema.js';
import { requireAuth } from '../../utils/auth.js';
import { sendError } from '../../utils/errorHandler.js';
import { encryptSecret } from '../../utils/crypto.js';

const JiraConnectSchema = z.object({
  siteUrl: z.string().url().max(500),
  email: z.string().email().max(255),
  token: z.string().min(10).max(500),
});

export async function integrationSettingsRoutes(fastify: FastifyInstance) {
  // GET /api/settings/integrations/jira/status
  fastify.get('/integrations/jira/status', async (request: FastifyRequest, reply: FastifyReply) => {
    let user;
    try { user = await requireAuth(request); } catch {
      return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    }

    const existing = await db.query.integrationCredentials.findFirst({
      where: and(
        eq(integrationCredentials.userId, user.id),
        eq(integrationCredentials.provider, 'jira'),
      ),
    });

    return {
      connected: !!existing,
      siteUrl: existing?.siteUrl ?? null,
      email: existing?.userEmail ?? null,
      connectedAt: existing?.createdAt ?? null,
    };
  });

  // POST /api/settings/integrations/jira/connect
  fastify.post('/integrations/jira/connect', async (request: FastifyRequest, reply: FastifyReply) => {
    let user;
    try { user = await requireAuth(request); } catch {
      return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    }

    const body = JiraConnectSchema.parse(request.body);
    const scope = `jira:${user.id}`;
    const encrypted = encryptSecret(body.token, scope);
    const last4 = body.token.slice(-4);

    // Upsert
    const existing = await db.query.integrationCredentials.findFirst({
      where: and(
        eq(integrationCredentials.userId, user.id),
        eq(integrationCredentials.provider, 'jira'),
      ),
    });

    if (existing) {
      await db.update(integrationCredentials).set({
        siteUrl: body.siteUrl,
        userEmail: body.email,
        encryptedToken: encrypted.cipherText,
        tokenIv: encrypted.iv,
        tokenTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        tokenLast4: last4,
        isValid: true,
        updatedAt: new Date(),
      }).where(eq(integrationCredentials.id, existing.id));
    } else {
      await db.insert(integrationCredentials).values({
        userId: user.id,
        provider: 'jira',
        siteUrl: body.siteUrl,
        userEmail: body.email,
        encryptedToken: encrypted.cipherText,
        tokenIv: encrypted.iv,
        tokenTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        tokenLast4: last4,
      });
    }

    return { ok: true, siteUrl: body.siteUrl };
  });

  // POST /api/settings/integrations/jira/disconnect (using POST instead of DELETE for Fastify compat)
  fastify.post('/integrations/jira/disconnect', async (request: FastifyRequest, reply: FastifyReply) => {
    let user;
    try { user = await requireAuth(request); } catch {
      return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    }

    await db.delete(integrationCredentials).where(
      and(
        eq(integrationCredentials.userId, user.id),
        eq(integrationCredentials.provider, 'jira'),
      ),
    );

    return { ok: true };
  });
}
