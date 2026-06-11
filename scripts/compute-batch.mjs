#!/usr/bin/env node
// compute-batch.mjs — run the JS engine over a batch of {workload, opts}
// cases and emit results as JSON. Used by python/random_parity.py to
// cross-check randomly mutated workloads against the Python engine in
// one node process instead of hundreds.
//
//   node scripts/compute-batch.mjs <cases.json> <out.json>
//
// cases.json: [{ id, workload, opts }, ...]
// out.json:   [{ id, ok, result?, error? }, ...]  (derivation stripped)
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CE = require('../public/lib/cost-engine.js');

const [casesPath, outPath] = process.argv.slice(2);
if (!casesPath || !outPath) {
  console.error('usage: node scripts/compute-batch.mjs <cases.json> <out.json>');
  process.exit(1);
}
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const out = cases.map(c => {
  try {
    // Deep-clone: the engine may normalize/mutate the workload in place.
    const r = CE.compute(JSON.parse(JSON.stringify(c.workload)), c.opts);
    delete r.derivation; // embeds a timestamp
    return { id: c.id, ok: true, result: r };
  } catch (e) {
    return { id: c.id, ok: false, error: String(e && e.message || e) };
  }
});
fs.writeFileSync(outPath, JSON.stringify(out));
console.error(`computed ${out.length} cases (${out.filter(x => !x.ok).length} errored)`);
