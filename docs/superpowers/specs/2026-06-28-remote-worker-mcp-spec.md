# Remote MCP Worker — design spec
# `calc.ajinkya.ai/mcp` via Cloudflare Workers

**Date:** 2026-06-28
**Status:** design spec — ready for implementation plan
**Repo:** `ai-cost-calculator-studio`, branch `feat/cost-mcp`
**Workstream:** #3 (Remote hosting). Sibling: #2 (npx packaging, not yet specced).
**Reference:** `docs/superpowers/specs/2026-06-27-cost-calc-mcp-design.md` (v1 stdio design)

---

## 1. Goal

Expose the cost-calculator MCP server at a **stable public HTTPS endpoint**
(`https://calc.ajinkya.ai/mcp`) so any MCP-capable client (Claude Code,
Cursor, Claude Desktop) can connect with a single URL, with no local
installation required. Numbers must be byte-identical to the live site and to
the stdio server — one engine, three delivery surfaces (site, stdio, remote).

### Non-goals (this spec)
- No authentication beyond rate-limiting — the tool does only pure math, no
  LLM calls, no API key spend, no secrets.
- No stateful sessions, multi-turn context, or server-side workload storage.
  The client holds the workload JSON; the server is a pure function.
- No new tools, prompt changes, or schema additions — the surface is exactly
  the six tools + `cost_interview` prompt defined in v1.
- No npx packaging (workstream #2, a separate spec).
- No model-comparison or sensitivity-sweep tools (v1.1 deferred item from v1
  spec §10).

---

## 2. Background

The v1 stdio server (`mcp/server.mjs`) speaks JSON-RPC over stdout. It is
fully stateless: the host (Claude Code) holds the workload in context and
passes it on every call. The tool logic lives in `mcp/lib/*.mjs`; the math
lives in the canonical CJS-UMD engine files at `public/lib/`. The engine runs
in any JS runtime (browser, Node, Workers) because it has no Node-only APIs in
the math path.

The existing site Worker (`ai-cost-calculator-studio`) already runs on
Cloudflare Workers with `nodejs_compat` and a `calc.ajinkya.ai` custom domain.
Its `wrangler.jsonc` currently declares only static assets (no fetch handler).
This spec adds a fetch handler that routes `POST /mcp` (and `GET /mcp`) to the
MCP transport while delegating everything else to the existing asset pipeline.

---

## 3. Transport and runtime — options and recommendation

This is the most consequential decision in the spec. Three options:

### Option A — `WebStandardStreamableHTTPServerTransport` (SDK v1.29, stateless mode)

The MCP SDK v1.29 ships `WebStandardStreamableHTTPServerTransport` in
`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`. Its own
JSDoc says: _"This transport works on any runtime that supports Web Standards:
Node.js 18+, Cloudflare Workers, Deno, Bun, etc."_ It accepts a raw `Request`
and returns a `Response` — exactly the Cloudflare Workers fetch handler
contract.

In stateless mode (`sessionIdGenerator: undefined`), the SDK docs require a
**new transport + new McpServer instance per request** because the transport
tracks `_hasHandledRequest` and throws on reuse. This means the Worker's fetch
handler instantiates a fresh `McpServer` + transport on every incoming request.
This is lightweight because the server has no I/O init — it is pure-function
tool registrations over a pre-loaded engine.

Upside: no hand-rolling, no divergence from the MCP spec, uses the same SDK
already depended on by v1, no additional packages.
Downside: per-request construction overhead (negligible — pure JS, no I/O);
the SDK's stateless constraint means no streaming notifications or resumable
requests (neither is needed here).

### Option B — Cloudflare `agents` / `McpAgent` + Durable Objects

Cloudflare's first-party MCP support (`cloudflare/agents` package,
`McpAgent` base class) wraps a Durable Object to provide session state and
streaming. It is the natural fit when a server needs per-session memory,
WebSocket streaming, or background tasks.

This server needs none of those. Durable Objects add a billing dimension
($0.15/million requests + $0.20/GB-month storage) and a new deployment
abstraction (DO namespace binding, migration config) for zero benefit. The
`agents` package is also not in the project's current dependency tree.

Not recommended for this use case.

### Option C — hand-rolled JSON-RPC-over-HTTP

