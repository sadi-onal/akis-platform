# AKIS Chat UX Polish — Claude Code Session Prompt

> Bu prompt, yeni bir Claude Code session'inda calistirilmak icin hazirlanmistir.
> Onceki session'da yapilan isler, tespit edilen sorunlar ve yapilacaklar detayli sekilde yer almaktadir.

---

## Proje Bağlami

AKIS (Adaptive Knowledge Integrity System), universite bitirme projesi olan bir AI Agent Workflows Engine'dir. React 19 + Vite 7 SPA frontend, Fastify 4 + TypeScript backend. Tez temasi: Knowledge Integrity & Agent Verification.

**Calisma dizini:** `/Users/omeryasironal/Projects/akisflow`
**CLAUDE.md:** Projenin tum kurallari `CLAUDE.md`'de — mutlaka oku.
**Production:** `akisflow.com` — frontend deploy: `tar + scp + ssh` ile `/opt/akis/frontend/`

## Onceki Session'da Yapilan Isler (Zaten Tamamlandi)

Bu sorunlar COZULDU — tekrar dokunma:

1. **`update-preferences` 404 hatasi** — `EmptyState.tsx:40` PUT → POST duzeltildi
2. **Scribe sorulari gorunmuyor** — `ChatPage.tsx` `conversationToChatMessages()` clarification tipini kaybediyordu, duzeltildi. `ChatMessage.tsx`'e clarification renderer eklendi.
3. **Input `scribe_clarifying`'de disabled kaliyordu** — Lossy stage mapping (`scribe_clarifying` → `running` → `scribe_generating`) duzeltildi:
   - `Workflow` tipine `currentStage: PipelineStage` eklendi
   - `workflows.ts` `mapPipelineToWorkflow()` icinde `currentStage: pipeline.stage` eklendi
   - `ChatPage.tsx`'de lossy `workflowStatusToStage()` kaldirildi, `currentStage` dogrudan kullaniliyor
   - `ConversationUIState`'e `scribe_clarifying` eklendi
   - `useConversationState.ts`'de input enabled + "Sorulari yanitlayin..." placeholder
   - Polling sadece `scribe_generating`, `proto_building`, `trace_testing`, `ci_running`'de calisiyor
4. **Suggestion badge'leri tiklanamiyordu** — `ChatMessage.tsx`'de `<button>` olarak duzeltildi, `ChatPanel.tsx`'de `onSuggestionClick={onSend}` ile auto-send

## Yapilacaklar — UX Polish Listesi

Asagidaki tum maddeleri plan modda planla, onayla, uygula, test et.

### 1. Modern Floating Chat Input

**Mevcut durum:** Input altta `border-t` ile yapismis, sade gorunumlu.
**Hedef:** Havada yuzen (floating), glassmorphism efektli, rounded modern input.

**Dosya:** `frontend/src/components/chat/ChatInput.tsx`

Yapilacaklar:
- Input'u `position: sticky bottom-0` yerine `mx-auto max-w-[720px]` icinde floating yap
- `backdrop-blur-xl bg-ak-surface/80 border border-ak-border/50 rounded-2xl shadow-lg` ile glassmorphism
- Input focus'ta subtle glow efekti: `focus-within:shadow-ak-primary/10`
- Send butonuna scale animasyonu: `hover:scale-105 active:scale-95 transition-transform`
- Disabled state'te `opacity-50` yerine daha subtle bir disabled gosterimi

### 2. Pipeline Stage Gecis Animasyonlari

**Mevcut durum:** Scribe → Proto → Trace gecislerinde UI jump ediyor, visual feedback yok.
**Hedef:** Her stage gecisinde smooth transition mesaji ve renk gecisi.

**Dosyalar:**
- `frontend/src/components/chat/ChatPanel.tsx` (lines 112-129 — typing indicator)
- `frontend/src/components/chat/ChatMessage.tsx`

Yapilacaklar:
- Typing indicator'da agent degistiginde crossfade animasyonu (`transition-all duration-300`)
- Stage gecis mesaji: "Scribe tamamlandi, Proto basliyor..." seklinde info mesaji
- `conversationToChatMessages()` icinde stage gecis mesajlari ekle (backend'den `stage_transition` event'i gelirse)
- Typing indicator renginin smooth gecisi (scribe teal → proto amber → trace purple)

