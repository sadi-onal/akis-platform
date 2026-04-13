/**
 * FreshnessScheduler — DB-backed stale knowledge detection.
 *
 * M2-FP-1:
 * - scans `knowledge_sources` due records
 * - classifies freshness deterministically
 * - updates `verificationStatus` + `staleAt` + `nextFetchAt`
 * - exposes last run status for admin visibility
 */

import { and, eq, isNull, lte, or } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { db } from '../../db/client.js';
import { knowledgeSources, type KnowledgeSource } from '../../db/schema.js';
import type { GitHubLatestRelease, GitHubMCPService } from '../mcp/adapters/GitHubMCPService.js';

// =============================================================================
// Types
// =============================================================================

export type FreshnessStaleness = 'fresh' | 'aging' | 'stale' | 'unknown';

export interface FreshnessCheckResult {
  sourceId: string;
  sourceName: string;
  sourceType: 'github_repo' | 'documentation' | 'manual';
  lastChecked: Date;
  lastUpdated?: Date;
  lastReleaseAt?: Date;
  releaseAgeInDays?: number;
  releaseTag?: string | null;
  releaseName?: string | null;
  isFresh: boolean;
  ageInDays: number;
  score?: number;
  staleness: FreshnessStaleness;
  details?: string;
}

export interface FreshnessRunSummary {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  sourcesChecked: number;
  staleSources: number;
  agingSources: number;
  unknownSources: number;
  errorCount: number;
}

export interface FreshnessSchedulerConfig {
  /** Optional GitHub MCP service for repo freshness checks. */
  githubMcp?: GitHubMCPService | null;
  /** Check interval in milliseconds (default: 6 hours). */
  intervalMs?: number;
  /** Freshness threshold in days (default: 90). */
  freshnessThresholdDays?: number;
  /** Aging threshold in days (default: 45). */
  agingThresholdDays?: number;
}

// =============================================================================
// FreshnessScheduler
// =============================================================================

