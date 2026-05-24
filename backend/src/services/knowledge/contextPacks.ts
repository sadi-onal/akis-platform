/**
 * Context Pack types and utilities — S0.5.2-RAG-2
 *
 * Context packs are deterministic file bundles assembled from repository
 * content for agent consumption. See docs/agents/CONTEXT_PACKS.md.
 */
import { contextPackSchema } from './ContextPackContract.js';

export interface ContextPackFile {
  path: string;
  content: string;
  language: string;
}

export interface ContextPackMetadata {
  repo: string;
  branch: string;
  totalFiles: number;
  truncated: boolean;
  assembledAt: string;
  packId: string;
  packVersion: string;
  profile: string;
  selectedBy: string | null;
}

export interface ContextPack {
  files: ContextPackFile[];
  metadata: ContextPackMetadata;
}

export interface PackLimits {
  maxFiles: number;
  maxTotalBytes: number;
}

export interface ContextPackSelection {
  profile?: string;
  packVersion?: string;
  selectedBy?: string | null;
}

const AGENT_PACK_LIMITS: Record<string, PackLimits> = {
  scribe: { maxFiles: 50, maxTotalBytes: 200_000 },
  trace: { maxFiles: 30, maxTotalBytes: 150_000 },
  proto: { maxFiles: 20, maxTotalBytes: 100_000 },
};

const DEFAULT_LIMITS: PackLimits = { maxFiles: 30, maxTotalBytes: 150_000 };
const AGENT_PACK_PROFILES: Record<string, string[]> = {
  scribe: ['default', 'docs', 'release'],
  trace: ['default', 'tests', 'risk'],
  proto: ['default', 'api', 'scaffold'],
};
export const CONTEXT_PACK_OVERFLOW_STRATEGY = 'truncation';

function simpleHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function getPackLimits(agentType: string): PackLimits {
  return AGENT_PACK_LIMITS[agentType] ?? DEFAULT_LIMITS;
}

export function listPackProfiles(agentType: string): string[] {
  return AGENT_PACK_PROFILES[agentType] ?? ['default'];
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    dockerfile: 'dockerfile',
  };
  const basename = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (basename === 'dockerfile') return 'dockerfile';
  return map[ext] ?? 'text';
}

export interface ValidatePackResult {
  valid: boolean;
  errors: string[];
}

export function validatePack(pack: unknown, agentType: string): ValidatePackResult {
  const errors: string[] = [];
  const parsed = contextPackSchema.safeParse(pack);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'pack'}: ${issue.message}`
      ),
    };
  }

  const { files, metadata } = parsed.data;
  const limits = getPackLimits(agentType);

  if (files.length > limits.maxFiles) {
    errors.push(`Pack has ${files.length} files, max for ${agentType} is ${limits.maxFiles}`);
  }

  let totalBytes = 0;
  for (const file of files) {
    if (!file.path || typeof file.path !== 'string') {
      errors.push('Each file must have a string path');
    }
    if (typeof file.content !== 'string') {
      errors.push(`File ${file.path}: content must be a string`);
    }
    totalBytes += file.content?.length ?? 0;
  }

  if (totalBytes > limits.maxTotalBytes) {
    errors.push(
      `Pack total size ${totalBytes} bytes exceeds limit ${limits.maxTotalBytes} for ${agentType}`
    );
  }

  if (typeof metadata.repo !== 'string' || !metadata.repo.includes('/')) {
    errors.push('metadata.repo must be in "owner/repo" format');
  }

  if (typeof metadata.branch !== 'string' || metadata.branch.length === 0) {
    errors.push('metadata.branch is required');
  }

  if (metadata.totalFiles !== files.length) {
    errors.push('metadata.totalFiles must match files.length');
  }

  const allowedProfiles = listPackProfiles(agentType);
  if (!allowedProfiles.includes(metadata.profile)) {
    errors.push(`metadata.profile must be one of: ${allowedProfiles.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

export function assembleContextPack(
  agentType: string,
  repo: string,
  branch: string,
  files: Array<{ path: string; content: string }>,
  selection: ContextPackSelection = {}
): ContextPack {
  const limits = getPackLimits(agentType);
  const profiles = listPackProfiles(agentType);
  if (selection.profile && !profiles.includes(selection.profile)) {
    throw new Error(
      `Invalid context pack profile "${selection.profile}" for ${agentType}. Allowed: ${profiles.join(', ')}`
    );
  }
  const profile = selection.profile ?? 'default';
  const packVersion =
    selection.packVersion && selection.packVersion.length > 0 ? selection.packVersion : 'v1';

  let totalBytes = 0;
  let truncated = false;
  const packFiles: ContextPackFile[] = [];

  for (const file of files) {
    if (packFiles.length >= limits.maxFiles) {
      truncated = true;
      break;
    }

    let content = file.content;
    if (totalBytes + content.length > limits.maxTotalBytes) {
      const remaining = limits.maxTotalBytes - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      content = content.slice(0, remaining);
      truncated = true;
    }

    packFiles.push({
      path: file.path,
      content,
      language: detectLanguage(file.path),
    });
    totalBytes += content.length;
  }

  const signature = `${agentType}|${repo}|${branch}|${profile}|${packVersion}|${packFiles.map((f) => `${f.path}:${f.content.length}`).join(',')}`;
  const packId = `cp_${simpleHash(signature)}`;

  return {
    files: packFiles,
    metadata: {
      repo,
      branch,
      totalFiles: packFiles.length,
      truncated,
      assembledAt: new Date().toISOString(),
      packId,
      packVersion,
      profile,
      selectedBy: selection.selectedBy ?? null,
    },
  };
}
