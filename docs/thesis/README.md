# AKIS Tez Paketi — Giriş ve Yazım Rehberi

**Status:** ✍️ Skeleton — fill with data when available
**Owner:** Ömer Yasir Önal (FSMVÜ Yazılım Mühendisliği, Lisans)
**Advisor:** [Advisor — danışman adı, LaTeX export adımında advisor onayıyla eklenir]
**Hedef savunma:** 2026 Mayıs sonu
**Locale:** Türkçe (akademik metin) + İngilizce kod/teknik terimler

---

## 1. Bu paket nedir?

`docs/thesis/` AKIS bitirme tezinin **iskelet + yazım planı** klasörüdür. 7 ana bölüm + bir conclusion + bu README. Her dosya **ne yazılacağı**nın yer tutucu hâlidir; gerçek prose iş bittikçe (Q2/Q4 verisi, PDP-2 metrikleri, vb.) doldurulur.

> **Felsefe:** Ürün belgeleri (`docs/product/`) ve dogfooding verisi (`docs/dogfooding/`) hâlihazırda mevcut — tez bunları yeniden yazmaz, **akademik çerçevede sentezler**. Çift yazım yok; placeholder etiketler veri geldiğinde grep'lenip yerleştirilir.

---

## 2. Yazım sırası (önerilen)

| Sıra | Dosya | Bağımlılık | Veri kaynağı |
|---|---|---|---|
| 1 | `00-outline.md` | yok | `docs/THESIS_FOCUS.md` |
| 2 | `01-introduction.md` | 00 | `docs/AKIS_VISION.md`, `docs/PRODUCT_DIRECTION.md` |
| 3 | `02-literature.md` | 01 | Sonar 2026, Sherlock 2026, FORGE'26, TRiSM, METR, Sabra & Tyler 2025, Qodo 2025 |
| 4 | `03-architecture.md` | 01-02 | `docs/ARCHITECTURE.md`, `docs/product/03-architecture.md` |
| 5 | `04-experiments.md` | 03 | `docs/learnings/benchmark-2026-may.md`, dogfooding forms |
| 6 | `05-results.md` | 04 | Q1+Q3 baseline (mevcut), Q2 form çıktısı, Q4 aggregator, PDP-2 metrikler |
| 7 | `06-discussion.md` | 05 | Tez Q1-Q4 cevapları + sınırlılıklar |
| 8 | `07-conclusion.md` | 06 | Tüm bölümler |

**Paralel yazılabilir:** 02 (literatür) ve 03 (mimari) bağımsız. 04 + 05 sıralı (deney → bulgu).

---

## 3. Placeholder etiketleri

Aşağıdaki etiketler `grep` ile bulunup veri geldiğinde doldurulur:

