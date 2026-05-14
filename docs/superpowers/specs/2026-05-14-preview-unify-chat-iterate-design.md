# Preview-Unify + Chat-Driven İterate — Design Spec

**Date:** 2026-05-14
**Author:** AKIS (Claude + Ömer)
**Status:** Approved (brainstorming complete)
**Scope:** Single-spec deliverable per user preference. Findings + Requirements + UX + Tech + Acceptance birleşik.

---

## 1. Findings — mevcut durumun problemleri

`/chat/:pipelineId` ekranında `awaiting_push_confirm` state'inde iki adet `PreviewPanel` iframe aynı anda render oluyor:

1. **Inline duplikasyon:** `PushConfirmGate.tsx:113-128` — kart içinde `h-72` (~288px) yükseklikte gömülü iframe.
2. **Sağ panel:** `PreviewPanel.tsx` — top-right "Preview" toggle ile açılan tam ekran sandpack.

Aynı kart şu sorumlulukları tek başına taşıyor (`PushConfirmGate.tsx`, 203 satır):

- Başlık + dosya sayısı badge'i
- Preview iframe (duplikasyon kaynağı)
- "GitHub'a gönder" / "İptal et" butonları
- "Bir şeyi değiştirmek ister misin?" textarea
- "Düzelt" butonu (B5 feedback iteration)

Bu yapının yan etkileri:

- Kullanıcı önizlemeyi sağ panelde gördükten sonra aksiyon almak için chat'e geri scroll etmek zorunda.
- Aynı sandpack iki kere mount oluyor — gereksiz network + render.
- Chat input'a yazılan mesajlar `awaiting_push_confirm` state'inde iterate endpoint'ine yönlendirilmiyor; kullanıcı iki ayrı text alanı arasında karar vermek zorunda (chat vs Düzelt textarea).
- `handleIntentFeedback` (`ChatPage.tsx:305-308`) F-10 intent classifier'dan `FEEDBACK` geldiğinde bir placeholder mesaj basıyor — gerçek iterate endpoint'ine bağlı değil.

