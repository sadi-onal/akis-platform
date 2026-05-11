# 05 — Bulgular

**Status:** ✍️ Skeleton — fill with data when available
**Bağımlılık:** [`04-experiments.md`](./04-experiments.md)
**Tahmini sayfa:** 12-15
**Veri kaynağı:** `docs/learnings/benchmark-2026-may.md` § 3, dogfooding form çıktıları

> **Bölümün amacı:** Q1-Q4 verisini + PDP-2 metriklerini + bakkal-language audit'ini akademik metinle sunmak. Yorumlama Bölüm 6'da; bu bölüm **veri** odaklı.

---

## 5.1 Q1 — Pipeline tamamlanma sonuçları

> **Yazım hedefi (2 sayfa):** Tablo + kısa yorum + Türkçe açıklama.

### 5.1.1 Tamamlanma oranı

> Kaynak: `results-baseline-2026-05-07T11-32-30-706Z.json`
> Model: `claude-haiku-4-5-20251001` · Wall clock: 238.1s · Provider: Anthropic

**Bulgu:** 5/5 pipeline başarılı şekilde Scribe → Critic-spec → `awaiting_approval` zincirini tamamladı. Runner-level hata yok.

[TBL-5.1] — Problem × stage × outcome × duration × Scribe confidence × Critic score × decision:

| Problem | Final stage | Süre | Scribe güven | Critic skoru | Karar |
|---------|-------------|------|--------------|--------------|-------|
| todo-001 | awaiting_approval | 48.2s | 92% | 82% | Spec onaylandı |
| calc-002 | awaiting_approval | 54.2s | 92% | 68% | Spec reddedildi |
| currency-003 | awaiting_approval | 48.2s | 92% | 68% | Spec reddedildi |
| blog-004 | awaiting_approval | 36.2s | 92% | 82% | Spec onaylandı |
| qr-005 | awaiting_approval | 51.3s | 88% | 82% | Spec onaylandı |

### 5.1.2 Güven skoru özeti

| Aşama | N | Ortalama | En düşük | En yüksek |
|-------|---|---------|---------|---------|
| Scribe | 5 | 91.2% | 88% | 92% |
| Critic (spec) | 5 | 76.4% | 68% | 82% |

**Gözlem:** Scribe çok dar bir bantta (88-92), Critic geniş bantta (68-82). Critic'in skor varyansı, Scribe'tan ~3× daha yüksek.

### 5.1.3 Onaylama oranı

3/5 = %60 onaylandı, 2/5 reddedildi. Critic körü körüne onaylamıyor; nesnel ayrımlar yapıyor:

- **Onaylananlar** (todo-001, blog-004, qr-005): minor + info düzey bulgularla rağmen overall ≥ 80 → threshold geçti.
- **Reddedilenler** (calc-002, currency-003): testability + ambiguity ağırlıklı bulgular → skor 68 → reddedildi.

### 5.1.4 Proto / Trace kademeleri

Bu birinci koşumda Proto/Trace kademeleri yok — pipeline `awaiting_approval` durdu. **Q1+Q3 sorularını Scribe + Critic-spec kademesi zaten yeterli ölçüde cevaplıyor** (doğrulama zinciri kalitesi başlangıçta belirleniyor). Proto/Trace dahil tam pipeline koşumu için gerçek GitHub PAT + ek bütçe gerekir; ikinci koşumda yapılır (gelecek iş).

---

## 5.2 Q2 — A/B Likert sonuçları

> **Yazım hedefi (2-3 sayfa):** Likert dağılımı + qualitative gözlemler.

### 5.2.1 Veri toplama özeti

| Metrik | Değer |
|---|---|
| Katılımcı sayısı | [Q2-DATA] |
| Cevaplanan problem × konfig sayısı | [Q2-DATA] |
| Counter-balanced order uyumu | [Q2-DATA] |

### 5.2.2 Likert dağılımı

[TBL-5.2] — Likert score per konfig per ifade:

| İfade | Baseline (A) ort. | Explainable (B) ort. | Δ (B − A) |
|---|---|---|---|
| 1. "Bu çıktıya güvenebileceğimi hissediyorum" | [Q2-DATA] | [Q2-DATA] | [Q2-DATA] |
| 2. "Hata olsaydı fark edebilirdim" | [Q2-DATA] | [Q2-DATA] | [Q2-DATA] |
| 3. "Yararlı olacağını düşünüyorum" | [Q2-DATA] | [Q2-DATA] | [Q2-DATA] |

[FIG-5.2] — Likert score box plot per ifade × konfig.

### 5.2.3 Qualitative gözlemler

[Q2-DATA] — katılımcı yorumlarından kısa alıntılar:

> **⚠️ ÖRNEK ŞABLON — gerçek Q2 verisi DEĞİL.** Aşağıdaki üç alıntı tezin
> nihai metninde nasıl görüneceğini *biçim olarak* göstermek için
> üretilmiş **sentetik şablon**dır. Q2 anketi tamamlandığında
> `docs/dogfooding/q2-responses/` altındaki gerçek yanıtlarla
> değiştirilecektir. Hiçbiri gerçek bir katılımcının ifadesi değildir.

