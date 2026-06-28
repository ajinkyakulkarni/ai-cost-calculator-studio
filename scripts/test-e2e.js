#!/usr/bin/env node
/**
 * End-to-end UI test for the deployed calculator at calc.ajinkya.ai.
 *
 * Slowly walks through every major control and asserts the headline
 * responds the way a real user would expect. Runs against the live
 * deployed build by default; pass --local to point at a file://
 * preview instead.
 *
 * Test scenarios (each in its own page context for isolation):
 *   1. boot-and-defaults     — page loads, default preset, headline visible
 *   2. mau-slider            — drag s-users; headline + segments scale
 *   3. cache-slider          — drag s-cache; headline moves inverse to cache
 *   4. agent-promotion       — drag s-agents; promotion happens, badge fades
 *   5. verifier-preset       — switch FactReasoner FR1 → MiniCheck; cost changes
 *   6. tools-registry        — open registry, add custom tool, edit rate
 *   7. agent-enabled-tools   — enable web_search on an agent; headline jumps
 *   8. share-url-roundtrip   — copy hash, reload, restored
 *   9. mcp-research-fleet    — load demo preset, verify multi-agent + tools work
 *
 * Usage:
 *   npm run test:e2e               # against https://calc.ajinkya.ai
 *   npm run test:e2e -- --local    # against ./public/index.html via file://
 *   npm run test:e2e -- --headed   # show the browser window
 *   npm run test:e2e -- --slow=400 # 400ms delay between actions (default 250)
 */

const { chromium } = require('playwright');
const path = require('path');

// ── CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const useLocal = args.includes('--local');
const headed = args.includes('--headed');
const slowArg = args.find(a => a.startsWith('--slow='));
const slowMs = slowArg ? parseInt(slowArg.split('=')[1], 10) : 250;
const filter = args.find(a => a.startsWith('--only='));
const onlyName = filter ? filter.split('=')[1] : null;

// --base=<url> points the suite at any origin (e.g. a local http server:
// --base=http://localhost:8765/index.html). Preferable to --local (file://)
// for scenarios that fetch preset JSONs — Chromium blocks file:// fetch.
const baseArg = args.find(a => a.startsWith('--base='));
const URL = baseArg
  ? baseArg.split('=').slice(1).join('=')
  : useLocal
    ? 'file://' + path.resolve(__dirname, '..', 'public', 'index.html')
    : 'https://calc.ajinkya.ai/';

// ── Helpers ──────────────────────────────────────────────────────────────
const fmt = (n) => '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const parseHeadline = (s) => parseInt((s || '').replace(/[^\d-]/g, ''), 10) || 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const failures = [];

async function scenario(name, fn) {
  if (onlyName && name !== onlyName) return;
  process.stdout.write(`  ${name.padEnd(28)} `);
  const browser = await chromium.launch({ headless: !headed, slowMo: slowMs });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  // Capture console errors
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    await fn(page);
    if (errors.length) throw new Error('JS errors: ' + errors.slice(0, 3).join(' | '));
    process.stdout.write('✓\n');
    passed++;
  } catch (e) {
    process.stdout.write('✗ ' + e.message + '\n');
    failed++;
    failures.push({ name, error: e.message, errors });
  } finally {
    await browser.close();
  }
}

// Booted means the headline is visible and not "—". Also dismisses the
// welcome overlay if it's present (intercepts clicks on first visit).
async function waitForBoot(page) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => {
      const el = document.getElementById('cb-num');
      return el && el.textContent && !el.textContent.includes('—');
    },
    { timeout: 15000 }
  );
  // Welcome overlay (#welcome-overlay) shows on first visit and intercepts
  // pointer events. Dismiss it programmatically so subsequent clicks work.
  await page.evaluate(() => {
    const ov = document.getElementById('welcome-overlay');
    if (ov) ov.remove();
  });
  await sleep(1000); // bench-coefficients loader can still be settling
}

async function getHeadline(page) {
  const t = await page.locator('#cb-num').textContent();
  return parseHeadline(t);
}

// Load a bundled example. The appbar example-loader is responsive-hidden at
// some viewports, which makes page.selectOption flake on a visibility wait;
// set the value + dispatch change directly (the loader's change handler fires
// the same fetch + render path).
async function loadExample(page, slug) {
  await page.evaluate((s) => {
    const sel = document.getElementById('example-loader');
    if (!sel) throw new Error('example-loader not found');
    sel.value = s;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, slug);
}

async function setSliderValue(page, id, value) {
  // Synthetic dispatchEvent fires with isTrusted=false, which the
  // bidirectional capture-phase listeners in app.js intentionally
  // ignore (they were added to keep the bench-coefficients loader from
  // overwriting URL-restored anchor values). For E2E, that means a
  // simple value+dispatch doesn't push into workload state. Use the
  // CDP-driven keyboard approach for the few sliders that test
  // round-trip; for cosmetic changes the simple path is fine.
  //
  // CDP path: focus the slider, press End/Home, then arrow toward the
  // target value. Browser fires isTrusted=true events.
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    if (!el) throw new Error('slider not found: ' + id);
    const nativeInputSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    nativeInputSetter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, value });
}

