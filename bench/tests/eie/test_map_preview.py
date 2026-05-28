"""map_preview — VEDA raster /bbox PNG endpoint (httpx-mocked).

Tests render_preview() in isolation with pytest-httpx stubs.
No live network calls; no OpenAI/LLM involvement.
"""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from agent_cost_bench.eie.map_preview import render_preview

# Minimal PNG magic bytes (signature only — enough to identify the format)
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20

_COLLECTION = "lis-global-da-gpp"
_ITEM = "LIS_GPP_202006010000.d01.cog"
_BBOX = (-123.8944, 38.7596, -122.8222, 40.0011)


# ---------------------------------------------------------------------------
# URL construction helpers
# ---------------------------------------------------------------------------

def _expected_path(bbox: tuple[float, float, float, float]) -> str:
    minx, miny, maxx, maxy = bbox
    return (
        f"/api/raster/collections/{_COLLECTION}/items/{_ITEM}/bbox/"
        f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}.png"
    )


# ---------------------------------------------------------------------------
# Happy path — PNG bytes returned
# ---------------------------------------------------------------------------

def test_render_preview_returns_bytes(httpx_mock: HTTPXMock) -> None:
    """render_preview returns raw bytes when the mock serves image/png."""
    httpx_mock.add_response(
        method="GET",
        url=__build_url(_COLLECTION, _ITEM, _BBOX),
        content=_PNG_MAGIC,
        headers={"content-type": "image/png"},
    )
    result = render_preview(_COLLECTION, _ITEM, _BBOX)
    assert isinstance(result, bytes)
    assert result[:8] == b"\x89PNG\r\n\x1a\n"


def test_render_preview_returns_all_bytes(httpx_mock: HTTPXMock) -> None:
    """render_preview returns all bytes from the response body."""
    body = _PNG_MAGIC + b"extra" * 100
    httpx_mock.add_response(
        method="GET",
        url=__build_url(_COLLECTION, _ITEM, _BBOX),
        content=body,
        headers={"content-type": "image/png"},
    )
    result = render_preview(_COLLECTION, _ITEM, _BBOX)
    assert result == body


# ---------------------------------------------------------------------------
# URL construction — bbox path segment and query params
# ---------------------------------------------------------------------------

def test_render_preview_url_contains_bbox_path(httpx_mock: HTTPXMock) -> None:
    """The built URL contains the bbox path segment with 4-decimal precision."""
    captured: list[str] = []

    def _handler(request, **kwargs):  # noqa: ANN001
        captured.append(str(request.url))
        import httpx as _httpx
        return _httpx.Response(200, content=_PNG_MAGIC, headers={"content-type": "image/png"})

    httpx_mock.add_callback(_handler)
    render_preview(_COLLECTION, _ITEM, _BBOX)

    assert captured, "No request was made"
    url = captured[0]
    minx, miny, maxx, maxy = _BBOX
    path_seg = f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}.png"
    assert path_seg in url, f"bbox path segment {path_seg!r} not in URL: {url}"


def test_render_preview_url_contains_assets_param(httpx_mock: HTTPXMock) -> None:
    """The built URL contains assets=cog_default query param (default)."""
    captured: list[str] = []

    def _handler(request, **kwargs):  # noqa: ANN001
        captured.append(str(request.url))
        import httpx as _httpx
        return _httpx.Response(200, content=_PNG_MAGIC, headers={"content-type": "image/png"})

    httpx_mock.add_callback(_handler)
    render_preview(_COLLECTION, _ITEM, _BBOX)

    url = captured[0]
    assert "assets=cog_default" in url, f"assets param missing in URL: {url}"


def test_render_preview_url_contains_rescale_param(httpx_mock: HTTPXMock) -> None:
    """The built URL contains rescale=0.0,0.0002 query param (default)."""
    captured: list[str] = []

    def _handler(request, **kwargs):  # noqa: ANN001
        captured.append(str(request.url))
        import httpx as _httpx
        return _httpx.Response(200, content=_PNG_MAGIC, headers={"content-type": "image/png"})

    httpx_mock.add_callback(_handler)
    render_preview(_COLLECTION, _ITEM, _BBOX)

    url = captured[0]
    assert "rescale=0.0%2C0.0002" in url or "rescale=0.0,0.0002" in url, (
        f"rescale param missing or wrong in URL: {url}"
    )


def test_render_preview_url_contains_colormap_param(httpx_mock: HTTPXMock) -> None:
    """The built URL contains colormap_name=viridis query param (default)."""
    captured: list[str] = []

    def _handler(request, **kwargs):  # noqa: ANN001
        captured.append(str(request.url))
        import httpx as _httpx
        return _httpx.Response(200, content=_PNG_MAGIC, headers={"content-type": "image/png"})

    httpx_mock.add_callback(_handler)
    render_preview(_COLLECTION, _ITEM, _BBOX)

    url = captured[0]
    assert "colormap_name=viridis" in url, f"colormap_name param missing in URL: {url}"


# ---------------------------------------------------------------------------
# Non-PNG / bad-path error handling
# ---------------------------------------------------------------------------

def test_render_preview_raises_on_html_response(httpx_mock: HTTPXMock) -> None:
    """render_preview raises ValueError when the server returns text/html."""
    html_body = b"<html><body>Not Found</body></html>"
    httpx_mock.add_response(
        method="GET",
        url=__build_url(_COLLECTION, _ITEM, _BBOX),
        content=html_body,
        status_code=200,
        headers={"content-type": "text/html; charset=utf-8"},
    )
    with pytest.raises(ValueError, match="non-PNG"):
        render_preview(_COLLECTION, _ITEM, _BBOX)


