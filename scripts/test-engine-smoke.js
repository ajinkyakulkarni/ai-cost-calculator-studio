#!/usr/bin/env node
/* =====================================================================
 * test-engine-smoke.js — cost-engine.js regression guard
 *
 * cost-engine.js is ~1500 lines of money math with no committed unit
 * tests. This script loads each bundled example preset, runs it through
 * the engine, and asserts core invariants. Run on every commit (and in
 * CI eventually) to catch silent engine regressions before they ship.
 *
 * Asserts:
 *   1. Every preset produces a finite, positive headline cost.
 *   2. result.queries.total matches the manual MAU-formula calculation
 *      from segments.
 *   3. Hosting multiplier behaves correctly: FedRAMP-High (1.30×) on the
 *      NASA preset produces ~30% higher api_capped than FedRAMP-None.
 *   4. Doubling MAU on a segment doubles queries/mo (linearity check).
 *   5. The headline math reconciles: api_capped + verif + federal +
 *      fixed + embeddings + personnel == result-derived total within
 *      rounding.
 *
 * Run with `node scripts/test-engine-smoke.js`. Exit code 0 = pass.
 * ===================================================================== */

'use strict';

const fs   = require('fs');
const path = require('path');

const ENGINE_PATH = path.resolve(__dirname, '..', 'public', 'lib', 'cost-engine.js');
const EXAMPLES_DIR = path.resolve(__dirname, '..', 'public', 'examples');
const CostEngine = require(ENGINE_PATH);

let passed = 0, failed = 0;
const fails = [];

function assert(cond, label) {
  if (cond) { passed++; process.stdout.write('.'); return true; }
  failed++; fails.push(label); process.stdout.write('F'); return false;
}

