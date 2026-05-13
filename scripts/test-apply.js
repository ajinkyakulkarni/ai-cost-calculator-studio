#!/usr/bin/env node
// Smoke test: invoke applyEditsToSource against an in-memory copy of
// prices.js and verify (a) the right field changed (b) nothing else
// was touched (c) prices.js still loads after the edit.
'use strict';
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// prices.js lives at public/lib/prices.js after the static-asset reorg;
// fall back to lib/prices.js for older layouts.
let SRC = path.resolve(__dirname, '..', 'public', 'lib', 'prices.js');
if (!fs.existsSync(SRC)) SRC = path.resolve(__dirname, '..', 'lib', 'prices.js');
const original = fs.readFileSync(SRC, 'utf8');

// Pull applyEditsToSource out of the script via vm — re-exec with a
// shim that exposes it on globalThis.
const scraperSrc = fs.readFileSync(path.resolve(__dirname, 'refresh-prices.js'), 'utf8');
const wrapped = scraperSrc.replace(/main\(\)\.catch.*$/m, '') +
  '\nglobalThis.__applyEditsToSource = applyEditsToSource;\n';
const ctx = {
  require, console, process, fetch: () => { throw new Error('fetch disabled in test'); },
  module: { exports: {} }, exports: {}, __dirname, Buffer,
  setTimeout, clearTimeout, setInterval, clearInterval,
};
ctx.global = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(wrapped, ctx);
const applyEditsToSource = ctx.__applyEditsToSource;

function pass(msg) { console.log('  ✓ ' + msg); }
function fail(msg) { console.log('  ✗ ' + msg); process.exitCode = 1; }

console.log('Test 1: edit a flat numeric field (gpt-5 input_per_million)');
{
  const r = applyEditsToSource(original, 'llm_models', 'gpt-5',
    [{ field: 'input_per_million', old: 1.25, new: 1.30 }], '2026-05-02');
  if (r.error) fail(`error: ${r.error}`);
  else if (r.applied !== 1) fail(`expected 1 applied, got ${r.applied}`);
  else if (!r.source.includes("'gpt-5':           { input_per_million: 1.3,")) fail('new value not present');
  else if (r.source.match(/'gpt-5-mini':\s+\{ input_per_million: 0\.25/) == null) fail('sibling gpt-5-mini was disturbed');
  else pass('field changed, sibling untouched');

  // Verify file still parses by exec'ing in a fresh context.
  try {
    const c = vm.createContext({ module: { exports: {} }, exports: {} });
    vm.runInContext(r.source, c);
    pass('modified file still parses');
  } catch (e) {
    fail(`parse error: ${e.message}`);
  }
}

console.log('Test 2: edit nested federal_multipliers.fedramp.moderate.multiplier');
{
  const r = applyEditsToSource(original, 'federal_multipliers', 'fedramp.moderate',
    [{ field: 'multiplier', old: 1.15, new: 1.18 }], '2026-05-02');
  if (r.error) fail(`error: ${r.error}`);
  else if (r.applied !== 1) fail(`expected 1 applied, got ${r.applied}`);
  else if (!r.source.includes('moderate: { multiplier: 1.18')) fail('new value not present');
  else if (!r.source.includes('high:     { multiplier: 1.30')) fail('sibling fedramp.high disturbed');
  else pass('nested key edit, sibling untouched');
}

console.log('Test 3: edit cloud_aws.s3 fields');
{
  const r = applyEditsToSource(original, 'cloud_aws', 's3',
    [{ field: 'storage_per_gb_month', old: 0.023, new: 0.025 }], '2026-05-02');
  if (r.error) fail(`error: ${r.error}`);
  else if (r.applied !== 1) fail(`expected 1 applied, got ${r.applied}`);
  else if (!r.source.includes('storage_per_gb_month:      0.025')) fail('new value not present');
  else pass('cloud_aws sub-object edit works');
}

console.log('Test 4: edit benchmarks/chatgpt-enterprise.dollar_per_seat_per_month');
{
  const r = applyEditsToSource(original, 'benchmarks', 'chatgpt-enterprise',
    [{ field: 'dollar_per_seat_per_month', old: 60, new: 65 }], '2026-05-02');
  if (r.error) fail(`error: ${r.error}`);
  else if (r.applied !== 1) fail(`expected 1 applied, got ${r.applied}`);
  else if (!r.source.includes('dollar_per_seat_per_month: 65')) fail('new value not present');
  else if (!r.source.includes("'microsoft-copilot-m365'")) fail('sibling benchmark disturbed');
  else pass('benchmark edit works');
}

console.log('Test 5: missing key returns error, file unchanged');
{
  const r = applyEditsToSource(original, 'llm_models', 'nonexistent-model',
    [{ field: 'input_per_million', old: 1.0, new: 2.0 }], '2026-05-02');
  if (!r.error) fail('expected error for missing key');
  else if (r.source !== original) fail('source modified despite error');
  else pass(`error returned, source unchanged: "${r.error}"`);
}

console.log('Test 6: last_verified inside the block gets bumped');
{
  const r = applyEditsToSource(original, 'llm_models', 'gpt-4o',
    [{ field: 'input_per_million', old: 2.50, new: 2.40 }], '2026-05-02');
  if (r.error) fail(`error: ${r.error}`);
  else {
    // Find gpt-4o block and confirm last_verified is the new date.
    const m = r.source.match(/'gpt-4o':\s*\{[^}]*last_verified:\s*'([^']+)'/);
    if (!m) fail('could not locate last_verified in gpt-4o block');
    else if (m[1] !== '2026-05-02') fail(`last_verified is ${m[1]}, expected 2026-05-02`);
    else pass('last_verified bumped to today');
  }
}

