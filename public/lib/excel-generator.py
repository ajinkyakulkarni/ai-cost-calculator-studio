#!/usr/bin/env python3
"""
Cost Calculator Studio — single-sheet Excel workbook generator.

Builds a ONE-sheet .xlsx that mirrors the web calculator UI: every
field from the workload spec is laid out as an editable cell, every
derived value is a live formula, and the headline + four-row
equal-budget comparison table sit at the bottom.

Editing any blue (input) cell anywhere on the sheet should recompute
the headline, exactly like dragging a slider on calc.ajinkya.ai.

Validation strategy: the three-way diff (JS engine + Python port +
this Excel sheet) should all produce the same headline for the same
workload. Divergences flag bugs in any one of the three
implementations.

Usage:
  python3 excel-generator.py examples/public-geospatial-qa.json -o calc.xlsx

Requires: openpyxl (pip install openpyxl). Standard library only otherwise.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side, NamedStyle
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.dimensions import ColumnDimension
    from openpyxl.formatting.rule import ColorScaleRule, CellIsRule, FormulaRule
    from openpyxl.chart import BarChart, LineChart, Reference
    from openpyxl.chart.label import DataLabelList
except ImportError:
    print("ERROR: openpyxl is required. Install with: pip install openpyxl", file=sys.stderr)
    sys.exit(1)


# ----- Editorial palette to match the HTML calculator -----
INK = "1A1A1A"
ACCENT = "8B2331"     # oxblood
ACCENT2 = "C87A52"    # warm copper (secondary)
GOOD = "2B7A3D"
BAD = "B8404A"
PAPER = "FBF9F4"
HIGHLIGHT = "F3ECDB"
HEATMAP_LO = "E8F4E8"  # pale green
HEATMAP_MID = "FFF4D6"  # cream
HEATMAP_HI = "F8D7DA"  # pale red
RULE = "D8D2C5"

THIN = Side(border_style="thin", color=RULE)
THICK = Side(border_style="medium", color=INK)


def style_header(cell, level: int = 1):
    """Section/column header styling."""
    if level == 1:
        cell.font = Font(name="Calibri", size=14, bold=True, color=ACCENT)
    elif level == 2:
        cell.font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
        cell.fill = PatternFill(start_color=INK, end_color=INK, fill_type="solid")
        cell.alignment = Alignment(horizontal="left", vertical="center")
    else:
        cell.font = Font(name="Calibri", size=10, bold=True, color="555555")
        cell.alignment = Alignment(horizontal="left", vertical="center")


def style_label(cell):
    cell.font = Font(name="Calibri", size=11, color=INK)


def style_input(cell):
    cell.font = Font(name="Consolas", size=11, color="0E5C8A", bold=True)
    cell.fill = PatternFill(start_color="EAF3F9", end_color="EAF3F9", fill_type="solid")
    cell.border = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def style_formula(cell):
    cell.font = Font(name="Consolas", size=11, color=INK)
    cell.fill = PatternFill(start_color=PAPER, end_color=PAPER, fill_type="solid")
    cell.border = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def style_result(cell):
    cell.font = Font(name="Consolas", size=12, bold=True, color=ACCENT)
    cell.fill = PatternFill(start_color=HIGHLIGHT, end_color=HIGHLIGHT, fill_type="solid")
    cell.border = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def autosize(ws, min_w=12, max_w=60):
    for col_idx, col in enumerate(ws.columns, start=1):
        try:
            longest = max(len(str(c.value)) for c in col if c.value is not None)
        except ValueError:
            longest = min_w
        ws.column_dimensions[get_column_letter(col_idx)].width = max(min_w, min(max_w, longest + 2))


# ============================================================
# Visual-polish helpers
# ============================================================

def fmt_usd(cell):
    """Apply $#,##0 number format."""
    cell.number_format = '"$"#,##0'


def fmt_usd_cents(cell):
    """Apply $#,##0.00 number format for small per-query values."""
    cell.number_format = '"$"#,##0.00'


def fmt_pct(cell):
    """Apply 0.0% number format."""
    cell.number_format = "0.0%"


def fmt_num(cell):
    """Apply #,##0 number format for query counts."""
    cell.number_format = "#,##0"


def freeze_below(ws, row, col=1):
    """Freeze rows above `row` and columns left of `col`."""
    ws.freeze_panes = ws.cell(row=row, column=col).coordinate


