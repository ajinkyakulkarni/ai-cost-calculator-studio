/* presets-worker.mjs — Workers-compatible preset loader.
 *
 * Replaces presets.mjs's fs.readdirSync approach with static JSON imports
 * that esbuild inlines at bundle time. The API is identical (listPresets /
 * loadPreset) so the Worker entry can swap this module in place of
 * presets.mjs without touching any tool logic.
 *
 * Single source of truth: same JSON files as public/examples/*.json.
 */

import archetypeAgentDemo              from '../public/examples/archetype-agent-demo.json';
import customerSupportFleet            from '../public/examples/customer-support-fleet.json';
import doeGridModeling                 from '../public/examples/doe-grid-modeling.json';
import financeComplianceQa             from '../public/examples/finance-compliance-qa.json';
import genericStartupChatbot           from '../public/examples/generic-startup-chatbot.json';
import healthPatientQa                 from '../public/examples/health-patient-qa.json';
import legalDiscoveryAgent             from '../public/examples/legal-discovery-agent.json';
import legalTechRag                    from '../public/examples/legal-tech-rag.json';
import mcpResearchFleet                from '../public/examples/mcp-research-fleet.json';
import nihClinicalTrials               from '../public/examples/nih-clinical-trials.json';
import noaaStormTracking               from '../public/examples/noaa-storm-tracking.json';
import publicGeospatialQaFreeformMulti from '../public/examples/public-geospatial-qa-freeform-multi-segment.json';
import publicGeospatialQaFreeform      from '../public/examples/public-geospatial-qa-freeform.json';
import publicGeospatialQaMulti         from '../public/examples/public-geospatial-qa-multi-segment.json';
import publicGeospatialQa              from '../public/examples/public-geospatial-qa.json';
import saasWebsiteBuilder              from '../public/examples/saas-website-builder.json';
import sweBenchCodingAgent             from '../public/examples/swe-bench-coding-agent.json';
import voiceSupportAgent               from '../public/examples/voice-support-agent.json';

// Indexed by name (filename without .json) for O(1) lookup
const PRESET_MAP = {
  'archetype-agent-demo':                         archetypeAgentDemo,
  'customer-support-fleet':                        customerSupportFleet,
  'doe-grid-modeling':                             doeGridModeling,
  'finance-compliance-qa':                         financeComplianceQa,
  'generic-startup-chatbot':                       genericStartupChatbot,
  'health-patient-qa':                             healthPatientQa,
  'legal-discovery-agent':                         legalDiscoveryAgent,
  'legal-tech-rag':                                legalTechRag,
  'mcp-research-fleet':                            mcpResearchFleet,
  'nih-clinical-trials':                           nihClinicalTrials,
  'noaa-storm-tracking':                           noaaStormTracking,
  'public-geospatial-qa-freeform-multi-segment':  publicGeospatialQaFreeformMulti,
  'public-geospatial-qa-freeform':                publicGeospatialQaFreeform,
  'public-geospatial-qa-multi-segment':           publicGeospatialQaMulti,
  'public-geospatial-qa':                          publicGeospatialQa,
  'saas-website-builder':                          saasWebsiteBuilder,
  'swe-bench-coding-agent':                        sweBenchCodingAgent,
  'voice-support-agent':                           voiceSupportAgent,
};

export function listPresets() {
  return Object.entries(PRESET_MAP).map(([name, w]) => {
    const dep = w.deployment || {};
    return { name, title: dep.name || name, one_line: dep.description || '' };
  });
}

export function loadPreset(name) {
  const key = String(name).replace(/[^a-z0-9-]/gi, '');
  const w = PRESET_MAP[key];
  if (!w) throw new Error(`unknown preset: ${name}`);
  return w;
}
