# 01 — Giriş

**Status:** ✍️ Skeleton — fill with data when available
**Bağımlılık:** [`00-outline.md`](./00-outline.md)
**Tahmini sayfa:** 8-12

> **Bölümün amacı:** Okuyucuyu AKIS'in çözmeye çalıştığı problemle tanıştırmak, tezin amacını ve katkılarını net cümleyle koymak, Q1-Q4 araştırma sorularını duyurmak, tez yapısını özetlemek.

> **⚠️ Kaynak doğrulama notu:** Bu bölümdeki `[CITE-X]` etiketleriyle birlikte
> geçen sayısal iddialar (%19, %43, %92, %96, 3.5×, vb.) **provisional**
> statüsündedir. Prose draftı yazılmadan önce her sayı kendi kaynak makalesine
> gidilerek teyit edilmelidir. arXiv ID'leri https://arxiv.org/abs/<id> üzerinden
> birebir doğrulanmalıdır. Doğrulanmayan iddialar tezde yer almamalıdır.

---

## 1.1 Problem tanımı

> **Yazım hedefi (2-3 sayfa):** Okuyucu bu bölümün sonunda "AI üretimi koddaki güven açığı"nı somut olarak hissetmeli ve neden non-developer (*bakkal*) tarafının cevapsız olduğunu anlamalı.

### 1.1.1 AI üretimi yazılım çıktısının güven açığı

- Büyük dil modelleri yazılım üretiminde yaygınlaştı: GitHub Copilot, Cursor, Devin, Replit Agent.
- Ancak çıktı kalitesi *gözle görülmeden* kabul edilir hâle gelmedi:
  - [CITE-METR2025] — geliştiriciler AI ile %19 yavaşlamış, ama %24 hızlandıklarını sanmış. **%43'lük algı-gerçeklik uçurumu.**
  - [CITE-METR2026] — Şubat 2026 update'inde seçim bias'ı kabul edildi; *ama trust gap kapanmadı*.
  - [CITE-Sabra2025] — 4.442 görevde LLM çıktıları sistematik olarak bug, güvenlik açığı, kod kokusu üretti.
  - [CITE-Sonar2026] — geliştiricilerin %96'sı AI koduna **tam güvenmiyor**.
  - [CITE-Sherlock2026] — vibe-coded codebase'lerin %92'sinde **≥ 1 kritik açık** raporlandı.
  - [CITE-Qodo2025] — 6+ AI aracı kullanan ekiplerin yalnızca %28'i AI kodundan emin; review loop'u **3.5×** kalite artışı sağladı.
  - [CITE-McKinsey2026] — yalnızca üst %20 anlamlı sonuç alıyor.

### 1.1.2 Bakkal-persona: yazılım bilmeyen kullanıcı için açık

- Mevcut araçların hedef kitlesi **geliştirici** veya **vibe-coder**: Cursor, Copilot, Devin geliştiricinin oturumunda eli güçlendiriyor; Bolt/Replit/v0/Lovable vibe-coder'a yüzeysel çıktı veriyor.
- *Bakkal personası*: dükkân sahibi, esnaf, küçük işletme. Excel'i orta düzey biliyor, kod yazmıyor; AI'a fikrini söylüyor, çıktıyı kontrol edemiyor. **Trust crisis bakkal'da total.**
- Tablo: rakip karşılaştırması — bkz. [`docs/PRODUCT_DIRECTION.md`](../PRODUCT_DIRECTION.md) tablosu. Bu tezde yeniden çizilecek [TBL-1].
- Anahtar gözlem: **non-developer + quality** kesişimi henüz sahipsiz bir lane.

### 1.1.3 Probleme ürün-mimari karşılığı

- Sorulması gereken: "AI çıktısına güven *teknolojik olarak* nasıl üretilir?"
- AKIS'in cevabı: **çok-ajanlı doğrulama zinciri** — her aşamada bağımsız bir ajan + adversarial review + insan onay kapısı + açıklanabilirlik yüzeyi.
- Bu aynı zamanda [CITE-TRiSM] (Gartner agentic AI trust framework) ve [CITE-AdversarialReview] çizgisinde literatürde tanımlı bir mimari motiftir.

---

## 1.2 Tezin amacı

> **Yazım hedefi (1 sayfa):** Tek cümlelik tezi koymak + üç tane "scope dahil" cümle + bir paragraf "scope dışı" netliği.

**Tek cümlelik tezi (THESIS_FOCUS § 1):**

> AKIS, AI tarafından üretilen yazılım çıktılarına geliştirici güvenini somut hâle getiren çok-ajanlı bir doğrulama zinciridir.

### 1.2.1 Bu tezin amacı

