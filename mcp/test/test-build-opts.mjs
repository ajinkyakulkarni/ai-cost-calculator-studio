import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildOpts } = require('../../public/lib/build-opts.js');

let pass = 0, fail = 0;
const eq = (l, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'} ${l}`); };

eq('empty → defaults', buildOpts({}), {
  hosting: 'api', model: 'gpt-5.2', tier: 'standard', mix: 'mixed',
  costMode: 'realistic', botFactor: 1.5, cacheRate: 0.7, verifCoverage: 0,
});
eq('from workload', buildOpts({
  defaults: { hosting: 'self-host', model: 'gpt-5.4', tier: 'batch', mix: 'worst', cost_mode: 'optimistic' },
  anchor_query: { cache_rate_baseline: 0.88 },
  verification: { coverage: 0.1 },
}), {
  hosting: 'self-host', model: 'gpt-5.4', tier: 'batch', mix: 'worst',
  costMode: 'optimistic', botFactor: 1.5, cacheRate: 0.88, verifCoverage: 0.1,
});

console.log(`\nbuild-opts: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
