# 00 — Tez Genel Hatları (Outline)

**Status:** ✍️ Skeleton — fill with data when available
**Bağımlılık:** yok (kök doküman)
**Sonraki:** [`01-introduction.md`](./01-introduction.md)

---

## 1. Önerilen başlık

**Türkçe (birincil):**

> **AKIS: Yazılım Üretimi için AI Ajan Orkestrasyonu ve Kalite-Güveni Doğrulama Zinciri**

**Alternatifler (advisor tartışmasında değerlendirilecek):**

1. AKIS: Çok-Ajanlı Doğrulama Zinciri ile AI-Üretimi Yazılım Çıktılarına Kalite Güveni
2. AKIS: Bakkal-Persona için Açıklanabilir Çok-Ajanlı AI Yazılım Üretim Platformu
3. Kalite-Güveni Mimarisi: AKIS Platformu Örneği ve Empirik Değerlendirme

**English subtitle (abstract için):**

> *AKIS: A Multi-Agent Verification Chain for Quality Trust in AI-Generated Software*

---

## 2. Abstract şablonu (≈200 kelime, son sürümde doldurulacak)

> **[Türkçe abstract — ~200 kelime]**
>
> Büyük dil modelleri (LLM) yazılım üretiminde yaygınlaşırken, üretilen çıktının
> kalitesine güven açığı kritik bir engele dönüşmüştür. [CITE-METR2025] %19'luk
> beklenmedik yavaşlamayı, [CITE-Sabra2025] sistemik kalite sorunlarını,
> [CITE-Sonar2026] %96 oranında "AI koduna tam güvenmeme" tutumunu raporlar.
> Mevcut araçlar (Cursor, Devin, Bolt) bu açığı geliştirici ihtiyacı üzerinden
> ele alır; yazılım bilmeyen kullanıcı (*bakkal persona*) için çözüm yoktur.
>
> Bu çalışma **AKIS** adlı çok-ajanlı yazılım üretim platformunu sunar. AKIS
> Scribe → Critic → Proto → Trace ardışıklığında her aşamayı bağımsız bir
> ajan ile sürdürür ve aşamalar arası adversarial review + insan onay kapısı
> ile **kalite-güveni doğrulama zinciri** oluşturur. Açıklanabilirlik yüzeyi
> her ajan kararını gerekçelendirir.
>
> Empirik değerlendirme dört araştırma sorusu etrafında yürütülmüştür: (Q1)
> zincirin tamamlanma oranı [Q1-DATA], (Q2) açıklanabilirliğin güven üzerindeki
> etkisi [Q2-DATA], (Q3) Critic adversarial review'un yakaladığı kategoriler
> [Q3-DATA], (Q4) confidence skor kalibrasyonu [Q4-DATA]. PDP-2 dalgası
> sonrasında AKIS [PDP2-METRICS] sayısal iyileşme sağlamıştır.
>
> Sonuç: doğrulama zinciri mimarisi bakkal-personası için **operasyonel
> olarak çalışmakta**, güven sinyallerini görselleştirerek AI-üretimi
> çıktının izini somut hâle getirmektedir.

---

## 3. Anahtar kelimeler

**Türkçe:** yapay zekâ ajanları, ajan orkestrasyonu, yazılım kalitesi,
açıklanabilir yapay zekâ (XAI), doğrulama zinciri, adversarial review,
bakkal-personası, kalite güveni

**English:** AI agents, agent orchestration, software quality, explainable AI
(XAI), verification chain, adversarial review, non-developer persona, quality trust

---

## 4. Bölüm planı (7 ana + 1 conclusion)

| # | Bölüm | 1-cümle özet | Tahmini sayfa |
|---|---|---|---|
| 1 | **Giriş** | Problem (AI güven açığı + bakkal-personası) + tez tezi + Q1-Q4 + katkı + tez yapısı | 8-12 |
| 2 | **Literatür Taraması** | AI ajan orkestrasyonu, yazılım kalitesi/test, non-developer AI araçlar, AKIS'in lane'i | 10-15 |
| 3 | **Mimari** | AKIS sistem mimarisi: pipeline orchestrator, verification chain, persistence, intent/chat-qa, scaffold portability | 15-20 |
| 4 | **Deneysel Çalışma** | Q1-Q4 yöntemleri + PDP-2 dalgası ölçüm protokolü + benchmark seti | 10-12 |
| 5 | **Bulgular** | Q1-Q4 sonuçları + PDP-2 metrikleri + bakkal-language audit | 12-15 |
| 6 | **Tartışma** | Tez core iddiası kanıt değerlendirmesi + sınırlılıklar + ileriki çalışmalar | 6-8 |
| 7 | **Sonuç** | Ana bulgular + tez katkıları + bakkal vizyonu | 2-3 |
| Ek | Ekler | Benchmark seti detayı, form ekran görüntüleri, PDP-2 PR listesi, kod parçacıkları | 8-12 |
| | **Toplam (tahmini)** | | **71-97 sayfa** |

> **Hedef:** ≈ 70-80 sayfa main body; ekler ile 90 civarı. FSMVÜ lisans tezi için makul.

