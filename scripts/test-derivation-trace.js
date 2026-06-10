#!/usr/bin/env node
/* Unit tests for public/lib/derivation-trace.js — the retry-inflation
 * formula and the A–D appendix of the derivation trace.
 *
 * Run directly:  node scripts/test-derivation-trace.js
 * Or via:        npm test
 */
'use strict';

const path = require('path');
const { retryInflateFactor, buildAppendix } =
  require(path.join(__dirname, '..', 'public', 'lib', 'derivation-trace.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function approx(a, b, eps = 1e-12) { return Math.abs(a - b) <= eps; }

console.log('derivation-trace: retryInflateFactor');
check('0% retry → factor 1.0', approx(retryInflateFactor(0), 1));
check('3% retry → 1 + 0.03×1.5 = 1.045', approx(retryInflateFactor(0.03), 1.045));
check('10% retry → 1.15', approx(retryInflateFactor(0.10), 1.15));
check('garbage → factor 1.0 (no NaN)', approx(retryInflateFactor('abc'), 1));
check('negative → clamped to 1.0', approx(retryInflateFactor(-0.5), 1));

console.log('derivation-trace: buildAppendix');

// A representative context mirroring a real render: parts sum to the
// headline, so the appendix's roll-up must show internally consistent
// arithmetic. apiBill = apiBillBefore × retryInflate by construction.
const retryRate = 0.03;
const retryInflate = retryInflateFactor(retryRate);
const apiBillBefore = 10000;
const ctx = {
  axTotalIn: 29330, axTotalOut: 410, axTurns: 10,
  retryRate, retryInflate,
  apiBillBefore, apiBill: apiBillBefore * retryInflate,
  agentEngineering: {
    enabled: true, upfront_total: 36000, amortization_months: 36,
    upfront_monthly: 1000, maintenance_monthly: 250, helper_monthly: 400,
  },
  agentEngMonthly: 1650,
  hosting: 'api',
  llmHeadline: 10450, verifMonthly: 2297, embeddingMonthly: 0,
  personnelMonthly: 0, federalAdditive: 82, fixedCosts: 1200,
  headlineTotal: 10450 + 2297 + 1650 + 82 + 1200, // 15,679
};
const out = buildAppendix(ctx);

// Section structure
check('has section A header', out.includes('A) WORKLOAD → ENGINE INPUTS'));
check('has section B header', out.includes('B) RETRY INFLATION'));
check('has section C header (engineering enabled)', out.includes('C) AGENT ENGINEERING'));
check('has section D header', out.includes('D) FINAL HEADLINE'));

// Section A: per-turn division 29330/10 = 2933, 410/10 = 41
check('A shows per-turn input 2,933', out.includes('= 2,933 tok/query'));
check('A shows per-turn output 41', out.includes('= 41 tok/query'));

// Section B: the printed formula carries the same numbers the helper computed
check('B prints the formula with rate 0.030', out.includes('1 + 0.030 × 1.5 = 1.0450'));
check('B before/after consistent', out.includes('$10,000') && out.includes('$10,450'));

// Section C: amortization lines
check('C shows upfront amortization', out.includes('$36,000 total, amortized over 36 months = $1,000/mo'));
check('C shows total 1,650/mo', out.includes('TOTAL agent engineering: $1,650/mo'));

// Section D: roll-up shows the consistent total and its 12×/36× projections
check('D shows monthly total $15,679', out.includes('= $15,679/mo'));
check('D shows yearly = 12×', out.includes('$' + (ctx.headlineTotal * 12).toLocaleString() + '/yr'));
check('D shows 3yr TCO = 36×', out.includes('$' + (ctx.headlineTotal * 36).toLocaleString() + '/3yr TCO'));
check('D includes zero lines omitted (no Embeddings)', !out.includes('+ Embeddings'));
check('D includes nonzero verification line', out.includes('+ Verification:        $2,297'));

// Variant: engineering disabled → no section C
const out2 = buildAppendix({ ...ctx, agentEngineering: { enabled: false }, agentEngMonthly: 0 });
check('C omitted when engineering disabled', !out2.includes('C) AGENT ENGINEERING'));
check('D omits engineering line when 0', !out2.includes('+ Agent engineering'));

// Variant: per-agent build-up inactive → fallback line in A
const out3 = buildAppendix({ ...ctx, axTotalIn: null, axTurns: null });
check('A fallback when build-up inactive', out3.includes('not active this render'));

// Variant: hosting labels
check('self-host label', buildAppendix({ ...ctx, hosting: 'self' }).includes('Self-host LLM'));
check('hybrid label', buildAppendix({ ...ctx, hosting: 'hybrid' }).includes('Hybrid LLM'));
check('onprem label', buildAppendix({ ...ctx, hosting: 'onprem' }).includes('On-prem (amortized)'));
check('api label', out.includes('API LLM × retry-inflate'));

if (failures > 0) {
  console.error(`\nderivation-trace: ${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nderivation-trace: all tests passed.');
