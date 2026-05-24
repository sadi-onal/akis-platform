# Chat Agent Narrator (Pattern A) — Design Spec

**Date:** 2026-05-23
**Author:** AKIS (Claude + Ömer)
**Status:** Brainstorming complete, awaiting user review
**Scope:** Tek-PR deliverable. Findings + Requirements + UX + Tech + Acceptance birleşik.
**Builds on:** [[2026-05-22-chat-timeline-event-log-design.md]] (event-log + failed-state) ve [[2026-05-22-failed-state-holistic-design.md]]

---

## 1. Findings — mevcut durum (2026-05-23 dogfood)

`pipeline/84607295-...` (sayaç) ekranı üzerinden tespit:

- **Ajanlar kullanıcıyla konuşmuyor.** Proto'nun LLM-üretti `summary` field'ı zaten var (`ProtoAgent.ts:699`, "1-3 sentence Turkish summary in plain text") ama chat'teki Proto bubble'ı sadece "Proje dosyaları hazır." tek cümlesi gösteriyor — bunun summary mı yoksa fallback mı olduğu belirsiz, ve Scribe ile Trace'in **hiç konuşma-dili özeti yok**:
  - Scribe `spec_approved` event'i sadece `StructuredSpec` jsonb yayınlıyor; chat'e "Akis'in sesi" düşmüyor.
  - Trace `testSummary` totals + uncoveredCriteria veriyor ama "21 test yazdım, 3 fonksiyonu da kapsıyor" gibi konuşma dilinde özet yok.
