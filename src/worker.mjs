/* worker.mjs — Cloudflare Workers entry point for calc.ajinkya.ai
 *
 * Routes POST /mcp and GET /mcp to the MCP handler (stateless
 * WebStandardStreamableHTTPServerTransport, new instance per request).
 * All other paths fall through to env.ASSETS.fetch() — the static calc site.
 *
 * Transport: SDK v1.29 WebStandardStreamableHTTPServerTransport (stateless)
 * Rate-limiting: Cloudflare native rate limiting via RATE_LIMITER binding
 * CORS: permissive Access-Control-Allow-Origin: * for browser MCP clients
 */

import { McpServer }                              from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport }
  from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z }                                      from 'zod';

import { listPresets, loadPreset } from './presets-worker.mjs';
import { validateWorkload }        from '../mcp/lib/validate.mjs';
import { computeCost }             from './compute-worker.mjs';
import { shareLink }               from './sharelink-worker.mjs';
import { REQUIRED, CONDITIONAL, SUGGESTIBLE } from '../mcp/lib/workload-schema.mjs';
import { instructions, interviewPrompt }       from './text-assets.mjs';

// ── CORS headers ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
};

function corsResponse(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

// ── MCP server factory ───────────────────────────────────────────────────────
// New instance per request (stateless mode requirement of the SDK).

const asText = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
});

const workloadShape = { workload: z.record(z.unknown()) };

function buildMcpServer() {
  const server = new McpServer(
    { name: 'cost-calc', version: '1.0.0' },
    { instructions },
  );

  // ── tools ────────────────────────────────────────────────────────────────

  server.registerTool(
    'list_presets',
    {
      title: 'List presets',
      description: 'Bundled example deployments to start from.',
    },
    async () => asText(listPresets()),
  );

  server.registerTool(
    'load_preset',
    {
      title: 'Load preset',
      description: 'Return a preset workload to adapt.',
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      try {
        return asText(loadPreset(name));
      } catch (e) {
        return asText({ error: e.message });
      }
    },
  );

  server.registerTool(
    'get_schema',
    {
      title: 'Get schema',
      description: 'Required vs suggestible workload fields + docs.',
    },
    async () =>
      asText({
        required: REQUIRED.map((r) => ({
          field: r.field,
          why: r.why,
          suggested_value: r.suggested_value,
          rationale: r.rationale,
        })),
        conditional: CONDITIONAL.map((c) => ({ field: c.field, why: c.why })),
        suggestible: SUGGESTIBLE.map((s) => ({
          field: s.field,
          default: s.default,
        })),
      }),
  );

  server.registerTool(
    'validate_workload',
    {
      title: 'Validate workload',
      description: 'Missing-required + assumptions. No compute.',
      inputSchema: workloadShape,
    },
    async ({ workload }) => asText(validateWorkload(workload)),
  );

  server.registerTool(
    'compute_cost',
    {
      title: 'Compute cost',
      description:
        'Cost via the canonical engine. Refuses until required inputs are present.',
      inputSchema: workloadShape,
    },
    async ({ workload }) => asText(computeCost(workload)),
  );

  server.registerTool(
    'make_share_link',
    {
      title: 'Make share link',
      description:
        'calc.ajinkya.ai URL that opens this workload in the visual UI.',
      inputSchema: workloadShape,
    },
    async ({ workload }) => asText({ url: shareLink(workload) }),
  );

  // ── prompts ─────────────────────────────────────────────────────────────

  server.registerPrompt(
    'cost_interview',
    {
      title: 'Cost interview',
      description: 'Guided interview to cost a deployment.',
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: interviewPrompt },
        },
      ],
    }),
  );

  return server;
}

// ── Rate-limit check ─────────────────────────────────────────────────────────
// Returns a 429 Response if the rate limit is exceeded; null otherwise.
// RATE_LIMITER is a Cloudflare Rate Limiting API binding (60 req/min per IP).
// In wrangler dev without the binding provisioned, the check is skipped.

async function checkRateLimit(env, request) {
  if (!env.RATE_LIMITER) return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return corsResponse(
      429,
      JSON.stringify({ error: 'rate_limited', message: 'Too many requests. Try again in a minute.' }),
      { 'Content-Type': 'application/json', 'Retry-After': '60' },
    );
  }
  return null;
}

// ── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    // Only intercept /mcp — everything else is the static calc site
    if (url.pathname !== '/mcp') {
      return env.ASSETS.fetch(request);
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(204, null);
    }

    // Only GET and POST are valid MCP methods
    if (request.method !== 'GET' && request.method !== 'POST') {
      return corsResponse(
        405,
        JSON.stringify({ error: 'method_not_allowed' }),
        { 'Content-Type': 'application/json', Allow: 'GET, POST, OPTIONS' },
      );
    }

    // Rate-limit check
    const rateLimitResponse = await checkRateLimit(env, request);
    if (rateLimitResponse) return rateLimitResponse;

    try {
      // Stateless mode: new transport + server per request (SDK requirement)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true, // prefer compact JSON over SSE for stateless calls
      });
      const server = buildMcpServer();
      await server.connect(transport);

      const mcpResponse = await transport.handleRequest(request);

      // Attach CORS headers to the MCP response
      const responseHeaders = new Headers(mcpResponse.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) {
        responseHeaders.set(k, v);
      }
      return new Response(mcpResponse.body, {
        status: mcpResponse.status,
        headers: responseHeaders,
      });
    } catch (err) {
      return corsResponse(
        500,
        JSON.stringify({ error: 'internal_error', message: err.message }),
        { 'Content-Type': 'application/json' },
      );
    }
  },
};