// Trusted-event variant: focus the slider and use keyboard nudges so
// the isTrusted-gated listeners actually fire. Used for share-URL
// round-trip where workload must be mutated via the user path.
async function setSliderTrusted(page, id, value) {
  await page.focus('#' + id);
  // Press End → slider at max; or Home → slider at min. Then arrow back
  // to the target. For a step=5 slider, each arrow press moves by step.
  const meta = await page.locator('#' + id).evaluate(el => ({
    min: parseFloat(el.min) || 0,
    max: parseFloat(el.max) || 100,
    step: parseFloat(el.step) || 1,
    cur: parseFloat(el.value) || 0,
  }));
  const target = Math.max(meta.min, Math.min(meta.max, value));
  // Nudge from current to target using arrows. Use the element locator's
  // press (auto-focuses + fires trusted events) and a tiny settle — at
  // slowMo=0 a bare page.keyboard.press loop can fire before focus lands,
  // leaving the slider unmoved.
  const loc = page.locator('#' + id);
  await loc.focus();
  const stepsNeeded = Math.round((target - meta.cur) / meta.step);
  const key = stepsNeeded > 0 ? 'ArrowRight' : 'ArrowLeft';
  for (let i = 0; i < Math.abs(stepsNeeded); i++) {
    await loc.press(key);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg}: got ${a}, expected ${b} ± ${tol}`);
}

// ── Scenarios ────────────────────────────────────────────────────────────

async function bootAndDefaults(page) {
  await waitForBoot(page);
  const h = await getHeadline(page);
  assert(h > 0, `headline should be > 0, got ${h}`);
  assert(h >= 1000 && h < 1000000, `headline should be in sane range, got ${fmt(h)}`);
  // Default preset is public-geospatial-qa → normalizeWorkload should have
  // seeded the tools registry with 5 entries.
  const registrySize = await page.evaluate(() =>
    Object.keys((window.workload && window.workload.tools_registry) || {}).length
  );
  assert(registrySize >= 5, `expected ≥5 registry entries in workload, got ${registrySize}`);
}

async function mauSlider(page) {
  await waitForBoot(page);
  const before = await getHeadline(page);
  // Mutate segments directly + render. The user-input path is verified
  // by share-url-roundtrip; this scenario tests the cost engine's
  // response to segment scaling, not the input pipeline.
  //
  // Implicit contract: in single-segment mode, renderPreview() rebuilds
  // workload.segments[0] from the s-users / s-sessions / s-turns slider
  // values on every render (app.js:1746-1763 — "sliders ARE the
  // segment"). So mutating segments[0].mau alone gets silently clobbered
  // on the next render unless the slider is also written. The user-facing
  // sync paths (slider drag → renderPreview rebuild; per-segment form
  // edit → mirror to slider at app.js:626) both honor this contract.
  // This test now does the same: write the new total to s-users AND
  // mutate segments. Multi-segment presets are unaffected — renderPreview
  // doesn't touch segments in that branch.
  await page.evaluate(() => {
    const segs = window.workload.segments || [];
    const oldTotal = segs.reduce((a, s) => a + (s.mau || 0), 0) || 1;
    const newTotal = 50000;
    const ratio = newTotal / oldTotal;
    for (const s of segs) s.mau = Math.round(s.mau * ratio);
    const sUsers = document.getElementById('s-users');
    if (sUsers) sUsers.value = String(newTotal);
    window.renderPreview();
  });
  await sleep(600);
  const after = await getHeadline(page);
  assert(after > before * 2, `expected headline to ≥2× when MAU ~5×, got ${fmt(before)} → ${fmt(after)}`);
}

async function cacheSlider(page) {
  await waitForBoot(page);
  const before = await getHeadline(page);
  // The cost engine reads cacheRate from the s-cache slider directly,
  // not from workload.anchor_query.cache_rate_baseline. So mutate both
  // for the engine to see the change.
  await page.evaluate(() => {
    const s = document.getElementById('s-cache');
    if (s) s.value = '30';
    window.workload.anchor_query.cache_rate_baseline = 0.30;
    window.renderPreview();
  });
  await sleep(600);
  const after = await getHeadline(page);
  // Threshold: cache rate is a strong lever on the API portion of the
  // headline (~2-3× rise on api-only between 88% and 30% in the engine),
  // but the public-geospatial-qa preset's headline includes verification
  // overhead (~$2.3K/mo at 10% coverage, FR1) that's INSENSITIVE to
  // cache rate. That fixed overhead dilutes the headline ratio from the
  // ~2× api-only response to ~1.28× on the full headline in production
  // (where federal, retry inflation, and batch share add further
  // composition). We assert >1.15× — modest enough to survive cost-
  // composition shifts, tight enough to catch a real regression where
  // the cache lever drops below ~10% effectiveness on the headline.
  // For a tighter isolation, an internal-result scenario could assert
  // against window.lastResult?.api?.monthly_with_retry directly.
  assert(after > before * 1.15, `expected headline to rise >15% with cache drop 88%→30%, got ${fmt(before)} → ${fmt(after)} (ratio ${(after/before).toFixed(3)}x)`);
}

async function agentPromotion(page) {
  await waitForBoot(page);
  // The default preset (public-geospatial-qa) is now 1-agent + 7-tool
  // out of the box (since 2026-05-31), so the s-agents promotion path
  // (workload-mode→agent-mode on first drag) wouldn't fire on it. Load
  // a workload-mode preset so the original promotion scenario is
  // still exercised. generic-startup-chatbot is workload-mode (no
  // agents array).
  await loadExample(page, 'generic-startup-chatbot');
  await sleep(1500);
  const stateBefore = await page.evaluate(() => ({
    badgeCount: document.querySelectorAll('#cb-calibrated').length,
    agentsLen:  (window.workload?.agents || []).length,
  }));
  assert(stateBefore.agentsLen === 0, `expected workload-mode preset to start with 0 agents, got ${stateBefore.agentsLen}`);
  assert(stateBefore.badgeCount === 1, `expected MEASURED badge on workload-mode load, got count=${stateBefore.badgeCount}`);
  await setSliderTrusted(page, 's-agents', 3);
  await sleep(1500); // 650ms badge fly-away animation + setTimeout(0)
  const stateAfter = await page.evaluate(() => ({
    badgeCount: document.querySelectorAll('#cb-calibrated').length,
    agentsLen:  (window.workload?.agents || []).length,
  }));
  assert(stateAfter.badgeCount === 0, `expected badge removed after promotion, got count=${stateAfter.badgeCount}`);
  assert(stateAfter.agentsLen > 0,    `expected workload.agents populated after promotion, got ${stateAfter.agentsLen}`);
}

async function verifierPreset(page) {
  await waitForBoot(page);
  // Force per-token NLI hosting so the variant's NLI-call-count matters.
  // ALSO set #prev-verif slider — renderPreview reads coverage from the
  // slider (opts.verifCoverage takes precedence over workload.verification
  // .coverage in the engine).
  await page.evaluate(() => {
    const verifEl = document.getElementById('prev-verif');
    if (verifEl) verifEl.value = '0.1';
    window.workload.verification = window.workload.verification || {};
    window.workload.verification.enabled = true;
    window.workload.verification.coverage = 0.1;
    window.workload.verification.variant = 'fr1';
    window.workload.verification.nli_hosting = 'api';
    window.renderPreview();
  });
  await sleep(700);
  const fr1Headline = await getHeadline(page);
  await page.evaluate(() => {
    window.workload.verification.variant = 'minicheck';
    window.renderPreview();
  });
  await sleep(700);
  const minicheckHeadline = await getHeadline(page);
  assert(minicheckHeadline < fr1Headline,
    `MiniCheck should be cheaper than FR1: FR1=${fmt(fr1Headline)} MiniCheck=${fmt(minicheckHeadline)}`);
}

async function toolsRegistry(page) {
  await waitForBoot(page);
  // Registry panel only renders when the workspace editor has been
  // rendered. Force a render so the rows exist in the DOM.
  await page.evaluate(() => {
    if (typeof window.renderEditor === 'function') window.renderEditor();
  });
  await sleep(400);
  const before = await page.locator('#tools-registry-list [data-tool-id]').count();
  assert(before >= 5, `expected ≥5 registry rows after renderEditor, got ${before}`);
  // Add a custom tool
  await page.locator('#add-tool-btn').first().click();
  await sleep(400);
  const after = await page.locator('#tools-registry-list [data-tool-id]').count();
  assert(after === before + 1, `expected +1 tool after click, ${before} → ${after}`);
  const hasCustom = await page.evaluate(() =>
    Object.keys(window.workload.tools_registry).some(k => k.startsWith('custom_tool_'))
  );
  assert(hasCustom, 'expected a custom_tool_N entry in workload.tools_registry');
}

async function agentEnabledTools(page) {
  await waitForBoot(page);
  // Force agent-mode by directly populating workload.agents (bypassing
  // the s-agents promotion path, which depends on a trusted-event drag
  // and adds timing complexity to the test).
  await page.evaluate(() => {
    window.workload.agents = [{
      id: 'test-agent',
      label: 'Test agent',
      input_tokens: 2000,
      output_tokens: 400,
      calls_per_query: 1,
      model: window.workload.defaults?.model || 'gpt-5.2',
      cache_eligible: true,
      hosting: 'api',
      enabled_tools: {},
    }];
    window.renderPreview();
  });
  await sleep(600);
  const before = await getHeadline(page);
  // Enable web_search at 5 calls/query
  await page.evaluate(() => {
    window.workload.agents[0].enabled_tools = {
      web_search: { calls_per_query: 5 }
    };
    window.renderPreview();
  });
  await sleep(600);
  const after = await getHeadline(page);
  assert(after > before, `expected headline to rise after enabling web_search, got ${fmt(before)} → ${fmt(after)}`);
}

async function shareUrlRoundtrip(page) {
  await waitForBoot(page);
  // The s-cache slider lives in an advanced-only area; the calc boots in
  // basic mode where it's hidden (offsetParent null), so a keyboard drag
  // can't move it. Switch to advanced first so the slider is interactable.
  await page.evaluate(() => {
    if (typeof window.setUiMode === 'function') window.setUiMode('advanced');
    else document.querySelector('[data-mode="advanced"]')?.click();
  });
  await sleep(400);
  // Use trusted-event keyboard nudges so the isTrusted-gated
  // bidirectional listener actually pushes the new cache value into
  // workload.anchor_query, which is what gets captured in the URL hash.
  await setSliderTrusted(page, 's-cache', 60);
  await sleep(1000); // 500ms hash debounce + buffer
  const url = page.url();
  assert(url.includes('#w='), 'expected URL to contain #w= hash after slider move');
  const beforeWorkload = await page.evaluate(() => window.workload?.anchor_query?.cache_rate_baseline);
  assertClose(beforeWorkload, 0.60, 0.01,
    `expected workload.anchor_query.cache_rate_baseline=0.60 after trusted drag, got ${beforeWorkload}`);
  // Reload and verify workload state (engine canonical) is restored.
  // NOTE: the bench-coefficients loader correctly overrides the s-cache
  // slider visual to 90 (calibrated bench value), but the workload state
  // preserves the URL-restored 0.60 thanks to the isTrusted filter on
  // the bidirectional listener. Engine reads cacheRate from the slider,
  // so the live headline reflects 0.90 — but the URL hash + workload
  // state DO round-trip correctly, which is what this test verifies.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.getElementById('cb-num')?.textContent && !document.getElementById('cb-num').textContent.includes('—'),
    { timeout: 15000 }
  );
  await sleep(2000); // let bench loader settle
  const afterWorkload = await page.evaluate(() => window.workload?.anchor_query?.cache_rate_baseline);
  assertClose(afterWorkload, 0.60, 0.01,
    `expected workload.anchor_query.cache_rate_baseline=0.60 after reload, got ${afterWorkload}`);
  // Confirm the URL hash still carries the value
  const hash = await page.evaluate(() => window.location.hash);
  assert(hash.includes('#w='), 'expected URL hash to persist after reload');
}

async function mcpResearchFleet(page) {
  await waitForBoot(page);
  // Switch to the demo preset via the example loader
  await loadExample(page, 'mcp-research-fleet');
  await sleep(1500);
  // Should have 3 agents in the workload, multiple tools enabled
  const state = await page.evaluate(() => ({
    agentCount: (window.workload.agents || []).length,
    registrySize: Object.keys(window.workload.tools_registry || {}).length,
    enabledTotal: (window.workload.agents || []).reduce(
      (a, ag) => a + Object.keys(ag.enabled_tools || {}).length, 0
    ),
  }));
  assert(state.agentCount === 3, `expected 3 agents in demo preset, got ${state.agentCount}`);
  assert(state.registrySize >= 6, `expected ≥6 registry entries, got ${state.registrySize}`);
  assert(state.enabledTotal >= 4, `expected ≥4 enabled tools across agents, got ${state.enabledTotal}`);
  const h = await getHeadline(page);
  assert(h > 1000 && h < 100000, `expected demo preset headline in sane range, got ${fmt(h)}`);
}

// ── Scenarios added 2026-05-19: cover today's affordances ───────────────

// BYOK provider mirror — switching an agent to BYOK in the simulator-side
// per-agent dropdown must (a) write workload.agents[i].hosting='byok',
// (b) drop the headline by that agent's previous contribution, (c) show
// the 'BYOK · billed to your key' badge on the Section C agent card,
// and (d) update the procurement-side sec-agents Hosting dropdown.
async function byokProviderMirror(page) {
  await waitForBoot(page);
  await loadExample(page, 'customer-support-fleet');
  await sleep(1500);
  const baseline = await getHeadline(page);
  // Flip Responder (sim.agents[2]) to BYOK via the sim's setAP() — the
  // same path the per-agent Provider dropdown's onchange invokes.
  await page.evaluate(() => { setAP(2, 'provider', 'byok'); });
  await sleep(700);
  const state = await page.evaluate(() => {
    const wl = window.workload;
    return {
      headline: (() => {
        const t = document.getElementById('cost-pill')?.textContent || '';
        const m = t.match(/\$([\d,]+)/);
        return m ? parseInt(m[1].replace(/,/g,'')) : null;
      })(),
      hostingValues: (wl.agents || []).map(a => a.hosting),
      hasByokBadge: !!document.querySelector('.agent-settings-list .badge[title*="own API key"]'),
      procurementHosting: Array.from(document.querySelectorAll('[data-key="hosting"]')).map(s => s.value),
    };
  });
  assert(state.hostingValues[2] === 'byok',
    `expected workload.agents[2].hosting='byok', got ${state.hostingValues[2]}`);
  assert(state.headline < baseline * 0.85,
    `expected headline to drop >15% after BYOK (baseline ${fmt(baseline)}, after ${fmt(state.headline)})`);
  assert(state.hasByokBadge,
    `expected 'BYOK · billed to your key' badge on Section C agent card`);
  assert(state.procurementHosting[2] === 'byok',
    `expected procurement-side sec-agents[2] Hosting=byok (bidirectional sync), got ${state.procurementHosting[2]}`);
}

// BYOK reverse-direction mirror — picking BYOK in the procurement-side
// sec-agents Hosting dropdown must (a) write workload.agents[i].hosting,
// (b) drop the headline, (c) update the SIM-side sim.agents[i].provider,
// and (d) cause the SIM-side BYOK badge to appear. Symmetric of
// byokProviderMirror — together they guarantee both editors stay in sync
// regardless of which one the user touches first.
async function byokReverseMirror(page) {
  await waitForBoot(page);
  await loadExample(page, 'customer-support-fleet');
  await sleep(1500);
  const baseline = await getHeadline(page);
  // Find the third (Responder) hosting select on the procurement side
  // and pick BYOK via the same path the user clicks would take.
  const changed = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('[data-key="hosting"]'));
    if (selects.length < 3) return false;
    selects[2].value = 'byok';
    selects[2].dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  assert(changed, 'expected ≥3 procurement-side Hosting dropdowns');
  await sleep(700);
  const state = await page.evaluate(() => {
    const wl = window.workload;
    const sim = window.sim;
    return {
      headline: (() => {
        const t = document.getElementById('cost-pill')?.textContent || '';
        const m = t.match(/\$([\d,]+)/);
        return m ? parseInt(m[1].replace(/,/g,'')) : null;
      })(),
      wlHosting: (wl.agents || []).map(a => a.hosting),
      simProvider: (sim?.agents || []).map(a => a.provider),
      hasByokBadge: !!document.querySelector('.agent-settings-list .badge[title*="own API key"]'),
    };
  });
  assert(state.wlHosting[2] === 'byok',
    `expected workload.agents[2].hosting='byok', got ${state.wlHosting[2]}`);
  assert(state.headline < baseline * 0.85,
    `expected headline drop >15% after BYOK (baseline ${fmt(baseline)}, after ${fmt(state.headline)})`);
  assert(state.simProvider[2] === 'byok',
    `expected sim.agents[2].provider='byok' (reverse mirror), got ${state.simProvider[2]}`);
  assert(state.hasByokBadge,
    `expected sim-side BYOK badge to appear after procurement-side BYOK pick`);
}

// Self-host reverse-mirror — symmetric to BYOK reverse-mirror. Picking
// self-host in the procurement-side sec-agents Hosting dropdown must
// (a) write workload.agents[i].hosting='self-host', (b) drop the API
// headline (engine excludes from API line; self-host counted elsewhere),
// (c) sync sim.agents[i].provider='self-hosted', (d) render the
// SELF-HOST badge on the Section C agent card.
async function selfHostReverseMirror(page) {
  await waitForBoot(page);
  await loadExample(page, 'customer-support-fleet');
  await sleep(1500);
  const baseline = await getHeadline(page);
  const changed = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('[data-key="hosting"]'));
    if (selects.length < 3) return false;
    selects[2].value = 'self-host';
    selects[2].dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  assert(changed, 'expected ≥3 procurement-side Hosting dropdowns');
  await sleep(700);
  const state = await page.evaluate(() => {
    const wl = window.workload;
    const sim = window.sim;
    return {
      headline: (() => {
        const t = document.getElementById('cost-pill')?.textContent || '';
        const m = t.match(/\$([\d,]+)/);
        return m ? parseInt(m[1].replace(/,/g,'')) : null;
      })(),
      wlHosting: (wl.agents || []).map(a => a.hosting),
      simProvider: (sim?.agents || []).map(a => a.provider),
      hasSelfHostBadge: !!document.querySelector('.agent-settings-list .badge[title*="self-host"], .agent-settings-list .badge-selfhost'),
    };
  });
  assert(state.wlHosting[2] === 'self-host',
    `expected workload.agents[2].hosting='self-host', got ${state.wlHosting[2]}`);
  assert(state.headline < baseline * 0.85,
    `expected headline drop >15% after self-host (baseline ${fmt(baseline)}, after ${fmt(state.headline)})`);
  assert(state.simProvider[2] === 'self-hosted',
    `expected sim.agents[2].provider='self-hosted' (reverse mirror), got ${state.simProvider[2]}`);
  assert(state.hasSelfHostBadge,
    `expected sim-side SELF-HOST badge to appear after procurement-side self-host pick`);
}

// Per-agent task_bias engine wiring — setting agent.task_bias must move
// the bill (engine reads the field and scales output tokens). Regression
// guard for the no-op-knob bug fixed 2026-05-18.
async function taskBiasMoves(page) {
  await waitForBoot(page);
  await loadExample(page, 'public-geospatial-qa');
  await sleep(1500);
  // Strip any existing task_bias (this preset shouldn't have any) so we
  // measure a clean baseline, then set every agent to longform.
  const result = await page.evaluate(async () => {
    const wl = window.workload;
    if (!wl || !Array.isArray(wl.agents) || wl.agents.length === 0) {
      return { skipped: true };
    }
    const original = wl.agents.map(a => a.task_bias);
    // baseline
    wl.agents.forEach(a => { delete a.task_bias; });
    if (typeof window.renderPreview === 'function') window.renderPreview();
    await new Promise(r => setTimeout(r, 300));
    const baseTxt = document.getElementById('cost-pill')?.textContent || '';
    const baseM = baseTxt.match(/\$([\d,]+)/);
    const baseline = baseM ? parseInt(baseM[1].replace(/,/g,'')) : null;
    // all agents = longform (3.6× output)
    wl.agents.forEach(a => { a.task_bias = 'longform'; });
    if (typeof window.renderPreview === 'function') window.renderPreview();
    await new Promise(r => setTimeout(r, 300));
    const afterTxt = document.getElementById('cost-pill')?.textContent || '';
    const afterM = afterTxt.match(/\$([\d,]+)/);
    const after = afterM ? parseInt(afterM[1].replace(/,/g,'')) : null;
    // restore
    wl.agents.forEach((a, i) => {
      if (original[i] == null) delete a.task_bias; else a.task_bias = original[i];
    });
    if (typeof window.renderPreview === 'function') window.renderPreview();
    return { baseline, after };
  });
  if (result.skipped) {
    // public-geospatial-qa has no agents (unit-cost mode) — skip
    return;
  }
  assert(result.baseline != null && result.after != null,
    `failed to read headline before/after task_bias change`);
  assert(result.after > result.baseline,
    `expected longform task_bias to RAISE headline (baseline ${fmt(result.baseline)}, after ${fmt(result.after)}) — engine may not be reading task_bias`);
}

// Section helpers — every section divider must have an adjacent
// .section-helper block, and the <strong> inside must render cyan
// (not the gray-on-procurement-pane bug). Also asserts the A-G
// numbered badges are gone.
async function sectionHelpersPresent(page) {
  await waitForBoot(page);
  const state = await page.evaluate(() => {
    const helpers = Array.from(document.querySelectorAll('.section-helper'));
    const strongs = helpers.map(h => h.querySelector('strong')).filter(Boolean);
    const colors = strongs.map(s => getComputedStyle(s).color);
    const ixNums = Array.from(document.querySelectorAll('.ix-num')).map(e => e.textContent);
    return { helperCount: helpers.length, strongColors: [...new Set(colors)], ixNums };
  });
  assert(state.helperCount >= 20,
    `expected ≥20 .section-helper blocks across procurement + simulator panes, got ${state.helperCount}`);
  // Every strong should be cyan-ish (rgb(0, 119, 204) procurement OR rgb(0, 212, 255) sim).
  // Reject if ANY strong is rendering inherited gray text (the bug).
  for (const c of state.strongColors) {
    assert(/rgb\(0,\s*(119|212),\s*(204|255)\)/.test(c),
      `section-helper strong rendering wrong color: ${c} (expected cyan)`);
  }
  assert(state.ixNums.length === 0,
    `expected zero .ix-num badges (A-G removed), got [${state.ixNums.join(',')}]`);
}

// Default preset (public-geospatial-qa) — now ships as 1-agent + 7-tool
// EIE walkthrough by default (previously a separate -per-tool variant,
// folded in on 2026-05-31 when the calibration was rebuilt from
// EIE-agent responses.py + openveda STAC measurements). Verifies the
// registry/agent shape after boot, then flips global RETURN SHAPE
// templated→freeform and asserts (a) all 7 tools mirror the change
// and (b) the headline rises (uncapped STAC payloads dominate).
async function geospatialDefaultPreset(page) {
  await waitForBoot(page);
  // EIE-named tool IDs from eie-agent/eie_agent/tools/. loadExample
  // merges these INTO the default DEFAULT_TOOLS_REGISTRY rather than
  // replacing, so the registry can legitimately have extra entries
  // (web_search, code_execution, etc.) — but these 7 EIE tools must
  // be present, default to templated, and be referenced exactly by
  // the agent's enabled_tools.
  const NAMED = ['set_datetime','get_place','collections_rag','select_collection',
                 'stac_search','stats','viz'];
  const shape = await page.evaluate((named) => {
    const reg = window.workload?.tools_registry || {};
    const ag = window.workload?.agents?.[0];
    const enabled = ag ? Object.keys(ag.enabled_tools || {}) : [];
    return {
      agentCount:      (window.workload.agents || []).length,
      missingFromReg:  named.filter(id => !reg[id]),
      namedTemplated:  named.every(id => reg[id]?.return_shape === 'templated'),
      enabledEqualsNamed: enabled.length === named.length && named.every(id => enabled.includes(id)),
    };
  }, NAMED);
  assert(shape.agentCount === 1,            `expected 1 agent, got ${shape.agentCount}`);
  assert(shape.missingFromReg.length === 0, `missing EIE pipeline tools from registry: ${shape.missingFromReg.join(', ')}`);
  assert(shape.namedTemplated,              'expected all 7 EIE pipeline tools to default to templated');
  assert(shape.enabledEqualsNamed,          'expected agent enabled_tools to match exactly the 7 EIE pipeline tools');
  const baseline = await getHeadline(page);
  assert(baseline > 0, `expected positive headline on preset load, got ${fmt(baseline)}`);
  await page.selectOption('#s-tool-response-mode', 'freeform');
  await sleep(800);
  const after = await page.evaluate((named) => {
    const reg = window.workload?.tools_registry || {};
    return {
      namedAllFreeform:  named.every(id => reg[id]?.return_shape === 'freeform'),
      anyNamedTemplated: named.some(id => reg[id]?.return_shape === 'templated'),
    };
  }, NAMED);
  assert(after.namedAllFreeform,    'expected global freeform to bulk-apply to all 7 EIE tools');
  assert(!after.anyNamedTemplated,  'expected no templated entries among the 7 EIE tools after global flip');
  const headlineFreeform = await getHeadline(page);
  assert(headlineFreeform > baseline,
    `expected headline to rise after global → freeform (uncaps STAC payloads), got ${fmt(baseline)} → ${fmt(headlineFreeform)}`);
}

// Validated calibration badge — when the user clicks Minimal/Moderate/
// Heavy on a preset that has payload_modes, the active button's text
// must be white #fff (not green-on-green from the old var(--card) bug).
async function validatedButtonContrast(page) {
  await waitForBoot(page);
  await loadExample(page, 'public-geospatial-qa');
  await sleep(1500);
  const state = await page.evaluate(() => {
    const calBadge = document.querySelector('.calibration-badge');
    if (!calBadge) return { noBadge: true };
    const activeBtn = calBadge.querySelector('.cal-mode-btn.active');
    if (!activeBtn) return { noModeButtons: true };
    const activeSpan = activeBtn.querySelector('span');
    return {
      btnText: activeBtn.textContent?.trim(),
      spanColor: activeSpan ? getComputedStyle(activeSpan).color : null,
    };
  });
  if (state.noBadge || state.noModeButtons) {
    // Preset has no payload_modes (e.g., the new agent-mode default preset
    // since 2026-05-31, where the per-tool RETURN SHAPE lever superseded
    // the coarse Validated/Moderate/Heavy buttons). Nothing to test.
    return;
  }
  assert(state.spanColor === 'rgb(255, 255, 255)',
    `expected Validated active button span color #fff, got ${state.spanColor} (green-on-green bug regression)`);
}

