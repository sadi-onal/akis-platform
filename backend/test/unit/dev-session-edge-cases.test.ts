/**
 * Unit tests: Dev Session & Conversation Management — Edge Cases
 *
 * Covers schema validation, pure logic, and state machine behavior
 * for the dev session plugin and conversation threads API.
 * No DB required — all tests use in-memory simulations.
 *
 * Dev Session scenarios:
 *   1. Start session — creates new session record
 *   2. Start session when one already exists — returns existing
 *   3. Send message to active session — adds to messages
 *   4. Push changes — creates commit record
 *   5. Close session — sets status to closed
 *   6. Session not found — proper error
 *
 * Conversation Management scenarios:
 *   7. Create conversation — valid title, userId
 *   8. List conversations — user-scoped, sorted by date
 *   9. Rename conversation — update title
 *  10. Delete conversation — remove from store
 *  11. Empty conversation list — returns empty array
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// ═════════════════════════════════════════════════════════════════════════════
// Part A: DevAgent — parseResponse logic (extracted for unit testing)
// ═════════════════════════════════════════════════════════════════════════════

interface FileChange {
  action: 'create' | 'modify' | 'delete';
  path: string;
  content?: string;
}

interface FileTreeNode {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileTreeNode[];
}

/** Mirrors DevAgent.parseFileChanges */
function parseFileChanges(xml: string): FileChange[] {
  const changes: FileChange[] = [];
  const changeRegex = /<change\s+action="(create|modify|delete)"\s+path="([^"]+)"(?:\s*\/>|>([\s\S]*?)<\/change>)/g;
  let match;
  while ((match = changeRegex.exec(xml)) !== null) {
    changes.push({
      action: match[1] as 'create' | 'modify' | 'delete',
      path: match[2],
      content: match[3]?.trim() || undefined,
    });
  }
  return changes;
}

/** Mirrors DevAgent.parseResponse */
function parseResponse(rawResponse: string): { response: string; fileChanges: FileChange[] } {
  const fileChangesMatch = rawResponse.match(/<file_changes>([\s\S]*?)<\/file_changes>/);
  let fileChanges: FileChange[] = [];
  let textResponse = rawResponse;

  if (fileChangesMatch) {
    textResponse = rawResponse.replace(/<file_changes>[\s\S]*?<\/file_changes>/, '').trim();
    fileChanges = parseFileChanges(fileChangesMatch[1]);
  }

  return { response: textResponse, fileChanges };
}

/** Mirrors DevAgent.formatFileTree */
function formatFileTree(tree: FileTreeNode[], indent = '', depth = 0): string {
  if (!tree || tree.length === 0) return '(empty)';
  const MAX_DEPTH = 3;
  let result = '';
  for (const node of tree) {
    if (node.type === 'dir') {
      result += `${indent}${node.path}/\n`;
      if (node.children && depth < MAX_DEPTH) {
        result += formatFileTree(node.children, indent + '  ', depth + 1);
      } else if (node.children && depth >= MAX_DEPTH) {
        result += `${indent}  ... (${node.children.length} items)\n`;
      }
    } else {
      result += `${indent}${node.path}\n`;
    }
  }
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// Part B: Dev Session — In-memory simulation
// ═════════════════════════════════════════════════════════════════════════════

type SessionStatus = 'active' | 'paused' | 'closed';
type ChangeStatus = 'pending' | 'approved' | 'pushed' | 'rejected';

interface DevSession {
  id: string;
  pipelineId: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  specSnapshot: unknown;
  initialFileTree: FileTreeNode[];
  status: SessionStatus;
  totalCommits: number;
  createdAt: Date;
  updatedAt: Date;
}

interface DevMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  fileChanges: FileChange[] | null;
  changeStatus: ChangeStatus | null;
  commitSha: string | null;
  createdAt: Date;
}

/** Simulates the dev session store (replaces DB layer) */
class DevSessionStore {
  sessions = new Map<string, DevSession>();
  messages = new Map<string, DevMessage>();
  private nextId = 1;

  private genId(): string {
    return `id-${this.nextId++}`;
  }

