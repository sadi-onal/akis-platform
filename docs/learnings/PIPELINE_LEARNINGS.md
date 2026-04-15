# Pipeline-Wide Learnings

> Bu dosya pipeline genelindeki pattern'lari, hatalari ve cozumleri biriktirir.
> Agent-specific olmayan, pipeline orkestrasyon seviyesindeki ogrenimler burada toplanir.

## Known Good Patterns

### Sequential Agent Pipeline (FSM)
Pipeline, deterministik bir state machine olarak calisir:
```
scribe_clarifying --> scribe_generating --> awaiting_approval
--> proto_building --> trace_testing --> completed | completed_partial
Her adimda --> failed (retryable) | cancelled
```

### PipelineOrchestrator -- Merkezi Kontrol
- Agent'lar birbirini dogrudan cagirmaz
- Tum iletisim PipelineOrchestrator uzerinden
- Tool'lar orchestrator tarafindan inject edilir -- agent'lar DB/API client'larini kendileri olusturmaz
- Dependency Injection pattern: her agent'in `*AIDeps` ve `*GitHubDeps` interface'leri var

### Error Handling Architecture
Tum hatalar `PipelineError` tipinde:
- `code`: Typed error kodu (PipelineErrorCode enum)
- `message`: Kullaniciya gosterilecek Turkce mesaj
- `technicalDetail`: Debug icin teknik detay
- `retryable`: Otomatik retry yapilabilir mi?
- `recoveryAction`: Frontend'in gosterecegi aksiyon (retry, edit_spec, reconnect_github, configure_ai_key)

### Error Categories
| Kategori | Kodlar | Retryable |
|----------|--------|-----------|
| AI Hatalari | AI_RATE_LIMITED, AI_PROVIDER_ERROR, AI_INVALID_RESPONSE | Evet |
| Scribe | SCRIBE_EMPTY_IDEA, SCRIBE_SPEC_VALIDATION_FAILED | Kismi |
| GitHub | GITHUB_NOT_CONNECTED, GITHUB_REPO_EXISTS, GITHUB_PERMISSION_DENIED, GITHUB_API_ERROR | Kismi |
| Proto | PROTO_SCAFFOLD_GENERATION_FAILED, PROTO_PUSH_FAILED | Evet |
| Trace | TRACE_CODE_READ_FAILED, TRACE_EMPTY_CODEBASE, TRACE_TEST_GENERATION_FAILED, TRACE_AI_CALL_TIMEOUT | Kismi |
| Genel | AI_KEY_MISSING, PIPELINE_TIMEOUT, PIPELINE_CANCELLED, NETWORK_ERROR | Kismi |

### Retry Policy
```
maxRetries: 3
backoffDelays: [5s, 15s, 30s]
specValidationMaxRetries: 2
stageTimeoutMs: 5 * 60 * 1000 (5 dakika)
traceStageTimeoutMs: 10 * 60 * 1000 (10 dakika)
aiCallTimeoutMs: 3 * 60 * 1000 (3 dakika)
maxCodebaseContextChars: 200,000
```

### JSON Parse Safety Chain (Pipeline-Wide)
Tum agent'larin AI yanitlari icin ortaklasa kullandigi 4-katmanli guvenlik zinciri:
1. `extractJsonSafe()` -- 4 strateji: pure JSON, fenced code block, brace extraction, fallback
2. `sanitizeJsonControlChars()` -- String icindeki control char'lari escape eder
3. `repairTruncatedJson()` -- Truncated JSON'u acik string/array/object kapatarak onarir
4. `parseAIJson<T>()` -- High-level: extract --> parse --> sanitize --> repair

Detay: `backend/src/pipeline/core/json-extract.ts`

### Activity Emitter
- `createActivityEmitter(pipelineId, agentName)` ile real-time progress tracking
- Her agent kendi stage'ini emit eder
- Frontend SSE veya polling ile takip eder

### Human-in-the-Loop Gate
- Pipeline `awaiting_approval` state'inde durur
- Kullanici spec'i gorur, onaylar veya reddeder
- Onaylama: Proto baslatilir
- Reddetme: Scribe tekrar sorar (feedback ile)

### Iteration Mode
- Follow-up degisiklikler icin Scribe atlanabilir
- Proto mevcut kod uzerinde calisir (sifirdan degil)
- Pipeline kisa yoldan Proto'ya gecer

## Known Failure Modes

### Pipeline Timeout
- **Belirtiler:** Stage 5 dakikadan (Trace: 10 dk) fazla suruyor.
- **Kok sebep:** AI yanit vermiyor veya cok yavas, GitHub API yavas.
- **Recovery:** retryable=true, PIPELINE_TIMEOUT error.

### Network Connectivity
- **Belirtiler:** API cagirilari basarisiz, connection refused/timeout.
- **Kok sebep:** Internet baglantisi, GitHub/Anthropic API kesintisi.
- **Recovery:** retryable=true, NETWORK_ERROR. "Baglanti geldiginde devam edilecek."

### AI Key Missing
- **Belirtiler:** Pipeline baslatilmiyor.
- **Kok sebep:** Kullanici AI API anahtarini ayarlardan eklememis.
- **Recovery:** retryable=false, recoveryAction=configure_ai_key.

### Race Condition (Signup)
- **Belirtiler:** Ayni email ile es zamanli kayit.
- **Kok sebep:** Concurrent request handling.
- **Cozum:** Backend'de race condition fix'i (commit: b98d9ab).

## Workarounds & Fixes

### Skip Trace Endpoint
- `POST /api/pipelines/:id/skip-trace` ile Trace atlanabilir
- Pipeline `completed_partial` durumuna gecer
- Kullanici Trace basarisiz oldugunda pipeline'i tamamlayabilir

### Dry Run Mode
- Proto ve Trace'de `dryRun` flagi
- Test ortaminda gercek GitHub API'ye dokunmaz
- MockAIService + GitHubServiceLike interface ile tam izolasyon

### Typed Error Classes
```typescript
PipelineNotFoundError  -- pipeline ID bulunamiyor
InvalidStageError      -- yanlis stage'de islem yapilmaya calisiyor
GitHubAPIError         -- GitHub API genel hatasi (statusCode ile)
GitHubRateLimitError   -- GitHub rate limit (retryable=false)
```

## Quality Baselines

| Metrik | Beklenen | Notlar |
|--------|----------|--------|
| Pipeline completion rate | > 80% | completed + completed_partial |
| Average pipeline duration | < 3 dakika | Scribe + approval + Proto + Trace |
| Retry success rate | > 60% | Retryable hatalarin kac tanesi basarili |
| Human approval rate | > 70% | Spec onaylama orani |
| JSON parse failure rate | < 2% | parseAIJson guvenlik zinciri |

## Convention Notes

- Pipeline state'leri DB'de tutulur (pipeline-schema.ts)
- Tum mesajlar Turkce (kullanici-goren), teknik detaylar Ingilizce (log)
- AI provider: Anthropic (claude-sonnet-4-6), temperature=0
- Mock test sistemi: AI_PROVIDER=mock --> MockAIService, fixtures: `services/ai/__fixtures__/`
- GitHubServiceLike interface ile mock GitHub (test'lerde gercek push yok)
- Pipeline output'lari ASLA platform repo'suna push edilmez
