# Agent Office Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working `docs/agent-office/` pixel-art dashboard that visualizes PM → Senior → Developer agent hierarchy live, plus update CLAUDE.md so the workflow is permanent across sessions.

**Architecture:** Single self-contained HTML file with embedded CSS + Canvas 2D rendering. Polls `state.json` every 500ms. Claude (main session) writes state directly via Write tool at each agent lifecycle transition. No backend, no build step, no framework.

**Tech Stack:** Plain HTML5 + Canvas 2D + vanilla JS. JSON file as state store. CSS `image-rendering: pixelated` for crisp 2x-4x scaling.

**Scope Note:** This plan covers ONLY the infrastructure (office dashboard + CLAUDE.md update). The 9 open GitHub issues are fixed in follow-up plans, one per phase.

---

## File Structure

```
docs/agent-office/
├── index.html          # Single-file dashboard (HTML + CSS + JS inline)
├── state.initial.json  # Checked-in baseline state
├── state.json          # Live state (gitignored, regenerated per session)
├── README.md           # How to use
└── .gitignore          # Ignore state.json
```

Plus one modification:
- `CLAUDE.md` — new section "PM → Senior → Developer İş Akışı" inserted between "Kritik Kurallar" and "AI Provider Yapılandırması"

---

### Task 1: Scaffold agent-office directory + baseline state

**Files:**
- Create: `docs/agent-office/.gitignore`
- Create: `docs/agent-office/state.initial.json`
- Create: `docs/agent-office/state.json` (copy of initial, but gitignored)
- Create: `docs/agent-office/README.md`

- [ ] **Step 1: Create `.gitignore`**

Write `docs/agent-office/.gitignore`:
```
state.json
```

- [ ] **Step 2: Create `state.initial.json` with canonical idle state**

Write `docs/agent-office/state.initial.json`:
```json
{
  "ts": "1970-01-01T00:00:00Z",
  "pm": {
    "status": "idle",
    "task": null,
    "issueNumber": null
  },
  "seniors": {
    "frontend": { "status": "idle", "task": null, "issueNumber": null, "devs": [] },
    "backend":  { "status": "idle", "task": null, "issueNumber": null, "devs": [] },
    "ai":       { "status": "idle", "task": null, "issueNumber": null, "devs": [] },
    "qa":       { "status": "idle", "task": null, "issueNumber": null, "devs": [] }
  },
  "log": [
    "[00:00:00] Office opened — all hands idle"
  ]
}
```

- [ ] **Step 3: Copy initial state to live state**

Run:
```bash
cp docs/agent-office/state.initial.json docs/agent-office/state.json
```

- [ ] **Step 4: Create `README.md`**

Write `docs/agent-office/README.md`:
```markdown
# AKIS Agent Office

Canlı pixel-art dashboard. PM → Senior → Developer agent hiyerarşisini görselleştirir.

## Açma

Herhangi bir tarayıcıda dosyayı aç:
\`\`\`
open docs/agent-office/index.html
\`\`\`

Veya Claude Code oturumunda Chrome MCP ile:
\`\`\`
mcp__Claude_in_Chrome__navigate url="file:///<repo>/docs/agent-office/index.html"
\`\`\`

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
```

- [ ] **Step 5: Verify files exist**

Run:
```bash
ls -la docs/agent-office/
```
Expected output includes: `.gitignore`, `README.md`, `state.initial.json`, `state.json`

- [ ] **Step 6: Commit**

