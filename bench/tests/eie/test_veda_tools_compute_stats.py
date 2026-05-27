"""compute_stats — VEDA raster /statistics API (httpx-mocked).

Real bench runs call https://openveda.cloud/api/raster/collections/<cid>/items/<iid>/statistics;
tests use pytest-httpx to stub the responses without hitting the network.
"""

import re

import pytest
from pytest_httpx import HTTPXMock

from agent_cost_bench.eie.veda_tools import compute_stats
from agent_cost_bench.eie.schemas import StacItemFields, ComputeStatsReturn


_BBOX = (-123.89, 38.76, -122.82, 40.0)
_GEOMETRY = list(_BBOX)  # [x1, y1, x2, y2] — same as bbox


def _make_items(n: int, collection_id: str = "test-collection") -> list[StacItemFields]:
    return [
        StacItemFields(
            id=f"LIS_GPP_2020{i:02d}010000.d01.cog",
            datetime=f"2020-{i:02d}-01T00:00:00Z",
            bbox=_BBOX,
            primary_asset_url=f"https://example.org/{i:02d}.tif",
            collection_id=collection_id,
        )
        for i in range(1, n + 1)
    ]


def _stats_response(mean: float, median: float, min_: float, max_: float, band: str = "cog_default") -> dict:
    return {
        f"{band}_b1": {
            "mean": mean,
            "median": median,
            "min": min_,
            "max": max_,
            "std": 1.0,
            "count": 100,
            "sum": mean * 100,
        }
    }


# ---------------------------------------------------------------------------
# Happy-path: single item
# ---------------------------------------------------------------------------

def test_compute_stats_single_item(httpx_mock: HTTPXMock):
    items = _make_items(1)
    item = items[0]
    httpx_mock.add_response(
        url=re.compile(
            rf"https://openveda\.cloud/api/raster/collections/{item.collection_id}/items/{re.escape(item.id)}/statistics.*"
        ),
        json=_stats_response(mean=5.0, median=4.5, min_=1.0, max_=10.0),
    )

    r = compute_stats(items, "cog_default", _GEOMETRY)

    assert isinstance(r, ComputeStatsReturn)
    assert r.n_items == 1
    assert r.band == "cog_default"
    assert abs(r.mean - 5.0) < 0.001
    assert abs(r.median - 4.5) < 0.001
    assert abs(r.min - 1.0) < 0.001
    assert abs(r.max - 10.0) < 0.001
    assert len(r.per_item) == 1
    assert r.per_item[0]["item_id"] == item.id


# ---------------------------------------------------------------------------
# Multi-item aggregation
# ---------------------------------------------------------------------------

def test_compute_stats_multi_item_aggregation(httpx_mock: HTTPXMock):
    """mean = mean-of-means; min = global min; max = global max."""
    items = _make_items(3)
    stats = [
        (2.0, 2.0, 0.0, 4.0),   # item-01
        (4.0, 4.0, 2.0, 6.0),   # item-02
        (6.0, 6.0, 4.0, 8.0),   # item-03
    ]
    for item, (mean, median, min_, max_) in zip(items, stats):
        httpx_mock.add_response(
            url=re.compile(
                rf"https://openveda\.cloud/api/raster/collections/{item.collection_id}/items/{re.escape(item.id)}/statistics.*"
            ),
            json=_stats_response(mean=mean, median=median, min_=min_, max_=max_),
        )

    r = compute_stats(items, "cog_default", _GEOMETRY)

    assert r.n_items == 3
    # overall mean = (2+4+6)/3 = 4.0
    assert abs(r.mean - 4.0) < 0.001
    # overall median = median([2,4,6]) = 4.0
    assert abs(r.median - 4.0) < 0.001
    # global min / max across all items
    assert abs(r.min - 0.0) < 0.001
    assert abs(r.max - 8.0) < 0.001


# ---------------------------------------------------------------------------
# Per-item detail in return value
# ---------------------------------------------------------------------------

def test_compute_stats_per_item_contains_ids_and_means(httpx_mock: HTTPXMock):
    items = _make_items(2)
    httpx_mock.add_response(
        url=re.compile(r".*statistics.*"),
        json=_stats_response(mean=1.0, median=1.0, min_=0.0, max_=2.0),
    )
    httpx_mock.add_response(
        url=re.compile(r".*statistics.*"),
        json=_stats_response(mean=3.0, median=3.0, min_=2.0, max_=4.0),
    )

    r = compute_stats(items, "cog_default", _GEOMETRY)

    ids = [d["item_id"] for d in r.per_item]
    means = [d["mean"] for d in r.per_item]
    assert ids == [items[0].id, items[1].id]
    assert abs(means[0] - 1.0) < 0.001
    assert abs(means[1] - 3.0) < 0.001


# ---------------------------------------------------------------------------
# Empty items list raises
# ---------------------------------------------------------------------------

def test_compute_stats_empty_items_raises():
    with pytest.raises((ValueError, IndexError, Exception)):
        compute_stats([], "cog_default", _GEOMETRY)


# ---------------------------------------------------------------------------
# URL structure: assets= and bbox= query params
# ---------------------------------------------------------------------------

def test_compute_stats_url_has_correct_query_params(httpx_mock: HTTPXMock):
    """The request URL must carry assets=<band> and bbox=x1,y1,x2,y2."""
    items = _make_items(1)
    captured_urls: list[str] = []

    def _capture(request):
        captured_urls.append(str(request.url))
        from httpx import Response
        import json as _json
        return Response(200, json=_stats_response(mean=1.0, median=1.0, min_=0.0, max_=2.0, band="NDVI"))

    httpx_mock.add_callback(_capture)

    compute_stats(items, "NDVI", _GEOMETRY)

    assert len(captured_urls) == 1
    url = captured_urls[0]
    assert "assets=NDVI" in url
    assert "bbox=" in url
    # bbox values should contain our coordinates
    assert "-123.89" in url or "123.89" in url


# ---------------------------------------------------------------------------
# Return type check
# ---------------------------------------------------------------------------

def test_compute_stats_return_type(httpx_mock: HTTPXMock):
    """Return value is always a ComputeStatsReturn with correct band label."""
    items = _make_items(1)
    httpx_mock.add_response(
        url=re.compile(r".*statistics.*"),
        json=_stats_response(mean=42.0, median=42.0, min_=42.0, max_=42.0),
    )
    r = compute_stats(items, "cog_default", _GEOMETRY)
    assert isinstance(r, ComputeStatsReturn)
    assert r.band == "cog_default"
    assert r.n_items == 1
    assert abs(r.mean - 42.0) < 0.001


# ---------------------------------------------------------------------------
# Empty collection_id raises clearly
# ---------------------------------------------------------------------------

def test_compute_stats_empty_collection_id_raises():
    items = [
        StacItemFields(
            id="some-item",
            datetime="2020-01-01T00:00:00Z",
            bbox=_BBOX,
            primary_asset_url="https://example.org/item.tif",
            collection_id="",   # empty — should raise
        )
    ]
    with pytest.raises((ValueError, Exception), match=r"collection_id|collection"):
        compute_stats(items, "cog_default", _GEOMETRY)
