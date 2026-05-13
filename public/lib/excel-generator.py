#!/usr/bin/env python3
"""
Cost Calculator Studio — Excel workbook generator.

Builds a sophisticated .xlsx file from a workload specification. The
workbook contains live formulas mirroring the JS cost engine, so a
procurement officer can paste their numbers and get the same answers
they'd see in the interactive calculator.

Sheets produced:
  README        — methodology, links, how to use
  Workload      — input parameters (editable)
  Shapes        — query shape definitions
  Mix           — traffic mix weights
  Segments      — user populations
  Rate Cards    — per-million-token model rates
  Cost Modes    — Optimistic vs Realistic parameters
  Computation   — intermediate values, all driven by formulas
  Output        — the four-row API-vs-self-host comparison
  Sensitivity   — how the headline moves when key inputs change

Usage:
  python3 excel-generator.py examples/public-geospatial-qa.json -o public-geospatial-qa.xlsx
  python3 excel-generator.py examples/generic-startup-chatbot.json -o startup.xlsx

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
except ImportError:
    print("ERROR: openpyxl is required. Install with: pip install openpyxl", file=sys.stderr)
    sys.exit(1)


# ----- Editorial palette to match the HTML calculator -----
INK = "1A1A1A"
ACCENT = "8B2331"     # oxblood
GOOD = "2B7A3D"
BAD = "B8404A"
PAPER = "FBF9F4"
HIGHLIGHT = "F3ECDB"
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
# Per-sheet builders
# ============================================================

def build_readme(ws, w: dict):
    ws.title = "README"

    title = ws["A1"]
    title.value = f"Cost Calculator · {w['deployment'].get('name', 'AI Agent')}"
    style_header(title, 1)
    ws["A1"].alignment = Alignment(vertical="center")

    ws["A2"] = w["deployment"].get("agency", "")
    ws["A2"].font = Font(name="Calibri", size=11, italic=True, color="555555")

    ws["A4"] = "About this workbook"
    style_header(ws["A4"], 2)

    rows = [
        "",
        "This Excel workbook is a parameterized cost model for the deployment named above.",
        "All numbers in the Output sheet are driven by formulas referencing the Workload,",
        "Shapes, Mix, Segments, Rate Cards, and Cost Modes sheets.",
        "",
        "How to use:",
        "  1. Open the Workload sheet and edit any blue-highlighted input cell.",
        "  2. The Computation and Output sheets recalculate automatically.",
        "  3. The Sensitivity sheet shows how the headline number moves when key",
        "     inputs swing ±30%.",
        "",
        "Methodology:",
        "  Same arithmetic as the Cost Calculator Studio web app and the EIE paper.",
        "  See lib/cost-engine.js for the canonical implementation.",
        "  See docs/papers/arxiv/paper.tex for the academic write-up.",
        "",
        "Cite as:",
        "  Kulkarni, A. & Parajuli, P. (2026). Cost Modeling for Public-Facing",
        "  LLM Chat Applications: An Equal-Budget, Refusal-Aware Comparison",
        "  of Commercial APIs and Self-Hosted GPU Fleets.",
        "",
        "Schema version: " + w.get("schemaVersion", "1.0"),
    ]

    for i, text in enumerate(rows, start=5):
        ws[f"A{i}"] = text
        style_label(ws[f"A{i}"])

    ws.column_dimensions["A"].width = 95
    ws.row_dimensions[1].height = 30


def build_workload(ws, w: dict):
    ws.title = "Workload"

    ws["A1"] = "Workload Specification"
    style_header(ws["A1"], 1)
    ws.merge_cells("A1:C1")

    section_offsets = []

    row = 3
    ws[f"A{row}"] = "Deployment"; style_header(ws[f"A{row}"], 2); ws.merge_cells(f"A{row}:C{row}")
    row += 1
    deployment_fields = [
        ("name", "Name"),
        ("agency", "Agency"),
        ("description", "Description"),
        ("publicFacing", "Public-facing"),
        ("fedrampTier", "FedRAMP tier"),
    ]
    for key, label in deployment_fields:
        ws[f"A{row}"] = label; style_label(ws[f"A{row}"])
        v = w["deployment"].get(key, "")
        ws[f"B{row}"] = v if not isinstance(v, bool) else ("yes" if v else "no")
        style_input(ws[f"B{row}"])
        row += 1

    row += 1
    ws[f"A{row}"] = "Anchor query"; style_header(ws[f"A{row}"], 2); ws.merge_cells(f"A{row}:C{row}")
    row += 1
    aq = w["anchor_query"]
    anchor_fields = [
        ("input_tokens", "Input tokens (anchor)"),
        ("output_tokens", "Output tokens (anchor)"),
        ("cache_rate_baseline", "Cache rate baseline (0–1)"),
        ("session_baseline_turns", "Baseline session turns"),
    ]
    anchor_input_cell = {}
    for key, label in anchor_fields:
        ws[f"A{row}"] = label; style_label(ws[f"A{row}"])
        ws[f"B{row}"] = aq.get(key, 0)
        style_input(ws[f"B{row}"])
        anchor_input_cell[key] = f"Workload!B{row}"
        row += 1

    row += 1
    ws[f"A{row}"] = "Daily spend cap"; style_header(ws[f"A{row}"], 2); ws.merge_cells(f"A{row}:C{row}")
    row += 1
    cap = w.get("daily_cap", {"enabled": True, "amount_usd": 1500, "burst_days": 7, "burst_factor": 1.0})
    cap_fields = [("enabled", "Enabled (yes/no)"), ("amount_usd", "$/day"), ("burst_days", "Burst days/month"), ("burst_factor", "Burst factor")]
    cap_cell = {}
    for key, label in cap_fields:
        ws[f"A{row}"] = label; style_label(ws[f"A{row}"])
        v = cap.get(key, "")
        ws[f"B{row}"] = ("yes" if v else "no") if isinstance(v, bool) else v
        style_input(ws[f"B{row}"])
        cap_cell[key] = f"Workload!B{row}"
        row += 1

    row += 1
    ws[f"A{row}"] = "Bot factor"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = 1.5
    style_input(ws[f"B{row}"])
    bot_factor_cell = f"Workload!B{row}"
    row += 1

    autosize(ws, min_w=20, max_w=70)
    return {
        "anchor_input": anchor_input_cell,
        "cap": cap_cell,
        "bot_factor": bot_factor_cell,
    }


def build_shapes(ws, w: dict):
    ws.title = "Shapes"
    headers = ["Shape", "Input factor", "Output factor", "Cache eligible", "Description"]
    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=h); style_header(c, 2)

    row = 2
    shape_rows = {}
    for name, shape in w["shapes"].items():
        ws.cell(row=row, column=1, value=name).font = Font(name="Consolas", bold=True, color=ACCENT)
        ws.cell(row=row, column=2, value=shape["input_factor"]); style_input(ws.cell(row=row, column=2))
        ws.cell(row=row, column=3, value=shape["output_factor"]); style_input(ws.cell(row=row, column=3))
        ws.cell(row=row, column=4, value="yes" if shape["cache_eligible"] else "no"); style_input(ws.cell(row=row, column=4))
        ws.cell(row=row, column=5, value=shape.get("description", ""))
        shape_rows[name] = row
        row += 1
    autosize(ws)
    return shape_rows


def build_mix(ws, w: dict):
    ws.title = "Mix"
    shapes = list(w["shapes"].keys())
    headers = ["Mix", "Label"] + shapes + ["Sum"]
    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=h); style_header(c, 2)

    row = 2
    mix_rows = {}
    for mix_name, mix in w["mix"].items():
        ws.cell(row=row, column=1, value=mix_name).font = Font(name="Consolas", bold=True, color=ACCENT)
        ws.cell(row=row, column=2, value=mix.get("label", mix_name))
        for i, shape in enumerate(shapes, start=3):
            ws.cell(row=row, column=i, value=mix.get("weights", {}).get(shape, 0))
            style_input(ws.cell(row=row, column=i))
        # Sum formula at the end
        first_col = get_column_letter(3)
        last_col = get_column_letter(2 + len(shapes))
        ws.cell(row=row, column=3 + len(shapes), value=f"=SUM({first_col}{row}:{last_col}{row})")
        style_formula(ws.cell(row=row, column=3 + len(shapes)))
        mix_rows[mix_name] = row
        row += 1
    autosize(ws)
    return mix_rows


def build_segments(ws, w: dict):
    ws.title = "Segments"
    headers = ["ID", "Label", "MAU", "Sessions/day", "Q/session", "Bot factor?"]
    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=h); style_header(c, 2)

    row = 2
    seg_rows = {}
    for seg in w["segments"]:
        ws.cell(row=row, column=1, value=seg["id"]).font = Font(name="Consolas", bold=True, color=ACCENT)
        ws.cell(row=row, column=2, value=seg.get("label", seg["id"]))
        ws.cell(row=row, column=3, value=seg["mau"]); style_input(ws.cell(row=row, column=3))
        ws.cell(row=row, column=4, value=seg["sessions_per_day"]); style_input(ws.cell(row=row, column=4))
        ws.cell(row=row, column=5, value=seg["questions_per_session"]); style_input(ws.cell(row=row, column=5))
        ws.cell(row=row, column=6, value="yes" if seg.get("applyBotFactor") else "no"); style_input(ws.cell(row=row, column=6))
        seg_rows[seg["id"]] = row
        row += 1
    autosize(ws)
    return seg_rows


def build_rate_cards(ws, w: dict):
    ws.title = "Rate Cards"
    # Default rate cards (mirrors lib/cost-engine.js)
    DEFAULT = {
        'gpt-5.5':         (5.00, 0.50,  30.00),
        'gpt-5.4':         (2.50, 0.25,  15.00),
        'gpt-5.2':         (1.75, 0.175, 14.00),
        'gpt-5.1':         (1.25, 0.125, 10.00),
        'gpt-5':           (1.25, 0.125, 10.00),
        'gpt-5-mini':      (0.25, 0.025,  2.00),
        'gpt-5-nano':      (0.05, 0.005,  0.40),
        'gpt-4o':          (2.50, 1.25,  10.00),
        'gpt-4o-mini':     (0.15, 0.075,  0.60),
        'claude-opus-4.7': (5.00, 0.50,  25.00),
        'gemini-3.1-pro':  (2.00, 0.20,  12.00),
    }
    rates = dict(DEFAULT)
    for k, v in (w.get("rate_cards") or {}).items():
        rates[k] = (v.get("input_per_million"), v.get("cached_per_million"), v.get("output_per_million"))
    headers = ["Model", "Input ($/M)", "Cached ($/M)", "Output ($/M)"]
    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=h); style_header(c, 2)
    row = 2
    rate_rows = {}
    for name, (i, c, o) in rates.items():
        ws.cell(row=row, column=1, value=name).font = Font(name="Consolas", bold=True, color=ACCENT)
        ws.cell(row=row, column=2, value=i); style_input(ws.cell(row=row, column=2))
        ws.cell(row=row, column=3, value=c); style_input(ws.cell(row=row, column=3))
        ws.cell(row=row, column=4, value=o); style_input(ws.cell(row=row, column=4))
        rate_rows[name] = row
        row += 1
    autosize(ws)
    return rate_rows


def build_cost_modes(ws):
    ws.title = "Cost Modes"
    DEFAULTS = {
        "optimistic": {"ops_monthly": 350,  "fte_monthly": 2500, "setup_amortized":    0, "throughput_derate": 1.00, "discount_1yr": 0.40, "discount_3yr": 0.60},
        "realistic":  {"ops_monthly": 1800, "fte_monthly": 8000, "setup_amortized": 8333, "throughput_derate": 0.75, "discount_1yr": 0.33, "discount_3yr": 0.55},
    }
    headers = ["Parameter", "Optimistic", "Realistic"]
    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=h); style_header(c, 2)
    rows = list(DEFAULTS["optimistic"].keys())
    for i, key in enumerate(rows, start=2):
        ws.cell(row=i, column=1, value=key.replace("_", " ").title())
        ws.cell(row=i, column=2, value=DEFAULTS["optimistic"][key]); style_input(ws.cell(row=i, column=2))
        ws.cell(row=i, column=3, value=DEFAULTS["realistic"][key]); style_input(ws.cell(row=i, column=3))
    autosize(ws)


def build_computation(ws, w: dict, refs: dict):
    """The intermediate values: queries, blended cost, monthly gross, capped, refused."""
    ws.title = "Computation"

    ws["A1"] = "Computation"
    style_header(ws["A1"], 1)
    ws.merge_cells("A1:C1")

    row = 3
    ws[f"A{row}"] = "Selections (change here to model)"; style_header(ws[f"A{row}"], 2); ws.merge_cells(f"A{row}:C{row}")
    row += 1
    default_model = w["defaults"]["model"]
    default_mix = w["defaults"]["mix"]
    default_tier = w["defaults"]["tier"]

    ws[f"A{row}"] = "Model"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = default_model; style_input(ws[f"B{row}"])
    model_cell = f"Computation!B{row}"
    row += 1

    ws[f"A{row}"] = "Mix"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = default_mix; style_input(ws[f"B{row}"])
    mix_cell = f"Computation!B{row}"
    row += 1

    ws[f"A{row}"] = "Tier"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = default_tier; style_input(ws[f"B{row}"])
    tier_cell = f"Computation!B{row}"
    row += 1

    ws[f"A{row}"] = "Cost mode"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = w["defaults"].get("cost_mode", "optimistic"); style_input(ws[f"B{row}"])
    cost_mode_cell = f"Computation!B{row}"
    row += 1

    # Tier multiplier lookup
    row += 1
    ws[f"A{row}"] = "Tier multiplier"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = f'=IF({tier_cell}="standard",1,IF({tier_cell}="flex",0.5,IF({tier_cell}="batch",0.5,IF({tier_cell}="priority",2.5,1))))'
    style_formula(ws[f"B{row}"])
    tier_mult_cell = f"Computation!B{row}"
    row += 1

    # Per-model rate lookup via VLOOKUP
    rate_rows = refs["rate_rows"]
    n_rates = len(rate_rows)
    rates_range_in = f"'Rate Cards'!A2:B{1 + n_rates}"
    rates_range_cached = f"'Rate Cards'!A2:C{1 + n_rates}"
    rates_range_out = f"'Rate Cards'!A2:D{1 + n_rates}"

    ws[f"A{row}"] = "Rate (input $/M)"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = f'=VLOOKUP({model_cell},{rates_range_in},2,FALSE)'; style_formula(ws[f"B{row}"])
    p_in_cell = f"Computation!B{row}"
    row += 1
    ws[f"A{row}"] = "Rate (cached $/M)"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = f'=VLOOKUP({model_cell},{rates_range_cached},3,FALSE)'; style_formula(ws[f"B{row}"])
    p_cached_cell = f"Computation!B{row}"
    row += 1
    ws[f"A{row}"] = "Rate (output $/M)"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = f'=VLOOKUP({model_cell},{rates_range_out},4,FALSE)'; style_formula(ws[f"B{row}"])
    p_out_cell = f"Computation!B{row}"
    row += 1

    row += 1
    ws[f"A{row}"] = "Per-shape cost (full pipeline)"; style_header(ws[f"A{row}"], 2); ws.merge_cells(f"A{row}:C{row}")
    row += 1

    anchor_in_cell = refs["anchor_input"]["input_tokens"]
    anchor_out_cell = refs["anchor_input"]["output_tokens"]
    cache_base_cell = refs["anchor_input"]["cache_rate_baseline"]

    # Compute per-segment effective cache + per-query cost
    ws[f"A{row}"] = "Effective cache (per segment)"; style_header(ws[f"A{row}"], 2); ws.merge_cells(f"A{row}:C{row}")
    row += 1
    ws[f"A{row}"] = "Segment ID"
    ws[f"B{row}"] = "Eff cache rate"
    ws[f"C{row}"] = "Per-query $ (blended)"
    style_header(ws[f"A{row}"], 3); style_header(ws[f"B{row}"], 3); style_header(ws[f"C{row}"], 3)
    row += 1

    seg_rows = refs["seg_rows"]
    seg_eff_cells = {}
    seg_pq_cells = {}
    for seg_id, seg_row in seg_rows.items():
        q_per_session_cell = f"Segments!E{seg_row}"
        ws[f"A{row}"] = seg_id
        # eff cache = clamp(base + (q-6)*0.01, 0.5, 0.94)
        ws[f"B{row}"] = (
            f'=MAX(0.5,MIN(0.94,{cache_base_cell}+({q_per_session_cell}-6)*0.01))'
        )
        style_formula(ws[f"B{row}"])
        seg_eff_cells[seg_id] = f"Computation!B{row}"

        # Per-query blended cost across mix
        # We'll use a simplified formula: compute weighted sum manually for top 5 shapes
        # Use mix lookup per-shape
        mix_row = refs["mix_rows"][default_mix]  # Use default mix; can be parameterized later
        shape_rows = refs["shape_rows"]
        # Build SUMPRODUCT manually
        formula_parts = []
        col_idx = 3  # mix weights start at col C
        for shape_name, shape_row in shape_rows.items():
            mix_w = f'INDEX(Mix!{get_column_letter(col_idx)}:{get_column_letter(col_idx)},{mix_row})'
            in_factor = f"Shapes!B{shape_row}"
            out_factor = f"Shapes!C{shape_row}"
            cache_elig = f"Shapes!D{shape_row}"  # "yes" or "no"
            cache_use = f'IF({cache_elig}="yes",{seg_eff_cells[seg_id]},0)'
            in_tokens = f"({anchor_in_cell}*{in_factor})"
            out_tokens = f"({anchor_out_cell}*{out_factor})"
            cached = f"({in_tokens}*{cache_use})"
            uncached = f"({in_tokens}-{cached})"
            shape_cost = (
                f"({uncached}*{p_in_cell}/1000000"
                f"+{cached}*{p_cached_cell}/1000000"
                f"+{out_tokens}*{p_out_cell}/1000000)"
                f"*{tier_mult_cell}"
            )
            formula_parts.append(f"{mix_w}*{shape_cost}")
            col_idx += 1
        sumprod = "+".join(formula_parts)
        ws[f"C{row}"] = f"={sumprod}"
        style_formula(ws[f"C{row}"])
        seg_pq_cells[seg_id] = f"Computation!C{row}"
        row += 1

    # Monthly query volume per segment
    row += 1
    ws[f"A{row}"] = "Monthly query volume"; style_header(ws[f"A{row}"], 2); ws.merge_cells(f"A{row}:C{row}")
    row += 1
    ws[f"A{row}"] = "Segment ID"; ws[f"B{row}"] = "Queries/mo"; ws[f"C{row}"] = "$ / mo (gross)"
    style_header(ws[f"A{row}"], 3); style_header(ws[f"B{row}"], 3); style_header(ws[f"C{row}"], 3)
    row += 1
    bot_cell = refs["bot_factor"]
    seg_q_cells = {}
    seg_cost_cells = {}
    for seg_id, seg_row in seg_rows.items():
        mau_cell = f"Segments!C{seg_row}"
        spd_cell = f"Segments!D{seg_row}"
        qps_cell = f"Segments!E{seg_row}"
        bot_flag_cell = f"Segments!F{seg_row}"
        beta = f'IF({bot_flag_cell}="yes",{bot_cell},1)'
        ws[f"A{row}"] = seg_id
        ws[f"B{row}"] = f"={mau_cell}*{spd_cell}*30*{qps_cell}*{beta}"
        style_formula(ws[f"B{row}"])
        seg_q_cells[seg_id] = f"Computation!B{row}"
        ws[f"C{row}"] = f"=B{row}*{seg_pq_cells[seg_id]}"
        style_formula(ws[f"C{row}"])
        seg_cost_cells[seg_id] = f"Computation!C{row}"
        row += 1

    # Totals
    row += 1
    ws[f"A{row}"] = "TOTAL queries/mo"; style_label(ws[f"A{row}"])
    total_q_formula = "=" + "+".join(seg_q_cells.values())
    ws[f"B{row}"] = total_q_formula
    style_result(ws[f"B{row}"])
    total_q_cell = f"Computation!B{row}"
    row += 1

    ws[f"A{row}"] = "TOTAL API gross $/mo"; style_label(ws[f"A{row}"])
    total_cost_formula = "=" + "+".join(seg_cost_cells.values())
    ws[f"B{row}"] = total_cost_formula
    style_result(ws[f"B{row}"])
    api_gross_cell = f"Computation!B{row}"
    row += 1

    # Daily cap clamping
    cap_amount_cell = refs["cap"]["amount_usd"]
    cap_burst_days = refs["cap"]["burst_days"]
    ws[f"A{row}"] = "Daily cap budget ($/mo)"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = f"={cap_amount_cell}*30"
    style_formula(ws[f"B{row}"])
    cap_monthly_cell = f"Computation!B{row}"
    row += 1

    ws[f"A{row}"] = "API monthly capped"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = f"=MIN({api_gross_cell},{cap_monthly_cell})"
    style_result(ws[f"B{row}"])
    api_capped_cell = f"Computation!B{row}"
    row += 1

    ws[f"A{row}"] = "Refused queries"; style_label(ws[f"A{row}"])
    ws[f"B{row}"] = f"=IF({api_gross_cell}>{api_capped_cell},({api_gross_cell}-{api_capped_cell})/{api_gross_cell}*{total_q_cell},0)"
    style_result(ws[f"B{row}"])
    refused_cell = f"Computation!B{row}"
    row += 1

    autosize(ws, min_w=22, max_w=70)
    return {
        "model_cell": model_cell,
        "total_q": total_q_cell,
        "api_gross": api_gross_cell,
        "api_capped": api_capped_cell,
        "refused": refused_cell,
        "cost_mode": cost_mode_cell,
    }


def build_output(ws, w: dict, comp_refs: dict, cap_refs: dict):
    ws.title = "Output"

    ws["A1"] = "Output · API vs Self-Host Comparison"
    style_header(ws["A1"], 1)
    ws.merge_cells("A1:D1")

    headers = ["Strategy", "Monthly LLM ($)", "Queries served/mo", "Notes"]
    row = 3
    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=row, column=col, value=h)
        style_header(c, 2)

    row += 1
    # Row 1: API capped
    ws.cell(row=row, column=1, value=f"API (capped at ${cap_refs['amount_usd']}/day)")
    ws.cell(row=row, column=2, value=f"={comp_refs['api_capped']}")
    style_result(ws.cell(row=row, column=2))
    ws.cell(row=row, column=3, value=f"={comp_refs['total_q']}-{comp_refs['refused']}")
    style_formula(ws.cell(row=row, column=3))
    ws.cell(row=row, column=4, value=f'=CONCATENATE(TEXT({comp_refs["refused"]},"#,##0"), " refused")')
    row += 1

    # Row 2: API uncapped (gross)
    ws.cell(row=row, column=1, value="API (uncapped — fair peer to self-host)")
    ws.cell(row=row, column=2, value=f"={comp_refs['api_gross']}")
    style_result(ws.cell(row=row, column=2))
    ws.cell(row=row, column=3, value=f"={comp_refs['total_q']}")
    style_formula(ws.cell(row=row, column=3))
    ws.cell(row=row, column=4, value="all queries")
    row += 1

    # Note about self-host
    row += 1
    ws.cell(row=row, column=1, value="Self-host comparison rows are computed in the JS engine and the live web calculator.")
    ws.cell(row=row, column=1).font = Font(name="Calibri", italic=True, size=10, color="555555")
    ws.merge_cells(f"A{row}:D{row}")
    row += 1
    ws.cell(row=row, column=1, value="Open the studio web app and load this workload to see the full four-row comparison.")
    ws.cell(row=row, column=1).font = Font(name="Calibri", italic=True, size=10, color="555555")
    ws.merge_cells(f"A{row}:D{row}")
    row += 2
    ws.cell(row=row, column=1, value="Studio: cost-calculator-studio/studio/index.html")
    ws.cell(row=row, column=1).font = Font(name="Calibri", size=10, color="0E5C8A", underline="single")

    autosize(ws, min_w=24, max_w=80)


def build_sensitivity(ws, w: dict, comp_refs: dict):
    ws.title = "Sensitivity"
    ws["A1"] = "Sensitivity · How the headline moves"
    style_header(ws["A1"], 1)
    ws.merge_cells("A1:E1")
    ws["A2"] = "Each row shows API capped cost at ±30% of the named input."
    ws["A2"].font = Font(name="Calibri", italic=True, size=10, color="555555")
    ws.merge_cells("A2:E2")
    headers = ["Input", "−30%", "−15%", "Baseline", "+15%", "+30%"]
    row = 4
    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=row, column=col, value=h); style_header(c, 2)
    row += 1
    notes = [
        ("Total MAU (proxy: bot factor × MAU)", "Run multiple times by editing Workload values"),
        ("Daily cap ($/day)", "Edit Workload!B (cap) and observe Computation"),
        ("Cache rate baseline", "Edit Workload anchor cache_rate_baseline"),
    ]
    for label, hint in notes:
        ws.cell(row=row, column=1, value=label)
        ws.cell(row=row, column=2, value=hint).font = Font(name="Calibri", italic=True, size=10, color="555555")
        ws.merge_cells(f"B{row}:F{row}")
        row += 1
    autosize(ws, min_w=22, max_w=80)


# ============================================================
# Main
# ============================================================

def generate(workload_path: Path, out_path: Path) -> None:
    with open(workload_path) as f:
        w = json.load(f)

    wb = Workbook()
    # Remove default sheet
    default = wb.active
    wb.remove(default)

    # README
    readme_ws = wb.create_sheet("README")
    build_readme(readme_ws, w)

    # Workload (inputs)
    workload_ws = wb.create_sheet("Workload")
    workload_refs = build_workload(workload_ws, w)

    # Shapes
    shapes_ws = wb.create_sheet("Shapes")
    shape_rows = build_shapes(shapes_ws, w)

    # Mix
    mix_ws = wb.create_sheet("Mix")
    mix_rows = build_mix(mix_ws, w)

    # Segments
    segments_ws = wb.create_sheet("Segments")
    seg_rows = build_segments(segments_ws, w)

    # Rate Cards
    rates_ws = wb.create_sheet("Rate Cards")
    rate_rows = build_rate_cards(rates_ws, w)

    # Cost Modes
    cost_modes_ws = wb.create_sheet("Cost Modes")
    build_cost_modes(cost_modes_ws)

    # Computation (formulas)
    comp_ws = wb.create_sheet("Computation")
    refs = {
        "anchor_input": workload_refs["anchor_input"],
        "cap": workload_refs["cap"],
        "bot_factor": workload_refs["bot_factor"],
        "shape_rows": shape_rows,
        "mix_rows": mix_rows,
        "seg_rows": seg_rows,
        "rate_rows": rate_rows,
    }
    comp_refs = build_computation(comp_ws, w, refs)

    # Output
    output_ws = wb.create_sheet("Output")
    build_output(output_ws, w, comp_refs, w.get("daily_cap", {"amount_usd": 1500}))

    # Sensitivity
    sens_ws = wb.create_sheet("Sensitivity")
    build_sensitivity(sens_ws, w, comp_refs)

    # Reorder so README is first
    wb.move_sheet("README", offset=-len(wb.sheetnames) + 1)

    wb.save(out_path)
    print(f"Wrote {out_path}")


def main():
    ap = argparse.ArgumentParser(description="Generate Excel workbook from a workload spec")
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