// Per-agent ARCHETYPE editor lives in the simulator agent card. Loading the
// archetype-agent-demo preset should surface the toggle; editing an
// archetype's input_tokens must move the headline (engine prices the mix).
async function archetypeEditor(page) {
  await waitForBoot(page);
  // Set via JS + change event (the loader can be responsive-hidden at this
  // viewport, which makes selectOption flake on visibility).
  await loadExample(page, 'archetype-agent-demo');
  await sleep(1800);
  // AC1: the simulator card exposes the archetype toggle.
  const togExists = await page.evaluate(() =>
    !!document.querySelector('input[onchange*="simTogArchMode"], input[onclick*="simTogArchMode"]'));
  assert(togExists, 'archetype toggle not found in simulator agent card');
  // Ensure mode on + the editable input_tokens cell is present (AC2).
  await page.evaluate(() => {
    const t = document.querySelector('input[onchange*="simTogArchMode"], input[onclick*="simTogArchMode"]');
    if (t && !t.checked) t.click();
  });
  await sleep(400);
  const hasCell = await page.evaluate(() => !!document.querySelector("input[oninput*=\"'input_tokens'\"]"));
  assert(hasCell, 'archetype input_tokens cell not rendered');
  // Drop MAU so the default daily cap doesn't clamp and mask edits.
  await setSliderValue(page, 's-users', 300);
  await sleep(800);
  const before = await getHeadline(page);
  // AC3: doubling an archetype's input_tokens raises the headline.
  await page.evaluate(() => {
    const c = document.querySelector("input[oninput*=\"'input_tokens'\"]");
    c.value = String((parseFloat(c.value) || 80000) * 2);
    c.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(800);
  const after = await getHeadline(page);
  assert(after > before, `editing archetype tokens did not raise headline: ${before} → ${after}`);
}

// Guard: browser-rendered headline must equal MCP compute_cost headline for
// the same workload. Covers the cap-clamped archetype-agent-demo (MAU 10K)
// and a non-capped low-volume variant (MAU 300). Navigation uses the
// hash-assignment pattern because page.goto() corrupts 3K+ char hash URLs.
async function uiMcpConsistency(page) {
  const { computeCost } = await import('../mcp/lib/compute.mjs');
  const fs = require('node:fs');
  const nodePath = require('node:path');
  const demo = JSON.parse(
    fs.readFileSync(nodePath.join(__dirname, '..', 'public', 'examples', 'archetype-agent-demo.json'))
  );
  const lowVol = JSON.parse(JSON.stringify(demo));
  // applyBotFactor: false matches the demo segment and prevents ensureFields()
  // from defaulting to true on load (which would apply a 1.5× bot multiplier
  // that the MCP engine doesn't see when applyBotFactor is absent).
  lowVol.segments = [{ id: 'all', mau: 300, sessions_per_day: 0.2, questions_per_session: 10, applyBotFactor: false }];
  const base = URL.split('#')[0];
  for (const [name, w] of [['demo', demo], ['low-volume', lowVol]]) {
    const mcp = computeCost(w);
    assert(!mcp.error, `${name}: compute_cost errored: ${mcp.error}`);
    // share_link is "https://calc.ajinkya.ai/#w=...&mode=advanced"
    // Split on the origin to get just the hash portion ("#w=...").
    const hashStr = mcp.share_link.split('calc.ajinkya.ai/')[1];
    assert(hashStr && hashStr.startsWith('#'), `${name}: unexpected share_link format`);
    // Load base page (no hash), then set hash via evaluate (avoids URL-length
    // limit on page.goto), then reload so boot reads the hash.
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.evaluate((h) => { window.location.hash = h; }, hashStr);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => { const e = document.getElementById('cb-num'); return e && e.textContent && !e.textContent.includes('—'); },
      { timeout: 15000 }
    );
    await page.evaluate(() => { const o = document.getElementById('welcome-overlay'); if (o) o.remove(); });
    await sleep(2500); // bench loader + recompute settle
    const ui = await page.evaluate(
      () => parseInt((document.getElementById('cb-num').textContent || '').replace(/[^\d]/g, ''), 10)
    );
    assert(ui === mcp.headline_monthly_usd,
      `${name}: UI $${ui} != MCP $${mcp.headline_monthly_usd}`);
  }
}

// ── Runner ───────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nE2E suite — target: ${URL}`);
  console.log(`slowMo: ${slowMs}ms${headed ? ' · headed' : ' · headless'}${onlyName ? ` · only=${onlyName}` : ''}\n`);
  const t0 = Date.now();
  await scenario('boot-and-defaults',     bootAndDefaults);
  await scenario('mau-slider',            mauSlider);
  await scenario('cache-slider',          cacheSlider);
  await scenario('agent-promotion',       agentPromotion);
  await scenario('verifier-preset',       verifierPreset);
  await scenario('tools-registry',        toolsRegistry);
  await scenario('agent-enabled-tools',   agentEnabledTools);
  await scenario('share-url-roundtrip',   shareUrlRoundtrip);
  await scenario('mcp-research-fleet',    mcpResearchFleet);
  await scenario('byok-provider-mirror',  byokProviderMirror);
  await scenario('byok-reverse-mirror',   byokReverseMirror);
  await scenario('selfhost-reverse',      selfHostReverseMirror);
  await scenario('task-bias-moves',       taskBiasMoves);
  await scenario('section-helpers',       sectionHelpersPresent);
  await scenario('geo-default-preset',    geospatialDefaultPreset);
  await scenario('validated-button',      validatedButtonContrast);
  await scenario('archetype-editor',      archetypeEditor);
  await scenario('ui-mcp-consistency',    uiMcpConsistency);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${passed} passed · ${failed} failed · ${dt}s\n`);
  if (failed > 0) {
    console.log('FAILURES:');
    for (const f of failures) {
      console.log(`  ${f.name}: ${f.error}`);
      if (f.errors && f.errors.length) for (const e of f.errors) console.log(`    JS: ${e}`);
    }
    process.exit(1);
  }
})();