  /** POST /:id/dev/start — create or return existing session */
  startSession(pipelineId: string, pipelineData: {
    stage: string;
    repoOwner?: string;
    repoName?: string;
    branch?: string;
    spec?: unknown;
  }): { ok: true; sessionId: string; messages: DevMessage[]; isExisting: boolean } | { ok: false; error: string; statusCode: number } {
    // Pipeline must be completed
    if (pipelineData.stage !== 'completed' && pipelineData.stage !== 'completed_partial') {
      return { ok: false, error: 'Pipeline must be completed to start dev mode', statusCode: 400 };
    }

    // Check existing active session
    for (const s of this.sessions.values()) {
      if (s.pipelineId === pipelineId && s.status === 'active') {
        const msgs = [...this.messages.values()]
          .filter(m => m.sessionId === s.id)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return { ok: true, sessionId: s.id, messages: msgs, isExisting: true };
      }
    }

    // Validate repo info
    if (!pipelineData.repoOwner || !pipelineData.repoName || !pipelineData.branch) {
      return { ok: false, error: 'Pipeline missing repo/branch info from Proto output', statusCode: 400 };
    }

    // Create session
    const now = new Date();
    const session: DevSession = {
      id: this.genId(),
      pipelineId,
      repoOwner: pipelineData.repoOwner,
      repoName: pipelineData.repoName,
      branch: pipelineData.branch,
      specSnapshot: pipelineData.spec ?? null,
      initialFileTree: [],
      status: 'active',
      totalCommits: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);

    return { ok: true, sessionId: session.id, messages: [], isExisting: false };
  }

  /** POST /:id/dev/chat — send message to session */
  addMessage(
    sessionId: string,
    pipelineId: string,
    role: 'user' | 'assistant',
    content: string,
    fileChanges?: FileChange[],
  ): { ok: true; messageId: string } | { ok: false; error: string; statusCode: number } {
    const session = this.sessions.get(sessionId);
    if (!session || session.pipelineId !== pipelineId || session.status !== 'active') {
      return { ok: false, error: 'Dev session not found', statusCode: 404 };
    }

    const msg: DevMessage = {
      id: this.genId(),
      sessionId,
      role,
      content,
      fileChanges: fileChanges && fileChanges.length > 0 ? fileChanges : null,
      changeStatus: fileChanges && fileChanges.length > 0 ? 'pending' : null,
      commitSha: null,
      createdAt: new Date(),
    };
    this.messages.set(msg.id, msg);
    return { ok: true, messageId: msg.id };
  }

  /** POST /:id/dev/push — push changes from a message */
  pushChanges(
    sessionId: string,
    messageId: string,
  ): { ok: true; commitSha: string } | { ok: false; error: string; statusCode: number } {
    const msg = this.messages.get(messageId);
    if (!msg || msg.sessionId !== sessionId) {
      return { ok: false, error: 'Message not found', statusCode: 404 };
    }
    if (!msg.fileChanges || msg.fileChanges.length === 0) {
      return { ok: false, error: 'No file changes to push', statusCode: 400 };
    }
    if (msg.changeStatus === 'pushed') {
      return { ok: false, error: 'Already pushed', statusCode: 409 };
    }
    if (msg.changeStatus === 'rejected') {
      return { ok: false, error: 'Cannot push rejected changes', statusCode: 409 };
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: 'Session not found', statusCode: 404 };
    }

    // Simulate successful push
    const commitSha = `sha-${Date.now()}`;
    msg.changeStatus = 'pushed';
    msg.commitSha = commitSha;
    session.totalCommits += 1;
    session.updatedAt = new Date();

    return { ok: true, commitSha };
  }

  /** Close session */
  closeSession(sessionId: string): { ok: true } | { ok: false; error: string; statusCode: number } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, error: 'No active dev session', statusCode: 404 };
    }
    if (session.status !== 'active') {
      return { ok: false, error: 'Session is not active', statusCode: 400 };
    }

    session.status = 'closed';
    session.updatedAt = new Date();
    return { ok: true };
  }

  /** GET /:id/dev/session — get active session info */
  getActiveSession(pipelineId: string): DevSession | null {
    for (const s of this.sessions.values()) {
      if (s.pipelineId === pipelineId && s.status === 'active') return s;
    }
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Part C: Conversation Management — In-memory simulation
// ═════════════════════════════════════════════════════════════════════════════

/** Mirrors deriveTitleFromPrompt from conversations.ts */
function deriveTitleFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New conversation';
  const trimmed = clean.slice(0, 80);
  return trimmed.length < clean.length ? `${trimmed}…` : trimmed;
}

