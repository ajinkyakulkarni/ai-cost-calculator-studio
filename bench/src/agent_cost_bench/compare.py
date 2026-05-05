"""Variance comparator — actual trace vs simulator predictions.

Reads two artifacts:
  1. trace.json   — produced by `run_scenario()`, contains per-call
                     OTEL spans + session totals
  2. simulator-export.json
                  — exported from calc.ajinkya.ai (the "Export JSON"
                     button in the appbar). Contains the AXIOM
                     simulator's predicted token totals + cost.

Computes per-coefficient variance between the two and emits both a
human-readable Markdown report and a machine-readable JSON suitable
for feeding into a calibration update on the simulator side.

The coefficients we measure are the same ones AXIOM uses internally:
  - cache_hit_rate         (predicted vs measured, from cached_tokens/input_tokens)
  - sysprompt_tokens       (predicted vs measured, from first-turn input_tokens)
  - retry_rate             (predicted vs measured, from error count / total calls)
  - per_turn_input_tokens  (predicted vs measured, mean across turns)
  - per_turn_output_tokens (predicted vs measured, mean across turns)
  - cost_per_session       (predicted vs measured, dollar amount)

When variance |delta| / predicted exceeds 15% on any coefficient,
the report flags it for calibration review.
"""

from __future__ import annotations

import json
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class Variance:
    """Per-coefficient comparison row."""

    name: str
    predicted: float
    actual: float
    unit: str = ""

    @property
    def delta(self) -> float:
        return self.actual - self.predicted

    @property
    def relative_pct(self) -> float:
        if self.predicted == 0:
            return 0.0 if self.actual == 0 else float("inf")
        return (self.delta / self.predicted) * 100

    @property
    def needs_calibration(self) -> bool:
        return abs(self.relative_pct) > 15


@dataclass
class VarianceReport:
    scenario: str
    sample_size: int
    rows: list[Variance] = field(default_factory=list)

    def add(self, name: str, predicted: float, actual: float, unit: str = "") -> None:
        self.rows.append(Variance(name=name, predicted=predicted, actual=actual, unit=unit))

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "sample_size": self.sample_size,
            "coefficients": {
                r.name: {
                    "predicted": r.predicted,
                    "actual": r.actual,
                    "delta": r.delta,
                    "relative_pct": round(r.relative_pct, 2),
                    "unit": r.unit,
                    "needs_calibration": r.needs_calibration,
                }
                for r in self.rows
            },
            "summary": {
                "rows_off_by_>15pct": sum(1 for r in self.rows if r.needs_calibration),
                "total_rows": len(self.rows),
            },
        }

    def to_markdown(self) -> str:
        lines = [
            f"# Variance report: `{self.scenario}`",
            "",
            f"**Sample size:** {self.sample_size} call(s)",
            "",
            "| Coefficient | Predicted | Actual | Δ | Δ% | Calibrate? |",
            "|---|---:|---:|---:|---:|:---:|",
        ]
        for r in self.rows:
            flag = "⚠️" if r.needs_calibration else "✓"
            lines.append(
                f"| `{r.name}` "
                f"| {_fmt(r.predicted)} {r.unit} "
                f"| {_fmt(r.actual)} {r.unit} "
                f"| {_fmt(r.delta, signed=True)} "
                f"| {r.relative_pct:+.1f}% "
                f"| {flag} |"
            )
        lines.append("")
        n_off = sum(1 for r in self.rows if r.needs_calibration)
        if n_off:
            lines.append(
                f"**{n_off}/{len(self.rows)}** coefficient(s) off by more than ±15%. "
                f"Consider updating defaults in the simulator's `coefficients.json`."
            )
        else:
            lines.append("All coefficients within ±15% of predictions ✓")
        return "\n".join(lines)


def _fmt(v: float, signed: bool = False) -> str:
    if v == 0:
        return "0"
    if abs(v) >= 1000:
        return f"{v:+,.0f}" if signed else f"{v:,.0f}"
    if abs(v) >= 1:
        return f"{v:+.2f}" if signed else f"{v:.2f}"
    return f"{v:+.4f}" if signed else f"{v:.4f}"


