#!/usr/bin/env node
/* copy-engine.mjs — build script for @ajinkyakulkarni/cost-calc-mcp.
 *
 * Assembles the npm-package/ directory from repo sources so the published
 * tarball is self-contained (no clone required). Run before npm publish.
 *
 * What it does:
 *   1. Copies public/lib/*.js (engine, prices, headline-math, build-opts,
 *      workload-hash) verbatim into npm-package/dist/lib/.
 *   2. Copies public/examples/*.json (all presets) into npm-package/dist/examples/.
 *   3. Copies mcp/lib/*.mjs into npm-package/mcp/lib/ with path rewrites for
 *      the three files that reference ../../public/ (engine-bridge, presets,
 *      sharelink).
 *   4. Copies mcp/server.mjs, mcp/instructions.md, mcp/prompts/cost-interview.md
 *      verbatim.
 *   5. Verifies SHA-256 of each dist/lib/*.js against its public/lib/ source
 *      (byte-identity check — the engine must not be forked or mangled).
 *
 * dist/ is generated output. Do NOT hand-edit files under npm-package/dist/.
 * The next run of this script overwrites them.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

// Resolve relative to this script's location (scripts/ is one level below repo root)
const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const PKG  = path.join(REPO, 'npm-package');

// ── helpers ───────────────────────────────────────────────────────────────────

function copyVerbatim(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyWithRewrite(src, dst, rewrites) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let text = fs.readFileSync(src, 'utf8');
  for (const [from, to] of rewrites) {
    text = text.replaceAll(from, to);
  }
  fs.writeFileSync(dst, text, 'utf8');
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertExists(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`ERROR: missing required source file: ${label} (${p})`);
    process.exit(1);
  }
}

// ── 1. Engine modules: public/lib/*.js → dist/lib/ ───────────────────────────

const ENGINE_FILES = [
  'cost-engine.js',
  'prices.js',
  'headline-math.js',
  'build-opts.js',
  'workload-hash.js',
];

const distLib = path.join(PKG, 'dist', 'lib');
fs.mkdirSync(distLib, { recursive: true });

console.log('Copying engine modules...');
for (const f of ENGINE_FILES) {
  const src = path.join(REPO, 'public', 'lib', f);
  const dst = path.join(distLib, f);
  assertExists(src, `public/lib/${f}`);
  copyVerbatim(src, dst);
  console.log(`  copied public/lib/${f} → dist/lib/${f}`);
}

// ── 2. Presets: public/examples/*.json → dist/examples/ ──────────────────────

const distExamples = path.join(PKG, 'dist', 'examples');
fs.mkdirSync(distExamples, { recursive: true });

console.log('Copying presets...');
const examplesDir = path.join(REPO, 'public', 'examples');
assertExists(examplesDir, 'public/examples/');
const presetFiles = fs.readdirSync(examplesDir).filter(f => f.endsWith('.json'));
if (presetFiles.length === 0) {
  console.error('ERROR: no preset JSON files found in public/examples/');
  process.exit(1);
}
for (const f of presetFiles) {
  const src = path.join(examplesDir, f);
  const dst = path.join(distExamples, f);
  copyVerbatim(src, dst);
}
console.log(`  copied ${presetFiles.length} preset files → dist/examples/`);

// ── 3. MCP lib files: mcp/lib/*.mjs → mcp/lib/ with path rewrites ────────────
//
//  Three files reference ../../public/ and need path adjustments:
//    engine-bridge.mjs: ../../public/lib/ → ../dist/lib/
//    presets.mjs:       ../../public/examples → ../dist/examples
//    sharelink.mjs:     ../../public/lib/ → ../dist/lib/
//
//  The other lib files (compute, format, validate, workload-schema) have no
//  ../../public/ references and are copied verbatim.

// Path rewrite rationale:
//   In the repo,    mcp/lib/*.mjs is at depth 2 under repo root.
//   In the package, mcp/lib/*.mjs is at depth 2 under package root.
//   In the repo,    the engine files are at public/lib/ (2 levels up from mcp/lib/).
//   In the package, the engine files are at dist/lib/   (2 levels up from mcp/lib/).
//   So "../../public/lib/" → "../../dist/lib/" and
//      "../../public/examples" → "../../dist/examples"
//   This is a literal replacement of "public" with "dist" in the path segment.
const MCP_LIB_REWRITES = {
  'engine-bridge.mjs': [
    ["require('../../public/lib/cost-engine.js')",   "require('../../dist/lib/cost-engine.js')"],
    ["require('../../public/lib/headline-math.js')", "require('../../dist/lib/headline-math.js')"],
    ["require('../../public/lib/build-opts.js')",    "require('../../dist/lib/build-opts.js')"],
    ["require('../../public/lib/prices.js')",        "require('../../dist/lib/prices.js')"],
  ],
  'presets.mjs': [
    ["path.resolve(new URL('../../public/examples', import.meta.url).pathname)",
     "path.resolve(new URL('../../dist/examples', import.meta.url).pathname)"],
  ],
  'sharelink.mjs': [
    ["require('../../public/lib/workload-hash.js')", "require('../../dist/lib/workload-hash.js')"],
  ],
};

const pkgMcpLib = path.join(PKG, 'mcp', 'lib');
fs.mkdirSync(pkgMcpLib, { recursive: true });

console.log('Copying mcp/lib files...');
const libDir = path.join(REPO, 'mcp', 'lib');
const libFiles = fs.readdirSync(libDir).filter(f => f.endsWith('.mjs'));
for (const f of libFiles) {
  const src = path.join(libDir, f);
  const dst = path.join(pkgMcpLib, f);
  const rewrites = MCP_LIB_REWRITES[f] || [];
  if (rewrites.length > 0) {
    copyWithRewrite(src, dst, rewrites);
    console.log(`  rewrite  mcp/lib/${f}`);
    // Verify the rewrites actually landed (no stale ../../public/ remaining)
    const result = fs.readFileSync(dst, 'utf8');
    if (result.includes('../../public/')) {
      console.error(`ERROR: unrewritten ../../public/ reference found in ${f} after rewrite`);
      process.exit(1);
    }
  } else {
    copyVerbatim(src, dst);
    console.log(`  verbatim mcp/lib/${f}`);
  }
}

// ── 4. MCP static files: server.mjs, instructions.md, prompts/ ───────────────

console.log('Copying mcp static files...');
const pkgMcp = path.join(PKG, 'mcp');

// server.mjs — URL-relative reads (./instructions.md, ./prompts/…) work because
// the file retains its position inside the package's mcp/ directory.
copyVerbatim(path.join(REPO, 'mcp', 'server.mjs'), path.join(pkgMcp, 'server.mjs'));
console.log('  copied mcp/server.mjs');

copyVerbatim(path.join(REPO, 'mcp', 'instructions.md'), path.join(pkgMcp, 'instructions.md'));
console.log('  copied mcp/instructions.md');

const pkgPrompts = path.join(pkgMcp, 'prompts');
fs.mkdirSync(pkgPrompts, { recursive: true });
copyVerbatim(
  path.join(REPO, 'mcp', 'prompts', 'cost-interview.md'),
  path.join(pkgPrompts, 'cost-interview.md'),
);
console.log('  copied mcp/prompts/cost-interview.md');

// ── 4b. Write a CommonJS sentinel in dist/lib/ ────────────────────────────────
//
//  The npm-package has "type":"module", which makes Node treat all .js files as
//  ESM. But the engine files (cost-engine.js, prices.js, …) are CJS/UMD that
//  use `module.exports`. A nested package.json with "type":"commonjs" overrides
//  the package-level setting for that subtree, restoring CJS semantics.
//  This file is NOT in public/lib/ (the repo has no "type":"module" at root, so
//  no sentinel is needed there). It is generated and ships in the tarball.

const cjsSentinel = path.join(distLib, 'package.json');
fs.writeFileSync(cjsSentinel, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n', 'utf8');
console.log('  wrote dist/lib/package.json (type: commonjs sentinel)');

// ── 5. SHA-256 identity check: dist/lib/*.js must be byte-identical to public/lib/*.js ──

console.log('Verifying engine file identity (SHA-256)...');
let identityFail = 0;
for (const f of ENGINE_FILES) {
  const srcHash = sha256(path.join(REPO, 'public', 'lib', f));
  const dstHash = sha256(path.join(distLib, f));
  if (srcHash !== dstHash) {
    console.error(`  IDENTITY FAIL ${f}: src ${srcHash} != dist ${dstHash}`);
    identityFail++;
  } else {
    console.log(`  OK ${f} (sha256: ${srcHash.slice(0, 16)}…)`);
  }
}
if (identityFail > 0) {
  console.error(`\nERROR: ${identityFail} engine file(s) failed identity check. Aborting.`);
  process.exit(1);
}

// ── done ──────────────────────────────────────────────────────────────────────

console.log(`\nBuild complete. npm-package/ is ready.`);
console.log(`  Engine files: ${ENGINE_FILES.length}`);
console.log(`  Preset files: ${presetFiles.length}`);
console.log(`  Lib files:    ${libFiles.length}`);