def heatmap_range(ws, range_str):
    """3-color scale heat-map (green → cream → red, lo → mid → hi)."""
    rule = ColorScaleRule(
        start_type='min', start_color=HEATMAP_LO,
        mid_type='percentile', mid_value=50, mid_color=HEATMAP_MID,
        end_type='max', end_color=HEATMAP_HI,
    )
    ws.conditional_formatting.add(range_str, rule)


def title_banner(ws, title: str, subtitle: str = "", cols: int = 6):
    """Top-of-sheet branded banner. Row 1 = title in ACCENT; row 2 = subtitle in muted."""
    t = ws["A1"]
    t.value = title
    t.font = Font(name="Calibri", size=15, bold=True, color=ACCENT)
    t.alignment = Alignment(vertical="center")
    ws.row_dimensions[1].height = 24
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=cols)
    if subtitle:
        s = ws["A2"]
        s.value = subtitle
        s.font = Font(name="Calibri", size=10, italic=True, color="666666")
        ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=cols)


def add_bar_chart(ws, *, title: str, data_ref: str, cats_ref: str, anchor: str, height: int = 9, width: int = 16):
    """Drop a horizontal-bar chart at `anchor`."""
    ch = BarChart()
    ch.type = "bar"
    ch.style = 11
    ch.title = title
    ch.y_axis.title = None
    ch.x_axis.title = "USD / month"
    ch.legend = None
    data = Reference(ws, range_string=data_ref)
    cats = Reference(ws, range_string=cats_ref)
    ch.add_data(data, titles_from_data=False)
    ch.set_categories(cats)
    ch.height = height
    ch.width = width
    ch.dataLabels = DataLabelList(showVal=True)
    ws.add_chart(ch, anchor)


def add_line_chart(ws, *, title: str, data_ref: str, cats_ref: str, anchor: str, height: int = 9, width: int = 18):
    """Drop a line chart at `anchor` (used for sensitivity sweeps)."""
    ch = LineChart()
    ch.style = 10
    ch.title = title
    ch.y_axis.title = "USD / month"
    ch.x_axis.title = "Sensitivity (% of baseline)"
    data = Reference(ws, range_string=data_ref)
    cats = Reference(ws, range_string=cats_ref)
    ch.add_data(data, titles_from_data=True)
    ch.set_categories(cats)
    ch.height = height
    ch.width = width
    ws.add_chart(ch, anchor)



# ============================================================
# Single-sheet calculator
#
# Layout: every field from the workload spec becomes a labelled cell;
# every derived value is a live formula. Editing any blue (input) cell
# recomputes the headline at the bottom. Section banners (full-width
# black bars) delineate the workflow: Project Profile → Global
# Parameters → Anchor Query → Segments → Shapes → Mix → Rate Card →
# Cost Mode → Self-Host GPU → Computation → Headline.
# ============================================================

def section_header(ws, row, text, cols=4):
    """Full-width banner row delineating a section of the calculator."""
    c = ws.cell(row=row, column=1, value=text)
    c.font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    c.fill = PatternFill(start_color=INK, end_color=INK, fill_type="solid")
    c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    ws.row_dimensions[row].height = 22
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=cols)


def kv(ws, row, label, value, *, kind="input", number_format=None, label_col=1, value_col=2):
    """Label in `label_col`; value in `value_col`. `kind` controls styling."""
    lc = ws.cell(row=row, column=label_col, value=label)
    lc.font = Font(name="Calibri", size=11, color=INK)
    c = ws.cell(row=row, column=value_col, value=value)
    if kind == "input": style_input(c)
    elif kind == "formula": style_formula(c)
    elif kind == "result": style_result(c)
    elif kind == "header3": style_header(c, 3)
    elif kind == "plain": c.font = Font(name="Calibri", size=11, color=INK)
    if number_format:
        c.number_format = number_format
    return c


def _addr(row, col):
    """Return absolute address like '$B$23' for col index col + row."""
    return f"${get_column_letter(col)}${row}"


# ============================================================
# build_calculator: lays out the entire single sheet.
#
# Returns a dict of important cell addresses so a caller can drop a
# small chart anchored to the headline.
# ============================================================

