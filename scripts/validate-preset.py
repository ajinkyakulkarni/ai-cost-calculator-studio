#!/usr/bin/env python3
"""validate-preset.py — closed-loop comparison of a calculator preset
against a real bench trace.

This is the script that answers the question the rest of the project
exists to answer: *do the numbers on calc.ajinkya.ai match what the
real OpenAI API charges for the same workload?*

Inputs:
  --preset    path to a preset workload JSON (e.g. public/examples/nasa-eie.json)
  --trace     path to a bench trace JSON (produced by `agent-cost-bench run`)
  --model     which model the calculator should price against (default:
              the preset's `defaults.model`; override when the bench run
              used a different model than the preset specifies)

Output: a Markdown variance report at reports/<preset>-validation.md
that puts the calculator's predicted per-query cost next to the bench's
measured per-query cost, with deltas for each contributing layer
(input tokens, output tokens, cache rate, tool overhead, dollar total).

Methodology:
  1. Parse the trace to get measured per-query input/output tokens,
     cache hits, cost, and tool-loop iterations.
  2. Run scripts/calc.js with --preset <slug> --model <model> --json
     to get the calculator's predicted per-query cost for the same
     model (the calc.js CLI is the same arithmetic as the live site).
  3. Diff line-by-line; flag any coefficient off by more than ±15%.

Usage:
  python scripts/validate-preset.py \
      --preset public/examples/nasa-eie.json \
      --trace bench/reports/eie-react-2026-05-11T*.json
"""

from __future__ import annotations

import argparse
import glob
import json
import subprocess
import sys
from pathlib import Path

# Requires: PyYAML (for parsing bench scenario YAML to recover the
# scenario's turns × repeats count). Install via `pip install pyyaml`
# if not already present in the env that runs this script.


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def load_trace(path: Path) -> dict:
    with path.open() as f:
        return json.load(f)


def measure_from_trace(trace: dict, scenario_yaml: Path | None = None) -> dict:
    """Extract per-query measurements from a bench trace.

    Real trace schema (from `agent-cost-bench run`):
      trace.calls = list of OTEL CLIENT spans, each with
        attributes['gen_ai.usage.input_tokens', '.output_tokens',
                    '.request.model', '.response.id', ...]
      trace.session_totals = pre-aggregated input/output/cached tokens.

    OTEL spans don't carry `turn_index` or `cost_usd`. To get a
    per-query mean, we divide totals by the scenario's effective
    query count: `turns × repeat` (from the scenario YAML).
    """
    calls = trace.get("calls") or []
    totals = trace.get("session_totals") or {}
    if not calls and not totals:
        raise RuntimeError(
            "Trace has neither `calls` nor `session_totals` — bench may "
            "have written a different schema than this validator expects."
        )

    # Determine effective query count. n_queries=1 silently turns every
    # "per-query" number in the report into the whole trace's aggregate,
    # which produces wildly wrong variance (off by the actual turn×repeat
    # count). So if we can't find the scenario YAML, fail hard rather
    # than emit a misleading report.
    scenario_meta: dict = {}
    if not scenario_yaml or not scenario_yaml.exists():
        raise RuntimeError(
            f"Scenario YAML not found at {scenario_yaml}. Per-query "
            "variance requires knowing the scenario's turns×repeats "
            "count. Pass --scenario explicitly, or place the YAML at "
            "bench/scenarios/<name>.yml matching the trace filename."
        )
    try:
        import yaml
    except ImportError:
        raise RuntimeError(
            "PyYAML not installed. Run `pip install pyyaml` (or add to "
            "your project's requirements) so the validator can parse "
            "bench scenario YAML."
        )
    try:
        scn = yaml.safe_load(scenario_yaml.read_text())
        n_turns = len(scn.get("turns", []) or [])
        n_repeat = int(scn.get("repeat", 1) or 1)
        n_queries = max(1, n_turns * n_repeat)
        scenario_meta = {
            "turns_per_session": n_turns,
            "repeats": n_repeat,
            "total_queries": n_queries,
            "scenario_name": scn.get("name"),
        }
    except Exception as e:
        raise RuntimeError(
            f"Failed to parse scenario YAML {scenario_yaml}: {e}. "
            "Cannot compute per-query variance without it."
        ) from e

    total_input = int(totals.get("input_tokens") or 0)
    total_output = int(totals.get("output_tokens") or 0)
    total_cached = int(totals.get("cached_tokens") or 0)
    n_llm_calls = int(totals.get("calls") or len(calls))

    # Mean per-query (per user turn). LLM calls per turn includes the
    # initial reasoning call + any tool-loop iterations; we surface
    # that ratio as a separate signal because it's a real cost driver
    # the calculator's anchor_query doesn't model directly.
    per_query_input = total_input / n_queries
    per_query_output = total_output / n_queries
    per_query_cached = total_cached / n_queries
    cache_hit_rate = total_cached / total_input if total_input > 0 else 0.0
    llm_calls_per_query = n_llm_calls / n_queries

    # Model is in the first call's attributes (OTEL semconv).
    model_used = "?"
    if calls:
        model_used = (
            calls[0].get("attributes", {}).get("gen_ai.request.model")
            or "?"
        )

    return {
        **scenario_meta,
        "n_llm_calls": n_llm_calls,
        "n_queries": n_queries,
        "per_query_input_tokens": per_query_input,
        "per_query_output_tokens": per_query_output,
        "per_query_cached_tokens": per_query_cached,
        "cache_hit_rate": cache_hit_rate,
        "llm_calls_per_query": llm_calls_per_query,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "model_used": model_used,
    }


