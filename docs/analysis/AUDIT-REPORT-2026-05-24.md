# AKIS Platform — Kapsamlı Kod Audit Raporu

**Tarih:** 2026-05-24
**Branch:** feat/chat-narrator-pattern-a (commit c727d6f)
**Yöntem:** 6 paralel audit agent — Backend API, Pipeline, Services, Frontend Components, AI Prompts, Frontend Routing/i18n
**Toplam taranan kod:** ~110K satır TypeScript

---

## Özet Tablo

| Severity | Adet | Açıklama |
|----------|------|----------|
| **Critical** | 7 | Güvenlik açıkları, veri sızıntısı, SSE bağlantı sorunları |
| **High** | 14 | Auth bypass, state machine hataları, kırık retry, i18n |
| **Medium** | 24 | Tutarsız davranış, kaynak sızıntısı, eksik handling |
| **Low** | 23 | Dead code, minor tutarsızlıklar, kozmetik |
| **Toplam** | **68** | *(tekrar eden bulgular elendi)* |

---

## CRITICAL (7 bulgu)

### C-1. Admin logs endpoint — herhangi bir kullanıcı erişebilir
**Dosya:** `backend/src/api/admin.ts:12`
**Sorun:** `GET /api/admin/logs` sadece `requireAuth` kullanıyor, `requireAdmin` değil. Giriş yapmış herhangi bir üye sunucunun in-memory log buffer'ını görebilir.
**Etki:** Log buffer'ında request ID'ler, user ID'ler, AI provider hataları, DB bağlantı bilgileri ve stack trace'ler bulunabilir — bilgi sızıntısı.
**Çözüm:** `preHandler: requireAuth` → `requireAdmin` olarak değiştir.

### C-2. Dashboard metrics — tüm kullanıcıların verilerini gösteriyor (tenant izolasyonu yok)
**Dosya:** `backend/src/api/dashboard-metrics.ts:60-86`
**Sorun:** `GET /api/dashboard/metrics` sorgusu `jobs` tablosunda sadece tarih filtresi kullanıyor, `userId` filtresi yok. Her authenticated kullanıcı TÜM kullanıcıların job metriklerini (toplam iş, hata oranı, kalite skorları) görüyor.
**Etki:** Multi-tenant izolasyon ihlali.
**Çözüm:** Her iki sorguya `userId` filtresi ekle — `user` zaten `preHandler`'dan mevcut ama kullanılmıyor.

### C-3. Marketplace jobs listesi — authentication yok
**Dosya:** `backend/src/api/marketplace.ts:197-214`
**Sorun:** `GET /api/jobs` hiçbir auth kontrolü yapmıyor. Kimlik doğrulaması olmadan tüm iş ilanlarına erişilebilir.
**Çözüm:** Handler'ın başına `requireAuth(request)` ekle.

### C-4. Google Gemini API key URL query string'inde
**Dosya:** `backend/src/services/ai/AIService.ts:544-547`
**Sorun:** `buildGoogleRequest` API key'i doğrudan URL'ye koyuyor: `?key=${encodeURIComponent(apiKey)}`. Key, loglar, proxy'ler ve hata mesajlarında görünür.
**Etki:** Credential sızıntısı riski.
**Çözüm:** API key'i header'a taşı (`x-goog-api-key` veya `Authorization: Bearer`).

### C-5. Tool-calling client (agentic path) — retry/rate-limit yok
**Dosya:** `backend/src/services/ai/AIService.ts:1621-1681`
**Sorun:** Proto ve Trace için asıl üretim yolu olan `createToolCallingClient` tek bir `fetch` çağrısı yapıyor — retry, backoff, 429 handling yok. Ana `chatCompletion` methodu bunların hepsine sahip ama agentic path bunları bypass ediyor.
**Etki:** Tek bir 429 veya 5xx yanıtı tüm pipeline'ı öldürüyor. Bu **ana üretim code path'i**.
**Çözüm:** `chatCompletion`'daki retry/backoff altyapısını paylaşılan bir helper'a çıkar ve tool-calling client'ta da kullan.

