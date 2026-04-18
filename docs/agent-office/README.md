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
- `spawning` (dev) → fade-in
- `done` (dev) → fade-out, log'a satır düşer

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
