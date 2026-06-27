/* sharelink.mjs — build a calc.ajinkya.ai share URL. Reuses the canonical
 * WorkloadHash codec so it can never drift from what the site decodes. The
 * site payload is { workload, ui }; the agent has no slider UI state, so ui is
 * empty and the calc falls back to the workload's own values. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WorkloadHash = require('../../public/lib/workload-hash.js');

const BASE = 'https://calc.ajinkya.ai/';

export function shareLink(workload) {
  const encoded = WorkloadHash.encodePayload({ workload, ui: {} });
  return BASE + WorkloadHash.buildHashString(encoded, 'advanced');
}
