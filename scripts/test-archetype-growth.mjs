#!/usr/bin/env node
// test-archetype-growth.mjs — assert the JS growth port matches the same
// fixtures as python/test_growth.py (so JS and Python agree).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cycleFromTurns, cycleUniform, DOC_CACHE_RATIO } = require('../public/lib/archetype-growth.js');

let passed = 0, failed = 0;
function eq(label, got, want) {
  const ok = got === want; ok ? passed++ : failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got} want ${want}`);
}

// Multi-source: reconstruct (added, output) steps from the doc trace.
const MS = [[20398,43],[20461,86],[20647,43],[20720,60],[20850,43],[20893,238],[21661,71],[21782,70],[21902,70],[22022,60],[22162,101]];
const MS_BASE = 20358;
const MS_STEPS = [];
let pin = MS_BASE, pout = 0;
for (const [inp, out] of MS) { MS_STEPS.push([inp - pin - pout, out]); pin = inp; pout = out; }

const PLANNING_BASE = 8500 + 12858 + 3858;
const PLANNING_STEPS = [[40,43],[20,43],[20,90],[150,43],[0,450],[0,238],[500,238],[600,100],[30,120],[800,150],[1500,200],[2000,600],[300,800]];

console.log('archetype-growth (JS) — same fixtures as test_growth.py');

const ms = cycleFromTurns(MS_BASE, MS_STEPS, DOC_CACHE_RATIO);
eq('Multi-source input', ms.input_tokens, 233498);
eq('Multi-source output', ms.output_tokens, 885);
eq('Multi-source cached', ms.cached_tokens, 184917);

const pl = cycleFromTurns(PLANNING_BASE, PLANNING_STEPS, DOC_CACHE_RATIO);
eq('Planning input', pl.input_tokens, 360938);
eq('Planning cached', pl.cached_tokens, 285842);
eq('Planning output', pl.output_tokens, 3115);

const u = cycleUniform(20000, 5, 500, 100, 0.8);
eq('uniform input', u.input_tokens, 108500);
eq('uniform cached', u.cached_tokens, 86800);
eq('uniform turns', u.turns, 5);

try { cycleFromTurns(1000, [[0,0]], 1.5); failed++; console.log('  FAIL  bad ratio: no throw'); }
catch { passed++; console.log('  PASS  bad ratio throws'); }

console.log(`\narchetype-growth: ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
