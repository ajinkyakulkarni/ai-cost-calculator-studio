"""Tests for the render_map tool: schema, URL builder, dispatch, handler modes.

All tests are pure — no network calls, no LLM API calls.
"""

from __future__ import annotations

import json
from unittest.mock import patch


from agent_cost_bench.eie.schemas import RenderMapReturn


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_COLLECTION = "lis-global-da-gpp"
_ITEM = "LIS_GPP_202006010000.d01.cog"
_BBOX = (-123.8944, 38.7596, -122.8222, 40.0011)
_COLORMAP = "viridis"


# ---------------------------------------------------------------------------
# 1. Schema: RenderMapReturn
# ---------------------------------------------------------------------------

def test_render_map_return_has_expected_fields():
    r = RenderMapReturn(
        map_url="https://example.com/preview.png",
        item_id=_ITEM,
        collection_id=_COLLECTION,
        colormap=_COLORMAP,
    )
    assert r.map_url == "https://example.com/preview.png"
    assert r.item_id == _ITEM
    assert r.collection_id == _COLLECTION
    assert r.colormap == _COLORMAP


def test_render_map_return_serialises_all_fields():
    r = RenderMapReturn(
        map_url="https://example.com/preview.png",
        item_id=_ITEM,
        collection_id=_COLLECTION,
        colormap=_COLORMAP,
    )
    d = json.loads(r.model_dump_json())
    assert "map_url" in d
    assert "item_id" in d
    assert "collection_id" in d
    assert "colormap" in d


# ---------------------------------------------------------------------------
# 2. build_preview_url — pure string builder, no HTTP
# ---------------------------------------------------------------------------

def test_build_preview_url_contains_bbox_path():
    from agent_cost_bench.eie.map_preview import build_preview_url
    minx, miny, maxx, maxy = _BBOX
    url = build_preview_url(_COLLECTION, _ITEM, _BBOX)
    seg = f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}.png"
    assert seg in url, f"bbox segment {seg!r} not found in URL: {url}"


def test_build_preview_url_contains_collection_and_item():
    from agent_cost_bench.eie.map_preview import build_preview_url
    url = build_preview_url(_COLLECTION, _ITEM, _BBOX)
    assert _COLLECTION in url
    assert _ITEM in url


def test_build_preview_url_default_colormap_viridis():
    from agent_cost_bench.eie.map_preview import build_preview_url
    url = build_preview_url(_COLLECTION, _ITEM, _BBOX)
    assert "colormap_name=viridis" in url


def test_build_preview_url_custom_colormap():
    from agent_cost_bench.eie.map_preview import build_preview_url
    url = build_preview_url(_COLLECTION, _ITEM, _BBOX, colormap="plasma")
    assert "colormap_name=plasma" in url
    assert "colormap_name=viridis" not in url


def test_build_preview_url_default_asset():
    from agent_cost_bench.eie.map_preview import build_preview_url
    url = build_preview_url(_COLLECTION, _ITEM, _BBOX)
    assert "assets=cog_default" in url


def test_build_preview_url_default_rescale():
    from agent_cost_bench.eie.map_preview import build_preview_url
    url = build_preview_url(_COLLECTION, _ITEM, _BBOX)
    assert "rescale=0.0" in url and "0.0002" in url


def test_build_preview_url_no_http_call(monkeypatch):
    """build_preview_url must not trigger any network call."""
    import httpx
    monkeypatch.setattr(httpx, "Client", lambda **kw: (_ for _ in ()).throw(
        RuntimeError("build_preview_url must not make HTTP calls")
    ))
    from agent_cost_bench.eie.map_preview import build_preview_url
    # Should not raise even with httpx.Client monkeypatched out
    url = build_preview_url(_COLLECTION, _ITEM, _BBOX)
    assert isinstance(url, str)
    assert len(url) > 0


# ---------------------------------------------------------------------------
# 3. render_preview still uses build_preview_url (refactor sanity)
# ---------------------------------------------------------------------------

