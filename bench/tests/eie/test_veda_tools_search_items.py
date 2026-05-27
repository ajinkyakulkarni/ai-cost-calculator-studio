"""search_items — real NASA VEDA STAC items endpoint (mocked HTTP)."""

import re

import pytest
from pytest_httpx import HTTPXMock
from agent_cost_bench.eie.veda_tools import search_items
from agent_cost_bench.eie.schemas import SearchItemsReturn


def test_search_items_typed_return(httpx_mock: HTTPXMock):
    bbox = (-123.89, 38.76, -122.82, 40.0)
    # MiCASA's STAC items endpoint
    httpx_mock.add_response(
        url=re.compile(r"https://openveda\.cloud/api/stac/collections/micasa-carbonflux-monthgrid-v1/items\?.*"),
        json={
            "features": [
                {
                    "id": f"micasa-carbonflux-monthgrid-v1-2020{m:02d}01",
                    "properties": {"datetime": f"2020-{m:02d}-01T00:00:00Z"},
                    "bbox": [-180, -90, 180, 90],
                    "assets": {
                        "FIRE": {"href": f"https://example.org/{m:02d}.tif"},
                        "NPP": {"href": f"https://example.org/{m:02d}-npp.tif"},
                    },
                }
                for m in range(6, 12)
            ],
        },
    )
    r = search_items("micasa-carbonflux-monthgrid-v1", bbox, "2020-06-01/2020-11-01", band="FIRE")
    assert isinstance(r, SearchItemsReturn)
    assert r.total_matched == 6
    assert r.items[0].primary_asset_url.endswith(".tif")
    # primary_asset_url picks the requested band (FIRE), not the first asset by accident:
    assert "06.tif" in r.items[0].primary_asset_url
