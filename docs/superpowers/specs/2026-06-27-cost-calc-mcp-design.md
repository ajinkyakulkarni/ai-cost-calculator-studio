# Cost-Calculator MCP server — design spec

**Date:** 2026-06-27
**Status:** approved design → ready for implementation plan
**Repo:** `ai-cost-calculator-studio`

## 1. Goal

Let a user describe an AI-agent deployment in plain language and get a
**trustworthy monthly cost** — where the LLM (the user's Claude Code) runs the
*conversation* but never the *arithmetic*. Every number comes from the
canonical, parity-locked cost engine, called programmatically. The agent
behaves as a helpful cost analyst: it proposes sensible defaults and
suggestions wherever it can, and explicitly confirms the cost-driving inputs
before quoting a figure.

### Non-goals (v1)
- No public web chat (that is a later, separate effort — see §10).
- No new cost math. The engine is frozen; the server is a thin wrapper.
- No stateful server session, model comparison, or sensitivity sweeps in v1
  (deferred to v1.1, §10).

## 2. Core principles

1. **The LLM never computes.** It only assembles/edits a `workload` JSON and
   calls the engine. All math is `CostEngine.compute()`.
2. **Canonical engine, zero parity gap.** The server `require`s the exact
   `public/lib/cost-engine.js` + `public/lib/prices.js` that the live site
   runs, so MCP numbers are byte-identical to calc.ajinkya.ai.
3. **Hard gate against invented inputs.** `compute_cost` refuses to return any
   number until the cost-driving inputs are explicitly present (§6).
4. **Seamless interview on top of the gate.** A shipped prompt + server
   instructions make the agent propose defaults/suggestions and confirm only
   what it must, so the gate never feels like a wall (§7).
5. **Auditable output.** Every result carries the assumptions it made (with the
   default's source) and the engine's derivation trace.

## 3. Architecture

A **Node stdio MCP server** living in `mcp/` in the repo. Stateless: the host
(Claude Code) holds the `workload` JSON in its context and passes it to each
tool call; the server holds no session state.

```
Claude Code (conversation, interview)
        │  MCP (stdio)
        ▼
cost-calc MCP server  (mcp/server.js)
        │  require()
        ▼
public/lib/cost-engine.js  +  public/lib/prices.js   ← canonical, frozen
```

Install: `claude mcp add cost-calc -- node /abs/path/mcp/server.js`.
Runtime: Node ≥ 18, zero runtime deps beyond the MCP SDK (`@modelcontextprotocol/sdk`).
The engine + prices are plain CommonJS modules already.

### File layout
```
mcp/
  server.js            # MCP wiring: tools/list, tools/call, prompts/list, prompts/get
  lib/
    engine-bridge.js   # require cost-engine.js+prices.js; compute(workload,opts)→result
    workload-schema.js # the workload JSON schema + per-field {required, suggestible, default, suggest_rationale}
    validate.js        # validate_workload(): missing_required[] + assumptions[] + suggestions[]
    sharelink.js       # encode(workload)→ calc.ajinkya.ai/#w=… (ported from app.js codec)
    presets.js         # load the 18 public/examples/*.json + one-line descriptions
    format.js          # shape compute() output → tool result (headline, breakdown, assumptions, warnings)
  prompts/
    cost-interview.md  # the written interview prompt (the deliverable)
  instructions.md      # server-level instructions injected into the host on connect
  test/
    test-gate.mjs      # hard-gate refusal cases
    test-parity.mjs    # compute_cost on all 18 presets == engine output
    test-sharelink.mjs # encode→decode round-trip
    test-protocol.mjs  # tools/list, tools/call, prompts/list smoke
  README.md            # install + usage
package.json           # add "mcp:test" script; @modelcontextprotocol/sdk dep
```

## 4. Tool surface (v1)

| Tool | Input | Returns |
|---|---|---|
| `list_presets` | — | `[{name, title, one_line}]` for the 18 bundled examples |
| `load_preset` | `{name}` | the preset's full `workload` JSON (a starting point to adapt) |
| `get_schema` | — | the workload schema with per-field `{required, suggestible, default, suggest_rationale, doc}` so the agent knows what to fill, suggest, and confirm |
| `validate_workload` | `{workload}` | `{ok, missing_required:[{field, why, suggested_value, rationale}], assumptions:[{field, value, source}]}` — **no compute** |
| `compute_cost` | `{workload, opts?}` | the hard gate (§6) — on pass: the result object (§8); on fail: `{error:"missing_required", missing_required:[…]}` and **no numbers** |
| `make_share_link` | `{workload}` | `{url}` → `https://calc.ajinkya.ai/#w=…` to open in the visual UI |

Deferred to v1.1: `compare_models`, `sensitivity`, `archetype_cost` helper.

## 5. Prompts & instructions (the interview layer)

### 5.1 `prompts/cost-interview.md` (named MCP prompt `cost_interview`)
The written interview script, surfaced to the user as an invocable prompt in
Claude Code. It directs the agent to:
1. Ask what they're building, in plain language.
2. Draft a `workload` (start from the closest preset via `list_presets`/
   `load_preset`), inferring everything it can.
3. Run `validate_workload`; present the **must-confirm** items as a short
   checklist *with proposed values + rationale*, and state the **suggested**
   defaults it applied in one line.
4. On user confirmation, call `compute_cost`.
5. Present headline + per-query + key breakdown, list assumptions, include the
   share-link, then offer sensitivities ("cheaper model / batch tier / 2×
   volume?"). Offer the derivation trace on request.
- Behavior rules (mirror the user's standing conventions): never silently
  invent a must-confirm input; propose realistic operating-point defaults, not
  midpoints/zeros; flag derived-not-measured values; keep the headline
  consistent with what the engine returns.

### 5.2 `mcp/instructions.md` (server `instructions`)
A condensed always-on version of the above, injected into the host when the
server connects, so the behavior holds even without invoking the prompt.

## 6. The hard gate

`compute_cost` (and `validate_workload`) classify the workload against a
**required set**. If any required item is absent, `compute_cost` returns
`{error:"missing_required", missing_required:[…]}` with **no cost numbers**.

**Required (must be explicitly provided; agent proposes + user confirms):**
- **Volume** — a `segments[]` entry with `mau`, `sessions_per_day`,
  `questions_per_session` (or an explicit monthly query count).
- **model**
- **hosting** (`api` | `byok` | `self-host`)
- **cache_rate_baseline** (anchor) — or per-agent cache configuration
- **A per-query token profile** — exactly one of: `anchor_query` input/output
  tokens, `agents[]` token profiles, or `archetypes`.
- **Conditionally required (only when in play):** if `hosting:self-host` → the
  GPU/throughput selection; if federal context is indicated → `fedramp_tier`.

**Suggestible (default applied, stamped as an assumption, override anytime):**
`tier` (=standard), `cost_mode` (=optimistic), traffic `mix` (=single worst
shape), `tier_multipliers` (=price book), retry/rate-limit (off), verification
(off), embedding (off), personnel (off), migration (off), self-host
diurnal/headroom/min-replicas (defaults).

Rationale for the split: the required set is exactly the inputs that move the
headline by orders of magnitude and that the engine cannot responsibly guess;
everything else has a defensible default the agent surfaces transparently.

## 7. Suggest-vs-confirm, as data

`get_schema` and `validate_workload` return per-field metadata so the agent's
"propose vs confirm" behavior is driven by data, not just prose:
- `required: true|false`
- `suggestible: true|false` + `default` + `suggest_rationale`
- For missing required fields, `validate_workload` returns a concrete
  `suggested_value` + `rationale` the agent can offer for one-tap confirmation.

## 8. `compute_cost` output shape (on pass)
```jsonc
{
  "headline_monthly_usd": 47095,        // cap-aware figure, matches the site
  "per_query_usd": 0.103283,
  "breakdown": { /* api / self_host / tools / federal / … as engine returns */ },
  "assumptions": [ {"field":"tier","value":"standard","source":"default"}, … ],
  "warnings": [ "daily cap clamped at $45,000/mo", … ],
  "derivation_trace": "…auditable line-by-line string…",
  "share_link": "https://calc.ajinkya.ai/#w=…"
}
```

## 9. Testing & acceptance

- **Hard-gate** (`test-gate.mjs`): omit model / volume / token-profile each →
  `compute_cost` returns `missing_required` naming the right field, no numbers;
  a fully-specified workload passes.
- **Parity** (`test-parity.mjs`): for all 18 `public/examples/*.json`,
  `compute_cost` equals a direct `CostEngine.compute()` call (MCP ≡ engine ≡
  site). Reuses the existing dump/parity discipline.
- **Share-link** (`test-sharelink.mjs`): `encode(workload)` → decode (the
  inverse of app.js's reader) → deep-equals the input.
- **Protocol** (`test-protocol.mjs`): `tools/list` returns the six tools;
  `prompts/list` returns `cost_interview`; a `tools/call compute_cost` round
  trips over stdio.
- Wire `npm run mcp:test`; keep `npm test` (engine) untouched and green.
- **Manual acceptance**: `claude mcp add` locally; run the `cost_interview`
  prompt; confirm the agent interviews, gates on a missing input, and the quoted
  number matches the share-link's rendered headline in the browser.

## 10. Future (out of scope for v1)
- v1.1 tools: `compare_models`, `sensitivity` sweeps, `archetype_cost` helper.
- Public web chat: a Cloudflare Worker hosting the same tool definitions +
  `cost-engine.js` server-side (Option D from the discussion), reusing this
  server's schema/validate/format modules.

## 11. Open risks
- **Share-link codec drift**: the encoder must exactly mirror app.js's reader
  (`#w=base64(encodeURIComponent(JSON))` + the `ui` block). Covered by the
  round-trip test; if the site codec changes, the test must be updated in lock-step.
- **Schema drift**: `workload-schema.js` duplicates knowledge of the workload
  shape. Mitigation: keep it minimal (only required/suggestible classification +
  docs), and parity tests over real presets catch structural mismatches.
