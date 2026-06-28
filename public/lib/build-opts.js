/* build-opts.js — canonical buildOpts() for the cost engine.
 *
 * Single source of truth for the opts shape passed to CostEngine.compute().
 * Shared by scripts/dump-engine.mjs, scripts/bench-validate.mjs, and the
 * MCP server so all three use identical logic.
 *
 * Dual-exported (CommonJS + browser global `BuildOpts`).
 * Load order: BEFORE any script that calls CostEngine.compute(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();           // Node (scripts / MCP server)
  } else {
    root.BuildOpts = factory();           // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function buildOpts(w) {
    const d = w.defaults || {};
    return {
      hosting:       d.hosting       || 'api',
      model:         d.model         || 'gpt-5.2',
      tier:          d.tier          || 'standard',
      mix:           d.mix           || 'mixed',
      costMode:      d.cost_mode     || 'realistic',
      botFactor:     1.5,
      cacheRate:     (w.anchor_query && w.anchor_query.cache_rate_baseline != null)
                       ? w.anchor_query.cache_rate_baseline : 0.7,
      verifCoverage: (w.verification && w.verification.coverage) || 0,
      retry_rate:    (w.anchor_query && w.anchor_query.retry_rate != null)
                       ? w.anchor_query.retry_rate : 0,
    };
  }

  return { buildOpts };
});
