"""Response handlers — the keystone of the templating bench.

Three middleware classes intercept every tool return before it is
serialized into the LLM's next-turn context. All three are pure
functions over a typed tool response. The only thing that varies
between bench scenarios in the same row is which handler is wrapping
the tool call.

StatusOnlyHandler  (mode A) — each tool returns ≤ 60 tokens of summary;
                              structured payload held in agent-side
                              state, never reaches the LLM.
KeyFieldsHandler   (mode B) — emits ~5-10 essential fields per tool
                              (production-realistic Pydantic shape);
                              drops bulky metadata.
FreeformHandler    (mode C) — passthrough of the raw tool response
                              with full geometry/properties/assets
                              serialized verbatim.

Tests in tests/eie/ confirm per-handler token discipline.
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel

from .schemas import (
    ComputeStatsReturn,
    GeocodeReturn,
    ParseDatetimeReturn,
    SearchCollectionsReturn,
    SearchItemsReturn,
    StatusReturn,
)


class StatusOnlyHandler:
    """Mode A: tool returns become ≤ 60-token status strings.

    Structured payloads are persisted in self.state keyed by
    tool_call_id so the agent can reference them server-side (e.g. when
    composing the final answer the agent reads compute_stats numbers
    from state, NOT from a re-summarized blob). The LLM context only
    ever sees the short summary string.
    """

    def __init__(self) -> None:
        # Keyed by tool_call_id. Values are the original typed return
        # objects (NOT serialized). Reset per scenario by the runner.
        self.state: dict[str, BaseModel] = {}

    def wrap(self, tool_name: str, tool_call_id: str, raw: BaseModel) -> str:
        """Stash the raw return; emit a short status JSON the LLM will see."""
        self.state[tool_call_id] = raw
        summary = self._summarize(tool_name, raw)
        out = StatusReturn(ok=True, summary=summary, tool_call_id=tool_call_id)
        return out.model_dump_json()

    def _summarize(self, tool_name: str, raw: BaseModel) -> str:
        if isinstance(raw, ParseDatetimeReturn):
            return f"parsed datetime range {raw.start} to {raw.end}"
        if isinstance(raw, GeocodeReturn):
            return f"geocoded {raw.admin_name} ({raw.admin_level})"
        if isinstance(raw, SearchCollectionsReturn):
            return f"{raw.total_matched} collections matched"
        if isinstance(raw, SearchItemsReturn):
            collection_hint = raw.items[0].id.split("-2020")[0] if raw.items else ""
            window = ""
            if raw.items:
                first = raw.items[0].datetime[:7]
                last = raw.items[-1].datetime[:7]
                window = f", {first} to {last}"
            return f"{raw.total_matched} items found in {collection_hint}{window}"
        if isinstance(raw, ComputeStatsReturn):
            return (
                f"{raw.band} stats over {raw.n_items} items: "
                f"mean={raw.mean:.2f}, median={raw.median:.2f}, "
                f"min={raw.min:.2f}, max={raw.max:.2f}"
            )
        return f"{tool_name} returned (untyped payload)"


class KeyFieldsHandler:
    """Mode B: the production middle ground the paper omits.

    Emits the typed Pydantic schema directly — which IS the
    key-fields-only extraction. Caps list-returning tools at 10
    entries (search_items returning 50 STAC items would dump too
    much; production agents always cap or paginate).

    The handler is stateless; everything the LLM needs is in the
    returned JSON. No agent-side state required.
    """

    LIST_CAP = 10  # search_items and search_collections cap entries at this

    def wrap(self, tool_name: str, tool_call_id: str, raw: BaseModel) -> str:
        if isinstance(raw, SearchItemsReturn):
            # Cap items list while preserving total_matched signal
            capped = SearchItemsReturn(
                items=raw.items[: self.LIST_CAP],
                total_matched=raw.total_matched,
            )
            return capped.model_dump_json()
        if isinstance(raw, SearchCollectionsReturn):
            capped = SearchCollectionsReturn(
                collections=raw.collections[: self.LIST_CAP],
                total_matched=raw.total_matched,
            )
            return capped.model_dump_json()
        return raw.model_dump_json()


class FreeformHandler:
    """Mode C: identity passthrough of the raw tool response.

    Accepts either a Pydantic model (serialized with .model_dump_json)
    or a raw dict/list (serialized with json.dumps directly — the
    structured payload from upstream STAC calls is kept verbatim).

    This is what naive ReAct loops do without any output structuring.
    Full geometry coordinates, every non-primary asset, every property,
    full provider blob — all reach the LLM context.
    """

    def wrap(self, tool_name: str, tool_call_id: str, raw: Any) -> str:
        if isinstance(raw, BaseModel):
            return raw.model_dump_json()
        return json.dumps(raw, default=str)
