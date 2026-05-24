import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db/client.js';
import {
  auditLog,
  jobPosts,
  matches,
  portfolios,
  profiles,
  proposals,
  skills,
} from '../db/schema.js';
import { sendError } from '../utils/errorHandler.js';
import { requireAuth } from '../utils/auth.js';
import { ingestJobs } from '../services/marketplace/ingestion-service.js';
import { generateProposalDraft } from '../services/marketplace/proposal-service.js';
import { scoreMarketplaceMatch, upsertMatchRecord } from '../services/marketplace/matching-service.js';
import { mapJobRecord, mapProfileRecord, type IngestPayload } from '../services/marketplace/types.js';

const profileInputSchema = z.object({
  headline: z.string().max(255).optional(),
  bio: z.string().max(5000).optional(),
  seniority: z.string().max(50).optional(),
  languages: z.array(z.string().max(20)).optional(),
  preferredLocations: z.array(z.string().max(255)).optional(),
  remoteOnly: z.boolean().optional(),
  salaryFloor: z.number().int().nonnegative().optional(),
  excludedIndustries: z.array(z.string().max(120)).optional(),
  skills: z.array(z.object({
    name: z.string().min(1).max(120),
    level: z.number().int().min(1).max(5).optional(),
    yearsExperience: z.number().min(0).max(60).optional(),
  })).optional(),
  portfolios: z.array(z.object({
    title: z.string().min(1).max(255),
    description: z.string().max(5000).optional(),
    url: z.string().url().max(2000).optional(),
    tags: z.array(z.string().max(100)).optional(),
  })).optional(),
});

const jobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const ingestSchema = z.object({
  source: z.string().min(1).max(255).default('manual'),
  jobs: z.array(z.object({
    externalId: z.string().max(255).optional(),
    title: z.string().min(1).max(500),
    description: z.string().min(1).max(12000),
    requiredSkills: z.array(z.string().max(120)).optional(),
    seniority: z.string().max(50).optional(),
    language: z.string().max(20).optional(),
    location: z.string().max(255).optional(),
    remoteAllowed: z.boolean().optional(),
    keywords: z.array(z.string().max(120)).optional(),
    budgetMin: z.number().nonnegative().optional(),
    budgetMax: z.number().nonnegative().optional(),
    currency: z.string().max(8).optional(),
    rawPayload: z.record(z.unknown()).optional(),
  })).min(1),
});

const runMatchSchema = z.object({
  jobIds: z.array(z.string().uuid()).optional(),
});

const listMatchesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const proposalSchema = z.object({
  jobPostId: z.string().uuid(),
});

async function writeAuditEvent(input: {
  userId: string;
  eventType: string;
  entityType: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditLog).values({
    userId: input.userId,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    payload: input.payload ?? {},
  });
}

async function getProfileByUserId(userId: string) {
  return db.query.profiles.findFirst({
    where: eq(profiles.userId, userId),
  });
}

