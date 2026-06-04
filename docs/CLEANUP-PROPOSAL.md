# Cleanup proposal — calc repo layout

Audit-only. Nothing has been moved or renamed; this file lists what
looks out of place after the recent anonymization push and the public
release of the companion agent repo. Each item flags whether it's
safe to act on, has inbound link risk, or needs a decision first.

## Summary

- Root is clean (no stray screenshots / scratch markdown).
- `docs/` is small and on-topic.
- `scripts/` is mixed — `audit-*.mjs` are one-off Playwright sweeps
  that have served their purpose; `test-*.js` overlap with bench
  tests; the reproducer + validator + price refresh are the only
  scripts the README/REPRODUCING reference.
- `public/examples/` has four `public-geospatial-qa*` JSON variants
  that double the file count and aren't all loaded from the UI.
- `EIE` is still referenced in source-code comments and in user-facing
  copy. Decision needed: anonymize fully, or keep the historical
  references because the calibration provenance is real.
- `bench/reports/` accumulates one trace JSON per run; ~25 files,
  ~most are historical and not referenced from REPRODUCING.

## Root files

Keep:
- `README.md`, `REPRODUCING.md`, `CONTRIBUTING.md`, `LICENSE` — load-bearing.
- `package.json`, `package-lock.json`, `wrangler.jsonc` — required.
- `CLAUDE.local.md` — gitignored already; correct.

Look at:
- `excel-template/` — empty directory. Either fill it or remove.

## `docs/`

Keep:
- `getting-started.md`, `publishing.md`, `workload-schema.md` — reference docs.
- `paper/` — paper artefacts.

Look at:
- `CHANGELOG-simulator.md` — fine to keep, but it predates the
  bench-driven calibration pipeline and reads as a development diary
  rather than a release log. Consider trimming or rolling under
  `docs/changelogs/`.
- `eie-calibration-2026-06.md`, `eie-instrumentation-spec.md` — already
  gitignored (`.gitignore` lines 49-50). Verify they are not in git
  history; `eie-instrumentation-spec.md` was already removed in commit
  `efa3728`. Audit for residual blob references.

## `scripts/`

Referenced from the public README / REPRODUCING:
- `reproduce-v0.1.0.sh` — pinned reproducer. Keep.
- `validate-preset.py` — referenced in REPRODUCING § "Verifying a result". Keep.
- `calc.js` — referenced in REPRODUCING § Table 7. Keep.
- `refresh-prices.js` — wrangler cron; required for the price book.
- `cost_engine.py` / `three_way_diff.py` — used by validate-preset.

Not referenced, looks orphaned:
- `audit-add-delete.mjs`, `audit-controls-nonslider.mjs`,
  `audit-every-row.mjs`, `audit-nav-modal.mjs`, `audit-skip-autosync.mjs`,
  `audit-sliders.mjs`, `audit-tools-registry.mjs`, `audit-ui-drive.mjs`
  — 8 Playwright sweeps, 1,628 lines total. Authored to catch the
  "silent slider" bug class. The bug class was caught; the regressions
  these prevent are now covered by bench-validate plus the per-feature
  Playwright tests at `scripts/test-*.js`. Proposal: move to
  `scripts/archive/` (kept for forensics) or delete outright.
- `bench-validate.mjs` — referenced indirectly via `npm run bench:validate`;
  keep as-is.
- `test-apply.js`, `test-controls.js`, `test-e2e.js`, `test-engine-smoke.js`
  — overlap unclear with `bench/tests/`. Worth confirming the canonical
  test entry point. If `test-e2e.js` (696 lines) supersedes the others,
  retire the rest.
- `verify-aws-instances.js` — price-book health check. Keep but
  consider moving to `scripts/healthchecks/`.

## `public/examples/`

17 preset JSONs. Four are `public-geospatial-qa` variants:
- `public-geospatial-qa.json` — referenced in REPRODUCING § Table 4 / Table 7.
- `public-geospatial-qa-freeform.json` — referenced in REPRODUCING § Table 7.
- `public-geospatial-qa-multi-segment.json` — flagged in `public/index.html`
  options, but the README doesn't reference it. Confirm the UI loads it
  and the multi-segment behaviour is covered, or drop it.
- `public-geospatial-qa-freeform-multi-segment.json` — same question.

The four-way split (templated/freeform × single/multi-segment) is a lot
of surface area for the same scenario. Proposal: keep the two single-
segment variants as the canonical pair, fold multi-segment into a UI
toggle on the preset rather than a separate file.

## `public/` source — EIE references

`public/lib/cost-engine.js` and `public/lib/cost-simulator.js` carry
the EIE name in inline comments and in the user-facing slider docstring
text — the latter is shown to end users in the calculator UI. The
project has been anonymizing toward "public geospatial QA" as the
scenario name, but the slider help text still says e.g. "lands a
typical EIE-class workload at ~30% templated savings" and the preset
dropdown shows "EIE Cost Estimation (reproduction)" in
`public/index.html` lines 3561, 5642, 5661.

Two options. Either:

(a) Anonymize fully — replace every user-visible "EIE" with
    "public-geospatial-qa" (matching the new agent repo and the public
    paper text). One-shot search-and-replace, plus updates to:
    `public/lib/cost-engine.js`, `public/lib/cost-simulator.js`,
    `public/index.html`, `docs/paper/validation-methodology.md`,
    `docs/publishing.md`, `scripts/test-e2e.js`,
    `scripts/bench-validate.mjs`. The `eie-cost-estimation` JSON
    preset is already gone from the public dir.

(b) Keep EIE references where they're factually historical (the
    paper's validation methodology section legitimately names the
    workload it calibrated against) and only strip them from
    user-visible UI strings.

Either is defensible; pick one and apply consistently.

## `bench/`

Keep:
- `README.md`, `AUTHORING.md`, `CONTRIBUTING.md` (`../CONTRIBUTING.md`).
- `pyproject.toml`, `src/`, `tests/`, `coefficients.json`.
- `scenarios/` — the canonical YAML library.
- `data/us_county_bboxes.json` — used by the scenarios.

Look at:
- `bench/reports/` — 25 historical traces and a few markdown variance
  reports. Referenced from REPRODUCING as "reference outputs" for the
  validator, but not every file is. Proposal: split into
  `bench/reports/reference/` (the 4 files REPRODUCING points at) and
  `bench/reports/runs/` (everything else, gitignored or rolled up).
- `bench/scenarios/geo-qa-templating/` — two YAML files; not
  referenced from REPRODUCING. Confirm they're still calibrated and
  either link them in or move to `bench/scenarios/archive/`.

## Suggested next moves

If you want a single low-risk first commit:

1. Move `scripts/audit-*.mjs` to `scripts/archive/audit/` (8 files,
   no inbound links).
2. Move `bench/reports/*.json` that aren't referenced from
   REPRODUCING into `bench/reports/runs/`.
3. Decide (a) vs (b) on the EIE naming question above.

(1) and (2) are reversible and don't touch user-visible behaviour. (3)
is a content decision worth doing deliberately rather than as a
search-and-replace pass.
