# ADR-004: Level 3 Pipeline Architecture

## Status
Kabul Edildi -- 2026-04-14

## Context
AKIS platformu su anda Shapiro maturity model'ine gore **Level 2** seviyesinde calisir:
- AI agent'lar (Scribe, Proto, Trace) sequential pipeline'da output uretir
- Insan-in-the-loop gate (spec onaylama) tek dogrulama noktasidir
- Agent'lar birbirini dogrulamaz, sadece sirali calisir

### Shapiro Maturity Levels (AI-Human Collaboration)
- **Level 1:** AI asistan -- insan yonetir, AI yardim eder
- **Level 2:** AI isci -- AI uretir, insan denetler (AKIS su an)
- **Level 3:** AI takim -- AI'lar birbirini denetler, insan son karar verir (HEDEF)
- **Level 4:** AI otonom -- AI bagimisiz calisir, insan sadece gozlemler

Level 2'den Level 3'e gecis icin gereklilikler:
1. AI-generated output'larin AI tarafindan review edilmesi (ADR-001)
2. Test failure sonrasi otomatik fix dongusu (ADR-002)
3. Uretici ve dogrulayici arasinda bilgi bariyeri (ADR-003)
4. Olculebilir kalite metrikleri

Tez temasi "Knowledge Integrity & Agent Verification" bu gecisi merkeze koyar.

## Decision
AKIS pipeline'i asagidaki **Level 3 mimarisine** yukseltilecek.

### Level 2 (Mevcut)
```
Scribe --> [Human Approval] --> Proto --> Trace --> completed/failed
```

### Level 3 (Hedef)
```
Scribe
  |
  v
CriticSpec (adversarial review)
  |
  v
[Human Approval Gate]
  |
  v
Proto
  |
  v
CriticCode (adversarial review)
  |
  v
Trace
  |
  v
[Test Results]
  |
  +---> All pass --> completed
  |
  +---> Some fail --> Fix Loop (max 3 iterations)
                        |
                        +---> Proto fix (temperature escalation)
                        |
                        +---> Trace re-test
                        |
                        +---> Loop or completed_partial
```

### Yeni FSM State'leri
Mevcut state'lere ek olarak:
```
Mevcut:
  scribe_clarifying --> scribe_generating --> awaiting_approval
  --> proto_building --> trace_testing --> completed | completed_partial

Eklenen:
  scribe_generating --> critic_reviewing_spec --> awaiting_approval
  proto_building --> critic_reviewing_code --> trace_testing
  trace_testing --> fix_loop_iteration_1 --> trace_retesting_1
  trace_retesting_1 --> fix_loop_iteration_2 --> trace_retesting_2
  trace_retesting_2 --> fix_loop_iteration_3 --> trace_retesting_3
  trace_retesting_3 --> completed_partial
```

### Verification Chain (Tam Zincir)
```
1. Scribe spec uretiyor
2. CriticSpec spec'i review ediyor (AI --> AI verification)
3. INSAN spec'i onayliyor (human-in-the-loop)
4. Proto kod uretiyor
5. CriticCode kodu review ediyor (AI --> AI verification)
6. Trace test yaziyor (holdout -- Proto'nun stratejisini bilmeden)
7. Testler otomatik calisip dogruluyor (automated verification)
8. Fail ise: Fix Loop (AI self-repair, temperature escalation)
```

Bu zincir 4 katmanli dogrulama saglar:
- **AI-AI (Critic):** Uretici agent'in output'unu bagimsiz AI review eder
- **AI-Human (Gate):** Insan son karari verir
- **AI-AI (Trace):** Kod, bagimsiz test agent'i tarafindan dogrulanir
- **AI-Self (Fix Loop):** Hata durumunda iteratif duzeltme

### Metrik Toplama
Her pipeline run'i icin toplanacak metrikler:
- Critic pass/fail oranlari (spec ve code icin ayri)
- Critic'in yakaladigi hata kategorileri
- Fix loop iteration sayisi (ortalama)
- Fix loop basari orani (kac pipeline fix ile tamamlandi?)
- Pipeline toplam suresi (Level 2 vs Level 3 karsilastirmasi)
- API maliyet artisi (ek Critic + Fix Loop call'lari)

## Consequences

### Artilari
- Cok katmanli dogrulama zinciri (tez icin guclu arguman)
- Olculebilir kalite iyilestirmesi (Level 2 vs Level 3 metrikleri)
- Self-healing pipeline (kullanici muedahalesi azalir)
- Akademik katkisi: Shapiro Level 3'un pratik implementasyonu
- Verification integrity: holdout + adversarial + human gate

### Eksileri
- Pipeline suresi onemli olcude artar (~1-3 dk ek)
- API maliyeti ~2-3x artar (Critic + Fix Loop)
- Kod karmasikligi artar (yeni agent, yeni state'ler, yeni test'ler)
- Debug zorlugu artar (daha fazla moving part)
- Deployment riski: buyuk mimari degisiklik, regression riski

### Trade-off'lar
- Basitlik vs. dogrulanabilirlik: Daha karmasik ama olculebilir sekilde daha guvenilir
- Hiz vs. kalite: Pipeline yavaslıyor ama output kalitesi artiyor
- Maliyet vs. otomasyon: Daha fazla API call ama daha az insan muedahalesi
- Akademik deger vs. pratik basitlik: Tez icin guclu ama overengineering riski

### Migration Stratejisi
1. **Fase 1:** CriticAgent implementasyonu + unit test'ler
2. **Fase 2:** Pipeline FSM'e critic state'leri ekleme
3. **Fase 3:** Fix Loop implementasyonu
4. **Fase 4:** Metrik toplama + Level 2 vs Level 3 karsilastirma
5. **Fase 5:** Production deployment + A/B testing (isteye bagli)

## References
- **Shapiro Maturity Model**: Human-AI collaboration levels (Level 1-4)
- **HubSpot Sidekick**: AI review reducing developer feedback time by 90%
- **SentinelOne**: Adversarial consensus for multi-agent verification
- **METR 2025**: Measuring AI agent capabilities -- evaluation framework
- **LLMloop (ICSME 2025)**: Iterative code repair with test feedback
- **Reflexion**: LLM self-reflection pattern for iterative improvement
- **StrongDM**: Holdout testing + NLSpec for spec-driven verification
- **ASDLC.io**: AI Software Development Lifecycle -- review at every stage
- **ADR-001**: Adversarial Review (this project)
- **ADR-002**: Fix Loop Pattern (this project)
- **ADR-003**: Holdout Testing (this project)
