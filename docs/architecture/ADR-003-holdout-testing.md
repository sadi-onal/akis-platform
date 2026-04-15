# ADR-003: Holdout Testing (Train/Test Split for AI Agents)

## Status
Kabul Edildi -- 2026-04-14

## Context
AKIS pipeline'inda Proto kod uretir, Trace bu koda test yazar. Kritik soru:
**Trace, Proto'nun urettigi kodu gorebilir mi?**

Makine ogreniminde temel bir prensip: **train/test split.** Model, test verisini
egitim sirasinda gormemelidir. Aksi takdirde overfitting olur -- model ezberler,
genelleme yapamaz.

Ayni prensip AI agent'lara uygulanabilir:
- Proto, Trace'in testlerini gorurse: testleri gecmeye optimize eder, gercek kaliteyi degil
- Trace, Proto'nun implementation detail'lerini gorurse: implementation'a bagimli testler yazar,
  black-box testing prensibi ihlal edilir

Arastirma kaynaklari:
- StrongDM NLSpec: Natural language spec'ten test generation -- spec bilgisi ile, implementation bilgisi olmadan
- ML holdout validation: Test set'i training'den ayirma prensibi
- Black-box testing theory: Implementation detail'lerine bagimli olmayan test tasarimi

## Decision
Trace ve Proto arasinda **information barrier (holdout)** uygulanacak:
- Trace, Proto'nun urettigi kodu GitHub'dan okur (output'u gorur)
- Trace, Proto'nun NASIL urettigini (prompt, strategy) gormez
- Proto, Trace'in testlerini ASLA gormez
- Her iki agent de yalnizca spec'i (StructuredSpec) ortak bilgi olarak kullanir

### Uygulama Detaylari

**Information Flow:**
```
                    StructuredSpec
                    /            \
                   v              v
              Proto (code)    Trace (tests)
                   |              |
                   v              |
              GitHub repo         |
                   |              |
                   v              v
              Trace reads    Trace reads
              source code    spec only
                   |
                   v
              Test generation
              (black-box, spec-driven)
```

**Proto'nun Bilmedikleri:**
- Trace'in test dosyalari
- Trace'in test stratejisi
- Trace'in coverage matrix'i
- Onceki pipeline'lardaki test failure pattern'lari (Proto icin)

**Trace'in Bilmedikleri:**
- Proto'nun system prompt'u
- Proto'nun scaffold generation stratejisi
- Proto'nun verification report'u
- Proto'nun internal decision'lari

**Trace'in Bildikleri:**
- StructuredSpec (user stories, acceptance criteria)
- Proto'nun push ettigi kaynak kod (GitHub'dan okunan dosyalar)
- Dosya yapisi ve icerikler (read-only)

**Mevcut Implementasyon:**
Bu prensip AKIS'te zaten uygulanmaktadir:
- Proto: `ProtoGitHubDeps` -- write-only (createRepository, commitFile, pushFiles, createPR)
- Trace: `TraceGitHubDeps` -- read + write (listFiles, getFileContent + commit/push)
- Trace, spec'i input olarak alir (`TraceInput.spec?`)
- Trace, kodu GitHub'dan okur (Proto'nun prompt/strategy'sini gormez)

**Traceability Enforcement:**
Trace, her test icin hangi AC'yi cover ettigini raporlar:
```json
[
  {"criterionId": "ac-1", "testFile": "...", "testName": "...", "coverage": "full"}
]
```
Bu, testlerin spec-driven oldugunu (implementation-driven degil) garantiler.

## Consequences

### Artilari
- Test'ler implementation detail'lerine bagimli olmaz (daha robust)
- Proto "teste gore kodla" tuzagina dusmez
- Tez icin guclu "verification integrity" argumani
- ML holdout analojisi akademik yazida iyi oturur
- Regression testleri anlamli olur (spec degistiginde test degisir, implementation degistiginde degismez)

### Eksileri
- Trace bazi edge case'leri kacirir (implementation-specific hatalari goremez)
- White-box testing avantajlarindan vazgeciilir (code coverage, branch coverage)
- Trace'in kodu GitHub'dan okumasi ek latency ekler
- Spec yetersizse (eksik AC), Trace yetersiz test yazar

### Trade-off'lar
- Black-box vs. white-box: Daha az detayli ama daha anlamli testler
- Izolasyon vs. bilgi paylasimi: Daha az bilgi ama daha bagimsiz dogrulama
- Spec-driven vs. code-driven: Spec kalitesi test kalitesini dogrudan etkiler
- Academic rigor vs. practical coverage: Holdout prensibi akademik olarak guclu, pratik coverage dusebilir

## References
- **StrongDM NLSpec**: Natural language specification to test generation -- spec-driven, not implementation-driven
- **ML Holdout Validation**: Train/test split principle applied to AI agent pipelines
- **Black-box Testing Theory**: Testing without knowledge of internal implementation
- **METR 2025**: Evaluation framework -- separation of generation and verification
- **IEEE/ISTQB**: Test independence levels -- independent testing for unbiased verification
