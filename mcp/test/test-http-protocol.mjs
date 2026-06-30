#!/usr/bin/env node
/* test-http-protocol.mjs — T1 HTTP transport smoke test.
 *
 * Tests the Cloudflare Worker MCP endpoint via raw HTTP (mimicking an MCP
 * client) against a running wrangler dev instance. Defaults to
 * http://localhost:8787; override with MCP_URL env var.
 *
 * Run against wrangler dev:
 *   npx wrangler dev &
 *   node mcp/test/test-http-protocol.mjs
 *
 * Run against production:
 *   MCP_URL=https://calc.ajinkya.ai node mcp/test/test-http-protocol.mjs
 */

const BASE = (process.env.MCP_URL || 'http://localhost:8787').replace(/\/$/, '');
const URL_MCP = `${BASE}/mcp`;

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS ${name}${detail ? '  — ' + detail : ''}`);
    passed++;
  } else {
    console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`);
    failed++;
  }
}

async function rpc(method, params = {}, id = 1) {
  const res = await fetch(URL_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`HTTP ${res.status} for ${method}`);
  }
  return res.json();
}

console.log(`[http-protocol smoke — ${URL_MCP}]`);

// T1-1: initialize
const initRes = await rpc('initialize', {
  protocolVersion: '2025-03-26',
  clientInfo: { name: 'test-client', version: '0.0.1' },
  capabilities: {},
});
ok('initialize succeeds', initRes.result?.serverInfo?.name === 'cost-calc',
  `serverInfo.name = ${initRes.result?.serverInfo?.name}`);
ok('instructions present', typeof initRes.result?.instructions === 'string' && initRes.result.instructions.length > 20);

// T1-2: tools/list
const toolsRes = await rpc('tools/list', {}, 2);
const toolNames = (toolsRes.result?.tools || []).map((t) => t.name);
const EXPECTED_TOOLS = ['list_presets', 'load_preset', 'get_schema', 'validate_workload', 'compute_cost', 'make_share_link'];
ok('tools/list returns 6 tools', toolNames.length === EXPECTED_TOOLS.length, `got ${toolNames.length}`);
for (const t of EXPECTED_TOOLS) {
  ok(`tool ${t} present`, toolNames.includes(t));
}

// T1-3: prompts/list
const promptsRes = await rpc('prompts/list', {}, 3);
const promptNames = (promptsRes.result?.prompts || []).map((p) => p.name);
ok('prompts/list returns cost_interview', promptNames.includes('cost_interview'));

// T1-4: compute_cost with archetype-agent-demo (headline must be 45070)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');

const agentDemo = JSON.parse(readFileSync(path.join(root, 'public/examples/archetype-agent-demo.json'), 'utf8'));
const computeRes = await rpc('tools/call', {
  name: 'compute_cost',
  arguments: { workload: agentDemo },
}, 4);
const computeText = computeRes.result?.content?.[0]?.text;
const computeObj = computeText ? JSON.parse(computeText) : null;
ok('compute_cost returns headline_monthly_usd', typeof computeObj?.headline_monthly_usd === 'number',
  `got ${computeObj?.headline_monthly_usd}`);
ok('archetype-agent-demo headline == 45070', computeObj?.headline_monthly_usd === 45070,
  `got ${computeObj?.headline_monthly_usd}`);

console.log(`\nhttp-protocol: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
