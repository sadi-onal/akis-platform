# PLAN A — CRITIC AGENT

## CONTEXT
AKIS pipeline'a inter-stage adversarial review eklenecek. CriticAgent, diger agent'larin ciktilarini AYRI bir LLM session'inda (fresh context) review eder. Bu "AI reviewing AI" pattern'idir ve tezin "Knowledge Integrity & Agent Verification" temasini dogrudan guclendirir.

## FORBIDDEN RULES
- .env dosyalarina DOKUNMA
- `backend/src/pipeline/agents/critic/` DISINDA dosya olusturma veya degistirme
- PipelineOrchestrator.ts'ye DOKUNMA (entegrasyon ayri yapilacak)
- PipelineTypes.ts'ye DOKUNMA (entegrasyon ayri yapilacak)
- Mevcut agent dosyalarina DOKUNMA

## ADIM 0 — DISCOVERY
```bash
cd ~/Projects/bitirme_projesi/akis-platform-devolopment/devagents
cat CLAUDE.md
cat backend/src/pipeline/core/contracts/PipelineTypes.ts
cat backend/src/pipeline/agents/scribe/ScribeAgent.ts
cat backend/src/pipeline/agents/proto/ProtoAgent.ts
cat backend/src/services/ai/AIService.ts | head -100
```
Mevcut agent yapisini, tip tanimlarini ve AIService interface'ini anla.

## ADIM 1 — CriticAgent Dosya Yapisi
`backend/src/pipeline/agents/critic/` dizini olustur:
```
critic/
├── CriticAgent.ts          <- Ana agent sinifi
├── CriticTypes.ts          <- Input/Output tipleri
├── prompts/
│   ├── spec-review.ts      <- Scribe ciktisini review eden prompt
│   └── code-review.ts      <- Proto ciktisini review eden prompt
└── __tests__/
    ├── CriticAgent.test.ts
    └── prompts.test.ts
```

## ADIM 2 — CriticTypes.ts
```typescript
// CriticTypes.ts

export interface CriticReviewInput {
  /** Ne review ediliyor: 'spec' veya 'code' */
  reviewType: 'spec_review' | 'code_review';
  /** Review edilecek artifact (Scribe'in spec'i veya Proto'nun kodu) */
  artifact: unknown;
  /** Orijinal kullanici fikri (baglam icin) */
  originalIdea: string;
  /** Eger code_review ise, spec de gerekli (compliance check icin) */
  referenceSpec?: unknown;
}

export interface CriticFinding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  category: 'completeness' | 'ambiguity' | 'consistency' | 'testability' | 'spec_compliance' | 'security';
  description: string;
  suggestion: string;
  /** Hangi bolumle ilgili */
  location?: string;
}

export interface CriticReviewOutput {
  approved: boolean;
  overallScore: number;        // 0-100
  findings: CriticFinding[];
  summary: string;
  reviewType: 'spec_review' | 'code_review';
  /** Kacinci review iterasyonu */
  iteration: number;
}
```

## ADIM 3 — Spec Review Prompt
`prompts/spec-review.ts` — Scribe'in urettigi StructuredSpec'i review eden prompt yaz.

Review kriterleri (agirlikli skor):
1. **Completeness (0.25)**: Problem statement, user stories, AC'ler, technical constraints, out of scope — hepsi var mi?
2. **Ambiguity (0.25)**: Her AC acik ve tek anlama mi geliyor? "Uygun" gibi belirsiz kelimeler var mi?
3. **Testability (0.20)**: Her AC Given/When/Then formatinda mi? Trace bunlari otomatik teste cevirebilir mi?
4. **Consistency (0.15)**: User story'ler birbiriyle celisiyor mu? AC'ler arasi cakisma var mi?
5. **Technical Feasibility (0.15)**: Spec'teki teknik kisitlar mantikli mi? Over-engineering var mi?

Prompt'un system kismi:
- "Sen bir BAGIMSIZ spec reviewer'sin. Bu spec'i SEN yazmadin. Amacin bulabildigin her problemi bulmak."
- "Spec'i ureten agent ile AYNI context'te DEGILSIN. Fresh eyes ile bakiyorsun."
- JSON formatinda CriticReviewOutput dondur.

Esik: `overallScore >= 75` -> approved: true, aksi halde approved: false

## ADIM 4 — Code Review Prompt
`prompts/code-review.ts` — Proto'nun urettigi kodu Scribe'in spec'ine karsi review eden prompt yaz.

Review kriterleri:
1. **Spec Compliance (0.35)**: Her AC icin kod karsiligi var mi? Spec'te olan ama kodda olmayan ne var?
2. **Code Quality (0.20)**: TypeScript best practices, error handling, type safety
3. **Security (0.20)**: Input validation, injection riskleri, hardcoded secrets
4. **Completeness (0.15)**: Import'lar dogru mu? Dosya yapisi tutarli mi?
5. **Testability (0.10)**: Bu kodu Trace test yazabilir mi? Mock'lanabilir mi?

## ADIM 5 — CriticAgent.ts
Ana agent sinifini yaz:
- Constructor: `AIService` injection alir (mevcut pattern'i takip et)
- `reviewSpec(input: CriticReviewInput): Promise<CriticReviewOutput>`
- `reviewCode(input: CriticReviewInput): Promise<CriticReviewOutput>`
- Her review AYRI bir Claude API call'u — fresh context, onceki agent'in conversation history'si YOK
- `temperature: 0` kullan (deterministik review)
- JSON parse icin mevcut `extractJsonSafe` + `sanitizeJsonControlChars` utility'lerini import et (from `../../core/json-extract.js`)

## ADIM 6 — Testler
- `CriticAgent.test.ts`: MockAIService ile spec_review ve code_review senaryolari
- Mock fixture'lar: iyi bir spec (approved olmali), kotu bir spec (rejected olmali), iyi kod, kotu kod
- En az 8 test case

## ADIM 7 — Dogrulama
```bash
cd backend && pnpm typecheck
cd backend && pnpm test:unit -- --testPathPattern="critic"
```
Her ikisi de PASS etmeli. Etmezse duzelt, tekrar calistir.

## STATUS REPORT
Isin bittiginde su formatta bir rapor yaz:
```
## AGENT A — CRITIC AGENT RAPORU
- Durum: TAMAMLANDI / BASARISIZ
- Olusturulan dosyalar: [liste]
- Test sonuclari: X/Y passing
- Typecheck: PASS/FAIL
- Notlar: [varsa]
```
Bu raporu `docs/plans/REPORT_A_CRITIC.md` olarak kaydet.