- **Plan kartı Scribe baloncuğundan ayrı yüzüyor.** Şu an `mapPipelineToConversation` `spec` tipini ayrı `plan` ChatMessage olarak emit ediyor. Kullanıcı planın "kimden geldiğini" zihinsel olarak bağlamak zorunda kalıyor.
- **Sub-step görünürlüğü düşük.** Ajan bubble'ı sadece tek satır özet veriyor. Çalışırken "şu an ne yapıyor" sorusunun cevabı sadece sağdaki **PipelineDetailRail Akış tab**'ında, chat'te değil.
- **Duration meta yok.** Her aşama ne kadar sürdü, bilinmiyor — defense (savunma) demo sırasında "AI hızlı mı yavaş mı" sorusu gelirse cevap yok.
- **State transition chip'leri kısmen var ama tutarsız.** "Spec onaylandı — Proto aşamasına geçiliyor." chip'i Proto başlatıldı satırından sonra düşüyor (timestamp sıralama bug'ı). User bunları beğeniyor; sıralama düzeltilmesi gerekiyor.

### Bu spec'in **kapsamadığı** ama gözlenen başka problemler (referansla)

- Critic-Proto döngüsü ve Validator'ın UI gösterimi: chat'te **ayrı bubble açmayacağız** (user decision — bkz. DL-2/DL-3). Bunlar Scribe/Proto'nun çıktısının değişmesi olarak yansıyacak.
- PlanCard "Düzenle" akışı (yumuşak iterasyon): Bu spec scope'u dışı (out of scope — bkz. §7).

---

## 2. Requirements

### 2.1 Functional

| ID  | Gereksinim | Önceki spec'le ilişki |
| --- | --- | --- |
| F-1 | Her Scribe / Proto / Trace tamamlanmasında 1-3 cümle **LLM-üretilmiş Türkçe konuşma-dili özeti** chat baloncuğunda başlıkta görünür. | Proto'da var (yeniden kullan); Scribe + Trace'e ekle |
| F-2 | Plan kartı **Scribe'ın son baloncuğunun içine gömülü** render edilir — ayrı `plan` ChatMessage emit edilmez. Onayla / İptal / Detayları göster aynı yerde durur. | Şu an ayrı message; bu spec birleştiriyor |
| F-3 | Her ajan baloncuğunun footer'ında **kesin duration** gösterilir (örn. "1 dk 38 sn"). Veri kaynağı: backend'in `*_completed` event payload'una eklediği `durationMs` field'ı (server-truth, started-completed timestamp delta'sı). | YENİ — event payload genişletilir |
| F-4 | Çalışmakta olan ajan için baloncukta **live narrator** + relative "X dakikadır çalışıyor" gösterilir (dakika seviyesinde, jitter yok). Tamamlanınca exact duration ile değişir. | Mevcut running marker (T12) genişletilir |
| F-5 | Her ajan baloncuğu **collapsed sub-step stream** içerir: "▾ N adım" toggle. Açılınca her sub-step bir satır (✓ done / ● live). | YENİ |
| F-6 | State transition **chip'leri** korunur ve doğru sıralanır: "Plan onaylandı", "Geri bildirim alındı, Proto 2. tura başlıyor", "Hazır — GitHub'a gönderebilirsin". Chip'ler `chat_event` tipinden gelir, timestamp'i event-log emission zamanından alır. | F-6 (mevcut spec'in F-6'sını netleştiriyor) |
| F-7 | Critic değerlendirmesi **kendi bubble'ı olmadan** chat'e yansır: Scribe/Proto bubble'ının sub-step stream'inde "Değerlendirme notları işlendi" sub-step + konuşma-dili özette referans ("Notları ekledim, plan 5 story oldu"). | YENİ — Critic UI dışı |
| F-8 | Validator (Statik Kontrol) sonucu **kendi bubble'ı olmadan** Proto bubble'ının sub-step stream'inde tek satır olarak ("Statik kontrol: ✓ temiz" veya "Statik kontrol: 2 hata düzeltildi"). | YENİ — Validator UI dışı |
| F-9 | Mid-pipeline user notu (E7): kullanıcı bubble timeline'da kronolojik yerine düşer + "Geri bildirim alındı, Proto 2. tura başlıyor" chip + Proto v2 bubble. Iterasyon sayacı baloncuğa "İterasyon 2" rozeti olarak çıkar. | F-4/F-5 mevcut, sıralama bug'ı bu spec'te kapanıyor |
| F-10 | Ajan baloncuğunun rengi sol-bar olarak korunur (Scribe yeşil, Proto turuncu, Trace mor). Critic ve Validator chat'te bubble olmadığından renk de yok. | NF (visual identity) |

### 2.2 Non-functional

| ID | Gereksinim |
| --- | --- |
| NF-1 | Mevcut event-log (proto_started/completed, trace_*, scribe_*, proto_failed) korunur; backward compat (NF-1 of 2026-05-22 spec) bu spec'te de geçerli — yeni payload field'ları opsiyonel. |
| NF-2 | `durationMs` hesabı serverda; client'ta sadece format. **Yanlış duration gösterme yasak** — `*_completed` event'inde `durationMs` yoksa duration meta gösterilmez (graceful degradation). |
| NF-3 | Live "X dakikadır çalışıyor" frontend'de hesaplanır; 30 sn interval ile güncellenir, dakika floor'lu (jitter önlemek için). |
| NF-4 | Yeni event tipleri yok; mevcut event payload'ları genişler. DB migration yok (jsonb non-breaking). |
| NF-5 | Plan kartı disclosure davranışı korunur: Problem Tanımı, Kabul Kriterleri (N), User Stories, Out of Scope, Assumptions. |

### 2.3 Out of Scope (gelecek PR)

- **PlanCard "Düzenle" yumuşak iterasyon akışı** — kullanıcı planı kabul etmek yerine "şunu değiştir" diyebilmesi. Şu an "İptal" sıfırdan başlatıyor. Bu ayrı bir UX akışı; bu spec dışında, gelecek PR'da ele alınacak. (User onayıyla scope dışı.)
- **Critic-Proto loop max iterasyon UI'ı (E6)** — şu an Proto v3 final hâliyle ilerliyor; "döngü çözülemedi" mesajı için ek copy gerekirse ayrı PR.
- **Validator detay görünümü (E9 detail)** — sadece tek satır sub-step görünür; lint/typecheck detay listesi rail'de mevcut, chat'te göstermiyoruz.
- **Stage-by-stage cinematic animation** — sub-step stream sadece collapsible liste; animasyonlu reveal yok.

---

## 3. UX — Pattern A mockup'ı (canonical)

### Happy path (sayaç senaryosu — clarification + critic-flagged scribe + proto + mid-pipeline iterate + trace)

```
                                          basit bir sayaç │ siz
                                                    22:25 ╯

  [S] Scribe · 22:25
      Bir noktayı netleştirmek istiyorum: sayacın başlangıç değeri
      0 mı olsun, kullanıcı mı belirlesin?

                                                  0'dan │ siz
                                                  22:26 ╯

  [S] Scribe · 22:26
      ● Acceptance criteria yazıyor
      ▾ 3 adım

      (live state — sub-step stream collapsed; expand → ✓/● satırlar)

  [S] Scribe · 22:27
      Notları ekledim, plan 5 user story oldu. Negatif değer koruması
      ve mobil layout kriteri eklendi.

      ┌───────────────────────────────────────────────────────┐
      │ 📋 Proje Planı: Basit Sayaç              [aktif]      │
      │ 5 user story · artır, azalt, sıfırla,                 │
      │              negatif koruma, mobil layout              │
      │                                                        │
      │ [ Onayla ]  [ İptal ]      Detayları göster ▾         │
      └───────────────────────────────────────────────────────┘
      ▾ 5 adım                                  2 dk 14 sn · 2 tur

  ─────────────── Plan onaylandı ───────────────

  [P] Proto · 22:28
      React + Vite ile sayaç hazır. Artırma, azaltma ve sıfırla
      butonları çalışıyor, negatif değere düşmüyor.
      ▾ 5 adım · 13 dosya · 440 satır · dry-run · 1 dk 38 sn

                                       login butonu da eklesen │ siz
                                                          22:30 ╯

  ─────── Geri bildirim alındı, Proto 2. tura başlıyor ───────

  [P] Proto · 22:31                                     İterasyon 2
      Login butonu eklendi — email + parola alanları, basit doğrulama.
      Toplam 16 dosya oldu (3 dosya değişti).
      ▾ · 1 dk 12 sn

  [T] Trace · 22:33
      21 test yazdım — sayacın 3 fonksiyonu ve login akışı da
      kapsanıyor.
      ▾ · %100 kapsam · 47 sn

  ─────────── Hazır, GitHub'a gönderebilirsin ───────────
```

### Failed state (Trace timeout)

```
  [T] Trace · 22:33
      ● Test senaryolarını yazıyor
      ▾ 2 adım

  ─────── Trace 15 dakika yanıt vermedi ───────

  [T] Trace · 22:48
      ⚠ Test üretimi zaman aşımına uğradı. Scaffold elimde hazır —
      testsiz devam edebilir ya da Trace'i tekrar deneyebilirsin.
      [ Tekrar Dene ]  [ Trace'siz devam et ]
      ▾ 2 adım (yarım) · 15 dk
```

### Critic-flagged scribe (no chat bubble for Critic)

Aşağıda Critic'in "sahnede görünmemesi" örneklenmiş — değerlendirme notları Scribe'ın **sonraki baloncuğunda** referans alınıyor, ayrı bir Critic baloncuğu açılmıyor.

```
  [S] Scribe · 22:26
      ● İlk taslak hazır, değerlendirmeye gönderildi
      ▾ 3 adım

      (live state; sub-step stream içinde "✓ İlk taslak yazıldı",
       "● Değerlendirme bekleniyor" satırları görünür açılırsa)

  [S] Scribe · 22:27
      Notları ekledim, plan 5 user story oldu. Negatif değer
      koruması ve mobil layout kriteri eklendi.
      ▾ 5 adım · 2 tur · 2 dk 14 sn
```

Sub-step stream açıldığında:

```
      ✓ Fikir 4 user story'ye bölündü                  (42 sn)
      ✓ Acceptance criteria yazıldı                    (35 sn)
      ✓ Değerlendirme: 2 eksik nokta tespit edildi    (14 sn)
      ✓ Negatif koruma eklendi                        (20 sn)
      ✓ Mobil layout kriteri eklendi                  (11 sn)
```

Yani Critic'in **sub-step satırı vardır** ama Critic baloncuğu yoktur (DL-2).

### Validator sub-step (no chat bubble for Validator)

Proto baloncuğu açıldığında:

```
  [P] Proto · 22:28
      React + Vite ile sayaç hazır...
      ▾ 5 adım

      ✓ Scaffold üretildi                              (32 sn)
      ✓ Bileşenler yazıldı                             (28 sn)
      ✓ Statik kontrol: ✓ temiz                        (3 sn)
      ✓ Repo'ya gönderildi                             (24 sn)
      ✓ Dry-run önizleme hazır                         (11 sn)
```

Validator sub-step olarak Proto'nun içinde — ayrı bubble yok (DL-3).

---

## 4. Tech — implementation plan

### 4.1 Veri modeli

`ScribeMessageType` union'ına yeni opsiyonel field'lar — DB migration yok.

```ts
// backend/src/pipeline/core/contracts/PipelineTypes.ts

// MEVCUT (özet) — değişmiyor:
type SpecApproved = { type: 'spec_approved'; content: StructuredSpec; timestamp?: string };

// GENİŞLETİLEN — proto_completed (mevcut field'lar + yeni):
| { type: 'proto_completed';
    content: {
      iteration: number;
      summary: string;            // mevcut — LLM özeti (Proto zaten üretiyor)
      filesCreated: number;
      totalLines: number;
      branch?: string;
      durationMs: number;         // YENİ — started→completed delta
      subSteps?: SubStep[];       // YENİ — sub-step stream
    };
    timestamp: string }

// YENİ — Scribe ve Trace de aynı şekle uyar:
| { type: 'scribe_completed';
    content: {
      iteration: number;
      summary: string;            // YENİ — Scribe'dan 1-3 cümle Türkçe özet
      storyCount: number;
      acCount: number;
      durationMs: number;
      subSteps?: SubStep[];
    };
    timestamp: string }

| { type: 'trace_completed';
    content: {
      iteration: number;
      summary: string;            // YENİ — Trace'den 1-3 cümle Türkçe özet
      totalTests: number;
      coverage: number;
      passed: boolean;
      durationMs: number;
      subSteps?: SubStep[];
    };
    timestamp: string }

// Sub-step şekli — generic, her ajan kullanabilir:
type SubStep = {
  label: string;              // "Acceptance criteria yazıldı" gibi insan-dili
  durationMs?: number;        // tek-step süresi (opsiyonel)
  status: 'done' | 'live' | 'failed';
  source?: 'critic' | 'validator' | 'agent';  // attribusyon — UI'da renk için
};
```

**Önemli:** `subSteps[]` içinde Critic ve Validator'ın etkileri **string satır olarak** geçer (`label: 'Değerlendirme: 2 eksik nokta tespit edildi'`, `source: 'critic'`). Yani Critic verisi event'te VAR ama ayrı bubble olarak render edilmiyor.

### 4.2 Backend — değişiklikler

| Konum | Değişiklik |
| --- | --- |
| `ScribeAgent` (`backend/src/pipeline/agents/scribe/ScribeAgent.ts`) | Spec'i kullanıcıya açıklayan 1-3 cümle Türkçe `summary` üretsin (Proto pattern'ini taklit et). LLM prompt'una "respond with a 1-3 sentence Turkish summary describing what you planned" ekle. Output şemasına `summary` field'ı opsiyonel olarak gir. |
| `TraceAgent` (`backend/src/pipeline/agents/trace/TraceAgent.ts`) | Benzer şekilde 1-3 cümle özet üret ("21 test yazdım, X fonksiyonu kapsanıyor"). Şu anki `testSummary` korunur, yeni `summary: string` eklenir. |
| `PipelineOrchestrator` | `scribe_completed`, `proto_completed`, `trace_completed` event emit ederken: <br>• `durationMs = Date.now() - startedAt` (her stage başında `startedAt` tutulur)<br>• `subSteps[]` array'ini build et (mevcut `intermediateState` ve `criticReview` çıktısından "Değerlendirme: 2 eksik nokta" gibi insan-dili satırlar üret) |
| Critic/Validator integration | Critic kendi event'ini emit etmez (chat'te görünmez). Bunun yerine Scribe/Proto orchestrator'ı, Critic'in çıktısını okuyup `proto_completed.content.subSteps`'e `{ label: '...', source: 'critic' }` push eder. Aynısı Validator için. |