def predict_from_calculator_with_overrides(
    preset_path: Path,
    model: str | None,
    input_tok: int | None,
    output_tok: int | None,
    cache_rate: float | None,
) -> dict:
    """Like predict_from_calculator but feeds calc.js overrides.

    Used to ask: "if the calculator were given the MEASURED token
    shape and cache rate, what would it predict?" — separating
    formula-error from input-error in the variance.
    """
    slug = preset_path.stem
    cmd = ["node", str(ROOT / "scripts" / "calc.js"), "--preset", slug, "--json"]
    if model:
        cmd.extend(["--model", model])
    if input_tok is not None:
        cmd.extend(["--input-tok", str(int(input_tok))])
    if output_tok is not None:
        cmd.extend(["--output-tok", str(int(output_tok))])
    if cache_rate is not None:
        cmd.extend(["--cache", f"{cache_rate:.4f}"])
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, cwd=ROOT,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"calc.js failed (exit {e.returncode}): {e.stderr.strip()}"
        ) from e
    j = json.loads(result.stdout)
    return {
        "per_query_cost_usd": j.get("derived", {}).get("per_query_blended", 0.0),
        "queries_per_month": j.get("derived", {}).get("queries_per_month", 0),
        "headline_monthly_usd": j.get("headline", {}).get("monthly", 0.0),
    }


