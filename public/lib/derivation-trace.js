/* derivation-trace.js — the app-layer appendix of the derivation trace.
 *
 * Extracted from app.js renderPreview (2026-06-10 modularization pass).
 * PURE: no DOM, no globals — takes an explicit context object and
 * returns the appendix string that gets concatenated onto the engine's
 * deriveTrace() output. Dual-exported (browser global `DerivationTrace`
 * + CommonJS) so the formatting and the retry-inflation formula are
 * unit-testable in Node: scripts/test-derivation-trace.js runs as part
 * of `npm test`.
 *
 * The engine's trace covers queries → per-query → LLM → federal →
 * fixed → embeddings → personnel → grand total. This appendix adds the
 * three app-layer adjustments on top, so the combined trace is fully
 * self-contained for paste-into-any-AI verification:
 *   A) workload → engine inputs (per-turn token derivation)
 *   B) retry inflation (the app-layer multiplier on the API bill)
 *   C) agent engineering (upfront amortization + maintenance)
 *   D) final headline roll-up (must match the cost pill)
 *
 * Load order: BEFORE app.js (no dependencies of its own). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();              // Node (unit tests)
  } else {
    root.DerivationTrace = factory();        // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The app-layer retry multiplier on the API bill.
   *   factor = 1 + retry_rate × 1.5
   * The 1.5 accounts for partial output already generated before the
   * retry trips (you pay for the aborted attempt's tokens too). This is
   * THE single source of the formula — app.js renderPreview calls this,
   * and section B below prints the same expression.
   */
  function retryInflateFactor(retryRate) {
    const r = Number(retryRate);
    const rate = Number.isFinite(r) && r > 0 ? r : 0;
    return 1 + rate * 1.5;
  }

  /**
   * Build the A–D appendix string.
   *
   * @param {object} ctx
   * @param {number|null} ctx.axTotalIn   session-total input tokens from the per-agent build-up (null = not active)
   * @param {number|null} ctx.axTotalOut  session-total output tokens (optional)
   * @param {number|null} ctx.axTurns     turns the session totals divide across
   * @param {number} ctx.retryRate        0..1
   * @param {number} ctx.retryInflate     output of retryInflateFactor(retryRate)
   * @param {number} ctx.apiBillBefore    API bill before retry inflation
   * @param {number} ctx.apiBill          API bill after retry inflation
   * @param {object|null} ctx.agentEngineering  workload.agent_engineering (or null)
   * @param {number} ctx.agentEngMonthly  monthly agent-engineering total
   * @param {string} ctx.hosting          'api' | 'self' | 'hybrid' | 'onprem'
   * @param {number} ctx.llmHeadline      LLM line in the final roll-up
   * @param {number} ctx.verifMonthly
   * @param {number} ctx.embeddingMonthly
   * @param {number} ctx.personnelMonthly
   * @param {number} ctx.federalAdditive
   * @param {number} ctx.fixedCosts
   * @param {number} ctx.headlineTotal    the headline the cost pill shows
   * @returns {string} appendix (starts with a newline, ready to concat)
   */
  function buildAppendix(ctx) {
    const sep = '──────────────────────────────────────────────────\n';
    const fmtN = (n) => Math.round(n).toLocaleString();
    const $f = (n) => '$' + fmtN(n);
    const lines = [];
    lines.push('');
    lines.push(sep);
    lines.push('A) WORKLOAD → ENGINE INPUTS (per-turn token counts from your settings)');
    lines.push(sep);
    if (ctx.axTotalIn != null && ctx.axTurns != null) {
      const perTurn = Math.round(ctx.axTotalIn / ctx.axTurns);
      lines.push(`Session-total input from your workload: ${fmtN(ctx.axTotalIn)} tok across ${ctx.axTurns} turns`);
      lines.push(`  → anchor_query.input_tokens = ${fmtN(ctx.axTotalIn)} / ${ctx.axTurns} = ${fmtN(perTurn)} tok/query (used in section 3 above)`);
      if (ctx.axTotalOut != null) {
        const perTurnOut = Math.round(ctx.axTotalOut / ctx.axTurns);
        lines.push(`Session-total output from your workload: ${fmtN(ctx.axTotalOut)} tok across ${ctx.axTurns} turns`);
        lines.push(`  → anchor_query.output_tokens = ${fmtN(ctx.axTotalOut)} / ${ctx.axTurns} = ${fmtN(perTurnOut)} tok/query`);
      }
      lines.push(`(Per-agent loop sums sysprompt + inter-agent messages + tool schema/result + RAG + reasoning + guardrails + comm-pattern overhead × turns × agent count.)`);
    } else {
      lines.push('Per-agent token build-up not active this render — anchor_query.input_tokens used as-is.');
    }
    lines.push('');

    lines.push(sep);
    lines.push('B) RETRY INFLATION (multiplier on API bill)');
    lines.push(sep);
    lines.push(`Retry rate (s-retry): ${(ctx.retryRate * 100).toFixed(1)}%`);
    lines.push(`Inflate factor: 1 + retry_rate × 1.5 = 1 + ${ctx.retryRate.toFixed(3)} × 1.5 = ${ctx.retryInflate.toFixed(4)}`);
    lines.push(`(1.5 accounts for partial output already generated before the retry trips.)`);
    lines.push(`API bill before retry: ${$f(ctx.apiBillBefore)}`);
    lines.push(`API bill after retry:  ${$f(ctx.apiBill)} (= ${$f(ctx.apiBillBefore)} × ${ctx.retryInflate.toFixed(4)})`);
    lines.push('');

    if (ctx.agentEngineering && ctx.agentEngineering.enabled && ctx.agentEngMonthly > 0) {
      lines.push(sep);
      lines.push('C) AGENT ENGINEERING (upfront design + maintenance amortization)');
      lines.push(sep);
      const ae = ctx.agentEngineering;
      if (ae.upfront_total != null) {
        lines.push(`Upfront design effort: ${$f(ae.upfront_total)} total, amortized over ${ae.amortization_months} months = ${$f(ae.upfront_monthly || 0)}/mo`);
      }
      if (ae.maintenance_monthly != null && ae.maintenance_monthly > 0) {
        lines.push(`Recurring maintenance: ${$f(ae.maintenance_monthly)}/mo`);
      }
      if (ae.helper_monthly != null && ae.helper_monthly > 0) {
        lines.push(`Helper agent (autonomous): ${$f(ae.helper_monthly)}/mo`);
      }
      lines.push(`TOTAL agent engineering: ${$f(ctx.agentEngMonthly)}/mo`);
      lines.push('');
    }

    lines.push(sep);
    lines.push('D) FINAL HEADLINE (after retry + engineering + additive adjustments)');
    lines.push(sep);
    lines.push(`  ${ctx.hosting === 'self' ? 'Self-host LLM' : ctx.hosting === 'hybrid' ? 'Hybrid LLM' : ctx.hosting === 'onprem' ? 'On-prem (amortized)' : 'API LLM × retry-inflate'}: ${$f(ctx.llmHeadline)}`);
    if (ctx.verifMonthly > 0)     lines.push(`+ Verification:        ${$f(ctx.verifMonthly)}`);
    if (ctx.embeddingMonthly > 0) lines.push(`+ Embeddings:          ${$f(ctx.embeddingMonthly)}`);
    if (ctx.personnelMonthly > 0) lines.push(`+ Personnel:           ${$f(ctx.personnelMonthly)}`);
    if (ctx.agentEngMonthly > 0)  lines.push(`+ Agent engineering:   ${$f(ctx.agentEngMonthly)}`);
    if (ctx.federalAdditive > 0)  lines.push(`+ Federal additive:    ${$f(ctx.federalAdditive)}`);
    if (ctx.fixedCosts > 0)       lines.push(`+ Fixed monthly:       ${$f(ctx.fixedCosts)}`);
    lines.push(`= ${$f(ctx.headlineTotal)}/mo  →  ${$f(ctx.headlineTotal * 12)}/yr  →  ${$f(ctx.headlineTotal * 36)}/3yr TCO`);
    lines.push('');
    lines.push('(Cross-check: this should match the headline number rendered at the top of the calculator.)');

    return lines.join('\n');
  }

  return { retryInflateFactor, buildAppendix };
});
