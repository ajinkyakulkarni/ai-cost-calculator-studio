// Silent-slider audit. For every workload-wide slider, nudge it and
// assert the headline cost moves. A slider that doesn't move the
// number = silent broadcast / disconnected wiring = a bug. Same
// failure mode that bit cache-write-share, container-sessions,
// sysprompt, tool return shape, etc. across this session.
//
// Run against both workload-mode (no agents) and agent-mode (mcp fleet)
// because some sliders only fire in one mode and we need to catch
// "disabled in mode X" gaps explicitly.

import { chromium } from 'playwright';

const URL = process.env.AUDIT_URL || 'https://calc.ajinkya.ai/';
const args = process.argv.slice(2);
const ONLY = args.find(a => a.startsWith('--only='))?.split('=')[1];

// Each slider needs a {nudge fn, mode constraint}. nudge returns the new
// expected value-as-string (for verification). Default: range slider →
// move +30% of (max-min); number input → +50.
// Slider classification for accurate audit attribution:
//   modes:        which mode(s) to test in. 'workload', 'agent', 'self_host',
//                 'workflow', or 'both' for workload+agent.
//   headlineExpected: false = slider should NOT move headline (by design)
//   topology:     'workflow' marks workflow-mode-only sliders that are hidden
//                 in default Fleet topology. Audit skips with that reason.
//   note:         human-readable explanation appended to PASS/SKIP output.
const SLIDERS = [
  // === Traffic shape (workload + agent) ===
  { id: 's-users',              modes: ['both'],     nudge: 'up' },
  { id: 's-turns',              modes: ['both'],     nudge: 'up' },
  { id: 's-sessions',           modes: ['both'],     nudge: 'up' },
  { id: 's-agents',             modes: ['workload'], nudge: 'up', note: 'agent-mode uses workload.agents.length, not s-agents' },
  { id: 's-peak',               modes: ['both'],     nudge: 'up', headlineExpected: false, note: 'self-host capacity sizing only; API tier ignores peak. Engine path verified separately.' },
  { id: 's-lang-mult',          modes: ['both'],     nudge: 'up' },
  { id: 's-growth',             modes: ['both'],     nudge: 'up', headlineExpected: false, tcoExpected: true, note: 'only moves 3yr TCO not monthly' },
  // === Cache + tier-economy knobs ===
  { id: 's-cache',              modes: ['both'],     nudge: 'down' },
  { id: 's-cache-write-share',  modes: ['both'],     nudge: 'up' },
  { id: 's-batch',              modes: ['both'],     nudge: 'up' },
  { id: 's-retry',              modes: ['both'],     nudge: 'up' },
  // === Context compression — newly bridged engine knob ===
  { id: 's-context-compression', modes: ['both'],    nudge: 'up' },
  // === Communication / DAG — simulator pane visualization only ===
  { id: 's-comm-pattern',       modes: ['workload'], nudge: 'up', note: 'touching this in workload-mode auto-promotes to agent-mode (fleet creation), which moves the headline. Headline movement IS expected.' },
  { id: 's-parallel-branches',  modes: ['workload'], nudge: 'up',   headlineExpected: false, note: 'wallclock-only; cost-neutral for fixed token budget' },
  { id: 's-concurrent-quota',   modes: ['workload'], nudge: 'down', headlineExpected: false, note: 'rate-limit ceiling, not cost knob' },
  { id: 's-rate-overage',       modes: ['workload'], nudge: 'up',   headlineExpected: false, note: 'rate-limit overage; affects simulator-pane retry overhead, not engine headline' },
  // === Tool routing — workload-wide defaults (per-tool overrides in registry) ===
  { id: 's-tool-response-mode', modes: ['workload'], nudge: 'toggle', headlineExpected: false, note: 'workload-wide default. When tools_registry entries set return_shape explicitly (mcp preset does), this is overridden — by design.' },
  { id: 's-tool-templated-cap', modes: ['workload'], nudge: 'up',     headlineExpected: false, note: 'workload-wide cap default. Per-tool cap_tokens in registry overrides.' },
  // === Workflow-topology only (panel-workflow hidden in default Fleet mode) ===
  { id: 's-doc-pages',          modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only — slider lives in panel-workflow, hidden unless topology=workflow' },
  { id: 's-doc-pdfs',           modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  { id: 's-doc-stages-pct',     modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  { id: 's-doc-tok-page',       modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  { id: 's-pause-hrs',          modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  { id: 's-pauses',             modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  { id: 's-rerun',              modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  { id: 's-storage-rate',       modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  { id: 's-stage-handoff',      modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  { id: 's-template-runs',      modes: ['workload'], nudge: 'up', topology: 'workflow', note: 'workflow-topology only' },
  // (Legacy s-fc-in / s-fc-pct / s-fc-price removed from markup 2026-05-25
  // in commit 4ec8fe1 alongside the Fact-Check Sidecar subsection deletion;
  // dropped from this harness 2026-05-26.)
];

function nudgeValue(input, direction) {
  const min = parseFloat(input.min) || 0;
  const max = parseFloat(input.max) || 100;
  const cur = parseFloat(input.value) || 0;
  const range = max - min || 1;
  const step = parseFloat(input.step) || (range > 100 ? 1 : 0.05);
  const delta = Math.max(step, range * 0.30);
  if (direction === 'down') return Math.max(min, cur - delta).toString();
  return Math.min(max, cur + delta).toString();
}

async function readHeadline(page) {
  const cb = await page.locator('#cb-num').textContent();
  const tco = await page.locator('#cb-tco').textContent().catch(() => '');
  return { headline: (cb || '').trim(), tco: (tco || '').trim() };
}

async function setSlider(page, id, value) {
  // Trusted-event path: many simulator handlers gate on ev.isTrusted to
  // distinguish user drags from programmatic state syncs. Use Playwright
  // native input (which produces trusted events) for selects and number
  // inputs; for ranges, focus + arrow-key the slider to the target value.
  const meta = await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    return { tag: el.tagName, type: el.type, current: el.value, min: el.min, max: el.max, step: el.step };
  }, id);
  if (!meta) return false;

  if (meta.tag === 'SELECT') {
    await page.selectOption('#' + id, value);
    await page.waitForTimeout(150);
    return true;
  }
  if (meta.type === 'number') {
    await page.locator('#' + id).fill(String(value));
    await page.locator('#' + id).dispatchEvent('change');
    await page.waitForTimeout(150);
    return true;
  }
  if (meta.type === 'range') {
    // Click the slider to focus it, then press arrows until we reach target.
    const el = page.locator('#' + id);
    await el.focus();
    const step = parseFloat(meta.step) || 1;
    const cur = parseFloat(meta.current) || 0;
    const target = parseFloat(value);
    const steps = Math.round((target - cur) / step);
    const key = steps >= 0 ? 'ArrowRight' : 'ArrowLeft';
    const count = Math.min(50, Math.abs(steps));
    for (let i = 0; i < count; i++) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(200);
    return true;
  }
  // Fallback for unknown input types
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, value });
  await page.waitForTimeout(150);
  return true;
}

async function testSlider(page, slider, mode) {
  if (!slider.modes.includes(mode) && !slider.modes.includes('both')) {
    return { skipped: true, reason: `not active in ${mode}` };
  }
  // Workflow-topology sliders live in #panel-workflow which is
  // display:none unless the user explicitly switches topology to
  // 'workflow'. Skip with the topology note so audit output is
  // honest about why they aren't being exercised in default Fleet mode.
  if (slider.topology === 'workflow') {
    return { skipped: true, reason: 'workflow-topology slider (panel hidden in default Fleet mode)' };
  }
  // Read current value + bounds
  const meta = await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    if (el.tagName === 'SELECT') {
      return { kind: 'select', value: el.value, options: [...el.options].map(o => o.value) };
    }
    return { kind: 'input', value: el.value, min: el.min, max: el.max, step: el.step, type: el.type };
  }, slider.id);
  if (!meta) return { error: 'not found in DOM' };
  const before = await readHeadline(page);
  // Compute nudged value
  let newValue;
  if (meta.kind === 'select') {
    const idx = meta.options.indexOf(meta.value);
    const next = (idx + 1) % meta.options.length;
    newValue = meta.options[next];
  } else {
    newValue = nudgeValue(meta, slider.nudge === 'down' ? 'down' : 'up');
  }
  if (newValue === meta.value) {
    return { skipped: true, reason: `slider at boundary, can't nudge` };
  }
  await setSlider(page, slider.id, newValue);
  const after = await readHeadline(page);
  // Restore for the next test
  await setSlider(page, slider.id, meta.value);

  const headlineMoved = before.headline !== after.headline;
  const tcoMoved = before.tco !== after.tco;
  // Default: headline expected to move; TCO is opt-IN (only s-growth
  // moves TCO-only without moving headline). headlineExpected:false
  // means "this slider intentionally doesn't affect cost" — verified by
  // confirming NEITHER the headline NOR the TCO moves.
  const expectHeadline = slider.headlineExpected !== false;
  const expectTco = slider.tcoExpected === true;

  const movedSomething = headlineMoved || tcoMoved;
  let pass;
  if (expectHeadline && expectTco) pass = headlineMoved || tcoMoved;
  else if (expectHeadline) pass = headlineMoved;
  else if (expectTco) pass = tcoMoved;
  else pass = !movedSomething; // explicitly expected NOT to move
  return {
    pass,
    before, after, newValue,
    headlineMoved, tcoMoved, expectHeadline, expectTco,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  async function setupPage(setupFn) {
    const page = await browser.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => { const o = document.querySelector('#welcome-overlay'); if (o) o.remove(); });
    // Unhide simulator's "Advanced" group (sr-advanced) — gated by
    // body.config-basic with display:none !important. Measurement-harness
    // fix; not a real-UX bug since the user can toggle Advanced themselves.
    await page.evaluate(() => { document.body.classList.remove('config-basic'); });
    await page.waitForTimeout(400);
    await setupFn(page);
    await page.waitForTimeout(1500);
    return page;
  }

  async function runMode(modeLabel, setupFn) {
    console.log(`\n=== ${modeLabel} mode ===`);
    const results = [];
    for (const slider of SLIDERS) {
      if (ONLY && !slider.id.includes(ONLY)) continue;
      // Fresh page per slider — auto-promotion (s-agents in workload mode)
      // flips the workload into agent-mode and marooned every workload-
      // only slider tested afterward. Per-slider reload makes each test
      // measure the slider's true effect against a clean baseline.
      const page = await setupPage(setupFn);
      const r = await testSlider(page, slider, modeLabel);
      await page.close();
      const status = r.error ? `ERROR(${r.error})` : r.skipped ? `SKIP(${r.reason})` : r.pass ? 'PASS' : 'FAIL';
      const detail = r.skipped || r.error ? '' :
        ` ${r.before.headline}→${r.after.headline}  tco:${r.tcoMoved ? 'Δ' : '='}  expected:${r.expectHeadline ? 'H' : ''}${r.expectTco ? 'T' : ''}${slider.note ? '  // ' + slider.note : ''}`;
      console.log(`  ${status.padEnd(40)} ${slider.id.padEnd(28)}${detail}`);
      results.push({ slider: slider.id, mode: modeLabel, ...r });
    }
    return results;
  }

  const workloadResults = await runMode('workload', async (page) => {
    // Default boot is workload-mode (no agents). Nothing to set up.
  });

  const agentResults = await runMode('agent', async (page) => {
    await page.selectOption('#example-loader', 'mcp-research-fleet');
    await page.waitForTimeout(2500);
  });

  await browser.close();

  // Summary
  const all = [...workloadResults, ...agentResults];
  const passed = all.filter(r => r.pass).length;
  const failed = all.filter(r => r.pass === false).length;
  const skipped = all.filter(r => r.skipped).length;
  const errored = all.filter(r => r.error).length;
  console.log(`\n=== Summary ===`);
  console.log(`Total: ${all.length}  ·  Pass: ${passed}  ·  Fail: ${failed}  ·  Skip: ${skipped}  ·  Error: ${errored}`);
  if (failed > 0) {
    console.log(`\nFAILURES:`);
    for (const r of all) {
      if (r.pass === false) {
        console.log(`  ${r.mode.padEnd(10)} ${r.slider.padEnd(28)} headline ${r.before.headline}→${r.after.headline} (expected to move)`);
      }
    }
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
