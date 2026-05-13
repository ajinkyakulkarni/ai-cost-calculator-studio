#!/usr/bin/env node
/* =====================================================================
 * calc.js — standalone calculator CLI
 *
 * Reproduces the live calculator's headline number byte-for-byte from a
 * workload JSON, with no DOM, no browser, no simulator token-shape sliders.
 * Use this to:
 *   - Verify the engine's math against any preset from another agent
 *   - Run scenarios in CI / scripts without spinning up a browser
 *   - Diff two configurations for procurement defense
 *
 * The math here mirrors public/app.js's renderPreview() exactly:
 *   1. CostEngine.compute(workload, opts)          → engine result
 *   2. apiBill = result.api.monthly_capped × retryInflate
 *      where retryInflate = 1 + retry_rate × 1.5
 *   3. llmHeadline depends on opts.hosting (api / self / hybrid / onprem)
 *      and result.reservation (if enabled)
 *   4. agentEng = computeAgentEngineering(workload)  (see below)
 *   5. headline = llm + verif + federal + fixed + emb + personnel + agentEng
 *
 * Note on simulator tokens: the live UI lets users move RAG/Tools/CoT sliders
 * which feed into anchor_query.input_tokens via the simulator's own per-turn
 * token simulator. For verification purposes this CLI uses
 * anchor_query.input_tokens / output_tokens from the preset JSON as-is.
 * If a user wants to simulate different simulator slider values, they set
 * those tokens in the input workload directly. Override with --input-tok
 * and --output-tok flags.
 *
 * For full-fidelity reproduction of a live page state, use --url-hash to
 * paste the share-link hash. The hash contains the post-simulator workload
 * including any imported agents and bridged token counts. Save the hash
 * to a file first if it's long enough that your shell truncates it on
 * the command line:  `echo "PASTED_HASH" > /tmp/h && node scripts/calc.js
 * --url-hash "$(cat /tmp/h)"`.
 *
 * Usage:
 *   node scripts/calc.js --preset public-geospatial-qa
 *   node scripts/calc.js --preset public-geospatial-qa --hosting self --json
 *   node scripts/calc.js --workload my.json --retry 0.05 --json
 *   node scripts/calc.js --preset nih-clinical-trials --input-tok 8000
 *   node scripts/calc.js --preset public-geospatial-qa --verbose      # full derivation trace
 *
 * Output: human-readable summary by default; --json for machine-readable.
 * Exit 0 on success, 1 on error.
 * ===================================================================== */

'use strict';

const fs   = require('fs');
const path = require('path');

const ENGINE_PATH  = path.resolve(__dirname, '..', 'public', 'lib', 'cost-engine.js');
const PRICES_PATH  = path.resolve(__dirname, '..', 'public', 'lib', 'prices.js');
const EXAMPLES_DIR = path.resolve(__dirname, '..', 'public', 'examples');

const CostEngine = require(ENGINE_PATH);
const Prices     = require(PRICES_PATH);
// CostEngine reads window.Prices internally for personnel rates etc;
// expose Prices on a global so the engine sees it.
globalThis.Prices = Prices;

// ── Argument parsing ──────────────────────────────────────────────────
function parseArgs(argv) {
  const flag = (k, fallback) => {
    const i = argv.indexOf('--' + k);
    if (i < 0) return fallback;
    const v = argv[i + 1];
    return (v && !v.startsWith('--')) ? v : true;
  };
  return {
    preset:    flag('preset', null),
    workload:  flag('workload', null),
    urlHash:   flag('url-hash', null),   // paste the #w=... from a live calc.ajinkya.ai link
    hosting:   flag('hosting', null),    // override opts.hosting
    model:     flag('model', null),
    tier:      flag('tier', null),
    mix:       flag('mix', null),
    costMode:  flag('cost-mode', null),
    cacheRate: flag('cache', null),       // 0–1
    retryRate: flag('retry', null),       // 0–1 (decimal — 0.03 = 3%)
    botFactor: flag('bot', null),
    inputTok:  flag('input-tok', null),
    outputTok: flag('output-tok', null),
    verifCov:  flag('verif', null),
    json:      argv.includes('--json'),
    verbose:   argv.includes('--verbose') || argv.includes('-v'),
    help:      argv.includes('--help') || argv.includes('-h'),
  };
}

