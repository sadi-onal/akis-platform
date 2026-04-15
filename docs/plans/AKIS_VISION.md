# AKIS — Vizyon, Kültür ve Stratejik Yol Haritası

> **Bu doküman AKIS'in resmi vizyon ve strateji belgesidir. Proje genelinde referans olarak kullanılır.**
> **Son güncelleme: 15 Nisan 2026 | Sürüm: 1.0**

---

## 1. VİZYON

> *AKIS, AI çıktılarının doğrulandığı, denetlendiği ve güvenilir hale getirildiği platformdur. AI'ı insanın yerine değil, yanına konumlandırıyoruz.*

**Üç temel ilke:**
- AI üretir, AI denetler, insan karar verir.
- Şeffaflık varsayılandır: güven skoru, doğrulama zinciri, izlenebilirlik matrisi her adımda görünür.
- Doğrulama, üretimden daha değerlidir (Verification > Generation).

---

## 2. PROBLEM: AI GÜVEN KRİZİ

| Kaynak | Bulgu |
|--------|-------|
| METR 2025 (arXiv:2507.09089) | Geliştiriciler AI ile %19 yavaşladı, ama %24 hızlandıklarını sandı. %43'lük algı-gerçeklik uçurumu. |
| Sabra & Tyler 2025 (arXiv:2508.14727) | 4.442 görevde LLM'ler sistematik olarak bug, güvenlik açığı ve kod kokusu üretmektedir. |
| Qodo 2025 | 6+ AI aracı kullanan ekiplerin yalnızca %28'i AI kodundan emin. AI review loop'u 3.5x kalite artışı sağlıyor. |
| McKinsey 2026 | Yalnızca üst %20 anlamlı sonuç elde ediyor. Araç yetmez, süreç dönüşümü şart. |

---

## 3. AKIS ÇÖZÜMÜ: DOĞRULAMA ZİNCİRİ

```
Scribe → CriticSpec → İnsan Kapısı → Proto → CriticCode → Trace → FixLoop → Completed
```

**Bilimsel temeller:**
- Adversarial Review (ASDLC.io, SentinelOne)
- Self-Refine & Reflexion (NeurIPS 2023, %88 pass@1)
- TRiSM Framework (Gartner/ScienceDirect 2026)
- Trustworthy Agentic AI Pipelines (2026)
- Human-on-the-Loop adaptive autonomy

---

## 4. KÜLTÜR

> *Pergelin ayağını insana koy. Çizeceğin daire onun etrafında şekillenecek.*

| İlke | AKIS Karşılığı |
|------|---------------|
| AI araçtır, amaç değil | Pipeline kaliteyi ölçer, AI kullanım oranını değil |
| İnsan karar verici | Human Approval Gate kaldırılamaz |
| Çelişkiler normaldir | CriticAgent çelişkileri bulur, puanlar, raporlar |

---

## 5. GELİŞTİRİLMESİ GEREKEN TEKNOLOJİLER

1. **Deterministic Anchoring** — AST tabanlı halüsinasyon tespiti (%100 precision, %87.6 recall)
2. **Explainability Interface** — Her agent kararının gerekçesi
3. **Confidence-Based Adaptive Autonomy** — Güven skoru tabanlı uyarlanabilir otonomi
4. **Persistent Learning** — Kalıcı öğrenme sistemi (pgvector + DSPy)
5. **Güvenlik Odaklı İterasyon Kontrolü** — No-regression gate
6. **Domain-Agnostic Verification** — ACP ile alan bağımsız doğrulama

---

## 6. STRATEJİK YOL HARİTASI

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

## 7. REKABETÇİ KONUMLANDIRMA

| | Cursor/Copilot | Bolt.new | Devin | **AKIS** |
|---|---|---|---|---|
| Güven mekanizması | Yok | Yok | Minimal | **Çok katmanlı doğrulama** |
| Şeffaflık | Kara kutu | Kara kutu | Kara kutu | **Güven skoru + izlenebilirlik** |
| İnsan rolü | Kod yazıcı | Onaylayıcı | İzleyici | **Karar verici** |

---

*Bu doküman yaşayan bir dokümandır. Her büyük AKIS güncellemesiyle birlikte revize edilecektir.*

*Tam sürüm için bkz: `docs/AKIS_Vizyon_Kultur_Strateji.docx`*
