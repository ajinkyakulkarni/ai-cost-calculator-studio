import { createRequire } from 'node:module';
import { shareLink } from '../lib/sharelink.mjs';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const WorkloadHash = require('../../public/lib/workload-hash.js');

let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const w = JSON.parse(fs.readFileSync(new URL('../../public/examples/archetype-agent-demo.json', import.meta.url)));
const url = shareLink(w);

ok('url is calc.ajinkya.ai #w=', /^https:\/\/calc\.ajinkya\.ai\/#w=/.test(url));
const decoded = WorkloadHash.classifyPayload(WorkloadHash.decodeHash(url));
ok('decodes to a valid wrapped workload', decoded.kind === 'wrapped');
ok('round-trips deployment name', decoded.workload.deployment.name === w.deployment.name);
ok('round-trips agents length', (decoded.workload.agents || []).length === (w.agents || []).length);

console.log(`\nsharelink: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
