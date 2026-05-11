# 04 — Deneysel Çalışma

**Status:** ✍️ Skeleton — fill with data when available
**Bağımlılık:** [`03-architecture.md`](./03-architecture.md)
**Tahmini sayfa:** 10-12
**Veri kaynağı:** `docs/learnings/benchmark-2026-may.md`, `docs/dogfooding/`

> **Bölümün amacı:** Q1-Q4 araştırma sorularına yönelik deney protokollerini ve veri toplama prosedürlerini detaylandırmak. Bulgular Bölüm 5'te.

---

## 4.1 Q1 — Pipeline tamamlanma çalışması

> **Yazım hedefi (2 sayfa):** Yöntem, problem seti, koşum konfigürasyonu, ölçülen metrikler.

### 4.1.1 Yöntem

**Soru:** AKIS'in doğrulama zinciri ardışıklığı küçük gerçek problem seti üzerinde uçtan uca tamamlanabilir mi?

**Tasarım:** N_problem = 5, N_run/problem = 1, N_total = 5 (single-run baseline; test-retest variance ölçülmedi — bkz. § 6.2 sınırlılıklar).

**Ölçüm:** Her problem için pipeline `final stage`, `duration`, `confidenceByStage`, `attentionPoints`, `coverage` (Trace aktifse), `testCount`, `filesCreated`.

### 4.1.2 Problem seti (`docs/dogfooding/benchmark-set.yaml`)

Beş sabit, dar kapsamlı problem:

| ID | Başlık | Tahmini karmaşıklık |
|----|--------|---------------------|
| todo-001 | Tek kullanıcılı görev listesi | düşük |
| calc-002 | Tarayıcı hesap makinesi | düşük |
| currency-003 | Statik kur döviz çevirici | düşük |
| blog-004 | Read-only blog API (Express + JSON) | orta |
| qr-005 | QR kod üretici | düşük-orta |

**Seçim gerekçesi:** lisans tezi süresinde manuel doğrulanabilir, mock/Haiku ile ücretsiz/ucuz koşulabilir, ≤ 5 dakika/problem.

### 4.1.3 Koşum konfigürasyonu

- **Model:** `claude-haiku-4-5-20251001` (Anthropic Haiku — baseline)
- **AI_PROVIDER:** `anthropic` (gerçek koşum, mock değil)
- **Backend:** local dev (`./scripts/dev-up.sh`)
- **Script:** `node scripts/benchmark/run.mjs --label baseline`
- **Output:** `docs/dogfooding/results-baseline-<stamp>.json`

### 4.1.4 Veri durumu

- ✅ **Birinci koşum (2026-05-07) mevcut:** `results-baseline-2026-05-07T11-32-30-706Z.json`
- Sonuçlar Bölüm 5.1'de — [Q1-DATA] placeholder.

---

## 4.2 Q2 — A/B Likert testi (açıklanabilirlik etkisi)

> **Yazım hedefi (2-3 sayfa):** A/B yapısı, Likert anketi, counter-balancing, katılımcı.

### 4.2.1 Yöntem

**Soru:** Açıklanabilirlik yüzeyi AÇIK vs KAPALI olduğunda kullanıcı güveni Likert ölçeğinde farklılık gösterir mi?

**Tasarım:** Within-subject A/B — her katılımcı 5 problemi iki konfigürasyon (baseline + explainable) ile değerlendirir.

### 4.2.2 İki konfigürasyon

- **A — Baseline:** Frontend explainability/cinema yüzeyleri kapalı. Kullanıcı sadece klasik `StageTimeline` ve `ChatPanel` mesajlarını görür. Confidence badge, attention banner, reasoning bubble yok.
- **B — Explainable:** `PipelineCinema` (4-kolon) + `ExplanationPanel` (per-stage reasoning) + confidence badge + attention banner aktif.

**Önemli:** Backend tamamen aynı; pipeline metrikleri (süre, coverage) iki konfig arasında özdeş. **Fark insan kullanıcının subjektif değerlendirmesinde aranıyor.**

### 4.2.3 Likert ifadeleri (5 ölçek; 5 = kesinlikle katılıyorum)

1. *"Bu çıktıya güvenebileceğimi hissediyorum."* (trust)
2. *"Eğer bir hata olsaydı, açıklamadan/akıştan onu fark edebilirdim."* (detectability)
3. *"Bu pipeline'ın benim için yararlı olacağını düşünüyorum."* (utility)

### 4.2.4 Counter-balancing

Öğrenme bias'ını azaltmak için katılımcıların yarısı A→B, diğer yarısı B→A görür. Her problem aynı katılımcı için iki kez göründüğü için **arada en az 5 dakikalık dinlenme** (cognitive priming azaltma).

### 4.2.5 Katılımcılar

