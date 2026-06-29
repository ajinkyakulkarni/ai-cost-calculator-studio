# Cost-Calculator MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a stateless Node stdio MCP server that lets an agent (the user's Claude Code) interview a user and quote AI-agent deployment costs that are byte-identical to calc.ajinkya.ai, with the LLM never doing arithmetic.

**Architecture:** The server `require()`s the canonical browser engine modules (`public/lib/cost-engine.js`, `headline-math.js`, `workload-hash.js`) and a newly-extracted shared `build-opts.js`. It exposes six tools and one prompt. The host holds the `workload` JSON; the server is a pure wrapper. A hard gate refuses to compute until cost-driving inputs are present; an interview prompt + server instructions make the agent propose defaults and confirm only what it must.

**Tech Stack:** Node ≥18 (ESM server with `createRequire` for the CJS engine), `@modelcontextprotocol/sdk`, `zod` (ships with the SDK) for tool input schemas. No other runtime deps.

**Spec:** `docs/superpowers/specs/2026-06-27-cost-calc-mcp-design.md`

---

## File structure

```
public/lib/build-opts.js     # NEW (extracted): canonical buildOpts(w) — UMD (CJS+global)
mcp/
  server.mjs                 # MCP wiring (tools, prompt, instructions, stdio)
  lib/
    engine-bridge.mjs        # computeWorkload(workload) → {opts,result,headline,…} (canonical engine + headline)
    workload-schema.mjs      # REQUIRED/SUGGESTIBLE field metadata + helpers
    validate.mjs             # validateWorkload(workload) → {ok, missing_required[], assumptions[]}
    presets.mjs              # listPresets(), loadPreset(name)
    sharelink.mjs            # shareLink(workload) → calc.ajinkya.ai/#w=… (reuses WorkloadHash)
    format.mjs               # formatResult(workload) → compute_cost success object
    compute.mjs              # computeCost(workload) → hard gate: {error,…} OR formatResult
  prompts/cost-interview.md  # the written interview prompt
  instructions.md            # server-level instructions injected on connect
  test/
    test-build-opts.mjs
    test-engine-bridge.mjs
    test-validate.mjs
    test-presets.mjs
    test-sharelink.mjs
    test-compute-gate.mjs
    test-parity.mjs
    test-protocol.mjs
  README.md
package.json                 # + deps, + "mcp:test" script
```

**Branch:** work on `feat/cost-mcp` (already created and checked out).

**Conventions to follow:** UMD pattern from `public/lib/workload-hash.js` for `build-opts.js`; `createRequire` pattern from `scripts/dump-engine.mjs` to load CJS engine modules from ESM; commit messages imperative, **no `Co-Authored-By` trailer**.

---

## Task 1: Extract shared `buildOpts` (DRY, parity-guarded)

`buildOpts(w)` is currently duplicated in `scripts/dump-engine.mjs` and `scripts/bench-validate.mjs`. Extract it so the MCP reuses the exact same opts the parity/bench tooling uses (the bench-pinning discipline requires identical opts).

**Files:**
- Create: `public/lib/build-opts.js`
- Create: `mcp/test/test-build-opts.mjs`
- Modify: `scripts/dump-engine.mjs` (replace inline `buildOpts` with a require)
- Modify: `scripts/bench-validate.mjs` (replace inline `buildOpts` with a require)

- [ ] **Step 1: Write the failing test**

`mcp/test/test-build-opts.mjs`:
```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildOpts } = require('../../public/lib/build-opts.js');

let pass = 0, fail = 0;
const eq = (l, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'} ${l}`); };

// defaults applied when workload.defaults absent
eq('empty → defaults', buildOpts({}), {
  hosting: 'api', model: 'gpt-5.2', tier: 'standard', mix: 'mixed',
  costMode: 'realistic', botFactor: 1.5, cacheRate: 0.7, verifCoverage: 0,
});
// reads workload.defaults + anchor cache + verification coverage
eq('from workload', buildOpts({
  defaults: { hosting: 'self-host', model: 'gpt-5.4', tier: 'batch', mix: 'worst', cost_mode: 'optimistic' },
  anchor_query: { cache_rate_baseline: 0.88 },
  verification: { coverage: 0.1 },
}), {
  hosting: 'self-host', model: 'gpt-5.4', tier: 'batch', mix: 'worst',
  costMode: 'optimistic', botFactor: 1.5, cacheRate: 0.88, verifCoverage: 0.1,
});

