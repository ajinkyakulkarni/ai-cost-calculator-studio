"""Real NASA VEDA STAC tools — 5 functions, all calling real APIs.

Drop-in replacement for the simulated tools in tools.py, used only
by the eie-templating bench. The existing tools.py is untouched so
the paper-baseline scenarios keep their deterministic-pseudorandom
payloads.

All STAC calls go through `STAC_ROOT` (NASA VEDA's STAC endpoint).
The compute_stats tool uses rio-tiler to read COG assets
directly from NASA's data store and compute band aggregates over
the polygon AOI.
"""

from __future__ import annotations

import json
import pathlib
import re
from typing import Any

import dateparser
import httpx
import numpy as np
from rio_tiler.io import Reader

from .schemas import (
    CollectionMeta,
    ComputeStatsReturn,
    GeocodeReturn,
    ParseDatetimeReturn,
    SearchCollectionsReturn,
    SearchItemsReturn,
    StacItemFields,
)

STAC_ROOT = "https://openveda.cloud/api/stac"

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
            )
        )
    result = SearchItemsReturn(items=items, total_matched=len(items))
    # Attach the raw FeatureCollection so FreeformHandler (mode C) can emit
    # full geometry, all assets, and all properties verbatim. Excluded from
    # .model_dump_json() via Field(exclude=True), so KeyFieldsHandler and
    # StatusOnlyHandler remain unaffected.
    result.raw_response = data
    return result


def compute_stats(
    items: list[StacItemFields],
    band: str,
    geometry: dict[str, Any],
) -> ComputeStatsReturn:
    """For each item, read the COG asset and compute band stats over the polygon.

    Uses rio-tiler's ``Reader.feature(geometry)`` which clips the raster
    to the polygon and returns a masked numpy array.  Aggregates per-item
    means and computes overall mean/median/min/max across all valid pixels
    from all items.
    """
    all_values: list[float] = []
    per_item: list[dict[str, Any]] = []

    for it in items:
        with Reader(it.primary_asset_url) as src:
            img = src.feature(geometry)
        arr = np.asarray(img.data, dtype=float).ravel()
        mask = np.asarray(img.mask, dtype=bool).ravel() if hasattr(img, "mask") else np.ones(arr.shape, dtype=bool)
        valid = arr[mask]
        if valid.size == 0:
            per_item.append({"item_id": it.id, "mean": float("nan")})
            continue
        per_item.append({"item_id": it.id, "mean": float(np.mean(valid))})
        all_values.extend(valid.tolist())

    if not all_values:
        return ComputeStatsReturn(
            band=band,
            n_items=len(items),
            mean=0.0,
            median=0.0,
            min=0.0,
            max=0.0,
            per_item=per_item,
        )

    arr_all = np.asarray(all_values, dtype=float)
    return ComputeStatsReturn(
        band=band,
        n_items=len(items),
        mean=float(np.mean(arr_all)),
        median=float(np.median(arr_all)),
        min=float(np.min(arr_all)),
        max=float(np.max(arr_all)),
        per_item=per_item,
    )
