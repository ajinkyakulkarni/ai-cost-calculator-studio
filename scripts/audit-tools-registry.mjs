// Pass 4.4 (partial): per-tool inline overrides in the tools registry.
// For each tool, expand the row, nudge each data-field input/select, record
// headline delta.
//
// Output: /tmp/audit-p4-tools-registry.json
//
// Usage: AUDIT_URL=http://localhost:8765/ node scripts/audit-tools-registry.mjs --preset <slug>
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.AUDIT_URL || 'http://localhost:8765/';
const presetArgIdx = process.argv.indexOf('--preset');
const PRESET = presetArgIdx >= 0 ? process.argv[presetArgIdx + 1] : 'voice-support-agent';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.renderPreview === 'function');
  await page.waitForTimeout(1500);
  await page.evaluate((p) => {
    const sel = document.getElementById('example-loader');
    const m = [...sel.options].find(o => o.value === p);
    if (m) { sel.value = m.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  }, PRESET);
  await page.waitForTimeout(2500);

  // Find the tools registry host
  const result = await page.evaluate(async () => {
    const log = [];
    const drainRaf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const fire = el => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    // Find ALL data-tool-id rows on the page
    const toolRows = [...document.querySelectorAll('[data-tool-id]')];
    if (toolRows.length === 0) return { status: 'NO-TOOLS', tools_count: 0, results: [] };

    // Expand all tools first
    if (typeof window.__expandedTools !== 'object' || !window.__expandedTools) {
      window.__expandedTools = new Set();
    }
    for (const row of toolRows) {
      window.__expandedTools.add(row.dataset.toolId);
    }
    if (typeof window.renderToolsRegistry === 'function') window.renderToolsRegistry();
    await drainRaf();

    const results = [];
    // Re-query after re-render
    const rowsAfterExpand = [...document.querySelectorAll('[data-tool-id]')];
    for (const row of rowsAfterExpand) {
      const tid = row.dataset.toolId;
      const fields = [...row.querySelectorAll('[data-field]')];
      const inputResults = [];
      for (let i = 0; i < fields.length; i++) {
        // Re-find the live row + fields each iteration (re-render may rebuild)
        const liveRow = document.querySelector(`[data-tool-id="${tid}"]`);
        if (!liveRow) { inputResults.push({ field_index: i, status: 'TOOL-DETACHED' }); break; }
        const liveFields = [...liveRow.querySelectorAll('[data-field]')];
        const el = liveFields[i];
        if (!el) continue;
        const field = el.dataset.field;
        if (!field) continue;
        // Skip label, description, provider — these don't affect cost
        if (['label', 'description', 'provider'].includes(field)) {
          inputResults.push({ field, status: 'SKIPPED-COSMETIC' });
          continue;
        }
        const before = window.__lastHeadlineMonthly;
        const origVal = el.value;
        try {
          if (el.tagName === 'SELECT') {
            const opts = [...el.options].map(o => o.value).filter(v => v !== el.value);
            if (opts.length) el.value = opts[0];
            else { inputResults.push({ field, status: 'NO-ALT-OPTION' }); continue; }
          } else if (el.type === 'number') {
            const cur = parseFloat(el.value) || 0;
            const target = cur === 0 ? 100 : cur * 1.5;
            el.value = String(target);
          } else {
            el.value = (el.value || '') + 'X';
          }
          el.focus();
          fire(el);
        } catch (e) {
          inputResults.push({ field, status: 'NUDGE-THREW', error: e.message });
          continue;
        }
        await drainRaf();
        await new Promise(r => setTimeout(r, 30));
        const after = window.__lastHeadlineMonthly;
        // Restore
        try {
          const restoreRow = document.querySelector(`[data-tool-id="${tid}"]`);
          if (restoreRow) {
            const restoreFields = [...restoreRow.querySelectorAll('[data-field]')];
            const restoreEl = restoreFields[i];
            if (restoreEl) { restoreEl.value = origVal; restoreEl.focus(); fire(restoreEl); await drainRaf(); }
          }
        } catch (_) {}
        inputResults.push({ field, before: Math.round(before*100)/100, after: Math.round(after*100)/100, delta: Math.round((after-before)*100)/100, moved: Math.abs(after-before) > 0.01 });
      }
      results.push({ tool_id: tid, field_count: inputResults.length, fields: inputResults });
    }
    return { status: 'OK', tools_count: rowsAfterExpand.length, results };
  });
  await browser.close();
  fs.writeFileSync('/tmp/audit-p4-tools-registry.json', JSON.stringify({ preset: PRESET, ...result }, null, 2));
  const totalFields = (result.results || []).flatMap(r => r.fields || []).filter(f => f.before !== undefined).length;
  const moved = (result.results || []).flatMap(r => r.fields || []).filter(f => f.moved).length;
  const skipped = (result.results || []).flatMap(r => r.fields || []).filter(f => f.status).length;
  console.log(JSON.stringify({ preset: PRESET, tools_count: result.tools_count, total_fields_nudged: totalFields, moved, nomove: totalFields - moved, skipped }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
