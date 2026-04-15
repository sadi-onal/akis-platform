/**
 * Auto-ingest pipeline outputs into the knowledge base.
 *
 * When a pipeline completes, this service:
 * 1. Converts Scribe's spec into a knowledge document
 * 2. Indexes Proto's file manifest as metadata
 * 3. Records Trace's test results and coverage matrix
 *
 * All documents are user-scoped (workspaceId = userId) and
 * project-scoped (projectId = pipelineId) for isolation.
 */

import { RepoDocsIngester } from './RepoDocsIngester.js';
import { logger } from '../../../lib/logger.js';
import type { StructuredSpec } from '../../../pipeline/core/contracts/PipelineTypes.js';

interface PipelineCompletionData {
  pipelineId: string;
  userId: string;
  spec?: StructuredSpec;
  specMarkdown?: string;
  protoFiles?: Array<{ filePath: string; linesOfCode: number }>;
  repoName?: string;
  repoOwner?: string;
  branch?: string;
  traceTestSummary?: { totalTests: number; coveragePercentage?: number; frameworks?: string[] };
  traceCoverageMatrix?: Record<string, string[]>;
}

export class PipelineKnowledgeIngester {
  private ingester = new RepoDocsIngester();

  async ingestPipelineResults(data: PipelineCompletionData): Promise<{ documentsCreated: number }> {
    let documentsCreated = 0;

    try {
      // 1. Scribe spec → knowledge document
      if (data.spec && data.specMarkdown) {
        const specContent = this.formatSpecForKB(data.spec, data.specMarkdown);
        const result = await this.ingester.ingestManualDocument({
          title: `Spec: ${data.spec.title}`,
          content: specContent,
          workspaceId: data.userId,
          agentType: 'scribe',
          status: 'approved',
          metadata: {
            pipelineId: data.pipelineId,
            projectId: data.pipelineId,
            repoName: data.repoName,
            repoOwner: data.repoOwner,
            specTitle: data.spec.title,
            userStoryCount: data.spec.userStories?.length ?? 0,
            acCount: data.spec.acceptanceCriteria?.length ?? 0,
          },
        });
        if (result?.isNew) documentsCreated++;
      }

      // 2. Proto file manifest → knowledge document
      if (data.protoFiles && data.protoFiles.length > 0) {
        const protoContent = this.formatProtoManifest(data);
        const result = await this.ingester.ingestManualDocument({
          title: `Scaffold: ${data.repoName ?? 'project'}`,
          content: protoContent,
          workspaceId: data.userId,
          agentType: 'proto',
          status: 'approved',
          metadata: {
            pipelineId: data.pipelineId,
            projectId: data.pipelineId,
            repoName: data.repoName,
            repoOwner: data.repoOwner,
            branch: data.branch,
            fileCount: data.protoFiles.length,
            totalLines: data.protoFiles.reduce((s, f) => s + f.linesOfCode, 0),
          },
        });
        if (result?.isNew) documentsCreated++;
      }

      // 3. Trace test results → knowledge document
      if (data.traceTestSummary) {
        const traceContent = this.formatTraceResults(data);
        const result = await this.ingester.ingestManualDocument({
          title: `Tests: ${data.repoName ?? 'project'}`,
          content: traceContent,
          workspaceId: data.userId,
          agentType: 'trace',
          status: 'approved',
          metadata: {
            pipelineId: data.pipelineId,
            projectId: data.pipelineId,
            repoName: data.repoName,
            totalTests: data.traceTestSummary.totalTests,
            ...(data.traceTestSummary.frameworks ? { frameworks: data.traceTestSummary.frameworks } : {}),
          },
        });
        if (result?.isNew) documentsCreated++;
      }

      logger.info(`[PipelineKnowledgeIngester] Ingested ${documentsCreated} documents for pipeline ${data.pipelineId}`);
    } catch (err) {
      logger.warn(`[PipelineKnowledgeIngester] Ingestion failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    return { documentsCreated };
  }

  private formatSpecForKB(spec: StructuredSpec, _markdown: string): string {
    const parts = [
      `# ${spec.title}`,
      '',
      `## Problem`,
      spec.problemStatement,
      '',
      `## User Stories`,
      ...(spec.userStories ?? []).map(us => `- ${us.persona}: ${us.action} → ${us.benefit}`),
      '',
      `## Acceptance Criteria`,
      ...(spec.acceptanceCriteria ?? []).map(ac => `- [${ac.id}] Given ${ac.given}, When ${ac.when}, Then ${ac.then}`),
      '',
      `## Technical Constraints`,
      `Stack: ${spec.technicalConstraints?.stack ?? 'N/A'}`,
      `Integrations: ${(spec.technicalConstraints?.integrations ?? []).join(', ')}`,
      '',
      `## Out of Scope`,
      ...(spec.outOfScope ?? []).map(s => `- ${s}`),
    ];
    return parts.join('\n');
  }

  private formatProtoManifest(data: PipelineCompletionData): string {
    const parts = [
      `# Scaffold: ${data.repoName}`,
      `Repo: ${data.repoOwner}/${data.repoName} (branch: ${data.branch ?? 'main'})`,
      '',
      `## Files (${data.protoFiles!.length} total)`,
      ...data.protoFiles!.map(f => `- ${f.filePath} (${f.linesOfCode} lines)`),
    ];
    return parts.join('\n');
  }

  private formatTraceResults(data: PipelineCompletionData): string {
    const parts = [
      `# Test Results: ${data.repoName}`,
      `Total Tests: ${data.traceTestSummary!.totalTests}`,
      ...(data.traceTestSummary!.frameworks ? [`Frameworks: ${data.traceTestSummary!.frameworks.join(', ')}`] : []),
    ];

    if (data.traceCoverageMatrix) {
      parts.push('', '## Coverage Matrix');
      for (const [acId, files] of Object.entries(data.traceCoverageMatrix)) {
        parts.push(`- ${acId}: ${files.join(', ')}`);
      }
    }

    return parts.join('\n');
  }
}
