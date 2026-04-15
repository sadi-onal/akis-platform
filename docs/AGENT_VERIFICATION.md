# Agent Verification — Test & Doğrulama Altyapısı

> Bu belge, AKIS platformundaki agent'ların doğruluğunu nasıl test ettiğimizi
> ve doğrulama zincirinin teknik detaylarını açıklar.
> Tez savunmasında "Agent doğruluğunu nasıl test ediyorsun?" sorusuna cevap olarak hazırlanmıştır.

---

## 1. Doğrulama Zinciri Özeti

AKIS platformunda hiçbir agent kendi çıktısını doğrulamaz. Doğrulama her zaman
bağımsız bir varlık tarafından yapılır:

```
Scribe (üretir: spec)    → İNSAN doğrular (human-in-the-loop)
Proto  (üretir: scaffold) → TRACE doğrular (automated verification)
Trace  (üretir: testler)  → TEST RUNNER doğrular (otomatik çalıştırma)
```

Bu 3 katmanlı yapı, tez temasının temelini oluşturur: **Knowledge Integrity**.

---

## 2. Test Altyapısı

### 2.1. Test Sayıları (Nisan 2026)

| Katman | Test Sayısı | Framework | Coverage Hedefi |
|--------|------------|-----------|-----------------|
| Backend unit | 1645+ | Node.js test runner | %70+ (agents/core) |
| Frontend unit | 457+ | Vitest + RTL | %65+ (chat components) |
| Integration | Ayrı suite | Node.js test runner | Pipeline FSM transitions |
| E2E | Playwright | CI nightly | Full pipeline flow |

### 2.2. Mock Stratejisi

Agent'lar dependency injection ile çalışır — tüm dış bağımlılıklar mock'lanabilir:

- **ScribeAIDeps**: `generateText(system, user) → string` — AI cevaplarını mock'lar
- **ProtoGitHubDeps**: `createRepository`, `pushFiles`, `createPR` — GitHub işlemlerini mock'lar
- **TraceGitHubDeps**: `listFiles`, `getFileContent` — codebase okumayı mock'lar

Bu yapı sayesinde testler:
- Gerçek AI API çağrısı yapmaz (maliyet = 0)
- Gerçek GitHub repo oluşturmaz (izolasyon = tam)
- Deterministik sonuçlar üretir (tekrarlanabilirlik = %100)

---

## 3. Agent-Spesifik Doğrulama

### 3.1. Scribe Agent Doğrulaması

**Doğrulanan özellikler:**

| Test Kategorisi | Ne Doğrulanıyor? | Test Sayısı |
|----------------|-------------------|-------------|
| Spec Format Validation | Title, problemStatement, userStories[], acceptanceCriteria[] | 5 |
| Given-When-Then Format | Her AC'nin id, given, when, then alanları | 1 |
| User Story Yapısı | persona, action, benefit yapısı | 1 |
| Clarification Flow | Soru üretimi, question ID tracking, user answer işleme | 4 |
| Confidence Scoring | 0-1 arası confidence değeri | 1 |
| Field Normalisation | String → array otomatik dönüşüm (userStories, outOfScope) | 2 |
| Error Recovery | AI hatası, invalid JSON, retry mekanizması | 3 |
| Conversation State | Phase tracking, clarificationRound, conversation history | 3 |
| Spec Regeneration | Kullanıcı feedback ile yeniden üretim | 1 |

**Kritik doğrulama noktası:**
Scribe'ın ürettiği her spec, Zod şema doğrulamasından geçer (`ScribeOutputSchema`).
Bu şema, acceptance criteria'nın Given-When-Then formatında olmasını zorunlu kılar.

### 3.2. Proto Agent Doğrulaması

**Doğrulanan özellikler:**

| Test Kategorisi | Ne Doğrulanıyor? | Test Sayısı |
|----------------|-------------------|-------------|
| Scaffold Generation | Dosya listesi üretimi, package.json dahil | 3 |
| GitHub Operations | Repo oluşturma, dosya push, PR açma | 2 |
| Setup Commands | git clone, cd, npm install komutları | 2 |
| Dry Run Mode | GitHub'a hiç yazmadan scaffold üretimi | 3 |
| File Safety | Path traversal (/../../), absolute path filtreleme | 2 |
| Error Recovery | AI hatası, GitHub 401/403, empty scaffold | 4 |
| Repo Already Exists | 422 hatasında graceful devam | 1 |
| JSON Extraction | Fenced code block (\`\`\`json) parse | 1 |

**Kritik doğrulama noktası:**
Proto, `sanitizeFiles()` ile tüm dosya yollarını tarar. Path traversal (`../`),
absolute path (`/etc/`), null byte, Windows reserved chars içeren dosyaları reddeder.

### 3.3. Trace Agent Doğrulaması

**Doğrulanan özellikler:**

| Test Kategorisi | Ne Doğrulanıyor? | Test Sayısı |
|----------------|-------------------|-------------|
| Test File Generation | Playwright test dosyaları, page objects | 3 |
| Coverage Matrix | AC → test file eşleştirmesi | 3 |
| Codebase Reading | GitHub'dan source file okuma, exclude pattern | 2 |
| Dry Run Mode | GitHub'a yazmadan test üretimi | 2 |
| Error Recovery | AI hatası, empty codebase, empty testFiles | 4 |
| PR Creation | Non-fatal PR failure handling | 1 |
| Test Summary | totalTests, frameworks, coverageRatio | 2 |

**Kritik doğrulama noktası:**
Trace'in ürettiği `coverageMatrix`, her acceptance criteria'yı en az bir test dosyasına
eşler. Bu, gereksinimlerden testlere izlenebilirlik (traceability) sağlar.

---

## 4. Paylaşılan Utility Testleri

### 4.1. json-extract.ts (36 test)

AI modelleri JSON'u sıklıkla markdown fence'leri (`\`\`\`json`) içinde veya
truncated (kesilmiş) olarak üretir. Bu utility 4 strateji ile JSON'u çıkarır:

