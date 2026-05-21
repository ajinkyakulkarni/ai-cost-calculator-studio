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
    // Workload-mode (no agents → no enabled_tools) → $0 external tool
    // fees. The geospatial deployment's geocoder/k8s cost is modeled as
    // fixed `infrastructure` line items, not metered tool fees.
    tool_fees: 0.00,
    note: 'Paper reference: validation report shows $1097.30/mo LLM-only API bill at default mix/cache.',
  },
  // Paired freeform anchor of the same deployment — public-geospatial-qa
  // with the freeform tool-return shape baked into the preset (anchor
  // input 22,798, cache 0.744, output held at the templated 41). Bundled
  // 2026-05-21 so the paper's freeform Table 7 row reproduces with no
  // manual anchor overrides — three reproducibility reviews in a row
  // mis-set one of the three freeform coordinates by hand. At the default
  // 10K-MAU worked-example scale this is the $8,222/mo freeform operating
  // point; set the public segment to 75,000 MAU for the $60,667/mo
  // Table 7 stress-test row. Computed against commit ffeada9 / v0.3.1.
  'public-geospatial-qa-freeform': {
    monthly_with_retry: 8221.83,
    // Workload-mode preset (no agents → no enabled_tools) → $0 tool fees,
    // same as the templated public-geospatial-qa entry above.
    tool_fees: 0.00,
    note: 'Freeform tool-return anchor (input 22,798 / cache 0.744); $8,222/mo LLM-only API bill at the 10K-MAU worked-example scale.',
  },
  // SWE-bench-class single-agent coder — 100 dev pilots, 1 task per
  // 3 days, 2 user-visible turns per task, 8× ReAct loop multiplier on
  // claude-opus-4.7 with 8K input / 2.5K output / 3K sysprompt.
  // Computed 2026-05-17 against commit 9a4b45c. 1,800 user-visible
  // queries/mo × $0.6628/query ≈ $1,193.04.
  // Re-pinned 2026-05-20: cost-engine now itemizes per-agent enabled_tools
  // (schema + return_shape-modulated result tokens) in perQueryCostAgents.
  // +0.86% from the pre-itemization $1,193.04.
  'swe-bench-coding-agent': {
    monthly_with_retry: 1203.34,
    tool_fees: 135.90,
    note: '100 devs × 0.3 sess/day × 30 × 2 q/sess = 1800 queries; 8× ReAct loop on Opus-4.7.',
  },
  // 3-agent customer-support fleet — 20K auth + 5K anon MAU, mixed
  // sessions/day reflecting auth multi-turn + anon spike patterns.
  // Triage on gpt-5-mini, KB-Lookup + Responder on claude-sonnet-4.6
  // with KB-Lookup activation_rate 0.85. Exercises per-agent task_bias
  // (Triage=classify, KB-Lookup=rag, Responder=summary) — realistic
  // character per agent: Triage emits short labels (~0.72× output),
  // KB-Lookup retrieves+grounds (~0.90× output), Responder writes a
  // paragraph reply (~0.83× output).
  //
  // Re-baked 2026-05-19 against commit 80c084d. The 2026-05-18 EXPECTED
  // ($18,474.23) was set using forced override opts (model=gpt-5.2,
  // mix=mixed, cacheRate=0.7, verifCoverage=0) instead of the preset's
  // actual defaults (claude-sonnet-4.6 / mix=default / cacheRate=0.65
  // / verifCoverage=1.0). buildOpts() in this script uses the preset
  // defaults — that's what the UI passes too — so the test was drifting
  // 3.5% within tolerance but on a wrong baseline. Re-pinned to the
  // engine's actual output under the preset's own defaults.
  // Re-pinned 2026-05-20 (tool itemization): +2.05% from $19,116.21 — the
  // 3 agents' enabled_tools (crm_lookup, file_search, web_search,
  // ticketing_mcp) now contribute schema + result tokens to the bill.
  'customer-support-fleet': {
    monthly_with_retry: 19508.90,
    tool_fees: 3766.50,
    note: '20K auth + 5K anon MAU; 3-agent Triage(classify)/KB-Lookup(rag)/Responder(summary) on sonnet-4.6 with MiniCheck verifier @ 100% coverage. Per-agent task_bias exercise.',
  },
  // Voice support agent (Sierra / Bland-class) — 50K customers, ~4%
  // call rate, 12-turn avg call → 720K voice turns/mo. One LLM call
  // per turn on claude-sonnet-4.6 with 70% cache. STT/TTS billed
  // separately via tool fees (added by app.js, not in LLM-only
  // baseline). Computed 2026-05-17 against commit ac76812.
  // Re-pinned 2026-05-20 (tool itemization): +1.24% from $7,516.80.
  'voice-support-agent': {
    monthly_with_retry: 7610.15,
    tool_fees: 7056.00,
    note: '50K customers × 0.04 sess/day × 30 × 12 q/sess = 720K voice turns; sonnet-4.6 with 70% cache. STT/TTS fees billed via the engine tool-fee path (computeToolFees).',
  },
  // Legal-tech RAG (Harvey / Spellbook-class) — 50-attorney firm,
  // 2-agent Retriever (sonnet, ReAct 1.5×) → Drafter (opus-4.7 with
  // FR2 cascade at 20% escalate). cache_eligible=false (each case
  // query unique). Computed 2026-05-17 against commit ac76812.
  // Re-pinned 2026-05-20 (tool itemization): +19.84% from $1,628.44 — the
  // largest shift, because the Retriever agent's enabled_tools are
  // result-heavy (file_search at 1,200 result tokens/call) and the
  // workload runs cache_eligible=false, so every tool-return token is
  // billed uncached.
  'legal-tech-rag': {
    monthly_with_retry: 1951.55,
    tool_fees: 6574.50,
    note: '50 attorneys × 1.5 sess/day × 30 × 3 q/sess = 6,750 queries; 2-agent Retriever/Drafter, opus-4.7 on Drafter, FR2 cascade @ 20% escalate.',
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
console.log('  Reads `api.monthly_with_retry` and `tool_fees.monthly` from CostEngine.compute().');
console.log('');

let allPass = true;
const rows = [];

// Drift check that tolerates an expected value of exactly 0 — the
// workload-mode presets carry $0 tool fees, where percentage drift is
// undefined; fall back to a near-zero absolute check there.
function checkDrift(actual, expected) {
  if (expected === 0) return { drift: 0, pass: Math.abs(actual) < 0.01 };
  const drift = (actual - expected) / expected;
  return { drift, pass: Math.abs(drift) <= TOLERANCE_PCT };
}

for (const slug of Object.keys(EXPECTED)) {
  const expected = EXPECTED[slug];
  let api = null, apiChk = null, tf = null, tfChk = null, err = null;

  try {
    const w = loadPreset(slug);
    const opts = buildOpts(w);
    const r = CostEngine.compute(w, opts);
    api = r.api && r.api.monthly_with_retry;
    if (typeof api !== 'number' || !Number.isFinite(api)) {
      throw new Error('api.monthly_with_retry not finite (got ' + api + ')');
    }
    apiChk = checkDrift(api, expected.monthly_with_retry);
    tf = (r.tool_fees && r.tool_fees.monthly) || 0;
    tfChk = checkDrift(tf, expected.tool_fees);
  } catch (e) {
    err = e;
  }

  const pass = !err && apiChk.pass && tfChk.pass;
  if (!pass) allPass = false;
  rows.push({ slug, err, pass, note: expected.note,
    api, apiExpected: expected.monthly_with_retry, apiChk,
    tf, tfExpected: expected.tool_fees, tfChk });
}

// Report
for (const row of rows) {
  const tag = row.pass ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${row.slug}`);
  if (row.err) {
    console.log('       ERROR     = ' + row.err.message);
  } else {
    console.log('       LLM api   = ' + fmtUsd(row.api) + '  (expected ' + fmtUsd(row.apiExpected)
                + ', drift ' + (row.apiChk.drift >= 0 ? '+' : '') + pct(row.apiChk.drift) + ')'
                + (row.apiChk.pass ? '' : '  <- FAIL'));
    console.log('       tool fees = ' + fmtUsd(row.tf) + '  (expected ' + fmtUsd(row.tfExpected)
                + ', drift ' + (row.tfChk.drift >= 0 ? '+' : '') + pct(row.tfChk.drift) + ')'
                + (row.tfChk.pass ? '' : '  <- FAIL'));
  }
  console.log('       note      = ' + row.note);
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
