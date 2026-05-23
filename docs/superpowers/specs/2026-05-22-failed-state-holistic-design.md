# Failed-State Holistic — Defense Blocker Fixes (A1-A4)

**Tarih:** 2026-05-22 · **Hedef sürüm:** v0.7.x · **Bağlam:** [[2026-05-22-chat-timeline-event-log-design]]'in genişletilmesi.

## Background

PR #609 (`6dd4b63`) chat-event-log altyapısını kurdu: `proto_started`, `proto_completed`, `trace_started`, `trace_completed`, `trace_failed` event'leri scribe_conversation jsonb'sine append ediliyor, frontend gating ile snapshot fallback'i regression-safe biçimde devre dışı bırakıyor. Live verified: Sayaç pipeline'ı 4 backend event tipini doğru persist etti.

Ancak 2026-05-22'de yapılan mockup vs. live karşılaştırması 4 önemli boşluğu ortaya çıkardı:

- **A1** PipelineReconciler.ts:92-96'da `eventTypeByStage` sadece `trace_testing` → `trace_failed` mapliyor. `scribe_generating`, `scribe_clarifying`, `proto_building` stuck olduğunda chat'e hiçbir event düşmüyor; kullanıcı pipeline'ın neden durduğunu bilmiyor.
- **A2** PipelineErrorBanner.tsx:115-119 `error.message`'ı technical line olarak gösteriyor ama `error.technicalDetail`'ı **render etmiyor**. `createPipelineError(code, technicalDetail)` çağrılarında stage + dakika bilgisi technicalDetail'a yazılıyor (örn. "Pipeline trace_testing aşamasında 15 dakikadır yanıt vermiyor.") ama UI'ya hiç ulaşmıyor.
- **A3** Timeout mesajı 3 katmanlı redundansa düşmüş: friendly title + friendly detail + backend default message — üçü de neredeyse aynı şeyi söylüyor ve hangi adım/hangi iş bilgisi yok.
- **A4** AC-1 (Cinema'da Trace ✗ rose kart) + AC-4 (TraceFailureMessage canlı failed pipeline'da action butonlu) coded + unit-tested ama gerçek failed pipeline'da hiç görsel doğrulanmadı.

## Functional requirements

