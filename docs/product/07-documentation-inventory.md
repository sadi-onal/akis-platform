# 07 — Documentation Inventory & Gap Matrix

**Status:** Draft — 2026-05-26
**Previous context:** [`00-README.md`](./00-README.md), [`01-requirements.md`](./01-requirements.md), [`02-ux.md`](./02-ux.md), [`03-architecture.md`](./03-architecture.md), [`04-quality.md`](./04-quality.md), [`05-findings.md`](./05-findings.md), [`06-roadmap.md`](./06-roadmap.md)
**Scope:** Documentation coverage only. No product behavior or code change is implied by this file.

---

## 1. Why this document exists

AKIS already has substantial documentation, but it is spread across PDP files, architecture notes, runbooks, dogfooding reports, API specs, thesis notes, and implementation plans. The current risk is not "no documentation"; the risk is **unclear canonical ownership**:

- A developer may not know which document is the source of truth.
- Product requirements are strong for the PDP-2 Bakkal pipeline flow, but not for every screen and backend capability.
- API documentation exists, but OpenAPI coverage appears narrower than the backend route surface.
- Some docs describe historical feature waves and may be mistaken for current product commitments.

This document is the starting inventory for turning the repo into a fully documented product reference.

## 2. Canonical documentation map

| Area | Current strongest source | Coverage | Canonical decision |
|---|---|---:|---|
| Product vision | [`docs/PRODUCT_DIRECTION.md`](../PRODUCT_DIRECTION.md), [`docs/AKIS_VISION.md`](../AKIS_VISION.md), [`docs/THESIS_FOCUS.md`](../THESIS_FOCUS.md) | Good | Keep as high-level product north star |
| Core product requirements | [`01-requirements.md`](./01-requirements.md) | Good for Bakkal pipeline flow | Promote into living requirements index; add missing screens/domains |
| Core UX flow | [`02-ux.md`](./02-ux.md) | Good for chat/pipeline rail | Extend with full screen-by-screen UI reference |
| Technical architecture | [`03-architecture.md`](./03-architecture.md), [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), `docs/architecture/ADR-*` | Good but split | Make `docs/ARCHITECTURE.md` the short canonical overview; keep PDP file as wave-specific delta |
| Quality strategy | [`04-quality.md`](./04-quality.md), [`docs/TESTING.md`](../TESTING.md) | Good for PDP-2 | Add traceability matrix for all screens/endpoints |
| API contract | [`docs/openapi.yaml`](../openapi.yaml), [`backend/docs/API_SPEC.md`](../../backend/docs/API_SPEC.md) | Partial/inconsistent | Make OpenAPI canonical; treat markdown API specs as generated or narrative companion only |
| User guide | [`docs/DEMO_SCRIPT.md`](../DEMO_SCRIPT.md), [`docs/dogfooding/DOGFOODING_GUIDE.md`](../dogfooding/DOGFOODING_GUIDE.md), [`02-ux.md`](./02-ux.md) | Partial | Add a dedicated user guide for real user tasks |
| Operations | `docs/ops/*`, [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md), [`docs/ENV_SETUP.md`](../ENV_SETUP.md) | Good but distributed | Keep as runbook folder; add index |
| Historical implementation plans | `docs/plans/*`, `docs/superpowers/*`, `docs/product/wave3/*` | Good archival value | Mark as historical unless explicitly linked from roadmap |

## 3. UI coverage matrix

| UI surface | Existing docs | Coverage status | Gap |
|---|---|---:|---|
| Landing `/` | [`README.md`](../../README.md), landing tests, screenshots | Partial | Business goal, sections, CTAs, persona fit, and success criteria are not in a screen spec |
| Docs `/docs` | Component/tests only | Weak | Needs user-facing purpose and content ownership |
| Auth: signup/login/password/verify/reset | Auth API docs + tests | Partial | Needs screen-by-screen user guide, validation rules, error states |
| Invite accept `/auth/invite/:token` | Tests | Weak | Needs business requirement and failure states |
| Chat `/chat/*` | [`01-requirements.md`](./01-requirements.md), [`02-ux.md`](./02-ux.md), many tests | Strong | Needs consolidation into full screen reference; current docs are PDP-2 scoped |
| Conversation sidebar | [`01-requirements.md`](./01-requirements.md) FR-12 | Medium | Needs full action inventory: rename, delete, search, status dots, keyboard |
| Pipeline rail | [`02-ux.md`](./02-ux.md), [`03-architecture.md`](./03-architecture.md) | Strong | Needs explicit mapping to backend endpoints and persisted data |
| Pipeline gates: GitHub, approval, push confirm, critic resolution | PDP docs + component tests | Medium | Needs a single state/error guide |
| Settings `/settings` | [`01-requirements.md`](./01-requirements.md) says mostly out-of-scope | Weak | Needs requirements for profile, integrations, AI keys, workspace, account deletion |
| Legal pages | Tests | Weak | Needs content ownership and release checklist |
| Error boundary/toasts/loading states | Component tests | Partial | Needs cross-screen UX rules |

