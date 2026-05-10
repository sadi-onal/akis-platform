# 05 — Gap Analizi (Findings)

**Status:** ✍️ Taslak (revize, 01-04 onaylı) — onay bekliyor
**Önceki bağlam:** [`00-README.md`](./00-README.md), [`01-requirements.md`](./01-requirements.md) ✅, [`02-ux.md`](./02-ux.md) ✅, [`03-architecture.md`](./03-architecture.md), [`04-quality.md`](./04-quality.md)
**Yöntem:** Kullanıcı tarafından raporlanan + 2026-05-09 smoke testi + kod inceleme + 01-04 hedefine göre gap analizi (2026-05-10).

> **İki tip gap:** **Davranış-gap'i** (F-01..F-07): mevcut kod hedef davranışı yanlış uyguluyor. **Yokluk-gap'i** (F-08..F-12): hedef feature mevcut kodda hiç yok. Roadmap her ikisini sıralı işler; davranış-gap'leri "fix", yokluk-gap'leri "feat" PR'ları olarak.

> **Severity legend**
> 🔴 **P0** — Akışı tıkar, kullanıcı işini bitiremez. PDP-2 dalgasında zorunlu fix.
> 🟠 **P1** — UX güveni sarsar, ürün "demo değil ama henüz mamul değil" gibi durur. Aynı dalgada hedef.
> 🟡 **P2** — Polish / teknik borç. Sonraki dalgaya bırakılabilir, ama doc'da mutlaka kayıtlı.

> **Format**: her bulgu ID + bir paragraf gerçek davranış + bir paragraf beklenen davranış + root cause (dosya:satır referanslı) + öneri + acceptance criteria.

---

## 🔴 P0 bulgular

### F-01 — Chat içeriği "Yeni Sohbet" sonrası geri dönülünce yüklenmiyor

**Davranış (kullanıcı raporu, 2026-05-09):** Var olan bir sohbette kalırken sidebar'dan "Yeni Sohbet" başlat → ardından sidebar'dan eski sohbete geri tıkla → mesaj alanı boş kalır, plan card / clarification / mesajlar görünmez. Sayfayı yenilemek (F5) sorunu çözer.

**Beklenen:** Eski sohbete tıklanınca kayıtlı tüm mesajlar (kullanıcı fikri + clarification + spec / plan / approval / proto / trace) anında render olmalı, sayfa yenileme gerektirmemeli.

**Root cause (kod analizi — `frontend/src/pages/chat/ChatPage.tsx`):**
- `lastMessagesKeyRef` global ref olarak `<conversationId>:<convLen>:<lastTs>` formatında bir önbellek-anahtarı tutuyor (line ~488).
- `handleNewConversation` (line ~503) çağrıldığında `loadedIdRef.current = undefined`, `setMessages([])` ve `setActiveWorkflow(null)` yapılıyor — ama **`lastMessagesKeyRef.current` reset edilmiyor.**
- Sidebar'dan eski sohbete geri tıklandığında useEffect (line ~417) tekrar fetch yapıyor; gelen response'un convLen + lastTs'i değişmediği için yeni key eski key'e eşit oluyor → `if (key !== lastMessagesKeyRef.current)` false dönüyor → **`setMessages` çağrılmıyor** → mesajlar boş kalıyor.

**Etki:** Bakkal akışında "Yeni Sohbet"e geçen her kullanıcı, eski sohbete döndüğünde içeriği kaybeder. Tipik kullanım sırasında %100 oranında karşılaşılan bir bug; manuel reload alışkanlığı kazanılır.

**Önerilen fix (one-liner):** `handleNewConversation` ve "navigate(/chat)" yapan diğer reset noktalarında `lastMessagesKeyRef.current = ''` da set edilmeli. Aynı reset, çıkış yaparken (logout) ve `EmptyState`'e dönerken de geçerli olmalı.

