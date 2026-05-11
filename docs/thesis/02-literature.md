# 02 — Literatür Taraması

**Status:** ✍️ Skeleton — fill with data when available
**Bağımlılık:** [`01-introduction.md`](./01-introduction.md)
**Tahmini sayfa:** 10-15

> **⚠️ Kaynak doğrulama notu (provisional iddialar):** Bu bölüm ve
> [`01-introduction.md`](./01-introduction.md) içindeki `[CITE-X]` yer
> tutucuları yalnızca "bibliography'ye eklenmesi gereken referans" anlamı
> taşır. Etiketin yanındaki **somut sayısal iddialar (örn. yüzde, arXiv
> kimliği, yıl) henüz birebir kaynak doğrulamasından geçmemiş** ve
> *provisional* statüsündedir. Her sayısal iddia tezin prose draftına
> dönüşmeden önce orijinal makaleye gidilip teyit edilmelidir; aksi hâlde
> savunmada akademik bütünlük riski doğar. arXiv kimliklerini özellikle
> https://arxiv.org/abs/<id> üzerinden doğrulayın.

> **Bölümün amacı:** AKIS'in oturduğu üç literatür ekseni (AI ajan orkestrasyonu, yazılım kalitesi/test üretimi, non-developer AI tools) etrafında ilgili çalışmaları sentezlemek; **gap analizi** ile AKIS'in lane'ini somutlamak.

---

## 2.1 AI ajan orkestrasyonu

> **Yazım hedefi (3-4 sayfa):** Çok-ajanlı sistemler, adversarial review, self-refinement, agentic AI trust framework'leri.

### 2.1.1 Çok-ajanlı yazılım üretimi

- **MetaGPT, AutoGen, ChatDev, AgentVerse** — multi-agent software engineering framework'leri. [CITE-MetaGPT, CITE-AutoGen, CITE-ChatDev]
  - Genel motif: rol bölünmesi (PM, Architect, Engineer, QA).
  - **Eksik:** Production-grade adversarial review yok; insan onay kapısı yok; persistence/explainability layer'ı yok.
- **AKIS'in farkı:** Scribe → Critic → İnsan Onayı → Proto → Critic → Trace + FixLoop — *her ajandan sonra* bağımsız bir Critic-pass; insan onay kapısı kaldırılamaz; her aşama persistent reasoning + activity log üretir.

### 2.1.2 Adversarial review / debate

- **Adversarial review (ASDLC.io, SentinelOne)** — kod review için adversarial agent motifi. [CITE-ASDLC, CITE-SentinelOne]
- **Multi-Agent Debate** [CITE-Du2023] — modeller karşılıklı argüman ile çıktı kalitesini artırıyor.
- **AKIS'in farkı:** Debate değil, *kategorik* review — 6 boyut (completeness, ambiguity, testability, consistency, spec_compliance, security). Findings frekansı ölçülebilir (Q3).

### 2.1.3 Self-refinement, Reflexion

- **Self-Refine** [CITE-SelfRefine] — kendi çıktısını iyileştiren LLM döngüsü.
- **Reflexion** [CITE-Reflexion] — NeurIPS 2023, %88 pass@1 — failure → feedback → retry.
- **AKIS'in karşılığı:** FixLoop — Trace'ten gelen test failure → Critic feedback → Proto retry (3-deneme limit).
- **Fark:** AKIS'te self-loop *adversarial agent* ile genişletilir; pure self-refinement değil.

### 2.1.4 Agentic AI trust framework'leri

- **TRiSM (Trust, Risk, Security Management)** — Gartner/agentic AI çerçevesi. [CITE-TRiSM, CITE-Gartner2026]
- **Trustworthy Agentic AI Pipelines** [CITE-TrustAgent2026]
- **Human-on-the-Loop adaptive autonomy** [CITE-HOTL]
- **AKIS'in karşılığı:** Approval Gate (FR-5) + ExplanationService (FR-8.2) + ConfidenceScore (FR-4.1) — TRiSM bileşenlerinin somut karşılığı.

### 2.1.5 Deterministic anchoring / hallucination detection

- **FORGE'26** [CITE-FORGE26] (arXiv 2601.19106) — AST-tabanlı halüsinasyon tespiti, %100 precision / %87.6 recall.
- **AKIS'in karşılığı:** `DeterministicValidator` katmanı (prototip aşamasında, Horizon 2'de tam implementasyon — § 6.3 future work).

### 2.1.6 Tabel: AKIS vs literatür motifleri