### 4.3 Frontend — render

`conversationToChatMessages` (`frontend/src/utils/conversationToChatMessages.ts`):

- `proto_completed` / `trace_completed` / `scribe_completed` → `agent` ChatMessage'a şu ek field'lar:
  - `summary` (zaten Proto'da var — Scribe + Trace'e genişlet)
  - `durationMs`
  - `subSteps`
- `spec` tipi (mevcut) artık ayrı `plan` ChatMessage **emit etmiyor** — Scribe'ın son baloncuğuna `embeddedPlan: { plan, version, status, spec, assumptions }` field'ı olarak iliştiriliyor.

`ChatMessage.tsx`:

- Agent bubble render fonksiyonu güncellenir. Görsel dikey sıralama:
  1. **Header:** agent badge + timestamp
  2. **Body:** ya live narrator (`isLive`) ya da `summary` (completed)
  3. **Embedded plan card** (sadece Scribe + son tur, conditional): `<PlanCard ... />` baloncuğun içine inline (body'nin altında, sub-step toggle'ından önce)
  4. **Sub-step toggle:** `<details>` collapsed by default; expand → `subSteps[]` listesi
  5. **Footer meta:** duration ("1 dk 38 sn") + iteration ("İterasyon 2") + count badges ("13 dosya · 440 satır")

