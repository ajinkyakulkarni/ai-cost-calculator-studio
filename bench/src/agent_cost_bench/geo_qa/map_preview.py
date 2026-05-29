"""Map preview utility — fetches a PNG tile from VEDA's raster /bbox endpoint.

This module is a *post-hoc visualisation utility* that is completely
decoupled from the cost-measuring path (patterns, handlers, runner, report).
It does not call any LLM, does not modify token counts, and must not be
imported from any of those modules.

Usage::

    from agent_cost_bench.geo_qa.map_preview import render_preview

    png_bytes = render_preview(
        collection_id="lis-global-da-gpp",
        item_id="LIS_GPP_202006010000.d01.cog",
        bbox=(-123.89, 38.76, -122.82, 40.00),
    )
    Path("preview.png").write_bytes(png_bytes)
"""

from __future__ import annotations

import urllib.parse

import httpx

from .stac_tools import RASTER_ROOT


def build_preview_url(
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
    """Return the full VEDA raster /bbox URL (path + query string) for a PNG tile.

    Pure string builder — no HTTP call, no side effects. Safe to call from
    render_map (the agent-facing tool) and render_preview (the fetch helper).

    Parameters
    ----------
    collection_id:
        STAC collection identifier (e.g. ``"lis-global-da-gpp"``).
    item_id:
        STAC item identifier (e.g. ``"LIS_GPP_202006010000.d01.cog"``).
    bbox:
        Bounding box as ``(minx, miny, maxx, maxy)`` in WGS-84 decimal degrees.
    asset:
        Asset name to render. Defaults to ``"cog_default"``.
    rescale:
        ``(lo, hi)`` value range for contrast stretch.
    colormap:
        TiTiler-compatible colormap name.
    width:
        Output image width in pixels.
    height:
        Output image height in pixels.

    Returns
    -------
    str
        Full URL including path and percent-encoded query string.
    """
    minx, miny, maxx, maxy = bbox
    bbox_path = f"{minx:.4f},{miny:.4f},{maxx:.4f},{maxy:.4f}"
    path = (
        f"{RASTER_ROOT}/collections/{collection_id}"
        f"/items/{item_id}/bbox/{bbox_path}.png"
    )
    query = urllib.parse.urlencode({
        "assets": asset,
        "rescale": f"{rescale[0]},{rescale[1]}",
        "colormap_name": colormap,
        "width": width,
        "height": height,
    })
    return f"{path}?{query}"


def render_preview(
    collection_id: str,
    item_id: str,
    bbox: tuple[float, float, float, float],
    *,
    asset: str = "cog_default",
    rescale: tuple[float, float] = (0.0, 0.0002),
    colormap: str = "viridis",
    width: int = 400,
    height: int = 400,
) -> bytes:
    """Fetch a PNG preview of *item_id* cropped to *bbox* from the VEDA raster API.

    Parameters
    ----------
    collection_id:
        STAC collection identifier (e.g. ``"lis-global-da-gpp"``).
    item_id:
        STAC item identifier (e.g. ``"LIS_GPP_202006010000.d01.cog"``).
    bbox:
        Bounding box as ``(minx, miny, maxx, maxy)`` in WGS-84 decimal degrees.
    asset:
        Asset name to render. Defaults to ``"cog_default"``.
    rescale:
        ``(lo, hi)`` value range for contrast stretch. Defaults to
        ``(0.0, 0.0002)`` — appropriate for GPP in kgC/m²/s units.
    colormap:
        TiTiler-compatible colormap name. Defaults to ``"viridis"``.
    width:
        Output image width in pixels. Defaults to 400.
    height:
        Output image height in pixels. Defaults to 400.

    Returns
    -------
    bytes
        Raw PNG bytes that can be written directly to a ``.png`` file.

    Raises
    ------
    httpx.HTTPStatusError
        If the raster API returns a non-2xx status code.
    ValueError
        If the response content-type is not ``image/png``.  The VEDA raster
        API serves an HTML page on unknown collection/item paths (200 OK with
        ``text/html``); this turns that into a clear error rather than letting
        the caller silently write an HTML file with a ``.png`` extension.
    """
    url = build_preview_url(
        collection_id, item_id, bbox,
        asset=asset, rescale=rescale, colormap=colormap, width=width, height=height,
    )

    with httpx.Client(timeout=30.0) as client:
        resp = client.get(url)
        resp.raise_for_status()

    ctype = resp.headers.get("content-type", "")
    if "image/png" not in ctype:
        raise ValueError(
            f"Raster /bbox returned non-PNG for {url} "
            f"content-type={ctype!r}. "
            "Likely the collection_id or item_id is wrong. "
            f"Body excerpt: {resp.content[:160]!r}"
        )

    return resp.content
