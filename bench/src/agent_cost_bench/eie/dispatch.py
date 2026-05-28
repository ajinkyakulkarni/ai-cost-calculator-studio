"""Route OpenAI-shape tool calls into veda_tools + wrap via handler.

This is the only file that knows which veda_tools function corresponds
to which tool name in the LLM's tool schema. The runner and patterns
talk to this module; nothing else.
"""

from __future__ import annotations

from typing import Any, Protocol

from . import veda_tools
from .schemas import StacItemFields


# Centralized JSON schemas the LLM sees for each tool. These names
# match the dispatch keys below.
_RENDER_MAP_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "render_map",
        "description": (
            "Return a map layer URL for a STAC item and bbox. "
            "Call this after compute_stats to produce a renderable map tile URL. "
            "The URL can be loaded directly by a map widget — no image is fetched here."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "collection_id": {"type": "string"},
                "item_id": {"type": "string"},
                "bbox": {
                    "type": "array",
                    "items": {"type": "number"},
                    "minItems": 4,
                    "maxItems": 4,
                },
                "colormap": {
                    "type": "string",
                    "description": "TiTiler colormap name (e.g. viridis, plasma, rdylgn). Optional.",
                },
            },
            "required": ["collection_id", "item_id", "bbox"],
        },
    },
}

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "parse_datetime",
            "description": "Parse a natural-language datetime range into ISO 8601 start/end dates.",
            "parameters": {
                "type": "object",
                "properties": {"value": {"type": "string"}},
                "required": ["value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "geocode",
            "description": "Look up the admin polygon bbox for an area name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "level": {"type": "string", "enum": ["state", "county"]},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_collections",
            "description": "Search NASA VEDA STAC collections by keyword.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_items",
            "description": "List STAC items in a collection filtered by bbox + datetime.",
            "parameters": {
                "type": "object",
                "properties": {
                    "collection_id": {"type": "string"},
                    "bbox": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 4,
                        "maxItems": 4,
                    },
                    "datetime_range": {"type": "string"},
                    "band": {"type": "string"},
                },
                "required": ["collection_id", "bbox", "datetime_range"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compute_stats",
            "description": (
                "Compute band stats over a bbox AOI from a list of STAC items. "
                "You MUST pass the item objects returned by a prior search_items call "
                "as item_refs — each carries its own collection_id required for the "
                "VEDA raster API. If you do not have the items yet, call search_items first."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "item_refs": {
                        "type": "array",
                        "description": (
                            "Non-empty list of STAC item objects previously returned by "
                            "search_items. Each element must have 'id', 'datetime', 'bbox', "
                            "'primary_asset_url', and 'collection_id' fields. "
                            "Passing an empty list is an error."
                        ),
                        "items": {"type": "object"},
                        "minItems": 1,
                    },
                    "band": {"type": "string"},
                    "geometry": {
                        "type": "array",
                        "description": "Bounding box [x1, y1, x2, y2] or a GeoJSON geometry object.",
                        "items": {"type": "number"},
                    },
                },
                "required": ["item_refs", "band", "geometry"],
            },
        },
    },
]


def get_tool_schemas(with_map: bool = False) -> list[dict[str, Any]]:
    """Return the tool schema list the LLM sees.

    Parameters
    ----------
    with_map:
        When True, append the render_map schema to the base 5 tools.
        When False (default), return only the base 5 tools unchanged.
    """
    if with_map:
        return TOOL_SCHEMAS + [_RENDER_MAP_SCHEMA]
    return TOOL_SCHEMAS


class Handler(Protocol):
    def wrap(self, tool_name: str, tool_call_id: str, raw: Any) -> str: ...


def dispatch_tool_call(name: str, args: dict[str, Any], handler: Handler, tool_call_id: str) -> str:
    """Run the named tool with `args`, wrap return via handler, return string for the LLM."""
    if name == "parse_datetime":
        raw = veda_tools.parse_datetime(args["value"])
    elif name == "geocode":
        raw = veda_tools.geocode(args["query"], args.get("level", "county"))
    elif name == "search_collections":
        raw = veda_tools.search_collections(args["query"])
    elif name == "search_items":
        raw = veda_tools.search_items(
            args["collection_id"],
            tuple(args["bbox"]),
            args["datetime_range"],
            args.get("band", "cog_default"),
        )
    elif name == "render_map":
        raw = veda_tools.render_map(
            args["collection_id"],
            args["item_id"],
            tuple(args["bbox"]),
            args.get("colormap", "viridis"),
        )
    elif name == "compute_stats":
        # item_refs must be the list of StacItemFields objects (or dicts with
        # the same fields) returned by a prior search_items call. The LLM is
        # required to have called search_items first and pass those results
        # here verbatim. An empty list means the LLM does NOT have the items
        # yet (typical for mode A / StatusOnly, where it only saw a count
        # summary). In that case we raise so the agent gets an honest error
        # and must issue an additional search_items call — that extra turn's
        # cost IS part of mode A's true cost and must be counted in the trace.
        raw_refs = args.get("item_refs")
        if not raw_refs:
            raise ValueError(
                "item_refs must be a non-empty list of STAC item objects from a "
                "prior search_items call. Call search_items first to obtain them."
            )
        # Accept either StacItemFields instances or plain dicts (the LLM
        # serialises tool results as JSON, so dicts are the normal case).
        items = [
            ref if isinstance(ref, StacItemFields) else StacItemFields(**ref)
            for ref in raw_refs
        ]
        raw = veda_tools.compute_stats(items, args["band"], args["geometry"])
    else:
        raise ValueError(f"unknown tool: {name!r}")
    return handler.wrap(name, tool_call_id, raw)
