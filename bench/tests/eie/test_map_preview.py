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
