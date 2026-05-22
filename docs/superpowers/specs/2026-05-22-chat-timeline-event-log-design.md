# Chat Timeline Event-Log + Failed-State UX — Design Spec

**Date:** 2026-05-22
**Author:** AKIS (Claude + Ömer)
**Status:** Brainstorming complete, awaiting review
**Scope:** Tek-PR deliverable. Findings + Requirements + UX + Tech + Acceptance birleşik.

---

## 1. Findings — mevcut durum

Sayaç session'ı (`pipeline 408ca37f-ca8f-4df3-bf93-1e776d52372f`) üzerinden tespit:

- Pipeline DB durumu: `stage = failed`, `error.code = PIPELINE_TIMEOUT`, `error.technicalDetail = "Pipeline trace_testing aşamasında 15 dakikadır yanıt vermiyor."`. Reconciler (`PipelineReconciler.ts:73`) 15-dk eşiğine bakıp doğru şekilde failed'a çevirmiş. **State doğru.**
- Banner üstte "İşlem zaman aşımına uğradı [Tekrar Dene]" gösteriyor (doğru).
- Üst panelde 3 stage kartı: Scribe ✓, Proto ✓, **Trace "Claude AI ile Playwright testleri oluşturuluyor..."** — pipeline failed olduğu halde Trace kartı "çalışıyor" gösteriyor → **çelişki, kafa karışıklığı kaynağı**.
- Chat timeline en altta `Proto: Scaffold oluşturuldu — 15 dosya` ile sona eriyor. Trace başladı/timeout gibi event'ler **chat'te yok**. Kullanıcı "sonra ne oldu?" diye sadece üst banner'a bakmak zorunda.
- Iterasyon yapılırsa Proto mesajı **silinip yenisiyle değişiyor** (snapshot-driven render). Kullanıcı kendi geri bildiriminin etkisini göremiyor. (`workflows.ts:255-352`)
- Mid-pipeline user mesajı backend'de `user_note` tipinde `scribe_conversation` jsonb'a düşüyor (`PipelineOrchestrator.ts:994-1004`), ama frontend bu tipi render etmiyor → "Notunuz kaydedildi" toast'undan başka iz yok.
- Proto mesajı insan-dilinde değil: "15 dosya, 552 satır" — non-developer (bakkal) için anlamsız. `protoOutput.summary` field'ı zaten LLM'den geliyor ama UI'da gizli kalıyor.

### Kök neden — mimari

Chat mesajları **iki farklı kaynaktan** üretiliyor:

1. **Gerçek event log** (`scribe_conversation` jsonb): user_idea / spec_draft / spec_approved / clarification — Scribe Q&A için işliyor.
2. **Snapshot-türevli mesajlar** (`workflows.ts` frontend): Proto/Trace mesajları her render'da `protoOutput`/`traceOutput`/`error` snapshot'undan **yeniden üretiliyor**.

Snapshot tek bir hâl tuttuğundan iterasyonda override oluyor; timeout/başlatma gibi diskret event'ler hiç kaydedilmiyor.

---

## 2. Requirements

### 2.1 Functional

