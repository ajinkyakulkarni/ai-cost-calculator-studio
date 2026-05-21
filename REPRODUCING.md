# Reproducing the paper

This repo is the artifact for *Cost Modeling for Public-Facing LLM Chat
Applications: An Equal-Budget, Refusal-Aware Comparison of Commercial APIs
and Self-Hosted GPU Fleets* (Kulkarni & Parajuli, 2026).

This file maps each numerical table in the paper to the command that
regenerates it.

## Pin the version first

The paper's dollar figures are a dated snapshot. Provider rate cards in
`public/lib/prices.js` get refreshed over time, so `main` will drift from
the published numbers. To reproduce the paper **exactly**, check out the
release it was written against:

```bash
git checkout v0.3.0
```

| Pin | Value |
|---|---|
| Release tag | `v0.3.0` |
| Git commit | `3b402d513b7b35d61b9e87570592b53dc423fff2` |
| Harness version | `agent-cost-bench` 0.2.0 |
| `public/coefficients.json` sha256 | `f4703c6278fab2cc69f6c6aeca25a3f06225044a0c296ded408f041b51c26a96` |
| Rate-card date | 2026-05-11 (GPT-5.2, Sonnet-4-5 prices captured) |

On `main` you will get numbers priced at the *current* rate card instead —
useful, but not the paper's figures. That is expected and is exactly why
the paper calls dollar figures "timestamps, not constants."

## What needs API keys

| Reproduction | Cost | Needs |
|---|---|---|
| Calibration tables (2, 3, 4) | real API spend, ~$0.30–$3 per scenario | OpenAI + Anthropic keys |
| Worked example / stress test (Table 7) | free | nothing — pure calculation |

Set keys for the calibration runs (see [`bench/README.md`](bench/README.md)):

```bash
cd bench
cp .env.example .env   # then paste your keys
```

---

## Table 2 — cache hit rate by provider and topology

The pilot rows come from the v0.1.0 calibration; the production re-cal row
comes from the templated geospatial scenario.

```bash
# Pilot (9 scenarios, 174 calls)
./scripts/reproduce-v0.1.0.sh

# Production-shape re-calibration (N=20, 238 calls)
cd bench && agent-cost-bench run scenarios/public-geospatial-react.yml --yes
```

## Table 3 — input/output ratio by topology

Covered by the same pilot run. The relevant scenarios are `long-chat`
(chat), `multi-stage-research` (sequential), `tool-chain`,
`data-discovery`, and `data-discovery-gpt52`.

```bash
./scripts/reproduce-v0.1.0.sh
```

## Table 4 — tool-response architecture cost lever

The paired templated/freeform measurement.

```bash
cd bench
# Templated floor — N=20, 238 calls, $0.00178/q
agent-cost-bench run scenarios/public-geospatial-react.yml --yes
# Freeform anchor — N=5, 60 calls, $0.01392/q
agent-cost-bench run scenarios/public-geospatial-react-freeform.yml --yes
```

The Anthropic cache-write share `w ≈ 0.20` (§5) is a third run:

```bash
agent-cost-bench run scenarios/cached-pipeline-anthropic.yml --yes
```

## Table 7 — public-scale stress test

No API calls — this is the calculator's own arithmetic. The worked-example
config is `public/examples/public-geospatial-qa.json`.

Table 7 has two API architectures. **Both** run on the same preset at
75,000 anonymous MAU with the mixed traffic mix; they differ *only* in the
anchor-query token shape:

| Row       | anchor input            | cache rate         | anchor output |
|---        |---:                     |---:                |---:           |
| Templated | 3,342 (preset default)  | 0.88 (preset def.) | **41**        |
| Freeform  | 22,798                  | 0.744              | **41**        |

**Templated rows** — load the **Public geospatial Q&A** example on the live
site, set the anonymous segment to 75,000 MAU, mixed traffic mix. From the
CLI:

```bash
node scripts/calc.js --preset public-geospatial-qa --json | jq .headline
```

**Freeform rows** — same preset and 75,000 MAU, but change the anchor query
to the freeform measurement: input **22,798** tokens, cache rate **0.744**.
**Leave the anchor output at 41 tokens.** Freeform balloons the *tool-return
input* the LLM ingests, not the user-facing answer, so the output count is
unchanged from templated. (The "≈850 output tokens" figure in §5 of the
paper belongs to the separate ~84K-input structural-ceiling trace — a
different, heavier shape. Do **not** use 850 for the freeform anchor; doing
so overstates the freeform cost by ~1.6×.) Build that workload in the live
calculator, click **Copy link**, and feed the hash back in:

```bash
node scripts/calc.js --url-hash "$(cat /tmp/share-hash)" --verbose
```

`calc.js` runs the same arithmetic as `calc.ajinkya.ai`. The blended
per-query rates this produces are **$0.00120/query templated** and
**$0.00897/query freeform**; at the 6,765,000-query monthly volume they
give the $8,095 and $60,667 uncapped rows of Table 7.

## Tables 1, 5, 6

Classification and evidence-boundary tables — no numerical cells to
reproduce.

---

## Verifying a result

To check that the calculator's prediction matches a real API run for the
same workload, use `validate-preset.py` — it diffs the two per-query costs
layer by layer and flags anything off by more than ±15%:

```bash
python scripts/validate-preset.py \
    --preset public/examples/public-geospatial-qa.json \
    --trace bench/reports/<trace-from-a-run-above>.json
```

The committed reports in `bench/reports/` are the reference outputs.
