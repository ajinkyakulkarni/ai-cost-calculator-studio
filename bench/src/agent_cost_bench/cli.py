"""CLI entry point — `agent-cost-bench run|compare|estimate <args>`."""

from __future__ import annotations

import json
import os
from pathlib import Path

import typer
from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table

from .compare import compute_variance
from .runner import run_scenario
from .scenario import config_hash, load_scenario

# Load .env from the current working directory or the bench project
# root so users don't have to `export` every key. Real env vars take
# precedence over the file.
_dotenv_search = [Path.cwd() / ".env", Path(__file__).resolve().parents[3] / ".env"]
for _p in _dotenv_search:
    if _p.is_file():
        load_dotenv(_p, override=False)
        break

app = typer.Typer(
    help="Production-shaped benchmark harness for multi-agent LLM systems.",
    rich_markup_mode="rich",
    add_completion=False,
)

console = Console()

DEFAULT_REPORTS_DIR = Path("reports")


@app.command()
def run(
    scenario_path: Path = typer.Argument(..., help="Path to scenario YAML file"),
    output_dir: Path = typer.Option(
        DEFAULT_REPORTS_DIR, "--output", "-o", help="Where to write trace artifacts"
    ),
    skip_estimate: bool = typer.Option(
        False, "--yes", "-y", help="Skip cost estimate confirmation prompt"
    ),
    max_cost_usd: float | None = typer.Option(
        None,
        "--max-cost-usd",
        help="Override the scenario's max_cost_usd cap (USD)",
    ),
):
    """Run a scenario end-to-end against real LLM APIs and capture a trace."""
    scenario = load_scenario(scenario_path)
    if max_cost_usd is not None:
        scenario.max_cost_usd = max_cost_usd

    # Print the configuration upfront so the user sees what's about to
    # consume their API budget.
    console.rule(f"[bold cyan]Scenario: {scenario.name}")
    console.print(f"[dim]{scenario.description}[/dim]")
    console.print()

    table = Table(title="Configuration", show_header=True, header_style="bold")
    table.add_column("Field")
    table.add_column("Value")
    table.add_row("topology", scenario.topology)
    table.add_row("agents", str(len(scenario.agents)))
    table.add_row("turns", str(len(scenario.turns)))
    table.add_row("repeat", str(scenario.repeat))
    table.add_row("max_cost_usd", f"${scenario.max_cost_usd:.2f}")
    table.add_row("config_hash", config_hash(scenario)[:24] + "…")
    console.print(table)

    if not skip_estimate:
        rough = _rough_cost_estimate(scenario)
        console.print(
            f"\n[yellow]Estimated cost:[/yellow] ~${rough:.2f} "
            f"(rough — actual depends on caching + provider pricing)"
        )
        if not typer.confirm("Run scenario?", default=True):
            raise typer.Abort()

    console.print(f"\n[bold]Running...[/bold] (max_cost_usd: ${scenario.max_cost_usd:.2f})")
    try:
        trace_path = run_scenario(scenario, output_dir=output_dir)
    except Exception as e:
        console.print(f"[red]Run failed:[/red] {e}")
        raise

    console.print(f"\n[green]✓[/green] Trace written to: [bold]{trace_path}[/bold]")
    _print_session_summary(trace_path)


@app.command()
def compare(
    trace_path: Path = typer.Argument(..., help="Path to trace.json from a previous run"),
    simulator_export: Path = typer.Option(
        ...,
        "--simulator-export",
        "-s",
        help="Path to scenario JSON exported from calc.ajinkya.ai",
    ),
    output: Path | None = typer.Option(
        None, "--output", "-o", help="Where to write variance report (default: stdout)"
    ),
):
    """Compare an actual trace against cost simulator predictions."""
    report = compute_variance(trace_path, simulator_export)

    md = report.to_markdown()
    console.print(md)

    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(md)
        # Also write the JSON sibling for programmatic consumption.
        json_path = output.with_suffix(".json")
        json_path.write_text(json.dumps(report.to_dict(), indent=2))
        console.print(f"\n[green]✓[/green] Variance report written to: [bold]{output}[/bold]")
        console.print(f"   JSON: [bold]{json_path}[/bold]")


