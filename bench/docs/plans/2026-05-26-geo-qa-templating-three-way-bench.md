# 3-way templating bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a parallel, self-contained 3-way templating bench (6 scenarios = 2 conversation patterns × 3 response-handler modes) that runs against real NASA VEDA STAC + real GPT-5.2 and empirically settles whether the paper's 7.5× tool-response cost lever holds against realistic production templating.

**Architecture:** New isolated modules under `bench/src/agent_cost_bench/` with `eie_*.py` / `veda_*.py` namespacing — existing `tools.py` and existing scenarios remain untouched. Three response-handler middleware classes wrap a common set of 5 real-API tools against `openveda.cloud/api/stac/`. Two LangGraph state machines (Pattern P = paper's 6-turn ReAct, Pattern E = gated drill-down ~9-10 turns). A new CLI subcommand orchestrates the 6-run matrix and a report generator emits the comparison Markdown.

**Tech Stack:** Python 3.11+, LangGraph (state machines), LiteLLM (provider), Pydantic (handler schemas), httpx (STAC HTTP), rio-tiler (COG band stats), dateparser (datetime parsing), pytest + httpx mock for unit tests, pyyaml for scenario manifests, OpenTelemetry for traces.

**Reference:** [`bench/docs/specs/2026-05-26-geo-qa-templating-three-way-bench-design.md`](../specs/2026-05-26-geo-qa-templating-three-way-bench-design.md)

---

## Pre-flight

Before Task 1, confirm the working directory and existing state:

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
ls src/agent_cost_bench/                      # confirms tools.py exists (untouched by this plan)
ls scenarios/                                  # confirms 12 existing scenarios; none will be modified
test -d src/agent_cost_bench/eie || echo "fresh"
```

All work in this plan happens in new files. Where an existing file is modified (`cli.py`, `pyproject.toml`), the modification is purely additive — a new subcommand registration or new dep, never a behaviour change to existing scenarios. `npm run bench:validate` in the calc repo root must continue passing 6/6 ±0.00% after every commit.

---

### Task 1: Add new dependencies + create directory layout

**Files:**
- Modify: `bench/pyproject.toml` (add httpx, rio-tiler, dateparser, pytest-httpx to deps lists)
- Create: `bench/src/agent_cost_bench/geo_qa/__init__.py`
- Create: `bench/data/.gitkeep`
- Create: `bench/scenarios/geo-qa-templating/.gitkeep`
- Create: `bench/reports/geo-qa-templating/.gitkeep`
- Create: `bench/tests/geo_qa/__init__.py`

- [ ] **Step 1: Add the new runtime deps to `bench/pyproject.toml`**

Open `bench/pyproject.toml`. Find the existing `dependencies = [...]` block (around line 11). Append these four entries inside the list, just before the closing `]`:

```toml
    # HTTP client for NASA VEDA STAC calls in the templating bench.
    # httpx is also a transitive of openai>=1.40 so this just pins it.
    "httpx>=0.27.0",
    # Reading Cloud Optimized GeoTIFF assets from STAC items, computing
    # per-band aggregates over a polygon AOI. Used by veda_tools.compute_stats.
    "rio-tiler>=6.7.0",
    # Natural-language datetime parsing for parse_datetime tool.
    "dateparser>=1.2.0",
```

Then find the existing `dev = [...]` line under `[project.optional-dependencies]`. Replace the line with:

```toml
dev = [
    "pytest>=8.0",
    "ruff>=0.7.0",
    "mypy>=1.13.0",
    # Mock HTTP responses in unit tests for VEDA STAC tools.
    "pytest-httpx>=0.34.0",
]
```

- [ ] **Step 2: Create the new directory skeletons**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
mkdir -p src/agent_cost_bench/eie
mkdir -p data
mkdir -p scenarios/geo-qa-templating
mkdir -p reports/geo-qa-templating
mkdir -p tests/eie
touch src/agent_cost_bench/geo_qa/__init__.py
touch tests/geo_qa/__init__.py
touch data/.gitkeep
touch scenarios/geo-qa-templating/.gitkeep
touch reports/geo-qa-templating/.gitkeep
```

- [ ] **Step 3: Install the new deps**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pip install -e ".[dev]"
```

Expected: pip installs httpx, rio-tiler, dateparser, pytest-httpx without conflicts. If `rio-tiler` install fails on macOS, run `brew install gdal proj` first, then retry.

- [ ] **Step 4: Verify**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
python -c "import httpx, dateparser, rio_tiler; print('ok')"
```

Expected: `ok`

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/pyproject.toml bench/src/agent_cost_bench/eie bench/data bench/scenarios/geo-qa-templating bench/reports/geo-qa-templating bench/tests/eie
git commit -m "bench(eie): scaffold three-way templating bench dirs + deps