def test_render_preview_uses_build_preview_url(httpx_mock):
    """render_preview must produce the same URL path that build_preview_url generates."""
    from agent_cost_bench.eie.map_preview import build_preview_url, render_preview

    expected_url = build_preview_url(_COLLECTION, _ITEM, _BBOX)
    _PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
    httpx_mock.add_response(
        method="GET",
        url=expected_url,
        content=_PNG_MAGIC,
        headers={"content-type": "image/png"},
    )
    result = render_preview(_COLLECTION, _ITEM, _BBOX)
    assert isinstance(result, bytes)


# ---------------------------------------------------------------------------
# 4. veda_tools.render_map — returns RenderMapReturn, no HTTP
# ---------------------------------------------------------------------------

def test_render_map_returns_render_map_return():
    from agent_cost_bench.eie.veda_tools import render_map
    result = render_map(_COLLECTION, _ITEM, _BBOX)
    assert isinstance(result, RenderMapReturn)


def test_render_map_url_is_well_formed():
    from agent_cost_bench.eie.veda_tools import render_map
    r = render_map(_COLLECTION, _ITEM, _BBOX)
    # URL must contain the bbox path segment
    minx, miny, maxx, maxy = _BBOX
    seg = f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}.png"
    assert seg in r.map_url, f"bbox segment not in map_url: {r.map_url}"


def test_render_map_url_contains_colormap():
    from agent_cost_bench.eie.veda_tools import render_map
    r = render_map(_COLLECTION, _ITEM, _BBOX, colormap="rdylgn")
    assert "colormap_name=rdylgn" in r.map_url


def test_render_map_fields_roundtrip():
    from agent_cost_bench.eie.veda_tools import render_map
    r = render_map(_COLLECTION, _ITEM, _BBOX, colormap="plasma")
    assert r.item_id == _ITEM
    assert r.collection_id == _COLLECTION
    assert r.colormap == "plasma"


def test_render_map_default_colormap_viridis():
    from agent_cost_bench.eie.veda_tools import render_map
    r = render_map(_COLLECTION, _ITEM, _BBOX)
    assert r.colormap == "viridis"
    assert "colormap_name=viridis" in r.map_url


def test_render_map_makes_no_http_call(monkeypatch):
    """render_map must be deterministic: no HTTP, no network."""
    import httpx

    def fail_if_used(**kw):
        raise RuntimeError("render_map must not make HTTP calls")

    monkeypatch.setattr(httpx, "Client", fail_if_used)
    from agent_cost_bench.eie.veda_tools import render_map
    # Should not raise
    result = render_map(_COLLECTION, _ITEM, _BBOX)
    assert isinstance(result, RenderMapReturn)


# ---------------------------------------------------------------------------
# 5. get_tool_schemas — conditional inclusion of render_map
# ---------------------------------------------------------------------------

def test_get_tool_schemas_without_map_has_5_tools():
    from agent_cost_bench.eie.dispatch import get_tool_schemas
    schemas = get_tool_schemas(with_map=False)
    names = [s["function"]["name"] for s in schemas]
    assert len(names) == 5
    assert "render_map" not in names


def test_get_tool_schemas_with_map_has_6_tools():
    from agent_cost_bench.eie.dispatch import get_tool_schemas
    schemas = get_tool_schemas(with_map=True)
    names = [s["function"]["name"] for s in schemas]
    assert len(names) == 6
    assert "render_map" in names


def test_get_tool_schemas_default_is_without_map():
    from agent_cost_bench.eie.dispatch import get_tool_schemas
    schemas = get_tool_schemas()
    names = [s["function"]["name"] for s in schemas]
    assert "render_map" not in names


