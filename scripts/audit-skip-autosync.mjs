// Pass 4.2: validate every _SKIP_AUTOSYNC_SLIDERS entry actually engages
// the skip path when the slider is focused, and confirm autoSync DOES
// clobber workload.agents when the same slider is changed without focus.
//
// This validates two design invariants:
//   (a) For each ID in the list, focusing the slider and changing its
//       value leaves workload.agents unchanged (skip path engaged).
//   (b) For each ID in the list, NOT focusing the slider and changing its
//       value causes workload.agents to be overwritten by the simulator
//       state (autoSync ran, clobber happened — the bug the skip list
//       was designed to prevent).
//
// A failing (a) means a listed ID isn't matching `document.activeElement
// .id`, so a user dragging that slider would still get the clobber. A
// failing (b) means the test setup is wrong, not necessarily a bug.
//
// Usage: AUDIT_URL=http://localhost:8765/ node scripts/audit-skip-autosync.mjs

import { chromium } from 'playwright';

const URL = process.env.AUDIT_URL || 'http://localhost:8765/';
const PRESET = 'voice-support-agent';

const SKIP_IDS = [
  // Workload-wide engine knobs
  's-context-compression', 's-lang-mult', 's-batch', 's-retry',
  's-cache-write-share', 's-growth', 's-cache', 's-peak',
  // Tool routing / per-tool defaults
  's-tool-response-mode', 's-tool-templated-cap',
  // DAG / workflow knobs
  's-comm-pattern', 's-parallel-branches', 's-concurrent-quota', 's-rate-overage',
  // Document parsing
  's-doc-pages', 's-doc-pdfs', 's-doc-tok-page', 's-doc-stages-pct',
  // Workflow handoff / pauses / storage / rerun
  's-stage-handoff', 's-rerun', 's-template-runs',
  's-pauses', 's-pause-hrs', 's-storage-rate',
  // Legacy fact-check sliders
  's-fc-in', 's-fc-pct', 's-fc-price',
];

// Pick a value distinct from the current one. For numeric sliders, bump by a
// noticeable amount; for selects, pick a different option.
async function pokeAndMeasure(page, id, focus) {
  return await page.evaluate(async (cfg) => {
    const el = document.getElementById(cfg.id);
    if (!el) return { status: 'NOT-IN-DOM' };
    // If the slider lives in panel-workflow (workflow-mode-only) and the
    // panel is hidden, switch topology to 'workflow' first. Real users
    // can only interact with these sliders after switching modes anyway.
    let switchedToWorkflow = false;
    const workflowPanel = el.closest('#panel-workflow');
    if (workflowPanel && workflowPanel.style.display === 'none' && typeof window.setMode === 'function') {
      window.setMode('workflow');
      switchedToWorkflow = true;
      await new Promise(r => setTimeout(r, 200));
    }
    // Visibility check after mode switch
    if (el.offsetParent === null) return { status: 'HIDDEN-AFTER-MODE-SWITCH', switchedToWorkflow };
    const before = JSON.stringify(window.workload?.agents || []);
    const before_count = (window.workload?.agents || []).length;
    let cur, target, kind;
    if (el.tagName === 'SELECT') {
      kind = 'select';
      cur = el.value;
      const opts = [...el.options].map(o => o.value).filter(v => v !== cur);
      if (!opts.length) return { status: 'NO-ALT-OPTION', current: cur };
      target = opts[0];
    } else {
      kind = 'numeric';
      cur = parseFloat(el.value);
      const max = parseFloat(el.max);
      const min = parseFloat(el.min) || 0;
      if (!Number.isFinite(max) || max === min) target = cur === 0 ? 1 : cur * 1.1;
      else if (cur < max * 0.9) target = Math.min(max, cur + (max - min) * 0.2);
      else target = Math.max(min, cur - (max - min) * 0.2);
      if (target === cur) target = cur + 1;
    }
    if (cfg.focus) el.focus();
    el.value = String(target);
    if (typeof window.onSlider === 'function') window.onSlider();
    // Drain rAF queue (autoSync may schedule a deferred renderPreview)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 50));
    const after = JSON.stringify(window.workload?.agents || []);
    const after_count = (window.workload?.agents || []).length;
    const activeId = document.activeElement?.id || '(none)';
    return {
      status: 'OK',
      kind, cur, target,
      before_agents_count: before_count,
      after_agents_count: after_count,
      clobbered: before !== after,
      // Length of agents JSON, for a rough sense of how much changed
      before_len: before.length,
      after_len: after.length,
      activeId,
      switchedToWorkflow,
    };
  }, { id, focus });
}

async function runOne(page, id) {
  // Run two probes: with-focus and without-focus, each on a fresh page so
  // workload.agents starts at the preset state both times.
  const out = { id };
  for (const focus of [true, false]) {
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof window.renderPreview === 'function');
    await page.waitForTimeout(1500);
    await page.evaluate((p) => {
      const sel = document.getElementById('example-loader');
      const m = [...sel.options].find(o => o.value === p);
      if (m) { sel.value = m.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }, PRESET);
    await page.waitForTimeout(2500);
    const r = await pokeAndMeasure(page, id, focus);
    out[focus ? 'with_focus' : 'no_focus'] = r;
  }
  // Conclude per-slider
  const wf = out.with_focus;
  const nf = out.no_focus;
  if (wf.status === 'NOT-IN-DOM' && nf.status === 'NOT-IN-DOM') {
    out.verdict = 'NOT-IN-DOM (slider not in markup)';
  } else if (wf.status === 'HIDDEN-AFTER-MODE-SWITCH') {
    out.verdict = 'HIDDEN-AFTER-MODE-SWITCH (slider stays display:none even after switching to workflow mode — likely deprecated; user cannot interact with it)';
  } else if (wf.status === 'OK' && wf.clobbered) {
    out.verdict = 'FAIL — skip path did NOT engage (with focus, workload.agents got clobbered)';
  } else if (wf.status === 'OK' && !wf.clobbered) {
    out.verdict = 'PASS — skip path engaged';
  } else {
    out.verdict = `INCONCLUSIVE (with_focus.status=${wf.status})`;
  }
  return out;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const results = [];
  for (const id of SKIP_IDS) {
    const r = await runOne(page, id);
    results.push(r);
    process.stderr.write(`${id}: ${r.verdict}\n`);
  }
  await browser.close();
  console.log(JSON.stringify({
    preset: PRESET,
    tested: SKIP_IDS.length,
    pass: results.filter(r => r.verdict.startsWith('PASS')).length,
    fail: results.filter(r => r.verdict.startsWith('FAIL')).map(r => r.id),
    not_in_dom: results.filter(r => r.verdict.startsWith('NOT-IN-DOM')).map(r => r.id),
    hidden_after_mode_switch: results.filter(r => r.verdict.startsWith('HIDDEN-AFTER-MODE-SWITCH')).map(r => r.id),
    inconclusive: results.filter(r => r.verdict.startsWith('INCONCLUSIVE')).map(r => r.id),
    results,
  }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
