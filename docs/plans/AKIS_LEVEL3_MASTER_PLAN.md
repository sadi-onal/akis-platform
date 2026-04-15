# AKIS LEVEL 3 EVOLUTION — MASTER PLAN

> **Bu plan bir "orchestrator" plan'dır. Claude Code bu dosyayı okuyacak, 4 ayrı sub-plan oluşturacak, her birini paralel bir Claude Code instance'ında çalıştıracak, sonra sonuçları birleştirecek.**

---

## BAĞLAM

AKIS şu an Shapiro Level 2'de: insan prompt veriyor → AI yazıyor → insan review ediyor.
Level 3'e geçiş için 4 bağımsız iş yapılacak, sonra 1 entegrasyon adımı.

**Proje dizini:** `~/Projects/bitirme_projesi/akis-platform-devolopment/devagents`

**YASAK KURALLAR (TÜM AGENT'LAR İÇİN):**
- `.env` dosyalarına ASLA dokunma, değiştirme, oluşturma, silme
- Mevcut çalışan dosyaları BACKUP almadan değiştirme
- Scope dışı özellik ekleme (Jira, Confluence, RAG, landing page)
- `node_modules/` içinde değişiklik yapma
- Mevcut testleri kırma — her değişiklik sonrası `pnpm -C backend typecheck` çalıştır
- Agent'lar birbirinin dosyalarına DOKUNMAZ (dosya sınırları aşağıda tanımlı)

---

## ADIM 0 — DISCOVERY & SUB-PLAN OLUŞTURMA

Bu adımda sen (master agent) şunları yap:

### 0.1 Projeyi tanı
```bash
cd ~/Projects/bitirme_projesi/akis-platform-devolopment/devagents
cat CLAUDE.md
ls backend/src/pipeline/agents/
ls backend/src/pipeline/core/
cat backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | head -100
cat backend/src/pipeline/agents/scribe/ScribeAgent.ts | head -80
cat backend/src/pipeline/agents/proto/ProtoAgent.ts | head -80
cat backend/src/pipeline/agents/trace/TraceAgent.ts | head -80
cat backend/src/services/ai/AIService.ts | head -60
ls backend/src/pipeline/core/contracts/
cat backend/src/pipeline/core/contracts/PipelineTypes.ts | head -100
```

### 0.2 Mevcut durumu doğrula
```bash
cd backend && pnpm typecheck && echo "✅ TYPECHECK PASSED" || echo "❌ TYPECHECK FAILED — ÖNCE BUNU DÜZELT"
```
Eğer typecheck FAIL ediyorsa, DURMA. Önce mevcut hataları düzelt, sonra devam et.

### 0.3 Sub-plan dosyalarını oluştur
Aşağıdaki 4 sub-plan dosyasını `docs/plans/` altında oluştur. Her plan kendi içinde bağımsız.

---

## SUB-PLAN A: CRITIC AGENT (Yeni dosyalar — çakışma riski YOK)

**Dosya:** `docs/plans/PLAN_A_CRITIC_AGENT.md`
**Dosya sınırı:** SADECE şu dizin ve dosyalar:
- `backend/src/pipeline/agents/critic/` (TÜM dosyalar — yeni dizin)
- `backend/src/pipeline/agents/critic/__tests__/` (testler)

**İçerik:**
```markdown
# PLAN A — CRITIC AGENT

## BAĞLAM
AKIS pipeline'ına inter-stage adversarial review eklenecek. CriticAgent, diğer agent'ların çıktılarını AYRI bir LLM session'ında (fresh context) review eder. Bu "AI reviewing AI" pattern'ıdır ve tezin "Knowledge Integrity & Agent Verification" temasını doğrudan güçlendirir.

## YASAK KURALLAR
- .env dosyalarına DOKUNMA
- `backend/src/pipeline/agents/critic/` DIŞINDA dosya oluşturma veya değiştirme
- PipelineOrchestrator.ts'ye DOKUNMA (entegrasyon ayrı yapılacak)
- PipelineTypes.ts'ye DOKUNMA (entegrasyon ayrı yapılacak)
- Mevcut agent dosyalarına DOKUNMA

## ADIM 0 — DISCOVERY
```bash
cd ~/Projects/bitirme_projesi/akis-platform-devolopment/devagents
cat CLAUDE.md
cat backend/src/pipeline/core/contracts/PipelineTypes.ts
cat backend/src/pipeline/agents/scribe/ScribeAgent.ts
cat backend/src/pipeline/agents/proto/ProtoAgent.ts
cat backend/src/services/ai/AIService.ts | head -100
```
Mevcut agent yapısını, tip tanımlarını ve AIService interface'ini anla.

## ADIM 1 — CriticAgent Dosya Yapısı
`backend/src/pipeline/agents/critic/` dizini oluştur:
```
critic/
├── CriticAgent.ts          ← Ana agent sınıfı
├── CriticTypes.ts          ← Input/Output tipleri
├── prompts/
│   ├── spec-review.ts      ← Scribe çıktısını review eden prompt
│   └── code-review.ts      ← Proto çıktısını review eden prompt
└── __tests__/
    ├── CriticAgent.test.ts
    └── prompts.test.ts
```

## ADIM 2 — CriticTypes.ts
```typescript
// CriticTypes.ts

export interface CriticReviewInput {
  /** Ne review ediliyor: 'spec' veya 'code' */
  reviewType: 'spec_review' | 'code_review';
  /** Review edilecek artifact (Scribe'ın spec'i veya Proto'nun kodu) */
  artifact: unknown;
  /** Orijinal kullanıcı fikri (bağlam için) */
  originalIdea: string;
  /** Eğer code_review ise, spec de gerekli (compliance check için) */
  referenceSpec?: unknown;
}

export interface CriticFinding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  category: 'completeness' | 'ambiguity' | 'consistency' | 'testability' | 'spec_compliance' | 'security';
  description: string;
  suggestion: string;
  /** Hangi bölümle ilgili */
  location?: string;
}

