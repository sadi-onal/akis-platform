# B5 — Feedback-Driven Proto Re-Iteration at Push Gate

**Status:** ✍️ Spec — impl bu PR'da.
**Tür:** Yeni davranış (`awaiting_push_confirm` stage'inde Proto re-trigger)
**Aciliyet:** Yüksek (bakkal güveni: kullanıcı kodu görünce "şunu değiştir" demek isterken sistem onu sessizce not olarak yutuyor)

## 1. Mevcut hâl (boşluk)

PDP-3 B4 ile push-confirm gate eklendi. Kullanıcı `awaiting_push_confirm` aşamasında **mesaj gönderirse** (örn. "yeşil renkleri pembe yap"):

- `POST /api/pipelines/:id/message` → `orchestrator.sendMessage()`
- Non-Scribe stage'lerde mesaj sadece `scribe_conversation` array'ine `user_note` olarak **kaydedilir** (`PipelineOrchestrator.ts:751-760`)
- **Pipeline state değişmez**, Proto re-trigger olmaz, kod aynı kalır
- FE "Notunuz kaydedildi" diye sessiz onay verir — kullanıcı kodun güncellendiğini sanır

**Canlı kanıt** (pipeline `d3764398-...`):
- 22:48:00 mesaj: `{"type": "user_note", "content": "yeşil renkleri pembe tonlarında yap"}`
- 22:49 itibarıyla `awaiting_push_confirm`, `protoOutput.files` 13 dosya — **aynı** (yeşil renkler hâlâ yeşil)
- Push edilse orijinal yeşil kod GitHub'a gider; kullanıcının niyeti kayboldu

## 2. Acceptance criteria

- [ ] Yeni endpoint **`POST /api/pipelines/:id/iterate-with-feedback`**
  - Body: `{ feedback: string }` (min 3 char, max 2000)
  - Auth + ownership pre-handlers (mevcut pattern)
  - Stage rejection: sadece `awaiting_push_confirm`'da kabul; aksi 400 + Türkçe açıklama
- [ ] Orchestrator method **`iterateProtoFromFeedback(pipelineId, feedback)`**
  - `withLock` (mevcut pattern) — eş zamanlı iteration imkansız
  - Stage transition: `awaiting_push_confirm` → `proto_building` → (Proto re-run dryRun) → `critic_reviewing_code` → `awaiting_push_confirm`
  - Mevcut spec aynı, sadece Proto context'ine feedback eklenir
  - `protoOutput.files` overwrite — eski versiyon DB'de kaybolur (audit yok; basit MVP)
  - Pipeline `scribe_conversation`'a `{ type: 'user_feedback', content: feedback }` ekle
- [ ] Frontend PushConfirmGate
  - "Düzelt" textarea + buton, en altta confirm/cancel'in altında
  - Buton tıklanınca endpoint çağrısı, loading state ("Kodu güncelliyorum...")
  - Mevcut `useProtoFiles` polling Sandpack'i otomatik refresh eder
  - Confirm/Cancel butonları iterate sırasında disabled
- [ ] i18n: TR + EN (chat.pushGate.feedback.* keys)
- [ ] Unit tests: yeni orchestrator method + endpoint stage rejection + lock isolation

## 3. Out of scope (kasıtlı)

- **Otomatik intent-based routing** (mesaj `/message` endpoint'inde intent classify edip FEEDBACK ise auto-iterate). Riskli: ASK ("ne kadar dosya var?") yanlış pozitif olur. Kullanıcı "Düzelt" butonuna açıkça basar — net kontrol.
- **Version history** — eski protoOutput.files'ı korumak. Şimdilik overwrite; ileride `proto_iteration_history` tablosu eklenir.
- **Trace re-run** — feedback Proto'yu değiştirir, ama Trace tests'i Proto bittikten sonra çalıştığı için mevcut akış zaten doğru.
- **Re-iteration sınırı** — kaç kere iterate edilebilir? Şimdilik sınırsız (lock ile sıralanır). 10+ iterate edersen `metrics.retryCount` yeter — sınır gerekirse bir sonraki PR.

## 4. Tech approach

### 4.1 Backend

**`backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts`** — yeni method:

```ts
async iterateProtoFromFeedback(pipelineId: string, feedback: string): Promise<PipelineState> {
  return this.withLock(pipelineId, () => this._iterateProtoFromFeedback(pipelineId, feedback));
}

private async _iterateProtoFromFeedback(pipelineId: string, feedback: string) {
  const pipeline = await this.getPipeline(pipelineId);
  this.assertStage(pipeline, 'awaiting_push_confirm');

  // Append feedback to conversation
  const conversation = [
    ...pipeline.scribeConversation,
    { type: 'user_feedback', content: feedback },
  ];

  // Transition back to proto_building
  const updated = await this.store.update(pipelineId, {
    stage: 'proto_building',
    scribeConversation: conversation,
    error: null,
  });
  this.emitEvent(pipelineId, 'stage_change', 'proto_building');

  // Re-run runProtoAndTrace with feedback context
  this.runProtoAndTrace(pipelineId, /* feedbackContext: */ feedback).catch((err) => {
    logger.error({ err, pipelineId }, '[Pipeline] Iterate from feedback failed');
  });

  return updated;
}
```

**Proto context injection:** `runProtoAndTrace` zaten `pipelineImageBlocks` ve `knowledgeContext` gibi parametre alıyor. Bir `feedbackContext` parametresi ekle; ProtoAgent.run'a system prompt'a "Kullanıcının düzeltme isteği: ..." ek olarak geç.

### 4.2 Endpoint

**`backend/src/pipeline/api/pipeline.plugin.ts`** — yeni POST route:

```ts
fastify.post(
  '/:id/iterate-with-feedback',
  { preHandler: [authPreHandler, ownershipPreHandler] },
  async (request) => routes.iterateWithFeedback(request),
);
```

**`backend/src/pipeline/api/pipeline.routes.ts`** — yeni handler:

```ts
async iterateWithFeedback(request: unknown) {
  const { id } = (request as { params: { id: string } }).params;
  await assertOwnership(request, id);
  const body = IterateFeedbackRequestSchema.parse((request as { body: unknown }).body);
  const pipeline = await orchestrator.iterateProtoFromFeedback(id, body.feedback);
  return { pipeline };
}
```

`IterateFeedbackRequestSchema`: `z.object({ feedback: z.string().min(3).max(2000) })`

### 4.3 Frontend

**`frontend/src/components/pipeline/PushConfirmGate.tsx`** — feedback subsection ekle:

```tsx
<div className="border-t pt-4 mt-4">
  <h4 className="text-sm font-medium">Bir şeyi değiştirmek ister misin?</h4>
  <p className="text-xs text-gray-500">Örn: "Renkleri pembe yap" veya "Başlığı büyült"</p>
  <textarea
    value={feedback}
    onChange={(e) => setFeedback(e.target.value)}
    placeholder="Düzeltme isteğini buraya yaz..."
    disabled={isIterating || isPushing || isCancelling}
  />
  <button
    onClick={onIterateFeedback}
    disabled={feedback.length < 3 || isIterating || isPushing || isCancelling}
  >
    {isIterating ? 'Kodu güncelliyorum...' : 'Düzelt'}
  </button>
</div>
```

**`frontend/src/services/api/workflows.ts`** — `iterateWithFeedback` API client method.

## 5. Risks

| Risk | Olasılık | Etki | Azaltıcı |
|---|---|---|---|
| Feedback çok geniş ("hepsini yeniden yap") → Proto totally regenerates, kullanıcının beğendiği parçalar kaybolur | orta | orta | Kullanıcı "Cancel" ile orijinaline dönemiyor; future: version history. Şimdilik kullanıcı bilgilendirilir (description copy). |
| AI feedback'i yanlış anlar (örn. "kırmızı yap" → değişmedi) | orta | düşük | Mevcut Critic code review sonrasındaki sonuç farklı olabilir; kullanıcı tekrar iterate eder |
| 10+ iterate → çok token tüketimi | düşük | düşük | Pipeline `metrics.tokenUsage` zaten tracked; UI gösteriyor |

## 6. Test plan

- **Backend unit** (`backend/test/unit/pipeline-feedback-iteration.test.ts`):
  - happy path: `awaiting_push_confirm` → iterate → yeni files
  - stage rejection: `completed` veya `proto_building`'da iterate çağrısı → InvalidStageError
  - feedback in conversation: `user_feedback` entry eklendi
  - lock isolation: paralel iterate çağrısı sıralı işlenir
- **Frontend component** (`frontend/src/components/pipeline/__tests__/PushConfirmGate.test.tsx`):
  - textarea + button render
  - feedback < 3 char → button disabled
  - button click → API call + loading state
- **Smoke**: dogfood-mode'da QR pipeline'da "yeşil renkleri pembe yap" mesajı + iterate, yeni Proto output'unda renk değişikliği gözlemle

## 7. Rollout

PR `feat/b5-feedback-iteration` (bu branch). Tek PR. Mevcut B4 davranışına ek; geriye dönük uyumlu (eski client'lar endpoint'i bilmiyor, eski user_note behavior'u korunur).
