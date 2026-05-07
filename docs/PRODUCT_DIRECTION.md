# AKIS — Ürün Yönelimi (2026-05-07)

> **Bu, ürün konumlandırma + öncelik dokümanıdır.** Tez odağı için `docs/THESIS_FOCUS.md`'ye bak — bu o dokümanın ürün-tarafı tamamlayıcısıdır.

## Birincil Persona: "Bakkal" — Yazılım Bilmeyen, Bir İhtiyacı Olan

> *Bakkal, dükkanı için stok takibi uygulaması ister. AI'a söyler, AI bir şey üretir. Ama bakkal ürünü kontrol edemez, hata var mı bilemez, "yarın hâlâ çalışıyor mu" sorusuna cevap veremez. AKIS bakkal'ın yerine "yazılım ekibi" olur.*

### Neden "bakkal/non-developer + quality" yeni bir lane

| Rakip | Hitap ettiği | Çıktı kalitesi | Eksik |
|-------|--------------|---------------|-------|
| Cursor / Copilot / Claude Code | Geliştirici | Yüksek | Bakkal kullanamaz |
| Replit Agent / Bolt / Lovable / v0 | Vibe-coder | Yüzeysel | Test yok, regression yok, "hâlâ çalışıyor mu" cevabı yok |
| Devin (Cognition) | Geliştirici | Yüksek (PR seviyesi) | Bakkal kullanamaz |
| **AKIS** | **Non-developer** | **Test edilmiş, regression-korumalı** | **(boş lane)** |

Bu lane sahibi yok. Vertical-industry değil (sektörel değil), horizontal-developer da değil (geliştirici değil). **Üçüncü, kazanılmamış audience.**

### Tez ile İlişki

Tez tek cümlesi: *"AI çıktısına geliştirici güvenini somut hâle getiren çok-ajanlı doğrulama zinciri."*

Bakkal için bu cümle **dramatik olarak daha doğru** — geliştirici kendisi kontrol edebilir, bakkal edemez. **Trust crisis bakkal'da total**. AKIS'in Level-4 explainability surface'i (v0.7.0) tam olarak bu yarayı adresler.

## Mevcut Durum — Ne Var, Ne Eksik

### ✅ Hazır (v0.7.0)

| Bileşen | Durum |
|---------|-------|
| Scribe — fikir → spec, açıklayıcı sorular | ✅ |
| Critic — adversarial review (spec + kod) | ✅, Türkçe çıktı |
| Insan onay kapısı | ✅ |
| Proto — kod üretimi + GitHub push | ✅ |
| Trace — Playwright e2e | ✅ |
| FixLoop — test fail → düzelt | ✅ |
| Level-4 explainability surface (Akış + Açıklama tab) | ✅ |
| Confidence skorları, attention banner, kategori-bazlı findings | ✅ |

### ❌ Bakkal için Eksik (4 gerçek gap)

1. **Iteration mode UX** — "şunu ekle" akışı çalışıyor ama regression görünürlüğü yok. Bakkal "değişiklik bir yeri bozdu mu" sorusuna cevap göremiyor.
2. **Deploy step** — pipeline GitHub repo verir, bakkal GitHub bilmiyor. Paylaşılabilir public URL gerek.
3. **Onboarding** — Anthropic key, GitHub PAT, model seçimi vb. tech-savvy gerektirir. Bakkal duvar görür. Managed credentials gerek.
4. **Regression confidence surface** — son değişiklik sonrası "24/24 test hâlâ geçiyor" gibi açık güven sinyali yok.

## Çalışma Tier'ları (Öncelik Sırasıyla)

### Tier 1 — Trust Surface for Non-Developer (Tezdeki ana iddianın somutlaşması)
- **A. Regression Confidence surface** — son değişiklikte hangi testler hâlâ geçiyor, hangileri kırıldı, FixLoop ne yaptı. UI surface, mevcut Trace + FixLoop verisini görselleştirme.
- **B. Iteration mode UX polish** — yeni istek geldiğinde AKIS'in mevcut spec'i nasıl anladığı, hangi AC'lerin etkilendiği görünür.
- **C. Output preview** — sandbox/iframe ile bakkal ürünü canlı görür, GitHub linki vermek yerine.

### Tier 2 — Reachability for Non-Developer
- **D. Onboarding simplification** — managed Anthropic (subscription), GitHub OAuth otomatik, model picker "Hızlı/Kaliteli" şeklinde basitleştirme.
- **E. Deploy step** — Vercel/Netlify entegrasyonu, pipeline sonunda public URL.
- **F. Landing repositioning** — "AI yazılım ekibi, yazılım bilmek gerekmez" mesajı.

### Tier 3 — Tez Ampirik Omurga
- **G. Q4 Calibration analizi** — manuel quality scoring + Critic skoru korelasyon. Otonom iş.
- **H. Q2 Self-Pilot v2** — Tier 1 feature'larından sonra yapılır; trust delta ölçümü.
- **I. Q2 katılımcı toplama** — 3-5 kişi, gerçek N için.

### Tier 4 — Ambitious / İddialı
- **J. AST DeterministicValidator** — FORGE'26 metodolojisi, mevcut iskelet üzerine.
- **K. CriticAgent prompt-injection robustness** — security yan-kolu (tezde sadece "future work" paragrafı).

## Karar Kuralı (1.1)

Yeni bir öneri geldiğinde:

```
Tier 1-3'ten birine ait mi?
├── Evet → Yap.
└── Hayır → Tier 4 mü? Yoksa scope dışı mı? Sınırlılıklar bölümüne ekle.
```

`THESIS_FOCUS.md` § 6 karar kuralı (Q1-Q4 filtresi) hâlâ geçerli — **bunu tamamlar, ezmez**: ürün tarafında bakkal hipotezini test eden iyileştirmeler tezde "kalite güveni iddiasının operasyonel kanıtı" olarak yer bulur.

---

*Bu doküman çekirdek persona değişirse güncellenir. İş listesi `benchmark-2026-may.md` ve aktif PR'larda.*