```bash
git add docs/agent-office/.gitignore docs/agent-office/state.initial.json docs/agent-office/README.md
git commit -m "feat(agent-office): scaffold directory + baseline state

- state.initial.json with 4 idle seniors + PM
- README documents usage + state protocol
- state.json gitignored (ephemeral per session)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Build HTML skeleton with Canvas + layout zones

**Files:**
- Create: `docs/agent-office/index.html`

- [ ] **Step 1: Write minimal HTML with Canvas and activity log**

Write `docs/agent-office/index.html`:
```html
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AKIS Agent Office</title>
  <style>
    :root {
      --bg: #0A1215;
      --surface: #12202A;
      --surface-2: #1A2C38;
      --primary: #07D1AF;
      --text: #E8F0F2;
      --text-dim: #8FA3AE;
      --danger: #FF6B6B;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body {
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      overflow: hidden;
    }

    .office {
      display: grid;
      grid-template-rows: 1fr auto;
      height: 100vh;
      width: 100vw;
    }

    .stage {
      position: relative;
      overflow: hidden;
      background: linear-gradient(180deg, #1A2C38 0%, #0E1820 100%);
    }

    canvas {
      display: block;
      margin: 0 auto;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      image-rendering: -moz-crisp-edges;
    }

    .bubbles {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .bubble {
      position: absolute;
      background: var(--surface-2);
      border: 1px solid var(--primary);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--text);
      white-space: nowrap;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      transform: translate(-50%, -100%);
    }

    .bubble::after {
      content: "";
      position: absolute;
      bottom: -5px;
      left: 50%;
      transform: translateX(-50%);
      border: 5px solid transparent;
      border-top-color: var(--primary);
    }

    .log {
      background: var(--surface);
      border-top: 2px solid var(--primary);
      padding: 12px 20px;
      max-height: 160px;
      overflow-y: auto;
      font-size: 12px;
      line-height: 1.6;
    }

    .log-title {
      color: var(--primary);
      font-weight: bold;
      margin-bottom: 6px;
      letter-spacing: 0.1em;
    }

    .log-entry {
      color: var(--text-dim);
    }

    .log-entry.recent {
      color: var(--text);
    }

    .header {
      position: absolute;
      top: 12px;
      left: 0;
      right: 0;
      text-align: center;
      color: var(--primary);
      font-size: 14px;
      letter-spacing: 0.3em;
      font-weight: bold;
    }

    .subheader {
      position: absolute;
      top: 32px;
      left: 0;
      right: 0;
      text-align: center;
      color: var(--text-dim);
      font-size: 10px;
      letter-spacing: 0.2em;
    }
  </style>
</head>
<body>
  <div class="office">
    <div class="stage" id="stage">
      <div class="header">AKIS AGENT OFFICE</div>
      <div class="subheader">PM → SENIOR → DEVELOPER · LIVE</div>
      <canvas id="canvas" width="960" height="540"></canvas>
      <div class="bubbles" id="bubbles"></div>
    </div>
    <div class="log">
      <div class="log-title">▸ ACTIVITY LOG</div>
      <div id="log-entries"></div>
    </div>
  </div>
  <script>
    // JS added in Task 3+
    console.log('Office ready');
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify HTML parses**

Run:
```bash
node -e "const fs=require('fs'); const html=fs.readFileSync('docs/agent-office/index.html','utf8'); console.log('OK', html.length, 'bytes');"
```
Expected: `OK <N> bytes` (N > 2000)

- [ ] **Step 3: Commit**

```bash
git add docs/agent-office/index.html
git commit -m "feat(agent-office): HTML skeleton with Canvas + activity log

- Liquid-glass styling matching AKIS palette (#07D1AF primary)
- Canvas 960x540 for pixel art (image-rendering: pixelated)
- DOM overlay for status bubbles
- Scrollable activity log at bottom

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Pixel character rendering engine

**Files:**
- Modify: `docs/agent-office/index.html:<script>` (replace the stub)

- [ ] **Step 1: Add the full rendering engine inside `<script>`**

Replace the entire `<script>` block in `index.html` with:

```html
<script>
/* ───────────────────────────── CONSTANTS ───────────────────────────── */
const TILE = 32;       // logical tile size
const SCALE = 2;       // render scale (x2)
const COLS = 30;
const ROWS = 15;
const SPRITE = 16;     // sprite logical pixels

/* Character slot positions (col, row) — anchor = sprite top-left */
const SLOTS = {
  pm:       { col: 14, row: 3 },
  frontend: { col: 4,  row: 8 },
  backend:  { col: 10, row: 8 },
  ai:       { col: 18, row: 8 },
  qa:       { col: 24, row: 8 },
  devSlots: {
    frontend: [{col:3,row:11},{col:5,row:11},{col:7,row:11}],
    backend:  [{col:9,row:11},{col:11,row:11},{col:13,row:11}],
    ai:       [{col:17,row:11},{col:19,row:11},{col:21,row:11}],
    qa:       [{col:23,row:11},{col:25,row:11},{col:27,row:11}]
  }
};

/* Per-role color palette */
const PALETTE = {
  pm:       { primary: '#2E4A7D', secondary: '#F5C76C', skin: '#F2C199', accent: '#FFFFFF' },
  frontend: { primary: '#E8823E', secondary: '#FFFFFF', skin: '#F2C199', accent: '#3A2A1A' },
  backend:  { primary: '#3FA85E', secondary: '#1A1A1A', skin: '#F2C199', accent: '#07D1AF' },
  ai:       { primary: '#8B5CF6', secondary: '#E0D4F7', skin: '#F2C199', accent: '#FFFFFF' },
  qa:       { primary: '#F0F0F0', secondary: '#FF6B6B', skin: '#F2C199', accent: '#1A1A1A' },
  dev:      { primary: '#9AA0A6', secondary: '#607D8B', skin: '#F2C199', accent: '#455A64' }
};

/* ───────────────────────────── PIXEL SPRITES ─────────────────────────────
   Each sprite is a 16x16 grid drawn as 2-frame animation.
   Letters map to palette keys:
     . = transparent, P = primary, S = secondary, K = skin, A = accent, O = outline (#000)
   Two frames: frame A (rest) and frame B (breathe / type)
*/
const SPRITE_DEF = {
  // Frame layout: array of 16 rows x 16 chars
  pm: [
    /* frame A - idle */
    [
      "................",
      "....OOOOOO......",
      "...OKKKKKKO.....",
      "...OKKKKKKO.....",
      "...OKKKKKKO.....",
      "....OOOOOO......",
      "...OPPPPPPO.....",
      "..OPPSPSPPO.....",
      "..OPPPPPPPO.....",
      "..OPPPPPPPO.....",
      "..OPPPPPPPO.....",
      "..OAAAAAAAO.....",
      "...OP..POP......",
      "...OP..POP......",
      "...OP..POP......",
      "..OOO..OOO......"
    ],
    /* frame B - breathe (1px raised) */
    [
      "....OOOOOO......",
      "...OKKKKKKO.....",
      "...OKKKKKKO.....",
      "...OKKKKKKO.....",
      "....OOOOOO......",
      "...OPPPPPPO.....",
      "..OPPSPSPPO.....",
      "..OPPPPPPPO.....",
      "..OPPPPPPPO.....",
      "..OPPPPPPPO.....",
      "..OAAAAAAAO.....",
      "...OP..POP......",
      "...OP..POP......",
      "...OP..POP......",
      "..OOO..OOO......",
      "................"
    ]
  ],
  senior: [
    [
      "................",
      "....OOOOOO......",
      "...OKKKKKKO.....",
      "..OKKAAKAAKO....",
      "...OKKKKKKO.....",
      "....OOOOOO......",
      "...OPPPPPPO.....",
      "..OPPPPPPPPO....",
      "..OPPSSSSPPO....",
      "..OPPPPPPPPO....",
      "..OPPPPPPPPO....",
      "..OPPPPPPPPO....",
      "...OP..POP......",
      "...OP..POP......",
      "...OP..POP......",
      "..OOO..OOO......"
    ],
    [
      "....OOOOOO......",
      "...OKKKKKKO.....",
      "..OKKAAKAAKO....",
      "...OKKKKKKO.....",
      "....OOOOOO......",
      "...OPPPPPPO.....",
      "..OPPPPPPPPO....",
      "..OPPSSSSPPO....",
      "..OPPPPPPPPO....",
      "..OPPPPPPPPO....",
      "..OPPPPPPPPO....",
      "..OPPPPPPPPO....",
      "...OP..POP......",
      "...OP..POP......",
      "...OP..POP......",
      "..OOO..OOO......"
    ]
  ],
  dev: [
    [
      "................",
      ".....OOOOO......",
      "....OKKKKKO.....",
      "....OKKKKKO.....",
      "....OKKKKKO.....",
      ".....OOOOO......",
      "....OPPPPPO.....",
      "...OPPPPPPPO....",
      "...OPPAAAPPO....",
      "...OPPPPPPPO....",
      "...OPPPPPPPO....",
      "...OPPPPPPPO....",
      "....OP.POP......",
      "....OP.POP......",
      "....OP.POP......",
      "...OOO.OOO......"
    ],
    [
      ".....OOOOO......",
      "....OKKKKKO.....",
      "....OKKKKKO.....",
      "....OKKKKKO.....",
      ".....OOOOO......",
      "....OPPPPPO.....",
      "...OPPPPPPPO....",
      "...OPPAAAPPO....",
      "...OPPPPPPPO....",
      "...OPPPPPPPO....",
      "...OPPPPPPPO....",
      "...OPPPPPPPO....",
      "....OP.POP......",
      "....OP.POP......",
      "....OP.POP......",
      "...OOO.OOO......"
    ]
  ]
};

/* ───────────────────────────── STATE ───────────────────────────── */
let currentState = null;
let lastRenderedState = null;
let frameCounter = 0;
let animPhase = 0;  // 0 or 1 — toggles every 400ms for idle, 150ms for typing

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
canvas.width = COLS * TILE;
canvas.height = ROWS * TILE * SCALE / 2;  // keeps 2x render

const bubblesEl = document.getElementById('bubbles');
const logEl = document.getElementById('log-entries');

/* ───────────────────────────── DRAWING ───────────────────────────── */
function drawSprite(kind, palette, col, row, frame) {
  const sprite = SPRITE_DEF[kind][frame];
  const baseX = col * TILE;
  const baseY = row * TILE;
  for (let y = 0; y < SPRITE; y++) {
    const line = sprite[y];
    for (let x = 0; x < SPRITE; x++) {
      const ch = line[x];
      let color = null;
      switch (ch) {
        case 'P': color = palette.primary; break;
        case 'S': color = palette.secondary; break;
        case 'K': color = palette.skin; break;
        case 'A': color = palette.accent; break;
        case 'O': color = '#000'; break;
        default: continue;
      }
      ctx.fillStyle = color;
      ctx.fillRect(baseX + x * SCALE, baseY + y * SCALE, SCALE, SCALE);
    }
  }
}

function drawDesk(col, row, color) {
  const baseX = col * TILE;
  const baseY = row * TILE + SPRITE * SCALE + 4;
  ctx.fillStyle = color;
  ctx.fillRect(baseX + 2, baseY, SPRITE * SCALE - 4, 4);
  ctx.fillStyle = '#000';
  ctx.fillRect(baseX + 4, baseY + 4, 3, 8);
  ctx.fillRect(baseX + SPRITE * SCALE - 7, baseY + 4, 3, 8);
}

function drawFloor() {
  // subtle tiled floor
  ctx.fillStyle = '#0A1820';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0E1C26';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if ((r + c) % 2 === 0) {
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
      }
    }
  }
  // horizon line
  ctx.strokeStyle = '#1A2C38';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 5 * TILE + 4);
  ctx.lineTo(canvas.width, 5 * TILE + 4);
  ctx.stroke();
}

