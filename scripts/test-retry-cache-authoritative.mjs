#!/usr/bin/env node
// Engine reads retry + cache from the workload when opts don't override.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CE = require(path.join(__dirname, '..', 'public', 'lib', 'cost-engine.js'));
const { buildOpts } = require(path.join(__dirname, '..', 'public', 'lib', 'build-opts.js'));

let pass = 0, fail = 0;
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)) + 1e-9;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const base = () => ({
  deployment: { name: 't' },
  anchor_query: { input_tokens: 2933, output_tokens: 41, cache_rate_baseline: 0.88, session_baseline_turns: 6 },
  shapes: { full: { input_factor: 1, output_factor: 1, cache_eligible: true } },
  mix: { worst: { weights: { full: 1 } } },
  segments: [{ id: 'all', mau: 1000, sessions_per_day: 0.2, questions_per_session: 10 }],
  defaults: { model: 'gpt-5.4', tier: 'standard', mix: 'worst', hosting: 'api', cost_mode: 'optimistic' },
});

let w = base();
let r = CE.compute(JSON.parse(JSON.stringify(w)), buildOpts(w));
ok('retry absent → retry_inflate 1.0', close(r.api.retry_inflate, 1.0));

w = base(); w.anchor_query.retry_rate = 0.03;
r = CE.compute(JSON.parse(JSON.stringify(w)), buildOpts(w));
ok('workload retry_rate 0.03 → retry_inflate 1.045', close(r.api.retry_inflate, 1.045));

w = base();
r = CE.compute(JSON.parse(JSON.stringify(w)), { model: 'gpt-5.4', tier: 'standard', mix: 'worst', hosting: 'api', costMode: 'optimistic' });
ok('cache falls back to anchor 0.88 (monthly>0)', r.api.monthly_capped > 0);

console.log(`\nretry-cache-authoritative: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