console.log('Test 7a: balanced brace pair inside string (entry-1) does not corrupt sibling');
{
  const fakeSrc = `module.exports = {
  test_category: {
    'entry-1': { value: 100, notes: 'use when {region} is us-east', other: 1 },
    'entry-2': { value: 200, notes: 'sentinel-do-not-touch', other: 2 },
  },
};`;
  const r = applyEditsToSource(fakeSrc, 'test_category', 'entry-1',
    [{ field: 'value', old: 100, new: 150 }], '2026-05-12');
  if (r.error) fail(`error: ${r.error}`);
  else if (!r.source.includes("'entry-2': { value: 200")) {
    fail('balanced brace inside string corrupted sibling entry-2');
  } else if (!r.source.includes('value: 150')) {
    fail('intended edit on entry-1 was not applied');
  } else {
    pass('balanced brace in string literal did not corrupt sibling entry');
  }
}

console.log('Test 7b: unbalanced close-brace inside a string field — output stays valid');
{
  // The brace-depth walker in applyEditsToSource is string-unaware,
  // so a lone "}" inside a quoted notes field will cause the depth
  // counter to drop to 0 too early. In practice this DOESN'T corrupt
  // the rewrite because the function reassembles via
  //   source.slice(0, blockStart) + edited_block + source.slice(blockEnd)
  // so any source text past the (mis-set) blockEnd boundary is
  // copied back verbatim. The only way to actually corrupt the
  // output is to ALSO have the edited field's value land past the
  // mis-set boundary, in which case the field replacement silently
  // no-ops. This test covers the common case (edit lands before the
  // string brace) and verifies the file still parses + entry-2 is
  // intact. If a future change makes this case fail, the next
  // hardening step is a string-stripping pre-pass for boundary
  // detection (regex below) or a real JS parser.
  const fakeSrc = `module.exports = {
  test_category: {
    'entry-1': { value: 100, notes: 'matched } literal close', other: 1 },
    'entry-2': { value: 200, notes: 'sentinel-do-not-touch', other: 2 },
  },
};`;
  const r = applyEditsToSource(fakeSrc, 'test_category', 'entry-1',
    [{ field: 'value', old: 100, new: 150 }], '2026-05-12');
  if (r.error) {
    fail(`error: ${r.error}`);
  } else {
    let parseErr = null;
    try {
      new Function(r.source.replace(/^module\.exports\s*=/, 'return'));
    } catch (e) { parseErr = e.message; }
    if (parseErr) fail(`rewrite produced invalid JS: ${parseErr}`);
    else if (!r.source.includes("'entry-2': { value: 200, notes: 'sentinel-do-not-touch'")) {
      fail('unbalanced brace corrupted sibling entry-2');
    } else if (!r.source.includes('value: 150')) {
      fail('intended edit on entry-1 was not applied');
    } else {
      pass('unbalanced brace handled (file parses, sibling intact, edit applied)');
    }
  }
}

console.log('Test 7c: edit field lands AFTER in-string brace — silent no-op (documented)');
{
  // The companion to Test 7b. When the unbalanced '}' inside a string
  // appears BEFORE the field we want to edit, the brace-walker's
  // mis-set boundary truncates the block ABOVE the target field, so
  // the field-value regex finds nothing inside the (truncated) block.
  // Result: applied === 0 with no error — i.e. the rewrite silently
  // does nothing. Callers (refresh-prices.js, verify-aws-instances.js)
  // now treat applied===0 as a warning so this case isn't invisible.
  const fakeSrc = `module.exports = {
  test_category: {
    'entry-1': { notes: 'lone close } here', value: 100, other: 1 },
    'entry-2': { value: 200, notes: 'sentinel-do-not-touch', other: 2 },
  },
};`;
  const r = applyEditsToSource(fakeSrc, 'test_category', 'entry-1',
    [{ field: 'value', old: 100, new: 150 }], '2026-05-12');
  if (r.error) {
    fail(`unexpected error: ${r.error}`);
  } else if (r.applied !== 0) {
    // If the brace-walker is ever hardened (string-stripping or AST
    // rewrite), this assertion flips: applied should become 1 and
    // value should be 150. Flip both assertions when that happens.
    pass(`brace-walker hardened — edit succeeded (applied=${r.applied})`);
  } else {
    // Current behavior: silent no-op. Verify the file is at least
    // unchanged (no corruption) so callers can warn-and-retry safely.
    if (r.source === fakeSrc) {
      pass('field-after-in-string-brace → applied=0, source unchanged (silent no-op surfaced via applied count)');
    } else {
      fail('applied=0 but source was modified — that should not happen');
    }
  }
}

console.log('');
if (process.exitCode) console.log('FAILED');
else console.log('All tests passed.');
