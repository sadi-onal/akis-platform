# AKIS Mini-Benchmark — Mayıs 2026

> **Durum:** Bu doküman, tezde "Bulgular ve Tartışma" bölümünün iskeleti olacak şekilde
> hazırlandı. Şu an üç boş tablo içeriyor: `scripts/benchmark/run.mjs` çalıştırılıp
> JSON çıktıları toplandığında bu tablolar doldurulup tezdeki anlatı yazılır.

## 1. Amaç

AKIS'in **doğrulama zinciri** mimarisi (Scribe → Critic → İnsan Onayı → Proto → Critic → Trace → FixLoop) küçük, gerçekçi yazılım problemlerinde:

1. **Tutarlı çıktı üretiyor mu?** (uçtan uca tamamlanma oranı, tekrarlanabilirlik)
2. **Açıklanabilirlik (explainability) yüzeyi geliştirici güvenini değiştiriyor mu?** (subjektif Likert ölçeği)
3. **Adversarial review (CriticAgent) hangi tip hataları yakalıyor?** (kategorik analiz)

Vizyon dokümanındaki (`docs/AKIS_VISION.md`) "doğrulama zinciri" iddiasını, görece dar ama tekrar koşulabilir bir veri kümesinde gözlemsel olarak test eder.

## 2. Yöntem

### 2.1 Problem Kümesi
Beş sabit, dar kapsamlı problem (`docs/dogfooding/benchmark-set.yaml`):

| ID | Başlık | Tahmini karmaşıklık |
|----|--------|---------------------|
| todo-001 | Tek kullanıcılı görev listesi | düşük |
| calc-002 | Tarayıcı hesap makinesi | düşük |
| currency-003 | Statik kur döviz çevirici | düşük |
| blog-004 | Read-only blog API (Express + JSON) | orta |
| qr-005 | QR kod üretici | düşük-orta |

Problemler bilinçli olarak **küçük** seçildi: lisans tezi süresinde manuel doğrulanabilir, mock provider ile ücretsiz koşulabilir, bir AKIS koşusunun ≤5 dakikada bitmesi beklenebilir.

### 2.2 Koşu Konfigürasyonu

Her problem **iki konfigürasyon** ile koşulur:

- **A — Baseline:** Frontend explainability/cinema yüzeyleri kapalı. Kullanıcı sadece klasik `StageTimeline` ve `ChatPanel` mesajlarını görür.
- **B — Explainable:** ExplanationPanel + PipelineCinema açık. Confidence badge'leri, attention banner, reasoning bubble'ları görünür.

Backend tamamen aynı, sadece UI yüzeyi farklı. Ölçülen pipeline metrikleri (süre, coverage, vb.) iki konfigürasyon arasında özdeş bekleniyor; **fark insan kullanıcının subjektif değerlendirmesinde aranıyor**.

Komut:

```bash
AKIS_API_BASE=http://localhost:3000 \
AKIS_TEST_TOKEN=<test-helper-token> \
node scripts/benchmark/run.mjs --label baseline   # ardından B konfigürasyonu için --label explainable
```

### 2.3 Sayısal Metrikler (Otomatik)

Her koşu için `scripts/benchmark/run.mjs` aşağıdakileri toplar ve `docs/dogfooding/results-<label>-<stamp>.json`'a yazar:

- `finalStage` (completed / completed_partial / failed)
- `durationMs` toplam pipeline süresi
- `confidenceByStage` her ajan için (Scribe, Critic-spec, Proto, Critic-code, Trace) güven skoru ve karar
- `attentionPoints` ExplainabilityService'in raporladığı dikkat noktası sayısı
- `coverage` Trace'in raporladığı AC kapsama yüzdesi
- `testCount` üretilen Playwright test sayısı
- `filesCreated` Proto'nun ürettiği dosya sayısı

### 2.4 Niteliksel Metrikler (Manuel)

Her koşu sonunda **3-5 katılımcı** (yazar + bitirme proje arkadaşları) aşağıdaki Likert ölçeğini doldurur (5 = kesinlikle katılıyorum):

1. *"Bu çıktıya güvenebileceğimi hissediyorum."*
2. *"Eğer bir hata olsaydı, açıklamadan/akıştan onu fark edebilirdim."*
3. *"Bu pipeline'ın benim için yararlı olacağını düşünüyorum."*

Her katılımcı her problemi **iki konfigürasyon** ile görür (counter-balanced order: yarısı A→B, yarısı B→A) — öğrenme bias'ını azaltmak için.

### 2.5 Sınırlılıklar

- **N küçük** (≈5 katılımcı, 5 problem). Lisans tezi kapsamında nicel istatistik testi (t-test, vb.) anlamlı sonuç vermez; gözlemsel gözlem olarak sunulur.
- **Self-experiment bias:** katılımcılar AKIS'i bilen aynı çevreden. Genel kullanıcıyı temsil etmez.
- **Mock provider riski:** mock AI çıktıları gerçek modelden kalitatif farklı olabilir. Asıl A/B en az bir defa **gerçek Anthropic** modeliyle de doğrulanmalı (token bütçesine göre).
- **Backend metrikleri konfigürasyonlar arasında değişmez** — bu benchmark **UX/güven** odaklı, "AI daha iyi kod üretiyor" iddiası değildir. Tezde bu sınır net belirtilmeli.
- **CriticAgent'a karşı prompt-injection saldırı testi yapılmadı** (gelecek iş — cf. § 6).

## 3. Bulgular (placeholder — koşu sonrası doldurulacak)

