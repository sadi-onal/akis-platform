# ADR-001: Adversarial Review (Critic Agent)

## Status
Kabul Edildi -- 2026-04-14

## Context
AKIS pipeline'inda AI agent'lar (Scribe, Proto, Trace) output uretir. Bu output'larin kalitesini
dogrulamanin tek yolu su anda human-in-the-loop gate'dir (Scribe sonrasi spec onaylama). Ancak:

1. **Uretici bias:** Bir LLM'in kendi output'unu degerlendirmesi inherent olarak biased'dir.
   Ayni session/context icinde uretilen output, ayni model tarafindan "iyi" olarak degerlendirilir.

2. **Human bottleneck:** Kod review'u insana birakmak pipeline'i yavaslattir ve teknik
   bilgi gerektirir. Proto'nun 10+ dosyalik scaffold'unu kullanicinin satir satir incelemesi
   pratik degildir.

3. **Verification gap:** Proto --> Trace arasinda code quality check yok. Trace, hatali
   kod uzerine test yazmaya calisabilir.

4. **Tez temasi:** "Knowledge Integrity & Agent Verification" -- agent'larin birbirini
   dogrulamasi projenin akademik motivasyonudur.

Arastirma kaynaklari bu probleme "adversarial review" veya "multi-agent consensus" olarak
yaklasir:
- SentinelOne: adversarial consensus ile AI-generated kodun guvenlik review'u
- HubSpot Sidekick: AI review ile gelistirici feedback suresi %90 azaldi
- ASDLC.io: AI Software Development Lifecycle pattern'inda her asama review icerir

## Decision
Her pipeline stage arasina bir **CriticAgent** yerlestirilecek. Critic, bagimsiz (fresh)
bir LLM session'inda output'u review eder.

### Uygulama Detaylari

**Pipeline Flow (Level 3):**
```
Scribe --> CriticSpec --> Human Gate --> Proto --> CriticCode --> Trace --> FixLoop
```

**Critic Ozellikleri:**
1. **Fresh session:** Her review icin sifirdan LLM session acar. Uretici agent'in
   conversation history'sinden izole.

2. **Spec Review (CriticSpec):**
   - Completeness (gerekli alanlar dolu mu?)
   - Consistency (user story + AC tutarliligi)
   - Feasibility (teknik kisitlamalar altinda uygulanabilir mi?)
   - Ambiguity detection (belirsiz ifadeler)

3. **Code Review (CriticCode):**
   - Spec compliance (her AC bir dosyayla eslesiyor mu?)
   - Import integrity (kirik import'lar)
   - Dependency completeness
   - Code quality (console.log, inline style, TODO/FIXME)

4. **Severity levels:**
   - BLOCKER: Pipeline durur, fix gerekli
   - WARNING: Log'a kaydedilir, pipeline devam eder
   - INFO: Yalnizca bilgilendirme

5. **Max review iterations:** 2 (sonsuz dongu onlemi)

**Yeni FSM State'leri:**
- `critic_reviewing_spec` (Scribe --> Critic)
- `critic_reviewing_code` (Proto --> Critic)

## Consequences

### Artilari
- AI-generated output kalitesi artar (ikinci goz prensibi)
- Human review yuku azalir (Critic on-filtreleme yapar)
- Verification chain tez temasini guclendirir: Scribe --> Critic --> Human --> Proto --> Critic --> Trace
- Pipeline reliability artar (hatali kod Trace'e ulasmadan yakalanir)

### Eksileri
- Pipeline suresi artar (her Critic review ~15-30s)
- API maliyeti artar (ek LLM call'lar)
- False positive riski: gecerli output gereksiz reddedilebilir
- Karmasiklik artar (yeni FSM state'leri, yeni agent)

### Trade-off'lar
- Hiz vs. kalite: Pipeline ~30-60s daha yavas, ama output kalitesi olculebilir sekilde artar
- Maliyet vs. guvenilirlik: Her pipeline run'i 2 ek API call, ama failed pipeline orani duser
- Karmasiklik vs. dogrulanabilirlik: Daha fazla kod, ama tez icin daha guclu verification narrative

## References
- **SentinelOne**: Adversarial consensus for AI-generated code security review
- **HubSpot Sidekick**: AI review reducing developer feedback time by 90%
- **ASDLC.io**: AI Software Development Lifecycle -- review at every stage
- **METR 2025**: Measuring AI agent capabilities, evaluation framework for multi-agent systems
- **Shapiro Level 3**: Human-AI collaboration maturity model -- AI reviews AI with human oversight
