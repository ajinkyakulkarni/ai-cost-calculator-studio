#!/usr/bin/env python3
"""run.py — CLI runner for the Python AI Cost Calculator engine.

Usage:
    python3 python/run.py public/examples/<preset>.json [options]

Options:
    --hosting   api|self|hybrid|onprem  (default: from workload.defaults)
    --model     model-id                (default: from workload.defaults)
    --tier      standard|premium        (default: from workload.defaults)
    --mix       mixed|worst|best        (default: from workload.defaults)
    --json      Emit full result as JSON instead of summary table
    --quiet     Only print headline total

Examples:
    python3 python/run.py public/examples/public-geospatial-qa.json
    python3 python/run.py public/examples/swe-bench-coding-agent.json --hosting api --json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow running from any cwd
sys.path.insert(0, str(Path(__file__).resolve().parent))
from costcalc import compute  # noqa: E402


def build_opts(workload: dict, args: argparse.Namespace) -> dict:
    """Build opts from workload.defaults + CLI overrides."""
    d = workload.get("defaults") or {}
    anchor = workload.get("anchor_query") or {}
    verif = workload.get("verification") or {}
    opts = {
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
    # CLI overrides
    if args.hosting:
        opts["hosting"] = args.hosting
    if args.model:
        opts["model"] = args.model
    if args.tier:
        opts["tier"] = args.tier
    if args.mix:
        opts["mix"] = args.mix
    return opts



def decode_share_url(url: str):
    """Decode a calc.ajinkya.ai share link (#w=<base64(uriencoded JSON)>)
    into its {workload, ui} payload — same codec as lib/workload-hash.js."""
    import base64
    import re
    from urllib.parse import unquote
    m = re.search(r"w=([^&]+)", url)
    if not m:
        raise ValueError("no w= payload in URL/hash")
    payload = json.loads(unquote(base64.b64decode(m.group(1)).decode("latin-1")))
    if isinstance(payload, dict) and payload.get("workload"):
        return payload["workload"], payload.get("ui") or {}
    return payload, {}


def apply_ui_block(opts: dict, ui: dict) -> dict:
    """Map the share-link's ui block (live slider/dropdown state) onto
    engine opts — this is what makes a share link reproduce the exact
    headline the browser shows, including app-layer sliders like retry."""
    def f(key):
        v = ui.get(key)
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None
    if f("s-retry") is not None:
        opts["retry_rate"] = f("s-retry") / 100.0
    if f("s-cache") is not None:
        opts["cacheRate"] = f("s-cache") / 100.0
    if f("prev-bot") is not None:
        opts["botFactor"] = f("prev-bot")
    if f("prev-cache") is not None:
        opts["cacheWriteShare"] = None  # prev-cache is a UI echo; cacheRate above wins
    if f("prev-api-split") is not None:
        opts["apiSplit"] = f("prev-api-split") / 100.0
    if f("prev-replicas") is not None:
        opts["replicas"] = int(f("prev-replicas"))
    if f("prev-tokens") is not None:
        opts["tokensPerQuery"] = f("prev-tokens")
    for ui_key, opt_key in (("prev-hosting", "hosting"), ("prev-model", "model"),
                            ("prev-tier", "tier"), ("prev-mix", "mix"),
                            ("prev-cost-mode", "costMode"), ("prev-gpu", "gpu"),
                            ("prev-commitment", "commitment")):
        if ui.get(ui_key):
            opts[opt_key] = ui[ui_key]
    return opts


def fmt_usd(n: float) -> str:
    return f"${n:>14,.2f}"


def print_summary(result: dict, opts: dict) -> None:
    """Print a human-readable summary of the result."""
    api = result.get("api") or {}
    verif = result.get("verification") or {}
    tf = result.get("tool_fees") or {}
    fed = result.get("federal") or {}
    fixed = result.get("fixed_costs") or {}
    emb = result.get("embedding") or {}
    pers = result.get("personnel") or {}
    q = result.get("queries") or {}
    hl = result.get("headline") or {}
    sh = result.get("self_host") or {}
    hyb = result.get("hybrid") or {}
    ae = result.get("agent_engineering") or {}
    res = result.get("reservation") or {}

    hosting = opts.get("hosting") or "api"
    print("")
    print(f"  Model     : {opts.get('model')}")
    print(f"  Hosting   : {hosting}")
    print(f"  Tier      : {opts.get('tier')}")
    print(f"  Mix       : {opts.get('mix')}")
    print(f"  Queries/mo: {q.get('total', 0):,.0f}")
    print("")
    print("  Cost breakdown (USD/month)")
    print("  " + "-" * 40)
    print(f"  LLM API gross     {fmt_usd(api.get('monthly_gross', 0))}")
    print(f"  LLM API (capped)  {fmt_usd(api.get('monthly_capped', 0))}")
    print(f"  LLM w/ retry      {fmt_usd(api.get('monthly_with_retry', 0))}")
    if hosting == "self":
        print(f"  Self-host total   {fmt_usd(sh.get('total', 0))}")
    elif hosting == "hybrid":
        print(f"  Hybrid total      {fmt_usd(hyb.get('total', 0))}")
    if res.get("enabled"):
        print(f"  Reservation eff.  {fmt_usd(res.get('effective_monthly', 0))}")
    print(f"  Verification      {fmt_usd(verif.get('monthly', 0))}")
    print(f"  Tool fees         {fmt_usd(tf.get('monthly', 0))}")
    print(f"  Federal additive  {fmt_usd(fed.get('additive_total', 0))}")
    print(f"  Fixed costs       {fmt_usd(fixed.get('total', 0))}")
    if emb.get("enabled"):
        print(f"  Embedding         {fmt_usd(emb.get('monthly', 0))}")
    if pers.get("enabled"):
        print(f"  Personnel         {fmt_usd(pers.get('monthly', 0))}")
    if ae.get("enabled"):
        print(f"  Agent eng.        {fmt_usd(ae.get('monthly', 0))}")
    print("  " + "-" * 40)
    print(f"  HEADLINE          {fmt_usd(hl.get('headline', 0))}")
    print("")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="AI Cost Calculator Python engine CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("workload_path", nargs="?", help="Path to workload JSON file")
    parser.add_argument("--share-url", default=None,
                        help="A calc.ajinkya.ai share link (or just its #w=... hash) — "
                             "reproduces the exact headline the browser shows, "
                             "including UI slider state (retry, cache, hosting, model…)")
    parser.add_argument("--retry", type=float, default=None,
                        help="Retry rate in PERCENT (the UI s-retry slider; default preset state is 3)")
    parser.add_argument("--hosting", choices=["api", "self", "hybrid", "onprem"], default=None)
    parser.add_argument("--model", default=None, help="Model ID override")
    parser.add_argument("--tier", default=None, help="Tier ID override")
    parser.add_argument("--mix", default=None, help="Mix ID override")
    parser.add_argument("--json", action="store_true", help="Emit full result as JSON")
    parser.add_argument("--quiet", action="store_true", help="Print only headline total")
    args = parser.parse_args()

    ui_block = {}
    if args.share_url:
        try:
            workload, ui_block = decode_share_url(args.share_url)
        except Exception as e:
            print(f"ERROR: could not decode share URL: {e}", file=sys.stderr)
            return 1
    elif args.workload_path:
        path = Path(args.workload_path)
        if not path.exists():
            print(f"ERROR: File not found: {path}", file=sys.stderr)
            return 1
        try:
            with open(path) as f:
                workload = json.load(f)
        except json.JSONDecodeError as e:
            print(f"ERROR: Invalid JSON in {path}: {e}", file=sys.stderr)
            return 1
    else:
        print("ERROR: provide a workload JSON path or --share-url", file=sys.stderr)
        return 1

    opts = build_opts(workload, args)
    if ui_block:
        opts = apply_ui_block(opts, ui_block)
        # re-apply explicit CLI overrides on top of the ui block
        if args.hosting: opts["hosting"] = args.hosting
        if args.model:   opts["model"] = args.model
        if args.tier:    opts["tier"] = args.tier
        if args.mix:     opts["mix"] = args.mix
    if args.retry is not None:
        opts["retry_rate"] = args.retry / 100.0

    try:
        result = compute(workload, opts)
    except Exception as e:
        import traceback
        print(f"ERROR: Engine raised: {e}", file=sys.stderr)
        traceback.print_exc()
        return 1

    if getattr(args, "json"):
        # Remove workload from output (large and redundant)
        out = {k: v for k, v in result.items() if k != "workload"}
        print(json.dumps(out, indent=2, default=str))
    elif args.quiet:
        hl = (result.get("headline") or {}).get("headline", 0)
        print(f"${hl:,.2f}")
    else:
        slug = Path(args.workload_path).stem if args.workload_path else "(share link)"
        print(f"\nAI Cost Calculator — {slug}")
        print_summary(result, opts)

    return 0


if __name__ == "__main__":
    sys.exit(main())