def predict_from_calculator(preset_path: Path, model: str | None,
                            n_turns: int | None = None) -> dict:
    """Run scripts/calc.js to get the calculator's prediction.

    calc.js is the standalone Node CLI we built that mirrors the live
    site's renderPreview() arithmetic exactly. By using it (rather
    than reimplementing the math here) we guarantee the comparison
    target is the same number the user sees on calc.ajinkya.ai.
    """
    slug = preset_path.stem  # e.g. "nasa-eie"
    cmd = [
        "node",
        str(ROOT / "scripts" / "calc.js"),
        "--preset", slug,
        "--json",
    ]
    if model:
        cmd.extend(["--model", model])
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True, cwd=ROOT,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"calc.js failed (exit {e.returncode}): {e.stderr.strip()}"
        ) from e

    j = json.loads(result.stdout)
    # calc.js --json schema:
    #   derived.queries_per_month, derived.api_with_retry,
    #   derived.per_query_blended (post-retry, post-hosting-multiplier)
    #   headline.monthly, headline.per_query
    queries = j.get("derived", {}).get("queries_per_month", 0)
    headline = j.get("headline", {}).get("monthly", 0.0)
    api_with_retry = j.get("derived", {}).get("api_with_retry", 0.0)
    per_query_blended = j.get("derived", {}).get("per_query_blended", 0.0)
    # Per-query input/output from the workload anchor_query, which is
    # what the simulator feeds into the engine. These are the "what the
    # calculator THINKS each query costs in tokens" numbers.
    with preset_path.open() as f:
        w = json.load(f)
    anchor = w.get("anchor_query", {})
    # Cache rate: paper Eq. (2) says
    #     r_eff(q) = clamp(baseline + 0.01 * (q - 6), 0.50, 0.94)
    # where q is the session turn count. The bench may run any number
    # of turns, so an apples-to-apples comparison needs the predicted
    # rate AT the bench's turn count, not the baseline (which is fit at
    # q=6). Without this correction the validator off-by-ones the rate
    # by 0.01 * (n_turns - 6) and produces false positives on the cache
    # variance check when the gap exceeds 15% of baseline.
    baseline = anchor.get("cache_rate_baseline", 0.0)
    if n_turns is not None and n_turns > 0:
        cache_predicted = max(0.50, min(0.94, baseline + 0.01 * (n_turns - 6)))
    else:
        cache_predicted = baseline
    return {
        "queries_per_month": queries,
        "headline_monthly_usd": headline,
        "api_monthly_capped_usd": api_with_retry,
        # LLM-only per-query (apples-to-apples with bench's LLM spend;
        # the bench measures provider API charges, not the calculator's
        # full headline which folds in verification + federal + fixed).
        "per_query_cost_usd": per_query_blended,
        "per_query_input_tokens": anchor.get("input_tokens", 0),
        "per_query_output_tokens": anchor.get("output_tokens", 0),
        "cache_hit_rate": cache_predicted,
        "cache_hit_rate_baseline": baseline,
        "n_turns_used_for_cache": n_turns,
        "model_predicted": w.get("defaults", {}).get("model", "?"),
    }


def variance_row(label: str, predicted: float, actual: float, unit: str = "") -> dict:
    """Compute a single variance row + flag if >15%."""
    delta = actual - predicted
    pct = (delta / predicted * 100) if predicted != 0 else float("inf")
    flag = "⚠️" if abs(pct) > 15 or (predicted == 0 and actual != 0) else "✓"
    return {
        "label": label,
        "predicted": predicted,
        "actual": actual,
        "delta": delta,
        "pct": pct,
        "unit": unit,
        "flag": flag,
    }