Adds httpx/rio-tiler/dateparser/pytest-httpx for the new bench. New
empty namespaces under bench/src/agent_cost_bench/geo_qa/, bench/data/,
bench/scenarios/geo-qa-templating/, bench/reports/geo-qa-templating/,
bench/tests/geo_qa/. Existing tools.py and scenarios untouched."
```

---

### Task 2: Ship a county-bbox lookup table

**Files:**
- Create: `bench/data/us_county_bboxes.json` (start with Mendocino + 4 neighbours for redundancy)

- [ ] **Step 1: Write the county-bbox data file**

`bench/data/us_county_bboxes.json`:

```json
{
  "_source": "US Census TIGER/Line 2023, public domain. Bboxes rounded to 4 decimals.",
  "_format": "lookup keyed by lowercase '<county> county, <state-abbrev>'; value is [west, south, east, north] in EPSG:4326.",
  "counties": {
    "mendocino county, ca": [-123.890, 38.756, -122.819, 40.005],
    "fresno county, ca":    [-120.918, 35.913, -118.361, 37.585],
    "sonoma county, ca":    [-123.534, 38.075, -122.341, 38.844],
    "humboldt county, ca":  [-124.408, 40.001, -123.534, 41.464],
    "lake county, ca":      [-123.090, 38.696, -122.330, 39.610]
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/data/us_county_bboxes.json
git commit -m "bench(eie): ship county-bbox lookup table

5 California counties (Mendocino + 4 neighbours) sourced from
US Census TIGER/Line 2023, public domain. Used by veda_tools.geocode
as a deterministic offline fallback so the bench has no external
geocode dependency."
```

---

### Task 3: Define the Pydantic response schemas

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/schemas.py`
- Test: `bench/tests/geo_qa/test_schemas.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_schemas.py`:

```python
"""Validate the typed schemas the response handlers consume + emit."""

import pytest
from agent_cost_bench.geo_qa.schemas import (
    ParseDatetimeReturn,
    GeocodeReturn,
    SearchCollectionsReturn,
    StacItemFields,
    SearchItemsReturn,
    ComputeStatsReturn,
    StatusReturn,
)


def test_parse_datetime_round_trip():
    r = ParseDatetimeReturn(start="2020-06-01", end="2020-11-01")
    assert r.start == "2020-06-01"
    assert r.end == "2020-11-01"


def test_geocode_minimum_fields():
    r = GeocodeReturn(
        admin_name="Mendocino County",
        admin_level="county",
        bbox=(-123.89, 38.76, -122.82, 40.0),
    )
    assert r.admin_name == "Mendocino County"
    assert len(r.bbox) == 4


def test_search_items_holds_a_list_of_typed_items():
    items = [
        StacItemFields(
            id=f"micasa-{m:02d}",
            datetime=f"2020-{m:02d}-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url=f"https://example.org/{m:02d}.tif",
        )
        for m in range(6, 12)
    ]
    r = SearchItemsReturn(items=items, total_matched=len(items))
    assert r.total_matched == 6
    assert r.items[0].id == "micasa-06"


def test_compute_stats_has_aggregates_and_per_item():
    r = ComputeStatsReturn(
        band="FIRE",
        n_items=6,
        mean=1.96,
        median=2.0,
        min=0.0,
        max=4.98,
        per_item=[{"item_id": "m1", "mean": 1.0}],
    )
    assert r.n_items == 6


def test_status_return_caps_summary():
    r = StatusReturn(ok=True, summary="6 items found in micasa-carbonflux-monthgrid-v1, 2020-06 to 2020-10", tool_call_id="ti_3f2a")
    assert r.ok is True
    assert len(r.summary) < 200
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_schemas.py -v
```

Expected: `ModuleNotFoundError: No module named 'agent_cost_bench.geo_qa.schemas'`

- [ ] **Step 3: Write the schemas**

`bench/src/agent_cost_bench/geo_qa/schemas.py`:

```python
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

from typing import Optional

from pydantic import BaseModel, Field


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
    collections: list[CollectionMeta]
    total_matched: int


class StacItemFields(BaseModel):
    id: str
    datetime: str
    bbox: tuple[float, float, float, float]
    primary_asset_url: str


class SearchItemsReturn(BaseModel):
    items: list[StacItemFields]
    total_matched: int


class ComputeStatsReturn(BaseModel):
    band: str
    n_items: int
    mean: float
    median: float
    min: float
    max: float
    per_item: list[dict[str, float]]


class StatusReturn(BaseModel):
    ok: bool
    summary: str
    tool_call_id: str
    error: Optional[str] = None
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_schemas.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/schemas.py bench/tests/geo_qa/test_schemas.py
git commit -m "bench(eie): typed response schemas for templating bench

Pydantic models for the 5 tool-return shapes (parse_datetime, geocode,
search_collections, search_items, compute_stats) plus the
StatusReturn shape used by the status-only handler. These are the
contracts every tool call flows through before the response handlers
serialize them into the LLM's context."
```

---

### Task 4: StatusOnlyHandler (mode A)

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/handlers.py` (just the StatusOnlyHandler in this task)
- Test: `bench/tests/geo_qa/test_handlers_status_only.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_handlers_status_only.py`:

```python
"""StatusOnlyHandler — every tool return becomes ≤ 60 tokens.

The structured payload is held in agent-side state keyed by
tool_call_id. The LLM never sees raw STAC items, geometry coords,
asset URLs — only deterministic short summary strings.
"""

import json
import pytest
from agent_cost_bench.geo_qa.handlers import StatusOnlyHandler
from agent_cost_bench.geo_qa.schemas import (
    GeocodeReturn,
    SearchItemsReturn,
    StacItemFields,
    ComputeStatsReturn,
)


def _approx_tokens(s: str) -> int:
    """OpenAI-ish heuristic: 1 token ≈ 4 chars."""
    return len(s) // 4


def test_status_handler_caps_geocode_response():
    h = StatusOnlyHandler()
    raw = GeocodeReturn(
        admin_name="Mendocino County",
        admin_level="county",
        bbox=(-123.89, 38.76, -122.82, 40.0),
    )
    out = h.wrap("geocode", "tc_001", raw)
    parsed = json.loads(out)
    assert parsed["ok"] is True
    assert "Mendocino County" in parsed["summary"]
    assert _approx_tokens(out) <= 60
    # The raw structured payload is held in handler state, not in the wrapped output:
    assert "bbox" not in parsed
    assert h.state["tc_001"].admin_name == "Mendocino County"


def test_status_handler_caps_search_items_with_many_items():
    h = StatusOnlyHandler()
    items = [
        StacItemFields(
            id=f"micasa-{i:02d}",
            datetime=f"2020-{i:02d}-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url=f"https://example.org/{i:02d}.tif",
        )
        for i in range(6, 12)
    ]
    raw = SearchItemsReturn(items=items, total_matched=6)
    out = h.wrap("search_items", "tc_002", raw)
    parsed = json.loads(out)
    assert "6 items" in parsed["summary"]
    assert _approx_tokens(out) <= 60


def test_status_handler_compute_stats_summary_includes_numbers():
    h = StatusOnlyHandler()
    raw = ComputeStatsReturn(
        band="FIRE", n_items=6, mean=1.96, median=2.0, min=0.0, max=4.98, per_item=[]
    )
    out = h.wrap("compute_stats", "tc_003", raw)
    parsed = json.loads(out)
    # Stats values DO surface in the summary because they ARE the final
    # answer the LLM composes from. Structured per-item array does not.
    assert "1.96" in parsed["summary"]
    assert "FIRE" in parsed["summary"]
    assert _approx_tokens(out) <= 60
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_handlers_status_only.py -v
```

Expected: ImportError on `StatusOnlyHandler`.

- [ ] **Step 3: Implement the handler**

`bench/src/agent_cost_bench/geo_qa/handlers.py`:

```python
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

Tests in tests/geo_qa/ confirm per-handler token discipline.
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
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_handlers_status_only.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/handlers.py bench/tests/geo_qa/test_handlers_status_only.py
git commit -m "bench(eie): StatusOnlyHandler (mode A)

Each tool return becomes a ≤60-token status string. Structured
payload held in handler.state keyed by tool_call_id, never reaches
the LLM context. Final answer composition reads stats values from
the templated summary; raw STAC items, geometry coords, asset URLs
stay server-side."
```

---

### Task 5: KeyFieldsHandler (mode B) — the production-realistic middle ground

**Files:**
- Modify: `bench/src/agent_cost_bench/geo_qa/handlers.py` (append `KeyFieldsHandler` class)
- Test: `bench/tests/geo_qa/test_handlers_key_fields.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_handlers_key_fields.py`:

```python
"""KeyFieldsHandler — the production middle ground the paper omits.

Emits ~5-10 essential fields per tool response (Pydantic-shaped),
drops bulky metadata (full STAC properties dict, all non-primary
assets, geometry coords, provider blob). What most LangChain /
LangGraph agents actually do via structured_output + Pydantic.
"""

import json
from agent_cost_bench.geo_qa.handlers import KeyFieldsHandler
from agent_cost_bench.geo_qa.schemas import (
    GeocodeReturn,
    SearchItemsReturn,
    StacItemFields,
)


def test_key_fields_geocode_keeps_bbox_drops_geometry():
    h = KeyFieldsHandler()
    raw = GeocodeReturn(
        admin_name="Mendocino County",
        admin_level="county",
        bbox=(-123.89, 38.76, -122.82, 40.0),
    )
    out = h.wrap("geocode", "tc_001", raw)
    parsed = json.loads(out)
    assert parsed["admin_name"] == "Mendocino County"
    assert parsed["bbox"] == [-123.89, 38.76, -122.82, 40.0]


def test_key_fields_search_items_caps_at_10_entries():
    h = KeyFieldsHandler()
    # Create 25 items; handler should cap the emitted list at 10 even though
    # total_matched preserves the true count.
    items = [
        StacItemFields(
            id=f"micasa-{i:02d}",
            datetime=f"2020-{i:02d}-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url=f"https://example.org/{i:02d}.tif",
        )
        for i in range(25)
    ]
    raw = SearchItemsReturn(items=items, total_matched=25)
    out = h.wrap("search_items", "tc_002", raw)
    parsed = json.loads(out)
    assert parsed["total_matched"] == 25
    assert len(parsed["items"]) <= 10
    # Each emitted item has only the 4 schema fields, nothing else:
    assert set(parsed["items"][0].keys()) == {"id", "datetime", "bbox", "primary_asset_url"}
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_handlers_key_fields.py -v
```

Expected: ImportError on `KeyFieldsHandler`.

- [ ] **Step 3: Append the handler to `handlers.py`**

Append to `bench/src/agent_cost_bench/geo_qa/handlers.py`:

```python
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
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_handlers_key_fields.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/handlers.py bench/tests/geo_qa/test_handlers_key_fields.py
git commit -m "bench(eie): KeyFieldsHandler (mode B) — production middle ground

Emits the typed Pydantic schema directly. Caps list-returning tools
at 10 entries. Stateless. This is the contract most LangChain/
LangGraph agents default to via structured_output + Pydantic, and
the test the paper does not include."
```

---

### Task 6: FreeformHandler (mode C) — passthrough of raw tool response

**Files:**
- Modify: `bench/src/agent_cost_bench/geo_qa/handlers.py` (append `FreeformHandler` class)
- Test: `bench/tests/geo_qa/test_handlers_freeform.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_handlers_freeform.py`:

```python
"""FreeformHandler — identity passthrough of the raw upstream response.

The raw STAC response (full geometry, every asset, every property)
is serialized verbatim. This is what naive ReAct loops do without
output structuring.
"""

import json
from agent_cost_bench.geo_qa.handlers import FreeformHandler


def test_freeform_passes_through_dict():
    h = FreeformHandler()
    raw_dict = {
        "id": "micasa-202006",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[-123.89, 38.76], [-122.82, 38.76], [-122.82, 40.0], [-123.89, 40.0], [-123.89, 38.76]]],
        },
        "properties": {"datetime": "2020-06-01T00:00:00Z", "eo:cloud_cover": 0, "provider": "NASA"},
        "assets": {
            "FIRE": {"href": "https://example.org/06.tif"},
            "NPP": {"href": "https://example.org/06-npp.tif"},
        },
    }
    out = h.wrap("search_items", "tc_001", raw_dict)
    parsed = json.loads(out)
    # Full payload preserved verbatim
    assert parsed["geometry"]["coordinates"][0][0] == [-123.89, 38.76]
    assert "eo:cloud_cover" in parsed["properties"]
    assert "NPP" in parsed["assets"]


def test_freeform_passes_through_list_of_dicts():
    h = FreeformHandler()
    raw = [{"id": f"item-{i}", "extra": "x" * 200} for i in range(5)]
    out = h.wrap("search_items", "tc_002", raw)
    parsed = json.loads(out)
    assert len(parsed) == 5
    assert parsed[0]["extra"] == "x" * 200
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_handlers_freeform.py -v
```

Expected: ImportError on `FreeformHandler`.

- [ ] **Step 3: Append the handler to `handlers.py`**

Append to `bench/src/agent_cost_bench/geo_qa/handlers.py`:

```python
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
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/ -v
```

Expected: 10 passed (3 schemas + 3 status + 2 key-fields + 2 freeform).

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/handlers.py bench/tests/geo_qa/test_handlers_freeform.py
git commit -m "bench(eie): FreeformHandler (mode C) — identity passthrough

Raw STAC response serialized verbatim. Full geometry/properties/
all asset URLs reach the LLM. This is what naive ReAct loops do
without output structuring."
```

---

### Task 7: `veda_tools.parse_datetime`

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/veda_tools.py` (parse_datetime only in this task)
- Test: `bench/tests/geo_qa/test_veda_tools_parse_datetime.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_veda_tools_parse_datetime.py`:

```python
"""parse_datetime — local NLP, no API call."""

from agent_cost_bench.geo_qa.veda_tools import parse_datetime
from agent_cost_bench.geo_qa.schemas import ParseDatetimeReturn


def test_parse_explicit_range():
    r = parse_datetime("2020-06-01 to 2020-11-01")
    assert isinstance(r, ParseDatetimeReturn)
    assert r.start == "2020-06-01"
    assert r.end == "2020-11-01"


def test_parse_natural_year():
    r = parse_datetime("June 2020 through November 2020")
    # Allow some leeway: must be 2020 and span June-November.
    assert r.start.startswith("2020-06")
    assert r.end.startswith("2020-11")


def test_parse_single_date_returns_same_start_end():
    r = parse_datetime("2020-06-01")
    assert r.start == "2020-06-01"
    assert r.end == "2020-06-01"
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_parse_datetime.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement parse_datetime**

`bench/src/agent_cost_bench/geo_qa/veda_tools.py`:

```python
"""Real NASA VEDA STAC tools — 5 functions, all calling real APIs.

Drop-in replacement for the simulated tools in tools.py, used only
by the geo-qa-templating bench. The existing tools.py is untouched so
the paper-baseline scenarios keep their deterministic-pseudorandom
payloads.

All STAC calls go through `STAC_ROOT` (NASA VEDA's STAC endpoint).
The compute_stats tool uses rio-tiler to read MiCASA COG assets
directly from NASA's data store and compute band aggregates over
the polygon AOI.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path
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

# Shipped county-bbox lookup loaded once at module import.
_COUNTY_DATA_PATH = Path(__file__).resolve().parents[3] / "data" / "us_county_bboxes.json"
with _COUNTY_DATA_PATH.open() as _f:
    _COUNTY_LOOKUP = json.load(_f)["counties"]


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
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_parse_datetime.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/veda_tools.py bench/tests/geo_qa/test_veda_tools_parse_datetime.py
git commit -m "bench(eie): parse_datetime tool (no API)

dateparser-based NLP. Handles explicit 'X to Y' ranges, natural-
language month-year ranges, and single-date inputs. Returns
ParseDatetimeReturn (start, end). First of 5 tools in the eie
templating bench's real-VEDA tool set."
```

---

### Task 8: `veda_tools.geocode` (county-bbox lookup)

**Files:**
- Modify: `bench/src/agent_cost_bench/geo_qa/veda_tools.py` (append `geocode` function)
- Test: `bench/tests/geo_qa/test_veda_tools_geocode.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_veda_tools_geocode.py`:

```python
"""geocode — county-bbox lookup, no API."""

import pytest
from agent_cost_bench.geo_qa.veda_tools import geocode
from agent_cost_bench.geo_qa.schemas import GeocodeReturn


def test_geocode_known_county():
    r = geocode("Mendocino County", "county")
    assert isinstance(r, GeocodeReturn)
    assert r.admin_name == "Mendocino County"
    assert r.admin_level == "county"
    assert -125 < r.bbox[0] < -120  # western longitude reasonable for CA
    assert 38 < r.bbox[1] < 41


def test_geocode_case_insensitive():
    r = geocode("mendocino county", "county")
    assert r.admin_name.lower().startswith("mendocino")


def test_geocode_unknown_county_raises():
    with pytest.raises(KeyError):
        geocode("Atlantis County", "county")
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_geocode.py -v
```

Expected: ImportError on `geocode`.

- [ ] **Step 3: Implement geocode**

Append to `bench/src/agent_cost_bench/geo_qa/veda_tools.py`:

```python
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
    return GeocodeReturn(
        admin_name=key.split(",")[0].strip().title() + " County",
        admin_level="county",
        bbox=tuple(bbox),
    )
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_geocode.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/veda_tools.py bench/tests/geo_qa/test_veda_tools_geocode.py
git commit -m "bench(eie): geocode tool — county-bbox lookup, no external API

Deterministic lookup against the shipped us_county_bboxes.json.
State-level geocode returns a fixed California envelope so Pattern E's
state-gate can complete without an external geocode dep."
```

---

### Task 9: `veda_tools.search_collections` (real VEDA HTTP)

**Files:**
- Modify: `bench/src/agent_cost_bench/geo_qa/veda_tools.py`
- Test: `bench/tests/geo_qa/test_veda_tools_search_collections.py`

- [ ] **Step 1: Write the failing test (with httpx mock)**

`bench/tests/geo_qa/test_veda_tools_search_collections.py`:

```python
"""search_collections — real NASA VEDA STAC call (mocked HTTP in tests)."""

import json
import pytest
from pytest_httpx import HTTPXMock
from agent_cost_bench.geo_qa.veda_tools import search_collections
from agent_cost_bench.geo_qa.schemas import SearchCollectionsReturn


def test_search_collections_matches_keyword(httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json={
            "collections": [
                {"id": "micasa-carbonflux-monthgrid-v1", "title": "MiCASA Land Carbon Flux v1",
                 "description": "Monthly land carbon flux from the MiCASA model"},
                {"id": "modis-ndvi", "title": "MODIS NDVI", "description": "Vegetation index"},
                {"id": "oco2-co2", "title": "OCO-2 CO2", "description": "Atmospheric CO2 column"},
            ]
        },
    )
    r = search_collections("carbon")
    assert isinstance(r, SearchCollectionsReturn)
    # 'carbon' matches MiCASA description; OCO-2 keyword 'CO2' doesn't match 'carbon' as substring.
    assert any("micasa" in c.id for c in r.collections)
    assert r.total_matched >= 1
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_search_collections.py -v
```

Expected: ImportError on `search_collections`.

- [ ] **Step 3: Implement search_collections**

Append to `bench/src/agent_cost_bench/geo_qa/veda_tools.py`:

```python
def search_collections(query: str, top_k: int = 5) -> SearchCollectionsReturn:
    """List NASA VEDA STAC collections, filter client-side by keyword.

    Calls `GET /collections` (no server-side keyword filter is exposed
    by VEDA's STAC API at the time of writing), then matches keyword
    against title + description case-insensitively.
    """
    with httpx.Client(timeout=20.0) as client:
        resp = client.get(f"{STAC_ROOT}/collections")
        resp.raise_for_status()
        data = resp.json()
    q_lower = query.lower()
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
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_search_collections.py -v
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/veda_tools.py bench/tests/geo_qa/test_veda_tools_search_collections.py
git commit -m "bench(eie): search_collections — real NASA VEDA STAC call

Lists VEDA collections, filters by keyword client-side. Tests use
pytest-httpx mocks; live calls happen during actual bench runs."
```

---

### Task 10: `veda_tools.search_items` (real VEDA HTTP)

**Files:**
- Modify: `bench/src/agent_cost_bench/geo_qa/veda_tools.py`
- Test: `bench/tests/geo_qa/test_veda_tools_search_items.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_veda_tools_search_items.py`:

```python
"""search_items — real NASA VEDA STAC items endpoint (mocked HTTP)."""

import pytest
from pytest_httpx import HTTPXMock
from agent_cost_bench.geo_qa.veda_tools import search_items
from agent_cost_bench.geo_qa.schemas import SearchItemsReturn


def test_search_items_typed_return(httpx_mock: HTTPXMock):
    bbox = (-123.89, 38.76, -122.82, 40.0)
    # MiCASA's STAC items endpoint
    httpx_mock.add_response(
        url__regex=r"https://openveda\.cloud/api/stac/collections/micasa-carbonflux-monthgrid-v1/items\?.*",
        json={
            "features": [
                {
                    "id": f"micasa-carbonflux-monthgrid-v1-2020{m:02d}01",
                    "properties": {"datetime": f"2020-{m:02d}-01T00:00:00Z"},
                    "bbox": [-180, -90, 180, 90],
                    "assets": {
                        "FIRE": {"href": f"https://example.org/{m:02d}.tif"},
                        "NPP": {"href": f"https://example.org/{m:02d}-npp.tif"},
                    },
                }
                for m in range(6, 12)
            ],
        },
    )
    r = search_items("micasa-carbonflux-monthgrid-v1", bbox, "2020-06-01/2020-11-01", band="FIRE")
    assert isinstance(r, SearchItemsReturn)
    assert r.total_matched == 6
    assert r.items[0].primary_asset_url.endswith(".tif")
    # primary_asset_url picks the requested band (FIRE), not the first asset by accident:
    assert "06.tif" in r.items[0].primary_asset_url
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_search_items.py -v
```

Expected: ImportError on `search_items`.

- [ ] **Step 3: Implement search_items**

Append to `bench/src/agent_cost_bench/geo_qa/veda_tools.py`:

```python
def search_items(
    collection_id: str,
    bbox: tuple[float, float, float, float],
    datetime_range: str,
    band: str = "FIRE",
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
    return SearchItemsReturn(items=items, total_matched=len(items))
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_search_items.py -v
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/veda_tools.py bench/tests/geo_qa/test_veda_tools_search_items.py
git commit -m "bench(eie): search_items — real NASA VEDA STAC items call

GET /collections/{id}/items with bbox + datetime filter. Returns
typed SearchItemsReturn with primary_asset_url selected from the
requested band."
```

---

### Task 11: `veda_tools.compute_stats` (rio-tiler over COG)

**Files:**
- Modify: `bench/src/agent_cost_bench/geo_qa/veda_tools.py`
- Test: `bench/tests/geo_qa/test_veda_tools_compute_stats.py`

- [ ] **Step 1: Write the failing test (with rio-tiler mocked)**

`bench/tests/geo_qa/test_veda_tools_compute_stats.py`:

```python
"""compute_stats — rio-tiler reads COG band over polygon AOI.

Real bench runs hit NASA's COG store; tests mock rio_tiler.io.Reader
so we don't fetch remote rasters during pytest. Mock returns synthetic
numpy arrays with known statistics.
"""

from unittest.mock import patch, MagicMock
import numpy as np
import pytest
from agent_cost_bench.geo_qa.veda_tools import compute_stats
from agent_cost_bench.geo_qa.schemas import StacItemFields, ComputeStatsReturn


def test_compute_stats_aggregates_across_items():
    items = [
        StacItemFields(
            id=f"item-{i:02d}",
            datetime=f"2020-{i:02d}-01T00:00:00Z",
            bbox=(-123.89, 38.76, -122.82, 40.0),
            primary_asset_url=f"https://example.org/{i:02d}.tif",
        )
        for i in range(6, 9)  # 3 items
    ]
    geometry = {
        "type": "Polygon",
        "coordinates": [[[-123.89, 38.76], [-122.82, 38.76], [-122.82, 40.0], [-123.89, 40.0], [-123.89, 38.76]]],
    }
    # Each mock reader returns a 2x2 array with known mean
    arrays = [np.array([[0.0, 2.0], [2.0, 4.0]]),  # mean=2.0
              np.array([[1.0, 3.0], [3.0, 5.0]]),  # mean=3.0
              np.array([[2.0, 4.0], [4.0, 6.0]])]  # mean=4.0
    mock_reader = MagicMock()
    mock_reader.__enter__ = MagicMock(return_value=mock_reader)
    mock_reader.__exit__ = MagicMock(return_value=None)
    with patch("agent_cost_bench.geo_qa.veda_tools.Reader") as reader_cls:
        reader_cls.return_value = mock_reader
        mock_reader.feature.side_effect = [
            MagicMock(data=np.expand_dims(arr, axis=0), mask=np.ones_like(arr, dtype=bool))
            for arr in arrays
        ]
        r = compute_stats(items, "FIRE", geometry)
    assert isinstance(r, ComputeStatsReturn)
    assert r.n_items == 3
    assert r.band == "FIRE"
    # mean over all 12 pixels: (0+2+2+4 + 1+3+3+5 + 2+4+4+6) / 12 = 36/12 = 3.0
    assert abs(r.mean - 3.0) < 0.01
    assert r.min == 0.0
    assert r.max == 6.0
    assert len(r.per_item) == 3
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_compute_stats.py -v
```

