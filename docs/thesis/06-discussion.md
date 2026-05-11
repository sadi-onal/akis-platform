# 06 — Tartışma

**Status:** ✍️ Skeleton — fill with data when available
**Bağımlılık:** [`05-results.md`](./05-results.md)
**Tahmini sayfa:** 6-8

> **Bölümün amacı:** Bölüm 5 bulgularını **tezin core iddiası** ekseninde değerlendirmek; sınırlılıkları açıkça ortaya koymak; ileriki çalışmaları tanımlamak.

---

## 6.1 Tezin core iddiası — kanıt değerlendirmesi

> **Yazım hedefi (2-3 sayfa):** "AKIS, AI çıktısına geliştirici güvenini somut hâle getiren çok-ajanlı doğrulama zinciridir" cümlesi için Q1-Q4 + PDP-2 verisinin sentezi.

### 6.1.1 İddianın yapısal kanıtı (Bölüm 3 + 5.5)

> **Önerme:** AKIS'in çok-ajanlı doğrulama zinciri (Scribe → Critic → İnsan Onayı → Proto → Critic → Trace + FixLoop) çalışan bir sistem olarak tasarlanmış ve uygulanmıştır.

**Kanıt:**
- 15 PR'lık PDP-2 dalgası ile *operasyonel olarak çalışır* hâle getirildi (Bölüm 5.5).
- NFR-1 persistence ile zincirin görsel kanıtı kalıcı (NFR-1.1 = %100 recovery).
- Intent classifier + chat-qa ile bakkal'ın pipeline-dışı sorgulara erişimi sağlandı (FR-10/11).
- Scaffold portability ile bakkal çıktıyı kendi bilgisayarında çalıştırabilir hâle geldi (FR-6.5..6.8).

> **Sonuç:** AKIS bir demo değil, kullanıcının uzun süreli güvenebileceği bir sistemdir.

### 6.1.2 İddianın işlevsel kanıtı (Q1)

> **Önerme:** Doğrulama zinciri küçük gerçek problemler üzerinde uçtan uca işlevseldir.

**Kanıt:**
- 5/5 pipeline `awaiting_approval`'a aksaksız ulaştı (Bölüm 5.1).
- Hiçbir LLM çıktısı schema validation'dan düşmedi.
- Önceki mock provider koşumlarında schema validation hatası nedeniyle %0 başarı vardı; gerçek Anthropic ile %100. Bu fark mock provider'ın spec çıktı kalitesinin schema'yı tatmin etmediğini gösteriyor — *future work*: tüm benchmark koşumları gerçek provider üzerinde yapılmalı.

> **Sonuç:** Doğrulama zinciri *operasyonel olarak çalışıyor*.

### 6.1.3 İddianın değer kanıtı (Q3)

> **Önerme:** Critic adversarial review *atıl değil* — gerçek değer üretir, rubber-stamp yapmaz.

**Kanıt (Bölüm 5.3):**
- %60 onaylama oranı (3/5) — Critic körü körüne onaylamıyor.
- Ortalama 5.4 finding/problem.
- Testability dominasyonu (%44) [CITE-Sabra2025] gözlemiyle birebir örtüşür: **AKIS bu literature gözlemini operasyonel hâle getiriyor.**
- Kritik = 0 → ne aşırı uyarıcı ne aşırı uysal; major + minor karışımı gerçekçi.
- Skor varyansı (Scribe 88-92 dar bant, Critic 68-82 geniş bant) → Critic farklı kalitedeki spec'leri farklı puanlıyor.

> **Sonuç:** Critic gerçek sinyal taşıyor; doğrulama zincirinin orta nokta düğümü işlevsel.

### 6.1.4 İddianın güven kanıtı (Q2)

> **Önerme:** Açıklanabilirlik yüzeyi kullanıcı güvenini artırır.

**Kanıt (Bölüm 5.2 — [Q2-DATA] geldiğinde):**
- Likert score B (explainable) > A (baseline) hipotezi: [Q2-DATA].
- Qualitative gözlemler: katılımcılar "Açıklama tab'ı olmadan ne onayladığımı bilmiyordum" benzeri açık ifadeler.

> [Q2-DATA] geldiğinde — sonuç: açıklanabilirlik yüzeyi güveni *anlamlı ölçüde artırıyor / kısmi artırıyor / fark gözlenmiyor* (üç senaryo şablonu).

### 6.1.5 İddianın kalibrasyon kanıtı (Q4)

> **Önerme:** Critic confidence skoru kalibre — sinyal taşıyor.