export interface CriticReviewOutput {
  approved: boolean;
  overallScore: number;        // 0-100
  findings: CriticFinding[];
  summary: string;
  reviewType: 'spec_review' | 'code_review';
  /** Kaçıncı review iterasyonu */
  iteration: number;
}
```

## ADIM 3 — Spec Review Prompt
`prompts/spec-review.ts` — Scribe'ın ürettiği StructuredSpec'i review eden prompt yaz.

Review kriterleri (ağırlıklı skor):
1. **Completeness (0.25)**: Problem statement, user stories, AC'ler, technical constraints, out of scope — hepsi var mı?
2. **Ambiguity (0.25)**: Her AC açık ve tek anlama mı geliyor? "Uygun" gibi belirsiz kelimeler var mı?
3. **Testability (0.20)**: Her AC Given/When/Then formatında mı? Trace bunları otomatik teste çevirebilir mi?
4. **Consistency (0.15)**: User story'ler birbiriyle çelişiyor mu? AC'ler arası çakışma var mı?
5. **Technical Feasibility (0.15)**: Spec'teki teknik kısıtlar mantıklı mı? Over-engineering var mı?

Prompt'un system kısmı:
- "Sen bir BAĞIMSIZ spec reviewer'sın. Bu spec'i SEN yazmadın. Amacın bulabildiğin her problemi bulmak."
- "Spec'i üreten agent ile AYNI context'te DEĞİLSİN. Fresh eyes ile bakıyorsun."
- JSON formatında CriticReviewOutput döndür.

Eşik: `overallScore >= 75` → approved: true, aksi halde approved: false

## ADIM 4 — Code Review Prompt  
`prompts/code-review.ts` — Proto'nun ürettiği kodu Scribe'ın spec'ine karşı review eden prompt yaz.

Review kriterleri:
1. **Spec Compliance (0.35)**: Her AC için kod karşılığı var mı? Spec'te olan ama kodda olmayan ne var?
2. **Code Quality (0.20)**: TypeScript best practices, error handling, type safety
3. **Security (0.20)**: Input validation, injection riskleri, hardcoded secrets
4. **Completeness (0.15)**: Import'lar doğru mu? Dosya yapısı tutarlı mı?
5. **Testability (0.10)**: Bu kodu Trace test yazabilir mi? Mock'lanabilir mi?

## ADIM 5 — CriticAgent.ts
Ana agent sınıfını yaz:
- Constructor: `AIService` injection alır (mevcut pattern'ı takip et)
- `reviewSpec(input: CriticReviewInput): Promise<CriticReviewOutput>` 
- `reviewCode(input: CriticReviewInput): Promise<CriticReviewOutput>`
- Her review AYRI bir Claude API call'u — fresh context, önceki agent'ın conversation history'si YOK
- `temperature: 0` kullan (deterministik review)
- JSON parse için mevcut `extractJson` + `sanitizeJsonControlChars` utility'lerini import et

## ADIM 6 — Testler
- `CriticAgent.test.ts`: MockAIService ile spec_review ve code_review senaryoları
- Mock fixture'lar: iyi bir spec (approved olmalı), kötü bir spec (rejected olmalı), iyi kod, kötü kod
- En az 8 test case

## ADIM 7 — Doğrulama
```bash
cd backend && pnpm typecheck
cd backend && pnpm test:unit -- --testPathPattern="critic"
```
Her ikisi de PASS etmeli. Etmezse düzelt, tekrar çalıştır.

## DURUM RAPORU
İşin bittiğinde şu formatta bir rapor yaz:
```
## AGENT A — CRITIC AGENT RAPORU
- Durum: ✅ TAMAMLANDI / ❌ BAŞARISIZ
- Oluşturulan dosyalar: [liste]
- Test sonuçları: X/Y passing
- Typecheck: PASS/FAIL
- Notlar: [varsa]
```
Bu raporu `docs/plans/REPORT_A_CRITIC.md` olarak kaydet.
```