| ID | Gereksinim | Kaynak |
|---|---|---|
| F-1 | Üst panelde pipeline `failed` ise hata yapan stage kartı failed durum göstermeli. Etiket `errorCode`'a bağlı: `PIPELINE_TIMEOUT` → "✗ Zaman aşımı", diğer hata kodları → "✗ Hata" + kısa mesaj | Mockup A |
| F-2 | Proto/Trace başlama event'leri chat timeline'a görünmeli | Mockup A |
| F-3 | Trace timeout/failure chat timeline'a görünmeli, `[Tekrar Dene]` ve `[Trace'siz devam et]` aksiyonları ile | Mockup A |
| F-4 | Iterasyon yapıldığında önceki Proto mesajı silinmemeli; her tur ayrı satır olarak append edilmeli | Mockup B |
| F-5 | Mid-pipeline user notu chat timeline'da kendi zaman damgasıyla görünür olmalı | Mockup B |
| F-6 | Proto mesajı `protoOutput.summary` (LLM-ürettiği insan-dili özet) ile başlamalı; teknik metadata (dosya/satır) ikincil bilgi | Bakkal persona |
| F-7 | Aktivite satırlarındaki "Claude AI ile..." hardcoded string'leri kaldırılmalı + teknik jargon ("iskelet", "Playwright") bakkal personası için anlaşılır Türkçe ile değiştirilmeli. UI'da agent adı (Scribe/Proto/Trace) zaten sol başta görünüyor, string sadece eylem cümlesi olmalı. Sebep: (a) multi-provider (Claude / OpenAI / Gemini / OpenRouter — bkz. `[[demo_provider_critic_decisions]]`) durumunda "Claude AI" yanıltıcı; (b) "iskelet/Playwright" non-developer kullanıcı için anlamsız jargon | Multi-provider + bakkal persona |

### 2.2 Non-functional

| ID | Gereksinim |
|---|---|
| NF-1 | Mevcut (eski) pipeline'lar için snapshot-türevli render fallback'i korunsun; DB migration yok |
| NF-2 | Event append'ler atomik (mevcut `pipelineStore.update` ile) |
| NF-3 | Frontend snapshot fallback'i + yeni event-log render'ı aynı timeline'da birleşik akmalı (sıralama timestamp ile) |

### 2.3 Out of Scope (gelecek PR)

- **Mid-pipeline user notunun Proto/Trace'i tetikleyici olması.** Şu an parking lot davranışı (sadece kaydedilir). Tetikleyici davranış yapısal değişiklik — ayrı spec'te ele alınacak. Geri-bildirim → iterasyon flow zaten `awaiting_push_confirm` ve `critic-resolution` gate'lerinde mevcut; `proto_building` / `trace_testing` sırasında interrupt-then-iterate ileride.
- **Iterasyon karşılaştırma görünümü** (`[1. tur ile karşılaştır]` link'i). Mockup B'de görünüyor ama tıklayınca açılan diff modali bu spec dışında.
- **Bakkal-language template'leri** (`%88` yerine "yüksek güven", "scaffold" yerine "iskelet" vs). Proto summary'sinin LLM'den geldiği gibi öne çıkarılması yeterli; daha geniş copy-rewrite ayrı iş.

---

## 3. UX — Mockup'lar

### Mockup A — Failed-state (Sayaç case)

```
╭──────────────────────────────────────────────────────────────╮
│ ⚠ İşlem zaman aşımına uğradı                                 │
│ Trace 15 dk boyunca yanıt vermedi. [Tekrar Dene]             │
╰──────────────────────────────────────────────────────────────╯

▼ PİPELİNE DETAYI · Akış · Açıklama · ...

  ┌─ Scribe ✓ ──┐  ┌─ Proto ✓ ──┐  ┌─ Trace ✗ ─────────┐
  │ Spec hazır  │  │ Scaffold   │  │ ⚠ Zaman aşımı     │  F-1
  │ 4 story     │  │ 15 dosya   │  │ 15 dk yanıt yok   │
  └─────────────┘  └────────────┘  └───────────────────┘

