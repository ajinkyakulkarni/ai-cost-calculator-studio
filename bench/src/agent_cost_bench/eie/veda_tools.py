"""Real NASA VEDA STAC tools — 5 functions, all calling real APIs.

Drop-in replacement for the simulated tools in tools.py, used only
by the eie-templating bench. The existing tools.py is untouched so
the paper-baseline scenarios keep their deterministic-pseudorandom
payloads.

All STAC calls go through `STAC_ROOT` (NASA VEDA's STAC endpoint).
compute_stats calls the VEDA raster /statistics endpoint — no local
COG reads, no rio-tiler dependency.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any

import dateparser
import httpx
import numpy as np

from .schemas import (
    CollectionMeta,
    ComputeStatsReturn,
    GeocodeReturn,
    ParseDatetimeReturn,
    RenderMapReturn,
    SearchCollectionsReturn,
    SearchItemsReturn,
    StacItemFields,
)

STAC_ROOT = "https://openveda.cloud/api/stac"
RASTER_ROOT = "https://openveda.cloud/api/raster"

_BBOX_JSON = pathlib.Path(__file__).parent.parent.parent.parent / "data" / "us_county_bboxes.json"
_COUNTY_LOOKUP: dict[str, list[float]] = json.loads(_BBOX_JSON.read_text())["counties"]


def parse_datetime(value: str) -> ParseDatetimeReturn:
    """Parse a natural-language datetime range into start/end ISO dates.

    Accepts:
      - "YYYY-MM-DD to YYYY-MM-DD" — explicit range
      - "Month YYYY through Month YYYY" — natural-language range
      - "YYYY-MM-DD" — single date (start == end)
    """
    # Try explicit "X to Y" / "X through Y" range, OR ISO 8601 interval "X/Y"
    m = re.split(r"\s+(?:to|through|-)\s+|\s*/\s*", value.strip(), maxsplit=1, flags=re.IGNORECASE)
    if len(m) == 2:
        d_start = dateparser.parse(m[0])
        d_end = dateparser.parse(m[1])
        if d_start and d_end:
            return ParseDatetimeReturn(
                start=d_start.strftime("%Y-%m-%d"),
                end=d_end.strftime("%Y-%m-%d"),
            )
    # Fall back: single-date input
    d = dateparser.parse(value)
    if d is None:
        raise ValueError(f"could not parse datetime: {value!r}")
    iso = d.strftime("%Y-%m-%d")
    return ParseDatetimeReturn(start=iso, end=iso)


def geocode(query: str, level: str = "county") -> GeocodeReturn:
    """Look up the admin polygon bbox for `query`.

    No external geocode API. Uses the shipped county-bbox table at
    bench/data/us_county_bboxes.json. The bench's frozen AOI is
    Mendocino County, CA — but a few neighbour counties are also
    shipped so an agent that wanders during the drill-down gate can
    still resolve them.

    For levels other than 'county' the lookup is intentionally not
    supported — Pattern E's state-level gate is just text confirmation
    and doesn't need a bbox. If the agent calls geocode at state level
    we return a synthetic bounding box covering California.
    """
    if level == "state":
        # California state envelope (rough), only used when Pattern E's
        # state-confirm gate calls into geocode. Not for compute.
        return GeocodeReturn(
            admin_name=query.strip().title(),
            admin_level="state",
            bbox=(-124.482, 32.529, -114.131, 42.009),
        )

    # Normalize: accept full state names ("California") or 2-letter codes ("CA"),
    # multi-part queries ("Mendocino County, California, USA"), and bare county
    # names ("Sonoma"). Lookup keys are "<county> county, <2-letter>".
    _STATE_NAME_TO_ABBREV = {
        "california": "ca",
        "calif.": "ca",
        "calif": "ca",
    }
    _COUNTRY_NOISE = {"usa", "u.s.a.", "u.s.", "united states", "united states of america", "us"}
    raw = query.strip().lower()
    parts = [p.strip().rstrip(".") for p in raw.split(",") if p.strip()]
    parts = [p for p in parts if p not in _COUNTRY_NOISE]
    county = parts[0] if parts else raw
    if not county.endswith(" county"):
        county = f"{county} county"
    state = "ca"
    for p in parts[1:]:
        cand = _STATE_NAME_TO_ABBREV.get(p, p)
        if len(cand) == 2 or cand in _STATE_NAME_TO_ABBREV.values():
            state = cand
            break
    key = f"{county}, {state}"
    if key not in _COUNTY_LOOKUP:
        raise KeyError(f"unknown county: {query!r} (normalised to {key!r})")
    bbox = _COUNTY_LOOKUP[key]
    county_part = key.split(",")[0].strip().title()
    # The lookup keys already include "county" in the name (e.g. "mendocino county, ca"),
    # so title-casing the left side gives the correctly formatted name.
    return GeocodeReturn(
        admin_name=county_part,
        admin_level="county",
        bbox=tuple(bbox),
    )


def search_collections(keyword: str, top_k: int = 5) -> SearchCollectionsReturn:
    """List NASA VEDA STAC collections, filter client-side by keyword.

    Calls GET /collections (no server-side keyword filter is exposed
    by VEDA's STAC API), then matches the keyword against title +
    description case-insensitively and returns up to top_k results.
    """
    with httpx.Client(timeout=20.0) as client:
        resp = client.get(f"{STAC_ROOT}/collections")
        resp.raise_for_status()
        data = resp.json()
    q_lower = keyword.lower()
    matches: list[CollectionMeta] = []
    for c in data.get("collections", []):
        title = c.get("title", "")
        desc = c.get("description", "")
        haystack = f"{title} {desc}".lower()
        if q_lower in haystack:
            matches.append(
                CollectionMeta(id=c["id"], title=title, description=desc[:300])
            )
        if len(matches) >= top_k:
            break
    result = SearchCollectionsReturn(collections=matches, total_matched=len(matches))
    # Attach the raw API response so FreeformHandler (mode C) can emit the
    # full STAC payload verbatim. Excluded from .model_dump_json() via
    # Field(exclude=True), so KeyFieldsHandler/StatusOnlyHandler are unaffected.
    result.raw_response = data
    return result


def search_items(
    collection_id: str,
    bbox: tuple[float, float, float, float],
    datetime_range: str,
    band: str = "cog_default",
    limit: int = 20,
) -> SearchItemsReturn:
    """List STAC items in a collection within bbox + datetime range.

    `datetime_range` is the STAC datetime filter syntax: "YYYY-MM-DD/YYYY-MM-DD".
    `band` selects which asset URL becomes the primary_asset_url in the
    typed return — the LLM gets one URL per item rather than the full
    asset dict (status-only/key-fields modes); freeform mode passes the
    raw STAC item through.
    """
    bbox_str = ",".join(f"{x:.4f}" for x in bbox)
    url = f"{STAC_ROOT}/collections/{collection_id}/items"
    # VEDA's STAC requires RFC3339 datetime ("YYYY-MM-DDTHH:MM:SSZ"), not bare
    # "YYYY-MM-DD". Promote bare-date forms (with or without slash) to RFC3339.
    def _to_rfc3339(d: str) -> str:
        d = d.strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            return f"{d}T00:00:00Z"
        return d
    if "/" in datetime_range:
        a, b = datetime_range.split("/", 1)
        datetime_range = f"{_to_rfc3339(a)}/{_to_rfc3339(b)}"
    else:
        datetime_range = _to_rfc3339(datetime_range)
    params = {"bbox": bbox_str, "datetime": datetime_range, "limit": limit}
    with httpx.Client(timeout=30.0) as client:
        resp = client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
    items: list[StacItemFields] = []
    for feat in data.get("features", []):
        assets = feat.get("assets", {})
        primary = assets.get(band, {}).get("href") or next(
            (a.get("href", "") for a in assets.values()), ""
        )
        items.append(
            StacItemFields(
                id=feat["id"],
                datetime=feat["properties"]["datetime"],
                bbox=tuple(feat.get("bbox", list(bbox))),
                primary_asset_url=primary,
                collection_id=collection_id,
            )
        )
    result = SearchItemsReturn(items=items, total_matched=len(items))
    # Attach the raw FeatureCollection so FreeformHandler (mode C) can emit
    # full geometry, all assets, and all properties verbatim. Excluded from
    # .model_dump_json() via Field(exclude=True), so KeyFieldsHandler and
    # StatusOnlyHandler remain unaffected.
    result.raw_response = data
    return result


def _bbox_from_geometry(geometry: Any) -> list[float]:
    """Extract a 4-element [x1, y1, x2, y2] bbox from a geometry argument.

    Accepts:
    - A 4-element list/tuple of floats (already a bbox).
    - A GeoJSON dict with a ``bbox`` key (4-element list).
    - A GeoJSON Polygon dict — computes the envelope from the ring coordinates.
    """
    if isinstance(geometry, (list, tuple)) and len(geometry) == 4:
        return [float(v) for v in geometry]
    if isinstance(geometry, dict):
        if "bbox" in geometry:
            return [float(v) for v in geometry["bbox"]]
        # GeoJSON Polygon — extract envelope from the outer ring
        coords = geometry.get("coordinates", [[]])[0]
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        return [min(xs), min(ys), max(xs), max(ys)]
    raise TypeError(f"Unsupported geometry type for bbox extraction: {type(geometry)!r}")


# The canonical COG asset key on VEDA collections like lis-global-da-gpp.
# Used as the fallback when an agent passes a guessed band name.
DEFAULT_ASSET = "cog_default"


def _fetch_stats_block(
    client: httpx.Client,
    item: StacItemFields,
    asset: str,
    bbox_str: str,
) -> dict | None:
    """Fetch the per-item stats block for ``asset``, or None if the asset is
    not valid on this item.

    The raster API serves a 200-OK HTML page (the STAC Browser index) when the
    asset/collection/item path is wrong, rather than a 4xx — so a non-JSON
    content type, or a missing ``<asset>_b1`` key, both mean "no such asset".
    """
    url = f"{RASTER_ROOT}/collections/{item.collection_id}/items/{item.id}/statistics"
    resp = client.get(url, params={"assets": asset, "bbox": bbox_str})
    resp.raise_for_status()
    if "application/json" not in resp.headers.get("content-type", ""):
        return None
    data = resp.json()
    return data.get(f"{asset}_b1")


def _resolve_asset(
    client: httpx.Client,
    first_item: StacItemFields,
    requested: str,
    bbox_str: str,
) -> tuple[str, dict]:
    """Return ``(effective_asset, first_item_stats_block)``.

    Probe ``requested`` on the first item; if it resolves, use it. Otherwise
    fall back to DEFAULT_ASSET (the real COG asset) so an agent's guessed band
    name doesn't fail the whole run. The first item's stats block is returned
    so the caller doesn't re-fetch it. Raise only if neither asset works.
    """
    block = _fetch_stats_block(client, first_item, requested, bbox_str)
    if block is not None:
        return requested, block
    if requested != DEFAULT_ASSET:
        block = _fetch_stats_block(client, first_item, DEFAULT_ASSET, bbox_str)
        if block is not None:
            return DEFAULT_ASSET, block
    raise ValueError(
        f"Raster /statistics has no usable asset for item {first_item.id!r} in "
        f"collection {first_item.collection_id!r}: tried {requested!r}"
        + ("" if requested == DEFAULT_ASSET else f" and {DEFAULT_ASSET!r}")
        + ". Check the collection_id and item_id."
    )


def compute_stats(
    items: list[StacItemFields],
    band: str,
    geometry: Any,
) -> ComputeStatsReturn:
    """For each item call the VEDA raster /statistics endpoint and aggregate.

    Calls:
      GET {RASTER_ROOT}/collections/{collection_id}/items/{item_id}/statistics
          ?assets=<band>&bbox=x1,y1,x2,y2

    Aggregates across items:
      - overall mean  = mean of per-item means
      - overall median = median of per-item medians
      - overall min   = global min across all items
      - overall max   = global max across all items

    ``geometry`` accepts a 4-element bbox list, a GeoJSON dict with a ``bbox``
    key, or a GeoJSON Polygon dict (the envelope is computed from the ring).
    ``items`` must be non-empty and each item must carry a non-empty
    ``collection_id`` (populated automatically by search_items).
    """
    if not items:
        raise ValueError(
            "compute_stats requires at least one item; received an empty list. "
            "Call search_items first."
        )

    bbox = _bbox_from_geometry(geometry)
    bbox_str = ",".join(str(v) for v in bbox)
    per_item: list[dict[str, Any]] = []
    all_means: list[float] = []
    all_medians: list[float] = []
    all_mins: list[float] = []
    all_maxs: list[float] = []

    for it in items:
        if not it.collection_id:
            raise ValueError(
                f"Item {it.id!r} has an empty collection_id. "
                "Items must be retrieved via search_items so that "
                "collection_id is populated before calling compute_stats."
            )

    with httpx.Client(timeout=30.0) as client:
        # Resolve the effective asset once on the first item. Agents often
        # guess a band from the dataset name (e.g. "gpp") rather than the real
        # COG asset key ("cog_default"); the raster API rejects unknown assets
        # with a 200-OK HTML page. Probe the requested band, and if it isn't a
        # real asset, fall back to DEFAULT_ASSET instead of failing the run.
        # The first item's block comes back too, so we don't re-fetch it.
        effective_band, first_block = _resolve_asset(client, items[0], band, bbox_str)

        for idx, it in enumerate(items):
            stats_block = first_block if idx == 0 else _fetch_stats_block(
                client, it, effective_band, bbox_str
            )
            if stats_block is None:
                raise ValueError(
                    f"Raster /statistics returned no usable {effective_band!r} "
                    f"stats for item {it.id!r} in collection {it.collection_id!r}."
                )
            item_mean = float(stats_block["mean"])
            item_median = float(stats_block["median"])
            item_min = float(stats_block["min"])
            item_max = float(stats_block["max"])
            per_item.append({
                "item_id": it.id,
                "mean": item_mean,
                "median": item_median,
                "min": item_min,
                "max": item_max,
            })
            all_means.append(item_mean)
            all_medians.append(item_median)
            all_mins.append(item_min)
            all_maxs.append(item_max)

    return ComputeStatsReturn(
        band=effective_band,
        n_items=len(items),
        mean=float(np.mean(all_means)),
        median=float(np.median(all_medians)),
        min=float(min(all_mins)),
        max=float(max(all_maxs)),
        per_item=per_item,
    )


def render_map(
    collection_id: str,
    item_id: str,
    bbox: tuple[float, float, float, float],
    colormap: str = "viridis",
) -> RenderMapReturn:
    """Return a map layer URL for the given STAC item and bbox.

    Deterministic, no network call — returns the VEDA raster /bbox PNG URL
    that a map widget would load to render the layer. The agent emits this
    URL verbatim in its final answer, mirroring real EIE behaviour.

    Parameters
    ----------
    collection_id:
        STAC collection identifier.
    item_id:
        STAC item identifier (use the first item from a prior search_items call).
    bbox:
        Bounding box as ``(minx, miny, maxx, maxy)`` in WGS-84 decimal degrees.
    colormap:
        TiTiler-compatible colormap name. Defaults to ``"viridis"``.

    Returns
    -------
    RenderMapReturn
        Typed return carrying the full map layer URL and the echo-back fields.
    """
    from .map_preview import build_preview_url  # local import avoids circular at module load

    url = build_preview_url(collection_id, item_id, bbox, colormap=colormap)
    return RenderMapReturn(
        map_url=url,
        item_id=item_id,
        collection_id=collection_id,
        colormap=colormap,
    )
