---
name: mvp-scaffolding
description: Minimal MVP scaffold generation. Apply when producing a working React+Vite codebase from a StructuredSpec.
agents: proto
tier: core
version: 1
---

# MVP Scaffolding

## File count and size budget

- 8–12 files total. Minimum 6 files enforced.
- Each file UNDER 80 lines — prefer 30–60.
- If a file grows past the budget, split it. Don't compress readability away.

## Required files (React + Vite baseline)

- `index.html` — single `<div id="root">` + module script tag
- `package.json` — `"type": "module"`, deps: react, react-dom, vite, @vitejs/plugin-react; scripts: dev/build/preview
- `vite.config.js` — plugin-react
- `.gitignore` — node_modules, dist, .env
- `README.md` — Turkish project description + setup (`npm install && npm run dev`)
- `src/main.jsx` — ONLY `ReactDOM.createRoot(...).render(<App />)`, nothing else
- `src/App.jsx` — composes feature components
- `src/App.css` — single stylesheet, no inline styles
- `src/components/<Feature>.jsx` — one component per user story

## Spec-to-code mapping

- Every user story → a matching component in `src/components/`.
- Every acceptance criterion → a concrete UI/handler realization. If an AC cannot be mapped, flag it; do not ship empty placeholders.

## Sandpack preview compatibility

- Relative imports only — no path aliases (`@/`, `~/`).
- No dynamic imports, no `React.lazy` — Sandpack does not code-split.
- Only package-name imports (e.g. `'react'`), never filesystem paths to node_modules.
- `src/App.jsx` is the Sandpack entry point.

## Turkish UI text (mandatory)

All user-facing copy in Turkish: "Kaydet", "Ara...", "Yükleniyor...", "Henüz veri yok", "Adınızı girin". Code and file names stay English.

## Responsive design (mobile-first)

- Container: `max-w-7xl mx-auto px-4 sm:px-6 lg:px-8`.
- Stack on mobile, grid on desktop: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4`.
- Minimum 44px touch targets on interactive elements.

## Don'ts

- No test files, no CI config, no `console.log`/`warn`/`error` in output.
- No code comments. No TODO/FIXME placeholders without implementation.
- No in-file inline styles.
