/* workload-hash.js — the share-link codec.
 *
 * Extracted from app.js (2026-06-10 modularization pass). PURE: no DOM,
 * no globals — just the encode/decode/classify pipeline for the URL
 * hash. Dual-exported (browser global `WorkloadHash` + CommonJS) so the
 * exact codec the app uses is unit-testable in Node:
 * scripts/test-workload-hash.js runs as part of `npm test`.
 *
 * The DOM glue (captureUiState / restoreUiState / scheduleHashUpdate /
 * loadFromHash) stays in app.js — those functions read sliders and
 * mutate `workload`; only the string transformation lives here.
 *
 * Encoded shape: '#w=' + base64(encodeURIComponent(JSON({workload,ui})))
 *                + '&mode=basic|advanced' (optional)
 * The encodeURIComponent step matters: btoa() throws on characters
 * outside Latin-1, and workload descriptions carry ×, →, é, emoji, etc.
 *
 * Load order: BEFORE app.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();           // Node (unit tests)
  } else {
    root.WorkloadHash = factory();        // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Node lacks btoa/atob on older versions; Buffer is the canonical shim.
  const _btoa = typeof btoa === 'function'
    ? btoa
    : (s) => Buffer.from(s, 'binary').toString('base64');
  const _atob = typeof atob === 'function'
    ? atob
    : (s) => Buffer.from(s, 'base64').toString('binary');

  /** payload object → base64 string (the value of the w= param). */
  function encodePayload(payload) {
    return _btoa(encodeURIComponent(JSON.stringify(payload)));
  }

  /**
   * Full location.hash (or any string containing w=...) → parsed object,
   * or null when absent/corrupt. Never throws.
   */
  function decodeHash(hashStr) {
    try {
      const m = String(hashStr || '').match(/w=([^&]+)/);
      if (!m) return null;
      return JSON.parse(decodeURIComponent(_atob(m[1])));
    } catch (_) {
      return null;
    }
  }

  /**
   * Classify a decoded payload into the two accepted shapes.
   *   wrapped — { workload: {...}, ui: {...} }   (current format)
   *   legacy  — unwrapped workload at the top level (old share links)
   * Validity check matches app.js loadFromHash: a workload must carry
   * both `deployment` and `shapes`.
   *
   * @returns {{kind:'wrapped'|'legacy'|'invalid', workload:object|null, ui:object|null}}
   */
  function classifyPayload(parsed) {
    if (parsed && parsed.workload && parsed.workload.deployment && parsed.workload.shapes) {
      return { kind: 'wrapped', workload: parsed.workload, ui: parsed.ui || null };
    }
    if (parsed && parsed.deployment && parsed.shapes) {
      return { kind: 'legacy', workload: parsed, ui: null };
    }
    return { kind: 'invalid', workload: null, ui: null };
  }

  /**
   * Assemble the canonical hash string. mode is appended only when it is
   * exactly 'basic' or 'advanced' — anything else is dropped, so a junk
   * body-class state can never poison the share link.
   */
  function buildHashString(encoded, mode) {
    const suffix = (mode === 'basic' || mode === 'advanced') ? '&mode=' + mode : '';
    return '#w=' + encoded + suffix;
  }

  return { encodePayload, decodeHash, classifyPayload, buildHashString };
});