---

## SUB-PLAN B: FIX LOOP SERVİSİ (Yeni dosyalar — çakışma riski YOK)

**Dosya:** `docs/plans/PLAN_B_FIX_LOOP.md`
**Dosya sınırı:** SADECE şu dosyalar:
- `backend/src/pipeline/core/fix-loop/` (TÜM dosyalar — yeni dizin)
- `backend/src/pipeline/core/fix-loop/__tests__/`

**İçerik:**
```markdown
# PLAN B — FIX LOOP SERVİSİ

## BAĞLAM
Trace testleri fail ettiğinde, Proto'nun kodu otomatik düzeltmesi için bir self-healing loop gerekiyor. Bu loop: Trace fail → hata mesajını Proto'ya gönder → Proto düzelt → Trace tekrar test et. Max 3 iterasyon.

Bu StrongDM'in "holdout test" pattern'ı ve LLMloop araştırmasındaki "fix-test-fix" loop'unun AKIS implementasyonu.

## YASAK KURALLAR
- .env dosyalarına DOKUNMA
- `backend/src/pipeline/core/fix-loop/` DIŞINDA dosya oluşturma veya değiştirme
- PipelineOrchestrator.ts'ye DOKUNMA
- Mevcut agent dosyalarına DOKUNMA

## ADIM 0 — DISCOVERY
```bash
cd ~/Projects/bitirme_projesi/akis-platform-devolopment/devagents
cat CLAUDE.md
cat backend/src/pipeline/core/contracts/PipelineTypes.ts
cat backend/src/pipeline/agents/proto/ProtoAgent.ts
cat backend/src/pipeline/agents/trace/TraceAgent.ts
cat backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | head -150
```
Proto ve Trace'in input/output tiplerini anla. Orchestrator'ın akışını anla.

## ADIM 1 — Fix Loop Dosya Yapısı
```
fix-loop/
├── FixLoopService.ts       ← Ana servis
├── FixLoopTypes.ts         ← Tipler
└── __tests__/
    └── FixLoopService.test.ts
```

## ADIM 2 — FixLoopTypes.ts
```typescript
export interface FixLoopConfig {
  maxIterations: number;          // default: 3
  baseTemperature: number;        // default: 0
  temperatureIncrement: number;   // default: 0.1 (her iterasyonda artar)
  timeoutPerIteration: number;    // default: 5 * 60 * 1000 (5 dakika)
}

export interface FixLoopIteration {
  iteration: number;
  temperature: number;
  protoOutput: unknown;   // ProtoOutput
  traceOutput: unknown;   // TraceOutput
  testsPassed: boolean;
  failureReason?: string;
  durationMs: number;
}