console.log(`\nbuild-opts: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node mcp/test/test-build-opts.mjs`
Expected: FAIL — `Cannot find module '../../public/lib/build-opts.js'`.

- [ ] **Step 3: Create `public/lib/build-opts.js`** (UMD, exact logic copied from dump-engine.mjs)

```js
/* build-opts.js — canonical engine-opts builder.
 * Single source of truth for the opts object passed to CostEngine.compute().
 * Used by scripts/dump-engine.mjs, scripts/bench-validate.mjs, and the MCP
 * server, so all headless callers compute with identical opts. UMD: CommonJS
 * (Node) + browser global (window.BuildOpts).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BuildOpts = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function buildOpts(w) {
    w = w || {};
    const d = w.defaults || {};
    return {
      hosting:   d.hosting   || 'api',
      model:     d.model     || 'gpt-5.2',
      tier:      d.tier      || 'standard',
      mix:       d.mix       || 'mixed',
      costMode:  d.cost_mode || 'realistic',
      botFactor: 1.5,
      cacheRate: (w.anchor_query && w.anchor_query.cache_rate_baseline != null)
        ? w.anchor_query.cache_rate_baseline : 0.7,
      verifCoverage: (w.verification && w.verification.coverage) || 0,
    };
  }
  return { buildOpts };
}));
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node mcp/test/test-build-opts.mjs`
Expected: `build-opts: 2 passed, 0 failed.`

- [ ] **Step 5: Update `scripts/dump-engine.mjs` to require it**

Replace the inline `function buildOpts(w) {...}` (the whole function) with:
```js
const { buildOpts } = require(path.resolve(__dirname, '..', 'public', 'lib', 'build-opts.js'));
```
(Place it next to the other `require`s, after `const CostEngine = require(ENGINE_PATH);`.)

- [ ] **Step 6: Update `scripts/bench-validate.mjs` to require it**

Find its inline `buildOpts` and replace identically with a `require` of `public/lib/build-opts.js` (use the same path-resolve style already used in that file for the engine). Delete the inline function.

- [ ] **Step 7: Prove no behavior change**

Run: `npm test && npm run bench:validate && node scripts/dump-engine.mjs && python3 python/parity_check.py`
Expected: all green; bench 6/6 within ±5%; parity 18/18, 0 diffs. (If parity changes, the extraction diverged from the original — fix `build-opts.js` to match exactly.)

- [ ] **Step 8: Commit**

```bash
git add public/lib/build-opts.js mcp/test/test-build-opts.mjs scripts/dump-engine.mjs scripts/bench-validate.mjs
git commit -m "refactor: extract canonical buildOpts to public/lib/build-opts.js

Single source of truth for engine opts, shared by dump-engine,
bench-validate, and the upcoming MCP server. Parity 18/18 unchanged."
```

---

## Task 2: Engine bridge (canonical compute + site headline)

**Files:**
- Create: `mcp/lib/engine-bridge.mjs`
- Create: `mcp/test/test-engine-bridge.mjs`

- [ ] **Step 1: Write the failing test**

`mcp/test/test-engine-bridge.mjs`:
```js
import { createRequire } from 'node:module';
import { computeWorkload } from '../lib/engine-bridge.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const w = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));
const out = computeWorkload(w);

ok('returns opts/result/headline', out.opts && out.result && typeof out.headline === 'number');
ok('headline > 0', out.headline > 0);
ok('headline is cap-aware $47,095 (archetype demo)', Math.round(out.headline) === 47095);
ok('per_query > 0', out.perQuery > 0);
ok('derivation string present', typeof out.derivation === 'string' && out.derivation.length > 0);
ok('breakdown has llm + additive lines', out.composed && typeof out.composed.llm === 'number');

console.log(`\nengine-bridge: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

> Note: `47095` is the verified archetype-demo headline at preset defaults (cap-clamped). If the preset's defaults change, recompute and update this pin.

- [ ] **Step 2: Run it, verify it fails**

Run: `node mcp/test/test-engine-bridge.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `mcp/lib/engine-bridge.mjs`**

```js
/* engine-bridge.mjs — the ONLY place that calls the cost engine.
 * Reuses the canonical browser modules so MCP numbers equal the live site:
 *   - cost-engine.js   → CostEngine.compute(workload, opts)
 *   - headline-math.js → composeHeadline / computeAgentEngineering (the site rollup)
 *   - build-opts.js    → the exact opts the bench/parity tooling uses
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const CostEngine  = require('../../public/lib/cost-engine.js');
const HeadlineMath = require('../../public/lib/headline-math.js');
const { buildOpts } = require('../../public/lib/build-opts.js');

export function computeWorkload(workload) {
  const opts = buildOpts(workload);
  const result = CostEngine.compute(workload, opts);
  // Agent-engineering monthly (rare; usually disabled → 0). composeHeadline
  // signature: (result, workload, opts, retryInflate, aeMonthly). retryInflate
  // = 1 because the engine already folds (1+1.5r) into api.monthly_with_retry.
  const ae = HeadlineMath.computeAgentEngineering(
    workload.agent_engineering || { enabled: false },
    (require('../../public/lib/prices.js').personnel_roles) || {}
  );
  const composed = HeadlineMath.composeHeadline(
    result, workload, opts, 1, ae.enabled ? ae.monthly : 0
  );
  const perQuery = result.api && result.api.per_query_blended != null
    ? result.api.per_query_blended : null;
  return {
    opts, result, composed,
    headline: composed.headline,
    perQuery,
    derivation: result.derivation || '',
  };
}
```

> **Verify before running:** open `public/lib/headline-math.js` and confirm `computeAgentEngineering(ae, personnelPrices)` — pass `workload.agent_engineering` as the first arg. Confirm the prices key name in `public/lib/prices.js` for personnel roles (used only when agent-engineering is enabled; pass `{}` if the key differs and AE is disabled in test presets). The archetype demo has AE disabled, so this path returns monthly 0.

- [ ] **Step 4: Run the test, verify it passes**

Run: `node mcp/test/test-engine-bridge.mjs`
Expected: `engine-bridge: 6 passed, 0 failed.` If `headline` ≠ 47095, print `out.composed` and reconcile against the live site (`#w=` of the demo) before changing the pin.

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/engine-bridge.mjs mcp/test/test-engine-bridge.mjs
git commit -m "feat(mcp): engine bridge reusing canonical compute + headline rollup"
```

---

## Task 3: Workload schema metadata (required / suggestible)

**Files:**
- Create: `mcp/lib/workload-schema.mjs`
- Create: `mcp/test/test-validate.mjs` (used by Tasks 3 & 4)

- [ ] **Step 1: Write `mcp/lib/workload-schema.mjs`**

```js
/* workload-schema.mjs — classification of workload inputs into REQUIRED
 * (hard gate; agent must propose + user confirm) vs SUGGESTIBLE (defaulted,
 * surfaced as an assumption). Drives both validate.mjs and the interview.
 */

// Each required field: how to detect presence on a workload, why it matters,
// and a suggested value + rationale the agent can offer.
export const REQUIRED = [
  {
    field: 'volume',
    present: (w) => Array.isArray(w.segments) && w.segments.some(s =>
      Number(s.mau) > 0 && s.sessions_per_day != null && s.questions_per_session != null),
    why: 'Total query volume drives every cost line.',
    suggested_value: { segments: [{ id: 'all', mau: 5000, sessions_per_day: 0.2, questions_per_session: 10 }] },
    rationale: 'Mid-size agency pilot ≈ 5,000 MAU × 0.2 sessions/day × 10 questions.',
  },
  {
    field: 'model',
    present: (w) => !!(w.defaults && w.defaults.model),
    why: 'Per-token rates depend on the model.',
    suggested_value: { defaults: { model: 'gpt-5.4' } },
    rationale: 'A current flagship; pick your actual model.',
  },
  {
    field: 'hosting',
    present: (w) => !!(w.defaults && w.defaults.hosting),
    why: 'API vs BYOK vs self-host changes the cost structure entirely.',
    suggested_value: { defaults: { hosting: 'api' } },
    rationale: 'Managed API is the common starting point.',
  },
  {
    field: 'cache_rate_baseline',
    present: (w) => !!(w.anchor_query && w.anchor_query.cache_rate_baseline != null),
    why: 'Prompt-cache hit rate strongly moves the token bill.',
    suggested_value: { anchor_query: { cache_rate_baseline: 0.8 } },
    rationale: 'Stable system prompts typically cache ~0.8; confirm from telemetry.',
  },
  {
    field: 'token_profile',
    present: (w) =>
      (w.anchor_query && Number(w.anchor_query.input_tokens) > 0) ||
      (Array.isArray(w.agents) && w.agents.length > 0) ||
      (Array.isArray(w.archetypes) && w.archetypes.length > 0),
    why: 'The per-query token shape (anchor, agents, or archetypes) is the cost basis.',
    suggested_value: { anchor_query: { input_tokens: 3000, output_tokens: 500 } },
    rationale: 'A single-call RAG answer is ~3k in / ~500 out; replace with your trace.',
  },
];

// Conditionally required: only when the workload indicates that path.
export const CONDITIONAL = [
  {
    field: 'self_host_gpu',
    applies: (w) => w.defaults && w.defaults.hosting === 'self-host',
    present: (w) => !!(w.self_host && w.self_host.gpu_choice),
    why: 'Self-host cost depends on the chosen GPU + throughput.',
  },
  {
    field: 'fedramp_tier',
    applies: (w) => !!(w.federal && w.federal.indicated),
    present: (w) => !!(w.federal && w.federal.fedramp_tier && w.federal.fedramp_tier !== 'none'),
    why: 'FedRAMP tier adds large compliance overhead.',
  },
];

// Suggestible fields → default + source label, surfaced as assumptions.
export const SUGGESTIBLE = [
  { field: 'tier',      get: (w) => w.defaults?.tier,      default: 'standard',   source: 'default' },
  { field: 'cost_mode', get: (w) => w.defaults?.cost_mode, default: 'optimistic', source: 'default' },
  { field: 'mix',       get: (w) => w.defaults?.mix,       default: 'worst',      source: 'default' },
];
```

- [ ] **Step 2: (test added in Task 4)** — no standalone test for the data module; it is exercised by `validate.mjs` tests.

- [ ] **Step 3: Commit**

```bash
git add mcp/lib/workload-schema.mjs
git commit -m "feat(mcp): workload field classification (required/conditional/suggestible)"
```

---

## Task 4: `validate_workload`

**Files:**
- Create: `mcp/lib/validate.mjs`
- Create/extend: `mcp/test/test-validate.mjs`

- [ ] **Step 1: Write the failing test** (`mcp/test/test-validate.mjs`)

```js
import { createRequire } from 'node:module';
import { validateWorkload } from '../lib/validate.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

// Full preset → ok, no missing.
const full = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));
const vFull = validateWorkload(full);
ok('full preset ok', vFull.ok === true && vFull.missing_required.length === 0);
ok('full preset reports assumptions array', Array.isArray(vFull.assumptions));

