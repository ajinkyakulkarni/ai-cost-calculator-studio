"""compute_stats — rio-tiler reads COG band over polygon AOI.

Real bench runs hit NASA's COG store; tests mock rio_tiler.io.Reader
so we don't fetch remote rasters during pytest. Mock returns synthetic
numpy arrays with known statistics.
"""

from unittest.mock import patch, MagicMock
import numpy as np
import pytest
from agent_cost_bench.eie.veda_tools import compute_stats
from agent_cost_bench.eie.schemas import StacItemFields, ComputeStatsReturn


_GEOMETRY = {
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
}


def _make_items(n: int) -> list[StacItemFields]:
    return [
        StacItemFields(
            id=f"item-{i:02d}",
            datetime=f"2020-{i:02d}-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url=f"https://example.org/{i:02d}.tif",
        )
        for i in range(1, n + 1)
    ]


def _mock_reader(arrays: list[np.ndarray]):
    """Return a patched Reader class whose .feature() side_effect yields ImageData-like mocks."""
    mock_reader = MagicMock()
    mock_reader.__enter__ = MagicMock(return_value=mock_reader)
    mock_reader.__exit__ = MagicMock(return_value=None)
    mock_reader.feature.side_effect = [
        MagicMock(
            data=np.expand_dims(arr, axis=0),
            mask=np.ones_like(arr, dtype=bool),
        )
        for arr in arrays
    ]
    return mock_reader


def test_compute_stats_aggregates_across_items():
    items = _make_items(3)
    # arrays with known means: 2.0, 3.0, 4.0
    arrays = [
        np.array([[0.0, 2.0], [2.0, 4.0]]),  # mean=2.0
        np.array([[1.0, 3.0], [3.0, 5.0]]),  # mean=3.0
        np.array([[2.0, 4.0], [4.0, 6.0]]),  # mean=4.0
    ]
    mock_reader = _mock_reader(arrays)
    with patch("agent_cost_bench.eie.veda_tools.Reader") as reader_cls:
        reader_cls.return_value = mock_reader
        r = compute_stats(items, "FIRE", _GEOMETRY)

    assert isinstance(r, ComputeStatsReturn)
    assert r.n_items == 3
    assert r.band == "FIRE"
    # mean over all 12 pixels: (0+2+2+4 + 1+3+3+5 + 2+4+4+6) / 12 = 36/12 = 3.0
    assert abs(r.mean - 3.0) < 0.01
    assert r.min == 0.0
    assert r.max == 6.0
    assert len(r.per_item) == 3


def test_compute_stats_per_item_ids():
    items = _make_items(2)
    arrays = [np.array([[1.0, 1.0]]), np.array([[3.0, 3.0]])]
    mock_reader = _mock_reader(arrays)
    with patch("agent_cost_bench.eie.veda_tools.Reader") as reader_cls:
        reader_cls.return_value = mock_reader
        r = compute_stats(items, "FIRE", _GEOMETRY)

    ids = [d["item_id"] for d in r.per_item]
    assert ids == ["item-01", "item-02"]


def test_compute_stats_per_item_means():
    items = _make_items(2)
    arrays = [np.array([[1.0, 3.0]]), np.array([[5.0, 7.0]])]
    mock_reader = _mock_reader(arrays)
    with patch("agent_cost_bench.eie.veda_tools.Reader") as reader_cls:
        reader_cls.return_value = mock_reader
        r = compute_stats(items, "FIRE", _GEOMETRY)

    assert abs(r.per_item[0]["mean"] - 2.0) < 0.01  # (1+3)/2
    assert abs(r.per_item[1]["mean"] - 6.0) < 0.01  # (5+7)/2


def test_compute_stats_median():
    items = _make_items(1)
    # 5 values whose median is 3.0
    arrays = [np.array([[1.0, 2.0, 3.0, 4.0, 5.0]])]
    mock_reader = _mock_reader(arrays)
    with patch("agent_cost_bench.eie.veda_tools.Reader") as reader_cls:
        reader_cls.return_value = mock_reader
        r = compute_stats(items, "NDVI", _GEOMETRY)

    assert abs(r.median - 3.0) < 0.01
    assert r.band == "NDVI"


def test_compute_stats_returns_compute_stats_return_type():
    items = _make_items(1)
    arrays = [np.array([[10.0]])]
    mock_reader = _mock_reader(arrays)
    with patch("agent_cost_bench.eie.veda_tools.Reader") as reader_cls:
        reader_cls.return_value = mock_reader
        r = compute_stats(items, "FIRE", _GEOMETRY)

    assert isinstance(r, ComputeStatsReturn)
    assert r.mean == 10.0
    assert r.min == 10.0
    assert r.max == 10.0
    assert r.n_items == 1


def test_compute_stats_empty_items_returns_zeros():
    r = compute_stats([], "FIRE", _GEOMETRY)
    assert isinstance(r, ComputeStatsReturn)
    assert r.n_items == 0
    assert r.mean == 0.0
    assert r.per_item == []


def test_compute_stats_reader_called_per_item_url():
    items = _make_items(2)
    arrays = [np.array([[1.0]]), np.array([[2.0]])]
    mock_reader = _mock_reader(arrays)
    with patch("agent_cost_bench.eie.veda_tools.Reader") as reader_cls:
        reader_cls.return_value = mock_reader
        compute_stats(items, "FIRE", _GEOMETRY)

    assert reader_cls.call_count == 2
    urls = [call.args[0] for call in reader_cls.call_args_list]
    assert urls == ["https://example.org/01.tif", "https://example.org/02.tif"]
