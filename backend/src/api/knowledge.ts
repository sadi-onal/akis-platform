/**
 * Knowledge Sources API — CRUD for the Source Registry
 * S0.6: Verified Knowledge Acquisition
 *
 * POST   /api/knowledge/sources       — register a new source
 * GET    /api/knowledge/sources       — list sources (filterable by domain, status)
 * GET    /api/knowledge/sources/:id   — get source + provenance stats
 * PATCH  /api/knowledge/sources/:id   — update source metadata
 * DELETE /api/knowledge/sources/:id   — soft-deactivate source
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { knowledgeSources, knowledgeChunks, knowledgeTags, knowledgeProvenance, knowledgeDocuments, auditLog } from '../db/schema.js';
import { requireAdmin, requireAuth } from '../utils/auth.js';
import { eq, and, sql, ilike, inArray, desc } from 'drizzle-orm';
import { FreshnessScheduler, getFreshnessSchedulerInstance } from '../services/knowledge/FreshnessScheduler.js';
import { getEnv } from '../config/env.js';
import { GitHubMCPService } from '../services/mcp/adapters/GitHubMCPService.js';
import { SecuritySignalCollector } from '../services/knowledge/security/SecuritySignalCollector.js';
import { repoDocsIngester } from '../services/knowledge/ingestion/RepoDocsIngester.js';
import { knowledgeRetrievalService } from '../services/knowledge/retrieval/KnowledgeRetrievalService.js';

// ── Validation schemas ──

const createSourceSchema = z.object({
  name: z.string().min(1).max(300),
  sourceUrl: z.string().url().max(2000),
  licenseType: z.enum([
    'apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'cc-by-4.0', 'cc-by-sa-4.0',
    'cc0-1.0', 'mpl-2.0', 'isc', 'unlicense', 'public-domain', 'custom-open', 'unknown',
  ]).default('unknown'),
  accessMethod: z.enum(['api', 'git_clone', 'http_scrape', 'rss', 'manual_upload']),
  domain: z.string().min(1).max(100),
  refreshIntervalHours: z.number().int().min(1).max(8760).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSourceSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  licenseType: z.enum([
    'apache-2.0', 'mit', 'bsd-2-clause', 'bsd-3-clause', 'cc-by-4.0', 'cc-by-sa-4.0',
    'cc0-1.0', 'mpl-2.0', 'isc', 'unlicense', 'public-domain', 'custom-open', 'unknown',
  ]).optional(),
  refreshIntervalHours: z.number().int().min(1).max(8760).optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const listQuerySchema = z.object({
  domain: z.string().optional(),
  verificationStatus: z.enum(['unverified', 'single_source', 'cross_verified', 'stale', 'conflicted']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const releaseSyncSchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  sourceId: z.string().uuid().optional(),
}).refine((input) => Boolean(input.sourceId) || Boolean(input.owner && input.repo), {
  message: 'sourceId or owner+repo is required',
});

const manualAdvisorySchema = z.object({
  cveId: z.string().regex(/^CVE-\d{4}-\d{4,}$/i),
  ghsaId: z.string().optional(),
  summary: z.string().min(1).max(5000),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']).default('unknown'),
  affectedPackage: z.string().optional(),
  sourceUrl: z.string().url(),
  publishedAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const cveSyncSchema = z.object({
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  advisories: z.array(manualAdvisorySchema).optional(),
}).refine((input) => Boolean(input.advisories?.length) || Boolean(input.owner && input.repo), {
  message: 'advisories or owner+repo is required',
});

const documentsQuerySchema = z.object({
  status: z.enum(['proposed', 'approved', 'deprecated']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const uploadDocumentSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(200_000),
  sourcePath: z.string().max(1000).optional(),
  workspaceId: z.string().uuid().optional(),
  agentType: z.string().max(50).optional(),
  status: z.enum(['proposed', 'approved']).default('proposed'),
  metadata: z.record(z.unknown()).optional(),
});

const hybridSearchSchema = z.object({
  query: z.string().min(1),
  topK: z.coerce.number().int().min(1).max(50).default(10),
  maxTokens: z.coerce.number().int().min(500).max(8000).default(4000),
  includeProposed: z.boolean().default(false),
  keywordWeight: z.coerce.number().min(0).max(1).default(0.55),
  semanticWeight: z.coerce.number().min(0).max(1).default(0.45),
});

function extractValidationIssues(error: unknown): Array<{ path: string; message: string }> | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues;
  if (!Array.isArray(issues)) {
    return null;
  }

  return issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join('.') : '',
    message: typeof issue.message === 'string' ? issue.message : 'Invalid value',
  }));
}

function resolveGithubRepoFromSource(source: {
  sourceUrl: string;
  metadata: Record<string, unknown> | null;
}): { owner: string; repo: string } | null {
  const metadata = source.metadata;
  if (metadata && typeof metadata === 'object') {
    const owner = metadata.owner;
    const repo = metadata.repo;
    if (typeof owner === 'string' && owner && typeof repo === 'string' && repo) {
      return { owner, repo };
    }
  }

  try {
    const parsed = new URL(source.sourceUrl);
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
      return null;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
  } catch {
    return null;
  }
}

export async function knowledgeRoutes(fastify: FastifyInstance) {
  const env = getEnv();
  const githubMcp =
    env.GITHUB_MCP_BASE_URL && env.GITHUB_TOKEN
      ? new GitHubMCPService({
          baseUrl: env.GITHUB_MCP_BASE_URL,
          token: env.GITHUB_TOKEN,
          correlationId: 'knowledge-api',
        })
      : null;
  const securityCollector = new SecuritySignalCollector(githubMcp);

  const writeKnowledgeAudit = async (input: {
    userId: string;
    eventType: string;
    entityType: string;
    entityId?: string;
    payload?: Record<string, unknown>;
  }): Promise<void> => {
    try {
      await db.insert(auditLog).values({
        userId: input.userId,
        eventType: input.eventType,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        payload: input.payload ?? {},
      });
    } catch (error) {
      fastify.log.error(
        {
          err: error,
          eventType: input.eventType,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
        },
        'Knowledge audit write failed'
      );
    }
  };

  // GET /api/knowledge/freshness/status
  fastify.get(
    '/api/knowledge/freshness/status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const scheduler = getFreshnessSchedulerInstance();

        if (!scheduler) {
          return reply.send({
            enabled: false,
            running: false,
            lastRun: null,
            staleSources: [],
            totalSourcesInLastRun: 0,
          });
        }

        const lastResults = scheduler.getLastResults();
        return reply.send({
          enabled: true,
          running: scheduler.isRunning(),
          lastRun: scheduler.getLastRunSummary(),
          staleSources: scheduler.getStaleSources(),
          totalSourcesInLastRun: lastResults.length,
        });
      } catch (err: unknown) {
        const issues = extractValidationIssues(err);
        if (issues) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid request payload',
              details: issues,
            },
          });
        }
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // POST /api/knowledge/freshness/run
  fastify.post(
    '/api/knowledge/freshness/run',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const scheduler = getFreshnessSchedulerInstance();
        if (!scheduler) {
          return reply.code(503).send({
            error: {
              code: 'SCHEDULER_DISABLED',
              message: 'Freshness scheduler is disabled in this environment',
            },
          });
        }

        const summary = await scheduler.runNow();
        return reply.send({
          ok: true,
          summary,
          staleSources: scheduler.getStaleSources(),
        });
      } catch (err: unknown) {
        const issues = extractValidationIssues(err);
        if (issues) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid request payload',
              details: issues,
            },
          });
        }
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // POST /api/knowledge/sources
  fastify.post(
    '/api/knowledge/sources',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const body = createSourceSchema.parse(request.body);

        const [inserted] = await db
          .insert(knowledgeSources)
          .values({
            name: body.name,
            sourceUrl: body.sourceUrl,
            licenseType: body.licenseType,
            accessMethod: body.accessMethod,
            domain: body.domain,
            refreshIntervalHours: body.refreshIntervalHours ?? 168,
            metadata: body.metadata ?? null,
          })
          .returning();

        return reply.code(201).send(inserted);
      } catch (err: unknown) {
        const issues = extractValidationIssues(err);
        if (issues) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid request payload',
              details: issues,
            },
          });
        }
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // GET /api/knowledge/sources
  fastify.get(
    '/api/knowledge/sources',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const query = listQuerySchema.parse(request.query);

        const conditions = [];
        if (query.domain) {
          conditions.push(eq(knowledgeSources.domain, query.domain));
        }
        if (query.verificationStatus) {
          conditions.push(eq(knowledgeSources.verificationStatus, query.verificationStatus));
        }
        if (query.isActive !== undefined) {
          conditions.push(eq(knowledgeSources.isActive, query.isActive === 'true'));
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined;

        const rows = await db
          .select()
          .from(knowledgeSources)
          .where(where)
          .limit(query.limit)
          .offset(query.offset)
          .orderBy(knowledgeSources.createdAt);

        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(knowledgeSources)
          .where(where);

        return reply.send({ items: rows, total: count });
      } catch (err: unknown) {
        const issues = extractValidationIssues(err);
        if (issues) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid request payload',
              details: issues,
            },
          });
        }
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // GET /api/knowledge/sources/:id
  fastify.get(
    '/api/knowledge/sources/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const { id } = (request.params as { id: string });

        const [source] = await db
          .select()
          .from(knowledgeSources)
          .where(eq(knowledgeSources.id, id))
          .limit(1);

        if (!source) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Knowledge source not found' } });
        }

        return reply.send(source);
      } catch (err: unknown) {
        const issues = extractValidationIssues(err);
        if (issues) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid request payload',
              details: issues,
            },
          });
        }
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // PUT /api/knowledge/sources/:id (update)
  fastify.put(
    '/api/knowledge/sources/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const { id } = (request.params as { id: string });
        const body = updateSourceSchema.parse(request.body);

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (body.name !== undefined) updates.name = body.name;
        if (body.licenseType !== undefined) updates.licenseType = body.licenseType;
        if (body.refreshIntervalHours !== undefined) updates.refreshIntervalHours = body.refreshIntervalHours;
        if (body.isActive !== undefined) updates.isActive = body.isActive;
        if (body.metadata !== undefined) updates.metadata = body.metadata;

        const [updated] = await db
          .update(knowledgeSources)
          .set(updates)
          .where(eq(knowledgeSources.id, id))
          .returning();

        if (!updated) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Knowledge source not found' } });
        }

        return reply.send(updated);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // DELETE /api/knowledge/sources/:id — soft-deactivate
  fastify.delete(
    '/api/knowledge/sources/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const { id } = (request.params as { id: string });

        const [deactivated] = await db
          .update(knowledgeSources)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(knowledgeSources.id, id))
          .returning({ id: knowledgeSources.id });

        if (!deactivated) {
          return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Knowledge source not found' } });
        }

        return reply.code(204).send();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // POST /api/knowledge/signals/releases/sync
  fastify.post(
    '/api/knowledge/signals/releases/sync',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const payload = releaseSyncSchema.parse(request.body ?? {});

        if (!githubMcp) {
          return reply.code(503).send({
            error: {
              code: 'MCP_NOT_CONFIGURED',
              message: 'GitHub MCP adapter is not configured for release sync',
            },
          });
        }

        let targetRepo: { owner: string; repo: string } | null = null;
        let sourceRecord: typeof knowledgeSources.$inferSelect | null = null;

        if (payload.sourceId) {
          const [source] = await db
            .select()
            .from(knowledgeSources)
            .where(eq(knowledgeSources.id, payload.sourceId))
            .limit(1);
          if (!source) {
            return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Knowledge source not found' } });
          }
          sourceRecord = source;
          targetRepo = resolveGithubRepoFromSource(source);
        } else if (payload.owner && payload.repo) {
          targetRepo = { owner: payload.owner, repo: payload.repo };
        }

        if (!targetRepo) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Unable to resolve GitHub repository from source',
            },
          });
        }

        const scheduler = getFreshnessSchedulerInstance() ??
          new FreshnessScheduler({
            githubMcp,
            freshnessThresholdDays: env.FRESHNESS_THRESHOLD_DAYS,
            agingThresholdDays: env.FRESHNESS_AGING_THRESHOLD_DAYS,
          });

        const result = await scheduler.checkRepoFreshness(targetRepo.owner, targetRepo.repo);

        if (sourceRecord) {
          const metadata = sourceRecord.metadata && typeof sourceRecord.metadata === 'object'
            ? { ...sourceRecord.metadata }
            : {};

          const nextMetadata = {
            ...metadata,
            freshness: {
              ...(metadata.freshness && typeof metadata.freshness === 'object' ? metadata.freshness : {}),
              ageInDays: result.ageInDays,
              staleness: result.staleness,
              score: result.score ?? scheduler.computeFreshnessScore(result.ageInDays),
              checkedAt: result.lastChecked.toISOString(),
              lastUpdated: result.lastUpdated?.toISOString() ?? null,
              lastReleaseAt: result.lastReleaseAt?.toISOString() ?? null,
              releaseAgeInDays: result.releaseAgeInDays ?? null,
              releaseTag: result.releaseTag ?? null,
              releaseName: result.releaseName ?? null,
              details: result.details ?? null,
            },
          };

          await db
            .update(knowledgeSources)
            .set({
              metadata: nextMetadata,
              lastFetchedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(knowledgeSources.id, sourceRecord.id));
        }

        return reply.send({
          ok: true,
          owner: targetRepo.owner,
          repo: targetRepo.repo,
          result,
          persisted: Boolean(sourceRecord),
        });
      } catch (err: unknown) {
        const issues = extractValidationIssues(err);
        if (issues) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid release sync payload',
              details: issues,
            },
          });
        }
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // POST /api/knowledge/signals/cve/sync
  fastify.post(
    '/api/knowledge/signals/cve/sync',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let user;
      try {
        user = await requireAdmin(request);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }

      const parsedBody = cveSyncSchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid CVE sync payload',
            details: parsedBody.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        });
      }
      const body = parsedBody.data;
      if (!body.advisories?.length && !githubMcp) {
        return reply.code(503).send({
          error: {
            code: 'MCP_NOT_CONFIGURED',
            message: 'GitHub MCP adapter is not configured for advisory sync',
          },
        });
      }

      const summary = body.advisories?.length
        ? await securityCollector.syncManual(
            body.advisories.map((item) => ({
              cveId: item.cveId.toUpperCase(),
              ghsaId: item.ghsaId ?? null,
              summary: item.summary,
              severity: item.severity,
              riskScore: SecuritySignalCollector.computeRiskScore(item.severity),
              affectedPackage: item.affectedPackage ?? null,
              sourceUrl: item.sourceUrl,
              publishedAt: item.publishedAt ?? null,
              updatedAt: item.updatedAt ?? null,
            }))
          )
        : await securityCollector.syncGithubRepo(body.owner!, body.repo!);

      await writeKnowledgeAudit({
        userId: user.id,
        eventType: 'knowledge_cve_sync',
        entityType: 'knowledge_source',
        payload: {
          source: summary.source,
          totalSignals: summary.totalSignals,
          inserted: summary.inserted,
          updated: summary.updated,
          deduped: summary.deduped,
          owner: body.owner ?? null,
          repo: body.repo ?? null,
        },
      });

      return reply.send({ ok: true, summary });
    }
  );

  // GET /api/knowledge/documents
  fastify.get(
    '/api/knowledge/documents',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const query = documentsQuerySchema.parse(request.query);
        const conditions = [];

        if (query.status) {
          conditions.push(eq(knowledgeDocuments.status, query.status));
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined;

        const rows = await db
          .select()
          .from(knowledgeDocuments)
          .where(where)
          .orderBy(desc(knowledgeDocuments.updatedAt))
          .limit(query.limit)
          .offset(query.offset);

        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(knowledgeDocuments)
          .where(where);

        return reply.send({ items: rows, total: count });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );

  // POST /api/knowledge/documents/upload
  fastify.post(
    '/api/knowledge/documents/upload',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let user;
      try {
        user = await requireAdmin(request);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }

      try {
        const body = uploadDocumentSchema.parse(request.body ?? {});
        const result = await repoDocsIngester.ingestManualDocument({
          title: body.title,
          content: body.content,
          sourcePath: body.sourcePath,
          workspaceId: body.workspaceId,
          agentType: body.agentType,
          status: body.status,
          metadata: body.metadata,
        });

        if (!result) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'title and content are required',
            },
          });
        }

        await writeKnowledgeAudit({
          userId: user.id,
          eventType: 'knowledge_document_uploaded',
          entityType: 'knowledge_document',
          entityId: result.documentId,
          payload: {
            title: body.title,
            sourcePath: body.sourcePath ?? null,
            status: body.status,
            chunksCreated: result.chunksCreated,
            isNew: result.isNew,
          },
        });

        const [document] = await db
          .select()
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.id, result.documentId))
          .limit(1);

        return reply.code(result.isNew ? 201 : 200).send({
          ok: true,
          result,
          document: document ?? null,
        });
      } catch (err: unknown) {
        const issues = extractValidationIssues(err);
        if (issues) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid upload payload',
              details: issues,
            },
          });
        }
        throw err;
      }
    }
  );

  // POST /api/knowledge/documents/:id/approve
  fastify.post(
    '/api/knowledge/documents/:id/approve',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let user;
      try {
        user = await requireAdmin(request);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }

      const { id } = request.params as { id: string };
      const approved = await repoDocsIngester.approveDocument(id);
      if (!approved) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Knowledge document not found' } });
      }

      await writeKnowledgeAudit({
        userId: user.id,
        eventType: 'knowledge_document_approved',
        entityType: 'knowledge_document',
        entityId: id,
      });

      const [doc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)).limit(1);
      return reply.send({ ok: true, document: doc ?? null });
    }
  );

  // POST /api/knowledge/documents/:id/deprecate
  fastify.post(
    '/api/knowledge/documents/:id/deprecate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      let user;
      try {
        user = await requireAdmin(request);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }

      const { id } = request.params as { id: string };
      const deprecated = await repoDocsIngester.deprecateDocument(id);
      if (!deprecated) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Knowledge document not found' } });
      }

      await writeKnowledgeAudit({
        userId: user.id,
        eventType: 'knowledge_document_deprecated',
        entityType: 'knowledge_document',
        entityId: id,
      });

      const [doc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)).limit(1);
      return reply.send({ ok: true, document: doc ?? null });
    }
  );

  // POST /api/knowledge/retrieval/hybrid
  fastify.post(
    '/api/knowledge/retrieval/hybrid',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAuth(request);
        const body = hybridSearchSchema.parse(request.body ?? {});

        const results = await knowledgeRetrievalService.searchHybrid(body.query, {
          maxResults: body.topK,
          maxTokens: body.maxTokens,
          includeProposed: body.includeProposed,
          keywordWeight: body.keywordWeight,
          semanticWeight: body.semanticWeight,
        });

        return reply.send({
          query: body.query,
          results,
          count: results.length,
        });
      } catch (err: unknown) {
        const issues = extractValidationIssues(err);
        if (issues) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_INPUT',
              message: 'Invalid hybrid retrieval payload',
              details: issues,
            },
          });
        }
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        throw err;
      }
    }
  );

  // ── Chunks search ──

  const chunkSearchSchema = z.object({
    tag: z.string().optional(),
    query: z.string().optional(),
    verified: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  });

  // GET /api/knowledge/chunks — search chunks by tag, query, verification status
  fastify.get(
    '/api/knowledge/chunks',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await requireAdmin(request);
        const params = chunkSearchSchema.parse(request.query);

        // If tag filter is specified, get chunk IDs that have that tag
        let taggedChunkIds: string[] | undefined;
        if (params.tag) {
          const tagRows = await db
            .select({ chunkId: knowledgeTags.chunkId })
            .from(knowledgeTags)
            .where(eq(knowledgeTags.tag, params.tag));
          taggedChunkIds = tagRows.map(r => r.chunkId);
          if (taggedChunkIds.length === 0) {
            return reply.send({ items: [], total: 0 });
          }
        }

        const conditions = [];
        if (taggedChunkIds && taggedChunkIds.length > 0) {
          conditions.push(inArray(knowledgeChunks.id, taggedChunkIds));
        }
        if (params.query) {
          conditions.push(ilike(knowledgeChunks.content, `%${params.query}%`));
        }

        // If verified=true, filter to chunks that have at least one cross_verified provenance
        if (params.verified === 'true') {
          const verifiedChunkRows = await db
            .select({ chunkId: knowledgeProvenance.chunkId })
            .from(knowledgeProvenance)
            .where(eq(knowledgeProvenance.verificationStatus, 'cross_verified'));
          const verifiedIds = verifiedChunkRows.map(r => r.chunkId);
          if (verifiedIds.length === 0) {
            return reply.send({ items: [], total: 0 });
          }
          conditions.push(inArray(knowledgeChunks.id, verifiedIds));
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined;

        const rows = await db
          .select()
          .from(knowledgeChunks)
          .where(where)
          .limit(params.limit)
          .offset(params.offset)
          .orderBy(knowledgeChunks.createdAt);

        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(knowledgeChunks)
          .where(where);

        return reply.send({ items: rows, total: count });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'UNAUTHORIZED') {
          return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        }
        if (err instanceof Error && err.message === 'FORBIDDEN') {
          return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
        }
        throw err;
      }
    }
  );
}
