# Getting started

A 5-minute walkthrough of the AI Cost Calculator.

## What it is

A clean, free, no-signup web tool for modeling the cost of an AI agent
deployment. Pick a preset (public geospatial Q&A, NIH ClinicalTrials, DOE grid, NOAA
storm, generic startup chatbot) or fill in your own parameters. The
calculator shows API vs self-host comparison with a same-budget fair-
comparison row that resolves the apples-to-oranges trap pervasive in
existing analyses.

## Quick start

1. Open `studio/index.html` in a browser (or visit the hosted version).
2. Pick a preset from the **Load preset** dropdown, or edit the form
   fields directly.
3. The right pane updates live with cost numbers and the API-vs-self-
   host comparison.
4. Click **Copy link** to share a URL that encodes the full
   configuration in the hash. Anyone opening that URL sees the same
   scenario.
5. Click **⬇ Excel** to download a .xlsx workbook with the full cost
   breakdown.
6. Click **⬆ Import JSON** / **⬇ Export JSON** to round-trip via JSON
   files.

## How sharing works

The URL hash is a base64-encoded JSON of the current workload spec.
When you click **Copy link**, your current configuration is encoded in
the URL and copied to your clipboard. Anyone clicking that link sees
the exact same configuration — no server, no database, no signup.

Example: a 50K-MAU public-geospatial-qa stress test scenario gets a URL like:

```
https://your-host.com/calc#w=eyJzY2hlbWFWZXJzaW9uIjoiMS4wIiwiZGVwbG95...
```

Send that URL to a procurement officer or in an email; they'll see
exactly the same numbers you saw.

## Hosting your own copy

The calculator is a static web app — three files plus a CDN dependency
for Excel export. To host:

```bash
# Copy everything into your web root:
cp -R cost-calculator-studio/studio/   /var/www/calc/
cp -R cost-calculator-studio/lib/      /var/www/calc/lib/
cp -R cost-calculator-studio/examples/ /var/www/calc/examples/

# Or with a dedicated subdomain (e.g., ajinkya.ai/ai-cost-calculator):
# point your web server at the cost-calculator-studio/ root and the
# studio is at /studio/index.html, libs at /lib/, examples at /examples/.
```

For the very simplest case — single-file deployment — flatten the file
structure:

```bash
# Inline the engine + create a single self-contained HTML file:
node cost-calculator-studio/lib/build-single-file.js > calc.html
# Drop calc.html anywhere; it has no external dependencies except the
# SheetJS CDN (which can also be inlined if you need fully offline use).
```

(`build-single-file.js` is a planned utility. For now, the multi-file
deployment is the supported path.)

## Methodology

The calculator implements the cost model documented in the companion
paper *Cost Modeling for Federal AI-Agent Deployment*. Six dimensions
are modeled:

1. Shape-aware per-query cost (traffic-mix blending across query
   shapes)
2. Segment-aware effective cache (different user populations with
   different session lengths)
3. Daily spend cap and refusal accounting (the dollar effect AND the
   service-level effect)
4. Verification pipeline (FactReasoner-style probabilistic factuality
   check)
5. Self-host capacity scaling with optimistic/realistic cost mode
6. Same-budget fair comparison row

See `docs/methodology.md` for the math.

## Workload specification

The single source of truth is a JSON file conforming to
`schema/workload-v1.schema.json`. Five example workloads ship with the
toolkit:

- `public-geospatial-qa.json` — Public-facing geospatial Q&A (example)
- `nih-clinical-trials.json` — NIH ClinicalTrials.gov-style agent
- `doe-grid-modeling.json` — DOE grid-operator assistant (internal)
- `noaa-storm-tracking.json` — NOAA storm-tracking explainer (extreme
  burst)
- `generic-startup-chatbot.json` — Generic startup customer-support bot

Copy any of these as a starting point, edit for your program, paste
into the calculator's **Import JSON** button.

## What to do next

- Read `docs/paper/validation-methodology.md` for the cost-model math
- Read `docs/publishing.md` for deployment options (S3, Cloudflare
  Pages, GitHub Pages, custom domain)
- Read `docs/workload-schema.md` for the full spec of every field
- Read `CONTRIBUTING.md` to add your own example workload or a measured
  coefficient so other people can use it too

## Citing

```bibtex
@misc{kulkarni2026cost,
  author = {Kulkarni, Ajinkya and Parajuli, Paridhi},
  title  = {Cost Modeling for Public-Facing {LLM} Chat Applications:
            An Equal-Budget, Refusal-Aware Comparison of Commercial
            {APIs} and Self-Hosted {GPU} Fleets},
  year   = {2026},
  url    = {https://github.com/ajinkyakulkarni/ai-cost-calculator-studio}
}
```