### C-6. `usePipelineStream` — `createdFiles` non-proto activity'de siliniyor
**Dosya:** `frontend/src/hooks/usePipelineStream.ts:95-97`
**Sorun:** `ingest` fonksiyonu `stage !== 'proto'` olan her activity'de `setCreatedFiles([])` çağırıyor. Proto dosyaları birikmişken tek bir Scribe/Trace activity geldiğinde tüm dosya listesi siliniyor.
**Etki:** Kullanıcı proto dosyalarını kısaca görüp sonra kaybolduğunu fark ediyor.
**Çözüm:** Satır 95-97'yi kaldır. `createdFiles` sadece `pipelineId` değiştiğinde sıfırlanmalı (effect'in başında zaten yapılıyor).

### C-7. `usePipelineStream` — `isActive` dependency array'de gereksiz SSE reconnect
**Dosya:** `frontend/src/hooks/usePipelineStream.ts:169`
**Sorun:** Satır 125'teki yorum `isActive`'in "informational only" olduğunu söylüyor ve `void isActive` statement'ı var ama `isActive` hâlâ dependency array'de `[pipelineId, isActive]`. Her state transition'da SSE stream yıkılıp yeniden kuruluyor.
**Etki:** Gereksiz SSE reconnection'ları, activity verisi kaybı, ekstra network request'leri.
**Çözüm:** `isActive`'i dependency array'den çıkar.

---

## HIGH (14 bulgu)

### H-1. Playbook route'ları — authentication yok
**Dosya:** `backend/src/api/playbooks.ts:4-36`
**Sorun:** `GET /api/agents/playbooks` ve `GET /api/agents/playbooks/:type` auth kontrolü yok. Agent playbook'ları herkese açık.
**Etki:** İç agent davranışlarını ve prompt stratejilerini ifşa eder.

### H-2. `forgot-password` — user existence sızıntısı
**Dosya:** `backend/src/api/auth.multi-step.ts:405-428`
**Sorun:** Kullanıcı varsa response `userId` içeriyor, yoksa içermiyor. Yorum "Always return success" diyor ama response shape farklı.
**Etki:** E-posta enumerasyonu.

### H-3. Knowledge source ID — UUID validasyonu yok
**Dosya:** `backend/src/api/knowledge.ts:391,428,466`
**Sorun:** `:id` parametresi `request.params as { id: string }` olarak alınıp UUID validasyonu yapılmıyor.
**Çözüm:** `z.object({ id: z.string().uuid() }).parse(request.params)` ekle.

### H-4. Legacy login — user status kontrolü yok
**Dosya:** `backend/src/api/auth.ts:139-159`
**Sorun:** `POST /auth/login` şifre doğruladıktan sonra JWT veriyor ama `user.status` kontrol etmiyor. `disabled`/`deleted` kullanıcı session alabilir.

### H-5. HttpClient — AbortController retry'lar arasında paylaşılıyor
**Dosya:** `backend/src/services/http/HttpClient.ts:97-123`
**Sorun:** `AbortController` retry döngüsü öncesinde bir kez oluşturuluyor. Timeout'tan sonra `controller.abort()` çağrılınca sonraki TÜM retry'lar anında abort oluyor çünkü signal zaten aborted.
**Etki:** Timeout sonrası retry mekanizması tamamen çalışmıyor.
**Çözüm:** `AbortController` oluşturmayı retry döngüsünün içine taşı.

### H-6. OAuth token'ları — plaintext saklanabiliyor
**Dosya:** `backend/src/db/schema.ts:1082-1086`
**Sorun:** `oauth_accounts` tablosu `accessToken`/`refreshToken` kolonlarını plain `text` olarak saklıyor. `OAuthTokenCrypto.decryptForUse` şifreli görünmeyen token'ı raw olarak döndürüyor.
**Etki:** Encryption yazma sırasında enforce edilmezse token'lar DB'de plaintext kalır.

### H-7. `autoApproveEnabled`/`autoApproveThreshold` — DB'ye yazılmıyor
**Dosya:** `backend/src/pipeline/db/DrizzlePipelineStore.ts` + `PipelineOrchestrator.ts:167-168,2983`
**Sorun:** Orchestrator `autoApproveEnabled` ve `autoApproveThreshold` değerlerini set ediyor ama `DrizzlePipelineStore.update()` bu alanları ignore ediyor. Schema'da `autoApproveThreshold` kolonu yok.
**Etki:** Auto-approve özelliği uçtan uca çalışmıyor — değerler set ediliyor ama kayboluyorlar.

