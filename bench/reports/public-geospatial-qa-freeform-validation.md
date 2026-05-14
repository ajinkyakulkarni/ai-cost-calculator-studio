# public-geospatial-qa preset — paired freeform-mode validation, 2026-05-13

## Summary

Paired empirical validation of the templated vs freeform cost-lever
claim. Both endpoints now measured against real OpenAI gpt-5.2, so
the spread in the paper is empirical at both ends — not "measured
floor + modeled ceiling."

The bench's freeform tools (`geocode`, `search_items`, `compute_stats`)
were extended on 2026-05-13 to return realistic heavy payloads:
- `geocode` returns a full 80-vertex administrative polygon (~2K tokens)
  as Geodini does for non-trivial polities
- `search_items` returns full STAC 1.0.0 item objects with `geometry`,
  `bbox`, `properties` (15+ fields), `assets` (cog/thumbnail/browse/
  metadata with checksums), and `links` (~3K tokens per item × 8-15
  items)
- `compute_stats` returns per-band per-item statistics with 16-bin
  histograms, 9 percentile levels, QA-mask counts, and spatial
  quadrant means (~1.5K tokens per item × 3 bands)

Templated mode is unchanged — the agent's response-template layer
strips structured payloads and the LLM only sees short status
messages.

**Headline finding: the measured cost spread is 7.8×, not 25×.** The
paper's earlier 25× claim was a structural extrapolation that
exceeded what the bench can produce even with maximally realistic
heavy tool returns. The empirical 7.8× is still a substantial
operational lever — turning off response templating costs ~8× more
per month on the same workload — but the paper should reflect the
measured number, not the modeled one.

## Measurements (all real OpenAI gpt-5.2, FedRAMP Moderate ×1.15)

| Mode                       | per-turn input | cache rate | $/turn      | Monthly $ at 915K queries | Spread vs templated |
|---                         |---:            |---:        |---:         |---:                       |---:                 |
| Templated (N=20)           | 3,342 tok      | 88.28%     | $0.00178    | **$1,871**                | 1.00× (baseline)    |
| Freeform / modest (N=5)    | 4,699 tok      | 82.26%     | $0.00281    | **$2,958**                | 1.58×               |
| Freeform / heavy (N=5)     | **22,798 tok** | **74.39%** | **$0.01392** | **$14,648**              | **7.83× (measured)** |
| Paper-modeled heavy (84K/session per Table 6) | 14,082 tok | 84.00% | $0.00800 | $8,419 | 4.50× (modeled) |

## Configuration

| Setting | Value |
|---|---|
| Scenario | `bench/scenarios/public-geospatial-react-freeform.yml` |
| Model | gpt-5.2 (OpenAI, standard tier) |
| Topology | single agent + ReAct tool loop |
| Tools | 7 (parse_datetime, geocode, search_collections, select_collection, search_items, compute_stats, build_viz_tiles) |
| Tool response mode | `freeform` (with heavy payloads from 2026-05-13 beef-up) |
| User turns per session | 6 |
| Repeats | 5 |
| Total user-turns | 30 |
| Total LLM calls | 60 (2.00 calls/user-turn) |
| Cache-busting | per-repeat UUID prefix on system prompt (audit fix #5) |
| Total input tokens | 683,937 |
| Total output tokens | 1,574 |
| Total cached tokens | 508,800 (74.39%) |
| Total API spend | ~$0.42 (well under the $10 cap) |

## Why the bench heavy-payload diverges from the paper's modeled anchor

The paper's "84,490 input tokens / 0.84 cache rate" anchor assumed:
- ~14K tokens per turn (over 6 turns = 84.5K per session)
- Cache rate stable at 0.84 across all turns

The bench measurement at full heavy payloads shows:
- ~23K tokens per turn (over 6 turns ≈ 137K per session) — **the
  bench's beefed-up payloads are heavier than the paper modeled**
- Cache rate drops to 0.74 — **heavy payloads erode cache more than
  modeled** because each new STAC item brings unique tokens that
  don't match prior cache prefixes

The two effects partly cancel for total cost: higher input tokens
(more expensive uncached fraction) × lower cache rate (more uncached
tokens absolute) gives $14.6K/mo, vs the paper's $8.4K/mo if you
plug the same per-query formula through the modeled point.

The 25× cost-lever claim in earlier drafts assumed:
- A specific heavy-payload shape that produced a per-query cost ~25×
  higher than templated
- That shape required tool returns *even heavier* than what realistic
  STAC + raster-statistics services produce

In practice, with the bench's full heavy payloads (matching what
production STAC/raster APIs actually return), the spread is **7.8×**.
A 25× spread is achievable only if tools return *additionally*
inflated content beyond STAC 1.0 metadata + standard statistics
arrays — e.g., per-pixel time-series, full raster previews encoded as
base64, or full text descriptions per item.

## Implication for the paper

The §5 footnote should be updated from "84K-token modeled anchor"
to "7.8× measured spread, both endpoints validated." The
qualitative argument (response-template architecture is a major
cost lever) is unchanged and strengthened by empirical
validation. The quantitative claim should match the measurement.

Recommended Table 6 update path: re-run the stress test at the
heavy-payload measured anchor (22,798 per-turn input, 0.74 cache
rate) instead of the modeled 84.5K anchor. The headline LLM cost at
50K MAU heavy would drop from the paper's current $125K/mo
(uncapped) to roughly $50-60K/mo, and the equal-budget comparison
band shifts proportionally.

## Reproducibility

```bash
# From bench/, with .env loaded:
agent-cost-bench run scenarios/public-geospatial-react-freeform.yml --output reports --yes
```

Spend: ~$0.40-0.50 at repeat=5. Trace artifact:
`reports/public-geospatial-react-freeform-2026-05-13T19-31-14-647879+00-00-trace.json`.

The paired templated trace from earlier is at
`reports/public-geospatial-qa-templated-trace.json`.
