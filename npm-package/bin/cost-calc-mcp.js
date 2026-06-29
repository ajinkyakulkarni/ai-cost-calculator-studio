#!/usr/bin/env node
// bin/cost-calc-mcp.js — thin shim: delegates to the ESM server entry.
// "type":"module" in package.json makes this file ESM automatically.
// Works on Node >= 18 (ESM bin entries are supported).
import '../mcp/server.mjs';
