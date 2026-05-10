#!/usr/bin/env node
/* =====================================================================
 * refresh-prices.js — periodic price-book refresher
 *
 * Iterates priced entries in ../lib/prices.js, fetches each entry's
 * source_url, runs the page text through an LLM extractor (OpenAI), and
 * diffs the extracted numbers against the current values. By default
 * just prints a diff; --apply writes proposed changes back to the
 * source file.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/refresh-prices.js            # dry-run, all categories
 *   OPENAI_API_KEY=sk-... node scripts/refresh-prices.js --apply    # write changes
 *   node scripts/refresh-prices.js --category=llm_models            # only one category
 *   node scripts/refresh-prices.js --key=gpt-5 --category=llm_models
 *   node scripts/refresh-prices.js --limit=3                        # first 3 entries (testing)
 *   node scripts/refresh-prices.js --model=gpt-4o-mini              # extractor model
 *   node scripts/refresh-prices.js --offline                        # skip fetch+LLM, just bump last_verified
 *
 * The script edits values in place via targeted regex replacements so
 * that comments, ordering, and formatting in prices.js are preserved.
 * It never adds or removes entries — additions are intentional human
 * actions.
 * ===================================================================== */

'use strict';

const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN  = !args.includes('--apply');
const OFFLINE  = args.includes('--offline');
const VERBOSE  = args.includes('--verbose') || args.includes('-v');
const arg = (k) => {
  const found = args.find(a => a.startsWith(`--${k}=`));
  return found ? found.split('=').slice(1).join('=') : null;
};
const ONLY_CATEGORY = arg('category');
const ONLY_KEY      = arg('key');
const LIMIT         = arg('limit') ? parseInt(arg('limit'), 10) : Infinity;
const MODEL         = arg('model') || 'gpt-4o-mini';

// prices.js lives at public/lib/prices.js after the static-asset reorg,
// but earlier layouts had it at lib/prices.js. Try both so the script
// keeps working regardless of where the file is on disk.
let PRICES_PATH = path.resolve(__dirname, '..', 'public', 'lib', 'prices.js');
if (!fs.existsSync(PRICES_PATH)) {
  PRICES_PATH = path.resolve(__dirname, '..', 'lib', 'prices.js');
}
const Prices      = require(PRICES_PATH);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OFFLINE && !OPENAI_API_KEY && !DRY_RUN) {
  console.error('ERROR: OPENAI_API_KEY env var required for --apply (or pass --offline to skip extraction).');
  process.exit(1);
}

// Numeric fields the scraper is allowed to refresh. Anything not in this
// set is left alone — keeps the LLM from inventing new fields.
const NUMERIC_FIELDS = new Set([
  // llm_models
  'input_per_million', 'cached_per_million', 'output_per_million',
  // tiers / reservations
  'multiplier', 'discount', 'discount_vs_monthly', 'discount_vs_on_demand',
  'dollar_per_unit_per_month', 'throughput_per_unit_tps', 'commitment_months',
  'committed_monthly_spend',
  // gpu
  'hourly', 'tput_tps',
  // self-host modes
  'ops_monthly', 'fte_monthly', 'setup_amortized', 'throughput_derate',
  'discount_1yr', 'discount_3yr',
  // embeddings
  'dollar_per_million_tokens', 'dimensions',
  // vector dbs
  'monthly_flat', 'vector_capacity',
  'dollar_per_million_vectors_stored', 'dollar_per_million_reads', 'dollar_per_million_writes',
  // cloud aws (flat keys per sub-object)
  'commercial_per_gb', 'govcloud_per_gb',
  'put_per_1k', 'get_per_1k', 'storage_per_gb_month',
  'ia_storage_per_gb_month', 'glacier_per_gb_month', 'glacier_deep_per_gb_month',
  'logs_ingest_per_gb', 'logs_storage_per_gb_month', 'custom_metric_per_month',
  'data_processing_per_gb', 'lcu_per_hour', 'capable_qps',
  // personnel
  'annual_base', 'total_comp_multiplier',
  // ato
  'upfront', 'annual_continuous_monitoring', 'assessment_cycle_months',
  // benchmarks
  'dollar_per_seat_per_month', 'dollar_per_user_per_month', 'dollar_per_query',
  'dollar_per_conversation', 'annual_savings_estimate', 'annual_total_for_org',
  'federal_total_estimate', 'cogs_pct_of_revenue', 'median_payback_months',
  'annual_budget_estimate', 'annual_min', 'annual_max', 'case_study_user_count',
]);

