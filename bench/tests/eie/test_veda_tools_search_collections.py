"""search_collections — real NASA VEDA STAC call (mocked HTTP in tests)."""

import pytest
from pytest_httpx import HTTPXMock
from agent_cost_bench.eie.veda_tools import search_collections
from agent_cost_bench.eie.schemas import SearchCollectionsReturn, CollectionMeta


MOCK_COLLECTIONS_PAYLOAD = {
    "collections": [
        {
            "id": "lis-global-da-gpp",
            "title": "LIS Global DA GPP",
            "description": "Land Information System global gross primary production (a carbon flux measure)",
        },
        {
            "id": "modis-ndvi",
            "title": "MODIS NDVI",
            "description": "Vegetation index product derived from MODIS",
        },
        {
            "id": "oco2-co2",
            "title": "OCO-2 CO2",
            "description": "Atmospheric CO2 column measurements",
        },
    ]
}


def test_search_collections_returns_typed_schema(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json=MOCK_COLLECTIONS_PAYLOAD,
    )
    r = search_collections("carbon")
    assert isinstance(r, SearchCollectionsReturn)
    assert isinstance(r.collections, list)
    assert isinstance(r.total_matched, int)


def test_search_collections_matches_keyword(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json=MOCK_COLLECTIONS_PAYLOAD,
    )
    r = search_collections("carbon")
    # LIS GPP description contains "carbon"; MODIS and OCO-2 do not
    assert any("lis-global-da-gpp" in c.id for c in r.collections)
    assert r.total_matched >= 1


def test_search_collections_excludes_non_matching(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json=MOCK_COLLECTIONS_PAYLOAD,
    )
    r = search_collections("carbon")
    ids = [c.id for c in r.collections]
    # NDVI and OCO-2 CO2 shouldn't match "carbon"
    assert "modis-ndvi" not in ids


def test_search_collections_case_insensitive(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json=MOCK_COLLECTIONS_PAYLOAD,
    )
    r = search_collections("CARBON")
    assert any("lis-global-da-gpp" in c.id for c in r.collections)


def test_search_collections_collection_meta_fields(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json=MOCK_COLLECTIONS_PAYLOAD,
    )
    r = search_collections("carbon")
    assert len(r.collections) >= 1
    c = r.collections[0]
    assert isinstance(c, CollectionMeta)
    assert c.id == "lis-global-da-gpp"
    assert "GPP" in c.title or "gpp" in c.title.lower()
    assert len(c.description) > 0


def test_search_collections_no_matches_returns_empty(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json=MOCK_COLLECTIONS_PAYLOAD,
    )
    r = search_collections("xyzzy_nonexistent_keyword")
    assert r.collections == []
    assert r.total_matched == 0


def test_search_collections_description_truncated(httpx_mock: HTTPXMock):
    long_desc = "Land Information System global gross primary production (a carbon flux measure). " + "X" * 500
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json={
            "collections": [
                {
                    "id": "lis-global-da-gpp",
                    "title": "LIS Global DA GPP",
                    "description": long_desc,
                }
            ]
        },
    )
    r = search_collections("carbon")
    assert len(r.collections) == 1
    assert len(r.collections[0].description) <= 300


def test_search_collections_top_k_limits_results(httpx_mock: HTTPXMock):
    many_collections = [
        {
            "id": f"carbon-dataset-{i}",
            "title": f"Carbon Dataset {i}",
            "description": "Contains carbon measurements",
        }
        for i in range(20)
    ]
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json={"collections": many_collections},
    )
    r = search_collections("carbon", top_k=5)
    assert len(r.collections) <= 5
    assert r.total_matched <= 5
