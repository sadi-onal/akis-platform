# Critic Agent -- Accumulated Learnings

> Bu dosya pipeline run'larindan ogrenilen pattern'lari, hatalari ve cozumleri biriktirir.
> Her basarili/basarisiz run sonrasi guncellenir.
>
> **STATUS: Henuz implement edilmedi -- Level 3 pipeline mimarisi icin planlanmistir.**
> **Bu dosya gelecek implementasyon icin bilgi tabanini onceden hazirlar.**

## Known Good Patterns

### Adversarial Review Principle
Critic, AI-generated output'lari bagimsiz bir AI session'da review eder:
- FRESH LLM session kullanir (onceki context'ten etkilenmez)
- Uretici agent'in bias'larindan bagimsiz degerlendirme
- Referans: SentinelOne adversarial consensus pattern

### Dual Review Points (Planned)
1. **CriticSpec** -- Scribe'in spec'ini review eder (Scribe --> CriticSpec --> Human Gate)
2. **CriticCode** -- Proto'nun kodunu review eder (Proto --> CriticCode --> Trace)

### Review Criteria (Planned)

#### Spec Review (CriticSpec)
- Completeness: Tum gerekli alanlar dolu mu?
- Consistency: User story'ler ve AC'ler birbiriyle tutarli mi?
- Ambiguity: Belirsiz ifadeler var mi?
- Feasibility: Teknik kisitlamalar altinda uygulanabilir mi?
- Scope: Out-of-scope alanlar acikca belirli mi?

#### Code Review (CriticCode)
- Spec compliance: Her AC en az bir dosyayla eslesir mi?
- Import integrity: Var olmayan dosyalara import yok mu?
- Dependency completeness: package.json tum import'lari icerir mi?
- Code quality: Console.log, inline style, TODO/FIXME var mi?
- Security: XSS, injection riskleri var mi?

### Temperature Policy (Planned)
- Review pass: temperature=0 (deterministic, strict)
- Eger fix gerekiyorsa ve fix loop'a girildiyse: temperature 0.1 increment (bkz. ADR-002)

## Known Failure Modes

### False Positive Rejection (Anticipated)
- **Belirtiler:** Gecerli spec/kod gereksiz yere reddediliyor.
- **Risk:** Pipeline throughput duser, kullanici deneyimi bozulur.
- **Onlem:** Critic'in severity threshold'lari ayarlanabilir olmali (warn vs block).

### Review Infinite Loop (Anticipated)
- **Belirtiler:** Critic reddediyor -> Agent duzeltiyor -> Critic yine reddediyor.
- **Risk:** Pipeline takilir.
- **Onlem:** Max review iteration limiti (onerilen: 2).

### Context Window Overflow (Anticipated)
- **Belirtiler:** Buyuk codebase + spec + review context context window'a sigmiyor.
- **Risk:** Critic eksik bilgiyle review yapar.
- **Onlem:** Review icin summary-based context, tam codebase degil.

## Workarounds & Fixes

### Severity-Based Gating (Planned)
- BLOCKER: Pipeline durur, fix gerekli
- WARNING: Pipeline devam eder, log'a kaydedilir
- INFO: Yalnizca bilgilendirme

### Fresh Session Isolation (Planned)
- Critic her seferinde sifirdan LLM session acar
- Uretici agent'in conversation history'sinden etkilenmez
- Bu, adversarial review'in temeldir -- "ikinci goz" prensibi

## Quality Baselines

| Metrik | Hedef | Notlar |
|--------|-------|--------|
| False positive rate | < 10% | Gecerli output gereksiz reddedilmemeli |
| Review süresi | < 30s | Critic hizli olmali, pipeline'i yavaslatmamali |
| Bug catch rate | > 50% | Bilinen hata pattern'larini yakalamali |
| Spec completeness score | > 0.8 | Review sonrasi spec kalitesi |

## Convention Notes

- temperature=0 (review icin strict, deterministic)
- Planlanan pipeline konumu: Scribe sonrasi + Proto sonrasi
- Yeni FSM state'leri: `critic_reviewing_spec`, `critic_reviewing_code`
- Critic, diger agent'lari dogrudan cagirmaz -- PipelineOrchestrator uzerinden
- Review output format: { passed: boolean, issues: Issue[], severity: 'blocker'|'warning'|'info' }
- Referanslar: ADR-001 (Adversarial Review), ADR-004 (Level 3 Architecture)
