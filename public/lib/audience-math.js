/* audience-math.js — pure formulas for the audience block.
 *
 * No DOM, no globals, no side effects. Dual-exported (browser global
 * `AudienceMath` + CommonJS) so the same formulas the UI uses are
 * unit-testable in Node: scripts/test-audience-math.js runs as part
 * of `npm test`.
 *
 * The audience model: workload.segments[] is the engine's only
 * audience source of truth. Each segment carries
 *   { mau, sessions_per_day, questions_per_session, applyBotFactor }
 * and the aggregate the rest of the calculator sees is:
 *   total MAU            = Σ mau_i
 *   sessions/day (agg)   = Σ (mau_i · sess_i) / Σ mau_i   (MAU-weighted mean)
 *   questions/sess (agg) = Σ (mau_i · q_i)   / Σ mau_i    (MAU-weighted mean)
 *
 * MAU-weighting matters: 10,000 public visitors at 0.2 sess/day and
 * 100 analysts at 3 sess/day must NOT average to 1.6 — the correct
 * aggregate is dominated by the big segment (≈0.228). A plain mean
 * here would silently misprice the whole bill.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();           // Node (unit tests)
  } else {
    root.AudienceMath = factory();        // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Coerce a segment field to a non-negative finite number. */
  function num(x) {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Aggregate an array of audience segments.
   *
   * @param {Array<{mau:any, sessions_per_day:any, questions_per_session:any}>} segments
   * @returns {{
   *   mau: number,                        // Σ mau_i
   *   weightedSessionsPerDay: number,     // MAU-weighted mean, 0 when Σ mau = 0
   *   weightedQuestionsPerSession: number // MAU-weighted mean, 0 when Σ mau = 0
   * }}
   */
  function computeAudienceAggregates(segments) {
    const segs = Array.isArray(segments) ? segments : [];
    let mau = 0, sessW = 0, qW = 0;
    for (const seg of segs) {
      const m = num(seg && seg.mau);
      mau   += m;
      sessW += m * num(seg && seg.sessions_per_day);
      qW    += m * num(seg && seg.questions_per_session);
    }
    return {
      mau,
      weightedSessionsPerDay:      mau > 0 ? sessW / mau : 0,
      weightedQuestionsPerSession: mau > 0 ? qW    / mau : 0,
    };
  }

  /**
   * Clamp the aggregate into the value ranges of the three legacy
   * slider inputs (#s-users / #s-sessions / #s-turns) that the rest
   * of the calculator polls. Keeping the clamp rules here (instead of
   * inline in the DOM layer) makes them testable:
   *   users    — integer, ≥1, ≤ maxMau (slider max attribute)
   *   sessions — ≥0.01, rounded to 2 dp (slider step)
   *   turns    — integer, ≥1
   *
   * @param {{mau:number, weightedSessionsPerDay:number, weightedQuestionsPerSession:number}} agg
   * @param {number} [maxMau=500000]
   * @returns {{users:number, sessions:number, turns:number}}
   */
  function mirrorValues(agg, maxMau) {
    const cap = Number.isFinite(Number(maxMau)) && Number(maxMau) > 0
      ? Number(maxMau) : 500000;
    return {
      users:    Math.min(cap, Math.max(1, Math.round(num(agg && agg.mau)))),
      sessions: Math.max(0.01, Number(num(agg && agg.weightedSessionsPerDay).toFixed(2))),
      turns:    Math.max(1, Math.round(num(agg && agg.weightedQuestionsPerSession))),
    };
  }

  return { computeAudienceAggregates, mirrorValues };
});
