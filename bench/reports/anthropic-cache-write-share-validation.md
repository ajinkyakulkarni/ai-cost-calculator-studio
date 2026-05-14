# Anthropic cache-write share `w` — empirical measurement, 2026-05-13

## Summary

Paired empirical measurement of Eq. 2 (`p_cached,eff = w·p_write +
(1−w)·p_read`) on the Anthropic side. The OpenAI side was already
validated (auto-prefix caching; `w ≈ 0` in steady state). This run
provides the symmetric measurement for Anthropic explicit caching,
closing the calibration loop on the cache-blend equation.

**Headline finding: empirical w = 0.204 for typical multi-turn
Anthropic deployments,** roughly 2× the engine's default of 0.10.

## Configuration

| Setting | Value |
|---|---|
| Scenario | `bench/scenarios/cached-pipeline-anthropic.yml` |
| Model | `claude-sonnet-4-5-20250929` (Anthropic) |
| Topology | single agent, long shared system prompt (~1,900 tokens), 6 short turns |
| Repeats | 3 |
| Total LLM calls | 18 |
| Total API spend | $0.099 |

## Measurement methodology

Anthropic separates cache usage into `cache_creation_input_tokens`
(written; charged at 1.25× base input = $3.75/M for 5-min TTL on
Sonnet 4.5) and `cache_read_input_tokens` (read; charged at 0.1×
base = $0.30/M). LiteLLM currently surfaces only `cache_read_input_tokens`
as the bench's `cached_tokens` field; the cache-creation portion is
implicit in the per-call cost reported by LiteLLM.

We back-derive cache-creation tokens from the cost residual:

```
total_cost = uncached_in × p_in
           + cache_read × p_read
           + cache_create × p_write
           + output × p_out
```

Solving for `cache_create`:

```
cache_create = (total_cost - uncached_in × p_in
               - cache_read × p_read
               - output × p_out) / p_write
```

## Results

**Aggregate over 18 calls (3 repeats × 6 turns):**

| Quantity | Value |
|---|---:|
| Total cost                  | $0.09858 |
| Output tokens               | 3,600 |
| Input tokens (full prompt)  | 35,303 |
| Cache-read tokens (measured)| 35,267 |
| Uncached input              | 36 |
| Cache-create tokens (derived) | **9,039** |
| **Empirical w = creation / (creation + read)** | **0.204** |

**Per-call pattern (consistent across all 3 repeats):**
- Turn 1 (calls 1, 7, 13): cold cache → ~1,917 tokens written to
  cache for the system prompt. Cost ≈ $0.0102.
- Turns 2-6 (the remaining 15 calls): cache-read of the system prompt
  (1,916-2,795 tokens depending on accumulated context) plus
  ~215 tokens of cache-creation per call (TTL refresh of the
  cache entry on each access). Cost ≈ $0.0044.

The ~215-tokens-per-warm-call refresh contribution is the unexpected
finding: even after the cache is warmed, Anthropic continues to
charge a small cache-write surcharge on each read, presumably to
extend the TTL. Across 15 warm calls × ~215 = 3,225 tokens. Plus
3 cold writes × ~1,917 = 5,751. Total: 8,976 ≈ measurement 9,039.

## Cost-impact comparison

For a typical warm-call cached portion (~1,959 tokens):

| `w` | `p_cached,eff` ($/M) | Cached-portion cost | Ratio vs w=0 |
|---|---:|---:|---:|
| 0.00 (steady state) | $0.300 | $0.000587 | 1.00× |
| 0.10 (engine default) | $0.645 | $0.001263 | 2.15× |
| **0.204 (measured)** | **$1.004** | **$0.001967** | **3.35×** |
| 0.30 (high rotation) | $1.335 | $0.002615 | 4.45× |

The engine's `cacheWriteShare: 0.10` default for Anthropic models
(in `cost-simulator.js:MODELS`) undercounts cache cost for typical
multi-turn deployments by roughly 36% on the cached portion of
input. For deployments with infrequent cache rotation, `w = 0.10`
is defensible; for the multi-turn-conversation pattern this scenario
measures (single agent, shared system prompt, 6 turns), `w ≈ 0.20`
is the empirical anchor.

## Implication for the paper

Eq. 2 (`p_cached,eff = w·p_write + (1−w)·p_read`) is now
empirically validated at BOTH endpoints:

- **OpenAI** (auto-prefix caching): `w ≈ 0` in steady state. Bench
  templated + freeform scenarios both confirm.
- **Anthropic** (explicit `cache_control`): **`w = 0.204`** measured
  on multi-turn deployment (this scenario, N=18 calls).

The 2-mode Anthropic caching (automatic top-level `cache_control`
vs explicit per-block) discussion in the paper's §3 cache section
is unaffected; both modes write tokens that count toward `w`. The
engine's default 0.10 should be updated to ~0.20 for Anthropic
multi-turn workloads, or the paper should report 0.20 as the
calibration anchor for that provider.

## Bench measurement gap (separate finding)

`provider.py:163-164` currently captures `cached_tokens` from
`prompt_tokens_cached` (cache reads) but does NOT capture
`cache_creation_input_tokens` separately. We back-derived from cost
in this run, but it would be cleaner to capture both fields on the
OTEL span so future runs report `w` directly without cost
arithmetic. Filed as a v2 improvement; doesn't affect the
measurement above.

## Reproducibility

```bash
# From bench/, with ANTHROPIC_API_KEY in .env:
agent-cost-bench run scenarios/cached-pipeline-anthropic.yml --output reports --yes
```

Spend: ~$0.10 per run at repeat=3. Trace artifact:
`reports/cached-pipeline-anthropic-2026-05-14T01-24-25-272383+00-00-trace.json`.
