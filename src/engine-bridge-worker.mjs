/* engine-bridge-worker.mjs — Workers-compatible engine bridge.
 *
 * Replaces createRequire (Node-only) with direct ESM-compatible imports of
 * the UMD files. esbuild resolves the UMD CJS branch statically at bundle
 * time under the workers format, so module.exports assignments are inlined.
 *
 * Single source of truth: identical math as engine-bridge.mjs (stdio) and
 * the browser site — only the import mechanism differs.
 */

// esbuild handles UMD/CJS interop when bundling for Workers
import CostEngine   from '../public/lib/cost-engine.js';
import HeadlineMath from '../public/lib/headline-math.js';
import BuildOpts    from '../public/lib/build-opts.js';
import Prices       from '../public/lib/prices.js';

export function computeWorkload(workload) {
  const opts   = BuildOpts.buildOpts(workload);
  const result = CostEngine.compute(workload, opts);
  const ae     = HeadlineMath.computeAgentEngineering(
    workload.agent_engineering || { enabled: false },
    (Prices.personnel) || {},
  );
  const composed = HeadlineMath.composeHeadline(
    result, workload, opts, 1, ae.enabled ? ae.monthly : 0,
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