### H-8. Proto prompt — çelişkili output format talimatları
**Dosya:** `backend/src/pipeline/agents/proto/ProtoAgent.ts:158-275`
**Sorun:** System prompt'ta iki çelişkili format var: satır 173'te `### path:` markdown formatı, satır 274'te JSON formatı. Parser sadece JSON'u anlıyor.
**Etki:** AI markdown formatında çıktı üretirse scaffold üretimi başarısız olur.

### H-9. Critic approval threshold — prompt ile kod uyumsuz
**Dosya:** `backend/src/pipeline/agents/critic/prompts/code-review.ts:55` + `CriticAgent.ts:37`
**Sorun:** Prompt `>=75` olarak hardcode edilmiş ama `CriticAgent`'ın `approvalThreshold`'u constructor'dan override edilebiliyor. AI'ın `approved` kararı ile kodun kararı çelişiyor.

### H-10. Token budget yok — prompt'lar sınırsız büyüyebilir
**Dosya:** `backend/src/pipeline/agents/scribe/ScribeAgent.ts`, `proto/ProtoAgent.ts:498`, `trace/TraceAgent.ts:776`
**Sorun:** Scribe konuşma geçmişini, Proto mevcut dosyaları, Trace codebase context'ini truncation olmadan birleştiriyor.
**Etki:** Context window aşılabilir → API hatası + maliyet.

### H-11. `useConversationState` — tüm placeholder'lar hardcoded Türkçe
**Dosya:** `frontend/src/hooks/useConversationState.ts:52-82`
**Sorun:** Her placeholder string Türkçe olarak hardcoded. i18n sistemi mevcut ama bypass edilmiş.
**Etki:** EN locale kullananlar Türkçe placeholder görüyor.

### H-12. Pipeline stage'leri `mapStageStatus`'ta eksik
**Dosya:** `frontend/src/services/api/workflows.ts:44`
**Sorun:** `critic_reviewing_spec`, `critic_reviewing_code`, `awaiting_critic_resolution`, `fix_loop_iteration`, `ci_running` — 5 gerçek backend stage'i handle edilmiyor. Switch fall-through ile `status='pending'`, tüm stage'ler `'idle'` olarak gösteriliyor.
**Etki:** Bu stage'lerde kullanıcı "bekliyor" görüyor ama pipeline aslında aktif çalışıyor.

### H-13. `completed_partial` — `isTerminalStage`'de eksik
**Dosya:** `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts:4828-4830`
**Sorun:** `isTerminalStage` sadece `cancelled`, `failed`, `completed` kontrol ediyor; `completed_partial` yok. In-flight dispatcher guard bunu yakalamıyor.
**Etki:** `completed_partial` durumundaki pipeline `proto_building`'e geri dönebilir — biten pipeline canlanıyor.

### H-14. AuthContext — role hardcoded `'member'`
**Dosya:** `frontend/src/contexts/AuthContext.tsx:37-39`
**Sorun:** `mapUser` fonksiyonu backend ne dönerse dönsün her zaman `role: 'member'` set ediyor.
**Etki:** Frontend admin özelliklerini asla göremez; `RequireRole` guard'ı kalıcı olarak çalışmaz.

---

## MEDIUM (24 bulgu)

### Backend

