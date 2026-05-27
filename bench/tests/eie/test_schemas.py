"""Validate the typed schemas the response handlers consume + emit."""

import pytest
from agent_cost_bench.eie.schemas import (
    ParseDatetimeReturn,
    GeocodeReturn,
    SearchCollectionsReturn,
    StacItemFields,
    SearchItemsReturn,
    ComputeStatsReturn,
    StatusReturn,
)


def test_parse_datetime_round_trip():
    r = ParseDatetimeReturn(start="2020-06-01", end="2020-11-01")
    assert r.start == "2020-06-01"
    assert r.end == "2020-11-01"


def test_geocode_minimum_fields():
    r = GeocodeReturn(
        admin_name="Mendocino County",
        admin_level="county",
        bbox=(-123.89, 38.76, -122.82, 40.0),
    )
    assert r.admin_name == "Mendocino County"
    assert len(r.bbox) == 4


def test_search_items_holds_a_list_of_typed_items():
    items = [
        StacItemFields(
            id=f"micasa-{m:02d}",
            datetime=f"2020-{m:02d}-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url=f"https://example.org/{m:02d}.tif",
        )
        for m in range(6, 12)
    ]
    r = SearchItemsReturn(items=items, total_matched=len(items))
    assert r.total_matched == 6
    assert r.items[0].id == "micasa-06"


def test_compute_stats_has_aggregates_and_per_item():
    r = ComputeStatsReturn(
        band="FIRE",
        n_items=6,
        mean=1.96,
        median=2.0,
        min=0.0,
        max=4.98,
        per_item=[{"item_id": "m1", "mean": 1.0}],
    )
    assert r.n_items == 6


def test_status_return_caps_summary():
    r = StatusReturn(ok=True, summary="6 items found in micasa-carbonflux-monthgrid-v1, 2020-06 to 2020-10", tool_call_id="ti_3f2a")
    assert r.ok is True
    assert len(r.summary) < 200
