// Pass-3 audit: simulate human add/edit/delete cycles on every editable list,
// load every example preset, and exhaustively nudge every visible form field
// inside each list row.
//
// Per-list cycle:
//   1. count rows
//   2. click "+ Add ..."
//   3. count rows again (expect +1)
//   4. nudge each input inside the newly-added row; record headline delta
//   5. click that row's "remove"
//   6. count again (expect back to original)
//   7. confirm headline restored
//
// Then for each preset in public/examples/: load it via #example-loader,
// record headline, sweep cache 0/50/95, restore. Verifies the loader path
// AND that no preset silently breaks cache reactivity.
//
// Usage: AUDIT_URL=https://calc.ajinkya.ai/ node scripts/audit-add-delete.mjs

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const URL = process.env.AUDIT_URL || 'http://localhost:8765/';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LISTS = [
  { name: 'shapes',     addId: 'shapes-add',     listId: 'shapes-list' },
  { name: 'agents',     addId: 'agents-add',     listId: 'agents-list' },
  { name: 'mixes',      addId: 'mixes-add',      listId: 'mixes-list' },
  { name: 'segments',   addId: 'segments-add',   listId: 'segments-list' },
  { name: 'migration',  addId: 'migration-add',  listId: 'migration-list' },
  { name: 'personnel',  addId: 'personnel-add',  listId: 'personnel-list' },
  { name: 'agent-eng',  addId: 'agent-eng-add',  listId: 'agent-eng-list' },
  { name: 'gpu',        addId: 'gpu-add',        listId: 'gpu-list' },
  { name: 'infra',      addId: 'infra-add',      listId: 'infra-list' },
];

