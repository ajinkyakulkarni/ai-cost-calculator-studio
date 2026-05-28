"""Tests for eie/viewer.py — static HTML viewer generator.

Uses fixture trace JSONs written to tmp_path; no real LLM calls.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Fixture helpers (mirror test_report.py style)
# ---------------------------------------------------------------------------

_SCENARIOS = [
    ("pattern-paper-status-only", "paper", "status_only"),
    ("pattern-paper-key-fields",  "paper", "key_fields"),
    ("pattern-paper-freeform",    "paper", "freeform"),
    ("pattern-eie-status-only",   "eie",   "status_only"),
    ("pattern-eie-key-fields",    "eie",   "key_fields"),
    ("pattern-eie-freeform",      "eie",   "freeform"),
]


def _make_trace(
    scenario_id: str,
    pattern: str,
    handler_mode: str,
    *,
    input_tokens: int = 10_000,
    output_tokens: int = 1_000,
    cached_tokens: int = 5_000,
    turn_count: int = 3,
    user_query: str = "What is the GPP over Mendocino?",
    final_answer: str = "Mean GPP: 0.12 gC/m2/day.",
    map_url: str | None = None,
    enforce_compute_stats: bool = False,
    emit_map: bool = False,
) -> dict:
    n = turn_count or 1
    cache_hit_rate = cached_tokens / input_tokens if input_tokens else 0.0
    turns = []
    per_in = input_tokens // n
    per_out = output_tokens // n
    per_cached = cached_tokens // n
    for i in range(n):
        turns.append({
            "input_tokens": per_in,
            "output_tokens": per_out,
            "cached_tokens": per_cached,
            "tool_calls": ["compute_stats"] if i == n - 1 else ["geocode"],
            "tool_calls_detail": [
                {"name": "compute_stats" if i == n - 1 else "geocode",
                 "args": {"query": "mendocino"}}
            ],
            "assistant_text": f"Turn {i + 1} thinking.",
        })
    return {
        "scenario_id": scenario_id,
        "pattern": pattern,
        "handler_mode": handler_mode,
        "model": "gpt-5.2",
        "enforce_compute_stats": enforce_compute_stats,
        "emit_map": emit_map,
        "turn_count": turn_count,
        "elapsed_s": 12.3,
        "user_query": user_query,
        "final_answer": final_answer,
        "map_url": map_url,
        "totals": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_tokens": cached_tokens,
            "cache_hit_rate": cache_hit_rate,
        },
        "per_turn_avg": {
            "input_tokens": input_tokens / n,
            "output_tokens": output_tokens / n,
        },
        "turns": turns,
    }


def _make_old_trace(scenario_id: str, pattern: str, handler_mode: str) -> dict:
    """Old-style trace without the new enrichment fields."""
    n = 3
    return {
        "scenario_id": scenario_id,
        "pattern": pattern,
        "handler_mode": handler_mode,
        "model": "gpt-5.2",
        "turn_count": n,
        "elapsed_s": 10.0,
        "totals": {
            "input_tokens": 5000,
            "output_tokens": 500,
            "cached_tokens": 2000,
            "cache_hit_rate": 0.4,
        },
        "per_turn_avg": {"input_tokens": 1667.0, "output_tokens": 167.0},
        "turns": [
            {"input_tokens": 1667, "output_tokens": 167,
             "cached_tokens": 667, "tool_calls": ["geocode"]}
            for _ in range(n)
        ],
    }


@pytest.fixture()
def reports_dir(tmp_path) -> Path:
    """Populate tmp_path with 6 enriched fixture trace JSONs and return the dir."""
    for sid, pattern, mode in _SCENARIOS:
        trace = _make_trace(sid, pattern, mode)
        (tmp_path / f"{sid}-2026-05-26T00-00-00.trace.json").write_text(
            json.dumps(trace)
        )
    return tmp_path


@pytest.fixture()
def reports_dir_old(tmp_path) -> Path:
    """Populate tmp_path with old-style traces (no enrichment fields)."""
    for sid, pattern, mode in _SCENARIOS:
        trace = _make_old_trace(sid, pattern, mode)
        (tmp_path / f"{sid}-2026-05-26T00-00-00.trace.json").write_text(
            json.dumps(trace)
        )
    return tmp_path


# ---------------------------------------------------------------------------
# 1. build_viewer writes a .html file
# ---------------------------------------------------------------------------

def test_build_viewer_creates_html_file(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    assert out.exists()
    assert out.suffix == ".html"


def test_build_viewer_fixed_filename(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    assert out.name == "eie-templating-viewer.html"


def test_build_viewer_path_inside_reports_dir(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    assert out.parent == reports_dir


# ---------------------------------------------------------------------------
# 2. HTML content — scenario ids and user_query
# ---------------------------------------------------------------------------

def test_html_contains_all_scenario_ids(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    content = out.read_text()
    for sid, _, _ in _SCENARIOS:
        assert sid in content, f"scenario id {sid!r} missing from HTML"


def test_html_contains_user_query_text(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    content = out.read_text()
    assert "What is the GPP over Mendocino?" in content


# ---------------------------------------------------------------------------
# 3. HTML content — projection presets
# ---------------------------------------------------------------------------

def test_html_contains_projection_presets(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    content = out.read_text()
    assert "50000" in content
    assert "75000" in content
    assert "915000" in content


def test_html_contains_queries_per_month_control(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    content = out.read_text()
    # Should have some form of queries/month label
    assert "queries" in content.lower()
    assert "month" in content.lower()


# ---------------------------------------------------------------------------
# 4. HTML content — per-turn cost embedded
# ---------------------------------------------------------------------------

def test_html_contains_dollar_sign_for_cost(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    content = out.read_text()
    assert "$" in content


# ---------------------------------------------------------------------------
# 5. Old-trace backward compat — no crash, HTML still generated
# ---------------------------------------------------------------------------

def test_build_viewer_handles_old_traces_without_crash(reports_dir_old):
    """build_viewer must not crash when traces lack new enrichment fields."""
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir_old):
        out = vmod.build_viewer()

    assert out.exists()
    content = out.read_text()
    # Scenario ids still appear
    for sid, _, _ in _SCENARIOS:
        assert sid in content


def test_build_viewer_empty_dir(tmp_path):
    """build_viewer on empty dir should not crash; writes a minimal viewer."""
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", tmp_path):
        out = vmod.build_viewer()

    assert out.exists()


# ---------------------------------------------------------------------------
# 6. Baked-in JS data correctness
# ---------------------------------------------------------------------------

def test_html_has_leaflet_cdn_reference(reports_dir):
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    content = out.read_text()
    assert "leaflet" in content.lower()
    assert "unpkg.com" in content


def test_html_baked_data_is_valid_within_script_tag(reports_dir):
    """The HTML should contain a <script> block with TRACE_DATA embedded."""
    from agent_cost_bench.eie import viewer as vmod

    with patch.object(vmod, "REPORTS_DIR", reports_dir):
        out = vmod.build_viewer()

    content = out.read_text()
    assert "<script" in content
    # The data variable or some JSON bracket should be present
    assert "TRACE_DATA" in content or '"scenario_id"' in content


# ---------------------------------------------------------------------------
# 7. map_url trace propagated into HTML
# ---------------------------------------------------------------------------

def test_html_contains_map_url_when_present(tmp_path):
    from agent_cost_bench.eie import viewer as vmod

    fake_url = "https://veda.example.com/map?collection=lis-global-da-gpp&item=item-1"
    trace = _make_trace(
        "pattern-paper-key-fields", "paper", "key_fields",
        map_url=fake_url, emit_map=True,
    )
    (tmp_path / "pattern-paper-key-fields-2026-05-26T00-00-00.trace.json").write_text(
        json.dumps(trace)
    )

    with patch.object(vmod, "REPORTS_DIR", tmp_path):
        out = vmod.build_viewer()

    content = out.read_text()
    assert fake_url in content
