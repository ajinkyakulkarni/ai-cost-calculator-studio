#!/usr/bin/env node
// test-archetype-agent.mjs — pins the per-agent ARCHETYPE engine path and its
// derivation-trace output. Complements:
//   - test-archetype-math / -growth (the math libs in isolation)
//   - parity_check.py (JS≡Python on the archetype-agent-demo preset)
// This asserts ACTUAL dollar values for the engine's archetype branch (an
// independent hand-formula vs CostEngine.compute), across several angles, and
// that the derivation trace prints the honest per-archetype breakdown that
// reconciles to the per-query cost. Part of `npm test`.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CE = require('../public/lib/cost-engine.js');
const P = require('../public/lib/prices.js');

const RATES = P.llm_models;
const TIERM = {}; Object.entries(P.tier_multipliers).forEach(([k, v]) => TIERM[k] = v.multiplier);

let pass = 0, fail = 0;
const close = (a, b, t = 1e-9) => Math.abs(a - b) <= t * Math.max(1, Math.abs(b)) + 1e-9;
function check(label, got, want, t) {
  const ok = close(got, want, t); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${(+got).toFixed(8)} want ${(+want).toFixed(8)}`);
}
function ok(label, cond) { cond ? pass++ : fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); }

// Independent reference formula — NOT the engine code path.
function refPerQuery(archs, model, tier, activation = 1) {
  const r = RATES[model], m = TIERM[tier];
  const sum = archs.reduce((s, a) => s + (+a.share || 0), 0) || 1;
  let blended = 0;
  for (const a of archs) {
    const shareN = (+a.share || 0) / sum;
    const inp = +a.input_tokens || 0, cch = Math.min(+a.cached_tokens || 0, inp), out = +a.output_tokens || 0;
    blended += shareN * ((inp - cch) * r.input_per_million + cch * r.cached_per_million + out * r.output_per_million) / 1e6 * m;
  }
  return blended * activation;
}
const W = (agents, model, tier) => ({
  deployment: { name: 't' },
  anchor_query: { input_tokens: 2933, output_tokens: 41, cache_rate_baseline: 0.88, session_baseline_turns: 6 },
  shapes: { full: { input_factor: 1, output_factor: 1, cache_eligible: true } },
  mix: { worst: { weights: { full: 1 } } },
  segments: [{ id: 'all', mau: 10000, sessions_per_day: 0.2, questions_per_session: 10 }],
  agents, defaults: { model, tier, mix: 'worst', hosting: 'api', cost_mode: 'optimistic' },
});
const O = (model, tier) => ({ model, tier, mix: 'worst', hosting: 'api', cacheRate: 0.88, costMode: 'optimistic' });
const archSum = r => (r.api.agent_breakdown || []).filter(x => x.archetype_mode).reduce((t, x) => t + x.per_query_cost, 0);

console.log('archetype-agent — engine path (hand-formula vs CostEngine) + trace');

const ten = [{ name: 'Default', share: 0.1, input_tokens: 80000, cached_tokens: 70000, output_tokens: 600 }];
for (let i = 0; i < 9; i++) ten.push({ name: 'New', share: 0.1, input_tokens: 50000, cached_tokens: 40000, output_tokens: 500 });

const ANGLES = [
  ['10-archetype claude-sonnet-4.6', [{ id: 'a', label: 'A', model: 'claude-sonnet-4.6', archetype_mode: true, activation_rate: 1, archetypes: ten }], 'claude-sonnet-4.6', 'standard', 0.05055],
  ['10-archetype gpt-5.4', [{ id: 'a', label: 'A', model: 'gpt-5.4', archetype_mode: true, activation_rate: 1, archetypes: ten }], 'gpt-5.4', 'standard', 0.0434],
  ['batch tier 0.5x', [{ id: 'a', label: 'A', model: 'claude-sonnet-4.6', archetype_mode: true, activation_rate: 1, archetypes: ten }], 'claude-sonnet-4.6', 'batch', 0.025275],
  ['activation 0.4', [{ id: 'a', label: 'A', model: 'gpt-5.4', archetype_mode: true, activation_rate: 0.4, archetypes: ten }], 'gpt-5.4', 'standard', 0.01736],
  ['shares sum 0.9 → normalized', [{ id: 'a', label: 'A', model: 'gpt-5.4', archetype_mode: true, activation_rate: 1, archetypes: [
    { name: 'x', share: 0.3, input_tokens: 100000, cached_tokens: 50000, output_tokens: 1000 },
    { name: 'y', share: 0.3, input_tokens: 200000, cached_tokens: 150000, output_tokens: 2000 },
    { name: 'z', share: 0.3, input_tokens: 300000, cached_tokens: 0, output_tokens: 3000 }] }], 'gpt-5.4', 'standard', null],
  ['cached>input clamp', [{ id: 'a', label: 'A', model: 'gpt-5.4', archetype_mode: true, activation_rate: 1, archetypes: [
    { name: 'x', share: 1, input_tokens: 50000, cached_tokens: 90000, output_tokens: 400 }] }], 'gpt-5.4', 'standard', null],
];
for (const [label, agents, model, tier, pin] of ANGLES) {
  const r = CE.compute(JSON.parse(JSON.stringify(W(agents, model, tier))), O(model, tier));
  const ref = agents.filter(a => a.archetype_mode).reduce((t, a) => t + refPerQuery(a.archetypes, a.model || model, tier, a.activation_rate == null ? 1 : a.activation_rate), 0);
  check(`${label} (engine==ref)`, archSum(r), ref);
  if (pin != null) check(`${label} (pinned $)`, ref, pin, 1e-6);
}

// Multi-agent sum: 2 archetype agents + 1 normal — archetype contribution sums.
{
  const agents = [
    { id: 'a', model: 'gpt-5.4', archetype_mode: true, activation_rate: 1, archetypes: [{ name: 'x', share: 1, input_tokens: 80000, cached_tokens: 70000, output_tokens: 600 }] },
    { id: 'b', model: 'claude-sonnet-4.6', archetype_mode: true, activation_rate: 0.5, archetypes: [{ name: 'y', share: 1, input_tokens: 233498, cached_tokens: 184917, output_tokens: 885 }] },
    { id: 'c', model: 'gpt-5.4', input_tokens: 2000, output_tokens: 300, calls_per_query: 1, cache_eligible: true },
  ];
  const r = CE.compute(JSON.parse(JSON.stringify(W(agents, 'gpt-5.4', 'standard'))), O('gpt-5.4', 'standard'));
  const ref = refPerQuery(agents[0].archetypes, 'gpt-5.4', 'standard', 1) + refPerQuery(agents[1].archetypes, 'claude-sonnet-4.6', 'standard', 0.5);
  check('multi-agent archetype sum', archSum(r), ref);
  ok('normal agent still present in breakdown', (r.api.agent_breakdown || []).some(x => x.id === 'c' && !x.archetype_mode));
}

// No archetype_mode → engine path unchanged (regression guard for the 17 presets).
{
  const r = CE.compute(JSON.parse(JSON.stringify(W([{ id: 'n', model: 'gpt-5.4', input_tokens: 2000, output_tokens: 300, calls_per_query: 1, cache_eligible: true }], 'gpt-5.4', 'standard'))), O('gpt-5.4', 'standard'));
  ok('non-archetype agent: no archetype rows', !(r.api.agent_breakdown || []).some(x => x.archetype_mode));
}

// Derivation trace: archetype agent prints honest per-archetype lines + reconciles.
{
  const agents = [{ id: 'p', label: 'Planner', model: 'gpt-5.4', archetype_mode: true, activation_rate: 1, archetypes: [
    { name: 'Simple', share: 0.6, input_tokens: 80000, cached_tokens: 70000, output_tokens: 600 },
    { name: 'Multi', share: 0.4, input_tokens: 233498, cached_tokens: 184917, output_tokens: 885 }] }];
  const r = CE.compute(JSON.parse(JSON.stringify(W(agents, 'gpt-5.4', 'standard'))), O('gpt-5.4', 'standard'));
  const d = r.derivation || '';
  ok('trace says "archetype mode"', /archetype mode/i.test(d));
  ok('trace lists Simple + Multi archetypes', /"Simple"/.test(d) && /"Multi"/.test(d));
  ok('trace shows cached→fresh split', /cached → /.test(d));
  ok('trace does NOT show bogus "0 input ... 0 output" for the archetype agent',
     !/Planner[\s\S]{0,200}0 agent input/.test(d));
  // reconciles: the per-query in the breakdown matches 0.6*0.0515 + 0.4*0.180957
  check('trace reconciles to breakdown per-query', r.api.agent_breakdown[0].per_query_cost, 0.6 * 0.0515 + 0.4 * 0.180957, 1e-6);
}

console.log(`\narchetype-agent: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