async function runAddDeleteOne(page, list) {
  return await page.evaluate((cfg) => {
    // Stub window.prompt so add-row handlers that ask for a name don't bail.
    // The handlers reject duplicates, so we use a timestamp-suffixed name.
    const stubName = `audit_${cfg.name}_${Date.now()}`;
    const _origPrompt = window.prompt;
    window.prompt = () => stubName;

    const addBtn = document.getElementById(cfg.addId);
    const container = document.getElementById(cfg.listId);
    if (!addBtn) { window.prompt = _origPrompt; return { list: cfg.name, status: 'NO-ADD-BUTTON' }; }
    if (!container) { window.prompt = _origPrompt; return { list: cfg.name, status: 'NO-LIST-CONTAINER' }; }

    const headline = () => window.__lastHeadlineMonthly;
    const fire = el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const headlineBefore = headline();
    const countBefore = container.children.length;

    // 1. Click ADD
    try { addBtn.click(); } catch (e) { return { list: cfg.name, status: 'ADD-CLICK-THREW', error: e.message }; }

    const headlineAfterAdd = headline();
    const countAfterAdd = container.children.length;
    const addDelta = countAfterAdd - countBefore;

    // 2. Find new row (last child) and try nudging every input inside
    const newRow = container.children[countAfterAdd - 1];
    const inputNudges = [];
    if (newRow) {
      const inputs = newRow.querySelectorAll('input,select,textarea');
      for (const el of inputs) {
        if (!el || el.type === 'hidden' || el.type === 'button' || el.type === 'submit') continue;
        // Skip rename inputs (any `data-*-name` attribute). Changing one
        // triggers a workload-key rename + full editor re-render, which
        // detaches the row mid-loop. Subsequent nudges on the snapshot
        // `inputs` collection then operate on detached elements whose
        // dataset still references the OLD name — the cost-input handler
        // re-creates `workload.X[oldName]` as a ghost, and the remove
        // button (also wired to oldName) then deletes the ghost instead
        // of the renamed row. Net effect: row count fails to decrement.
        // Skipping rename inputs sidesteps the detachment cascade. The
        // canonical cost lever (the cost input) still gets nudged below.
        const hasRenameAttr = Object.keys(el.dataset || {}).some(k => /name$/i.test(k));
        if (hasRenameAttr) {
          inputNudges.push({ id: el.id || '(no-id)', name: el.name || '(no-name)', type: el.type || el.tagName, status: 'SKIPPED-RENAME-INPUT' });
          continue;
        }
        const before = headline();
        const origVal = el.value;
        const origChecked = el.checked;
        try {
          if (el.type === 'checkbox') el.checked = !el.checked;
          else if (el.tagName === 'SELECT') {
            const opts = [...el.options].map(o => o.value).filter(v => v !== el.value);
            if (opts.length) el.value = opts[0];
            else { inputNudges.push({ id: el.id || '(no-id)', name: el.name || '(no-name)', type: el.type || el.tagName, status: 'NO-ALT-OPTION' }); continue; }
          } else if (el.type === 'number' || el.type === 'range') {
            const cur = parseFloat(el.value) || 0;
            const max = parseFloat(el.max); const min = parseFloat(el.min) || 0;
            let target;
            if (cur === 0) target = !isNaN(max) ? Math.min(100, max) : 100;
            else if (!isNaN(max) && cur * 1.5 <= max) target = cur * 1.5;
            else target = Math.max(min, cur * 0.5);
            if (Math.abs(target - cur) < 1e-9) target = cur + (cur === 0 ? 1 : cur * 0.1);
            el.value = String(target);
          } else {
            el.value = (el.value || '') + 'X';
          }
          fire(el);
        } catch (e) {
          inputNudges.push({ id: el.id || '(no-id)', name: el.name || '(no-name)', type: el.type || el.tagName, status: 'NUDGE-THREW', error: e.message });
          continue;
        }
        const after = headline();
        const moved = Math.abs(after - before) > 0.01;
        // restore
        try {
          if (el.type === 'checkbox') el.checked = origChecked;
          else el.value = origVal;
          fire(el);
        } catch (e) {}
        inputNudges.push({
          id: el.id || '(no-id)', name: el.name || '(no-name)',
          type: el.type || el.tagName,
          before: Math.round(before*100)/100, after: Math.round(after*100)/100, moved,
        });
      }
    }

    // 3. Find remove button on the new row
    let removeBtn = null;
    if (newRow) {
      removeBtn = newRow.querySelector('.item-remove, [data-shape-remove], [data-mix-remove], [data-seg-remove], [data-agent-remove], [data-gpu-remove], [data-infra-remove], [data-personnel-remove], [data-mig-remove], [data-eng-remove]');
    }
    let removeStatus = 'NO-REMOVE-BTN';
    if (removeBtn) {
      try { removeBtn.click(); removeStatus = 'CLICKED'; } catch (e) { removeStatus = 'CLICK-THREW: ' + e.message; }
    }

    const countAfterRemove = container.children.length;
    const headlineAfterRemove = headline();
    const restored = Math.abs(headlineAfterRemove - headlineBefore) < 0.01 && countAfterRemove === countBefore;

    return {
      list: cfg.name,
      addId: cfg.addId, listId: cfg.listId,
      countBefore, countAfterAdd, countAfterRemove,
      addDelta, removeStatus,
      addWorked: addDelta >= 1,
      removeWorked: countAfterRemove === countBefore,
      restoredHeadline: Math.abs(headlineAfterRemove - headlineBefore) < 0.01,
      headlineBefore: Math.round(headlineBefore*100)/100,
      headlineAfterAdd: Math.round(headlineAfterAdd*100)/100,
      headlineAfterRemove: Math.round(headlineAfterRemove*100)/100,
      input_nudges_on_new_row: inputNudges,
      input_count_in_new_row: inputNudges.length,
    };
  }, list);
}

async function loadExamplePreset(page, presetFile) {
  return await page.evaluate(async (preset) => {
    const sel = document.getElementById('example-loader');
    if (!sel) return { preset, status: 'NO-LOADER' };
    const headlineBefore = window.__lastHeadlineMonthly;
    const matching = [...sel.options].find(o => o.value === preset || o.value === preset.replace('.json','') || (o.value && preset.includes(o.value)));
    if (!matching) return { preset, status: 'PRESET-NOT-IN-DROPDOWN', available: [...sel.options].map(o => o.value).slice(0,20) };
    sel.value = matching.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { preset, value_loaded: matching.value, headlineBefore: Math.round(headlineBefore*100)/100 };
  }, presetFile);
}

