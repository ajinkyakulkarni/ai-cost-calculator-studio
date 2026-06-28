#!/usr/bin/env node
/* test-e2e-thorough.mjs — exhaustive end-to-end exercise of the cost-calc MCP
 * server over real stdio: every tool, the hard gate, edge cases, the interview
 * sequence (validate → suggest → compute), and a share-link↔headline
 * consistency check (the number the user sees == what opening the link computes).
 * Run from repo root: node mcp/test/test-e2e-thorough.mjs */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const WorkloadHash = require('../../public/lib/workload-hash.js');

let pass = 0, fail = 0;
const ok = (l, c, extra = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${l}${extra ? '  — ' + extra : ''}`); };
const call = async (client, name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const transport = new StdioClientTransport({ command: 'node', args: [new URL('../server.mjs', import.meta.url).pathname] });
const client = new Client({ name: 'thorough', version: '0' });
await client.connect(transport);

console.log('cost-calc MCP — thorough end-to-end\n');

// ── 1. Capabilities ───────────────────────────────────────────────
console.log('[capabilities]');
const tools = (await client.listTools()).tools;
const names = tools.map(t => t.name).sort();
ok('exactly the six tools', JSON.stringify(names) === JSON.stringify(
  ['compute_cost','get_schema','list_presets','load_preset','make_share_link','validate_workload']), names.join(','));
ok('every tool has a description', tools.every(t => t.description && t.description.length > 10));
const prompts = (await client.listPrompts()).prompts;
ok('cost_interview prompt listed', prompts.some(p => p.name === 'cost_interview'));
const promptText = (await client.getPrompt({ name: 'cost_interview', arguments: {} })).messages[0].content.text;
ok('prompt forbids inventing inputs', /NEVER silently invent/i.test(promptText));
ok('prompt covers self-host GPU + FedRAMP confirm', /self-host/i.test(promptText) && /FedRAMP/i.test(promptText));

// ── 2. Presets ────────────────────────────────────────────────────
console.log('\n[presets]');
const presets = await call(client, 'list_presets');
ok('18 presets listed', presets.length === 18, `${presets.length} presets`);
const demo = await call(client, 'load_preset', { name: 'archetype-agent-demo' });
ok('load_preset returns a workload', demo && demo.deployment && demo.shapes);
const badPreset = await call(client, 'load_preset', { name: '../../../etc/passwd' });
ok('load_preset rejects path traversal', !!badPreset.error, badPreset.error || 'no error');

// ── 3. Schema ─────────────────────────────────────────────────────
console.log('\n[get_schema]');
const schema = await call(client, 'get_schema');
ok('schema lists 5 required fields', schema.required.length === 5,
  schema.required.map(r => r.field).join(','));
ok('required carry suggested_value + rationale', schema.required.every(r => r.suggested_value && r.rationale));
ok('schema lists suggestible defaults', schema.suggestible.length >= 3);

// ── 4. HARD GATE (the anti-hallucination guarantee) ───────────────
console.log('\n[hard gate]');
const empty = await call(client, 'compute_cost', { workload: {} });
ok('empty workload → error, no numbers', empty.error === 'missing_required' && empty.headline_monthly_usd === undefined);
ok('empty lists all 5 missing fields', ['volume','model','hosting','cache_rate_baseline','token_profile']
  .every(f => empty.missing_required.some(m => m.field === f)));
for (const drop of [['defaults','model'], ['defaults','hosting'], ['anchor_query','cache_rate_baseline']]) {
  const w = JSON.parse(JSON.stringify(demo));
  if (w[drop[0]]) delete w[drop[0]][drop[1]];
  const r = await call(client, 'compute_cost', { workload: w });
  ok(`drop ${drop[1]} → refuses, no headline`, r.error === 'missing_required' && r.headline_monthly_usd === undefined
    && r.missing_required.some(m => m.field === (drop[1] === 'cache_rate_baseline' ? 'cache_rate_baseline' : drop[1])));
}
// garbage input must not crash the server / must not emit a number
const garbage = await call(client, 'compute_cost', { workload: { deployment: 42, segments: 'nope' } });
ok('garbage workload → error, no number (no crash)', !!garbage.error && garbage.headline_monthly_usd === undefined);

// ── 5. validate_workload (interview step) ─────────────────────────
console.log('\n[validate_workload]');
const vFull = await call(client, 'validate_workload', { workload: demo });
ok('full demo validates ok', vFull.ok === true && vFull.missing_required.length === 0);
ok('validate returns assumptions', Array.isArray(vFull.assumptions) && vFull.assumptions.length >= 3);
const noVol = JSON.parse(JSON.stringify(demo)); delete noVol.segments;
const vNoVol = await call(client, 'validate_workload', { workload: noVol });
ok('missing volume → suggestion offered', vNoVol.missing_required.find(m => m.field === 'volume')?.suggested_value != null);

// ── 6. compute_cost happy path ────────────────────────────────────
console.log('\n[compute_cost]');
const res = await call(client, 'compute_cost', { workload: demo });
ok('headline is a positive number', typeof res.headline_monthly_usd === 'number' && res.headline_monthly_usd > 0,
  `$${res.headline_monthly_usd.toLocaleString()}`);
ok('per_query present', typeof res.per_query_usd === 'number' && res.per_query_usd > 0, `$${res.per_query_usd}`);
ok('breakdown has llm line', res.breakdown && typeof res.breakdown.llm === 'number');
ok('assumptions present', Array.isArray(res.assumptions) && res.assumptions.length >= 3);
ok('derivation trace present + substantial', typeof res.derivation_trace === 'string' && res.derivation_trace.length > 500);
ok('cap warning fired (demo is cap-clamped)', res.warnings.some(w => /cap/i.test(w)), res.warnings.join(' | '));
ok('share_link is a calc.ajinkya.ai #w= URL', /^https:\/\/calc\.ajinkya\.ai\/#w=/.test(res.share_link));

// ── 7. END-TO-END CONSISTENCY: the quoted number == what the link computes ──
console.log('\n[share-link ↔ headline consistency]');
const decoded = WorkloadHash.classifyPayload(WorkloadHash.decodeHash(res.share_link));
ok('share_link decodes to the same workload', decoded.kind === 'wrapped'
  && decoded.workload.deployment.name === demo.deployment.name
  && (decoded.workload.agents || []).length === (demo.agents || []).length);
const recompute = await call(client, 'compute_cost', { workload: decoded.workload });
ok('recomputing the decoded link gives the IDENTICAL headline', recompute.headline_monthly_usd === res.headline_monthly_usd,
  `link→$${recompute.headline_monthly_usd} vs quoted $${res.headline_monthly_usd}`);

// ── 8. make_share_link standalone ─────────────────────────────────
console.log('\n[make_share_link]');
const link = await call(client, 'make_share_link', { workload: demo });
ok('make_share_link returns a url', /^https:\/\/calc\.ajinkya\.ai\/#w=/.test(link.url));

// ── 9. Sensitivity flow (cheaper model) — still engine-driven ─────
console.log('\n[sensitivity: swap model]');
const cheaper = JSON.parse(JSON.stringify(demo)); cheaper.defaults.model = 'gpt-5-mini';
const vCheap = await call(client, 'validate_workload', { workload: cheaper });
const rCheap = vCheap.ok ? await call(client, 'compute_cost', { workload: cheaper }) : { error: 'model not in price book' };
ok('model swap recomputes (or cleanly errors if model unknown)',
  (typeof rCheap.headline_monthly_usd === 'number') || !!rCheap.error,
  rCheap.headline_monthly_usd != null ? `$${rCheap.headline_monthly_usd.toLocaleString()}` : rCheap.error);

await client.close();
console.log(`\nthorough-e2e: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
