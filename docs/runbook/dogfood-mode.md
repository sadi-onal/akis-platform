# Dogfood Mode — GitHub-free local exercise

**Amaç:** AKIS pipeline'ını **gerçek GitHub OAuth bağlamadan** uçtan uca koşturmak. Bakkal akışını gözle görmek, B4 push-confirm gate'ini test etmek, demo videoları çekmek için. AI **gerçek** kalır (`.env`'deki Anthropic key) — böylece Sandpack preview'da gerçek üretilmiş kodu görürsün, sahte "Hello World" değil.

> Token maliyeti: 1 pipeline ≈ $0.05–$0.15 (Anthropic Haiku/Sonnet karışımı).

## Kullanım

İki ayrı script var; her seferinde flag yazmana gerek yok:

```bash
# Normal (real GitHub + real AI)
./scripts/dev-up.sh

# Dogfood (GitHub stubbed, real AI)
./scripts/dev-up-mock.sh
```

`./scripts/dev-up-mock.sh` aslında `dev-up.sh --mock` çağıran bir alias. İstersen flag'i hala doğrudan kullanabilirsin.

**Mod değiştirmek için:**
```bash
./scripts/dev-down.sh && ./scripts/dev-up.sh        # gerçek mode
./scripts/dev-down.sh && ./scripts/dev-up-mock.sh   # dogfood mode
```

`.env`'e dokunulmaz. Flag sadece **shell-level** olarak `DOGFOOD_MODE=true` set eder ve backend'i bu env ile spawn eder.

## DOGFOOD_MODE altında ne değişir?

| Bileşen | Normal dev | DOGFOOD_MODE |
|---|---|---|
| AI provider | `.env`'deki `AI_PROVIDER` (`anthropic`) | **aynı** — gerçek AI |
| `validateGitHubAccess` (orchestrator) | Gerçek `api.github.com/user` çağrısı + token decrypt + owner lookup | Skip — stub `{ token: 'ghp_mock_dogfood', owner: 'dogfood-owner' }` döner |
| `GET /api/integrations/github/status` | DB'deki `github_integrations` row'undan okur | DB'ye bakmaz, sahte `{ connected: true, login: 'dogfood-tester' }` döner |
| Proto dryRun (B4 push gate) | Default: `awaiting_push_confirm`'da durur | **aynı** — gate'in kendisi `AUTO_PUSH_AFTER_PROTO=false` (default) ile zaten aktif |
| "GitHub'a gönder" butonu | Gerçek push | **Stub token'la 401 yer** — gate'in noktası push öncesi durdurmak; dogfood'da Cancel akışı kullanılır |

## Ne ÇALIŞIR

- Signup / login / activate (normal flow)
- `/chat` empty state + 4 demo (B3)
- Demo tıklama → **gerçek** Scribe spec üretimi (~30sn)
- **Gerçek** Critic spec review
- "Onayla" butonu → Proto dryRun
- **Gerçek** Proto kodu üretir (~60sn) — `qrcode.react` gibi gerçek library import'ları, gerçek componentlar, gerçek README
- `awaiting_push_confirm` → **PushConfirmGate** render, Sandpack preview'da **gerçek kodu** görürsün
- "İptal et" → `completed_partial`, protoOutput korunur

## Ne ÇALIŞMAZ (kasıtlı)

- "GitHub'a gönder" (confirm-push) — stub token gerçek GitHub'a 401 yer
- Gerçek repo / PR oluşturma — Pipeline complete olmaz

## Implementation referansları

- Flag tanımı: `backend/src/config/env.ts` — `DOGFOOD_MODE` schema field (`'true' | 'false'` → boolean)
- GitHub stub (orchestrator): `backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts` `validateGitHubAccess()` early-return on `process.env.DOGFOOD_MODE === 'true'`
- GitHub stub (API): `backend/src/api/integrations.ts` `GET /api/integrations/github/status` early-return
- Shell flag: `scripts/dev-up.sh --mock` (alias: `--dogfood`)

## Verified flow (2026-05-12)

`QR Kod Üretici` idea ile uçtan uca koşturuldu:

```
scribe_generating → critic_reviewing_spec → awaiting_approval (~36s)
→ approve → proto_building → critic_reviewing_code → awaiting_push_confirm (~60s)
→ cancel-push → completed_partial
```

18 dosyalık React + Vite + qrcode.react scaffold. `branch: 'dry-run'`, `metadata.committed: false`. GitHub'a hiç değmedi.

## Bakım notu

Yeni bir dış servis (Stripe, başka MCP gateway, vb.) eklenirse, DOGFOOD_MODE altında stub davranışı eklenmesi düşünülmeli. Pattern: composition-root noktasında `if (process.env.DOGFOOD_MODE === 'true') return stub`.
