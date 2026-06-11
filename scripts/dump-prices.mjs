#!/usr/bin/env node
/* =====================================================================
 * dump-prices.mjs — serialize prices.js to python/costcalc/prices_data.json
 *
 * Loads prices.js via require (CommonJS), strips the function-level
 * wrapper, and writes the Prices object as JSON so the Python engine
 * can consume it without a JS runtime dependency at runtime.
 *
 * GENERATED FILE — do not edit prices_data.json by hand.
 * To regenerate: node scripts/dump-prices.mjs
 *
 * Run: node scripts/dump-prices.mjs
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const require    = createRequire(import.meta.url);

const PRICES_PATH = path.resolve(__dirname, '..', 'public', 'lib', 'prices.js');
const OUT_PATH    = path.resolve(__dirname, '..', 'python', 'costcalc', 'prices_data.json');

const Prices = require(PRICES_PATH);

function stripNonFinite(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) return null;
    return obj;
  }
  if (Array.isArray(obj)) return obj.map(stripNonFinite);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = stripNonFinite(v);
    }
    return out;
  }
  return obj;
}

const cleaned = stripNonFinite(Prices);
const header = {
  _generated_by: 'scripts/dump-prices.mjs',
  _regen_command: 'node scripts/dump-prices.mjs',
  _source: 'public/lib/prices.js',
  _note: 'Do not edit by hand. Regenerate whenever prices.js changes.',
};

const output = { ...header, ...cleaned };
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`Wrote ${OUT_PATH}`);
