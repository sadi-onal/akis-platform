# AKIS Platform — Mimari Değerlendirme ve Trend Karşılaştırması

Tarih: 2026-05-23

## Genel Yapı

AKIS, **Scribe → Proto → Trace** zincirini state-machine olarak yürüten bir "orchestrator + workers" mimarisi.
Üstüne **Critic** (evaluator-optimizer) + **fix-loop** (3 iterasyon, temperature escalation) + **explainability service** + **SSE event bus** + **MCP gateway** ekli.

## Anthropic "Building Effective Agents" Pattern Hizalaması

| Pattern | AKIS'te durum |
|---|---|
| Prompt chaining | ✓ Scribe→Proto→Trace |
| Orchestrator–workers | ✓ `PipelineOrchestrator` + alt agent'lar |
| Evaluator–optimizer | ✓ Critic (spec+code), skor eşiği |
| Routing | ~Kısmî (per-phase model slot'ları) |
| Parallelization | ✗ Yok (sıralı zincir) |

## Güçlü Yönler (2026 trendleriyle uyumlu)

- **MCP adoption (GitHub+Jira)** — 2025 standardı, erken benimsenmiş
- **Skills (SkillLoader)** — Anthropic Skills modeline paralel, composable agent capability
- **Prompt caching** — maliyet disiplini
- **Per-pipeline lock + state machine** — LangGraph felsefesiyle aynı
- **Explainability ayrı servis** — "show-your-work" trendi
- **SSE + ring buffer + DB persistence + reconnection hydration** — production-grade
- **Human-in-the-loop gates** — responsible AI, kasıtlı kontrol

## Zayıf / Riskli Noktalar

1. **Çift agent katmanı** (`backend/src/agents/` legacy + `pipeline/agents/` yeni) — 4.3K + 6.5K LOC, karışıklık riski
2. **PipelineOrchestrator.ts 4.7K LOC** — god-class, state handler'lara ayrılabilir
3. **Provider abstraction iddia edilenden ince** — fiilen Anthropic + mock
4. **Fix-loop yüzeysel** — Reflexion-style natural-language reflection üretmiyor
5. **Critic skoru kalibre değil** — eşik 75, ama rubric-based multi-boyutlu değil
6. **Paralel keşif yok** — N-best candidate + Critic-as-selector mümkün ama yapılmamış
7. **Tool-calling sadece Critic'te** — Proto kod üretirken repo okuyamıyor
8. **Frontend'e token streaming yok** — sadece stage event streaming

## 2026 Bağlamında Kalibrasyon

2026'da "novelty bar" architectural novelty'den **operational maturity**'ye kaymış:
- OpenTelemetry-compatible tracing
- Evaluation frameworks + guardrails
- RLVR (Reinforcement Learning from Verifiable Rewards)

Bu eksen AKIS'in güçlü tarafı — pipeline_activities audit trail, explainability, Critic, AC coverage.

## Savunma Önerileri

- Slide deck'te workflow pattern'leri isimleriyle ver: evaluator-optimizer, orchestrator-workers, prompt chaining
- MCP + Skills'i öne çıkar
- Verification chain'i "sequential because verifiable" olarak çerçevele
- Human-in-the-loop gates = "responsible AI" söylemiyle hizalı
- Related-work paragrafında: Anthropic Building Effective Agents, OpenAI Agents SDK, LangGraph, MCP
