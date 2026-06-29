/* validate.mjs — classify a workload without computing. Returns the missing
 * required inputs (with suggestions) and the suggestible defaults that would
 * be assumed. No cost numbers here. */
import { REQUIRED, CONDITIONAL, SUGGESTIBLE } from './workload-schema.mjs';

export function validateWorkload(workload) {
  const w = workload || {};
  const missing_required = [];
  for (const r of REQUIRED) {
    if (!r.present(w)) {
      missing_required.push({ field: r.field, why: r.why, suggested_value: r.suggested_value, rationale: r.rationale });
    }
  }
  for (const c of CONDITIONAL) {
    if (c.applies(w) && !c.present(w)) {
      missing_required.push({ field: c.field, why: c.why });
    }
  }
  const assumptions = [];
  for (const s of SUGGESTIBLE) {
    const v = s.get(w);
    assumptions.push(v == null
      ? { field: s.field, value: s.default, source: s.source }
      : { field: s.field, value: v, source: 'user' });
  }
  return { ok: missing_required.length === 0, missing_required, assumptions };
}
