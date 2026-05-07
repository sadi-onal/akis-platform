# AKIS Tezi — Odak ve Öncelik

> **Bu doküman tek görevi olan kısa bir kontrol listesidir: "Tezde ne yapıyoruz, ne yapmıyoruz?"**
> 60 saniyede okunmalı. Yeni iş başlamadan önce buraya bakılır. Dışına çıkan tüm öneriler "future work" diye etiketlenir.

**Sürüm:** 1.1 · **Son güncelleme:** 2026-05-07 (akşam) · **Durum:** v0.7.0 main'de + feat/benchmark-critic-effectiveness branch açık

## Değişiklik Notu (1.1)
- **Zaman buffer'ı:** Kalan ~15 gün buffer — AI-asisted dev hızıyla "büyük değişiklik yapma" uyarısı geri çekildi.
- **Birincil persona netleştirildi:** Yazılım bilmeyenler (bakkal, esnaf, küçük işletme) — bkz. `docs/PRODUCT_DIRECTION.md`. Geliştiriciler ikincil.
- **Q2 self-pilot zamanlaması:** v2 yeni feature eklemeden önce yapılmaz; UI bug'ları v1'de zaten yakalandı, v2'nin asıl katma değeri *feature trust delta* ölçümüdür.

---

## 1. Tezin Tek Cümlelik Çekirdeği

> **AKIS, AI tarafından üretilen yazılım çıktılarına geliştirici güvenini somut hâle getiren çok-ajanlı bir doğrulama zinciridir.**

Anahtar kelime: **kalite güveni** (quality trust). **Güvenlik (security) değil.** Saldırı dayanıklılığı değil, *kullanıcının çıktıya güvenebilme yeteneği*.

---

## 2. Çalışan Mekanizma (v0.7.0'da Mevcut)

```
Fikir → Scribe → Critic (spec review) → 👤 İnsan Onayı → Proto → Critic (code review) → Trace → FixLoop
                          │                                       │
                          └──────────── ExplainabilityService ────┘
                                       (Level-4 surface)
```

- Her ajan kararı `AgentReasoning` üretiyor: decision + reasoning[] + assumptions + confidence{score, factors} + risks
- `GET /api/pipelines/:id/explanation` rotası bunları dışarı veriyor
- Frontend `PipelineDetailRail` (Akış + Açıklama tab) bunları kullanıcıya gösteriyor
- Real-data kanıtı: `docs/dogfooding/screenshots/inspect-2026-05-07*` — Critic 8 spesifik finding raporladı, kullanıcı UI'da gördü

**Bu çalışıyor.** Yeniden inşa etmiyoruz.

---

## 3. Tez Soruları (Bulgular Bölümü Şablonu)

Bunlara ampirik cevap üretmek **birincil iş**. Sıralama önemli:

### Q1 — Doğrulama zinciri çalışıyor mu?
- 5 sabit problem üzerinde uçtan uca koşum
- Her aşamada confidence skoru, attention point sayısı, completion rate
- **Çıktı:** tablo (problem × stage × outcome × duration × score)

### Q2 — Açıklanabilirlik geliştirici güvenini değiştiriyor mu?
- A/B koşumu: Level-4 surface ON vs OFF (sayfa entegrasyonu kapatılarak)
- 3-5 katılımcı (yazar + bitirme arkadaşları), Likert ölçeği:
  - "Bu çıktıya güvenebileceğimi hissediyorum" (1-5)
  - "Eğer bir hata olsaydı, açıklamadan/akıştan onu fark edebilirdim" (1-5)
  - "Bu pipeline'ın benim için yararlı olacağını düşünüyorum" (1-5)
- **Çıktı:** Likert dağılımı + qualitative gözlemler

### Q3 — Adversarial review (Critic) ne yakalıyor?
- Critic findings'in kategorik dağılımı (completeness, ambiguity, consistency, testability, spec_compliance, security)
- Her benchmark koşumunda otomatik toplanır
- **Çıktı:** kategori frekans tablosu + örnek finding alıntıları

### Q4 — Confidence skorları kalibre mi?
- Critic 68% verdiğinde gerçekten %32 kötü mü? Scribe 90% verdiğinde gerçekten %90 iyi mi?
- Confidence vs gerçek outcome (pipeline tamamlanma, manuel kalite skoru) korelasyonu
- **Çıktı:** scatter plot + Pearson r

> Q4 *iddialı* ama çok değerli. Vakit kalırsa bonus chapter — yoksa Q1+Q2+Q3 tezi taşır.

---

## 4. Kapsam Dışı (Future Work / Tezde Tek Paragraf)

Bunlar AKIS için ilginç ama **bu tezin merkezi değil**. Sadece "Sınırlılıklar / Gelecek İş" bölümünde adı geçer:

- **CriticAgent prompt-injection robustness** — security yan-kolu, kalite ekseni dışı
- **AST DeterministicValidator** (FORGE'26) — eksiksiz hâline getirmek değerli ama Q1-Q4'ten sonra gelir
- **Persistent Learning** (pgvector + DSPy) — vizyon Horizon 3'ten, bu tezin değil
- **Vertical SaaS pivot** — ticari öneri, akademik tez konusu değil
- **Mobile/responsive review** — UI polish, tezde bahsedilmez

---

## 5. Aktif Çalışma Sırası (1.1)

Q1 + Q3 birinci koşumu **tamamlandı** (PR #507'de merged-not-yet, gerçek Haiku verisi `results-baseline-*.json`'da). Sıradaki birincil iş paralel iki şerit:

### Şerit A — Bakkal-direction ürün surface (Tier 1)
1. **Regression Confidence surface** — son değişiklik sonrası "X/Y test hâlâ geçiyor" güven sinyali, mevcut Trace+FixLoop verisini görselleştirir
2. **Iteration mode UX polish** — yeni istek geldiğinde hangi AC'ler etkilendi görünür
3. (Tier 2'den seçim) Output preview, deploy step, onboarding

### Şerit B — Tez ampirik
4. **Q4 Calibration analizi** — manuel quality scoring + Critic skoru korelasyon. Otonom, paralel session'da yürür
5. **Q2 Self-Pilot v2** — Şerit A'dan en az bir feature eklendikten SONRA. Trust delta ölçümü
6. **Q2 katılımcı** — 3-5 kişi (sosyal koordinasyon işi)

İş listesinin operasyonel detayı: `docs/PRODUCT_DIRECTION.md` § Tier'lar.

---

## 6. Karar Kuralı

**Yeni bir öneri geldiğinde** (kendi sezgimden, danışmandan, marketten, literatürden):

```
İlgili soru Q1-Q4'ten birine cevap veriyor mu?
├── Evet → Yap.
└── Hayır → Future work etiketle, geçme.
```

Eğer "kalite güveni" cümlesinde yer açıkça oluşmuyorsa **scope dışıdır**.

---

*Bu doküman donar — sadece çekirdek değişirse güncellenir. Yeni iş listesi değildir; iş listesi `docs/learnings/benchmark-2026-may.md`'de.*
