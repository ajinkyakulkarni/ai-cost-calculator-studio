/* headline-math.js — the headline composition + agent-engineering math.
 *
 * Extracted from app.js (2026-06-10 modularization pass). PURE: no DOM,
 * no closures — every input is a parameter. Dual-exported (browser
 * global `HeadlineMath` + CommonJS) so the two most consequential
 * app-layer formulas are unit-testable in Node:
 * scripts/test-headline-math.js runs as part of `npm test`.
 *
 * app.js keeps thin wrappers that inject the live `workload` and
 * `window.Prices` — all existing call sites (preview, sensitivity,
 * model compare, budget solver, preset compare) are unchanged.
 *
 * Load order: BEFORE app.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();           // Node (unit tests)
  } else {
    root.HeadlineMath = factory();        // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Agent engineering — design-phase roles × FTE × duration, amortized
   * over deployment lifetime; plus periodic re-spec maintenance.
   *
   *   upfront             = Σ fte_i × (annual_base_i × comp_mult_i) × (dur/12)
   *                         + helper_monthly × dur
   *   amortized_monthly   = upfront / amortization_months   (floor 1)
   *   maintenance_monthly = lead_loaded_hourly × hours_per_session / interval
   *     where lead_loaded_hourly = annual_base × comp_mult / 2080 (40h × 52wk)
   *
   * Fail-loud policy mirrors scripts/calc.js: if personnelPrices doesn't
   * define agent_design_lead, surface a console.error and zero the
   * maintenance line rather than silently masking the gap with a
   * hardcoded fallback that can drift away from prices.js.
   *
   * @param {object|null} ae               workload.agent_engineering block
   * @param {object|null} personnelPrices  Prices.personnel map (role → {annual_base, total_comp_multiplier, ...})
   */
  function computeAgentEngineering(ae, personnelPrices) {
    ae = ae || {};
    if (!ae.enabled) return { enabled: false, upfront: 0, amortized_monthly: 0, maintenance_monthly: 0, monthly: 0 };
    const prices = personnelPrices || {};
    const dur   = Math.max(0, Number(ae.duration_months) || 0);
    const amort = Math.max(1, Number(ae.amortization_months) || 36);
    const helper = Math.max(0, Number(ae.helper_agent_monthly) || 0);
    const roles = Array.isArray(ae.roles) ? ae.roles : [];
    let upfront = 0;
    roles.forEach(r => {
      const def = prices[r.role] || {};
      const loaded = (def.annual_base || 0) * (def.total_comp_multiplier || 1);
      upfront += (Number(r.fte) || 0) * loaded * (dur / 12);
    });
    upfront += helper * dur;
    const amortized_monthly = upfront / amort;
    // Maintenance: design-lead loaded hourly × hours per session ÷ months between sessions.
    const lead = prices.agent_design_lead || null;
    let maintenance_monthly = 0;
    if (lead && lead.annual_base) {
      const leadLoadedAnnual = lead.annual_base * (lead.total_comp_multiplier || 1);
      const leadHourly = leadLoadedAnnual / 2080;  // 40hr × 52wk
      const interval = Math.max(1, Number(ae.maintenance_interval_months) || 6);
      const hoursPerSession = Math.max(0, Number(ae.maintenance_hours_per_session) || 0);
      maintenance_monthly = (leadHourly * hoursPerSession) / interval;
    } else {
      console.error('prices.js: personnel.agent_design_lead is missing — maintenance line zeroed. Update lib/prices.js to define annual_base + total_comp_multiplier for this role.');
    }
    return {
      enabled: true,
      upfront,
      amortized_monthly,
      maintenance_monthly,
      monthly: amortized_monthly + maintenance_monthly,
    };
  }

  /**
   * Single source of truth for the headline composition. Every panel
   * that displays a $/month total routes through this so they can't
   * drift — a recurring bug source where one panel applied
   * retry-inflate and another didn't.
   *
   * LLM line selection (first match wins):
   *   hybrid  → r.hybrid.total
   *   self    → r.self_host.total
   *   onprem  → workload.on_prem_monthly
   *   reservation enabled → r.reservation.effective_monthly
   *   else    → API bill (engine's monthly_with_retry when present;
   *             manual × retryInflate fallback for older payloads)
   *
   *   headline = llm + fixed + verification + tool fees + federal
   *            + embeddings + personnel + agent engineering
   *
   * @param {object} r            engine result
   * @param {object} w            workload (only on_prem_monthly is read)
   * @param {object} opts         { hosting: 'api'|'self'|'hybrid'|'onprem', ... }
   * @param {number} retryInflate fallback multiplier (see derivation-trace.js)
   * @param {number} aeMonthly    agent-engineering monthly (0 when disabled)
   */
  function composeHeadline(r, w, opts, retryInflate, aeMonthly) {
    // Eq. 5 (1 + 1.5r) retry inflate is now applied inside the engine
    // (api.monthly_with_retry). We keep the retryInflate arg for migration
    // phase callers and fall back to a manual multiplication only when the
    // engine didn't compute monthly_with_retry (older callers/payloads).
    const apiBill = r.api?.monthly_with_retry != null
      ? r.api.monthly_with_retry
      : (r.api?.monthly_capped || 0) * (retryInflate == null ? 1 : retryInflate);
    const fixed = r.fixed_costs?.total || 0;
    const verif = r.verification?.monthly || 0;
    // External tool fees (per-call / per-session provider charges for the
    // agents' enabled_tools) are an engine line — r.tool_fees — so
    // calc.js, the Excel export and the bench all bill them identically.
    const toolFees = r.tool_fees?.monthly || 0;
    const fed = r.federal?.additive_total || 0;
    const emb = (r.embedding?.enabled ? r.embedding.monthly : 0) || 0;
    const pers = (r.personnel?.enabled ? r.personnel.monthly : 0) || 0;
    const ae = Number(aeMonthly) || 0;
    let llm;
    if (opts.hosting === 'hybrid' && r.hybrid) llm = r.hybrid.total;
    else if (opts.hosting === 'self') llm = r.self_host?.total || 0;
    else if (opts.hosting === 'onprem') llm = parseFloat(w.on_prem_monthly) || 0;
    else if (r.reservation?.enabled) llm = r.reservation.effective_monthly;
    else llm = apiBill;
    const headline = llm + fixed + verif + toolFees + fed + emb + pers + ae;
    return { headline, llm, apiBill, fixed, verif, toolFees, fed, emb, pers, ae };
  }

  return { computeAgentEngineering, composeHeadline };
});