export async function marketplaceRoutes(fastify: FastifyInstance) {
  fastify.post('/api/profile', async (request: FastifyRequest, reply: FastifyReply) => {
    let user;
    try {
      user = await requireAuth(request);
    } catch {
      return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    }

    let body;
    try {
      body = profileInputSchema.parse(request.body);
    } catch {
      return sendError(reply, request, 'VALIDATION_ERROR', 'Invalid profile payload');
    }

    const now = new Date();
    const existing = await getProfileByUserId(user.id);

    const values = {
      headline: body.headline ?? null,
      bio: body.bio ?? null,
      seniority: body.seniority ?? 'mid',
      languages: body.languages ?? [],
      preferredLocations: body.preferredLocations ?? [],
      remoteOnly: body.remoteOnly ?? false,
      salaryFloor: body.salaryFloor ?? null,
      excludedIndustries: body.excludedIndustries ?? [],
      updatedAt: now,
    };

    const profileId = existing
      ? existing.id
      : (await db.insert(profiles).values({ ...values, userId: user.id }).returning({ id: profiles.id }))[0].id;

    if (existing) {
      await db.update(profiles).set(values).where(eq(profiles.id, existing.id));
    }

    if (body.skills) {
      await db.delete(skills).where(eq(skills.profileId, profileId));
      if (body.skills.length > 0) {
        await db.insert(skills).values(
          body.skills.map((item) => ({
            profileId,
            name: item.name.trim().toLowerCase(),
            level: item.level ?? 3,
            yearsExperience: typeof item.yearsExperience === 'number'
              ? item.yearsExperience.toFixed(1)
              : null,
          })),
        );
      }
    }

    if (body.portfolios) {
      await db.delete(portfolios).where(eq(portfolios.profileId, profileId));
      if (body.portfolios.length > 0) {
        await db.insert(portfolios).values(
          body.portfolios.map((item) => ({
            profileId,
            title: item.title,
            description: item.description ?? null,
            url: item.url ?? null,
            tags: item.tags ?? [],
          })),
        );
      }
    }

    await writeAuditEvent({
      userId: user.id,
      eventType: existing ? 'profile_updated' : 'profile_created',
      entityType: 'profile',
      entityId: profileId,
      payload: {
        hasSkills: Boolean(body.skills),
        hasPortfolios: Boolean(body.portfolios),
      },
    });

    const [profileRow, profileSkills, profilePortfolios] = await Promise.all([
      db.query.profiles.findFirst({ where: eq(profiles.id, profileId) }),
      db.select().from(skills).where(eq(skills.profileId, profileId)),
      db.select().from(portfolios).where(eq(portfolios.profileId, profileId)),
    ]);

    return reply.send({
      profile: profileRow,
      skills: profileSkills,
      portfolios: profilePortfolios,
    });
  });

  fastify.get('/api/jobs', { preHandler: [requireAuth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    // Job postings are intentionally visible to all authenticated users (marketplace)
    const query = jobsQuerySchema.parse(request.query);

    const [items, totalRows] = await Promise.all([
      db
        .select()
        .from(jobPosts)
        .orderBy(desc(jobPosts.ingestedAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(jobPosts),
    ]);

    return reply.send({
      items,
      total: totalRows[0]?.count ?? 0,
    });
  });

  fastify.post('/api/jobs/ingest', async (request: FastifyRequest, reply: FastifyReply) => {
    let user;
    try {
      user = await requireAuth(request);
    } catch {
      return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    }

    let payload: IngestPayload;
    try {
      payload = ingestSchema.parse(request.body);
    } catch {
      return sendError(reply, request, 'VALIDATION_ERROR', 'Invalid ingest payload');
    }

    const result = await ingestJobs(payload);

    await writeAuditEvent({
      userId: user.id,
      eventType: 'jobs_ingested',
      entityType: 'job_source',
      entityId: result.sourceId,
      payload: {
        source: payload.source,
        ingested: result.ingested,
      },
    });

    return reply.code(201).send({ ingested: result.ingested });
  });

  fastify.post('/api/match/run', async (request: FastifyRequest, reply: FastifyReply) => {
    let user;
    try {
      user = await requireAuth(request);
    } catch {
      return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    }

    let body;
    try {
      body = runMatchSchema.parse(request.body ?? {});
    } catch {
      return sendError(reply, request, 'VALIDATION_ERROR', 'Invalid match request');
    }

    const profile = await getProfileByUserId(user.id);
    if (!profile) {
      return sendError(reply, request, 'NOT_FOUND', 'Profile not found. Complete onboarding first.');
    }

    const profileSkills = await db
      .select({ name: skills.name })
      .from(skills)
      .where(eq(skills.profileId, profile.id));

    const jobs = body.jobIds && body.jobIds.length > 0
      ? await db.select().from(jobPosts).where(inArray(jobPosts.id, body.jobIds))
      : await db.select().from(jobPosts).orderBy(desc(jobPosts.ingestedAt)).limit(100);

    let processed = 0;
    for (const job of jobs) {
      const result = scoreMarketplaceMatch({
        profile: mapProfileRecord(profile),
        profileSkills: profileSkills.map((item) => item.name),
        job: mapJobRecord(job),
      });

      await upsertMatchRecord({
        profileId: profile.id,
        jobPostId: job.id,
        score: result.score,
        explanation: result.explanation,
      });

      processed += 1;
    }

    await writeAuditEvent({
      userId: user.id,
      eventType: 'match_run',
      entityType: 'profile',
      entityId: profile.id,
      payload: {
        processed,
        filteredByJobIds: Boolean(body.jobIds && body.jobIds.length > 0),
      },
    });

    return reply.send({ created: processed });
  });

  fastify.get('/api/match', async (request: FastifyRequest, reply: FastifyReply) => {
    let user;
    try {
      user = await requireAuth(request);
    } catch {
      return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    }

    const query = listMatchesSchema.parse(request.query);
    const profile = await getProfileByUserId(user.id);

    if (!profile) {
      return reply.send({ items: [], total: 0 });
    }

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: matches.id,
          profileId: matches.profileId,
          jobPostId: matches.jobPostId,
          score: matches.score,
          explanation: matches.explanation,
          status: matches.status,
          createdAt: matches.createdAt,
          updatedAt: matches.updatedAt,
          jobTitle: jobPosts.title,
          jobLocation: jobPosts.location,
          remoteAllowed: jobPosts.remoteAllowed,
          jobLanguage: jobPosts.language,
        })
        .from(matches)
        .innerJoin(jobPosts, eq(jobPosts.id, matches.jobPostId))
        .where(eq(matches.profileId, profile.id))
        .orderBy(desc(matches.updatedAt))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(matches).where(eq(matches.profileId, profile.id)),
    ]);

    return reply.send({
      items: rows.map((row) => ({
        ...row,
        score: Number(row.score),
      })),
      total: totalRows[0]?.count ?? 0,
    });
  });

  fastify.post('/api/proposals/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    let user;
    try {
      user = await requireAuth(request);
    } catch {
      return sendError(reply, request, 'UNAUTHORIZED', 'Authentication required');
    }

    let body;
    try {
      body = proposalSchema.parse(request.body);
    } catch {
      return sendError(reply, request, 'VALIDATION_ERROR', 'Invalid proposal request');
    }

    const profile = await getProfileByUserId(user.id);
    if (!profile) {
      return sendError(reply, request, 'NOT_FOUND', 'Profile not found. Complete onboarding first.');
    }

    const job = await db.query.jobPosts.findFirst({
      where: eq(jobPosts.id, body.jobPostId),
    });

    if (!job) {
      return sendError(reply, request, 'NOT_FOUND', 'Job post not found');
    }

    const profileSkills = await db
      .select({ name: skills.name })
      .from(skills)
      .where(eq(skills.profileId, profile.id));

    const existingMatch = await db.query.matches.findFirst({
      where: and(eq(matches.profileId, profile.id), eq(matches.jobPostId, job.id)),
    });

    const explanation = existingMatch?.explanation as { missing_skills?: string[] } | null;
    const missingSkills = Array.isArray(explanation?.missing_skills) ? explanation.missing_skills : [];

    const draft = await generateProposalDraft({
      profile: mapProfileRecord(profile),
      job: mapJobRecord(job),
      skills: profileSkills.map((item) => item.name),
      missingSkills,
    });

    const [created] = await db.insert(proposals).values({
      profileId: profile.id,
      jobPostId: job.id,
      content: draft.content,
      source: draft.source,
      metadata: draft.metadata,
      updatedAt: new Date(),
    }).returning();

    await writeAuditEvent({
      userId: user.id,
      eventType: 'proposal_generated',
      entityType: 'proposal',
      entityId: created.id,
      payload: {
        source: draft.source,
        jobPostId: job.id,
      },
    });

    return reply.code(201).send({ proposal: created });
  });
}
