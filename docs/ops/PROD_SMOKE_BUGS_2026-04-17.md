# Prod Smoke Test — Bug Log (2026-04-17)

**Ortam:** `akisflow.com` (prod)
**Tester:** Ömer Yasir Önal (engomeryasironal@gmail.com, admin)
**Versiyon (UI sidebar):** AKIS v0.6.0 — *CLAUDE.md v0.6.5 diyor (muhtemel mismatch)*
**Oturum başlangıcı:** Ayarlar sayfası turu

## GitHub Issue Haritası

| Bug | Issue | Severity | Branch önerisi |
|---|---|---|---|
| BUG-01 | [#381](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/381) | 🔴 | `fix/unify-github-token-storage` |
| BUG-02 | [#382](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/382) | 🔴 | `fix/usage-plan-counter-coherence` |
| BUG-03 | [#383](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/383) | 🟠 | `fix/admin-unlimited-ui-gating` |
| BUG-04 | [#384](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/384) | 🟡 | `fix/integrity-tab-label-and-content` |
| BUG-05 | [#385](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/385) | 🟡 | `feat/avatar-upload` |
| BUG-06 | [#386](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/386) | 🟡 | `fix/usage-page-a11y-typography` |
| BUG-07 | [#387](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/387) | 🟢 | `fix/plan-terminology-agent-vs-pipeline` |
| BUG-08 | [#388](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/388) | 🔴 | `fix/iteration-continues-same-pipeline` |
| BUG-09 | [#389](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/389) | 🟠 | `fix/multimodal-ack-feedback` |
| BUG-10 | [#390](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/390) | 🟠 | `feat/agent-conversational-narration` |
| BUG-11 | [#391](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/391) | 🟡 | `fix/chat-input-sizing-and-expand` |
| BUG-12 | [#392](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/392) | 🟡 | `fix/spec-card-typography` |
| BUG-13 | [#393](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/393) | 🟡 | `fix/hide-internal-ui-from-end-users` |
| BUG-14 | [#394](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/394) | 🟡 | `feat/pipeline-phase-transitions` |
| BUG-15 | [#395](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/395) | 🟠 | `feat/engineer-mode-intro-and-fix` |
| VERIFY-Jira | [#396](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/396) | 🟢 | `verify/jira-integration-e2e` |
| VERIFY-Cucumber | [#397](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/397) | 🟢 | `verify/cucumber-bdd-e2e` |

**Kapatılan eski issue'lar:** #333, #316, #315, #314, #313, #312, #311, #310, #250 (hepsi bu sweep ile supersede edildi).

---

## Severity Legend
- 🔴 **Blocker** — golden-path'i kıran, fix olmadan ileri gidilmez
- 🟠 **High** — fonksiyonel bozuk ama workaround var
- 🟡 **Medium** — cosmetic / UX / küçük yanlışlık
- 🟢 **Low** — nice-to-have iyileştirme

---

## BUG-01 🔴 GitHub bağlantısı UI'da tutarsız — iki ayrı storage, senkron değil
- **Konum:** Üst banner + `/engineer` sayfası + Settings > Integrations
- **Semptom:**
  - Settings > Integrations → GitHub: **"Bağlı"** (OmerYasirOnal, OAuth)
  - Üst banner → **"Profilinizi tamamlayın: GitHub"** (bağlı değil algısı)
  - `/engineer` sayfası → **"GitHub bağlı değil. Ayarlar > Entegrasyonlar üzerinden GitHub bağlantısı yapın."**
  - Onboarding wizard'da GitHub'a git → callback sonrası chat'e dön → banner hâlâ orada
- **Kök neden (code verified):**
  - İki ayrı `getGitHubToken()` fonksiyonu var:
    - `backend/src/api/github.ts:45` → `users.githubToken` kolonundan okuyor (PAT storage)
    - `backend/src/api/integrations.ts:59` → `oauthAccounts` tablosundan okuyor (OAuth storage)
  - OAuth login → `oauthAccounts`'a yazıyor
  - `/api/github/status` (banner, engineer page'in baktığı endpoint) → `users.githubToken`'a bakıyor → `null` → "bağlı değil"
  - Dolayısıyla aynı user için iki farklı "connected" durumu var
- **Önerilen fix:** `getGitHubToken()` tek kaynağa (oauthAccounts + fallback) normalize edilmeli. İki fonksiyon birleşmeli, `/api/github/status` OAuth-aware olmalı.
- **Priorite:** Pipeline (Proto push), Engineer modu, Profile completion — hepsi bloke → **🔴 Blocker**

## BUG-15 🟠 Mühendis Modu (`/engineer`) amacı belirsiz + GitHub check kırık
- **Konum:** `/engineer` → 4-step wizard (Repo Seç → Task Discovery → Time & Budget → Confirm)
- **Semptom:**
  - Sayfanın ne işe yaradığı landing/docs'ta yok (kullanıcı notu: *"bu mühendis ne işe yarayacak bilmiyorum"*)
  - GitHub entegrasyonu bağlı olmasına rağmen "bağlı değil" diyor (BUG-01'in ikincil semptomu — aynı `/api/github/status` çağrısı)
- **Beklenen:**
  - Kısa açıklama kartı ("Mühendis Modu nedir?" → "Mevcut repo'ya AI mühendis kiralayın, belirlediğiniz süre içinde issue/task'larınızı çözsün")
  - GitHub bağlıysa doğrudan repo listesi
- **Önerilen fix:** BUG-01 ile birlikte çözülür. Üstüne bir intro modal eklenebilir.

---

## Entegrasyonlar Sağlık Raporu (kullanıcı isteği)

### GitHub — ✅ Bağlı ama UI tutarsız
Bkz BUG-01. Backend tarafında OAuth token `oauthAccounts` tablosunda ama `/api/github/status` eski PAT storage'ına bakıyor.

### Jira / Atlassian — ⚠️ Henüz bağlanmadı (kod mevcut, test edilmedi)
- Kod: `backend/src/services/atlassian/AtlassianOAuthService.ts`, `backend/src/api/integrations.ts`, `backend/src/pipeline/integrations/jiraIntegration.ts`
- Testler: `backend/test/unit/integrations-jira-oauth.test.ts`, `backend/test/unit/jira-integration.test.ts`
- MCP Adapter: `backend/src/services/mcp/adapters/JiraMCPService.ts`
- UI: "Atlassian ile Bağlan" (OAuth) + "API token ile bağlan" (alternatif)
- **Durum:** Kod hazır görünüyor, ama live akış test edilmedi. Bağlanmadan Cucumber Trace output'una Jira-issue otomatik bağlanması çalışıyor mu bilinmiyor.
- **Aksiyon:** Jira bağla → test pipeline çalıştır → issue auto-create var mı doğrula

### Slack — 🔜 Yakında
UI'da disabled, kod implementasyonu yok. Landing/docs'ta "yakında" yazması tutarlı.

### Cucumber / BDD — ✅ Toggle aktif, kod mevcut
- Kod: `backend/src/pipeline/integrations/cucumberGenerator.ts`
- Test: `backend/test/unit/cucumber-generator.test.ts`
- Trace agent'da referans: `backend/src/pipeline/agents/trace/TraceAgent.ts` (grep hit)
- UI açıklaması: *"Etkinleştirildiğinde, Trace agent'ı Playwright testlerinin yanında .feature dosyaları oluşturur ve GitHub branch'ine push eder."*
- **Durum:** Toggle aktif, ama end-to-end doğrulanmadı. Son Trace akışında `.feature` dosyası üretildi mi bilinmiyor.
- **Aksiyon:** Trace akışı çalıştır → repo'da `.feature` dosyası var mı kontrol et → yoksa toggle'ın gerçekten backend'e geçip geçmediğine bak

---

## BUG-02 🔴 Kullanım/Plan sayaç tutarsızlığı
- **Konum:** `/settings?tab=usage` ve `/settings?tab=plan`
- **Semptom:** Aynı sayfada çelişkili sayılar:
  - Üst kart: **92.2K Token Kullanımı**
  - Altta "Aylık Token Limiti": **0 / 20.0K** (limit barı boş)
  - Detaylı Dağılım: Giriş 45.6K + Çıkış 46.6K = 92.2K ✓ (bu tutarlı)
  - Ücretsiz Kota 100.0K, Kalan 7.8K ← **Kalan Token (Ay) kartı 20.0K diyor**
  - Günlük İş Limiti: **7 / 3** (limit aşılmış, kırmızı bar, ama iş çalışmaya devam etmiş)
- **Beklenen:**
  - Admin → sınırsız (limit hiç tüketilmemeli veya "∞" gösterilmeli)
  - En azından iki kart aynı sayıyı göstermeli
- **Şüpheli yerler:**
  - Backend `usage` endpoint'i iki farklı kaynaktan okuyor (ay başı reset + cumulative counter mismatch)
  - Admin bypass'i business logic'te var ama UI gösteriminde yok
- **Priorite:** 🔴 (admin test edemez, limit'e takılır)

---

## BUG-03 🟠 Admin hesabı sınırsız olmalı ama günlük 3 iş limitine takılıyor
- **Konum:** `/settings?tab=plan` → "Admin hesabınız sınırsız erişime sahiptir" yazıyor AMA üstte "Bugün 7 / 3 iş" ve "Günlük İş Limiti: 3"
- **Semptom:** UI admin-unlimited mesajı gösteriyor ama plan limit enforcement hâlâ aktif gibi görünüyor
- **Beklenen:**
  - Admin için bütün limitler `∞` gösterilmeli VEYA
  - "Admin sınırsız" mesajı + limit kartları hidden
- **Şüpheli yerler:**
  - Frontend: `/settings` plan tab'da admin-check var ama sadece bir mesaj ekliyor, limit kartlarını gizlemiyor
  - Backend: admin bypass'i istek kabul ederken mi çalışıyor, yoksa hiç mi çalışmıyor? (7 iş geçmiş olması bypass'in çalıştığını ama UI'nin yansıtmadığını gösteriyor olabilir)
- **Bağıntılı:** BUG-02 ile aynı kök neden olabilir

---

## BUG-04 🟡 "Butunluk" tab'i — yazım yanlışı + içi boş
- **Konum:** `/settings` tab bar → "Butunluk"
- **Semptom:**
  - Doğrusu: **Bütünlük** (Turkish: "Integrity" — tez temasıyla ilgili)
  - Tab içi aktif içerik yok (tam olarak ne olduğunu görmedim, user notu)
- **Beklenen:** Düzgün Türkçe + anlamlı içerik (integrity/verification metrikleri)
- **Priorite:** 🟡 — tez temasıyla doğrudan bağıntılı, demo'da göze çarpar

---

## BUG-05 🟡 Profil resmi yükleme yok
- **Konum:** `/settings?tab=profile` → Profil kartı
- **Semptom:** Sadece baş harfi avatar (Ö), resim upload butonu yok
- **Beklenen:** Avatar'a tıklayınca dosya seçme, yükleyince kaydolma
- **Priorite:** 🟡 — feature gap, şu an tam hata değil

---

## BUG-06 🟡 Kullanım sayfasında bazı yazı/sayılar çok küçük/okunamıyor
- **Konum:** `/settings?tab=usage`
- **Semptom:** Günlük Aktivite grafiğinin altındaki "17 Nis — 7 iş — 92.2K — $0.0000" satırı ve limit bar'ların üzerindeki sayılar küçük
- **Beklenen:** Min font-size, contrast kontrolü
- **Priorite:** 🟡 accessibility

---

## BUG-07 🟢 "Maksimum Agent: 1" — platform 3 agent'lı (Scribe/Proto/Trace) ama limit 1 diyor
- **Konum:** `/settings?tab=plan` → Plan Limitleri
- **Semptom:** Platform sequential 3-agent pipeline, ama limit "1 agent" gösteriyor. Concept-mismatch — "agent" burada "eşzamanlı pipeline" mi, yoksa "pipeline içi agent sayısı" mı belirsiz.
- **Beklenen:** Terminoloji netleştir ("Eşzamanlı Pipeline: 1" gibi)

---

---

## Chat / Pipeline Akış Turu (21:05–21:08)
**Kullanılan prompt:** "bana bir todo app yap" → spec üretildi → onaylandı → Proto 11 dosya / 578 satır → Preview açıldı (yeşil tema, 3 örnek todo). İlk pipeline akışı **başarıyla** tamamlandı ✓

Sonrasında iteration için resim + text prompt gönderildi ("bu resimdeki iconları değiştir"). Burada sorunlar başladı.

---

## BUG-08 🔴 Iteration prompt (resim+text) yeni sohbet açıyor — aynı sohbette devam etmiyor
- **Konum:** Chat preview açıkken altta "Projeniz hazır! Değişiklik isteği yazarak yeni iterasyon başlatın." alanından prompt göndermek
- **Semptom:**
  - Eski chat ID: `63e3d93a-4548-4eda-9cb6-09369f1dcc15`
  - Yeni prompt sonrası URL: `55d165ff-7638-4321-baf1-c0e0369f6ce5` → **yeni chat oluştu**
  - Sidebar'da iki ayrı kayıt: "Basit Todo Uygulaması" + "Bu resimdeki gördüğün..."
  - Proto önceki kod üstüne iterate etmek yerine sıfırdan 14 dosya yazdı (tema yeşilden mora atladı — yani önceki scaffold tamamen göz ardı edildi)
- **Beklenen:** Iteration prompt aynı chat'te devam etmeli, Proto mevcut repo'yu okuyup üstüne değişiklik yapmalı
- **Şüpheli yerler:**
  - `frontend/src/pages/chat/ChatPage.tsx` → iteration mesajında muhtemelen `/api/pipelines` (yeni) çağrısı, `/api/pipelines/:id/message` değil
  - Backend: "iteration" endpoint'i var mı, yoksa her mesaj yeni pipeline mi başlatıyor?
- **Priorite:** 🔴 — iteration tamamen bozuk, tek shot kullanım oluyor

## BUG-09 🟠 Resim prompt'u gerçekten parse edildi mi belirsiz
- **Konum:** Aynı iteration denemesi (Screenshot 4→5)
- **Semptom:** Resim upload edildi ("Screenshot 2026-..."), Proto tamamen farklı bir şey üretti (mor tema, 0 örnek todo, farklı layout). Kullanıcıya hiçbir dönüş yok — "resmi gördüm/görmedim" mesajı yok.
- **Beklenen:** Scribe/Proto "resim OK, X noktaları anladım, şu değişiklikleri uygulayacağım" gibi dönüş vermeli
- **Araştırılacak:**
  - `backend/src/pipeline/services/FileUploadService.ts` — multipart upload gerçekten Scribe/Proto'ya inject ediyor mu?
  - Multimodal content type Anthropic API'ye `image` block olarak mı gidiyor?
- **Bağıntılı:** BUG-08 ile birlikte — yeni chat açıldığı için image context'i zaten kopmuş olabilir

## BUG-10 🟠 Agent'lar sohbet etmiyor, sadece kod/output fırlatıyor
- **Konum:** Tüm Proto/Trace adımları
- **Semptom:** Agent "Scaffold oluşturuldu — 11 dosya, 578 satır" gibi tek satır atıyor. Ne yaptığını, hangi kararları aldığını, kullanıcının isteğini nasıl yorumladığını anlatmıyor.
- **Beklenen (user quote):** *"konuşsun benimle anlatsın aynı senin gibi ama hiç bir şey yazmıyor"* — agent'lar Claude gibi konuşmalı: "Resmi gördüm, X icon'ları kırmızıdan yeşile değiştireceğim, onay veriyor musun?"
- **Şüpheli yerler:**
  - Proto/Trace prompt'larında "reasoning/narration" output'u yok, sadece tool_use ile kod yazıyor
  - Frontend streaming chunks'ı sadece "scaffold oluşturuldu" gibi sistem mesajı gösteriyor
- **Priorite:** 🟠 — UX olarak kritik, "karanlıkta çalışan agent" hissi veriyor

## BUG-11 🟡 Chat input kutusu çok küçük + "büyütme" butonu çalışmıyor
- **Konum:** Chat sayfası alt mesaj yazma alanı
- **Semptom:**
  - Input tek satır görünüyor, uzun prompt yazmak zor
  - Yanındaki expand/büyütme ikonu tıklayınca hiçbir şey olmuyor
- **Beklenen (user quote):** *"gerektiğinde çıksın sadece"* — expand butonu sadece içerik uzunsa görünmeli, yoksa hiç gösterilmemeli
- **Şüpheli yerler:** `frontend/src/components/chat/ChatPanel.tsx` (bu dosya zaten şu an `feat/S0.5.X-pipeline-stall-indicator` branch'inde modified — input-size ile ilgili başka çalışma devam ediyor)

## BUG-12 🟡 Spec kartında tipografi/kontrast — okumak zor
- **Konum:** "Proje Planı" kartı (Scribe output)
- **Semptom:** Özellikler, açıklama, teknik seçimler kısmında yazılar soluk, font boyutu/kontrast düşük
- **Beklenen:** Heryerde okunabilir, tutarlı tipografi (liquid-glass tema içinde bile yazı kontrast WCAG AA)
- **Priorite:** 🟡 accessibility

## BUG-13 🟡 "main/repo/Preview" üst bar bilgileri fazla agresif
- **Konum:** Preview ekranı üst şerit: `basit-todo-uygulamasi | main | Preview` ve "Konsol" sekmesi
- **Semptom (user quote):** *"repo kısımları trace buttonu falan bir süre daha gözüküyor"* — yani phase geçişinde eski UI kalıntıları ekranda kalıyor
- **Beklenen:** Phase transition animasyonu smooth, eski chips fade-out
- **Ek:** *"konsol bi rişe yaramıyor pipeline'ın bilgilerini göstermeyelim kullanıcıya"* — Konsol tab'i internal log gösteriyor, son kullanıcı için saklanmalı (debug modunda aç)

## BUG-14 🟡 Phase transition animasyonu eksik
- **Konum:** Scribe → Proto → Trace geçişleri
- **Semptom (user):** *"başlatıyorum basit bir task güzel animasyonluca geçmeli bir sondaki yere"*
- **Beklenen:** Aşamalar arası smooth görsel geçiş (timeline/stepper animasyonu, eski kart fade-out)

---

## Başarıyla Çalışan (Pozitif)
- ✅ Landing → Chat → Scribe spec üretimi (hızlı, düzgün Türkçe)
- ✅ Spec onay akışı + auto-progress to Proto
- ✅ Proto → GitHub repo oluşturma → scaffold (11 dosya)
- ✅ Preview (Sandpack) çalışıyor, todo ekleme/silme fonksiyonel
- ✅ Web/Mobile toggle UI mevcut (Screenshot 3)

---

## Henüz Test Edilmedi (next steps)
- [ ] Trace fazı (yukarıdaki 2 pipeline'da Trace'e geçildi mi belirsiz — screenshot yok)
- [ ] AI Sağlayıcılar sekmesi — kendi anahtar ekleme/silme
- [ ] Entegrasyonlar sekmesi
- [ ] Butunluk sekmesi içeriği (detay)
- [ ] Pipeline İstatistikleri sekmesi
- [ ] Cancel (iptal) butonu
- [ ] Mobile/responsive view
- [ ] Retry sonrası davranış

---

## Fix Planı Önerisi (öncelik sırası — güncel)

### Tier 1 — Pipeline'ı bozan (blocker)
1. **BUG-08** Iteration yeni chat açıyor → `fix/iteration-continues-same-chat`
2. **BUG-01** GitHub OAuth persist olmuyor → `fix/oauth-github-persist-connection`
3. **BUG-02 + BUG-03** admin/usage sayaç tutarsızlığı → `fix/admin-unlimited-usage-coherence`

### Tier 2 — UX kritik
4. **BUG-10** Agent'lar konuşmuyor (Proto/Trace narration) → `feat/agent-conversational-output`
5. **BUG-09** Resim prompt'u işlendi mi belirsiz → `fix/multimodal-input-feedback`
6. **BUG-13** Konsol tab'i ve repo chips'leri prod UI'da fazla → `fix/hide-internal-ui-from-users`

### Tier 3 — Polish
7. **BUG-11** Chat input size + expand button → `fix/chat-input-sizing` *(şu anki branch'te zaten iş var)*
8. **BUG-12** Spec tipografi/kontrast → `fix/spec-card-readability`
9. **BUG-14** Phase transition animasyonu → `feat/pipeline-phase-transitions`
10. **BUG-04** "Butunluk" → "Bütünlük" + içerik → `fix/integrity-tab-label-and-content`
11. **BUG-05, 06, 07** Settings polish (avatar, typography, agent terminology) → `chore/settings-polish-bundle`

### Öneri: Bundling
- Tier 1'i **tek mega PR** yapma, her bug ayrı PR (review + rollback kolay olsun)
- Tier 3'te 5-7 arası tek "polish PR"ında birleşebilir
- Her PR öncesi `pnpm -C backend typecheck && lint && test:unit && build` + `pnpm -C frontend ...` (CLAUDE.md quality gate)

---

## Kullanıcının Direkt İstekleri (Feature/Change Requests)

| # | İstek | Kaynak |
|---|---|---|
| R1 | Profile picture upload eklenmeli | Screenshot 1 |
| R2 | Kullanım/Plan'da admin sonsuz olmalı, token artmalı | Screenshot 3,4 |
| R3 | Kullanım sayfasında küçük yazılar büyütülmeli | Screenshot 3 |
| R4 | "Bütünlük" sekmesi anlamlı içerik almalı | Screenshot tabs |
| R5 | Entegrasyonlar sekmesi geliştirilmeli | kullanıcı notu |
| R6 | Phase geçişlerinde smooth animasyon | "animasyonluca geçmeli" |
| R7 | Trace/repo chips phase bitince UI'dan inmeli | "bir süre daha gözüküyor" |
| R8 | Mesaj yazma alanı büyütülmeli, expand butonu conditional | "çok ufak kalmış" |
| R9 | Spec kartı okunaklı hale gelmeli (font/renk) | "yazılar okunmuyor" |
| R10 | Auto-approval akışı ("direkt oluşturdu") iyi — korunmalı | "güzel" |
| R11 | Konsol tab'i end-user'dan gizlenmeli | "bir işe yaramıyor" |
| R12 | Aynı chat'te iterasyon, yeni chat açılmamalı | "aynı chatte devam etmeli" |
| R13 | Agent'lar Claude gibi sohbet etmeli, kararlarını açıklamalı | "konuşsun benimle anlatsın" |
| R14 | Resim prompt'unda Scribe/Proto "gördüm, şunu anladım" demeli | "görüyor mu ona göre bir şey yaptı mı" |
