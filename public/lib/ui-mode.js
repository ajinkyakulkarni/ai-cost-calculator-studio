/* ui-mode.js — Basic vs Advanced UI mode.
 *
 * Extracted verbatim from cost-simulator.js (2026-06-10 modularization
 * pass). Self-contained: touches only document/body classes, the
 * #mode-toggle pill, the sidebar tab fallback, and the debounced
 * workload-hash serializer exposed by app.js as
 * window.__scheduleHashUpdate.
 *
 * Two-mode UI: BASIC hides .advanced-only nodes (per CSS in index.html);
 * ADVANCED exposes every knob. Mode persists via URL hash
 * (#...&mode=basic|advanced) — no localStorage — so a shared link carries
 * the mode through to the recipient. Default boot mode: basic (simple
 * surface first; engineers flip the pill or share #mode=advanced). The
 * engine math is unchanged regardless of mode — hidden controls keep
 * their preset defaults (see memory/design rule: CSS-only hiding, no
 * per-mode engine branches; headline must be identical across modes). */
function setUiMode(m){
  const mode = m === 'advanced' ? 'advanced' : 'basic';
  document.body.classList.remove('mode-basic','mode-advanced');
  document.body.classList.add('mode-' + mode);
  // Sync the segmented-pill toggle (Basic | Advanced). aria-checked
  // drives the CSS that paints the white inner pill on the selected
  // segment; data-mode lets the click handler dispatch back through here.
  // role="radio" inside role="group" is the WAI-ARIA pattern for a 2-state
  // toggle with no panel (not role="tablist", which requires panels).
  const pill = document.getElementById('mode-toggle');
  if (pill) {
    pill.querySelectorAll('[data-mode]').forEach(btn => {
      btn.setAttribute('aria-checked', btn.dataset.mode === mode ? 'true' : 'false');
    });
  }
  // Hash update is delegated to the debounced workload-state serializer
  // in app.js (window.__scheduleHashUpdate, called below). It reads body
  // class and re-emits the canonical #w=<base64>&mode=<mode> form,
  // preserving the workload payload alongside the mode. A synchronous
  // replaceState here would double-write — the debounce would still fire
  // 500ms later with the body class and rebuild the same hash — so we
  // drop the sync write entirely. Body class is the single source of
  // truth; the hash writer reads it on every fire.
  // If the active sidebar tab is now hidden, switch to a safe visible
  // tab so the report area doesn't show a dead state.
  try {
    const active = document.querySelector('.sidebar .tab-btn.active');
    if (mode === 'basic' && active && active.classList.contains('advanced-only')) {
      const fallback = document.querySelector('.sidebar .tab-btn[data-wiz="report"]')
                    || document.querySelector('.sidebar .tab-btn[data-wiz="profile"]')
                    || document.querySelector('.sidebar .tab-btn:not(.advanced-only)');
      if (fallback) fallback.click();
    }
  } catch(_){ /* tab fallback is best-effort */ }
  // Re-trigger the workload-hash serializer (defined in app.js) so the
  // freshly-set body class gets reflected in the hash. Without this,
  // an initial-render renderPreview that fires BEFORE setUiMode finishes
  // would write a hash without mode= and we'd lose the mode in the URL.
  try {
    if (typeof window.__scheduleHashUpdate === 'function') {
      window.__scheduleHashUpdate();
    }
  } catch(_){ /* hash re-trigger is best-effort */ }
}

// Boot: read mode from URL hash, default basic. Wire hashchange so an
// external nav (browser back/forward, or another script editing the
// hash) re-syncs the mode display.
(function _initUiMode(){
  const apply = () => {
    try {
      const m = (window.location.hash || '').match(/[#&]mode=(basic|advanced)/);
      // Default boot mode: basic — first-time visitors get the simple
      // procurement surface. Engineers flip the appbar pill or share a
      // URL with #mode=advanced.
      setUiMode(m ? m[1] : 'basic');
    } catch(e){ console.warn('UI mode init deferred:',e); setTimeout(apply,200); }
  };
  const wireHashChange = () => {
    window.addEventListener('hashchange', () => {
      const m = (window.location.hash || '').match(/[#&]mode=(basic|advanced)/);
      const desired = m ? m[1] : 'basic';
      const current = document.body.classList.contains('mode-advanced') ? 'advanced' : 'basic';
      if (desired !== current) setUiMode(desired);
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { apply(); wireHashChange(); });
  } else {
    apply(); wireHashChange();
  }
})();
