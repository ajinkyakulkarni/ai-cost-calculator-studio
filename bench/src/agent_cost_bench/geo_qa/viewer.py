"""Static HTML viewer for the geo-qa-templating bench traces.

Decoupled from the cost-measuring path — reads traces, bakes data into a
self-contained HTML file (Leaflet via CDN), no server required.

Usage::

    from agent_cost_bench.geo_qa.viewer import build_viewer

    html_path = build_viewer()
    # Open bench/reports/geo-qa-templating/geo-qa-templating-viewer.html in a browser
"""

from __future__ import annotations

import json
from pathlib import Path

from .report import (
    GPT52_INPUT_PER_M,
    GPT52_CACHED_PER_M,
    GPT52_OUTPUT_PER_M,
)

# REPORTS_DIR is defined here so tests can patch viewer.REPORTS_DIR without
# affecting report.REPORTS_DIR.  The two share the same default value.
REPORTS_DIR = Path(__file__).resolve().parents[3] / "reports" / "geo-qa-templating"

VIEWER_FILENAME = "geo-qa-templating-viewer.html"


def _latest_traces() -> dict[tuple[str, bool, bool], dict]:
    """Map (scenario_id, enforce_compute_stats, emit_map) → latest trace dict.

    Uses viewer.REPORTS_DIR so tests can patch it without touching report.py.
    """
    import json as _json
    by_key: dict[tuple[str, bool, bool], tuple[float, dict]] = {}
    for p in REPORTS_DIR.glob("*.trace.json"):
        try:
            with p.open() as f:
                t = _json.load(f)
            mtime = p.stat().st_mtime
            sid = t["scenario_id"]
            forced = bool(t.get("enforce_compute_stats", False))
            with_map = bool(t.get("emit_map", False))
            key = (sid, forced, with_map)
            if key not in by_key or mtime > by_key[key][0]:
                by_key[key] = (mtime, t)
        except (json.JSONDecodeError, KeyError, ValueError):
            continue
    return {key: t for key, (_, t) in by_key.items()}

# Mendocino County AOI — (minx, miny, maxx, maxy) WGS-84
_AOI_BBOX = (-123.89, 38.756, -122.819, 40.005)
# Leaflet bounds: [[miny, minx], [maxy, maxx]]
_LEAFLET_BOUNDS = [[_AOI_BBOX[1], _AOI_BBOX[0]], [_AOI_BBOX[3], _AOI_BBOX[2]]]
_MAP_CENTER = [(_AOI_BBOX[1] + _AOI_BBOX[3]) / 2, (_AOI_BBOX[0] + _AOI_BBOX[2]) / 2]


def _cost_per_turn(turn: dict) -> float:
    """Compute per-turn cost using the same rates as report._cost_per_query."""
    in_t = turn.get("input_tokens", 0)
    out_t = turn.get("output_tokens", 0)
    cached = turn.get("cached_tokens", 0)
    fresh = in_t - cached
    return (
        fresh   * GPT52_INPUT_PER_M  / 1e6
        + cached  * GPT52_CACHED_PER_M / 1e6
        + out_t   * GPT52_OUTPUT_PER_M / 1e6
    )


def _scenario_label(key: tuple[str, bool, bool]) -> str:
    """Human-readable label for a scenario key."""
    sid, forced, with_map = key
    parts = [sid]
    if forced:
        parts.append("forced")
    parts.append("map=Y" if with_map else "map=N")
    return " · ".join(parts)


def _build_scenario_data(traces: dict) -> list[dict]:
    """Build list of scenario dicts with per-turn costs baked in."""
    scenarios = []
    for key, t in sorted(traces.items(), key=lambda kv: _scenario_label(kv[0])):
        turns = t.get("turns", [])
        enriched_turns = []
        running_total = 0.0
        for i, turn in enumerate(turns):
            cost = _cost_per_turn(turn)
            running_total += cost
            enriched_turns.append({
                "index": i + 1,
                "input_tokens": turn.get("input_tokens", 0),
                "output_tokens": turn.get("output_tokens", 0),
                "cached_tokens": turn.get("cached_tokens", 0),
                "tool_calls": turn.get("tool_calls", []),
                "tool_calls_detail": turn.get("tool_calls_detail", []),
                "assistant_text": turn.get("assistant_text", ""),
                "cost": cost,
                "running_total": running_total,
            })

        totals = t.get("totals", {})
        in_t = totals.get("input_tokens", 0)
        cached_t = totals.get("cached_tokens", 0)
        fresh_t = in_t - cached_t
        out_t = totals.get("output_tokens", 0)
        session_cost = (
            fresh_t  * GPT52_INPUT_PER_M  / 1e6
            + cached_t * GPT52_CACHED_PER_M / 1e6
            + out_t    * GPT52_OUTPUT_PER_M / 1e6
        )
        cache_hit_pct = totals.get("cache_hit_rate", 0.0) * 100

        scenarios.append({
            "key": list(key),
            "label": _scenario_label(key),
            "scenario_id": t.get("scenario_id", ""),
            "pattern": t.get("pattern", ""),
            "handler_mode": t.get("handler_mode", ""),
            "model": t.get("model", ""),
            "enforce_compute_stats": key[1],
            "emit_map": key[2],
            "user_query": t.get("user_query") or "",
            "final_answer": t.get("final_answer") or "",
            "map_url": t.get("map_url") or None,
            "turn_count": t.get("turn_count", 0),
            "turns": enriched_turns,
            "totals": {
                "input_tokens": in_t,
                "output_tokens": out_t,
                "cached_tokens": cached_t,
                "cache_hit_pct": cache_hit_pct,
                "session_cost": session_cost,
            },
        })
    return scenarios


