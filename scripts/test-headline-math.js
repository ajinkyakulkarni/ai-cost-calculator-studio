#!/usr/bin/env node
/* Unit tests for public/lib/headline-math.js — the headline composition
 * and agent-engineering amortization formulas.
 *
 * Run directly:  node scripts/test-headline-math.js
 * Or via:        npm test
 */
'use strict';

const path = require('path');
const { computeAgentEngineering, composeHeadline } =
  require(path.join(__dirname, '..', 'public', 'lib', 'headline-math.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

// Silence the intentional fail-loud console.error for the missing-lead case.
const realError = console.error;

console.log('headline-math: computeAgentEngineering');

const PRICES = {
  ml_engineer:       { annual_base: 200000, total_comp_multiplier: 1.3 },
  agent_design_lead: { annual_base: 230000, total_comp_multiplier: 1.3 },
};

{
  const r = computeAgentEngineering({ enabled: false }, PRICES);
  check('disabled → all zeros', !r.enabled && r.monthly === 0 && r.upfront === 0);
  check('null block → disabled zeros', computeAgentEngineering(null, PRICES).monthly === 0);
}
{
  // Worked example:
  //   1 ML engineer @ 200k × 1.3 loaded = 260k/yr, 1.0 FTE, 4-month phase
  //     upfront roles = 1.0 × 260000 × (4/12)            = 86,666.667
  //   helper agent $400/mo × 4 months                    = 1,600
  //     upfront total                                    = 88,266.667
  //   amortized over 36 months                           = 2,451.852/mo
  //   maintenance: lead 230k × 1.3 = 299k → /2080 = $143.75/hr
  //     × 40 h per session ÷ 6-month interval            = 958.333/mo
  //   monthly = 2,451.852 + 958.333                      = 3,410.185
  const r = computeAgentEngineering({
    enabled: true,
    roles: [{ role: 'ml_engineer', fte: 1.0 }],
    duration_months: 4, amortization_months: 36,
    helper_agent_monthly: 400,
    maintenance_interval_months: 6, maintenance_hours_per_session: 40,
  }, PRICES);
  check('worked example → upfront 88,266.67', approx(r.upfront, 200000 * 1.3 * (4 / 12) + 400 * 4, 1e-6));
  check('worked example → amortized = upfront/36', approx(r.amortized_monthly, r.upfront / 36, 1e-9));
  check('worked example → maintenance 958.33', approx(r.maintenance_monthly, (230000 * 1.3 / 2080) * 40 / 6, 1e-6));
  check('worked example → monthly = amortized + maintenance', approx(r.monthly, r.amortized_monthly + r.maintenance_monthly, 1e-9));
}
{
  // Missing agent_design_lead → maintenance zeroed, console.error fired
  // (fail-loud policy mirroring scripts/calc.js).
  let errored = false;
  console.error = () => { errored = true; };
  const r = computeAgentEngineering(
    { enabled: true, roles: [], duration_months: 4, maintenance_hours_per_session: 40 },
    { ml_engineer: PRICES.ml_engineer } // no agent_design_lead
  );
  console.error = realError;
  check('missing design lead → maintenance 0', r.maintenance_monthly === 0);
  check('missing design lead → fail-loud error fired', errored);
}
{
  // Amortization floor: 0/garbage months must not divide by zero.
  console.error = () => {};
  const r = computeAgentEngineering(
    { enabled: true, roles: [], duration_months: 1, amortization_months: 0, helper_agent_monthly: 100 },
    {}
  );
  console.error = realError;
  check('amortization floor → /36 default when 0', approx(r.amortized_monthly, 100 / 36, 1e-9));
  check('no NaN on empty prices', Number.isFinite(r.monthly));
}

console.log('headline-math: composeHeadline');

// A representative engine result with every line populated.
const R = {
  api: { monthly_with_retry: 10450, monthly_capped: 10000 },
  fixed_costs: { total: 1200 },
  verification: { monthly: 2297 },
  tool_fees: { monthly: 310 },
  federal: { additive_total: 82 },
  embedding: { enabled: true, monthly: 55 },
  personnel: { enabled: true, monthly: 9000 },
  self_host: { total: 7000 },
  hybrid: { total: 8800 },
  reservation: { enabled: false, effective_monthly: 9500 },
};
const W = { on_prem_monthly: '6500' };

{
  const c = composeHeadline(R, W, { hosting: 'api' }, 1.045, 1650);
  check('api → llm = engine monthly_with_retry (preferred)', c.llm === 10450);
  const want = 10450 + 1200 + 2297 + 310 + 82 + 55 + 9000 + 1650;
  check('headline = sum of all 8 lines', approx(c.headline, want), `got ${c.headline} want ${want}`);
  check('breakdown keys all present', ['headline','llm','apiBill','fixed','verif','toolFees','fed','emb','pers','ae'].every(k => k in c));
}
{
  // Fallback path: engine without monthly_with_retry → manual × retryInflate.
  const r2 = { ...R, api: { monthly_capped: 10000 } };
  const c = composeHeadline(r2, W, { hosting: 'api' }, 1.045, 0);
  check('legacy payload → apiBill = capped × retryInflate', approx(c.apiBill, 10450));
}
{
  check('self → llm = self_host.total', composeHeadline(R, W, { hosting: 'self' }, 1, 0).llm === 7000);
  check('hybrid → llm = hybrid.total', composeHeadline(R, W, { hosting: 'hybrid' }, 1, 0).llm === 8800);
  check('onprem → llm = parsed workload.on_prem_monthly', composeHeadline(R, W, { hosting: 'onprem' }, 1, 0).llm === 6500);
}
{
  // Reservation wins over API bill — but only on the api path.
  const r3 = { ...R, reservation: { enabled: true, effective_monthly: 9500 } };
  check('reservation enabled → llm = effective_monthly', composeHeadline(r3, W, { hosting: 'api' }, 1, 0).llm === 9500);
  check('reservation does NOT override self-host', composeHeadline(r3, W, { hosting: 'self' }, 1, 0).llm === 7000);
}
{
  // Disabled blocks contribute zero.
  const r4 = { ...R, embedding: { enabled: false, monthly: 55 }, personnel: { enabled: false, monthly: 9000 } };
  const c = composeHeadline(r4, W, { hosting: 'api' }, 1, 0);
  check('disabled embedding → 0', c.emb === 0);
  check('disabled personnel → 0', c.pers === 0);
}
{
  // Sparse engine result → all-zero lines, no NaN.
  const c = composeHeadline({}, {}, { hosting: 'api' }, 1, 0);
  check('empty result → headline 0, no NaN', c.headline === 0 && Number.isFinite(c.headline));
}

if (failures > 0) {
  console.error(`\nheadline-math: ${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nheadline-math: all tests passed.');
