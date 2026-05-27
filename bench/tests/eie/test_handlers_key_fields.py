"""KeyFieldsHandler — the production middle ground the paper omits.

Emits ~5-10 essential fields per tool response (Pydantic-shaped),
drops bulky metadata (full STAC properties dict, all non-primary
assets, geometry coords, provider blob). What most LangChain /
LangGraph agents actually do via structured_output + Pydantic.
"""

import json
from agent_cost_bench.eie.handlers import KeyFieldsHandler
from agent_cost_bench.eie.schemas import (
    GeocodeReturn,
    SearchItemsReturn,
    StacItemFields,
)


def test_key_fields_geocode_keeps_bbox_drops_geometry():
    h = KeyFieldsHandler()
    raw = GeocodeReturn(
        admin_name="Mendocino County",
        admin_level="county",
        bbox=(-123.89, 38.76, -122.82, 40.0),
    )
    out = h.wrap("geocode", "tc_001", raw)
    parsed = json.loads(out)
    assert parsed["admin_name"] == "Mendocino County"
    assert parsed["bbox"] == [-123.89, 38.76, -122.82, 40.0]


def test_key_fields_search_items_caps_at_10_entries():
    h = KeyFieldsHandler()
    # Create 25 items; handler should cap the emitted list at 10 even though
    # total_matched preserves the true count.
    items = [
        StacItemFields(
            id=f"micasa-{i:02d}",
            datetime=f"2020-{i:02d}-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url=f"https://example.org/{i:02d}.tif",
        )
        for i in range(25)
    ]
    raw = SearchItemsReturn(items=items, total_matched=25)
    out = h.wrap("search_items", "tc_002", raw)
    parsed = json.loads(out)
    assert parsed["total_matched"] == 25
    assert len(parsed["items"]) <= 10
    # Each emitted item has only the 4 schema fields, nothing else:
    assert set(parsed["items"][0].keys()) == {"id", "datetime", "bbox", "primary_asset_url"}
