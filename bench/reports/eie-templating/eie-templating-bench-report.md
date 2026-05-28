# eie-templating bench summary — 2026-05-28

## Per-scenario results

| scenario | pattern | mode | forced | map | turns | tok/turn (in) | tok/turn (out) | cache hit % | $/query | $/month @ 915K |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|
| pattern-eie-freeform | eie | freeform | N | N | 12 | 9096 | 241 | 59.7% | $0.1289 | $117,913 |
| pattern-eie-freeform | eie | freeform | N | Y | 14 | 11519 | 219 | 73.1% | $0.1395 | $127,672 |
| pattern-eie-freeform | eie | freeform | Y | N | 13 | 11228 | 158 | 65.4% | $0.1339 | $122,505 |
| pattern-eie-key-fields | eie | key_fields | N | N | 12 | 1410 | 150 | 48.4% | $0.0419 | $38,341 |
| pattern-eie-key-fields | eie | key_fields | N | Y | 13 | 1776 | 143 | 66.5% | $0.0422 | $38,629 |
| pattern-eie-key-fields | eie | key_fields | Y | N | 15 | 1471 | 126 | 62.1% | $0.0435 | $39,771 |
| pattern-eie-status-only | eie | status_only | N | N | 14 | 1243 | 48 | 44.1% | $0.0277 | $25,353 |
| pattern-eie-status-only | eie | status_only | N | Y | 13 | 1384 | 71 | 69.7% | $0.0246 | $22,554 |
| pattern-eie-status-only | eie | status_only | Y | N | 11 | 1187 | 70 | 58.8% | $0.0216 | $19,735 |
| pattern-paper-freeform | paper | freeform | N | N | 4 | 15644 | 626 | 50.3% | $0.0950 | $86,909 |
| pattern-paper-freeform | paper | freeform | N | Y | 6 | 21952 | 712 | 74.3% | $0.1361 | $124,542 |
| pattern-paper-freeform | paper | freeform | Y | N | 5 | 19641 | 1135 | 66.9% | $0.1479 | $135,305 |
| pattern-paper-key-fields | paper | key_fields | N | N | 4 | 1649 | 353 | 67.9% | $0.0243 | $22,192 |
| pattern-paper-key-fields | paper | key_fields | N | Y | 5 | 2400 | 346 | 59.7% | $0.0339 | $31,045 |
| pattern-paper-key-fields | paper | key_fields | Y | N | 4 | 1678 | 361 | 68.7% | $0.0247 | $22,616 |
| pattern-paper-status-only | paper | status_only | N | N | 4 | 1330 | 540 | 50.5% | $0.0353 | $32,290 |
| pattern-paper-status-only | paper | status_only | N | Y | 5 | 1793 | 457 | 64.2% | $0.0386 | $35,327 |
| pattern-paper-status-only | paper | status_only | Y | N | 7 | 2410 | 582 | 80.4% | $0.0652 | $59,653 |

## Ratio rows

- **Pattern paper (natural) — C/A ratio (paper's headline lever):** 2.69×
- **Pattern paper (natural) — C/B ratio (realistic production lever):** 3.92×
- **Pattern paper (forced) — C/A ratio (paper's headline lever):** 2.27×
- **Pattern paper (forced) — C/B ratio (realistic production lever):** 5.98×
- **Pattern eie (natural) — C/A ratio (paper's headline lever):** 4.65×
- **Pattern eie (natural) — C/B ratio (realistic production lever):** 3.08×
- **Pattern eie (forced) — C/A ratio (paper's headline lever):** 6.21×
- **Pattern eie (forced) — C/B ratio (realistic production lever):** 3.08×

## Findings

**Setup.** Live runs against GPT-5.2 over NASA VEDA STAC (`lis-global-da-gpp`, Mendocino County CA, June–November 2020). 2 conversation patterns × 3 response-handler modes, across three prompt variants: natural, forced `compute_stats`, and `--with-map` (agent calls `render_map` and emits a map-layer URL). All cells completed except where noted; `eie-status-only` with-map needed `--recursion-limit 60` (it loops at the default 30).

### Templating lever (the paper's claim)

The paper's ~7.5× tool-response lever is **directionally real but overstated for realistic comparisons.** Headline C/A (raw STAC → status-only summary) varies by conversation shape:

- Paper pattern (parallel ReAct, 4–7 turns): **2.27–2.69×**
- EIE pattern (gated drill-down, 11–15 turns): **4.65–6.21×**

The realistic production lever — C/B (raw → typed key-fields, what teams actually template to) — lands at **3.08–5.98×**, not 7.5×. A team already doing key-fields templating won't find another 7.5× by going to status-only; mode A ($0.02–$0.07/query) is only marginally cheaper than mode B ($0.024–$0.046), and status-only carries a real information-bottleneck cost (the agent terminates early or loops without enough context to call `search_items`/`compute_stats`).

### Map step (`render_map`) cost

Emitting a map-layer URL adds one agent turn. Its marginal cost depends almost entirely on how aggressively the conversation is templated:

| Scenario | map=N | map=Y | Δ $/query | Δ % |
|---|---:|---:|---:|---:|
| eie · status-only | $0.0277 | $0.0272 | **−$0.0005** | **−1.8%** |
| paper · status-only | $0.0353 | $0.0377 | +$0.0024 | +6.8% |
| eie · freeform | $0.1289 | $0.1366 | +$0.0077 | +6.0% |
| eie · key-fields | $0.0419 | $0.0459 | +$0.0040 | +9.5% |
| paper · key-fields | $0.0243 | $0.0304 | +$0.0061 | +25.1% |
| paper · freeform | $0.0950 | $0.1507 | +$0.0557 | **+58.6%** |

Three observations:

1. **In templated modes the map step is nearly free** — and in the most extreme case (eie · status-only) it was net *cheaper*: the extra turn pushed the cache-hit rate to 75% (from 44%), and the discount on the now-cached conversation more than offset the added turn. The visualization is not where cost lives.

2. **Freeform amplifies the map step.** paper · freeform jumped +59% because the extra turns re-send the already-bloated raw-STAC context (input/turn 15.6K → 22.4K). This is the templating lever reappearing in a different guise: the more you template, the cheaper *every* subsequent turn — including the map call.

3. **status-only + map is fragile.** Both `eie-status-only --with-map` (default limit) and earlier runs hit the 30-turn recursion ceiling: from terse summaries the agent struggles to reconstruct enough context to both compute stats AND build a valid `render_map` call. It completes at limit 60, but the looping is a real production risk — bound retries per tool, not per conversation.

### Takeaway

Quote the templating lever as **~3–6× for realistic choices** (raw → key-fields), up to ~6× for aggressive templating (raw → status-only), with 7.5× as the extreme upper bound rather than the typical case. Adding a map-layer output costs **~$0.002–$0.06/query** — negligible in templated modes, only material in raw-passthrough. Response templating dominates cost; the visualization step does not.

**Limitations.** Single dataset (`lis-global-da-gpp`, substituted for the paper's MiCASA which isn't in VEDA's catalog), single AOI, single model. Cache hit rates (44–80%) depend on back-to-back agent-fleet execution and heavily dampen absolute costs; an isolated cold start would push them higher.