**Acceptance criteria:**
- [ ] Vitest unit testi: `handleNewConversation` çağrısından sonra `lastMessagesKeyRef.current === ''` ya da yeni bir effective key.
- [ ] Vitest entegrasyon testi: A → Yeni Sohbet → A senaryosunda `setMessages` çağrı sayısı ≥ 2 (ilk yükleme + geri dönüş yükleme).
- [ ] Playwright e2e: 2 chat sidebar'da, A → Yeni → A → mesaj listesinde plan card görünür.
- [ ] Manuel smoke: Kayıp veri yok, F5 gereksiz.

---

### F-02 — "Açıklama" sekmesi içinde scroll edilemiyor

**Davranış (kullanıcı raporu, 2026-05-09):** Pipeline detayı rail'inde "Açıklama" sekmesine tıklanınca her stage için reasoning kartları + bulgular grupları render olur. İçerik viewport'un altına taşar — fakat scroll edilemez. Tek çıkış: rail'i daraltmak ve reasoning bilgisine ulaşamamak.

**Beklenen:** Açıklama sekmesi uzun olsa bile rail içinde dikey scroll edilebilmeli; ekranın geri kalanı (chat header + mesaj alanı) sabit kalmalı.

**Root cause (`frontend/src/components/pipeline/PipelineDetailRail.tsx:302`):**
```tsx
<div id="pipeline-rail-body" className="px-4 pb-3">
  ...
  {effectiveTab === 'why' && <ExplanationPanel ... />}
</div>
```
Body wrapper'ında `max-h` veya `overflow-y` yok. Rail flex container'ın çocuğu olduğu için `flex-shrink: 1` ile mesaj alanını sıkıştırıp kendisi büyüyor; içerik viewport'tan taştığında **kullanıcı rail'in içindeki içeriği göremiyor**.

**Etki:** Critic findings + multi-stage reasoning ortalama 3-4 ekran boyu. Bakkal "neyi neden onaylıyorum" sorusunu cevaplayamıyor → kalite-güveni tezinin core değer önerisi kayboluyor.

**Önerilen fix:** Rail body'sine `max-h-[60vh] overflow-y-auto` (veya tablet/dar ekranlarda `max-h-[55vh]`). "Akış" ve "Regresyon" sekmeleri de aynı yapıyı paylaşır → tek değişiklik üçünü kapsar. Alternatif: rail'i `<aside>` olarak yapısal değiştirip kendi scroll context'ini açmak; daha büyük refactor — bu PDP'de tercih edilen değil.

**Acceptance criteria:**
- [ ] Vitest snapshot: rail body class listesi `overflow-y-auto` ve `max-h-*` içeriyor.
- [ ] Playwright a11y test: rail body scroll edilebilir (`scrollHeight > clientHeight` ve scroll set edildiğinde scrollTop değişiyor).
- [ ] Manuel: 5+ stage reasoning + 10+ findings'li bir explanation seti rail içinde scroll edilerek tamamen erişilebilir.

---

## 🟠 P1 bulgular

### F-03 — Backend restart sonrası "Henüz açıklama yok" / Cinema sıfır

**Davranış:** Tamamlanmış (completed) bir pipeline `dev-up.sh` sonrası açıldığında "Açıklama" sekmesi `Henüz açıklama yok`, "Akış" sekmesi tüm stage'leri `pending` olarak gösterir. Halbuki DB'deki pipeline süreci başarıyla bitmiş, `proto_output` + `trace_output` dolu.

**Beklenen:** Hangi anda açılırsa açılsın, completed pipeline'da reasoning + activity tarihçesi geri gelmeli; rail "donuk demo" değil "kalıcı ürün" hissi vermeli.

**Root cause:**
- `backend/src/pipeline/core/explainability/ExplainabilityService.ts` — in-memory map.
- `backend/src/pipeline/core/activityEmitter.ts` ring buffer — 5 dk TTL, in-memory.
- Backend her restart'ta bu state'i kaybediyor.

**Etki:** Pipeline tamamlandıktan sonra backend bir kez yeniden başlatılırsa, kullanıcı "kanıt" göremiyor → güven sarsılıyor. Tezin ana iddiası "verification chain"in görsel kanıtının uçuculuğu.

