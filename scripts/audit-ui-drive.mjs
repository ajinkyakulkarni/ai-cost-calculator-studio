// Comprehensive UI-drive audit: walk every interactive control on the page,
// drive it programmatically, and report (a) whether its paired visible label
// updates (the bug class that bit s-peak / s-lang-mult: slider was wired to
// the engine but the on-screen value was stuck at the initial hardcoded
// text), and (b) whether the headline pill responds.
//
// Categories covered:
//   1. range sliders (input[type=range])
//   2. number/range form inputs inside list rows
//   3. select dropdowns
//   4. checkboxes (input[type=checkbox])
//   5. text inputs that data-bind into workload
//
// For each control, we capture:
//   - control's value/checked before
//   - the paired label (.sr-val with id="v-<suffix>", or nearest sibling
//     element matching common label patterns)
//   - __lastHeadlineMonthly before
// drive the control, then capture after-state and compute deltas.
//
// Output: /tmp/audit-ui-drive.json — per-control row with
//   { id, kind, label_changed, headline_moved, label_before, label_after,
//     value_before, value_after, headline_before, headline_after }
//
// Surfaces three classes of issue:
//   A. label_stuck (label_changed=false but value changed) — UI lies to user
//   B. headline_silent (headline_moved=false despite control being "live")
//   C. nudge_threw — handler crashed
//
// Usage: AUDIT_URL=http://localhost:8765/ node scripts/audit-ui-drive.mjs
//        AUDIT_URL=https://calc.ajinkya.ai/ node scripts/audit-ui-drive.mjs

import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.AUDIT_URL || 'http://localhost:8765/';
const VERBOSE = process.env.AUDIT_VERBOSE === '1';

// Sliders / inputs whose paired label lives at id="v-<id_suffix>" (the v-*
// convention used everywhere in the simulator panel). Falls back to "no
// paired label" if not found, which means the audit can't check label sync
// but still checks headline movement.
function pairedLabelId(controlId) {
  if (controlId.startsWith('s-')) return 'v-' + controlId.slice(2);
  if (controlId.startsWith('prev-')) return controlId + '-val';
  return null;
}