interface ConversationThread {
  id: string;
  userId: string;
  title: string;
  status: string;
  agentType: string;
  activeRuns: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ConversationMessage {
  id: string;
  threadId: string;
  userId: string;
  role: string;
  agentType: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

class ConversationStore {
  threads = new Map<string, ConversationThread>();
  messages = new Map<string, ConversationMessage>();
  private nextId = 1;

  private genId(): string {
    return `conv-${this.nextId++}`;
  }

  createThread(userId: string, opts?: { title?: string; agentType?: string }): ConversationThread {
    const now = new Date();
    const thread: ConversationThread = {
      id: this.genId(),
      userId,
      title: opts?.title?.trim() || 'New conversation',
      status: 'active',
      agentType: opts?.agentType ?? 'scribe',
      activeRuns: 0,
      lastMessageAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  listThreads(userId: string): ConversationThread[] {
    return [...this.threads.values()]
      .filter(t => t.userId === userId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  getThread(userId: string, threadId: string): ConversationThread | null {
    const t = this.threads.get(threadId);
    if (!t || t.userId !== userId) return null;
    return t;
  }

  renameThread(userId: string, threadId: string, newTitle: string): ConversationThread | null {
    const t = this.getThread(userId, threadId);
    if (!t) return null;
    t.title = newTitle.trim();
    t.updatedAt = new Date();
    return t;
  }

  deleteThread(userId: string, threadId: string): boolean {
    const t = this.getThread(userId, threadId);
    if (!t) return false;
    this.threads.delete(threadId);
    // Also delete associated messages
    for (const [id, msg] of this.messages) {
      if (msg.threadId === threadId) this.messages.delete(id);
    }
    return true;
  }

  addMessage(threadId: string, userId: string, role: string, content: string): ConversationMessage | null {
    const thread = this.threads.get(threadId);
    if (!thread || thread.userId !== userId) return null;

    const now = new Date();
    const msg: ConversationMessage = {
      id: this.genId(),
      threadId,
      userId,
      role,
      agentType: thread.agentType,
      content: content.trim(),
      metadata: {},
      createdAt: now,
    };
    this.messages.set(msg.id, msg);

    // Auto-title from first user message
    if (thread.title === 'New conversation' && role === 'user') {
      thread.title = deriveTitleFromPrompt(content);
    }
    thread.updatedAt = now;
    thread.lastMessageAt = now;

    return msg;
  }

  getMessages(threadId: string): ConversationMessage[] {
    return [...this.messages.values()]
      .filter(m => m.threadId === threadId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}

// Conversation Zod schemas (mirrored from conversations.ts for validation tests)
const createThreadSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(255).optional(),
  agentType: z.enum(['scribe', 'trace', 'proto']).optional(),
});

const createMessageSchema = z.object({
  role: z.enum(['system', 'user', 'agent']),
  content: z.string().trim().min(1),
  agentType: z.enum(['scribe', 'trace', 'proto']).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const threadIdParamsSchema = z.object({
  threadId: z.string().uuid(),
});

const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.string().optional(),
});

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

// ── DevAgent parseResponse ─────────────────────────────────────────────────

describe('DevAgent — parseResponse', () => {
  test('extracts text response and file changes from raw AI output', () => {
    const raw = `I'll create the login page for you.

<file_changes>
<change action="create" path="src/pages/Login.tsx">
export default function Login() { return <div>Login</div>; }
</change>
</file_changes>`;

    const result = parseResponse(raw);
    assert.equal(result.fileChanges.length, 1);
    assert.equal(result.fileChanges[0].action, 'create');
    assert.equal(result.fileChanges[0].path, 'src/pages/Login.tsx');
    assert.ok(result.fileChanges[0].content?.includes('Login'));
    assert.ok(result.response.includes('login page'));
    assert.ok(!result.response.includes('<file_changes>'));
  });

  test('returns empty fileChanges when no XML block present', () => {
    const raw = 'Sure, I can help with that. Let me explain the architecture.';
    const result = parseResponse(raw);
    assert.equal(result.fileChanges.length, 0);
    assert.equal(result.response, raw);
  });

  test('handles delete action (self-closing tag)', () => {
    const raw = `Removing old file.

<file_changes>
<change action="delete" path="src/old.ts" />
</file_changes>`;

    const result = parseResponse(raw);
    assert.equal(result.fileChanges.length, 1);
    assert.equal(result.fileChanges[0].action, 'delete');
    assert.equal(result.fileChanges[0].path, 'src/old.ts');
    assert.equal(result.fileChanges[0].content, undefined);
  });

  test('handles multiple file changes', () => {
    const raw = `Making changes.

<file_changes>
<change action="create" path="a.ts">const a = 1;</change>
<change action="modify" path="b.ts">const b = 2;</change>
<change action="delete" path="c.ts" />
</file_changes>`;

    const result = parseResponse(raw);
    assert.equal(result.fileChanges.length, 3);
    assert.equal(result.fileChanges[0].action, 'create');
    assert.equal(result.fileChanges[1].action, 'modify');
    assert.equal(result.fileChanges[2].action, 'delete');
  });

  test('handles empty file_changes block', () => {
    const raw = `No changes needed.

<file_changes>
</file_changes>`;

    const result = parseResponse(raw);
    assert.equal(result.fileChanges.length, 0);
    assert.ok(result.response.includes('No changes'));
  });
});

// ── DevAgent formatFileTree ────────────────────────────────────────────────

describe('DevAgent — formatFileTree', () => {
  test('returns "(empty)" for empty tree', () => {
    assert.equal(formatFileTree([]), '(empty)');
    assert.equal(formatFileTree(null as unknown as FileTreeNode[]), '(empty)');
  });

  test('formats flat file list', () => {
    const tree: FileTreeNode[] = [
      { path: 'index.ts', type: 'file' },
      { path: 'README.md', type: 'file' },
    ];
    const result = formatFileTree(tree);
    assert.ok(result.includes('index.ts'));
    assert.ok(result.includes('README.md'));
  });

  test('formats directories with trailing slash', () => {
    const tree: FileTreeNode[] = [
      { path: 'src', type: 'dir', children: [{ path: 'index.ts', type: 'file' }] },
    ];
    const result = formatFileTree(tree);
    assert.ok(result.includes('src/'));
    assert.ok(result.includes('index.ts'));
  });

  test('truncates at MAX_DEPTH=3', () => {
    const deep: FileTreeNode = {
      path: 'level0', type: 'dir', children: [{
        path: 'level1', type: 'dir', children: [{
          path: 'level2', type: 'dir', children: [{
            path: 'level3', type: 'dir', children: [
              { path: 'deep.ts', type: 'file' },
              { path: 'deeper.ts', type: 'file' },
            ],
          }],
        }],
      }],
    };
    const result = formatFileTree([deep]);
    assert.ok(result.includes('... (2 items)'));
    assert.ok(!result.includes('deep.ts'));
  });
});

// ── Dev Session — Start ────────────────────────────────────────────────────

describe('Dev Session — Start Session', () => {
  test('1. creates new session record for completed pipeline', () => {
    const store = new DevSessionStore();
    const result = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
      spec: { title: 'Test App' },
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.sessionId);
      assert.equal(result.messages.length, 0);
      assert.equal(result.isExisting, false);

      const session = store.sessions.get(result.sessionId)!;
      assert.equal(session.status, 'active');
      assert.equal(session.totalCommits, 0);
      assert.equal(session.repoOwner, 'acme');
      assert.equal(session.repoName, 'webapp');
      assert.equal(session.branch, 'main');
    }
  });

  test('1b. creates session for completed_partial pipeline', () => {
    const store = new DevSessionStore();
    const result = store.startSession('pipe-2', {
      stage: 'completed_partial',
      repoOwner: 'acme',
      repoName: 'partial',
      branch: 'dev',
    });
    assert.equal(result.ok, true);
  });

  test('2. returns existing session when one already exists', () => {
    const store = new DevSessionStore();

    // First start
    const r1 = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    assert.equal(r1.ok, true);

    // Second start — same pipeline
    const r2 = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    assert.equal(r2.ok, true);
    if (r1.ok && r2.ok) {
      assert.equal(r2.sessionId, r1.sessionId);
      assert.equal(r2.isExisting, true);
    }
  });

  test('rejects session start for non-completed pipeline', () => {
    const store = new DevSessionStore();
    const result = store.startSession('pipe-1', {
      stage: 'proto_building',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.ok(result.error.includes('completed'));
    }
  });

  test('rejects session when missing repo info', () => {
    const store = new DevSessionStore();
    const result = store.startSession('pipe-1', {
      stage: 'completed',
      // missing repoOwner, repoName, branch
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 400);
      assert.ok(result.error.includes('repo'));
    }
  });
});

// ── Dev Session — Messages ─────────────────────────────────────────────────

describe('Dev Session — Send Message', () => {
  test('3. adds user message to active session', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    assert.equal(start.ok, true);
    if (!start.ok) return;

    const result = store.addMessage(start.sessionId, 'pipe-1', 'user', 'Add a login page');
    assert.equal(result.ok, true);
    if (result.ok) {
      const msg = store.messages.get(result.messageId)!;
      assert.equal(msg.role, 'user');
      assert.equal(msg.content, 'Add a login page');
      assert.equal(msg.fileChanges, null);
    }
  });

  test('adds assistant message with file changes', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    assert.equal(start.ok, true);
    if (!start.ok) return;

    const changes: FileChange[] = [
      { action: 'create', path: 'src/Login.tsx', content: 'export default function Login() {}' },
    ];
    const result = store.addMessage(start.sessionId, 'pipe-1', 'assistant', 'Created login page', changes);
    assert.equal(result.ok, true);
    if (result.ok) {
      const msg = store.messages.get(result.messageId)!;
      assert.equal(msg.role, 'assistant');
      assert.deepEqual(msg.fileChanges, changes);
      assert.equal(msg.changeStatus, 'pending');
    }
  });

  test('6. rejects message to non-existent session', () => {
    const store = new DevSessionStore();
    const result = store.addMessage('nonexistent', 'pipe-1', 'user', 'Hello');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 404);
    }
  });

  test('rejects message when session is closed', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    assert.equal(start.ok, true);
    if (!start.ok) return;

    store.closeSession(start.sessionId);

    const result = store.addMessage(start.sessionId, 'pipe-1', 'user', 'After close');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 404);
    }
  });
});

