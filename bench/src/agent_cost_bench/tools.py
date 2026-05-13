"""Tool implementations for the tool-chain scenario.

Real local functions (no mocks) that the LLM can invoke via OpenAI's
function-calling protocol. Production agents call MCP servers / REST
APIs / databases — these stand in for that layer and produce
realistic tool-result token volumes.

Three tools cover the production patterns that matter for AXIOM
calibration:

  search(query)         → simulates ADS / web search → 3-5 result snippets
  fetch_doc(doc_id)     → simulates document retrieval → 800-1500 tokens
  query_db(sql)         → simulates SQL execution → tabular result

The LLM picks tools dynamically based on its system prompt; we
record per-tool token cost so the variance comparator can
calibrate AXIOM's tool-result-tokens coefficient (currently a
guess at ~200 tok/call).
"""

from __future__ import annotations

import hashlib
import json
import random
from typing import Any


def _stable_seed(s: str) -> int:
    """Deterministic 32-bit seed from a string.

    Python's built-in `hash()` is randomized per process by default
    (since 3.3, controlled by PYTHONHASHSEED). Seeding `random.Random`
    with `hash(query)` therefore breaks the bench's reproducibility
    claim: two runs of the same scenario with the same config_hash
    would produce different "deterministic" tool results, different
    per-turn token counts, and different trace artifacts.

    Using SHA-256 keeps the seeding stable across processes,
    interpreters, and Python versions — same input string, same seed,
    always.
    """
    return int.from_bytes(hashlib.sha256(s.encode("utf-8")).digest()[:4], "little")