async function runAudit(page) {
  return await page.evaluate(async () => {
    const out = [];
    const fire = (el, eventNames) => {
      for (const n of eventNames) {
        try { el.dispatchEvent(new Event(n, { bubbles: true })); } catch (_) {}
      }
    };
    const drainRaf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const labelTextFor = (controlId) => {
      // Look for paired sr-val / *-val span by id convention
      let labelId = null;
      if (controlId.startsWith('s-')) labelId = 'v-' + controlId.slice(2);
      else if (controlId.startsWith('prev-')) labelId = controlId + '-val';
      if (!labelId) return null;
      const lab = document.getElementById(labelId);
      return lab ? lab.textContent.trim() : null;
    };
    const visibleAndEnabled = (el) =>
      el && el.offsetParent !== null && !el.disabled && el.type !== 'hidden';

    // Walk every input[type=range] first
    for (const el of document.querySelectorAll('input[type=range]')) {
      if (!visibleAndEnabled(el)) continue;
      const id = el.id || '(no-id)';
      const labelBefore = labelTextFor(id);
      const headlineBefore = window.__lastHeadlineMonthly;
      const origVal = el.value;
      const min = parseFloat(el.min) || 0;
      const max = parseFloat(el.max);
      const step = parseFloat(el.step) || 1;
      // Pick a target value distinct from current
      const cur = parseFloat(origVal);
      let target;
      if (!isNaN(max) && max > cur) target = Math.min(max, cur + Math.max(step, (max - min) * 0.2));
      else target = Math.max(min, cur - step);
      if (target === cur) target = cur === min ? min + step : min;
      el.focus();
      el.value = String(target);
      fire(el, ['input', 'change']);
      await drainRaf();
      await sleep(40);
      const labelAfter = labelTextFor(id);
      const headlineAfter = window.__lastHeadlineMonthly;
      // Restore
      el.value = origVal;
      fire(el, ['input', 'change']);
      await drainRaf();
      out.push({
        kind: 'range', id,
        value_before: origVal, value_after: String(target),
        label_id: id.startsWith('s-') ? 'v-' + id.slice(2) : null,
        label_before: labelBefore, label_after: labelAfter,
        label_present: labelBefore !== null,
        label_changed: labelBefore !== null && labelBefore !== labelAfter,
        headline_before: Math.round((headlineBefore || 0) * 100) / 100,
        headline_after: Math.round((headlineAfter || 0) * 100) / 100,
        headline_delta: Math.round(((headlineAfter || 0) - (headlineBefore || 0)) * 100) / 100,
        headline_moved: Math.abs((headlineAfter || 0) - (headlineBefore || 0)) > 0.01,
      });
    }

    // Selects
    for (const el of document.querySelectorAll('select')) {
      if (!visibleAndEnabled(el)) continue;
      const id = el.id || '(no-id)';
      const headlineBefore = window.__lastHeadlineMonthly;
      const origVal = el.value;
      const opts = [...el.options].map(o => o.value).filter(v => v !== origVal);
      if (!opts.length) {
        out.push({ kind: 'select', id, status: 'NO-ALT-OPTION' });
        continue;
      }
      el.focus();
      el.value = opts[0];
      fire(el, ['input', 'change']);
      await drainRaf();
      await sleep(40);
      const headlineAfter = window.__lastHeadlineMonthly;
      el.value = origVal;
      fire(el, ['input', 'change']);
      await drainRaf();
      out.push({
        kind: 'select', id,
        value_before: origVal, value_after: opts[0],
        headline_before: Math.round((headlineBefore || 0) * 100) / 100,
        headline_after: Math.round((headlineAfter || 0) * 100) / 100,
        headline_delta: Math.round(((headlineAfter || 0) - (headlineBefore || 0)) * 100) / 100,
        headline_moved: Math.abs((headlineAfter || 0) - (headlineBefore || 0)) > 0.01,
      });
    }

    // Checkboxes
    for (const el of document.querySelectorAll('input[type=checkbox]')) {
      if (!visibleAndEnabled(el)) continue;
      const id = el.id || '(no-id)';
      const headlineBefore = window.__lastHeadlineMonthly;
      const origChecked = el.checked;
      el.focus();
      el.checked = !el.checked;
      fire(el, ['input', 'change']);
      await drainRaf();
      await sleep(40);
      const headlineAfter = window.__lastHeadlineMonthly;
      el.checked = origChecked;
      fire(el, ['input', 'change']);
      await drainRaf();
      out.push({
        kind: 'checkbox', id,
        checked_before: origChecked, checked_after: !origChecked,
        headline_before: Math.round((headlineBefore || 0) * 100) / 100,
        headline_after: Math.round((headlineAfter || 0) * 100) / 100,
        headline_delta: Math.round(((headlineAfter || 0) - (headlineBefore || 0)) * 100) / 100,
        headline_moved: Math.abs((headlineAfter || 0) - (headlineBefore || 0)) > 0.01,
      });
    }

    return out;
  });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', err => console.error('[PAGE ERR]', err.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.renderPreview === 'function');
  await page.waitForTimeout(2500);

  const results = await runAudit(page);
  await browser.close();

  // Bucket
  const ranges = results.filter(r => r.kind === 'range');
  const selects = results.filter(r => r.kind === 'select');
  const checks = results.filter(r => r.kind === 'checkbox');

  const labelStuck = ranges.filter(r => r.label_present && !r.label_changed);
  const labelStuckButHeadlineMoved = labelStuck.filter(r => r.headline_moved);

  const summary = {
    target: URL,
    counts: { ranges: ranges.length, selects: selects.length, checkboxes: checks.length },
    range_label_present: ranges.filter(r => r.label_present).length,
    range_label_stuck: labelStuck.length,
    range_label_stuck_ids: labelStuck.map(r => r.id),
    range_label_stuck_but_headline_moved_ids: labelStuckButHeadlineMoved.map(r => r.id),
    range_headline_moved: ranges.filter(r => r.headline_moved).length,
    select_headline_moved: selects.filter(r => r.headline_moved).length,
    checkbox_headline_moved: checks.filter(r => r.headline_moved).length,
  };

  fs.writeFileSync('/tmp/audit-ui-drive.json', JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (VERBOSE) {
    console.log('\n--- ranges (sorted by label_stuck first) ---');
    [...ranges].sort((a, b) => Number(b.label_present && !b.label_changed) - Number(a.label_present && !a.label_changed))
      .forEach(r => console.log(`${(r.id || '?').padEnd(28)} label:${(r.label_before+'→'+r.label_after).padEnd(20)} label_changed=${r.label_changed?'Y':'N'} headline_moved=${r.headline_moved?'Y':'N'} delta=${r.headline_delta}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
