# Deploy Smoke Test — 2026-04-17 Wave 1 (post-merge #404 → #410)

**Deploy commit:** `d69f645` (main, `feat(workflow): smooth phase transitions in StageTimeline (#394) (#410)`)
**Deploy start:** 2026-04-17 20:42:16 UTC
**Chrome MCP session:** `claude-in-chrome` tab 322399243
**Tester account:** logged-in session (OmerYasirOnal)

## Merged PRs verified in this pass

| PR | Bug | Status | Evidence |
|---|---|---|---|
| #404 | BUG-04 "Butunluk" → "Bütünlük" | ✅ **VERIFIED** | `document.querySelector('button')` with `/bütünlük/i` match returns `["Bütünlük"]` on `/settings` |
| #404 | BUG-07 "Maksimum Agent" → "Eşzamanlı Pipeline" | ✅ **VERIFIED** | On `/settings?tab=plan`: `esZamanli: true` in DOM scan |
| #405 | BUG-11 Chat input min-height 72px + conditional expand | ✅ **VERIFIED** | After "Yeni Sohbet" click: textarea `minHeight: 72px`, `actualHeight: 72`, `rows: 3`; expand button present but `.hidden` when content empty |
| #406 | BUG-13 Hide Konsol tab from end users | ✅ **VERIFIED** | Preview panel of existing pipeline shows `["▶Onizleme", "📁Dosyalar11"]` — no Konsol in DOM (konsolAnywhere: 0) |
| #407 | BUG-15 Mühendis Modu intro modal | ✅ **VERIFIED** | `/engineer` fresh-load shows modal with "🔧Mühendis Modu nedir?" heading + 4-step explanation + "Başla" button |
| #408 | BUG-12 Spec card typography | ⏸️ DEFERRED | Requires active pipeline with spec card rendered — not exercised in this smoke; static inspection of class names in dev build confirms `text-sm` / `font-semibold` on description + feature title |
| #409 | BUG-06 Kullanım a11y | ⏸️ DEFERRED | Requires visiting `/settings?tab=usage` with user that has usage data; not explicitly verified in this pass |
| #410 | BUG-14 Phase transition animations | ⏸️ DEFERRED | Requires running pipeline to observe transition; framer-motion lazy-load confirmed via Vite build output |

## PRs still open (not in this deploy)

| PR | Bug | Category | CI |
|---|---|---|---|
| #399 | BUG-01 GitHub token unify | High-risk (user confirmation) | green |
| #400 | BUG-08 Iteration same-chat | High-risk | green (after review fixes pushed) |
| #401 | BUG-02+03 Admin unlimited | High-risk | green |
| #403 | BUG-09 Multimodal ack | High-risk | green |
| #411 | CLAUDE.md auto-test rule | doc | - |
| #412 | Playwright prod-smoke spec suite | test | - |

## Observed regressions

None.

## UI/UX signals worth noting

- Sidebar history intact, no duplicate chat entries for previously-completed pipelines
- Existing chat URLs (e.g. `/chat/63e3d93a-...`) load without 404
- `Karanlık Mod`, `Mühendis`, `Ayarlar` nav buttons all present and route correctly
- Version endpoint responds `{"commit":"d69f645","environment":"production","startTime":"2026-04-17T20:42:16.401Z"}`

## Next actions

1. Get user confirmation on high-risk PRs (#399, #400, #401, #403) → merge in order: #401 → #399 → #403 → #400
2. Run the deferred checks (#408, #409, #410) after running a fresh pipeline end-to-end
3. Verify #409 on Kullanım tab once the user has usage data accrued
4. After high-risk merges land → new wave 2 smoke report covering admin ∞, iteration same-chat, multimodal ack

## Methodology

```
1. Waited for `Deploy to Production` workflow → success
2. claude-in-chrome MCP → akisflow.com/version → confirmed commit d69f645 live
3. For each merged PR's user-observable change:
   - navigate to the relevant URL
   - javascript_tool query of DOM (aria-label / class / computed style)
   - record PASS / FAIL / DEFERRED
4. No human-in-the-loop pipeline runs in this pass (would take 3-5 min each
   and was blocked by existing admin-unlimited not being deployed yet)
```

Generated via Claude Code session.
