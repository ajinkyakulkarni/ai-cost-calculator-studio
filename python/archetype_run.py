#!/usr/bin/env python3
"""archetype_run.py — CLI for the archetype cost model.

    python3 python/archetype_run.py python/examples/eie-new-direction.json
    python3 python/archetype_run.py <file.json> --model gpt-5.2 --tier batch
    python3 python/archetype_run.py <file.json> --json

Input JSON: { model, tier, cycles_per_month, archetypes: [ {name, share,
input_tokens, cached_tokens, output_tokens, [tool_calls, turns, low_factor,
high_factor]} ] }. See python/docs/archetype-cost-spec.md.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from costcalc.archetype import archetype_cost  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Archetype-based agent cost estimate.")
    ap.add_argument("spec_path", help="Path to an archetype-set JSON")
    ap.add_argument("--model", default=None, help="Override model rate-card key")
    ap.add_argument("--tier", default=None, help="Override tier (standard/flex/batch/priority)")
    ap.add_argument("--cycles", type=float, default=None, help="Override cycles_per_month")
    ap.add_argument("--json", action="store_true", help="Emit full result as JSON")
    args = ap.parse_args()

    path = Path(args.spec_path)
    if not path.exists():
        print(f"ERROR: file not found: {path}", file=sys.stderr)
        return 1
    spec = json.loads(path.read_text())

    try:
        r = archetype_cost(
            spec["archetypes"],
            model=args.model or spec.get("model", "gpt-5.4"),
            tier=args.tier or spec.get("tier", "standard"),
            cycles_per_month=(args.cycles if args.cycles is not None
                              else float(spec.get("cycles_per_month", 0))),
        )
    except (ValueError, KeyError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(r, indent=2))
        return 0

    print(f"\nEIE Archetype Cost — {r['model']}, {r['tier']} tier "
          f"(x{r['tier_multiplier']:g})")
    print(f"  cycles/month: {r['cycles_per_month']:,.0f}")
    if abs(r["shares_sum_raw"] - 1.0) > 1e-6:
        print(f"  ⚠ shares sum to {r['shares_sum_raw']:.3f} — normalized to 1.0")
    print("  " + "-" * 74)
    print(f"  {'Archetype':<18}{'mix':>6}{'calls':>7}{'$/cycle':>11}"
          f"{'(low–high)':>16}{'$/month':>14}")
    print("  " + "-" * 74)
    for a in r["archetypes"]:
        calls = a["tool_calls"] if a["tool_calls"] is not None else "-"
        rng = f"{a['cost_cycle_low']:.3f}-{a['cost_cycle_high']:.3f}"
        print(f"  {a['name']:<18}{a['share_normalized']*100:>5.0f}%{calls:>7}"
              f"{a['cost_cycle']:>11.4f}{rng:>16}{a['monthly']:>14,.0f}")
    print("  " + "-" * 74)
    b = r["blended"]
    print(f"  {'BLENDED':<18}{'100%':>6}{'':>7}{b['cost_per_cycle']:>11.4f}"
          f"{'':>16}{b['monthly']:>14,.0f}")
    print(f"  {'range / month':<18}{'':>6}{'':>7}{'':>11}{'':>16}"
          f"{b['monthly_low']:,.0f} – {b['monthly_high']:,.0f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