Bypass the SDK transport entirely: parse the incoming POST body as a
JSON-RPC request, call the appropriate tool handler directly, return a
JSON response. This eliminates the SDK's stateless-reuse constraint and
all transport machinery.

Upside: minimal bundle, full control.
Downside: diverges from the MCP spec at the transport layer (correct
`Content-Type`, `Mcp-Session-Id` header handling, SSE streaming for
`notifications/` if ever needed). Any spec update requires manual re-sync.
High maintenance risk.

Not recommended.

### Recommendation: Option A (stateless `WebStandardStreamableHTTPServerTransport`)

Rationale: the SDK already declares Workers compatibility in its own docs;
stateless mode matches the server's compute-only nature; no new dependencies;
transport spec compliance is maintained automatically as the SDK evolves. The
per-request construction penalty is sub-millisecond — the engine is synchronous
pure math, not I/O-bound.

**SSE vs Streamable HTTP note:** The older SSE transport (`sse.js`) requires
maintaining an open connection for the response stream — awkward on Cloudflare
Workers' single-request/response model and deprecated in favor of Streamable
HTTP in MCP 2025-03-26. Streamable HTTP allows a single POST-per-call pattern
(no persistent connection) which maps cleanly to Workers' stateless invocation
model. Use Streamable HTTP only; do not implement the SSE transport.

---

## 4. Statefulness — why Durable Objects are not needed

The existing stdio server's `McpServer` instance is recreated per process
invocation. The sole "state" is the workload JSON, which the client maintains
in its context window and passes as a parameter on every tool call. No
server-side session, cache, or conversation history is needed.

Under Option A's stateless mode, the Worker creates a fresh `McpServer` +
`WebStandardStreamableHTTPServerTransport` per request. This is the correct
mapping: one HTTP request = one MCP RPC round-trip. There is no streaming
notification channel to maintain. If a future v1.1 tool needs server-push
(e.g., a long-running sensitivity sweep reporting progress), that would require
revisiting; it is explicitly a non-goal here.

---

## 5. Reusing the engine at the edge — bundling strategy

The Worker must execute the **identical** code paths as the site's browser JS
and the stdio server's Node `require()` calls. The constraint: single source of
truth, zero forks.

### Module graph

```
Worker entry point (src/worker.mjs)
  └─ mcp/lib/*.mjs           (tool logic — already ESM)
       └─ public/lib/cost-engine.js    (CJS-UMD)
       └─ public/lib/prices.js         (CJS-UMD)
       └─ public/lib/headline-math.js  (CJS-UMD)
       └─ public/lib/build-opts.js     (CJS-UMD)
       └─ public/lib/workload-hash.js  (UMD)
  └─ public/examples/*.json  (preset files, imported as JSON)
  └─ mcp/instructions.md     (text asset, inlined at bundle time)
  └─ mcp/prompts/cost-interview.md (text asset, inlined at bundle time)
```

### Bundling with wrangler/esbuild

Wrangler uses esbuild internally. The Worker entry point imports the CJS-UMD
engine files; esbuild handles CJS interop for the Worker bundle (the
`nodejs_compat` flag is already set on the existing site Worker and enables
CJS module interop in the Workers runtime). The bundled output is a single ESM
module that wrangler deploys.

Key points:
- `public/lib/*.js` are pure UMD with no Node-only APIs in the math path.
  They self-detect the runtime (`typeof window !== 'undefined'`) and export
  via `module.exports` in the CJS branch — esbuild resolves this statically.
- `public/examples/*.json` are loaded at module init (not via `fs.readFileSync`
  at request time) so they are bundled as static data. The Worker entry point
  replaces `presets.mjs`'s `fs.readdirSync` call with a static import map of
  the preset JSON files.
- `mcp/instructions.md` and `mcp/prompts/cost-interview.md` are inlined at
  bundle time (esbuild `loader: { '.md': 'text' }`), replacing the
  `fs.readFileSync` calls in `server.mjs`.
- `node:module` (`createRequire`) is used in `engine-bridge.mjs` and
  `sharelink.mjs`; with `nodejs_compat` this is available in the Workers
  runtime. If bundling reveals a gap, the fix is to replace the `createRequire`
  pattern with direct ESM imports from the engine files (which are valid UMD
  that esbuild can consume without `require`).