async function sweepCachePostLoad(page) {
  return await page.evaluate(async () => {
    const sc = document.getElementById('s-cache');
    if (!sc) return { status: 'NO-CACHE-SLIDER' };
    const orig = sc.value;
    const out = [];
    // Focus the slider before each value change. Mouse-drag focuses the
    // slider on mousedown — without that, document.activeElement is the
    // body and the wrapped onSlider() bypasses _SKIP_AUTOSYNC_SLIDERS,
    // running autoSync() → __importFromSimulator → workload.agents gets
    // overwritten with simulator-inflated tokens (~10×). renderPreview
    // is then rAF-deferred, so an immediate read of __lastHeadlineMonthly
    // captures the pre-cascade stale value. Focusing engages the skip
    // path, matching real-user behavior and producing stable reads.
    for (const v of [0, 50, 95]) {
      sc.focus();
      sc.value = String(v);
      if (typeof window.onSlider === 'function') window.onSlider();
      // Defense in depth: drain the rAF queue in case anything else
      // schedules a paint.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      out.push({ slider: v, monthly: Math.round(window.__lastHeadlineMonthly * 100) / 100 });
    }
    sc.focus();
    sc.value = orig;
    if (typeof window.onSlider === 'function') window.onSlider();
    // Distinguish three patterns:
    //  - decreasing: strict monotone (cost falls as cache rate rises) —
    //    expected for any preset with cache_eligible=true agents.
    //  - flat:       all-equal (cache rate has no effect) — acceptable
    //    when all agents have cache_eligible=false (e.g. RAG presets with
    //    unstable retrieval prefixes).
    //  - increasing: cost rises with cache rate. ALWAYS a bug — either
    //    in the engine or in opts composition.
    const m = out.map(o => o.monthly);
    const decreasing = m[0] > m[1] && m[1] > m[2];
    const flat = m[0] === m[1] && m[1] === m[2];
    const pattern = decreasing ? 'decreasing' : flat ? 'flat' : 'non-monotonic';
    return { sweep: out, monotonic: decreasing || flat, pattern };
  });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

  // Block console noise
  page.on('pageerror', err => console.error('[PAGE ERR]', err.message));

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.renderPreview === 'function', { timeout: 60000 });
  await page.waitForTimeout(3000);

  const results = {};

  // PART A — add/delete cycle per list
  results.add_delete = [];
  for (const list of LISTS) {
    const r = await runAddDeleteOne(page, list);
    results.add_delete.push(r);
    // Reload to clean state between lists (some lists, e.g. agents, change mode)
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.renderPreview === 'function', { timeout: 60000 });
    await page.waitForTimeout(1500);
  }

  // PART B — load every example preset & sweep cache after each load
  const presetsDir = path.resolve(__dirname, '..', 'public', 'examples');
  const presets = fs.readdirSync(presetsDir).filter(f => f.endsWith('.json'));
  results.example_presets = [];
  for (const preset of presets) {
    // Fresh page each time so state doesn't leak between presets
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.renderPreview === 'function', { timeout: 60000 });
    await page.waitForTimeout(1500);
    const loadRes = await loadExamplePreset(page, preset);
    await page.waitForTimeout(2000); // async preset loads run a fetch
    const headlineAfterLoad = await page.evaluate(() => Math.round(window.__lastHeadlineMonthly * 100) / 100);
    const cacheSweep = await sweepCachePostLoad(page);
    results.example_presets.push({
      preset,
      ...loadRes,
      headlineAfterLoad,
      cacheSweep,
    });
  }

  // Summary
  results.summary = {
    add_delete_lists_tested: results.add_delete.length,
    add_worked: results.add_delete.filter(r => r.addWorked).length,
    remove_worked: results.add_delete.filter(r => r.removeWorked).length,
    restored_headline: results.add_delete.filter(r => r.restoredHeadline).length,
    failing_lists: results.add_delete.filter(r => !r.addWorked || !r.removeWorked).map(r => r.list),
    presets_total: results.example_presets.length,
    presets_loaded_ok: results.example_presets.filter(p => p.value_loaded && p.headlineAfterLoad > 0).length,
    presets_cache_monotonic: results.example_presets.filter(p => p.cacheSweep?.monotonic).length,
    presets_cache_decreasing: results.example_presets.filter(p => p.cacheSweep?.pattern === 'decreasing').length,
    presets_cache_flat: results.example_presets.filter(p => p.cacheSweep?.pattern === 'flat').map(p => p.preset),
    presets_cache_NOT_monotonic: results.example_presets.filter(p => p.cacheSweep && !p.cacheSweep.monotonic).map(p => ({ preset: p.preset, sweep: p.cacheSweep.sweep })),
  };

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