export interface FixLoopResult {
  success: boolean;
  totalIterations: number;
  iterations: FixLoopIteration[];
  finalProtoOutput?: unknown;
  finalTraceOutput?: unknown;
  /** Neden durdu: 'tests_passed' | 'max_iterations' | 'timeout' | 'error' */
  terminationReason: string;
}
```

## ADIM 3 — FixLoopService.ts
Şu mantığı implement et:
```
function runFixLoop(spec, protoAgent, traceAgent, config):
  for i in 0..config.maxIterations:
    temperature = config.baseTemperature + (i * config.temperatureIncrement)
    
    if i == 0:
      protoOutput = protoAgent.run(spec, temperature)
    else:
      // Önceki iterasyonun hata mesajını Proto'ya feedback olarak ver
      protoOutput = protoAgent.runWithFeedback(spec, previousFailure, temperature)
    
    traceOutput = traceAgent.run(protoOutput)
    
    if traceOutput.allTestsPassed:
      return { success: true, iteration: i }
    else:
      previousFailure = traceOutput.failureSummary
  
  return { success: false, iterations: all }
```

ÖNEMLİ:
- Bu servis ProtoAgent ve TraceAgent'ı DOĞRUDAN çağırmaz. Callback function'lar alır.
- `runProto: (spec, feedback?, temperature?) => Promise<ProtoOutput>`
- `runTrace: (protoOutput) => Promise<TraceOutput>`
- Bu sayede orchestrator integration'da agent'ları inject edebiliriz.

## ADIM 4 — Testler
- Happy path: İlk iterasyonda testler geçer → success
- Fix path: İlk 2 iterasyon fail, 3. iterasyon pass → success
- Max iterations: 3 iterasyon da fail → terminationReason: 'max_iterations'
- Temperature escalation: Her iterasyonda temperature 0.1 artıyor mu?
- Timeout: Bir iterasyon timeout olursa ne oluyor?
- En az 6 test case

## ADIM 5 — Doğrulama
```bash
cd backend && pnpm typecheck
cd backend && pnpm test:unit -- --testPathPattern="fix-loop"
```

## DURUM RAPORU
`docs/plans/REPORT_B_FIXLOOP.md` olarak kaydet (aynı format).
```

---

## SUB-PLAN C: LEARNINGS & KNOWLEDGE BASE (Sadece docs — çakışma riski YOK)

**Dosya:** `docs/plans/PLAN_C_KNOWLEDGE.md`
**Dosya sınırı:** SADECE şu dizin ve dosyalar:
- `docs/learnings/` (yeni dizin)
- `docs/architecture/` (yeni dizin)

**İçerik:**
```markdown
# PLAN C — LEARNINGS & KNOWLEDGE BASE

## BAĞLAM
Her pipeline run'ından sonra agent'ların öğrendiklerini biriktiren bir knowledge base oluşturulacak. Bu Addy Osmani'nin AGENTS.md pattern'ı. Ayrıca AKIS'in Level 3 mimarisini dokümante eden bir architecture doc yazılacak.

## YASAK KURALLAR
- .env dosyalarına DOKUNMA
- `docs/learnings/` ve `docs/architecture/` DIŞINDA dosya oluşturma veya değiştirme
- Kod dosyalarına DOKUNMA

## ADIM 0 — DISCOVERY
```bash
cd ~/Projects/bitirme_projesi/akis-platform-devolopment/devagents
cat CLAUDE.md
ls docs/
cat backend/src/pipeline/agents/scribe/ScribeAgent.ts | head -50
cat backend/src/pipeline/agents/proto/ProtoAgent.ts | head -50
cat backend/src/pipeline/agents/trace/TraceAgent.ts | head -50
```

## ADIM 1 — Learnings Dizin Yapısı
```
docs/learnings/
├── SCRIBE_LEARNINGS.md
├── PROTO_LEARNINGS.md
├── TRACE_LEARNINGS.md
├── CRITIC_LEARNINGS.md
├── PIPELINE_LEARNINGS.md
└── CONVENTIONS.md
```

## ADIM 2 — Her agent için LEARNINGS.md şablonu oluştur
Her dosya şu bölümleri içersin:
```markdown
# [Agent Adı] — Accumulated Learnings

> Bu dosya pipeline run'larından öğrenilen pattern'ları, hataları ve çözümleri biriktirir.
> Her başarılı/başarısız run sonrası güncellenir.

