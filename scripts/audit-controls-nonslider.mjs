// Non-slider control audit. Complements scripts/audit-sliders.mjs:
//   - selects (model, hosting, tier, mix, ...)
//   - data-bind number inputs (workload-level fields)
//   - top-level checkboxes (enable verification, daily cap, ...)
//   - tab switches
//   - major expanders / collapsibles
//
// For each visible control with an id, nudge it once and report whether
// the headline cost (or DOM state, for navigation controls) actually
// reacts. A control that doesn't react when its concept implies it
// should = candidate bug (same failure mode that bit the cache slider).
//
// Usage: AUDIT_URL=https://calc.ajinkya.ai/ node scripts/audit-controls-nonslider.mjs

import { chromium } from 'playwright';

const URL = process.env.AUDIT_URL || 'http://localhost:8765/';

// Sliders already covered by audit-sliders.mjs — skip here.
const SLIDER_IDS_COVERED = new Set([
  's-users','s-turns','s-sessions','s-agents','s-peak','s-lang-mult','s-growth',
  's-cache','s-cache-write-share','s-batch','s-retry','s-context-compression',
  's-comm-pattern','s-parallel-branches','s-concurrent-quota','s-rate-overage',
  's-tool-response-mode','s-tool-templated-cap','s-doc-pages','s-doc-pdfs',
  's-doc-stages-pct','s-doc-tok-page','s-pause-hrs','s-pauses','s-rerun',
  's-storage-rate','s-stage-handoff','s-template-runs','s-fc-in','s-fc-pct',
  's-fc-price',
]);

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.renderPreview === 'function');
  await page.waitForTimeout(2000);

  // SELECTS, NUMBER INPUTS, CHECKBOXES
  const ctrlResults = await page.evaluate((coveredArr) => {
    const COVERED = new Set(coveredArr);
    const headline = () => window.__lastHeadlineMonthly;
    const fire = (el, kind) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (typeof window.onSlider === 'function') window.onSlider();
      if (typeof window.renderPreview === 'function') window.renderPreview();
    };

    function isVisible(el) {
      if (!el.offsetParent && el.tagName !== 'BODY') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function nudgeSelect(el) {
      const opts = [...el.options].map(o => o.value).filter(v => v !== '');
      const cur = el.value;
      const other = opts.find(v => v !== cur);
      if (other == null) return null;
      el.value = other; fire(el);
      return { from: cur, to: other };
    }
    function nudgeNumber(el) {
      const cur = parseFloat(el.value) || 0;
      const max = parseFloat(el.max);
      const min = parseFloat(el.min) || 0;
      let target;
      if (cur === 0) target = !isNaN(max) ? Math.min(100, max) : 100;
      else if (!isNaN(max) && cur * 1.5 <= max) target = cur * 1.5;
      else target = Math.max(min, cur * 0.5);
      if (Math.abs(target - cur) < 1e-9) target = cur + 1;
      el.value = String(target); fire(el);
      return { from: cur, to: target };
    }
    function nudgeCheckbox(el) {
      const cur = el.checked;
      el.checked = !cur; fire(el);
      return { from: cur, to: !cur };
    }
    function restore(el, kind, action) {
      try {
        if (kind === 'select') el.value = action.from;
        else if (kind === 'checkbox') el.checked = action.from;
        else el.value = String(action.from);
        fire(el);
      } catch (_) {}
    }

    function testOne(el, kind) {
      const before = headline();
      let action = null;
      try {
        if (kind === 'select')   action = nudgeSelect(el);
        else if (kind === 'checkbox') action = nudgeCheckbox(el);
        else                     action = nudgeNumber(el);
      } catch (e) { return { status: 'ERROR', error: e.message }; }
      if (!action) return { status: 'SKIP', reason: 'no alternative value' };
      const after = headline();
      const moved = (typeof before === 'number' && typeof after === 'number')
        ? Math.abs(after - before) > 0.01 : null;
      restore(el, kind, action);
      return {
        status: moved === true ? 'MOVED' : moved === false ? 'NOMOVE' : 'UNKNOWN',
        before: typeof before === 'number' ? Math.round(before*100)/100 : null,
        after: typeof after === 'number' ? Math.round(after*100)/100 : null,
        action,
      };
    }

    const rows = [];
    for (const el of document.querySelectorAll('input,select,textarea')) {
      if (!el.id || COVERED.has(el.id)) continue;
      if (!isVisible(el)) {
        rows.push({ id: el.id, kind: el.tagName === 'SELECT' ? 'select' : (el.type || 'text'),
                    section: el.closest('section,[id]')?.id || '',
                    dataBind: el.getAttribute('data-bind') || null,
                    status: 'SKIP', reason: 'hidden (collapsed/inactive panel)' });
        continue;
      }
      const tag = el.tagName;
      const kind = tag === 'SELECT' ? 'select' :
                   tag === 'TEXTAREA' ? 'text' :
                   el.type;
      if (kind === 'range') continue; // sliders covered separately
      if (kind === 'radio' || kind === 'file' || kind === 'submit' || kind === 'button' || kind === 'hidden') {
        rows.push({ id: el.id, kind, section: el.closest('section,[id]')?.id || '',
                    status: 'SKIP', reason: `kind=${kind} not auto-tested` });
        continue;
      }
      const res = testOne(el, kind === 'checkbox' ? 'checkbox' : kind === 'select' ? 'select' : 'number');
      rows.push({
        id: el.id,
        kind,
        dataBind: el.getAttribute('data-bind') || null,
        section: el.closest('section,[id]')?.id || '',
        ...res,
      });
    }
    return rows;
  }, [...SLIDER_IDS_COVERED]);

  // TABS: identify by IDs starting tab- or with role=tab; click each
  const tabResults = await page.evaluate(() => {
    const out = [];
    const tabs = [...document.querySelectorAll('[role=tab],button[id^=tab-],[data-tab]')];
    for (const t of tabs) {
      if (!t.id && !t.dataset?.tab) continue;
      const ariaSelBefore = t.getAttribute('aria-selected');
      const before = document.querySelector('[role=tabpanel][aria-hidden=false]')?.id || null;
      try { t.click(); } catch (e) {}
      const ariaSelAfter = t.getAttribute('aria-selected');
      const after = document.querySelector('[role=tabpanel][aria-hidden=false]')?.id || null;
      out.push({
        id: t.id || t.dataset.tab,
        kind: 'tab',
        before, after,
        ariaSelBefore, ariaSelAfter,
        moved: (before !== after) || (ariaSelBefore !== ariaSelAfter),
      });
    }
    return out;
  });

  // EXPANDERS: details elements + .collapsed class
  const expanderResults = await page.evaluate(() => {
    const out = [];
    for (const d of document.querySelectorAll('details')) {
      const open0 = d.open;
      d.open = !open0;
      const open1 = d.open;
      d.open = open0;
      out.push({ id: d.id || '(no-id)', kind: 'details', moved: open1 !== open0,
                 summary: d.querySelector('summary')?.textContent.slice(0,50).trim() });
    }
    for (const c of document.querySelectorAll('.collapsed[id], .collapsible[id]')) {
      out.push({ id: c.id, kind: 'collapsible', note: 'requires user-trusted click; structural-only verification', moved: 'not-tested' });
    }
    return out;
  });

  // Output as JSON for downstream report assembly
  console.log(JSON.stringify({
    summary: {
      controls_total: ctrlResults.length,
      moved: ctrlResults.filter(r => r.status === 'MOVED').length,
      nomove: ctrlResults.filter(r => r.status === 'NOMOVE').length,
      skip: ctrlResults.filter(r => r.status === 'SKIP').length,
      error: ctrlResults.filter(r => r.status === 'ERROR').length,
      tabs_total: tabResults.length, tabs_moved: tabResults.filter(t => t.moved).length,
      expanders_total: expanderResults.length, expanders_moved: expanderResults.filter(e => e.moved === true).length,
    },
    controls: ctrlResults,
    tabs: tabResults,
    expanders: expanderResults,
  }, null, 2));

  await browser.close();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