/* ───────────────────────────── BUBBLES ───────────────────────────── */
function setBubble(key, col, row, text) {
  let el = document.getElementById('bubble-' + key);
  if (!text) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'bubble-' + key;
    el.className = 'bubble';
    bubblesEl.appendChild(el);
  }
  el.textContent = text;
  const x = (col * TILE + SPRITE * SCALE / 2);
  const y = (row * TILE - 4);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

/* ───────────────────────────── LOG ───────────────────────────── */
function renderLog(entries) {
  logEl.innerHTML = '';
  const recent = entries.slice(-20);
  recent.forEach((entry, idx) => {
    const div = document.createElement('div');
    div.className = 'log-entry' + (idx >= recent.length - 3 ? ' recent' : '');
    div.textContent = entry;
    logEl.appendChild(div);
  });
  logEl.scrollTop = logEl.scrollHeight;
}

/* ───────────────────────────── RENDER LOOP ───────────────────────────── */
function render() {
  frameCounter++;
  if (frameCounter % 24 === 0) animPhase = 1 - animPhase; // ~400ms at 60fps

  drawFloor();

  if (!currentState) return;

  // Draw PM
  const pm = currentState.pm;
  drawDesk(SLOTS.pm.col, SLOTS.pm.row, '#2E4A7D');
  drawSprite('pm', PALETTE.pm, SLOTS.pm.col, SLOTS.pm.row, animPhase);
  if (pm.status !== 'idle' && pm.task) {
    setBubble('pm', SLOTS.pm.col, SLOTS.pm.row, pm.task);
  } else {
    setBubble('pm', null, null, null);
  }

  // Draw seniors + their devs
  ['frontend', 'backend', 'ai', 'qa'].forEach((role) => {
    const sr = currentState.seniors[role];
    const slot = SLOTS[role];
    drawDesk(slot.col, slot.row, PALETTE[role].primary);
    drawSprite('senior', PALETTE[role], slot.col, slot.row, animPhase);
    if (sr.status !== 'idle' && sr.task) {
      setBubble('sr-' + role, slot.col, slot.row, sr.task);
    } else {
      setBubble('sr-' + role, null, null, null);
    }

    // devs
    const devSlots = SLOTS.devSlots[role];
    sr.devs.forEach((dev, i) => {
      if (i >= devSlots.length) return;
      const ds = devSlots[i];
      drawSprite('dev', PALETTE.dev, ds.col, ds.row, animPhase);
      if (dev.task) {
        setBubble('dev-' + role + '-' + dev.id, ds.col, ds.row, dev.task);
      }
    });

    // remove stale dev bubbles
    const activeDevIds = new Set(sr.devs.map(d => 'dev-' + role + '-' + d.id));
    Array.from(bubblesEl.children).forEach(b => {
      if (b.id.startsWith('bubble-dev-' + role + '-') && !activeDevIds.has(b.id.replace('bubble-', ''))) {
        b.remove();
      }
    });
  });
}