| # | Dosya | Sorun |
|---|-------|-------|
| M-1 | `api/webhooks.ts:46-53` | GitHub webhook signature verification isteğe bağlı — `GITHUB_WEBHOOK_SECRET` yoksa her payload kabul ediliyor |
| M-2 | `api/settings/workspace.ts:259` | Cookie silme hardcoded `'akis_sid'` — env'den okumuyor |
| M-3 | `api/auth.multi-step.ts:302-356` | `login/start` farklı hata kodlarıyla e-posta enumerasyonu (`USER_NOT_FOUND` vs `EMAIL_NOT_VERIFIED`) |
| M-4 | `api/job-events.ts:70-76` | SSE endpoint `reply.hijack()` çağırmıyor — `ERR_HTTP_HEADERS_SENT` riski |
| M-5 | `api/ai-models.ts:52-84` | `GET /api/ai/supported-models` auth hatalarını sessizce yakalıyor — tutarsız auth |
| M-6 | `api/agents.ts:717-744` | Proto/Trace job'ları auth olmadan gönderilebiliyor |
| M-7 | `services/session/SessionService.ts:14-35` | Session'lar in-memory Map'te — restart'ta kayboluyor, TTL yok (memory leak) |
| M-8 | `services/auth/verification.ts:23,80-105` | Brute-force lockout in-memory — restart'ta sıfırlanıyor, dağıtık atağa karşı savunmasız |
| M-9 | `db/client.ts:18-27` | Pool `on('error')` handler'ı yok — idle connection ölürse process crash |
| M-10 | `db/schema.ts:19-22` | `vector1536` adı ama aslında `vector(384)` — yanıltıcı isimlendirme |
| M-11 | `pipeline/core/orchestrator:1037,3360,...` | 7 yerde `getAgents()` pipelineId olmadan çağrılıyor — token kullanımı DB'ye yazılmıyor (özellikle Trace) |
| M-12 | `pipeline/core/orchestrator:844-853` | `runScribeAnalysis` listener cleanup `.finally` eksik — EventEmitter leak |
| M-13 | `pipeline/core/orchestrator:3528-3606` | FixLoop stale owner/repo/branch — Proto yeni branch oluştursa bile Trace eski branch'ten okuyor |
| M-14 | `pipeline/core/json-extract.ts:63-65` | Greedy JSON regex yanlış match yapabiliyor — AI yanıtının sonuna eklenen yorum dahil ediliyor |
| M-15 | `pipeline/agents/proto/ProtoAgent.ts:158-275,936` | Scaffold prompt React+Vite hardcoded — Python/Next.js isteklerinde yanlış scaffold |

### Frontend

| # | Dosya | Sorun |
|---|-------|-------|
| M-16 | `hooks/useProfileCompleteness.ts:42` | Effect boş dep array — OAuth sonrası profile status güncellenmiyor |
| M-17 | `pages/chat/hooks/useIterationChildPoll.ts:85-143` | Yeni `startPolling` çağrısında eski setTimeout chain iptal edilmiyor — ekstra network request |
| M-18 | `components/pipeline/PipelineDetailRail.tsx:350-381` | Resize handle mouse-only — touch cihazlarda çalışmıyor + unmount'ta listener leak |
| M-19 | `components/chat/ConversationSidebar.tsx:80` | `grouped` memo'da `t` dependency eksik — locale değişiminde stale label |
| M-20 | `services/api/HttpClient.ts:148-155` | 401'de hard redirect — unsaved chat input kaybolabiliyor |
| M-21 | `pages/chat/chatPageHelpers.ts:80-88` | `completed_partial` → `'idle'` yerine `'partial'` olmalı — sidebar durum noktası yanlış |
| M-22 | `services/api/workflows.ts:226,250,...` | Servis katmanında 12+ dosyada hardcoded Türkçe string |
| M-23 | `utils/errorMessages.ts` | 40+ hata mesajı sadece Türkçe — EN locale için çalışmıyor |
| M-24 | `vite.config.ts:72-91` | Auth sub-path'ler (`/auth/signup/start`, `/auth/login/start`, vb.) proxy config'de eksik — dev'de HTML dönüyor |

---

## LOW (23 bulgu)

### Backend

| # | Dosya | Sorun |
|---|-------|-------|
| L-1 | `api/auth.ts:234-345` vs `api/settings/profile.ts:30-278` | Duplicate profil/şifre yönetim route'ları — farklı validation kuralları |
| L-2 | `api/auth.ts:207` | `GET /auth/me` hata formatı `{ user: null }` — diğer endpoint'lerle tutarsız |
| L-3 | `api/github.ts:121,158` | GitHub hata mesajları client'a olduğu gibi dönüyor — bilgi sızıntısı |
| L-4 | `api/rag.ts:157-187` | RAG proxy hata mesajları Piri service'den ham olarak geliyor |
| L-5 | `server.app.ts:361-362` | `agent-activities` stub route'ları auth yok |
| L-6 | `server.app.ts:543-546` | `openapi.json` unauthenticated — API haritası açık |
| L-7 | `api/auth.invite.ts:57` | `requireAdmin` sendError sonrası `return` eksik — kırılgan |
| L-8 | `services/ai/pricing.ts:188-196` | Model prefix match bidirectional — kısa model adında yanlış fiyat |
| L-9 | `services/knowledge/verification/VerificationGateEngine.ts:297-318` | `overrideGate` + `registerEvaluator` module-level sabit'leri mutate ediyor |
| L-10 | `services/embedding/EmbeddingService.ts:24-41` | Model yükleme başarısızlığında retry mekanizması yok — kalıcı embedding kaybı |
| L-11 | `pipeline/core/security-gate/SecurityGate.ts:48-52` | Path traversal pattern `../` tüm relative import'larda false positive |
| L-12 | `pipeline/core/security-gate/SecurityGate.ts:29-33` | Secret pattern `password|secret|api_key` UI placeholder'larda false positive |
| L-13 | `pipeline/core/PipelineReconciler.ts:19-24` | `fix_loop_iteration`, `ci_running`, `critic_reviewing_*` reconciler'da eksik — stuck pipeline kurtarılmıyor |
| L-14 | `agents/scribe,proto,trace/` | Legacy agent modülleri (3332 satır dead code) — pipeline versiyonlarıyla karışabilir |
| L-15 | `pipeline/agents/scribe/ScribeAgent.ts:571,573` | `delegationPhrases` dizisinde duplicate `'sana bırakıyorum'` |

