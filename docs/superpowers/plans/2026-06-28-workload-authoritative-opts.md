# Workload-Authoritative Opts (retry + cache) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `retry` and `cache` workload-authoritative so the headless path (MCP/bench/parity) and the browser produce the identical headline for the same workload, closing the chat↔UI gap at the source.

**Architecture:** The cost engine already reads `opts.retry_rate` (default 0) and `opts.cacheRate` (falls back to `anchor_query.cache_rate_baseline`). We make `anchor_query.retry_rate` an explicit workload field (default 0, surfaced in the UI), have BOTH `buildOpts` read retry+cache from the workload, and make the s-retry/s-cache sliders editors of those workload fields. A new Playwright test asserts MCP headline == browser headline.

**Tech Stack:** Plain JS (classic-script calc + ESM MCP), Node test scripts, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-06-28-workload-authoritative-opts-spec.md`

**Branch:** continue on `feat/cost-mcp` (this initiative's branch; the MCP consistency test in Task 6 depends on this fix). At merge time the user may split the production-calc changes from the MCP-server changes if desired.

**Decision recorded:** `anchor_query.retry_rate` explicit, **default 0** (paper/bench-faithful, no re-bake), surfaced in the UI. Cache authoritative from the measured `anchor_query.cache_rate_baseline`. **Expected side-effect:** the live UI default headline drops ~4.5% (retry 0) plus a small cache shift — intended.

---

## File structure

```
public/lib/cost-engine.js        # MODIFY: retry fallback to workload (no math change)
public/lib/build-opts.js         # MODIFY: read retry_rate from workload
public/app.js                    # MODIFY: browser buildOpts + slider init read/write workload fields
public/index.html                # MODIFY: relabel the retry control
scripts/test-retry-cache-authoritative.mjs  # CREATE: engine unit for retry/cache from workload
mcp/test/test-build-opts.mjs     # MODIFY: assert the new retry_rate field
scripts/test-e2e.js              # MODIFY: add 'ui-mcp-consistency' scenario (the guard)
```

---

## Task 1: Engine — retry falls back to the workload (no math change)

**Files:**
- Modify: `public/lib/cost-engine.js` (the `retryInflate` assignment, ~line 1200)
- Create: `scripts/test-retry-cache-authoritative.mjs`

- [ ] **Step 1: Write the failing test** (`scripts/test-retry-cache-authoritative.mjs`)

```js
#!/usr/bin/env node
// Engine reads retry + cache from the workload when opts don't override.
const path = require('path');
const CE = require(path.join(__dirname, '..', 'public', 'lib', 'cost-engine.js'));
const { buildOpts } = require(path.join(__dirname, '..', 'public', 'lib', 'build-opts.js'));

let pass = 0, fail = 0;
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) + 1e-9;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const base = () => ({
  deployment: { name: 't' },
  anchor_query: { input_tokens: 2933, output_tokens: 41, cache_rate_baseline: 0.88, session_baseline_turns: 6 },
  shapes: { full: { input_factor: 1, output_factor: 1, cache_eligible: true } },
  mix: { worst: { weights: { full: 1 } } },
  segments: [{ id: 'all', mau: 1000, sessions_per_day: 0.2, questions_per_session: 10 }],
  defaults: { model: 'gpt-5.4', tier: 'standard', mix: 'worst', hosting: 'api', cost_mode: 'optimistic' },
});

// retry absent → no inflation
let w = base();
let r = CE.compute(JSON.parse(JSON.stringify(w)), buildOpts(w));
ok('retry absent → retry_inflate 1.0', close(r.api.retry_inflate, 1.0));

// retry_rate 0.03 in the workload, opts derived from buildOpts → 1.045
w = base(); w.anchor_query.retry_rate = 0.03;
r = CE.compute(JSON.parse(JSON.stringify(w)), buildOpts(w));
ok('workload retry_rate 0.03 → retry_inflate 1.045', close(r.api.retry_inflate, 1.045));

// cache comes from the anchor when opts.cacheRate omitted
w = base();
r = CE.compute(JSON.parse(JSON.stringify(w)), { model: 'gpt-5.4', tier: 'standard', mix: 'worst', hosting: 'api', costMode: 'optimistic' });
ok('cache falls back to anchor 0.88 (no crash, monthly>0)', r.api.monthly_capped > 0);