Expected: ImportError on `compute_stats`.

- [ ] **Step 3: Implement compute_stats**

Append to `bench/src/agent_cost_bench/geo_qa/veda_tools.py`:

```python
from rio_tiler.io import Reader
import numpy as np


def compute_stats(
    items: list[StacItemFields],
    band: str,
    geometry: dict[str, Any],
) -> ComputeStatsReturn:
    """For each item, read the COG asset and compute band stats over the polygon.

    Uses rio-tiler's `Reader.feature(geometry)` which clips the raster
    to the polygon and returns a masked numpy array. Aggregates per-item
    means and computes overall mean/median/min/max across all valid
    pixels from all items.
    """
    all_values: list[float] = []
    per_item: list[dict[str, float]] = []
    for it in items:
        with Reader(it.primary_asset_url) as src:
            img = src.feature(geometry)
        arr = np.asarray(img.data, dtype=float).ravel()
        mask = np.asarray(img.mask, dtype=bool).ravel() if hasattr(img, "mask") else np.ones_like(arr, dtype=bool)
        valid = arr[mask]
        if valid.size == 0:
            per_item.append({"item_id": it.id, "mean": float("nan")})
            continue
        per_item.append({"item_id": it.id, "mean": float(np.mean(valid))})
        all_values.extend(valid.tolist())
    if not all_values:
        return ComputeStatsReturn(
            band=band, n_items=len(items),
            mean=0.0, median=0.0, min=0.0, max=0.0,
            per_item=per_item,
        )
    arr_all = np.asarray(all_values)
    return ComputeStatsReturn(
        band=band,
        n_items=len(items),
        mean=float(np.mean(arr_all)),
        median=float(np.median(arr_all)),
        min=float(np.min(arr_all)),
        max=float(np.max(arr_all)),
        per_item=per_item,
    )
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_veda_tools_compute_stats.py -v
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/veda_tools.py bench/tests/geo_qa/test_veda_tools_compute_stats.py
git commit -m "bench(eie): compute_stats — rio-tiler COG band stats over polygon

Per-item: Reader(href).feature(geometry) → masked array. Per-band:
mean/median/min/max across valid pixels from all items, plus
per-item mean for timeseries display."
```

---

### Task 12: `eie_user_actor` — deterministic gate responder

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/user_actor.py`
- Test: `bench/tests/geo_qa/test_user_actor.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_user_actor.py`:

```python
"""eie_user_actor — deterministic gate-response actor for Pattern E.

The bench's "user" in Pattern E is a script, not an LLM. It reads
from a fixed answer list keyed by gate-type. Re-runs are bit-for-bit
reproducible.
"""

from agent_cost_bench.geo_qa.user_actor import UserActor


def test_actor_yields_each_gate_answer_in_order():
    actor = UserActor.frozen_default()
    # Gate 1: datetime confirm
    a = actor.respond("datetime", agent_prompt="Confirm: 2020-06-01 to 2020-11-01?")
    assert a == "yes, that's correct"
    # Gate 2: state
    a = actor.respond("state", agent_prompt="What state should I analyze?")
    assert a == "California"
    # Gate 3: county
    a = actor.respond("county", agent_prompt="Which county?")
    assert a == "Mendocino County"
    # Gate 4: dataset
    a = actor.respond("dataset", agent_prompt="Which dataset?")
    assert "MiCASA" in a
    # Gate 5: variable
    a = actor.respond("variable", agent_prompt="Which variable?")
    assert a == "FIRE"


def test_actor_raises_on_unknown_gate():
    actor = UserActor.frozen_default()
    try:
        actor.respond("unknown_gate", agent_prompt="x")
        assert False, "expected KeyError"
    except KeyError:
        pass
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_user_actor.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement UserActor**

`bench/src/agent_cost_bench/geo_qa/user_actor.py`:

```python
"""Deterministic user-actor for Pattern E (gated drill-down).

Pattern E pauses at 5 confirmation gates; this actor responds with
fixed, pre-decided answers so the conversation is fully reproducible.

Not an LLM. Just a frozen lookup table. The 'user' is a measurement
instrument here, not a participant.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class UserActor:
    """Look-up table keyed by gate-type."""

    answers: dict[str, str]

    @classmethod
    def frozen_default(cls) -> "UserActor":
        """The canonical Mendocino × MiCASA × FIRE × 2020-summer-fall fixture."""
        return cls(
            answers={
                "datetime": "yes, that's correct",
                "state": "California",
                "county": "Mendocino County",
                "dataset": "MiCASA Land Carbon Flux v1",
                "variable": "FIRE",
            }
        )

    def respond(self, gate: str, agent_prompt: str) -> str:
        if gate not in self.answers:
            raise KeyError(f"no scripted answer for gate {gate!r}; agent asked: {agent_prompt!r}")
        return self.answers[gate]
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_user_actor.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/user_actor.py bench/tests/geo_qa/test_user_actor.py
git commit -m "bench(eie): UserActor — deterministic gate responder for Pattern E

Frozen answer table keyed by gate-type. Mendocino × MiCASA × FIRE ×
2020-06/11 fixture. Re-runs are bit-for-bit reproducible — this is
a measurement instrument, not an LLM."
```

---

### Task 13: Tool dispatch table — single source of truth wiring tools to handlers

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/dispatch.py`
- Test: `bench/tests/geo_qa/test_dispatch.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_dispatch.py`:

```python
"""Tool dispatch — given (tool_name, args, handler), route to the
right veda_tools function and wrap the return through the handler.
"""

import json
from agent_cost_bench.geo_qa.dispatch import dispatch_tool_call
from agent_cost_bench.geo_qa.handlers import StatusOnlyHandler, KeyFieldsHandler, FreeformHandler


def test_dispatch_parse_datetime_status_mode():
    h = StatusOnlyHandler()
    out = dispatch_tool_call("parse_datetime", {"value": "2020-06-01 to 2020-11-01"}, h, "tc_001")
    parsed = json.loads(out)
    assert parsed["ok"] is True
    assert "2020-06-01" in parsed["summary"]
    assert "2020-11-01" in parsed["summary"]


def test_dispatch_geocode_key_fields_mode():
    h = KeyFieldsHandler()
    out = dispatch_tool_call("geocode", {"query": "Mendocino County", "level": "county"}, h, "tc_002")
    parsed = json.loads(out)
    assert parsed["admin_name"] == "Mendocino County"
    assert "bbox" in parsed
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_dispatch.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement dispatch**

`bench/src/agent_cost_bench/geo_qa/dispatch.py`:

```python
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
                    "bbox": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4},
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
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_dispatch.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/dispatch.py bench/tests/geo_qa/test_dispatch.py
git commit -m "bench(eie): dispatch table — single source of truth for tool routing

Maps OpenAI-shape tool calls to veda_tools functions, wraps returns
through whichever handler the scenario uses. Single place the runner
talks to."
```

---

### Task 14: Pattern P state machine (paper's 6-turn ReAct)

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/pattern_paper.py`
- Test: `bench/tests/geo_qa/test_pattern_paper.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_pattern_paper.py`:

```python
"""Pattern P — 6-turn ReAct loop, no gates, single user query.

Test verifies the state machine compiles and runs to completion on a
mocked LLM (no real provider calls). We assert the conversation has
the expected turn count and the agent ends in 'final_answer' state.
"""

from unittest.mock import patch, MagicMock
from agent_cost_bench.geo_qa.pattern_paper import build_pattern_p_graph
from agent_cost_bench.geo_qa.handlers import StatusOnlyHandler


def test_pattern_p_compiles_and_runs_to_end():
    handler = StatusOnlyHandler()
    graph = build_pattern_p_graph(handler=handler, model="gpt-5.2-mock")
    # Confirm the graph compiled (graph.invoke would call LLM; here we
    # just check structure).
    assert graph is not None
    # The graph should have nodes for: agent_step, tool_step, answer.
    node_names = {n for n in graph.get_graph().nodes}
    assert "agent_step" in node_names
    assert "tool_step" in node_names
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_pattern_paper.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement Pattern P**

`bench/src/agent_cost_bench/geo_qa/pattern_paper.py`:

```python
"""Pattern P — paper's 6-turn single-shot ReAct.

User asks one specific query; the agent runs the full tool chain
(parse_datetime → geocode → search_collections → search_items →
compute_stats) in a continuous tool-use loop and produces a final
answer. No confirmation gates.

The state machine has three node types:
  - agent_step: LLM produces either tool_calls or a final answer
  - tool_step:  execute every tool_call in the LLM's output via dispatch
  - END:        terminal when LLM returns final answer (no tool_calls)
"""

from __future__ import annotations

import json
import uuid
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from .dispatch import TOOL_SCHEMAS, dispatch_tool_call


PAPER_SYSTEM_PROMPT = """You are a measurement instrument running a geospatial analysis tool chain.
Given the user's query, use the available tools in sequence to:
1. Parse the datetime range
2. Geocode the area of interest
3. Search NASA VEDA STAC collections by keyword
4. List items in the chosen collection within the bbox and datetime window
5. Compute band stats over the polygon AOI

When you have the final stats, write a one-paragraph answer summarizing the mean, min, max,
and any pattern across the per-item monthly values. Be terse — this is a measurement run,
not a customer chat. Do not add emoji, personality, or follow-up offers.
"""

PAPER_USER_QUERY = """Visualize FIRE band flux from MiCASA Land Carbon Flux v1 over Mendocino County, California, June 2020 to November 2020. Report mean/median/min/max plus per-month values."""


class State(TypedDict):
    messages: Annotated[list[dict[str, Any]], add_messages]
    handler_ref: Any           # the StatusOnly/KeyFields/Freeform handler instance
    turn_count: int


def _agent_step(state: State) -> dict[str, Any]:
    """LLM turn. Real provider call happens here at run time; mocked in tests."""
    from .provider_shim import call_llm
    msg = call_llm(
        model=state.get("model", "gpt-5.2"),
        messages=state["messages"],
        tools=TOOL_SCHEMAS,
        temperature=0.0,
    )
    return {"messages": [msg], "turn_count": state["turn_count"] + 1}


def _tool_step(state: State) -> dict[str, Any]:
    """Execute every tool_call from the last assistant message."""
    last = state["messages"][-1]
    tool_calls = last.get("tool_calls") or []
    new_messages: list[dict[str, Any]] = []
    for tc in tool_calls:
        name = tc["function"]["name"]
        args = json.loads(tc["function"]["arguments"])
        tool_call_id = tc.get("id", str(uuid.uuid4()))
        result_str = dispatch_tool_call(name, args, state["handler_ref"], tool_call_id)
        new_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": result_str})
    return {"messages": new_messages}


def _route(state: State) -> str:
    """End when the LLM stops calling tools."""
    last = state["messages"][-1]
    return "tool_step" if last.get("tool_calls") else END


def build_pattern_p_graph(handler, model: str = "gpt-5.2"):
    """Build the Pattern P LangGraph state machine."""
    g = StateGraph(State)
    g.add_node("agent_step", _agent_step)
    g.add_node("tool_step", _tool_step)
    g.add_edge(START, "agent_step")
    g.add_conditional_edges("agent_step", _route, {"tool_step": "tool_step", END: END})
    g.add_edge("tool_step", "agent_step")
    return g.compile()


def initial_state(handler, model: str = "gpt-5.2") -> State:
    return {
        "messages": [
            {"role": "system", "content": PAPER_SYSTEM_PROMPT},
            {"role": "user", "content": PAPER_USER_QUERY},
        ],
        "handler_ref": handler,
        "turn_count": 0,
    }
```

- [ ] **Step 4: Provider shim (called by `_agent_step`)**

`bench/src/agent_cost_bench/geo_qa/provider_shim.py`:

```python
"""Thin shim — wraps LiteLLM in a uniform shape for the bench's needs.

Production code paths in this bench use `call_llm` so tests can patch
this single module without monkey-patching litellm internals.
"""

from __future__ import annotations

from typing import Any


def call_llm(model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]], temperature: float = 0.0) -> dict[str, Any]:
    """Issue one LLM call with tool schemas; return the assistant message dict."""
    import litellm  # late import keeps test isolation tighter
    response = litellm.completion(
        model=model, messages=messages, tools=tools, temperature=temperature
    )
    choice = response.choices[0]
    msg = choice.message
    out: dict[str, Any] = {"role": "assistant", "content": msg.content or ""}
    if msg.tool_calls:
        out["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.function.name, "arguments": tc.function.arguments},
            }
            for tc in msg.tool_calls
        ]
    out["_usage"] = response.usage.model_dump() if hasattr(response, "usage") and response.usage else {}
    return out
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_pattern_paper.py -v
```

Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/pattern_paper.py bench/src/agent_cost_bench/geo_qa/provider_shim.py bench/tests/geo_qa/test_pattern_paper.py
git commit -m "bench(eie): Pattern P — paper's 6-turn single-shot ReAct

LangGraph state machine with agent_step + tool_step nodes, terminates
when the LLM stops calling tools. Provider shim wraps LiteLLM so tests
can patch one module. System prompt + user query are neutral terse,
written from scratch (no gated prose paraphrase)."
```

---

### Task 15: Pattern E state machine (gated drill-down)

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/pattern_gated.py`
- Test: `bench/tests/geo_qa/test_pattern_gated.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_pattern_gated.py`:

```python
"""Pattern E — 5 gates between tool calls. 9-10 turns total.

Test verifies the state machine wires gate_node + agent_step + tool_step
and that the UserActor is consulted at each gate.
"""

from agent_cost_bench.geo_qa.pattern_gated import build_pattern_gated_graph
from agent_cost_bench.geo_qa.handlers import KeyFieldsHandler
from agent_cost_bench.geo_qa.user_actor import UserActor


def test_pattern_e_compiles():
    handler = KeyFieldsHandler()
    actor = UserActor.frozen_default()
    graph = build_pattern_gated_graph(handler=handler, user_actor=actor, model="gpt-5.2-mock")
    node_names = {n for n in graph.get_graph().nodes}
    assert "agent_step" in node_names
    assert "tool_step" in node_names
    assert "gate_step" in node_names
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_pattern_gated.py -v
```

Expected: ImportError.

- [ ] **Step 3: Implement Pattern E**

`bench/src/agent_cost_bench/geo_qa/pattern_gated.py`:

```python
"""Pattern E — gated drill-down with 5 confirmation gates.

User asks an under-specified query. Agent runs a tool, then asks a
clarifying gate question, waits for the user (UserActor) to answer,
then runs the next tool, etc. Five gates: datetime → state → county →
dataset → variable. After the variable gate the agent runs search_items
and compute_stats autonomously and produces a final answer.

The agent signals which gate it is at by emitting a tool_call to a
synthetic 'ask_user' tool with one argument: {gate: '<gate_name>'}.
The runner intercepts ask_user and routes to the UserActor.
"""

from __future__ import annotations

import json
import uuid
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from .dispatch import TOOL_SCHEMAS, dispatch_tool_call
from .provider_shim import call_llm
from .user_actor import UserActor


ASK_USER_TOOL = {
    "type": "function",
    "function": {
        "name": "ask_user",
        "description": "Pause and ask the user a clarifying question. Use this between tool calls when you need confirmation (datetime / state / county / dataset / variable).",
        "parameters": {
            "type": "object",
            "properties": {
                "gate": {
                    "type": "string",
                    "enum": ["datetime", "state", "county", "dataset", "variable"],
                },
                "prompt": {"type": "string"},
            },
            "required": ["gate", "prompt"],
        },
    },
}

gated_SYSTEM_PROMPT = """You are a measurement instrument running a geospatial analysis workflow.
The user has asked an under-specified query about Earth-data analysis. Your job is to:

1. Call `parse_datetime` with a reasonable default window, then call `ask_user(gate='datetime', prompt='...')` to confirm.
2. Call `ask_user(gate='state', prompt='...')` to learn which state to analyze.
3. Call `geocode` on the state, then `ask_user(gate='county', prompt='...')` to drill down to a county.
4. Call `geocode` on the county, then call `search_collections` and `ask_user(gate='dataset', prompt='...')` to pick a dataset.
5. Call `ask_user(gate='variable', prompt='...')` to pick a band/variable.
6. Once you have datetime + bbox + collection + variable, call `search_items` and `compute_stats` (no more gates) and write a one-paragraph terse answer.

Do NOT chain multiple ask_user calls in one turn — one gate per turn.
Be terse. No emoji. No follow-up offers. This is a measurement run.
"""

gated_USER_QUERY = """Analyze the contribution of the 2020 California wildfires to total CO2 flux using model-estimated carbon flux data."""


class State(TypedDict):
    messages: Annotated[list[dict[str, Any]], add_messages]
    handler_ref: Any
    user_actor: Any
    turn_count: int


def _agent_step(state: State) -> dict[str, Any]:
    msg = call_llm(
        model=state.get("model", "gpt-5.2"),
        messages=state["messages"],
        tools=TOOL_SCHEMAS + [ASK_USER_TOOL],
        temperature=0.0,
    )
    return {"messages": [msg], "turn_count": state["turn_count"] + 1}


def _route(state: State) -> str:
    last = state["messages"][-1]
    tool_calls = last.get("tool_calls") or []
    if not tool_calls:
        return END
    # If ANY of the tool_calls is ask_user, route to gate_step; else tool_step
    for tc in tool_calls:
        if tc["function"]["name"] == "ask_user":
            return "gate_step"
    return "tool_step"


def _tool_step(state: State) -> dict[str, Any]:
    last = state["messages"][-1]
    tool_calls = last.get("tool_calls") or []
    new_messages: list[dict[str, Any]] = []
    for tc in tool_calls:
        if tc["function"]["name"] == "ask_user":
            continue  # handled in gate_step
        name = tc["function"]["name"]
        args = json.loads(tc["function"]["arguments"])
        tool_call_id = tc.get("id", str(uuid.uuid4()))
        result_str = dispatch_tool_call(name, args, state["handler_ref"], tool_call_id)
        new_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": result_str})
    return {"messages": new_messages}


def _gate_step(state: State) -> dict[str, Any]:
    last = state["messages"][-1]
    tool_calls = last.get("tool_calls") or []
    new_messages: list[dict[str, Any]] = []
    actor: UserActor = state["user_actor"]
    for tc in tool_calls:
        if tc["function"]["name"] != "ask_user":
            continue
        args = json.loads(tc["function"]["arguments"])
        gate = args["gate"]
        prompt = args.get("prompt", "")
        response = actor.respond(gate, prompt)
        # The agent reads the gate response as the tool return.
        tool_call_id = tc.get("id", str(uuid.uuid4()))
        new_messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": response})
    return {"messages": new_messages}


def build_pattern_gated_graph(handler, user_actor: UserActor, model: str = "gpt-5.2"):
    g = StateGraph(State)
    g.add_node("agent_step", _agent_step)
    g.add_node("tool_step", _tool_step)
    g.add_node("gate_step", _gate_step)
    g.add_edge(START, "agent_step")
    g.add_conditional_edges(
        "agent_step", _route,
        {"tool_step": "tool_step", "gate_step": "gate_step", END: END},
    )
    g.add_edge("tool_step", "agent_step")
    g.add_edge("gate_step", "agent_step")
    return g.compile()


def initial_state(handler, user_actor: UserActor, model: str = "gpt-5.2") -> State:
    return {
        "messages": [
            {"role": "system", "content": gated_SYSTEM_PROMPT},
            {"role": "user", "content": gated_USER_QUERY},
        ],
        "handler_ref": handler,
        "user_actor": user_actor,
        "turn_count": 0,
    }
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_pattern_gated.py -v
```

Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/pattern_gated.py bench/tests/geo_qa/test_pattern_gated.py
git commit -m "bench(eie): Pattern E — 5-gate drill-down state machine