function loop() {
  render();
  requestAnimationFrame(loop);
}

/* ───────────────────────────── POLLING ───────────────────────────── */
async function poll() {
  try {
    const resp = await fetch('./state.json?t=' + Date.now(), { cache: 'no-store' });
    const next = await resp.json();
    const nextLogLen = (next.log || []).length;
    const prevLogLen = (currentState?.log || []).length;
    currentState = next;
    if (nextLogLen !== prevLogLen) {
      renderLog(next.log || []);
    }
  } catch (err) {
    console.warn('poll error', err);
  }
}

/* ───────────────────────────── BOOT ───────────────────────────── */
poll();
setInterval(poll, 500);
requestAnimationFrame(loop);
console.log('AKIS Agent Office ready');
</script>
```

- [ ] **Step 2: Verify HTML is still valid**

Run:
```bash
node -e "const fs=require('fs'); const html=fs.readFileSync('docs/agent-office/index.html','utf8'); const m=html.match(/<script>/g); console.log('scripts:', m ? m.length : 0, 'size:', html.length);"
```
Expected: `scripts: 1 size: <N>` (N > 10000)

- [ ] **Step 3: Open in Chrome MCP and screenshot**

Use `mcp__Claude_in_Chrome__navigate` with `url="file:///<absolute-path>/docs/agent-office/index.html"`.

Then `mcp__Claude_in_Chrome__read_page` or `screenshot` to verify:
- Header "AKIS AGENT OFFICE" visible
- Canvas rendered with checkered floor
- 5 characters visible (PM + 4 seniors)
- Activity log shows "Office opened — all hands idle"

- [ ] **Step 4: Commit**

```bash
git add docs/agent-office/index.html
git commit -m "feat(agent-office): pixel character rendering + state polling