**Önerilen fix (iki seçenek):**
1. **Persist (önerilen)**: AgentReasoning + ActivityEvent kayıtlarını DB'de `pipeline_reasonings` ve `pipeline_activities` tablolarına yaz. Drizzle migration + service refactor.
2. **Skip + UX bayrağı**: Reasoning eksik olduğunda "Bu pipeline eski bir oturumda tamamlandı; yeniden çalıştırarak açıklamayı yenileyebilirsiniz." mesajı + "Yenile" butonu.

Seçim 04-architecture.md'de kararlaştırılır; default tercih (1) — kalite-güveni kalıcı olmalı.

**Acceptance criteria:**
- [ ] Backend restart sonrası completed pipeline reasoning eksiksiz dönüyor (`/api/pipelines/:id/explanation` 200 + non-empty stages).
- [ ] Migration test: var olan completed pipeline'lar için backfill stratejisi tanımlı (boş bırakılır mı, mock mı, yoksa nadir-durum bayrağı mı).

---

### F-04 — Rail completed + zero-activity'de tamamen gizli

**Davranış:** `PipelineDetailRail.tsx:119` — `if (uiState === 'idle' && activities.length === 0) return null;`. F-03 ile birleşince: backend restart sonrası completed pipeline'da rail hiç render edilmiyor. Açıklama, Akış, Regresyon hiçbirine erişim yok.

**Beklenen:** Completed pipeline her zaman rail'i gösterebilmeli (en azından collapsed/mini-progress hâliyle), kullanıcı tab'lara erişebilmeli.

**Root cause:** Rail "boş durumda gizle" kuralı, F-03'ün uçuculuğunu kullanıcı için tamamen yıkıcı yapıyor.

**Önerilen fix:** Bu koşul kaldırılır veya `uiState === 'idle' && activities.length === 0 && !pipelineHasOutputs` olarak daraltılır. Pipeline output'u (proto/trace) varsa rail collapsed da olsa tab'larıyla beraber render edilir.

**Acceptance criteria:**
- [ ] Vitest: completed pipeline + zero activities → rail render edilir (collapsed default).
- [ ] Manuel: F-03 fix'iyle birlikte, rail tab'ları her completed pipeline'da gözükür.

---

### F-05 — Mode badge ASK ↔ PLAN ↔ ACT ↔ REVIEW tutarsız

**Davranış (önceki bug listesinde de var):** ChatHeader'da pipeline aşamasına göre değişen `ASK / PLAN / ACT / REVIEW` rozeti var. Aynı pipeline boyunca rozet 3-4 kez değişir, kullanıcı için "ne anlama geliyor?" net değil.