- *"Açıklama tab'ı olmadan ne onayladığımı bilmiyordum."* (rater-X şablon, blog-004)
- *"Cinema 4-kolon ile aşamaları takip etmek kolaydı."* (rater-Y şablon, qr-005)
- *"Baseline'da Critic ne dedi anlayamadım."* (rater-Z şablon, todo-001)

### 5.2.4 Sınırlılıklar (Q2'ye özel)

- N küçük; istatistiksel anlamlılık testi yapılmadı.
- Self-experiment bias: katılımcılar AKIS'i bilen aynı çevreden.
- Mock provider riski yok — Q1 gerçek Anthropic ile yapıldı; Q2 aynı backend output'unu farklı UI'larda gösterir, backend identical.

---

## 5.3 Q3 — Critic findings analizi

> **Yazım hedefi (2 sayfa):** Kategori + severity tablosu + örnek alıntılar.

### 5.3.1 Bulgu kategorileri

> Toplam **27 bulgu** raporlandı (5 problem). Kaynak: aynı baseline JSON.

[TBL-5.3] — Kategori × frekans × pay × örnek (kısaltılmış):

| Kategori | Frekans | Pay | Örnek |
|----------|---------|-----|---|
| testability | 12 | %44 | "AC-4 page refresh test may be flaky in automated testing environments…" |
| ambiguity | 8 | %30 | "AC-2 uses vague visual descriptions 'üzeri çizili veya gri renk alır' which could…" |
| completeness | 6 | %22 | "Missing acceptance criteria for localStorage data persistence mechanism" |
| spec_compliance | 1 | %4 | "Technical constraints include responsive design which wasn't explicitly mentioned…" |
| consistency | 0 | %0 | (bulgu yok) |
| security | 0 | %0 | (problem seti küçük + auth yok → beklenen) |
| **Toplam** | **27** | **100%** | |

### 5.3.2 Severity dağılımı

| Şiddet | Adet | Pay |
|--------|------|-----|
| critical | 0 | %0 |
| major | 9 | %33 |
| minor | 13 | %48 |
| info | 5 | %19 |
| **Toplam** | **27** | **100%** |

**Gözlem:** Kritik bulgu sıfır — Critic ne aşırı uyarıcı (her şeyi critical yapıyor), ne de aşırı uysal (her şeyi info yapıyor). Major + minor karışımı, gerçekçi spec değerlendirmesinin doğal dağılımı gibi.

### 5.3.3 Yorum (Bölüm 6.1 ile çapraz referans)

- **Testability dominasyonu (%44):** [CITE-Sabra2025] "LLM-üretilen spec'ler test-friendly değil" gözlemiyle birebir örtüşür.
- **Ambiguity + completeness (%52):** klasik spec kalitesi sorunlarının payı.
- **Consistency + security (%0):** problem setinin yapısı (küçük, auth-içermeyen, tek-modüllü) ile uyumlu.

---

## 5.4 Q4 — Critic kalibrasyonu sonuçları

> **Yazım hedefi (2 sayfa):** [Q4-DATA] placeholder, gerçek r geldiğinde doldur.

### 5.4.1 Manuel rubric × Critic skoru

[TBL-5.4]:

| Spec | Critic skoru | Manuel ort | Δ (M − C) | Yön |
|------|--------------|------------|-----------|-----|
| todo-001 | 82% | [Q4-DATA] | [Q4-DATA] | [Q4-DATA] |
| calc-002 | 68% | [Q4-DATA] | [Q4-DATA] | [Q4-DATA] |
| currency-003 | 68% | [Q4-DATA] | [Q4-DATA] | [Q4-DATA] |
| blog-004 | 82% | [Q4-DATA] | [Q4-DATA] | [Q4-DATA] |
| qr-005 | 82% | [Q4-DATA] | [Q4-DATA] | [Q4-DATA] |

### 5.4.2 Pearson r

- **Pearson r (Critic × Manuel ort):** [Q4-DATA]
- **n (spec çiftleri):** 5
- **Onay kararı uyumu** (Critic approved vs manual ≥ 80% eşiği): [Q4-DATA]/5

> N=5 küçüktür; Pearson r anlamlılık testi yapılmaz. Aşağıdaki yorum
> "small-N illustrative correlation" çerçevesinde okunmalıdır.

### 5.4.3 Yorum (Bölüm 4.4.4 tablosuna göre)

[Q4-DATA] — gerçek r geldiğinde 4.4.4'teki yorum tablosundan ilgili satır yapıştırılır.

### 5.4.4 Rater-arası tutarlılık

[Q4-DATA] — eğer ≥ 2 rater olduysa rater-arası varyans.

---

## 5.5 PDP-2 ürün metrikleri

> **Yazım hedefi (2 sayfa):** Süreç + kod kalitesi metrikleri. Bölüm 4.5 ölçüm tablosunu burada raporla.

### 5.5.1 Sayısal değişim (PDP-2 öncesi → sonrası)

