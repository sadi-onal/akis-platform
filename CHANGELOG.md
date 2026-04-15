# Changelog

## v0.6.5 (2026-04-15)

### File Upload (New Feature)
- **feat:** End-to-end file upload — ChatInput → FormData API → @fastify/multipart → Scribe
- **feat:** FileUploadService: in-memory processing for text (.ts/.tsx/.js/.md/.json/.html/.css), images (.png/.jpeg/.gif/.webp), basic PDF
- **feat:** Attachment context injection into Scribe knowledgeContext (reuses existing RAG pattern)
- **feat:** Backend multipart/JSON auto-detection — full backward compatibility

### Chat UX Improvements
- **feat:** Info messages shown when user sends notes during running pipeline stages
- **feat:** Iteration mode error feedback — ChatMessage error shown on failure
- **fix:** Iteration mode navigation preserves browser history (removed replace:true)
- **fix:** Updated Turkish placeholder text for all pipeline terminal states
- **feat:** ChatSkeleton used as Suspense fallback instead of plain text

### Landing Page Fixes
- **fix:** framer-motion opacity:0 animation failure — removed all opacity from initial states
- **fix:** LazyMotion domAnimation → domMax (enables whileInView support)
- **fix:** WCAG AA contrast — text-secondary → text-primary, bg-surface/30 → /70
- **fix:** Mobile responsive padding — px-4 sm:px-6 lg:px-8 on all sections
- **fix:** HowItWorks grid gap responsive — gap-4 md:gap-6

