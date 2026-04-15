# Scribe Agent -- Accumulated Learnings

> Bu dosya pipeline run'larindan ogrenilen pattern'lari, hatalari ve cozumleri biriktirir.
> Her basarili/basarisiz run sonrasi guncellenir.

## Known Good Patterns

### Effort Calibration (3-Tier)
Scribe, fikrin karmasikligina gore soru sayisini otomatik ayarlar:
- **Simple ideas** ("hesap makinesi", "todo list"): `{"ready": true}` ile direkt spec generation'a gecer. Soru sormaz.
- **Medium ideas** ("e-ticaret sitesi", "blog platformu"): 1-2 hedefli soru sorar.
- **Complex/vague ideas** ("yapay zeka ile bir sey yap"): 2-4 soru, max 3 round.

### Turkish-First Clarification
- Sorular ve aciklamalar DAIMA Turkce.
- Kullanicilar Turkce-Ingilizce teknoloji terimleri karistirabilir ("login sayfasi", "dashboard yap"). Bu normaldir, aciklama istenmez.
- Delegation ifadeleri ("sen karar ver", "sana birakiyorum", "fark etmez") tespit edilir ve reasonable defaults ile ilerler.

### Self-Interrogation Before Spec Generation
Spec generation prompt'unda 5 adimli ic kontrol:
1. Self-interrogation (5 soru, CLEAR/ASSUMED/UNKNOWN olarak isaretlenir)
2. Assumption log (HIGH-CONFIDENCE / LOW-CONFIDENCE)
3. Ambiguity score (1-5, weighted: scope 0.3, users 0.2, success 0.3, tech 0.2)
4. Ambiguity < 3.5 ise `assumptions` array'i output'a eklenir
5. Ancak bundan sonra StructuredSpec uretilir

### Partial Answer Handling
- Kullanici tum sorulari yanitmamissa, yalnizca cevaplanmayan sorular tekrar sorulur.
- Kisa/eksik cevaplar icin cikarim yapilir, sadece gercekten eksik bilgi sorulur.
- Zaten cevaplanmis sorular tekrar edilmez.

### Question Quality Standards
Her soru sunlari icerir:
- Benzersiz `id` (q1, q2...)
- Tek bir konuya odakli soru (coklu sorular degil)
- Neden onemli oldugunu aciklayan `reason`
- 2-3 somut `suggestions` (kullanici dogrudan secebilir)

### JSON Output via parseAIJson
Scribe, AI yaniti icin `parseAIJson()` kullanir (bkz. CONVENTIONS.md JSON safety chain).

## Known Failure Modes

### AI_INVALID_RESPONSE
- **Belirtiler:** AI'in dondurudugu JSON parse edilemiyor.
- **Kok sebep:** Model markdown fences icinde JSON donduruyor veya fazla metin ekliyor.
- **Sikligi:** Dusuk (parseAIJson 4-katmanli guvenlik zinciri cogu vakayii yakalar).

### SCRIBE_SPEC_VALIDATION_FAILED
- **Belirtiler:** Spec uretildi ama `isSpecMinimallyValid()` kontrolunu gecemiyor.
- **Kok sebep:** Model bos array'ler donduruyor veya zorunlu alanlar eksik.
- **Sikligi:** Orta (ozellikle cok kisa fikirler icin).

### SCRIBE_EMPTY_IDEA
- **Belirtiler:** Kullanici bos veya anlamsiz input gonderdi.
- **Kok sebep:** Frontend validasyondan kacabiliyor.
- **Recovery:** retryable=false, kullaniciya daha detayli aciklama istenir.

### Clarification Loop Stuck
- **Belirtiler:** 3 round sonra hala `ready: false`.
- **Kok sebep:** MAX_CLARIFICATION_ROUNDS=3 limiti asildi, model spec uretmeye hazir olmadigi icin.
- **Recovery:** Otomatik olarak mevcut bilgiyle spec generation'a gecilir.

## Workarounds & Fixes

### Zod Schema Validation
- `ScribeOutputSchema` ve `ScribeClarificationSchema` ile runtime validation.
- Parse hatasindan sonra retry yapilabilir (retryable=true).

### Conversation State Tracking
- `ScribeState.pendingQuestionIds` ve `answeredQuestionIds` ile hangi sorularin cevaplandigi takip edilir.
- Bu, partial answer handling'i mumkun kilar.

### Knowledge Context Injection
- `ScribeState.knowledgeContext` alani RAG-injected bilgi icerir.
- System prompt'lara eklenir, boylece domain-specific bilgi kullanilabilir.

## Quality Baselines

| Metrik | Beklenen | Notlar |
|--------|----------|--------|
| Confidence score | >= 0.75 | Ambiguity score < 3.5 ise assumptions eklenir |
| Clarification rounds | 0-3 | Simple fikirler 0, complex max 3 |
| Spec validation pass rate | > 90% | isSpecMinimallyValid() |
| JSON parse success rate | > 98% | parseAIJson() safety chain |
| Ortalama sure | < 60s | 3 round ise ~120s |

## Convention Notes

- temperature=0 (tum Scribe prompt'lari icin)
- Stage timeout: 5 dakika (RETRY_CONFIG.stageTimeoutMs)
- Max retries: 3, backoff: [5s, 15s, 30s]
- Spec validation max retries: 2 (RETRY_CONFIG.specValidationMaxRetries)
- Tum UI text'leri Turkce, teknik terimler Ingilizce kalabilir
- Output JSON: `ScribeOutput` tipi (spec, plan, rawMarkdown, confidence, clarificationsAsked)
- Scribe dogrudan Proto'yu cagirmaz -- tum iletisim PipelineOrchestrator uzerinden