`frontend/src/types/chat.ts` — ChatMessage union genişler:
```ts
type AgentChatMessage = {
  type: 'agent';
  agent: 'scribe' | 'proto' | 'trace';
  content: string;
  summary?: string;                  // YENİ — LLM özet (öne çıkan)
  isLive?: boolean;                  // YENİ — running marker
  liveLabel?: string;                // YENİ — italic narrator metni
  startedAt?: string;                // YENİ — live duration için
  durationMs?: number;               // YENİ — completed duration (server-truth)
  subSteps?: SubStep[];              // YENİ — collapsed list
  iteration?: number;                // mevcut
  embeddedPlan?: {                   // YENİ — sadece Scribe son tur'da set
    plan: UserFriendlyPlan;
    version: number;
    status: PlanStatus;
    spec?: StructuredSpec;
    assumptions?: string[];
  };
  // ... existing fields (totalFiles, totalLines, branch, etc.)
};
```

`workflows.ts` `mapPipelineToConversation`:

- `case 'proto_completed'` — `embeddedPlan` çıkarıp Proto'da değil **Scribe'ın son baloncuğunda** yer ver (Scribe `spec_approved` event'i + Scribe `scribe_completed` event'i birleşmiş).
- Yeni `scribe_completed` case ekle.
- Snapshot fallback (NF-1) korunur — eski pipeline'lar `summary`siz render olur (graceful, "Proje dosyaları hazır" generic mesajı düşer).

