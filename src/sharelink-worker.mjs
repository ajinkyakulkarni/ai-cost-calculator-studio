/* sharelink-worker.mjs — Workers-compatible share link builder.
 *
 * Replaces createRequire with a direct ESM import of the UMD file.
 * API is identical to mcp/lib/sharelink.mjs.
 */

import WorkloadHash from '../public/lib/workload-hash.js';

const BASE = 'https://calc.ajinkya.ai/';

export function shareLink(workload) {
  const encoded = WorkloadHash.encodePayload({ workload, ui: {} });
  return BASE + WorkloadHash.buildHashString(encoded, 'advanced');
}
