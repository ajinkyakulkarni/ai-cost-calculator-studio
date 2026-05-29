"""Emit the 1-page Markdown comparison report from 6 trace JSONs.

Reads all *.trace.json files from bench/reports/geo-qa-templating/,
groups by scenario_id, picks the latest trace per scenario, builds
a comparison table, and computes the two key ratio rows (C/A, C/B)
for each conversation pattern.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REPORTS_DIR = Path(__file__).resolve().parents[3] / "reports" / "geo-qa-templating"

# One durable, descriptively-named report (not date-stamped) so regenerating
# overwrites the same file rather than littering one per day. The run date is
# kept as a heading inside the document.
REPORT_FILENAME = "geo-qa-templating-bench-report.md"

_FINDINGS_PLACEHOLDER_MARKER = "this report builder leaves the"

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


def _latest_traces() -> dict[tuple[str, bool, bool], dict]:
    """Map (scenario_id, enforce_compute_stats, emit_map) → latest trace dict.

    Natural, forced, and map variants of the same scenario_id are kept as
    separate entries so the report can show all three.  Old traces without
    ``enforce_compute_stats`` or ``emit_map`` fields are treated as False.
    """
    by_key: dict[tuple[str, bool, bool], tuple[float, dict]] = {}
    for p in REPORTS_DIR.glob("*.trace.json"):
        try:
            with p.open() as f:
                t = json.load(f)
            mtime = p.stat().st_mtime
            sid = t["scenario_id"]
            forced = bool(t.get("enforce_compute_stats", False))
            with_map = bool(t.get("emit_map", False))
            key = (sid, forced, with_map)
            if key not in by_key or mtime > by_key[key][0]:
                by_key[key] = (mtime, t)
        except (json.JSONDecodeError, KeyError, ValueError):
            continue
    return {key: t for key, (_, t) in by_key.items()}


def _existing_findings_block(out: Path) -> str | None:
    """Return the hand-written '## Findings' section from an existing report.

    Regenerating the report rebuilds the tables from the latest traces, but a
    human writes the findings by hand. Preserve that section across regens so
    the analysis isn't clobbered. Returns None if the file is absent or the
    findings are still the auto-generated placeholder.
    """
    if not out.exists():
        return None
    text = out.read_text()
    idx = text.find("## Findings")
    if idx == -1:
        return None
    block = text[idx:].rstrip()
    if _FINDINGS_PLACEHOLDER_MARKER in block:
        return None
    return block


def emit_report() -> Path:
    """Build the comparison Markdown and write it to REPORTS_DIR."""
    traces = _latest_traces()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = REPORTS_DIR / REPORT_FILENAME
    preserved_findings = _existing_findings_block(out)

    rows: list[dict] = []
    for (sid, forced, with_map), t in traces.items():
        cost = _cost_per_query(t)
        rows.append({
            "id": sid,
            "pattern": t["pattern"],
            "mode": t["handler_mode"],
            "forced": forced,
            "with_map": with_map,
            "turns": t["turn_count"],
            "in_per_turn": t["per_turn_avg"]["input_tokens"],
            "out_per_turn": t["per_turn_avg"]["output_tokens"],
            "cache_hit_pct": t["totals"]["cache_hit_rate"] * 100,
            "cost_per_q": cost,
            "monthly": cost * MONTHLY_QUERIES,
        })
    rows.sort(key=lambda r: (r["pattern"], r["mode"], r["forced"], r["with_map"]))

    lines: list[str] = []
    lines.append(f"# geo-qa-templating bench summary — {ts}\n")
    lines.append("## Per-scenario results\n")
    lines.append(
        "| scenario | pattern | mode | forced | map | turns | tok/turn (in) | tok/turn (out)"
        " | cache hit % | $/query | $/month @ 915K |"
    )
    lines.append("|---|---|---|---|---|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        forced_label = "Y" if r["forced"] else "N"
        map_label = "Y" if r["with_map"] else "N"
        lines.append(
            f"| {r['id']} | {r['pattern']} | {r['mode']} | {forced_label} | {map_label} | {r['turns']} | "
            f"{r['in_per_turn']:.0f} | {r['out_per_turn']:.0f} | "
            f"{r['cache_hit_pct']:.1f}% | ${r['cost_per_q']:.4f} | ${r['monthly']:,.0f} |"
        )

    lines.append("\n## Ratio rows\n")
    # Ratio rows use only the base (no-map) runs to preserve comparability.
    for pattern in ("paper", "gated"):
        for forced in (False, True):
            variant_label = "forced" if forced else "natural"
            a = next(
                (r for r in rows
                 if r["pattern"] == pattern and r["mode"] == "status_only"
                 and r["forced"] == forced and not r["with_map"]),
                None,
            )
            b = next(
                (r for r in rows
                 if r["pattern"] == pattern and r["mode"] == "key_fields"
                 and r["forced"] == forced and not r["with_map"]),
                None,
            )
            c = next(
                (r for r in rows
                 if r["pattern"] == pattern and r["mode"] == "freeform"
                 and r["forced"] == forced and not r["with_map"]),
                None,
            )
            if a and b and c and a["cost_per_q"] > 0 and b["cost_per_q"] > 0:
                lines.append(
                    f"- **Pattern {pattern} ({variant_label}) — C/A ratio (paper's headline lever):**"
                    f" {c['cost_per_q'] / a['cost_per_q']:.2f}×"
                )
                lines.append(
                    f"- **Pattern {pattern} ({variant_label}) — C/B ratio (realistic production lever):**"
                    f" {c['cost_per_q'] / b['cost_per_q']:.2f}×"
                )

    if preserved_findings:
        lines.append("\n" + preserved_findings + "\n")
    else:
        lines.append("\n## Findings\n")
        lines.append(
            "- (Drafted by hand after a real run; this report builder leaves the"
            " findings section empty so the analyst writes from the observed numbers.)\n"
        )

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines))
    return out
