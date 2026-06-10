/* audience-block.js — the "Your audience" panel (DOM layer).
 *
 * Extracted from cost-simulator.js (2026-06-10 modularization pass).
 * The aggregate FORMULAS live in lib/audience-math.js (pure, unit-
 * tested in Node via scripts/test-audience-math.js); this file is only
 * the DOM rendering + event wiring on top of them.
 *
 * Single canonical UI for editing per-segment audience data (MAU /
 * sessions / questions / bot factor). Two visual modes, auto-selected
 * from workload.segments.length:
 *   - single (1 segment):  3 sliders + "Split into audience types" CTA
 *   - multi  (2+ segments): per-segment cards + "Add another audience" CTA
 *
 * No new persisted state. The view is derived from segments.length on
 * every render. Engine math is unchanged — both views write to
 * workload.segments[] which is the engine's only audience source of
 * truth. The 3 sliders (#s-users / #s-sessions / #s-turns) stay in the
 * DOM in all modes so existing reads in app.js / cost-engine.js keep
 * working; in multi-mode they're hidden and their .value is kept synced
 * to the aggregate so anything that polls them gets a sensible number.
 *
 * Load order: AFTER lib/audience-math.js (uses window.AudienceMath) and
 * AFTER the #audience-block markup in index.html (the wiring IIFE looks
 * the element up at parse time). cost-simulator.js's boot setTimeout
 * calls renderAudienceBlock() via the global this file defines. */

/* Sync the hidden legacy slider inputs + their value labels to the
   aggregate of all segments. Returns the aggregate so callers can
   reuse it. */
function _syncAudienceMirrors(segments) {
  const agg = AudienceMath.computeAudienceAggregates(segments);
  const sUsers = document.getElementById('s-users');
  const sSess  = document.getElementById('s-sessions');
  const sTurns = document.getElementById('s-turns');
  const m = AudienceMath.mirrorValues(agg, sUsers ? parseInt(sUsers.max || '500000', 10) : 500000);
  if (sUsers) sUsers.value = String(m.users);
  if (sSess)  sSess.value  = String(m.sessions);
  if (sTurns) sTurns.value = String(m.turns);
  return agg;
}

/* Shared summary-line builder (multi-mode header). */
function _audienceSummaryHtml(agg, segCount) {
  const b = (txt) => `<span style="color:#0B3D91;font-weight:700">${txt}</span>`;
  return `Total: ${b(agg.mau.toLocaleString() + ' MAU')} across ${b(segCount)} audiences · `
       + `${b(agg.weightedSessionsPerDay.toFixed(2))} sess/day (weighted) · `
       + `${b(Math.round(agg.weightedQuestionsPerSession))} q/session (weighted)`;
}

function renderAudienceBlock() {
  const block = document.getElementById('audience-block');
  if (!block) return; // not on this page
  const w = window.workload;
  if (!w || !Array.isArray(w.segments)) return;
  const single = block.querySelector('[data-audience-view="single"]');
  const multi  = block.querySelector('[data-audience-view="multi"]');
  if (!single || !multi) return;
  const isMulti = w.segments.length >= 2;
  single.hidden = isMulti;
  multi.hidden  = !isMulti;
  // Panel-header badge reflects the current mode at a glance.
  const badge = document.getElementById('audience-mode-badge');
  if (badge) badge.textContent = isMulti ? `${w.segments.length} audiences` : 'single';
  // Always sync the 3 hidden slider inputs to the aggregate so
  // downstream code that reads cfg('s-users')/etc. gets the right
  // number regardless of mode. In single-mode these are the live
  // controls; in multi-mode they're downstream mirrors.
  const agg = _syncAudienceMirrors(w.segments);
  // Update the value-labels next to the sliders (single-mode visible UI).
  const vUsers = document.getElementById('v-users');
  const vSess  = document.getElementById('v-sessions');
  const vTurns = document.getElementById('v-turns');
  if (vUsers) vUsers.textContent = agg.mau.toLocaleString();
  if (vSess)  vSess.textContent  = agg.weightedSessionsPerDay.toFixed(2);
  if (vTurns) vTurns.textContent = String(Math.round(agg.weightedQuestionsPerSession));
  if (isMulti) renderAudienceMulti(w.segments);
}

