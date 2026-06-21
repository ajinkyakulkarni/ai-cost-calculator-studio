# Spec: archetype mode in the SIMULATOR agent cards

Status: **to build / branch `feat/archetype-cost`**
Audience: a fresh-context engineer/agent. Read this top to bottom before editing.

## Background (what already exists — do NOT rebuild)

The "archetype cost" feature lets an agent describe its per-query LLM cost as a
**mix of query archetypes** (each with its own cumulative input/cached/output
tokens), instead of a single fixed token profile. The engine already supports
this and is parity-locked — **do not touch the engine math**:

- `public/lib/cost-engine.js` → `perQueryCostAgents()`: when an agent has
  `archetype_mode === true` and a non-empty `archetypes[]`, its per-query LLM
  cost = Σ (share_normalized × cycleCost(archetype @ agent model + workload
  tier)), honoring `activation_rate`. No `archetype_mode` → original behavior.
- `python/costcalc/agents.py` → `per_query_cost_agents()`: identical, parity-tested.
- Parity gate: `node scripts/dump-engine.mjs && python3 python/parity_check.py`
  → **18/18**. `public/examples/archetype-agent-demo.json` exercises the path.
- Math/growth libs (browser globals, already loaded in index.html):
  - `ArchetypeMath.archetypeCost(...)` — pricing (not needed for the editor).
  - `ArchetypeGrowth.cycleUniform(base, turns, addedPerTurn, outputPerTurn, cacheRatio)`
    → `{input_tokens, cached_tokens, output_tokens, turns}` — used by the ⚙
    "from turns" builder. `ArchetypeGrowth.DOC_CACHE_RATIO` ≈ 0.792.

A **reference in-card editor** already exists but in the WRONG (hidden) place —
`renderAgentArchetypes()` + `openAgentTurnsEditor()` in `public/app.js` (they
render into `#sec-agents`, the "Multi-agent pipeline" section, which is hidden
in the live UI). **Reuse their logic/markup as the template** for the simulator
editor. You may leave them in place (harmless) — do not spend effort removing.

## The problem this task fixes

The PROMINENT "Agent fleet" the user sees is the **simulator** (Section C),
rendered from `sim.agents` in `public/lib/cost-simulator.js`. Its agent model
has no concept of archetypes, and its `sim.agents → workload.agents` mirror
drops them. So the archetype toggle must live in the **simulator agent card**,
and archetype fields must survive the simulator's persistence + mirror.

## Key files & integration points (verified line refs, 2026-06-21)

`public/lib/cost-simulator.js`:
- `AGENT_CONFIG_FIELDS` (line ~1154): array of per-agent fields that
  `snapshotAgentConfig()` (~1156) persists and `cloneAgentBase`/rebuild (~1163)
  restore. **Add `'archetype_mode'` and `'archetypes'` here** so they survive
  agent rebuilds and snapshots.
- `agentCardHtml(a, scope)` (line ~1530): builds one agent card's HTML. The
  config panel id is `cfg-${scope}-${a.id}` (~1586). Body sections are assembled
  as `toolsBody`, `ragBody`, `reasonBody`, `guardBody` (strings) via helpers like
  `agentRangeCtl(...)`. **Add an archetype section** here: a toggle bound to
  `a.archetype_mode` + (when on) an editable archetype table + ⚙ from-turns.
- `renderAgents()` (~1743) / `refreshAfterAgentEdit()` (~1748): re-render +
  recompute. After rendering cards, wire up the archetype editor handlers (or
  use inline `onclick`/`oninput` like other sim controls — the file leans on
  inline handlers calling global functions; follow that convention).
- `_mirrorAgentEditToWorkload(simAgentId, k, v)` (~1864): pushes a single field
  edit to `workload.agents`. Ensure archetype edits propagate (either via this
  or via the full promote path below).
- `_syncAgentsToWorkload()` (~1779) calls `window.__promoteAgentModeFromSimulator()`.

`public/app.js`:
- `window.__importFromSimulator(payload)` (line ~6537): rebuilds
  `workload.agents` from the sim payload. **Already preserves** `archetype_mode`
  /`archetypes` by id→label→index (a prior fix) — but the cleaner path is for the
  sim PAYLOAD to carry them directly. Find what builds that payload (the
  `__promoteAgentModeFromSimulator` / `buildPayload` chain — grep both files) and
  make it include `archetype_mode` + `archetypes` from `sim.agents`. Keep the
  app.js id→label→index preservation as a belt-and-braces fallback.

## What to build

1. **sim.agents carries archetype fields.** Add `archetype_mode`, `archetypes`
   to `AGENT_CONFIG_FIELDS`. Confirm `snapshotAgentConfig()` then includes them
   and rebuilds restore them.