### 3.1 Tamamlanma Oranı

| Problem | Baseline | Explainable | Not |
|---------|----------|-------------|-----|
| todo-001 | _TBD_ | _TBD_ |  |
| calc-002 | _TBD_ | _TBD_ |  |
| currency-003 | _TBD_ | _TBD_ |  |
| blog-004 | _TBD_ | _TBD_ |  |
| qr-005 | _TBD_ | _TBD_ |  |

### 3.2 Güven Skoru Dağılımı

| Ajan | Ortalama Güven (5 problem) | En düşük | En yüksek |
|------|---------------------------|----------|-----------|
| Scribe | _TBD_ | _TBD_ | _TBD_ |
| Critic (spec) | _TBD_ | _TBD_ | _TBD_ |
| Proto | _TBD_ | _TBD_ | _TBD_ |
| Critic (kod) | _TBD_ | _TBD_ | _TBD_ |
| Trace | _TBD_ | _TBD_ | _TBD_ |

### 3.3 Likert Sonuçları (her problem ortalaması)

| Problem | Q1 (güven) A | Q1 (güven) B | Q2 (hata fark) A | Q2 (hata fark) B | Q3 (yararlılık) A | Q3 (yararlılık) B |
|---------|--------------|--------------|------------------|------------------|-------------------|-------------------|
| todo-001 | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| ... | | | | | | |

### 3.4 CriticAgent Bulgu Kategorileri

5 problem boyunca Critic'in raporladığı bulguların kategori dağılımı:

| Kategori | Frekans | Örnek |
|----------|---------|-------|
| completeness | _TBD_ | _TBD_ |
| ambiguity | _TBD_ | _TBD_ |
| consistency | _TBD_ | _TBD_ |
| testability | _TBD_ | _TBD_ |
| spec_compliance | _TBD_ | _TBD_ |
| security | _TBD_ | _TBD_ |

## 4. Tartışma (placeholder)

- Doğrulama zinciri **tamamlanma oranı** üzerinde gözlemlenen etki nedir?
- Explainable konfigürasyonda Likert güven skoru yükseliyor mu? Hangi soruda en belirgin?
- Critic'in en sık yakaladığı kategori hangisi? Bu, Sabra & Tyler 2025 (LLM bug taxonomy) ile uyumlu mu?
- Hangi problem(ler)de Critic kararsız davrandı? (false positive/negative gözlemleri)

## 5. İlgili Çalışmalar (kısa atıf)

- Sonar 2026 — geliştiricilerin %96'sı AI koduna tam güvenmiyor → AKIS'in açık güven yüzeyi bu boşluğu adresliyor.
- Sherlock 2026 — vibe-coded codebase'lerin %92'sinde ≥1 kritik açık → CriticAgent'ın security kategorisi bu yarayı kapsıyor.
- FORGE '26 (arXiv 2601.19106) — AST-tabanlı halüsinasyon tespiti %100 precision / %87.6 recall → AKIS'in `DeterministicValidator` katmanı bu metodolojinin sadeleştirilmiş bir uygulaması.
- TRiSM (Gartner / arXiv 2506.04133) — agentic AI güvenilirlik çerçevesi; Approval Gate + ExplanationService bu çerçevenin somut karşılığı.
- METR Şubat 2026 update ([metr.org](https://metr.org/blog/2026-02-24-uplift-update/)) — orijinal %19 yavaşlama bulgusunda seçim bias'ı kabul edildi; AKIS değerlendirmesinde bu hedge'lendi.

## 6. Gelecek İş

- CriticAgent prompt-injection sertleştirilmesi ve tekrar koşusu (`spawn-hijack` saldırı vektörleri 2025-26 literatüründe %58-90 başarı oranıyla raporlanıyor).
- N=20+ katılımcılı yeniden koşu — gerçek istatistik test imkanı verir.
- Karmaşıklık eksenini genişletmek (beş orta-zorluk problem ekle: full-stack auth, file upload, real-time chat, vb.)
- Persistent learning (pgvector + DSPy) ile aynı problem setinde "AKIS kendi geçmişinden öğreniyor mu?" sorusu.

## Ek A — Koşu Talimatları

```bash
# 1. Backend'i mock provider ile ayağa kaldır
cd akis-platform
AI_PROVIDER=mock ./scripts/dev-up.sh

# 2. Test-helper token'ı export et (backend/.env'de tanımlı)
export AKIS_TEST_TOKEN=$(grep TEST_TOKEN backend/.env | cut -d= -f2)

# 3. Baseline koşusu (UI flag'leri kapalı)
node scripts/benchmark/run.mjs --label baseline

# 4. Explainable koşusu (UI flag'leri açık — UI tarafından test edilir, backend aynı)
node scripts/benchmark/run.mjs --label explainable

# 5. Çıktı: docs/dogfooding/results-baseline-*.json + results-explainable-*.json
```

## Ek B — Likert Anketi (kullanıcılara verilecek metin)

> AKIS pipeline'ı [problem ID] için bir çıktı üretti. Lütfen aşağıdaki ifadelere
> 1 (kesinlikle katılmıyorum) - 5 (kesinlikle katılıyorum) ölçeğinde puan verin:
>
> 1. Bu çıktıya güvenebileceğimi hissediyorum.
> 2. Eğer bir hata olsaydı, açıklamadan/akıştan onu fark edebilirdim.
> 3. Bu pipeline'ın benim için yararlı olacağını düşünüyorum.
>
> Açıklama (ops): ...
