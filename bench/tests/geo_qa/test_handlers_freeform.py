"""FreeformHandler — identity passthrough of the raw upstream response.

The raw STAC response (full geometry, every asset, every property)
is serialized verbatim. This is what naive ReAct loops do without
output structuring.
"""

import json
from agent_cost_bench.geo_qa.handlers import FreeformHandler


def test_freeform_passes_through_dict():
    h = FreeformHandler()
    raw_dict = {
        "id": "LIS_GPP_202006",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[-123.89, 38.76], [-122.82, 38.76], [-122.82, 40.0], [-123.89, 40.0], [-123.89, 38.76]]],
        },
        "properties": {"datetime": "2020-06-01T00:00:00Z", "eo:cloud_cover": 0, "provider": "NASA"},
        "assets": {
            "cog_default": {"href": "https://example.org/06.tif"},
            "thumbnail": {"href": "https://example.org/06-thumb.png"},
        },
    }
    out = h.wrap("search_items", "tc_001", raw_dict)
    parsed = json.loads(out)
    # Full payload preserved verbatim
    assert parsed["geometry"]["coordinates"][0][0] == [-123.89, 38.76]
    assert "eo:cloud_cover" in parsed["properties"]
    assert "thumbnail" in parsed["assets"]


def test_freeform_passes_through_list_of_dicts():
    h = FreeformHandler()
    raw = [{"id": f"item-{i}", "extra": "x" * 200} for i in range(5)]
    out = h.wrap("search_items", "tc_002", raw)
    parsed = json.loads(out)
    assert len(parsed) == 5
    assert parsed[0]["extra"] == "x" * 200