| Etiket | Anlam | Veri kaynağı geldiğinde |
|---|---|---|
| `[Q1-DATA]` | Q1 pipeline çalışması (5 problem) | `docs/dogfooding/results-baseline-2026-05-07T11-32-30-706Z.json` (✅ mevcut) |
| `[Q2-DATA]` | Q2 Likert A/B sonuçları | `docs/dogfooding/q2-responses/` (en az 3-5 katılımcı dolduktan sonra) |
| `[Q3-DATA]` | Q3 Critic findings dağılımı | Aynı baseline JSON (✅ mevcut) |
| `[Q4-DATA]` | Q4 manuel rubric × Critic Pearson r | `docs/dogfooding/q4-responses/` (kullanıcı 5 spec'i skorlayınca) |
| `[PDP2-METRICS]` | PDP-2 dalga sayısal değişim | `docs/learnings/benchmark-2026-may.md` Ek C (✅ mevcut) |
| `[BAKKAL-AUDIT]` | NFR-5.1 bakkal-language audit warn count | `scripts/lint/bakkal-language.mjs` çıktısı |
| `[FIG-X]` | Tez şekil yer tutucusu (mimari diagram, screenshot) | Mermaid render → PNG export veya PDF figure |
| `[TBL-X]` | Tez tablo yer tutucusu | Benchmark JSON aggregator |
| `[CITE-X]` | Referans yer tutucusu | Bibliography (LaTeX bib dosyası geldiğinde) |

> **İpucu:** `grep -rn "\[Q4-DATA\]" docs/thesis/` ile placeholder'ları tek seferde tara.

---

## 4. Format kararı: Markdown mı LaTeX mı?

**Şu an:** Markdown. Skeleton, draft, ve revizyonlar için en hızlı; GitHub'da render edilir, advisor çevrimiçi okuyabilir.

**Defense öncesi son hafta:** LaTeX'e dönüşüm. FSMVÜ tez şablonu (resmî) zorunlu; pandoc ile Markdown → LaTeX otomatik geçiş + manuel düzeltme. Tek dosyada birleşim:
```bash
pandoc docs/thesis/00-outline.md docs/thesis/01-introduction.md docs/thesis/02-literature.md docs/thesis/03-architecture.md docs/thesis/04-experiments.md docs/thesis/05-results.md docs/thesis/06-discussion.md docs/thesis/07-conclusion.md -o thesis-draft.tex --template=fsmvu-template.tex
```

**Şekiller:** Markdown'da mermaid → defense'te PNG'ye çevrilir, LaTeX'te `\includegraphics`.

**Bibliography:** Markdown'da `[CITE-Sonar2026]` placeholder; LaTeX dönüşümünde `\cite{sonar2026}` + `references.bib`.

---

## 5. Tez tek-cümlelik tezi (THESIS_FOCUS § 1)

> **AKIS, AI tarafından üretilen yazılım çıktılarına geliştirici güvenini somut hâle getiren çok-ajanlı bir doğrulama zinciridir.**

Anahtar kelime: **kalite güveni** (quality trust). Güvenlik değil. Her bölümün giriş paragrafı bu cümleyi referans alır.

---

## 6. Q1-Q4 araştırma soruları (kısa)

| ID | Soru | Veri durumu |
|---|---|---|
| Q1 | Doğrulama zinciri çalışıyor mu? | ✅ Birinci koşum (5/5 success) |
| Q2 | Açıklanabilirlik geliştirici güvenini değiştiriyor mu? | 🟡 A/B form hazır, katılımcı bekleniyor |
| Q3 | Critic adversarial review ne yakalıyor? | ✅ 27 finding, 5 kategori |
| Q4 | Confidence skorları kalibre mi? | 🟡 Form hazır, kullanıcı manuel skor bekliyor |

Detay: [`00-outline.md`](./00-outline.md) § 5, [`04-experiments.md`](./04-experiments.md).

---

## 7. Tez tarafındaki riskler & azaltıcılar

| Risk | Olasılık | Etki | Azaltıcı |
|---|---|---|---|
| Q2 katılımcı 3'ten azı dönerse | orta | düşük (gözlemsel zaten) | Yazar + 2 sınıf arkadaşı garanti; ek 2 katılımcı bonus |
| Q4 Pearson r < 0.2 (kalibre değil) | düşük | orta (tez claim'i zayıflar) | Hâlâ "Critic sinyal taşıyor ama threshold yeniden ayarlanmalı" diye yorumlanır; yön değiştirmez |
| LaTeX dönüşüm zaman aşar | orta | yüksek | Markdown draft tamamen onaylı olduktan sonra son 3 gün LaTeX'e ayrılır |
| Advisor revisionu büyük çıkarsa | orta | yüksek | Skeleton aşamasında erken paylaşım — bölüm bölüm onay |
| Yazma sırasında scope crawl | yüksek | orta | THESIS_FOCUS § 6 karar kuralı: Q1-Q4 filtresi |

---

## 8. Cross-references

- [`../THESIS_FOCUS.md`](../THESIS_FOCUS.md) — tez ekseni, Q1-Q4 tanımı, scope dışı liste
- [`../PRODUCT_DIRECTION.md`](../PRODUCT_DIRECTION.md) — bakkal personası + Tier 1/2/3
- [`../AKIS_VISION.md`](../AKIS_VISION.md) — vizyon umbrella
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — mevcut mimari (PDP-2 sonrası)
- [`../learnings/benchmark-2026-may.md`](../learnings/benchmark-2026-may.md) — Q1+Q3 baseline + Ek C (PDP-2)
- [`../product/`](../product/) — PDP-2 paketi (00-06), FR/NFR ID kaynağı
- [`../dogfooding/q2-likert-form.html`](../dogfooding/q2-likert-form.html), [`../dogfooding/q4-rubric-form.html`](../dogfooding/q4-rubric-form.html) — empirik veri toplama

---

## 9. Sonraki adım

1. `00-outline.md` ile başla — top-level outline + title + abstract slot
2. Advisor'a Markdown draft halinde paylaş (bölüm bölüm)
3. Q2/Q4 verisi geldikçe placeholder'ları doldur
4. Son hafta: pandoc → LaTeX dönüşümü + FSMVÜ şablon entegrasyonu