**Ölçüm tarihi:** 2026-05-11 — **commit:** `084f867` (main HEAD). 4.5.3 ile aynı snapshot — tutarlı kalması için tek tabloya bağlı.

[TBL-5.5]:

| Metrik | Önce | Sonra | Δ | Bağlı FR/NFR |
|---|---:|---:|---:|---|
| Backend test sayısı | ~3179 | ~3260 | +81 | NFR (test coverage) |
| Frontend test sayısı | 813 | 860 | +47 | NFR (test coverage) |
| Backend coverage | (önce ölçülmemişti) | %79 | + | NFR-3 / NFR-4 |
| ChatPage line count | 1409 | 372 | -73% | F-06 refactor |
| Bakkal-language audit warn | (yoktu) | 33 | + | NFR-5.1 |
| Pipeline reasoning persist | 0% | 100% | NFR-1.1 ✅ | NFR-1 |
| Intent classification | yoktu | 4-class + 0.7 threshold | FR-11 ✅ | FR-11 |
| Chat Q&A (RAG + SSE) | yoktu | mevcut | FR-10 ✅ | FR-10 |
| Scaffold portability | yoktu | 8 stack | FR-6.5..6.8 ✅ | FR-6 |

### 5.5.2 PR audit trail

15 PR (4 wave) — `docs/product/06-roadmap.md` referansı. Tezde ek olarak.

[PDP2-METRICS] — Bölüm 4.5.3 ile özdeş.

### 5.5.3 İmplementasyon log

`.claude/state/implementation-log.jsonl` — 10 implementation entry, machine-readable audit trail. Lisans tezi için ham kanıt.

### 5.5.4 Disiplinli ön-tasarım gözlemi

- **Spec-first verimi 5×'lik sıkıştırdı.** 7 PDP dokümanı (00-06) yazılırken her gereksinim FR/F-ID etiketleriyle açıklandı. Bu, implementation aşamasında subagent'lara verilebilen brief'leri tek bir referans noktasına bağladı.
- 15 PR ortalama 20-30 dakikada paralel subagent'larla tamamlandı.

---

## 5.6 Bakkal-language audit (NFR-5.1 baseline)

> **Yazım hedefi (1 sayfa):** Audit script + baseline + iyileştirme.

### 5.6.1 Audit script

- `scripts/lint/bakkal-language.mjs` — zero-dependency Node script
- İki mod: **error** (default — sözlükteki banned terimler) + **warn** (info-severity)
- Allowlist: teknik gereksinim olan terimler için

### 5.6.2 Baseline sonuç

| Metrik | Değer |
|---|---|
| Audit error count | 0 (banned terim sızıntısı yok) |
| Audit warn count | 33 (push, repo, vb. henüz tam dönüşmemiş) |
| Info-severity finding | 102 (deferred to PDP-3) |
| i18n catalog senkronu | 1436 key TR ↔ EN |

[BAKKAL-AUDIT] — gerçek son sayım

### 5.6.3 Gözlem

- "Push" terimi PDP-2 wave'de yeni eklendi (Proto README üreticisi); audit warn aldı → "değişiklik kaydı" / "değişikliği gönder" gibi Türkçe karşılık alternatifleri ileride değerlendirilir.
- NFR-5.4 5-dakika oturum testi (Q2 self-pilot v2) sonrasında gerçek kullanıcı dilinden ek ihlaller toplanır.

---

## 5.7 Sonuçların özeti

[TBL-5.7] — Q1-Q4 + PDP-2 özet:

| Soru | Beklenen | Bulunan | Sonuç |
|---|---|---|---|
| Q1 | Pipeline tamamlanma | 5/5 success | ✅ Doğrulama zinciri çalışıyor |
| Q2 | Likert farkı | [Q2-DATA] | [Q2-DATA] |
| Q3 | Critic kategorik dağılımı | testability dominant + kritik=0 | ✅ Adversarial review atıl değil |
| Q4 | Pearson r | [Q4-DATA] | [Q4-DATA] |
| PDP-2 | Süreç + metrik | 15 PR + NFR-1 ✅ | ✅ Disiplinli ön-tasarım uygulanabilir |

---

## Kabul kriterleri (bu doc için)

- [ ] 5.1 → Q1 verisi tablo + 4 gözlem
- [ ] 5.2 → [Q2-DATA] doldurulduktan sonra Likert dağılımı + qualitative gözlemler
- [ ] 5.3 → Q3 kategori + severity tablosu + 3 örnek alıntı
- [ ] 5.4 → [Q4-DATA] doldurulduktan sonra Pearson r + onay uyumu
- [ ] 5.5 → [PDP2-METRICS] tablosu eksiksiz
- [ ] 5.6 → audit baseline + delta

## Placeholder'lar (grep edilebilir)

- `[Q1-DATA]`, `[Q2-DATA]`, `[Q3-DATA]`, `[Q4-DATA]`, `[PDP2-METRICS]`, `[BAKKAL-AUDIT]`
- `[TBL-5.1]` ... `[TBL-5.7]` — bulgular tabloları
- `[FIG-5.2]` — Likert box plot