### Frontend

| # | Dosya | Sorun |
|---|-------|-------|
| L-16 | `components/ErrorBoundary.tsx` | Navigation'da error state reset olmuyor |
| L-17 | `components/chat/ChatMessage.tsx:207-241` | Blob URL'ler `URL.revokeObjectURL()` ile temizlenmiyor — memory leak |
| L-18 | `ChatInput.tsx:203`, `ConversationSidebar.tsx:266,289` | `window.confirm()` kullanımı — design system ile tutarsız |
| L-19 | `utils/mapPipelineEvent.ts:119-294` | `mapPipelineToChatMessages` dead code — `mapConversation` ile duplicate |
| L-20 | `components/chat/ChatInput.tsx:7` | `ChatAttachment` type export yeri yanlış — UI dosyasından export ediliyor |
| L-21 | `services/api/client.ts` | Legacy API client dead code — `workflowsApi`/`agentsApi` ile duplicate |
| L-22 | `postcss.config.js` vs `postcss.config.mjs` | Duplicate PostCSS config — farklı `base` ayarları |
| L-23 | `app/RouteGuards.tsx:81` | `RequireRole` guard export ediliyor ama hiç kullanılmıyor |

---

## Öncelik Sıralaması (Önerilen Fix Sırası)

### Acil — Demo/Savunma Öncesi
1. **C-1** Admin logs auth → tek satır değişiklik
2. **C-2** Dashboard metrics userId filtresi → SQL'e WHERE ekle
3. **C-6** createdFiles clearing → 3 satır sil
4. **C-7** isActive SSE reconnect → dependency array'den çıkar
5. **H-13** `completed_partial` isTerminalStage → 1 string ekle
6. **H-12** mapStageStatus eksik stage'ler → switch case'leri ekle
7. **M-21** completed_partial → partial mapping → 1 string değiştir

### Kısa Vadeli — Güvenilirlik
8. **C-5** Tool-calling retry logic → shared retry helper
9. **H-5** HttpClient AbortController → döngü içine taşı
10. **H-7** autoApprove DB persistence → store + schema güncelle
11. **H-8** Proto çelişkili format → markdown bölümünü sil
12. **M-11** Token tracking gaps → getAgents'a pipelineId geç
13. **M-13** FixLoop stale branch → Proto output'tan branch al
14. **M-15** Proto stack hardcoding → stack-aware prompt

### Orta Vadeli — Kalite
15. **C-4** Google API key header'a taşı
16. **H-11** + **M-22** + **M-23** i18n hardcoded strings → i18n catalogue'a taşı
17. **H-14** AuthContext role hardcoding → backend'den al
18. **M-24** Vite proxy eksik path'ler ekle
19. **H-9** Critic threshold dinamik inject
20. **H-10** Token budget limitleri ekle

---

## İstatistikler

- **Güvenlik bulguları:** 12 (auth bypass, IDOR, credential leak, info disclosure, user enumeration)
- **State management bug'ları:** 8 (race condition, stale state, clearing, terminal guard)
- **i18n sorunları:** 6 (hardcoded Türkçe, eksik çeviri)
- **Kaynak sızıntısı:** 5 (memory leak, listener leak, connection leak)
- **Dead code:** 5 (legacy agents, duplicate API client, unused guard)
- **AI/Prompt sorunları:** 5 (format çelişkisi, threshold uyumsuzluğu, stack hardcoding)
- **Retry/resilience:** 3 (broken retry, missing retry, no timeout)