export class FreshnessScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private githubMcp: GitHubMCPService | null;
  private intervalMs: number;
  private freshnessThresholdDays: number;
  private agingThresholdDays: number;
  private lastResults: FreshnessCheckResult[] = [];
  private lastRunSummary: FreshnessRunSummary | null = null;
  private running = false;

  constructor(config: FreshnessSchedulerConfig) {
    this.githubMcp = config.githubMcp ?? null;
    this.intervalMs = config.intervalMs ?? 6 * 60 * 60 * 1000; // 6h
    this.freshnessThresholdDays = config.freshnessThresholdDays ?? 90;
    this.agingThresholdDays = config.agingThresholdDays ?? 45;
  }

  start(): void {
    if (this.timer) return;

    logger.info(
      `[FreshnessScheduler] Starting (interval=${Math.round(this.intervalMs / 60000)}m, threshold=${this.freshnessThresholdDays}d, aging=${this.agingThresholdDays}d)`
    );

    void this.runCheck().catch((error) => {
      logger.warn('[FreshnessScheduler] Initial check failed:', error);
    });

    this.timer = setInterval(() => {
      void this.runCheck().catch((error) => {
        logger.warn('[FreshnessScheduler] Scheduled check failed:', error);
      });
    }, this.intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('[FreshnessScheduler] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  async runNow(): Promise<FreshnessRunSummary | null> {
    await this.runCheck();
    return this.lastRunSummary;
  }

  getLastRunSummary(): FreshnessRunSummary | null {
    return this.lastRunSummary;
  }

  getLastResults(): readonly FreshnessCheckResult[] {
    return this.lastResults;
  }

  getStaleSources(): FreshnessCheckResult[] {
    return this.lastResults.filter((result) => result.staleness === 'stale');
  }

  async checkRepoFreshness(owner: string, repo: string): Promise<FreshnessCheckResult> {
    const now = new Date();
    const sourceId = `github:${owner}/${repo}`;

    if (!this.githubMcp) {
      return {
        sourceId,
        sourceName: `${owner}/${repo}`,
        sourceType: 'github_repo',
        lastChecked: now,
        isFresh: false,
        ageInDays: -1,
        staleness: 'unknown',
        details: 'GitHub MCP adapter is not configured',
      };
    }

    try {
      const repoInfo = await this.githubMcp.callToolRaw('get_repository', { owner, repo });
      const latestRelease =
        typeof this.githubMcp.getLatestRelease === 'function'
          ? await this.githubMcp.getLatestRelease(owner, repo)
          : null;
      let lastUpdated: Date | undefined;
      let details: string | undefined;

      if (repoInfo && typeof repoInfo === 'object') {
        const info = repoInfo as Record<string, unknown>;
        if (typeof info.pushed_at === 'string') {
          lastUpdated = new Date(info.pushed_at);
        } else if (typeof info.updated_at === 'string') {
          lastUpdated = new Date(info.updated_at);
        }
        if (typeof info.description === 'string') {
          details = info.description;
        }
      }

      const ageInDays = lastUpdated
        ? Math.floor((now.getTime() - lastUpdated.getTime()) / (24 * 60 * 60 * 1000))
        : -1;
      const releaseAgeInDays = this.computeReleaseAgeInDays(now, latestRelease);
      const commitScore = ageInDays >= 0 ? this.computeFreshnessScore(ageInDays) : null;
      const releaseScore = releaseAgeInDays >= 0 ? this.computeFreshnessScore(releaseAgeInDays) : null;
      const combinedScore = this.combineFreshnessScores(commitScore, releaseScore);
      const staleness = this.classifyStalenessByScore(combinedScore, ageInDays, releaseAgeInDays);

      const normalizedAgeInDays = ageInDays >= 0 ? ageInDays : releaseAgeInDays;
      const releaseSuffix =
        latestRelease?.publishedAt
          ? ` release=${latestRelease.tagName ?? latestRelease.name ?? latestRelease.publishedAt.toISOString()}`
          : '';
      details = `${details ?? ''}${releaseSuffix}`.trim();

      return {
        sourceId,
        sourceName: `${owner}/${repo}`,
        sourceType: 'github_repo',
        lastChecked: now,
        lastUpdated,
        lastReleaseAt: latestRelease?.publishedAt ?? undefined,
        releaseAgeInDays: releaseAgeInDays >= 0 ? releaseAgeInDays : undefined,
        releaseTag: latestRelease?.tagName ?? null,
        releaseName: latestRelease?.name ?? null,
        isFresh: staleness === 'fresh',
        ageInDays: normalizedAgeInDays >= 0 ? normalizedAgeInDays : -1,
        score: combinedScore,
        staleness,
        details,
      };
    } catch (error) {
      return {
        sourceId,
        sourceName: `${owner}/${repo}`,
        sourceType: 'github_repo',
        lastChecked: now,
        isFresh: false,
        ageInDays: -1,
        staleness: 'unknown',
        details: `GitHub check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
  }

  computeFreshnessScore(ageInDays: number): number {
    if (ageInDays < 0) return 0;
    if (ageInDays <= this.agingThresholdDays) return 1.0;
    if (ageInDays >= this.freshnessThresholdDays * 2) return 0;

    const range = this.freshnessThresholdDays * 2 - this.agingThresholdDays;
    const position = ageInDays - this.agingThresholdDays;
    return Math.max(0, Math.round((1 - position / range) * 100) / 100);
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private async runCheck(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const startedAt = new Date();
    let errorCount = 0;

    try {
      const dueSources = await db
        .select()
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.isActive, true),
            or(isNull(knowledgeSources.nextFetchAt), lte(knowledgeSources.nextFetchAt, startedAt))
          )
        )
        .limit(500);

      const results: FreshnessCheckResult[] = [];

      for (const source of dueSources) {
        try {
          const result = await this.checkSourceFreshness(source, startedAt);
          results.push(result);
          await this.persistSourceFreshness(source, result, startedAt);
        } catch (error) {
          errorCount += 1;
          results.push({
            sourceId: source.id,
            sourceName: source.name,
            sourceType: this.resolveSourceType(source),
            lastChecked: startedAt,
            isFresh: false,
            ageInDays: -1,
            staleness: 'unknown',
            details: `Scheduler source update failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          });
        }
      }

      this.lastResults = results;

      const finishedAt = new Date();
      const staleSources = results.filter((result) => result.staleness === 'stale').length;
      const agingSources = results.filter((result) => result.staleness === 'aging').length;
      const unknownSources = results.filter((result) => result.staleness === 'unknown').length;

      this.lastRunSummary = {
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        sourcesChecked: results.length,
        staleSources,
        agingSources,
        unknownSources,
        errorCount,
      };

      logger.info(
        `[FreshnessScheduler] Check complete: checked=${results.length}, stale=${staleSources}, aging=${agingSources}, unknown=${unknownSources}, errors=${errorCount}`
      );
    } finally {
      this.running = false;
    }
  }

  private async checkSourceFreshness(
    source: KnowledgeSource,
    checkedAt: Date
  ): Promise<FreshnessCheckResult> {
    const sourceType = this.resolveSourceType(source);

    if (sourceType === 'github_repo') {
      const repo = this.resolveGithubRepo(source);
      if (repo) {
        const repoResult = await this.checkRepoFreshness(repo.owner, repo.repo);
        return {
          ...repoResult,
          sourceId: source.id,
          sourceName: source.name,
          sourceType,
          lastChecked: checkedAt,
        };
      }
    }

    const lastUpdated = this.resolveLastUpdatedAt(source);
    const ageInDays = lastUpdated
      ? Math.floor((checkedAt.getTime() - lastUpdated.getTime()) / (24 * 60 * 60 * 1000))
      : -1;

    const staleness = this.classifyStaleness(ageInDays);
    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceType,
      lastChecked: checkedAt,
      lastUpdated: lastUpdated ?? undefined,
      isFresh: staleness === 'fresh',
      ageInDays: ageInDays < 0 ? -1 : ageInDays,
      score: this.computeFreshnessScore(ageInDays),
      staleness,
    };
  }

  private async persistSourceFreshness(
    source: KnowledgeSource,
    result: FreshnessCheckResult,
    checkedAt: Date
  ): Promise<void> {
    const refreshIntervalHours = source.refreshIntervalHours ?? 168;
    const nextFetchAt = new Date(checkedAt.getTime() + refreshIntervalHours * 60 * 60 * 1000);
    const staleAt = result.staleness === 'stale' ? checkedAt : null;

    const nextVerificationStatus =
      result.staleness === 'stale'
        ? 'stale'
        : source.verificationStatus === 'stale'
          ? 'single_source'
          : source.verificationStatus;

    const metadata = this.mergeFreshnessMetadata(source.metadata, result);

    await db
      .update(knowledgeSources)
      .set({
        lastFetchedAt: checkedAt,
        nextFetchAt,
        staleAt,
        verificationStatus: nextVerificationStatus,
        metadata,
        updatedAt: checkedAt,
      })
      .where(eq(knowledgeSources.id, source.id));
  }

  private mergeFreshnessMetadata(
    existing: Record<string, unknown> | null,
    result: FreshnessCheckResult
  ): Record<string, unknown> {
    const metadata = existing && typeof existing === 'object' ? { ...existing } : {};
    return {
      ...metadata,
      freshness: {
        ageInDays: result.ageInDays,
        staleness: result.staleness,
        score: result.score ?? this.computeFreshnessScore(result.ageInDays),
        checkedAt: result.lastChecked.toISOString(),
        lastUpdated: result.lastUpdated?.toISOString() ?? null,
        lastReleaseAt: result.lastReleaseAt?.toISOString() ?? null,
        releaseAgeInDays: result.releaseAgeInDays ?? null,
        releaseTag: result.releaseTag ?? null,
        releaseName: result.releaseName ?? null,
        details: result.details ?? null,
      },
    };
  }

  private computeReleaseAgeInDays(now: Date, release: GitHubLatestRelease | null): number {
    if (!release?.publishedAt) {
      return -1;
    }
    return Math.floor((now.getTime() - release.publishedAt.getTime()) / (24 * 60 * 60 * 1000));
  }

  private combineFreshnessScores(
    commitScore: number | null,
    releaseScore: number | null
  ): number {
    if (commitScore === null && releaseScore === null) {
      return 0;
    }
    if (commitScore === null) {
      return releaseScore ?? 0;
    }
    if (releaseScore === null) {
      return commitScore;
    }
    return Math.round((commitScore * 0.6 + releaseScore * 0.4) * 100) / 100;
  }

  private classifyStalenessByScore(
    score: number,
    commitAgeInDays: number,
    releaseAgeInDays: number
  ): FreshnessStaleness {
    if (commitAgeInDays < 0 && releaseAgeInDays < 0) {
      return 'unknown';
    }
    if (score >= 0.7) {
      return 'fresh';
    }
    if (score >= 0.35) {
      return 'aging';
    }
    return 'stale';
  }

  private resolveSourceType(
    source: Pick<KnowledgeSource, 'accessMethod' | 'sourceUrl'>
  ): FreshnessCheckResult['sourceType'] {
    if (source.accessMethod === 'manual_upload') return 'manual';
    if (source.sourceUrl.includes('github.com')) return 'github_repo';
    return 'documentation';
  }

  private resolveLastUpdatedAt(source: KnowledgeSource): Date | null {
    if (source.lastFetchedAt) {
      return source.lastFetchedAt;
    }

    const metadata = source.metadata;
    if (metadata && typeof metadata === 'object') {
      const value =
        (metadata as Record<string, unknown>).lastUpdatedAt ??
        (metadata as Record<string, unknown>).lastUpdated;
      if (typeof value === 'string') {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
    }
    return null;
  }

  private resolveGithubRepo(source: KnowledgeSource): { owner: string; repo: string } | null {
    const metadata = source.metadata;
    if (metadata && typeof metadata === 'object') {
      const owner = (metadata as Record<string, unknown>).owner;
      const repo = (metadata as Record<string, unknown>).repo;
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

  private classifyStaleness(ageInDays: number): FreshnessStaleness {
    if (ageInDays < 0) return 'unknown';
    if (ageInDays <= this.agingThresholdDays) return 'fresh';
    if (ageInDays <= this.freshnessThresholdDays) return 'aging';
    return 'stale';
  }
}

// =============================================================================
// Runtime singleton
// =============================================================================

let freshnessSchedulerInstance: FreshnessScheduler | null = null;

export function setFreshnessSchedulerInstance(instance: FreshnessScheduler | null): void {
  freshnessSchedulerInstance = instance;
}

export function getFreshnessSchedulerInstance(): FreshnessScheduler | null {
  return freshnessSchedulerInstance;
}