| Motif | Literatür kaynağı | AKIS karşılığı | Tam mı? |
|---|---|---|---|
| Multi-agent role split | MetaGPT, AutoGen | Scribe/Critic/Proto/Trace | ✅ |
| Adversarial review | ASDLC, SentinelOne | CriticAgent (6 boyut) | ✅ |
| Self-refinement | Self-Refine, Reflexion | FixLoop | ✅ |
| Human-in-the-loop gate | HOTL [CITE-HOTL] | Approval Gate (FR-5) | ✅ |
| Explainability | XAI literatürü | ExplanationService | ✅ |
| Deterministic anchoring | FORGE'26 | Prototip (gelecek iş) | 🟡 |
| Persistent learning | DSPy, pgvector RAG | Knowledge chunks (kısmi) | 🟡 |

[TBL-2]: bu tablo tezde figure olarak da yer alabilir.

---

## 2.2 Yazılım kalitesi ve test üretimi

> **Yazım hedefi (2-3 sayfa):** LLM-üretimi kodun kalite sorunları, test generation literatürü, BDD/Gherkin, coverage.

### 2.2.1 LLM-üretimi kod kalitesi

- **Sabra & Tyler 2025** [CITE-Sabra2025] — 4.442 görevde sistematik bug + güvenlik açığı + kod kokusu.
- **Sonar 2026** [CITE-Sonar2026] — %96 "AI koduna tam güvenmiyor".
- **Sherlock 2026** [CITE-Sherlock2026] — vibe-coded codebase'lerin %92'sinde ≥ 1 kritik açık.
- **AKIS'in karşılığı:** Critic'in security kategorisi (FR-4.1) + Trace'in coverage matrix'i (FR-7.3) + Regression report (FR-9.3).

### 2.2.2 Test generation literatürü

- **TestGen-LLM** [CITE-TestGenLLM] — Meta, LLM ile unit test üretimi.
- **CodaMosa, AthenaTest** [CITE-CodaMosa, CITE-AthenaTest] — search-based + LLM test generation.
- **AKIS'in farkı:** TraceAgent BDD/Gherkin + Playwright e2e üretiyor — *spec acceptance criteria* → senaryo dönüşümü. Unit test değil, AC kapsama.

### 2.2.3 BDD/Gherkin ve AC coverage

- **BDD (Behavior-Driven Development)** [CITE-North2006] — özellikten test'e doğal dil köprüsü.
- **Acceptance Test-Driven Development** [CITE-Adzic]
- **AKIS'in karşılığı:** Trace, spec'in `acceptanceCriteria[]` alanını alır, her AC için Gherkin scenario üretir, Playwright e2e yazar, **coverage matrix** ile hangi AC'lerin teste bağlandığını raporlar.

### 2.2.4 Verification kalitesi metrikleri

- **Pass@k** [CITE-Codex] — k denemede başarı oranı.
- **AKIS'in metrikleri:** Q1'de completion rate (5/5), Critic approval rate (%60), Trace coverage. AC-based, pass@k'dan zengin.

---

## 2.3 Bakkal-persona — non-developer AI tools

> **Yazım hedefi (2-3 sayfa):** No-code/low-code, vibe-coding, AI builder araçları; gap analizi.

### 2.3.1 No-code/low-code mevcut durum

- **Webflow, Bubble, Glide** — UI-builder + workflow. Tek-tıkla yayın. Kod yok.
- **Eksik:** Kalite-doğrulama yok; "bu uygulama çalışıyor mu" sorusu yanıtsız; iteration regression görünür değil.

### 2.3.2 Vibe-coding / AI builder lane

- **Bolt.new, Replit Agent, v0 (Vercel), Lovable** [CITE-Bolt, CITE-Replit, CITE-V0, CITE-Lovable]
  - Hedef: vibe-coder (geliştirici-yakın ama derin değil).
  - Çıktı: çalışan uygulama prototipi.
  - **Eksik:** Test yok / yüzeysel; regression yok; "hâlâ çalışıyor mu" sorusu yanıtsız; bakkal kullanamaz (GitHub link döner, deploy step yok).

### 2.3.3 Geliştirici-asistan lane

- **Cursor, GitHub Copilot, Claude Code, Codex (OpenAI)** [CITE-Cursor, CITE-Copilot, CITE-ClaudeCode]
- **Devin (Cognition)** — PR seviyesi otonomi. [CITE-Devin]
- **Eksik:** Bakkal'a hitap etmiyor — IDE içinde, dev terminolojisi, deploy/ops bilgisi varsayar.

### 2.3.4 Lane karşılaştırma matrisi