# Tool schemas — what we expose to the LLM via function calling.
# These mirror what NASA-IMPACT/akd-services exposes via MCP servers
# (code_search, ads_search, experiment_status, pds_search), kept
# generic so any team running similar architectures sees themselves.

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": (
                "Search a literature index for papers matching the query. "
                "Returns 3-5 result snippets with title, authors, abstract."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query, e.g. 'satellite NO2 New York City'",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "1-5",
                        "default": 3,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_doc",
            "description": (
                "Retrieve the full text of a document by ID. Returns ~1000 tokens."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_id": {"type": "string", "description": "Document identifier"},
                },
                "required": ["doc_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_db",
            "description": (
                "Execute a read-only SQL query against the metadata catalog. "
                "Returns up to 10 rows as JSON."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {"type": "string", "description": "Read-only SQL"},
                },
                "required": ["sql"],
            },
        },
    },
    # ---- EIE-shape tools — used by the data-discovery scenario.
    # These mirror the canonical 6-tool flow used in production
    # domain-data-discovery agents (parse_datetime → geocode →
    # search_collections → select_collection → search_items →
    # compute_stats). Tool-state pattern: large payloads (geometry,
    # item lists) stay out of the LLM context — only summaries and
    # IDs are returned to the model. This is the optimization a
    # naïve cost simulator misses.
    {
        "type": "function",
        "function": {
            "name": "parse_datetime",
            "description": "Validate an ISO-8601 datetime range. Returns pending_confirmation for user to verify.",
            "parameters": {
                "type": "object",
                "properties": {
                    "value": {"type": "string", "description": "ISO-8601 range YYYY-MM-DD/YYYY-MM-DD"},
                },
                "required": ["value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "geocode",
            "description": "Resolve a place name to a bbox + small bounding-polygon geometry. Returns pending_confirmation for user to verify location.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Place name, e.g. 'Houston TX' or 'California'"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_collections",
            "description": "Semantic search over a domain catalog. Returns top-K candidate collections with cosine_similarity, spatial/temporal overlap, available variables. Returns pending_confirmation when multiple match.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Topic, e.g. 'NO2 air quality'"},
                    "top_k": {"type": "integer", "default": 5},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "select_collection",
            "description": "Record the user's collection (and optional variable) selection.",
            "parameters": {
                "type": "object",
                "properties": {
                    "collection_id": {"type": "string"},
                    "variable": {"type": "string"},
                },
                "required": ["collection_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_items",
            "description": "Search an item catalog (e.g. STAC) for a previously selected collection over the bbox + datetime. Returns up to 15 items with id, datetime, asset URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "default": 15},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compute_stats",
            "description": "Compute zonal/raster statistics for the items selected. Returns per-item per-band mean/min/max plus valid_percent.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "build_viz_tiles",
            "description": "Build raster tile URLs for the items selected. Non-gating; can be called in the same turn as compute_stats. Reads items + selected collection from state.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


# --- Tool implementations (deterministic, reproducible) ----------

# Pre-baked content corpus — scenarios are reproducible because the
# random seed is fixed per call.

_PAPER_TITLES = [
    "Satellite NO2 trends over US megacities, 2014-2023",
    "Ground-truth comparison of OMI vs TROPOMI NO2 retrievals",
    "Boundary-layer mixing effects on column-to-surface NO2 ratios",
    "Diurnal cycle of NO2 in urban air-quality monitoring",
    "Statistical methods for satellite-based regulatory compliance",
]

_PAPER_ABSTRACTS = [
    (
        "We analyze 9 years of OMI and TROPOMI tropospheric NO2 retrievals "
        "across 12 major US metropolitan areas. Median annual decline ranges "
        "from 1.8% (Atlanta) to 4.7% (Los Angeles), with a notable "
        "discontinuity in Q2 2020 attributable to pandemic mobility "
        "reductions. Statistical significance is robust at p<0.01 across all "
        "cities except Houston, where industrial point-source emissions "
        "complicate the trend signal."
    ),
    (
        "Inter-instrument calibration shows OMI underestimates urban NO2 "
        "columns by 6-9% relative to TROPOMI; the bias is largest in winter "
        "months and inversely correlates with cloud fraction. Differences "
        "stem from the assumed albedo prior in the OMI v003 algorithm, "
        "which was conservatively calibrated against AERONET ground "
        "stations in arid regions."
    ),
    (
        "Boundary-layer height variability introduces significant scatter "
        "(~30% relative) in the column-to-surface conversion of satellite "
        "NO2. Without colocated planetary boundary-layer measurements, "
        "single-day satellite observations provide poor surface-quality "
        "proxies. Multi-day averaging substantially improves the "
        "correlation."
    ),
]


def search(query: str, max_results: int = 3) -> dict:
    """Return 3-5 fake-but-plausible literature search results."""
    n = max(1, min(5, max_results))
    rng = random.Random(_stable_seed(query))
    titles = rng.sample(_PAPER_TITLES, k=min(n, len(_PAPER_TITLES)))
    return {
        "query": query,
        "result_count": len(titles),
        "results": [
            {
                "doc_id": f"DOC-{rng.randrange(1000, 9999)}",
                "title": t,
                "authors": rng.choice(
                    [
                        ["Liu Z.", "Smith J."],
                        ["Patel A.", "Johnson R.", "Lee K."],
                        ["Anderson S."],
                    ]
                ),
                "year": rng.choice([2021, 2022, 2023]),
                "abstract": rng.choice(_PAPER_ABSTRACTS),
            }
            for t in titles
        ],
    }


def fetch_doc(doc_id: str) -> dict:
    """Return a ~1000-token document body."""
    rng = random.Random(_stable_seed(doc_id))
    body_paragraphs = rng.choices(_PAPER_ABSTRACTS, k=4)  # ~4 paragraphs
    return {
        "doc_id": doc_id,
        "title": rng.choice(_PAPER_TITLES),
        "body": "\n\n".join(body_paragraphs)
        + "\n\nFigure 1 shows the time series of column NO2 over each city, "
        + "smoothed with a 3-month moving average. Figure 2 decomposes the "
        + "trend into a seasonal cycle and a long-term linear component. "
        + "Table 1 reports statistical significance across all 12 cities, "
        + "with the heteroscedasticity-corrected t-test for each year-on-year "
        + "comparison.",
        "doi": f"10.1234/{doc_id.lower()}",
    }


def query_db(sql: str) -> dict:
    """Return up to 10 rows of fake tabular data."""
    rng = random.Random(_stable_seed(sql))
    n = rng.randint(2, 8)
    return {
        "sql": sql,
        "row_count": n,
        "columns": ["region", "year", "no2_mean_dobson", "n_samples"],
        "rows": [
            {
                "region": rng.choice(["NYC", "LA", "Houston", "Chicago", "Atlanta"]),
                "year": rng.choice([2020, 2021, 2022, 2023]),
                "no2_mean_dobson": round(rng.uniform(0.8, 4.2), 3),
                "n_samples": rng.randint(50, 300),
            }
            for _ in range(n)
        ],
    }


# --- EIE-shape tools (data-discovery scenario) -------------------

# Tool-response-shape mode. Two settings:
#   - 'freeform' (default): tool `message` fields carry descriptive
#     context derived from the call ("Date range set to 2021-10/2021-12.
#     Please confirm this is correct."). Mirrors the textual richness
#     a default ReAct loop produces; per-turn input cost compounds
#     with conversation history.
#   - 'templated': tool messages are clipped to a short fixed
#     placeholder ("OK — date range stored. Awaiting confirmation.").
#     Models production agents that pipe every tool return through a
#     centralized response-template layer, keeping the LLM context
#     small across turns. The placeholder strings here are *generic*
#     by design — they convey only the status transition, never any
#     value carried by the call — so they can be compared to any
#     templated-response implementation without textual coupling.
#
# The runner calls `set_response_mode()` before each scenario so a
# scenario's `tool_response_mode` field is honored. Default is
# 'freeform' to preserve historical bench behavior for existing
# scenarios that don't declare the field.
# THREAD-SAFETY: _RESPONSE_MODE and _eie_state below are plain
# module-level globals. The bench runs scenarios sequentially in a
# single process, so this is fine today. If two scenarios are ever
# evaluated concurrently in-process (e.g. a future async harness),
# wrap both pieces of state in a contextvars.ContextVar (or move them
# onto the LangGraph state) to keep per-scenario isolation.
_RESPONSE_MODE: str = "freeform"


def set_response_mode(mode: str) -> None:
    """Switch the active tool-response shape. Called by the runner."""
    global _RESPONSE_MODE
    if mode not in ("freeform", "templated"):
        raise ValueError(
            f"Unknown tool_response_mode {mode!r}; expected 'freeform' or 'templated'"
        )
    _RESPONSE_MODE = mode


def reset_response_mode() -> None:
    """Restore the default response mode. Useful for tests."""
    global _RESPONSE_MODE
    _RESPONSE_MODE = "freeform"


def _msg(freeform: str, templated: str) -> str:
    """Pick the message variant for the active mode.

    `freeform` is the descriptive default; `templated` is a short
    generic placeholder. Tools call this everywhere they previously
    inlined an f-string for the `message` field. The split keeps the
    two shapes side-by-side in the source so it's obvious what cost
    profile each call produces.
    """
    return templated if _RESPONSE_MODE == "templated" else freeform


# Module-level shared "tool state" — mirrors the EIE pattern where
# large payloads (geometry, item lists, collection metadata) are
# kept out of LLM context and only summaries are returned. The LLM
# never sees the raw geometry; just the bbox + name.
_eie_state: dict[str, Any] = {
    "datetime_range": None,
    "place": None,
    "bbox": None,
    "selected_collection": None,
    "selected_variable": None,
    "items": None,
    # `last_matches` holds per-collection metadata returned by the last
    # search_collections call. select_collection reads it to decide
    # whether to gate on a CMR variable choice — without it we can't
    # model the extra confirmation turn that multi-variable CMR
    # collections trigger in production.
    "last_matches": [],
}


def parse_datetime(value: str) -> dict:
    """Validate an ISO-8601 range; return pending_confirmation for user."""
    parts = value.split("/")
    if len(parts) != 2:
        return {"status": "error", "error": f"Invalid format '{value}', expected YYYY-MM-DD/YYYY-MM-DD"}
    _eie_state["datetime_range"] = value
    return {
        "status": "pending_confirmation",
        "datetime": value,
        "message": _msg(
            f"Date range set to {value}. Please confirm this is correct.",
            "OK — date range stored. Awaiting confirmation.",
        ),
    }


def geocode(query: str) -> dict:
    """Resolve place name → bbox + small polygon. The LLM only sees the
    bbox polygon (~100 tokens), never the full geometry."""
    rng = random.Random(_stable_seed(query))
    # Realistic-ish bbox for a city/region
    w = round(rng.uniform(-125, -70), 4)
    s = round(rng.uniform(25, 48), 4)
    e = round(w + rng.uniform(0.1, 2.0), 4)
    n = round(s + rng.uniform(0.1, 2.0), 4)
    bbox = [w, s, e, n]
    bbox_poly = {
        "type": "Polygon",
        "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
    }
    _eie_state["place"] = query
    _eie_state["bbox"] = bbox
    # In templated mode, geometry stays in server-side state and never
    # reaches the LLM — only the small bbox does.
    if _RESPONSE_MODE == "templated":
        return {
            "status": "pending_confirmation",
            "place": query,
            "bbox": bbox,
            "message": "OK — location resolved. Awaiting confirmation.",
        }
    return {
        "status": "pending_confirmation",
        "place": query,
        "bbox": bbox,
        "geometry": bbox_poly,
        "message": f"Location resolved to '{query}'. Please confirm.",
    }


def search_collections(query: str, top_k: int = 5) -> dict:
    """Top-K collection candidates with realistic metadata."""
    rng = random.Random(_stable_seed(query))
    n = max(1, min(5, top_k))
    options = []
    for i in range(n):
        cos = round(0.92 - i * 0.07, 3)
        options.append({
            "id": f"COLL-{rng.randrange(100, 999)}",
            "title": rng.choice(_PAPER_TITLES),
            "cosine_similarity": cos,
            "match_strength": "High" if cos > 0.85 else "Moderate" if cos > 0.7 else "Weak",
            "spatial_overlap": True,
            "temporal_overlap": True,
            "is_cmr_backed": rng.random() < 0.3,
            "available_variables": rng.choice([
                ["NO2_total_column"],
                ["AOT_550", "AOT_660", "AOT_865"],
                ["LST_day", "LST_night"],
                [],
            ]),
        })
    # Persist matches so select_collection can look up CMR-flag and
    # variable lists later (needed to model the variable-selection
    # gate). The LLM never sees this — it's bench-internal state.
    _eie_state["last_matches"] = options
    # Templated mode: only minimal options reach the LLM (id, label,
    # cmr flag — ~15 tokens per option). Freeform mode includes the
    # full match metadata (cosine, overlap flags, available variables)
    # which dominates per-turn input cost in long sessions.
    minimal_options = [
        {"id": o["id"], "label": o["title"], "is_cmr_backed": o["is_cmr_backed"]}
        for o in options
    ]
    if n == 1:
        if _RESPONSE_MODE == "templated":
            return {
                "status": "complete",
                "options": minimal_options,
                "message": "OK — one matching dataset returned.",
            }
        return {"status": "complete", "matches": options,
                "message": f"Found 1 matching collection: {options[0]['title']}"}
    if _RESPONSE_MODE == "templated":
        return {
            "status": "pending_confirmation",
            "options": minimal_options,
            "message": "OK — candidate datasets returned. Pick one.",
        }
    return {
        "status": "pending_confirmation",
        "matches": options,
        "options": [{"id": o["id"], "label": o["title"]} for o in options],
        "message": f"Found {n} matching collections. Please select one.",
    }


def select_collection(collection_id: str, variable: str | None = None) -> dict:
    """Record the user's selection.

    CMR-backed collections with multiple available variables require
    an extra confirmation turn: the agent calls select_collection with
    just the id, the tool returns pending_confirmation listing the
    variables, then the agent calls again with `variable` set. This
    mirrors the production agent's two-step CMR flow and is the only
    way a benchmark can faithfully model the cost of that extra turn.
    """
    # Look up metadata for this id from the last search_collections
    # call. If we don't have it (e.g. agent invoked select with an
    # arbitrary id), treat it as a VEDA COG collection with no
    # variable list — the safer default.
    match = next(
        (m for m in _eie_state.get("last_matches", []) if m.get("id") == collection_id),
        None,
    )
    is_cmr = bool(match and match.get("is_cmr_backed"))
    available_vars = (match or {}).get("available_variables") or []

    # Gate: CMR + multiple variables + no variable picked yet.
    if is_cmr and len(available_vars) > 1 and not variable:
        _eie_state["selected_collection"] = collection_id  # half-selected
        if _RESPONSE_MODE == "templated":
            return {
                "status": "pending_confirmation",
                "selected_collection_id": collection_id,
                "selected_variable": None,
                "options": [{"id": v, "label": v} for v in available_vars],
                "message": "OK — variable selection required.",
            }
        return {
            "status": "pending_confirmation",
            "selected_collection_id": collection_id,
            "selected_variable": None,
            "available_variables": available_vars,
            "message": (
                f"Collection '{collection_id}' exposes multiple variables. "
                f"Please choose one: {', '.join(available_vars)}."
            ),
        }

    # CMR + exactly one variable: auto-select it without a confirmation
    # turn — matches the production behavior.
    if is_cmr and len(available_vars) == 1 and not variable:
        variable = available_vars[0]

    _eie_state["selected_collection"] = collection_id
    if variable:
        _eie_state["selected_variable"] = variable
    return {
        "status": "complete",
        "selected_collection_id": collection_id,
        "selected_variable": variable,
        "message": _msg(
            f"Selected collection '{collection_id}'"
            + (f" with variable '{variable}'" if variable else ""),
            "OK — selection recorded.",
        ),
    }


def search_items(limit: int = 15) -> dict:
    """Return up to 15 items for the selected collection — realistic
    payload size (~2-3K tokens) but only IDs + datetimes shown to LLM."""
    if not _eie_state.get("selected_collection"):
        return {"status": "error", "error": "No collection selected — call select_collection first"}
    if not _eie_state.get("bbox"):
        return {"status": "error", "error": "No bbox — call geocode first"}
    rng = random.Random(_stable_seed(_eie_state["selected_collection"]))
    n = rng.randint(8, max(8, min(15, limit)))
    items = []
    for i in range(n):
        items.append({
            "id": f"ITEM-{rng.randrange(10000, 99999)}",
            "datetime": f"2021-{rng.randint(1,12):02d}-{rng.randint(1,28):02d}T00:00:00Z",
            "asset_url": f"s3://veda-data-store/{_eie_state['selected_collection']}/item-{i}.tif",
        })
    _eie_state["items"] = items
    # Templated mode: the items array (largest payload from this stage)
    # stays in state. The LLM only sees the count, which is what a
    # production agent's pipeline needs to decide whether to advance.
    if _RESPONSE_MODE == "templated":
        return {
            "status": "complete",
            "retrieved": n,
            "message": "OK — catalog items retrieved.",
        }
    return {
        "status": "complete",
        "item_count": n,
        "items": items,
        "message": f"Found {n} items for the selected collection.",
    }


def compute_stats() -> dict:
    """Per-item per-band statistics — realistic payload."""
    items = _eie_state.get("items")
    if not items:
        return {"status": "error", "error": "No items — call search_items first"}
    rng = random.Random(42)
    results = []
    for it in items:
        valid_pct = round(rng.uniform(70, 100), 1)
        results.append({
            "id": it["id"],
            "datetime": it["datetime"],
            "stats": {
                "b1": {
                    "mean": round(rng.uniform(0.5, 4.5), 4),
                    "min": round(rng.uniform(0.0, 0.5), 4),
                    "max": round(rng.uniform(4.5, 8.0), 4),
                    "valid_percent": valid_pct,
                },
            },
        })
    # Templated mode: the per-item stats array stays in state; the
    # downstream renderer reads it from there. The LLM only sees the
    # count and a status update, mirroring production agents that
    # explicitly suppress numeric output from the model layer.
    if _RESPONSE_MODE == "templated":
        return {
            "status": "complete",
            "count": len(results),
            "message": "OK — statistics retrieved.",
        }
    return {
        "status": "complete",
        "result_count": len(results),
        "results": results,
        "message": f"Statistics computed for {len(results)} items.",
    }


def build_viz_tiles() -> dict:
    """Build tile URLs for each item selected.

    Mirrors the production pattern where a separate visualization
    stage runs alongside (or right after) statistics. Non-gating —
    the agent can call this in the same turn as compute_stats. In
    freeform mode the LLM sees the full URL list; in templated mode
    only the count, since the renderer downstream reads the URLs out
    of state, not out of the conversation.
    """
    items = _eie_state.get("items")
    if not items:
        return {"status": "error", "error": "No items — call search_items first"}
    coll = _eie_state.get("selected_collection") or "COLL-XXX"
    tile_urls = [
        # Z/X/Y placeholders — the bench doesn't render tiles, it just
        # models the cost shape of a tile-URL payload moving through
        # the conversation.
        f"https://titiler.veda.example/cog/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}.png?url={it['asset_url']}"
        for it in items
    ]
    if _RESPONSE_MODE == "templated":
        return {
            "status": "complete",
            "count": len(tile_urls),
            "message": "OK — tile URLs prepared.",
        }
    return {
        "status": "complete",
        "tile_count": len(tile_urls),
        "tile_urls": tile_urls,
        "message": f"Generated {len(tile_urls)} tile URL templates for the selected collection.",
    }


def execute_tool_call(name: str, arguments: dict[str, Any]) -> str:
    """Dispatch a function call coming from the LLM. Returns the JSON
    string the LLM will see as the tool result."""
    if name == "search":
        result = search(**arguments)
    elif name == "fetch_doc":
        result = fetch_doc(**arguments)
    elif name == "query_db":
        result = query_db(**arguments)
    elif name == "parse_datetime":
        result = parse_datetime(**arguments)
    elif name == "geocode":
        result = geocode(**arguments)
    elif name == "search_collections":
        result = search_collections(**arguments)
    elif name == "select_collection":
        result = select_collection(**arguments)
    elif name == "search_items":
        result = search_items(**arguments)
    elif name == "compute_stats":
        result = compute_stats(**arguments)
    elif name == "build_viz_tiles":
        result = build_viz_tiles(**arguments)
    else:
        result = {"error": f"unknown tool: {name}"}
    return json.dumps(result)


def reset_eie_state() -> None:
    """Clear the EIE-shape tool state — call between scenario runs."""
    _eie_state.clear()
    _eie_state.update({
        "datetime_range": None, "place": None, "bbox": None,
        "selected_collection": None, "selected_variable": None, "items": None,
        "last_matches": [],
    })