2. **Toggle + editor in `agentCardHtml`.** In each agent's config panel, add a
   purple "Cost via query archetypes (mix)" section mirroring the app.js
   reference:
   - a checkbox bound to `a.archetype_mode` (toggling re-renders the card).
   - when ON: a compact editable table — columns Name / Mix% / Input / Cached /
     Output — over `a.archetypes` (seed one default row if empty:
     `{name:'Default', share:1, input_tokens:80000, cached_tokens:70000,
     output_tokens:600}`), a "+ archetype" button, per-row remove (×), and a
     per-row ⚙ that opens a "from turns" mini-editor (base / turns / added-per-
     turn / output-per-turn / cache-ratio → live preview via
     `ArchetypeGrowth.cycleUniform` → Apply writes input/cached/output back).
   - a one-line note: "Token/RAG/tools sliders are ignored while this is on —
     cost comes from the archetype mix."
   - Every edit must mutate `sim.agents[i]` AND trigger the cost recompute +
     the sim→workload mirror so the **headline updates live**.

3. **Mirror carries archetypes.** Make the promote/buildPayload path include
   `archetype_mode` + `archetypes` so `workload.agents` (what the engine reads)
   has them directly — not only via app.js's id/label fallback.

4. **Optional polish:** when archetype mode is ON, visually de-emphasize (grey
   or hide) the now-ignored token/tools/RAG sub-sections in that card. Nice-to-
   have, not required for correctness.

## Acceptance criteria (Playwright-verifiable, on the LOCAL server :8765)

Run a local server from `public/` (`python3 -m http.server 8765`). Use a
cache-bust query param. Then:

1. **Toggle visible in the simulator card.** Boot the calc, open the simulator
   "Agent fleet" Section C agent card (expand it). The "Cost via query
   archetypes (mix)" toggle is present and clickable. (This is the location the
   in-card editor was missing from — the whole point.)
2. **Toggling on shows the editor** with a seeded archetype row + ⚙ + add/remove.
3. **Editing drives the headline.** With archetype mode on, change a Mix% or a
   token cell → the top cost pill (`#cb-num`) recomputes. (Tip: the default daily
   cap clamps high volume — drop MAU/`s-users` to ~300 so changes move the
   number visibly.)
4. **⚙ from-turns** computes via ArchetypeGrowth and Apply writes the row +
   recomputes.
5. **Survives a re-sync.** After enabling archetype mode and editing, change a
   traffic slider (e.g. `s-users`) → `archetype_mode` + `archetypes` survive on
   `workload.agents[i]` (they are NOT clobbered) and the headline stays
   archetype-driven.
6. **Round-trips.** Share-link (copy the `#w=` hash) → reload → archetype mode +
   archetypes restored.

## Regression contract — ALL must stay green

- `npm test` (8 suites incl. archetype-math + archetype-growth) — pass.
- `npm run bench:validate` — 6/6 within ±5% (engine untouched).
- `node scripts/dump-engine.mjs && python3 python/parity_check.py` — **18/18**,
  0 diffs (engine math must not change).
- `python3 -m pyflakes python/costcalc/*.py` — clean (you likely won't touch
  Python at all; if you do, keep it clean).
- The 17 non-archetype presets must render byte-identical headlines (no
  `archetype_mode` on their agents → engine path unchanged).

## Constraints

- Edit `public/lib/cost-simulator.js` and `public/app.js` (mirror) + bump the
  relevant `?v=` cache-busts in `public/index.html` (both files had stale-cache
  issues before — cost-engine.js and app.js now carry `?v=`; do the same for any
  changed lib).
- Do NOT change engine math (cost-engine.js perQueryCostAgents formula,
  costcalc). Only the simulator UI + the sim→workload data plumbing.
- Follow the file's existing conventions (inline handlers → global functions,
  `agentRangeCtl`-style helpers, the `cfg-${scope}-${a.id}` panel pattern).
  `scope` can be more than one value — make ids unique per scope+agent so two
  rendered scopes don't collide.
- Commit style: imperative subject + body explaining the plumbing; NO
  Co-Authored-By trailer. Commit to `feat/archetype-cost`, do NOT push, do NOT
  deploy. Branch only.

## Report back (≤400 words)

Files touched + line counts; how the toggle/editor was wired (handler
convention); how archetype fields now flow sim.agents → workload.agents; the
6 acceptance checks with PASS/FAIL + the headline numbers you observed; and the
regression results (npm test / bench / parity 18/18 / pyflakes). If any
acceptance check can't pass, say so plainly with the blocker — do not claim done.