- **N hedefi:** 3-5 (yazar + bitirme proje arkadaşları + advisor'ın isteğine göre 1-2 ek)
- **Limitler:** lisans tezi kapsamında istatistiksel anlamlılık testi yapılmaz; gözlemsel sunulur (THESIS_FOCUS § 3 Q2).

### 4.2.6 Form ve veri

- **Form:** `docs/dogfooding/q2-likert-form.html` — kendine ait + Q2v2 görsel snapshot pair'leri (`docs/dogfooding/q2-pairs/*.png` — todo, calc, currency, blog, qr — A baseline + B explainable her biri)
- **Sonuçlar:** `docs/dogfooding/q2-responses/*.json`
- **Veri durumu:** 🟡 form + 1 katılımcı (anon — yazar) mevcut; ek katılımcı bekleniyor → [Q2-DATA]

---

## 4.3 Q3 — Critic findings analizi

> **Yazım hedefi (1-2 sayfa):** Otomatik kategori dağılımı.

### 4.3.1 Yöntem

**Soru:** Critic'in 6 boyutu Q1 koşumlarında hangi sıklıkta finding üretti?

**Veri:** Q1 baseline koşumdan otomatik aggregation — `scripts/benchmark/analyze.mjs` çalıştırılır.

### 4.3.2 Ölçüm

| Boyut | Beklenen davranış |
|---|---|
| completeness | Eksik AC veya değer önerisi |
| ambiguity | Belirsiz UI terim / vague seçim |
| testability | AC'lerin test-friendly yazılması |
| consistency | Şartların kendi içinde çelişmesi |
| spec_compliance | Spec şablonu uygunluğu |
| security | Auth, data, secret handling |

### 4.3.3 Severity dağılımı

- critical / major / minor / info
- "Rubber stamp" sınanır: critical = 0 ya da major+minor ağırlıklı?

### 4.3.4 Veri durumu

- ✅ **Birinci koşumdan 27 finding analiz edilmiş.**
- Q3 başlıca cevap için ek koşum gerekmez (aynı veri Q1+Q3'e cevap verir).
- Sonuçlar Bölüm 5.3 — [Q3-DATA] zaten doldurulmuş.

---

## 4.4 Q4 — Manuel rubric kalibrasyonu

> **Yazım hedefi (2-3 sayfa):** Bağımsız rubric tasarımı + Pearson r metodolojisi.

### 4.4.1 Yöntem

**Soru:** Critic'in `overallScore` puanı bağımsız manuel rubric ile değerlendirildiğinde örtüşür mü?

**Korelasyon:** Pearson r, N=5 spec çifti.

### 4.4.2 Bağımsız rubric tasarımı

Rubric Critic'in kendi kategorilerinden **kasıtlı olarak ayrık** seçildi — circular reference önlemek için. Kriterler **ürün/iş perspektifindendir**, *spec dokümanının yapısal kalitesi* değil *spec'in oluşturduğu ürünün kullanıcı/iş açısından sağlamlığı* ölçülür:

| # | Kriter | Puan |
|---|---|---|
| 1 | Ürün vizyonu netliği — spec yalnız okunarak ne inşa ediliyor soruları cevaplanabiliyor mu? | 0-10 |
| 2 | Kullanıcı yararı belirginliği — değer önerisi açık mı? | 0-10 |
| 3 | Kullanıcı fikrine sadakat — orijinal idea ile örtüşme | 0-10 |
| 4 | MVP kapsamı uygunluğu — doğru ölçek | 0-10 |
| 5 | Yazılımcı olmayan anlaşılabilirliği — bakkal okuyup ne aldığını anlar mı? | 0-10 |
| 6 | Pratik fizibilite (1 hafta · 1 dev) | 0-10 |

**Toplam:** 60 puan → yüzdeye normalize → Critic'in `overallScore` ile karşılaştır.

### 4.4.3 Bias engellemek için

- Form Critic skorunu/karar/findings'i **göstermez** (`q4-specs-snapshot.json` o verileri içermez)
- Aggregator: `scripts/benchmark/q4-aggregate.mjs`

### 4.4.4 Pearson r yorum tablosu (THESIS_FOCUS § 3 Q4)

| \|r\| aralığı | Yorum |
|---|---|
| ≥ 0.7 | Güçlü uyum: kalibre. Threshold-tabanlı approval rasyonel. |
| 0.4 – 0.7 | Orta uyum: Critic sinyal taşıyor ama kesin değil. Threshold ayarı düşünülebilir. |
| 0.2 – 0.4 | Zayıf uyum: skor kalibre değil; threshold tek başına karar için yetersiz. |
| < 0.2 | Korelasyon yok: kalibrasyon problemi. |

### 4.4.5 Sınırlılıklar (Q4'e özel)

- **N=5 spec çifti** — istatistiksel güç düşük; yön/büyüklük gösterir.
- **Tek baseline koşumu** — aynı spec yeniden üretildiğinde Critic skoru oynayabilir (LLM stochasticity).
- **Rater havuzu küçük** — yazar + 1-2 bitirme arkadaşı; aggregator rater-arası varyansı raporlar.
- **Rubric kasıtlı disjoint** — pozitif korelasyon iki bağımsız sinyalin çakıştığını gösterir.

### 4.4.6 Veri durumu

- 🟡 Form (`docs/dogfooding/q4-rubric-form.html`) + spec snapshot (`q4-specs-snapshot.json`) + aggregator hazır.
- Kullanıcı manuel skor doldurana kadar TBD.
- Sonuçlar Bölüm 5.4 — [Q4-DATA]

---

## 4.5 PDP-2 dalga sonuçları (süreç ölçümü)

> **Yazım hedefi (2 sayfa):** PDP-2 wave'i (15 PR, 4 wave) — disiplinli ön-tasarım sürecinin lisans tezi süresinde uygulanabilirliği.

### 4.5.1 Yöntem

**Soru:** Disiplinli ön-tasarım (PDP) süreci AI-asisted geliştirme hızında uygulanabilir mi? Sonucu ölçülebilir mi?

**Ölçüm noktası:** PDP-2 öncesi (2026-05-09) vs sonrası (2026-05-11).

### 4.5.2 PDP-2 dalga yapısı

| Wave | Hedef | PR sayısı |
|---|---|---|
| 1 | P0/P1 fix'leri (paralel) — F-01, F-02, F-04 | 3 |
| 2 | NFR-1 persistence (F-11 + F-03) | 1 |
| 3 | ScaffoldEnricher (F-08) | 1 |
| 4 | Intent classifier + chat-qa (F-10 + F-09) — paralel | 2 |
| 5 | Cleanup (F-05, F-07, F-12) + dogfooding planı | 3+ |
| F-06 follow-up | ChatPage refactor | 1 |
| Testing follow-up | e2e (intent + chat-qa) | 1 |
| Wave3 prep | Docs + tooling + smoke | 1 |
| **Toplam** | | **15** |

### 4.5.3 Ölçülen metrikler

**Ölçüm tarihi:** 2026-05-11 — **commit:** `084f867` (main HEAD, PR #525 squash sonrası). Rakamlar bu snapshot içindir; yeni PR'lar ile değişebilir.

| Metrik | Önce | Sonra | Δ |
|---|---:|---:|---:|
| Backend test sayısı | ~3179 | ~3260 | +81 |
| Frontend test sayısı | 813 | 860 | +47 |
| Bakkal-language audit warn | (yoktu) | 33 | + |
| Pipeline reasoning persist | 0% | 100% | NFR-1.1 ✅ |
| Intent classification | yoktu | 4-class + 0.7 threshold | FR-11 ✅ |
| Chat Q&A (RAG citations + SSE) | yoktu | mevcut | FR-10 ✅ |
| Scaffold portability | yoktu | 8 stack | FR-6.5..6.8 ✅ |
| ChatPage line count | 1409 | 372 | -73% (F-06) |

[PDP2-METRICS] — Bölüm 5.5 ile çapraz referans.

### 4.5.4 Veri durumu

- ✅ Mevcut — `docs/learnings/benchmark-2026-may.md` Ek C
- PR commit history audit trail

---

## 4.6 Veri toplama özet tablosu

| Q | Veri tipi | Kaynak | N | Durum |
|---|---|---|---:|---|
| Q1 | Otomatik (pipeline log) | `results-baseline-*.json` | 5 problem | ✅ |
| Q2 | Manuel Likert (anket) | `q2-responses/*.json` + 1 anon | 3-5 katılımcı | 🟡 |
| Q3 | Otomatik (finding aggregation) | aynı baseline JSON | 27 finding | ✅ |
| Q4 | Manuel rubric (form) | `q4-responses/*.json` | 5 spec | 🟡 |
| PDP-2 | Mixed (PR audit + test sayım) | `benchmark-2026-may.md` Ek C | 15 PR | ✅ |

---

## 4.7 Etik ve katılımcı izni

> **Yazım hedefi (0.5 sayfa):** Q2 katılımcı izni + veri anonimliği.

- Q2 Likert formu **anonim** — sadece "rater-id" (sıralı sayı) + tarih.
- Katılımcılara sözel ve formda yazılı bilgilendirme (Türkçe): amaç, süre (~30 dk), istedikleri zaman çıkma hakkı.
- Q4 rubric formu da anonim — yazar + 1-2 sınıf arkadaşı; raw veri repo'da public (kişisel veri içermez).

---

## Kabul kriterleri (bu doc için)

- [ ] 4.1 → Q1 yöntem net + veri durumu ✅
- [ ] 4.2 → Q2 A/B yapısı + counter-balancing + Likert ifadeleri açık
- [ ] 4.3 → Q3 kategori + severity ölçümü
- [ ] 4.4 → Q4 bağımsız rubric + Pearson r + sınırlılıklar
- [ ] 4.5 → PDP-2 ölçümü 15 PR audit
- [ ] Her deneyin **veri durumu** belirgin (mevcut / bekliyor)

## Placeholder'lar (grep edilebilir)

- `[Q1-DATA]`, `[Q2-DATA]`, `[Q3-DATA]`, `[Q4-DATA]`, `[PDP2-METRICS]`
