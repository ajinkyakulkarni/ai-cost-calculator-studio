/* compute.mjs — the hard gate. No cost numbers escape unless every required
 * input is present. */
import { validateWorkload } from './validate.mjs';
import { formatResult } from './format.mjs';

export function computeCost(workload) {
  const v = validateWorkload(workload);
  if (!v.ok) {
    return {
      error: 'missing_required',
      message: 'Cannot compute a cost until these inputs are provided (propose values and confirm with the user, then retry).',
      missing_required: v.missing_required,
    };
  }
  return formatResult(workload);
}
