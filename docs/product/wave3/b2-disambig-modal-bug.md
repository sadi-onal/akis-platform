# B2 — Smoke Walkthrough GitHub-Gate Intercept

**Status:** ✅ Resolved — PR [#534](https://github.com/OmerYasirOnal/akis-platform/pull/534)
**Tür:** Smoke test fix (initially filed as modal bug — see Resolution)
**Aciliyet:** Orta (smoke walkthrough'da gözlendi, app davranışı değil)

> **Resolution (post-impl):** Bu spec başlangıçta bir "modal pointer-event"
> app bug'ı olarak yazıldı; gerçek root cause **app değil, smoke test'inde**
> çıktı. z-40 backdrop `GithubConnectGate`'in **doğru prod davranışı**
> (kullanıcı GitHub'a bağlı değilse her yeni sohbet send'inde gate açılır
> — `useHandleSend.ts:84-87` + `ChatPageLayout.tsx:222`). Smoke kullanıcısı
> her run'da fresh signup yapıyor, gate her send'de yeniden tetikleniyor,
> smoke sadece bir kez dismiss ediyordu.
>
> **Fix:** `scripts/smoke/walkthrough.mjs`'e signup + activate sonrası stub
> `github_integrations` row insert eklendi (`STUB_TOKEN_NOT_REAL`). Gate
> artık tetiklenmez; smoke 1.79s'te `awaiting_approval`'a ulaşıyor, 11
> screenshot temiz alınıyor.
>
> Aşağıdaki orijinal "approach" bölümleri tarihsel kayıt olarak duruyor —
> modal'a CSS fix gerekli değildi.

## 1. Mevcut hâl

`scripts/smoke/walkthrough.mjs` koşturulduğunda satır 217 civarı:

```
[2m  - <div class="fixed inset-0 z-40 flex items-center justify-center bg-ak-bg/80 px-4 py-8 backdrop-blur-sm">…</div> intercepts pointer events[22m
```

Bir `z-40` full-screen overlay `Yeni Sohbet Başlat` butonuna tıklamayı engelliyor. `DisambiguationModal` (`frontend/src/components/chat/DisambiguationModal.tsx`) `z-50`'de, yani intercept eden modal **farklı bir overlay** — büyük olasılıkla:

1. **GitHub-connect prompt** (`frontend/src/components/chat/GithubGate*.tsx` veya benzeri) — first-time chat'te tetiklenir
2. **Pipeline-running spinner overlay** — bir önceki idea'dan kalan
3. **Stale modal mount** — closing animation devam ederken backdrop kalıyor

Walkthrough akışında ilk `dismissBtn.click()` (satır 124-129) **bir** modal'ı kapatıyor, ama ikinci tur `Yeni Sohbet Başlat` denediğinde yeni bir modal açılmış ve dismiss edilmemiş.

## 2. Acceptance criteria

- [ ] `walkthrough.mjs` step 12 ("disambiguation smoke") soft-fail olmadan geçer
- [ ] Birinci akış (idea submit → pipeline running) bitince herhangi bir overlay mount kalmıyor
- [ ] İkinci akış (`Yeni Sohbet Başlat` tekrar tıklamak) overlay tarafından engellenmiyor
- [ ] DisambiguationModal kendisi normal çalışıyor — bu PR onu kırmıyor

## 3. Approach

**Adım 1 — Reproduce + identify (5-10 dk):**
- Playwright MCP veya tarayıcıyı manuel kullanarak ilk-pipeline-sonrası state'i incele
- DOM inspect ile `z-40` overlay'in component'ini bul (`Element > console > $0.closest('[data-testid]')`)
- Component dosyasını aç

**Adım 2 — Root cause kategorile (5 dk):**

| Olasılık | Fix |
|---|---|
| Modal close fn `null` set etmiyor; React state hala open | unmount tetikleyicisini güçlendir (useEffect cleanup veya parent state reset) |
| Backdrop animasyonu CSS `pointer-events: none` eklemiyor closing'de | Closing class'a `pointer-events-none` ekle |
| Modal stack — birden fazla overlay aynı anda render | Single-modal kuralı (state machine veya context) |

**Adım 3 — Fix + test (10 dk):**
- Minimal CSS/state fix
- `scripts/smoke/walkthrough.mjs` re-run → step 12 yeşil mi?
- Eğer mevcut bir e2e test varsa onu da koştur

## 4. Test plan

- Manuel: lokal dev → idea submit → pipeline running → kapat → yeni chat → modal'a basabiliyor muyum?
- Playwright: `walkthrough.mjs` end-to-end → no soft-fails
- Unit: değiştirilen modal/overlay component'inin mount/unmount lifecycle test'i

## 5. Risk

- **Düşük.** Tek dosya, CSS/state-level fix. Pipeline davranışı etkilenmez.
- **Olası yan etki:** stale overlay'i çok agresif unmount edersem closing animation kesilebilir (cosmetic, regression değil)

## 6. Out of scope

- Modal stack mimari overhaul (eğer 3+ paralel modal mount oluyorsa, bu ayrı bir PR'a giriyor)
- DisambiguationModal'ın kendi davranışı (zaten çalışıyor)

## 7. Cross-refs

- `frontend/src/components/chat/DisambiguationModal.tsx:99` — kendisi `z-50`, intercepting overlay değil
- `scripts/smoke/walkthrough.mjs:236` — soft-fail nokta
