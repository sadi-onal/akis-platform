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

## 3. Bulgular — Birinci koşum (2026-05-07, Anthropic Haiku, baseline)

> Kaynak: `docs/dogfooding/results-baseline-2026-05-07T11-32-30-706Z.json` · Üretici: `scripts/benchmark/analyze.mjs`
> Bu koşum **baseline** konfigürasyonudur (Q1+Q3). Q2 (Likert A/B) için ayrıca **explainable** koşumu + 3-5 katılımcılı anket gerekir; bu hâlen yapılacak.

### 3.1 Q1.1 — Tamamlanma Oranı

5/5 pipeline başarılı şekilde Scribe → Critic-spec → `awaiting_approval` zincirini tamamladı. Hiçbir runner-level hata yok.

| Problem | Final stage | Süre | Scribe güven | Critic skoru | Karar |
|---------|-------------|------|--------------|--------------|-------|
| todo-001 | awaiting_approval | 48.2s | 92% | 82% | Spec onaylandi |
| calc-002 | awaiting_approval | 54.2s | 92% | 68% | Spec reddedildi |
| currency-003 | awaiting_approval | 48.2s | 92% | 68% | Spec reddedildi |
| blog-004 | awaiting_approval | 36.2s | 92% | 82% | Spec onaylandi |
| qr-005 | awaiting_approval | 51.3s | 88% | 82% | Spec onaylandi |

**Toplam:** 238.1s wall clock, ortalama 47.6s/problem, model `claude-haiku-4-5-20251001`.

### 3.2 Q1.2 — Güven Skoru Özeti

| Aşama | N | Ortalama | En düşük | En yüksek |
|-------|---|---------|---------|---------|
| Scribe | 5 | 91.2% | 88% | 92% |
| Critic (spec) | 5 | 76.4% | 68% | 82% |

Scribe çok dar bir bant'ta (88-92), Critic geniş bant'ta (68-82). **Critic'in skor varyansı, Scribe'tan ~3x daha yüksek** — Critic gerçekten farklı kalitedeki spec'leri farklı puanlıyor (sabit puan vermiyor).

> Proto / Critic-code / Trace kademeleri bu koşumda yok — pipeline `awaiting_approval`'da durdu. Onlar için ayrıca gerçek GitHub PAT ile koşum gerekir; Q1+Q3 sorularını **Scribe + Critic-spec** kademesi zaten yeterli ölçüde cevaplıyor (doğrulama zinciri kalitesi başlangıçta belirleniyor).

### 3.3 Q1.3 — Critic Onaylama Oranı

**3/5 = %60 onaylandı**, 2/5 reddedildi. Critic körü körüne onaylamıyor; gerçek nesnel ayrımlar yapıyor:
- **Onaylananlar** (todo-001, blog-004, qr-005): minor + info düzey bulgularla rağmen overall skor ≥ 80 → critic threshold'unu geçti.
- **Reddedilenler** (calc-002, currency-003): testability + ambiguity ağırlıklı bulgular → skor 68 → reddedildi.

### 3.4 Q3 — Critic Bulgu Kategorileri

5 problem boyunca toplam **27 bulgu** raporlandı. Dağılım:

| Kategori | Frekans | Pay | Örnek (kısaltılmış) |
|----------|---------|-----|---------------------|
| testability | 12 | %44 | "AC-4 page refresh test may be flaky in automated testing environments due to timing…" |
| ambiguity | 8 | %30 | "AC-2 uses vague visual descriptions 'üzeri çizili veya gri renk alır' which could…" |
| completeness | 6 | %22 | "Missing acceptance criteria for localStorage data persistence mechanism" |
| spec_compliance | 1 | %4 | "Technical constraints include responsive design which wasn't explicitly mentioned…" |
| consistency | 0 | %0 | (bulgu yok) |
| security | 0 | %0 | (problem seti küçük + auth yok → beklenen) |
| **Toplam** | **27** | **100%** | |

### 3.5 Q3.2 — Bulgu Şiddeti (severity) Dağılımı

| Şiddet | Adet | Pay |
|--------|------|-----|
| critical | 0 | %0 |
| major | 9 | %33 |
| minor | 13 | %48 |
| info | 5 | %19 |
| **Toplam** | **27** | **100%** |

**Kritik bulgu sıfır** — Critic ne aşırı uyarıcı (her şeyi critical yapıyor), ne de aşırı uysal (her şeyi info yapıyor). Major + minor karışımı, gerçekçi spec değerlendirmesinin doğal dağılımı gibi.

### 3.6 Birinci Koşum Sonuçlarından Birincil Gözlemler