Memory referansı: `chat_intent_gaps.md` (normal chat Q&A + intent detection gap'leri) — bu spec'in çıkış noktası aynı eksiklik.

---

## 2. Requirements

### 2.1 Functional

| ID | Gereksinim | Kaynak |
|---|---|---|
| FR-PU-1 | `awaiting_push_confirm` state'inde tek bir preview render olmalı | findings §1 |
| FR-PU-2 | "GitHub'a gönder" + "İptal et" butonları sağ Preview Panel'in altında sticky footer olarak görünmeli | user answer Q2 |
| FR-PU-3 | Chat input'a yazılan mesaj ChatRouter üzerinden intent-classify edilmeli; `FEEDBACK` etiketi alırsa ve state `awaiting_push_confirm` ise iterate-with-feedback endpoint'ine yönlendirilmeli | user answer Q3 |
| FR-PU-4 | Kullanıcı `awaiting_push_confirm` state'ine geçtiğinde sağ Preview Panel otomatik açılmalı | findings §1 |
| FR-PU-5 | `PushConfirmGate` chat içinde compact (sadece başlık + bilgilendirme) varyanta indirilmeli | user answer Q1 |
| FR-PU-6 | `PushConfirmGate` içindeki "Bir şeyi değiştirmek ister misin?" textarea + "Düzelt" butonu kaldırılmalı | user answer Q1, Q2 |
| FR-PU-7 | Intent classifier düşük confidence verirse mevcut DisambiguationModal flow'u korunmalı | non-regression |
| FR-PU-8 | `iterate-with-feedback` başarılı dönerse chat'e optimistic echo eklenmeli ve poll'leme yeni preview'ı yenilemeli | UX |

### 2.2 Non-Functional

| ID | Gereksinim |
|---|---|
| NFR-PU-1 | Geri uyumlu: `PushConfirmGate` mevcut prop'larını kıran değişiklik yok. Yeni `fileCount`/`onOpenPreview` prop'ları opsiyonel; eski `files` prop'u kaldırılır. |
| NFR-PU-2 | i18n: bakkal-Türkçesi audit script (F-12 glossary) 0 warn. |
| NFR-PU-3 | Bundle size delta < +5KB (PushGateFooter ayrı dosya, eski textarea/Düzelt kodu silinir → muhtemelen net negatif). |
| NFR-PU-4 | Mobile viewport (360px) — footer iframe'i kapatmamalı. |
| NFR-PU-5 | a11y: sticky footer'daki butonlar `aria-label` ile etiketlenmeli; kontrast Wave1-UX standardına uygun. |
| NFR-PU-6 | Test coverage: yeni dosyalar 80%+; mevcut komponent testleri kırılmamalı (snapshot update kabul). |

### 2.3 Out of scope (kasıtlı)

- Mobile-first refactor (sadece footer'ın bozulmaması yeterli; mobil tasarımı ayrı PR).
- Intent classifier threshold tuning (sadece state-aware fallback eklenir).
- Backend değişikliği — endpoint'ler hâlihazırda var (B4 + B5).
- `PreviewPanel.tsx` (598 satır) refactor — sadece yeni prop slot'u eklenir, içerik dokunulmaz.
- DisambiguationModal davranışı değiştirilmez.

---

## 3. UX

### 3.1 Yeni layout (awaiting_push_confirm state'inde)

```
┌──────────────────────────────────────┬───────────────────────────────────┐
│ ChatPanel                            │ PreviewPanel (otomatik açık)      │
│                                      │                                   │
│ ┌── PushConfirmGate compact ─────┐   │  [Onizleme] [Dosyalar 19]         │
│ │ Kodu gözden geçir · 19 dosya   │   │  ┌─────────────────────────────┐  │
│ │ Önizleme sağda · GitHub'a      │   │  │                             │  │
│ │ göndermek için sağdaki butonu  │   │  │  QR Kod Üretici (iframe)    │  │
│ │ kullan, düzeltme için chat'e   │   │  │                             │  │
│ │ yaz.                           │   │  │                             │  │
│ │                                │   │  │                             │  │
│ │ [Önizlemeyi aç]   ← rail kapa- │   │  │                             │  │
│ │                   lıysa görünür│   │  └─────────────────────────────┘  │
│ └────────────────────────────────┘   │  ┌── PushGateFooter ───────────┐  │
│                                      │  │ [GitHub'a gönder] [İptal et]│  │
│ (önceki mesajlar...)                 │  └─────────────────────────────┘  │
│                                      │                                   │
│ ┌── ChatInput ────────────────────┐  │                                   │
│ │ Ne değişsin? Örn: renkleri      │  │                                   │
│ │ pembe yap. Veya 'GitHub'a       │  │                                   │
│ │ gönder' diye yaz.            ↑  │  │                                   │
│ └─────────────────────────────────┘  │                                   │
└──────────────────────────────────────┴───────────────────────────────────┘
```

### 3.2 State machine (push gate sınırında)

```
[proto_completed dryRun]
        │
        ▼
[awaiting_push_confirm]  ← setShowPreview(true) auto-fire
        │
   ┌────┼────────────────────┐
   │    │                    │
   ▼    ▼                    ▼
confirm-push  chat msg     cancel-push
(footer)      (classify)   (footer)
   │           │              │
   ▼           ▼              ▼
[pushing]   FEEDBACK?     [cancelled → idle]
   │           │
   ▼        ┌──┴──┐
[completed] iterate else
            │     │
            ▼     ▼
        [proto_  placeholder
         running]  (existing)
            │
            ▼
[awaiting_push_confirm]  ← back, fresh files
```

### 3.3 Edge case'ler

| Senaryo | Davranış |
|---|---|
| Sağ panel kullanıcı manuel kapatır | Compact card'da "Önizlemeyi aç" butonu görünür; tıklayınca `setShowPreview(true)`. |
| Classifier timeout / 5xx | Push-confirm state'inde **FEEDBACK fallback** (mevcut BUILD fallback yerine state-aware). Diğer state'lerde davranış değişmez. |
| Confidence < threshold | Mevcut `DisambiguationModal` (F-10 ile gelen) açılır; user seçimi yapar. |
| Push iterate çalışırken user yeni mesaj atar | `busy` flag input'u disable eder (mevcut pattern korunur). |
| User "iptal et" cümlesini chat'e yazar | Classifier muhtemelen `CHAT` etiketler → footer butonuna yönlendiren bir toast/hint *opsiyonel* (out of scope). |

### 3.4 i18n delta

**Silinen (6 key):**

- `chat.pushGate.previewLoading`
- `chat.pushGate.feedback.title`
- `chat.pushGate.feedback.hint`
- `chat.pushGate.feedback.placeholder`
- `chat.pushGate.feedback.submit`
- `chat.pushGate.feedback.iterating`
- `chat.pushGate.errorIterate`

**Güncellenen:**

- `chat.pushGate.description` → "Sağdaki önizlemeyi inceleyin. GitHub'a göndermek veya iptal etmek için sağdaki butonu kullanın. Düzeltme için aşağıdaki chat'e yazın."
- `useConversationState` placeholder (`awaiting_push_confirm`) → "Ne değişsin? Örn: 'renkleri pembe yap'. Veya sağdaki butonla GitHub'a gönder."

**Yeni:**

- `chat.pushGate.openPreview` → "Önizlemeyi aç"
- `chat.feedback.optimisticEcho` → "Düzeltme gönderildi: \"{snippet}\". Proto güncelleniyor..."

---

## 4. Tech approach

### 4.1 Komponent topolojisi

```
ChatPage
├── ChatPageLayout
│   ├── ChatPanel
│   │   ├── ChatMessage(...)
│   │   │   └── PushConfirmGate (compact)  ← T2
│   │   └── ChatInput (state-aware placeholder)
│   └── PreviewPanel  ← T1 footer slot eklenir
│       └── PushGateFooter (yeni)  ← T1
└── ChatRouter
    └── handleIntentFeedback (state-aware)  ← T3
```

### 4.2 Dosya değişiklik haritası

| Dosya | Aksiyon | Task |
|---|---|---|
| `frontend/src/components/workflow/PushGateFooter.tsx` | YENİ — confirm + cancel butonları, API çağrıları | T1 |
| `frontend/src/components/workflow/PreviewPanel.tsx` | EDIT — `pushGateProps` opsiyonel prop'u; footer slot render | T1 |
| `frontend/src/components/pipeline/PushConfirmGate.tsx` | REWRITE — 203 → ~50 satır; iframe + textarea + 3 buton silinir, compact header + "Önizlemeyi aç" kalır | T2 |
| `frontend/src/components/pipeline/__tests__/PushConfirmGate.test.tsx` | REWRITE — eski feature testleri silinir, compact varyant testleri eklenir | T2 |
| `frontend/src/pages/chat/ChatPage.tsx` | EDIT — `handleIntentFeedback` placeholder → state-aware iterate çağrısı + optimistic echo | T3 |
| `frontend/src/pages/chat/ChatPageLayout.tsx` | EDIT — `uiState=awaiting_push_confirm` → `setShowPreview(true)` effect; `PreviewPanel` prop drilling | T3 |
| `frontend/src/hooks/useConversationState.ts` | EDIT — placeholder string güncellemesi | T3 |
| `frontend/src/services/api/workflows.ts` | YOK — `confirmPush`, `cancelPush`, `iterateWithFeedback` zaten satır 493/503/515'te var | — |
| `frontend/src/i18n/locales/tr.json` | EDIT — 6 key sil, 2 key ekle, 1 key güncelle | T4 |
| `frontend/src/i18n/locales/en.json` | EDIT — aynı delta | T4 |
| `frontend/src/i18n/i18n.types.ts` | EDIT — auto-regen veya manuel patch | T4 |
| `frontend/playwright/specs/push-gate-chat-iterate.spec.ts` | YENİ — e2e walkthrough | T5 |
| `scripts/smoke/walkthrough.mjs` | OPSIYONEL — yeni davranışı kapsasın | T5 |

### 4.3 Komponent imzaları

**`PushGateFooter` (yeni):**

```typescript
export interface PushGateFooterProps {
  pipelineId: string;
  onResolved?: (action: 'confirm' | 'cancel') => void;
  className?: string;
}
```

İç state: `busy: 'confirm' | 'cancel' | null`, `error: string | null`.
API çağrıları: `workflowsApi.confirmPush`, `workflowsApi.cancelPush` (mevcut: `frontend/src/services/api/workflows.ts:493,503`).
Render: sticky footer; iki buton + error alert.

**`PreviewPanel` yeni prop:**

```typescript
interface PreviewPanelProps {
  // ... mevcut props
  pushGateProps?: PushGateFooterProps;
}

// Render eklemesi:
{pushGateProps && <PushGateFooter {...pushGateProps} />}
```

**`PushConfirmGate` compact:**

```typescript
export interface PushConfirmGateProps {
  pipelineId: string;
  fileCount: number;
  previewOpen: boolean;
  onOpenPreview: () => void;
}

// Render: section header + 1 paragraf + (!previewOpen ? "Önizlemeyi aç" buton : null).
```

**`handleIntentFeedback` (ChatPage.tsx):**

```typescript
const handleIntentFeedback = useCallback(
  async (message: string) => {
    const pipeline = pushPipelineRef.current; // veya pipeline state'i
    if (pipeline?.uiState !== 'awaiting_push_confirm') {
      return intentPlaceholder('Geribildirim', message);
    }
    try {
      await workflowsApi.iterateWithFeedback(pipeline.id, message);
      appendMessage({ role: 'user', content: message });
      appendMessage({
        role: 'system',
        content: t('chat.feedback.optimisticEcho', { snippet: truncate(message, 60) }),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Düzeltme gönderilemedi');
    }
  },
  [pushPipelineRef, intentPlaceholder, appendMessage, t]
);
```

**Auto-open preview (ChatPageLayout.tsx):**

```typescript
useEffect(() => {
  if (uiState === 'awaiting_push_confirm' && !showPreview) {
    setShowPreview(true);
  }
}, [uiState, showPreview, setShowPreview]);
```

### 4.4 ChatRouter state-aware fallback

`ChatRouter.tsx:120-125` (classify error fallback) — push-confirm state'inde BUILD yerine FEEDBACK'e düşmeli:

```typescript
} catch {
  const isPushConfirm = pipelineUiState === 'awaiting_push_confirm';
  await dispatch(isPushConfirm ? 'FEEDBACK' : 'BUILD', message, attachments);
  return;
}
```

Bu, classify endpoint yavaş veya error verirse push gate'de "BUILD" intent ile pipeline'ı sıfırdan başlatma riskini ortadan kaldırır.

### 4.5 Backend — değişiklik yok

Hâlihazırda var olan endpoint'ler:

- `POST /api/pipelines/:id/confirm-push` (B4, `pipeline.routes.ts`)
- `POST /api/pipelines/:id/cancel-push` (B4, `pipeline.routes.ts`)
- `POST /api/pipelines/:id/iterate-with-feedback` (B5, `pipeline.routes.ts:215`)

Tüm wire-up frontend tarafında.

---

## 5. Risks

| Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|
| `useConversationState` placeholder snapshot testleri kırar | yüksek | düşük | Snapshot update + bakkal-language audit yeniden çalıştır |
| Classifier düşük confidence push-confirm'de → DisambiguationModal sık çıkar | orta | orta | NFR-PU-1 kapsamında: timeout/error fallback'i FEEDBACK; threshold tuning out of scope |
| Prop drilling 3 katman (ChatPage → ChatPageLayout → PreviewPanel) | düşük | düşük | Mevcut pattern'le aynı; context eklemeye gerek yok |
| Eski `PushConfirmGate.test.tsx` 9 test fail (silinen feature'lar) | yüksek | düşük | T2'de atomic rewrite (testleri + komponenti aynı commit'te) |
| Sticky footer mobile viewport'ta iframe'i kapatır | orta | düşük | Flexbox: footer fixed height, iframe `flex-1`. e2e mobile test (T5). |
| ~~Client wrapper yokluğu~~ — doğrulandı: `workflowsApi.iterateWithFeedback` zaten `workflows.ts:515`'te var | yok | yok | n/a (risk düşürüldü) |
| i18n auto-regen `i18n.types.ts` conflict yaratır | düşük | düşük | T4'te `pnpm -C frontend generate:types` veya manuel patch |

---

## 6. Test plan

### 6.1 Unit / component

| Dosya | Test sayısı (yeni) | Kapsam |
|---|---|---|
| `PushGateFooter.test.tsx` | 5-6 | render, confirm click → API, cancel click → API, error alert, busy disable |
| `PreviewPanel.test.tsx` | 2 yeni | `pushGateProps` undefined → footer yok; verilirse footer render |
| `PushConfirmGate.test.tsx` | 4-5 yeniden yazılır | compact render; iframe yok assertion; "Önizlemeyi aç" buton condition; eski feedback textarea yok assertion |
| `ChatPage.intent-feedback.test.tsx` | 4-5 | push-confirm + FEEDBACK → iterate API call; başka state → placeholder; iterate error → toast; optimistic echo eklenir |
| `ChatPageLayout.auto-open.test.tsx` | 2 | uiState=awaiting_push_confirm → showPreview true; kullanıcı kapatırsa tekrar açılmaz (effect tek seferlik fire) |
| `useConversationState.test.ts` | 1 | yeni placeholder string |

### 6.2 E2E (Playwright)

`frontend/playwright/specs/push-gate-chat-iterate.spec.ts`:

1. Walkthrough başlat (mock provider, DOGFOOD_MODE varyantı)
2. Pipeline `awaiting_push_confirm`'e ulaş
3. Sağ panel otomatik açıldı mı? — assert
4. Compact card'da iframe yok mu? — assert
5. Sağ footer'da iki buton var mı? — assert
6. Chat input'a "renkleri pembe yap" yaz, gönder
7. Optimistic echo görünür mü? — assert
8. Pipeline `proto_running` → tekrar `awaiting_push_confirm` döner — assert
9. Yeni dosya sayısı güncellendi mi? — assert (opsiyonel — mock provider belirsiz olabilir)

### 6.3 Smoke

`scripts/smoke/walkthrough.mjs` — push gate adımına chat-iterate eklenir veya ayrı bir smoke script (`smoke/push-gate-iterate.mjs`).

### 6.4 Manuel doğrulama (final gate)

- `./scripts/dev-up.sh` ile localhost başlat
- DOGFOOD_MODE açıkken yeni pipeline başlat → push gate'e ulaş
- Önizleme sadece sağda mı? — gör
- Chat'e "başlığı büyült" yaz → preview yenilenir mi? — gör
- Sağ paneli kapat → compact card'da "Önizlemeyi aç" görünür mü? — gör
- "GitHub'a gönder" sağ footer'da çalışıyor mu? — gör (DOGFOOD mode'da stub'lanır)

---

## 7. Acceptance criteria

- [ ] `awaiting_push_confirm` state'inde tek bir preview render olur (DOM'da `<iframe>` veya sandpack root sayısı kontrolü)
- [ ] "GitHub'a gönder" + "İptal et" sağ Preview Panel altında sticky footer'da
- [ ] Chat input → mesaj → FEEDBACK intent → iterate-with-feedback API call
- [ ] `awaiting_push_confirm` state geçişinde sağ panel auto-open
- [ ] `PushConfirmGate.tsx` ≤ 60 satır (compact)
- [ ] Eski feedback textarea + Düzelt butonu kodda yok (grep ile `chat.pushGate.feedback` 0 hit, `setFeedback` 0 hit)
- [ ] tr.json + en.json: 6 key silindi, 2 key eklendi, description güncellendi
- [ ] bakkal-language audit: 0 warn
- [ ] `pnpm -C frontend typecheck` PASS
- [ ] `pnpm -C frontend lint` PASS
- [ ] `pnpm -C frontend test` PASS (yeni testler dahil)
- [ ] `pnpm -C frontend test:e2e` push-gate-chat-iterate spec PASS
- [ ] `/review` çıktısında high/medium severity 0
- [ ] 3 PR (T1, T2, T3) main'e merge + CI yeşil
- [ ] T4 (i18n) + T5 (e2e) main'e merge

---

## 8. Rollout

- Her task ayrı PR (T1, T2, T3 paralel; T4 + T5 sonra)
- Feature flag yok — değişiklik kullanıcıya doğrudan görünür (lokal dev'de doğrulanır)
- Memory güncelleme: `b4-ci-debug-pending.md` silinir (geçersiz)
- Yeni memory: `preview-actions-pattern.md` — sağ panel sticky footer pattern'i ileride başka gate'lerde kullanılırsa referans
- Eski PushConfirmGate'in 203 satırı ~50'ye iner: NFR-PU-3 (bundle) için net pozitif

---

## 9. Cross-refs

- `docs/product/wave3/b5-feedback-iteration.md` — B5 spec, iterate-with-feedback endpoint'i tanımladı
- `docs/product/06-roadmap.md` § 5 Wave 4 — F-10 intent classifier + ChatRouter
- Memory: `chat_intent_gaps.md`, `level4_surface.md`, `worktree_symlink_pattern.md`, `parallel_subagent_velocity.md`
- PRs: #519 (F-10), #520 (F-09), #538 (B5)