function help() {
  console.log(`calc.js — standalone calculator (reproduces calc.ajinkya.ai exactly)

Required (one of):
  --preset <slug>          Load examples/<slug>.json  (8 presets bundled)
  --workload <file.json>   Load arbitrary workload JSON
  --url-hash <hash>        Paste a live calc.ajinkya.ai share URL (or just
                           the hash part after #w=). This is the most
                           faithful mode — reproduces exactly what's on
                           the live page, including any simulator-imported
                           agents and bridged token counts.

Optional overrides (otherwise use workload defaults):
  --hosting api|self|hybrid|onprem
  --model <id>             e.g. gpt-5.2, claude-opus-4.7
  --tier standard|flex|batch|priority
  --mix <id>
  --cost-mode optimistic|realistic
  --cache 0.85             cache hit rate (0–1)
  --retry 0.03             retry rate (0–1)
  --bot 1.5                bot factor multiplier
  --input-tok 8000         anchor_query.input_tokens override
  --output-tok 600         anchor_query.output_tokens override
  --verif 0.10             verification coverage (0–1)

Output:
  (default)                Human-readable summary
  --json                   Machine-readable JSON
  --verbose                Full derivation trace

Presets available:
  public-geospatial-qa, doe-grid-modeling, nih-clinical-trials, noaa-storm-tracking,
  generic-startup-chatbot, health-patient-qa, legal-discovery-agent,
  finance-compliance-qa

Examples:
  node scripts/calc.js --preset public-geospatial-qa
  node scripts/calc.js --preset public-geospatial-qa --hosting self --json
  node scripts/calc.js --preset nih-clinical-trials --retry 0.05 --verbose
`);
}

