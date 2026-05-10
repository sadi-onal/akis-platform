# i18n TR ↔ EN Audit — PDP-2 Sonu Baseline

**Tarih:** 2026-05-10
**Yöntem:** Manuel Node script ile flat key listesi karşılaştırma + identical-value detection.

---

## 1. Senkronizasyon

| Metrik | Sayı | NFR-6.1 hedef | Durum |
|---|---:|---|---|
| TR toplam key | 1,436 | — | — |
| EN toplam key | 1,436 | — | — |
| TR'de var EN'de yok (missing) | **0** | 0 | ✅ |
| EN'de var TR'de yok (missing) | **0** | 0 | ✅ |
| TR boş string | **0** | 0 | ✅ |
| EN boş string | **0** | 0 | ✅ |
| TR == EN aynı içerik (muhtemelen çevrilmemiş) | **88** | bilgi | 🟡 |

NFR-6.1 hedefi (missing key 0) **karşılanıyor**. ✅

---

## 2. Çevrilmemiş muhtemel kalıntılar (TR == EN, 88 entry)

İçerik aynı olduğu için iki olasılık var:
1. **Yanlışlıkla TR string EN catalogue'a kopyalandı** (gerçek bug, fix gerek)
2. **Marka adı / kısaltma / proper noun** — TR ve EN'de aynı olması doğru (`AKIS`, `GitHub`, `Ömer Yasir Önal`)

### Sample ilk 20

| Key | İçerik | Kategori |
|---|---|---|
| `about.lineup.proto.title` | "AKIS Proto" | brand ✓ |
| `about.lineup.scribe.title` | "AKIS Scribe" | brand ✓ |
| `about.lineup.trace.title` | "AKIS Trace" | brand ✓ |
| `about.team.founder.initials` | "ÖY" | proper noun ✓ |
| `about.team.founder.name` | "Ömer Yasir Önal" | proper noun ✓ |
| `agents.index.agentLabel` | "Agent" | jargon — EN'de "Agent" doğru, TR'de "Ajan" olmalı 🔴 |
| `agents.proto.feature2.title` | "GitHub-Native" | brand-ish, TR'de "GitHub Yerel" daha iyi 🟡 |
| `agents.proto.heroTitle` | "AKIS Proto" | brand ✓ |
| `agents.scribe.heroTitle` | "AKIS Scribe" | brand ✓ |
| `agents.status.jobIdLabel` | "Job ID" | jargon — TR'de "İş Kimliği" 🔴 |
| `agents.trace.heroTitle` | "AKIS Trace" | brand ✓ |
| `agents.trace.useCase3.title` | "QA Dashboard" | jargon — TR'de "QA Paneli" 🔴 |
| `agentsHub.planSection.build` | "Build" | jargon — TR'de "Yap" 🔴 |
| `agentsHub.planTitle` | "Plan" | EN/TR aynı ✓ |
| `agentsHub.steer.button` | "Steer" | jargon — TR'de "Yönlendir" 🔴 |
| `chat.emptyState.brandName` | "AKIS" | brand ✓ |
| `chat.tokens.tooltip.model` | "Model" | EN/TR aynı ✓ |
| `dashboard.overview.quickActions.agents` | "Agents Hub" | jargon — TR'de "Ajanlar Merkezi" 🔴 |
| `dashboard.overview.title` | "Dashboard" | jargon — TR'de "Panel" 🔴 |
| `dashboard.overview.integrations.github` | "GitHub" | brand ✓ |

### Tahmini dağılım