### Worker entry point shape (illustrative)

```js
// src/worker.mjs — NOT final code; illustrates the structure
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport }
  from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerAllTools } from '../mcp/lib/register.mjs'; // to be extracted
import instructions from '../mcp/instructions.md';          // esbuild text loader

function buildServer() {
  const server = new McpServer({ name: 'cost-calc', version: '1.0.0' }, { instructions });
  registerAllTools(server);
  return server;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') {
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer();
      await server.connect(transport);
      return transport.handleRequest(request);
    }
    // Fall through to static asset handler (ASSETS binding)
    return env.ASSETS.fetch(request);
  },
};
```

### Dependency on workstream #1 (consistency fix)

The spec `2026-06-28-workload-authoritative-opts-spec.md` (workstream #1)
ensures that `buildOpts()` is called identically in the UI, the bench, and the
MCP engine-bridge. The remote Worker must be deployed **after** workstream #1
is merged to `main` so that the Worker's bundled engine is the authoritative
version. Deploying before the consistency fix risks the Worker's numbers
diverging from the site's rendered headline on edge cases.

---

## 6. Routing and deployment

### Routing decision — same Worker vs separate Worker

Two options:

**Option R1 — extend the existing `ai-cost-calculator-studio` Worker**
Add a fetch handler to the current Worker. The `wrangler.jsonc` currently
declares only `assets` with no fetch handler (pure static). Adding a fetch
handler script and routing `/mcp` through it while forwarding all other
requests to `env.ASSETS.fetch(request)` is the standard pattern for
Worker-with-assets hybrid deployments.

Upside: same deploy unit, same `wrangler deploy` command, no new wrangler
route or DNS record needed, `/mcp` is co-located on `calc.ajinkya.ai` naturally.
Downside: the Worker bundle now includes the MCP SDK and engine (~200-400KB
bundled) alongside the static asset handler; any MCP Worker crash takes down
the static site routing (though Cloudflare's asset binding is resilient).

**Option R2 — separate Worker at a new route**
A new Worker script (`ajinkya-calc-mcp`) deployed to `calc.ajinkya.ai/mcp`
via a Cloudflare route record. The existing static site Worker is untouched.

Upside: blast radius isolation; independent deploy lifecycle.
Downside: new wrangler config, new DNS/route to manage, `calc.ajinkya.ai`
route precedence must be set so `/mcp` wins before the static asset Worker.
Cloudflare route matching on the same custom domain across Workers requires
careful ordering.

**Recommendation: Option R1 (extend the existing Worker)**

The static site is a single HTML/JS page with no server-side logic; adding a
fetch handler is the lowest-friction path and keeps `calc.ajinkya.ai/mcp` in
the same deploy unit as the calculator it serves. The risk of the Worker
crash affecting the static site is mitigated by the fact that the asset
binding (`env.ASSETS.fetch`) is handled by Cloudflare's infrastructure, not
the Worker script itself.

### `wrangler.jsonc` shape (illustrative sketch)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "ai-cost-calculator-studio",
  "compatibility_date": "2026-05-03",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },

  // NEW: entry point for the fetch handler
  "main": "src/worker.mjs",

  "routes": [
    { "pattern": "calc.ajinkya.ai", "custom_domain": true }
  ],

  "assets": {
    "directory": "./public",
    "not_found_handling": "404-page"
  },

  // NEW: rate-limit binding (Cloudflare rate limiting API)
  "rate_limits": [
    {
      "binding": "RATE_LIMITER",
      "namespace_id": "<to-be-provisioned>"
    }
  ]
}
```

The `ASSETS` binding is automatically injected by Wrangler when `assets` +
`main` coexist; the fetch handler calls `env.ASSETS.fetch(request)` for
non-`/mcp` paths.

### Deploy command (same pattern as existing Workers)

```bash
cd /path/to/ai-cost-calculator-studio
export CLOUDFLARE_API_TOKEN=$(cat ~/.cloudflare/api-token | tr -d '\n\r ')
export CLOUDFLARE_ACCOUNT_ID=082499cdbef2cf208e4f253f66db1609
npx wrangler deploy
```

No new `wrangler secret put` calls are needed — this Worker has no API key
spend and no secrets.

---

## 7. Auth, rate-limiting, CORS, and abuse controls

### Threat model

The `/mcp` endpoint performs **pure synchronous math** — no LLM calls, no
outbound network requests, no API key spend. A `compute_cost` call runs the
engine in ~1ms. The exposure is CPU time on Cloudflare's Workers platform
(which is free-tier-abundant) and Cloudflare's request quota. There are no
financial blow-up risks analogous to the calc-proxy's LLM budget.

### Auth decision — fully open, rate-limited

No token gate. Reasons:
1. The entire tool surface is already public via the calc.ajinkya.ai site UI.
2. No secrets are involved; no per-user state is stored.
3. Requiring a token would break the one-URL install UX (the main goal).

### Rate-limiting

Reuse the pattern from `ajinkya-calc-proxy`'s five-layer defense, simplified
to what matters here:

| Layer | Mechanism | Threshold (suggested) | Open Decision |
|---|---|---|---|
| Per-IP burst | Cloudflare rate limiting (Workers binding) | 60 req/min | tune based on observed p99 |
| Per-IP daily | KV counter (existing `USAGE` namespace, new key prefix `mcp:`) | 500 req/day | or skip if pure-math risk is acceptable |
| Global daily | KV counter | 10,000 req/day | tune |

**Open Decision OD-4**: Whether to bind the existing `USAGE` KV namespace to
this Worker and add `mcp:` prefixed counters, or deploy with Cloudflare's
native rate limiting API only (simpler, no KV dependency). The calc-proxy
pattern uses KV because it needs dollar-value caps; this Worker needs only
request-volume caps, which Cloudflare's rate limiting API handles natively
without KV reads.

### Admin bypass

Same `X-Admin-Token: <ADMIN_BYPASS_TOKEN>` header pattern, same
`~/.calc-proxy/admin-token` secret. If KV rate-limiting is added, the bypass
skips counters (not the request itself). If only Cloudflare native rate
limiting is used, no bypass logic is needed in the Worker code (Cloudflare
rate limits can be configured to exempt a specific IP).

### CORS

The `/mcp` endpoint must be callable from:
- Claude Desktop and Cursor (Electron apps making fetch calls — no CORS
  restrictions apply at the OS level)
- Browser-based MCP clients (if/when they exist)

Safe approach: return `Access-Control-Allow-Origin: *` on the `/mcp` path
(the endpoint has no auth and no cross-origin risk since it handles no
credentials). Also handle `OPTIONS` preflight:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Mcp-Session-Id
```

