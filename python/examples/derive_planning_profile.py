#!/usr/bin/env python3
"""derive_planning_profile.py — derive the Planning+routing archetype profile.

There are NO measured Planning+routing numbers — the stakeholder doc left that
row blank. This script DERIVES an estimate by applying the doc's own
turn-by-turn token-accumulation method (the one it used for Multi-source) to
the Q2 shade-routing workflow.

To earn trust in the method, it FIRST reproduces the doc's published
Multi-source totals (cumulative input 233,498 / output 885 / cached 184,917)
from that workflow's per-turn trace. Only then does it apply the same method,
and the same empirical cache ratio (184,917 / 233,498 = 0.7919), to Planning.

Output numbers are ESTIMATES, not telemetry. Replace with measured values when
the Q2 workflow is instrumented.

    python3 python/examples/derive_planning_profile.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from costcalc.growth import cycle_from_turns, DOC_CACHE_RATIO  # noqa: E402

# Doc's published Multi-source 11-turn trace (input, output) per turn.
# Used purely to validate that summing the trace reproduces the doc's totals.
MULTI_SOURCE_TRACE = [
    (20398, 43), (20461, 86), (20647, 43), (20720, 60), (20850, 43),
    (20893, 238), (21661, 71), (21782, 70), (21902, 70), (22022, 60),
    (22162, 101),
]
DOC_MULTI = {"input": 233498, "output": 885, "cached": 184917}
CACHE_RATIO = DOC_CACHE_RATIO  # 0.79195... (shared with costcalc.growth)

# ---------------------------------------------------------------------------
# Q2 shade-routing workflow — derived turn-by-turn trace.
#
# Base context (larger than Multi-source's 20,358): planning+routing needs a
# bigger system prompt and three extra tool schemas.
#   sysprompt          ~8,500  (Multi-source 7,500 + routing/shade constraints)
#   10 base schemas    12,858  (same as Multi-source: 9,000 + 3,858)
#   +3 tools           ~3,858  (Google Maps, fusion, optimization)
PLANNING_BASE = 8500 + 12858 + 3858  # = 25,216

# Each turn: tokens ADDED to context this turn (user msg + incoming tool
# result), then the model's output. input_t = base + running history.
# Deltas follow the doc's conventions: templated ask ~43, tool call ~60-150,
# search result payload ~500-800, large fusion/route payloads bigger, final
# GeoJSON output is freeform (not templated) so it is large.
#                     added_to_context, output
PLANNING_STEPS = [
    ("ask AOI / destination",          40,   43),   # user query in, templated ask
    ("ask time of day",                20,   43),
    ("geocode origin + destination",   20,   90),   # tool call (2 points)
    ("confirm geocode",               150,   43),   # 2 geometries returned
    ("PLANNING: interpret shade",       0,  450),   # reasoning + dataset plan
    ("federated search: tree canopy",   0,  238),   # tool call + present
    ("federated search: bldg + height",500,  238),  # prior results land in ctx
    ("solar position (computed)",      600,  100),
    ("item search: retrieve datasets",  30,  120),   # user select + multi-retrieve
    ("Google Maps routing",            800,  150),   # road net + candidate routes
    ("data fusion (shade + routes)",  1500,  200),   # large route payload in ctx
    ("route scoring / optimization",  2000,  600),   # fusion result in ctx; reasoning
    ("visualization + GeoJSON answer", 300,  800),   # freeform route geometry out
]


def main():
    # 1. Validate the method on the doc's Multi-source numbers.
    ms_in = sum(t[0] for t in MULTI_SOURCE_TRACE)
    ms_out = sum(t[1] for t in MULTI_SOURCE_TRACE)
    print("Multi-source self-check (must match the doc):")
    print(f"  cumulative input : {ms_in:,}  (doc {DOC_MULTI['input']:,})  "
          f"{'OK' if ms_in == DOC_MULTI['input'] else 'MISMATCH'}")
    print(f"  cumulative output: {ms_out:,}  (doc {DOC_MULTI['output']:,})  "
          f"{'OK' if ms_out == DOC_MULTI['output'] else 'MISMATCH'}")
    print(f"  cache ratio used : {CACHE_RATIO:.4f}  ({DOC_MULTI['cached']:,}/{DOC_MULTI['input']:,})")
    assert ms_in == DOC_MULTI["input"] and ms_out == DOC_MULTI["output"]

    # 2. Derive Planning+routing from the Q2 trace via the shared growth model
    #    (same accumulation + cache ratio as costcalc.growth.cycle_from_turns).
    prof = cycle_from_turns(
        PLANNING_BASE,
        [(added, out) for _label, added, out in PLANNING_STEPS],
        cache_ratio=CACHE_RATIO,
    )
    p_in, p_cached, p_out = prof["input_tokens"], prof["cached_tokens"], prof["output_tokens"]
    print(f"\nPlanning+routing derived ({len(PLANNING_STEPS)} turns, "
          f"base {PLANNING_BASE:,}):")
    print(f"  input_tokens : {p_in:,}")
    print(f"  cached_tokens: {p_cached:,}  (at the doc's {CACHE_RATIO:.3f} ratio)")
    print(f"  output_tokens: {p_out:,}")
    print(f"  vs Multi-source input: x{p_in / DOC_MULTI['input']:.2f} "
          "(was a flat 2.2x placeholder)")
    print("\nPaste into eie-new-direction.json (these are ESTIMATES, not measured):")
    print(f'  "input_tokens": {p_in}, "cached_tokens": {p_cached}, '
          f'"output_tokens": {p_out}')


if __name__ == "__main__":
    main()
