# AKIS Platform — Geliştirme Süreci İncelemesi

Tarih: 2026-05-24
Yöntem: 6 eksenli kanıt-tabanlı tarama + 2026 best-practice karşılaştırma

---

## Yönetici Özeti

Bu inceleme AKIS'in ne ürettiğini değil, nasıl üretildiğini değerlendiriyor. 4 paralel araştırma agent'ı + doğrudan repo taramasıyla 6 eksende kanıt toplandı. Bulgular 2026'nın dominant paradigması olan Spec-Driven Development (SDD) ve Harness Engineering prensipleriyle karşılaştırıldı.

**En kritik 5 bulgu:**

1. **Commit disiplini mükemmel, PR disiplini zayıf.** Son 20 commit'te %0 FE+BE karışımı — ama PR bazında #608 (40 dosya), #609 (34 dosya), #610 (24 dosya) birden fazla ilgisiz concern birleştiriyor. Sorun session'da verilen "bu 4 şeyi düzelt" tarzı geniş scope.

2. **Enforcement boşluğu.** Gate script, 2 hook (FR-link + doc-update), CI workflow var — ama hiçbiri pre-commit'e bağlı değil. Disiplin tamamen irade gücüne dayanıyor.

3. **Pipeline core modülü (29 dosya) sıfır test.** Backend test/kaynak oranı 0.85x ama en kritik modül (orchestrator, state machine) tamamen test dışında.

4. **Dokümantasyon zengin ama dağınık.** 114 dosya, navigasyon indeksi yok. PDP iyi yapılandırılmış ama SDD'nin gerektirdiği constitution, traceability matrix, task breakdown eksik.

5. **State yönetimi stale.** orchestrator.json 3 olmayan worktree'ye referans veriyor. pdp-progress.json 14 gün eski. 32 lokal branch, 30'u unmerged. Dead code sweep analizi yapılmış ama aksiyon alınmamış.

---

## A. Concern Separation (FE/BE Karışımı)

### Kanıt

**Commit bazında: 10/10 — mükemmel ayrım.**
- Son 20 substantive commit'te %0 FE+BE karışımı
- Ortalama 2.35 dosya/commit
- Hiçbir commit 50+ dosya değil

**PR bazında: 4/10 — kitchen-sink pattern.**

| PR | Dosya | BE | FE | Concern Sayısı |
|----|-------|----|----|----------------|
| #608 | 40 | 22 | 17 | MCP authv2 + DCR + frontend Jira |
| #609 | 34 | 11 | 21 | event-log + failed-state UX + provider copy |
| #610 | 24 | 8 | 14 | A1-A4 holistic + chat-history fix + z-index |
| #607 | 17 | 2 | 14 | display rename (tek concern ✓) |
| #603 | 14 | 9 | 3 | AI logging (tek concern ✓) |

PR #603-607 (T1-T5 serisi) odaklı ve iyi. PR #608-610 geniş scope, karışık concern.

### 2026 Best Practice

Red Hat Harness Engineering: *"The task template includes a Repository field that scopes the AI to a single repository."*
Addy Osmani: *"Monolithic code generation produces jumbled messes — like 10 devs without talking."*

### Teşhis

Session'da "bu 4 şeyi düzelt" tarzı istek → AI temiz commit'ler üretiyor ama hepsi tek PR'a giriyor. Sorun AI'ın commit disiplini değil, kullanıcının session scope'u.

### Öneri

- **Kural: 1 session = 1 concern = 1 PR.** T1-T5 serisi bunu yapmış ve iyi çıkmış.
- Paralel concern'lar için `/parallel` komutu (zaten var) — her concern ayrı worktree + PR.
- Session başlangıcında "bu session'da sadece X yapılacak" constraint'i.

---

## B. Dokümantasyon Olgunluğu (SDD Lens)

### Kanıt

**114 dosya**, 10+ kategori:

| Kategori | Dosya | Olgunluk |
|----------|-------|----------|
| PDP (Product docs) | 18 | MAINTAINED — 2 approved, 3 draft, roadmap implemented |
| Architecture ADRs | 6 | MAINTAINED — decision+context+alternatives pattern |
| API Spec | 2 | MAINTAINED — 1124 satır, 20 endpoint, type-gen entegre |
| Dogfooding | 10 | Recent (Mayıs 2026) |
| Thesis | 9 | In-progress |
| Ops Runbooks | 19 | Maintained |
| Plans/Reports | 19 | Mixed (eski+yeni) |

