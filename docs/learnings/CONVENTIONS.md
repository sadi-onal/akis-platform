# AKIS Platform -- Conventions

> Bu dosya AKIS platformu genelinde gecerli kurallari, naming convention'lari
> ve teknik standartlari dokumante eder. Tum agent'lar ve pipeline bilesenleri
> bu kurallara uyar.

---

## 1. Naming Conventions

### Dosya ve Dizin Isimleri
- Agent dosyalari: `PascalCase` (ScribeAgent.ts, ProtoAgent.ts, TraceAgent.ts)
- Utility dosyalari: `kebab-case` (json-extract.ts, pipeline-factory.ts, activity-emitter.ts)
- Test dosyalari: `kebab-case.test.ts` veya `PascalCase.test.ts`
- Schema dosyalari: `kebab-case` (pipeline-schema.ts)
- Route dosyalari: `kebab-case` (pipeline.routes.ts, auth.oauth.ts)
- Dizin isimleri: `kebab-case` (agents/, core/, contracts/, adapters/)

### Degisken ve Fonksiyon Isimleri
- Fonksiyonlar: `camelCase` (extractJsonSafe, createPipelineError, parseAIJson)
- Interface'ler: `PascalCase` (ScribeAIDeps, ProtoGitHubDeps, PipelineError)
- Sabitler: `UPPER_SNAKE_CASE` (MAX_CLARIFICATION_ROUNDS, MIN_SCAFFOLD_FILES, RETRY_CONFIG)
- Type'lar: `PascalCase` (ScribeResult, ProtoResult, TraceResult)
- Enum-like const object'ler: `PascalCase` key, `UPPER_SNAKE_CASE` degerler (PipelineErrorCode)

### Branch ve Commit
- Branch: `main` (dogrudan push, PR yok -- MVP asama)
- Commit prefix'leri: `feat()`, `fix()`, `refactor()`, `docs()`, `chore()`, `test()`
- Scope ornekleri: `feat(pipeline)`, `fix(frontend)`, `refactor(auth)`, `docs(plan)`
- Commit dili: Ingilizce
- Co-author: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`

### API Endpoint'leri
- RESTful: `/api/pipelines`, `/api/pipelines/:id/approve`
- Verb mapping: GET=list/get, POST=create/action, PUT=update, DELETE=cancel
- Nested actions: `/api/pipelines/:id/message`, `/api/pipelines/:id/retry`

---

## 2. Agent Communication Contract

### Contract Formati
Her agent'in tip-guvenli contract'i:
```typescript
interface [Agent]Input { ... }   // Orchestrator'dan gelen input
interface [Agent]Output { ... }  // Agent'in dondurudugu output
type [Agent]Result =
  | { type: 'output'; data: [Agent]Output }
  | { type: 'error'; error: PipelineError };
```

### Dependency Injection Pattern
Her agent'in bagimliliklari interface uzerinden inject edilir:
```typescript
interface [Agent]AIDeps {
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}
interface [Agent]GitHubDeps {
  // GitHub islemleri (agent'a ozel subset)
}
```
- Agent'lar kendi DB/API client'larini OLUSTURMAZ
- Tool'lar orchestrator tarafindan inject edilir
- Bu pattern mock/test'i kolaylastirir

### Agent Izolasyonu
- Agent'lar birbirini dogrudan cagirmaz
- Tum iletisim PipelineOrchestrator uzerinden
- Her agent kendi scope'unda calisir:
  - Scribe: Idea --> Spec (AI only)
  - Proto: Spec --> Code (AI + GitHub write)
  - Trace: Code --> Tests (GitHub read + AI + GitHub write)

---

## 3. Error Handling Patterns

### PipelineError Tipi
```typescript
interface PipelineError {
  code: string;           // PipelineErrorCode enum degeri
  message: string;        // Turkce, kullaniciya gosterilir
  technicalDetail?: string; // Ingilizce, log icin
  retryable: boolean;     // Otomatik retry mumkun mu?
  recoveryAction?: string; // Frontend aksiyonu
}
```

### Error Olusturma
```typescript
createPipelineError(PipelineErrorCode.AI_RATE_LIMITED, 'Rate limit hit: 429')
```
- ERROR_DEFINITIONS const'unda tum hata kodlarinin default mesajlari ve recovery action'lari tanimli
- technicalDetail parametresi optional, debug icin eklenir

### Recovery Actions
| Action | Anlami |
|--------|--------|
| `retry` | Otomatik veya kullanici-tetikli tekrar deneme |
| `edit_spec` | Spec'i degistirip tekrar deneme |
| `reconnect_github` | GitHub baglantisini yenileme |
| `configure_ai_key` | AI API anahtari ekleme |

### Typed Error Classes
```typescript
PipelineNotFoundError   -- 404: pipeline bulunamiyor
InvalidStageError       -- 400: yanlis state'de islem
GitHubAPIError          -- 502: GitHub API hatasi
GitHubRateLimitError    -- 429: GitHub rate limit
```

---

## 4. JSON Parse Safety Chain

AI modelleri JSON output'u cesitli sekillerde dekore edebilir (markdown fences, control
chars, truncation). Bu zincir tum vakalari handle eder.

### Zincir Sirasi
```
AI Response --> extractJsonSafe --> JSON.parse
                                     |
                                     v (fail)
                              sanitizeJsonControlChars --> JSON.parse
                                                            |
                                                            v (fail)
                                                     repairTruncatedJson --> JSON.parse
                                                                              |
                                                                              v (fail)
                                                                        SyntaxError throw
