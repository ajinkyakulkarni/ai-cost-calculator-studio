#!/usr/bin/env node
// mcp/server.mjs — stdio MCP server for the AI Cost Calculator
// Speaks JSON-RPC over stdout; do NOT console.log to stdout here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createRequire } from 'node:module';

import { listPresets, loadPreset } from './lib/presets.mjs';
import { validateWorkload } from './lib/validate.mjs';
import { computeCost } from './lib/compute.mjs';
import { shareLink } from './lib/sharelink.mjs';
import { REQUIRED, CONDITIONAL, SUGGESTIBLE } from './lib/workload-schema.mjs';

const require = createRequire(import.meta.url);
const fs = require('node:fs');

const instructions = fs.readFileSync(
  new URL('./instructions.md', import.meta.url).pathname,
  'utf8',
);
const interviewPrompt = fs.readFileSync(
  new URL('./prompts/cost-interview.md', import.meta.url).pathname,
  'utf8',
);

// SDK v1.29: McpServer(serverInfo, options) — options.instructions sets the
// instructions capability advertised to clients on initialize.
const server = new McpServer(
  { name: 'cost-calc', version: '1.0.0' },
  { instructions },
);

// Helper: wrap any JS value as MCP tool text content
const asText = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
});

// inputSchema is a raw Zod shape: { field: z.schema, ... }
// For workload tools, accept any object via z.record(z.unknown())
const workloadShape = { workload: z.record(z.unknown()) };

// ── tools ─────────────────────────────────────────────────────────────────────

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
    description:
      'Missing-required + assumptions. No compute.',
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

// ── prompts ───────────────────────────────────────────────────────────────────

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

// ── connect ───────────────────────────────────────────────────────────────────

await server.connect(new StdioServerTransport());