function loadPreset(slug) {
  const p = path.join(EXAMPLES_DIR, slug + '.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildOpts(w) {
  return {
    hosting: w.defaults?.hosting || 'api',
    model:   w.defaults?.model   || 'gpt-5.2',
    tier:    w.defaults?.tier    || 'standard',
    mix:     w.defaults?.mix     || 'mixed',
    costMode:w.defaults?.cost_mode || 'realistic',
    botFactor: 1.5,
    cacheRate: w.anchor_query?.cache_rate_baseline ?? 0.7,
    verifCoverage: w.verification?.coverage || 0,
  };
}

function headline(r, o, w) {
  const apiCapped = r.api?.monthly_capped || 0;
  const fixed = r.fixed_costs?.total || 0;
  const verif = r.verification?.monthly || 0;
  const fed = r.federal?.additive_total || 0;
  const emb = (r.embedding?.enabled ? r.embedding.monthly : 0) || 0;
  const pers = (r.personnel?.enabled ? r.personnel.monthly : 0) || 0;
  let llm;
  if (o.hosting === 'self') llm = r.self_host?.total || 0;
  else if (o.hosting === 'hybrid' && r.hybrid) llm = r.hybrid.total;
  else if (o.hosting === 'onprem') llm = parseFloat(w.on_prem_monthly) || 0;
  else if (r.reservation?.enabled) llm = r.reservation.effective_monthly;
  else llm = apiCapped;
  return llm + fixed + verif + fed + emb + pers;
}

const PRESETS = [
  'public-geospatial-qa',
  'doe-grid-modeling',
  'nih-clinical-trials',
  'noaa-storm-tracking',
  'generic-startup-chatbot',
  'health-patient-qa',
  'legal-discovery-agent',
  'finance-compliance-qa',
];

console.log('test-engine-smoke.js — running invariant checks on cost-engine.js\n');

// ── 1. Every preset produces a finite positive headline ─────────────
console.log('1. Every preset → finite positive headline cost');
for (const slug of PRESETS) {
  let w, r, h;
  try {
    w = loadPreset(slug);
    const o = buildOpts(w);
    r = CostEngine.compute(w, o);
    h = headline(r, o, w);
  } catch (e) {
    fails.push(`${slug}: engine threw — ${e.message}`);
    failed++; process.stdout.write('F');
    continue;
  }
  assert(Number.isFinite(h) && h > 0, `${slug}: headline finite + positive (got ${h})`);
  assert(Number.isFinite(r.queries.total) && r.queries.total > 0, `${slug}: queries.total finite + positive`);
}
console.log('');

// ── 2. Queries math: MAU × sessions × 30 × turns × bot ───────────────
console.log('2. Queries math matches MAU × sessions × 30 × turns × bot');
for (const slug of PRESETS) {
  const w = loadPreset(slug);
  const o = buildOpts(w);
  const r = CostEngine.compute(w, o);
  let manual = 0;
  for (const s of (w.segments || [])) {
    const beta = s.applyBotFactor ? (r.queries.botEffective || 1) : 1;
    manual += (s.mau || 0) * (s.sessions_per_day || 0) * 30 * (s.questions_per_session || 0) * beta;
  }
  const drift = Math.abs(r.queries.total - manual) / Math.max(1, manual);
  assert(drift < 0.001, `${slug}: queries math ±0.1% (engine=${Math.round(r.queries.total)}, manual=${Math.round(manual)}, drift=${(drift*100).toFixed(3)}%)`);
}
console.log('');

// ── 3. FedRAMP multiplier: High should produce ~30% higher per-query rate ─
console.log('3. FedRAMP multiplier (high) increases per-query rate ~30%');
{
  const w = loadPreset('public-geospatial-qa');
  const o = buildOpts(w);
  // Some presets only have deployment.fedrampTier (legacy) — make sure
  // a federal block exists before we mutate it.
  const ensureFederal = (wx) => { if (!wx.federal) wx.federal = { fedramp_tier: 'none', multi_region: 'single' }; return wx; };
  const wHigh = ensureFederal(JSON.parse(JSON.stringify(w)));
  wHigh.federal.fedramp_tier = 'high';
  wHigh.federal.multi_region = 'single';
  const wNone = ensureFederal(JSON.parse(JSON.stringify(w)));
  wNone.federal.fedramp_tier = 'none';
  wNone.federal.multi_region = 'single';
  // Also clear the legacy deployment.fedrampTier so the engine doesn't
  // back-fill from it.
  if (wHigh.deployment) wHigh.deployment.fedrampTier = 'high';
  if (wNone.deployment) wNone.deployment.fedrampTier = 'none';
  const rHigh = CostEngine.compute(wHigh, o);
  const rNone = CostEngine.compute(wNone, o);
  // Assert on per_query_blended (and equivalently monthly_gross) rather
  // than monthly_capped: the multiplier is structural, but the capped
  // value collapses to the cap when both runs exceed it, hiding the
  // ratio. monthly_gross / per_query_blended preserve the multiplier
  // regardless of how the preset's traffic shape evolves.
  const ratioPerQ = rHigh.api.per_query_blended / rNone.api.per_query_blended;
  assert(Math.abs(ratioPerQ - 1.30) < 0.01, `public-geospatial-qa: per_query_blended ratio high/none ≈ 1.30 (got ${ratioPerQ.toFixed(4)})`);
  const ratioGross = rHigh.api.monthly_gross / rNone.api.monthly_gross;
  assert(Math.abs(ratioGross - 1.30) < 0.01, `public-geospatial-qa: monthly_gross ratio high/none ≈ 1.30 (got ${ratioGross.toFixed(4)})`);
}
console.log('');

// ── 4. Linearity: doubling MAU doubles queries ────────────────────────
console.log('4. Doubling MAU doubles queries (linearity)');
{
  const w = loadPreset('generic-startup-chatbot');
  const o = buildOpts(w);
  const rBase = CostEngine.compute(w, o);
  const w2x = JSON.parse(JSON.stringify(w));
  for (const s of w2x.segments) s.mau *= 2;
  const r2x = CostEngine.compute(w2x, o);
  const ratio = r2x.queries.total / rBase.queries.total;
  assert(Math.abs(ratio - 2.0) < 0.005, `generic-startup-chatbot: queries ratio 2x MAU ≈ 2.00 (got ${ratio.toFixed(4)})`);
}
console.log('');

// ── 5. Headline reconciliation (no NaN, no infinity) ──────────────────
console.log('5. Headline math reconciles cleanly');
for (const slug of PRESETS) {
  const w = loadPreset(slug);
  const o = buildOpts(w);
  const r = CostEngine.compute(w, o);
  const h = headline(r, o, w);
  // Reconciles: every numeric subcomponent is also finite
  const parts = [
    r.api?.monthly_capped || 0,
    r.fixed_costs?.total || 0,
    r.verification?.monthly || 0,
    r.federal?.additive_total || 0,
    (r.embedding?.enabled ? r.embedding.monthly : 0) || 0,
    (r.personnel?.enabled ? r.personnel.monthly : 0) || 0,
  ];
  const sum = parts.reduce((a, b) => a + b, 0);
  const allFinite = parts.every(Number.isFinite);
  assert(allFinite, `${slug}: every headline component is finite`);
  const drift = h > 0 ? Math.abs(h - sum) / h : 0;
  assert(drift < 0.001, `${slug}: headline matches sum-of-parts ±0.1% (h=${Math.round(h)}, sum=${Math.round(sum)})`);
}
console.log('');

// ── 6. Per-query cost > 0 for every preset on API hosting ────────────
console.log('6. Per-query blended cost > 0 on API hosting');
for (const slug of PRESETS) {
  const w = loadPreset(slug);
  const o = buildOpts(w);
  o.hosting = 'api';
  const r = CostEngine.compute(w, o);
  assert(Number.isFinite(r.api.per_query_blended) && r.api.per_query_blended > 0, `${slug}: per_query_blended > 0 (got ${r.api?.per_query_blended})`);
}
console.log('');

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed · ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log('All engine invariants hold ✓');
