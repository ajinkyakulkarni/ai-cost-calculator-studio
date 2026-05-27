"""Real NASA VEDA STAC tools — 5 functions, all calling real APIs.

Drop-in replacement for the simulated tools in tools.py, used only
by the eie-templating bench. The existing tools.py is untouched so
the paper-baseline scenarios keep their deterministic-pseudorandom
payloads.

All STAC calls go through `STAC_ROOT` (NASA VEDA's STAC endpoint).
The compute_stats tool uses rio-tiler to read MiCASA COG assets
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
    # Try explicit "X to Y" / "X through Y" range first
    m = re.split(r"\s+(?:to|through|-)\s+", value.strip(), maxsplit=1, flags=re.IGNORECASE)
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

    key = f"{query.strip().lower()}, ca" if "," not in query else query.strip().lower()
    if key not in _COUNTY_LOOKUP:
        # Try without the ", ca" suffix in case the input had a different state
        if query.strip().lower() in _COUNTY_LOOKUP:
            key = query.strip().lower()
        else:
            raise KeyError(f"unknown county: {query!r}")
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
    return SearchCollectionsReturn(collections=matches, total_matched=len(matches))


def search_items(
    collection_id: str,
    bbox: tuple[float, float, float, float],
    datetime_range: str,
) -> SearchItemsReturn:
    raise NotImplementedError("search_items — Task 10")


def compute_stats(
    items: list[StacItemFields],
    bbox: tuple[float, float, float, float],
    band: str,
) -> ComputeStatsReturn:
    raise NotImplementedError("compute_stats — Task 11")
