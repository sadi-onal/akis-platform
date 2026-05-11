# PDP-2 Yeni Özellikler — Manuel Değerlendirme Planı

**Status:** Plan (uygulama Q4 ile birlikte)
**Hedef:** Q4 rubric Critic skoru kalibrasyonu içinken, PDP-2'de gelen yeni feature'lar (F-08 ScaffoldEnricher, F-09 Chat Q&A, F-10 Intent Classifier) için ayrı bir manuel değerlendirme planı.

---

## Neden ayrı?

Q4 rubric Critic'in spec skorunu kalibre etmek için tasarlandı (tek değerlendirici, gizli skor, 5 spec). Yeni feature'lar farklı boyutlar değerlendiriyor:
- **F-08 (ScaffoldEnricher)** — çıktı kalitesi: install.sh çalışıyor mu? README anlaşılır mı?
- **F-09 (Chat Q&A)** — yanıt kalitesi: soruyla ilgili mi? RAG citations doğru mu?
- **F-10 (Intent Classifier)** — sınıflandırma doğruluğu: BUILD/ASK/FEEDBACK/CHAT ayrımı tutarlı mı?

Farklı bir form / dataset gerekir.

---

## F-08 Scaffold Portability

**Yöntem:** 3 farklı stack (node-pnpm, python-pip, go) için pipeline çalıştır → enriched output indir → bakkal-personası kişi `install.sh` ile çalıştırmaya çalışsın.

**Kriterler (her stack için 0-5):**

| Kriter | 0 | 5 |
|---|---|---|
| `install.sh` ilk denemede başarılı | bash hatası, manuel müdahale | tek komut, hata yok |
| README anlaşılır | tech jargon, bakkal anlamaz | bakkal-language, sırayla |
| `Bu projeyi kendi bilgisayarında çalıştır` adımları yeterli | eksik (port, .env vs.) | tam, kopyala-yapıştır |
| `Sunucuya kur` (Docker varyantı) çalışır | compose hata | `docker compose up -d` → erişilebilir |
| `.env.example` her satır Türkçe yorumlu | İngilizce / yok | bakkal anlaşılır |

**Hedef:** her stack için ortalama ≥ 3.5 → "bakkal taşıyabilir".

**Dataset:** 9 örnek (3 stack × 3 farklı spec).

---

## F-09 Chat Q&A

**Yöntem:** 1 tamamlanmış pipeline + 20 farklı kullanıcı sorusu seti. Her soru için yanıt + citations.

**Kriterler (her cevap için 0-5):**

| Kriter | 0 | 5 |
|---|---|---|
| Sorunun konusuyla ilgili | konu dışı | direkt cevap |
| Citations doğru | yanlış kaynak | spec/proto/findings'den ilgili parça |
| Bakkal-language | jargon | anlaşılır Türkçe |
| `needsBuild` doğru tespit | yanlış flag | doğru flag |
| Streaming akışı doğal | takılma | düz akış |

**Hedef:** Ortalama ≥ 4.

**Dataset:** 20 (5 kategori × 4 soru).

---

## F-10 Intent Classifier

**Yöntem:** 100 örnek mesajdan oluşan etiketli dataset. Her mesaj human-labeled (gold) + classifier prediction.

**Metrikler:**

| Metrik | Hedef |
|---|---|
| Accuracy (4-class) | ≥ %85 |
| Per-class precision (BUILD/ASK/FEEDBACK/CHAT) | ≥ %80 her sınıf |
| Confidence calibration | < 0.7 ambig örneklerle uyumlu |
| Disambiguation tetiklenme oranı | %5-15 arası |

**Dataset:** 100 örnek dengeli (25 per class) + 20 ambig örnek.

---

## Sıralama (PDP-3 dalga başı)

| # | İş | Tahmini efor |
|---|---|---:|
| 1 | F-10 dataset (100 etiketli) | 2 sa kullanıcı |
| 2 | F-10 collection form + aggregator | 1.5 sa AI |
| 3 | F-08 manuel test (9 kombinasyon) | 3 sa kullanıcı |
| 4 | F-09 dataset 20 soru + skorlama | 2 sa kullanıcı |

---

## Bağlantılar

- [`q4-rubric-form.html`](./q4-rubric-form.html) — Critic kalibrasyonu (mevcut)
- [`q2-likert-form.html`](./q2-likert-form.html) — A/B testi (mevcut)
- [`../product/04-quality.md`](../product/04-quality.md) § NFR-5.4
- [`../product/05-findings.md`](../product/05-findings.md) — F-08/F-09/F-10
