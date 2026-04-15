# PLAN D — PIPELINE METRICS & DOGFOODING

## CONTEXT
J-curve'den cikmak icin olcum sart. Her pipeline run'inin metriklerini toplayan bir servis + AKIS'i kendi gelistirmesinde kullanma (dogfooding) setup'i.

## FORBIDDEN RULES
- .env dosyalarina DOKUNMA
- Belirtilen dizinler DISINDA dosya olusturma veya degistirme
- Mevcut kod dosyalarina DOKUNMA

## ADIM 0 — DISCOVERY
```bash
cd ~/Projects/bitirme_projesi/akis-platform-devolopment/devagents
cat CLAUDE.md
cat backend/src/pipeline/core/contracts/PipelineTypes.ts
ls backend/src/pipeline/core/
```

## ADIM 1 — Metrics Dosya Yapisi
```
metrics/
├── PipelineMetrics.ts      <- Metrik toplama servisi
├── MetricTypes.ts          <- Tip tanimlari
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
  /** Toplam LLM token kullanimi */
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
- `startStage(pipelineId, stageName)` -> timer baslat
- `endStage(pipelineId, stageName, success, metadata)` -> timer durdur, kaydet
- `getRunMetrics(pipelineId)` -> PipelineRunMetric dondur
- `getSummary()` -> MetricsSummary dondur (tum run'larin ortalamasi)

## ADIM 4 — Dogfooding Dokumani
`docs/dogfooding/` dizini olustur:

### `docs/dogfooding/DOGFOODING_GUIDE.md`
```markdown
# AKIS Dogfooding Guide

## Konsept
AKIS'i kendi gelistirmesinde kullanmak — "eat your own dog food"

## Dogfooding Senaryolari

### Senaryo 1: Login Sayfasi
- Fikir: "AKIS icin bir kullanici giris sayfasi olustur. GitHub ve Google OAuth butonlari, e-posta/sifre formu, 'Sifremi unuttum' linki olsun."
- Pipeline'a ver -> Scribe spec yazsin -> Onayla -> Proto scaffold uretsin -> Trace test yazsin
- Cikan kodu AKIS frontend'iyle karsilastir

### Senaryo 2: Pipeline Status Component
- Fikir: "Bir pipeline'in durumunu gosteren React component olustur. Her stage (Scribe, Proto, Trace) icin progress indicator, sure bilgisi ve hata mesaji gostersin."
- Pipeline'a ver -> sonuclari degerlendir

### Senaryo 3: API Health Check
- Fikir: "Basit bir health check endpoint'i olustur. Sunucu durumu, veritabani baglantisi ve AI servis durumunu JSON olarak dondursun."
- Pipeline'a ver -> sonuclari degerlendir

## Degerlendirme Kriterleri
Her dogfooding run'i su kriterlerle degerlendirilir:
1. Scribe spec kalitesi (confidence score)
2. Proto kod kalitesi (derlenebilir mi? calisir mi?)
3. Trace test kalitesi (anlamli testler mi?)
4. Toplam sure
5. Insan mudahalesi gerektiren nokta sayisi
```

## ADIM 5 — Testler
```bash
cd backend && pnpm typecheck
cd backend && pnpm test:unit -- --testPathPattern="metrics"
```

## STATUS REPORT
`docs/plans/REPORT_D_METRICS.md` olarak kaydet.
