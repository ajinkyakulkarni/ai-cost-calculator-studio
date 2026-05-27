"""Typed schemas for the three-way templating bench.

These are the contracts every tool call's return value flows through.
The three response handlers (status-only / key-fields / freeform) all
consume the same raw tool output and emit one of these typed shapes
(or in freeform's case, an opaque dict) before serialization into the
LLM's next-turn context.

Schemas are deliberately tight: a future plan reviewer can read this
file and predict exactly what tokens land in the LLM's context per
handler mode, without reading the handlers themselves.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, ConfigDict


class ParseDatetimeReturn(BaseModel):
    start: str = Field(..., description="ISO 8601 date, inclusive lower bound")
    end: str = Field(..., description="ISO 8601 date, inclusive upper bound")


class GeocodeReturn(BaseModel):
    admin_name: str
    admin_level: str  # 'country' | 'state' | 'county'
    bbox: tuple[float, float, float, float]
    # Note: full geometry coords are NOT in this schema; the freeform
    # handler includes them via passthrough of the underlying tool's
    # raw response, not via this typed shape.


class CollectionMeta(BaseModel):
    id: str
    title: str
    description: str


class SearchCollectionsReturn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    collections: list[CollectionMeta]
    total_matched: int
    raw_response: Optional[dict] = Field(default=None, exclude=True)


class StacItemFields(BaseModel):
    id: str
    datetime: str
    bbox: tuple[float, float, float, float]
    primary_asset_url: str


class SearchItemsReturn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    items: list[StacItemFields]
    total_matched: int
    raw_response: Optional[dict] = Field(default=None, exclude=True)


class ComputeStatsReturn(BaseModel):
    band: str
    n_items: int
    mean: float
    median: float
    min: float
    max: float
    per_item: list[dict[str, Any]]


class StatusReturn(BaseModel):
    ok: bool
    summary: str
    tool_call_id: str
    error: Optional[str] = None