// ── Dev Session — Push Changes ─────────────────────────────────────────────

describe('Dev Session — Push Changes', () => {
  test('4. push creates commit record and increments totalCommits', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    assert.equal(start.ok, true);
    if (!start.ok) return;

    const changes: FileChange[] = [
      { action: 'create', path: 'src/index.ts', content: 'console.log("hi")' },
    ];
    const msgResult = store.addMessage(start.sessionId, 'pipe-1', 'assistant', 'Created file', changes);
    assert.equal(msgResult.ok, true);
    if (!msgResult.ok) return;

    const pushResult = store.pushChanges(start.sessionId, msgResult.messageId);
    assert.equal(pushResult.ok, true);
    if (pushResult.ok) {
      assert.ok(pushResult.commitSha.startsWith('sha-'));
    }

    const session = store.sessions.get(start.sessionId)!;
    assert.equal(session.totalCommits, 1);

    const msg = store.messages.get(msgResult.messageId)!;
    assert.equal(msg.changeStatus, 'pushed');
    assert.ok(msg.commitSha);
  });

  test('rejects double push (409)', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    if (!start.ok) return;

    const changes: FileChange[] = [{ action: 'create', path: 'x.ts', content: 'x' }];
    const msgResult = store.addMessage(start.sessionId, 'pipe-1', 'assistant', 'ok', changes);
    if (!msgResult.ok) return;

    store.pushChanges(start.sessionId, msgResult.messageId);

    const secondPush = store.pushChanges(start.sessionId, msgResult.messageId);
    assert.equal(secondPush.ok, false);
    if (!secondPush.ok) {
      assert.equal(secondPush.statusCode, 409);
      assert.ok(secondPush.error.includes('Already pushed'));
    }
  });

  test('rejects push for message with no file changes', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    if (!start.ok) return;

    const msgResult = store.addMessage(start.sessionId, 'pipe-1', 'assistant', 'Just text, no files');
    if (!msgResult.ok) return;

    const pushResult = store.pushChanges(start.sessionId, msgResult.messageId);
    assert.equal(pushResult.ok, false);
    if (!pushResult.ok) {
      assert.equal(pushResult.statusCode, 400);
    }
  });
});

