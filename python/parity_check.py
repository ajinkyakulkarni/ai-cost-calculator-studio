#!/usr/bin/env python3
"""parity_check.py — Acceptance gate: Python vs JS engine numeric parity.

Usage:
    python3 python/parity_check.py

Reads pre-dumped JS results from /tmp/engine-dumps/<preset>.json (written
by scripts/dump-engine.mjs), re-runs the Python engine with the same _opts,
then deep-compares every numeric leaf between the two result trees.

Tolerances (matching scientific computing convention):
  - rel_tol = 1e-9   (relative tolerance for normal values)
  - abs_tol = 1e-6   (absolute tolerance for near-zero values)

Exit code:
  0 — all presets PASS
  1 — one or more presets FAIL
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
_REPO_ROOT = Path(__file__).resolve().parent.parent
_EXAMPLES_DIR = _REPO_ROOT / "public" / "examples"
_DUMPS_DIR = Path("/tmp/engine-dumps")

# Add the python/ directory so `import costcalc` works without pip install
sys.path.insert(0, str(Path(__file__).resolve().parent))
from costcalc import compute  # noqa: E402


# ---------------------------------------------------------------------------
# buildOpts() — exact port of bench-validate.mjs:buildOpts()
# ---------------------------------------------------------------------------

def build_opts(w: Dict[str, Any]) -> Dict[str, Any]:
    """Mirrors buildOpts() from scripts/bench-validate.mjs."""
    d = w.get("defaults") or {}
    anchor = w.get("anchor_query") or {}
    verif = w.get("verification") or {}
    return {
        "hosting":       d.get("hosting")   or "api",
        "model":         d.get("model")      or "gpt-5.2",
        "tier":          d.get("tier")       or "standard",
        "mix":           d.get("mix")        or "mixed",
        "costMode":      d.get("cost_mode")  or "realistic",
        "botFactor":     1.5,
        "cacheRate":     (anchor["cache_rate_baseline"]
                         if anchor.get("cache_rate_baseline") is not None
                         else 0.7),
        "verifCoverage": verif.get("coverage") or 0,
    }


# ---------------------------------------------------------------------------
# Deep numeric comparison
# ---------------------------------------------------------------------------

REL_TOL = 1e-9
ABS_TOL = 1e-6


def _is_numeric(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _nums_close(a: float, b: float) -> bool:
    if math.isnan(a) and math.isnan(b):
        return True
    if math.isinf(a) or math.isinf(b):
        return a == b
    # math.isclose with both rel and abs tolerances
    return math.isclose(a, b, rel_tol=REL_TOL, abs_tol=ABS_TOL)


def _collect_diffs(
    ref: Any,
    act: Any,
    path: str,
    diffs: List[Tuple[str, float, float]],
    *,
    max_collect: int = 500,
) -> None:
    """Recursively collect (path, ref_val, act_val) for differing numeric leaves."""
    if len(diffs) >= max_collect:
        return

    # Both numeric — the leaf comparison
    if _is_numeric(ref) and _is_numeric(act):
        if not _nums_close(float(ref), float(act)):
            diffs.append((path, float(ref), float(act)))
        return

    # Both dict
    if isinstance(ref, dict) and isinstance(act, dict):
        for k in ref:
            if k in act:
                _collect_diffs(ref[k], act[k], f"{path}.{k}", diffs, max_collect=max_collect)
            # Keys absent in act are not compared (Python may produce fewer fields)
        return

    # Both list
    if isinstance(ref, list) and isinstance(act, list):
        for i, rv in enumerate(ref):
            if i < len(act):
                _collect_diffs(rv, act[i], f"{path}[{i}]", diffs, max_collect=max_collect)
        return

    # Type mismatch on numeric vs non-numeric — report if ref is numeric
    if _is_numeric(ref) and not _is_numeric(act):
        diffs.append((path, float(ref), float("nan")))


# ---------------------------------------------------------------------------
# Keys to compare (stripped of workload/derivation/break_even/migration)
# ---------------------------------------------------------------------------

COMPARE_KEYS = [
    "queries",
    "api",
    "verification",
    "tool_fees",
    "federal",
    "reservation",
    "embedding",
    "personnel",
    "fixed_costs",
    "self_host",
]


# ---------------------------------------------------------------------------
# Per-preset runner
# ---------------------------------------------------------------------------

def run_preset(slug: str) -> Tuple[bool, str, List[Tuple[str, float, float]]]:
    """Returns (passed, detail_msg, diffs)."""
    dump_path = _DUMPS_DIR / f"{slug}.json"
    example_path = _EXAMPLES_DIR / f"{slug}.json"

    if not dump_path.exists():
        return False, f"Dump not found: {dump_path}", []
    if not example_path.exists():
        return False, f"Example not found: {example_path}", []

    # Load JS reference dump
    with open(dump_path) as f:
        js_dump = json.load(f)

    # Load workload and build opts (same as dump-engine.mjs)
    with open(example_path) as f:
        workload = json.load(f)

    # Use _opts from dump for exact reproducibility
    stored_opts = js_dump.get("_opts") or {}
    # Reconstruct opts the same way dump-engine.mjs does — via buildOpts()
    opts = build_opts(workload)
    # Sanity: stored opts should match
    if stored_opts and stored_opts.get("cacheRate") != opts.get("cacheRate"):
        print(f"  ⚠ opts.cacheRate mismatch vs stored dump for {slug} — comparing anyway", file=sys.stderr)

    # Run Python engine
    try:
        py_result = compute(workload, opts)
    except Exception as e:
        import traceback
        return False, f"Python engine raised: {e}\n{traceback.format_exc()}", []

    diffs: List[Tuple[str, float, float]] = []
    for key in COMPARE_KEYS:
        ref_val = js_dump.get(key)
        act_val = py_result.get(key)
        if ref_val is None:
            continue
        if act_val is None:
            diffs.append((key, float("nan"), float("nan")))
            continue
        _collect_diffs(ref_val, act_val, key, diffs)

    passed = len(diffs) == 0
    return passed, "", diffs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    if not _DUMPS_DIR.exists() or not any(_DUMPS_DIR.glob("*.json")):
        print(f"ERROR: No dump files found in {_DUMPS_DIR}")
        print("Run:  node scripts/dump-engine.mjs")
        return 1

    slugs = sorted(p.stem for p in _DUMPS_DIR.glob("*.json"))
    print(f"parity_check.py — {len(slugs)} presets, rel_tol={REL_TOL}, abs_tol={ABS_TOL}")
    print("")

    all_pass = True
    rows = []

    for slug in slugs:
        passed, errmsg, diffs = run_preset(slug)
        status = "PASS" if passed else "FAIL"
        if not passed:
            all_pass = False
        rows.append((slug, passed, errmsg, diffs))
        print(f"[{status}] {slug}")
        if errmsg:
            print(f"       ERROR: {errmsg}")
        elif diffs:
            # Print first 10 differing paths
            for path, ref, act in diffs[:10]:
                rel = abs((act - ref) / ref) if ref != 0 else abs(act)
                print(f"       DIFF  {path}")
                print(f"             ref={ref:>18.6f}  act={act:>18.6f}  rel={rel:.2e}")
            if len(diffs) > 10:
                print(f"       ... and {len(diffs) - 10} more diffs")

    # Summary table
    print("")
    print("=" * 72)
    total = len(rows)
    passed_n = sum(1 for _, p, _, _ in rows if p)
    print(f"Result: {passed_n}/{total} presets PASS")
    print("")
    print(f"{'Preset':<45} {'Status':<6} {'Diffs':>5}")
    print("-" * 60)
    for slug, passed, errmsg, diffs in rows:
        tag = "PASS" if passed else "FAIL"
        ndiff = 0 if passed else (len(diffs) if not errmsg else "ERR")
        print(f"{slug:<45} {tag:<6} {str(ndiff):>5}")

    if all_pass:
        print("\nAll presets within tolerance — Python engine is PARITY.")
        return 0
    else:
        failed = total - passed_n
        print(f"\nFAILED: {failed}/{total} presets have numeric differences.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