// ── Workload loader ───────────────────────────────────────────────────
function loadWorkload(args) {
  if (args.workload) {
    return JSON.parse(fs.readFileSync(path.resolve(args.workload), 'utf8'));
  }
  if (args.urlHash) {
    // Live calc.ajinkya.ai encodes the workload in the URL hash after
    // '#w='. Format: base64(encodeURIComponent(JSON.stringify(workload))).
    // The CLI accepts either the full URL (we'll extract the hash) or
    // just the raw hash payload.
    let hash = args.urlHash;
    const wIdx = hash.indexOf('#w=');
    if (wIdx >= 0) hash = hash.slice(wIdx + 3);
    // Trim leading '#w=' if it was passed without the '#'
    if (hash.startsWith('w=')) hash = hash.slice(2);
    try {
      const json = decodeURIComponent(Buffer.from(hash, 'base64').toString('binary'));
      return JSON.parse(json);
    } catch (e) {
      console.error('Failed to decode --url-hash. Expected base64(encodeURIComponent(JSON)). Error: ' + e.message);
      process.exit(1);
    }
  }
  if (args.preset) {
    const file = path.join(EXAMPLES_DIR, args.preset + '.json');
    if (!fs.existsSync(file)) {
      console.error(`Preset not found: ${args.preset} (looked in ${EXAMPLES_DIR})`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  console.error('Must specify --preset <slug>, --workload <file.json>, or --url-hash <hash>. Pass --help for options.');
  process.exit(1);
}

// ── Backward-compat: map legacy deployment.fedrampTier into federal.* ─
function ensureFederalBlock(w) {
  if (!w.federal) w.federal = {};
  if (w.deployment && w.deployment.fedrampTier && (!w.federal.fedramp_tier || w.federal.fedramp_tier === 'none')) {
    w.federal.fedramp_tier = w.deployment.fedrampTier;
  }
  if (!w.federal.multi_region) w.federal.multi_region = 'single';
  return w;
}

// ── computeAgentEngineering — direct port from app.js ────────────────
// Same logic as public/app.js:767+ but uses the locally-loaded Prices
// instead of window.Prices.
function computeAgentEngineering(workload) {
  const ae = workload.agent_engineering || {};
  if (!ae.enabled) return { enabled: false, upfront: 0, amortized_monthly: 0, maintenance_monthly: 0, monthly: 0 };
  const dur   = Math.max(0, Number(ae.duration_months) || 0);
  const amort = Math.max(1, Number(ae.amortization_months) || 36);
  const helper = Math.max(0, Number(ae.helper_agent_monthly) || 0);
  const roles = Array.isArray(ae.roles) ? ae.roles : [];
  const personnel = (Prices && Prices.personnel) || {};
  let upfront = 0;
  roles.forEach(r => {
    const def = personnel[r.role] || {};
    const loaded = (def.annual_base || 0) * (def.total_comp_multiplier || 1);
    upfront += (Number(r.fte) || 0) * loaded * (dur / 12);
  });
  upfront += helper * dur;
  const amortized_monthly = upfront / amort;
  const lead = personnel.agent_design_lead || null;
  if (!lead) {
    // Fail loudly rather than silently using a hardcoded fallback that
    // can diverge from prices.js. The lead-engineer cost feeds
    // maintenance_monthly, which is part of the headline; a wrong
    // value would silently inflate or deflate the agent-engineering
    // line.
    throw new Error(
      'prices.js: personnel.agent_design_lead is missing. Update lib/prices.js to define annual_base + total_comp_multiplier for this role.'
    );
  }
  const leadLoadedAnnual = lead.annual_base * (lead.total_comp_multiplier || 1);
  const leadHourly = leadLoadedAnnual / 2080;
  const interval = Math.max(1, Number(ae.maintenance_interval_months) || 6);
  const hoursPerSession = Math.max(0, Number(ae.maintenance_hours_per_session) || 0);
  const maintenance_monthly = (leadHourly * hoursPerSession) / interval;
  return {
    enabled: true,
    upfront,
    amortized_monthly,
    maintenance_monthly,
    monthly: amortized_monthly + maintenance_monthly,
  };
}

// ── Main compute — mirrors renderPreview() exactly ───────────────────
function compute(workload, opts) {
  // Defensive deep-clone — the rest of this function mutates
  // workload.anchor_query when overrides are passed, and any caller
  // that re-uses the same workload object across multiple compute()
  // invocations would otherwise see the first call's overrides bleed
  // into the second. Cheap relative to the cost of the engine pass.
  workload = JSON.parse(JSON.stringify(workload));

  // Honor token overrides if supplied (mimics what simulator bridge would
  // write into anchor_query at runtime in the browser).
  if (Number.isFinite(opts.inputTok))  workload.anchor_query.input_tokens  = opts.inputTok;
  if (Number.isFinite(opts.outputTok)) workload.anchor_query.output_tokens = opts.outputTok;

  // Build the engine-facing opts. Field names + defaults match
  // public/app.js:1075–1089 (the opts object passed to CostEngine.compute).
  const engineOpts = {
    hosting:       opts.hosting       || workload.defaults?.hosting       || 'api',
    model:         opts.model         || workload.defaults?.model         || 'gpt-5.2',
    tier:          opts.tier          || workload.defaults?.tier          || 'standard',
    mix:           opts.mix           || workload.defaults?.mix           || 'mixed',
    costMode:      opts.costMode      || workload.defaults?.cost_mode     || 'realistic',
    botFactor:     Number.isFinite(opts.botFactor) ? opts.botFactor : 1.5,
    cacheRate:     Number.isFinite(opts.cacheRate) ? opts.cacheRate
                                                   : (workload.anchor_query?.cache_rate_baseline ?? 0.7),
    verifCoverage: Number.isFinite(opts.verifCov)  ? opts.verifCov  : (workload.verification?.coverage || 0),
  };

  const result = CostEngine.compute(workload, engineOpts);

  // Retry inflation (app.js:1109)
  const retryRate    = Number.isFinite(opts.retryRate) ? opts.retryRate : 0;
  const retryInflate = 1 + (retryRate * 1.5);
  const apiBill      = (result.api?.monthly_capped || 0) * retryInflate;

  // Headline line items (app.js:1115–1124)
  const fixedCosts      = result.fixed_costs?.total || 0;
  const verifMonthly    = result.verification?.monthly || 0;
  const federalAdditive = result.federal?.additive_total || 0;
  const embeddingMonthly = (result.embedding?.enabled ? result.embedding.monthly : 0) || 0;
  const personnelMonthly = (result.personnel?.enabled ? result.personnel.monthly : 0) || 0;
  const reservation = result.reservation || { enabled: false };
  const agentEng = computeAgentEngineering(workload);
  const agentEngMonthly = agentEng.enabled ? agentEng.monthly : 0;

  // LLM headline branch (app.js:1126–1138)
  let llmHeadline;
  if (engineOpts.hosting === 'hybrid' && result.hybrid)       llmHeadline = result.hybrid.total;
  else if (engineOpts.hosting === 'self')                     llmHeadline = result.self_host.total;
  else if (engineOpts.hosting === 'onprem')                   llmHeadline = parseFloat(workload.on_prem_monthly) || 0;
  else if (reservation.enabled)                               llmHeadline = reservation.effective_monthly;
  else                                                        llmHeadline = apiBill;

  const headlineTotal = llmHeadline + fixedCosts + verifMonthly + federalAdditive
                       + embeddingMonthly + personnelMonthly + agentEngMonthly;

  return {
    workload,
    engineOpts,
    result,
    retryRate, retryInflate,
    apiBill, apiCappedRaw: result.api?.monthly_capped || 0,
    llmHeadline,
    lines: {
      llm:                 llmHeadline,
      verification:        verifMonthly,
      federal_additive:    federalAdditive,
      fixed:               fixedCosts,
      embeddings:          embeddingMonthly,
      personnel:           personnelMonthly,
      agent_engineering:   agentEngMonthly,
    },
    headline_monthly: headlineTotal,
    headline_annual:  headlineTotal * 12,
    headline_3yr:     headlineTotal * 36,
    queries:          result.queries?.total || 0,
    per_query:        result.queries?.total > 0 ? headlineTotal / result.queries.total : 0,
    per_mau_month:    (() => {
      const totalMau = (workload.segments || []).reduce((a, s) => a + (s.mau || 0), 0);
      return totalMau > 0 ? headlineTotal / totalMau : 0;
    })(),
    agent_engineering_detail: agentEng,
  };
}

// ── Formatters ───────────────────────────────────────────────────────
function fmt$(n) { return '$' + Math.round(n).toLocaleString(); }
function fmt$2(n) { return '$' + (n || 0).toFixed(2); }
function fmtN(n) { return Math.round(n).toLocaleString(); }

function renderHuman(out, verbose) {
  const w = out.workload;
  const o = out.engineOpts;
  const r = out.result;
  const lines = [];
  lines.push('');
  lines.push('=== AI COST CALCULATOR · STANDALONE CLI ===');
  lines.push(`Deployment: ${w.deployment?.agency || ''} · ${w.deployment?.name || ''}`);
  lines.push(`Mode: ${o.hosting} · model=${o.model} · tier=${o.tier} · mix=${o.mix} · cost_mode=${o.costMode}`);
  lines.push('');
  lines.push('─── Inputs ───');
  lines.push(`  MAU:           ${fmtN((w.segments || []).reduce((a, s) => a + (s.mau || 0), 0))}`);
  lines.push(`  Cache rate:    ${(o.cacheRate * 100).toFixed(1)}%`);
  lines.push(`  Retry rate:    ${(out.retryRate * 100).toFixed(1)}%  →  inflate ${out.retryInflate.toFixed(4)}×`);
  lines.push(`  Bot factor:    ${o.botFactor}×  (effective ${(r.queries?.botEffective || 1).toFixed(2)}×)`);
  lines.push(`  FedRAMP tier:  ${w.federal?.fedramp_tier || 'none'}  (multiplier ${(r.api?.hosting_multiplier || 1).toFixed(2)}×)`);
  lines.push(`  Anchor input:  ${fmtN(w.anchor_query?.input_tokens || 0)} tok/q`);
  lines.push(`  Anchor output: ${fmtN(w.anchor_query?.output_tokens || 0)} tok/q`);
  lines.push('');
  lines.push('─── Derived ───');
  lines.push(`  Queries/mo:    ${fmtN(out.queries)}`);
  lines.push(`  Per-query $:   $${(r.api?.per_query_blended || 0).toFixed(4)}  (post-multiplier)`);
  lines.push(`  API gross:     ${fmt$(r.api?.monthly_gross || 0)}`);
  lines.push(`  API capped:    ${fmt$(out.apiCappedRaw)}  →  × retry ${out.retryInflate.toFixed(4)} = ${fmt$(out.apiBill)}`);
  lines.push('');
  lines.push('─── Headline composition ───');
  lines.push(`  ${(o.hosting === 'self' ? 'Self-host LLM' : o.hosting === 'hybrid' ? 'Hybrid LLM' : o.hosting === 'onprem' ? 'On-prem (amortized)' : 'API LLM × retry-inflate').padEnd(28)} ${fmt$(out.lines.llm).padStart(14)}`);
  if (out.lines.verification > 0)       lines.push(`+ Verification               ${fmt$(out.lines.verification).padStart(14)}`);
  if (out.lines.embeddings > 0)         lines.push(`+ Embeddings                 ${fmt$(out.lines.embeddings).padStart(14)}`);
  if (out.lines.personnel > 0)          lines.push(`+ Personnel                  ${fmt$(out.lines.personnel).padStart(14)}`);
  if (out.lines.agent_engineering > 0)  lines.push(`+ Agent engineering          ${fmt$(out.lines.agent_engineering).padStart(14)}`);
  if (out.lines.federal_additive > 0)   lines.push(`+ Federal additive           ${fmt$(out.lines.federal_additive).padStart(14)}`);
  if (out.lines.fixed > 0)              lines.push(`+ Fixed monthly              ${fmt$(out.lines.fixed).padStart(14)}`);
  lines.push('');
  lines.push(`= MONTHLY:                    ${fmt$(out.headline_monthly).padStart(14)}`);
  lines.push(`  ANNUAL:                     ${fmt$(out.headline_annual).padStart(14)}`);
  lines.push(`  3-YEAR TCO:                 ${fmt$(out.headline_3yr).padStart(14)}`);
  lines.push(`  Per-MAU/month:              ${fmt$2(out.per_mau_month).padStart(14)}`);
  lines.push(`  Per-query:                  $${out.per_query.toFixed(4).padStart(13)}`);
  lines.push('');

  if (verbose && r.derivation) {
    lines.push('─── Full engine derivation trace ───');
    lines.push(r.derivation);
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); process.exit(0); }

  const workload = ensureFederalBlock(loadWorkload(args));
  const opts = {
    hosting:   args.hosting,
    model:     args.model,
    tier:      args.tier,
    mix:       args.mix,
    costMode:  args.costMode,
    botFactor: args.botFactor === null ? null : Number(args.botFactor),
    cacheRate: args.cacheRate === null ? null : Number(args.cacheRate),
    retryRate: args.retryRate === null ? 0    : Number(args.retryRate),
    inputTok:  args.inputTok  === null ? null : Number(args.inputTok),
    outputTok: args.outputTok === null ? null : Number(args.outputTok),
    verifCov:  args.verifCov  === null ? null : Number(args.verifCov),
  };

  const out = compute(workload, opts);

  if (args.json) {
    // Strip derivation from JSON output — too long, available via verbose
    // human mode. Include enough fields for procurement diffing.
    const trimmed = {
      preset: args.preset || null,
      deployment: { name: workload.deployment?.name, agency: workload.deployment?.agency },
      mode: { hosting: out.engineOpts.hosting, model: out.engineOpts.model, tier: out.engineOpts.tier, mix: out.engineOpts.mix, cost_mode: out.engineOpts.costMode },
      inputs: { mau: (workload.segments || []).reduce((a, s) => a + (s.mau || 0), 0), cache_rate: out.engineOpts.cacheRate, retry_rate: out.retryRate, bot_factor: out.engineOpts.botFactor, fedramp_tier: workload.federal?.fedramp_tier, hosting_multiplier: out.result.api?.hosting_multiplier, anchor_input: workload.anchor_query?.input_tokens, anchor_output: workload.anchor_query?.output_tokens },
      derived: { queries_per_month: out.queries, per_query_blended: out.result.api?.per_query_blended, api_gross: out.result.api?.monthly_gross, api_capped_raw: out.apiCappedRaw, retry_inflate: out.retryInflate, api_with_retry: out.apiBill },
      lines: out.lines,
      headline: { monthly: out.headline_monthly, annual: out.headline_annual, three_year_tco: out.headline_3yr, per_mau_month: out.per_mau_month, per_query: out.per_query },
      agent_engineering_detail: out.agent_engineering_detail,
    };
    console.log(JSON.stringify(trimmed, null, 2));
  } else {
    console.log(renderHuman(out, args.verbose));
  }
}

try { main(); }
catch (e) { console.error('ERROR:', e.message); process.exit(1); }