| Araç | Hitap ettiği | Çıktı kalitesi | Test/regression | Bakkal erişimi |
|---|---|---|---|---|
| Cursor / Copilot / Claude Code | Geliştirici | Yüksek | Manuel | ❌ |
| Bolt / Replit / v0 / Lovable | Vibe-coder | Yüzeysel | Yok | 🟡 (kısmi) |
| Devin | Geliştirici | PR-seviye | Sınırlı | ❌ |
| Webflow / Bubble | Non-dev | UI-only | Yok | ✅ ama kalite yok |
| **AKIS** | **Non-dev** | **Test edilmiş, regression-korumalı** | **✅ (Trace + FixLoop)** | **✅** |

[TBL-3]

**Gözlem:** Non-developer + quality + regression sahasında AKIS literatürde tarif edilen ama operasyonel olarak boş olan bir lane'i dolduruyor.

---

## 2.4 Boşluk analizi — AKIS'in farkı

> **Yazım hedefi (1.5-2 sayfa):** Üç ekseni birleştirip "AKIS'in *birlikte* sahip olduğu özellik kombinasyonunu kim sunuyor?" sorusuna cevap.

### 2.4.1 Özellik kombinasyonu

AKIS'in tek başına benzersiz olduğu kombinasyon:

```
Çok-ajanlı verification chain
  + Bağımsız adversarial review (kategorik)
  + İnsan onay kapısı (kaldırılamaz)
  + Açıklanabilirlik yüzeyi (per-stage reasoning + confidence)
  + Bakkal-persona dil + scaffold portability
  + Persistent audit trail (NFR-1)
```

Literatürdeki her motif tek tek var; ama **bütünlüklü olarak bu kombinasyonu sunan bir referans çalışma yok**.

### 2.4.2 AKIS'in literatüre operasyonel katkısı

- **TRiSM motiflerini somut UI'ya bağlama** — confidence skor → user-visible badge; reasoning → user-readable card; finding → category icon + Türkçe açıklama.
- **Bakkal-persona için XAI** — XAI literatürü çoğunlukla geliştirici/uzman hedefli; bakkal için açıklanabilirlik (NFR-5) literatürde temsil edilmiyor.
- **Test-as-trust-signal** — Trace çıktısının "X/Y test geçti" güven mesajı olarak görselleştirilmesi (regression report — FR-9.3).

### 2.4.3 Tezin literatür konumlandırması (özet)

> AKIS, çok-ajanlı yazılım üretim literatüründe (Bölüm 2.1) tanımlı motifleri (adversarial review, self-refinement, HOTL, XAI) **bakkal-persona için bütünlüklü bir ürün** olarak somutlaştırır. Yazılım kalite literatürünün (2.2) bulgularını (LLM çıktısı sistemik bug üretiyor — Sabra & Tyler) operasyonel olarak adresleyen bir mimari sunar. Non-developer AI tools (2.3) lane'inde **kalite+regression sinyali** boyutunda hiçbir araç şu an yer almıyor — AKIS bu boşluğu doldurur.

---

## Yazım notları

- Her alt-bölüm başında **1-cümle tezi tekrar** (örn. "Bu eksende AKIS'in literatürdeki konumu şudur: ...").
- Türkçe terimler İngilizce orijinaliyle ilk geçtiği yerde birlikte verilir (örn. "adversarial review (çekişmeli inceleme)").
- Tablo formatı tutarlı (TBL-2, TBL-3 aynı sütun yapısı): motif | kaynak | AKIS karşılığı | durum.

---

## Kabul kriterleri (bu doc için)

- [ ] 2.1 → ≥ 5 farklı multi-agent/orkestrasyon kaynağı
- [ ] 2.2 → LLM kalite çalışmaları + test generation literatürü
- [ ] 2.3 → ≥ 4 farklı lane (geliştirici / vibe / no-code / AKIS) karşılaştırma
- [ ] 2.4 → AKIS'in unique kombinasyonu cümleyle ifade edildi
- [ ] Tüm referanslar `[CITE-*]` placeholder'ı + bibliography'de mevcut

## Placeholder'lar (grep edilebilir)

- `[CITE-*]` — yaklaşık 25+ referans yer tutucusu (MetaGPT, AutoGen, ChatDev, Du2023, SelfRefine, Reflexion, TRiSM, FORGE26, Sabra2025, Sonar2026, Sherlock2026, Qodo2025, McKinsey2026, METR2025, METR2026, TestGenLLM, CodaMosa, AthenaTest, North2006, Adzic, Codex, Bolt, Replit, V0, Lovable, Cursor, Copilot, ClaudeCode, Devin, ASDLC, SentinelOne, HOTL, TrustAgent2026, Gartner2026 ...)
- `[TBL-2]`, `[TBL-3]` — karşılaştırma tabloları