@app.command()
def estimate(
    scenario_path: Path = typer.Argument(..., help="Path to scenario YAML file"),
):
    """Print a rough cost estimate without running anything."""
    scenario = load_scenario(scenario_path)
    rough = _rough_cost_estimate(scenario)
    console.print(f"Rough estimate for [bold]{scenario.name}[/bold]: ~${rough:.2f}")
    console.print("[dim]Actual cost depends on cache hits + tool execution overhead.[/dim]")


def _rough_cost_estimate(scenario) -> float:
    """Crude pre-flight cost estimate — assumes ~5K input + ~500 output
    tokens per turn at gpt-5.2-ish rates. Used only for the
    confirmation prompt; actuals are recorded post-run."""
    total = 0.0
    for agent in scenario.agents:
        # Per-turn cost: input + output × rate. Input partly cached
        # after the first turn, but we ignore that for the estimate
        # (overstate is safer than understate for a budget prompt).
        # Substring matching on model names is intentional and
        # acceptable here: this is a back-of-envelope estimate shown
        # in a confirmation prompt, not the cost that gets charged.
        # The trace-side comparator uses LiteLLM's per-call billed
        # cost (response_cost) for anything authoritative.
        rate_in = 5.0  # $/M input  (premium-tier default)
        rate_out = 15.0  # $/M output
        m = agent.model.lower()
        if "haiku" in m:
            rate_in, rate_out = 0.8, 4.0
        elif "mini" in m or "flash" in m or "nano" in m:
            rate_in, rate_out = 0.15, 0.60
        per_turn = (5000 / 1e6) * rate_in + (500 / 1e6) * rate_out
        total += per_turn * len(scenario.turns) * scenario.repeat
    return total


def _print_session_summary(trace_path: Path) -> None:
    """Pretty-print session totals from a trace artifact."""
    artifact = json.loads(trace_path.read_text())
    totals = artifact["session_totals"]

    table = Table(title="Session totals", show_header=True, header_style="bold")
    table.add_column("Metric")
    table.add_column("Value", justify="right")
    table.add_row("calls", f"{totals['calls']:,}")
    table.add_row("input_tokens", f"{totals['input_tokens']:,}")
    table.add_row("output_tokens", f"{totals['output_tokens']:,}")
    table.add_row("cached_tokens", f"{totals['cached_tokens']:,}")
    if totals["input_tokens"]:
        cache_rate = totals["cached_tokens"] / totals["input_tokens"]
        table.add_row("cache_hit_rate", f"{cache_rate:.2%}")
    console.print()
    console.print(table)


from dataclasses import replace as _dataclass_replace

from .eie.runner import run_scenario as run_eie_scenario  # noqa: F401  (module-level for patching)
from .eie.scenario_loader import load_scenario as _load_eie_scenario

_EIE_SCENARIO_DIR = Path(__file__).resolve().parent.parent.parent / "scenarios" / "eie-templating"


@app.command(name="run-eie-templating")
def run_eie_templating(
    scenario: str = typer.Option(
        "all",
        help="Scenario id (e.g. pattern-paper-status-only), or 'all' to run all 6.",
    ),
    model: str = typer.Option(
        "",
        help="Override the model in every scenario (e.g. gpt-5.2, claude-sonnet-4-6).",
    ),
) -> None:
    """Run the eie-templating bench: 6 scenarios = 2 patterns × 3 handler modes.

    Each run writes a trace JSON under bench/reports/eie-templating/.
    Use `agent-cost-bench report-eie-templating` afterwards to emit
    the comparison Markdown summary.
    """
    if scenario == "all":
        ids = [p.stem for p in sorted(_EIE_SCENARIO_DIR.glob("*.yml"))]
    else:
        ids = [scenario]

    for sid in ids:
        cfg = _load_eie_scenario(_EIE_SCENARIO_DIR / f"{sid}.yml")
        if model:
            cfg = _dataclass_replace(cfg, model=model)
        console.print(f"[cyan]Running:[/] {sid}  ({cfg.pattern} × {cfg.handler_mode} on {cfg.model})")
        out_path = run_eie_scenario(cfg)
        console.print(f"[green]Wrote:[/] {out_path}")

    console.print(
        f"\n[bold]{len(ids)} scenario(s) complete.[/] "
        "Now run `agent-cost-bench report-eie-templating` to emit the summary."
    )


def main() -> None:
    """Console-script entry point referenced by pyproject.toml."""
    app()


if __name__ == "__main__":
    main()
