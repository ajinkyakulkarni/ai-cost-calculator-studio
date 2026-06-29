import { createRequire } from 'node:module';
import { validateWorkload } from '../lib/validate.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const full = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));
const vFull = validateWorkload(full);
ok('full preset ok', vFull.ok === true && vFull.missing_required.length === 0);
ok('full preset reports assumptions array', Array.isArray(vFull.assumptions));

const noModel = JSON.parse(JSON.stringify(full));
delete noModel.defaults.model;
const vNoModel = validateWorkload(noModel);
ok('missing model → not ok', vNoModel.ok === false);
ok('missing model named', vNoModel.missing_required.some(m => m.field === 'model'));
ok('missing model carries suggestion', vNoModel.missing_required.find(m => m.field === 'model').suggested_value != null);

const vEmpty = validateWorkload({});
ok('empty → core fields missing', ['volume','model','hosting','cache_rate_baseline','token_profile'].every(f => vEmpty.missing_required.some(m => m.field === f)));

console.log(`\nvalidate: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