**F-1 — Reconciler tüm stuck stage'leri için chat event'i emit eder.**
`scribe_generating`, `scribe_clarifying`, `proto_building` ve mevcut `trace_testing` stage'leri için ayrı event tipleri:
- `scribe_failed` (covers `scribe_generating` + `scribe_clarifying`, content discriminator yok — stage adı errorMessage'da)
- `proto_failed`
- `trace_failed` (mevcut)

Content payload: `{ stageStuck: PipelineStage, errorCode: 'PIPELINE_TIMEOUT', errorMessage: string, recoveryAction: 'retry' }`.

**F-2 — PipelineErrorBanner technicalDetail satırını render eder.**
Yeni satır mevcut "banner-technical-detail" satırının ALTINDA: `data-testid="banner-stage-detail"`, font-size aynı (11px), color text-muted. `error.technicalDetail` null/empty ise gizli. `error.technicalDetail === error.message` ise (çift gösterimi önlemek için) gizli.

**F-3 — Stage-aware timeout copy.**
Merkezi helper: `stageLabel(stage: PipelineStage): string` → Türkçe iş adı eşlemesi:
- `scribe_clarifying`, `scribe_generating` → "Fikir analiz adımı"
- `proto_building` → "Kod üretim adımı"
- `trace_testing` → "Test üretim adımı"
- `critic_reviewing_*` → "İnceleme adımı"
- diğerleri → "İşlem"

Reconciler errorMessage formatı:
```
"{stageLabel} {N} dakika boyunca yanıt vermedi. Otomatik olarak durduruldu."
```

errorMessages.ts (frontend friendly) için PIPELINE_TIMEOUT detail'ı **kısaltılır** ("İşlem beklenenden uzun sürdü ve duraklatıldı. Tekrar deneyebilirsiniz." → "Bir adım yanıt vermedi; aşağıdaki teknik detay hangi adımın ne kadar süredir durduğunu gösterir.").

Backend PipelineErrors.ts:179 (default message): aynı kısaltma uygulansın.

**F-4 — Live failed pipeline e2e.**
Trace stage'ini bilinçli fail ettir (env override: `TRACE_FORCE_TIMEOUT=true` veya `STAGE_TIMEOUT_MS_OVERRIDE=5000`). Pipeline `failed`'a düşünce screenshot al:
- Cinema rail: Trace kartı rose ✗
- Chat'te TraceFailureMessage (action butonlu)
- Banner: title + detail + technical + stage-detail (4 satır, ama net hiyerarşi)
- Rail auto-expanded

`docs/dogfooding/screenshots/`'a kaydet, gerekirse `docs/superpowers/plans/2026-05-22-failed-state-holistic.md`'e visual confirm satırı ekle.

## Non-functional requirements

**NF-1 — Backward compat.** Mevcut `trace_failed` event'inin payload'ı değişmiyor; yeni event tipleri (`scribe_failed`, `proto_failed`) sadece eklendi. Eski snapshot fallback'i hâlâ event-log yoksa devreye giriyor.

**NF-2 — Banner çift-render önleme.** F-2'de `technicalDetail === message` ise gizli. Reconciler iki field'ı doldururken aynı string'i atmayacak (technicalDetail stage-specific, message friendly).

**NF-3 — Reconciler atomicity.** F-1'de yeni event'in append'i `stage='failed'` transition'ı ile aynı `store.update` çağrısında (mevcut pattern korunur).

## Acceptance criteria

- **AC-1** Reconciler `scribe_generating` stuck pipeline'ına `scribe_failed` event'i append eder; conversation içinde tek bir tane olur, stage='failed' atomicity korunur.
- **AC-2** Reconciler `proto_building` stuck pipeline'ına `proto_failed` event'i append eder; iteration kolonu boş bırakılır (Proto retry iteration sayacı şu an yok).
- **AC-3** PipelineErrorBanner `error.technicalDetail` set olduğunda yeni satırı render eder; null ise hiçbir ek satır gözükmez. Snapshot test'inde DOM diff doğrulansın.
- **AC-4** Reconciler errorMessage formatı 3 stage için verify edilir (regex match `/Fikir analiz adımı.*\d+ dakika/`, `/Kod üretim adımı.*\d+ dakika/`, `/Test üretim adımı.*\d+ dakika/`).
- **AC-5** Live e2e: Trace timeout zorla yapıldığında, Cinema'da rose-themed ✗ kart + chat'te TraceFailureMessage butonlu + Banner stage-detail satırı görünür. Screenshot delili olarak commit edilir.

## Out of scope

- `critic_reviewing_spec` stuck cleanup (`5d3340a1...` örnek case). Bu reconciler RUNNING_STAGES dışında; ayrı bir PR (memory'de not düşülecek).
- ChatMessage'a `scribe_failed` / `proto_failed` için ayrı failure component (TraceFailureMessage benzeri). A1'de sadece backend event'i kaydeder; frontend render'ı ileride. Şimdilik backend event'i log + sonraki PR'da render.
- Reconciler interval/threshold tuning (15 dk → daha kısa).

## Dependencies

- ScribeMessageType extension F-1'in ön koşulu (frontend mirror sync).
- workflows.ts mapper (frontend) yeni event tiplerini conversation pipeline'ına çevirmeli; render eklenmemiş bile olsa type-safe.

## Risk

- **R-1** scribe_clarifying'in "kullanıcı yanıt vermedi" vs. "sistem takıldı" ayrımı yok. F-1 bunu sistem takılması varsayıyor; kullanıcı 15+ dakika düşününce de event atılır. Kabul edilebilir (memory: bakkal persona kısa session'larda çalışır, 15 dk normal olmaz).
- **R-2** PipelineErrorBanner'a yeni satır eklendiğinde küçük layout regression olabilir; PipelineErrorBanner.test.tsx'te mevcut snapshot test'leri update edilmeli.