**Kanıt (Bölüm 5.4 — [Q4-DATA] geldiğinde):**
- Pearson r [Q4-DATA].
- Bölüm 4.4.4 yorum tablosundan ilgili satır (≥ 0.7 / 0.4-0.7 / 0.2-0.4 / < 0.2).

> [Q4-DATA] geldiğinde — sonuç: kalibrasyon yorum şablonu.

### 6.1.6 PDP-2 süreç katkısı

> **Önerme:** Disiplinli ön-tasarım (PDP) süreci AI-asisted geliştirme hızında uygulanabilir.

**Kanıt (Bölüm 5.5):**
- 15 PR / 4 wave / 2 gün takvim süresi.
- Spec-first disiplin verimi 5×'lik sıkıştırdı.
- Her FR/NFR ID test'lere ve dokümantasyona izlenebilir.

> **Sonuç:** PDP süreci lisans tezi süresinde uygulanabilir; sonuçlar ölçülebilir.

---

## 6.2 Sınırlılıklar

> **Yazım hedefi (1-2 sayfa):** Açıkça konulan sınırlılıklar — small-N, single-language, single-bakkal, vb.

### 6.2.1 Empirik sınırlılıklar

| Sınırlılık | Etki | Hedge |
|---|---|---|
| **N=5 problem** | Q1+Q3 gözlemsel, istatistiksel test yok | Sonuçlar "small-N exploratory" çerçevesinde sunulur |
| **N=3-5 katılımcı (Q2)** | Likert istatistiksel anlamlılık yok | Yorum gözlemsel; qualitative alıntılar destekler |
| **N=5 spec çifti (Q4)** | Pearson r yön gösterir, anlamlılık testi yok | "small-N illustrative correlation" net açıklanır |
| **Tek baseline koşumu** | LLM stochasticity test-retest fark yaratabilir | Future work: 3-koşum ortalama |
| **Self-experiment bias** | Katılımcılar AKIS'i bilen aynı çevreden | Future work: dış katılımcı (gerçek bakkal personası) |
| **Mock provider riski** | Mock çıktıları gerçek modelden kalitatif farklı | Q1 gerçek Anthropic ile yapıldı; future Q2v3 da gerçek provider |

### 6.2.2 Mimari sınırlılıklar

| Sınırlılık | Etki | Hedge |
|---|---|---|
| **Single-language (TS/Node)** | Scaffold portability 8 stack destekler ama JS/TS ekosisteminde | Future work: Python/Go/Rust/Ruby + .NET stack ekleme |
| **Single-bakkal persona** | Mehmet (veresiye defteri) reprezentatif değil | Future work: 3 farklı persona × 3 farklı use case |
| **CriticAgent prompt-injection robustness sınanmadı** | Security yan-kolu açık | Future work: § 6.3 |
| **AST DeterministicValidator prototip** | FORGE'26 metodolojisi tam değil | Future work: § 6.3 |
| **Persistent Learning yok** | DSPy + pgvector RAG sadece kısmi | Future work: § 6.3 |
| **Production dormant** | Multi-user / load testi yapılmadı | Tezin scope dışı |

### 6.2.3 UX sınırlılıklar

| Sınırlılık | Etki | Hedge |
|---|---|---|
| **NFR-5.4 5-dakika oturumu henüz yapılmadı** | Gerçek bakkal kullanıcı testi yok | Future work: Q2 v2 self-pilot + dış katılımcı |
| **Mobil/responsive sınanmadı** | Bakkal telefonda kullanır mı? | Future work |
| **Tek dil (Türkçe + İngilizce)** | i18n var ama diğer diller yok | Future work |
| **Bakkal-language audit %95 değil %100 değil** | 33 warn + 102 info kalan | PDP-3 yokum gelirse |

### 6.2.4 Süreç sınırlılıkları

- **Tek geliştirici (yazar) + AI-asisted** — takım çalışması ölçeklenebilirliği test edilmedi.
- **Lisans tezi süresi (≈ 6 hafta)** — uzun-vadeli ürün gelişimi sınanmadı.
- **Token bütçesi sınırlı** — Sonnet/Opus ile koşum sınırlı; Haiku yeterli oldu.

---

## 6.3 İleriki çalışmalar (future work)

> **Yazım hedefi (1.5-2 sayfa):** Tezin scope dışında kalan ama ilgili olan iş listesi.

### 6.3.1 Empirik genişleme