def compute_variance(
    trace_path: Path,
    simulator_export_path: Path,
) -> VarianceReport:
    """Compare a trace against AXIOM's predictions.

    The simulator export is the JSON output of calc.ajinkya.ai's
    "Export JSON" button — the same `workload` shape the calc edits
    in-browser. We pull AXIOM's per-session predictions out of it.
    """
    trace = json.loads(trace_path.read_text())
    sim = json.loads(simulator_export_path.read_text())

    calls = trace["calls"]
    totals = trace["session_totals"]

    # Actuals derived from the trace.
    n_calls = totals["calls"] or 1
    actual_input = totals["input_tokens"]
    actual_output = totals["output_tokens"]
    actual_cached = totals["cached_tokens"]
    actual_cache_hit = (actual_cached / actual_input) if actual_input else 0
    actual_per_turn_input = actual_input / n_calls
    actual_per_turn_output = actual_output / n_calls

    # Predictions extracted from the simulator export. The exact path
    # into the workload object depends on which AXIOM panel produced
    # the predictions — for v1 we read the calc's anchor_query +
    # cache_rate_baseline (these are the calc-side mirrors of AXIOM
    # globals, set in lockstep via the auto-sync we built earlier).
    anchor = sim.get("anchor_query", {})
    pred_input = anchor.get("input_tokens", 0)
    pred_output = anchor.get("output_tokens", 0)
    pred_cache_hit = anchor.get("cache_rate_baseline", 0)

    # Number of turns AXIOM expects per session. Used to scale the
    # per-turn predictions back up to session totals.
    pred_turns = anchor.get("session_baseline_turns", 1) or 1

    pred_session_input = pred_input * pred_turns
    pred_session_output = pred_output * pred_turns

    # Predicted cost: scenario.json doesn't store the AXIOM-computed
    # cost directly because it's derived live in the browser. As a
    # proxy we sum per-call costs from LiteLLM's pricing table.
    actual_cost = sum(
        c["attributes"].get("response_cost", 0)
        or _cost_from_call(c)
        for c in calls
    )

    report = VarianceReport(scenario=trace["scenario"], sample_size=n_calls)
    report.add("cache_hit_rate", pred_cache_hit, actual_cache_hit, unit="(0–1)")
    report.add("session_input_tokens", pred_session_input, actual_input, unit="tok")
    report.add("session_output_tokens", pred_session_output, actual_output, unit="tok")
    report.add("per_turn_input_tokens", pred_input, actual_per_turn_input, unit="tok")
    report.add("per_turn_output_tokens", pred_output, actual_per_turn_output, unit="tok")
    report.add("session_cost_usd", _predicted_cost(sim), actual_cost, unit="USD")

    # Latency stats — the simulator doesn't predict latency directly,
    # but it's still useful to surface for the report consumer.
    latencies = [c.get("duration_ms", 0) for c in calls if c.get("duration_ms")]
    if latencies:
        # No simulator counterpart, so we report observed-only as a
        # zero-predicted row.
        report.add("median_latency_ms", 0, statistics.median(latencies), unit="ms")

    return report


def _cost_from_call(call: dict[str, Any]) -> float:
    """Fallback per-call cost estimate when LiteLLM didn't fill it in.

    Crude rough estimate using $5/M input, $15/M output. Real cost
    comes from LiteLLM's pricing table — this is a safety net.
    """
    a = call.get("attributes", {})
    in_tok = a.get("gen_ai.usage.input_tokens", 0)
    out_tok = a.get("gen_ai.usage.output_tokens", 0)
    return (in_tok / 1e6) * 5 + (out_tok / 1e6) * 15


def _predicted_cost(sim: dict) -> float:
    """Pull AXIOM's predicted session cost from the simulator export.

    The export is the calc's full workload JSON. The headline monthly
    cost lives elsewhere in the export but session-level cost has to
    be reconstructed. For v1 we approximate from anchor_query + the
    baseline rates used by cost-engine.
    """
    # If the export already includes a derived field, use it.
    if "axiom_session_cost_usd" in sim:
        return float(sim["axiom_session_cost_usd"])

    # Otherwise, reconstruct from anchor_query + agent rate cards.
    anchor = sim.get("anchor_query", {})
    in_tok = anchor.get("input_tokens", 0)
    out_tok = anchor.get("output_tokens", 0)
    turns = anchor.get("session_baseline_turns", 1) or 1
    # Conservative blended rate — refine when scenario points at a
    # specific model.
    return (in_tok * turns / 1e6) * 5 + (out_tok * turns / 1e6) * 15
