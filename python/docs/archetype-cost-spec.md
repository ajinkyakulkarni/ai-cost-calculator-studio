# Archetype Cost Model — Spec

Status: **draft / branch `feat/archetype-cost`**
Scope: a Python helper (`costcalc.archetype`) that estimates LLM cost for an
agent whose queries do **not** follow a single fixed pipeline, by classifying
queries into **archetypes** and weighting them by an expected mix.

## Why this exists

The existing engine (`cost-engine.js` / `costcalc`) models a workload from one
**anchor query** scaled by per-shape factors. That is exact for a fixed-length
pipeline (the original EIE geospatial agent: parse → geocode → search → … →
viz, each stage once).

The proposed EIE direction breaks that assumption: broad multi-step queries
that fan out across federated sources, plan over a **variable** number of
turns, and produce derived insights. Cost is no longer one anchor × factors —
different query *kinds* have genuinely different absolute token profiles
(Simple ≈ 6 turns, Multi-source ≈ 8, Planning+routing ≈ 10–15).

The stakeholder doc itself proposes the right unit and method:

> "a meaningful way to estimate is on the units of a **cycle** … classify
> queries into **archetypes** and weight by expected mix."

This module implements exactly that, reusing the engine's pricing math so the
numbers stay consistent with the rest of the calculator.

## Definitions

- **cycle** — one complete resolution of a user query (may span many LLM
  turns). The costing unit. `turns ≈ tool_calls + clarifications + planning_steps`.
- **archetype** — a class of cycle with a characteristic token profile.
- **mix** — the expected share of each archetype in production traffic
  (shares should sum to ~1.0; the helper normalizes and warns if not).

### Archetype profile (absolute, not a multiplier)

```python
{
  "name": "Multi-source",
  "share": 0.30,           # fraction of cycles
  "tool_calls": 8,         # informational / for the table
  "turns": 11,             # informational / for the table
  "input_tokens": 233498,  # cumulative input across the cycle's turns
  "cached_tokens": 184917, # cumulative cached input (subset of input)
  "output_tokens": 885,    # cumulative output (incl. reasoning) across turns
  # optional uncertainty bands (multipliers on the expected profile):
  "low_factor": 0.7,
  "high_factor": 1.5
}
```

`cached_tokens` MUST be ≤ `input_tokens` (cached is a subset of fresh+cached
input). The helper raises `ValueError` on violation rather than silently
clamping — a cached>input profile is a data-entry bug.

## Cost formula (reused from the engine, not reinvented)

Per cycle, for a chosen `model` + `tier`:

```
fresh   = input_tokens - cached_tokens
cost_cycle = ( fresh        * input_per_million
             + cached_tokens * cached_per_million
             + output_tokens * output_per_million ) / 1e6 * tier_multiplier
```

- `input_per_million`, `cached_per_million`, `output_per_million` come from the
  **same price book** the engine uses (`prices.DEFAULT_RATE_CARDS[model]`).
- `tier_multiplier` from `prices.DEFAULT_TIER_MULTIPLIERS[tier]` (standard 1.0,
  flex/batch 0.5, priority 2.5) — applied exactly as `llm.py` applies it.
- This is byte-identical to the doc's formula when model=gpt-5.4, tier=standard
  (2.50 / 0.25 / 15.00).

Monthly:

```
cost_monthly = Σ_archetypes ( share_normalized * cost_cycle * cycles_per_month )
```

Bands: `low`/`high` recompute `cost_cycle` with `input/output × low_factor` (or
`high_factor`) — cached scales with input to preserve the cached ratio — then
blend the same way, giving a monthly (low, expected, high) triple.

## Acceptance fixtures (pinned)

Model **gpt-5.4**, tier **standard** (rates from the calc price book:
input 2.50, cached 0.25, output 15.00 per million).

| Archetype | input | cached | output | expected cycle $ |
|---|---|---|---|---|
| Simple | 80,000 | 70,000 | 600 | **0.0515** |
| Multi-source | 233,498 | 184,917 | 885 | **0.1810** |

Derivations (must match to ≤ $1e-6):
- Simple: (10,000·2.50 + 70,000·0.25 + 600·15)/1e6 = (25,000+17,500+9,000)/1e6 = **0.0515**
- Multi:  (48,581·2.50 + 184,917·0.25 + 885·15)/1e6 = (121,452.5+46,229.25+13,275)/1e6 = **0.18096** → 0.1810