---

## 5. Q1-Q4 araştırma soruları (özet — detay 01 § 1.3)

| ID | Soru | Yöntem | Veri durumu |
|---|---|---|---|
| **Q1** | AKIS'in doğrulama zinciri ardışıklığı küçük gerçek problem seti üzerinde uçtan uca tamamlanabilir mi? | 5 benchmark problemi, 1 koşum/problem, completion + duration + confidence + finding kaydı | ✅ baseline koşum mevcut |
| **Q2** | Açıklanabilirlik yüzeyi (PipelineCinema + ExplanationPanel) kullanıcı güvenini değiştiriyor mu? | A/B Likert testi, 5 problem × 2 konfigürasyon × 3-5 katılımcı | 🟡 form hazır, Q2v2 koşumu var, katılımcı toplama açık |
| **Q3** | Critic adversarial review hangi kategori bulguları yakalıyor? | Aynı baseline koşumdan finding aggregation (kategori × severity) | ✅ 27 finding analiz edilmiş |
| **Q4** | Critic confidence skoru manuel rubric ile kalibre mi? | 5 spec, 6-kriterli manuel rubric, Pearson r | 🟡 form + aggregator hazır, kullanıcı manuel skor bekliyor |

> Q1+Q3 birincil tezi taşır; Q2 + Q4 *bonus chapter* statüsünde (THESIS_FOCUS § 3).

---

## 6. Tezin katkıları (claim'ler)

1. **Mimari katkı:** AKIS adında Scribe → Critic → Proto → Trace + FixLoop çok-ajanlı doğrulama zinciri tasarlanmış ve uygulanmıştır.
2. **Empirik katkı:** Q1-Q4 deneyleri ile çok-ajanlı doğrulama zincirinin küçük gerçek problemler üzerinde uçtan uca işlevsel olduğu gösterilmiştir.
3. **UX/persona katkısı:** Yazılım bilmeyen kullanıcı (*bakkal persona*) hedefli açıklanabilirlik yüzeyi (PipelineCinema + ExplanationPanel) tanıtılmış ve kullanıcı güveni üzerindeki etkisi A/B testi ile değerlendirilmiştir.
4. **Pratik katkı:** PDP (Product Discovery & Design) süreci ve PDP-2 dalgasının sonuçları (15 PR, in-memory volatility çözümü, intent classifier, chat-qa, scaffold portability) lisans tezi sürelerinde ürün-yönetim disiplinli geliştirmenin uygulanabilirliğini göstermiştir.
5. **Açık kaynak çıktı:** AKIS Platform [`github.com/OmerYasirOnal/akis-platform`](https://github.com/OmerYasirOnal/akis-platform) açık kaynak olarak yayınlanmıştır; yeniden üretilebilirlik için benchmark seti + Q2/Q4 formları + Q1+Q3 baseline JSON paylaşılır.

---

## 7. Sunum / savunma materyali

| Materyal | Format | Hedef |
|---|---|---|
| Tez dokümanı | LaTeX → PDF (FSMVÜ şablonu) | Defense öncesi advisor onayı |
| Defense slide deck | Keynote / Slides (15-20 slide) | 15 dakika sunum + 10 dk Q&A |
| Demo video | Screencast ~3 dakika | Mehmet (veresiye defteri) end-to-end pipeline |
| Live demo (opsiyonel) | AKIS dev env, projeksiyon | "Soru sorulduğunda" canlı koşum |
| Poster | A1, akademik poster | (FSMVÜ poster sergisi olursa) |
| GitHub README/CHANGELOG | Markdown | Repo'da güncel; tez ekindeki PR listesi |

---

## 8. Tezin yapısı (1-paragraf, giriş § 1.5'te yer alacak)

> Bölüm 1 problemi ve tezin amacını tanımlar. Bölüm 2 ilgili literatürü
> tarayarak AKIS'in konumlandığı boş lane'i kanıtlar. Bölüm 3 sistem
> mimarisini açıklar; doğrulama zinciri, persistence, intent classifier
> ve scaffold portability komponentlerini detaylandırır. Bölüm 4 Q1-Q4
> araştırma sorularına yönelik deney protokollerini ortaya koyar. Bölüm 5
> bulguları sunar. Bölüm 6 bulguları tezin core iddiası ekseninde
> değerlendirir ve sınırlılıkları açıklar. Bölüm 7 ana sonuçları ve
> ileriki çalışmaları özetler.

---

## 9. Kabul kriterleri (bu doc için)

- [ ] Önerilen başlık advisor tarafından onaylandı
- [ ] 7-bölüm planı toplam sayfa hedefiyle uyumlu (≤ 100)
- [ ] Q1-Q4 listesi `docs/THESIS_FOCUS.md` § 3 ile özdeş
- [ ] Anahtar kelimeler hem TR hem EN tarafından doğru (literatür arama için)
- [ ] Sunum/savunma materyali listesi defense gününe kadar yapılabilir efor

---

## 10. Sonraki adım

[`01-introduction.md`](./01-introduction.md) — problem tanımı + tezin amacı + Q1-Q4 + katkı + tez yapısı detaylı yazımı.
