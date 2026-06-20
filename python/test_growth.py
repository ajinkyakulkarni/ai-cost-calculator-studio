#!/usr/bin/env python3
"""test_growth.py — unit tests for costcalc.growth.

The growth model must (a) reproduce the doc's published Multi-source cumulative
totals from its turn trace, and (b) reproduce the derived Planning profile that
ships in eie-new-direction.json. Run: python3 python/test_growth.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from costcalc.growth import cycle_from_turns, cycle_uniform, DOC_CACHE_RATIO  # noqa: E402

_passed = 0
_failed = 0


def eq(label, got, want):
    global _passed, _failed
    ok = got == want
    _passed += ok
    _failed += not ok
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got} want {want}")


# Doc's Multi-source 11-turn trace (input, output) per turn — same as the doc.
MS = [(20398,43),(20461,86),(20647,43),(20720,60),(20850,43),
      (20893,238),(21661,71),(21782,70),(21902,70),(22022,60),(22162,101)]
# Reconstruct the (added, output) steps that PRODUCE that trace, so we exercise
# cycle_from_turns end-to-end rather than just summing the given inputs.
MS_BASE = 20358
MS_STEPS = []
prev_out = 0
prev_in = MS_BASE
for inp, out in MS:
    added = inp - prev_in - prev_out      # tokens added to context this turn
    MS_STEPS.append((added, out))
    prev_in, prev_out = inp, out

# Planning Q2 trace (added_to_context, output) — mirrors derive_planning_profile.py.
PLANNING_BASE = 8500 + 12858 + 3858  # 25,216
PLANNING_STEPS = [
    (40,43),(20,43),(20,90),(150,43),(0,450),(0,238),(500,238),(600,100),
    (30,120),(800,150),(1500,200),(2000,600),(300,800),
]


def main():
    print("growth model — reproduces the doc + Planning")

    ms = cycle_from_turns(MS_BASE, MS_STEPS, cache_ratio=DOC_CACHE_RATIO)
    eq("Multi-source input", ms["input_tokens"], 233498)
    eq("Multi-source output", ms["output_tokens"], 885)
    eq("Multi-source cached", ms["cached_tokens"], 184917)
    eq("Multi-source turns", ms["turns"], 11)

    pl = cycle_from_turns(PLANNING_BASE, PLANNING_STEPS, cache_ratio=DOC_CACHE_RATIO)
    eq("Planning input (ships in EIE json)", pl["input_tokens"], 360938)
    eq("Planning cached", pl["cached_tokens"], 285842)
    eq("Planning output", pl["output_tokens"], 3115)

    # Uniform parameterization: base 20,000, 5 turns, +500/turn, 100 out/turn.
    # Every turn adds (prev_output + 500) to history, including turn 1's +500:
    # t1:20500 t2:21100 t3:21700 t4:22300 t5:22900 → sum 108,500.
    u = cycle_uniform(20000, 5, 500, 100, cache_ratio=0.8)
    eq("uniform input", u["input_tokens"], 108500)
    eq("uniform output", u["output_tokens"], 500)
    eq("uniform cached (0.8x)", u["cached_tokens"], 86800)
    eq("uniform turns", u["turns"], 5)

    # Guards.
    try:
        cycle_from_turns(1000, [(0, 0)], cache_ratio=1.5)
        print("  FAIL  bad cache_ratio: no raise"); globals().__setitem__('_failed', _failed + 1)
    except ValueError:
        print("  PASS  bad cache_ratio raises"); globals().__setitem__('_passed', _passed + 1)

    print(f"\ngrowth: {_passed} passed, {_failed} failed.")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
