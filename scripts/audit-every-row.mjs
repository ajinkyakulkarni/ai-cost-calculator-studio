// Pass 4.1: every-row nudge across all 9 list panels.
//
// Pass 3's audit only nudged inputs in the NEW (added) row. This pass
// iterates EVERY existing row in each list (after loading a representative
// preset) and nudges every input inside it. Records headline-delta per
// input.
//
// Strategy to handle re-renders:
//   - Capture row count + an input "fingerprint" (the data-*-key
//     attributes) per row before nudging. After each nudge, re-find rows
//     by index; for re-renders that preserve row order (renderXList), this
//     stays correct. For full-editor re-renders (renderEditor), the same
//     row likely lands at the same index too.
//   - Skip data-*-name inputs (rename → cascades; already proven in Pass 3).
//
// Output: /tmp/audit-p4-every-row.json
//
// Usage: AUDIT_URL=http://localhost:8765/ node scripts/audit-every-row.mjs [--preset slug]

import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.AUDIT_URL || 'http://localhost:8765/';
const presetArgIdx = process.argv.indexOf('--preset');
const PRESET = presetArgIdx >= 0 ? process.argv[presetArgIdx + 1] : 'voice-support-agent';

const LISTS = [
  { name: 'shapes',     listId: 'shapes-list' },
  { name: 'agents',     listId: 'agents-list' },
  { name: 'mixes',      listId: 'mixes-list' },
  { name: 'segments',   listId: 'segments-list' },
  { name: 'migration',  listId: 'migration-list' },
  { name: 'personnel',  listId: 'personnel-list' },
  { name: 'agent-eng',  listId: 'agent-eng-list' },
  { name: 'gpu',        listId: 'gpu-list' },
  { name: 'infra',      listId: 'infra-list' },
];