def test_render_preview_valueerror_includes_url(httpx_mock: HTTPXMock) -> None:
    """The ValueError message includes the request URL."""
    html_body = b"<html>oops</html>"
    url = __build_url(_COLLECTION, _ITEM, _BBOX)
    httpx_mock.add_response(
        method="GET",
        url=url,
        content=html_body,
        status_code=200,
        headers={"content-type": "text/html"},
    )
    with pytest.raises(ValueError) as exc_info:
        render_preview(_COLLECTION, _ITEM, _BBOX)
    assert _COLLECTION in str(exc_info.value) or _ITEM in str(exc_info.value)


# ---------------------------------------------------------------------------
# Custom kwargs forwarded
# ---------------------------------------------------------------------------

def test_render_preview_custom_colormap(httpx_mock: HTTPXMock) -> None:
    """Custom colormap kwarg is reflected in the URL."""
    captured: list[str] = []

    def _handler(request, **kwargs):  # noqa: ANN001
        captured.append(str(request.url))
        import httpx as _httpx
        return _httpx.Response(200, content=_PNG_MAGIC, headers={"content-type": "image/png"})

    httpx_mock.add_callback(_handler)
    render_preview(_COLLECTION, _ITEM, _BBOX, colormap="plasma")

    url = captured[0]
    assert "colormap_name=plasma" in url, f"custom colormap missing in URL: {url}"


def test_render_preview_custom_asset(httpx_mock: HTTPXMock) -> None:
    """Custom asset kwarg is reflected in the URL."""
    captured: list[str] = []

    def _handler(request, **kwargs):  # noqa: ANN001
        captured.append(str(request.url))
        import httpx as _httpx
        return _httpx.Response(200, content=_PNG_MAGIC, headers={"content-type": "image/png"})

    httpx_mock.add_callback(_handler)
    render_preview(_COLLECTION, _ITEM, _BBOX, asset="cog_alt")

    url = captured[0]
    assert "assets=cog_alt" in url, f"custom asset missing in URL: {url}"


# ---------------------------------------------------------------------------
# CLI wiring — the preview must crop to the geocoded AOI, NOT the item's own
# bbox. Every lis-global-da-gpp item carries the whole-globe extent as its
# bbox; passing that to render_preview renders the entire world instead of
# the county. This regression test pins the correct wiring.
# ---------------------------------------------------------------------------

def test_cli_preview_uses_aoi_bbox_not_item_bbox(monkeypatch) -> None:
    from typer.testing import CliRunner

    from agent_cost_bench import cli
    from agent_cost_bench.eie.schemas import GeocodeReturn, SearchItemsReturn, StacItemFields

    aoi_bbox = (-123.89, 38.756, -122.819, 40.005)
    world_bbox = (-180.0, -90.0, 180.0, 90.0)  # what GPP items actually report

    # The command imports geocode/search_items/render_preview INSIDE the
    # function body from their source modules, so patch the source modules.
    from agent_cost_bench.eie import veda_tools
    monkeypatch.setattr(
        veda_tools, "geocode",
        lambda *a, **k: GeocodeReturn(admin_name="Mendocino County", admin_level="county", bbox=aoi_bbox),
    )
    monkeypatch.setattr(
        veda_tools, "search_items",
        lambda *a, **k: SearchItemsReturn(
            items=[StacItemFields(
                id="LIS_GPP_202008010000.d01.cog",
                datetime="2020-08-01T00:00:00Z",
                bbox=world_bbox,
                primary_asset_url="https://example.org/x.tif",
                collection_id="lis-global-da-gpp",
            )],
            total_matched=1,
        ),
    )

    seen: list[tuple] = []

    def _fake_render(collection_id, item_id, bbox, **kwargs):
        seen.append(bbox)
        return b"\x89PNG\r\n\x1a\n"

    from agent_cost_bench.eie import map_preview
    monkeypatch.setattr(map_preview, "render_preview", _fake_render)

    result = CliRunner().invoke(
        cli.app,
        ["preview-eie-templating", "--max-items", "1"],
    )
    assert result.exit_code == 0, result.output
    assert seen, "render_preview was never called"
    # The bbox handed to render_preview must be the geocoded AOI, not the
    # item's whole-globe bbox.
    assert tuple(seen[0]) == aoi_bbox, (
        f"preview cropped to {seen[0]!r}; expected AOI {aoi_bbox!r} "
        "(regression: item.bbox is the whole globe)"
    )


# ---------------------------------------------------------------------------
# Helpers — not tests
# ---------------------------------------------------------------------------

def __build_url(
    collection_id: str,
    item_id: str,
    bbox: tuple[float, float, float, float],
    *,
    asset: str = "cog_default",
    rescale: tuple[float, float] = (0.0, 0.0002),
    colormap: str = "viridis",
    width: int = 400,
    height: int = 400,
) -> str:
    """Construct the expected URL for use in httpx_mock.add_response."""
    minx, miny, maxx, maxy = bbox
    base = (
        f"https://openveda.cloud/api/raster/collections/{collection_id}"
        f"/items/{item_id}/bbox"
        f"/{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}.png"
    )
    rescale_str = f"{rescale[0]},{rescale[1]}"
    return (
        f"{base}?assets={asset}&rescale={rescale_str}"
        f"&colormap_name={colormap}&width={width}&height={height}"
    )