def _html(scenarios_json: str) -> str:
    """Return the full self-contained HTML string."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>geo-qa-templating bench viewer</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }}
  #topbar {{ padding: 10px 16px; background: #16213e; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }}
  #topbar h1 {{ font-size: 0.95rem; font-weight: 600; color: #a8dadc; white-space: nowrap; }}
  #scenario-select {{ flex: 1; background: #0f3460; border: 1px solid #457b9d; color: #e0e0e0; padding: 5px 8px; border-radius: 4px; font-size: 0.85rem; }}
  #main {{ display: flex; flex: 1; overflow: hidden; }}
  #conv-panel {{ width: 380px; flex-shrink: 0; overflow-y: auto; padding: 12px; border-right: 1px solid #0f3460; display: flex; flex-direction: column; gap: 8px; }}
  #map-panel {{ flex: 1; position: relative; }}
  #map {{ width: 100%; height: 100%; }}
  #map-note {{ position: absolute; top: 8px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.6); color: #ffd; padding: 4px 10px; border-radius: 4px; font-size: 0.78rem; z-index: 500; pointer-events: none; }}
  #bottom-panel {{ height: 200px; flex-shrink: 0; border-top: 1px solid #0f3460; overflow-y: auto; padding: 10px 16px; background: #16213e; display: flex; gap: 20px; }}
  #cost-table-wrap {{ flex: 1; overflow-y: auto; }}
  #projection-wrap {{ flex-shrink: 0; width: 240px; display: flex; flex-direction: column; gap: 6px; }}
  .bubble {{ padding: 8px 12px; border-radius: 8px; max-width: 100%; word-break: break-word; font-size: 0.82rem; line-height: 1.5; }}
  .bubble-user {{ background: #0f3460; border-left: 3px solid #457b9d; }}
  .bubble-final {{ background: #1d4e3a; border-left: 3px solid #52b788; }}
  .turn-block {{ background: #1e1e3a; border: 1px solid #2a2a5a; border-radius: 6px; padding: 8px 10px; font-size: 0.80rem; }}
  .turn-header {{ font-size: 0.75rem; font-weight: 600; color: #a8dadc; margin-bottom: 4px; display: flex; justify-content: space-between; }}
  .chip {{ display: inline-block; background: #0f3460; border: 1px solid #457b9d; border-radius: 10px; padding: 1px 7px; font-size: 0.72rem; margin: 1px; font-family: monospace; color: #90caf9; }}
  .turn-text {{ color: #bbb; margin-top: 4px; font-size: 0.78rem; white-space: pre-wrap; }}
  .turn-cost {{ font-size: 0.72rem; color: #a0c4a0; font-family: monospace; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 0.75rem; }}
  th {{ background: #0f3460; color: #a8dadc; padding: 4px 8px; text-align: right; font-weight: 600; position: sticky; top: 0; }}
  th:first-child {{ text-align: left; }}
  td {{ padding: 3px 8px; text-align: right; border-bottom: 1px solid #252550; font-family: monospace; }}
  td:first-child {{ text-align: left; }}
  tr:last-child td {{ font-weight: 600; background: #202040; }}
  label {{ font-size: 0.78rem; color: #a8dadc; }}
  input[type=number] {{ background: #0f3460; border: 1px solid #457b9d; color: #e0e0e0; padding: 4px 8px; border-radius: 4px; font-size: 0.82rem; width: 100%; }}
  .preset-btns {{ display: flex; gap: 4px; flex-wrap: wrap; }}
  .preset-btn {{ background: #0f3460; border: 1px solid #457b9d; color: #90caf9; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 0.75rem; }}
  .preset-btn:hover {{ background: #1a4a7a; }}
  #monthly-result {{ font-size: 1.1rem; font-weight: 700; color: #52b788; font-family: monospace; }}
  #monthly-label {{ font-size: 0.72rem; color: #888; }}
  .section-label {{ font-size: 0.70rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 2px; }}
  #no-data {{ color: #888; font-size: 0.85rem; padding: 20px; text-align: center; }}
</style>
</head>
<body>
<div id="topbar">
  <h1>geo-qa-templating bench viewer</h1>
  <select id="scenario-select"></select>
</div>
<div id="main">
  <div id="conv-panel"><div id="no-data">No traces loaded.</div></div>
  <div id="map-panel">
    <div id="map"></div>
    <div id="map-note" style="display:none"></div>
  </div>
</div>
<div id="bottom-panel">
  <div id="cost-table-wrap">
    <div class="section-label">Per-turn cost breakdown</div>
    <table id="cost-table">
      <thead><tr>
        <th>Turn</th><th>Input tok</th><th>Output tok</th><th>Cached tok</th>
        <th>$/turn</th><th>Running $</th>
      </tr></thead>
      <tbody id="cost-tbody"></tbody>
    </table>
  </div>
  <div id="projection-wrap">
    <div class="section-label">Monthly cost projection</div>
    <label for="qpm">Queries / month</label>
    <input type="number" id="qpm" value="50000" min="1" step="1000">
    <div class="preset-btns">
      <button class="preset-btn" onclick="setQPM(50000)">50K</button>
      <button class="preset-btn" onclick="setQPM(75000)">75K</button>
      <button class="preset-btn" onclick="setQPM(915000)">915K</button>
    </div>
    <div id="monthly-result">—</div>
    <div id="monthly-label">= $/query × queries/month</div>
    <div id="per-query-label" style="font-size:0.72rem;color:#888;font-family:monospace;margin-top:4px;"></div>
  </div>
</div>

<script>
const TRACE_DATA = {scenarios_json};

let map = null;
let overlayLayer = null;
const AOI_BOUNDS = [[38.756, -123.89], [40.005, -122.819]];
const MAP_CENTER = [39.38, -123.35];

function initMap() {{
  if (typeof L === 'undefined') return;  // Leaflet CDN unavailable; map stays blank
  map = L.map('map', {{ center: MAP_CENTER, zoom: 9 }});
  L.tileLayer('https://{{s}}.tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
  }}).addTo(map);
}}

function updateMap(scenario) {{
  if (typeof L === 'undefined' || !map) {{
    const note = document.getElementById('map-note');
    note.textContent = 'Map unavailable (Leaflet failed to load — check network).';
    note.style.display = 'block';
    return;
  }}
  if (overlayLayer) {{ map.removeLayer(overlayLayer); overlayLayer = null; }}
  const note = document.getElementById('map-note');
  if (scenario && scenario.map_url) {{
    overlayLayer = L.imageOverlay(scenario.map_url, AOI_BOUNDS, {{ opacity: 0.75 }}).addTo(map);
    map.fitBounds(AOI_BOUNDS);
    const cm = scenario.map_url.match(/colormap_name=([^&]+)/);
    note.textContent = 'Map layer: ' + (cm ? cm[1] : 'viridis') + (scenario.handler_mode ? ' · ' + scenario.handler_mode : '');
    note.style.display = 'block';
  }} else {{
    map.fitBounds(AOI_BOUNDS);
    note.textContent = 'No map layer in this trace (emit_map=false or render_map not called)';
    note.style.display = 'block';
  }}
}}

function renderConversation(scenario) {{
  const panel = document.getElementById('conv-panel');
  panel.innerHTML = '';
  if (!scenario) {{
    panel.innerHTML = '<div id="no-data">No traces loaded.</div>';
    return;
  }}

  // User bubble
  if (scenario.user_query) {{
    const uq = document.createElement('div');
    uq.className = 'bubble bubble-user';
    uq.textContent = scenario.user_query;
    panel.appendChild(uq);
  }}

  // Per-turn blocks
  scenario.turns.forEach(function(turn) {{
    const block = document.createElement('div');
    block.className = 'turn-block';

    const header = document.createElement('div');
    header.className = 'turn-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Turn ' + turn.index;
    const costSpan = document.createElement('span');
    costSpan.className = 'turn-cost';
    costSpan.textContent = '$' + turn.cost.toFixed(5);
    header.appendChild(titleSpan);
    header.appendChild(costSpan);
    block.appendChild(header);

    if (turn.assistant_text) {{
      const txt = document.createElement('div');
      txt.className = 'turn-text';
      txt.textContent = turn.assistant_text;
      block.appendChild(txt);
    }}

    if (turn.tool_calls_detail && turn.tool_calls_detail.length > 0) {{
      const chipsDiv = document.createElement('div');
      chipsDiv.style.marginTop = '4px';
      turn.tool_calls_detail.forEach(function(tc) {{
        const chip = document.createElement('span');
        chip.className = 'chip';
        const argsStr = tc.args && Object.keys(tc.args).length > 0
          ? '(' + Object.keys(tc.args).slice(0, 2).map(function(k) {{ return k + ': ' + JSON.stringify(tc.args[k]).slice(0, 20); }}).join(', ') + ')'
          : '()';
        chip.textContent = tc.name + argsStr;
        chipsDiv.appendChild(chip);
      }});
      block.appendChild(chipsDiv);
    }} else if (turn.tool_calls && turn.tool_calls.length > 0) {{
      const chipsDiv = document.createElement('div');
      chipsDiv.style.marginTop = '4px';
      turn.tool_calls.forEach(function(name) {{
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = name + '()';
        chipsDiv.appendChild(chip);
      }});
      block.appendChild(chipsDiv);
    }}

    panel.appendChild(block);
  }});

  // Final answer bubble
  if (scenario.final_answer) {{
    const fa = document.createElement('div');
    fa.className = 'bubble bubble-final';
    fa.textContent = scenario.final_answer;
    panel.appendChild(fa);
  }}
}}

function renderCostTable(scenario) {{
  const tbody = document.getElementById('cost-tbody');
  tbody.innerHTML = '';
  if (!scenario) return;
  scenario.turns.forEach(function(turn) {{
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + turn.index + '</td>' +
      '<td>' + turn.input_tokens.toLocaleString() + '</td>' +
      '<td>' + turn.output_tokens.toLocaleString() + '</td>' +
      '<td>' + turn.cached_tokens.toLocaleString() + '</td>' +
      '<td>$' + turn.cost.toFixed(5) + '</td>' +
      '<td>$' + turn.running_total.toFixed(5) + '</td>';
    tbody.appendChild(tr);
  }});
  // Totals row
  const tot = scenario.totals;
  const tr = document.createElement('tr');
  tr.innerHTML = '<td>TOTAL</td>' +
    '<td>' + tot.input_tokens.toLocaleString() + '</td>' +
    '<td>' + tot.output_tokens.toLocaleString() + '</td>' +
    '<td>' + tot.cached_tokens.toLocaleString() + ' (' + tot.cache_hit_pct.toFixed(1) + '% hit)</td>' +
    '<td>$' + tot.session_cost.toFixed(5) + '</td>' +
    '<td>—</td>';
  tbody.appendChild(tr);
}}

function updateProjection() {{
  const sel = document.getElementById('scenario-select');
  const idx = sel.value;
  const scenario = TRACE_DATA[idx];
  if (!scenario) return;
  const qpm = parseFloat(document.getElementById('qpm').value) || 0;
  const monthly = scenario.totals.session_cost * qpm;
  document.getElementById('monthly-result').textContent = '$' + monthly.toLocaleString('en-US', {{minimumFractionDigits: 2, maximumFractionDigits: 2}});
  document.getElementById('per-query-label').textContent = '$/query = $' + scenario.totals.session_cost.toFixed(6);
}}

function setQPM(n) {{
  document.getElementById('qpm').value = n;
  updateProjection();
}}

function onScenarioChange() {{
  const sel = document.getElementById('scenario-select');
  const idx = parseInt(sel.value, 10);
  const scenario = TRACE_DATA[idx];
  renderConversation(scenario);
  renderCostTable(scenario);
  updateMap(scenario);
  updateProjection();
}}

// Init
(function() {{
  const sel = document.getElementById('scenario-select');
  TRACE_DATA.forEach(function(sc, i) {{
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = sc.label;
    sel.appendChild(opt);
  }});
  sel.addEventListener('change', onScenarioChange);
  document.getElementById('qpm').addEventListener('input', updateProjection);

  // Render conversation/cost/projection FIRST so a map (network) failure
  // can't abort the rest of init. initMap is wrapped defensively too.
  if (TRACE_DATA.length > 0) {{
    renderConversation(TRACE_DATA[0]);
    renderCostTable(TRACE_DATA[0]);
    updateProjection();
  }}
  try {{
    initMap();
    if (TRACE_DATA.length > 0) updateMap(TRACE_DATA[0]);
  }} catch (e) {{
    console.error('map init failed (non-fatal):', e);
  }}
}})();
</script>
</body>
</html>
"""


def build_viewer() -> Path:
    """Read latest traces, compute per-turn costs, and emit a self-contained HTML viewer.

    Returns
    -------
    Path
        Path to the written HTML file (bench/reports/geo-qa-templating/geo-qa-templating-viewer.html).
    """
    traces = _latest_traces()
    scenarios = _build_scenario_data(traces)
    scenarios_json = json.dumps(scenarios, indent=2)

    html_content = _html(scenarios_json)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORTS_DIR / VIEWER_FILENAME
    out.write_text(html_content, encoding="utf-8")
    return out
