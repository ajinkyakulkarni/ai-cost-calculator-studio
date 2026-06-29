#!/usr/bin/env node
/* test-cors.mjs — T3 CORS check.
 *
 * Verifies that /mcp returns the correct CORS headers on preflight (OPTIONS)
 * and on actual POST requests with an Origin header.
 *
 * Run against wrangler dev:
 *   npx wrangler dev &
 *   node mcp/test/test-cors.mjs
 *
 * Run against production:
 *   MCP_URL=https://calc.ajinkya.ai node mcp/test/test-cors.mjs
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

console.log(`[cors — ${URL_MCP}]`);

// T3-1: OPTIONS preflight
const preflightRes = await fetch(URL_MCP, {
  method: 'OPTIONS',
  headers: {
    'Origin': 'https://example.com',
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'Content-Type',
  },
});
ok('OPTIONS returns 204', preflightRes.status === 204, `status=${preflightRes.status}`);
ok('OPTIONS Access-Control-Allow-Origin: *',
  preflightRes.headers.get('Access-Control-Allow-Origin') === '*');
ok('OPTIONS Access-Control-Allow-Methods includes POST',
  (preflightRes.headers.get('Access-Control-Allow-Methods') || '').includes('POST'));
ok('OPTIONS Access-Control-Allow-Headers includes Content-Type',
  (preflightRes.headers.get('Access-Control-Allow-Headers') || '').includes('Content-Type'));

// T3-2: POST with Origin header should also include CORS headers
const postRes = await fetch(URL_MCP, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Origin': 'https://example.com',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  }),
});
ok('POST with Origin returns 200', postRes.status === 200, `status=${postRes.status}`);
ok('POST Access-Control-Allow-Origin: *',
  postRes.headers.get('Access-Control-Allow-Origin') === '*');

console.log(`\ncors: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