| Fonksiyon | Test Sayısı | Stratejiler |
|-----------|-------------|-------------|
| `extractJsonSafe` | 10 | Pure JSON, fenced block, brace extraction, fallback |
| `sanitizeJsonControlChars` | 6 | Newline, tab, CR escape (string içinde) |
| `repairTruncatedJson` | 9 | Unclosed brace/bracket, trailing comma, open string |
| `parseAIJson` | 11 | extract → parse → sanitize → repair zinciri |

**Gerçek dünya senaryosu testi:**
```
Input:  '```json\n{"testFiles": [...]}\n```'
Output: { testFiles: [...] }  ← doğru parse
```

Bu test, Trace agent'ın production'da karşılaştığı exact hatayı simüle eder.

---

## 5. Pipeline Orchestrator Testleri

Orchestrator, agent'lar arası geçişleri yönetir. FSM (Finite State Machine) testleri:

| Test Kategorisi | Ne Doğrulanıyor? |
|----------------|-------------------|
| State Transitions | scribe_clarifying → scribe_generating → awaiting_approval → proto_building → trace_testing → completed |
| Error Transitions | Her adımdan → failed (retryable) |
| Approval Flow | Spec onay/red → doğru state geçişi |
| Retry Logic | Max 3 deneme, exponential backoff |
| Timeout Handling | Stage timeout: 5dk (Trace: 10dk) |
| Pipeline Continuation | existingRepo ile aynı repo üzerinde devam |

---

## 6. Coverage Matrix Konsepti

Trace agent'ın ürettiği coverage matrix, tez temasının en önemli çıktısıdır:

```json
{
  "coverageMatrix": {
    "ac-1": ["tests/e2e/auth.spec.ts", "tests/e2e/login.spec.ts"],
    "ac-2": ["tests/e2e/dashboard.spec.ts"],
    "ac-3": ["tests/e2e/settings.spec.ts"]
  }
}
```

Bu matris şunu kanıtlar:
- Her gereksinim (AC) en az bir test tarafından doğrulanır
- Doğrulanmayan gereksinim varsa `coverageRatio < 1.0` olur
- Bu oran, **knowledge integrity score** olarak tez metriğidir

---

## 7. CI/CD Quality Gate

Her commit, aşağıdaki quality gate'den geçer:

```bash
# Backend
pnpm -C backend typecheck    # TypeScript tip kontrolü
pnpm -C backend lint          # ESLint kuralları
pnpm -C backend test:unit     # 1645+ unit test
pnpm -C backend build         # Production build

# Frontend
pnpm -C frontend typecheck
pnpm -C frontend lint
pnpm -C frontend test          # 457+ unit test
pnpm -C frontend build
```

CI workflow (`ci.yml`): GitHub Actions'da her push'ta çalışır.
PR gate (`pr-gate.yml`): Merge öncesi zorunlu kontrol.

---

## 8. Test Dosya Haritası

```
backend/test/unit/
├── agents/
│   ├── scribe-agent.test.ts    (22 test) — Spec validation, clarification, state
│   ├── proto-agent.test.ts     (19 test) — Scaffold, GitHub, file safety
│   └── trace-agent.test.ts     (17 test) — Test gen, coverage matrix, codebase
├── json-extract.test.ts        (36 test) — AI JSON extraction/repair
├── pipeline-scribe.test.ts     (20 test) — Scribe legacy tests
├── pipeline-proto.test.ts      (20 test) — Proto legacy tests
├── pipeline-trace.test.ts      (20 test) — Trace legacy tests
├── pipeline-orchestrator*.test.ts — FSM transitions, approval flow
└── ... (340+ diğer test dosyaları)

frontend/src/components/chat/__tests__/
├── ConversationSidebar.test.tsx (14 test)
├── ChatHeader.test.tsx          (17 test)
├── TraceProgressStepper.test.tsx (10 test)
├── ChatSkeleton.test.tsx        (5 test)
├── ChatMessage.test.tsx         (10 describe, ~40 test)
├── ChatInput.test.tsx           (10 test)
├── ChatPanel.scroll.test.tsx
├── EmptyState.test.tsx
├── PlanCard.test.tsx
└── ClarificationCard.test.tsx
```

---

## 9. Sonuç

AKIS platformunda agent doğrulaması 3 katmanda gerçekleşir:

1. **Birim düzeyi**: Her agent izole olarak test edilir (mock AI + mock GitHub)
2. **Entegrasyon düzeyi**: Pipeline orchestrator FSM geçişleri test edilir
3. **Sistem düzeyi**: Coverage matrix, gereksinimlerden testlere izlenebilirlik sağlar

Bu yapı, "bir agent'ın kendi çıktısını doğrulaması" problemini ortadan kaldırır
ve her üretim adımını bağımsız bir doğrulayıcı ile kontrol eder.

**Toplam test sayısı: 2100+ (backend: 1645, frontend: 457)**