## Known Good Patterns
<!-- Hangi prompt pattern'ları iyi sonuç veriyor? -->

## Known Failure Modes  
<!-- Hangi durumlarda fail oluyor? Kök sebep neydi? -->

## Workarounds & Fixes
<!-- Bulunan geçici veya kalıcı çözümler -->

## Quality Baselines
<!-- Ortalama güven skoru, ortalama süre, ortalama dosya sayısı vb. -->

## Convention Notes
<!-- Bu agent için özel kurallar, kısıtlamalar -->
```

## ADIM 3 — CONVENTIONS.md
AKIS genelinde geçerli kurallar:
- Naming conventions (dosya, branch, commit)
- Agent communication contract formatı
- Error handling pattern'ları
- JSON parse güvenlik zinciri: extractJson → sanitizeJsonControlChars → repairJson
- Temperature policy: generation=0, fix-loop'ta 0.1 increment
- Timeout policy: Scribe/Proto 5dk, Trace 10dk

## ADIM 4 — Architecture Decision Records
`docs/architecture/` dizini oluştur:
```
docs/architecture/
├── ADR-001-adversarial-review.md
├── ADR-002-fix-loop-pattern.md
├── ADR-003-holdout-testing.md
└── ADR-004-level3-pipeline-architecture.md
```

Her ADR şu formatta:
```markdown
# ADR-XXX: [Başlık]

## Durum
Kabul Edildi — [Tarih]

## Bağlam
[Neden bu karar gerekti?]

## Karar
[Ne kararlaştırıldı?]