def test_tool_schemas_base_constant_unchanged():
    """TOOL_SCHEMAS (base 5) is not mutated by get_tool_schemas."""
    from agent_cost_bench.eie.dispatch import TOOL_SCHEMAS, get_tool_schemas
    _ = get_tool_schemas(with_map=True)
    names = [s["function"]["name"] for s in TOOL_SCHEMAS]
    assert "render_map" not in names
    assert len(TOOL_SCHEMAS) == 5


def test_render_map_schema_has_required_params():
    from agent_cost_bench.eie.dispatch import get_tool_schemas
    schemas = get_tool_schemas(with_map=True)
    rm = next(s for s in schemas if s["function"]["name"] == "render_map")
    params = rm["function"]["parameters"]
    required = params.get("required", [])
    props = params.get("properties", {})
    assert "collection_id" in props
    assert "item_id" in props
    assert "bbox" in props
    assert "colormap" in props  # optional but documented
    assert "collection_id" in required
    assert "item_id" in required
    assert "bbox" in required


# ---------------------------------------------------------------------------
# 6. dispatch_tool_call routes render_map correctly
# ---------------------------------------------------------------------------

def test_dispatch_render_map_status_mode():
    from agent_cost_bench.eie.dispatch import dispatch_tool_call
    from agent_cost_bench.eie.handlers import StatusOnlyHandler
    h = StatusOnlyHandler()
    args = {
        "collection_id": _COLLECTION,
        "item_id": _ITEM,
        "bbox": list(_BBOX),
        "colormap": "viridis",
    }
    out = dispatch_tool_call("render_map", args, h, "tc_rm_01")
    parsed = json.loads(out)
    # StatusOnlyHandler returns a StatusReturn with summary containing the URL
    assert "map ready" in parsed["summary"] or "map_url" in parsed.get("summary", "")
    # The map URL must appear somewhere in the output
    minx, miny, maxx, maxy = _BBOX
    seg = f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}"
    assert seg in out, f"bbox segment not in status output: {out}"


def test_dispatch_render_map_key_fields_mode():
    from agent_cost_bench.eie.dispatch import dispatch_tool_call
    from agent_cost_bench.eie.handlers import KeyFieldsHandler
    h = KeyFieldsHandler()
    args = {
        "collection_id": _COLLECTION,
        "item_id": _ITEM,
        "bbox": list(_BBOX),
    }
    out = dispatch_tool_call("render_map", args, h, "tc_rm_02")
    parsed = json.loads(out)
    assert "map_url" in parsed
    minx, miny, maxx, maxy = _BBOX
    seg = f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}"
    assert seg in parsed["map_url"]


def test_dispatch_render_map_freeform_mode():
    from agent_cost_bench.eie.dispatch import dispatch_tool_call
    from agent_cost_bench.eie.handlers import FreeformHandler
    h = FreeformHandler()
    args = {
        "collection_id": _COLLECTION,
        "item_id": _ITEM,
        "bbox": list(_BBOX),
        "colormap": "plasma",
    }
    out = dispatch_tool_call("render_map", args, h, "tc_rm_03")
    parsed = json.loads(out)
    assert "map_url" in parsed
    assert "plasma" in parsed["map_url"]


def test_dispatch_render_map_url_survives_all_three_modes():
    """The map_url string is present in all three handler mode outputs."""
    from agent_cost_bench.eie.dispatch import dispatch_tool_call
    from agent_cost_bench.eie.handlers import (
        StatusOnlyHandler, KeyFieldsHandler, FreeformHandler,
    )
    args = {
        "collection_id": _COLLECTION,
        "item_id": _ITEM,
        "bbox": list(_BBOX),
        "colormap": "viridis",
    }
    minx, miny, maxx, maxy = _BBOX
    seg = f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}"

    for handler_cls in (StatusOnlyHandler, KeyFieldsHandler, FreeformHandler):
        h = handler_cls()
        out = dispatch_tool_call("render_map", args, h, "tc_rm_modes")
        assert seg in out, (
            f"bbox segment missing from {handler_cls.__name__} output: {out}"
        )


