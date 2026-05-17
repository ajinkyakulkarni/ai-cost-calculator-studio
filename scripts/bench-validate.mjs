#!/usr/bin/env node
/* =====================================================================
 * bench-validate.mjs — bench-validated preset regression suite
 *
 * cost-engine.js drives every public number on the calculator. Three of
 * the bundled presets are bench-validated (or modeled after published
 * bench traces) and their headline LLM-only API bill is a citable
 * artefact — if the engine drifts, the published number drifts with it
 * and we want CI to fail loudly.
 *
 * This script:
 *   1. Loads each validated preset via the same JSON-file path the
 *      browser uses.
 *   2. Builds the same `opts` shape the live UI passes
 *      (botFactor 1.5, cacheRate from anchor_query, verifCoverage from
 *      verification block).
 *   3. Calls CostEngine.compute(workload, opts) and reads
 *      `api.monthly_with_retry` (== monthly_capped when retry_rate is
 *      unset, which is the published-headline default).
 *   4. Asserts the actual is within ±5% of a hand-baked EXPECTED value.
 *      Each EXPECTED was computed once on the commit recorded in the
 *      comment beside it; any future engine change that moves the
 *      headline beyond ±5% fails this script.
 *   5. Exits 1 on any drift; 0 on all pass.
 *
 * Run with `node scripts/bench-validate.mjs` or `npm run bench:validate`.
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const require    = createRequire(import.meta.url);

const ENGINE_PATH   = path.resolve(__dirname, '..', 'public', 'lib', 'cost-engine.js');
const EXAMPLES_DIR  = path.resolve(__dirname, '..', 'public', 'examples');
const CostEngine    = require(ENGINE_PATH);

// ---------------------------------------------------------------------
// Expected headline values — `api.monthly_with_retry`, USD/mo,
// LLM-only API bill (before fixed/verif/federal/etc. additions from
// composeHeadline). Computed once on the commit recorded below; any
// future engine change that drifts these beyond ±TOLERANCE_PCT fails
// this script.
//
//   Computed: 2026-05-17 against commit 9a4b45c
//   Tolerance: ±5% (covers minor numerical reformulations; anything
//   bigger is a real semantic change worth a re-bake + re-publish.)
// ---------------------------------------------------------------------

const TOLERANCE_PCT = 0.05;  // ±5%

const EXPECTED = {
  // Paper reference number — matches the $1,097.30 LLM-only API bill
  // published in the public-geospatial-qa validation report. DO NOT
  // change this unless you're republishing the paper number.
  'public-geospatial-qa': {
    monthly_with_retry: 1097.30,
    note: 'Paper reference: validation report shows $1097.30/mo LLM-only API bill at default mix/cache.',
  },
  // SWE-bench-class single-agent coder — 100 dev pilots, 1 task per
  // 3 days, 2 user-visible turns per task, 8× ReAct loop multiplier on
  // claude-opus-4.7 with 8K input / 2.5K output / 3K sysprompt.
  // Computed 2026-05-17 against commit 9a4b45c. 1,800 user-visible
  // queries/mo × $0.6628/query ≈ $1,193.04.
  'swe-bench-coding-agent': {
    monthly_with_retry: 1193.04,
    note: '100 devs × 0.3 sess/day × 30 × 2 q/sess = 1800 queries; 8× ReAct loop on Opus-4.7.',
  },
  // 3-agent customer-support fleet — 20K auth + 5K anon MAU, mixed
  // sessions/day reflecting auth multi-turn + anon spike patterns.
  // Triage on gpt-5-mini, KB-Lookup + Responder on claude-sonnet-4.6
  // with KB-Lookup activation_rate 0.85. Computed 2026-05-17 against
  // commit 9a4b45c. 465K queries × ~$0.0460/query ≈ $21,369.96.
  'customer-support-fleet': {
    monthly_with_retry: 21369.96,
    note: '20K auth + 5K anon MAU; 3-agent Triage/KB-Lookup/Responder with MiniCheck verifier on Responder.',
  },
};

// ---------------------------------------------------------------------
// Engine invocation — mirrors the option shape used by the live UI and
// by scripts/test-engine-smoke.js so the numbers we compute here are
// the numbers users see.
// ---------------------------------------------------------------------

function loadPreset(slug) {
  const p = path.join(EXAMPLES_DIR, slug + '.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

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

function fmtUsd(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(x) {
  return (x * 100).toFixed(2) + '%';
}

// ---------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------

console.log('bench-validate.mjs — bench-validated preset regression suite');
console.log('  Tolerance: ±' + (TOLERANCE_PCT * 100).toFixed(0) + '%');
console.log('  Reads `api.monthly_with_retry` from CostEngine.compute() for each preset.');
console.log('');

let allPass = true;
const rows = [];

for (const slug of Object.keys(EXPECTED)) {
  const expected = EXPECTED[slug];
  let actual = null;
  let pass = false;
  let drift = null;
  let err = null;

  try {
    const w = loadPreset(slug);
    const opts = buildOpts(w);
    const r = CostEngine.compute(w, opts);
    actual = r.api && r.api.monthly_with_retry;
    if (typeof actual !== 'number' || !Number.isFinite(actual)) {
      throw new Error('api.monthly_with_retry not finite (got ' + actual + ')');
    }
    drift = (actual - expected.monthly_with_retry) / expected.monthly_with_retry;
    pass = Math.abs(drift) <= TOLERANCE_PCT;
  } catch (e) {
    err = e;
    pass = false;
  }

  if (!pass) allPass = false;
  rows.push({ slug, expected: expected.monthly_with_retry, actual, drift, pass, err, note: expected.note });
}

// Report
for (const row of rows) {
  const tag = row.pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${row.slug}`);
  console.log('       expected = ' + fmtUsd(row.expected) + '/mo');
  if (row.err) {
    console.log('       ERROR    = ' + row.err.message);
  } else {
    console.log('       actual   = ' + fmtUsd(row.actual) + '/mo');
    console.log('       drift    = ' + (row.drift >= 0 ? '+' : '') + pct(row.drift)
                + ' (tolerance ±' + pct(TOLERANCE_PCT) + ')');
  }
  console.log('       note     = ' + row.note);
  console.log('');
}

if (allPass) {
  console.log('All ' + rows.length + ' bench-validated presets within ±' + pct(TOLERANCE_PCT) + ' of expected.');
  process.exit(0);
} else {
  const failed = rows.filter(r => !r.pass).length;
  console.error('FAILED: ' + failed + '/' + rows.length + ' presets drifted beyond ±' + pct(TOLERANCE_PCT) + '.');
  console.error('If this drift is intentional, recompute and update EXPECTED in scripts/bench-validate.mjs.');
  process.exit(1);
}
