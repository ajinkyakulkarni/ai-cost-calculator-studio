#!/usr/bin/env node
/* Unit tests for public/lib/audience-math.js — the pure audience
 * aggregate formulas behind the "Your audience" block.
 *
 * Run directly:  node scripts/test-audience-math.js
 * Or via:        npm test
 */
'use strict';

const path = require('path');
const { computeAudienceAggregates, mirrorValues } =
  require(path.join(__dirname, '..', 'public', 'lib', 'audience-math.js'));

let failures = 0;
function check(name, got, want, eps) {
  const ok = eps != null
    ? Math.abs(got - want) <= eps
    : Object.is(got, want);
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}${eps != null ? ` (±${eps})` : ''}`);
  }
}

console.log('audience-math: computeAudienceAggregates');

// --- Empty / degenerate inputs -------------------------------------
{
  const a = computeAudienceAggregates([]);
  check('empty array → mau 0', a.mau, 0);
  check('empty array → weighted sessions 0 (no NaN)', a.weightedSessionsPerDay, 0);
  check('empty array → weighted questions 0 (no NaN)', a.weightedQuestionsPerSession, 0);
}
{
  const a = computeAudienceAggregates(undefined);
  check('undefined → mau 0', a.mau, 0);
}
{
  // All-zero MAU must not divide by zero.
  const a = computeAudienceAggregates([
    { mau: 0, sessions_per_day: 5, questions_per_session: 9 },
  ]);
  check('zero-MAU segment → weighted sessions 0 (no NaN)', a.weightedSessionsPerDay, 0);
}

// --- Single segment is a passthrough -------------------------------
{
  const a = computeAudienceAggregates([
    { mau: 500, sessions_per_day: 0.3, questions_per_session: 8 },
  ]);
  check('single segment → mau passthrough', a.mau, 500);
  check('single segment → sessions passthrough', a.weightedSessionsPerDay, 0.3, 1e-12);
  check('single segment → questions passthrough', a.weightedQuestionsPerSession, 8, 1e-12);
}

// --- The worked example from the multi-segment preset ---------------
// 10,000 public visitors @ 0.2 sess/day, 10 q/sess
// + 1,000 authenticated  @ 0.2 sess/day,  5 q/sess
// Total MAU 11,000; sessions stay 0.2 (same on both);
// questions = (10000*10 + 1000*5) / 11000 = 105000/11000 = 9.5454...
{
  const a = computeAudienceAggregates([
    { mau: 10000, sessions_per_day: 0.2, questions_per_session: 10 },
    { mau: 1000,  sessions_per_day: 0.2, questions_per_session: 5  },
  ]);
  check('preset example → mau 11000', a.mau, 11000);
  check('preset example → weighted sessions 0.2', a.weightedSessionsPerDay, 0.2, 1e-12);
  check('preset example → weighted questions 105000/11000', a.weightedQuestionsPerSession, 105000 / 11000, 1e-12);
}

// --- MAU-weighting (NOT a plain mean) -------------------------------
// 10,000 public @ 0.2 + 100 analysts @ 3.0:
//   weighted = (10000*0.2 + 100*3.0) / 10100 = 2300/10100 ≈ 0.2277
//   a plain mean would wrongly give 1.6.
{
  const a = computeAudienceAggregates([
    { mau: 10000, sessions_per_day: 0.2, questions_per_session: 2  },
    { mau: 100,   sessions_per_day: 3.0, questions_per_session: 15 },
  ]);
  check('weighting → big segment dominates sessions', a.weightedSessionsPerDay, 2300 / 10100, 1e-12);
  check('weighting → NOT the plain mean 1.6', a.weightedSessionsPerDay === 1.6, false);
  check('weighting → questions (10000*2+100*15)/10100', a.weightedQuestionsPerSession, 21500 / 10100, 1e-12);
}

// --- Garbage coercion ------------------------------------------------
{
  const a = computeAudienceAggregates([
    { mau: '2500', sessions_per_day: '0.5', questions_per_session: '4' }, // numeric strings OK
    { mau: 'abc',  sessions_per_day: null,  questions_per_session: -3 },  // garbage → 0
  ]);
  check('numeric strings coerce', a.mau, 2500);
  check('garbage / negative coerce to 0', a.weightedQuestionsPerSession, 4, 1e-12);
}

console.log('audience-math: mirrorValues');

// --- Slider-mirror clamps -------------------------------------------
{
  const m = mirrorValues({ mau: 0, weightedSessionsPerDay: 0, weightedQuestionsPerSession: 0 });
  check('floor → users ≥ 1', m.users, 1);
  check('floor → sessions ≥ 0.01', m.sessions, 0.01);
  check('floor → turns ≥ 1', m.turns, 1);
}
{
  const m = mirrorValues({ mau: 9e9, weightedSessionsPerDay: 0.2, weightedQuestionsPerSession: 10 });
  check('cap → users ≤ default max 500000', m.users, 500000);
}
{
  const m = mirrorValues({ mau: 9e9, weightedSessionsPerDay: 0.2, weightedQuestionsPerSession: 10 }, 1000);
  check('cap → custom maxMau honored', m.users, 1000);
}
{
  const m = mirrorValues({ mau: 11000, weightedSessionsPerDay: 0.20449, weightedQuestionsPerSession: 9.545 });
  check('rounding → sessions to 2 dp', m.sessions, 0.20);
  check('rounding → turns to nearest int', m.turns, 10);
  check('passthrough → users', m.users, 11000);
}

if (failures > 0) {
  console.error(`\naudience-math: ${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\naudience-math: all tests passed.');