**SDD Uyumu:**

| SDD Pillar | Gerekli | AKIS'te | Durum |
|------------|---------|---------|-------|
| Constitution (governance rules) | ✓ | ✗ | MISSING |
| Spec (user stories + AC) | ✓ | ✓ | 01-requirements.md (approved) |
| Plan (architecture + design) | ✓ | ✓ | 03-architecture.md (draft) |
| Tasks (atomic work items) | ✓ | ~Kısmî | Roadmap'te PR referansları var ama atomic checklist yok |

**CLAUDE.md**: 118 satır, 9 bölüm. İçerik doğru ve güncel ama **rol karışıklığı** var — hem onboarding guide hem agent talimatı aynı dosyada. 2026 standardı (AGENTS.md) bunların ayrılmasını öneriyor.

### 2026 Best Practice

SDD (GitHub SpecKit, AWS Kiro): Specify → Plan → Tasks → Implement, her aşamada human review.
AGENTS.md standard: Root → paket-spesifik → paylaşılan, hierarchical yapı.

### Teşhis

PDP sistemi var ve iyi — ama tutarlı takip edilmiyor. Bazı PR'lar spec'ten doğuyor (T1-T5), bazıları doğrudan "bunu düzelt" session'ı (V serisi). İkincisi sorun çıkarıyor çünkü context her seferinde sıfırdan verilmek zorunda.

### Öneri

- **Constitution.md**: Süreç kurallarını, gate SLA'larını, rollback prosedürünü belgele.
- **Traceability matrix**: FR → Test → PR → Status tek tablo.
- **CLAUDE.md split**: Agent talimatları CLAUDE.md'de kalsın; onboarding ONBOARDING.md'ye taşınsın.
- **docs/README.md (index)**: 114 dosyaya navigasyon indeksi.

---

## C. Session / Agent Anti-Pattern'leri

### Kanıt

**1. Kitchen-sink debug session:**
`pr-h-debug-session-2026-05-19.md` (9007 byte) — tek session'da 4 ilgisiz bug:
- Login enter submit
- Trace frontend'te görünmüyor
- Trace JSON parse fail (3x retry)
- SSE state sync kırık (refresh gerekli)

Bu 4 sorunun her biri ayrı concern; tek session'da çözmeye çalışmak karmaşa üretmiş.

**2. Analysis without action:**
`dead-code-sweep-2026-05-19.md` (8174 byte) — 9 unused component (~1730 LOC) + 313 stale i18n key tespit edilmiş. 5 gün geçmiş, hiçbiri temizlenmemiş. Analiz zamanı harcandı ama aksiyon alınmadı.

**3. Stale orchestrator state:**
`orchestrator.json` 3 worktree'yi "active" referans ediyor (pra-quick-fixes, prb-tab-resize, prc-critic-checkbox) — hiçbiri disk'te yok. Session resume bu state'e bakıp kafa karışıklığı yaşar.

**4. Backlog-as-spec:**
`backlog-2026-05-20.md` çok detaylı (specific LOC, dosya yolları, iki opsiyon) — aslında bir implementation spec, backlog formatında yazılmış. Doğru artifact'ta değil.

### 2026 Best Practice

Osmani: *"Break work into small, manageable chunks — implement one task at a time."*
Tim Deschryver: *"Frequent reviews catch misalignments early; avoid big review at the end."*

### Öneri