function renderAudienceMulti(segs) {
  const summary = document.getElementById('audience-summary');
  const cards = document.getElementById('audience-cards');
  if (!summary || !cards) return;
  const agg = AudienceMath.computeAudienceAggregates(segs);
  summary.innerHTML = _audienceSummaryHtml(agg, segs.length);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  cards.innerHTML = segs.map((seg, i) => `
    <fieldset class="audience-card" data-seg-idx="${i}">
      <div class="audience-card-head">
        <input type="text" class="audience-card-label-input" data-seg-label="${i}"
               value="${esc(seg.label || seg.id || `Audience ${i + 1}`)}"
               aria-label="Audience ${i + 1} label">
        <button type="button" class="audience-card-remove" data-seg-remove="${i}"
                title="Remove this audience type">× remove</button>
      </div>
      <div class="audience-card-fields">
        <div class="sr">
          <div class="sr-top">
            <span class="sr-label is-measured" data-tip="### Monthly active users (MAU)

**In plain English:** how many distinct people use this audience in a typical month. Counted as unique humans, NOT visits or sessions.

**Why this audience is measured.** Pull this number from real analytics — login records for authenticated audiences, web-analytics dedup for anonymous ones. The whole bill scales linearly with MAU so a 2× error here means a 2× error on the bill.">Monthly active users</span>
            <span class="sr-val" data-seg-mau-val="${i}" style="color:var(--cyan)">${(Number(seg.mau) || 0).toLocaleString()}</span>
          </div>
          <input type="range" min="1" max="500000" step="1" value="${Number(seg.mau) || 1}" data-seg-mau="${i}" aria-label="Monthly active users for ${esc(seg.label || seg.id)}">
          <div class="sr-hint">📊 from analytics · unique humans per month in this audience</div>
        </div>
        <div class="sr">
          <div class="sr-top">
            <span class="sr-label is-measured" data-tip="### Sessions per user per day

**In plain English:** the average number of times a single user opens a session per day. Fractional rate — most users don't show up every day so realistic values sit well below 1.0.

**Why this audience is measured.** Pull from analytics (login events or web visits). Public portals usually sit around 0.1–0.3 (most visitors don't return). Internal tools sit higher (0.5–3.0).">Sessions / day</span>
            <span class="sr-val" data-seg-sess-val="${i}" style="color:var(--cyan)">${(Number(seg.sessions_per_day) || 0).toFixed(2)}</span>
          </div>
          <input type="range" min="0.01" max="10" step="0.01" value="${Number(seg.sessions_per_day) || 0.01}" data-seg-sess="${i}" aria-label="Sessions per user per day for ${esc(seg.label || seg.id)}">
          <div class="sr-hint">📊 from analytics · how often each user comes back (≤1 typical)</div>
        </div>
        <div class="sr">
          <div class="sr-top">
            <span class="sr-label is-measured" data-tip="### Questions per session

**In plain English:** how many back-and-forth exchanges happen in one chat session for this audience. One question + assistant reply = one turn.

**Why this audience is measured.** Pull from chat-log analytics. Quick Q&A audiences (search-style): 1–3. Deep research / analyst audiences: 8–20.">Questions / session</span>
            <span class="sr-val" data-seg-q-val="${i}" style="color:var(--cyan)">${Math.round(Number(seg.questions_per_session) || 0)}</span>
          </div>
          <input type="range" min="1" max="40" step="1" value="${Math.max(1, Number(seg.questions_per_session) || 1)}" data-seg-q="${i}" aria-label="Questions per session for ${esc(seg.label || seg.id)}">
          <div class="sr-hint">📊 from analytics · turns per session</div>
        </div>
        <label class="bot-cell" title="Apply the global bot-factor multiplier to this audience (typical for anonymous public segments).">
          Apply Bot factor
          <input type="checkbox" data-seg-bot="${i}" ${seg.applyBotFactor ? 'checked' : ''}>
        </label>
      </div>
    </fieldset>
  `).join('');
}

// Refresh just the summary line + hidden-input mirrors without
// re-rendering the cards (which would steal focus from whatever input
// the user is typing into).
function renderAudienceBlock_summaryOnly() {
  const w = window.workload;
  if (!w || !Array.isArray(w.segments)) return;
  const agg = _syncAudienceMirrors(w.segments);
  // Summary line (only in multi-mode)
  if (w.segments.length >= 2) {
    const summary = document.getElementById('audience-summary');
    if (summary) summary.innerHTML = _audienceSummaryHtml(agg, w.segments.length);
  }
}

