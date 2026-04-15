# Changelog

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