### DocsPage Improvements
- **feat:** Inline markdown rendering — **bold**, \`code\`, [links](url) now properly rendered
- **feat:** Fenced code blocks (\`\`\`) render as styled \<pre\>\<code\> blocks
- **fix:** Sidebar nav accessibility — aria-label, aria-current="page"

### Accessibility
- **fix:** ChatInput: aria-labels for file/image buttons, dynamic remove label
- **fix:** ChatMessage: aria-labels for copy buttons
- **fix:** ErrorBoundary: Turkish character fixes, aria-expanded toggle
- **feat:** File upload validation toast messages (size, count, type errors)

### i18n
- **feat:** StatusBadge labels internationalized (7 keys TR+EN)
- **feat:** common.loading key added to both locale files

### Security
- **fix:** Path traversal guard on getFileContent endpoint (rejects ../ and absolute paths)
- **fix:** Error message no longer leaks file path structure (404 instead of path in message)
- **fix:** HTTP status codes: 400 for invalid input, 404 for not found (was 500 for all)

### Type Safety
- **refactor:** Eliminated all 25 \`as any\` assertions from backend (0 remaining)
- **fix:** fastify.d.ts: added hijack(), routerPath, user, raw, delete() type declarations
- **fix:** StripeService: proper unknown cast for subscription period fields

### Code Quality
- **fix:** Silent .catch(() => {}) handlers replaced with dev console.warn
- **fix:** console.debug → logger.debug in ScribeAgent and GitHubMCPService
- **fix:** localStorage SSR safety guards in EmptyState, ProfileSetupWizard

### Deploy Reliability
- **fix:** deploy_prebuilt.sh: sudo for frontend cleanup (prevents permission denied)
- **fix:** deploy.sh: GITHUB_REPOSITORY sync in .env (prevents image tag mismatch)
- **fix:** @fastify/multipart v10 → v8 (Fastify 4 compatibility)
- **fix:** @fastify/compress v8 → v7 (Fastify 4 compatibility)

### Test Coverage
- **test:** LandingPage.test.tsx — 24 tests (hero, steps, features, stats, navigation, auth)
- **test:** DocsPage.test.tsx — 23 tests (sections, markdown, a11y, navigation)
- **test:** file-upload-service.test.ts — 15 tests (text extraction, image encoding, limits)
- **test:** pipeline-multipart.test.ts — 18 tests (field parsing, context string, e2e flow)
- **test:** pipeline-orchestrator.test.ts — +4 tests (attachment threading)
- **test:** ErrorBoundary tests updated for Turkish character fixes
- **stats:** Frontend 620 → 673 (+53), Backend 3075 → 3112 (+37), Total +90

### Knowledge Base
- **feat:** 30 project documents ingested into RAG (188 chunks)
- **docs:** CLAUDE.md updated to v0.6.5 with file upload and RAG docs

## v0.5.0 (2026-04-13)

### Pipeline Engine
- **fix:** JSON parse errors when AI wraps response in \`\`\`json fences — shared `json-extract.ts` utility
- **fix:** Pipeline continuation — follow-up pipelines reuse existing repo instead of creating new
- **fix:** Double-approve guard on spec approval
- **fix:** Polling optimization for pipeline status checks
- **feat:** Agent context injection — RAG knowledge appended to Scribe/Proto/Trace system prompts
- **feat:** Pipeline completion auto-ingests specs, scaffolds, and test results into knowledge base

### RAG System (New)
- **feat:** Local embedding with Transformers.js (all-MiniLM-L6-v2, 384d) — zero cost
- **feat:** pgvector integration for cosine similarity search
- **feat:** Hybrid retrieval: keyword (55%) + semantic (45%) with user/project isolation
- **feat:** Knowledge API: CRUD documents, hybrid search, statistics
- **feat:** Automatic knowledge ingestion on pipeline completion

### Billing & Pricing
- **feat:** Anthropic Claude model pricing (Haiku, Sonnet, Opus) + OpenAI GPT-4.1 family
- **feat:** Token budget enforcement — monthly limit check before job execution
- **feat:** Pipeline token tracking — completion triggers billing usage update
- **fix:** Billing race condition — atomic SQL for concurrent usage increment
- **fix:** Admin accounts set to unlimited (production DB verified)

### UI & Animations
- **feat:** Stage-colored glow bar when agents run (blue/orange/purple)
- **feat:** Conversation sidebar: hover scale + active accent border
- **feat:** TraceProgressStepper: smooth icon transitions + border-glow
- **feat:** EmptyState: logo glow-pulse effect (respects reduced-motion)
- **feat:** Settings tab content fade+slide transition
- **feat:** Clarification card: bigger chips (border-2, font-medium), checkmark on selection
- **feat:** Sidebar empty state: icon + "Yeni Sohbet Başlat" button
- **feat:** Settings loading skeletons replace plain text
- **feat:** Chat performance: content-visibility:auto on message list
- **fix:** Sandpack preview: Proto path mapping (src/App.tsx → /App.tsx)
- **fix:** Delete confirmation dialogs for conversations and API keys
- **fix:** Turkish character search normalization (toLocaleLowerCase)
- **fix:** Search debounce (300ms) for conversation sidebar

### Preview System
- **feat:** StackBlitz → Sandpack migration (15-30s → 1-3s boot time)
- **fix:** Template + custom files hybrid — Proto code renders instead of "Hello world"
- **feat:** Vendor chunk splitting — Sandpack lazy-loaded separately (620KB)

### Testing
- **feat:** 2102 total tests (1645 backend + 457 frontend), 0 failures
- **feat:** Agent unit tests: ScribeAgent (22), ProtoAgent (19), TraceAgent (17)
- **feat:** JSON extract utility tests (36 tests)
- **feat:** Frontend component tests: ConversationSidebar, ChatHeader, TraceProgressStepper, ChatSkeleton

### Documentation
- **feat:** AGENT_VERIFICATION.md — thesis defense documentation
- **feat:** CHANGELOG.md (this file)

### Infrastructure
- **feat:** Database composite indexes: (userId, createdAt), (stage, updatedAt)
- **feat:** DB pool default increased: 10 → 20 connections
- **fix:** All console.log/warn/error → structured pino logger (150+ calls migrated)
- **fix:** nodemailer security update (7.x → 8.0.5)
- **fix:** Pipeline ON DELETE CASCADE for user foreign keys

### Security
- **verified:** API keys encrypted with AES-256-GCM, never exposed to frontend
- **verified:** Admin role with unlimited billing override
- **verified:** Rate limiting on auth endpoints
- **verified:** CORS whitelist, httpOnly cookies, bcrypt passwords
- **verified:** OAuth HMAC-signed state tokens (stateless)

---

## v0.2.0 (2026-03-xx)

Initial release with pipeline engine, chat UI, and OAuth authentication.