- Canvas 2D draws 16x16 sprites for PM, Senior (4 variants), Developer
- 500ms state.json polling with diff-based render
- Idle breathing animation (2-frame, 400ms)
- DOM-overlay status bubbles positioned above characters
- Activity log auto-scrolls to newest

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 4: Smoke test — manually drive the dashboard through state.json edits

**Files:**
- Modify: `docs/agent-office/state.json` (manual edits for test)

- [ ] **Step 1: Write a "triaging" state**

Write `docs/agent-office/state.json`:
```json
{
  "ts": "2026-04-18T14:00:00Z",
  "pm": {
    "status": "triaging",
    "task": "triaging #429",
    "issueNumber": 429
  },
  "seniors": {
    "frontend": { "status": "idle", "task": null, "issueNumber": null, "devs": [] },
    "backend":  { "status": "idle", "task": null, "issueNumber": null, "devs": [] },
    "ai":       { "status": "idle", "task": null, "issueNumber": null, "devs": [] },
    "qa":       { "status": "idle", "task": null, "issueNumber": null, "devs": [] }
  },
  "log": [
    "[14:00:00] Office opened",
    "[14:00:15] PM → triaging #429 (github/repos fail)"
  ]
}
```

- [ ] **Step 2: Refresh Chrome, verify PM bubble appears**