// ── Dev Session — Close ────────────────────────────────────────────────────

describe('Dev Session — Close', () => {
  test('5. close sets status to closed', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    assert.equal(start.ok, true);
    if (!start.ok) return;

    const result = store.closeSession(start.sessionId);
    assert.equal(result.ok, true);

    const session = store.sessions.get(start.sessionId)!;
    assert.equal(session.status, 'closed');
  });

  test('6. close non-existent session returns 404', () => {
    const store = new DevSessionStore();
    const result = store.closeSession('nonexistent');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 404);
    }
  });

  test('close already-closed session returns error', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    if (!start.ok) return;

    store.closeSession(start.sessionId);

    const secondClose = store.closeSession(start.sessionId);
    assert.equal(secondClose.ok, false);
    if (!secondClose.ok) {
      assert.equal(secondClose.statusCode, 400);
    }
  });

  test('getActiveSession returns null after close', () => {
    const store = new DevSessionStore();
    const start = store.startSession('pipe-1', {
      stage: 'completed',
      repoOwner: 'acme',
      repoName: 'webapp',
      branch: 'main',
    });
    if (!start.ok) return;

    assert.ok(store.getActiveSession('pipe-1'));
    store.closeSession(start.sessionId);
    assert.equal(store.getActiveSession('pipe-1'), null);
  });
});

