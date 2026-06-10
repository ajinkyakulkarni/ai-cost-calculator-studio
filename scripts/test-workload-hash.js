#!/usr/bin/env node
/* Unit tests for public/lib/workload-hash.js — the share-link codec.
 *
 * Run directly:  node scripts/test-workload-hash.js
 * Or via:        npm test
 */
'use strict';

const path = require('path');
const { encodePayload, decodeHash, classifyPayload, buildHashString } =
  require(path.join(__dirname, '..', 'public', 'lib', 'workload-hash.js'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}

console.log('workload-hash: encode/decode round-trip');
{
  const payload = { workload: { deployment: { name: 'Test' }, shapes: {} }, ui: { 's-users': '10000' } };
  const enc = encodePayload(payload);
  check('encode produces base64-safe string', /^[A-Za-z0-9+/=]+$/.test(enc));
  const dec = decodeHash('#w=' + enc);
  check('round-trip preserves payload', JSON.stringify(dec) === JSON.stringify(payload));
  const dec2 = decodeHash('#w=' + enc + '&mode=basic');
  check('round-trip with &mode= suffix', JSON.stringify(dec2) === JSON.stringify(payload));
}
{
  // Unicode stress — this is WHY encodeURIComponent wraps btoa. Workload
  // descriptions carry ×, →, é, CJK, emoji; raw btoa() throws on them.
  const payload = {
    workload: {
      deployment: { name: 'Geo Q&A — coût élevé × 1.5 → 日本語 🚀' },
      shapes: { full: { description: '7-stage pipeline (parse_datetime → geocode)' } },
    },
  };
  const dec = decodeHash('#w=' + encodePayload(payload));
  check('unicode survives round-trip', dec?.workload?.deployment?.name === payload.workload.deployment.name);
}

console.log('workload-hash: decodeHash robustness');
check('no w= param → null', decodeHash('#mode=basic') === null);
check('empty string → null', decodeHash('') === null);
check('undefined → null', decodeHash(undefined) === null);
check('corrupt base64 → null (no throw)', decodeHash('#w=%%%not-base64%%%') === null);
check('valid base64, invalid JSON → null', decodeHash('#w=' + Buffer.from('not json').toString('base64')) === null);

console.log('workload-hash: classifyPayload');
{
  const wrapped = { workload: { deployment: {}, shapes: {} }, ui: { 's-retry': '3' } };
  const c = classifyPayload(wrapped);
  check('wrapped format recognized', c.kind === 'wrapped');
  check('wrapped → workload extracted', c.workload === wrapped.workload);
  check('wrapped → ui extracted', c.ui === wrapped.ui);
}
{
  const c = classifyPayload({ workload: { deployment: {}, shapes: {} } });
  check('wrapped without ui → ui null', c.kind === 'wrapped' && c.ui === null);
}
{
  const legacy = { deployment: {}, shapes: {} };
  const c = classifyPayload(legacy);
  check('legacy unwrapped format recognized', c.kind === 'legacy');
  check('legacy → workload is the payload itself', c.workload === legacy);
  check('legacy → no ui block', c.ui === null);
}
check('missing shapes → invalid', classifyPayload({ deployment: {} }).kind === 'invalid');
check('missing deployment → invalid', classifyPayload({ shapes: {} }).kind === 'invalid');
check('null → invalid', classifyPayload(null).kind === 'invalid');
check('wrapped but inner workload incomplete → invalid', classifyPayload({ workload: { deployment: {} } }).kind === 'invalid');

console.log('workload-hash: buildHashString');
check('basic mode appended', buildHashString('AbC', 'basic') === '#w=AbC&mode=basic');
check('advanced mode appended', buildHashString('AbC', 'advanced') === '#w=AbC&mode=advanced');
check('null mode → no suffix', buildHashString('AbC', null) === '#w=AbC');
check('junk mode dropped', buildHashString('AbC', 'pwned"><script>') === '#w=AbC');

console.log('workload-hash: full pipeline (encode → hash → decode → classify)');
{
  const workload = { deployment: { name: 'E2E' }, shapes: { full: {} } };
  const hash = buildHashString(encodePayload({ workload, ui: { 's-cache': '88' } }), 'advanced');
  const c = classifyPayload(decodeHash(hash));
  check('pipeline → wrapped + workload intact + ui intact',
    c.kind === 'wrapped' && c.workload.deployment.name === 'E2E' && c.ui['s-cache'] === '88');
  check('pipeline → mode param coexists with w=', hash.endsWith('&mode=advanced'));
}

if (failures > 0) {
  console.error(`\nworkload-hash: ${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nworkload-hash: all tests passed.');
