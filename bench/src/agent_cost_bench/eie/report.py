"""Emit the 1-page Markdown comparison report from 6 trace JSONs.

Reads all *.trace.json files from bench/reports/eie-templating/,
groups by scenario_id, picks the latest trace per scenario, builds
a comparison table, and computes the two key ratio rows (C/A, C/B)
for each conversation pattern.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REPORTS_DIR = Path(__file__).resolve().parents[3] / "reports" / "eie-templating"

# GPT-5.2 pricing (USD per million tokens)
GPT52_INPUT_PER_M = 1.75
GPT52_CACHED_PER_M = 0.175  # 10% of input rate
GPT52_OUTPUT_PER_M = 14.0

MONTHLY_QUERIES = 915_000  # paper's workload


def _cost_per_query(t: dict) -> float:
    """Estimate $/query from a trace's totals."""
    totals = t["totals"]
    cached = totals["cached_tokens"]
    fresh = totals["input_tokens"] - cached
    return (
        fresh   * GPT52_INPUT_PER_M  / 1e6
        + cached  * GPT52_CACHED_PER_M / 1e6
        + totals["output_tokens"] * GPT52_OUTPUT_PER_M / 1e6
    )


def _latest_traces() -> dict[str, dict]:
    """Map scenario_id → latest trace dict."""
    by_id: dict[str, tuple[float, dict]] = {}
    for p in REPORTS_DIR.glob("*.trace.json"):
        try:
            with p.open() as f:
                t = json.load(f)
            mtime = p.stat().st_mtime
            sid = t["scenario_id"]
            if sid not in by_id or mtime > by_id[sid][0]:
                by_id[sid] = (mtime, t)
        except (json.JSONDecodeError, KeyError, ValueError):
            continue
    return {sid: t for sid, (_, t) in by_id.items()}


def emit_report() -> Path:
    """Build the comparison Markdown and write it to REPORTS_DIR."""
    traces = _latest_traces()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = REPORTS_DIR / f"{ts}-summary.md"

    rows: list[dict] = []
    for sid, t in traces.items():
        cost = _cost_per_query(t)
        rows.append({
            "id": sid,
            "pattern": t["pattern"],
            "mode": t["handler_mode"],
            "turns": t["turn_count"],
            "in_per_turn": t["per_turn_avg"]["input_tokens"],
            "out_per_turn": t["per_turn_avg"]["output_tokens"],
            "cache_hit_pct": t["totals"]["cache_hit_rate"] * 100,
            "cost_per_q": cost,
            "monthly": cost * MONTHLY_QUERIES,
        })
    rows.sort(key=lambda r: (r["pattern"], r["mode"]))

    lines: list[str] = []
    lines.append(f"# eie-templating bench summary — {ts}\n")
    lines.append("## Per-scenario results\n")
    lines.append(
        "| scenario | pattern | mode | turns | tok/turn (in) | tok/turn (out)"
        " | cache hit % | $/query | $/month @ 915K |"
    )
    lines.append("|---|---|---|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        lines.append(
            f"| {r['id']} | {r['pattern']} | {r['mode']} | {r['turns']} | "
            f"{r['in_per_turn']:.0f} | {r['out_per_turn']:.0f} | "
            f"{r['cache_hit_pct']:.1f}% | ${r['cost_per_q']:.4f} | ${r['monthly']:,.0f} |"
        )

    lines.append("\n## Ratio rows\n")
    for pattern in ("paper", "eie"):
        a = next(
            (r for r in rows if r["pattern"] == pattern and r["mode"] == "status_only"),
            None,
        )
        b = next(
            (r for r in rows if r["pattern"] == pattern and r["mode"] == "key_fields"),
            None,
        )
        c = next(
            (r for r in rows if r["pattern"] == pattern and r["mode"] == "freeform"),
            None,
        )
        if a and b and c and a["cost_per_q"] > 0 and b["cost_per_q"] > 0:
            lines.append(
                f"- **Pattern {pattern} — C/A ratio (paper's headline lever):**"
                f" {c['cost_per_q'] / a['cost_per_q']:.2f}×"
            )
            lines.append(
                f"- **Pattern {pattern} — C/B ratio (realistic production lever):**"
                f" {c['cost_per_q'] / b['cost_per_q']:.2f}×"
            )

    lines.append("\n## Findings\n")
    lines.append(
        "- (Drafted by hand after a real run; this report builder leaves the"
        " findings section empty so the analyst writes from the observed numbers.)\n"
    )

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines))
    return out
