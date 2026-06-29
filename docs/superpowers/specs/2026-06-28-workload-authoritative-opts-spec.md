# Workload-authoritative opts (retry + cache) — design spec

**Date:** 2026-06-28
**Status:** approved decisions → ready for implementation plan
**Repo:** `ai-cost-calculator-studio`
**Workstream:** #1 of 3 (gates the MCP public-distribution work). Follow-ups: npx packaging (#2), remote Worker MCP at calc.ajinkya.ai/mcp (#3).

## 1. Problem

The MCP `compute_cost` returns a headline that does **not** match what the calc UI renders for the same share-link ($45,070 vs $47,095 on the archetype demo — a 4.5% gap). Root cause: two cost knobs live in the **UI sliders**, not the `workload` JSON, and the headless path (MCP, bench, parity) and the browser derive them differently:

| Knob | Engine reads | Browser `buildOpts` | Headless `buildOpts` |
|---|---|---|---|
| retry | `opts.retryInflate` / `opts.retry_rate` (default 1.0 = none) | `1 + 1.5·(s-retry/100)` → 3% default → ×1.045 | none → ×1.0 |
| cache | `opts.cacheRate` else `anchor_query.cache_rate_baseline` | s-cache slider (0.91 default) | `anchor_query.cache_rate_baseline` (0.88) |

The cap masked the cache gap on the demo, so only retry showed; a non-capped workload would also diverge on cache. The same gap sits, unnoticed, between the **paper/bench anchors** (retry 0) and the **live UI** (retry 3%), hidden under bench's ±5% tolerance.

## 2. Decision (locked)

Make retry + cache **workload-authoritative**: the sliders become editors of workload fields, and BOTH `buildOpts` read those fields. So `compute(workload)` is deterministic from the JSON, and a share-link (which carries the workload) round-trips to the identical number.

- **retry**: new explicit field `anchor_query.retry_rate` (fraction 0–1), **default 0**. Paper/bench-faithful (no re-bake). **Surfaced** in the UI as a clearly-labelled control (the existing s-retry slider, relabelled so 0 is not a hidden assumption). The live UI's default headline drops ~4.5% to match the paper anchors + the MCP.
- **cache**: authoritative source is the measured `anchor_query.cache_rate_baseline`. The s-cache slider edits that field; `buildOpts` reads it (not an independent slider default). Not a judgment call — the anchor is the measured value.

## 3. Non-goals
- No engine math change. The engine already accepts `opts.retry_rate` (default 0) and `opts.cacheRate` (falls back to anchor). We only change how `opts` is *assembled* and how the sliders bind.
- No bench re-bake (headless basis is already retry 0 / cache anchor → numbers unchanged).
- Packaging (#2) and the remote Worker (#3) are separate specs.

## 4. Changes

### 4a. Engine (no math change; one robustness read)
`public/lib/cost-engine.js` — in `compute()`, when `opts.retry_rate`/`opts.retryInflate` are absent, fall back to `w.anchor_query.retry_rate` (so a bare `compute(workload)` with no opts still honors the workload). Keep the existing `(1 + 1.5·r)` formula and the 1.0 default when neither workload nor opts specify. This is additive and must not change any existing result where opts already carry retry.

### 4b. Shared headless `buildOpts`
`public/lib/build-opts.js` — add `retry_rate: (w.anchor_query && w.anchor_query.retry_rate) || 0`. (cacheRate already = anchor.) Used by dump-engine, bench-validate, and the MCP bridge → all read retry from the workload (default 0 → unchanged). Update `mcp/test/test-build-opts.mjs` for the new field.

### 4c. Browser `buildOpts` (app.js ~1808–1895)
- **retry**: derive `retryInflate` from `workload.anchor_query.retry_rate` (default 0), NOT from the raw slider value as an independent input. The s-retry slider WRITES to `workload.anchor_query.retry_rate` (×/100); `buildOpts` READS that field. Net: editing the slider mutates the workload; the headline derives from the workload.
- **cache**: `cacheRate` reads `workload.anchor_query.cache_rate_baseline` (the existing s-cache↔anchor bidirectional link is the editor). Remove the independent slider-default path so an empty-ui hash uses the anchor, not 0.91.

### 4d. Slider init / hash restore (app.js)
On boot and on `loadFromHash`, set the sliders FROM the workload:
- s-retry ← `anchor_query.retry_rate × 100` (default 0).
- s-cache ← `anchor_query.cache_rate_baseline × 100`.
So an MCP share-link (`ui:{}`) yields sliders that reflect the workload → the browser reproduces the MCP number exactly.

### 4e. UI surfacing (index.html + app.js)
Relabel the retry control so 0 is explicit, e.g. "Rate-limit retry: 0% (set if you expect throttled retries)". Keep it in the advanced controls. No new section.

### 4f. MCP (likely no change)
Because the workload now carries `retry_rate` (and cache is already in the anchor), the existing `make_share_link({workload, ui:{}})` round-trips exactly. Verify the engine-bridge headline (which uses build-opts.js) still equals the browser — the demo pin moves from 45070 only if the demo workload sets a non-zero retry_rate (it won't; default 0). No MCP code change expected beyond re-confirming the pin.

## 5. Tests / acceptance

- **bench + parity unchanged**: `npm test`, `npm run bench:validate` (6/6 ±5%, no re-bake), `node scripts/dump-engine.mjs && python3 python/parity_check.py` (18/18). These are headless; they prove the headless basis didn't move.
- **NEW — UI↔MCP consistency (the whole point)**: a Playwright check (add to `scripts/test-e2e.js`, run via `--base=http://localhost:8765/index.html`): for the archetype-demo AND a deliberately **non-cap-clamped** workload (low MAU), compute the MCP `headline_monthly_usd`, open the MCP share-link in the browser, read `#cb-num`, assert **equal**. This is the regression guard that the gap is closed and stays closed.
- **Engine unit**: `compute(workload)` with `anchor_query.retry_rate = 0.03` and no opts → headline reflects ×1.045; with retry_rate absent → ×1.0. Add to an engine test.
- **Live-number delta is expected**: document that the live UI default headline drops ~4.5% (retry 0) and shifts slightly from the cache correction. This is the intended paper-faithful reconciliation.

## 6. Risks
- **app.js is the delicate surface** (production calc). Bench is headless and won't catch a UI regression — the new Playwright consistency test is the guard. Run the full e2e suite (17 scenarios) after.
- **Slider/workload binding loops**: s-retry and s-cache must write→workload and read←workload without an oscillating update loop (the existing s-cache bidirectional listener is the pattern to follow). Watch the isTrusted-gated capture-phase listeners (per repo memory) so programmatic init doesn't get ignored or cause feedback.
- **Other UI-only knobs**: growth (s-growth), bot factor, api-split, etc. may have the same headless-vs-UI divergence class. OUT OF SCOPE here (they didn't affect the measured gap), but note for a future audit — list them in the plan so they're consciously deferred, not silently missed.