## Sonuçlar
[Artıları, eksileri, trade-off'lar]

## Referanslar
[Araştırma kaynakları: StrongDM, HubSpot Sidekick, METR 2025, LLMloop, Reflexion vb.]
```

### ADR-001: Adversarial Review
- Bağlam: AI-generated output'ları AI ile review etmek (Shapiro Level 3)
- Karar: Her pipeline stage arasına CriticAgent ekle, fresh LLM session'da review yap
- Referans: HubSpot Sidekick (90% faster feedback), SentinelOne adversarial consensus, ASDLC.io pattern

### ADR-002: Fix Loop Pattern  
- Bağlam: Trace fail → Proto düzelt döngüsü (self-healing pipeline)
- Karar: Max 3 iterasyon, temperature escalation (0 → 0.1 → 0.2)
- Referans: LLMloop (ICSME 2025), StrongDM holdout testing

### ADR-003: Holdout Testing
- Bağlam: Trace'in testlerini Proto'dan gizlemek (ML train/test split analojisi)
- Karar: Trace testleri ayrı tutulur, Proto bu testleri görmez, sadece spec'i görür
- Referans: StrongDM NLSpec, ML holdout validation

### ADR-004: Level 3 Pipeline Architecture  
- Bağlam: AKIS'in Shapiro Level 2'den Level 3'e geçişi
- Karar: Scribe → CriticSpec → Human Gate → Proto → CriticCode → Trace → FixLoop
- Yeni pipeline FSM state'leri: critic_reviewing_spec, critic_reviewing_code, fix_loop_iteration_N

## ADIM 5 — Doğrulama
Tüm markdown dosyalarının syntax'ını kontrol et. Kırık linkler var mı?

## DURUM RAPORU
`docs/plans/REPORT_C_KNOWLEDGE.md` olarak kaydet.
```

---

## SUB-PLAN D: PIPELINE METRICS & DOGFOODING SETUP (Yeni dosyalar — çakışma riski YOK)

**Dosya:** `docs/plans/PLAN_D_METRICS.md`
**Dosya sınırı:** SADECE şu dosyalar:
- `backend/src/pipeline/core/metrics/` (yeni dizin)
- `backend/src/pipeline/core/metrics/__tests__/`
- `docs/dogfooding/` (yeni dizin)

**İçerik:**
```markdown
# PLAN D — PIPELINE METRICS & DOGFOODING

## BAĞLAM  
J-curve'den çıkmak için ölçüm şart. Her pipeline run'ının metriklerini toplayan bir servis + AKIS'i kendi geliştirmesinde kullanma (dogfooding) setup'ı.

## YASAK KURALLAR
- .env dosyalarına DOKUNMA
- Belirtilen dizinler DIŞINDA dosya oluşturma veya değiştirme
- Mevcut kod dosyalarına DOKUNMA

## ADIM 0 — DISCOVERY
```bash
cd ~/Projects/bitirme_projesi/akis-platform-devolopment/devagents
cat CLAUDE.md
cat backend/src/pipeline/core/contracts/PipelineTypes.ts
ls backend/src/pipeline/core/
```

## ADIM 1 — Metrics Dosya Yapısı
```
metrics/
├── PipelineMetrics.ts      ← Metrik toplama servisi
├── MetricTypes.ts          ← Tip tanımları
└── __tests__/
    └── PipelineMetrics.test.ts
```

## ADIM 2 — MetricTypes.ts
```typescript
export interface StageMetric {
  stageName: string;              // 'scribe' | 'critic_spec' | 'proto' | 'critic_code' | 'trace' | 'fix_loop'
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  success: boolean;
  /** Agent-specific metrikler */
  metadata: Record<string, unknown>;
  // Scribe: { confidenceScore, clarificationsCount }
  // Critic: { overallScore, findingsCount, approved }
  // Proto: { filesGenerated, linesOfCode }
  // Trace: { testsGenerated, coveragePercent }
  // FixLoop: { iterationCount, temperatureUsed }
}

export interface PipelineRunMetric {
  pipelineId: string;
  startedAt: Date;
  completedAt?: Date;
  totalDurationMs?: number;
  stages: StageMetric[];
  finalStatus: string;
  /** Toplam LLM token kullanımı */
  totalTokensUsed?: number;
  /** Toplam LLM API maliyeti (tahmini) */
  estimatedCostUsd?: number;
}

export interface MetricsSummary {
  totalRuns: number;
  successRate: number;
  avgDurationMs: number;
  avgScribeConfidence: number;
  avgCriticScore: number;
  fixLoopStats: {
    avgIterations: number;
    fixSuccessRate: number;
  };
}
```

## ADIM 3 — PipelineMetrics.ts
In-memory metrik toplama servisi:
- `startStage(pipelineId, stageName)` → timer başlat
- `endStage(pipelineId, stageName, success, metadata)` → timer durdur, kaydet
- `getRunMetrics(pipelineId)` → PipelineRunMetric döndür
- `getSummary()` → MetricsSummary döndür (tüm run'ların ortalaması)

## ADIM 4 — Dogfooding Dokümanı
`docs/dogfooding/` dizini oluştur:

### `docs/dogfooding/DOGFOODING_GUIDE.md`
```markdown
# AKIS Dogfooding Guide

## Konsept
AKIS'i kendi geliştirmesinde kullanmak — "eat your own dog food"

## Dogfooding Senaryoları

### Senaryo 1: Login Sayfası
- Fikir: "AKIS için bir kullanıcı giriş sayfası oluştur. GitHub ve Google OAuth butonları, e-posta/şifre formu, 'Şifremi unuttum' linki olsun."
- Pipeline'a ver → Scribe spec yazsın → Onayla → Proto scaffold üretsin → Trace test yazsın
- Çıkan kodu AKIS frontend'iyle karşılaştır

### Senaryo 2: Pipeline Status Component
- Fikir: "Bir pipeline'ın durumunu gösteren React component oluştur. Her stage (Scribe, Proto, Trace) için progress indicator, süre bilgisi ve hata mesajı göstersin."
- Pipeline'a ver → sonuçları değerlendir

### Senaryo 3: API Health Check
- Fikir: "Basit bir health check endpoint'i oluştur. Sunucu durumu, veritabanı bağlantısı ve AI servis durumunu JSON olarak döndürsün."
- Pipeline'a ver → sonuçları değerlendir

## Değerlendirme Kriterleri
Her dogfooding run'ı şu kriterlerle değerlendirilir:
1. Scribe spec kalitesi (confidence score)
2. Proto kod kalitesi (derlenebilir mi? çalışır mı?)
3. Trace test kalitesi (anlamlı testler mi?)
4. Toplam süre
5. İnsan müdahalesi gerektiren nokta sayısı
```

## ADIM 5 — Testler
```bash
cd backend && pnpm typecheck
cd backend && pnpm test:unit -- --testPathPattern="metrics"
```

## DURUM RAPORU
`docs/plans/REPORT_D_METRICS.md` olarak kaydet.
```

---

## ADIM 1 — SUB-PLAN DOSYALARINI OLUŞTUR

Yukarıdaki 4 sub-plan'ı dosya olarak oluştur:
```bash
mkdir -p docs/plans
# Her sub-plan'ı kendi dosyasına yaz
```

---

## ADIM 2 — PARALEL AGENT'LARI BAŞLAT

4 agent'ı aynı anda başlat. Her biri kendi plan dosyasını okuyup bağımsız çalışacak:

```bash
PROJECT_DIR=~/Projects/bitirme_projesi/akis-platform-devolopment/devagents

# Agent A — Critic Agent
claude --model claude-opus-4-6-20250710 --max-turns 80 -p \
  "Proje dizini: $PROJECT_DIR — Bu dizine git ve çalış. docs/plans/PLAN_A_CRITIC_AGENT.md dosyasını oku ve adım adım uygula. Her adımda hata varsa düzelt. Act mode'da çalış. .env dosyalarına ASLA dokunma. İşin bitince docs/plans/REPORT_A_CRITIC.md dosyasına durum raporu yaz." \
  > /tmp/akis_agent_a.log 2>&1 &
AGENT_A_PID=$!
echo "Agent A başlatıldı (PID: $AGENT_A_PID)"

# Agent B — Fix Loop
claude --model claude-opus-4-6-20250710 --max-turns 80 -p \
  "Proje dizini: $PROJECT_DIR — Bu dizine git ve çalış. docs/plans/PLAN_B_FIX_LOOP.md dosyasını oku ve adım adım uygula. Her adımda hata varsa düzelt. Act mode'da çalış. .env dosyalarına ASLA dokunma. İşin bitince docs/plans/REPORT_B_FIXLOOP.md dosyasına durum raporu yaz." \
  > /tmp/akis_agent_b.log 2>&1 &
AGENT_B_PID=$!
echo "Agent B başlatıldı (PID: $AGENT_B_PID)"

# Agent C — Knowledge Base
claude --model claude-opus-4-6-20250710 --max-turns 50 -p \
  "Proje dizini: $PROJECT_DIR — Bu dizine git ve çalış. docs/plans/PLAN_C_KNOWLEDGE.md dosyasını oku ve adım adım uygula. Sadece docs/ dizininde çalış. Kod dosyalarına DOKUNMA. İşin bitince docs/plans/REPORT_C_KNOWLEDGE.md dosyasına durum raporu yaz." \
  > /tmp/akis_agent_c.log 2>&1 &
AGENT_C_PID=$!
echo "Agent C başlatıldı (PID: $AGENT_C_PID)"

# Agent D — Metrics
claude --model claude-opus-4-6-20250710 --max-turns 60 -p \
  "Proje dizini: $PROJECT_DIR — Bu dizine git ve çalış. docs/plans/PLAN_D_METRICS.md dosyasını oku ve adım adım uygula. Her adımda hata varsa düzelt. Act mode'da çalış. .env dosyalarına ASLA dokunma. İşin bitince docs/plans/REPORT_D_METRICS.md dosyasına durum raporu yaz." \
  > /tmp/akis_agent_d.log 2>&1 &
AGENT_D_PID=$!
echo "Agent D başlatıldı (PID: $AGENT_D_PID)"

echo ""
echo "=========================================="
echo "4 AGENT PARALEL ÇALIŞIYOR"
echo "=========================================="
echo "Agent A (Critic):     PID $AGENT_A_PID → /tmp/akis_agent_a.log"
echo "Agent B (Fix Loop):   PID $AGENT_B_PID → /tmp/akis_agent_b.log"
echo "Agent C (Knowledge):  PID $AGENT_C_PID → /tmp/akis_agent_c.log"
echo "Agent D (Metrics):    PID $AGENT_D_PID → /tmp/akis_agent_d.log"
echo "=========================================="
echo ""
echo "Log takibi: tail -f /tmp/akis_agent_*.log"
echo "Bekleniyor..."

# Tüm agent'ların bitmesini bekle
wait $AGENT_A_PID $AGENT_B_PID $AGENT_C_PID $AGENT_D_PID

echo ""
echo "=========================================="
echo "TÜM AGENT'LAR TAMAMLANDI"
echo "=========================================="
```

---

## ADIM 3 — RAPORLARI KONTROL ET

```bash
echo "=== AGENT RAPORLARI ==="
for report in docs/plans/REPORT_*.md; do
  echo "--- $report ---"
  cat "$report"
  echo ""
done
```

Tüm raporlarda ✅ TAMAMLANDI görmelisin. Herhangi birinde ❌ varsa, o agent'ın log'unu incele ve sorunu çöz.

---

## ADIM 4 — ENTEGRASYON (Sıralı — tüm agent'lar bittikten sonra)

Bu adımı SEN (master agent) yapacaksın. Paralel agent'ların ürettiği dosyaları mevcut sisteme entegre et.

### 4.1 — PipelineTypes.ts güncelle
```bash
cat backend/src/pipeline/core/contracts/PipelineTypes.ts
```
Yeni state'leri ekle:
- `critic_reviewing_spec` (Scribe sonrası)
- `critic_reviewing_code` (Proto sonrası)  
- `fix_loop_iteration` (Trace fail sonrası)

CriticReviewOutput ve FixLoopResult tiplerini import veya re-export et.

### 4.2 — PipelineOrchestrator.ts güncelle
```bash
cat backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts
```
Mevcut akışı genişlet:
```
ESKI:  Scribe → awaiting_approval → Proto → Trace → completed
YENİ:  Scribe → critic_reviewing_spec → awaiting_approval → Proto → critic_reviewing_code → Trace → [fix_loop if fail] → completed
```

- CriticAgent'ı import et, Scribe sonrası çağır
- Critic approved=false ise → Scribe'a geri gönder (max 2 retry)
- Proto sonrası CriticAgent code_review çağır
- Critic approved=false ise → Proto'ya geri gönder
- Trace fail ise → FixLoopService başlat

### 4.3 — PipelineMetrics entegrasyonu
- PipelineMetrics servisini orchestrator'a inject et
- Her stage başında `metrics.startStage()`, sonunda `metrics.endStage()` çağır

### 4.4 — Pipeline API route güncelle
```bash
cat backend/src/pipeline/api/pipeline.routes.ts
```
- `GET /api/pipelines/:id/metrics` → pipeline metriklerini döndür
- Mevcut response'lara critic ve fix-loop bilgilerini ekle

### 4.5 — Tam test suite çalıştır
```bash
cd backend && pnpm typecheck && echo "✅ TYPECHECK" || echo "❌ TYPECHECK FAILED"
cd backend && pnpm test:unit && echo "✅ UNIT TESTS" || echo "❌ UNIT TESTS FAILED"
```

HER İKİSİ DE PASS ETMELİ. Fail eden testleri düzelt.

### 4.6 — Final entegrasyon testi
```bash
# Eğer DEV_MODE=true ve backend çalışıyorsa:
curl -X POST http://localhost:3000/api/pipelines \
  -H "Content-Type: application/json" \
  -d '{"idea": "Basit bir hello world web uygulaması oluştur"}'
```
Pipeline'ın yeni akışla (critic → fix loop dahil) çalıştığını doğrula.

---

## ADIM 5 — FINAL DURUM RAPORU

```markdown
## AKIS LEVEL 3 EVOLUTION — FINAL RAPOR

### Tamamlanan İşler
- [ ] Agent A: CriticAgent (spec review + code review)
- [ ] Agent B: FixLoopService (self-healing pipeline)
- [ ] Agent C: Learnings knowledge base + ADR'lar
- [ ] Agent D: Pipeline metrics + dogfooding guide
- [ ] Entegrasyon: Orchestrator + Types + Routes güncellendi

### Yeni Pipeline Akışı
Scribe → CriticSpec → Human Gate → Proto → CriticCode → Trace → FixLoop → Completed

### Test Sonuçları
- Typecheck: PASS/FAIL
- Unit tests: X/Y passing
- Yeni testler: Z adet

### Dosya Değişiklikleri
[Değişen/eklenen dosya listesi]

### Bilinen Sorunlar
[Varsa]

### Sonraki Adımlar (Post-Thesis)
- DSPy prompt optimization
- Vector DB archival memory
- LangGraph migration
- Digital Twin Universe
```

Bu raporu `docs/plans/FINAL_REPORT.md` olarak kaydet.