───── CHAT ─────────────────────────────────────────────────────
                                       basit bir sayaç │ siz
                                                 16:52 ╯

  📋 Proje Planı: Basit Sayaç Uygulaması       [Onaylandı]
     ● 4 user story · artır / azalt / sıfırla

  ● Proto başlatıldı — kod iskeleti üretiliyor
    ↳ Spec onaylandı, Proto'ya geçiliyor.

  [P] Proto · 16:53
      ✓ Sayaç için React projesi hazırladım.                F-6
        Artırma, azaltma ve sıfırla butonları çalışıyor.
        15 dosya · 552 satır · [Önizle]

  ● Trace başlatıldı — Playwright testleri yazılıyor       F-2

  [T] Trace · 17:08                                          F-3
      ⚠ Test yazımı 15 dakika yanıt vermedi.
        Otomatik olarak durduruldu.
      [Tekrar Dene]  [Trace'siz devam et]
```

### Mockup B — Iterasyon + mid-pipeline user notu

```
  [P] Proto · 16:53 (1. tur)
      ✓ İlk taslak — 14 dosya. [Önizle]

                            login butonunu da eklesen │ siz   F-5
                                              17:15  ╯

  ● Geri bildirim alındı, Proto 2. iterasyona başladı

  [P] Proto · 17:18 (2. tur — 1. turdan değişti)           F-4
      ✓ Login butonu eklendi.
        Toplam 16 dosya, değişen: 3 dosya.
      [Önizle]  [1. tur ile karşılaştır*]              (* OOS)
```

---

## 4. Tech — implementation plan

### 4.1 Veri modeli

`ScribeMessageType` union'a (backend `pipeline/core/contracts/PipelineTypes.ts`) yeni tipler:

```ts
type ScribeMessageType =
  | { type: 'user_idea';     content: string; timestamp?: string }
  | { type: 'spec_draft';    content: SpecDraft; timestamp?: string }
  | { type: 'spec_approved'; content: StructuredSpec; timestamp?: string }
  | { type: 'spec_rejected'; content: { feedback: string }; timestamp?: string }
  | { type: 'clarification'; content: string; questions: string[]; timestamp?: string }
  | { type: 'user_answer';   content: string; timestamp?: string }
  | { type: 'user_note';     content: string; timestamp?: string }              // mevcut
  // YENİ:
  | { type: 'proto_started'; content: { iteration: number }; timestamp: string }
  | { type: 'proto_completed';
      content: { iteration: number; summary: string; filesCreated: number;
                 totalLines: number; branch?: string };
      timestamp: string }
  | { type: 'trace_started'; content: { iteration: number }; timestamp: string }
  | { type: 'trace_completed';
      content: { iteration: number; totalTests: number; coverage: number; passed: boolean };
      timestamp: string }
  | { type: 'trace_failed';
      content: { iteration: number; errorCode: string; errorMessage: string;
                 recoveryAction?: 'retry' | 'skip' };
      timestamp: string };
```

`iteration: number` — her tur için artar; mevcut `intermediateState.iterationHistory.length` ile hizalı.

### 4.2 Backend — append noktaları

| Olay | Konum | Append edilen event |
|---|---|---|
| Proto run başlangıcı | `PipelineOrchestrator.runProto`, `runProtoIterate` | `proto_started` |
| Proto run sonu | aynı, success path | `proto_completed` (summary `protoOutput.summary`, fallback "<title> için scaffold hazır") |
| Trace run başlangıcı | `PipelineOrchestrator.runTrace`, `retryTrace` | `trace_started` |
| Trace run sonu (success) | aynı | `trace_completed` |
| Trace failure (orchestrator-thrown) | aynı, error path | `trace_failed` (`errorCode`, `errorMessage`) |
| Trace timeout (reconciler) | `PipelineReconciler.sweep` | `trace_failed` (`errorCode: 'PIPELINE_TIMEOUT'`) |

Hepsi `this.store.update(id, { scribeConversation: [...prev, event] })` ile atomik.

### 4.3 Frontend — render

`conversationToChatMessages` (`frontend/src/utils/conversationToChatMessages.ts`) yeni event tiplerini `ChatMessage`'a map'le:

- `proto_started` → `{ type: 'agent_started', agent: 'proto', state: 'started', ... }` (mevcut tip yeniden kullanılır)
- `proto_completed` → yeni `{ type: 'proto_result', summary, filesCreated, totalLines, branch, iteration }` — mevcut snapshot-türevli `proto_result` mesajıyla aynı şekle benzesin ama event-log'dan beslensin
- `trace_started` → `{ type: 'agent_started', agent: 'trace', state: 'started', ... }`
- `trace_completed` → yeni `{ type: 'trace_result', ... }` (mevcut snapshot-türevli ile aynı şekil)
- `trace_failed` → yeni `{ type: 'trace_failure', errorMessage, recoveryAction, iteration }`
- `user_note` → `{ type: 'user', content }` (zaten varsa append; render zaten mevcut `user` tipini gösteriyor)

`mapPipelineToConversation` (`frontend/src/services/api/workflows.ts:255-352`) **snapshot türevli Proto/Trace mesaj üretimini kaldır**. Yeni davranış:

```ts
// Pseudocode
if (scribeConversation.some(m => m.type === 'proto_completed')) {
  // Yeni event-log var → snapshot türevli mesaj basma
} else if (pipeline.protoOutput?.ok) {
  // Eski pipeline → mevcut snapshot-türevli mesaj (NF-1)
}
```

Aynı pattern Trace için de.

### 4.4 Backend — provider-agnostic + bakkalca activity strings (F-7)

UI render'da agent adı (Scribe/Proto/Trace) zaten sol başta görünüyor (`Trace — <string>` formatı). String agent prefix'i içermez; sadece eylem cümlesi.

5 backend string'i (`emit?.('ai_call', ...)` çağrıları):

| Dosya:satır | Eski | Yeni |
|---|---|---|
| `ScribeAgent.ts:476` | "Claude AI ile fikir analiz ediliyor..." | "Fikrini detaylandırıyor..." |
| `ProtoAgent.ts:348` | "Claude AI ile MVP iskeleti oluşturuluyor..." | "Proje dosyalarını oluşturuyor..." |
| `ProtoAgent.ts:618` | "Claude AI tool_use ile iskelet oluşturuluyor..." | "Proje dosyalarını oluşturuyor..." |
| `ProtoAgent.ts:848` | "Claude AI ile MVP iskeleti oluşturuluyor (fallback)..." | "Proje dosyalarını oluşturuyor (yedek yol)..." |
| `TraceAgent.ts:358` | "Claude AI ile Playwright testleri oluşturuluyor (X dosya, YKB)..." | "Test senaryolarını hazırlıyor (X dosya, YKB)..." |

İlgili frontend i18n key değerleri (`frontend/src/i18n/locales/{tr,en}.json`) de hizalı tutulur:

| i18n key | TR (eski → yeni) | EN (eski → yeni) |
|---|---|---|
| `pipeline.activity.scribe.writing_spec` | "Spec yazılıyor" → "Fikrini detaylandırıyor" | "Writing spec" → "Detailing your idea" |
| `pipeline.activity.proto.creating_scaffold` | "İskelet üretiliyor" → "Proje dosyalarını oluşturuyor" | "Generating scaffold" → "Creating project files" |
| `pipeline.activity.trace.writing_scenarios` | "Test senaryoları yazılıyor" → "Test senaryolarını hazırlıyor" | "Writing test scenarios" → "Preparing test scenarios" |

(Mevcut TR değerleri tahmin — implementation sırasında dosyalardan doğrulanır.)

Agent kodundaki yorum içi "Claude" referansları (`// use Claude with tools`) bırakılır — bunlar dev-facing kod yorumu, UI'a düşmüyor.

### 4.5 Frontend — üst panel failed-state (F-1)

`mapStageStatus` (`workflows.ts`) içinde:

```ts
if (pipeline.stage === 'failed' && pipeline.error) {
  // Hangi stage'de düştüğünü intermediateState veya error.technicalDetail'dan çıkar.
  // PipelineReconciler "Pipeline <stage> aşamasında..." şeklinde technical detail koyuyor.
  // Daha güvenilir: protoOutput varsa Trace failed; protoOutput yoksa Proto failed; approvedSpec yoksa Scribe failed.
  if (pipeline.protoOutput && !pipeline.traceOutput) stages.trace.status = 'failed';
  else if (pipeline.approvedSpec && !pipeline.protoOutput) stages.proto.status = 'failed';
  else stages.scribe.status = 'failed';
}
```

Mevcut benzer mantık zaten satır 394-409'da var ama sadece `stage === 'completed_partial'` veya `stage === 'trace_testing'` durumunu yakalıyor — `failed` durumunu yakalamıyor.

### 4.6 Backward compat (NF-1)

- Eski pipeline'larda yeni event'ler `scribeConversation` içinde yok → snapshot-türevli render fallback (`mapPipelineToConversation` mevcut path).
- Yeni pipeline'larda event'ler varsa snapshot-türevli üretim bypass edilir, event-log üzerinden render.
- DB migration yok; tip union'ı genişletme JSONB için non-breaking.

---

## 5. Acceptance Criteria

| AC | Verilen | Yapıldığında | Sonra |
|---|---|---|---|
| AC-1 | Pipeline `failed` + `error.code = PIPELINE_TIMEOUT` | Chat sayfası açıldığında | Üst panelde failed olan stage kartı "✗ Zaman aşımı" gösterir; diğer kartlar değişmez |
| AC-2 | Yeni bir Proto run tetiklenir | Proto başladığında | Chat timeline'da "Proto başlatıldı" satırı görünür (timestamp ile) |
| AC-3 | Yeni bir Trace run tetiklenir | Trace başladığında | Chat timeline'da "Trace başlatıldı" satırı görünür |
| AC-4 | Trace 15-dk timeout veya başka bir runtime error | Reconciler veya orchestrator failed yazdığında | Chat timeline'a "Trace zaman aşımı" satırı eklenir; `[Tekrar Dene]` ve `[Trace'siz devam et]` butonları görünür |
| AC-5 | Iterasyon yapıldı (Proto 2. tur) | 2. tur tamamlandığında | Chat timeline'da hem 1. tur hem 2. tur Proto mesajı görünür (eski silinmedi); 2. tur "(2. tur)" etiketi taşır |
| AC-6 | Pipeline `proto_building` aşamasında, kullanıcı bir mesaj yazar | Mesaj POST edildiğinde | Chat timeline'a o mesaj kendi timestamp'iyle yerleşir (sonraki Proto event'lerinin üstünde değil, kronolojik sırada) |
| AC-7 | Proto tamamlandı, `protoOutput.summary` mevcut | Chat'te Proto satırı render edildiğinde | Satırın ilk paragrafı `summary` metni; "X dosya · Y satır" altta küçük puntoyla |
| AC-8 | Eski (event-log'suz) pipeline | Chat sayfası açıldığında | Mevcut snapshot-türevli mesajlar değişmeden gösterilir (regresyon yok) |
| AC-9 | Herhangi bir agent (Scribe / Proto / Trace) çalışırken | Aktivite satırı render edildiğinde | Satırda "Claude AI", "iskelet" veya "Playwright" jargonu geçmez. UI'da "Scribe — Fikrini detaylandırıyor...", "Proto — Proje dosyalarını oluşturuyor...", "Trace — Test senaryolarını hazırlıyor..." şeklinde görünür |

---

## 6. Risks & Mitigation

| Risk | Mitigation |
|---|---|
| Event-log + snapshot fallback aynı pipeline'da çift mesaj üretir | `mapPipelineToConversation` kontrolü: yeni event tipleri varsa snapshot türevli üretimi bypass et |
| Reconciler sweep batch içinde DB hatası → bazı pipeline'lar event-log eksik kalır | Mevcut `try/catch` zaten var; event append `update` çağrısına dahil edilir, atomik |
| Iterasyon sayacı yanlış (intermediateState vs yeni event'ler) | `proto_completed.content.iteration` = `(önceki proto_completed sayısı) + 1`, tek-doğruluk noktası |
| Yeni event tipleri mevcut testleri (`conversationToChatMessages.test.ts`) etkiler | Yeni event'ler için ek test case; mevcut snapshot-fallback test'leri korunur |

---

## 7. Decision Log

- **DL-1** (2026-05-22): Event persistence için `scribe_conversation` jsonb append seçildi; ayrı `pipeline_events` tablosu reddedildi (DB migration eklemek istemiyoruz, scope dışı, gelecekteki ihtiyaca açık).
- **DL-2** (2026-05-22): Mid-pipeline user notunun Proto/Trace'i tetikleyici olması scope dışı; sadece görünür kılma. Sebep: yapısal değişiklik, ayrı dikkat ister.
- **DL-3** (2026-05-22): Eski pipeline'lar için snapshot-türevli render fallback korunur; migration ile backfill reddedildi (risk + scope).
- **DL-4** (2026-05-22): Insan-dili Proto özeti için yeni LLM çağrısı eklenmez; mevcut `protoOutput.summary` (zaten LLM'den) öne çıkarılır.
- **DL-5** (2026-05-22): Aktivite string'leri agent prefix'i içermez — UI render zaten "Trace — <eylem>" formatında basıyor, prefix çift olmasın. Backend `emit('ai_call', message)` çağrılarındaki `message` salt eylem cümlesi.
- **DL-6** (2026-05-22): "Iskelet" ve "Playwright" jargonları kaldırılır. "İskelet" → "Proje dosyaları" (bakkal için somut). "Playwright" → "Test senaryoları" (jargon değil, provider-agnostik). "Analiz" → "Detaylandırıyor" (Türkçe + aksiyon-odaklı).

---

## 8. Open Questions

(Yok — tüm tasarım kararları DL'lerde sabitlendi.)
