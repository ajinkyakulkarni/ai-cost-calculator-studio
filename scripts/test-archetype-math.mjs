#!/usr/bin/env node
// test-archetype-math.mjs — assert the JS archetype port matches the same
// pinned fixtures as python/test_archetype.py (so JS and Python agree).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { archetypeCost } = require('../public/lib/archetype-math.js');

// Same rates the calc price book carries for gpt-5.4 (input 2.50 / cached 0.25
// / output 15.00 per million) and the standard tier multipliers.
const RATES = { 'gpt-5.4': { input_per_million: 2.5, cached_per_million: 0.25, output_per_million: 15 } };
const TIERS = { standard: 1, flex: 0.5, batch: 0.5, priority: 2.5 };

let passed = 0, failed = 0;
const close = (a, b, t = 1e-4) => Math.abs(a - b) <= t;
function check(label, got, want, tol) {
  const ok = close(got, want, tol);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got.toFixed(6)} want ${want.toFixed(6)}`);
}
function expectThrow(label, fn) {
  try { fn(); failed++; console.log(`  FAIL  ${label}: expected throw`); }
  catch { passed++; console.log(`  PASS  ${label}: threw as expected`); }
}

const SIMPLE = { name: 'Simple', share: 0.6, tool_calls: 6, turns: 6, input_tokens: 80000, cached_tokens: 70000, output_tokens: 600 };
const MULTI = { name: 'Multi-source', share: 0.3, tool_calls: 8, turns: 11, input_tokens: 233498, cached_tokens: 184917, output_tokens: 885 };
const O = (over = {}) => ({ model: 'gpt-5.4', tier: 'standard', cyclesPerMonth: 0, rateCards: RATES, tierMultipliers: TIERS, ...over });

console.log('archetype-math (JS) — same fixtures as test_archetype.py');

check('Simple cycle $', archetypeCost([SIMPLE], O()).archetypes[0].cost_cycle, 0.0515);
check('Multi-source cycle $', archetypeCost([MULTI], O()).archetypes[0].cost_cycle, 0.18096);
check('Multi @ batch (0.5x) $', archetypeCost([MULTI], O({ tier: 'batch' })).archetypes[0].cost_cycle, 0.09048);

const planning = { ...MULTI, name: 'Planning', share: 0.1, input_tokens: 360938, cached_tokens: 285842, output_tokens: 3115 };
const blended = archetypeCost([SIMPLE, MULTI, planning], O({ cyclesPerMonth: 600000 }));
check('shares_sum_raw', blended.shares_sum_raw, 1.0);
check('monthly == blended×cycles', blended.blended.monthly, blended.blended.cost_per_cycle * 600000, 1.0);

const normd = archetypeCost([{ ...SIMPLE, share: 3 }, { ...MULTI, share: 1 }], O());
check('normalized share 3/4', normd.archetypes[0].share_normalized, 0.75);

const bands = archetypeCost([{ ...MULTI, low_factor: 0.7, high_factor: 1.5 }], O()).archetypes[0];
check('low band 0.7x', bands.cost_cycle_low, bands.cost_cycle * 0.7);
check('high band 1.5x', bands.cost_cycle_high, bands.cost_cycle * 1.5);

expectThrow('empty list', () => archetypeCost([], O()));
expectThrow('unknown model', () => archetypeCost([SIMPLE], O({ model: 'nope' })));
expectThrow('unknown tier', () => archetypeCost([SIMPLE], O({ tier: 'nope' })));
expectThrow('cached > input', () => archetypeCost([{ ...SIMPLE, input_tokens: 100, cached_tokens: 200 }], O()));

console.log(`\narchetype-math: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