console.log(`\nretry-cache-authoritative: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node scripts/test-retry-cache-authoritative.mjs`
Expected: the `retry_rate 0.03 → 1.045` case FAILS (engine doesn't yet read `anchor_query.retry_rate`; buildOpts doesn't pass it). The "retry absent" and cache cases may already pass.

- [ ] **Step 3: Make the engine fall back to the workload's retry_rate**

In `public/lib/cost-engine.js`, find (≈ line 1200):
```js
    const retryInflate = opts.retryInflate != null
      ? opts.retryInflate
      : (1 + 1.5 * (opts.retry_rate || 0));
```
Replace with (adds a workload fallback; preserves all existing behavior when opts specify retry):
```js
    const retryRateEff = opts.retry_rate != null
      ? opts.retry_rate
      : ((w.anchor_query && w.anchor_query.retry_rate) || 0);
    const retryInflate = opts.retryInflate != null
      ? opts.retryInflate
      : (1 + 1.5 * retryRateEff);
```
(Confirm `w` is the normalized workload in scope here — it is the variable used elsewhere in `compute()`; if the local name differs, use that name.)

- [ ] **Step 4: This test still needs buildOpts to pass retry_rate — defer to Task 2.** For now, re-run and confirm the engine change didn't break the "retry absent" + cache cases:

Run: `node scripts/test-retry-cache-authoritative.mjs`
Expected: "retry absent" PASS, cache PASS; the 0.03 case still FAIL (buildOpts not yet updated). That's expected — Task 2 finishes it.

- [ ] **Step 5: Confirm no regression in the headless basis**

Run: `npm test && npm run bench:validate && node scripts/dump-engine.mjs && python3 python/parity_check.py`
Expected: all green; bench 6/6 ±0% (no preset sets retry_rate → all still 1.0); parity 18/18, 0 diffs.

- [ ] **Step 6: Commit**

```bash
git add public/lib/cost-engine.js scripts/test-retry-cache-authoritative.mjs
git commit -m "feat(engine): retry_rate falls back to anchor_query.retry_rate (no math change)"
```

---

## Task 2: Headless buildOpts reads retry_rate from the workload

**Files:**
- Modify: `public/lib/build-opts.js`
- Modify: `mcp/test/test-build-opts.mjs`

- [ ] **Step 1: Update the build-opts test to expect the new field** (`mcp/test/test-build-opts.mjs`)

Change the two expected objects to include `retry_rate`:
- In the `empty → defaults` case add `retry_rate: 0,`.
- In the `from workload` case, add `retry_rate: 0,` UNLESS you also add `retry_rate: 0.03` to that input's `anchor_query`. Simplest: add `retry_rate: 0.03` to the from-workload input's `anchor_query` and `retry_rate: 0.03,` to its expected object. (Pick one and make input/expected consistent.)

- [ ] **Step 2: Run it, verify it fails**

Run: `node mcp/test/test-build-opts.mjs`
Expected: FAIL — buildOpts output lacks `retry_rate`.

- [ ] **Step 3: Add `retry_rate` to `public/lib/build-opts.js`**

Inside the returned object in `buildOpts`, add (next to `cacheRate`):
```js
      retry_rate: (w.anchor_query && w.anchor_query.retry_rate != null)
        ? w.anchor_query.retry_rate : 0,
```

- [ ] **Step 4: Run both tests, verify they pass**

Run: `node mcp/test/test-build-opts.mjs && node scripts/test-retry-cache-authoritative.mjs`
Expected: build-opts PASS (2/2); retry-cache PASS (3/3 now — the 0.03 case passes because buildOpts threads `retry_rate` into opts).

- [ ] **Step 5: Confirm headless basis unchanged**

Run: `npm test && npm run bench:validate && node scripts/dump-engine.mjs && python3 python/parity_check.py`
Expected: all green; bench 6/6 ±0%; parity 18/18. (No preset sets `retry_rate`, so `retry_rate: 0` everywhere → identical numbers.)

- [ ] **Step 6: Commit**

```bash
git add public/lib/build-opts.js mcp/test/test-build-opts.mjs
git commit -m "feat: headless buildOpts reads retry_rate from the workload (default 0)"
```

---

## Task 3: Browser buildOpts reads retry + cache from the workload

This is the delicate task — `public/app.js` is large; read the surrounding code before editing.

**Files:**
- Modify: `public/app.js` (browser `buildOpts`, ≈ lines 1808–1900)

- [ ] **Step 1: Read the current browser buildOpts**

Run: `sed -n '1800,1900p' public/app.js` and read it. Locate exactly:
- `const retryRate = sRetryEl ? parseFloat(sRetryEl.value) / 100 : 0;` (≈1820)
- the `cacheRate:` line: `cacheRate: cacheFromAxiom !== null ? cacheFromAxiom : numVal('prev-cache', workload.anchor_query.cache_rate_baseline),` (≈1829)
- `retryInflate: 1 + (retryRate * 1.5),` (≈1895)
Understand how `cacheFromAxiom`, `sRetryEl`, and `workload` are obtained.

- [ ] **Step 2: Make the s-retry slider WRITE to the workload, and read retry FROM the workload**

Change the retry derivation so the slider mutates `workload.anchor_query.retry_rate` and buildOpts reads that field (single source of truth). Replace:
```js
  const retryRate = sRetryEl ? parseFloat(sRetryEl.value) / 100 : 0;
```
with:
```js
  // s-retry slider is an EDITOR of workload.anchor_query.retry_rate (fraction).
  if (sRetryEl && workload.anchor_query) {
    workload.anchor_query.retry_rate = (parseFloat(sRetryEl.value) || 0) / 100;
  }
  const retryRate = (workload.anchor_query && workload.anchor_query.retry_rate) || 0;
```
(`retryInflate: 1 + (retryRate * 1.5)` at ≈1895 then derives from the workload field — leave that line as is.)

- [ ] **Step 3: Make cacheRate authoritative from the anchor**

The s-cache slider already has a bidirectional link to `anchor_query.cache_rate_baseline` (see ≈line 3854). Make buildOpts read the anchor (the authoritative measured value) rather than an independent slider/`prev-cache` default. Replace the `cacheRate:` line (≈1829):
```js
      cacheRate: cacheFromAxiom !== null ? cacheFromAxiom : numVal('prev-cache', workload.anchor_query.cache_rate_baseline),
```
with:
```js
      cacheRate: (workload.anchor_query && workload.anchor_query.cache_rate_baseline != null)
        ? workload.anchor_query.cache_rate_baseline
        : (cacheFromAxiom !== null ? cacheFromAxiom : numVal('prev-cache', 0.7)),
```
(Anchor wins when present; the slider/axiom path remains a fallback so nothing breaks if the anchor is missing.)

- [ ] **Step 4: Smoke-check in the browser**

Start a local server (`cd public && python3 -m http.server 8765`), open `http://localhost:8765/index.html?v=t3`, switch to Advanced, load the default preset, and confirm the page still computes a headline (no JS error). Editing the s-retry slider should still move the headline (it now flows through the workload field). If the slider feels "stuck", check that the change handler still triggers a recompute (renderPreview) after writing the workload field.

- [ ] **Step 5: Run engine + headless suites (unaffected, but confirm no syntax break)**

Run: `node --check public/app.js && npm test && npm run mcp:test`
Expected: parses; all green (these are headless; the app.js change is browser-only — the consistency proof is Task 6).

- [ ] **Step 6: Commit**

```bash
git add public/app.js
git commit -m "feat(calc): browser buildOpts reads retry + cache from the workload"
```

---

## Task 4: Slider init / hash-restore sets sliders FROM the workload

**Files:**
- Modify: `public/app.js` (boot + `loadFromHash` slider initialization)

- [ ] **Step 1: Find where sliders are initialized on load / hash restore**

Run: `grep -n "loadFromHash\|function applyUiState\|s-retry\|s-cache" public/app.js | head -40` and read the function(s) that set slider values after a preset/hash load (look near `loadFromHash` ≈5263 and any `applyUiState`/`captureUiState`). Identify where `s-cache` is set from the workload today (the bidirectional listener at ≈3854 is the cache editor).

- [ ] **Step 2: On load, set s-retry + s-cache from the workload**

In the load/restore path (after `workload` is populated from a preset or hash, before the first `renderPreview`), set the sliders from the workload so an empty-`ui` hash (e.g. an MCP share-link) reflects the workload:
```js
  // Sliders mirror the authoritative workload fields on load.
  const sRetry = document.getElementById('s-retry');
  if (sRetry && workload.anchor_query) {
    sRetry.value = String(Math.round(((workload.anchor_query.retry_rate) || 0) * 100));
  }
  const sCache = document.getElementById('s-cache');
  if (sCache && workload.anchor_query && workload.anchor_query.cache_rate_baseline != null) {
    sCache.value = String(Math.round(workload.anchor_query.cache_rate_baseline * 100));
  }
```
Place this where other post-load slider syncing happens. If a dedicated `applyUiState(ui)` exists, set these as defaults when the `ui` block omits `s-retry`/`s-cache` (so an explicit ui value still wins, but an empty ui falls back to the workload). Read the surrounding code to choose the exact insertion point; do NOT introduce an update loop (write the slider value WITHOUT dispatching an input event that would recurse into buildOpts and re-write the workload).

- [ ] **Step 3: Browser smoke — empty-ui hash reflects the workload**

With the local server running, in the browser console (or a Playwright eval) load the default preset, then confirm `document.getElementById('s-retry').value === '0'` (default) and `s-cache` equals `anchor_query.cache_rate_baseline*100`. Confirm the headline did not change spuriously.

- [ ] **Step 4: Run checks**

Run: `node --check public/app.js && npm test`
Expected: parses; headless green.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(calc): initialize s-retry/s-cache from the workload on load/hash-restore"
```

---

## Task 5: Surface the retry control in the UI

**Files:**
- Modify: `public/index.html` (the s-retry control label/hint)

- [ ] **Step 1: Find the retry control markup**

Run: `grep -n "s-retry" public/index.html`

- [ ] **Step 2: Relabel so 0 is explicit, not hidden**

Update the label/hint text near the `s-retry` input to read (keep existing classes/structure; only change the human text):
> "Rate-limit retry — 0% (set if you expect throttled retries; inflates the API bill by 1 + 1.5×rate)"

Ensure the slider's default rendered position corresponds to 0 (Task 4 sets the value from the workload, default 0).

- [ ] **Step 3: Browser smoke**

Reload the calc; confirm the retry control reads 0% by default and the label is the new text.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(calc): surface retry control with explicit 0% default"
```

---

## Task 6: UI ↔ MCP consistency test (the regression guard)

**Files:**
- Modify: `scripts/test-e2e.js` (add a scenario + register it)

- [ ] **Step 1: Add the scenario function**

In `scripts/test-e2e.js`, add (near the other scenario functions, before the runner). It uses the MCP compute path (Node) and the browser, and asserts equality for the cap-clamped demo AND a non-capped variant (low MAU). `createRequire` loads the CJS/ESM MCP libs:
```js
async function uiMcpConsistency(page) {
  const { createRequire } = await import('node:module');
  const require2 = createRequire(import.meta.url);
  // MCP compute + share link (ESM libs)
  const { computeCost } = await import('../mcp/lib/compute.mjs');
  const fs = require2('node:fs');
  const WorkloadHash = require2('../public/lib/workload-hash.js');

  const demo = JSON.parse(fs.readFileSync(new URL('../public/examples/archetype-agent-demo.json', import.meta.url)));
  // Two cases: as-is (cap-clamped) and a non-capped low-MAU variant.
  const lowVol = JSON.parse(JSON.stringify(demo));
  lowVol.segments = [{ id: 'all', mau: 300, sessions_per_day: 0.2, questions_per_session: 10 }];

  for (const [name, w] of [['demo', demo], ['low-volume', lowVol]]) {
    const mcp = computeCost(w);
    assert(!mcp.error, `${name}: compute_cost errored`);
    const hash = mcp.share_link.split('calc.ajinkya.ai/')[1]; // '#w=...&mode=advanced'
    await page.goto(URL.split('#')[0] + hash, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => {
      const el = document.getElementById('cb-num');
      return el && el.textContent && !el.textContent.includes('—');
    }, { timeout: 15000 });
    await page.evaluate(() => { const o = document.getElementById('welcome-overlay'); if (o) o.remove(); });
    await sleep(2500); // let bench loader + recompute settle
    const ui = await page.evaluate(() => parseInt((document.getElementById('cb-num').textContent || '').replace(/[^\d]/g, ''), 10));
    assert(ui === mcp.headline_monthly_usd,
      `${name}: UI $${ui} != MCP $${mcp.headline_monthly_usd}`);
  }
}
```
> Note: `test-e2e.js` is CommonJS today (`require('playwright')`). Use dynamic `import()` for the ESM `compute.mjs` as shown. If the file is ESM, use static imports instead — match the file. The `URL` here is the suite's target URL constant (point the run at the local server via `--base=http://localhost:8765/index.html`).

- [ ] **Step 2: Register the scenario** in the runner list:
```js
  await scenario('ui-mcp-consistency',  uiMcpConsistency);
```

- [ ] **Step 3: Run it against the local server**

Start `cd public && python3 -m http.server 8765`. Then:
Run: `npm run test:e2e -- --base=http://localhost:8765/index.html --only=ui-mcp-consistency`
Expected: `ui-mcp-consistency ✓` — both `demo` and `low-volume` assert UI == MCP. If it fails, the printed `UI $X != MCP $Y` tells you which case and by how much; reconcile (almost always a remaining slider-not-from-workload path).

- [ ] **Step 4: Run the FULL e2e suite (no regressions in the 17 existing scenarios)**

Run: `npm run test:e2e -- --base=http://localhost:8765/index.html --slow=0`
Expected: 18 passed · 0 failed (17 existing + the new one).

- [ ] **Step 5: Commit**

```bash
git add scripts/test-e2e.js
git commit -m "test(e2e): UI==MCP headline consistency guard (demo + non-capped)"
```

---

## Task 7: Final regression + re-confirm MCP pins

**Files:** none (verification + any pin fix surfaced)

- [ ] **Step 1: Full headless + MCP suites**

Run: `npm test && npm run mcp:test && npm run bench:validate && node scripts/dump-engine.mjs && python3 python/parity_check.py`
Expected: all green; bench 6/6 ±0%; parity 18/18. The MCP engine-bridge pin (45070 for the demo) should be UNCHANGED (demo has no retry_rate → still 0).

- [ ] **Step 2: Full e2e**

Run (local server up): `npm run test:e2e -- --base=http://localhost:8765/index.html --slow=0`
Expected: 18 passed · 0 failed.

- [ ] **Step 3: If any MCP test pin moved, reconcile honestly**

If `mcp/test/test-engine-bridge.mjs` or `test-e2e-thorough.mjs` headline pins changed, that means the demo's number moved — investigate WHY before updating a pin (the demo has retry_rate 0, so it should not move). Only update a pin once you've confirmed the new value is correct.

- [ ] **Step 4: Push**

```bash
git push origin feat/cost-mcp
```

---

## Acceptance criteria (whole plan)
- `npm test`, `npm run mcp:test`, `npm run bench:validate` (6/6 ±0%), parity 18/18 — all green, **no re-bake**.
- New `scripts/test-retry-cache-authoritative.mjs` passes (engine reads retry/cache from the workload).
- **UI == MCP**: `ui-mcp-consistency` e2e passes for both the cap-clamped demo and a non-capped workload — the gap is closed and guarded.
- Full e2e: 18/18.
- Live UI default retry shows 0%; the default headline drops ~4.5% (documented, intended).

## Notes / deferred
- Other UI-only knobs (s-growth, bot factor, api-split, prev-* selects) may share the same headless-vs-UI divergence class. NOT addressed here (they didn't affect the measured gap). Flag for a future audit; do not silently assume they're consistent.
- Branch: implemented on `feat/cost-mcp`; user may split production-calc vs MCP-server commits at merge.
