# AKIS Agent Office

Canlı pixel-art dashboard. PM → Senior → Developer agent hiyerarşisini görselleştirir.

## Açma

Herhangi bir tarayıcıda dosyayı aç:

```
open docs/agent-office/index.html
```

Veya Claude Code oturumunda Chrome MCP ile:

```
mcp__Claude_in_Chrome__navigate url="file:///<repo>/docs/agent-office/index.html"
```

## Nasıl çalışır

1. `state.json` tek kaynak gerçeklik. Claude (main session) Write tool ile günceller.
2. `index.html` her 500ms fetch eder, diff'i animasyonla ekrana yansıtır.
3. Oturum başında Claude `state.initial.json` → `state.json` kopyalar.

## Karakterler

| Rol | Renk | Aksesuar |
|---|---|---|
| PM | navy + gold tie | klipboard |
| Sr Frontend | orange | fırça |
| Sr Backend | green | terminal |
| Sr AI/Platform | purple | chip |
| Sr QA | lab white + red | büyüteç |
| Developer | gray | baret |

## Status değerleri

- `idle` → masasında oturur, nefes animasyonu
- `planning` / `triaging` / `reviewing` → düşünme bubble'ı
- `working` → typing animasyonu + task bubble
- `walking` → hızlı bacak salınımı (bir sonraki delegation'a yürüyor)
- `spawning` (dev) → fade-in
- `done` (dev) → fade-out, log'a satır düşer

## Walking animation (delegation moments)

Her karakter isteğe bağlı olarak `walkTo: "<role-key>"` field'ı taşıyabilir.
Set edildiğinde karakter hedefin %40'ı kadar o yöne sinüzoidal oscillate
eder + küçük dikey bob (2s döngü).

Kullanım: PM delegation anı için aşağıdaki gibi:

```json
"pm":      { "status": "walking", "task": "delegating #429", "walkTo": "backend" }
"backend": { "status": "walking", "task": "meeting PM",      "walkTo": "pm" }
```

İki karakter birbirine doğru oscillate eder (toplantı efekti). İş başlayınca
`walkTo: null` + `status: "working"` yap — karakter masasına döner.

## State protokolü

Detay: `docs/superpowers/specs/2026-04-18-senior-hierarchy-agent-office-design.md` §4.2.

Özet:

```json
{
  "ts": "ISO-8601 timestamp",
  "pm": { "status": "...", "task": "...", "issueNumber": 123 },
  "seniors": {
    "frontend": { "status": "...", "task": "...", "issueNumber": 123, "devs": [...] },
    "backend":  { "..." },
    "ai":       { "..." },
    "qa":       { "..." }
  },
  "log": ["[HH:MM:SS] event", "..."]
}
```

## CLAUDE.md linki

Hiyerarşi kullanımı: `CLAUDE.md` → "PM → Senior → Developer İş Akışı" bölümü.