// Missing model → flagged with a suggestion.
const noModel = JSON.parse(JSON.stringify(full));
delete noModel.defaults.model;
const vNoModel = validateWorkload(noModel);
ok('missing model → not ok', vNoModel.ok === false);
ok('missing model named', vNoModel.missing_required.some(m => m.field === 'model'));
ok('missing model carries suggestion', vNoModel.missing_required.find(m => m.field === 'model').suggested_value != null);

// Empty workload → many missing.
const vEmpty = validateWorkload({});
ok('empty → volume+model+hosting+cache+token_profile missing', ['volume','model','hosting','cache_rate_baseline','token_profile'].every(f => vEmpty.missing_required.some(m => m.field === f)));

console.log(`\nvalidate: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node mcp/test/test-validate.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `mcp/lib/validate.mjs`**

```js
/* validate.mjs — classify a workload without computing. Returns the missing
 * required inputs (with suggestions) and the suggestible defaults that would
 * be assumed. No cost numbers here. */
import { REQUIRED, CONDITIONAL, SUGGESTIBLE } from './workload-schema.mjs';

export function validateWorkload(workload) {
  const w = workload || {};
  const missing_required = [];
  for (const r of REQUIRED) {
    if (!r.present(w)) {
      missing_required.push({ field: r.field, why: r.why, suggested_value: r.suggested_value, rationale: r.rationale });
    }
  }
  for (const c of CONDITIONAL) {
    if (c.applies(w) && !c.present(w)) {
      missing_required.push({ field: c.field, why: c.why });
    }
  }
  const assumptions = [];
  for (const s of SUGGESTIBLE) {
    const v = s.get(w);
    assumptions.push(v == null
      ? { field: s.field, value: s.default, source: s.source }
      : { field: s.field, value: v, source: 'user' });
  }
  return { ok: missing_required.length === 0, missing_required, assumptions };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node mcp/test/test-validate.mjs`
Expected: `validate: 7 passed, 0 failed.`

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/validate.mjs mcp/test/test-validate.mjs
git commit -m "feat(mcp): validate_workload — missing-required + assumptions, no compute"
```

---

## Task 5: Presets

**Files:**
- Create: `mcp/lib/presets.mjs`
- Create: `mcp/test/test-presets.mjs`

- [ ] **Step 1: Write the failing test** (`mcp/test/test-presets.mjs`)

```js
import { listPresets, loadPreset } from '../lib/presets.mjs';
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const list = listPresets();
ok('lists >= 18 presets', list.length >= 18);
ok('each has name + one_line', list.every(p => p.name && typeof p.one_line === 'string'));

const w = loadPreset('archetype-agent-demo');
ok('loadPreset returns a workload', w && w.deployment && w.shapes);
ok('unknown preset throws', (() => { try { loadPreset('nope'); return false; } catch { return true; } })());

console.log(`\npresets: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node mcp/test/test-presets.mjs` → FAIL (module not found).

- [ ] **Step 3: Write `mcp/lib/presets.mjs`**

```js
/* presets.mjs — list + load the bundled example workloads. The example files
 * ARE the workload at top level (deployment, shapes, …). */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.resolve(new URL('../../public/examples', import.meta.url).pathname);

export function listPresets() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => {
    const name = f.replace(/\.json$/, '');
    const w = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const dep = w.deployment || {};
    return { name, title: dep.name || name, one_line: dep.description || '' };
  });
}

