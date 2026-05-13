/**
 * test-controls.js — browser-side smoke test for UI control wiring.
 *
 * Use case: catch the class of bug where a slider LOOKS active but
 * is silently shadowed by a per-agent or per-segment override from a
 * loaded preset. The May 2026 "what-if cards all show 0%" bug was
 * exactly this shape — sliders changed, headline cost didn't.
 *
 * How to run:
 *
 *   1. Open the calc (calc.ajinkya.ai or localhost:8765/index.html)
 *   2. Load whichever preset you want to test against (or none for
 *      defaults)
 *   3. Open DevTools → Console
 *   4. Paste this whole file and press Enter
 *   5. Read the table: each control is OK (cost changed) or STUCK
 *      (cost unchanged when the value was perturbed)
 *
 * STUCK controls are not necessarily bugs — many sliders only affect
 * specific cost numbers (e.g. peak-sizing, monthly projections,
 * verification cost) rather than the per-session model cost we read
 * here. But every STUCK row deserves a second look: ask whether the
 * slider IS supposed to move per-session cost and, if so, whether
 * the loaded preset is shadowing it.
 */
(function runControlCoverageTest() {
  if (typeof computeCost !== 'function') {
    console.error('computeCost not in scope — open this on a calc.ajinkya.ai page.');
    return;
  }

  const baseline = computeCost().netCost;
  const controls = Array.from(
    document.querySelectorAll('input[id^="s-"], select[id^="s-"]')
  );

  const results = [];
  for (const ctrl of controls) {
    const id = ctrl.id;
    const before = ctrl.value;
    const beforeNum = parseFloat(before) || 0;

    // Pick a meaningfully-different target value
    let target;
    if (ctrl.type === 'range' || ctrl.type === 'number') {
      const max = parseFloat(ctrl.max);
      const min = parseFloat(ctrl.min);
      if (beforeNum === 0 && !isNaN(max)) {
        target = Math.max(1, Math.floor(max / 2));
      } else if (!isNaN(max) && beforeNum * 2 <= max) {
        target = beforeNum * 2;
      } else if (!isNaN(min) && beforeNum / 2 >= min && beforeNum > 0) {
        target = Math.floor(beforeNum / 2);
      } else if (!isNaN(max)) {
        target = max;
      } else {
        target = beforeNum + 10;
      }
    } else if (ctrl.tagName === 'SELECT') {
      const opts = Array.from(ctrl.options)
        .map(o => o.value)
        .filter(v => v !== before && v !== '');
      target = opts[0];
    } else {
      continue;
    }

    if (target === undefined || String(target) === String(before)) {
      results.push({ id, status: 'NO_PERTURB', before, target: '(none)', pct: '—' });
      continue;
    }

    ctrl.value = target;
    const after = computeCost().netCost;
    ctrl.value = before; // restore
    const pct = baseline ? ((after - baseline) / baseline) * 100 : 0;

    results.push({
      id,
      status: Math.abs(pct) < 0.005 ? 'STUCK' : 'OK',
      before,
      target: String(target),
      pct: pct.toFixed(2) + '%',
    });
  }

  const stuck = results.filter(r => r.status === 'STUCK');
  const ok = results.filter(r => r.status === 'OK');

  console.group('%cUI control coverage', 'font-weight:bold;font-size:13px');
  console.log('Baseline per-session cost: $' + baseline.toFixed(5));
  console.log(
    `Total controls tested: ${results.length} · OK: ${ok.length} · STUCK: ${stuck.length}`
  );
  console.table(results);
  if (stuck.length) {
    console.warn(
      `${stuck.length} stuck controls — IDs:`,
      stuck.map(r => r.id).join(', ')
    );
    console.log(
      'A STUCK row means: changing this slider does NOT move per-session model cost.\n' +
        'Possible causes:\n' +
        '  · The loaded preset has per-agent overrides shadowing the global slider\n' +
        '    (e.g. agent.rag_chunks shadowing s-rag-chunks).\n' +
        '  · The slider only affects a different cost number (peak-sizing,\n' +
        '    growth projections, verification, infrastructure, etc.).\n' +
        '  · The slider is gated by an off-flag (e.g. ragOn=false on every agent).'
    );
  } else {
    console.log('All sliders moved per-session cost ✓');
  }
  console.groupEnd();
  return results;
})();
