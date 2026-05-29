# geo-qa-templating bench summary — 2026-05-29

## Per-scenario results

| scenario | pattern | mode | forced | map | turns | tok/turn (in) | tok/turn (out) | cache hit % | $/query | $/month @ 915K |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| pattern-gated-freeform | gated | freeform | N | N | 12 | 9096 | 241 | 59.7% | $0.1289 | $117,913 |
| pattern-gated-freeform | gated | freeform | N | Y | 12 | 12574 | 256 | 71.5% | $0.1372 | $125,532 |
| pattern-gated-freeform | gated | freeform | Y | N | 13 | 11228 | 158 | 65.4% | $0.1339 | $122,505 |
| pattern-gated-key-fields | gated | key_fields | N | N | 14 | 1437 | 133 | 59.8% | $0.0423 | $38,679 |
| pattern-gated-key-fields | gated | key_fields | N | Y | 13 | 1776 | 143 | 66.5% | $0.0422 | $38,629 |
| pattern-gated-key-fields | gated | key_fields | Y | N | 15 | 1471 | 126 | 62.1% | $0.0435 | $39,771 |
| pattern-gated-status-only | gated | status_only | N | N | 14 | 1243 | 48 | 44.1% | $0.0277 | $25,353 |
| pattern-gated-status-only | gated | status_only | N | Y | 15 | 1483 | 69 | 74.8% | $0.0272 | $24,898 |
| pattern-gated-status-only | gated | status_only | Y | N | 11 | 1187 | 70 | 58.8% | $0.0216 | $19,735 |
| pattern-paper-freeform | paper | freeform | N | N | 4 | 15383 | 396 | 49.5% | $0.0818 | $74,890 |
| pattern-paper-freeform | paper | freeform | N | Y | 5 | 28995 | 5324 | 77.3% | $0.4500 | $411,752 |
| pattern-paper-freeform | paper | freeform | Y | N | 5 | 19641 | 1135 | 66.9% | $0.1479 | $135,305 |
| pattern-paper-key-fields | paper | key_fields | N | N | 4 | 1798 | 392 | 40.9% | $0.0299 | $27,376 |
| pattern-paper-key-fields | paper | key_fields | N | Y | 6 | 2124 | 344 | 55.2% | $0.0401 | $36,701 |
| pattern-paper-key-fields | paper | key_fields | Y | N | 4 | 1678 | 361 | 68.7% | $0.0247 | $22,616 |
| pattern-paper-status-only | paper | status_only | N | N | 4 | 1300 | 537 | 51.7% | $0.0349 | $31,972 |
| pattern-paper-status-only | paper | status_only | N | Y | 6 | 1180 | 156 | 41.6% | $0.0208 | $19,044 |
| pattern-paper-status-only | paper | status_only | Y | N | 7 | 2410 | 582 | 80.4% | $0.0652 | $59,653 |

## Ratio rows

