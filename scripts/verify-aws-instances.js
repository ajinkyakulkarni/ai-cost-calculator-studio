#!/usr/bin/env node
/* =====================================================================
 * verify-aws-instances.js — refresh AWS EC2 GPU prices from a structured
 * source, no LLM required.
 *
 * Why this isn't part of refresh-prices.js:
 *   - aws.amazon.com instance-type pages (e.g. /ec2/instance-types/g6e/)
 *     are spec sheets, not pricing — they don't list hourly rates.
 *   - aws.amazon.com/ec2/pricing/on-demand/ is a JS-heavy SPA that
 *     fetches prices from a JSON API at runtime; raw HTML scraping
 *     returns mostly empty shells.
 *   - The official AWS Price List Bulk API
 *     (pricing.us-east-1.amazonaws.com) is too heavy for casual use:
 *     the EC2 us-east-1 file alone is ~470 MB.
 *
 * What this does instead:
 *   - Fetches https://instances.vantage.sh/aws/ec2/<instance-type> per
 *     entry. Vantage maintains a public mirror of AWS pricing with
 *     plain HTML pages that have the hourly rate inline.
 *   - Regex-extracts the on-demand hourly price.
 *   - Prints a drift report vs prices.js.
 *   - With --apply, updates prices.js using the same applyEditsToSource
 *     helper that refresh-prices.js uses.
 *
 * Usage:
 *   node scripts/verify-aws-instances.js              # dry-run
 *   node scripts/verify-aws-instances.js --apply      # write changes
 *   node scripts/verify-aws-instances.js --verbose    # print evidence
 * ===================================================================== */

'use strict';

const fs   = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

let PRICES_PATH = path.resolve(__dirname, '..', 'public', 'lib', 'prices.js');
if (!fs.existsSync(PRICES_PATH)) PRICES_PATH = path.resolve(__dirname, '..', 'lib', 'prices.js');
const Prices = require(PRICES_PATH);

const VANTAGE_BASE = 'https://instances.vantage.sh/aws/ec2/';

// Map our entry id (e.g. 'g6e.12xl') to the canonical AWS instance type
// (e.g. 'g6e.12xlarge'). Our shorter form drops the trailing 'arge'.
function toFullInstanceName(id) {
  // 'g6e.12xl' → 'g6e.12xlarge'; 'p5.48xl' → 'p5.48xlarge'
  // If already full ('g6e.12xlarge'), pass through unchanged.
  if (/xlarge$/.test(id)) return id;
  return id.replace(/xl$/, 'xlarge');
}

async function fetchVantagePrice(instanceType) {
  const url = VANTAGE_BASE + instanceType;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'cost-calculator-studio/verify-aws-instances 0.1' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const html = await resp.text();

  // Vantage renders the on-demand price as `$X.YYYYY per hour` near the
  // top of the page. The number sometimes has 5+ decimal places; cap at
  // 2 to match our existing entries.
  const m = html.match(/\$(\d+\.\d{2,6})\s+per\s+hour/);
  if (!m) {
    // Fallback: look for an embedded JSON blob with on-demand pricing.
    const j = html.match(/"on_demand"\s*:\s*"(\d+\.\d{2,6})"/);
    if (!j) throw new Error('no price pattern matched in HTML');
    return { hourly: Number(j[1]), source: url, evidence: `"on_demand":"${j[1]}"` };
  }
  return { hourly: Number(m[1]), source: url, evidence: `$${m[1]} per hour` };
}

async function main() {
  console.log(`verify-aws-instances.js — mode: ${DRY_RUN ? 'DRY-RUN' : 'APPLY'}`);

  const gpus = Prices.gpu_instances || {};
  const ids = Object.keys(gpus);
  if (ids.length === 0) {
    console.error('No gpu_instances found in prices.js');
    process.exit(1);
  }

  let checked = 0, drifted = 0, errors = 0;
  const drifts = [];

  for (const id of ids) {
    const entry = gpus[id];
    const fullName = toFullInstanceName(id);
    const current = entry.hourly;
    process.stdout.write(`[${id} → ${fullName}] `);
    try {
      const { hourly, evidence } = await fetchVantagePrice(fullName);
      const truncated = Math.round(hourly * 100) / 100;  // 2 dp to match entry style
      checked++;
      if (Math.abs(truncated - current) < 0.005) {
        console.log(`unchanged ($${current})`);
      } else {
        const pct = ((truncated - current) / current * 100).toFixed(1);
        const sign = truncated > current ? '+' : '';
        // Sanity check: GPU-instance hourly rates below $5 are almost
        // certainly mis-scraped (multi-GPU instances cost $10-100/hr).
        // Vantage's HTML for some newer instance types (p5e, p6) has
        // mislabeled markup that pairs the 'On Demand' label with what
        // appears to be a Spot or per-GPU rate. Flag these instead of
        // proposing the apply.
        const suspicious = (truncated < 5 && current > 20) || (truncated < current * 0.3 && current > 30);
        const flag = suspicious ? '  ⚠ SUSPICIOUS — manual verify' : '';
        console.log(`drift: $${current} → $${truncated} (${sign}${pct}%)${flag}`);
        if (VERBOSE) console.log(`    evidence: ${evidence}`);
        if (suspicious) {
          // Don't queue suspicious drifts for --apply.
          errors++;
        } else {
          drifted++;
          drifts.push({ id, current, scraped: truncated });
        }
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      errors++;
    }
    // Be nice — 200ms between requests
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\nsummary: checked=${checked} drifted=${drifted} errors=${errors}`);

  if (DRY_RUN) {
    if (drifts.length > 0) console.log('\nRe-run with --apply to write these changes to prices.js.');
    return;
  }

  // Apply path: re-use the same regex-replacement strategy as refresh-prices.js
  // by loading its applyEditsToSource via vm — keeps comments + ordering intact.
  if (drifts.length === 0) return;
  const vm = require('vm');
  const scraperSrc = fs.readFileSync(path.resolve(__dirname, 'refresh-prices.js'), 'utf8');
  const wrapped = scraperSrc.replace(/main\(\)\.catch[^]*$/m, '') +
    '\nglobalThis.__applyEditsToSource = applyEditsToSource;\n';
  const ctx = { require, console, process, fetch, module: { exports: {} }, exports: {}, __dirname, Buffer, setTimeout };
  vm.createContext(ctx);
  vm.runInContext(wrapped, ctx);
  const apply = ctx.__applyEditsToSource;

  let src = fs.readFileSync(PRICES_PATH, 'utf8');
  for (const d of drifts) {
    const result = apply(src, ['gpu_instances', d.id], { hourly: d.scraped });
    if (result.error) console.error(`apply failed for ${d.id}: ${result.error}`);
    else src = result.next;
  }
  fs.writeFileSync(PRICES_PATH, src);
  console.log(`Updated ${drifts.length} entries in ${PRICES_PATH}`);
}

main().catch(e => { console.error(e); process.exit(1); });