# ---------------------------------------------------------------------------
# 7. Handlers: StatusOnlyHandler._summarize handles RenderMapReturn
# ---------------------------------------------------------------------------

def test_status_handler_render_map_summary_contains_url():
    from agent_cost_bench.eie.handlers import StatusOnlyHandler
    h = StatusOnlyHandler()
    r = RenderMapReturn(
        map_url="https://openveda.cloud/api/raster/collections/lis/items/x/bbox/-123.0000,38.0000,-122.0000,40.0000.png?assets=cog_default&rescale=0.0%2C0.0002&colormap_name=viridis&width=400&height=400",
        item_id="x",
        collection_id="lis",
        colormap="viridis",
    )
    out = h.wrap("render_map", "tc_sum_01", r)
    parsed = json.loads(out)
    assert parsed["ok"] is True
    # URL must appear in the summary (the agent relays it verbatim)
    assert "https://" in parsed["summary"] or "map ready" in parsed["summary"]
    # The actual URL must be somewhere in the output so the agent can relay it
    assert "openveda.cloud" in out


# ---------------------------------------------------------------------------
# 8. ScenarioCfg: emit_map field
# ---------------------------------------------------------------------------

def test_scenario_cfg_emit_map_defaults_false():
    from agent_cost_bench.eie.scenario_loader import ScenarioCfg
    cfg = ScenarioCfg(
        id="test",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    assert cfg.emit_map is False


def test_scenario_cfg_emit_map_roundtrips_true():
    from agent_cost_bench.eie.scenario_loader import ScenarioCfg
    cfg = ScenarioCfg(
        id="test",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
        emit_map=True,
    )
    assert cfg.emit_map is True


def test_scenario_cfg_emit_map_dataclass_replace():
    from dataclasses import replace
    from agent_cost_bench.eie.scenario_loader import ScenarioCfg
    cfg = ScenarioCfg(
        id="test",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    assert cfg.emit_map is False
    patched = replace(cfg, emit_map=True)
    assert patched.emit_map is True
    assert cfg.emit_map is False  # original unchanged


# ---------------------------------------------------------------------------
# 9. report: emit_map in key tuple — same (scenario_id, enforce_compute_stats)
#    but different emit_map → two distinct entries
# ---------------------------------------------------------------------------

def _make_trace_with_map(scenario_id, pattern, handler_mode,
                          enforce_compute_stats=False, emit_map=False,
                          input_tokens=10_000):
    n = 5
    return {
        "scenario_id": scenario_id,
        "pattern": pattern,
        "handler_mode": handler_mode,
        "model": "gpt-5.2",
        "turn_count": n,
        "elapsed_s": 12.3,
        "enforce_compute_stats": enforce_compute_stats,
        "emit_map": emit_map,
        "totals": {
            "input_tokens": input_tokens,
            "output_tokens": 1_000,
            "cached_tokens": 5_000,
            "cache_hit_rate": 0.5,
        },
        "per_turn_avg": {
            "input_tokens": input_tokens / n,
            "output_tokens": 200.0,
        },
        "turns": [],
    }


def test_report_two_emit_map_variants_produce_two_entries(tmp_path):
    """Natural (emit_map=False) and map (emit_map=True) traces produce separate entries."""
    from unittest.mock import patch
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-status-only"
    natural = _make_trace_with_map(sid, "paper", "status_only", emit_map=False, input_tokens=1_000)
    with_map = _make_trace_with_map(sid, "paper", "status_only", emit_map=True, input_tokens=2_000)

    (tmp_path / f"{sid}-natural.trace.json").write_text(json.dumps(natural))
    (tmp_path / f"{sid}-map.trace.json").write_text(json.dumps(with_map))

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        traces = rmod._latest_traces()

    assert len(traces) == 2
    # One key with emit_map=False, one with emit_map=True
    map_values = [t.get("emit_map", False) for t in traces.values()]
    assert False in map_values
    assert True in map_values


def test_report_backward_compat_no_emit_map(tmp_path):
    """Old traces without emit_map are treated as emit_map=False."""
    from unittest.mock import patch
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-freeform"
    old_trace = _make_trace_with_map(sid, "paper", "freeform")
    # Remove emit_map to simulate old trace
    del old_trace["emit_map"]
    (tmp_path / f"{sid}-old.trace.json").write_text(json.dumps(old_trace))

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        traces = rmod._latest_traces()

    assert len(traces) == 1
    # Key must include emit_map=False (the backward-compat default)
    key_tuples = list(traces.keys())
    assert len(key_tuples[0]) == 3  # (scenario_id, enforce_compute_stats, emit_map)
    assert key_tuples[0][2] is False  # emit_map defaults to False


def test_report_map_column_present_in_table(tmp_path):
    """Report table header includes a 'map' column."""
    from unittest.mock import patch
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-status-only"
    t = _make_trace_with_map(sid, "paper", "status_only", emit_map=False)
    (tmp_path / f"{sid}.trace.json").write_text(json.dumps(t))

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        out = rmod.emit_report()

    content = out.read_text()
    assert "map" in content.lower()


def test_report_emit_map_y_n_labels(tmp_path):
    """Y/N labels appear in the map column for emit_map=True and False rows."""
    from unittest.mock import patch
    from agent_cost_bench.eie import report as rmod

    sid = "pattern-paper-status-only"
    natural = _make_trace_with_map(sid, "paper", "status_only", emit_map=False)
    with_map = _make_trace_with_map(sid, "paper", "status_only", emit_map=True, input_tokens=9_000)

    (tmp_path / f"{sid}-natural.trace.json").write_text(json.dumps(natural))
    (tmp_path / f"{sid}-map.trace.json").write_text(json.dumps(with_map))

    with patch.object(rmod, "REPORTS_DIR", tmp_path):
        out = rmod.emit_report()

    content = out.read_text()
    assert "N" in content
    assert "Y" in content


# ---------------------------------------------------------------------------
# 10. Pattern-level: emit_map=True injects render_map into tool list + system prompt
# ---------------------------------------------------------------------------

def _make_paper_stub_responses():
    """Minimal stub that ends immediately with a final answer."""
    return iter([
        {
            "role": "assistant",
            "content": "Mean GPP: 0.12 gC/m2/day.",
            "_usage": {"prompt_tokens": 50, "completion_tokens": 40, "total_tokens": 90},
        }
    ])


def _make_eie_stub_responses():
    """Minimal EIE stub that ends immediately."""
    return iter([
        {
            "role": "assistant",
            "content": "Done.",
            "_usage": {"prompt_tokens": 50, "completion_tokens": 40, "total_tokens": 90},
        }
    ])


_RENDER_MAP_INSTRUCTION = (
    "After compute_stats, call render_map"
)


def test_pattern_paper_emit_map_true_includes_render_map_in_tools():
    """When emit_map=True, the tool list passed to call_llm includes render_map."""
    from agent_cost_bench.eie.pattern_paper import build_pattern_p_graph, initial_state
    from agent_cost_bench.eie.handlers import StatusOnlyHandler

    captured_tools: list[list] = []

    def capturing_llm(**kw):
        captured_tools.append(kw.get("tools", []))
        return {
            "role": "assistant",
            "content": "Done.",
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=capturing_llm):
        handler = StatusOnlyHandler()
        graph = build_pattern_p_graph(handler=handler, model="gpt-stub")
        state = initial_state(handler=handler, model="gpt-stub", emit_map=True)
        graph.invoke(state)

    assert captured_tools, "call_llm was never invoked"
    tool_names = [t["function"]["name"] for t in captured_tools[0]]
    assert "render_map" in tool_names, (
        f"render_map not in tool list: {tool_names}"
    )


def _extract_system_content(msgs) -> str | None:
    """Extract system message content from raw dicts or LangChain message objects."""
    for m in msgs:
        if isinstance(m, dict):
            if m.get("role") == "system":
                return m["content"]
        else:
            if getattr(m, "type", None) == "system":
                return getattr(m, "content", None)
    return None


def test_pattern_paper_emit_map_true_includes_instruction_in_system_prompt():
    """When emit_map=True, the system prompt contains the render_map instruction."""
    from agent_cost_bench.eie.pattern_paper import build_pattern_p_graph, initial_state
    from agent_cost_bench.eie.handlers import StatusOnlyHandler

    captured_prompts: list[str] = []

    def capturing_llm(**kw):
        content = _extract_system_content(kw.get("messages", []))
        if content is not None:
            captured_prompts.append(content)
        return {
            "role": "assistant",
            "content": "Done.",
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=capturing_llm):
        handler = StatusOnlyHandler()
        graph = build_pattern_p_graph(handler=handler, model="gpt-stub")
        state = initial_state(handler=handler, model="gpt-stub", emit_map=True)
        graph.invoke(state)

    assert captured_prompts, "no system message captured"
    assert _RENDER_MAP_INSTRUCTION in captured_prompts[0], (
        f"render_map instruction missing from system prompt: {captured_prompts[0][:300]}"
    )


def test_pattern_paper_emit_map_false_no_render_map_in_tools():
    """When emit_map=False (default), render_map is absent from the tool list."""
    from agent_cost_bench.eie.pattern_paper import build_pattern_p_graph, initial_state
    from agent_cost_bench.eie.handlers import StatusOnlyHandler

    captured_tools: list[list] = []

    def capturing_llm(**kw):
        captured_tools.append(kw.get("tools", []))
        return {
            "role": "assistant",
            "content": "Done.",
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=capturing_llm):
        handler = StatusOnlyHandler()
        graph = build_pattern_p_graph(handler=handler, model="gpt-stub")
        state = initial_state(handler=handler, model="gpt-stub")
        graph.invoke(state)

    assert captured_tools
    tool_names = [t["function"]["name"] for t in captured_tools[0]]
    assert "render_map" not in tool_names


def test_pattern_eie_emit_map_true_includes_render_map_in_tools():
    """Pattern E: emit_map=True also injects render_map into the tool list."""
    from agent_cost_bench.eie.pattern_eie import build_pattern_e_graph, initial_state
    from agent_cost_bench.eie.handlers import StatusOnlyHandler
    from agent_cost_bench.eie.user_actor import UserActor

    captured_tools: list[list] = []

    def capturing_llm(**kw):
        captured_tools.append(kw.get("tools", []))
        return {
            "role": "assistant",
            "content": "Done.",
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    with patch("agent_cost_bench.eie.pattern_eie.call_llm",
               side_effect=capturing_llm):
        handler = StatusOnlyHandler()
        actor = UserActor.frozen_default()
        graph = build_pattern_e_graph(handler=handler, user_actor=actor, model="gpt-stub")
        state = initial_state(handler=handler, user_actor=actor, model="gpt-stub", emit_map=True)
        graph.invoke(state)

    assert captured_tools, "call_llm was never invoked"
    # Pattern E adds ASK_USER_TOOL to the list; check render_map is also there
    tool_names = [t["function"]["name"] for t in captured_tools[0]]
    assert "render_map" in tool_names


def test_pattern_eie_emit_map_true_includes_instruction_in_system_prompt():
    """Pattern E: emit_map=True adds render_map instruction to system prompt."""
    from agent_cost_bench.eie.pattern_eie import build_pattern_e_graph, initial_state
    from agent_cost_bench.eie.handlers import StatusOnlyHandler
    from agent_cost_bench.eie.user_actor import UserActor

    captured_prompts: list[str] = []

    def capturing_llm(**kw):
        content = _extract_system_content(kw.get("messages", []))
        if content is not None:
            captured_prompts.append(content)
        return {
            "role": "assistant",
            "content": "Done.",
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }

    with patch("agent_cost_bench.eie.pattern_eie.call_llm",
               side_effect=capturing_llm):
        handler = StatusOnlyHandler()
        actor = UserActor.frozen_default()
        graph = build_pattern_e_graph(handler=handler, user_actor=actor, model="gpt-stub")
        state = initial_state(handler=handler, user_actor=actor, model="gpt-stub", emit_map=True)
        graph.invoke(state)

    assert captured_prompts, "no system message captured"
    assert _RENDER_MAP_INSTRUCTION in captured_prompts[0]


# ---------------------------------------------------------------------------
# 11. Runner: emit_map in trace JSON
# ---------------------------------------------------------------------------

def _paper_stubs():
    return iter([
        {
            "role": "assistant",
            "content": "Done.",
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                       "prompt_tokens_details": {"cached_tokens": 0}},
        }
    ])


def _eie_stubs():
    return iter([
        {
            "role": "assistant",
            "content": "Done.",
            "_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                       "prompt_tokens_details": {"cached_tokens": 0}},
        }
    ])


def test_runner_emit_map_true_appears_in_trace(tmp_path):
    from agent_cost_bench.eie.scenario_loader import ScenarioCfg
    from agent_cost_bench.eie.runner import run_scenario

    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
        emit_map=True,
    )
    responses = _paper_stubs()

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=lambda n, a, h, i: f"ok:{n}"), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert trace["emit_map"] is True


