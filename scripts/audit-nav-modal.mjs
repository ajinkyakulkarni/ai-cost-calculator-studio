// Nav + modal + keyboard audit. Extends the audit-* suite to cover:
//   - Top-level tab buttons (.tab-btn[data-tab]) and the wizard sidebar
//     (.tab-btn[data-wiz]). Click each, verify the page doesn't throw
//     and the relevant panel/anchor becomes active.
//   - JSON modal (#json-btn opens, .json-modal-tab[data-tab] sub-tabs,
//     #json-modal-close closes). Open → switch each sub-tab → close.
//     Verify data-open transitions correctly and no errors.
//   - Bench chart tabs (#bench-chart-tabs > [role=tab]) if visible.
//     Click each.
//   - Keyboard focus cycle. Press Tab 50 times, capture activeElement
//     chain, verify no page errors and that focus advances (i.e. it
//     doesn't trap).
//
// Output: /tmp/audit-nav-modal.json
//
// Usage: AUDIT_URL=http://localhost:8765/ node scripts/audit-nav-modal.mjs
//        AUDIT_URL=https://calc.ajinkya.ai/ node scripts/audit-nav-modal.mjs

import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.AUDIT_URL || 'http://localhost:8765/';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') pageErrors.push(`[console.error] ${msg.text()}`);
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.renderPreview === 'function', { timeout: 60000 });
  await page.waitForTimeout(2000);

  const out = { url: URL, tabs: [], modal: {}, bench_tabs: [], keyboard: {}, page_errors_total: 0 };

  // ---------- 1. Tabs ----------
  // Enumerate. Snapshot before, click, snapshot after.
  const tabButtons = await page.evaluate(() => {
    return [...document.querySelectorAll('.tab-btn')].map(b => ({
      data_tab: b.dataset.tab || null,
      data_wiz: b.dataset.wiz || null,
      data_wiz_anchor: b.dataset.wizAnchor || null,
      visible: b.offsetParent !== null,
      label: (b.textContent || '').trim().slice(0, 50),
    }));
  });
  for (const t of tabButtons) {
    const beforeErrors = pageErrors.length;
    const target = t.data_tab ? `[data-tab="${t.data_tab}"]` : `[data-wiz="${t.data_wiz}"]`;
    try {
      const handle = await page.$(`.tab-btn${target}`);
      if (!handle) { out.tabs.push({ ...t, status: 'NOT-FOUND' }); continue; }
      await handle.click({ timeout: 3000, force: true });
      await page.waitForTimeout(150);
      // Capture active panel for top-level tabs; for wizard, capture anchor visibility
      const activeInfo = await page.evaluate((cfg) => {
        if (cfg.data_tab) {
          const panels = [...document.querySelectorAll('[data-tab-panel]')];
          const active = panels.find(p => p.classList.contains('active'));
          return { active_panel: active ? active.dataset.tabPanel : null };
        } else if (cfg.data_wiz_anchor) {
          const anchor = document.getElementById(cfg.data_wiz_anchor);
          if (!anchor) return { anchor_found: false };
          const rect = anchor.getBoundingClientRect();
          return {
            anchor_found: true,
            anchor_in_viewport: rect.top >= -100 && rect.top < window.innerHeight,
          };
        }
        return {};
      }, t);
      out.tabs.push({
        ...t,
        clicked: true,
        ...activeInfo,
        new_page_errors: pageErrors.length - beforeErrors,
      });
    } catch (e) {
      out.tabs.push({ ...t, status: 'CLICK-THREW', error: e.message.slice(0, 100) });
    }
  }
  // Return to the workspace tab to leave state clean for the next audits
  await page.evaluate(() => { if (typeof window.__switchToTab === 'function') window.__switchToTab('workspace'); });
  await page.waitForTimeout(300);

  // ---------- 2. JSON modal ----------
  const modalBeforeErrors = pageErrors.length;
  try {
    // #json-btn lives inside the appbar share dropdown — open the dropdown
    // first, then click the JSON item. Force-click to bypass nuanced
    // visibility checks (the menu uses opacity/transform transitions).
    await page.click('#appbar-share-trigger', { timeout: 2000, force: true });
    await page.waitForTimeout(150);
    await page.click('#json-btn', { timeout: 2000, force: true });
    await page.waitForTimeout(200);
    const opened = await page.evaluate(() => document.getElementById('json-modal')?.dataset.open === '1');
    const subTabs = await page.evaluate(() => [...document.querySelectorAll('.json-modal-tab')].map(t => t.dataset.tab));
    const subTabResults = [];
    for (const sub of subTabs) {
      try {
        await page.click(`.json-modal-tab[data-tab="${sub}"]`, { timeout: 1500, force: true });
        await page.waitForTimeout(100);
        const isActive = await page.evaluate((s) => {
          const t = document.querySelector(`.json-modal-tab[data-tab="${s}"]`);
          return t ? t.classList.contains('active') : null;
        }, sub);
        subTabResults.push({ tab: sub, active_after_click: isActive });
      } catch (e) {
        subTabResults.push({ tab: sub, error: e.message.slice(0, 100) });
      }
    }
    await page.click('#json-modal-close', { timeout: 2000, force: true });
    await page.waitForTimeout(200);
    const closed = await page.evaluate(() => document.getElementById('json-modal')?.dataset.open !== '1');
    out.modal = {
      opener_button: '#json-btn',
      opened_after_click: opened,
      sub_tabs: subTabResults,
      closed_after_close_click: closed,
      new_page_errors: pageErrors.length - modalBeforeErrors,
    };
  } catch (e) {
    out.modal = { error: e.message.slice(0, 200) };
  }

  // ---------- 3. Bench-chart sub-tabs ----------
  const benchBeforeErrors = pageErrors.length;
  try {
    // Switch to benchmarks panel first
    await page.evaluate(() => { if (typeof window.__switchToTab === 'function') window.__switchToTab('benchmarks'); });
    await page.waitForTimeout(400);
    const benchTabs = await page.evaluate(() => {
      const host = document.getElementById('bench-chart-tabs');
      if (!host) return [];
      return [...host.querySelectorAll('[role=tab], button')].map((b, i) => ({
        index: i,
        label: (b.textContent || '').trim().slice(0, 30),
      }));
    });
    for (const bt of benchTabs) {
      try {
        // Click by index within the bench-chart-tabs host
        await page.evaluate((i) => {
          const host = document.getElementById('bench-chart-tabs');
          const btns = [...host.querySelectorAll('[role=tab], button')];
          if (btns[i]) btns[i].click();
        }, bt.index);
        await page.waitForTimeout(100);
        out.bench_tabs.push({ ...bt, clicked: true });
      } catch (e) {
        out.bench_tabs.push({ ...bt, error: e.message.slice(0, 100) });
      }
    }
    out.bench_tabs_new_page_errors = pageErrors.length - benchBeforeErrors;
  } catch (e) {
    out.bench_tabs_error = e.message.slice(0, 200);
  }

  // Restore to workspace
  await page.evaluate(() => { if (typeof window.__switchToTab === 'function') window.__switchToTab('workspace'); });
  await page.waitForTimeout(300);

  // ---------- 4. Keyboard focus cycle ----------
  const kbdBeforeErrors = pageErrors.length;
  const focusChain = [];
  // Click body to reset focus
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 50; i++) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return {
        tag: el.tagName,
        id: el.id || null,
        type: el.type || null,
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
        visible: el.offsetParent !== null || el === document.body,
      };
    });
    focusChain.push(active);
  }
  out.keyboard = {
    presses: 50,
    distinct_elements: new Set(focusChain.map(f => f && (f.id || f.tag))).size,
    chain_sample: focusChain.slice(0, 10),
    last_5: focusChain.slice(-5),
    invisible_focused: focusChain.filter(f => f && !f.visible).length,
    new_page_errors: pageErrors.length - kbdBeforeErrors,
  };

  out.page_errors_total = pageErrors.length;
  out.page_errors_sample = pageErrors.slice(0, 5);

  await browser.close();

  // Summary
  const summary = {
    url: URL,
    tabs_clicked: out.tabs.filter(t => t.clicked).length,
    tabs_total: out.tabs.length,
    tabs_with_errors: out.tabs.filter(t => t.new_page_errors > 0).length,
    tab_click_failures: out.tabs.filter(t => t.status === 'CLICK-THREW' || t.status === 'NOT-FOUND').length,
    modal_opens: !!out.modal.opened_after_click,
    modal_closes: !!out.modal.closed_after_close_click,
    modal_sub_tabs_work: (out.modal.sub_tabs || []).every(s => s.active_after_click),
    bench_tabs_total: out.bench_tabs.length,
    bench_tab_click_failures: out.bench_tabs.filter(b => b.error || b.status).length,
    keyboard_distinct_elements: out.keyboard.distinct_elements,
    keyboard_invisible_focused: out.keyboard.invisible_focused,
    total_page_errors: out.page_errors_total,
  };

  fs.writeFileSync('/tmp/audit-nav-modal.json', JSON.stringify({ summary, ...out }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
