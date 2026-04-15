# PLAN C — LEARNINGS & KNOWLEDGE BASE

## CONTEXT
Her pipeline run'indan sonra agent'larin ogrendiklerini biriktiren bir knowledge base olusturulacak. Bu Addy Osmani'nin AGENTS.md pattern'i. Ayrica AKIS'in Level 3 mimarisini dokumante eden bir architecture doc yazilacak.

## FORBIDDEN RULES
- .env dosyalarina DOKUNMA
- `docs/learnings/` ve `docs/architecture/` DISINDA dosya olusturma veya degistirme
- Kod dosyalarina DOKUNMA

## ADIM 0 — DISCOVERY
```bash
cd ~/Projects/bitirme_projesi/akis-platform-devolopment/devagents
cat CLAUDE.md
ls docs/
cat backend/src/pipeline/agents/scribe/ScribeAgent.ts | head -50
cat backend/src/pipeline/agents/proto/ProtoAgent.ts | head -50
cat backend/src/pipeline/agents/trace/TraceAgent.ts | head -50
```

## ADIM 1 — Learnings Dizin Yapisi
```
docs/learnings/
├── SCRIBE_LEARNINGS.md
├── PROTO_LEARNINGS.md
├── TRACE_LEARNINGS.md
├── CRITIC_LEARNINGS.md
├── PIPELINE_LEARNINGS.md
└── CONVENTIONS.md
```

## ADIM 2 — Her agent icin LEARNINGS.md sablonu olustur
Her dosya su bolumleri icersin:
```markdown
# [Agent Adi] — Accumulated Learnings

> Bu dosya pipeline run'larindan ogrenilen pattern'lari, hatalari ve cozumleri biriktirir.
> Her basarili/basarisiz run sonrasi guncellenir.

## Known Good Patterns
<!-- Hangi prompt pattern'lari iyi sonuc veriyor? -->

## Known Failure Modes
<!-- Hangi durumlarda fail oluyor? Kok sebep neydi? -->

## Workarounds & Fixes
<!-- Bulunan gecici veya kalici cozumler -->

## Quality Baselines
<!-- Ortalama guven skoru, ortalama sure, ortalama dosya sayisi vb. -->

## Convention Notes
<!-- Bu agent icin ozel kurallar, kisitlamalar -->
```

## ADIM 3 — CONVENTIONS.md
AKIS genelinde gecerli kurallar:
- Naming conventions (dosya, branch, commit)
- Agent communication contract formati
- Error handling pattern'lari
- JSON parse guvenlik zinciri: extractJsonSafe -> sanitizeJsonControlChars -> repairTruncatedJson
- Temperature policy: generation=0, fix-loop'ta 0.1 increment
- Timeout policy: Scribe/Proto 5dk, Trace 10dk

## ADIM 4 — Architecture Decision Records
`docs/architecture/` dizini olustur:
```
docs/architecture/
├── ADR-001-adversarial-review.md
├── ADR-002-fix-loop-pattern.md
├── ADR-003-holdout-testing.md
└── ADR-004-level3-pipeline-architecture.md
```

Her ADR su formatta:
```markdown
# ADR-XXX: [Baslik]

## Durum
Kabul Edildi — [Tarih]

## Baglam
[Neden bu karar gerekti?]

## Karar
[Ne kararlastirildi?]

## Sonuclar
[Artilari, eksileri, trade-off'lar]

## Referanslar
[Arastirma kaynaklari: StrongDM, HubSpot Sidekick, METR 2025, LLMloop, Reflexion vb.]
```

### ADR-001: Adversarial Review
- Baglam: AI-generated output'lari AI ile review etmek (Shapiro Level 3)
- Karar: Her pipeline stage arasina CriticAgent ekle, fresh LLM session'da review yap
- Referans: HubSpot Sidekick (90% faster feedback), SentinelOne adversarial consensus, ASDLC.io pattern

### ADR-002: Fix Loop Pattern
- Baglam: Trace fail -> Proto duzelt dongusu (self-healing pipeline)
- Karar: Max 3 iterasyon, temperature escalation (0 -> 0.1 -> 0.2)
- Referans: LLMloop (ICSME 2025), StrongDM holdout testing

### ADR-003: Holdout Testing
- Baglam: Trace'in testlerini Proto'dan gizlemek (ML train/test split analojisi)
- Karar: Trace testleri ayri tutulur, Proto bu testleri gormez, sadece spec'i gorur
- Referans: StrongDM NLSpec, ML holdout validation

### ADR-004: Level 3 Pipeline Architecture
- Baglam: AKIS'in Shapiro Level 2'den Level 3'e gecisi
- Karar: Scribe -> CriticSpec -> Human Gate -> Proto -> CriticCode -> Trace -> FixLoop
- Yeni pipeline FSM state'leri: critic_reviewing_spec, critic_reviewing_code, fix_loop_iteration_N

## ADIM 5 — Dogrulama
Tum markdown dosyalarinin syntax'ini kontrol et. Kirik linkler var mi?

## STATUS REPORT
`docs/plans/REPORT_C_KNOWLEDGE.md` olarak kaydet.