Monthly rollup fixture — 600,000 cycles/mo, mix {Simple 0.6, Multi 0.3,
Planning 0.1} with Planning ≈ Multi × 2.2 (placeholder until measured):
- per-cycle blended ≈ **$0.1250**, monthly ≈ **$74,999** (sanity band, not pinned to the cent).

Tier check: Multi-source at tier=batch (0.5×) ⇒ cycle = **0.0905**.

## Non-goals (this iteration)

- No UI panel yet (Python helper first, per the plan).
- No intra-cycle context-growth *curve* — the profile carries the already-summed
  cumulative input/cached/output, so growth is captured in the totals the user
  enters (or that get measured). A generative growth model is a later task.
- No change to `engine.compute()` or any existing module. This is additive.

## Guardrails / regression contract

Every existing safety gate must stay green after this work:
- `python/parity_check.py` — 17/17 presets, 0 diffs.
- `python/random_parity.py --n 200` — clean.
- `python3 -m pyflakes python/costcalc/*.py python/*.py` — zero findings.
- `npm test` + `npm run bench:validate` — JS engine untouched.
- Default UI headline still reproduces: `python3 python/run.py --retry 3
  public/examples/public-geospatial-qa.json --quiet` → `$7,771.96`.

## Regression results (branch `feat/archetype-cost`, 2026-06-20)

All six gates green after the feature was added:

| Gate | Result |
|---|---|
| pyflakes (incl. new files) | clean |
| `test_archetype.py` | 15/15 passed |
| `parity_check.py` | 17/17 presets, 0 diffs |
| `random_parity.py --n 250` | 250/250 match, 0 crashes |
| `npm test` + `bench:validate` | green; 6/6 presets ±0.00% |
| UI headline reproduces | `$7,771.96` |

Touched only 2 existing files, both additively: `__init__.py` (new export) and
`package.json` (new `test:archetype-py` script). `archetype.py` imports only
`prices` — no coupling to `engine`.

### EIE worked example (`python/examples/eie-new-direction.json`)

`python3 python/archetype_run.py python/examples/eie-new-direction.json`:

| Archetype | mix | $/cycle | $/month |
|---|---|---|---|
| Simple | 60% | 0.0515 | 18,540 |
| Multi-source | 30% | 0.1810 | 32,572 |
| Planning+routing (placeholder) | 10% | 0.3981 | 23,886 |
| **Blended** | 100% | **0.1250** | **74,999** |
| range / month | | | 55,222 – 112,699 |

Simple/Multi-source cycle costs match the stakeholder doc to the cent.

## Round 2 — Planning derivation + JS port + UI (2026-06-20)

**Planning+routing** is no longer a flat 2.2× placeholder. `derive_planning
_profile.py` applies the doc's own turn-by-turn accumulation method to the Q2
shade-routing workflow (~13 turns), and self-validates by first reproducing the
doc's published Multi-source totals (233,498 / 885 / 184,917) before extending.
Result: input 360,938 / cached 285,842 / output 3,115 — **~1.55×** Multi-source,
not 2.2×. Still an ESTIMATE (clearly labeled), pending real telemetry.

EIE blended with the derived Planning: **$0.1158/cycle → $69,468/mo**
(range $51,903–$102,743).

**JS port** (`public/lib/archetype-math.js`) mirrors the Python helper;
`scripts/test-archetype-math.mjs` asserts the same fixtures and is wired into
`npm test`. Python and JS agree to the cent.

**UI** (`public/archetype.html`) — self-contained editable archetype table with
live per-archetype + blended cost, low/high bands, model/tier/cycles controls,
preloaded with the EIE set (Planning flagged "derived, not measured"). Reuses
the calc price book via `window.Prices`. Linked from the calc appbar (🧩 icon)
+ footer. Does not touch index.html/app.js logic.

Regression (all green): npm test (incl. archetype-math) + bench ±0.00%;
Python engine parity 17/17; random_parity 200/200; pyflakes clean; Python &
JS archetype tests agree; UI headline still $7,771.96; archetype.html
Playwright smoke (live edits recompute, tier switch halves cost).
