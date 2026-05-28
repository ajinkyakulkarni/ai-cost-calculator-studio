"""StatusOnlyHandler — every tool return becomes ≤ 60 tokens.

The structured payload is held in agent-side state keyed by
tool_call_id. The LLM never sees raw STAC items, geometry coords,
asset URLs — only deterministic short summary strings.
"""

import json
from agent_cost_bench.eie.handlers import StatusOnlyHandler
from agent_cost_bench.eie.schemas import (
    CollectionMeta,
    GeocodeReturn,
    SearchCollectionsReturn,
    SearchItemsReturn,
    StacItemFields,
    ComputeStatsReturn,
)


def _approx_tokens(s: str) -> int:
    """OpenAI-ish heuristic: 1 token ≈ 4 chars."""
    return len(s) // 4


def test_status_handler_caps_geocode_response():
    h = StatusOnlyHandler()
    raw = GeocodeReturn(
        admin_name="Mendocino County",
        admin_level="county",
        bbox=(-123.89, 38.76, -122.82, 40.0),
    )
    out = h.wrap("geocode", "tc_001", raw)
    parsed = json.loads(out)
    assert parsed["ok"] is True
    assert "Mendocino County" in parsed["summary"]
    assert _approx_tokens(out) <= 60
    # The raw structured payload is held in handler state, not in the wrapped output:
    assert "bbox" not in parsed
    assert h.state["tc_001"].admin_name == "Mendocino County"


def test_status_handler_caps_search_items_with_many_items():
    h = StatusOnlyHandler()
    items = [
        StacItemFields(
            id=f"LIS_GPP_2020{i:02d}",
            datetime=f"2020-{i:02d}-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url=f"https://example.org/{i:02d}.tif",
        )
        for i in range(6, 12)
    ]
    raw = SearchItemsReturn(items=items, total_matched=6)
    out = h.wrap("search_items", "tc_002", raw)
    parsed = json.loads(out)
    assert "6 items" in parsed["summary"]
    assert _approx_tokens(out) <= 60


def test_status_handler_compute_stats_summary_includes_numbers():
    h = StatusOnlyHandler()
    raw = ComputeStatsReturn(
        band="cog_default", n_items=6, mean=1.96, median=2.0, min=0.0, max=4.98, per_item=[]
    )
    out = h.wrap("compute_stats", "tc_003", raw)
    parsed = json.loads(out)
    # Stats values DO surface in the summary because they ARE the final
    # answer the LLM composes from. Structured per-item array does not.
    assert "1.96" in parsed["summary"]
    assert "cog_default" in parsed["summary"]
    assert _approx_tokens(out) <= 60


def test_status_handler_search_collections_summary_keeps_ids():
    """Collection IDs survive status-only — they're the actionable handle the
    agent needs to call search_items. Bulky titles/descriptions are dropped."""
    h = StatusOnlyHandler()
    raw = SearchCollectionsReturn(
        collections=[
            CollectionMeta(id="lis-global-da-gpp", title="LIS Global DA GPP",
                           description="X" * 300),
            CollectionMeta(id="some-other-collection", title="Other", description="Y" * 300),
        ],
        total_matched=2,
    )
    out = h.wrap("search_collections", "tc_sc", raw)
    parsed = json.loads(out)
    assert "lis-global-da-gpp" in parsed["summary"]
    # The bulky description must NOT leak into the LLM context.
    assert "XXXX" not in parsed["summary"]


def test_status_handler_recovers_stashed_search_items():
    """recover_search_items returns the items the agent fetched but never saw,
    so compute_stats can run in status-only mode."""
    h = StatusOnlyHandler()
    assert h.recover_search_items() is None  # nothing stashed yet
    items = [
        StacItemFields(
            id="LIS_GPP_202008010000.d01.cog",
            datetime="2020-08-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url="https://example.org/x.tif",
            collection_id="lis-global-da-gpp",
        )
    ]
    h.wrap("search_items", "tc_si", SearchItemsReturn(items=items, total_matched=1))
    recovered = h.recover_search_items()
    assert recovered is not None and len(recovered) == 1
    assert recovered[0].id == "LIS_GPP_202008010000.d01.cog"
    assert recovered[0].collection_id == "lis-global-da-gpp"
