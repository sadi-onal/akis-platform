# PROTO_SCAFFOLD_GENERATION_FAILED — Failure-Mode Analysis

**Date:** 2026-05-20
**Scope:** investigation only (no code changes)
**Trigger:** user reported a pipeline that failed with `PROTO_SCAFFOLD_GENERATION_FAILED` and succeeded on retry → flaky scaffold generation
**Pipeline ID supplied by user:** `592d97d0-a264-4ef2-9907-6762be924f03`

> ⚠️ **Important correction:** the pipeline ID the user remembered did **not** actually fail with `PROTO_SCAFFOLD_GENERATION_FAILED`. Its persisted error is `TRACE_CODE_READ_FAILED` (GitHub `401 Bad credentials`) — Proto succeeded, Trace then failed to read the pushed repo because the GitHub token used by Trace was invalid. See *Specific case analysis* below.
>
> The DB has exactly **one** historical `PROTO_SCAFFOLD_GENERATION_FAILED` row — pipeline `843bb62d-f7bf-4906-83db-1026f59a10d2` (2026-05-12 19:04 UTC), with `technicalDetail = "No files generated"`. This report uses that row as the concrete reference point and analyzes the code paths that can raise the error today.

---

## 1. Where the error is thrown

All raise sites live in `backend/src/pipeline/agents/proto/ProtoAgent.ts`. The constant is defined in `backend/src/pipeline/core/contracts/PipelineErrors.ts:67`. The user-facing definition is:

```ts
// backend/src/pipeline/core/contracts/PipelineErrors.ts:142-146
[PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED]: {
  message: "Kod üretilirken bir sorun oluştu. Spec'i basitleştirmeyi deneyebilirsiniz.",
  retryable: true,
  recoveryAction: 'retry',
},
```

There are **six** raise points inside ProtoAgent. They fall into two clusters:

### A. Iteration path (single, non-retried) — `executeIteration`

```ts
// ProtoAgent.ts:525-533
if (!parsedFiles?.length) {
  return {
    type: 'error',
    error: createPipelineError(
      PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED,
      'İterasyon sonucu ayrıştırılamadı veya dosya üretilmedi'
    ),
  };
}
```

Iteration mode runs a **single** AI call (no in-method retry). The upstream `dispatchIterationGenerate` (line 489) returns either a string or throws; if the throw happens the error becomes `AI_PROVIDER_ERROR`, otherwise we fall through to the JSON-extract → repair → parse cascade. Empty / unparseable / files-less responses all collapse to this single error.

### B. Legacy scaffold path (`generateScaffold`) — has a retry loop

```ts
// ProtoAgent.ts:913
for (let attempt = 0; attempt <= RETRY_CONFIG.specValidationMaxRetries; attempt++) { ... }
```

`RETRY_CONFIG.specValidationMaxRetries = 2`, so the loop runs **up to 3 attempts**. Inside it, five distinct failure modes each `continue` (retry) until the final attempt, then raise `PROTO_SCAFFOLD_GENERATION_FAILED`:

| Site (line) | `technicalDetail` | Condition |
|---|---|---|
| 925-932 | `"AI call failed after retries"` | `this.ai.generateText(...)` threw on every attempt |
| 938-945 | `"AI returned empty response after retries"` | `responseText` empty/whitespace |
| 977-986 | `"Invalid JSON from scaffold generation (response length: N)"` | `extractJsonSafe` + `repairTruncatedJson` both failed |
| 1006-1014 | `"No files generated"` | parsed JSON had no `files` array or it was empty |
| 1041-1047 | `"All retries exhausted"` | unreachable in practice; defensive fallthrough after the loop |

### C. Where it actually surfaces in real traffic

In **both** the agentic (`executeWithTools`) and legacy paths, scaffold failures are normalised to this single code. The agentic path swallows its own errors and falls back to `executeLegacy`, which then calls `generateScaffold` — so the legacy path is the **only** code that emits `PROTO_SCAFFOLD_GENERATION_FAILED` for pipelines that started agentic and degraded.

```ts
// ProtoAgent.ts:810-814 (agentic catch-all)
} catch (err) {
  logger.error({ err }, '[Proto] Agentic execution failed, falling back to legacy path');
  return this.executeLegacy(input, emit);
}
```

---

## 2. What triggers it — all conditions

In raise-priority order:

1. **AI provider call throws on every attempt** (network error, 4xx/5xx after AIService's own internal retries, timeout > `aiCallTimeoutMs = 180s`). → `"AI call failed after retries"`. The original error from `AIService` is `logger.error`'d but **not** carried into `technicalDetail`.
2. **AI returns empty/whitespace-only body**, e.g. provider returns a `204`, or `choices[0].message.content === ""`. → `"AI returned empty response after retries"`.
3. **JSON parse fails on every attempt**, even after:
   - `extractJsonSafe` (handles ```` ```json ``` `` fences, brace extraction, truncated fences)
   - `sanitizeJsonControlChars` (escapes raw newlines / tabs inside string values)
   - `repairTruncatedJson` (closes open strings + brackets when `max_tokens` cut the response)

   → `"Invalid JSON from scaffold generation (response length: N)"`. **The actual response text is dropped** — only its length is preserved.
4. **JSON parses but has no `files`** (missing key, non-array, empty array) → `"No files generated"`. This is the historical 2026-05-12 case.
5. **Repaired (truncated) JSON has fewer than `MIN_SCAFFOLD_FILES = 6` files** → triggers `continue` (forces retry); only surfaces as `PROTO_SCAFFOLD_GENERATION_FAILED` if all attempts hit this OR another failure mode.
6. **Agentic loop hits its iteration cap** (`maxIterations: 10`), `runAgenticLoop` throws, the catch on line 810 → falls back to legacy → legacy then has its own 3-attempt budget. So a single user-visible failure can already represent ≤ 4 AI calls (1 agentic + 3 legacy).

`max_tokens` for the legacy path: **16 384** (set in `pipeline-factory.ts:185`). The agentic path uses the same `16384` (ProtoAgent.ts:696). Trace, by contrast, was bumped to 64 000 on 2026-05-19 after hitting the same truncation bug (`pipeline-factory.ts:228-232` comment). **Proto has not received this bump.**

`temperature` for the agentic path: `0` (line 697). The legacy path uses provider defaults (the helper doesn't pass `temperature`), so OpenAI / Anthropic default ~1.0 — explaining why retries are non-deterministic and "it worked on retry" matches the observed flakiness.

---

## 3. Existing retry / fallback behavior

| Layer | Retries | Notes |
|---|---|---|
| `AIService.chatCompletion` | 3 attempts on 429 / 5xx (built-in) | Caller (`generateText`) sees opaque success or final throw |
| `ProtoAgent.generateScaffold` legacy loop | 3 attempts (`specValidationMaxRetries: 2` inclusive of seed) | Same system + user prompt each time. **No backoff, no prompt adjustment, no temperature change.** |
| `ProtoAgent.executeWithTools` → `executeLegacy` fallback | 1 fallback chain on any agentic-loop throw | The fallback is the only safety net for the agentic path |
| `ProtoAgent.executeIteration` | **0** in-method retries | Single shot; one bad JSON = `PROTO_SCAFFOLD_GENERATION_FAILED` |
| Orchestrator level | Per `recoveryAction: 'retry'` from the error definition | Manual user retry; no auto-retry |

The legacy retry is the platform's existing flake mitigation. **It does not change the prompt or any AI parameter between attempts** — so for non-stochastic failure modes (prompt too long, model truncation at fixed token cap, missing-field schema mismatch) all three attempts will fail identically.

---

## 4. Specific case analysis

### The pipeline the user named — `592d97d0-a264-4ef2-9907-6762be924f03`

This pipeline **did not** fail at Proto. Database evidence:

```text
stage  = completed_partial
error  = {
  "code": "TRACE_CODE_READ_FAILED",
  "message": "Üretilen kod GitHub'dan okunamadı. Tekrar deneniyor...",
  "retryable": true,
  "technicalDetail": "Failed to read codebase: GitHub API
                      GET /repos/OmerYasirOnal/qr-kod-uretici-uygulamasi/git/trees/main?recursive=1
                      → 401: Bad credentials"
}
intermediate_state = { agent: "trace", status: "in_progress", inputSummary: "OmerYasirOnal/qr-kod-uretici-uygulamasi@main" }
```

So Proto succeeded (the repo `qr-kod-uretici-uygulamasi` exists on GitHub), and Trace then failed because the GitHub token it used for the tree-read returned `401 Bad credentials`. **This is a separate bug — likely the same class as the open `Trace takılı kaldı` task #27.** The user almost certainly observed *some* error and assumed it was the scaffold error; the actual code surfaced via the UI message would have been the Trace one.

Recommendation: the "PROTO_SCAFFOLD_GENERATION_FAILED is flaky" hypothesis is **not supported by this specific pipeline**. Investigate the Trace 401 instead (separate task), and treat the scaffold investigation below as preventative.

### The historical PROTO_SCAFFOLD_GENERATION_FAILED — `843bb62d-f7bf-4906-83db-1026f59a10d2`

```text
created_at         = 2026-05-12 19:04:06
stage              = failed
attempt_count      = 0
error.code         = PROTO_SCAFFOLD_GENERATION_FAILED
error.technicalDetail = "No files generated"
intermediate_state = { agent: "proto", status: "in_progress", inputSummary: "Mock Project" }
approved_spec      = {
  title: "Mock Project",
  userStories: [<2 stories>],
  acceptanceCriteria: [<2 ACs>],
  technicalConstraints: { stack: "React + Vite + TypeScript" },
  problemStatement: "A mock project generated for testing AKIS pipeline end-to-end."
}
```

Observations:
- The spec is the **smallest possible valid spec** (mock e2e fixture). It is *not* "spec too complex".
- `agent_activities` for this pipeline: **0 rows.** The agent activity logger doesn't run during scaffold AI calls in this code path, so we have no record of the actual AI response.
- `technicalDetail` is "No files generated" → raise point #4 above (ProtoAgent.ts:1011). The JSON **parsed**, but its `files` array was missing or empty.
- There is **no persistence of the raw AI response anywhere** — neither on the pipeline, nor in `agent_activities`, nor in pino logs (the logger only emitted `[Proto] Repaired JSON only has X files` and `[Proto] Parsed after sanitizing control chars` — both informational, response body dropped).

**Result:** we cannot recover the actual AI output that caused this failure. Any future fix needs to add response-body capture (truncated to a budget) on the failure path.

---

## 5. Improvements (NOT IMPLEMENTED — suggestions only)

Ordered by leverage:

1. **Persist the failing AI response on error** *(highest value, lowest risk)*
   - Today `technicalDetail` is a static string; the actual model output is dropped at lines 977-1014.
   - Add a `lastResponse` (first 4 KB) and `lastResponseLength` to `createPipelineError`'s `technicalDetail` JSON, or store it on `pipelines.intermediate_state.lastAiResponse` before raising.
   - Without this we will keep guessing at every future occurrence.

2. **Bump Proto `max_tokens` to 32 768 (or 64 000, matching Trace)**
   - Trace was bumped on 2026-05-19 for exactly this reason (see `pipeline-factory.ts:228-232`). Proto's `SCAFFOLD_SYSTEM_PROMPT` mandates 8-12 files × up to 80 lines, plus README + package.json + CSS → easily 6-10 KB of JSON output.
   - At 16 384 tokens (~12-13 KB at ~3.5 chars/token) Proto is operating uncomfortably close to truncation on every call. The `repairTruncatedJson` path being needed at all is the smoking gun.

3. **In-loop prompt adjustment on retry**
   - Today all three legacy attempts use the **identical** prompt. Stochastic failures (transient JSON corruption) might pass; deterministic failures (prompt → schema mismatch) will fail 3×3.
   - On retry-2 / retry-3 append a "you just produced an unparseable response — output ONLY the JSON, no preamble, no markdown, no closing commentary" instruction. Cheap and reduces the deterministic-failure floor.
   - Optionally lower temperature on retry (currently provider default → 0 → 0).

4. **Surface a richer technicalDetail to the user**
   - "No files generated" is unactionable. Distinguish "AI returned empty", "JSON unparseable", "JSON parsed but missing files", "JSON parsed but truncated < MIN_FILES" in the UI error so we know which class of failure recurs. The five distinct messages already exist server-side — they just need to make it into the `error.technicalDetail` field (they currently do for some sites; standardise + expose in the UI's "Detayları göster" affordance).

5. **Add an in-agent retry to the iteration path**
   - `executeIteration` has **0** retries. The legacy path has 3. Either align both, or document why iteration is single-shot.

6. **Schema relaxation — skip strict `verificationReport` parsing**
   - The prompt asks for `verificationReport` + `summary` + `metadata` + `setupCommands`, but only `files` is required for the agent to succeed. The current parser already tolerates missing optional fields, so this is **not** the bug — but the prompt's complexity may be driving the LLM to truncate earlier. Consider removing or making `verificationReport` opt-in.

7. **Persist per-stage agent activity even on error**
   - `agent_activities` had 0 rows for the failed pipeline. The `recordActivity` codepath should run *before* the error return so we keep input tokens, model used, and duration even when scaffold generation fails. Useful for cost reconciliation + ops dashboards.

---

## Bottom line

The single historical occurrence (2026-05-12) raised from `"No files generated"` — meaning the AI's JSON parsed but contained no `files` array, on a trivially-small mock spec. The pipeline the user referenced today (`592d97d0`) did **not** fail at Proto — it failed at Trace with a GitHub 401, which is a separate concern.

The Proto failure surface is real but currently un-diagnoseable because **no AI response body is persisted on failure**. Adding response capture (improvement #1) is the prerequisite for any deeper investigation; bumping `max_tokens` to match Trace (#2) is the highest-confidence preventative fix.
