#!/usr/bin/env node
/* test-packaged.mjs — acceptance test for the @ajinkyakulkarni/cost-calc-mcp tarball.
 *
 * Runs after `npm run build` in npm-package/. Checks:
 *   1. SHA-256 identity: dist/lib/*.js bytes match public/lib/*.js
 *   2. Headline parity: packaged engine produces the same headline as the repo
 *      engine for all 18 presets (archetype-agent-demo must equal 45070).
 *   3. Protocol smoke: MCP server starts, lists 6 tools + cost_interview prompt,
 *      compute_cost returns headline > 0.
 *
 * The packaged artifact must be built first:
 *   cd npm-package && npm run build && npm pack
 *
 * Usage (from repo root):
 *   node scripts/test-packaged.mjs [/abs/path/to/tarball.tgz]
 *
 * If no tarball path is supplied, the script looks for
 *   npm-package/ajinkyakulkarni-cost-calc-mcp-*.tgz
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(new URL('..', import.meta.url).pathname);
const PKG_DIR_SRC = path.join(REPO, 'npm-package');

// ── locate tarball ────────────────────────────────────────────────────────────

let tarball = process.argv[2];
if (!tarball) {
  const tarballs = fs.readdirSync(PKG_DIR_SRC)
    .filter(f => f.startsWith('ajinkyakulkarni-cost-calc-mcp-') && f.endsWith('.tgz'))
    .map(f => path.join(PKG_DIR_SRC, f));
  if (tarballs.length === 0) {
    console.error('No tarball found. Run: cd npm-package && npm pack');
    process.exit(1);
  }
  // pick the most recently created
  tarball = tarballs.sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime)[0];
}
tarball = path.resolve(tarball);
if (!fs.existsSync(tarball)) {
  console.error('Tarball not found:', tarball);
  process.exit(1);
}
console.log('Testing tarball:', tarball);

// ── install into temp dir ─────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-calc-mcp-test-'));
console.log('Installing into:', tmpDir);

const installResult = spawnSync('npm', ['install', tarball], {
  cwd: tmpDir, stdio: 'pipe', encoding: 'utf8',
});
if (installResult.status !== 0) {
  console.error('npm install failed:', installResult.stderr);
  process.exit(1);
}

const PKG = path.join(tmpDir, 'node_modules', '@ajinkyakulkarni', 'cost-calc-mcp');

// ── helpers ───────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function ok(label, cond) {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`);
}

function sha256file(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ── 1. SHA-256 identity ───────────────────────────────────────────────────────

console.log('\n=== 1. Engine file identity (SHA-256) ===');
const ENGINE_FILES = ['cost-engine.js', 'prices.js', 'headline-math.js', 'build-opts.js', 'workload-hash.js'];
for (const f of ENGINE_FILES) {
  const srcHash = sha256file(path.join(REPO, 'public', 'lib', f));
  const dstHash = sha256file(path.join(PKG, 'dist', 'lib', f));
  ok(`${f} byte-identical`, srcHash === dstHash);
}

// ── 2. Headline parity via dynamic import ─────────────────────────────────────

console.log('\n=== 2. Headline parity (all 18 presets) ===');

// Import packaged modules
const { computeWorkload: pkgCompute }    = await import(path.join(PKG, 'mcp/lib/engine-bridge.mjs'));
const { loadPreset: pkgLoad, listPresets: pkgPresets } = await import(path.join(PKG, 'mcp/lib/presets.mjs'));
const { computeCost: pkgComputeCost }   = await import(path.join(PKG, 'mcp/lib/compute.mjs'));

// Import repo modules
const { computeWorkload: repoCompute }  = await import(path.join(REPO, 'mcp/lib/engine-bridge.mjs'));
const { loadPreset: repoLoad }          = await import(path.join(REPO, 'mcp/lib/presets.mjs'));

const KEY_PRESET = 'archetype-agent-demo';
const EXPECTED_KEY = 45070;

for (const { name } of pkgPresets()) {
  const pkgW    = pkgLoad(name);
  const repoW   = repoLoad(name);
  const pkgH    = Math.round(pkgCompute(pkgW).headline);
  const repoH   = Math.round(repoCompute(repoW).headline);
  const match   = pkgH === repoH;
  if (name === KEY_PRESET) {
    ok(`${name}: pkg=${pkgH} repo=${repoH} (must be ${EXPECTED_KEY})`, match && pkgH === EXPECTED_KEY);
  } else {
    ok(`${name}: pkg=${pkgH} repo=${repoH}`, match);
  }
}

// Also verify computeCost (tool layer) matches the key preset
const keyW    = pkgLoad(KEY_PRESET);
const toolH   = pkgComputeCost(keyW).headline_monthly_usd;
ok(`compute_cost tool layer: ${KEY_PRESET} == ${EXPECTED_KEY}`, toolH === EXPECTED_KEY);

// ── 3. Protocol smoke ─────────────────────────────────────────────────────────

console.log('\n=== 3. Protocol smoke (stdio MCP) ===');

// Write a small test script into tmpDir so it can use the installed node_modules
const smokeScript = path.join(tmpDir, '_smoke.mjs');
fs.writeFileSync(smokeScript, `
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

const PKG = ${JSON.stringify(PKG)};
const EXPECTED_HEADLINE = ${EXPECTED_KEY};

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log('  ' + (cond ? 'PASS' : 'FAIL') + ' ' + label); };

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(PKG, 'bin/cost-calc-mcp.js')],
});
const client = new Client({ name: 'test', version: '0' });
await client.connect(transport);

const EXPECTED_TOOLS = ['list_presets','load_preset','get_schema','validate_workload','compute_cost','make_share_link'];
const tools = (await client.listTools()).tools.map(t => t.name);
ok('6 tools listed', tools.length === 6 && EXPECTED_TOOLS.every(t => tools.includes(t)));

const prompts = (await client.listPrompts()).prompts.map(p => p.name);
ok('cost_interview prompt listed', prompts.includes('cost_interview'));

const w = JSON.parse(fs.readFileSync(path.join(PKG, 'dist/examples/archetype-agent-demo.json'), 'utf8'));
const res = await client.callTool({ name: 'compute_cost', arguments: { workload: w } });
const payload = JSON.parse(res.content[0].text);
ok('compute_cost headline > 0', payload.headline_monthly_usd > 0);
ok('compute_cost headline == ' + EXPECTED_HEADLINE, payload.headline_monthly_usd === EXPECTED_HEADLINE);

await client.close();

const results = JSON.stringify({ pass, fail });
process.stdout.write('SMOKE_RESULTS:' + results + '\\n');
process.exit(fail > 0 ? 1 : 0);
`, 'utf8');

const smokeResult = spawnSync('node', [smokeScript], { cwd: tmpDir, encoding: 'utf8' });
if (smokeResult.stdout) {
  for (const line of smokeResult.stdout.split('\n')) {
    if (line.startsWith('SMOKE_RESULTS:')) {
      const { pass: sp, fail: sf } = JSON.parse(line.slice('SMOKE_RESULTS:'.length));
      pass += sp; fail += sf;
    } else if (line.trim()) {
      console.log(line);
    }
  }
}
if (smokeResult.status !== 0 && !smokeResult.stdout.includes('SMOKE_RESULTS:')) {
  console.error('Protocol smoke subprocess failed:', smokeResult.stderr);
  fail += 1;
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Packaged artifact tests: ${pass} passed, ${fail} failed`);
console.log('Temp dir (for inspection):', tmpDir);

if (fail > 0) {
  console.error('\nPACKAGED PARITY: BLOCKED — do not publish.');
  process.exit(1);
} else {
  console.log('\nPACKAGED PARITY: OK — safe to publish.');
  process.exit(0);
}