## 4. Backend/API coverage matrix

| Backend surface | Registered in code | OpenAPI coverage | Gap |
|---|---:|---:|---|
| Health/meta | Yes | Yes | Minor response-shape drift should be checked |
| Auth multi-step/OAuth/profile/password | Yes | Partial/mostly yes | Invite, reset, legacy endpoints need full OpenAPI parity |
| Pipeline core | Yes | Partial | Dev-session routes, stream route, feedback iteration, files routes need parity check |
| Chat intent / Chat Q&A | Yes | Yes | Add business behavior and rate/error contract |
| Settings/workspace/AI keys | Yes | Partial | Workspace/account deletion and pipeline stats need parity check |
| GitHub integration | Yes | Partial | Repo creation and OAuth callback surfaces need explicit contract |
| Conversations | Yes | Not clearly complete | Need endpoint inventory and product purpose |
| Integrations | Yes | Not clearly complete | Atlassian/GitHub integration routes need current source-of-truth |
| Webhooks/triggers | Yes | Not clearly complete | Need business ownership and auth/rate contract |
| Dashboard metrics/usage/AI models | Yes | Partial | Need reporting requirements and response schemas |
| Knowledge/RAG/chat attachments | Yes | Not clearly complete | Need product scope decision: core feature or experimental |
| Studio/marketplace/admin | Yes | Not clearly complete | Need scope decision: active product, internal tool, or archived experiment |

## 5. Primary gaps

| ID | Priority | Gap | Why it matters | Proposed artifact |
|---|---|---|---|---|
| DOC-01 | P0 | No single documentation index that says what is canonical | Developers can follow stale docs | `docs/README.md` or expanded `docs/product/00-README.md` |
| DOC-02 | P0 | Requirements are PDP-2 scoped, not full product scoped | Product scope can drift outside chat/pipeline | Full product requirements index |
| DOC-03 | P0 | OpenAPI does not obviously cover all registered backend routes | API contract can drift from implementation | OpenAPI parity audit + endpoint matrix |
| DOC-04 | P1 | Screen-by-screen UI behavior is incomplete | UI changes may break undocumented workflows | UI reference by route/screen |
| DOC-05 | P1 | User guide is scattered across demo/dogfooding docs | Non-developer target user lacks one clear guide | `docs/user-guide/` or `docs/USER_GUIDE.md` |
| DOC-06 | P1 | Technical docs are split between overview, PDP deltas, ADRs, and reports | Architecture decisions are harder to trace | Technical docs index + canonical/archival labels |
| DOC-07 | P1 | Quality strategy does not cover every active backend/frontend surface | Test priorities can drift | FR/NFR/API/test traceability matrix |
| DOC-08 | P2 | Historical plans and reports are not clearly marked archival | Old plans may be treated as current roadmap | Archive labels/index for `docs/plans`, `docs/superpowers`, reports |

## 6. Proposed documentation PR sequence

Each PR should be one concern. This keeps documentation reviewable and prevents the documentation effort from becoming a vague rewrite.

| PR | Concern | Output | Acceptance |
|---|---|---|---|
| DOC-PR1 | Documentation index and ownership | Canonical docs index + archival policy | A new developer can identify source-of-truth docs in under 2 minutes |
| DOC-PR2 | Full product requirements | Expand requirements beyond PDP-2: auth, settings, docs, legal, integrations, knowledge/RAG, admin/internal surfaces | Every active screen and backend domain has an owner, purpose, and in/out-of-scope statement |
| DOC-PR3 | Screen-by-screen UI reference | Route/screen specs + actions + states + errors + empty/loading states | Every route in `frontend/src/App.tsx` has a UI spec |
| DOC-PR4 | API parity | OpenAPI route inventory matched against backend registered routes | Every public route is documented or explicitly marked internal/test-only |
| DOC-PR5 | Technical architecture consolidation | Architecture overview + component map + data ownership + ADR index | Current architecture and historical deltas are clearly separated |
| DOC-PR6 | User guide | User-facing guide for signup, connect GitHub, create workflow, approve plan, inspect output, iterate, settings | A non-developer user can complete the happy path without reading developer docs |
| DOC-PR7 | Quality traceability | FR/NFR/API/test matrix | Every P0/P1 requirement maps to at least one verification method |

## 7. Immediate next action

Start with **DOC-PR1**. It should not rewrite existing docs. It should:

1. Add a canonical documentation index.
2. Label current PDP files as historical wave docs vs living product docs.
3. Define how new requirements, UI specs, API specs, and runbooks should be added.
4. Link this inventory as the gap source.

DOC-PR1 is intentionally small. After it lands, the larger requirements/UI/API work can proceed without arguing about document ownership on every change.

## 8. Acceptance criteria

- [ ] Existing documentation sources are inventoried by purpose.
- [ ] UI, backend/API, user guide, and technical documentation gaps are explicitly listed.
- [ ] Each gap has a priority and proposed artifact.
- [ ] Next PR sequence is small enough to review one concern at a time.
- [ ] No implementation behavior is changed by this document.
