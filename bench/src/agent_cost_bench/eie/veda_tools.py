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

import re
from typing import Any

import dateparser

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


def geocode(location: str) -> GeocodeReturn:
    raise NotImplementedError("geocode — Task 8")


def search_collections(keyword: str) -> SearchCollectionsReturn:
    raise NotImplementedError("search_collections — Task 9")


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