export function loadPreset(name) {
  const p = path.join(DIR, `${String(name).replace(/[^a-z0-9-]/gi, '')}.json`);
  if (!fs.existsSync(p)) throw new Error(`unknown preset: ${name}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node mcp/test/test-presets.mjs`
Expected: `presets: 4 passed, 0 failed.`

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/presets.mjs mcp/test/test-presets.mjs
git commit -m "feat(mcp): list_presets + load_preset over public/examples"
```

---

## Task 6: Share link (reuse WorkloadHash)

**Files:**
- Create: `mcp/lib/sharelink.mjs`
- Create: `mcp/test/test-sharelink.mjs`

- [ ] **Step 1: Write the failing test** (`mcp/test/test-sharelink.mjs`)

```js
import { createRequire } from 'node:module';
import { shareLink } from '../lib/sharelink.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const WorkloadHash = require('../../public/lib/workload-hash.js');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const w = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));
const url = shareLink(w);

ok('url is calc.ajinkya.ai #w=', /^https:\/\/calc\.ajinkya\.ai\/#w=/.test(url));
// round-trip: decode the hash and confirm the workload survives
const decoded = WorkloadHash.classifyPayload(WorkloadHash.decodeHash(url));
ok('decodes to a valid wrapped workload', decoded.kind === 'wrapped');
ok('round-trips deployment name', decoded.workload.deployment.name === w.deployment.name);
ok('round-trips agents length', (decoded.workload.agents || []).length === (w.agents || []).length);

console.log(`\nsharelink: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node mcp/test/test-sharelink.mjs` → FAIL (module not found).

- [ ] **Step 3: Write `mcp/lib/sharelink.mjs`**

```js
/* sharelink.mjs — build a calc.ajinkya.ai share URL. Reuses the canonical
 * WorkloadHash codec so it can never drift from what the site decodes. The
 * site payload is { workload, ui }; the agent has no slider UI state, so ui is
 * empty and the calc falls back to the workload's own values. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WorkloadHash = require('../../public/lib/workload-hash.js');

const BASE = 'https://calc.ajinkya.ai/';

export function shareLink(workload) {
  const encoded = WorkloadHash.encodePayload({ workload, ui: {} });
  return BASE + WorkloadHash.buildHashString(encoded, 'advanced');
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node mcp/test/test-sharelink.mjs`
Expected: `sharelink: 4 passed, 0 failed.`

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/sharelink.mjs mcp/test/test-sharelink.mjs
git commit -m "feat(mcp): make_share_link reusing the canonical WorkloadHash codec"
```

---

## Task 7: Result formatter

**Files:**
- Create: `mcp/lib/format.mjs`
- (tested via Task 8's compute test)

- [ ] **Step 1: Write `mcp/lib/format.mjs`**

```js
/* format.mjs — shape a computed workload into the compute_cost success object.
 * Assumes the caller already passed the hard gate. */
import { computeWorkload } from './engine-bridge.mjs';
import { validateWorkload } from './validate.mjs';
import { shareLink } from './sharelink.mjs';

export function formatResult(workload) {
  const { result, composed, headline, perQuery, derivation } = computeWorkload(workload);
  const { assumptions } = validateWorkload(workload);

  const warnings = [];
  if (result.api && result.api.monthly_gross > result.api.monthly_capped + 1) {
    warnings.push(`Daily cap clamps the LLM bill (gross $${Math.round(result.api.monthly_gross).toLocaleString()} → capped $${Math.round(result.api.monthly_capped).toLocaleString()}/mo).`);
  }
  if (Array.isArray(workload.agents) && workload.agents.some(a => a._source && /derived/i.test(a._source))) {
    warnings.push('One or more agent token profiles are DERIVED, not measured.');
  }

  return {
    headline_monthly_usd: Math.round(headline),
    per_query_usd: perQuery,
    breakdown: {
      llm: composed.llm, fixed: composed.fixed, verification: composed.verif,
      tool_fees: composed.toolFees, federal: composed.fed, embedding: composed.emb,
      personnel: composed.pers, agent_engineering: composed.ae,
    },
    assumptions,
    warnings,
    derivation_trace: derivation,
    share_link: shareLink(workload),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add mcp/lib/format.mjs
git commit -m "feat(mcp): result formatter (headline, breakdown, assumptions, warnings, trace, link)"
```

---

## Task 8: `compute_cost` hard gate

**Files:**
- Create: `mcp/lib/compute.mjs`
- Create: `mcp/test/test-compute-gate.mjs`

- [ ] **Step 1: Write the failing test** (`mcp/test/test-compute-gate.mjs`)

```js
import { createRequire } from 'node:module';
import { computeCost } from '../lib/compute.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const full = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));

// Pass: full preset → numbers, no error.
const good = computeCost(full);
ok('full preset returns headline', !good.error && good.headline_monthly_usd > 0);
ok('full preset returns share link', /#w=/.test(good.share_link || ''));

// Gate: drop model → refuse, no numbers.
const noModel = JSON.parse(JSON.stringify(full)); delete noModel.defaults.model;
const gated = computeCost(noModel);
ok('missing model → error', gated.error === 'missing_required');
ok('missing model → names model', gated.missing_required.some(m => m.field === 'model'));
ok('missing model → NO numbers', gated.headline_monthly_usd === undefined);

// Gate: empty → refuse.
ok('empty → error', computeCost({}).error === 'missing_required');

console.log(`\ncompute-gate: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node mcp/test/test-compute-gate.mjs` → FAIL (module not found).

- [ ] **Step 3: Write `mcp/lib/compute.mjs`**

```js
/* compute.mjs — the hard gate. No cost numbers escape unless every required
 * input is present. */
import { validateWorkload } from './validate.mjs';
import { formatResult } from './format.mjs';

export function computeCost(workload) {
  const v = validateWorkload(workload);
  if (!v.ok) {
    return {
      error: 'missing_required',
      message: 'Cannot compute a cost until these inputs are provided (propose values and confirm with the user, then retry).',
      missing_required: v.missing_required,
    };
  }
  return formatResult(workload);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node mcp/test/test-compute-gate.mjs`
Expected: `compute-gate: 6 passed, 0 failed.`

- [ ] **Step 5: Commit**

```bash
git add mcp/lib/compute.mjs mcp/test/test-compute-gate.mjs
git commit -m "feat(mcp): compute_cost hard gate — refuses until required inputs present"
```

---

## Task 9: Parity test (MCP ≡ engine ≡ site)

**Files:**
- Create: `mcp/test/test-parity.mjs`

- [ ] **Step 1: Write the test**

```js
/* For every bundled preset, computeCost's headline must equal the engine-bridge
 * headline computed directly — proving the tool/gate/format layers don't mangle
 * the engine number. (engine-bridge already matches the site via headline-math.) */
import { createRequire } from 'node:module';
import { computeCost } from '../lib/compute.mjs';
import { computeWorkload } from '../lib/engine-bridge.mjs';
import { validateWorkload } from '../lib/validate.mjs';
import { listPresets, loadPreset } from '../lib/presets.mjs';

let pass = 0, fail = 0;
for (const { name } of listPresets()) {
  const w = loadPreset(name);
  if (!validateWorkload(w).ok) { console.log(`  SKIP ${name} (preset omits a required field)`); continue; }
  const viaTool = computeCost(w).headline_monthly_usd;
  const direct = Math.round(computeWorkload(w).headline);
  const ok = viaTool === direct;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: tool ${viaTool} vs direct ${direct}`);
}
console.log(`\nmcp-parity: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it passes**

Run: `node mcp/test/test-parity.mjs`
Expected: every preset PASS (or SKIP if it legitimately omits a required field). 0 failed.
If a preset SKIPs unexpectedly, inspect whether the required-field detection in `workload-schema.mjs` is too strict for that preset's shape and adjust the `present()` predicate.

- [ ] **Step 3: Commit**

```bash
git add mcp/test/test-parity.mjs
git commit -m "test(mcp): headline parity across all bundled presets (tool == engine)"
```

---

## Task 10: Interview prompt + server instructions

**Files:**
- Create: `mcp/prompts/cost-interview.md`
- Create: `mcp/instructions.md`

- [ ] **Step 1: Write `mcp/prompts/cost-interview.md`**

```markdown
# Cost interview

You are a cost analyst for AI-agent deployments. You NEVER do the arithmetic
yourself — every dollar figure comes from the `compute_cost` tool. Your job is
to turn a plain-language description into a complete `workload`, proposing
sensible defaults and confirming only what you must.

## Flow
1. Ask what they're building, in their own words.
2. Pick the closest starting point with `list_presets` → `load_preset`, then
   adapt it. Infer everything you reasonably can.
3. Call `validate_workload`. For each entry in `missing_required`, present the
   field, your proposed value (use its `suggested_value`/`rationale`), and ask
   the user to confirm or correct — as a short checklist, not one slow Q&A.
   In one line, state the suggestible defaults you applied (tier, cost mode,
   mix) and that they can override any.
4. Once the user confirms the required inputs, call `compute_cost`.
   - If it returns `missing_required`, you skipped a confirmation — collect it
     and retry. Never present a number from anywhere but this tool.
5. Present: the headline monthly cost, per-query cost, the main breakdown
   lines, then the assumptions list and any warnings. Include the `share_link`
   so they can open the full visual calculator. Offer the derivation trace on
   request.
6. Offer sensitivities: "want it on a cheaper model, at batch tier, or at 2×
   volume?" — each is another `compute_cost` call.

## Rules
- NEVER silently invent a required input (volume, model, hosting, cache rate,
  token profile). Propose + confirm.
- Propose realistic operating points, not midpoints or zeros.
- Flag any value marked derived-not-measured.
- Keep the headline you quote exactly as `compute_cost` returns it.
```

- [ ] **Step 2: Write `mcp/instructions.md`** (condensed always-on version)

```markdown
This server costs AI-agent deployments with a frozen, audited engine. Do NOT
compute costs yourself — call `compute_cost`; it is the only source of numbers.
Build a `workload` from the user's description (start from `list_presets` /
`load_preset`), run `validate_workload`, and for every `missing_required` field
propose a value with rationale and CONFIRM it with the user before computing —
never invent volume, model, hosting, cache rate, or token profile. Apply
suggestible defaults (tier/cost-mode/mix) transparently. Present the headline,
breakdown, assumptions, warnings, and the share_link; offer sensitivities. For
a guided session, use the `cost_interview` prompt.
```

- [ ] **Step 3: Commit**

```bash
git add mcp/prompts/cost-interview.md mcp/instructions.md
git commit -m "feat(mcp): cost_interview prompt + server instructions (propose-and-confirm)"
```

---

## Task 11: MCP server wiring (stdio)

**Files:**
- Modify: `package.json` (add deps + `mcp:test` script)
- Create: `mcp/server.mjs`
- Create: `mcp/test/test-protocol.mjs`

- [ ] **Step 1: Add deps + script to `package.json`**

Add to `dependencies` (or `devDependencies` if you prefer): `"@modelcontextprotocol/sdk": "^1.0.0"`. Add to `scripts`:
```json
"mcp:test": "for t in mcp/test/test-build-opts.mjs mcp/test/test-engine-bridge.mjs mcp/test/test-validate.mjs mcp/test/test-presets.mjs mcp/test/test-sharelink.mjs mcp/test/test-compute-gate.mjs mcp/test/test-parity.mjs mcp/test/test-protocol.mjs; do node \"$t\" || exit 1; done"
```
Run: `npm install`
Expected: SDK + zod installed.

- [ ] **Step 2: Write the failing protocol test** (`mcp/test/test-protocol.mjs`)

```js
/* Spawn the server over stdio, list tools + prompts, call compute_cost, assert
 * a JSON result comes back. Uses the SDK client. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const transport = new StdioClientTransport({ command: 'node', args: [new URL('../server.mjs', import.meta.url).pathname] });
const client = new Client({ name: 'test', version: '0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map(t => t.name);
ok('lists six tools', ['list_presets','load_preset','get_schema','validate_workload','compute_cost','make_share_link'].every(t => tools.includes(t)));

const prompts = (await client.listPrompts()).prompts.map(p => p.name);
ok('lists cost_interview prompt', prompts.includes('cost_interview'));

const w = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));
const res = await client.callTool({ name: 'compute_cost', arguments: { workload: w } });
const payload = JSON.parse(res.content[0].text);
ok('compute_cost returns a headline over stdio', payload.headline_monthly_usd > 0);

await client.close();
console.log(`\nmcp-protocol: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 3: Run it, verify it fails**

Run: `node mcp/test/test-protocol.mjs`
Expected: FAIL — `server.mjs` not found / cannot connect.

- [ ] **Step 4: Write `mcp/server.mjs`**

```js
#!/usr/bin/env node
/* server.mjs — cost-calculator MCP server (stdio). Thin wrapper over the
 * canonical engine; all numbers come from compute_cost. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'node:module';

import { listPresets, loadPreset } from './lib/presets.mjs';
import { validateWorkload } from './lib/validate.mjs';
import { computeCost } from './lib/compute.mjs';
import { shareLink } from './lib/sharelink.mjs';
import { REQUIRED, CONDITIONAL, SUGGESTIBLE } from './lib/workload-schema.mjs';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const instructions = fs.readFileSync(new URL('./instructions.md', import.meta.url), 'utf8');
const interviewPrompt = fs.readFileSync(new URL('./prompts/cost-interview.md', import.meta.url), 'utf8');

const server = new McpServer({ name: 'cost-calc', version: '1.0.0' }, { instructions });

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const workloadArg = { workload: z.object({}).passthrough() };

server.registerTool('list_presets',
  { title: 'List presets', description: 'Bundled example deployments to start from.', inputSchema: {} },
  async () => asText(listPresets()));

server.registerTool('load_preset',
  { title: 'Load preset', description: 'Return a preset workload to adapt.', inputSchema: { name: z.string() } },
  async ({ name }) => { try { return asText(loadPreset(name)); } catch (e) { return asText({ error: e.message }); } });

server.registerTool('get_schema',
  { title: 'Get schema', description: 'Required vs suggestible workload fields + docs.', inputSchema: {} },
  async () => asText({
    required: REQUIRED.map(r => ({ field: r.field, why: r.why, suggested_value: r.suggested_value, rationale: r.rationale })),
    conditional: CONDITIONAL.map(c => ({ field: c.field, why: c.why })),
    suggestible: SUGGESTIBLE.map(s => ({ field: s.field, default: s.default })),
  }));

server.registerTool('validate_workload',
  { title: 'Validate workload', description: 'Missing-required + assumptions. No compute.', inputSchema: workloadArg },
  async ({ workload }) => asText(validateWorkload(workload)));

server.registerTool('compute_cost',
  { title: 'Compute cost', description: 'Cost via the canonical engine. Refuses until required inputs are present.', inputSchema: workloadArg },
  async ({ workload }) => asText(computeCost(workload)));

server.registerTool('make_share_link',
  { title: 'Make share link', description: 'calc.ajinkya.ai URL that opens this workload in the visual UI.', inputSchema: workloadArg },
  async ({ workload }) => asText({ url: shareLink(workload) }));

server.registerPrompt('cost_interview',
  { title: 'Cost interview', description: 'Guided interview to cost a deployment.' },
  async () => ({ messages: [{ role: 'user', content: { type: 'text', text: interviewPrompt } }] }));

await server.connect(new StdioServerTransport());
```

> **Verify before running:** the installed `@modelcontextprotocol/sdk` version's API. If `McpServer` doesn't accept `{ instructions }` as the 2nd constructor arg in the installed version, set instructions via the documented option for that version (e.g. server options/`Server` capabilities). If `registerTool`/`registerPrompt` names differ, use the version's equivalents (`tool(...)`, `prompt(...)`). Adjust the protocol test's client imports to match.

- [ ] **Step 5: Run the protocol test, verify it passes**

Run: `node mcp/test/test-protocol.mjs`
Expected: `mcp-protocol: 3 passed, 0 failed.`

- [ ] **Step 6: Run the whole MCP suite**

Run: `npm run mcp:test`
Expected: every file prints `N passed, 0 failed`.

- [ ] **Step 7: Confirm the engine suite still green**

Run: `npm test && npm run bench:validate`
Expected: unchanged, all green (we only added files + the Task-1 refactor).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json mcp/server.mjs mcp/test/test-protocol.mjs
git commit -m "feat(mcp): stdio server wiring — six tools + cost_interview prompt + instructions"
```

---

## Task 12: README + manual acceptance

**Files:**
- Create: `mcp/README.md`

- [ ] **Step 1: Write `mcp/README.md`**

````markdown
# cost-calc MCP server

Stateless MCP server that costs AI-agent deployments using the calculator's
canonical engine. The LLM runs the interview; every number comes from the
engine via `compute_cost` (hard-gated so it refuses until the cost-driving
inputs are present). Numbers are byte-identical to calc.ajinkya.ai.

## Install (Claude Code)
```bash
npm install
claude mcp add cost-calc -- node /ABS/PATH/TO/ai-cost-calculator-studio/mcp/server.mjs
```

## Use
Invoke the `cost_interview` prompt, or just say "help me cost an AI agent". The
agent proposes defaults, confirms the cost-drivers, computes, and returns a
`calc.ajinkya.ai/#w=…` link to open the full visual calculator.

## Tools
list_presets · load_preset · get_schema · validate_workload · compute_cost · make_share_link

## Test
```bash
npm run mcp:test
```
````

- [ ] **Step 2: Manual acceptance** (record results in the commit message)

1. `claude mcp add cost-calc -- node $(pwd)/mcp/server.mjs` in a scratch Claude Code session.
2. Run the `cost_interview` prompt; describe a deployment that omits volume → confirm the agent asks instead of inventing.
3. Provide the inputs → confirm a headline comes back + a share link.
4. Open the share link in a browser → confirm the rendered headline (`#cb-num`) equals the tool's `headline_monthly_usd` (cross-check against the live site to prove MCP ≡ site).

- [ ] **Step 3: Commit**

```bash
git add mcp/README.md
git commit -m "docs(mcp): README + manual acceptance notes"
```

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/cost-mcp
```

---

## Acceptance criteria (whole plan)
- `npm run mcp:test` — all MCP test files pass.
- `npm test` + `npm run bench:validate` — unchanged, green (engine untouched; only Task-1 refactor, parity 18/18).
- Hard gate proven: missing model / volume / token-profile → `compute_cost` returns `missing_required`, no numbers.
- `compute_cost` headline equals the engine-bridge headline for every bundled preset (test-parity), and equals the live site `#cb-num` in manual acceptance.
- The `cost_interview` prompt + instructions make the agent propose-and-confirm rather than invent.

## Notes / risks
- **SDK API drift:** pin a known-good `@modelcontextprotocol/sdk` version; adjust `registerTool`/`registerPrompt`/instructions wiring to that version (Task 11 Step 4 verify note).
- **headline pin (Task 2):** `47095` is the archetype-demo headline at current preset defaults; if defaults change, recompute the pin from the live `#w=` of that preset.
- **personnel prices key (Task 2):** confirm the exact key in `prices.js` used by `computeAgentEngineering`; AE is disabled in the test presets so the path returns 0, but get it right for AE-enabled workloads.
```