- **1 session = 1 concern kuralı** (B.1'de de var). Debug session'ları bile scope'lanmalı.
- **Analysis → Action pipeline**: Simplifier bulguları 48 saat içinde ya uygulanır ya "defer" ile etiketlenir.
- **Orchestrator temizliği**: Session resume skill'inde "stale worktree detection" ekle.
- **Backlog vs Spec ayrımı**: Backlog'da sadece "ne yapılacak + neden"; nasıl yapılacak → spec dosyası (SDD Plan aşaması).

---

## D. Testing ve Quality Gate Disiplini

### Kanıt

**TDD disiplini: %50 — tutarsız.**
- 9/20 feature commit'te test commit'le birlikte (TDD)
- 11/20 commit'te test yok veya sonra eklenmiş
- Backend pipeline modülü: TDD
- Frontend: güçlü TDD
- Type-only ve chore commit'ler: genellikle testsiz (kabul edilebilir)

**Test coverage boşlukları:**

| Modül | Kaynak | Test | Oran | Kritiklik |
|-------|--------|------|------|-----------|
| backend/core/ | 29 | 0 | 0.00x | KRITIK — orchestrator mantığı |
| backend/api/ | 36 | 2 | 0.05x | YÜKSEK — HTTP yüzeyi |
| backend/services/ | 66 | 1 | 0.01x | YÜKSEK — domain logic |
| backend/pipeline/ | 92 | 36 | 0.39x | ORTA — ana yol |
| frontend (genel) | 151 | 117 | 0.77x | SAĞLIKLI |

**Frontend coverage gate**: NFR-3.5 ≥%70 line coverage, PR gate'te enforced. Backend'de böyle bir gate yok.

**Gate script**: `scripts/gate.sh` var, kapsamlı (typecheck+lint+test+build), ama:
- Pre-commit hook'a bağlı değil
- Husky yok
- Kullanım tamamen isteğe bağlı

**CI workflows**: 5 workflow (ci.yml, pr-gate.yml, deploy-prod.yml, db-reset-prod.yml, nightly-smoke.yml). PR gate kapsamlı — ama integration testleri sadece nightly'de.

### Öneri

- **core/ modülüne test**: Orchestrator state transition'ları + lock mekanizması en az 10 unit test hak ediyor.
- **Pre-commit hook**: gate.sh'ı git hook veya Claude hook'a bağla. Manual gate = missed gate.
- **Integration testleri PR gate'e taşı**: Nightly'de yakalamak çok geç.

---

## E. Branch / Worktree / CI Stratejisi

### Kanıt

**32 lokal branch, sadece 2'si main'e merge edilmiş.**
- pr-v1 ... pr-v9 serisi (V dalga) — hepsi ayrı branch, çoğu merge edilmemiş lokal
- pr-T1 ... pr-T5 serisi (T dalga) — benzer
- feat/, fix/, chore/, docs/ prefix'leri — 4 farklı convention
- defense-fixes-deploy-2026-05-19 — one-off branch

**CI config sağlıklı** — ci.yml her branch'e push'ta çalışıyor, pr-gate.yml main'e PR'da, nightly-smoke.yml hafta içi gece. Ama 32 branch'in hepsinde CI çalışıyor = gereksiz maliyet.

**Worktree disiplini**: Orchestrator 3 worktree referans ediyor, hiçbiri yok. Temizlik yapılmamış.

**Stash**: 1 entry ("pdp-branch artifacts") — tamamlanmamış iş.

### Öneri

- **Branch temizliği**: `git branch --merged main` + remote prune. Rutin haline gelsin.
- **Branch naming convention**: `{type}/{scope}-{ticket}` standardize et (feat/scribe-clarification gibi).
- **Worktree lifecycle**: Oluştur → çalış → merge → temizle. Orchestrator "stale worktree gc" eklesin.
- **CI branch filter**: `ci.yml`'de sadece `main` + `feat/*` + `fix/*` çalıştır; stale branch'ler CI tüketmesin.

---

## F. AI Harness Konfigürasyonu

### Kanıt

**Genel yapı: 7/10 — iyi tasarlanmış ama incomplete execution.**

| Bileşen | Durum | Sorun |
|---------|-------|-------|
| CLAUDE.md | ✅ Sağlıklı (118 satır) | Rol karışıklığı (onboarding + agent) |
| 8 Agent tanımı | ⚠️ Eksik | 2 planlanmış agent yok (researcher, release-coordinator) |
| 5 Skill tanımı | ✅ Sağlıklı | — |
| 6 Command tanımı | ⚠️ İsim uyumsuzluğu | README "gate" diyor, dosya "gate-check" |
| 3 Hook script | ❌ 2/3 bağlı değil | pre-commit-fr-link + post-doc-write dormant |
| settings.json | ✅ 28 permission entry | Konservatif, uygun |
| orchestrator.json | ⚠️ Stale | 3 hayalet worktree |
| pdp-progress.json | ⚠️ 14 gün eski | — |
| Memory (39 entry) | ✅ Güncel | — |

**Kritik dormant hook'lar:**

1. **pre-commit-fr-link.sh** (134 satır) — commit mesajında FR-/NFR-/F- ID zorunluluğu. Yazılmış ama settings.json'a eklenmemiş. Bu hook çalışsaydı traceability otomatik olurdu.

2. **post-doc-write.sh** (156 satır) — PDP dokümanı düzenlendiğinde 00-README.md status tablosunu otomatik günceller. Yazılmış ama bağlı değil.

### Öneri

- **2 hook'u hemen bağla**: `/update-config` ile 2 dakikada yapılabilir. FR-link hook en değerli tek iyileştirme.
- **README.md ↔ gerçek dosya senkronu**: researcher ve release-coordinator ya implement et ya README'den çıkar.
- **orchestrator.json temizliği**: Stale worktree'leri sil.

---

## Anti-Pattern Kataloğu (Özet)

| # | Anti-Pattern | Kanıt | Sektör Karşılığı | Önerilen Çözüm |
|---|---|---|---|---|
| 1 | **Kitchen-sink PR** | PR #608-610 (24-40 dosya, 3+ concern) | Red Hat: "scope to single repo" | 1 session = 1 concern = 1 PR |
| 2 | **Kitchen-sink debug session** | pr-h-debug: 4 ilgisiz bug tek session | Osmani: "one task at a time" | Debug session'ı da scope'la |
| 3 | **Enforcement gap** | Gate script + 2 hook var ama wired değil | SDD: "human review at every phase boundary" | Pre-commit hook bağla |
| 4 | **Core untested** | 29 dosya, 0 test | Osmani: "agent flies with test suite as safety net" | Orchestrator state-transition testleri |
| 5 | **Analysis without action** | Dead code sweep 5 gün aksiyon bekliyor | Tim D: "frequent reviews, not big review at end" | 48 saat kuralı: uygula veya defer et |
| 6 | **Stale state** | orchestrator.json, pdp-progress, 30 branch | Session-resume: stale detection | Rutin gc (branch + worktree + state) |
| 7 | **SDD incomplete** | Constitution, traceability matrix yok | GitHub SpecKit: 4 pillar | Constitution.md + matrix |
| 8 | **CLAUDE.md role confusion** | Onboarding + agent talimatı aynı dosya | AGENTS.md standard: hierarchical | Split veya section |

---

## Öncelikli Aksiyon Planı

### Hemen (1 gün, yüksek ROI)

1. **2 dormant hook'u bağla** — settings.json'a ekle. FR-link hook traceability'yi otomatize eder.
2. **orchestrator.json + branch temizliği** — stale state sil, 30 unmerged branch'i prune et.
3. **"1 session = 1 concern" kuralını CLAUDE.md'ye ekle** — agent bu kuralı her session başında okur.

### Kısa vade (1 hafta)

4. **Constitution.md** — süreç kuralları, gate SLA, 1-session-1-concern kuralı, rollback prosedürü.
5. **core/ modülüne 10 unit test** — orchestrator state transition coverage.
6. **docs/README.md (index)** — 114 dosyaya navigasyon.

### Orta vade (savunma sonrası)

7. **SDD tam adoption** — GitHub SpecKit veya OpenSpec entegrasyonu (3 belge: proposal → design → tasks).
8. **Integration testleri PR gate'e taşı** — nightly yerine her PR'da.
9. **CLAUDE.md → AGENTS.md migration** — 2026 standardına geçiş.
10. **Dead code sweep otomasyonu** — simplifier findings → auto-PR.

---

## Kaynaklar

- [Harness Engineering — Red Hat](https://developers.redhat.com/articles/2026/04/07/harness-engineering-structured-workflows-ai-assisted-development)
- [LLM Coding Workflow — Addy Osmani](https://addyosmani.com/blog/ai-coding-workflow/)
- [Agentic AI Workflow — Tim Deschryver](https://timdeschryver.dev/blog/keep-agentic-ai-simple-a-practical-workflow-for-software-development)
- [SDD 2026 Guide — BCMS](https://thebcms.com/blog/spec-driven-development)
- [SpecKit — GitHub Blog](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/)
- [AGENTS.md Guide — BuildBetter](https://blog.buildbetter.ai/agents-md-complete-guide-for-engineering-teams-in-2026/)
