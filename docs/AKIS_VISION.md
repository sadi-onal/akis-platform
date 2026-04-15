# AKIS Platform — Vizyon & Strateji Belgesi

> **Bu doküman AKIS'in resmi vizyon ve strateji belgesidir. Proje genelinde referans olarak kullanılır.**
> **Sürüm: 2.0 | 2026-04-15**

---

## 1. VİZYON

> *Herkesin kendi AI mühendis ekibini kurabildiği platform.*

**Misyon:** Yazılım geliştirmeyi demokratize etmek — teknik bilgi barajını kaldırarak her fikir sahibini ürün sahibi yapmak.

**Slogan:** *Mühendisini kirala. Fikrini söyle. Ürününü al.*

---

## 2. PERGEL İLKESİ (Compass Principle)

> *Pergelin sabit ucu her zaman insan niyetine basar. AI bunun etrafında döner ama merkez yerinden oynamaz.*

**Üç Sütun:**

| # | Sütun | Açıklama |
|---|-------|----------|
| 1 | **Niyet Sadakati** | AI çıktısı kullanıcının niyetine sadık kalmalı |
| 2 | **Cesaretlendirici Teknoloji** | Teknik bilgi eksikliği engel olmamalı |
| 3 | **Çıktı Satmak** | Kullanıcı araç değil sonuç satın alır |

---

## 3. PROBLEM: AI GÜVEN KRİZİ

| Kaynak | Bulgu |
|--------|-------|
| METR 2025 (arXiv:2507.09089) | Geliştiriciler AI ile %19 yavaşladı, ama %24 hızlandıklarını sandı. %43'lük algı-gerçeklik uçurumu. |
| Sabra & Tyler 2025 (arXiv:2508.14727) | 4.442 görevde LLM'ler sistematik olarak bug, güvenlik açığı ve kod kokusu üretmektedir. |
| Qodo 2025 | 6+ AI aracı kullanan ekiplerin yalnızca %28'i AI kodundan emin. AI review loop'u 3.5x kalite artışı sağlıyor. |
| McKinsey 2026 | Yalnızca üst %20 anlamlı sonuç elde ediyor. Araç yetmez, süreç dönüşümü şart. |

---

## 4. AKIS ÇÖZÜMÜ: DOĞRULAMA ZİNCİRİ

```
Scribe → CriticSpec → İnsan Kapısı → Proto → CriticCode → Trace → FixLoop → Completed
```

**Bilimsel Temeller:**
- Adversarial Review (ASDLC.io, SentinelOne)
- Self-Refine & Reflexion (NeurIPS 2023, %88 pass@1)
- TRiSM Framework (Gartner/ScienceDirect 2026)
- Trustworthy Agentic AI Pipelines (2026)
- Human-on-the-Loop adaptive autonomy

---

## 5. REKABETÇİ KONUMLANDIRMA

| Özellik | AKIS | Cursor | Devin | Freelancer |
|---------|------|--------|-------|------------|
| Fikir → Ürün | Tam | Hayır | Kısmi | Manuel |
| AI Doğrulama | Otomatik | Yok | Sınırlı | Yok |
| İnsan Kontrolü | Her adımda | Yok | Sınırlı | Tam |
| Maliyet Modeli | Dakika bazlı | Aylık | Aylık | Proje bazlı |
| Şeffaflık | Açıklanabilir AI | Kara kutu | Kara kutu | Değişken |

---

## 6. FİYATLANDIRMA

| Plan | Fiyat | İş/Gün | Token/Ay | Agent | Hedef Kitle |
|------|-------|--------|----------|-------|-------------|
| Free | $0 | 3 | 20K | 1 | Keşfetmek isteyenler |
| Builder | $29/ay | 25 | 500K | 3 | Solo geliştiriciler |
| Team | $99/ay | Sınırsız | 2M | 5 | Takımlar |
| Pay-as-you-go | $0.017/dk | Sınırsız | Sınırsız | 5 | Proje bazlı |

---

## 7. KÜLTÜR

> *Pergelin ayağını insana koy. Çizeceğin daire onun etrafında şekillenecek.*

| İlke | AKIS Karşılığı |
|------|---------------|
| AI araçtır, amaç değil | Pipeline kaliteyi ölçer, AI kullanım oranını değil |
| İnsan karar verici | Human Approval Gate kaldırılamaz |
| Çelişkiler normaldir | CriticAgent çelişkileri bulur, puanlar, raporlar |

---

## 8. GELİŞTİRİLMESİ GEREKEN TEKNOLOJİLER

1. **Deterministic Anchoring** — AST tabanlı halüsinasyon tespiti (%100 precision, %87.6 recall)
2. **Explainability Interface** — Her agent kararının gerekçesi
3. **Confidence-Based Adaptive Autonomy** — Güven skoru tabanlı uyarlanabilir otonomi
4. **Persistent Learning** — Kalıcı öğrenme sistemi (pgvector + DSPy)
5. **Güvenlik Odaklı İterasyon Kontrolü** — No-regression gate
6. **Domain-Agnostic Verification** — ACP ile alan bağımsız doğrulama

---

## 9. STRATEJİK YOL HARİTASI

### Horizon 1: Şimdi → Tez (6 hafta)
- Level 3 mimarisini teze ekle
- Dogfooding demo
- AST validation prototip
- Staging deploy

### Horizon 2: Tez Sonrası → 6 Ay
- Multi-provider AI, ödeme, SaaS lansmanı
- Explainability interface
- Adaptive autonomy
- ACP v0.1

### Horizon 3: 6 Ay → 2 Yıl
- Persistent learning (pgvector + DSPy)
- Domain-agnostic doğrulama
- ACP ekosistemi
- Self-evolving workflows

---

*Bu doküman yaşayan bir dokümandır. Her büyük AKIS güncellemesiyle birlikte revize edilecektir.*
