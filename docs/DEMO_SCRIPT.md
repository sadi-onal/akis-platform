# AKIS Platform — Tez Savunma Demo Senaryosu

## Genel Bilgiler

| Alan | Detay |
|------|-------|
| **Ogrenci** | Omer Yasir Onal (2221221562) |
| **Danismanl** | Dr. Ogr. Uyesi Nazli Dogan |
| **Universite** | Fatih Sultan Mehmet Vakif Universitesi — Bilgisayar Muhendisligi |
| **Tez Temasi** | Knowledge Integrity & Agent Verification |
| **Platform URL** | https://akisflow.com |
| **Kaynak Kod** | `OmerYasirOnal/akis-platform-devolopment` (private) |

---

## Demo Akisi (Tahmini: 8-10 dakika)

### 1. Giris ve Platform Tanitimi (30 saniye)

**Goster:** Landing page (`akisflow.com`) — karanlik temada acilmis halde

**Anlat:**
> "AKIS, kullanicinin dogal dilde anlattigi bir yazilim fikrini otomatik olarak calisan bir projeye donusturen AI tabanli bir platformdur. Uc AI agenti zincirleme calisir:
> - **Scribe** fikri yapilandirir ve analiz eder,
> - **Proto** onaylanan spesifikasyondan calisir kod uretir,
> - **Trace** uretilen kodu dogrudan GitHub'dan okuyarak test yazar.
>
> Tezin temel temasi **Knowledge Integrity** — yani her agentin ciktisinin farkli bir mekanizma ile dogrulanmasidir."

**Vurgulanacak:** Landing page'deki uc adimli akis gorseli (Fikrinizi Anlatin → Otomatik Prototipleme → Otomatik Test)

---

### 2. Tema Degisimi (15 saniye)

**Yap:** Sag ust kosedeki header'da bulunan tema toggle ikonuna tikla (ay/gunes ikonu)

**Goster:** Karanlik tema → aydinlik tema gecisini canli olarak goster, ardindan tekrar karanlik temaya don

**Anlat:**
> "Platform hem karanlik hem aydinlik temayi destekliyor. Tum bilesenler CSS degiskenleri uzerinden tema duyarli olarak tasarlandi. Tarayici tercihi otomatik algilaniyor."

---

### 3. Yeni Proje Fikri Girisi (1 dakika)

**Yap:**
1. Giris yap (veya onceden giris yapilmis halde `/chat` sayfasina git)
2. Sol sidebarda "+ Yeni Is Akisi" butonuna tikla
3. Asagidaki ornek fikri mesaj alanina yaz:

> _"React ve Node.js ile basit bir todo uygulamasi istiyorum. Kullanicilar gorev ekleyebilmeli, tamamlayabilmeli ve silebilmeli. PostgreSQL veritabani kullanilsin."_

4. Gonder butonuna tikla

**Goster:**
- Scribe agentinin SSE uzerinden canli olarak "analiz ediliyor..." mesajini gostermesi
- Clarification (netlestirme) sorularinin gelmesi — her soru bir oncelik seviyesiyle gelir
- Her sorunun altinda **suggestion badge'leri** — tiklanabilir hazir yanit onerileri

**Yap:** Suggestion badge'lerinden birine tikla — otomatik olarak mesaj gonderilir, kullanicinin yazmasi gerekmez

**Anlat:**
> "Scribe burada **self-interrogation** yapiyor. MVP kapsamini daraltmak ve belirsizlikleri gidermek icin kullaniciya onceliklendirilmis sorular soruyor. Hazir oneri badge'leri tek tikla gonderim sagliyor."

---

### 4. Spec Inceleme ve Onay (1 dakika)

**Goster:** Scribe'in olusturdugu **PlanCard** bileseni:
- Proje adi ve ozet bilgi
- **Ozellikler** listesi (numaralandirilmis, her biri ad + aciklama)
- **Teknik Secimler** (React, Node.js, PostgreSQL vb.)
- **Tahmini Dosya Sayisi**
- Test gereksinimi gostergesi ("Trace testleri yazacak")

**Anlat:**
> "Scribe'in olusturdugu yapilandirilmis spesifikasyon burada gorulur. Kullanici butun detaylari inceleyebilir. Bu adim **human-in-the-loop** dogrulamanin cekirdegi — hicbir agent, insan onayi almadan bir sonraki asamaya gecemez."

**Yap:** "Onayla" butonuna tikla