### DNS rebinding protection

The SDK's `WebStandardStreamableHTTPServerTransport` already validates
`Host` and `Origin` headers by default to prevent DNS rebinding. The Worker
should not suppress this validation.

---

## 8. Tool and prompt surface over HTTP

All six tools and the `cost_interview` prompt are served identically over the
HTTP transport as over stdio. No tool changes are needed. Specific notes:

- **`list_presets` / `load_preset`**: preset JSON files are bundled into the
  Worker at deploy time (see §5). They are not read from disk at request time.
  The preset catalog is frozen at deploy; updating presets requires a
  redeployment (same discipline as the site).
- **`make_share_link`**: still returns `https://calc.ajinkya.ai/#w=…` — the
  tool's base URL is a constant, not configurable. No change.
- **Server instructions**: `mcp/instructions.md` is bundled as a text asset at
  build time. Same content as v1 stdio.
- **`cost_interview` prompt**: `mcp/prompts/cost-interview.md` is bundled at
  build time. Same content as v1 stdio.

**Open Decision OD-5**: Should `list_presets` in the Worker scan the bundled
preset list dynamically or be a static array baked at build time? The current
stdio implementation uses `fs.readdirSync`. The Worker replacement should be a
static import map to avoid filesystem calls at request time. This requires a
small refactor to `presets.mjs` — either a new `presets-worker.mjs` variant
that re-exports the same API with a bundled data source, or a common
`presets-core.mjs` that accepts an injected preset map (enabling both Node and
Worker usage). The single-source-of-truth constraint argues for the injection
approach.

---

## 9. Install UX — one-liners

### Claude Code

```bash
claude mcp add --transport http cost-calc https://calc.ajinkya.ai/mcp
```

