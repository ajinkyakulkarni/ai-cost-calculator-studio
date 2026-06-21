#!/usr/bin/env python3
"""test_archetype.py — unit tests for costcalc.archetype.

Asserts the pinned numbers from python/docs/archetype-cost-spec.md against
the calc's real price book. Run: python3 python/test_archetype.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from costcalc.archetype import archetype_cost  # noqa: E402

TOL = 1e-4
_passed = 0
_failed = 0


def check(label, got, want, tol=TOL):
    global _passed, _failed
    ok = abs(got - want) <= tol
    _passed += ok
    _failed += not ok
    print(f"  {'PASS' if ok else 'FAIL'}  {label}: got {got:.6f}  want {want:.6f}")


def expect_raises(label, fn):
    global _passed, _failed
    try:
        fn()
        _failed += 1
        print(f"  FAIL  {label}: expected ValueError, none raised")
    except ValueError:
        _passed += 1
        print(f"  PASS  {label}: raised ValueError as expected")


SIMPLE = {"name": "Simple", "share": 0.6, "tool_calls": 6, "turns": 6,
          "input_tokens": 80000, "cached_tokens": 70000, "output_tokens": 600}
MULTI = {"name": "Multi-source", "share": 0.3, "tool_calls": 8, "turns": 11,
         "input_tokens": 233498, "cached_tokens": 184917, "output_tokens": 885}


def main():
    print("archetype_cost — spec fixtures (gpt-5.4, standard tier)")

    # Single-archetype cycle costs (the pinned spec numbers).
    r = archetype_cost([SIMPLE], model="gpt-5.4", tier="standard", cycles_per_month=0)
    check("Simple cycle $", r["archetypes"][0]["cost_cycle"], 0.0515)

    r = archetype_cost([MULTI], model="gpt-5.4", tier="standard", cycles_per_month=0)
    check("Multi-source cycle $", r["archetypes"][0]["cost_cycle"], 0.18096, tol=1e-4)

    # Tier multiplier: batch = 0.5×.
    r = archetype_cost([MULTI], model="gpt-5.4", tier="batch", cycles_per_month=0)
    check("Multi-source @ batch (0.5x) $", r["archetypes"][0]["cost_cycle"], 0.09048, tol=1e-4)
    check("tier_multiplier reported", r["tier_multiplier"], 0.5)

    # Mix blending → monthly at 600k cycles.
    planning = dict(MULTI, name="Planning", share=0.1,
                    input_tokens=int(233498 * 2.2),
                    cached_tokens=int(184917 * 2.2),
                    output_tokens=int(885 * 2.2))
    r = archetype_cost([SIMPLE, MULTI, planning], model="gpt-5.4",
                       tier="standard", cycles_per_month=600000)
    # shares 0.6/0.3/0.1 already sum to 1.0
    check("shares_sum_raw", r["shares_sum_raw"], 1.0)
    bl = r["blended"]["cost_per_cycle"]
    print(f"    blended per-cycle = ${bl:.4f}, monthly = ${r['blended']['monthly']:,.0f}")
    # sanity band (not pinned to the cent — placeholder Planning factor)
    check("blended monthly in band", 1.0 if 60000 <= r["blended"]["monthly"] <= 90000 else 0.0, 1.0)
    # monthly = blended_cycle × cycles
    check("monthly == blended×cycles", r["blended"]["monthly"], bl * 600000, tol=1.0)

    # Share normalization: shares that don't sum to 1 get normalized.
    r = archetype_cost([dict(SIMPLE, share=3), dict(MULTI, share=1)],
                       model="gpt-5.4", tier="standard", cycles_per_month=0)
    check("normalized share (3 of 4)", r["archetypes"][0]["share_normalized"], 0.75)
    check("normalized share (1 of 4)", r["archetypes"][1]["share_normalized"], 0.25)

    # Bands: low/high factors scale the cycle cost.
    r = archetype_cost([dict(MULTI, low_factor=0.7, high_factor=1.5)],
                       model="gpt-5.4", tier="standard", cycles_per_month=0)
    a0 = r["archetypes"][0]
    check("low band = 0.7× expected", a0["cost_cycle_low"], a0["cost_cycle"] * 0.7)
    check("high band = 1.5× expected", a0["cost_cycle_high"], a0["cost_cycle"] * 1.5)

    # Edge cases.
    expect_raises("empty list", lambda: archetype_cost([], cycles_per_month=0))
    expect_raises("unknown model",
                  lambda: archetype_cost([SIMPLE], model="nope", cycles_per_month=0))
    expect_raises("unknown tier",
                  lambda: archetype_cost([SIMPLE], tier="nope", cycles_per_month=0))
    expect_raises("cached > input",
                  lambda: archetype_cost(
                      [dict(SIMPLE, input_tokens=100, cached_tokens=200)],
                      cycles_per_month=0))

    print(f"\narchetype: {_passed} passed, {_failed} failed.")
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
