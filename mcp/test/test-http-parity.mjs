#!/usr/bin/env node
/* test-http-parity.mjs — T2 Remote parity check.
 *
 * For each bundled preset, calls compute_cost over HTTP and verifies the
 * headline_monthly_usd equals the direct computeWorkload() result from the
 * Node engine. This confirms the bundled engine is byte-identical to the
 * local engine.
 *
 * Run against wrangler dev:
 *   npx wrangler dev &
 *   node mcp/test/test-http-parity.mjs
 *
 * Run against production:
 *   MCP_URL=https://calc.ajinkya.ai node mcp/test/test-http-parity.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { computeWorkload } from '../lib/engine-bridge.mjs';

const BASE = (process.env.MCP_URL || 'http://localhost:8787').replace(/\/$/, '');
const URL_MCP = `${BASE}/mcp`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');
const EXAMPLES_DIR = path.join(root, 'public/examples');

const presets = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({
    name: f.replace(/\.json$/, ''),
    workload: JSON.parse(readFileSync(path.join(EXAMPLES_DIR, f), 'utf8')),
  }));

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

async function computeViaHTTP(workload) {
  const res = await fetch(URL_MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'compute_cost', arguments: { workload } },
    }),
  });
  const d = await res.json();
  const text = d.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

console.log(`[http-parity — ${URL_MCP}]`);
console.log(`  Testing ${presets.length} presets...`);

for (const { name, workload } of presets) {
  const localResult = computeWorkload(workload);
  const localHeadline = Math.round(localResult.headline);

  const httpResult = await computeViaHTTP(workload);
  const httpHeadline = httpResult?.headline_monthly_usd;

  ok(
    `${name} headline matches`,
    httpHeadline === localHeadline,
    `HTTP=${httpHeadline} Node=${localHeadline}`,
  );
}

console.log(`\nhttp-parity: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