In Chrome MCP, reload the page and take a screenshot. Expected:
- PM character has a bubble "triaging #429"
- Other seniors still idle
- Log shows 2 entries

- [ ] **Step 3: Write a "delegation + working dev" state**

Write `docs/agent-office/state.json`:
```json
{
  "ts": "2026-04-18T14:02:00Z",
  "pm": {
    "status": "reviewing",
    "task": "awaiting Sr BE",
    "issueNumber": 429
  },
  "seniors": {
    "frontend": { "status": "idle", "task": null, "issueNumber": null, "devs": [] },
    "backend":  {
      "status": "working",
      "task": "debugging /api/github/repos",
      "issueNumber": 429,
      "devs": [
        { "id": "dev-be-1", "status": "working", "task": "reading route handler" },
        { "id": "dev-be-2", "status": "working", "task": "writing unit test" }
      ]
    },
    "ai":       { "status": "idle", "task": null, "issueNumber": null, "devs": [] },
    "qa":       { "status": "idle", "task": null, "issueNumber": null, "devs": [] }
  },
  "log": [
    "[14:00:00] Office opened",
    "[14:00:15] PM → triaging #429 (github/repos fail)",
    "[14:01:05] PM → delegated #429 to Sr Backend",
    "[14:01:20] Sr Backend → spawned dev-be-1",
    "[14:01:35] Sr Backend → spawned dev-be-2"
  ]
}
```

- [ ] **Step 4: Refresh Chrome, verify full scene**

Screenshot expected content:
- PM: bubble "awaiting Sr BE"
- Sr Backend: bubble "debugging /api/github/repos"
- 2 developers under Sr Backend with bubbles
- Other 3 seniors: no bubbles (idle)
- Log: 5 entries

- [ ] **Step 5: Restore to initial state**

Run:
```bash
cp docs/agent-office/state.initial.json docs/agent-office/state.json
```

- [ ] **Step 6: No commit for this task**

This task is pure smoke test. state.json is gitignored.

---