1. **N=20+ katılımcılı Q2 yeniden koşumu** — gerçek istatistik test imkanı. Online crowdsourcing veya FSMVÜ öğrenci havuzu kullanımı.
2. **Problem seti genişletmesi** — 5 küçük problem → 10 orta-zorluk (full-stack auth, file upload, real-time chat, multi-tenant data, payment integration).
3. **Test-retest kalibrasyon** — aynı spec 3 kez koşulup Critic skoru varyansı ölçülür (LLM stochasticity quantification).
4. **Q4 N=20+ rubric çalışması** — yön/büyüklük tespitinden istatistiksel güce geçiş.
5. **Gerçek bakkal-persona testi** — yazılım bilmeyen dış katılımcı, 5-dakika oturum (NFR-5.4).
6. **Karşılaştırmalı çalışma** — AKIS vs Bolt vs Replit Agent vs v0 — aynı 5 problem, kullanıcı tercih + kalite skoru.

### 6.3.2 Mimari genişleme

1. **AST DeterministicValidator** (FORGE'26 metodolojisi tam implementasyon) — %100 precision / %87.6 recall hedefi. Backend test gate olarak entegrasyon.
2. **CriticAgent prompt-injection sertleştirilmesi** — `spawn-hijack` saldırı vektörleri 2025-26 literatüründe %58-90 başarı oranıyla raporlanıyor. Defense-in-depth: rate limit + content filter + adversarial fine-tune.
3. **Persistent Learning (pgvector + DSPy)** — geçmiş spec'lerden öğrenen Critic. Aynı tip findings tekrarlayan kullanıcı için Scribe'ın self-correction.
4. **Multi-language scaffold** — Python, Go, Rust, Ruby, .NET stack desteği.
5. **Multi-persona** — bakkal + esnaf + öğrenci + araştırmacı persona şablonları; UI dilini persona'ya göre adapte.
6. **Vertical SaaS pivot** — sektörel (restoran, kuaför, kafe) için pre-built template'ler. Akademik tez konusu değil ama ürün roadmap'inde.

### 6.3.3 UX genişleme

1. **Mobil-first responsive review** — bakkal telefonda kullanır.
2. **Deploy step** — Vercel/Netlify entegrasyonu, pipeline sonunda public URL.
3. **Onboarding simplification** — managed Anthropic + GitHub OAuth + "Hızlı/Kaliteli" model picker.
4. **Output preview** — sandbox/iframe ile bakkal ürünü canlı görür.
5. **Voice input** — bakkal sesli fikir verir, transcribe → spec.

### 6.3.4 Süreç genişleme

1. **Çoklu-geliştirici takım** — AKIS bir takımda kullanıldığında PDP süreci nasıl ölçeklenir?
2. **Production hardening** — multi-user, load testing, observability, alerting.
3. **CI/CD entegrasyonu** — AKIS-üretimi repo'ya AKIS-üretimi GitHub Actions pipeline (recursive).

---

## 6.4 Tartışma özeti

> **Yazım hedefi (0.5 sayfa):** Bölüm 6'nın iki paragraflık sentezi.

> AKIS bu tezin core iddiası olan "AI çıktısına geliştirici güvenini somut hâle getiren çok-ajanlı doğrulama zinciri"ni hem mimari (Bölüm 3) hem empirik (Q1-Q4) hem süreç (PDP-2) düzeylerinde kanıtlamıştır. Doğrulama zinciri 5/5 küçük problemde çalıştı; Critic adversarial review rubber-stamp değil ve sinyal taşıyor; persistence + intent classifier + chat-qa + scaffold portability ile bakkal-persona için operasyonel bir ürün konumuna geldi. [Q2-DATA: açıklanabilirlik güveni anlamlı/kısmen/değişmez biçimde etkiledi]; [Q4-DATA: Pearson r ... ile Critic skor kalibrasyonu güçlü/orta/zayıf].

> Bununla birlikte, N=5 problem ve N=3-5 katılımcı seviyesindeki ölçümler **gözlemsel** çerçevede okunmalıdır; bir lisans tezi olarak istatistiksel anlamlılık testi yapılmadı. Self-experiment bias, single-language scope, ve gerçek bakkal-persona dış katılımcı yokluğu açık sınırlılıklardır. İleriki çalışmalar büyük-N ampirik, AST validator, persistent learning, multi-persona ve multi-language eksenlerinde tezi genişletecektir.

---

## Kabul kriterleri (bu doc için)

- [ ] 6.1 → Her Q için iddia + kanıt + sonuç şablonu
- [ ] 6.2 → Empirik + mimari + UX + süreç sınırlılıkları açıkça konulmuş
- [ ] 6.3 → Empirik + mimari + UX + süreç future work
- [ ] 6.4 → 2-paragraflık sentez

## Placeholder'lar (grep edilebilir)

- `[Q2-DATA]`, `[Q4-DATA]`
