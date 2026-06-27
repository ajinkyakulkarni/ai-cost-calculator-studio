/* engine-bridge.mjs — the ONLY place that calls the cost engine.
 * Reuses the canonical browser modules so MCP numbers equal the live site:
 *   - cost-engine.js   → CostEngine.compute(workload, opts)
 *   - headline-math.js → composeHeadline / computeAgentEngineering (the site rollup)
 *   - build-opts.js    → the exact opts the bench/parity tooling uses
 *
 * Signature notes (verified 2026-06-27):
 *   computeAgentEngineering(ae, personnelPrices)
 *     ae             = workload.agent_engineering block (first arg)
 *     personnelPrices = Prices.personnel map (second arg, role → {annual_base, ...})
 *   composeHeadline(r, w, opts, retryInflate, aeMonthly)
 *     returns { headline, llm, apiBill, fixed, verif, toolFees, fed, emb, pers, ae }
 *   Prices exports a single object; personnel is at Prices.personnel (not personnel_roles).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const CostEngine   = require('../../public/lib/cost-engine.js');
const HeadlineMath = require('../../public/lib/headline-math.js');
const { buildOpts } = require('../../public/lib/build-opts.js');
const Prices        = require('../../public/lib/prices.js');

export function computeWorkload(workload) {
  const opts   = buildOpts(workload);
  const result = CostEngine.compute(workload, opts);
  const ae     = HeadlineMath.computeAgentEngineering(
    workload.agent_engineering || { enabled: false },
    (Prices.personnel) || {}
  );
  const composed = HeadlineMath.composeHeadline(
    result, workload, opts, 1, ae.enabled ? ae.monthly : 0
  );
  const perQuery = result.api && result.api.per_query_blended != null
    ? result.api.per_query_blended : null;
  return {
    opts, result, composed,
    headline: composed.headline,
    perQuery,
    derivation: result.derivation || '',
  };
}