1. AKIS'in çok-ajanlı doğrulama zinciri mimarisini tasarlamak ve uygulamak.
2. Bu mimarinin küçük gerçek problemler üzerinde uçtan uca *işlevsel olduğu*nu deneysel olarak göstermek.
3. Açıklanabilirlik yüzeyinin kullanıcı güvenine etkisini A/B Likert testi ile ölçmek.
4. Critic adversarial review'un *atıl olmadığını* ve confidence skorlarının sinyal taşıdığını gözlemsel olarak doğrulamak.
5. Bakkal-personası için ürün-mimari bütünlüğünü göstermek.

### 1.2.2 Scope dışı (kısaca)

- **Güvenlik (security) ekseni** birincil değil. Saldırı dayanıklılığı, prompt-injection robustness, threat-modeling — *future work* başlığında bir paragraf.
- **AST DeterministicValidator** (FORGE'26 metodolojisi) sadece prototip referans — tam implementasyon Horizon 2'de.
- **Persistent Learning** (pgvector + DSPy) Horizon 3 vizyonu — bu tezin değil.
- **Multi-language scaffold** — şu an tek-stack (TS/Node), genişletme ileri iş.
- **Çoklu-kullanıcı kolaborasyon, mobil, billing** — out of scope.

---

## 1.3 Araştırma soruları (Q1-Q4)

> **Yazım hedefi (1.5 sayfa):** Her soruyu net cümleyle koymak + neden o sorunun değerli olduğunu açıklamak + hangi metodla cevaplandığını duyurmak.

### Q1 — Doğrulama zinciri çalışıyor mu?

- **Soru:** AKIS'in Scribe → Critic → (Proto → Critic → Trace → FixLoop) ardışıklığı küçük gerçek problem seti üzerinde uçtan uca tamamlanabilir mi?
- **Neden değerli:** Çok-ajanlı sistemler literatürde önerilse de [CITE-Reflexion, CITE-SelfRefine, CITE-TRiSM], operasyonel olarak çalıştığına dair *empirik* veri seyrek. Bu tez küçük N ile gözlemsel kanıt sunar.
- **Yöntem:** 5 problem (todo, calc, currency, blog API, QR) — her biri AKIS pipeline'ı üzerinden koşulur. Final stage + duration + confidence per stage + finding count kaydedilir.

### Q2 — Açıklanabilirlik geliştirici güvenini değiştiriyor mu?

- **Soru:** Level-4 explainability surface (PipelineCinema + ExplanationPanel + Açıklama tab + confidence badge'ler) AÇIK vs KAPALI olduğunda kullanıcı güveni Likert ölçeğinde anlamlı farklılık gösterir mi?
- **Neden değerli:** XAI literatüründe açıklanabilirlik özgün katkı sayılır, ama gerçek kullanıcı üzerinde ölçülmüş veri seyrek. Bakkal-persona perspektifi de literatürde temsil edilmiyor.
- **Yöntem:** A/B Likert testi — her katılımcı 5 problemi iki konfigürasyon (baseline + explainable) ile değerlendirir. 3 ifade × 5 problem × 2 konfig × 3-5 katılımcı. Counter-balanced sıralama.

### Q3 — Critic adversarial review hangi kategorileri yakalıyor?

- **Soru:** Critic'in 6 boyutu (completeness, ambiguity, testability, consistency, spec_compliance, security) Q1 koşumlarında hangi sıklıkta finding üretti? Severity dağılımı nasıl?
- **Neden değerli:** Adversarial review motifinin "rubber stamp" olmadığını (her şeyi onaylamadığını) ve "yalancı alarm" olmadığını (kategorik dağılımın anlamlı olduğunu) göstermek.
- **Yöntem:** Q1 baseline koşumdan finding aggregation — kategori × severity tablosu. Beklenen: testability + ambiguity ağırlıklı, consistency + security az.

### Q4 — Confidence skorları kalibre mi?

- **Soru:** Critic'in `overallScore` (yüzde) puanı, bağımsız manuel rubric ile değerlendirildiğinde örtüşür mü? Pearson r ≥ 0.4 mü?
- **Neden değerli:** Kalibre olmayan confidence skoru false sense of security üretir. Threshold-tabanlı approval (≥ 80 = onayla) ancak skor *kalibre* ise rasyonel.
- **Yöntem:** 5 spec için 6-kriterli manuel rubric (ürün vizyonu, kullanıcı yararı, fidelity, MVP kapsamı, bakkal-anlaşılırlığı, fizibilite) — her kriter 0-10, toplam normalize. Critic'in skoruyla Pearson r hesaplanır. Bias engellemek için form Critic skorunu/karar/findings'i göstermez.

> **Not:** Q4 N=5 olduğu için istatistiksel anlamlılık testi yapılmaz; *small-N illustrative correlation* çerçevesinde okunur (THESIS_FOCUS § 3 yorum tablosu).

---

## 1.4 Tezin katkıları

> **Yazım hedefi (1 sayfa):** Her katkı 1 paragraf + ilgili bölüm referansı.

1. **Mimari katkı (Bölüm 3):** Çok-ajanlı doğrulama zinciri mimarisi (Scribe → Critic → Proto → Trace + FixLoop) tasarlanmış ve PostgreSQL-backed persistence + açıklanabilirlik servisi ile genişletilmiştir. PDP-2 dalgasında in-memory volatility çözüldü; intent classifier + chat-qa eklendi.

2. **Empirik katkı (Bölüm 5):** Q1-Q4 deneyleri ile zincirin küçük problemler üzerinde işlevsel olduğu, Critic adversarial review'un atıl olmadığı, confidence skorlarının sinyal taşıdığı gözlemsel olarak gösterilmiştir.

3. **UX/persona katkısı (Bölüm 3-5):** Bakkal-personası hedefli açıklanabilirlik yüzeyi (PipelineCinema 4-kolon + ExplanationPanel per-stage reasoning kartları + confidence badge'ler) tasarlanmış, A/B Likert testi ile kullanıcı güveni üzerindeki etkisi değerlendirilmiştir. NFR-5 kapsamında bakkal-language sözlüğü + audit script üretilmiştir.

4. **Süreç katkısı:** PDP (Product Discovery & Design) sürecinin lisans tezi süresinde uygulanabilirliği gösterilmiştir. PDP-2 dalgası 15 PR'da [PDP2-METRICS] sayısal iyileşme sağlamıştır.

5. **Açık kaynak çıktı:** AKIS Platform açık kaynak olarak yayımlanmış, benchmark seti + Q2/Q4 formları + baseline JSON yeniden üretilebilirlik için paylaşılmıştır.

---

## 1.5 Tez yapısı

> **Yazım hedefi (0.5 sayfa):** Tek paragrafta tüm bölümlerin işlevi.

> Bölüm 2'de AI ajan orkestrasyonu, yazılım kalitesi/test üretimi ve non-developer AI araçları literatürü taranır; AKIS'in konumlandığı boş lane somutlanır. Bölüm 3 sistem mimarisini açıklar; pipeline orchestrator, verification chain, persistence layer (PDP-2), intent classifier + chat-qa surface, scaffold portability bileşenleri detaylandırılır. Bölüm 4 Q1-Q4 araştırma sorularına yönelik deney protokollerini sunar; benchmark seti, Likert anketi, rubric tasarımı, PDP-2 ölçüm metrikleri açıklanır. Bölüm 5 bulguları sunar — pipeline tamamlanma, Critic findings dağılımı, Likert sonuçları, kalibrasyon sonuçları, PDP-2 ürün metrikleri, bakkal-language audit. Bölüm 6 bulguları tezin core iddiası ekseninde değerlendirir; sınırlılıklar açıkça konur (small-N, single-language, single-bakkal). Bölüm 7 ana sonuçları ve ileriki çalışmaları özetler.

---

## Yazım notları (tez yazarken hatırlatma)

- Her bölümün ilk paragrafı **tek-cümlelik tezi** (§ 1.2) referans alır.
- Q1-Q4 numaralandırması tüm tezde sabit kalır (Bölüm 4 ve 5 aynı sırayı korur).
- Bakkal-persona ilk geçtiği yerde italik tanım: *bakkal-personası — yazılım geliştirici olmayan, dijital yetkinliği orta seviye, kendi işine yönelik küçük yazılım üretmek isteyen kullanıcı*.
- "Doğrulama zinciri" (verification chain) ilk geçtiği yerde tanımlı: *Scribe → Critic → İnsan Onayı → Proto → Critic → Trace → FixLoop ardışıklığı*.

---

## Kabul kriterleri (bu doc için)

- [ ] 1.1 → problem somut hissediliyor (data + sayılarla)
- [ ] 1.2 → tek-cümlelik tezi + scope açık
- [ ] 1.3 → Q1-Q4 tanımları THESIS_FOCUS § 3 ile özdeş
- [ ] 1.4 → 5 katkı + ilgili bölüm referansı
- [ ] 1.5 → tek paragrafta tüm tez

## Placeholder'lar (grep edilebilir)

- `[CITE-*]` — referans yer tutucuları
- `[TBL-1]` — rakip karşılaştırma tablosu
- `[PDP2-METRICS]` — PDP-2 sayısal değişim (§ 1.4 katkı 4)