// ---------------------------------------------------------------------
// Entry iteration. Walks the categories that have URL-bearing entries
// and yields (category, key, entry) tuples. Skips entries with no
// source_url since there's nothing to refresh.
// ---------------------------------------------------------------------
function* priceEntries() {
  const skip = new Set(['meta', 'self_host_cost_modes', 'getPrice', 'listKeys', 'pickRdsTier']);
  for (const category of Object.keys(Prices)) {
    if (skip.has(category)) continue;
    if (typeof Prices[category] !== 'object') continue;
    if (ONLY_CATEGORY && category !== ONLY_CATEGORY) continue;

    // Special-case categories with sub-objects (federal_multipliers, cloud_aws).
    if (category === 'federal_multipliers' || category === 'cloud_aws') {
      for (const sub of Object.keys(Prices[category])) {
        const entry = Prices[category][sub];
        if (!entry || typeof entry !== 'object') continue;
        // federal_multipliers.fedramp.{none,low,moderate,high}: walk one level deeper
        if (category === 'federal_multipliers') {
          for (const tier of Object.keys(entry)) {
            const e = entry[tier];
            if (!e || !e.source_url) continue;
            if (ONLY_KEY && tier !== ONLY_KEY) continue;
            yield { category, key: `${sub}.${tier}`, entry: e };
          }
        } else {
          // cloud_aws.{egress,s3,cloudwatch,...}: each sub-object has its own source_url
          if (!entry.source_url) continue;
          if (ONLY_KEY && sub !== ONLY_KEY) continue;
          yield { category, key: sub, entry };
        }
      }
      continue;
    }

    for (const key of Object.keys(Prices[category])) {
      const entry = Prices[category][key];
      if (!entry || typeof entry !== 'object') continue;
      if (!entry.source_url) continue;  // skip entries with no URL
      if (ONLY_KEY && key !== ONLY_KEY) continue;
      yield { category, key, entry };
    }
  }
}

// ---------------------------------------------------------------------
// Fetch + strip HTML to plain text. Caps at 30K chars to keep token use
// bounded; pricing pages typically have the relevant numbers near the
// top or in tables, so truncation is acceptable.
// ---------------------------------------------------------------------
async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (price-refresher; cost-calculator-studio)',
      'Accept':     'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  return htmlToText(html).slice(0, 30000);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------
// LLM extraction. Sends the page text + the current numeric fields and
// asks the model to return updated values. We give it the field names
// and the current numbers so it doesn't have to guess what to look for.
// ---------------------------------------------------------------------
async function extractWithLLM({ category, key, entry, pageText }) {
  const numericFields = {};
  for (const [k, v] of Object.entries(entry)) {
    if (NUMERIC_FIELDS.has(k) && typeof v === 'number') numericFields[k] = v;
  }
  if (Object.keys(numericFields).length === 0) {
    return { fields: {}, _note: 'no numeric fields to refresh' };
  }

  const sys = [
    'You are a price-book updater for AI cost calculations.',
    'Given a vendor pricing page (truncated to plain text) and a JSON object of CURRENT numeric values,',
    'return ONLY the values you can verify on the page. If a value is unchanged, omit it.',
    'If a value cannot be confirmed from the page, omit it (do not guess).',
    'Output strict JSON: { "fields": { "<field_name>": <new_number>, ... }, "evidence": "<short quote>" }.',
    'Use the same units as the input. Convert per-1K to per-million by multiplying by 1000 if the page lists per-1K.',
    'Do not invent fields not present in the input.',
  ].join(' ');

  const user = [
    `ENTRY: ${category}.${key}`,
    `NAME: ${entry.name || ''}`,
    `NOTES: ${entry.notes || ''}`,
    `CURRENT VALUES: ${JSON.stringify(numericFields)}`,
    '',
    'PAGE TEXT:',
    pageText,
  ].join('\n');

  const body = {
    model: MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      { role: 'system', content: sys },
      { role: 'user',   content: user },
    ],
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (e) { throw new Error(`LLM returned invalid JSON: ${content.slice(0, 200)}`); }

  // Sanitize: only keep fields we asked about, and only numbers.
  const clean = {};
  for (const [k, v] of Object.entries(parsed.fields || {})) {
    if (numericFields.hasOwnProperty(k) && typeof v === 'number' && isFinite(v)) {
      clean[k] = v;
    }
  }
  return { fields: clean, evidence: parsed.evidence || '' };
}

// ---------------------------------------------------------------------
// Diff. Returns { changed: bool, fields: [{ field, old, new, pct }] }.
// ---------------------------------------------------------------------
function diff(currentEntry, extractedFields) {
  const out = [];
  for (const [k, newVal] of Object.entries(extractedFields)) {
    const oldVal = currentEntry[k];
    if (oldVal === newVal) continue;
    const pct = oldVal === 0 ? Infinity : ((newVal - oldVal) / oldVal) * 100;
    out.push({ field: k, old: oldVal, new: newVal, pct });
  }
  return { changed: out.length > 0, fields: out };
}