def build_calculator(ws, w: dict):
    ws.title = "Calculator"

    # Column widths chosen for readable labels + comfortable values.
    ws.column_dimensions["A"].width = 38
    ws.column_dimensions["B"].width = 22
    ws.column_dimensions["C"].width = 22
    ws.column_dimensions["D"].width = 22
    ws.column_dimensions["E"].width = 22
    ws.column_dimensions["F"].width = 22

    # --- 1. TITLE BANNER ---
    deployment_name = w["deployment"].get("name", "AI agent deployment")
    title_banner(
        ws,
        f"Cost Calculator · {deployment_name}",
        "One sheet. Every workload field is a cell. Every cost number is a formula. "
        "Edit blue cells to model your deployment; the headline at the bottom recomputes live.",
        cols=6,
    )

    row = 4

    # --- 2. PROJECT PROFILE ---
    section_header(ws, row, "PROJECT PROFILE", cols=6); row += 1
    kv(ws, row, "Deployment name", deployment_name); row += 1
    kv(ws, row, "Agency / organization", w["deployment"].get("agency", "")); row += 1
    # Read FedRAMP tier from either deployment.fedrampTier (preset-level)
    # or federal.fedramp_tier (engine-level field) — engine prefers the
    # federal block, so we mirror that here.
    fedramp_value = (
        w.get("federal", {}).get("fedramp_tier")
        or w["deployment"].get("fedrampTier")
        or "none"
    )
    kv(ws, row, "FedRAMP tier", fedramp_value)
    fedramp_cell = _addr(row, 2)
    row += 1
    # Multi-region multiplier comes from federal.multi_region (single /
    # active-passive / active-active). Engine treats hostMult as FedRAMP
    # × multi_region; previously omitted here, which made the LLM line
    # come out 1/1.5x or 1/2x for any preset with regional redundancy.
    multi_region_value = w.get("federal", {}).get("multi_region", "single")
    kv(ws, row, "Multi-region posture", multi_region_value)
    multi_region_cell = _addr(row, 2)
    row += 1
    kv(ws, row, "Public-facing", "yes" if w["deployment"].get("publicFacing") else "no"); row += 1
    row += 1  # blank

    # --- 3. GLOBAL PARAMETERS ---
    section_header(ws, row, "GLOBAL PARAMETERS", cols=6); row += 1
    defaults = w.get("defaults", {})
    kv(ws, row, "Model", defaults.get("model", "gpt-5.2"))
    model_cell = _addr(row, 2); row += 1
    kv(ws, row, "Tier", defaults.get("tier", "standard"))
    tier_cell = _addr(row, 2); row += 1
    kv(ws, row, "Mix", defaults.get("mix", "mixed"))
    mix_cell = _addr(row, 2); row += 1
    kv(ws, row, "Cost mode", defaults.get("cost_mode", "optimistic"))
    cost_mode_cell = _addr(row, 2); row += 1
    kv(ws, row, "Bot factor (β_bot, requested)", 1.5, number_format="0.00")
    bot_cell = _addr(row, 2); row += 1
    # Bot ceiling clamps the effective β_bot. Engine reads from
    # w.rate_limit.bot_ceiling; expose it here so segment query math
    # uses MIN(requested, ceiling). Use 99 as a "no ceiling" sentinel
    # (engine uses Infinity but Excel can't represent that cleanly).
    bot_ceiling_value = (w.get("rate_limit") or {}).get("bot_ceiling")
    if bot_ceiling_value is None:
        bot_ceiling_value = 99
    kv(ws, row, "Bot ceiling (from rate-limit policy)", bot_ceiling_value, number_format="0.00")
    bot_ceiling_cell = _addr(row, 2); row += 1
    # Default to 0 to match the JS engine's compute_api_cost default
    # (steady-state OpenAI; cache writes are negligible). Set to ~0.10
    # for Anthropic deployments that rotate the cache frequently.
    kv(ws, row, "Cache-write share (w)", 0.0, number_format="0.0%")
    cws_cell = _addr(row, 2); row += 1
    kv(ws, row, "Retry rate (r)", 0.0, number_format="0.0%")
    retry_cell = _addr(row, 2); row += 1
    kv(ws, row, "Daily spend cap ($/day)",
       w.get("daily_cap", {}).get("amount_usd", 1500),
       number_format='"$"#,##0')
    cap_cell = _addr(row, 2); row += 1
    row += 1

    # --- 4. ANCHOR QUERY ---
    section_header(ws, row, "ANCHOR QUERY (per-query base shape)", cols=6); row += 1
    aq = w.get("anchor_query", {})
    kv(ws, row, "Input tokens", aq.get("input_tokens", 3342), number_format="#,##0")
    anchor_in_cell = _addr(row, 2); row += 1
    kv(ws, row, "Output tokens", aq.get("output_tokens", 41), number_format="#,##0")
    anchor_out_cell = _addr(row, 2); row += 1
    kv(ws, row, "Cache rate baseline", aq.get("cache_rate_baseline", 0.88), number_format="0.00")
    cache_base_cell = _addr(row, 2); row += 1
    kv(ws, row, "Session baseline turns", aq.get("session_baseline_turns", 6))
    turns_cell = _addr(row, 2); row += 1
    row += 1

    # --- 5. AUDIENCE SEGMENTS table ---
    section_header(ws, row, "AUDIENCE SEGMENTS", cols=6); row += 1
    for col, h in enumerate(["ID", "Label", "MAU", "Sessions/day", "Q/session", "Apply β_bot"], start=1):
        style_header(ws.cell(row=row, column=col, value=h), 3)
    row += 1
    seg_addrs = []  # list of dicts: {id, mau, spd, qps, bot}
    for seg in w.get("segments", []):
        ws.cell(row=row, column=1, value=seg["id"]).font = Font(name="Calibri", size=11)
        ws.cell(row=row, column=2, value=seg.get("label", seg["id"])).font = Font(name="Calibri", size=11)
        style_input(ws.cell(row=row, column=3, value=seg["mau"])); fmt_num(ws.cell(row=row, column=3))
        style_input(ws.cell(row=row, column=4, value=seg["sessions_per_day"]))
        style_input(ws.cell(row=row, column=5, value=seg["questions_per_session"]))
        apply_bot = seg.get("applyBotFactor") if seg.get("applyBotFactor") is not None else seg.get("apply_bot_factor")
        style_input(ws.cell(row=row, column=6, value="yes" if apply_bot else "no"))
        seg_addrs.append({
            "id": seg["id"],
            "mau": _addr(row, 3),
            "spd": _addr(row, 4),
            "qps": _addr(row, 5),
            "bot": _addr(row, 6),
        })
        row += 1
    row += 1

    # --- 6. TRAFFIC SHAPES (factors) ---
    section_header(ws, row, "TRAFFIC SHAPES (per-query input/output factors)", cols=6); row += 1
    for col, h in enumerate(["Shape", "Input factor", "Output factor", "Cache eligible"], start=1):
        style_header(ws.cell(row=row, column=col, value=h), 3)
    row += 1
    shape_addrs = {}
    for shape_name, shape in w.get("shapes", {}).items():
        ws.cell(row=row, column=1, value=shape_name).font = Font(name="Calibri", size=11)
        style_input(ws.cell(row=row, column=2, value=shape.get("input_factor", 1.0)))
        ws.cell(row=row, column=2).number_format = "0.00"
        style_input(ws.cell(row=row, column=3, value=shape.get("output_factor", 1.0)))
        ws.cell(row=row, column=3).number_format = "0.00"
        style_input(ws.cell(row=row, column=4, value="yes" if shape.get("cache_eligible", True) else "no"))
        shape_addrs[shape_name] = {"in": _addr(row, 2), "out": _addr(row, 3), "cache": _addr(row, 4)}
        row += 1
    row += 1

    # --- 7. MIX WEIGHTS (selected mix only) ---
    selected_mix_name = defaults.get("mix", "mixed")
    selected_mix = w.get("mix", {}).get(selected_mix_name, {})
    section_header(ws, row, f"MIX WEIGHTS ({selected_mix_name} — change the GLOBAL · Mix cell above to switch)", cols=6); row += 1
    for col, h in enumerate(["Shape", "Weight"], start=1):
        style_header(ws.cell(row=row, column=col, value=h), 3)
    row += 1
    mix_addrs = {}
    weights = selected_mix.get("weights", {})
    for shape_name in shape_addrs.keys():
        weight = weights.get(shape_name, 0)
        ws.cell(row=row, column=1, value=shape_name).font = Font(name="Calibri", size=11)
        style_input(ws.cell(row=row, column=2, value=weight))
        ws.cell(row=row, column=2).number_format = "0.00"
        mix_addrs[shape_name] = _addr(row, 2)
        row += 1
    row += 1

    # --- 8. RATE CARD (selected model only) ---
    selected_model = defaults.get("model", "gpt-5.2")
    rate_card = w.get("rate_cards", {}).get(selected_model, {})
    section_header(ws, row, f"RATE CARD ({selected_model} — change the GLOBAL · Model cell above to switch)", cols=6); row += 1
    kv(ws, row, "p_in ($/M, input)", rate_card.get("input_per_million", 1.75), number_format='"$"#,##0.000')
    p_in_cell = _addr(row, 2); row += 1
    kv(ws, row, "p_read ($/M, cached read)", rate_card.get("cached_per_million", rate_card.get("input_per_million", 1.75) * 0.1), number_format='"$"#,##0.000')
    p_read_cell = _addr(row, 2); row += 1
    cw = rate_card.get("cached_write_per_million")
    kv(ws, row, "p_write ($/M, cached write)",
       cw if cw is not None else rate_card.get("input_per_million", 1.75),
       number_format='"$"#,##0.000')
    p_write_cell = _addr(row, 2); row += 1
    kv(ws, row, "p_out ($/M, output)", rate_card.get("output_per_million", 14.0), number_format='"$"#,##0.000')
    p_out_cell = _addr(row, 2); row += 1
    row += 1

    # --- 9. COST MODE PARAMS (selected mode only) ---
    selected_cost_mode = defaults.get("cost_mode", "optimistic")
    cm = w.get("self_host", {}).get("cost_modes", {}).get(selected_cost_mode, {})
    # Fall back to canonical defaults if the workload JSON omits them
    if not cm:
        cm = {"ops_monthly": 350, "fte_monthly": 2500, "setup_amortized": 0,
              "throughput_derate": 1.00, "discount_1yr": 0.40, "discount_3yr": 0.60}
    section_header(ws, row, f"COST MODE ({selected_cost_mode})", cols=6); row += 1
    kv(ws, row, "Ops monthly ($)", cm.get("ops_monthly", 350), number_format='"$"#,##0')
    cm_ops_cell = _addr(row, 2); row += 1
    kv(ws, row, "FTE monthly ($, 0.5 SRE etc.)", cm.get("fte_monthly", 2500), number_format='"$"#,##0')
    cm_fte_cell = _addr(row, 2); row += 1
    kv(ws, row, "Setup amortized ($/mo)", cm.get("setup_amortized", 0), number_format='"$"#,##0')
    cm_setup_cell = _addr(row, 2); row += 1
    kv(ws, row, "Throughput derate η", cm.get("throughput_derate", 1.00), number_format="0.00")
    cm_eta_cell = _addr(row, 2); row += 1
    kv(ws, row, "Reservation discount (3-yr)", cm.get("discount_3yr", 0.6), number_format="0.0%")
    cm_disc_cell = _addr(row, 2); row += 1
    row += 1

    # --- 10. SELF-HOST GPU ---
    section_header(ws, row, "SELF-HOST GPU", cols=6); row += 1
    gpu_opts = w.get("self_host", {}).get("gpu_options", {})
    first_gpu_id, first_gpu = (next(iter(gpu_opts.items())) if gpu_opts else ("g6.12xlarge", {"hourly": 8.0, "label": "g6.12xlarge"}))
    kv(ws, row, "GPU SKU", first_gpu.get("label", first_gpu_id)); row += 1
    kv(ws, row, "GPU hourly ($/hr)", first_gpu.get("hourly", 8.0), number_format='"$"#,##0.00')
    gpu_hourly_cell = _addr(row, 2); row += 1
    kv(ws, row, "Duty cycle (0..1)", w.get("self_host", {}).get("duty_cycle", 1.0), number_format="0.00")
    duty_cell = _addr(row, 2); row += 1
    row += 1

    # ============================================================
    # 11. COMPUTATION — derived from everything above
    # ============================================================
    section_header(ws, row, "COMPUTATION (formulas — derived from blue cells above)", cols=6); row += 1

    # Tier multiplier from selection (standard=1, flex=0.5, batch=0.5, priority=2.5)
    kv(ws, row, "Tier multiplier",
       f'=IF({tier_cell}="standard",1,IF({tier_cell}="flex",0.5,IF({tier_cell}="batch",0.5,IF({tier_cell}="priority",2.5,1))))',
       kind="formula", number_format="0.00")
    tier_mult_cell = _addr(row, 2); row += 1

    # Hosting multiplier = FedRAMP × multi-region.
    # FedRAMP: none=1.00 · low=1.00 · moderate=1.15 · high=1.30
    # Multi-region: single=1.00 · active-passive=1.50 · active-active=2.00
    fedramp_formula = f'IF({fedramp_cell}="moderate",1.15,IF({fedramp_cell}="high",1.30,1))'
    mr_formula = f'IF({multi_region_cell}="active-active",2,IF({multi_region_cell}="active-passive",1.5,1))'
    kv(ws, row, "Hosting multiplier (FedRAMP × multi-region)",
       f'=({fedramp_formula})*({mr_formula})',
       kind="formula", number_format="0.00")
    host_mult_cell = _addr(row, 2); row += 1

    # Effective cached-input rate (Eq. 2): p_eff = w·p_write + (1-w)·p_read
    kv(ws, row, "p_cached,eff (Eq. 2 blend)",
       f'={cws_cell}*{p_write_cell}+(1-{cws_cell})*{p_read_cell}',
       kind="formula", number_format='"$"#,##0.000')
    p_eff_cell = _addr(row, 2); row += 1
    row += 1

    # Per-segment effective cache rate (Eq. 3) + per-query cost
    kv(ws, row, "Per-segment effective cache + per-query cost", "", kind="header3"); row += 1
    for col, h in enumerate(["Segment", "Eff cache rate (Eq. 3)", "Per-query $ (mix-blended)"], start=1):
        style_header(ws.cell(row=row, column=col, value=h), 3)
    row += 1
    seg_eff_cells = {}
    seg_pq_cells = {}
    for sa in seg_addrs:
        ws.cell(row=row, column=1, value=sa["id"]).font = Font(name="Calibri", size=11)
        # Eq. 3 clamp(baseline + 0.01·(q − turns), 0.5, 0.94); q is q/session for this seg
        eff_formula = (
            f'=MAX(0.5,MIN(0.94,{cache_base_cell}+'
            f'({sa["qps"]}-{turns_cell})*0.01))'
        )
        c = ws.cell(row=row, column=2, value=eff_formula); style_formula(c); c.number_format = "0.000"
        seg_eff_cells[sa["id"]] = _addr(row, 2)
        # Per-query blended cost across mix: Σ weight × shape_cost
        # shape_cost = (I·(1-eff*cache_elig)·p_in + I·eff·cache_elig·p_eff + O·p_out) / 1e6 × tier_mult
        parts = []
        for shape_name, shape_a in shape_addrs.items():
            cache_use = f'IF({shape_a["cache"]}="yes",{seg_eff_cells[sa["id"]]},0)'
            in_tok = f'({anchor_in_cell}*{shape_a["in"]})'
            out_tok = f'({anchor_out_cell}*{shape_a["out"]})'
            cached = f'({in_tok}*{cache_use})'
            uncached = f'({in_tok}-{cached})'
            shape_cost = (
                f'({uncached}*{p_in_cell}/1000000'
                f'+{cached}*{p_eff_cell}/1000000'
                f'+{out_tok}*{p_out_cell}/1000000)'
                f'*{tier_mult_cell}'
            )
            parts.append(f'{mix_addrs[shape_name]}*{shape_cost}')
        pq_formula = "=" + "+".join(parts)
        c = ws.cell(row=row, column=3, value=pq_formula); style_formula(c); c.number_format = '"$"#,##0.0000'
        seg_pq_cells[sa["id"]] = _addr(row, 3)
        row += 1
    row += 1

    # Monthly query volume per segment (Eq. 4)
    kv(ws, row, "Monthly query volume (Eq. 4)", "", kind="header3"); row += 1
    for col, h in enumerate(["Segment", "Queries/mo", "$ / mo (pre-mult)"], start=1):
        style_header(ws.cell(row=row, column=col, value=h), 3)
    row += 1
    seg_q_cells = {}
    seg_cost_cells = {}
    for sa in seg_addrs:
        ws.cell(row=row, column=1, value=sa["id"]).font = Font(name="Calibri", size=11)
        # Effective β_bot = MIN(requested, ceiling) when segment opts in;
        # 1 otherwise. Matches the JS engine's `botEffective` clamp.
        beta = f'IF({sa["bot"]}="yes",MIN({bot_cell},{bot_ceiling_cell}),1)'
        q_formula = f'={sa["mau"]}*{sa["spd"]}*30*{sa["qps"]}*{beta}'
        c = ws.cell(row=row, column=2, value=q_formula); style_formula(c); fmt_num(c)
        seg_q_cells[sa["id"]] = _addr(row, 2)
        cost_formula = f'={_addr(row, 2)}*{seg_pq_cells[sa["id"]]}'
        c = ws.cell(row=row, column=3, value=cost_formula); style_formula(c); fmt_usd(c)
        seg_cost_cells[sa["id"]] = _addr(row, 3)
        row += 1

    # Totals
    row += 1
    kv(ws, row, "TOTAL queries / month",
       "=" + "+".join(seg_q_cells.values()),
       kind="result", number_format="#,##0")
    total_q_cell = _addr(row, 2); row += 1

    # API gross pre-multiplier
    kv(ws, row, "API gross $ / mo (pre-multiplier)",
       "=" + "+".join(seg_cost_cells.values()),
       kind="formula", number_format='"$"#,##0')
    api_gross_pre_cell = _addr(row, 2); row += 1

    # API gross post-multiplier (× hostMult)  — this is the bug the screenshot exposed
    kv(ws, row, "API gross $ / mo (post-multiplier × hostMult)",
       f"={api_gross_pre_cell}*{host_mult_cell}",
       kind="formula", number_format='"$"#,##0')
    api_gross_post_cell = _addr(row, 2); row += 1

    # Daily cap monthly budget — INFORMATIONAL only. The engine no longer
    # enforces the cap as a hard refusal (real cloud LLMs bill usage),
    # so the displayed "capped" cost equals gross. Kept here as a
    # reference value so a procurement reviewer can see the cap they
    # specified and the spend it would have implied at a literal cap.
    kv(ws, row, "Daily cap monthly budget ($/mo, informational)",
       f"={cap_cell}*30",
       kind="formula", number_format='"$"#,##0')
    cap_monthly_cell = _addr(row, 2); row += 1

    # API capped post-multiplier: matches engine behavior (cap enforcement
    # removed). When gross > cap, the engine returns gross — this Excel
    # mirrors that. To re-enforce a hard cap, replace the formula with
    # =MIN(gross_post_cell, cap_monthly_cell).
    kv(ws, row, "API capped $ / mo (post-mult; = gross, cap not enforced)",
       f"={api_gross_post_cell}",
       kind="formula", number_format='"$"#,##0')
    api_capped_cell = _addr(row, 2); row += 1

    # Retry inflate (Eq. 5)
    kv(ws, row, "Retry inflate factor (Eq. 5: 1 + 1.5r)",
       f"=1+1.5*{retry_cell}",
       kind="formula", number_format="0.000")
    retry_inflate_cell = _addr(row, 2); row += 1

    # API monthly with retry — the canonical headline LLM bill
    kv(ws, row, "API monthly (with retry inflate) — Eq. 5",
       f"={api_capped_cell}*{retry_inflate_cell}",
       kind="result", number_format='"$"#,##0')
    api_with_retry_cell = _addr(row, 2); row += 1

    # Refused queries (will be 0 unless cap < gross, which the engine
    # treats as informational only)
    kv(ws, row, "Refused queries / mo (≥0 only if cap binds)",
       f"=IF({api_gross_post_cell}>{cap_monthly_cell},({api_gross_post_cell}-{cap_monthly_cell})/{api_gross_post_cell}*{total_q_cell},0)",
       kind="formula", number_format="#,##0")
    refused_cell = _addr(row, 2); row += 1
    row += 1

    # Self-host (single-replica approximation — see SH-1 caveat)
    kv(ws, row, "Self-host (single-replica approximation)", "", kind="header3"); row += 1
    # Effective hours = 730 × duty_cycle (this is the fix to the bug from #4 of the prior round)
    kv(ws, row, "Effective hours / mo (= 730 × duty cycle)",
       f"=730*{duty_cell}",
       kind="formula", number_format="0")
    eff_hours_cell = _addr(row, 2); row += 1
    # GPU monthly using 3-yr reservation discount and effective hours
    kv(ws, row, "Self-host GPU $ / mo (3-yr RI × duty cycle × hostMult)",
       f"={gpu_hourly_cell}*(1-{cm_disc_cell})*{eff_hours_cell}*{host_mult_cell}",
       kind="formula", number_format='"$"#,##0')
    sh_gpu_cell = _addr(row, 2); row += 1
    # Fixed costs from selected cost mode (with hostMult on ops portion only — matches engine)
    kv(ws, row, "Self-host fixed $ / mo (ops·hostMult + FTE + setup)",
       f"={cm_ops_cell}*{host_mult_cell}+{cm_fte_cell}+{cm_setup_cell}",
       kind="formula", number_format='"$"#,##0')
    sh_fixed_cell = _addr(row, 2); row += 1
    # Total
    kv(ws, row, "Self-host total $ / mo",
       f"={sh_gpu_cell}+{sh_fixed_cell}",
       kind="result", number_format='"$"#,##0')
    sh_total_cell = _addr(row, 2); row += 1
    row += 1

    # ============================================================
    # 12. HEADLINE
    # ============================================================
    section_header(ws, row, "HEADLINE — the procurement answer", cols=6); row += 1

    # Big number cell
    kv(ws, row, "Monthly LLM bill (API capped × retry, post-mult)",
       f"={api_with_retry_cell}", kind="result", number_format='"$"#,##0')
    headline_cell = _addr(row, 2)
    big = ws.cell(row=row, column=2)
    big.font = Font(name="Calibri", size=22, bold=True, color=ACCENT)
    ws.row_dimensions[row].height = 38
    row += 2

    # Equal-budget 4-row comparison
    for col, h in enumerate(["Strategy", "Monthly $", "Queries served / mo", "Refused / lost"], start=1):
        style_header(ws.cell(row=row, column=col, value=h), 2)
    row += 1
    eb_start = row
    # API capped + retry
    ws.cell(row=row, column=1, value=f"API (capped × retry, post-mult)")
    c = ws.cell(row=row, column=2, value=f"={api_with_retry_cell}"); style_result(c); fmt_usd(c)
    c = ws.cell(row=row, column=3, value=f"={total_q_cell}-{refused_cell}"); style_formula(c); fmt_num(c)
    c = ws.cell(row=row, column=4, value=f"={refused_cell}"); style_formula(c); fmt_num(c)
    c.font = Font(name="Calibri", color=BAD)
    row += 1
    # API uncapped (no retry × by convention — uncapped path = no refusal, no retry)
    ws.cell(row=row, column=1, value="API (uncapped — full service, post-mult)")
    c = ws.cell(row=row, column=2, value=f"={api_gross_post_cell}*{retry_inflate_cell}"); style_result(c); fmt_usd(c)
    c = ws.cell(row=row, column=3, value=f"={total_q_cell}"); style_formula(c); fmt_num(c)
    ws.cell(row=row, column=4, value=0); fmt_num(ws.cell(row=row, column=4))
    row += 1
    # Self-host (single mode shown — current selected cost_mode)
    ws.cell(row=row, column=1, value=f"Self-host ({selected_cost_mode})")
    c = ws.cell(row=row, column=2, value=f"={sh_total_cell}"); style_result(c); fmt_usd(c)
    c = ws.cell(row=row, column=3, value=f"={total_q_cell}"); style_formula(c); fmt_num(c)
    ws.cell(row=row, column=4, value=0); fmt_num(ws.cell(row=row, column=4))
    row += 1
    eb_end = row - 1

    # Heat-map across the cost column
    heatmap_range(ws, f"B{eb_start}:B{eb_end}")

    # Bar chart anchored just below the comparison
    add_bar_chart(
        ws,
        title="Equal-budget cost by strategy",
        data_ref=f"Calculator!$B${eb_start}:$B${eb_end}",
        cats_ref=f"Calculator!$A${eb_start}:$A${eb_end}",
        anchor=f"A{row + 1}",
        height=8, width=18,
    )

    # Freeze the title banner so it stays visible while scrolling
    freeze_below(ws, row=4)