### 4.4 Live duration meta

Frontend `useRelativeDuration(startedAt)` hook (`frontend/src/hooks/`):

```ts
function useRelativeDuration(startedAt: string | null, isLive: boolean): string {
  // null/not-live → return ''
  // live: compute Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000)
  //   < 1: '1 dakikadan az'
  //   = 1: '1 dakikadır çalışıyor'
  //   > 1: '${n} dakikadır çalışıyor'
  // tick every 30s (dakika floor edilmiş, jitter yok)
}

function formatDuration(durationMs: number): string {
  // < 60s: '${s} sn'
  // < 60m: '${m} dk ${s} sn' veya sadece '${m} dk' (eğer s < 5)
  // >= 60m: '${h} sa ${m} dk'
}
```

NF-2 gereği: `durationMs` undefined ise meta hiç render edilmez (yanlış değer yerine yok).

### 4.5 State transition chip'leri (F-6)

Mevcut sistem chip'leri (`chat_event` veya synthetic system row'lar):
- "Plan onaylandı" — `spec_approved` user-triggered event'te
- "Geri bildirim alındı, Proto 2. tura başlıyor" — `user_note` event'inden sonra orchestrator emit'ti
- "Trace zaman aşımına uğradı" — `trace_failed` event'ten
- "Hazır, GitHub'a gönderebilirsin" — final push gate açıldığında

