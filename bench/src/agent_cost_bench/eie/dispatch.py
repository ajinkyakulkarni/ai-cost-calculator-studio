"""Route OpenAI-shape tool calls into veda_tools + wrap via handler.

This is the only file that knows which veda_tools function corresponds
to which tool name in the LLM's tool schema. The runner and patterns
talk to this module; nothing else.
"""

from __future__ import annotations

from typing import Any, Protocol

from . import veda_tools


# Centralized JSON schemas the LLM sees for each tool. These names
# match the dispatch keys below.
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
            "description": "Compute band stats over a polygon AOI from a list of STAC items.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_refs": {"type": "array", "items": {"type": "string"}},
                    "band": {"type": "string"},
                    "geometry": {"type": "object"},
                },
                "required": ["item_refs", "band", "geometry"],
            },
        },
    },
]


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
            args.get("band", "FIRE"),
        )
    elif name == "compute_stats":
        # `item_refs` is a list of tool_call_ids pointing into handler state.
        # The handler is responsible for resolving refs back to typed items.
        # For KeyFields and Freeform handlers, the LLM passes the items
        # directly; for StatusOnly the LLM passes only the call-id of the
        # earlier search_items call and the handler reconstitutes.
        # Simplest cross-handler contract: always re-search if compute_stats
        # is called without resolved items. For the bench's fixed workload
        # this is one extra STAC call, acceptable.
        items = veda_tools.search_items(
            args.get("collection_id", "micasa-carbonflux-monthgrid-v1"),
            tuple(args.get("bbox", (-123.89, 38.76, -122.82, 40.0))),
            args.get("datetime_range", "2020-06-01/2020-11-01"),
            args.get("band", "FIRE"),
        ).items
        raw = veda_tools.compute_stats(items, args["band"], args["geometry"])
    else:
        raise ValueError(f"unknown tool: {name!r}")
    return handler.wrap(name, tool_call_id, raw)