This is the **complete install**. The server identifier `cost-calc` is local
naming only; the URL is the authoritative connection point. No local files, no
Node.js required.

### Cursor

```jsonc
// .cursor/mcp.json  (project-level)  OR  ~/.cursor/mcp.json (global)
{
  "mcpServers": {
    "cost-calc": {
      "url": "https://calc.ajinkya.ai/mcp"
    }
  }
}
```

### Claude Desktop

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "cost-calc": {
      "type": "http",
      "url": "https://calc.ajinkya.ai/mcp"
    }
  }
}
```

**Important clarification:** A `CLAUDE.md` entry in a project repository does
NOT connect an MCP client to a remote server. `CLAUDE.md` can document the
one-liner for humans to copy, but the actual connection requires the user to
run `claude mcp add` or edit their client config. The README and any
`CLAUDE.md` entry should make this distinction explicit.

**Open Decision OD-6**: Whether to add a `CLAUDE.md` or `.mcp.json` (Claude
Code's project MCP config) to the repo root pointing at the live URL. This
would auto-connect Claude Code for contributors who open the repo, without
them needing to run `claude mcp add`. Risk: contributors without MCP clients
get a noisy warning; contributors using the stdio server for development would
have both registered. Recommend documenting the one-liner in README and leaving
`.mcp.json` / `CLAUDE.md` to the user's choice.

---

## 10. Testing and acceptance

### Local development

```bash
npx wrangler dev --local
```

This runs the Worker locally with `wrangler dev`. The `/mcp` endpoint is
available at `http://localhost:8787/mcp`. The static site assets are served
from `./public` as normal.

For MCP client testing during development:

```bash
# Claude Code local override
claude mcp add --transport http cost-calc-dev http://localhost:8787/mcp
```

### Test suite additions for the remote Worker

The existing `mcp/test/` suite tests the tool logic and stdio protocol.
Three additional test categories are needed for the remote Worker:

**T1 — HTTP transport smoke test (`mcp/test/test-http-protocol.mjs`)**
Spin up `wrangler dev` (or a local equivalent using the SDK's test utilities),
connect an MCP client via `WebStandardStreamableHTTPClientTransport` (SDK
`client/webStandardStreamableHttp.js`), assert:
- `tools/list` returns all six tools.
- `prompts/list` returns `cost_interview`.
- `compute_cost` with the `archetype-agent-demo` preset returns a positive
  `headline_monthly_usd`.

**T2 — Remote parity check (`mcp/test/test-http-parity.mjs`)**
For each bundled preset (same set as `test-parity.mjs`), call `compute_cost`
over the HTTP transport and assert the result equals the direct
`computeWorkload()` call. This proves that bundling did not break the engine.
Can target `wrangler dev` locally or the live `calc.ajinkya.ai/mcp` endpoint
(guarded by an env flag `MCP_URL`).

**T3 — CORS check (`mcp/test/test-cors.mjs`)**
Send a preflight `OPTIONS /mcp` and assert the correct CORS headers are
returned. Send a POST with `Origin: https://example.com` and confirm the
response includes `Access-Control-Allow-Origin: *`.

**T4 — Rate-limit integration test**
Manual or CI: send N+1 requests within a minute from a single IP and assert
the N+1th returns 429. This is an integration test against the live or
staging Worker, not a unit test.

**Acceptance criteria (before GA):**
1. `npx wrangler dev` starts without errors.
2. T1 + T2 + T3 pass locally against `wrangler dev`.
3. T1 + T2 pass against the deployed `https://calc.ajinkya.ai/mcp`.
4. `claude mcp add --transport http cost-calc https://calc.ajinkya.ai/mcp`
   completes; subsequent `/mcp cost_interview` prompt invocation in Claude Code
   runs the interview; the quoted headline matches the share-link rendered in
   the browser.
5. Parity triple-check: for one representative preset (e.g.,
   `customer-support-fleet`), the number from the HTTP endpoint equals the
   number from the stdio server equals the number rendered in the browser UI.
   This is the "single source of truth" acceptance gate.

---

## 11. Relationship to workstream #2 (npx packaging)

Both the remote Worker and the eventual npx package share the same source:
`mcp/lib/*.mjs` and `public/lib/*.js`. The single-source-of-truth requirement
means:

- No code in `mcp/lib/` should be forked or copied for either delivery surface.
- The only Worker-specific adaptation is the entry point (`src/worker.mjs`)
  and the `presets.mjs` bundling approach (§5, §8 OD-5).
- If workstream #2 produces a `presets-core.mjs` with an injected data source,
  the Worker can use the same abstraction.
- The `engine-bridge.mjs` `createRequire` pattern must work in both Node (npx)
  and Workers (wrangler bundle). If it doesn't work in Workers due to a
  bundling edge case, the fix is to replace `createRequire` with direct ESM
  imports from the UMD files — this change is compatible with Node and Workers
  alike and should be made in `engine-bridge.mjs` itself, not in a fork.

---

## 12. Open decisions

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| OD-1 | Transport implementation | (A) SDK `WebStandardStreamableHTTPServerTransport`, (B) Cloudflare `McpAgent`/DO, (C) hand-rolled JSON-RPC | A — SDK stateless mode |
| OD-2 | Worker topology | (R1) extend existing `ai-cost-calculator-studio` Worker, (R2) separate Worker + route | R1 — extend existing |
| OD-3 | Session mode | Stateless (new transport per request) vs stateful (DO-backed sessions) | Stateless — sessions add no value for compute-only tools |
| OD-4 | Rate-limiting mechanism | Cloudflare native rate limiting API only vs KV counters (calc-proxy pattern) | Native rate limiting API — no KV dependency needed for pure-math endpoint |
| OD-5 | Preset loading in Worker | `fs.readdirSync` replaced by (a) static import map in worker entry, (b) injected data via `presets-core.mjs` abstraction | Option (b) — enables reuse by workstream #2 |
| OD-6 | Repo-level `.mcp.json` / `CLAUDE.md` | Add project-level MCP config pointing at live URL, or leave to user | Leave to user; document one-liner in README only |
| OD-7 | Merge dependency | Deploy after workstream #1 (authoritative opts fix) merges, or deploy immediately with a known-gap note | Defer deployment until workstream #1 merges — parity is a hard acceptance criterion |

---

## 13. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **SDK / Workers runtime compatibility gap** — `WebStandardStreamableHTTPServerTransport` is documented as Workers-compatible but may hit Node-only import paths (e.g., `node:stream`, `node:crypto`) when bundled. This is the top risk. | High | Validate in a spike (`wrangler dev`) before full implementation. If a gap exists, the fallback is Option C (hand-rolled JSON-RPC) for the MVP. |
| **`createRequire` in Workers** — `engine-bridge.mjs` and `sharelink.mjs` use `createRequire` from `node:module`. With `nodejs_compat` this should work; if not, replace with direct ESM imports. | Medium | Verify in `wrangler dev` spike. Fix is a one-line change per file. |
| **Bundle size** — esbuild bundling the MCP SDK + engine + presets may produce a Worker script above Cloudflare's 10MB limit (Workers Bundled) or 3MB (Workers Free). | Low | The engine is ~50KB minified; the SDK adds ~200KB. Total should be well under 1MB. Verify with `wrangler deploy --dry-run`. |
| **Preset catalog staleness** — presets are baked into the Worker bundle at deploy time. Adding a new preset requires a redeployment. | Low | This is the same discipline as the site; acceptable for now. Document in README. |
| **Parity gap if workstream #1 is not merged** — the Worker could ship with slightly different `buildOpts()` behavior than the live site on edge cases, violating the "byte-identical" acceptance criterion. | Medium | Block the production deploy on workstream #1 merge (OD-7). Enforce via the T2/T5 parity acceptance gate. |
| **MCP spec evolution** — if Anthropic updates Claude Code's MCP HTTP transport expectations (e.g., requires SSE support or a specific protocol version header), the Worker needs to be updated. | Low | SDK upgrades automatically pick up spec changes; staying on SDK rather than hand-rolling (Option A over C) is the mitigation. |
| **Cloudflare rate limit misconfiguration** — too-tight rate limits block legitimate users (e.g., CI pipelines running parity checks); too-loose limits allow abuse. | Low | Start conservative (60 req/min per IP); tune based on observability data (`wrangler tail`). Admin bypass header available for CI. |