# ============================================================
# Main entry
# ============================================================

def _normalize_for_excel(w: dict) -> dict:
    """Resolve rate_cards / cost_modes / gpu_options from the global Prices
    so the Excel single-sheet has real numbers to embed even for presets
    whose workload JSON ships an empty rate_cards block. Falls back to a
    no-op if the Python port isn't importable (e.g., generator run
    standalone)."""
    try:
        import sys as _sys, os as _os
        _here = _os.path.dirname(_os.path.abspath(__file__))
        _scripts = _os.path.normpath(_os.path.join(_here, "..", "..", "scripts"))
        if _scripts not in _sys.path:
            _sys.path.insert(0, _scripts)
        from cost_engine import normalize_workload  # type: ignore
        return normalize_workload(w)
    except Exception as e:
        sys.stderr.write(
            f"WARNING: could not normalize workload via cost_engine ({e}); "
            "Excel may show fallback rates if rate_cards is empty.\n"
        )
        return w


def generate(workload_path: Path, out_path: Path) -> None:
    with open(workload_path) as f:
        raw = json.load(f)
    # Normalize so rate_cards / cost_modes / gpu_options are populated
    # from prices.js when the preset's workload JSON omits them.
    w = _normalize_for_excel(raw)

    wb = Workbook()
    ws = wb.active
    build_calculator(ws, w)
    wb.save(out_path)
    print(f"Wrote {out_path}")


def main():
    ap = argparse.ArgumentParser(
        description="Generate a single-sheet Excel calculator from a workload spec"
    )
    ap.add_argument("workload", help="Path to workload JSON file")
    ap.add_argument("-o", "--output", help="Output .xlsx path", default=None)
    args = ap.parse_args()

    workload_path = Path(args.workload)
    if not workload_path.exists():
        print(f"ERROR: {workload_path} not found", file=sys.stderr)
        sys.exit(1)
    if args.output:
        out_path = Path(args.output)
    else:
        slug = workload_path.stem
        out_path = workload_path.parent / f"{slug}.xlsx"
    generate(workload_path, out_path)


if __name__ == "__main__":
    main()