// ---------------------------------------------------------------------
// Apply diff to the source file text. Strategy:
//   1. Locate the entry's enclosing object literal in the source.
//      We anchor on the entry key (quoted or bare) followed by ': {'.
//   2. Inside that block, regex-replace `<field>: <old>` → `<field>: <new>`.
//   3. Update last_verified to today.
//
// This is line/regex based (not AST) on purpose — keeps comments and
// trailing punctuation untouched. We also bound the replacement to the
// matched block (next balanced `}`) so we don't touch sibling entries.
// ---------------------------------------------------------------------
function applyEditsToSource(source, category, key, fieldDiffs, today) {
  // For dotted keys (federal_multipliers fedramp.moderate) we use the
  // last segment as the anchor since the JS literal key is just `moderate`.
  const lastSeg  = key.split('.').pop();
  const keyEsc   = lastSeg.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

  // Match either bare key (identifier) or quoted key.
  const blockRe = new RegExp(`(['"]?${keyEsc}['"]?\\s*:\\s*\\{)`, 'g');
  const match = blockRe.exec(source);
  if (!match) {
    return { source, applied: 0, error: `key not found in source: ${key}` };
  }

  // Find the matching closing brace, respecting nested braces.
  let i = match.index + match[0].length;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) {
    return { source, applied: 0, error: `unbalanced braces for key: ${key}` };
  }
  const blockStart = match.index + match[0].length;
  const blockEnd   = i - 1;
  let block        = source.slice(blockStart, blockEnd);
  let applied = 0;

  for (const { field, old: oldVal, new: newVal } of fieldDiffs) {
    const fEsc = field.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    // Match `<field>: <number>` allowing scientific notation and underscores.
    const numLit = String(oldVal).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const re = new RegExp(`(${fEsc}\\s*:\\s*)${numLit}\\b`);
    if (re.test(block)) {
      block = block.replace(re, `$1${newVal}`);
      applied++;
    } else {
      // Try a looser match: any number for that field in this block.
      const looseRe = new RegExp(`(${fEsc}\\s*:\\s*)([-+]?[0-9_]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)`);
      if (looseRe.test(block)) {
        block = block.replace(looseRe, `$1${newVal}`);
        applied++;
      }
    }
  }

  // Update last_verified in the block.
  const lvRe = /(last_verified\s*:\s*['"])\d{4}-\d{2}-\d{2}(['"])/;
  if (lvRe.test(block)) block = block.replace(lvRe, `$1${today}$2`);

  const newSource = source.slice(0, blockStart) + block + source.slice(blockEnd);
  return { source: newSource, applied, error: null };
}

// ---------------------------------------------------------------------
function fmtNum(n) {
  if (n == null) return 'null';
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return String(n);
}
function fmtPct(p) {
  if (!isFinite(p)) return '∞';
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(1)}%`;
}

// ---------------------------------------------------------------------
async function main() {
  console.log(`refresh-prices.js — mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}${OFFLINE ? ' (offline)' : ''}, model: ${MODEL}`);
  if (ONLY_CATEGORY) console.log(`  filter category: ${ONLY_CATEGORY}`);
  if (ONLY_KEY)      console.log(`  filter key:      ${ONLY_KEY}`);
  console.log('');

  const today  = new Date().toISOString().slice(0, 10);
  let source   = fs.readFileSync(PRICES_PATH, 'utf8');
  let totalChecked = 0;
  let totalChanged = 0;
  let totalApplied = 0;
  const errors = [];

  for (const { category, key, entry } of priceEntries()) {
    if (totalChecked >= LIMIT) break;
    totalChecked++;

    const label = `[${category}/${key}]`;
    process.stdout.write(`${label} ${entry.source_url} ... `);

    let extracted = { fields: {} };
    try {
      if (!OFFLINE) {
        const text = await fetchText(entry.source_url);
        extracted = await extractWithLLM({ category, key, entry, pageText: text });
      }
    } catch (e) {
      console.log(`FETCH/EXTRACT FAILED: ${e.message}`);
      errors.push({ category, key, error: e.message });
      continue;
    }

    const { changed, fields } = diff(entry, extracted.fields);
    if (!changed) {
      console.log('no change');
      continue;
    }
    totalChanged++;
    console.log(`${fields.length} field(s) changed`);
    for (const f of fields) {
      console.log(`    ${f.field}: ${fmtNum(f.old)} → ${fmtNum(f.new)}  (${fmtPct(f.pct)})`);
    }
    if (VERBOSE && extracted.evidence) {
      console.log(`    evidence: ${extracted.evidence.slice(0, 200)}`);
    }

    if (!DRY_RUN) {
      const res = applyEditsToSource(source, category, key, fields, today);
      if (res.error) {
        console.log(`    SKIP WRITE: ${res.error}`);
        errors.push({ category, key, error: res.error });
      } else {
        source = res.source;
        totalApplied += res.applied;
        console.log(`    wrote ${res.applied} field(s)`);
      }
    }
  }

  if (!DRY_RUN && totalApplied > 0) {
    // Bump meta.last_checked.
    source = source.replace(/(last_checked\s*:\s*['"])\d{4}-\d{2}-\d{2}(['"])/, `$1${today}$2`);
    fs.writeFileSync(PRICES_PATH, source);
    console.log('');
    console.log(`✅ wrote ${totalApplied} field updates to ${path.relative(process.cwd(), PRICES_PATH)}`);
  }

  console.log('');
  console.log(`summary: checked=${totalChecked} changed=${totalChanged} applied=${totalApplied} errors=${errors.length}`);
  if (errors.length) {
    console.log('errors:');
    for (const e of errors) console.log(`  ${e.category}/${e.key}: ${e.error}`);
  }
  if (DRY_RUN && totalChanged > 0) {
    console.log('');
    console.log('Re-run with --apply to write these changes to lib/prices.js.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