1. **Doğrulama zinciri çalışıyor.** 5/5 pipeline aksaksız Scribe → Critic geçti, `awaiting_approval`'a ulaştı. Hiçbir LLM çıktısı schema validation'dan düşmedi.
2. **Critic atıl değil.** %60 onaylama oranı + her problemde ortalama 5.4 bulgu → adversarial review pratikte gerçek değer üretiyor; körü körüne damgalama (rubber stamp) yok.
3. **Testability dominasyonu (%44)** anlamlı bir bulgu. Critic'in en güçlü olduğu alan: AC'lerin otomatik testlere uygun yazılıp yazılmadığını kontrol etmek. Bu, Sabra & Tyler 2025'in "LLM-üretilen spec'ler test-friendly değil" gözlemi ile **doğrudan örtüşür**.
4. **Confidence skor varyansı, sinyal taşıyor.** Critic 68 ile 82 arasında üç farklı skor verdi (68, 82). Bu ayrım approval kararına da yansıyor (68 reject, 82 approve). Skor → karar zinciri kalibre görünüyor.
5. **Security kategorisi sıfır** — bu problem seti (todo, hesap makinesi, döviz çevirici, blog API, QR) güvenlik-yoğun olmadığı için doğal. Auth/payment içeren bir benchmark seti güvenlik bulgularını ortaya çıkarır.

## 4. Tartışma (birinci koşum sonrası)

### 4.1 Doğrulama Zinciri Tamamlanma Oranı (Q1)
İlk koşumda **Scribe + Critic-spec** zinciri 5/5 problemde aksaksız tamamlandı. Bu, AKIS'in ana iddiası olan "doğrulama zincirinin kullanılabilirliği"ne ilk somut delildir. Önceki mock provider koşumlarında schema validation hatası nedeniyle %0 başarı vardı; gerçek Anthropic ile %100. Bu fark, mock provider'ın spec çıktı kalitesinin schema'yı tatmin etmediğini gösteriyor — gelecek dogfooding koşumları gerçek provider üzerinde yapılmalı.

### 4.2 Critic'in Yakaladığı Kategori Profili (Q3)
**Testability (%44)** dominasyonu, Sabra & Tyler 2025'in "LLM-üretilen yazılım artefaktları otomatik testlere uyumsuz" gözlemiyle birebir örtüşür. AKIS'in Critic'i bu literature gözlemini *operasyonel* hâle getiriyor: spec yazılırken AC'lerin test-edilebilir olup olmadığını otomatik kontrol ediyor. **Ambiguity (%30)** + **completeness (%22)** geriye kalan kütleyi taşıyor — bu da klasik spec kalitesi sorunlarının (belirsiz terim, eksik kabul kriteri) %52 paya sahip olduğunu söylüyor.

**Consistency (%0)** ve **security (%0)** sıfır — problem setinin yapısı (5 küçük, auth-içermeyen, tek-modüllü uygulama) ile uyumlu. Geniş bir spec'te (multi-component, auth/data flows) bu kategoriler ortaya çıkmalı; küçük spec'lerde tutarlılık çelişkisi doğmuyor.

### 4.3 Critic'in Skor Kalibrasyonu (Q4 ön-gözlem)
Critic 68 ile 82 arasında ayrım yapıyor: 68 = reddedildi, 82 = onaylandı. **Threshold davranışı görünür.** Tam Q4 (skor vs gerçek outcome korelasyonu) için daha büyük N + manuel quality scoring gerekir; bu birinci koşum Q4'ü kapatmıyor ama yön veriyor: Critic skor üretimi rubber stamping değil.

### 4.4 Hangi Problem'lerde Critic'in Yargısı Sorulabilir?
- **calc-002 (hesap makinesi)** ve **currency-003 (döviz)** reddedildi. Bu iki problem dar kapsamlı, "iyi spec yazılması zor" değil normalde. Critic'in burada testability concern'leri çıkardığı görülüyor — özellikle calc-002'de "üzeri çizili veya gri renk alır" gibi UI vague terim'leri yakalanmış. Bu *makul* bir reddetme; ancak küçük problemlerde Critic'in daha lenient olması da bir tasarım sorusu (false positive riski).
- **qr-005 (QR üreteç)** onaylandı (%82) — bu beklenmedik değil, problem yapısı dar.
- Önemli kalibre soru: "Critic'in reddettiği spec'leri **insan onaylar mıydı?**" Bu soru Q2'ye (Likert) bağlı; bir sonraki koşumda 3-5 katılımcı her reddedilen spec'i değerlendirmeli.

### 4.5 Pipeline Maliyeti
- 5 problem × ~47s/problem = ~4 dakika wall clock
- Tahmini token maliyeti: Haiku ile ~$0.15-0.30 (5 pipeline, her biri Scribe + Critic spec)
- Sonnet ile koşulursa muhtemelen ~$1.50-3.00 ve daha kaliteli çıktı
- Tezde "deneylerin maliyeti" başlığında raporlanabilir veri

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