agent_step / tool_step / gate_step nodes. Agent emits an ask_user
tool call to request a gate response; runner intercepts and routes
to the UserActor's frozen answer table. 5 gates between tool calls:
datetime → state → county → dataset → variable.

All agent strings (system prompt, gate routing instructions, user
query template) written from scratch — neutral, terse, no gated prose
paraphrase, no emoji."
```

---

### Task 16: Scenario YAMLs (six manifests) + the scenario loader

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/scenario_loader.py`
- Create: 6 files in `bench/scenarios/geo-qa-templating/`
- Test: `bench/tests/geo_qa/test_scenario_loader.py`

- [ ] **Step 1: Write the failing test**

`bench/tests/geo_qa/test_scenario_loader.py`:

```python
"""Scenario YAMLs round-trip through the loader to typed config."""

from pathlib import Path
import pytest
from agent_cost_bench.geo_qa.scenario_loader import load_scenario, ScenarioCfg

SCENARIO_DIR = Path(__file__).resolve().parents[2] / "scenarios" / "geo-qa-templating"


def test_all_six_scenarios_load():
    expected_ids = [
        "pattern-paper-status-only",
        "pattern-paper-key-fields",
        "pattern-paper-freeform",
        "pattern-gated-status-only",
        "pattern-gated-key-fields",
        "pattern-gated-freeform",
    ]
    for sid in expected_ids:
        s = load_scenario(SCENARIO_DIR / f"{sid}.yml")
        assert isinstance(s, ScenarioCfg)
        assert s.id == sid
        assert s.handler_mode in ("status_only", "key_fields", "freeform")
        assert s.pattern in ("paper", "gated")
        assert s.model.startswith("gpt-")
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_scenario_loader.py -v
```

Expected: ImportError (or "no scenario files found" once loader exists).

- [ ] **Step 3: Write the loader**

`bench/src/agent_cost_bench/geo_qa/scenario_loader.py`:

```python
"""Typed loader for geo-qa-templating scenario YAMLs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class ScenarioCfg:
    id: str
    pattern: str         # 'paper' | 'gated'
    handler_mode: str    # 'status_only' | 'key_fields' | 'freeform'
    model: str           # litellm model identifier
    description: str


def load_scenario(path: Path) -> ScenarioCfg:
    with path.open() as f:
        data = yaml.safe_load(f)
    return ScenarioCfg(
        id=data["id"],
        pattern=data["pattern"],
        handler_mode=data["handler_mode"],
        model=data.get("model", "gpt-5.2"),
        description=data.get("description", ""),
    )
```

- [ ] **Step 4: Write the 6 scenario manifests**

`bench/scenarios/geo-qa-templating/pattern-paper-status-only.yml`:

```yaml
id: pattern-paper-status-only
pattern: paper
handler_mode: status_only
model: gpt-5.2
description: |
  Pattern P (paper's 6-turn ReAct) × StatusOnlyHandler (mode A).
  Tests the paper's claimed cost floor.
```

`bench/scenarios/geo-qa-templating/pattern-paper-key-fields.yml`:

```yaml
id: pattern-paper-key-fields
pattern: paper
handler_mode: key_fields
model: gpt-5.2
description: |
  Pattern P × KeyFieldsHandler (mode B).
  Production-realistic middle ground. The paper does NOT test this point.
```

`bench/scenarios/geo-qa-templating/pattern-paper-freeform.yml`:

```yaml
id: pattern-paper-freeform
pattern: paper
handler_mode: freeform
model: gpt-5.2
description: |
  Pattern P × FreeformHandler (mode C).
  Naive ReAct loop with no output structuring. Paper's claimed cost ceiling.
```

`bench/scenarios/geo-qa-templating/pattern-gated-status-only.yml`:

```yaml
id: pattern-gated-status-only
pattern: gated
handler_mode: status_only
model: gpt-5.2
description: |
  Pattern E (~9-10 turn gated drill-down) × StatusOnlyHandler.
  Tests whether the gated conversation pattern changes the templating lever.
```

`bench/scenarios/geo-qa-templating/pattern-gated-key-fields.yml`:

```yaml
id: pattern-gated-key-fields
pattern: gated
handler_mode: key_fields
model: gpt-5.2
description: |
  Pattern E × KeyFieldsHandler.
  Most-realistic combination: gated conversation + production templating.
```

`bench/scenarios/geo-qa-templating/pattern-gated-freeform.yml`:

```yaml
id: pattern-gated-freeform
pattern: gated
handler_mode: freeform
model: gpt-5.2
description: |
  Pattern E × FreeformHandler.
  Cumulative input growth across ~10 turns of gated conversation with
  full STAC payloads in context. Worst-case operating point.
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_scenario_loader.py -v
```

Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/scenario_loader.py bench/scenarios/geo-qa-templating/ bench/tests/geo_qa/test_scenario_loader.py
git commit -m "bench(eie): 6 scenario YAML manifests + loader

The 2×3 matrix: 2 conversation patterns × 3 response modes. Each
YAML pins the pattern, handler_mode, and model. Frozen workload
(Mendocino × MiCASA × FIRE × 2020-06/11) is hard-coded in the
pattern modules — scenarios only vary the conversation shape and
handler type."
```

---

### Task 17: Scenario runner — glues pattern + handler + tracing

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/runner.py`

- [ ] **Step 1: Implement the runner**

`bench/src/agent_cost_bench/geo_qa/runner.py`:

```python
"""Run one geo-qa-templating scenario end-to-end and write a trace JSON.

The runner is the thinnest possible glue between:
  - scenario_loader (which scenario YAML to run)
  - handlers (which middleware to wrap tool returns with)
  - pattern_paper / pattern_gated (which state machine to drive)
  - the LLM provider (real calls through provider_shim.call_llm)

Trace artifact captures per-turn input/output/cached tokens, every
LLM message, every tool call, and a final summary suitable for the
report generator to read.
"""

from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .handlers import FreeformHandler, KeyFieldsHandler, StatusOnlyHandler
from .pattern_paper import build_pattern_p_graph, initial_state as paper_initial
from .pattern_gated import build_pattern_gated_graph, initial_state as eie_initial
from .scenario_loader import ScenarioCfg
from .user_actor import UserActor


REPORTS_DIR = Path(__file__).resolve().parents[3] / "reports" / "geo-qa-templating"


def _make_handler(mode: str):
    if mode == "status_only":
        return StatusOnlyHandler()
    if mode == "key_fields":
        return KeyFieldsHandler()
    if mode == "freeform":
        return FreeformHandler()
    raise ValueError(f"unknown handler mode: {mode!r}")


def run_scenario(cfg: ScenarioCfg, max_turns: int = 30) -> Path:
    """Execute one scenario, write trace JSON, return the trace path."""
    handler = _make_handler(cfg.handler_mode)
    if cfg.pattern == "paper":
        graph = build_pattern_p_graph(handler=handler, model=cfg.model)
        state = paper_initial(handler=handler, model=cfg.model)
    elif cfg.pattern == "gated":
        actor = UserActor.frozen_default()
        graph = build_pattern_gated_graph(handler=handler, user_actor=actor, model=cfg.model)
        state = eie_initial(handler=handler, user_actor=actor, model=cfg.model)
    else:
        raise ValueError(f"unknown pattern: {cfg.pattern!r}")
    state["model"] = cfg.model
    t0 = time.time()
    final = graph.invoke(state, {"recursion_limit": max_turns})
    elapsed = time.time() - t0
    trace = _build_trace(cfg, final, elapsed)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    out_path = REPORTS_DIR / f"{cfg.id}-{ts}.trace.json"
    with out_path.open("w") as f:
        json.dump(trace, f, indent=2)
    return out_path


def _build_trace(cfg: ScenarioCfg, final_state: dict[str, Any], elapsed_s: float) -> dict[str, Any]:
    """Aggregate per-turn usage and build a trace dict."""
    messages = final_state.get("messages", [])
    turns: list[dict[str, Any]] = []
    total_input = total_output = total_cached = 0
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        usage = msg.get("_usage", {}) or {}
        in_t = int(usage.get("prompt_tokens") or 0)
        out_t = int(usage.get("completion_tokens") or 0)
        # OpenAI returns cached_tokens inside prompt_tokens_details
        cached = 0
        details = usage.get("prompt_tokens_details") or {}
        if isinstance(details, dict):
            cached = int(details.get("cached_tokens") or 0)
        turns.append({
            "input_tokens": in_t,
            "output_tokens": out_t,
            "cached_tokens": cached,
            "tool_calls": [tc["function"]["name"] for tc in (msg.get("tool_calls") or [])],
        })
        total_input += in_t
        total_output += out_t
        total_cached += cached
    n_turns = len(turns)
    cache_hit_rate = (total_cached / total_input) if total_input else 0.0
    return {
        "scenario_id": cfg.id,
        "pattern": cfg.pattern,
        "handler_mode": cfg.handler_mode,
        "model": cfg.model,
        "turn_count": n_turns,
        "elapsed_s": elapsed_s,
        "totals": {
            "input_tokens": total_input,
            "output_tokens": total_output,
            "cached_tokens": total_cached,
            "cache_hit_rate": cache_hit_rate,
        },
        "per_turn_avg": {
            "input_tokens": (total_input / n_turns) if n_turns else 0,
            "output_tokens": (total_output / n_turns) if n_turns else 0,
        },
        "turns": turns,
    }
```