**Anlat:**
> "Onayla butonuyla kullanici spec'i kabul etti. Simdi Proto agenti devreye giriyor."

**Goster (opsiyonel):** Sag ust kosedeki **model secici pill** (`claude-sonnet-4-6 v`)

**Anlat:**
> "Kullanici sohbet basina AI modelini secebilir: Haiku (hizli/ucuz), Sonnet (varsayilan, dengeli), Opus (karmasik is). Secim pipeline boyunca kalici — DB'de `pipelines.model` kolonunda tutulur. Token kapasitesi modele gore otomatik ayarlanir (Claude: 200k, GPT-4.1: 1M)."

---

### 5. Kod Uretimi — Proto Asamasi (1 dakika)

**Goster:** Sag ust kosedeki **token kapasitesi pilli** — `8.9k / 200.0k · %4.46`

**Anlat:**
> "Saga ust kosedeki pill baglam penceresinin ne kadarinin doldugunu canli gosterir; hover tooltip'te Giris/Cikis/toplam token ve asama basina dokum var. Esik asilirsa (80%+) renk degisir, kullaniciyi uyarir."

**Goster:**
- Proto calisirken **SSE ile gercek zamanli dosya olusturma olaylari** — dosyalar birer birer listeleniyor
- **FloatingActivityToast** bileseni — sag alt kosede canli ilerleme gostergesi (ilerleme cubugu + agent etiketi)
- Dosya listesinin Proto badge'leri ile isaretlenmesi

**Anlat:**
> "Proto, onaylanan spec'e sadik kalarak dosya yapisini planliyor, kodu uretiyor ve otomatik olarak GitHub'a push ediyor. Her dosya olusturulurken SSE uzerinden gercek zamanli bildirim geliyor — ekranda dosyalarin birer birer belirdigini goruyorsunuz."

**Goster:** Proto tamamlandiginda:
- Toplam dosya sayisi ve satir sayisi
- Branch adi (`proto/scaffold-{timestamp}`)
- GitHub repository linki
- PR (Pull Request) badge'i (varsa)

---

### 6. Test Uretimi — Trace Asamasi (1.5 dakika)