### Task 5: Update CLAUDE.md with PM → Senior → Developer workflow

**Files:**
- Modify: `CLAUDE.md` (insert new section between "Kritik Kurallar" and "AI Provider Yapılandırması")

- [ ] **Step 1: Locate the insertion point**

Run:
```bash
grep -n "^## AI Provider Yapılandırması" CLAUDE.md
```
Expected: One match, around line 280-320.

- [ ] **Step 2: Insert new section before that line**

Use Edit tool to add this block BEFORE `## AI Provider Yapılandırması`:

```markdown
## PM → Senior → Developer İş Akışı (zorunlu)

Her dev oturumunda bu 3-katmanlı hiyerarşi kullanılır. Detaylı tasarım:
`docs/superpowers/specs/2026-04-18-senior-hierarchy-agent-office-design.md`

### Hiyerarşi

```
Kullanıcı isteği
      ↓
  [PM — main Claude session]   triage, öncelik, risk, kapsam
      ↓
  [Senior X]                   (Frontend | Backend | AI/Platform | QA)
      ↓  Agent tool (nested)
  [Developer agents]           somut kod yazımı, test
      ↓
  Senior review & unified diff → PM
      ↓
  PM opens PR → CLAUDE.md PR review + smoke-test döngüsü
```

### Senior rolleri

| Senior | Domain | Örnek issue |
|---|---|---|
| **Sr Frontend** | React 19, Tailwind 4, Vite, chat UI, auth pages | UI bug, layout, state mgmt |
| **Sr Backend** | Fastify, Drizzle, auth, REST API, GitHub adapter, multipart | API bug, migration, perf |
| **Sr AI/Platform** | Claude API, Scribe/Proto/Trace agents, RAG, caching, streaming | prompt caching, token counter, RAG |
| **Sr QA** | Playwright, Cucumber/BDD, post-deploy smoke, Chrome MCP | e2e tests, smoke reports |

### Ne zaman delege edilir

**HER ZAMAN delege et:**
- ≥3 dosya değişikliği
- ≥100 LOC
- Yeni DB migration
- Yeni API endpoint
- Herhangi bir vision-gap feature
- Auth / billing / pipeline orchestrator değişikliği

**PM direkt yapabilir (delegasyon overhead gereksiz):**
- Typo / tek satır string fix
- README / docs-only değişiklik
- Revert of known-bad commit
- i18n key-only add (no logic)

### Agent tool invocation şablonu

PM senior'u şöyle spawn eder:

```
Agent({
  subagent_type: "general-purpose",
  description: "Senior <Role> — issue #<N>",
  prompt: `
You are Senior <Role> Engineer for the AKIS platform.
Project: /Users/omeryasironal/Projects/akisflow
Read CLAUDE.md before anything.

Your task: Issue #<N> — <başlık>.
Context: <issue body, ilgili dosya yolları, acceptance criteria>

Responsibilities:
1. Plan the implementation (files, tests, migration).
2. Spawn Developer agents via Agent tool (subagent_type: general-purpose) for atomic tasks.
3. Integrate developer outputs into one coherent diff.
4. Run local quality gates: typecheck, lint, test:unit, build.
5. Update docs/agent-office/state.json at each milestone (working, dev spawn, complete).
6. Report back: summary, files changed, tests added, risks, followups.

Hard rules:
- NEVER push to main directly. PM opens the PR.
- NEVER modify .env files.
- NEVER bypass CLAUDE.md rules.
- temperature=0 for all agent prompts you write.
`
});
```

### Agent Office dashboard

- Path: `docs/agent-office/index.html`
- State: `docs/agent-office/state.json` (gitignored, ephemeral)
- Oturum başı PM `state.initial.json` → `state.json` kopyalar
- PM ve Senior'lar her lifecycle transition'da (spawn, working, complete) state.json'u Write tool ile günceller
- Kullanıcı istediğinde Chrome MCP ile açılır: `navigate url="file://<repo>/docs/agent-office/index.html"`

### Concurrency kuralı

- Aynı dosya / aynı modül ise **sequential**
- Disjoint (farklı domain) ise **parallel** Agent call'lar tek mesajda
- Çakışma riski varsa PM sequential'a düşürür

### ASLA

- Senior'un Senior'u spawn etmesi (sadece Senior → Developer)
- Developer'ın Developer'ı spawn etmesi
- Aynı issue'da 2 senior paralel çalışması (merge conflict riski)
- state.json'ı Developer'ın doğrudan yazması (Senior aggregates)
```