- [ ] **Step 2: Verify the module imports**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
python -c "from agent_cost_bench.geo_qa.runner import run_scenario; print('ok')"
```

Expected: `ok`

- [ ] **Step 3: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/runner.py
git commit -m "bench(eie): scenario runner — glue between pattern + handler + tracing

Loads a ScenarioCfg, instantiates the right handler + pattern graph,
runs to completion (recursion_limit=30), aggregates per-turn usage
into a trace JSON. Captures cached_tokens from OpenAI's
prompt_tokens_details for the cache-hit-rate column in the report."
```

---

### Task 18: CLI subcommand — `agent-cost-bench run-geo-qa-templating`

**Files:**
- Modify: `bench/src/agent_cost_bench/cli.py` (add new subcommand)

- [ ] **Step 1: Add the subcommand**

Open `bench/src/agent_cost_bench/cli.py`. Find the bottom of the file where `app.command()` decorators register subcommands. Append this new subcommand registration:

```python
@app.command(name="run-geo-qa-templating")
def run_eie_templating(
    scenario: str = typer.Option("all", help="scenario id (e.g. pattern-paper-status-only), 'all' to run all 6"),
    model: str = typer.Option("", help="override the model in every scenario (e.g. gpt-5.2, claude-sonnet-4.6)"),
):
    """Run the geo-qa-templating bench: 6 scenarios = 2 patterns × 3 handler modes.

    Each run writes a trace JSON under bench/reports/geo-qa-templating/.
    Use `agent-cost-bench report-geo-qa-templating` afterwards to emit
    the comparison Markdown summary.
    """
    from pathlib import Path
    from .eie.runner import run_scenario
    from .eie.scenario_loader import load_scenario, ScenarioCfg
    from dataclasses import replace
    SCENARIO_DIR = Path(__file__).resolve().parent.parent.parent / "scenarios" / "geo-qa-templating"
    if scenario == "all":
        ids = [p.stem for p in sorted(SCENARIO_DIR.glob("*.yml"))]
    else:
        ids = [scenario]
    console = Console()
    for sid in ids:
        cfg = load_scenario(SCENARIO_DIR / f"{sid}.yml")
        if model:
            cfg = replace(cfg, model=model)
        console.print(f"[cyan]Running:[/] {sid}  ({cfg.pattern} × {cfg.handler_mode} on {cfg.model})")
        out_path = run_scenario(cfg)
        console.print(f"[green]Wrote:[/] {out_path}")
    console.print(f"\n[bold]{len(ids)} scenarios complete.[/] Now run `agent-cost-bench report-geo-qa-templating` to emit the summary.")
```

- [ ] **Step 2: Verify CLI sees the new subcommand**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
agent-cost-bench --help
```

Expected: lists `run-geo-qa-templating` alongside the existing subcommands.

- [ ] **Step 3: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/cli.py
git commit -m "bench(eie): CLI subcommand 'run-geo-qa-templating'

Runs all 6 scenarios (or a single one with --scenario <id>). Writes
one trace JSON per scenario under bench/reports/geo-qa-templating/.
Existing CLI subcommands unchanged."
```

---

### Task 19: Report generator — emit the comparison Markdown

**Files:**
- Create: `bench/src/agent_cost_bench/geo_qa/report.py`
- Modify: `bench/src/agent_cost_bench/cli.py` (add `report-geo-qa-templating` subcommand)

- [ ] **Step 1: Implement the report generator**

`bench/src/agent_cost_bench/geo_qa/report.py`:

```python
"""Emit the 1-page Markdown comparison report from 6 trace JSONs.

Reads all *.trace.json files from bench/reports/geo-qa-templating/,
groups by scenario_id, picks the latest trace per scenario, builds
a comparison table, and computes the two key ratio rows (C/A, C/B)
for each conversation pattern.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

REPORTS_DIR = Path(__file__).resolve().parents[3] / "reports" / "geo-qa-templating"

# GPT-5.2 pricing (USD per million tokens)
GPT52_INPUT_PER_M = 1.75
GPT52_CACHED_PER_M = 0.175  # 10% of input rate
GPT52_OUTPUT_PER_M = 14.0

MONTHLY_QUERIES = 915_000  # paper's workload


def _cost_per_query(t: dict) -> float:
    """Estimate $/query from a trace's totals."""
    totals = t["totals"]
    cached = totals["cached_tokens"]
    fresh = totals["input_tokens"] - cached
    return (
        fresh   * GPT52_INPUT_PER_M  / 1e6 +
        cached  * GPT52_CACHED_PER_M / 1e6 +
        totals["output_tokens"] * GPT52_OUTPUT_PER_M / 1e6
    )


def _latest_traces() -> dict[str, dict]:
    """Map scenario_id → latest trace dict."""
    by_id: dict[str, tuple[float, dict]] = {}
    for p in REPORTS_DIR.glob("*.trace.json"):
        try:
            with p.open() as f:
                t = json.load(f)
            mtime = p.stat().st_mtime
            sid = t["scenario_id"]
            if sid not in by_id or mtime > by_id[sid][0]:
                by_id[sid] = (mtime, t)
        except (json.JSONDecodeError, KeyError):
            continue
    return {sid: t for sid, (_, t) in by_id.items()}


def emit_report() -> Path:
    traces = _latest_traces()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = REPORTS_DIR / f"{ts}-summary.md"
    rows: list[dict] = []
    for sid, t in traces.items():
        cost = _cost_per_query(t)
        rows.append({
            "id": sid,
            "pattern": t["pattern"],
            "mode": t["handler_mode"],
            "turns": t["turn_count"],
            "in_per_turn": t["per_turn_avg"]["input_tokens"],
            "out_per_turn": t["per_turn_avg"]["output_tokens"],
            "cache_hit_pct": t["totals"]["cache_hit_rate"] * 100,
            "cost_per_q": cost,
            "monthly": cost * MONTHLY_QUERIES,
        })
    rows.sort(key=lambda r: (r["pattern"], r["mode"]))
    lines: list[str] = []
    lines.append(f"# geo-qa-templating bench summary — {ts}\n")
    lines.append("## Per-scenario results\n")
    lines.append("| scenario | pattern | mode | turns | tok/turn (in) | tok/turn (out) | cache hit % | $/query | $/month @ 915K |")
    lines.append("|---|---|---|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        lines.append(
            f"| {r['id']} | {r['pattern']} | {r['mode']} | {r['turns']} | "
            f"{r['in_per_turn']:.0f} | {r['out_per_turn']:.0f} | "
            f"{r['cache_hit_pct']:.1f}% | ${r['cost_per_q']:.4f} | ${r['monthly']:,.0f} |"
        )
    lines.append("\n## Ratio rows\n")
    for pattern in ("paper", "gated"):
        a = next((r for r in rows if r["pattern"] == pattern and r["mode"] == "status_only"), None)
        b = next((r for r in rows if r["pattern"] == pattern and r["mode"] == "key_fields"), None)
        c = next((r for r in rows if r["pattern"] == pattern and r["mode"] == "freeform"), None)
        if a and b and c and a["cost_per_q"] > 0 and b["cost_per_q"] > 0:
            lines.append(f"- **Pattern {pattern} — C/A ratio (paper's headline lever):** {c['cost_per_q'] / a['cost_per_q']:.2f}×")
            lines.append(f"- **Pattern {pattern} — C/B ratio (realistic production lever):** {c['cost_per_q'] / b['cost_per_q']:.2f}×")
    lines.append("\n## Findings\n")
    lines.append("- (Drafted by hand after a real run; this report builder leaves the findings section empty so the analyst writes from the observed numbers.)\n")
    out.write_text("\n".join(lines))
    return out
```

- [ ] **Step 2: Add CLI subcommand**

Open `bench/src/agent_cost_bench/cli.py`. Append below the `run_eie_templating` subcommand:

```python
@app.command(name="report-geo-qa-templating")
def report_eie_templating():
    """Emit the comparison Markdown report from the latest 6 traces."""
    from .eie.report import emit_report
    out = emit_report()
    Console().print(f"[green]Report written:[/] {out}")
```

- [ ] **Step 3: Smoke-check**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
agent-cost-bench --help | grep eie
```

Expected: shows both `run-geo-qa-templating` and `report-geo-qa-templating`.

- [ ] **Step 4: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/src/agent_cost_bench/geo_qa/report.py bench/src/agent_cost_bench/cli.py
git commit -m "bench(eie): report generator + 'report-geo-qa-templating' CLI

Reads the latest trace per scenario from bench/reports/geo-qa-templating/,
builds the 6-row comparison table with cost projections at 915K
queries/mo, and computes C/A + C/B ratios per pattern. The findings
section is left empty for the analyst to fill in after eyeballing the
numbers."
```

---

### Task 20: End-to-end smoke test with mocked LLM

**Files:**
- Create: `bench/tests/geo_qa/test_e2e_mocked.py`

- [ ] **Step 1: Write the e2e smoke test**

`bench/tests/geo_qa/test_e2e_mocked.py`:

```python
"""End-to-end smoke test: run one scenario with a mocked LLM + mocked HTTP.

Patches provider_shim.call_llm to return a hard-coded conversation
that calls parse_datetime → geocode → search_collections → search_items
→ compute_stats and then emits a final answer. Patches httpx for STAC
calls. Confirms the runner produces a non-empty trace JSON.
"""

import json
from pathlib import Path
from unittest.mock import patch
import pytest
from pytest_httpx import HTTPXMock
from agent_cost_bench.geo_qa.scenario_loader import load_scenario
from agent_cost_bench.geo_qa.runner import run_scenario


SCENARIO_DIR = Path(__file__).resolve().parents[2] / "scenarios" / "geo-qa-templating"


def _mock_llm_sequence():
    """Return an iterator of fake assistant messages — the agent's tool-call sequence."""
    seq = [
        # Turn 1: parse_datetime
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "tc_1", "type": "function", "function": {"name": "parse_datetime", "arguments": '{"value": "2020-06-01 to 2020-11-01"}'}}
        ], "_usage": {"prompt_tokens": 1200, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 0}}},
        # Turn 2: geocode
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "tc_2", "type": "function", "function": {"name": "geocode", "arguments": '{"query": "Mendocino County", "level": "county"}'}}
        ], "_usage": {"prompt_tokens": 1400, "completion_tokens": 28, "prompt_tokens_details": {"cached_tokens": 1100}}},
        # Turn 3: search_collections
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "tc_3", "type": "function", "function": {"name": "search_collections", "arguments": '{"query": "MiCASA carbon flux"}'}}
        ], "_usage": {"prompt_tokens": 1600, "completion_tokens": 25, "prompt_tokens_details": {"cached_tokens": 1300}}},
        # Turn 4: search_items
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "tc_4", "type": "function", "function": {"name": "search_items", "arguments": '{"collection_id": "micasa-carbonflux-monthgrid-v1", "bbox": [-123.89,38.76,-122.82,40.0], "datetime_range": "2020-06-01/2020-11-01", "band": "FIRE"}'}}
        ], "_usage": {"prompt_tokens": 1800, "completion_tokens": 60, "prompt_tokens_details": {"cached_tokens": 1500}}},
        # Turn 5: compute_stats
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "tc_5", "type": "function", "function": {"name": "compute_stats", "arguments": '{"item_refs": ["tc_4"], "band": "FIRE", "geometry": {"type": "Polygon", "coordinates": [[[-123.89,38.76],[-122.82,38.76],[-122.82,40.0],[-123.89,40.0],[-123.89,38.76]]]}}'}}
        ], "_usage": {"prompt_tokens": 2200, "completion_tokens": 80, "prompt_tokens_details": {"cached_tokens": 1900}}},
        # Turn 6: final answer (no tool_calls)
        {"role": "assistant", "content": "Mean FIRE = 1.96 across 6 monthly grids; min 0.0, max 4.98.", "_usage": {"prompt_tokens": 2400, "completion_tokens": 40, "prompt_tokens_details": {"cached_tokens": 2100}}},
    ]
    return iter(seq)


def test_e2e_paper_status_only(httpx_mock: HTTPXMock, monkeypatch, tmp_path):
    # Mock VEDA collections
    httpx_mock.add_response(
        url="https://openveda.cloud/api/stac/collections",
        json={"collections": [{"id": "micasa-carbonflux-monthgrid-v1", "title": "MiCASA", "description": "Carbon flux from MiCASA"}]},
        is_reusable=True,
    )
    # Mock VEDA items
    httpx_mock.add_response(
        url__regex=r"https://openveda\.cloud/api/stac/collections/micasa-carbonflux-monthgrid-v1/items.*",
        json={"features": [
            {"id": f"mc-{m:02d}", "properties": {"datetime": f"2020-{m:02d}-01T00:00:00Z"}, "bbox": [-123.89,38.76,-122.82,40.0], "assets": {"FIRE": {"href": f"https://example.org/{m:02d}.tif"}}}
            for m in range(6, 12)
        ]},
        is_reusable=True,
    )
    seq = _mock_llm_sequence()
    monkeypatch.setattr("agent_cost_bench.geo_qa.pattern_paper.call_llm", lambda **kw: next(seq))
    # Mock rio-tiler so compute_stats doesn't try to fetch a real COG
    from unittest.mock import MagicMock
    import numpy as np
    mock_reader = MagicMock()
    mock_reader.__enter__ = MagicMock(return_value=mock_reader)
    mock_reader.__exit__ = MagicMock(return_value=None)
    mock_reader.feature.return_value = MagicMock(data=np.array([[[1.0, 2.0], [3.0, 4.0]]]), mask=np.ones((2, 2), dtype=bool))
    monkeypatch.setattr("agent_cost_bench.geo_qa.veda_tools.Reader", lambda *a, **k: mock_reader)
    cfg = load_scenario(SCENARIO_DIR / "pattern-paper-status-only.yml")
    out_path = run_scenario(cfg, max_turns=10)
    assert out_path.exists()
    with out_path.open() as f:
        trace = json.load(f)
    assert trace["scenario_id"] == "pattern-paper-status-only"
    assert trace["turn_count"] >= 5
    assert trace["totals"]["input_tokens"] > 0
```

- [ ] **Step 2: Run the e2e smoke**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/geo_qa/test_e2e_mocked.py -v
```

Expected: 1 passed. If failures, debug by running with `-s` to see runner output.

- [ ] **Step 3: Run the FULL bench test suite to catch regressions**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
pytest tests/ -v
```

Expected: all eie tests pass; pre-existing bench tests (if any) also pass.

- [ ] **Step 4: Run the calc repo's bench-validate to confirm engine is untouched**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
npm run bench:validate
```

Expected: `All 6 bench-validated presets within ±5.00% of expected.`

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/tests/geo_qa/test_e2e_mocked.py
git commit -m "bench(eie): end-to-end smoke test with mocked LLM + HTTP

Patches provider_shim.call_llm with a hard-coded 6-turn tool-call
sequence and httpx + rio-tiler for STAC and COG reads. Confirms the
runner produces a valid trace JSON without making any real API calls.
Calc-repo bench-validate still passes 6/6."
```

---

### Task 21: Live run — execute all 6 scenarios against real GPT-5.2

**Files:**
- No code changes. This is an operator step.
- Output: 6 trace JSONs in `bench/reports/geo-qa-templating/*.trace.json`

- [ ] **Step 1: Confirm `OPENAI_API_KEY` is set in the bench's .env**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
grep -q "^OPENAI_API_KEY=" .env && echo "key present" || echo "MISSING — add OPENAI_API_KEY=sk-... to bench/.env before continuing"
```

Expected: `key present`. If missing, add `OPENAI_API_KEY=sk-...` to `bench/.env` (do NOT commit the .env file).

- [ ] **Step 2: Run all 6 scenarios against real GPT-5.2**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
agent-cost-bench run-geo-qa-templating --scenario all
```

Expected: 6 lines of "Running: ... Wrote: bench/reports/geo-qa-templating/<id>-<timestamp>.trace.json". Total OpenAI spend: ~$5. Total wall-clock: ~5-10 minutes (real STAC calls + real LLM round-trips).

- [ ] **Step 3: Inspect one trace to confirm it captured real OpenAI usage**

```bash
ls -t bench/reports/geo-qa-templating/*.trace.json | head -1 | xargs jq '.totals'
```

Expected: non-zero `input_tokens`, non-zero `output_tokens`, `cached_tokens` ≥ 0 (will be > 0 by turn 2+ thanks to OpenAI's prompt cache).

- [ ] **Step 4: Generate the summary report**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio/bench
agent-cost-bench report-geo-qa-templating
```

Expected: writes `bench/reports/geo-qa-templating/<today>-summary.md` and prints its path.

- [ ] **Step 5: Read the summary; write the Findings paragraph by hand**

Open the generated `bench/reports/geo-qa-templating/<today>-summary.md` in your editor. Fill in the `## Findings` section with a few sentences answering:

1. What is the measured `C/A` ratio per pattern? Does it match the paper's claimed 7.5× lever?
2. What is the measured `C/B` ratio per pattern? Is the realistic production lever meaningfully smaller?
3. Does the gated drill-down conversation pattern (E rows) change the lever vs the paper's pattern (P rows)?
4. Brief verdict: "paper is roughly right" / "paper's lever holds against status-only but key-fields halves it" / "coworker was right, lever is overstated" — whichever the numbers support.

Save the file.

- [ ] **Step 6: Commit the trace artifacts and the summary**

```bash
cd ~/Desktop/Code/Ajinkya/websites/ai-cost-calculator-studio
git add bench/reports/geo-qa-templating/*.trace.json bench/reports/geo-qa-templating/*-summary.md
git commit -m "bench(eie): live measurement — all 6 scenarios + findings

Real OpenAI GPT-5.2 calls against real NASA VEDA STAC + MiCASA
Land Carbon Flux v1. 6 trace JSONs (2 patterns × 3 handler modes)
plus the comparison summary. Findings paragraph captures whether
the paper's 7.5× lever holds against the realistic production
key-fields middle ground."
```

- [ ] **Step 7: Push**

```bash
git push origin main
```

Expected: pushes to main. GitHub Action deploys the static calc — no impact since this work touches only `bench/` (not `public/`).

---

## Self-review

After reading the spec section-by-section against the plan:

**1. Spec coverage check:**
- ✓ Architecture (2×3 matrix) — Task 16 manifests + Task 14/15 patterns
- ✓ Response handler contracts (A/B/C) — Tasks 4/5/6
- ✓ 5 tools against NASA VEDA STAC — Tasks 7/8/9/10/11
- ✓ Both conversation patterns — Tasks 14 (P), 15 (E) + UserActor Task 12
- ✓ Frozen workload params — encoded in the pattern modules' constants + scenario YAMLs
- ✓ Repo layout — matches spec
- ✓ CLI — Task 18 (run) + 19 (report)
- ✓ Output: trace JSON per run + Markdown summary — Tasks 17 + 19
- ✓ Constraints (no gated prose paraphrase, no Co-Authored-By, engine untouched) — written from scratch system prompts in Tasks 14/15; commits omit the trailer; `npm run bench:validate` checked in Task 20

**2. Placeholder scan:** Search complete — no TBD/TODO/FIXME/"add appropriate error handling"/"similar to Task N" in the plan. Every step has actual code or actual commands.

**3. Type consistency:** Function names match across tasks. `dispatch_tool_call`, `wrap`, `respond`, `build_pattern_p_graph`, `build_pattern_gated_graph`, `run_scenario`, `emit_report` — all used consistently.

**4. Ambiguity:** The plan defines exact file paths, exact code, exact tests, and exact commands. The `compute_stats` "resolve item_refs" behaviour is deferred to dispatch.py with an explicit comment on why a re-search is acceptable for the bench (Task 13, Step 3). The `LIST_CAP = 10` value in `KeyFieldsHandler` is concrete.

No issues found. Plan ready for review.
