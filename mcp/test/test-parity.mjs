/* For every bundled preset, computeCost's headline must equal the engine-bridge
 * headline computed directly — proving the tool/gate/format layers don't mangle
 * the engine number. */
import { computeCost } from '../lib/compute.mjs';
import { computeWorkload } from '../lib/engine-bridge.mjs';
import { validateWorkload } from '../lib/validate.mjs';
import { listPresets, loadPreset } from '../lib/presets.mjs';

let pass = 0, fail = 0;
for (const { name } of listPresets()) {
  const w = loadPreset(name);
  if (!validateWorkload(w).ok) { console.log(`  SKIP ${name} (preset omits a required field)`); continue; }
  const viaTool = computeCost(w).headline_monthly_usd;
  const direct = Math.round(computeWorkload(w).headline);
  const good = viaTool === direct;
  good ? pass++ : fail++;
  console.log(`  ${good ? 'PASS' : 'FAIL'} ${name}: tool ${viaTool} vs direct ${direct}`);
}
console.log(`\nmcp-parity: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