def test_runner_emit_map_false_appears_in_trace(tmp_path):
    from agent_cost_bench.eie.scenario_loader import ScenarioCfg
    from agent_cost_bench.eie.runner import run_scenario

    cfg = ScenarioCfg(
        id="pattern-paper-status-only",
        pattern="paper",
        handler_mode="status_only",
        model="gpt-stub",
        description="test",
    )
    responses = _paper_stubs()

    with patch("agent_cost_bench.eie.pattern_paper.call_llm",
               side_effect=lambda **kw: next(responses)), \
         patch("agent_cost_bench.eie.pattern_paper.dispatch_tool_call",
               side_effect=lambda n, a, h, i: f"ok:{n}"), \
         patch("agent_cost_bench.eie.runner.REPORTS_DIR", tmp_path):
        out_path = run_scenario(cfg)

    trace = json.loads(out_path.read_text())
    assert trace["emit_map"] is False


# ---------------------------------------------------------------------------
# 12. CLI: --with-map flag
# ---------------------------------------------------------------------------

def test_cli_run_eie_templating_help_shows_with_map():
    from typer.testing import CliRunner
    from agent_cost_bench import cli

    result = CliRunner().invoke(cli.app, ["run-eie-templating", "--help"])
    assert result.exit_code == 0, result.output
    assert "--with-map" in result.output


def test_cli_run_eie_templating_with_map_sets_emit_map(tmp_path, monkeypatch):
    """--with-map causes emit_map=True on every scenario cfg passed to run_eie_scenario."""
    from typer.testing import CliRunner
    from agent_cost_bench import cli

    collected_cfgs: list = []

    def fake_run(cfg, **kwargs):
        collected_cfgs.append(cfg)
        # Return a fake trace path
        p = tmp_path / f"{cfg.id}.trace.json"
        p.write_text('{"ok": true}')
        return p

    monkeypatch.setattr(cli, "run_eie_scenario", fake_run)

    # Point scenario dir at the real one so IDs resolve
    result = CliRunner().invoke(
        cli.app,
        ["run-eie-templating", "--scenario", "pattern-paper-status-only", "--with-map"],
    )
    assert result.exit_code == 0, result.output
    assert collected_cfgs, "run_eie_scenario was never called"
    assert all(c.emit_map is True for c in collected_cfgs), (
        f"emit_map not set to True: {[c.emit_map for c in collected_cfgs]}"
    )