// ── Conversation Management ────────────────────────────────────────────────

describe('Conversation — Create Thread', () => {
  test('7. creates conversation with valid title and userId', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1', { title: 'My first project' });
    assert.equal(thread.userId, 'user-1');
    assert.equal(thread.title, 'My first project');
    assert.equal(thread.status, 'active');
    assert.equal(thread.agentType, 'scribe');
  });

  test('uses default title when none provided', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1');
    assert.equal(thread.title, 'New conversation');
  });

  test('accepts custom agentType', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1', { title: 'Trace', agentType: 'trace' });
    assert.equal(thread.agentType, 'trace');
  });

  test('trims title whitespace', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1', { title: '  Trimmed Title  ' });
    assert.equal(thread.title, 'Trimmed Title');
  });
});

describe('Conversation — List Threads', () => {
  test('8. lists user-scoped threads sorted by date (newest first)', () => {
    const store = new ConversationStore();

    const t1 = store.createThread('user-1', { title: 'First' });
    // Force t2 to have a later updatedAt so sort order is deterministic
    const t2 = store.createThread('user-1', { title: 'Second' });
    t2.updatedAt = new Date(t1.updatedAt.getTime() + 1000);
    store.createThread('user-2', { title: 'Other user' });

    // t2 has a later updatedAt, so it comes first
    const list = store.listThreads('user-1');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, t2.id);
    assert.equal(list[1].id, t1.id);
  });

  test('11. empty list for user with no conversations', () => {
    const store = new ConversationStore();
    store.createThread('user-1', { title: 'something' });
    const list = store.listThreads('user-999');
    assert.equal(list.length, 0);
    assert.deepEqual(list, []);
  });
});

describe('Conversation — Rename Thread', () => {
  test('9. rename updates title', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1', { title: 'Old Title' });
    const renamed = store.renameThread('user-1', thread.id, 'New Title');
    assert.ok(renamed);
    assert.equal(renamed!.title, 'New Title');
  });

  test('rename does not affect other users thread', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1', { title: 'Private' });
    const result = store.renameThread('user-2', thread.id, 'Hacked');
    assert.equal(result, null);
    assert.equal(store.threads.get(thread.id)!.title, 'Private');
  });
});

describe('Conversation — Delete Thread', () => {
  test('10. delete removes thread and its messages', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1', { title: 'To delete' });
    store.addMessage(thread.id, 'user-1', 'user', 'Hello');
    store.addMessage(thread.id, 'user-1', 'agent', 'Hi there');

    assert.equal(store.getMessages(thread.id).length, 2);

    const deleted = store.deleteThread('user-1', thread.id);
    assert.equal(deleted, true);
    assert.equal(store.threads.has(thread.id), false);
    assert.equal(store.getMessages(thread.id).length, 0);
  });

  test('delete non-existent thread returns false', () => {
    const store = new ConversationStore();
    const deleted = store.deleteThread('user-1', 'nonexistent');
    assert.equal(deleted, false);
  });

  test('delete other users thread returns false', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1', { title: 'Mine' });
    assert.equal(store.deleteThread('user-2', thread.id), false);
    assert.equal(store.threads.has(thread.id), true);
  });
});

