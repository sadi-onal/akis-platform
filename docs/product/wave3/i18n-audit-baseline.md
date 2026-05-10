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