```

### extractJsonSafe(text): string
4 strateji siraliyla:
1. **Pure JSON** -- Response `{` ile basliyor, son `}` bulunur
2. **Fenced code block** -- ` ```json ... ``` ` regex ile cikarilir
3. **Brace extraction** -- Ilk `{` ile son `}` arasi kesilir
4. **Fallback** -- Trimmed text dondurulur

### sanitizeJsonControlChars(json): string
- JSON string degerlerinin icindeki raw control char'lari escape eder
- LF --> `\n`, CR --> `\r`, TAB --> `\t`, diger --> `\uXXXX`
- Character-by-character state machine (inString tracking)

### repairTruncatedJson(text): string | null
- max_tokens cutoff'undan kaynaklanan truncated JSON'u onarir
- Acik string literal'lari kapatir (tek quote ekler)
- Trailing comma'lari kaldirir
- Acik bracket/brace'leri kapatir (stack-based tracking)
- Repair sonrasi JSON.parse ile dogrular, basarisizsa null dondurur

### parseAIJson<T>(text): T
- High-level API -- tum agent'lar bunu kullanir
- Sirali deneme: direct parse --> sanitize --> repair
- Hepsi basarisiz olursa: SyntaxError (ilk 200 char ile)

**Kaynak:** `backend/src/pipeline/core/json-extract.ts`

---

## 5. Temperature Policy

| Durum | Temperature | Neden |
|-------|-------------|-------|
| Generation (Scribe spec, Proto scaffold, Trace tests) | 0 | Deterministic, tekrarlanabilir output |
| Fix loop 1. iterasyon | 0 | Ilk deneme ayni stratejiyle |
| Fix loop 2. iterasyon | 0.1 | Hafif cesitlilik, farkli yaklasim denemesi |
| Fix loop 3. iterasyon | 0.2 | Daha fazla cesitlilik |
| Review (Critic, planned) | 0 | Strict, bias-free degerlendirme |

**Prensip:** Uretim temperature=0 ile baslar, fix loop'ta her iterasyonda 0.1 artar.
Bu, ayni hataya ayni cozumle yaklasma dongusunu kirar.

---

## 6. Timeout Policy

| Bilesan | Timeout | Neden |
|---------|---------|-------|
| Scribe stage | 5 dakika | Soru-cevap + spec generation |
| Proto stage | 5 dakika | Scaffold generation + GitHub push |
| Trace stage | 10 dakika | GitHub read + test generation (daha fazla islem) |
| AI call (tekil) | 3 dakika | Tek bir API cagrisinin max suresi |
| Retry backoff | 5s, 15s, 30s | Artan bekleme sureleri |

---

## 7. Language Policy

| Icerik | Dil |
|--------|-----|
| Kod (degisken, fonksiyon, yorum) | Ingilizce |
| UI text (buton, label, placeholder) | Turkce |
| Error mesajlari (kullaniciya) | Turkce |
| Technical detail (log) | Ingilizce |
| Commit mesajlari | Ingilizce |
| Dokumantasyon (CLAUDE.md, plan dosyalari) | Turkce veya Ingilizce (karisik) |
| Agent prompt'lari | Ingilizce (Turkish handling talimatlari icinde Turkce ornekler) |
| Spec output (title, userStories, AC) | Turkce |
| Test dosyalari (describe/it bloklari) | Ingilizce |
| Test text matcher'lari | Turkce (UI dili) |

---

## 8. Tech Stack Constraints

### Zorunlu
- Backend: Fastify 4 + TypeScript, PostgreSQL + Drizzle ORM
- Frontend: React 19 + Vite 7 SPA (Tailwind 4, React Router 7)
- AI: Anthropic (claude-sonnet-4-6)
- Test: Vitest (unit), Playwright (e2e)

### Yasak
- Express, NestJS, Prisma, Next.js
- SSR framework'ler
- Agent'larin kendi DB/API client olusturmasi

---

## 9. Quality Gate (Commit Oncesi)

```bash
# Backend
pnpm -C backend typecheck && pnpm -C backend lint && pnpm -C backend test:unit && pnpm -C backend build

# Frontend
pnpm -C frontend typecheck && pnpm -C frontend lint && pnpm -C frontend test && pnpm -C frontend build
```

Lint kurallarini devre disi birakarak hata susturmek YASAKTIR (gerekcelenmeden).
