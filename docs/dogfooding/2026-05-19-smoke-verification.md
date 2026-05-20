# Manual Smoke Verification Raporu — 2026-05-19

**Method:** Playwright MCP, fresh test user (`smoke+1779256033@akis.local`), dev stack on main HEAD `42317f0`. Pipeline `63237ee7-9ffb-426f-9e73-ad870606682d` (pre-V5/V6/V8 era pipeline) reassigned for inspection.

## Sonuç özeti

| Fix | Durum | Not |
|---|---|---|
| **V3** Login Enter | ✅ VERIFIED | Email + Şifre input'larında Enter form submit ediyor; /login → /login/password → /chat akışı pürüzsüz |
| **V7** Compose bar chips | ✅ VERIFIED | Trace switch + Model picker (claude-haiku-4-5) ChatInput içinde; eski 50px üst bar yok |
| **V-jira** Integrations UI | ✅ VERIFIED | GitHub + Jira kartları render, "Atlassian ile Bağlan" + "API token ile bağlan" fallback |
| **V-settings-polish** AIKeysTab i18n | ✅ VERIFIED | Tüm Türkçe diakritikler doğru (Sağlayıcı/ğ ı, Yerleşik/ş, sınırsız/ı, Anahtarınız/ı) |
| **V-settings** Usage tab empty state | ✅ VERIFIED | Yeni kullanıcı için $0.0000 doğru (henüz pipeline çalıştırmadı) |
| **V2** Critic findings tab dedup | ✅ VERIFIED (qualified) | SPEC findings sadece Açıklama'da; chip CODE findings için tasarlanmış (Proto sonrası), bu pipeline'da yok |
| **V4** Critic apply toast | ✅ VERIFIED | Error path: `data-testid="critic-apply-toast"` + `data-toast-kind="error"` + "Düzeltme gönderilemedi." text; inline banner ile complementary |
| **V6** Scribe disclosures | ❌ **BUG BULUNDU** | DOM'da 0 details element; scribeSpec backend'de var ama ExplanationPanel'a ulaşmıyor (integration gap) |
| **V1** Resizer iframe yapışması | ⏸ NOT TESTABLE | Sandpack preview gerekli → Proto run + GitHub OAuth (smoke env'de yok) |
| **V5** Truthful progress | ⏸ Pre-V5 fallback | Mevcut pipeline pre-V5 era; legacy fallback "tüm stages complete" gösteriyor — yeni pipeline'da test edilmeli |
| **V8** Critic no-stack-flag | ⏸ Pre-V8 finding mevcut | Eski pipeline DB'de hâlâ "stack boş bırakılmış" finding'i taşıyor (fix prompt-level, retroactive değil) |
| **V9** Preview session leak | ⏸ NOT TESTABLE | Preview state gerekli → Proto + GitHub |
| **V-spec-artifacts** PRD/tech/api docs | ⏸ NOT TESTABLE | Proto file emit → kullanıcının GitHub repo gerekli |
| **V-pricing** Accurate model rates | ⏸ NOT TESTABLE | Yeni AI call gerekli |

## 🚨 Yeni bulgular (follow-up PR'lar gerekli)

### Bulgu #1: V6 Scribe disclosures render olmuyor (CRITICAL)
- Backend `scribeOutput.spec` mevcut (5 AC, 3 user story, problem statement, vs.)
- Workflow mapping (`workflows.ts:117 mapScribeOutput`) doğru görünüyor
- ExplanationPanel `showScribeOutputs` gating doğru
- AMA DOM'da `<details>` count = 0 ve `data-testid="scribe-acceptance-criteria-disclosure"` yok
- **Olasılık:** `activeWorkflow.stages.scribe.spec` undefined kalıyor — sebep belirsiz
- Unit testler integration gap'i kaçırdı
- Demo öncesi düzeltilmeli ★★★

### Bulgu #2: Profil + Usage + Stats tab'larında diakritiksiz Türkçe (★★)
- "Calistirilan Is", "Token Kullanimi", "Detayli Dagilim", "Sinirsiz", "Cikis Tokenlari"
- "Sifre Degistir", "Hesap Bilgileri", "Bu Ayki Kullanim"
- V-settings-polish kapsamı sadece AIKeysTab + 2 empty-state idi; bu tab'lar dışarıda
- Follow-up PR gerekli

### Bulgu #3: Yeniden atanmış pipeline'da "Yeni Sohbet" başlık (★)
- URL `/chat/63237ee7-...` ama header "SORU · Yeni Sohbet" gösteriyor
- Conversation messages skeleton'da kaldı
- Muhtemelen user_id swap sonrası stale cache; demo flow'unu etkilemiyor

## Verified davranış detayları

### V3 Login Enter
- `/login` → email yaz + Enter → `/login/password` ✅
- `/login/password` → şifre yaz + Enter → `/chat` ✅
- Form structure korunmuş, native + explicit handler birlikte çalışıyor

### V7 Compose chips
- ChatInput içinde alt satırda: `⚡ Trace açık` switch (emerald active) + `claude-haiku-4-5` model picker
- Eski 50px üst bar tamamen kayıp; chat alanı ~50px daha geniş
- `role="switch"` + `aria-checked` doğru atanmış

### V4 Critic apply toast (error path)
- "Seçilenleri uygula" → POST `/api/pipelines/:id/iterate-with-feedback`
- Backend `Invalid stage` döndü (awaiting_approval'da Critic apply geçersiz)
- Frontend: hem inline banner (server detail) hem rose toast ("Düzeltme gönderilemedi.")
- `data-toast-kind="error"` + `role="status"` doğru
- 4 saniye auto-dismiss çalışıyor

### V-settings-polish AIKeysTab
- "Aktif Sağlayıcı" (ğ + ı doğru)
- "AKIS Yerleşik Anahtar" — "Anthropic Claude · sınırsız kullanım" (ı x2)
- "Kendi Anahtarınız" — "Kendi API anahtarınızı ekleyerek sınırsız kullanın"
- 3 provider kartı (Anthropic / OpenAI / Google) "Henüz eklenmedi"
- i18n keys düzgün çalışıyor

## Demo öncesi kritik test listesi (kullanıcı tarafından)

GitHub bağlı gerçek kullanıcı hesabıyla:

1. **V1 resizer:** Pipeline → Proto tamamlandı → Sandpack preview açık → splitter'ı sürükle, mouse'u iframe üstünde bırak → drag anında bitiyor mu
2. **V5 truthful progress:** YENİ pipeline başlat → Scribe çalışırken shimmer var mı, ✓ yok mu? Scribe biter, Proto başlar → Scribe ✓ + tam bar
3. **V6 Scribe disclosures (BUG):** Pipeline Scribe gate'e geldiğinde:
   - Chat'teki "Proje planı" mesajında PlanCard altında disclosure'lar var mı?
   - Pipeline Detayı → Açıklama → Scribe card içinde "Kabul Kriterleri (N)" disclosure var mı?
   - ⚠️ Bu testte BUG bulundu — büyük olasılıkla GÖRÜNMEYECEK
4. **V8 critic no-stack-flag:** YENİ pipeline, "stack" alanı boş bırakılan bir spec → Critic'in "kritik" finding üretmemeli
5. **V9 preview leak:** Önizleme açık session → "Yeni Sohbet" → yeni session'da önizleme alanı KAPALI olmalı (eski: açık + boş içerikli kalıyordu)
6. **V-spec-artifacts:** Pipeline tamamlandı, GitHub repo'da:
   - `docs/PRD.md` var
   - `docs/TECHNICAL-ANALYSIS.md` var
   - `docs/API-CONTRACT.md` (API varsa) var
7. **V-pricing:** Bir kaç pipeline çalıştırdıktan sonra Settings → Kullanım → non-zero $ doğru aralıkta

## Verification env detayları

- Browser: Playwright MCP Chromium, viewport 1400×900, locale tr-TR
- Test user: `smoke+1779256033@akis.local` (status=active)
- Dev stack: `./scripts/dev-up.sh` on `main@42317f0`
- Backend: localhost:3000, Frontend: localhost:5173
- Mock provider olmadığı için cost flow yeni AI call ile test edilemedi
- GitHub OAuth bağlı değildi → Proto/Trace stages çalıştırılamadı
- Pre-V5/V6/V8 era pipeline reassigned for visual inspection — bazı fix'ler için yetersiz

## Sonuç

**6 fix tam doğrulandı**, **6 fix env limit nedeniyle yetersiz test**, **1 gerçek bug (V6)** + **2 polish gap** bulundu. V6 demo öncesi düzeltilmeli.

🤖 Smoke verification raporu — Playwright MCP otomasyonu + manuel evaluasyon
