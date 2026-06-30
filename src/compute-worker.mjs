/* compute-worker.mjs — Workers-compatible compute gate.
 *
 * Identical logic to mcp/lib/compute.mjs; uses format-worker.mjs instead
 * of format.mjs so the Workers bundle gets the correct engine bridge.
 */

import { validateWorkload } from '../mcp/lib/validate.mjs';
import { formatResult }     from './format-worker.mjs';

export function computeCost(workload) {
  const v = validateWorkload(workload);
  if (!v.ok) {
    return {
      error: 'missing_required',
      message:
        'Cannot compute a cost until these inputs are provided (propose values and confirm with the user, then retry).',
      missing_required: v.missing_required,
    };
  }
  return formatResult(workload);
}
