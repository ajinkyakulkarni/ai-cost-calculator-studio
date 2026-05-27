"""Tool dispatch — given (tool_name, args, handler), route to the
right veda_tools function and wrap the return through the handler.
"""

import json
import pytest
from unittest.mock import patch, MagicMock
from agent_cost_bench.eie.dispatch import dispatch_tool_call
from agent_cost_bench.eie.handlers import StatusOnlyHandler, KeyFieldsHandler, FreeformHandler
from agent_cost_bench.eie.schemas import StacItemFields, SearchItemsReturn


def test_dispatch_parse_datetime_status_mode():
    h = StatusOnlyHandler()
    out = dispatch_tool_call("parse_datetime", {"value": "2020-06-01 to 2020-11-01"}, h, "tc_001")
    parsed = json.loads(out)
    assert parsed["ok"] is True
    assert "2020-06-01" in parsed["summary"]
    assert "2020-11-01" in parsed["summary"]


def test_dispatch_geocode_key_fields_mode():
    h = KeyFieldsHandler()
    out = dispatch_tool_call("geocode", {"query": "Mendocino County", "level": "county"}, h, "tc_002")
    parsed = json.loads(out)
    assert parsed["admin_name"] == "Mendocino County"
    assert "bbox" in parsed


# --- compute_stats dispatch correctness tests (C1 fix) ---

def _make_fake_items():
    return [
        StacItemFields(
            id="micasa-carbonflux-monthgrid-v1-2020-06",
            datetime="2020-06-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url="https://example.nasa.gov/cog/2020-06.tif",
        )
    ]


_GEOMETRY = {
    "type": "Polygon",
    "coordinates": [[
        [-123.89, 38.76], [-122.82, 38.76], [-122.82, 40.0],
        [-123.89, 40.0], [-123.89, 38.76],
    ]],
}


def test_compute_stats_uses_passed_items_not_refetch():
    """compute_stats must call veda_tools.compute_stats with the items
    the LLM passed via item_refs, and must NOT call search_items internally."""
    fake_items = _make_fake_items()
    fake_result = MagicMock()
    fake_result.model_dump_json.return_value = (
        '{"band":"FIRE","n_items":1,"mean":1.0,"median":1.0,"min":1.0,"max":1.0,"per_item":[]}'
    )

    with patch("agent_cost_bench.eie.dispatch.veda_tools.compute_stats", return_value=fake_result) as mock_compute, \
         patch("agent_cost_bench.eie.dispatch.veda_tools.search_items") as mock_search:

        items_as_dicts = [item.model_dump() for item in fake_items]
        args = {"item_refs": items_as_dicts, "band": "FIRE", "geometry": _GEOMETRY}
        h = KeyFieldsHandler()
        dispatch_tool_call("compute_stats", args, h, "tc_cs_01")

        # compute_stats must be called with the resolved StacItemFields items
        mock_compute.assert_called_once()
        called_items = mock_compute.call_args[0][0]
        assert len(called_items) == 1
        assert called_items[0].id == fake_items[0].id

        # search_items must NOT be called — no hidden STAC re-fetch
        mock_search.assert_not_called()


def test_compute_stats_empty_item_refs_raises():
    """When item_refs is empty (mode A: LLM never saw item IDs), dispatch
    raises ValueError rather than silently re-fetching from STAC.
    This is the honest measurement: mode A needs an extra search_items turn."""
    args = {"item_refs": [], "band": "FIRE", "geometry": _GEOMETRY}
    h = StatusOnlyHandler()

    with pytest.raises(ValueError, match="item_refs"):
        dispatch_tool_call("compute_stats", args, h, "tc_cs_02")


def test_compute_stats_missing_item_refs_raises():
    """item_refs key absent entirely also raises cleanly."""
    args = {"band": "FIRE", "geometry": _GEOMETRY}
    h = KeyFieldsHandler()

    with pytest.raises((ValueError, KeyError)):
        dispatch_tool_call("compute_stats", args, h, "tc_cs_03")
