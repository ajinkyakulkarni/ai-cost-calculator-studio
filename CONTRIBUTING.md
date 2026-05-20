# Contributing

This project gets more useful as more people add their own workloads and
measurements. There are two ways to contribute, and they produce two
different artifacts:

| Mode | You contribute | It becomes | Who benefits |
|---|---|---|---|
| **A — Calibration** | a bench scenario + its trace | a measured coefficient in `coefficients.json` | every calculator user — the simulator's defaults get more accurate |
| **B — Example workload** | a workload JSON | a preset others can load on calc.ajinkya.ai | anyone modeling a similar deployment |

You can do either on its own. The strongest contribution does both: an
example workload **paired with** a bench trace that proves its numbers.

Before anything else: **never commit an API key or any secret.** Keys live
in `bench/.env` (gitignored). Nothing you submit should contain one.

---

## Mode A — contribute a calibration measurement

Goal: replace a guessed coefficient (cache hit rate, I/O ratio, handoff
overhead, retry rate, tool-token cost) with a measured one.

You do **not** have to use our harness. If you measured a coefficient your
own way, you can still contribute it — see *Custom measurements* below. The
harness path is just the easiest one to review.

### With `agent-cost-bench`

1. **Author a scenario** that exercises the topology you care about. See
   [`bench/AUTHORING.md`](bench/AUTHORING.md) for the YAML schema. Start by
   copying `bench/scenarios/smoke-test.yml`.
2. **Smoke it first** — run once with `repeat: 1` to confirm the plumbing
   and the cost estimate before spending real money.
3. **Run it for real:**
   ```bash
   cd bench
   agent-cost-bench run scenarios/<your-scenario>.yml --yes
   ```
   This writes a trace JSON and a summary Markdown into `bench/reports/`.
4. **(Optional) Compare** against the simulator's prediction:
   ```bash
   agent-cost-bench compare reports/<your-scenario>-...-trace.json \
       --scenario scenarios/<your-scenario>.yml
   ```
5. **Open a PR** that includes: the scenario YAML, the trace JSON, and the
   summary/variance Markdown. In the PR description, state the model
   version, the sample size (`repeat` × turns), and the coefficient(s) the
   run measures.

### Custom measurements

If you measured a coefficient against a real provider API without our
harness, that is welcome too. Attach evidence a reviewer can spot-check:

- the **provider `request_id` / `response.id`** for at least a few calls,
- the raw **usage numbers** (input / output / cached tokens) those calls
  returned,
- the **model version** and date,
- how you computed the coefficient from the raw numbers.

A coefficient with no traceable evidence cannot be merged into
`coefficients.json` — it would just be another guess.

---

## Mode B — contribute an example workload

Goal: a new preset in the **Load example…** menu on calc.ajinkya.ai.

1. **Start from a real one.** Copy an existing file in `public/examples/`
   (e.g. `public-geospatial-qa.json`), or open the live calculator,
   configure your deployment, and use **Export JSON**.
2. **Edit the fields.** Every field is documented in
   [`docs/workload-schema.md`](docs/workload-schema.md). Anything you omit
   gets a sane default from the engine's `normalizeWorkload`.
3. **Anonymize.** Examples ship publicly. Don't include a real agency's
   confidential traffic numbers or internal system names — the bundled
   examples are all anonymized; match that bar.
4. **Validate it** (see the gate below).
5. **Register the slug.** Drop the file at `public/examples/<slug>.json`,
   then add an `<option value="<slug>">` to every example-loader `<select>`
   in `public/index.html`. To find them, grep for an existing slug:
   ```bash
   grep -n 'public-geospatial-qa' public/index.html
   ```
6. **Open a PR.**

If your example carries numbers you *measured* (not estimated), pair it
with a Mode-A trace and fill in the `anchor_query._calibration` block —
that is what lets the example claim "validated against a real API."

---

## The verification gate

A contribution is mergeable when it clears these checks. They are the same
checks a maintainer runs on the PR.

**Every contribution**

- [ ] No API keys or secrets in any committed file.
- [ ] Every dollar figure either cites a `source_url` or is plainly
      labelled an estimate. No uncited numbers.

**Mode A — calibration**

- [ ] Trace artifact is included and carries provider `request_id`s.
- [ ] Model version and date are pinned in the scenario (or stated, for a
      custom measurement).
- [ ] `max_cost_usd` is set in the scenario YAML.
- [ ] Sample size is stated. One run of one turn is a smoke test, not a
      calibration — say what you actually measured.

**Mode B — example workload**

- [ ] `npm test` passes (engine smoke suite — finite cost, headline
      reconciliation, MAU linearity, etc.).
- [ ] The headline is finite and non-zero:
      ```bash
      node scripts/calc.js --preset <slug> --json | jq .headline.monthly
      ```
- [ ] If the example claims measured numbers, it ships with a trace and a
      passing `validate-preset.py` run:
      ```bash
      python scripts/validate-preset.py \
          --preset public/examples/<slug>.json \
          --trace bench/reports/<your-trace>.json
      ```
      `validate-preset.py` puts the calculator's predicted per-query cost
      next to the bench's measured cost and flags any layer off by more
      than ±15%. A clean report is the proof that the example is real and
      not just plausible-looking.

---

## PR checklist

Copy this into your pull-request description:

```
Contribution mode: [ ] A — calibration   [ ] B — example workload

- [ ] No secrets committed
- [ ] Dollar figures are sourced or labelled estimates
- [ ] (Mode A) trace artifact included, with provider request_ids
- [ ] (Mode A) model version + sample size stated
- [ ] (Mode B) `npm test` passes
- [ ] (Mode B) `calc.js --preset <slug>` yields a finite headline
- [ ] (Mode B) slug registered in public/index.html
- [ ] (Mode B, if "measured") validate-preset.py report attached
```

## Ground rules

- The project is MIT-licensed; contributions are accepted under the same
  licence.
- Keep the methodology honest: the value of this tool is that every number
  is either measured or labelled as an estimate. A contribution that blurs
  that line works against the whole point.
- Small, reviewable PRs beat large ones. One scenario or one example per
  PR is ideal.