**Goster:**
- Trace calisirken ilerleme gostergesi
- Trace sonuclari geldiginde:
  - **Test sayilari:** toplam / gecen / kalan
  - **Kapsam yuzdesi**
  - **Test dosyalari listesi** (TRACE badge'li, detayli gorunum)

**Onemli — Kabul Kriteri Kapsam Matrisi:**

**Goster:** `traceability` matrisi — her kabul kriterinin hangi test dosyasi ve test fonksiyonu tarafindan karsilandigini gosteren tablo:

| Kriter ID | Test Dosyasi | Test Adi | Kapsam |
|-----------|-------------|----------|--------|
| AC-1 | `todo.spec.ts` | `should add new todo` | full |
| AC-2 | `todo.spec.ts` | `should complete todo` | full |
| AC-3 | `todo.spec.ts` | `should delete todo` | full |

**Anlat:**
> "Trace agenti, Proto'nun **gercek kodunu** GitHub'dan okuyor ve o koda ozel Playwright testleri yaziyor. Halusinasyona yer yok — generic test degil, gercek koda dayali testler.
>
> **Izlenebilirlik Matrisi** ile her kabul kriterinin hangi testle karsilandigini takip ediyoruz. Kapsanmayan kriter varsa uyari verilir. Bu, tezin ana temasi olan **Knowledge Integrity** yaklasiminin somut uygulamasidir."

---

### 7. BDD/Cucumber Spesifikasyonlari (1 dakika)

**Goster:** Trace sonuclarindaki **Gherkin feature dosyalari** — `gherkin_spec` mesaj tipi olarak gorunur:
- Feature adi ve dosya yolu
- Senaryo sayisi
- Eslenen kabul kriterleri listesi
- **Given / When / Then** syntax'i ile yazilandirilmis test senaryolari

**Ornek Gherkin ciktisi:**
```gherkin
Feature: Todo Yonetimi
  Scenario: Yeni gorev ekleme
    Given kullanici todo sayfasinda
    When "Alisveris yap" gorevini ekler
    Then gorev listesinde "Alisveris yap" gorunur
```

**Anlat:**
> "Trace ayni zamanda Cucumber/BDD formatinda Gherkin feature dosyalari uretiyor. Her feature dosyasi, spesifikasyondaki kabul kriterlerine dogrudan eslenir. Bu, yapilandirilmis dogrulama saglar — hem insan hem de otomasyon tarafindan okunabilir test spesifikasyonlari."

---

### 8. Jira Entegrasyonu (30 saniye)

**Yap:** Eger onceden Jira baglantiisi yapildiysa, chat akisinda Jira badge'lerini goster

**Goster:**
- Chat mesajlarindaki **Jira badge'leri** (mavi, Epic key gosterir, ornegin `PROJ-42`)
- Jira Epic + alt gorevlerin otomatik olusturulmus hali (varsa Jira'da goster)

**Alternatif (Jira baglantisi yoksa):**

**Yap:** Settings → Integrations sekmesine git

**Goster:**
- Jira baglanti durumu
- Proje anahtari girisi (PROJ)
- Etkinlestirme toggle'i

**Anlat:**
> "AKIS, **MCP (Model Context Protocol)** standart protokolu ile dis sistemlere baglanir. Jira entegrasyonunda her pipeline calismasi sonucunda otomatik olarak Epic ve alt gorevler olusturulur. Her pipeline adiminda Jira'ya yorum eklenir — pipeline ilerlemesi proje yonetim aracinda da izlenebilir."

---

### 9. Knowledge Integrity Metrikleri (1 dakika)

**Yap:** Settings → Integrity sekmesine git (`/settings?tab=integrity`)

**Goster:**

1. **Spec Compliance Daire Gostergeleri** — Scribe, Proto ve Trace icin ayri ayri uyumluluk yuzdeleri (ComplianceCircle bilesenleri)

2. **Agent Confidence Trend Grafigi** — SVG tabanlizgi grafigi, haftalik bazda uc agentin guven skorlarini gosterir (ConfidenceChart)

3. **Criteria Coverage Ilerleme Cubugu** — kapsamalar/toplam kabul kriteri orani ve yuzde gostergesi (yesil ilerleme cubugu)

4. **En Sik Yapilan Varsayimlar Listesi** — numaralandirilmis liste, pipeline basina ortalama varsayim sayisi

**Anlat:**
> "Bu sekme tezin ana temasi olan Knowledge Integrity'yi olcumlenebilir hale getiriyor:
> - **Spec Compliance:** Her agentin spesifikasyona ne kadar sadik kaldigini gosterir.
> - **Confidence Trend:** Agent guven skorlarinin zaman icindeki degisimini izler — dusus varsa erken uyari verir.
> - **Criteria Coverage:** Kabul kriterlerinin ne kadarinin testlerle dogrulandigini gosterir.
> - **Assumptions:** Agentlerin hangi durumlarda varsayim yaptigini seffaflastirir — halusinasyon riskini olcumler."

---

### 10. Pipeline Analitikleri (30 saniye)

**Yap:** Settings → Pipeline Stats sekmesine git (`/settings?tab=pipeline-stats`)

**Goster:**
- **Toplam pipeline sayisi** ve **basari orani**
- **Ortalama sureler:** Scribe / Proto / Trace / toplam (formatli: dakika + saniye)
- **Son pipeline'lar tablosu** — her birinin durumu, suresi, tarihi
- **Hata Dagilimi** (`errorFrequency`) — en sik karsilasilan hata kodlari
- **Model Kullanimi** (`modelDistribution`) — hangi AI modeli ne kadar kullanildi
- **Token Istatistikleri** (`tokenUsage`) — agent bazinda input/output token sayilari
- **Retry Oruntuleri** (`retryPatterns`) — hangi asamada ne kadar tekrar deneme yapildi

**Anlat:**
> "Bu dashboard platformun performansini izlemek icin. Hata dagilimi hangi sorunlarin ne siklikla yasandigini, retry oruntuleri ise hangi asamanin daha kirilgan oldugunu gosterir. Token kullanimi maliyet optimizasyonu icin kritik."

---

### 11. Hata Yonetimi Demo (opsiyonel, 30 saniye)

**Goster:** (Eger basarisiz bir pipeline varsa o pipeline'i ac. Yoksa senaryoyu sozlu anlat.)

- **Hata mesaji** — kullanici dostu Turkce aciklama
- **Hata kodu** — teknik referans (ornegin `SCRIBE_TIMEOUT`, `PROTO_GITHUB_PUSH_FAILED`)
- **Tekrar denenebilirlik gostergesi** — "Bu hata tekrar denenebilir" badge'i
- **"Tekrar Dene" butonu** — basarisiz asamayi otomatik tespit edip o noktadan devam eder
- **"Trace'i Atla" butonu** — `completed_partial` durumuna gecirir (graceful degradation)

**Anlat:**
> "Pipeline bir durum makinesi (FSM) ile yonetiliyor. Her durumdan kurtarma senaryosu tanimli:
> - Tekrar denenebilir hatalar otomatik retry ile cozulebilir (max 3 deneme, exponential backoff: 5sn → 15sn → 30sn).
> - Kullanici isterse Trace'i atlayarak kismi tamamlanma durumuna gecebilir.
> - Hicbir hata pipeline'i belirsiz bir durumda birakmaz."

---

### 12. Kapanis (30 saniye)

**Anlat:**
> "Ozetlemek gerekirse, AKIS'in dogrulama zinciri bes katmandan olusur:"

```
Scribe uretir  →  INSAN dogrular        (human-in-the-loop)
Proto uretir   →  TRACE dogrular        (automated verification)
Trace uretir   →  TESTLER dogrular      (execution verification)
Cucumber       →  YAPILANDIRILMIS       (BDD specs — okunabilir dogrulama)
Jira           →  PROJE YONETIMI        (MCP entegrasyonu — izlenebilirlik)
```

> "Her katman farkli bir dogrulama mekanizmasi kullanir. Bu yaklasim, LLM halusinasyonlarini yapisal olarak engeller ve yazilim gelistirme surecinde **Knowledge Integrity**'yi saglar."

---

## Juri Icin Konusma Noktalari

### Knowledge Integrity Neden Onemli?

- AI agentlari hata yapabilir — tek bir agentin ciktisina guvenilmemeli
- Her adimda farkli bir dogrulama mekanizmasi devreye girer:
  - **Insan** → Scribe spec'ini inceler ve onaylar
  - **AI (Trace)** → Proto kodunu GitHub'dan bagimisiz olarak okuyup dogrular
  - **Otomasyon** → Trace'in yazdigi testler calistirilarak dogrulanir
  - **BDD** → Cucumber Gherkin ile kabul kriterleri yapilandirilmis olarak dogrulanir
- Varsayim seffafligi — agent ne zaman belirsiz bilgiyle calisiyorsa bunu acikca raporlar

### 3-Agent Pipeline'in Avantajlari

- **Sorumluluk ayirimi (Separation of Concerns):** Her agent tek bir gorevde uzmanlasmistir
- **Bagimsiz dogrulama:** Agentlar birbirini dogrudan cagirmaz — tum iletisim PipelineOrchestrator uzerinden akar
- **Izole hata yonetimi:** Bir agenttaki hata digerlerini etkilemez, her asama bagimsiz olarak tekrar denenebilir
- **Olceklenebilirlik:** Her pipeline bagimsiz bir FSM instance'i, async/non-blocking mimari ile esanlamli calisma mumkun

### MCP (Model Context Protocol) Entegrasyonu

- **Standart protokol:** Dis sistemlere baglanmak icin AI industrisinde ortaya cikan standart bir protokol
- **Jira entegrasyonu:** Spesifikasyondan otomatik Epic ve gorev olusturma, pipeline adimlarinda otomatik yorum ekleme
- **GitHub entegrasyonu:** Kod push, branch olusturma, PR acma — hepsi MCP adaptoru uzerinden
- **Genisletilebilirlik:** Yeni arac eklemek icin ayni adapter pattern'i kullanilir (ornegin Slack, Linear vb.)

### Teknik Zorluklar ve Cozumler

| Zorluk | Cozum |
|--------|-------|
| Concurrent islem yonetimi | Optimistic locking ile cakisma onleme |
| Gercek zamanli ilerleme izleme | Server-Sent Events (SSE) — her dosya olusumunda canli bildirim |
| AI maliyeti optimizasyonu | **Prompt caching** (`cache_control: ephemeral`, 5dk TTL) + effort-based model routing (Haiku → hizli isler, Sonnet → kompleks isler) + cache-hit metrikleri (`cache_read_input_tokens` DB'de izleniyor) |
| Entegrasyon hatalari | Graceful degradation — Jira veya GitHub hatasi pipeline'i kirmaz |
| LLM halisinasyonu | Trace'in Proto kodunu dogrudan GitHub'dan okumasi — kendi halusinasyonunu test etmesini engeller |
| Uzun sureli islemler | Pipeline FSM ile durum yonetimi, her durumdan kurtarma senaryosu |

### Guvenlik Onlemleri (Juri Sorarsa)

| Onlem | Uygulama |
|-------|----------|
| Rate limiting | 120 req/min global + endpoint bazli limitler (auth: 5-10/min) |
| Brute-force korumasi | 5 basarisiz deneme → 30 dakika kilitleme |
| CORS | Origin whitelist (wildcard degil), credentials kontrolluu |
| Cerezler | httpOnly, secure, sameSite=Lax |
| Sifreler | bcrypt 10 tur |
| AI API anahtarlari | AES-256-GCM (AEAD) ile sifreleme |
| SQL enjeksiyonu | Tum sorgular Drizzle ORM ile parametrize |
| Hata mesajlari | Sanitize edilmis, stack trace sizintisi yok |
| OAuth | HMAC imzali state tokenlari (stateless, yeniden baslatmaya dayanikli) |

---

## Teknik Mimari Ozeti

### Tech Stack

| Katman | Teknoloji |
|--------|-----------|
| Frontend | React 19 + TypeScript + Vite 7 + Tailwind CSS 4 |
| Backend | Fastify 4 + TypeScript + Drizzle ORM + PostgreSQL 16 |
| AI Provider | Anthropic Claude API (Sonnet 4.6 / Haiku 4.5) |
| Gercek Zamanli | Server-Sent Events (SSE) |
| Kimlik Dogrulama | Cookie-based JWT + OAuth (GitHub, Google) |
| Test | Vitest (backend + frontend birim testleri) |
| Deployment | OCI x86_64, Docker Compose, Caddy (auto-HTTPS) |

### Pipeline Durum Makinesi (FSM)

```
Kullanici Fikri
    ↓
scribe_clarifying  ←→  (soru-cevap turlari, max 3)
    ↓
scribe_generating  →  Spec olusturma
    ↓
awaiting_approval  →  Insan kapisi (onayla / reddet)
    ↓
proto_building     →  Kod uretimi + GitHub push
    ↓
trace_testing      →  Test yazimi + kapsam raporu
    ↓
completed          →  Basariyla tamamlandi
completed_partial  →  Trace atlanarak tamamlandi

Her adimdan → failed (retryable) | cancelled
```

### Dogrulama Zinciri Tablosu

| Agent | Girdisi | Ciktisi | Dogrulama Yontemi |
|-------|---------|---------|-------------------|
| Scribe | Kullanici fikri (serbest metin) | StructuredSpec (JSON) | Self-interrogation + self-review + varsayim gunlugu |
| Insan | Yapilandirilmis spec | Onay veya red | Human-in-the-loop (PlanCard UI ile inceleme) |
| Proto | Onaylanmis spec | MVP scaffold + GitHub push | Spec compliance + dosya yapisi dogrulama |
| Trace | Proto'nun GERCEK kodu (GitHub'dan) | Playwright testleri + Gherkin specleri | AC-test izlenebilirlik matrisi + kapsam raporu |

---

## Olasi Juri Sorulari ve Yanitlari

**S: Neden 3 ayri agent? Tek bir agent hepsini yapamaz mi?**
> Her agent tek bir sorumluluk tasir (Single Responsibility Principle). Scribe analiz, Proto uretim, Trace dogrulama yapar. Bu ayrim her agentin kendi alaninda optimize edilmesini saglar. Ayrica, dogrulama icin bir agentin kendi ciktisini degil, baska bir agentin ciktisini test etmesi gerekir — aksi halde "kendi halusinasyonunu dogrulayan" bir sistem olur.

**S: Trace neden Proto'nun kodunu dogrudan kullanmiyor da GitHub'dan okuyor?**
> Trace, Proto'nun gercek push ettigi kodu dogrulamalidir. Eger Proto'nun bellekteki ciktisini kullansak, Proto kodunu degistirip push ettiginde Trace yanlis seyi test edebilir. GitHub'dan okumak, dogrulamanin bagimsiz ve guvenilir olmasini garantiler — "trust but verify" prensibi.

**S: Human-in-the-loop neden gerekli? Tamamen otomatik olamaz mi?**
> LLM'ler hala yanlis yorumlama yapabilir. Insan onayi, yanlis anlasilmis gereksinimlerin kodlamaya gecmesini engeller. Bu, Knowledge Integrity zincirinin en kritik halkasidir. Ileride guven skoru yuksek pipeline'larda otomatik onay opsiyonu eklenebilir, ancak su anki yaklasim guvenlik onceliklidir.

**S: Sistem nasil olceklenir (scalability)?**
> Her pipeline bagimsiz bir FSM instance'idir. Backend async/non-blocking Fastify ile calisir, birden fazla pipeline eszamanli yonetilebilir. Horizontal scale icin stateless backend + shared PostgreSQL mimarisi yeterlidir. AI cagrisi bottleneck'i ise provider rate limit'leriyle sinirlidir.

**S: Maliyet ne kadar?**
> Ortalama bir pipeline yaklasik $0.15-0.25 Anthropic API maliyeti getirir (Sonnet 4.6). Token kullanimi pipeline stats dashboard'unda izlenebilir. Kullanicilar kendi API anahtarlarini da getirebilir — platform lock-in yok. Effort-based routing ile basit isler Haiku'ya yonlendirilerek maliyet dusurulur.

**S: Neden Fastify? Express veya Next.js degil?**
> Fastify, benchmark'larda Express'ten 2-3 kat daha hizlidir. Native TypeScript destegi, plugin mimarisi ve schema-based validation saglar. Next.js ise SSR odakli bir framework — AKIS bir SPA oldugu icin Vite + React daha hafif ve esnek bir cozumdur. Mimari karari basitlik ve performans onceliklidir.

**S: Gercek bir projede kullanilabilir mi?**
> Evet. akisflow.com uzerinde canli olarak calisir durumdadir. GitHub OAuth ile giris yapilir, gercek repository'ler olusturulur, gercek kod push edilir. Ancak uretilen kodun production'a cikmadan once insan tarafindan gozden gecirilmesi onerilir — AKIS bir "ilk taslak uretici" olarak konumlanmistir, final urun degil.

---

## Hazirlik Kontrol Listesi

### Demo Oncesi (D-1)

- [ ] `akisflow.com` erisim kontrolu — sayfa yukleniyormu?
- [ ] GitHub OAuth baglantisi aktif mi? (Settings → AI Keys sekmesi)
- [ ] AI Key yapilandirilmis mi? (Anthropic provider'da "Yapilandirildi" durumu)
- [ ] En az 1 tamamlanmis pipeline gecmisi var mi? (Demo 2 icin gerekli)
- [ ] Jira test projesi hazir mi? (Opsiyonel — Demo 8 icin)
- [ ] Yedek plan: `AI_PROVIDER=mock` ile local demo ortami hazir mi?

### Demo Gunu (D-0)

- [ ] Tarayici tam ekran modunda (`F11`)
- [ ] Tarayici devtools kapali
- [ ] Karanlik tema varsayilan olarak ayarli
- [ ] Tarayicida yalnizca `akisflow.com` sekmeleri acik (dikkat dagitici sekmeler yok)
- [ ] Ekran kaydi araci hazir ve test edilmis (OBS, QuickTime vb.)
- [ ] Internet baglantisi stabil (yedek: mobil hotspot)
- [ ] Sunum notlari yazdirilmis veya ikinci ekranda acik

### Acil Durum Plani

| Sorun | Cozum |
|-------|-------|
| akisflow.com erisemiyor | Local ortamda `pnpm dev` ile demo (`localhost:5173`) |
| AI API cevap vermiyor | `AI_PROVIDER=mock` ile mock demo (onceden hazirlanmis yanitlar) |
| GitHub push basarisiz | `dryRun: true` modu ile push simule et |
| Pipeline cok uzun suruyor | Onceden tamamlanmis bir pipeline uzerinden Demo 2'ye gec |
| Internet yok | Tamamen offline mock demo + ekran goruntuleri ile anlat |

---

## Istatistikler (Guncelleme: Nisan 2026)

| Metrik | Deger |
|--------|-------|
| Toplam birim test | 1500+ (backend + frontend) |
| Ortalama pipeline suresi | ~5 dakika |
| Ortalama Scribe guven skoru | %88-92 |
| Ortalama Proto dosya sayisi | ~12-15 |
| Ortalama Trace test sayisi | 55+ |
| Tanimli hata kodu | 18 (10 tanesi retryable) |
| Retry politikasi | Max 3 deneme, backoff: 5sn → 15sn → 30sn |
| Stage timeout | 5 dakika (Trace: 10 dakika) |
| Desteklenen AI provider | 3 (Anthropic, OpenAI, OpenRouter) |
| Ortalama pipeline maliyeti | ~$0.15-0.25 (Anthropic Sonnet 4.6) |
