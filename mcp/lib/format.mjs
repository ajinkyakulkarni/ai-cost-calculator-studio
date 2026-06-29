/* format.mjs — shape a computed workload into the compute_cost success object.
 * Assumes the caller already passed the hard gate. */
import { computeWorkload } from './engine-bridge.mjs';
import { validateWorkload } from './validate.mjs';
import { shareLink } from './sharelink.mjs';

export function formatResult(workload) {
  const { result, composed, headline, perQuery, derivation } = computeWorkload(workload);
  const { assumptions } = validateWorkload(workload);

  const warnings = [];
  if (result.api && result.api.monthly_gross > result.api.monthly_capped + 1) {
    warnings.push(`Daily cap clamps the LLM bill (gross $${Math.round(result.api.monthly_gross).toLocaleString()} → capped $${Math.round(result.api.monthly_capped).toLocaleString()}/mo).`);
  }
  if (Array.isArray(workload.agents) && workload.agents.some(a => a._source && /derived/i.test(a._source))) {
    warnings.push('One or more agent token profiles are DERIVED, not measured.');
  }

  return {
    headline_monthly_usd: Math.round(headline),
    per_query_usd: perQuery,
    breakdown: {
      llm: composed.llm, fixed: composed.fixed, verification: composed.verif,
      tool_fees: composed.toolFees, federal: composed.fed, embedding: composed.emb,
      personnel: composed.pers, agent_engineering: composed.ae,
    },
    assumptions,
    warnings,
    derivation_trace: derivation,
    share_link: shareLink(workload),
  };
}
