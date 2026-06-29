import { createRequire } from 'node:module';
import { computeCost } from '../lib/compute.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const full = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));

const good = computeCost(full);
ok('full preset returns headline', !good.error && good.headline_monthly_usd > 0);
ok('full preset returns share link', /#w=/.test(good.share_link || ''));

const noModel = JSON.parse(JSON.stringify(full)); delete noModel.defaults.model;
const gated = computeCost(noModel);
ok('missing model → error', gated.error === 'missing_required');
ok('missing model → names model', gated.missing_required.some(m => m.field === 'model'));
ok('missing model → NO numbers', gated.headline_monthly_usd === undefined);

ok('empty → error', computeCost({}).error === 'missing_required');

console.log(`\ncompute-gate: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