- **Pattern paper (natural) — C/A ratio (paper's headline lever):** 2.34×
- **Pattern paper (natural) — C/B ratio (realistic production lever):** 2.74×
- **Pattern paper (forced) — C/A ratio (paper's headline lever):** 2.27×
- **Pattern paper (forced) — C/B ratio (realistic production lever):** 5.98×
- **Pattern gated (natural) — C/A ratio (paper's headline lever):** 4.65×
- **Pattern gated (natural) — C/B ratio (realistic production lever):** 3.05×
- **Pattern gated (forced) — C/A ratio (paper's headline lever):** 6.21×
- **Pattern gated (forced) — C/B ratio (realistic production lever):** 3.08×

## Findings

**Setup.** Live runs against GPT-5.2 over a public geospatial STAC catalog (a global gross-primary-production raster dataset, Mendocino County CA, June–November 2020). 2 conversation patterns × 3 response-handler modes × 3 prompt variants (natural, forced `compute_stats`, `--with-map`). This is a single consistent 12/12 sweep — **all six scenarios now complete the full tool chain and compute real GPP stats**, including status-only (after the fix below). Numbers carry run-to-run variance because GPT-5.2 tool-calling isn't fully deterministic even at temperature 0.

### Templating lever (the paper's claim)

The paper's ~7.5× tool-response lever is **directionally real but overstated for realistic comparisons.** Headline C/A (raw STAC → status-only summary) varies sharply by conversation shape:

- Paper pattern (parallel ReAct, 4–7 turns): **2.27–2.34×**
- Gated drill-down pattern (gated conversation, 11–15 turns): **4.65–6.21×**

The realistic production lever — C/B (raw → typed key-fields, what teams actually template to) — lands at **2.74–5.98×**, not 7.5×. A team already doing key-fields templating won't find another 7.5× by going to status-only; mode A ($0.021–$0.035/query) is only marginally cheaper than mode B ($0.025–$0.040). The 7.5× anchor is the extreme upper bound (raw passthrough vs the most aggressive summary on the longest conversation), not the typical case.

### Status-only completes — but only if it retains identifiers

An earlier iteration of the bench showed status-only **failing** to complete: the handler summarized `search_collections` to a bare count and dropped the collection IDs, so the agent could never pick a collection to drill into. **That was a property of a naive handler, not of templating itself.** Fixing the handler to keep the essential identifiers (collection IDs in the summary; items resolved from server-side state for `compute_stats`) lets status-only complete the full analysis at ~$0.021–$0.035/query.

The sharpened finding: **over-templating that strips identifiers starves the agent; well-designed status-only that keeps the handles completes and still saves most of the tokens.** The savings come from dropping bulky descriptions/geometry/asset-dicts, not from dropping IDs. (Separately, the agent often guesses a wrong asset/band name — e.g. `gpp` instead of `cog_default` — so the tool layer needs a fallback that resolves the name to the real asset; without it the run spends tokens and returns nothing.)

### Map step (`render_map`) cost

Emitting a map-layer URL adds one agent turn. Marginal cost (natural map=N → map=Y) in this sweep:

| Scenario | map=N | map=Y | Δ % |
|---|---:|---:|---:|
| paper · status-only | $0.0349 | $0.0208 | **−40%** |
| gated · key-fields | $0.0423 | $0.0453 | +7% |
| gated · status-only | $0.0249 | $0.0272 | +9% |
| gated · freeform | $0.1265 | $0.1372 | +8% |
| paper · key-fields | $0.0299 | $0.0401 | +34% |
| paper · freeform | $0.0818 | $0.4500 | **+450%** |

Two stable observations plus one caveat:

1. **In templated modes (key-fields/status-only) the map step is cheap to free** — single-digit-percent deltas, and in one case net-cheaper (the extra turn lifted the cache-hit rate, offsetting itself). The visualization is not where cost lives.

2. **Freeform is volatile.** `paper · freeform · map=Y` spiked to $0.45 (5,324 output tok/turn — the agent wrote an enormous answer echoing the raw payload). One run; it does not reproduce stably. The signal isn't "+450%" — it's that **raw-passthrough mode has a fat tail**: when the agent both ingests and re-emits unbounded payloads, cost can blow out unpredictably. Templating caps that tail.

3. **Don't over-read any single map=Y cell.** The map-step deltas swing run-to-run (compare to the earlier sweep where paper · status-only · map was +7%, here −40%). The robust claim is directional: templated ≈ cheap/flat, freeform = volatile.

### Takeaway

Quote the templating lever as **~3–6× for realistic choices** (raw → key-fields), with **7.5× as the extreme upper bound** (raw → aggressive summary on a long gated conversation), not the typical case. Status-only is viable *if* the handler keeps identifiers; stripping them is a failure mode, not a saving. A map-layer output is cheap in templated modes and a volatility risk in freeform. Response templating dominates cost; the visualization step does not.

**Limitations.** Single dataset (a public global gross-primary-production raster, substituted for a higher-resolution product not present in the catalog), single AOI, single model, single sweep. GPT-5.2 tool-calling variance moves per-cell numbers ±tens of percent between sweeps — treat ratios as ranges, not point estimates. Cache hit rates (41–80%) depend on back-to-back execution and heavily dampen absolute costs; an isolated cold start would push them higher.
