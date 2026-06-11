#!/usr/bin/env node
/* =====================================================================
 * dump-engine.mjs — dump CostEngine.compute() output for all presets
 *
 * For each preset in public/examples/, loads the workload exactly as
 * bench-validate.mjs does (same buildOpts pattern), calls compute(),
 * strips the `derivation` string (it has a timestamp), and writes the
 * full result to /tmp/engine-dumps/<preset>.json.
 *
 * Run: node scripts/dump-engine.mjs
 * Consumed by: python/parity_check.py
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const require    = createRequire(import.meta.url);

const ENGINE_PATH  = path.resolve(__dirname, '..', 'public', 'lib', 'cost-engine.js');
const EXAMPLES_DIR = path.resolve(__dirname, '..', 'public', 'examples');
const OUT_DIR      = '/tmp/engine-dumps';

const CostEngine = require(ENGINE_PATH);

// Exact same buildOpts as bench-validate.mjs
function buildOpts(w) {
  const d = w.defaults || {};
  return {
    hosting:       d.hosting       || 'api',
    model:         d.model         || 'gpt-5.2',
    tier:          d.tier          || 'standard',
    mix:           d.mix           || 'mixed',
    costMode:      d.cost_mode     || 'realistic',
    botFactor:     1.5,
    cacheRate:     (w.anchor_query && w.anchor_query.cache_rate_baseline != null)
                     ? w.anchor_query.cache_rate_baseline : 0.7,
    verifCoverage: (w.verification && w.verification.coverage) || 0,
  };
}

function stripNonFinite(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) return null;
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(stripNonFinite);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = stripNonFinite(v);
    }
    return out;
  }
  return obj;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const presets = fs.readdirSync(EXAMPLES_DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''));

let ok = 0, fail = 0;
for (const slug of presets) {
  const p = path.join(EXAMPLES_DIR, slug + '.json');
  try {
    const w = JSON.parse(fs.readFileSync(p, 'utf8'));
    const opts = buildOpts(w);
    const result = CostEngine.compute(w, opts);
    // Strip derivation string (has timestamp) and workload (too large, not needed)
    const { derivation, workload: _w, ...rest } = result;
    const cleaned = stripNonFinite(rest);
    // Also store the opts used so parity_check can verify it used the same
    cleaned._opts = opts;
    fs.writeFileSync(
      path.join(OUT_DIR, slug + '.json'),
      JSON.stringify(cleaned, null, 2)
    );
    console.log(`  OK  ${slug}`);
    ok++;
  } catch (e) {
    console.error(`FAIL  ${slug}: ${e.message}`);
    fail++;
  }
}

console.log(`\nDumped ${ok} presets to ${OUT_DIR}  (${fail} failed)`);
if (fail > 0) process.exit(1);