// Expose so app.js can re-render after preset loads / hash restores
// without duplicating the audience-block logic in two places.
window.__renderAudienceBlock = renderAudienceBlock;
// Bare-global exposure for cost-simulator.js's boot call (classic
// scripts: function declarations already bind to window, this line is
// documentation of the contract more than necessity).
window.renderAudienceBlock = renderAudienceBlock;

/* Click handlers — wired once via event delegation on the block. */
(function _wireAudienceBlock() {
  const block = document.getElementById('audience-block');
  if (!block) return;
  const onMutate = () => {
    // Re-render the block (could be a mode flip) and re-run the
    // cost preview so the headline reflects the new segments.
    renderAudienceBlock();
    if (typeof window.renderPreview === 'function') {
      window.renderPreview();
    } else if (typeof onSlider === 'function') {
      onSlider();
    }
  };
  block.addEventListener('click', (e) => {
    const t = e.target;
    // "+ Split into audience types"
    if (t && t.id === 'audience-split-btn') {
      const w = window.workload;
      if (!w || !Array.isArray(w.segments) || w.segments.length === 0) return;
      // Push a default new segment alongside the existing one.
      w.segments.push({
        id: 'auth', label: 'Authenticated',
        mau: 1000, sessions_per_day: 0.2, questions_per_session: 5,
        applyBotFactor: false
      });
      onMutate();
      return;
    }
    // "+ Add another audience type"
    if (t && t.id === 'audience-add-btn') {
      const w = window.workload;
      if (!w || !Array.isArray(w.segments)) return;
      const used = new Set(w.segments.map(s => s.id));
      let id = 'audience' + (w.segments.length + 1);
      while (used.has(id)) id += '_';
      w.segments.push({
        id, label: id,
        mau: 1000, sessions_per_day: 0.2, questions_per_session: 5,
        applyBotFactor: false
      });
      onMutate();
      return;
    }
    // "× remove" on a card
    if (t && t.dataset && t.dataset.segRemove != null) {
      const w = window.workload;
      const idx = parseInt(t.dataset.segRemove, 10);
      if (!w || !Array.isArray(w.segments) || !Number.isInteger(idx)) return;
      if (w.segments.length <= 1) return; // never go to zero from the UI
      w.segments.splice(idx, 1);
      onMutate();
      return;
    }
  });
  // Slider / label edits inside cards
  block.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    const w = window.workload;
    if (!w || !Array.isArray(w.segments)) return;
    const idxStr = t.dataset.segMau ?? t.dataset.segSess ?? t.dataset.segQ ?? t.dataset.segLabel;
    if (idxStr == null) return;
    const idx = parseInt(idxStr, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= w.segments.length) return;
    const seg = w.segments[idx];
    if (t.dataset.segMau != null) {
      seg.mau = Math.max(0, Number(t.value) || 0);
      const label = document.querySelector(`[data-seg-mau-val="${idx}"]`);
      if (label) label.textContent = seg.mau.toLocaleString();
    } else if (t.dataset.segSess != null) {
      seg.sessions_per_day = Math.max(0, Number(t.value) || 0);
      const label = document.querySelector(`[data-seg-sess-val="${idx}"]`);
      if (label) label.textContent = seg.sessions_per_day.toFixed(2);
    } else if (t.dataset.segQ != null) {
      seg.questions_per_session = Math.max(0, Number(t.value) || 0);
      const label = document.querySelector(`[data-seg-q-val="${idx}"]`);
      if (label) label.textContent = String(Math.round(seg.questions_per_session));
    } else if (t.dataset.segLabel != null) {
      seg.label = String(t.value || '').trim() || seg.id;
    }
    // Don't re-render the cards on every keystroke — that destroys focus.
    // Just sync the hidden inputs + summary + re-run the cost engine.
    renderAudienceBlock_summaryOnly();
    if (typeof window.renderPreview === 'function') window.renderPreview();
    else if (typeof onSlider === 'function') onSlider();
  });
  // Bot-factor checkbox edits
  block.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.dataset || t.dataset.segBot == null) return;
    const w = window.workload;
    const idx = parseInt(t.dataset.segBot, 10);
    if (!w || !Array.isArray(w.segments) || !Number.isInteger(idx)) return;
    if (idx < 0 || idx >= w.segments.length) return;
    w.segments[idx].applyBotFactor = !!t.checked;
    renderAudienceBlock_summaryOnly();
    if (typeof window.renderPreview === 'function') window.renderPreview();
    else if (typeof onSlider === 'function') onSlider();
  });
})();