describe('Conversation — Auto-title from first message', () => {
  test('first user message derives title from content', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1');
    assert.equal(thread.title, 'New conversation');

    store.addMessage(thread.id, 'user-1', 'user', 'Build me a todo app with React');
    assert.equal(thread.title, 'Build me a todo app with React');
  });

  test('long prompt is truncated to 80 chars with ellipsis', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1');
    const longPrompt = 'A'.repeat(120);
    store.addMessage(thread.id, 'user-1', 'user', longPrompt);
    assert.equal(thread.title.length, 81); // 80 chars + ellipsis char
    assert.ok(thread.title.endsWith('…'));
  });

  test('agent message does not change title', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1');
    store.addMessage(thread.id, 'user-1', 'agent', 'System message');
    assert.equal(thread.title, 'New conversation');
  });

  test('second user message does not change title once set', () => {
    const store = new ConversationStore();
    const thread = store.createThread('user-1');
    store.addMessage(thread.id, 'user-1', 'user', 'First message');
    assert.equal(thread.title, 'First message');

    store.addMessage(thread.id, 'user-1', 'user', 'Second message');
    assert.equal(thread.title, 'First message');
  });
});

// ── Conversation Schema Validation ─────────────────────────────────────────

describe('Conversation — Schema Validation', () => {
  test('createThreadSchema accepts empty body', () => {
    const result = createThreadSchema.safeParse({});
    assert.equal(result.success, true);
  });

  test('createThreadSchema rejects empty string title', () => {
    const result = createThreadSchema.safeParse({ title: '   ' });
    assert.equal(result.success, false);
  });

  test('createThreadSchema rejects title over 255 chars', () => {
    const result = createThreadSchema.safeParse({ title: 'X'.repeat(256) });
    assert.equal(result.success, false);
  });

  test('createThreadSchema rejects invalid agentType', () => {
    const result = createThreadSchema.safeParse({ agentType: 'invalid' });
    assert.equal(result.success, false);
  });

  test('createMessageSchema rejects whitespace-only content', () => {
    const result = createMessageSchema.safeParse({ role: 'user', content: '   ' });
    assert.equal(result.success, false);
  });

  test('createMessageSchema rejects invalid role', () => {
    const result = createMessageSchema.safeParse({ role: 'admin', content: 'hi' });
    assert.equal(result.success, false);
  });

  test('createMessageSchema accepts valid message with metadata', () => {
    const result = createMessageSchema.safeParse({
      role: 'agent',
      content: 'Hello from Scribe',
      agentType: 'scribe',
      metadata: { source: 'pipeline' },
    });
    assert.equal(result.success, true);
  });

  test('threadIdParamsSchema requires valid UUID', () => {
    const valid = threadIdParamsSchema.safeParse({ threadId: '6bf42b31-fd00-42fd-bac2-543af687f5e3' });
    assert.equal(valid.success, true);

    const invalid = threadIdParamsSchema.safeParse({ threadId: 'not-uuid' });
    assert.equal(invalid.success, false);
  });

  test('listMessagesQuerySchema defaults limit to 100', () => {
    const result = listMessagesQuerySchema.parse({});
    assert.equal(result.limit, 100);
    assert.equal(result.before, undefined);
  });

  test('listMessagesQuerySchema rejects limit > 200', () => {
    const result = listMessagesQuerySchema.safeParse({ limit: 201 });
    assert.equal(result.success, false);
  });
});

// ── deriveTitleFromPrompt ──────────────────────────────────────────────────

describe('Conversation — deriveTitleFromPrompt', () => {
  test('returns "New conversation" for empty string', () => {
    assert.equal(deriveTitleFromPrompt(''), 'New conversation');
    assert.equal(deriveTitleFromPrompt('   '), 'New conversation');
  });

  test('collapses internal whitespace', () => {
    const title = deriveTitleFromPrompt('Build  a   todo   app');
    assert.equal(title, 'Build a todo app');
  });

  test('truncates at 80 chars with ellipsis', () => {
    const long = 'Build a comprehensive e-commerce platform with user authentication, product catalog, shopping cart, and checkout flow integration';
    const title = deriveTitleFromPrompt(long);
    assert.ok(title.length <= 81);
    assert.ok(title.endsWith('…'));
  });

  test('keeps short prompt as-is without ellipsis', () => {
    const title = deriveTitleFromPrompt('Add dark mode');
    assert.equal(title, 'Add dark mode');
    assert.ok(!title.includes('…'));
  });
});