**Beklenen:** Ya rozet kullanıcıya değer üreten netlik sunar (kısa açıklamayla, hover'da tooltip), ya da kaldırılır.

**Root cause:** `mapStageToMode` (`frontend/src/utils/mapPipelineEvent.ts:36`) developer-friendly state etiketi yapıyor; bakkal için anlamsız.

**Önerilen fix:** İki yol — UX kararına bağlı:
1. **Tooltip + kısa Türkçe açıklama**: "PLAN: yapılacakları planlıyoruz", "ACT: kodu yazıyoruz", vs.
2. **Rozet kaldır**, yerine ChatHeader'a stage bazlı kısa bir Türkçe açıklama (zaten `Spec hazır: planı inceleyin ve onaylayın` benzerleri var).

03-ux.md'de hangisinin kazanacağı kararlaştırılır.

**Acceptance criteria:**
- [ ] Bakkal kullanım testi (5 dakika gözlem): kullanıcı rozetten ne çıkardığını söyleyebilir, ya da rozetin yokluğu kafasını karıştırmıyor.

---

## 🟡 P2 bulgular

### F-06 — `frontend/src/pages/chat/ChatPage.tsx` 1100+ satır

**Davranış:** Tek dosyada conversation loading, polling, GitHub OAuth restore, iteration child polling, message handling, retry logic, error states — hepsi inline. Her bug fix daha kırılgan.

**Etki:** Geliştirme verimi düşüyor; F-01 root cause'unu bulmak benim için kolay olmadı çünkü dosya 1100 satır.

**Önerilen fix (incremental, ileri dalga):** Aşağıdaki hook'lara/componentlere ayırma:
- `useConversationLoader(conversationId)` — fetch + polling (zaten kısmen useConversationState var)
- `useIterationChildPoll(childId)` — iteration child takibi
- `useGithubOAuthRestore()` — `?github=connected` + sessionStorage flow
- `<ChatPageShell>` — layout/sidebar + Suspense, container component

Mevcut testler bozulmadan yapılabilir (hook signatures stabil tutulur).

**Acceptance criteria (sonraki dalga için):** ChatPage.tsx ≤ 500 satır; her hook ≥ 80% test coverage.

---

### F-07 — Clarification "X/N cevaplandı" sayacı yanıltıcı

**Davranış (önceki smoke'tan):** Soru 1/4'te kullanıcı seçim yaptı (✓ Sadece bakkal sahibi) → sayaç hâlâ "0/4 cevaplandı". Sonraki soruya geçince "1/4". Yani seçim yapmak yetmiyor; ileri ok'a basmak gerekiyor — ama bu UX belirsizliği yaratıyor.

**Önerilen fix:** Sayaç anlık güncellensin; soru başlığında "(yanıtlandı ✓)" işareti seçim yapılınca render edilsin.

**Acceptance criteria:** Seçim yapıldığında sayaç anında değişir; ileri ok zorunlu değil.

---

## 🟦 Yokluk-gap'leri (yeni feature ihtiyaçları, 01-03'ten türetilmiş)

### F-08 — ScaffoldEnricher yok (FR-6.5..6.8)

**Hedef:** Proto çıktısı `install.sh` + Türkçe README ("Kendi bilgisayarında çalıştır" + "Sunucuya kur") + opsiyonel Dockerfile + `.env.example` içermeli.
**Mevcut:** Proto sadece minimum scaffold (package.json, README, src/) üretiyor; taşınabilirlik dosyaları yok.
**Önerilen fix:** `backend/src/pipeline/agents/proto/ScaffoldEnricher.ts` — bkz. 03-architecture § 3.3. Stack tespiti + template render + post-AI hook.
**Acceptance:** D-14 (04-quality § 2 FR-6.5..6.8 satırı).

### F-09 — Chat Q&A yok (FR-10)

**Hedef:** Pipeline tetiklemeden kullanıcı serbest soru sorabilir; RAG ile yanıtlanır.
**Mevcut:** Her kullanıcı mesajı pipeline'a gider (clarification cevabı veya iteration trigger).
**Önerilen fix:** `ChatQAService` + `POST /api/chat-qa/ask` route (SSE stream). Detay 03 § 3.2, 5.3.
**Acceptance:** "Pipeline tetiklenmez" + "RAG citations döner" + streaming çalışır.

### F-10 — Intent detection yok (FR-11)

**Hedef:** Her mesaj BUILD/ASK/FEEDBACK/CHAT'e ayrılır; confidence < 0.7 → disambiguation.
**Mevcut:** Mesaj türü stage'den çıkarılıyor; user intent classifier yok.
**Önerilen fix:** `IntentClassifier` service + `POST /api/chat/intent` + frontend `ChatRouter` + `DisambiguationModal`. Detay 03 § 3.1, 3.4, 5.2.
**Acceptance:** 4 sınıf doğruluk testleri + low-conf modal e2e.

### F-11 — Reasoning + Activities persistence yok (NFR-1)

**Hedef:** Backend restart sonrası completed pipeline'ın reasoning/activity geçmişi geri gelir (%100).
**Mevcut:** `ExplainabilityService` + `ActivityEmitter` in-memory; restart'ta uçar (smoke testte doğrulandı).
**Önerilen fix:** `pipeline_reasonings` + `pipeline_activities` tabloları + write-through cache (03 § 4.1, 4.2, 5.1).
**Acceptance:** D-4, D-5, D-6 (03 § 6) — integration test: restart → reasoning recovered.

> **F-03 ile ilişki:** F-03 davranış-gap'iydi ("backend restart sonrası empty"); F-11 onun sebebi olan yokluk-gap'i. Tek PR'da çözülür (`feat/persist-reasoning-and-activities`).

### F-12 — Bakkal-language tutarsızlıkları (NFR-5.1)

**Hedef:** Tüm UI metni + scaffold çıktısı bakkal-language sözlüğüne uyar (02-ux § 6).
**Mevcut:** i18n catalogue tarama yapılmamış; "repo / PR / scaffold" gibi tech term'ler aktif olası.
**Önerilen fix:** Audit script (`scripts/lint/bakkal-language.mjs`) + i18n diff + Proto README üretici prompt revizyonu.
**Acceptance:** ≥ %95 tutarlılık (04-quality § 6 hedefi).

---

## Çözülmüş bulgular (referans)

Son sürümde fix'lendi, regression için tracker:

| ID | Başlık | Çözen PR | Regression test |
|---|---|---|---|
| C-01 | Plan card "Onaylandı" rozeti Critic spec review aşamasında erken görünüyor | #511 | `frontend/src/utils/__tests__/conversationToChatMessages.test.ts` |
| C-02 | Critic running iken UI'da "Scribe" diye attribute ediliyor (mapStageToUIState) | #511 | `frontend/src/utils/__tests__/utils.test.ts` (`critic_running` testleri) |

---

## Bulgu önceliklendirme matrisi (revize)

Davranış-gap'leri (F-01..F-07) + yokluk-gap'leri (F-08..F-12) tek listede sıralı.

| ID | Tip | Severity | Etki | Efor | Sıra | Bağlı PR |
|---|---|---|---:|---:|---:|---|
| F-01 | davranış | P0 | 5 (her kullanıcı) | XS | **1** | `fix/F-01-chat-reload` |
| F-02 | davranış | P0 | 4 | XS | **2** | `fix/F-02-rail-scroll` |
| F-04 | davranış | P1 | 4 | S | **3** | `fix/F-04-rail-completed` |
| F-11 + F-03 | yokluk + davranış | P1 | 5 (kalite-güveni) | M | **4** | `feat/persist-reasoning` |
| F-08 | yokluk | P1 | 4 (taşınabilirlik) | M | **5** | `feat/scaffold-enricher` |
| F-10 | yokluk | P1 | 4 (FR-11) | M | **6** | `feat/intent-classifier` |
| F-09 | yokluk | P1 | 4 (FR-10) | M | **7** | `feat/chat-qa` |
| F-05 | davranış | P1 | 2 | S | **8** | `fix/F-05-mode-badge` |
| F-07 | davranış | P2 | 2 | S | **9** | `fix/F-07-clarify-counter` |
| F-12 | yokluk | P2 | 2 | S | **10** | `chore/bakkal-language-audit` |
| F-06 | davranış | P2 | 1 (developer) | L | **sonraki dalga** | `refactor/chatpage-split` |

**Efor:** XS ≤ 30 dk · S ≈ 1 saat · M ≈ 2-3 saat · L ≥ 4 saat.

PDP-2 hedefi: 1-7 dalga sonu; 8-10 fırsat varsa; 11 sonraki PDP.

---

## Sonraki adım

**06-roadmap.md**: önceliklendirme matrisinden writing-plans skill ile sıralı uygulama planı.

## Kabul kriterleri (bu doc için)

- [x] 01-04 onaylı, gap analizi hedef hâlle güncellendi
- [ ] F-08..F-12 yokluk-gap'leri kapsamı doğru
- [ ] F-11 + F-03 tek PR çözümü (`feat/persist-reasoning`) onaylandı
- [ ] F-12 (bakkal-language audit) P2 mı P1 mi (default P2)
