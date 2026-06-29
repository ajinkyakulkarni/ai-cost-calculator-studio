# npx packaging — design spec

**Date:** 2026-06-28
**Status:** approved decisions → ready for implementation plan
**Repo:** `ai-cost-calculator-studio`
**Workstream:** #2 of 3. Gates on workstream #1 (workload-authoritative opts, `2026-06-28-workload-authoritative-opts-spec.md`) being merged first.

---

## 1. Goal

Let any Claude Code / Cursor / Claude Desktop user install the cost-calc MCP
server in **one command, without cloning the repo**:

```bash
claude mcp add cost-calc -- npx -y @ajinkya/cost-calc-mcp
```

The installed server must produce numbers **byte-identical** to calc.ajinkya.ai —
that guarantee is the whole point of the canonical-engine architecture. It must
not require the user to own or know about the repo layout.

---

## 2. Non-goals

- No fork of the engine, prices, or preset JSON files. There is one source of
  truth.
- No new cost math or tools in this workstream. The package is a distribution
  mechanism, not a feature.
- No remote Worker / HTTP endpoint (workstream #3, separate spec).
- No automated publish pipeline (CI auto-publish) in v1; a manual release
  command is acceptable for now, with CI as a future addition.
- No browser/bundler support for the npm package itself. The package is Node
  stdio only.

---

## 3. Background

### Why the server can't be run today without a clone

`mcp/server.mjs` and its lib files use two types of cross-directory references:

1. **Engine modules via `createRequire`** — `engine-bridge.mjs` calls
   `require('../../public/lib/cost-engine.js')`, `prices.js`, `headline-math.js`,
   `build-opts.js`, and `workload-hash.js`. These are CJS/UMD modules in
   `public/lib/`, outside `mcp/`.
2. **Preset JSON via `path.resolve`** — `presets.mjs` resolves
   `../../public/examples/*.json` at runtime relative to `import.meta.url`.
3. **Prompt/instructions text via `new URL()`** — `server.mjs` reads
   `./instructions.md` and `./prompts/cost-interview.md` using the file URL of
   `server.mjs`.

References (1) and (2) point two directory levels up, so they only resolve if
the installed code retains its position inside the repo. An `npm install` of a
standalone package breaks both paths unless the engine files and presets travel
with the package.

### What must travel with the package

| Source in repo | Type | Why needed |
|---|---|---|
| `public/lib/cost-engine.js` | CJS/UMD | arithmetic |
| `public/lib/prices.js` | CJS/UMD | price book |
| `public/lib/headline-math.js` | CJS/UMD | headline + AE rollup |
| `public/lib/build-opts.js` | CJS/UMD | opts assembly |
| `public/lib/workload-hash.js` | CJS/UMD | share-link codec |
| `public/examples/*.json` | JSON | 18 presets |
| `mcp/server.mjs` | ESM | MCP entry point |
| `mcp/lib/*.mjs` | ESM | engine-bridge, validate, presets, etc. |
| `mcp/instructions.md` | text | server instructions |
| `mcp/prompts/cost-interview.md` | text | named MCP prompt |

The key constraint: **the engine modules must be the exact bytes from the repo**,
not re-typed, not transpiled away, and not forked. If a file in `public/lib/`
changes (new model, new price update), a new package version must ship those
updated files.

---

## 4. Packaging options

### Option A — Published npm package (recommended)

Publish a package named `@ajinkya/cost-calc-mcp` (or `cost-calc-mcp` unscoped
— see Open Decisions §8.1) to the npm registry. The package includes a copy of
the engine files and presets under a stable internal path. The `bin` field
points to a thin entry script that launches `server.mjs`.

**Install one-liners:**
```bash
# Claude Code
claude mcp add cost-calc -- npx -y @ajinkya/cost-calc-mcp

# Cursor (.cursor/mcp.json)
{ "mcpServers": { "cost-calc": { "command": "npx", "args": ["-y", "@ajinkya/cost-calc-mcp"] } } }

# Claude Desktop (claude_desktop_config.json)
{ "mcpServers": { "cost-calc": { "command": "npx", "args": ["-y", "@ajinkya/cost-calc-mcp"] } } }
```

**How the engine travels:** A `prepare` (or named `build`) npm script runs
before publish and copies `public/lib/{cost-engine,prices,headline-math,build-opts,workload-hash}.js`
and `public/examples/*.json` into a `dist/` subtree inside the package. The
engine-bridge path rewrite points to `../dist/lib/` and `../dist/examples/`
instead of `../../public/lib/` and `../../public/examples/`. See §6 for the
exact layout.

**Tradeoffs:**
- npx resolves the version from the registry, so installs are reproducible and
  pinnable (`npx -y @ajinkya/cost-calc-mcp@1.2.0`).
- The user gets standard `npm update` semantics.
- Requires an npm account, registry publication, and deliberate version bumps.
- The copy-at-build step is a new workflow step that must not be forgotten on
  publish.

### Option B — `npx github:ajinkyakulkarni/ai-cost-calculator-studio`

Run directly from the GitHub repo, pointing at the `feat/cost-mcp` branch (or a
git tag). npx downloads the tarball, installs deps, and runs the `bin` entry.

```bash
claude mcp add cost-calc -- npx -y github:ajinkyakulkarni/ai-cost-calculator-studio#v1.0.0
```

**Tradeoffs:**
- Zero registry setup. Works immediately from the branch.
- The repo's existing layout is preserved — no path rewriting needed, since
  `public/lib/` and `public/examples/` ship as part of the tarball (they are
  not `.gitignored`).
- But the package name is the monolith repo name, not a focused MCP package.
  The downloaded tarball is larger (the entire repo is included unless
  `.npmignore` is tightly trimmed).
- No stable `npx cost-calc-mcp` short name without a registry entry.
- Version pinning ties to git refs, not semver. If the repo is renamed, the
  install command breaks.
- `npm install` during `npx` runs from HEAD unless pinned to a tag, which is
  a latent footgun.
- **Not recommended** for distribution to external users.

### Option C — Bundled single-file artifact

Use esbuild (or rollup) to bundle the entire server — ESM server, lib files,
CJS engine modules, preset JSON, prompt text — into one `server.cjs` file.
Publish that as the package entry. No runtime file reads; everything is inlined.

**Tradeoffs:**
- Simplest install artifact; a single file.
- Eliminates `require()` path issues completely.
- But: esbuild cannot inline binary reads of `instructions.md` and
  `cost-interview.md` without explicit asset handling (the files are read at
  startup via `fs.readFileSync`). Either the text is embedded as JS string
  literals (lossy tooling) or the build step must copy those files alongside
  the bundle anyway, partially defeating the single-file benefit.
- The CJS/UMD engine modules use `(function(root, factory){...})(self, ...)`,
  which bundles fine, but the result mixes UMD patterns into an ESM bundle in
  a non-obvious way — a future engine change could silently break the bundle if
  the UMD wrapper changes.
- Parity testing becomes harder: the test suite imports lib files individually;
  a bundled artifact requires a separate test-via-subprocess path.
- **Not recommended** for v1. The copy-at-build approach (Option A) is simpler
  to audit and easier to keep in sync.

### Recommendation: Option A

Publish `@ajinkya/cost-calc-mcp` to npm. The copy-at-build step (run as the
`prepare` script) keeps the engine files in sync at the moment of publish. The
path rewrite is the only change to the server lib files. This gives external
users standard npx install UX, reproducible version pinning, and a clear
release discipline.

---

## 5. Package layout

```
@ajinkya/cost-calc-mcp/
  package.json
  bin/
    cost-calc-mcp.js      ← thin shim: #!/usr/bin/env node; import('../mcp/server.mjs')
  mcp/
    server.mjs            ← unchanged from repo (URL-relative reads work)
    instructions.md
    lib/
      engine-bridge.mjs   ← ONE line changes: require path → '../dist/lib/...'
      presets.mjs         ← ONE line changes: DIR path → '../dist/examples'
      compute.mjs         ← unchanged
      validate.mjs        ← unchanged
      format.mjs          ← unchanged
      sharelink.mjs       ← ONE line changes: require path → '../dist/lib/...'
      workload-schema.mjs ← unchanged
    prompts/
      cost-interview.md
  dist/
    lib/
      cost-engine.js      ← copied from public/lib/ at build time
      prices.js
      headline-math.js
      build-opts.js
      workload-hash.js
    examples/
      *.json              ← copied from public/examples/ at build time
```

The `dist/` subtree is **generated** (not committed to the repo). It is
produced by the `prepare` script and included in the published tarball via the
`files` field in `package.json`. The `dist/` directory should be in
`.gitignore`.

### `package.json` shape (illustrative)

```json
{
  "name": "@ajinkya/cost-calc-mcp",
  "version": "1.0.0",
  "description": "MCP server for the AI Cost Calculator — byte-identical to calc.ajinkya.ai",
  "type": "module",
  "bin": {
    "cost-calc-mcp": "bin/cost-calc-mcp.js"
  },
  "engines": { "node": ">=18" },
  "files": [
    "bin/",
    "mcp/",
    "dist/"
  ],
  "scripts": {
    "prepare": "node scripts/copy-engine.mjs",
    "test": "npm run mcp:test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.0.0"
  }
}
```

Notes:
- `"type": "module"` — the server is ESM-native. The bin shim must either use
  `.cjs` extension or an async `import()` wrapper for compatibility with older
  npx invocations (see Open Decisions §8.2).
- `zod` is already an implicit transitive dep; make it explicit so lockfiles
  are deterministic.
- `devDependencies` (playwright, wrangler, etc.) are NOT included; the package
  ships no dev tooling.

### `scripts/copy-engine.mjs` (the build step)

A small Node script that:
1. Reads `public/lib/{cost-engine,prices,headline-math,build-opts,workload-hash}.js`
   from the repo root.
2. Writes them verbatim to `dist/lib/`.
3. Reads `public/examples/*.json`.
4. Writes them verbatim to `dist/examples/`.

"Verbatim" is intentional: no transpilation, no mangling. The engine files are
CJS/UMD and must remain exactly as-is so the `createRequire` call in
`engine-bridge.mjs` loads them identically to the browser.

The script exits non-zero if any source file is missing, so `npm publish`
fails loudly rather than publishing a broken package.

---

## 6. Path rewriting in lib files

Three lib files reference paths that must change. The changes are minimal and
mechanical:

| File | Current path | Packaged path |
|---|---|---|
| `engine-bridge.mjs` | `require('../../public/lib/cost-engine.js')` | `require('../dist/lib/cost-engine.js')` |
| `engine-bridge.mjs` | same pattern for prices, headline-math, build-opts | same pattern under `dist/lib/` |
| `presets.mjs` | `path.resolve(new URL('../../public/examples', ...))` | `path.resolve(new URL('../dist/examples', ...))` |
| `sharelink.mjs` | `require('../../public/lib/workload-hash.js')` | `require('../dist/lib/workload-hash.js')` |

The in-repo copies of these files keep their current `../../public/...` paths
(so `npm run mcp:test` continues to work in the repo). The packaged copies have
the rewritten paths.

**Implementation approach (two viable sub-options — see Open Decisions §8.3):**
- Sub-option A1: Maintain two sets of files — `mcp/lib/` (repo paths) and
  `mcp-pkg/lib/` (packaged paths), with the `copy-engine.mjs` script producing
  the `dist/` payload and a separate `pkg/` directory for the patched lib files.
- Sub-option A2: Apply the path rewrite in `copy-engine.mjs` at publish time
  (sed/string-replace on the lib files). One source of truth for the logic;
  the rewrite is a literal string substitution and is easy to audit.

Sub-option A2 is simpler to maintain (no drift between two copies of the lib
files) but adds a small moving part to the build script.

---

## 7. Versioning strategy

**Package version = engine snapshot version.** The `@ajinkya/cost-calc-mcp`
version must reflect which engine/prices snapshot it was built from, so a user
can reason about whether the package tracks the live site.

**Scheme:** `{engine-major}.{engine-minor}.{mcp-patch}`
- `engine-major` bumps when the workload schema or engine output shape changes
  incompatibly (a new required field, a renamed breakdown key).
- `engine-minor` bumps when prices are updated or new presets are added
  (compatible but meaningfully different numbers).
- `mcp-patch` bumps for MCP server changes only (new tool, prompt edit,
  packaging fix) with no engine change.

**Release process (manual, v1):**
1. Engine/prices/presets are updated in `public/lib/` and `public/examples/`
   on the main repo branch.
2. A human bumps the version in `package.json` following the scheme above.
3. Run `npm run prepare` (verifies the build), `npm run test` (runs `mcp:test`
   against the dist-patched layout — see §8), then `npm publish --access public`.

**Staleness risk:** a published package with old prices gives wrong numbers but
no error. Mitigation: the `list_presets` and `compute_cost` responses could
include the `prices_as_of` metadata from `prices.js` (if present) so the
LLM/user can see which price snapshot they're on. This is a recommended v1.1
addition.

**Relationship to the live site:** calc.ajinkya.ai serves `prices.js` directly.
The npm package ships a snapshot. They diverge the moment prices are updated on
the site without a new package publish. This is a known, accepted tradeoff for
v1 — the alternative (fetching prices from the live site at runtime) introduces
a network dependency that is out of scope here.

---

## 8. Install UX (exact one-liners)

### Claude Code

```bash
claude mcp add cost-calc -- npx -y @ajinkya/cost-calc-mcp
```

npx downloads and caches the package on first run. Subsequent runs reuse the
cache. The user never sees the `dist/` or `mcp/` internals.

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "cost-calc": {
      "command": "npx",
      "args": ["-y", "@ajinkya/cost-calc-mcp"]
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "cost-calc": {
      "command": "npx",
      "args": ["-y", "@ajinkya/cost-calc-mcp"]
    }
  }
}
```

### Version-pinned install (reproducible, production-like)

```bash
claude mcp add cost-calc -- npx -y @ajinkya/cost-calc-mcp@1.2.0
```

### `mcp/README.md` update

The existing README shows an absolute local path. The published package's
README replaces the install block with the one-liner above. The repo's
`mcp/README.md` (the developer-facing one) keeps both: the local `node` command
for repo contributors and the `npx` one-liner for consumers.

---

## 9. Tests and acceptance

### 9.1 Existing `mcp:test` suite (unchanged semantics)

The 8-suite `npm run mcp:test` continues to run from the repo against the
in-repo layout (`../../public/lib/`, `../../public/examples/`). These tests must
stay green at all times. They are the definition of correct behavior.

### 9.2 Packaged-artifact test (new)

A new script `scripts/test-packaged.sh` (or `.mjs`) runs after `prepare` and
before `npm publish`:

1. `npm pack --dry-run` to verify the `files` field includes everything needed.
2. `npm pack` → produces `ajinkya-cost-calc-mcp-{version}.tgz`.
3. In a temp directory: `npm install /abs/path/ajinkya-cost-calc-mcp-{version}.tgz`.
4. From that temp dir, run the parity test and the protocol test against the
   installed package (pointing `node` at `node_modules/@ajinkya/cost-calc-mcp/mcp/server.mjs`
   or via the bin entry).
5. Assert the parity results match the in-repo `mcp:test` parity results
   (identical headlines for all presets that pass the gate).

This test catches path-rewrite bugs (a missing file in `dist/`, a wrong path)
before the package reaches the registry.

### 9.3 Engine identity check (new)

The `copy-engine.mjs` build step (or a companion `scripts/test-engine-identity.mjs`)
computes a SHA-256 of each `dist/lib/*.js` file and each `public/lib/*.js`
source and asserts they are identical. This is the machine check that the
package has not forked the engine. Run it as part of the packaged-artifact test.

### 9.4 parity test (existing, extended)

`mcp/test/test-parity.mjs` already asserts `computeCost(preset) == computeWorkload(preset)`
for all 18 presets. In the packaged-artifact test environment (§9.2), run
`test-parity.mjs` against the installed package. If the count or headlines
diverge from the repo run, the publish is blocked.

### 9.5 Acceptance smoke

After `npm publish` (or before, using `npm link`), the manual acceptance is:
```bash
claude mcp add cost-calc-pkg -- npx -y @ajinkya/cost-calc-mcp
# In Claude Code: run cost_interview; pick the archetype-agent-demo preset;
# confirm the headline matches calc.ajinkya.ai for that workload.
```

---

## 10. Dependency on workstream #1

The workload-authoritative opts fix (`2026-06-28-workload-authoritative-opts-spec.md`)
must be merged before packaging. Specifically:

- `public/lib/build-opts.js` must include `retry_rate: (w.anchor_query && w.anchor_query.retry_rate != null) ? w.anchor_query.retry_rate : 0` before the file is snapshotted into `dist/lib/`.
- If the package is published before workstream #1, the packaged engine will
  have the UI/MCP gap (~4.5% retry divergence for the archetype demo), and the
  share-link consistency guarantee will not hold.
- The packaged-artifact parity test (§9.2) exercises only `computeCost == computeWorkload`
  (internal consistency); it does NOT catch the UI/MCP gap. The Playwright
  consistency test from workstream #1 (UI headline == MCP headline via share-link)
  is the guard for that class of bug.

**The package should not be published until workstream #1 tests are green.**

---

## 11. Relationship to workstream #3 (remote Worker)

Workstream #3 is a Cloudflare Worker that exposes the same tools over HTTP/SSE
for clients that cannot run a local process (e.g., web-based Claude clients).
Both the packaged npm server and the remote Worker must use the same engine
modules and presets. The design for #3 should reference `dist/lib/` as a
canonical location (or re-use the `copy-engine.mjs` build step) to ensure
all three surfaces — repo, npm package, Worker — track the same engine snapshot.
This is a design decision for the workstream #3 spec; it is noted here as a
constraint so the #2 layout does not inadvertently foreclose it.

---

## 12. Open decisions

**8.1 Package name: scoped vs unscoped**

`@ajinkya/cost-calc-mcp` (scoped, public) requires `npm publish --access public`
on first publish and ties the namespace to a user scope. `cost-calc-mcp`
(unscoped) is simpler to type but requires the name to be available on the
public registry. A fully namespaced name like `ajinkya-cost-calc-mcp` is
unscoped but carries the author. Decision needed: which name, and is scoped
acceptable for the target user base (adding `@` to the npx command is a minor
friction point for non-npm-native users)?

**8.2 Bin shim: `import()` wrapper vs `.cjs` entry**

`"type": "module"` in package.json makes all `.js` files ESM, which is correct
for the server. But the `bin` entry must be runnable by `npx` in all Node >=18
environments. Some older npx versions have edge cases with ESM bin entries.
Two options:
- A `bin/cost-calc-mcp.cjs` shim that does
  `require('@ajinkya/cost-calc-mcp/mcp/server.mjs')` — but CJS cannot
  `require` an ESM module directly; would need a dynamic `import()` inside an
  async wrapper, which adds a microtask delay.
- A `bin/cost-calc-mcp.js` that is treated as ESM (because `type:module`) and
  simply `import`s the server — cleaner, but requires verifying that npx
  handles ESM bin entries reliably in the target Node versions.
Decision: which bin pattern, and test it on Node 18 LTS and Node 20 LTS.

**8.3 Path rewrite strategy: two-copy vs build-time rewrite**

The lib files reference `../../public/lib/` in the repo and `../dist/lib/` in
the package. Two approaches:
- **Two-copy:** keep `mcp/lib/` (repo) and a `pkg/mcp/lib/` (package) with
  the rewritten paths. The `copy-engine.mjs` assembles the package from the
  patched copy. Clear separation; no build-time mutation. But two copies of
  the same logic must be kept in sync.
- **Build-time rewrite:** `copy-engine.mjs` reads `mcp/lib/*.mjs`, does a
  string replacement (`'../../public/lib/'` → `'../dist/lib/'`, etc.),
  and writes the result to `pkg/mcp/lib/`. Single source of truth; the rewrite
  is one literal string substitution and easy to audit. Slightly more magic in
  the build step.
Decision: which approach — and if build-time rewrite, is the string
substitution robust enough (are there any other `../../public/` references in
the lib files that should NOT be rewritten)?

**8.4 `prepare` vs a named `prebuild`/`build` script**

npm's `prepare` hook runs on `npm install` (not just `npm publish`), which
means contributors cloning the repo get `dist/` generated automatically. This
is arguably convenient but also means the build runs on every `npm ci` in CI.
Alternative: a named `npm run build` that must be run explicitly before publish.
Decision: which lifecycle hook to use.

**8.5 Preset sync cadence**

Presets (`public/examples/*.json`) change whenever a new workload archetype is
added or an existing one is updated. The package snapshot freezes them at
publish time. Should the package version bump (and release) be triggered by a
preset-only change? A price-only change? Or only by an engine or MCP tool
change? This affects the `engine-minor` vs `mcp-patch` boundary in the
versioning scheme (§7).

**8.6 `prices_as_of` metadata exposure**

`public/lib/prices.js` may or may not carry a `prices_as_of` timestamp (this
should be verified in the actual file). If it does, surfacing that field in
`compute_cost` output and in `list_presets` would let users know they are
running on a stale price snapshot. Decision: add this field to the output
schema in v1, or defer to v1.1?

---

## 13. Risks

**Engine drift (primary risk):** The `dist/` snapshot is a copy. If `public/lib/`
is updated (prices, model list, new engine feature) and the package is not
republished, users get stale numbers with no warning. Mitigation: make the
release checklist explicit; consider adding a `--check-engine` CI job that
compares `dist/lib/` SHA-256 against the current `public/lib/` files and
opens an issue if they diverge.

**The engine copy is not a fork.** The spec explicitly prohibits editing
anything inside `dist/`. If a developer edits `dist/lib/cost-engine.js` to
"fix" a bug, the next `npm run prepare` silently overwrites their change.
This is a feature, not a bug: `dist/` is generated. The tooling comment header
should say so.

**CJS/ESM boundary.** The engine files are CJS/UMD globals; the server is ESM.
The `createRequire` bridge already handles this in the repo. As long as Node's
module resolution finds the CJS files in `dist/lib/`, the bridge works.
Risk: if a future engine file uses ESM `export` syntax, `createRequire` will
throw. This is an engine design risk, not a packaging risk — but the packager
should be aware.

**npx caching.** By default, `npx -y` caches the package and does not re-fetch
on subsequent runs unless the version changes. Users who install `@latest` will
not get price updates until a new version is published AND they clear their
npx cache (or pin a new version). This is expected behavior but should be
documented in the README.

**Registry availability.** npm registry outages are rare but real. The repo
install path (`node /abs/path/mcp/server.mjs`) remains the fallback for
developers; the README should document both.

**Bundler risk (if Option C is reconsidered).** The CJS UMD wrapper
`(function(root, factory){ ... })(self, ...)` in the engine modules references
`self` for browser globals. In a Node bundle without a `self` polyfill, this
evaluates to `undefined` (globalThis would be the correct target). The existing
`createRequire` path bypasses this entirely, which is why Option A (copy) is
safer than Option C (bundle).

---
## Decisions locked (2026-06-28, user)
- **Package name:** `@ajinkyakulkarni/cost-calc-mcp` (scoped to npm account https://www.npmjs.com/~ajinkyakulkarni). Install: `npx -y @ajinkyakulkarni/cost-calc-mcp`.
- **Sequencing:** consistency fix #1 merged to `main` first (done, commit 5b60e8a) — implement packaging against `main`.