**Sıralama bug'ı fix:** `system` event'lerin `timestamp` field'ı kesin server-side olmalı; `mapPipelineToConversation` `sort by timestamp` yapmalı; tie-break: event-log array sırası. Şu anki "Spec onaylandı — Proto aşamasına geçiliyor" chip'i Proto başlatıldı'dan sonra düşüyor — bu fix bunu çözer.

### 4.6 Backward compat (NF-1, NF-4)

- Yeni event payload field'ları (`summary`, `durationMs`, `subSteps`) opsiyonel
- Eski pipeline'lar `summary`siz render olur — generic fallback (örn. "Proto adımı tamamlandı")
- DB migration yok; jsonb şema genişlemesi non-breaking
- Mevcut `plan` ChatMessage tipini koruyup gradually deprecate edebiliriz (bu PR'da `spec` event'i artık ayrı plan emit etmez, ama tip union'da `plan` tipi var olmaya devam eder — eski geçmiş pipeline render'ı için)

---

## 5. Acceptance Criteria

| AC | Verilen | Yapıldığında | Sonra |
| --- | --- | --- | --- |
| AC-1 | Yeni bir pipeline çalışır, Scribe başarıyla bitirir | `scribe_completed` event emit edildiğinde | Chat'te Scribe baloncuğu görünür; ilk satır LLM özeti (Türkçe, 1-3 cümle); plan kartı baloncuğun içine gömülü; footer'da duration meta |
| AC-2 | Proto başarıyla biter | `proto_completed` event'inde | Proto baloncuğu konuşma-dili summary'yle başlar; "▾ N adım" toggle ile sub-step listesi açılabilir; statik kontrol Proto baloncuğunun sub-step'i olarak görünür (ayrı bubble değil) |
| AC-3 | Trace başarıyla biter | `trace_completed` event'inde | Trace baloncuğu LLM özet ("21 test yazdım..."); sub-step + duration meta |
| AC-4 | Scribe ilk taslak Critic tarafından flag'lendi | Critic değerlendirmesi tamamlandığında | **Chat'te ayrı Critic bubble açılmaz**; Scribe sub-step stream'inde `{label: 'Değerlendirme: N eksik nokta tespit edildi', source: 'critic'}` satırı görünür (açılırsa) |
| AC-5 | Iterasyon yapıldı (Proto 2. tur) | 2. tur tamamlandığında | Chat'te hem 1. tur hem 2. tur Proto baloncuğu görünür (1. silinmedi); 2. baloncukta "İterasyon 2" rozeti |
| AC-6 | Pipeline proto_building, user mid-pipeline mesaj yazar | Mesaj POST edildiğinde | User bubble kronolojik yerine düşer (Proto sub-step'lerinden önce, sonraki Proto v2'den önce); "Geri bildirim alındı, Proto 2. tura başlıyor" chip görünür |
| AC-7 | Bir agent çalışmakta | Live render edildiğinde | Baloncuk içinde italik narrator ("● Acceptance criteria yazıyor"); footer'da relative "X dakikadır çalışıyor" (dakika floor) |
| AC-8 | Bir agent başarıyla bitti | Render edildiğinde | Footer "X dk Y sn" exact duration; live narrator kaybolur, yerine LLM summary |
| AC-9 | `*_completed` event'inde `durationMs` yok (eski pipeline) | Render edildiğinde | Duration meta hiç gösterilmez (NF-2 — yanlış değer yerine yok) |
| AC-10 | Eski (summary'siz) pipeline yüklenir | Chat açıldığında | Snapshot fallback devreye girer; baloncuklar generic copy'le render olur — fallback metinleri: Scribe yok ise "Plan hazırlandı.", Proto yok ise "Kod hazırlandı.", Trace yok ise "Testler hazırlandı." (regresyon yok) |
| AC-11 | "Plan onaylandı" chip'i + Scribe baloncuğu | Timeline sıralandığında | Chip Scribe'ın son baloncuğundan SONRA, Proto baloncuğundan ÖNCE düşer (timestamp sıralı, tie-break: event-log array sırası) |
| AC-12 | PlanCard'ın disclosure'ları (Problem Tanımı, Kabul Kriterleri, User Stories, Out of Scope, Assumptions) | "Detayları göster" tıklandığında | Aynı eski içerikle açılır — değişmemiş; sadece konum Scribe baloncuğunun içi |

---

## 6. Risks & Mitigation

| Risk | Mitigation |
| --- | --- |
| LLM summary süresi pipeline'ı uzatır (yeni Scribe + Trace çağrıları) | Summary mevcut LLM çağrısının çıktı şemasında ek field — ayrı çağrı yok. Proto'da zaten böyle yapılıyor. |
| Backward compat — eski pipeline'lar `summary`siz | NF-1 fallback (graceful); AC-10 ile test edilir |
| Sub-step listesi çok uzun olur (10+ satır) | Default collapsed (▾); açılırsa scroll vermez (max 8 satır + "..."). User feedback'e göre ileride truncate |
| Live "X dakikadır" jitter ya da yanlış (clock drift) | Server `startedAt` ile client `Date.now()` farkı — client clock drift olabilir. Dakika floor + 30s tick: 1 dk altı sapmalar gizlenir. NF-3. |
| `durationMs` hesabı pipeline pause/resume durumunda yanlış olur | Şu an pipeline pause yok. Eğer ileride eklenirse her `*_completed` event durations'ı kümülatif tutmalı. Bu spec scope dışı. |
| Plan kartı Scribe baloncuğuna gömüldüğünde mobil görünümde sığmaz | PlanCard zaten responsive; baloncuk genişliğini max-width sınırla. Manuel test E2E. |
| Critic değerlendirme satırı ("source: 'critic'") kullanıcıyı kafa karıştırır mı | Sub-step label'i bakkalca yazılmış olacak ("Değerlendirme: 2 eksik nokta") — UI'da rozet ya da farklı renk yok. Subtle "değerlendirme" ifadesi yeterli. |

---

## 7. Decision Log

- **DL-1** (2026-05-23): Pattern A seçildi (ajan-renkli baloncuklar + her ajan kendi sesinde + plan kartı gömülü). Pattern B (tek Akis narrator) ve C (chip + stream) reddedildi. Sebep: A "mesaj nereye gitti" sorusunu en doğrudan çözüyor; mevcut renk kodlamasını koruyor; bakkal-okunabilirlik ile power-user şeffaflığı arasında doğru dengede.
- **DL-2** (2026-05-23): **Critic chat'te ayrı bubble açmaz.** Critic'in etkisi Scribe/Proto'nun sub-step stream'inde insan-dili satır olarak yer alır (`source: 'critic'`). Sebep: kullanıcı (Ömer) Critic'in "akışa yedirilmesi" tasarımını korumak istiyor; ayrı bubble görsel kalabalık + zihinsel yük.
- **DL-3** (2026-05-23): **Validator (Statik Kontrol) chat'te ayrı bubble açmaz.** Sonuç Proto baloncuğunun sub-step'i. Sebep: aynı (DL-2) — Validator agent değil tool, sub-step seviyesinde anlam kazanır.
- **DL-4** (2026-05-23): Sub-step stream **default collapsed**. "▾ N adım" toggle açar. Sebep: bakkal için chat sade kalır; power user'a erişim engellenmez.
- **DL-5** (2026-05-23): Duration **server-truth**: `*_completed` event payload'unda `durationMs` field'ı (started-completed timestamp delta'sı). Frontend sadece format. Yanlış duration gösterme yasak (NF-2) — `durationMs` yoksa meta render edilmez. Sebep: kullanıcının "yakın bilgi okey ama yanlış bilgi okey değil" kuralı.
- **DL-6** (2026-05-23): Live durum için relative "X dakikadır çalışıyor" — dakika floor, 30s tick. Sebep: NF-3 jitter koruması.
- **DL-7** (2026-05-23): Plan kartı **Scribe'ın son baloncuğuna gömülü** — ayrı `plan` ChatMessage emit edilmez (yeni pipeline'lar için). Sebep: F-2; "Akis'in mesajı" hissi için planın "kimden geldiği" görünür olmalı.
- **DL-8** (2026-05-23): PlanCard "Düzenle" akışı scope dışı (out of scope §2.3). Kullanıcı bu PR'da değil sonraki PR'da ele almak istiyor.

---

## 8. Open Questions

(Yok — tüm tasarım kararları kapatıldı.)
