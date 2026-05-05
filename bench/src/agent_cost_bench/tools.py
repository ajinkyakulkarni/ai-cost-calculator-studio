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

import json
import random
from typing import Any

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
    rng = random.Random(hash(query) & 0xFFFFFFFF)
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
    rng = random.Random(hash(doc_id) & 0xFFFFFFFF)
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
    rng = random.Random(hash(sql) & 0xFFFFFFFF)
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


def execute_tool_call(name: str, arguments: dict[str, Any]) -> str:
    """Dispatch a function call coming from the LLM. Returns the JSON
    string the LLM will see as the tool result."""
    if name == "search":
        result = search(**arguments)
    elif name == "fetch_doc":
        result = fetch_doc(**arguments)
    elif name == "query_db":
        result = query_db(**arguments)
    else:
        result = {"error": f"unknown tool: {name}"}
    return json.dumps(result)
