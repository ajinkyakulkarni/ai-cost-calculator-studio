import { listPresets, loadPreset } from '../lib/presets.mjs';
let pass = 0, fail = 0;
const ok = (l, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}`); };

const list = listPresets();
ok('lists >= 18 presets', list.length >= 18);
ok('each has name + one_line', list.every(p => p.name && typeof p.one_line === 'string'));

const w = loadPreset('archetype-agent-demo');
ok('loadPreset returns a workload', w && w.deployment && w.shapes);
ok('unknown preset throws', (() => { try { loadPreset('nope'); return false; } catch { return true; } })());

console.log(`\npresets: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