def render_markdown(
    preset_name: str,
    predicted: dict,
    measured: dict,
    refit: dict | None = None,
) -> str:
    """Build the human-readable variance report.

    We compare the **coefficients** the calculator uses (per-query
    input/output tokens, cache hit rate) against what the real API
    actually returned. We do not compare dollar totals directly
    because the bench trace doesn't store per-call cost — but if all
    three coefficients agree within ±15%, the calculator's dollar
    prediction is structurally correct by construction.
    """
    rows = [
        variance_row(
            "per_query_input_tokens",
            predicted["per_query_input_tokens"],
            measured["per_query_input_tokens"],
            "tok",
        ),
        variance_row(
            "per_query_output_tokens",
            predicted["per_query_output_tokens"],
            measured["per_query_output_tokens"],
            "tok",
        ),
        variance_row(
            "cache_hit_rate",
            predicted["cache_hit_rate"],
            measured["cache_hit_rate"],
            "0-1",
        ),
    ]
    n_flagged = sum(1 for r in rows if r["flag"] == "⚠️")

    def fmt_val(v: float, unit: str) -> str:
        if unit == "USD":
            return f"${v:.4f}"
        if unit == "tok":
            return f"{v:,.0f}"
        if unit == "0-1":
            return f"{v:.3f}"
        return f"{v:g}"

    # Compute the bench's true API spend per query from measured tokens
    # + the model's rate card (pulled fresh via calc.js). This is the
    # number OpenAI would have actually billed for the measured workload.
    bench_actual_per_query = None
    if refit is not None:
        # refit was computed by feeding measured tokens into calc.js,
        # so its per_query_blended IS the bench's true API cost per
        # query (within the precision of the rate card).
        bench_actual_per_query = refit.get("per_query_cost_usd")

    lines = []
    lines.append(f"# Validation report: `{preset_name}`")
    lines.append("")
    sample = (
        f"**Sample**: {measured['n_queries']} queries "
        f"({measured.get('turns_per_session', '?')} turns × "
        f"{measured.get('repeats', '?')} repeats) "
        f"across {measured['n_llm_calls']} LLM calls "
        f"on model `{measured['model_used']}`"
    )
    lines.append(sample)
    lines.append("")
    lines.append(
        f"**Calculator prediction** uses preset `{preset_name}` "
        f"with model `{predicted['model_predicted']}` via "
        f"`scripts/calc.js --preset {preset_name} --json`. "
        f"Per-query cost prediction: ${predicted['per_query_cost_usd']:.4f}."
    )
    lines.append("")
    lines.append("## Coefficient variance")
    lines.append("")
    lines.append("| Coefficient | Predicted | Measured | Δ | Δ% | Flag |")
    lines.append("|---|---:|---:|---:|---:|:---:|")
    for r in rows:
        if r["unit"] == "0-1":
            delta_str = f"{r['delta']:+.3f}"
        else:
            delta_str = fmt_val(r['delta'], r['unit'])
        lines.append(
            f"| `{r['label']}` "
            f"| {fmt_val(r['predicted'], r['unit'])} "
            f"| {fmt_val(r['actual'], r['unit'])} "
            f"| {delta_str} "
            f"| {r['pct']:+.1f}% "
            f"| {r['flag']} |"
        )
    lines.append("")
    if refit is not None:
        lines.append("## Per-query cost: formula vs inputs")
        lines.append("")
        lines.append(
            "Three numbers separate **formula error** from **input error**:"
        )
        lines.append("")
        lines.append("| Scenario | $ / query | Notes |")
        lines.append("|---|---:|---|")
        lines.append(
            f"| **Calculator with preset's `anchor_query`** "
            f"| ${predicted['per_query_cost_usd']:.4f} "
            f"| What calc.ajinkya.ai shows today for this preset. |"
        )
        lines.append(
            f"| **Calculator re-fit to MEASURED tokens + cache** "
            f"| ${refit['per_query_cost_usd']:.4f} "
            f"| Same engine math, but fed the real per-query input/output/cache. |"
        )
        lines.append("")
        ratio_drift = (
            predicted["per_query_cost_usd"] / refit["per_query_cost_usd"]
            if refit["per_query_cost_usd"] > 0
            else float("inf")
        )
        lines.append(
            f"If the calculator's math is structurally correct, the gap between "
            f"these two rows reflects only the preset's mis-calibrated input shape "
            f"({ratio_drift:.1f}× in this run). To make the headline match reality, "
            f"recalibrate `anchor_query.input_tokens` / `.output_tokens` / "
            f"`.cache_rate_baseline` in `public/examples/{preset_name}.json` to the "
            f"measured values above."
        )
        lines.append("")
    lines.append("## Tool-loop overhead")
    lines.append("")
    lines.append(
        f"LLM calls per user turn (measured): **{measured['llm_calls_per_query']:.2f}**. "
        "A value above 1.0 means the agent ran tool-loop iterations on top of "
        "the initial reasoning call. The calculator's `anchor_query.input_tokens` "
        "is expected to already roll the tool-result tokens into its number, "
        "so an inflated per-query input above probably reflects a real "
        "tool overhead the preset's anchor doesn't capture."
    )
    lines.append("")
    if n_flagged == 0:
        lines.append(
            "✅ **All coefficients within ±15%** — the calculator's per-query "
            "cost prediction for this preset is structurally consistent with "
            "measured API behavior."
        )
    else:
        lines.append(
            f"⚠️ **{n_flagged}/{len(rows)} coefficient(s) off by more than ±15%.** "
            "The calculator's per-query dollar prediction is therefore off by "
            "roughly the compounded delta. Recalibrate the preset's "
            "`anchor_query` block (input/output token shape, cache rate "
            "baseline) to match real API behavior, then re-run."
        )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--preset", required=True, type=Path, help="Preset JSON path")
    ap.add_argument(
        "--trace",
        required=True,
        help="Bench trace JSON path (glob supported — latest match is used)",
    )
    ap.add_argument(
        "--model",
        help="Override model used for calculator prediction (default: preset's defaults.model)",
    )
    ap.add_argument(
        "--scenario",
        type=Path,
        help=(
            "Scenario YAML used for the run (default: infer from preset slug, "
            "e.g. bench/scenarios/<preset>-react.yml or any matching name)"
        ),
    )
    ap.add_argument(
        "--output",
        type=Path,
        help="Output Markdown path (default: bench/reports/<preset>-validation.md)",
    )
    args = ap.parse_args()

    if not args.preset.exists():
        sys.stderr.write(f"Preset not found: {args.preset}\n")
        return 1

    # Resolve glob if needed; take the latest by mtime.
    candidates = sorted(glob.glob(args.trace))
    if not candidates:
        sys.stderr.write(f"No trace files matched: {args.trace}\n")
        return 1
    trace_path = Path(candidates[-1])

    # Resolve scenario YAML so we can compute per-query means correctly.
    # Heuristic: take it from the trace's scenario_name (if available) or
    # the trace filename (e.g. eie-react-2026-...-trace.json → eie-react).
    trace = load_trace(trace_path)
    scenario_yaml = args.scenario
    if scenario_yaml is None:
        # Try: trace.scenario.config.name (newer bench format), then file name stem.
        scn_name = (
            (trace.get("scenario") or {}).get("config", {}).get("name")
            if isinstance(trace.get("scenario"), dict)
            else trace.get("scenario")
        )
        if not scn_name:
            # Filename pattern: <scn>-<timestamp>-trace.json
            stem = trace_path.stem
            scn_name = stem.split("-2026")[0] if "-2026" in stem else stem
        scenario_yaml = ROOT / "bench" / "scenarios" / f"{scn_name}.yml"

    measured = measure_from_trace(trace, scenario_yaml)
    predicted = predict_from_calculator(
        args.preset, args.model,
        n_turns=measured.get("turns_per_session"),
    )
    # Second prediction: feed measured tokens + cache back into the
    # calculator. If THIS dollar number matches the bench's true cost,
    # the calculator's math is correct and only the preset's
    # anchor_query inputs are miscalibrated.
    refit = predict_from_calculator_with_overrides(
        args.preset,
        args.model,
        input_tok=int(round(measured["per_query_input_tokens"])),
        output_tok=int(round(measured["per_query_output_tokens"])),
        cache_rate=measured["cache_hit_rate"],
    )

    out_path = args.output or (
        ROOT / "bench" / "reports" / f"{args.preset.stem}-validation.md"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        render_markdown(args.preset.stem, predicted, measured, refit)
    )

    print(f"Validation report → {out_path}")
    print()
    # Also echo the table to stdout so the user sees it in their terminal.
    print(out_path.read_text())
    return 0


if __name__ == "__main__":
    sys.exit(main())
