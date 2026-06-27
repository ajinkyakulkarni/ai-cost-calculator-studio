import { createRequire } from 'node:module';
import { computeWorkload } from '../lib/engine-bridge.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const w = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));
const out = computeWorkload(w);

ok('returns opts/result/headline', out.opts && out.result && typeof out.headline === 'number');
ok('headline > 0', out.headline > 0);
ok('headline is cap-aware $45,070 (archetype demo)', Math.round(out.headline) === 45070);
ok('per_query > 0', out.perQuery > 0);
ok('derivation string present', typeof out.derivation === 'string' && out.derivation.length > 0);
ok('breakdown has llm + additive lines', out.composed && typeof out.composed.llm === 'number');

console.log(`\nengine-bridge: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