### 3. Skeleton Loading Ekranlari

**Mevcut durum:** Conversation yuklenirken eski icerik gorunuyor ama loading gostergesi yok.
**Hedef:** Skeleton pulse animasyonlari ile yukleme durumu.

**Dosyalar:**
- `frontend/src/components/ui/Skeleton.tsx` (zaten var, `animate-pulse` ile)
- Yeni: `frontend/src/components/chat/ChatSkeleton.tsx`

Yapilacaklar:
- ChatPanel icin message skeleton: 3-4 satirlik pulse animasyonlu placeholder
- Sidebar icin conversation list skeleton: 4-5 item skeleton
- Skeleton'lari sadece ILK yukleme'de goster (conversation switch'te degil — eski icerik kalmali)

### 4. Sayfa Gecis Animasyonlari

**Mevcut durum:** `frontend/src/motion/routeTransitions.ts` var ama sadece `fade-slide` preset'i tanimli.
**Hedef:** Route degisikliklerinde smooth fade-slide gecisi.

**Dosyalar:**
- `frontend/src/App.tsx`
- `frontend/src/motion/routeTransitions.ts`
- `frontend/src/motion/motion.config.ts`

Yapilacaklar:
- `App.tsx`'de route wrapper icinde `RouteTransitionContainer` kullan (varsa)
- Lazy-loaded sayfalarda Suspense fallback'e skeleton veya fade animasyonu ekle
- Login → Chat gecisinde smooth transition

### 5. Buton Animasyonlari & Hover Efektleri

**Mevcut durum:** Primary button'da `hover:scale-[1.02]` var, diger butonlarda yok.
**Hedef:** Tum interactive elementlerde consistent hover/active state.

**Dosyalar:**
- `frontend/src/components/common/Button.tsx`
- `frontend/src/components/chat/ChatMessage.tsx` (suggestion buttons)
- Global CSS

Yapilacaklar:
- Secondary button'a `hover:scale-[1.01] active:scale-[0.99]` ekle
- Suggestion badge butonlarina `hover:scale-[1.03]` ekle
- Tum butonlarda `transition-all duration-150` ensure et
- Cancel button'da `hover:bg-red-500/20` gecisi smoothlasstir

### 6. Gereksiz Re-render Onleme

**Mevcut durum:** Conversation switch'te eski icerik kaliyor (iyi), ama bazi durumlarda gereksiz state update'ler olabilir.
**Hedef:** Minimum re-render, smooth UX.

**Dosya:** `frontend/src/pages/chat/ChatPage.tsx`

Kontrol et:
- `messages` state'i her poll'da yeni array olusturuyor mu? (referans esitligi kontrol et)
- `conversations` sidebar listesi gereksiz re-render aliyor mu?
- `useMemo`/`useCallback` dogru kullaniliyor mu?
- Polling interval'i `scribe_clarifying`'de durmus mu? (ONCEKI SESSION'DA DUZELTILDI — dogrula)

### 7. Smooth Scroll & Auto-scroll Iyilestirmesi

**Mevcut durum:** `scrollIntoView({ behavior: 'smooth' })` var, calisiyor.
**Hedef:** Daha iyi scroll UX.

**Dosya:** `frontend/src/components/chat/ChatPanel.tsx`

Yapilacaklar:
- Scroll-to-bottom butonuna entrance/exit animasyonu (zaten `animate-in` var, dogrula)
- Yeni mesaj geldiginde sadece kullanici scrollbar'i en altta ise auto-scroll yap (kullanici yukari scroll yapmissa scroll'u bozma)
- Scroll-down butonunda "unread message count" badge'i (opsiyonel, sadece kolay ise)

### 8. Message Animasyonu Tutarliligi

**Mevcut durum:** Farkli message tipleri farkli animation duration'lari kullaniyor (100ms-200ms).
**Hedef:** Tutarli ama cesitli animation language.

**Dosya:** `frontend/src/components/chat/ChatMessage.tsx`

Yapilacaklar:
- Tum slide-in animasyonlari `duration-200` olarak standardize et
- User mesajlari sagdan (`slide-in-from-right-2`), agent mesajlari soldan (`slide-in-from-left-2`)
- Error mesajlarinda subtle shake animasyonu
- Plan card'da `zoom-in` efekti korulsun (zaten var)

## Kritik Kurallar

1. **CLAUDE.md'yi OKU** — tum teknoloji ve kod kurallari orada
2. **Backend'e DOKUNMA** — sadece frontend degisiklikleri
3. **Tez temasindan UZAKLASMA** — sadece UX polish, yeni ozellik ekleme
4. **Tailwind 4 kullan** — custom CSS minimum
5. **`prefers-reduced-motion` DESTEKLE** — tum animasyonlar `useReducedMotion` hook'u ile kontrol edilmeli
6. **Typecheck + Build GECMELI** — her degisiklik sonrasi: `pnpm -C frontend typecheck && pnpm -C frontend build`
7. **Production'da TEST ET** — deploy: `tar -czf /tmp/akis-frontend.tar.gz -C frontend/dist . && scp -i ~/.ssh/id_ed25519 /tmp/akis-frontend.tar.gz ubuntu@141.147.25.123:/tmp/ && ssh -i ~/.ssh/id_ed25519 ubuntu@141.147.25.123 'sudo rm -rf /opt/akis/frontend/* && sudo tar -xzf /tmp/akis-frontend.tar.gz -C /opt/akis/frontend/ && rm /tmp/akis-frontend.tar.gz'`
8. **Commit convention:** `feat(ui):` veya `fix(ui):` prefix, Co-Authored-By satiri ekle

## Test Senaryolari

Her degisiklik sonrasi su akisi test et:

1. Siteye gir → bos state gorunmeli (animasyonlu)
2. Yeni Sohbet → input gorunmeli (floating, modern)
3. Fikir yaz → mesaj animasyonlu gitmeli, typing indicator gorunmeli
4. Scribe soru sorsun → sorular kartlar halinde, input aktif, "Sorulari yanitlayin..."
5. Suggestion badge tikla → otomatik gonderilmeli
6. Spec olusturulsun → plan card animasyonlu gorunmeli
7. Conversation switch → eski icerik kalsin, yeni icerik smooth gelsin
8. Sidebar collapse/expand → smooth
9. Mobile gorunum → responsive, sidebar slide-in

## Dosya Haritasi (Quick Reference)

```
frontend/src/
├── components/chat/
│   ├── ChatInput.tsx          ← Floating input tasarimi
│   ├── ChatMessage.tsx        ← Message animasyonlari
│   ├── ChatPanel.tsx          ← Skeleton loading, scroll, typing indicator
│   ├── ChatHeader.tsx         ← Header
│   ├── ConversationSidebar.tsx ← Sidebar animasyonlari
│   └── EmptyState.tsx         ← Bos state (zaten iyi)
├── components/common/
│   └── Button.tsx             ← Buton animasyonlari
├── components/ui/
│   └── Skeleton.tsx           ← Skeleton component
├── hooks/
│   ├── useConversationState.ts ← UI state yonetimi
│   ├── usePipelineStream.ts   ← SSE stream
│   └── useReducedMotion.ts    ← Motion preference
├── motion/
│   ├── motion.config.ts       ← Animasyon ayarlari
│   └── routeTransitions.ts   ← Sayfa gecisleri
├── pages/chat/
│   └── ChatPage.tsx           ← Ana sayfa, polling, state
├── services/api/
│   └── workflows.ts           ← Pipeline API wrapper
├── types/
│   ├── chat.ts                ← ChatMessage, UIState tipleri
│   ├── workflow.ts            ← Workflow tipi (currentStage eklendi)
│   └── pipeline.ts            ← PipelineStage tipleri
├── utils/
│   └── mapPipelineEvent.ts    ← Stage → UIState mapping
└── App.tsx                    ← Routing, transitions
```

## Baslarken

1. `CLAUDE.md`'yi oku
2. Bu prompt'u tamamen anla
3. Plan modda calis — once arastir, sonra plan yaz, onay al, uygula
4. Her maddeyi bitirince typecheck + build calistir
5. Tum maddeler bitince deploy et ve test et
6. Gereksiz scope creep yapma — sadece listedeki maddeler