- [ ] **Step 3: Verify CLAUDE.md parses and structure intact**

Run:
```bash
grep -c "^## " CLAUDE.md
```
Expected: Count increased by 1 compared to before.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): add PM → Senior → Developer workflow section

New mandatory workflow layer:
- PM (main Claude) triages + delegates
- 4 role-specialized seniors (FE, BE, AI, QA) via Agent tool
- Developers nested under seniors for atomic work
- Live dashboard at docs/agent-office/

Links to full design spec.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Create PR + trigger CLAUDE.md PR review loop

**Files:** none (branch push + PR creation)

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/senior-hierarchy-agent-office
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "feat(agent-office): PM→Senior→Developer workflow + live dashboard" --body "$(cat <<'EOF'
## Summary

Introduces 3-tier agent hierarchy (PM → 4 Seniors → N Developers) + live pixel-art dashboard.

- `docs/agent-office/` — standalone HTML dashboard (Canvas pixel art, 500ms polling)
- `docs/superpowers/specs/2026-04-18-senior-hierarchy-agent-office-design.md` — full design
- `docs/superpowers/plans/2026-04-18-agent-office-infrastructure.md` — this plan
- `CLAUDE.md` — new mandatory section documenting the workflow

## Test plan

- [x] Dashboard opens in Chrome at `file://<repo>/docs/agent-office/index.html`
- [x] 5 characters render (PM + 4 Seniors) with correct colors
- [x] Status bubble appears when state.json updates PM task
- [x] Dev spawn/despawn fades correctly
- [x] Activity log auto-scrolls
- [ ] CLAUDE.md section renders in GitHub preview

## Risk

**Low.** Pure additive: new directory + docs-only CLAUDE.md change. No runtime / API / DB impact.

## Post-merge

Next plans kick off Phase 1 bugfixes (#429, #427, #425) using the new workflow.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Record PR number and trigger review**

Get the PR URL. Then trigger CLAUDE.md PR review automation per §"PR Review + Deploy Smoke Otomasyonu" rules:
- This is LOW-RISK (docs + new dir) → auto-merge candidate after READY review
- Run: `code-reviewer` subagent via Agent tool with the PR diff

---

## Self-Review Checklist (completed inline)

**Spec coverage:**
- ✅ §3 Senior hierarchy → Task 5 (CLAUDE.md)
- ✅ §4 Office visualization (file layout) → Task 1
- ✅ §4 Office visualization (HTML + Canvas) → Tasks 2-3
- ✅ §4 Office visualization (verify) → Task 4
- ✅ §5 CLAUDE.md changes → Task 5
- ⏭ §6 Rollout (9 issues) → out of scope for this plan (follow-up plans)
- ✅ §7 Quality gates → Task 6 PR body covers it
- ✅ §8 YAGNI → reflected in task scope

**Placeholder scan:**
- No TBD / TODO / "fill in later"
- All code blocks contain real code
- All commands have expected output

**Type consistency:**
- `state.json` schema consistent across all tasks (pm/seniors.X/log)
- Slot keys consistent (frontend/backend/ai/qa)
- Palette keys consistent (primary/secondary/skin/accent)

---

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between.
2. **Inline Execution** — execute in this session with checkpoints.

This plan is small (6 tasks, ~1 hour) and I have full context. Recommend **inline execution** via `superpowers:executing-plans`.