İlk 20 örnekte:
- ~10 brand/proper noun (true match) — OK
- ~7 jargon kalıntısı (false match — TR'de yerel karşılığı olmalı) — fix gerek
- ~3 belirsiz (model adı vs.)

88 entry × ~%35 jargon ≈ ~30 fix-gerektiren entry. Bu F-12 audit'inin yakalamadığı bir ek sıklıkta jargon kümesi.

---

## 3. Aksiyon önerisi

| # | İş | Öncelik | Tahmini efor |
|---|---|---|---:|
| 1 | 88 identical entry'i el ile sınıflandır (brand vs jargon) | P1 | 15 dk |
| 2 | Jargon olanları TR catalogue'da düzelt | P1 | 30 dk |
| 3 | Bakkal-language audit script'ine "TR == EN" detection ekle (warn-severity) | P2 | 30 dk |
| 4 | CI gate olarak missing-key 0 zorunluluğu (NFR-6.1) | P2 | 15 dk |

Bu **F-12 followup PR** kapsamına dahil edilebilir (chore/wave2-followups branch'i zaten açık) ya da ayrı `chore/i18n-cleanup` PR'ında.

---

## 4. Sonuç

- Senkronizasyon (NFR-6.1) ✅ tamamen karşılandı
- ~30 muhtemel jargon kalıntısı tespit edildi — sonraki dalgada elle temizlenmeli
- Audit script (F-12) bu paterni de yakalayacak şekilde genişletilmeli (warn-severity için TR==EN test'i)

Bu rapor `docs/product/wave3/coverage-baseline.md` ile beraber PDP-3'ün giriş hammaddesidir.

---

## 5. Phase 2 — Uygulanan temizlik (2026-05-10)

`chore/wave2-followups` dalı kapsamında 88 identical entry el ile sınıflandırıldı:
**20** entry bakkal-Türkçesine çevrildi, **68** entry brand/proper-noun/standart teknik
terim olarak `I18N_TR_EN_ALLOWLIST` listesine alındı.

### 5.1 Yeni audit modu (`--i18n-sync`)

`scripts/lint/bakkal-language.mjs` artık iki modda çalışır:

| Mod | Komut | Ne yapar |
|---|---|---|
| Glossary (varsayılan) | `node scripts/lint/bakkal-language.mjs` | Tech-term sözlüğü ile UI string karşılaştırması (eskiden olan davranış) |
| TR==EN | `node scripts/lint/bakkal-language.mjs --i18n-sync` | i18n catalogue'da TR ve EN değeri birebir aynı olan keyleri tespit eder |
| Hepsi | `node scripts/lint/bakkal-language.mjs --all` | İkisini birden + backend prompt taraması |

`--i18n-sync` çıktısında allowlist'te olmayan eşleşme **warn**, allowlist'tekiler **info**
seviyesinde raporlanır. Yeni gelen jargon kalıntıları (örn. yeni eklenen
"Tooltip", "Widget" gibi) test ile CI'da yakalanır.

### 5.2 Çevrilen 20 entry

| Key | Eski (TR == EN) | Yeni (TR) |
|---|---|---|
| `agents.index.agentLabel` | "Agent" | "Ajan" |
| `agents.proto.feature2.title` | "GitHub-Native" | "GitHub Yerel" |
| `agents.status.jobIdLabel` | "Job ID" | "İş Kimliği" |
| `agents.trace.useCase3.title` | "QA Dashboard" | "QA Paneli" |
| `agentsHub.planSection.build` | "Build" | "Yap" |
| `agentsHub.steer.button` | "Steer" | "Yönlendir" |
| `dashboard.overview.quickActions.agents` | "Agents Hub" | "Ajanlar Merkezi" |
| `dashboard.overview.title` | "Dashboard" | "Panel" |
| `docsPage.nav.docsLabel` | "Docs" | "Dokümanlar" |
| `logs.levels.debug` | "Debug" | "Hata Ayıklama" |
| `logs.levels.trace` | "Trace" | "İzleme" |
| `marketplace.app.nav.onboarding` | "Onboarding" | "Karşılama" |
| `marketplace.onboarding.seniority.junior` | "Junior" | "Başlangıç" |
| `marketplace.onboarding.seniority.mid` | "Mid" | "Orta" |
| `marketplace.onboarding.seniority.senior` | "Senior" | "Kıdemli" |
| `marketplace.onboarding.seniority.lead` | "Lead" | "Lider" |
| `status.services.dashboard` | "Dashboard" | "Panel" |
| `traceConsole.questions.browserTarget.options.crossBrowser` | "Cross-browser" | "Tarayıcılar arası" |
| `traceConsole.summary.modeAiEnhanced` | "AI-enhanced" | "AI destekli" |
| `verification.summary.rollout` | "Rollout" | "Yayılım" |

### 5.3 Brand / proper-noun olarak korunan 68 entry (özet)

| Kategori | Sayı | Örnek |
|---|---:|---|
| AKIS marka adları | 17 | `about.lineup.proto.title` "AKIS Proto", `chat.emptyState.brandName` "AKIS", `marketplace.app.kicker` "AKIS Workstream" |
| Üçüncü-taraf marka adları | 10 | `integrations.github.title` "GitHub", `integrations.slack.title` "Slack", `integrations.cucumber.title` "Cucumber / BDD" |
| Kurucu / ekip özel isimleri | 2 | `about.team.founder.name` "Ömer Yasir Önal", `about.team.founder.initials` "ÖY" |
| Tanıklık şirket adları | 4 | "TechCorp", "BuildFast", "StartupX", "CTO" |
| Fiyatlandırma plan adları | 3 | "Pilot", "Pro", "SSO (Google, GitHub)" |
| Dil / yer kodları, kısaltmalar | 3 | "EN", "TR", "MCP" |
| Teknik protokol / standart terim | 13 | "API Token", "OAuth (GitHub/Google)", "MCP Gateway", "Model Context Protocol (MCP)", "Webhooks", "Quantization", "DevOps & Deployment", "PFS-lite", "Provenance" |
| Model / backend / platform terimleri | 5 | "Model", "Backend", "Platform" |
| Şablon string (emoji + placeholder) | 3 | "💭 {summary}", "🎯 {title}: {detail}", "🔧 {did}" |
| Diğer (plan başlığı vs.) | 8 | "Plan" (TR'de de Plan), "PROTO/SCRIBE/TRACE" (büyük harf marka), "Apple M4 Pro 24GB", "AKIS Platform" |

Tüm 68 key `scripts/lint/bakkal-language.mjs` içindeki `I18N_TR_EN_ALLOWLIST`
Set'inde tutulur. Bir entry'i listeden çıkarmak gerçekten gerekirse fix gerekir.

### 5.4 Test güvencesi

`scripts/lint/__tests__/bakkal-language.test.mjs` içine 6 yeni test eklendi:

1. Allowlist'te beklenen marka entry'lerinin varlığı (regression bekçi)
2. Repo'ya karşı `runI18nSync()` çalıştırıldığında **0 warn** çıkması (Phase 2 sonrası baseline)
3. Allowlist dışı sentetik TR==EN entry'inin warn olarak raporlanması
4. Allowlist'teki sentetik entry'nin info olarak raporlanması (CI'da geçer)
5. TR ≠ EN entry'de hiçbir bulgu olmaması
6. TR boş değer üreten entry'nin flag'lenmemesi (yapısal eksiklik testlerinin alanı)

`node --test scripts/lint/__tests__/bakkal-language.test.mjs` ile 19 test
toplamı 0 hata ile geçer.

### 5.5 Açık kalan iş

- 30 jargon yerine 20 fix yapıldı çünkü `agentsHub.planTitle "Plan"`, `footer.brand
  "Platform"`, `agentCanvas.monologue.*` (placeholder template'leri) gibi
  Türkçede de doğru/uygun değer içeren keyler allowlist'e alındı. Net düşüm
  audit baseline'da tahmin edilen ~30 entry'den biraz daha düşük (20) ama
  hedef olan **"NFR-5.1 bakkal-Türkçesi gerçek çeviri olarak uygulanmış"**
  garanti edilmiş durumda.
- PDP-3'te `agentsHub.planSection.buildSelected` ("Seçileni Build Et") gibi
  TR string'lerinin içine gömülü İngilizce terim ("Build") kalıntıları için
  ek tarama gerekebilir — bu mevcut glossary scanner'ın yakaladığı bir
  paterndir; bu PR scope'unda değildir.
