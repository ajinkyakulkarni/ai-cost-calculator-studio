"""TDD test: FreeformHandler must emit the raw STAC blob, not the stripped Pydantic shape.

Bug I2: mode C was calling .model_dump_json() on SearchItemsReturn, which
is identical to mode B output (both emit the 4-field Pydantic schema).
The fix attaches raw_response on SearchItemsReturn / SearchCollectionsReturn
and FreeformHandler detects it to emit the full STAC payload.
"""

import json

from agent_cost_bench.eie.handlers import FreeformHandler, KeyFieldsHandler
from agent_cost_bench.eie.schemas import SearchItemsReturn, StacItemFields

# ---------------------------------------------------------------------------
# Synthetic raw STAC response that mimics what the real API returns:
# full geometry, multiple assets, all properties.
# ---------------------------------------------------------------------------
SYNTHETIC_RAW_RESPONSE = {
    "type": "FeatureCollection",
    "features": [
        {
            "id": "LIS_GPP_20200601",
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [-123.89, 38.76],
                        [-122.82, 38.76],
                        [-122.82, 40.0],
                        [-123.89, 40.0],
                        [-123.89, 38.76],
                    ]
                ],
            },
            "properties": {
                "datetime": "2020-06-01T00:00:00Z",
                "eo:cloud_cover": 0,
                "platform": "LIS",
                "provider": "NASA",
            },
            "assets": {
                "cog_default": {"href": "https://example.org/06.tif", "type": "image/tiff"},
                "cog_secondary": {"href": "https://example.org/06-secondary.tif", "type": "image/tiff"},
                "thumbnail": {"href": "https://example.org/06-thumb.png", "type": "image/png"},
            },
            "bbox": [-123.89, 38.76, -122.82, 40.0],
        }
    ],
    "numberMatched": 1,
    "numberReturned": 1,
}


def _make_search_items_return_with_raw() -> SearchItemsReturn:
    """Build a SearchItemsReturn that carries the raw STAC blob."""
    item = StacItemFields(
        id="LIS_GPP_20200601",
        datetime="2020-06-01T00:00:00Z",
        bbox=(-123.89, 38.76, -122.82, 40.0),
        primary_asset_url="https://example.org/06.tif",
    )
    r = SearchItemsReturn(items=[item], total_matched=1)
    r.raw_response = SYNTHETIC_RAW_RESPONSE  # type: ignore[attr-defined]
    return r


# ---------------------------------------------------------------------------
# Core bug-fix assertion: mode C emits geometry + multi-asset + properties
# ---------------------------------------------------------------------------

def test_freeform_emits_geometry_when_raw_response_attached():
    h = FreeformHandler()
    raw = _make_search_items_return_with_raw()
    out = h.wrap("search_items", "tc_i2_001", raw)
    parsed = json.loads(out)
    # Full geometry present
    first_feat = parsed["features"][0]
    assert "geometry" in first_feat
    assert first_feat["geometry"]["type"] == "Polygon"
    assert first_feat["geometry"]["coordinates"][0][0] == [-123.89, 38.76]


def test_freeform_emits_all_assets_not_just_primary():
    h = FreeformHandler()
    raw = _make_search_items_return_with_raw()
    out = h.wrap("search_items", "tc_i2_002", raw)
    parsed = json.loads(out)
    assets = parsed["features"][0]["assets"]
    # All three assets present — not just the primary cog_default one
    assert "cog_default" in assets
    assert "cog_secondary" in assets
    assert "thumbnail" in assets


def test_freeform_emits_extra_properties():
    h = FreeformHandler()
    raw = _make_search_items_return_with_raw()
    out = h.wrap("search_items", "tc_i2_003", raw)
    parsed = json.loads(out)
    props = parsed["features"][0]["properties"]
    assert "eo:cloud_cover" in props
    assert "provider" in props


# ---------------------------------------------------------------------------
# Mode B must NOT include the raw blob keys
# ---------------------------------------------------------------------------

def test_key_fields_does_not_emit_geometry_even_with_raw_response():
    h = KeyFieldsHandler()
    raw = _make_search_items_return_with_raw()
    out = h.wrap("search_items", "tc_i2_004", raw)
    parsed = json.loads(out)
    # Must look like the typed Pydantic schema, not the full STAC blob
    assert "items" in parsed
    assert "total_matched" in parsed
    assert "features" not in parsed
    assert "geometry" not in str(parsed)
    # Each item should have exactly the schema fields (collection_id added in VEDA raster rewrite)
    assert set(parsed["items"][0].keys()) == {"id", "datetime", "bbox", "primary_asset_url", "collection_id"}


# ---------------------------------------------------------------------------
# Regression: freeform without raw_response still works (other tools unaffected)
# ---------------------------------------------------------------------------

def test_freeform_falls_back_to_model_dump_json_without_raw_response():
    """Non-search returns (compute_stats, parse_datetime, geocode) are unaffected."""
    from agent_cost_bench.eie.schemas import ComputeStatsReturn

    h = FreeformHandler()
    raw = ComputeStatsReturn(
        band="cog_default",
        n_items=2,
        mean=1.5,
        median=1.5,
        min=1.0,
        max=2.0,
        per_item=[{"item_id": "a", "mean": 1.0}, {"item_id": "b", "mean": 2.0}],
    )
    out = h.wrap("compute_stats", "tc_i2_005", raw)
    parsed = json.loads(out)
    assert parsed["band"] == "cog_default"
    assert parsed["mean"] == 1.5