async function auditList(page, list) {
  return await page.evaluate(async (cfg) => {
    const container = document.getElementById(cfg.listId);
    if (!container) return { list: cfg.name, status: 'NO-CONTAINER' };
    const rowCount = container.children.length;
    if (rowCount === 0) return { list: cfg.name, status: 'EMPTY', rowCount };

    const fire = (el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const headline = () => window.__lastHeadlineMonthly;
    const drainRaf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const rows = [];
    for (let rIdx = 0; rIdx < rowCount; rIdx++) {
      // Re-find the row each iteration (rows may have re-rendered)
      const row = document.getElementById(cfg.listId)?.children[rIdx];
      if (!row) {
        rows.push({ row_index: rIdx, status: 'ROW-MISSING-AFTER-RERENDER' });
        continue;
      }
      const inputs = [...row.querySelectorAll('input,select,textarea')];
      const inputResults = [];
      for (let iIdx = 0; iIdx < inputs.length; iIdx++) {
        // Re-find the current row by index (defends against any re-render
        // that happened during the previous nudge).
        const currentRow = document.getElementById(cfg.listId)?.children[rIdx];
        if (!currentRow) {
          inputResults.push({ status: 'ROW-DETACHED-MID-LOOP' });
          break;
        }
        const liveInputs = [...currentRow.querySelectorAll('input,select,textarea')];
        const el = liveInputs[iIdx];
        if (!el || el.type === 'hidden' || el.type === 'button' || el.type === 'submit') continue;
        // Skip rename inputs (per Pass 3 finding)
        const hasRenameAttr = Object.keys(el.dataset || {}).some(k => /name$/i.test(k));
        if (hasRenameAttr) {
          inputResults.push({ id: el.id || '(no-id)', type: el.type || el.tagName, status: 'SKIPPED-RENAME-INPUT' });
          continue;
        }
        const before = headline();
        const origVal = el.value;
        const origChecked = el.checked;
        try {
          if (el.type === 'checkbox') el.checked = !el.checked;
          else if (el.tagName === 'SELECT') {
            const opts = [...el.options].map(o => o.value).filter(v => v !== el.value);
            if (!opts.length) {
              inputResults.push({ id: el.id || '(no-id)', type: 'select-one', status: 'NO-ALT-OPTION' });
              continue;
            }
            el.value = opts[0];
          } else if (el.type === 'number' || el.type === 'range') {
            const cur = parseFloat(el.value) || 0;
            const max = parseFloat(el.max);
            const min = parseFloat(el.min) || 0;
            let target;
            if (cur === 0) target = !isNaN(max) ? Math.min(100, max) : 100;
            else if (!isNaN(max) && cur * 1.5 <= max) target = cur * 1.5;
            else target = Math.max(min, cur * 0.5);
            if (Math.abs(target - cur) < 1e-9) target = cur + (cur === 0 ? 1 : cur * 0.1);
            el.value = String(target);
          } else {
            el.value = (el.value || '') + 'X';
          }
          el.focus();
          fire(el);
        } catch (e) {
          inputResults.push({ id: el.id || '(no-id)', type: el.type || el.tagName, status: 'NUDGE-THREW', error: e.message });
          continue;
        }
        await drainRaf();
        await new Promise(r => setTimeout(r, 30));
        const after = headline();
        // Restore (best effort; row may have detached)
        try {
          const restoreRow = document.getElementById(cfg.listId)?.children[rIdx];
          if (restoreRow) {
            const restoreInputs = [...restoreRow.querySelectorAll('input,select,textarea')];
            const restoreEl = restoreInputs[iIdx];
            if (restoreEl) {
              if (restoreEl.type === 'checkbox') restoreEl.checked = origChecked;
              else restoreEl.value = origVal;
              restoreEl.focus();
              fire(restoreEl);
              await drainRaf();
            }
          }
        } catch (_) {}
        inputResults.push({
          id: el.id || '(no-id)',
          type: el.type || el.tagName,
          before: Math.round(before * 100) / 100,
          after: Math.round(after * 100) / 100,
          delta: Math.round((after - before) * 100) / 100,
          moved: Math.abs(after - before) > 0.01,
        });
      }
      rows.push({ row_index: rIdx, input_count: inputResults.length, inputs: inputResults });
    }
    return { list: cfg.name, status: 'OK', rowCount, rows };
  }, list);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const out = { preset: PRESET, lists: [] };
  for (const list of LISTS) {
    // Fresh page per list to avoid cumulative state drift
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.renderPreview === 'function', { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate((p) => {
      const sel = document.getElementById('example-loader');
      const m = [...sel.options].find(o => o.value === p);
      if (m) { sel.value = m.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }, PRESET);
    await page.waitForTimeout(2500);
    const r = await auditList(page, list);
    out.lists.push(r);
    const moved = (r.rows || []).flatMap(ro => ro.inputs || []).filter(i => i.moved).length;
    const total = (r.rows || []).flatMap(ro => ro.inputs || []).filter(i => i.before !== undefined).length;
    process.stderr.write(`${list.name}: ${r.rowCount ?? 0} rows, ${moved}/${total} inputs moved headline\n`);
  }
  await browser.close();
  // Summary: how many inputs across all lists moved vs didn't
  const allInputs = out.lists.flatMap(l => (l.rows || []).flatMap(r => r.inputs || []));
  out.summary = {
    total_lists: out.lists.length,
    total_rows: out.lists.reduce((a, l) => a + (l.rowCount || 0), 0),
    inputs_nudged: allInputs.filter(i => i.before !== undefined).length,
    inputs_moved: allInputs.filter(i => i.moved).length,
    inputs_nomove: allInputs.filter(i => i.before !== undefined && !i.moved).length,
    inputs_skipped: allInputs.filter(i => /^SKIPPED|NO-ALT|NUDGE-THREW|DETACHED|MISSING/.test(i.status || '')).length,
  };
  fs.writeFileSync('/tmp/audit-p4-every-row.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.summary, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
