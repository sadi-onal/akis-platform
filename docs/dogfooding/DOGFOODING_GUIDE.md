# AKIS Dogfooding Guide

## Konsept

AKIS'i kendi gelistirmesinde kullanmak — "eat your own dog food". Platform'un urettigi ciktiyi kendi kod tabaniyla karsilastirarak kaliteyi olcmek ve iyilestirme firsatlarini belirlemek.

## Dogfooding Senaryolari

### Senaryo 1: Login Sayfasi

- **Fikir:** "AKIS icin bir kullanici giris sayfasi olustur. GitHub ve Google OAuth butonlari, e-posta/sifre formu, 'Sifremi unuttum' linki olsun."
- **Adimlar:**
  1. Pipeline'a fikri ver
  2. Scribe spec yazsin
  3. Spec'i incele ve onayla
  4. Proto scaffold uretsin
  5. Trace test yazsin
- **Degerlendirme:** Cikan kodu AKIS frontend'indeki gercek login sayfasiyla (`frontend/src/pages/auth/`) karsilastir. Benzerlik orani, eksik ozellikler ve gereksiz eklentileri not et.

### Senaryo 2: Pipeline Status Component

- **Fikir:** "Bir pipeline'in durumunu gosteren React component olustur. Her stage (Scribe, Proto, Trace) icin progress indicator, sure bilgisi ve hata mesaji gostersin."
- **Adimlar:**
  1. Pipeline'a fikri ver
  2. Scribe spec yazsin, Proto scaffold uretsin, Trace test yazsin
- **Degerlendirme:** Cikan component'i mevcut `frontend/src/components/` altindaki pipeline UI bilesenleriyle karsilastir. State yonetimi, hata gosterimi ve UX kalitesini degerlendir.

### Senaryo 3: API Health Check

- **Fikir:** "Basit bir health check endpoint'i olustur. Sunucu durumu, veritabani baglantisi ve AI servis durumunu JSON olarak dondursun."
- **Adimlar:**
  1. Pipeline'a fikri ver
  2. Sonuclari degerlendir
- **Degerlendirme:** Cikan kodu backend'deki mevcut health endpoint'iyle karsilastir. Route tanimlama, hata yonetimi ve response format kalitesini incele.

## Degerlendirme Kriterleri

Her dogfooding run'i su kriterlerle degerlendirilir:

| # | Kriter | Aciklama | Olcum |
|---|--------|----------|-------|
| 1 | Scribe spec kalitesi | Spec'in fikri ne kadar iyi yapilandirdigi | Confidence score (0-1) |
| 2 | Proto kod kalitesi | Uretilen kodun derlenebilirligi ve calisabilirligi | Derleme basarisi, lint hata sayisi |
| 3 | Trace test kalitesi | Yazilan testlerin anlamliligi ve kapsami | Test sayisi, coverage % |
| 4 | Toplam sure | Pipeline'in bastan sona ne kadar surdugu | Saniye cinsinden toplam sure |
| 5 | Insan mudahalesi | Kullanicinin mudahale etmesi gereken nokta sayisi | Clarification + reject sayisi |

## Metrik Toplama

Dogfooding senaryolari sirasinda `PipelineMetricsService` kullanilarak her stage'in suresi, basari durumu ve agent-spesifik metrikleri otomatik olarak kaydedilir. `getSummary()` metodu ile tum run'larin toplu ozeti alinabilir.

## Sonuc Kaydi

Her dogfooding run'inin sonuclari su formatta kaydedilmelidir:

```
Senaryo: [isim]
Tarih: [tarih]
Pipeline ID: [id]
Scribe Confidence: [skor]
Proto Dosya Sayisi: [n]
Trace Test Sayisi: [n]
Toplam Sure: [ms]
Basari: [evet/hayir]
Notlar: [serbest metin]
```
