/* ===========================================================================
 * cost-simulator v9.6 — Multi-Agent Token Simulator
 *
 * Extracted from public/index.html on 2026-05-11 to keep index.html
 * navigable (was 8500+ lines, now ~6600 after this split). No behavior
 * change — just a script-source extraction. All globals (sim, AGENT_DEF,
 * MODELS, computeCost, setMode, setTheme, onSlider, …) remain attached
 * to the page's window scope exactly as before; the bridge in app.js
 * and the inline script blocks below this load order still see them.
 *
 * Source map: previously lived between lines 5669–7619 of public/index.html.
 * ===========================================================================
 */

/* ═══════ BPE TOKEN COUNTER ═══════ */
const BG=new Set(['th','he','in','er','an','re','on','en','at','es','ed','is','it','al','ar','st','to','nt','ng','or','ha','as','hi','ou','te','of','nd','se','le','sa','si','ve','wh','ch','ll','be','me','ri','li','ca','ne','la','ma','ro','co','de','io','ia','ti','fi','pr','fo','pl','sp','tr','gr','br','fr','dr','cl','cr','sl','sm','sw','tw','qu','ph','ck','sh','oo','ee','ai','ea']);
function tok(t){if(!t)return 0;const w=(t.match(/\S+/g)||[]);let c=0;for(const wd of w){const s=wd.toLowerCase().replace(/[^a-z0-9]/g,'');if(!s.length){c++;continue}if(s.length<=3){c++;continue}if(s.length<=6){c+=Math.ceil(s.length/3.5);continue}let sub=1,i=0;while(i<s.length-1){if(!BG.has(s[i]+s[i+1]))sub++;i+=2;}c+=Math.max(1,Math.round(sub*.75+s.length*.15));}c+=Math.ceil(((t.match(/[.,!?;:'"()\[\]{}\-\/\\@#$%^&*+=|<>~`]/g)||[]).length)*.6);c+=(t.match(/\n/g)||[]).length;return Math.max(1,c);}

/* ═══════ LOGNORMAL CI ═══════ */
const TASK_CV={classify:.18,summary:.28,rag:.35,code:.62,longform:.68,agent:.75};
function wCV(){const t=TASK_TYPES.reduce((s,x)=>s+x.pct,0)||1;return TASK_TYPES.reduce((s,x)=>s+(x.pct/t)*TASK_CV[x.id],0);}
function lnPct(v,z){const cv=wCV();const sig=Math.sqrt(Math.log(1+cv*cv));const mu=Math.log(Math.max(v,1e-10))-sig*sig/2;return Math.exp(mu+z*sig);}
const p90=v=>lnPct(v,1.282);const p99=v=>lnPct(v,2.326);const p50=v=>lnPct(v,0);

/* ═══════ MODELS ═══════ */
const MODEL_PRICE_VERIFIED='2026-05-04';
const PRICING_SOURCES={
  anthropic_api_pricing:'https://platform.claude.com/docs/en/about-claude/pricing',
  openai_api_pricing:'https://developers.openai.com/api/docs/pricing',
  gemini_api_pricing:'https://ai.google.dev/gemini-api/docs/pricing',
  together_api_pricing:'https://www.together.ai/pricing'
};
const EMBEDDING_MODEL='text-embedding-3-small';
const EMBEDDING_RATE=0.02; // USD per 1M embedding input tokens
// Per-provider tool fee schedules (USD).
// webSearchPer1k: $/1000 search queries
// fileSearchPer1k: $/1000 file-search retrieval calls
// container1GBSession: $/code-interpreter container session
// Notes: Anthropic charges $10/1k for the web_search tool, no file-search billing, code-execution beta currently free.
// OpenAI Assistants API: $10/1k web search, $2.50/1k file search, $0.03/container session.
// Google Vertex Search Grounding: $35/1k queries; no separate file-search; code-exec bundled.
// Bedrock/Azure pass-through: no separate fees, model price already includes provider markup.
// BYOK: pay underlying provider directly — defaults to managed-api fee table for the matching family.
// Self-hosted: zero tool fees (you run them yourself).
const TOOL_FEES = {
  managed_anthropic: {webSearchPer1k:10.00, fileSearchPer1k:0.00,  container1GBSession:0.00, note:'Anthropic web search $10/1k; code exec beta free; no file search billing.'},
  managed_openai:    {webSearchPer1k:10.00, fileSearchPer1k:2.50,  container1GBSession:0.03, note:'OpenAI Assistants API published rates.'},
  managed_google:    {webSearchPer1k:35.00, fileSearchPer1k:0.00,  container1GBSession:0.00, note:'Vertex Search Grounding $35/1k; code exec bundled.'},
  managed_other:     {webSearchPer1k:0.00,  fileSearchPer1k:0.00,  container1GBSession:0.00, note:'No published tool-fee schedule; fees set to zero.'},
  bedrock:           {webSearchPer1k:0.00,  fileSearchPer1k:0.00,  container1GBSession:0.00, note:'Bedrock pass-through; tool fees folded into model markup.'},
  azure:             {webSearchPer1k:0.00,  fileSearchPer1k:0.00,  container1GBSession:0.00, note:'Azure OpenAI does not bill Assistants tool fees separately at this tier.'},
  openrouter:        {webSearchPer1k:0.00,  fileSearchPer1k:0.00,  container1GBSession:0.00, note:'OpenRouter aggregator; tool fees not exposed.'},
  byok:              {webSearchPer1k:10.00, fileSearchPer1k:2.50,  container1GBSession:0.03, note:'BYOK passes through to underlying provider (default: OpenAI-style schedule).'},
  'self-hosted':     {webSearchPer1k:0.00,  fileSearchPer1k:0.00,  container1GBSession:0.00, note:'Self-hosted: tools run on your infrastructure, zero per-call fees.'},
};
function toolFeeKey(provider, family){
  if(provider==='managed'){
    if(family==='anthropic') return 'managed_anthropic';
    if(family==='openai') return 'managed_openai';
    if(family==='google') return 'managed_google';
    return 'managed_other';
  }
  return provider; // bedrock, azure, openrouter, byok, self-hosted
}
function feesFor(provider, family){
  return TOOL_FEES[toolFeeKey(provider, family)] || TOOL_FEES.managed_other;
}
// Back-compat alias used by older display code paths
const TOOL_FEE_PRICES = TOOL_FEES.managed_openai;
const MODELS={
  'claude-opus-4.7':{label:'Claude Opus 4.7',api_id:'claude-opus-4-7',family:'anthropic',source:'anthropic_api_pricing',providerDefault:'managed',in:5.00,out:25.00,cacheRead:0.50,cacheWrite5m:6.25,cacheWrite1h:10.00,cacheWriteShare:.10,color:'#ce93d8',ctx:1000000,cd:.90,bd:.50,lat:4100,tps:30,status:'current'},
  'claude-sonnet-4.6':{label:'Claude Sonnet 4.6',api_id:'claude-sonnet-4-6',family:'anthropic',source:'anthropic_api_pricing',providerDefault:'managed',in:3.00,out:15.00,cacheRead:0.30,cacheWrite5m:3.75,cacheWrite1h:6.00,cacheWriteShare:.10,color:'#00d4ff',ctx:1000000,cd:.90,bd:.50,lat:1800,tps:65,status:'current'},
  'claude-haiku-4.5':{label:'Claude Haiku 4.5',api_id:'claude-haiku-4-5',family:'anthropic',source:'anthropic_api_pricing',providerDefault:'managed',in:1.00,out:5.00,cacheRead:0.10,cacheWrite5m:1.25,cacheWrite1h:2.00,cacheWriteShare:.10,color:'#00e676',ctx:200000,cd:.90,bd:.50,lat:700,tps:140,status:'current'},
  'gpt-5.5':{label:'GPT-5.5',api_id:'gpt-5.5',family:'openai',source:'openai_api_pricing',providerDefault:'managed',in:5.00,out:30.00,cacheRead:0.50,longThreshold:270000,longIn:10.00,longOut:45.00,longCacheRead:1.00,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#74aa9c',ctx:400000,cd:.90,bd:.50,lat:2300,tps:50,status:'current'},
  'gpt-5.5-pro':{label:'GPT-5.5 Pro',api_id:'gpt-5.5-pro',family:'openai',source:'openai_api_pricing',providerDefault:'managed',in:30.00,out:180.00,cacheRead:null,longThreshold:270000,longIn:60.00,longOut:270.00,longCacheRead:null,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#a1887f',ctx:400000,cd:0,bd:.50,lat:5200,tps:24,status:'current'},
  'gpt-5.4':{label:'GPT-5.4',api_id:'gpt-5.4',family:'openai',source:'openai_api_pricing',providerDefault:'managed',in:2.50,out:15.00,cacheRead:0.25,longThreshold:270000,longIn:5.00,longOut:22.50,longCacheRead:0.50,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#80cbc4',ctx:400000,cd:.90,bd:.50,lat:2000,tps:58,status:'current'},
  'gpt-5.4-mini':{label:'GPT-5.4 mini',api_id:'gpt-5.4-mini',family:'openai',source:'openai_api_pricing',providerDefault:'managed',in:0.75,out:4.50,cacheRead:0.075,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#4db6ac',ctx:200000,cd:.90,bd:.50,lat:900,tps:110,status:'current'},
  'gpt-5.4-nano':{label:'GPT-5.4 nano',api_id:'gpt-5.4-nano',family:'openai',source:'openai_api_pricing',providerDefault:'managed',in:0.20,out:1.25,cacheRead:0.02,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#26a69a',ctx:200000,cd:.90,bd:.50,lat:520,tps:180,status:'current'},
  'gpt-5.4-pro':{label:'GPT-5.4 Pro',api_id:'gpt-5.4-pro',family:'openai',source:'openai_api_pricing',providerDefault:'managed',in:30.00,out:180.00,cacheRead:null,longThreshold:270000,longIn:60.00,longOut:270.00,longCacheRead:null,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#8d6e63',ctx:400000,cd:0,bd:.50,lat:5000,tps:25,status:'current'},
  'gemini-3.1-pro-preview':{label:'Gemini 3.1 Pro Preview',api_id:'gemini-3.1-pro-preview',family:'google',source:'gemini_api_pricing',providerDefault:'managed',in:2.00,out:12.00,cacheRead:0.20,longThreshold:200000,longIn:4.00,longOut:18.00,longCacheRead:0.40,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,tiers:[{thresholdAt:0,label:'standard',in:2.00,out:12.00,cacheRead:0.20},{thresholdAt:200000,label:'long-context',in:4.00,out:18.00,cacheRead:0.40},{thresholdAt:1000000,label:'ultra-long',in:6.00,out:24.00,cacheRead:0.60}],color:'#3367d6',ctx:2000000,cd:.90,bd:.50,lat:2100,tps:70,status:'preview'},
  'gemini-3-flash-preview':{label:'Gemini 3 Flash Preview',api_id:'gemini-3-flash-preview',family:'google',source:'gemini_api_pricing',providerDefault:'managed',in:0.50,out:3.00,cacheRead:0.05,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#4285f4',ctx:1048576,cd:.90,bd:.50,lat:900,tps:120,status:'preview'},
  'gemini-3.1-flash-lite-preview':{label:'Gemini 3.1 Flash-Lite Preview',api_id:'gemini-3.1-flash-lite-preview',family:'google',source:'gemini_api_pricing',providerDefault:'managed',in:0.25,out:1.50,cacheRead:0.025,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#5e97f6',ctx:1048576,cd:.90,bd:.50,lat:650,tps:150,status:'preview'},
  'gemini-2.5-flash':{label:'Gemini 2.5 Flash',api_id:'gemini-2.5-flash',family:'google',source:'gemini_api_pricing',providerDefault:'managed',in:0.30,out:2.50,cacheRead:0.03,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#6fa8dc',ctx:1048576,cd:.90,bd:.50,lat:750,tps:135,status:'current'},
  'gemini-2.5-flash-lite':{label:'Gemini 2.5 Flash-Lite',api_id:'gemini-2.5-flash-lite',family:'google',source:'gemini_api_pricing',providerDefault:'managed',in:0.10,out:0.40,cacheRead:0.01,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#8ab4f8',ctx:1048576,cd:.90,bd:.50,lat:600,tps:160,status:'current'},
  'llama-3.3-70b-together':{label:'Llama 3.3 70B Turbo - Together',api_id:'meta-llama/Llama-3.3-70B-Instruct-Turbo',family:'together',source:'together_api_pricing',providerDefault:'together',in:0.88,out:0.88,cacheRead:null,cacheWrite5m:null,cacheWrite1h:null,cacheWriteShare:0,color:'#ffab40',ctx:131072,cd:0,bd:0,lat:1100,tps:95,status:'provider-priced'}
};
const MK=Object.keys(MODELS);
let selectedModel='claude-sonnet-4.6';

// Expose tables to app.js (cost-engine.js doesn't know about provider
// tool fees or per-model families; app.js loops over workload.agents
// and sums fees into the headline so mixed-provider fleets bill
// correctly). Must come AFTER const MODELS / TOOL_FEES are declared
// (TDZ would otherwise throw at module-eval time and halt execution).
if (typeof window !== 'undefined') {
  window.__TOOL_FEES = TOOL_FEES;
  window.__feesFor = feesFor;
  window.__MODELS = MODELS;
}

const TASK_TYPES=[
  {id:'classify', label:'Classification', color:'#00d4ff',pct:20,outMult:.30},
  {id:'summary',  label:'Summarisation',  color:'#00e676',pct:25,outMult:.65},
  {id:'rag',      label:'RAG/Retrieval',  color:'#7c4dff',pct:20,outMult:.85},
  {id:'code',     label:'Code gen',       color:'#ffab40',pct:15,outMult:2.80},
  {id:'longform', label:'Long-form NLG',  color:'#f48fb1',pct:10,outMult:3.60},
  {id:'agent',    label:'Agentic chains', color:'#4dd0e1',pct:10,outMult:4.30},
];
function wOM(){const t=TASK_TYPES.reduce((s,x)=>s+x.pct,0)||1;return TASK_TYPES.reduce((s,x)=>s+(x.pct/t)*x.outMult,0);}

const TOOLS_LIST=['web_search','db_query','code_exec','vector_search','file_read','api_call','memory_write','embeddings'];
const AGENT_DEF=[
  {name:'Agent 1',role:'Orchestrator',model:'claude-sonnet-4.6',provider:'managed',col:'#00d4ff',temp:.7,maxOut:512,
   turnsShare:1.5, toolsOn:true, ragOn:true, reasonOn:false, guardOn:true,
   tools_per:3,schema:320,result:600,rag_chunks:5,rag_size:512,rag_calls:1,
   think_tok:0,think_pct:0,cot:0,factcheck:0,
   guard_in:200,guard_out:200,guard_pii:100,guard_policy:300,
   cache_rate:60,task_bias:'agent'},
  {name:'Agent 2',role:'Analyst',     model:'claude-opus-4.7',    provider:'managed',col:'#ce93d8',temp:.5,maxOut:1024,
   turnsShare:1.2, toolsOn:true, ragOn:true, reasonOn:true,  guardOn:true,
   tools_per:2,schema:400,result:1200,rag_chunks:8,rag_size:768,rag_calls:2,
   think_tok:5000,think_pct:50,cot:5,factcheck:1,
   guard_in:400,guard_out:400,guard_pii:200,guard_policy:600,
   cache_rate:40,task_bias:'rag'},
  {name:'Agent 3',role:'Researcher',  model:'claude-haiku-4.5', provider:'managed',col:'#00e676',temp:.8,maxOut:768,
   turnsShare:0.8, toolsOn:true, ragOn:true, reasonOn:false, guardOn:false,
   tools_per:4,schema:300,result:1500,rag_chunks:12,rag_size:512,rag_calls:3,
   think_tok:0,think_pct:0,cot:2,factcheck:1,
   guard_in:0,guard_out:0,guard_pii:0,guard_policy:0,
   cache_rate:50,task_bias:'rag'},
  {name:'Agent 4',role:'Coder',       model:'gpt-5.4',           provider:'managed',col:'#74aa9c',temp:.3,maxOut:2048,
   turnsShare:1.0, toolsOn:true, ragOn:false,reasonOn:true,  guardOn:true,
   tools_per:2,schema:500,result:2000,rag_chunks:0,rag_size:0,rag_calls:0,
   think_tok:8000,think_pct:60,cot:8,factcheck:2,
   guard_in:100,guard_out:100,guard_pii:0,guard_policy:200,
   cache_rate:55,task_bias:'code'},
  {name:'Agent 5',role:'Critic',      model:'gemini-3-flash-preview', provider:'managed',col:'#4285f4',temp:.6,maxOut:512,
   turnsShare:0.5, toolsOn:false,ragOn:false,reasonOn:true, guardOn:true,
   tools_per:0,schema:0,result:0,rag_chunks:0,rag_size:0,rag_calls:0,
   think_tok:3000,think_pct:80,cot:5,factcheck:3,
   guard_in:200,guard_out:200,guard_pii:0,guard_policy:300,
   cache_rate:30,task_bias:'classify'},
  {name:'Agent 6',role:'Planner',     model:'llama-3.3-70b-together',    provider:'together',col:'#ffab40',temp:.7,maxOut:1024,
   turnsShare:0.8, toolsOn:true, ragOn:false,reasonOn:false, guardOn:false,
   tools_per:1,schema:200,result:500,rag_chunks:0,rag_size:0,rag_calls:0,
   think_tok:0,think_pct:0,cot:3,factcheck:0,
   guard_in:0,guard_out:0,guard_pii:0,guard_policy:0,
   cache_rate:0,task_bias:'agent'},
  {name:'Agent 7',role:'Executor',    model:'claude-sonnet-4.6',provider:'managed',col:'#ff5252',temp:.4,maxOut:768,
   turnsShare:1.0, toolsOn:true, ragOn:true, reasonOn:false, guardOn:true,
   tools_per:3,schema:320,result:1000,rag_chunks:3,rag_size:256,rag_calls:1,
   think_tok:0,think_pct:0,cot:0,factcheck:0,
   guard_in:300,guard_out:300,guard_pii:200,guard_policy:400,
   cache_rate:55,task_bias:'agent'},
  {name:'Agent 8',role:'Summarizer',  model:'claude-haiku-4.5', provider:'byok',col:'#80cbc4',temp:.9,maxOut:512,
   turnsShare:0.4, toolsOn:false,ragOn:false,reasonOn:false, guardOn:true,
   tools_per:0,schema:0,result:0,rag_chunks:0,rag_size:0,rag_calls:0,
   think_tok:0,think_pct:0,cot:0,factcheck:0,
   guard_in:100,guard_out:100,guard_pii:50,guard_policy:200,
   cache_rate:70,task_bias:'summary'},
];
const PROVIDERS = {
  managed:{label:'Managed API',in_mult:1.00,out_mult:1.00,fixed_mo:0,note:'Direct vendor/API list price'},
  byok:{label:'BYOK',in_mult:1.00,out_mult:1.00,fixed_mo:0,note:'Bring your own key, no aggregator markup'},
  together:{label:'Together AI',in_mult:1.00,out_mult:1.00,fixed_mo:0,note:'Together-hosted open-weight inference'},
  bedrock:{label:'AWS Bedrock regional',in_mult:1.10,out_mult:1.10,fixed_mo:0,note:'+10% regional/multi-region premium where applicable'},
  azure:{label:'Azure/OpenAI',in_mult:1.00,out_mult:1.00,fixed_mo:0,note:'Cloud contract parity unless your agreement differs'},
  openrouter:{label:'OpenRouter',in_mult:1.05,out_mult:1.05,fixed_mo:0,note:'+5% representative aggregator markup'},
  'self-hosted':{label:'Self-Hosted',in_mult:0,out_mult:0,fixed_mo:5000,note:'GPU+ops fixed cost; no per-token API charge'}
};
const SYS_P={Orchestrator:'You are the orchestrator. Coordinate multi-agent workflows, prioritize tasks, enforce protocols.',Analyst:'You are the analyst. Telemetry processing, anomaly detection, pattern recognition.',Researcher:'You are the researcher. Surface precedents, literature, procedures.',Coder:'You are the systems coder. Computational tasks, data transformations.',Critic:'You are the QA critic. Evaluate outputs for accuracy, completeness, risk.',Planner:'You are the planner. Build execution plans, manage dependencies.',Executor:'You are the executor. Carry out actions with precision.',Summarizer:'You are the summarizer. Condense exchanges into actionable briefs.'};
const UNAMES=['Mission Ctrl','Flight Dir','Systems Eng','Science Lead','Ops Analyst','Data Arch','Comms Ofcr','Safety Ofcr'];
const UMSGS_SHORT=['Requesting telemetry analysis for orbital trajectory delta-V calculations.','Cross-reference sensor array data with historical mission profiles.','Execute subsystem health check: propulsion, comms, life support.','Initiate ML inference on spectrometer feed from sector 7-Alpha.','Synthesize multi-source intelligence for mission decision support.','Coordinate agent handoff for signal processing pipeline.','Run anomaly detection on thermal imaging data. Flag outliers above 2σ.','Validate fuel model against real-time trajectory. Quantify deviation.'];
const UMSGS_LONG=[
'I need a comprehensive analysis of telemetry data covering the last 30 days. Please segment by subsystem (propulsion, thermal, communications), identify any anomalies above 2-sigma threshold, cross-reference with historical mission profiles from comparable phases, and generate a risk-ranked summary. For any anomaly flagged, include attribution confidence and recommended mitigation actions. Also confirm whether the anomaly patterns align with known degradation signatures or suggest novel failure modes that warrant deeper investigation.',
'Please review the attached corpus of research papers on methane detection from satellite-borne instruments and produce a structured gap analysis. I need: (1) a list of methodologies covered vs not covered, (2) temporal coverage gaps in the dataset record, (3) instrument bias considerations, (4) recommendations for which gaps are most critical to address for our mission objectives. Pause for my approval before propagating to downstream stages — do not auto-proceed.',
'Cross-reference the experimental protocol with NASA-STD-8729.1B and ECSS-Q-ST-30C requirements. Highlight any compliance gaps, risk areas requiring waivers, and propose alternative protocol modifications that maintain scientific objectives while achieving full standards compliance. Include effort estimates for each remediation path and rank by impact-to-effort ratio.',
'Synthesize findings from the previous three stages (gap identification, capability mapping, spec building) into a coherent research report suitable for submission to mission leadership. The report should include: executive summary, methodology rationale, key findings with confidence intervals, identified risks and mitigations, recommended next steps with cost/timeline estimates, and an appendix with detailed evidence trails. Structure it for both technical reviewers and program management audiences.',
'I want you to design and validate the experimental implementation plan based on the workflow specification. Include: data ingestion procedures, processing pipeline architecture, quality assurance gates, expected output formats, validation test cases, and rollback procedures. Identify any computational resource requirements that exceed our current allocation and flag them for procurement review.',
'Analyze the research workflow output and produce a peer-review-ready document. Include comparative analysis against three relevant published studies, statistical significance testing for all quantitative claims, methodological caveats and limitations, and a discussion section addressing potential alternative interpretations. The document should be ready for submission to a Q1 journal in our domain.'
];
const UMSGS = UMSGS_LONG;
const RESPS_SHORT=[(a,t,tools)=>`Analysis complete. Confidence: ${(85+t*12).toFixed(1)}%. ${tools.length?'Invoked: '+tools.join(', ')+'.':''} Forwarding to coordinator.`,(a,t,tools)=>`${a.role} nominal. Cross-referenced ${Math.floor(3+t*7)} streams. ${tools.length?'Tool chain: '+tools.join(' → ')+'.':''} No critical anomalies.`,(a,t,tools)=>`Synthesis complete. CI: ${(80+t*18).toFixed(1)}% at 2σ. ${tools.length?'APIs: '+tools.join(', ')+'.':''} Recommendation matrix ready.`,(a,t,tools)=>`Decision tree: ${Math.floor(4+t*5)} paths. Optimal: ${(88+t*10).toFixed(1)}% confidence. ${tools.length?'Calls: '+tools.join(', ')+'.':''} Forwarded.`];
const RESPS_LONG=[
(a,t,tools)=>`I've completed initial ${a.role} analysis on the inputs you provided. Here's the structured breakdown:\n\nWhat I observed:\n- Primary scope: ${Math.floor(3+t*7)} core dimensions with measurable variance across ${Math.floor(2+t*4)} sub-domains.\n- Coverage gaps: ${Math.floor(1+t*3)} significant gaps detected in the corpus, particularly around methodology boundaries and data lineage.\n- Key dependencies: ${tools.length?tools.join(', '):'no external tool calls required for this stage'}.\n\nWhat cannot be determined yet:\n- Whether the inferred scope holds across edge cases (need broader sampling).\n- Confidence in attribution to specific source documents (requires fact-check pass).\n\nWhat I need from you to proceed:\n1. Confirm the inferred scope matches your intent, or specify boundary corrections.\n2. Approve or revise the gap list before I propagate to downstream stages.\n3. Indicate any domain constraints I should enforce (years, geography, methods).\n\nProcessing confidence: ${(82+t*14).toFixed(1)}%. Once you reply with confirmations or corrections, I will proceed to the next stage.`,
(a,t,tools)=>`${a.role} stage output — ready for your review.\n\nSummary of work completed:\nAfter reviewing the upstream inputs and applying ${a.role.toLowerCase()} criteria, I've produced ${Math.floor(4+t*8)} candidate findings ranked by relevance. The highest-confidence finding (${(88+t*10).toFixed(1)}%) is well-grounded in the source corpus with explicit citations. The lower-ranked findings ${tools.length?'leveraged '+tools.join(' and ')+' for cross-validation':'are speculative and flagged accordingly'}.\n\nMethodology applied:\n- Multi-pass extraction with reasoning trace preserved\n- Cross-reference against ${Math.floor(2+t*5)} authoritative sources\n- Statistical significance threshold: p<0.05 for quantitative claims\n\nRisks detected:\n- Attribution uncertainty on ${Math.floor(1+t*3)} claims (mitigation: fact-check sidecar will verify)\n- Potential data leakage between training corpus and evaluation set\n\nBlocking approval needed before I proceed:\n- Confirm the methodology is acceptable for your use case\n- Approve or revise the candidate findings list\n- Specify whether to include speculative items in downstream processing\n\nReply "Proceed" to continue or provide specific revisions.`,
(a,t,tools)=>`${a.role} synthesis report.\n\nI've integrated outputs from upstream stages and produced a structured deliverable. Below is the breakdown by section:\n\nSection 1 — Executive summary:\nThe analysis identified ${Math.floor(3+t*6)} primary themes with strong empirical support. Confidence interval: ${(80+t*15).toFixed(1)}% at 2σ.\n\nSection 2 — Detailed findings:\nFinding A: Strong signal in primary dataset, ${tools.length?'cross-validated via '+tools[0]:'no external validation performed'}. Recommended action: prioritize for follow-up.\nFinding B: Moderate signal, requires additional sampling. Confidence ${(70+t*15).toFixed(1)}%.\nFinding C: Weak signal, possibly noise. Flagged for human review.\n\nSection 3 — Caveats and limitations:\nThis analysis was performed against the corpus as-of stage input timestamp. Any data updates after that point are not reflected. The ${a.role.toLowerCase()} model has known limitations in handling ${['ambiguous attribution','non-English content','code-mixed documents','temporal reasoning'][Math.floor(t*4)%4]}.\n\nNext steps:\nI recommend proceeding to the next stage with these findings. Please confirm or request revisions. If you need a deeper dive on any specific finding, indicate which one and the level of detail required.`,
];
const RESPS = RESPS_LONG; // default to long; runTick will pick by mode

/* ═══════ COST ENGINE ═══════ */
function providerForAgent(agent, modelKey, overrideModel){
  const m=MODELS[modelKey]||MODELS['claude-sonnet-4.6'];
  const pk=overrideModel ? (m.providerDefault||'managed') : (agent.provider || m.providerDefault || 'managed');
  return PROVIDERS[pk] || PROVIDERS.managed;
}
function resolvePricingTier(model, provider, langMult, turnIn){
  // Walk tier definitions to find the matching one for the given input size.
  // Two formats supported:
  // 1) NEW: model.tiers = [{thresholdAt:0,in,out,cacheRead,...},{thresholdAt:200000,in,out,cacheRead,...},{thresholdAt:1000000,...}]
  //    thresholdAt is the LOW edge (inclusive). The tier whose thresholdAt is the largest value <= turnIn applies.
  // 2) LEGACY: model.longThreshold + model.longIn/longOut/longCacheRead (binary standard vs long).
  // Either format is accepted; tiers[] takes precedence when present.
  let inBase, outBase, cacheReadBase, cacheWrite5mBase, cacheWrite1hBase, tierLabel;
  if(Array.isArray(model.tiers) && model.tiers.length){
    // Sort by threshold ascending and pick highest threshold <= turnIn
    const sorted=[...model.tiers].sort((a,b)=>(a.thresholdAt||0)-(b.thresholdAt||0));
    let chosen=sorted[0];
    for(const t of sorted){ if(turnIn >= (t.thresholdAt||0)) chosen=t; }
    inBase = chosen.in!=null ? chosen.in : model.in;
    outBase = chosen.out!=null ? chosen.out : model.out;
    cacheReadBase = chosen.cacheRead!=null ? chosen.cacheRead : model.cacheRead;
    cacheWrite5mBase = chosen.cacheWrite5m!=null ? chosen.cacheWrite5m : model.cacheWrite5m;
    cacheWrite1hBase = chosen.cacheWrite1h!=null ? chosen.cacheWrite1h : model.cacheWrite1h;
    tierLabel = chosen.label || ('tier@'+(chosen.thresholdAt||0));
  } else {
    // `>=` (not `>`): provider docs (e.g. Gemini) define the long-context
    // tier boundary as "input at or above 200K tokens". Strict `>` would
    // bill a 200,000-token prompt at the standard rate — off-by-one against
    // the rate-card definition.
    const useLong=!!(model.longThreshold && turnIn>=model.longThreshold && model.longIn!=null && model.longOut!=null);
    inBase=useLong?model.longIn:model.in;
    outBase=useLong?model.longOut:model.out;
    cacheReadBase=useLong && model.longCacheRead!==undefined ? model.longCacheRead : model.cacheRead;
    cacheWrite5mBase=model.cacheWrite5m;
    cacheWrite1hBase=model.cacheWrite1h;
    tierLabel = useLong?'long-context':'standard';
  }
  const inMult=provider.in_mult*langMult;
  const outMult=provider.out_mult*langMult;
  const priceModel=Object.assign({},model,{
    in:inBase, out:outBase,
    cacheRead:cacheReadBase!=null?cacheReadBase*inMult:cacheReadBase,
    cacheWrite5m:cacheWrite5mBase!=null?cacheWrite5mBase*inMult:cacheWrite5mBase,
    cacheWrite1h:cacheWrite1hBase!=null?cacheWrite1hBase*inMult:cacheWrite1hBase
  });
  return {tier:tierLabel, inRate:inBase*inMult, outRate:outBase*outMult, priceModel};
}
function pricedInputCost(tokens, rate, model, batchRate, cacheRate, cacheWriteShareOverride){
  const safeTok=Math.max(0,tokens||0), safeBatch=Math.min(1,Math.max(0,batchRate||0)), safeCache=Math.min(1,Math.max(0,cacheRate||0));
  const eligibleCached=Math.round(safeTok*safeCache);
  // cacheWriteShareOverride from UI (0..1) takes precedence over model default; null/undefined means use model default
  const writeShare = (cacheWriteShareOverride!=null && !isNaN(cacheWriteShareOverride))
    ? Math.min(1, Math.max(0, cacheWriteShareOverride))
    : (model.cacheWriteShare||0);
  const cacheWriteTok=model.cacheWrite5m ? Math.round(eligibleCached*writeShare) : 0;
  const cacheReadTok=Math.max(0,eligibleCached-cacheWriteTok);
  const uncachedTok=Math.max(0,safeTok-eligibleCached);
  const batchTok=Math.round(uncachedTok*safeBatch);
  const regularTok=Math.max(0,uncachedTok-batchTok);
  const readRate=(model.cacheRead!=null)?model.cacheRead:rate*(1-(model.cd||0));
  const writeRate=(model.cacheWrite5m!=null)?model.cacheWrite5m:rate;
  const regularCost=(regularTok/1e6)*rate;
  const batchCost=(batchTok/1e6)*rate*(1-(model.bd||0));
  const readCost=(cacheReadTok/1e6)*readRate;
  const writeCost=(cacheWriteTok/1e6)*writeRate;
  const listCost=(safeTok/1e6)*rate;
  const cacheListCost=(eligibleCached/1e6)*rate;
  return {
    cost:regularCost+batchCost+readCost+writeCost,
    listCost, regularTok, batchTok, cacheReadTok, cacheWriteTok,
    cacheSave:Math.max(0,cacheListCost-readCost-writeCost),
    batchSave:(batchTok/1e6)*rate*(model.bd||0)
  };
}
function pricedOutputCost(tokens, rate, model, batchRate){
  const safeTok=Math.max(0,tokens||0), safeBatch=Math.min(1,Math.max(0,batchRate||0));
  const batchTok=Math.round(safeTok*safeBatch), regularTok=Math.max(0,safeTok-batchTok);
  const regularCost=(regularTok/1e6)*rate;
  const batchCost=(batchTok/1e6)*rate*(1-(model.bd||0));
  return {cost:regularCost+batchCost,listCost:(safeTok/1e6)*rate,regularTok,batchTok,batchSave:(batchTok/1e6)*rate*(model.bd||0)};
}
function computeCost(mk){
  if(typeof executionMode==='undefined'){window.executionMode='fleet';}
  if(typeof dagTopology==='undefined'){window.dagTopology='sequential';}
  const baseTurns=cfg('s-turns');
  const sysTokGlobal=cfg('s-sysprompt');
  const cacheGlobal=cfg('s-cache')/100;
  const batchRate=cfg('s-batch')/100;
  const retryRate=cfg('s-retry')/100;
  const iaMsg=cfg('s-iamsg');
  const peakRatio=parseInt(document.getElementById('s-peak')?.value||'1')||1;
  const langMult=parseFloat(document.getElementById('s-lang-mult')?.value||'1.0')||1.0;
  const agentsToProcess=sim.agents.length ? sim.agents : AGENT_DEF.slice(0,cfg('s-agents'));
  const agentCount=agentsToProcess.length || 1;
  const overrideModel=(mk && mk!=='__aggregate__');

  let totalIn=0,totalOut=0,modelApiCost=0,baseCost=0,retryWaste=0,cacheSave=0,batchSave=0;
  let ragCost=0,reasonCost=0,totalGuardCost=0,toolOHCost=0,guardWaste=0;
  let fixedMonthly=0,ragTokTotal=0,reasonTokTotal=0,guardTokTotal=0,toolSchemaTotal=0,toolResultTotal=0;
  let guardInTotal=0,guardOutTotal=0,guardPiiTotal=0,guardPolicyTotal=0,cacheReadTok=0,cacheWriteTok=0;
  let summarisationCost=0,modelTouched={},agentBreakdown=[];
  // Eq. 7 pipeline handoff: per-stage running sum of prior stages' output
  // tokens, threaded across the agent loop. Only used when s-comm-pattern=3.
  let pipelineCumulativeOutTok = 0;

  const imgTok=cfg('s-images')*1568, audioTok=cfg('s-audio')*25, pdfTok=cfg('s-pdf')*1500, codeInterp=cfg('s-codeinterp');
  // Workload-wide fewshot/jsonschema/memory/citations are fallbacks.
  // Per-agent values (agent.fewshot, .jsonschema, .memory, .citations)
  // override inside the per-agent loop below — only the formatter and
  // structured-output agents typically carry few-shots and JSON schema;
  // only persistent agents carry memory; only fact-grounded agents emit
  // citation tokens. Applying workload-wide to every agent overestimates.
  const fewshotGlobal=cfg('s-fewshot')*250, jsonSchemaGlobal=cfg('s-jsonschema'), citationsGlobal=cfg('s-citations'), memoryGlobal=cfg('s-memory');
  const modalTurnTok=imgTok+audioTok+pdfTok+codeInterp;

  agentsToProcess.forEach(agent=>{
    const usedModel=overrideModel ? mk : agent.model;
    const m=MODELS[usedModel]||MODELS['claude-sonnet-4.6'];
    const provider=providerForAgent(agent,usedModel,overrideModel);
    modelTouched[usedModel]=true;

    const myTurns=Math.max(1,Math.round(baseTurns*(agent.turnsShare||1.0)));
    // Per-tool-result token budget — two paths.
    //
    // (A) Per-tool walk: when this agent declares `enabled_tools`
    // (the canonical MCP-style registry walk introduced in the per-agent
    // redesign), schema and result tokens are computed PER TOOL from the
    // registry entry. Each tool can set its own `return_shape`
    // ('freeform' | 'templated') and `cap_tokens`; templated tools have
    // their result tokens clamped to cap. This matches the paper's
    // implicit assumption that different tools have different return
    // sizes (web_search ~800 tok freeform vs. internal_db_query ~500 tok
    // freeform vs. 40 tok templated).
    //
    // (B) Workload-wide fallback: when `enabled_tools` is empty (the
    // public-geospatial-qa reference workload uses this path), we honor
    // the workload-wide #s-tool-response-mode + #s-tool-templated-cap
    // controls. This preserves the paper's bench-validated headline
    // because that workload has never used per-tool fields.
    const _toolMode=document.getElementById('s-tool-response-mode')?.value||'freeform';
    const _templatedCapRaw=parseInt(document.getElementById('s-tool-templated-cap')?.value,10);
    const _templatedCap=Number.isFinite(_templatedCapRaw)&&_templatedCapRaw>0?_templatedCapRaw:40;
    const _registry=(window.workload&&window.workload.tools_registry)||{};
    const _enabledTools=agent.enabled_tools||(window.workload&&window.workload.agents||[])
      .find(a=>String(a.id)===String(agent.id))?.enabled_tools||{};
    const _enabledList=Object.entries(_enabledTools).filter(([id,spec])=>(spec&&spec.calls_per_query>0)&&_registry[id]);
    let myToolsPer, mySchema, myResult, myToolSchemaOH, myToolResultOH;
    if(agent.toolsOn&&_enabledList.length>0){
      // Per-tool walk (path A). Sum calls/turn across all enabled tools;
      // schema/result tokens are call-weighted averages so the existing
      // headline-overhead computation (uniform myToolsPer * myResult)
      // produces the same total as a per-tool sum.
      let totalCalls=0, schemaSum=0, resultSum=0;
      for(const [tid,spec] of _enabledList){
        const t=_registry[tid];
        // Per-tool memoization (same-session result cache). Effective
        // call count = nominal × (1 - hit_rate). Schema tokens still
        // count for every call (the LLM sees the tool definition in
        // sysprompt regardless of cache hits); result tokens scale
        // down with the cache.
        const memo=t.memoize&&Number.isFinite(t.memoize_hit_rate)?t.memoize_hit_rate:0;
        // Per-(agent,tool) trigger rate — fraction of agent invocations
        // this tool actually fires on. Affects effective call count
        // (and therefore both result tokens and the upstream fee math
        // in app.js). Schema tokens still amortize over every turn
        // because the tool definition stays in sysprompt regardless.
        const trig=Number.isFinite(spec.trigger_rate)&&spec.trigger_rate>=0&&spec.trigger_rate<=1?spec.trigger_rate:1.0;
        const callsNominal=spec.calls_per_query;
        const callsEff=callsNominal*Math.max(0,1-memo)*trig;
        const sch=t.schema_tokens??cfg('s-schema');
        const rawResult=t.result_tokens_avg??cfg('s-toolresult');
        // Override precedence (highest wins):
        //   per-(agent,tool)  — agent.enabled_tools[tid].return_shape_override
        //   per-tool          — workload.tools_registry[tid].return_shape
        //   workload-wide     — #s-tool-response-mode (default fallback)
        // Same chain for cap_tokens.
        const shape=spec.return_shape_override||t.return_shape||_toolMode;
        const cap=Number.isFinite(spec.cap_tokens_override)?spec.cap_tokens_override
                  :Number.isFinite(t.cap_tokens)?t.cap_tokens:_templatedCap;
        const res=shape==='templated'?Math.min(rawResult,cap):rawResult;
        totalCalls+=callsNominal;
        schemaSum+=callsNominal*sch;
        resultSum+=callsEff*res;
      }
      // calls_per_query is per session; per-turn rate = calls/turn.
      myToolsPer=totalCalls/Math.max(1,myTurns);
      mySchema=totalCalls>0?(schemaSum/totalCalls):0;
      myResult=totalCalls>0?(resultSum/totalCalls):0;
      myToolSchemaOH=schemaSum/Math.max(1,myTurns);
      myToolResultOH=resultSum/Math.max(1,myTurns);
    } else {
      // Workload-wide fallback (path B). Preserves paper math.
      myToolsPer=agent.toolsOn?(agent.tools_per??cfg('s-tools')):0;
      mySchema=agent.schema??cfg('s-schema');
      const _myResultRaw=agent.result??cfg('s-toolresult');
      myResult=_toolMode==='templated'?Math.min(_myResultRaw,_templatedCap):_myResultRaw;
      myToolSchemaOH=myToolsPer*mySchema;
      myToolResultOH=myToolsPer*myResult;
    }
    const ragCalls=agent.rag_calls??cfg('s-rag-calls');
    const myRagTok=agent.ragOn?(((agent.rag_chunks??cfg('s-rag-chunks'))*(agent.rag_size??cfg('s-rag-chunk-size'))+(cfg('s-rag-query')||0))*ragCalls):0;
    const myReasonTok=agent.reasonOn?((agent.think_tok??cfg('s-think-tokens'))*((agent.think_pct??cfg('s-think-pct'))/100)+(agent.cot??cfg('s-cot'))*150+(agent.factcheck??cfg('s-factcheck'))*200):0;
    const myGuardIn=agent.guardOn?(agent.guard_in??cfg('s-guard-in')):0;
    const myGuardOut=agent.guardOn?(agent.guard_out??cfg('s-guard-out')):0;
    const myGuardPii=agent.guardOn?(agent.guard_pii??cfg('s-guard-pii')):0;
    const myGuardPolicy=agent.guardOn?(agent.guard_policy??cfg('s-guard-policy')):0;
    const myGuardTok=myGuardIn+myGuardOut+myGuardPii+myGuardPolicy;
    const myCacheRate=(agent.cache_rate!==undefined)?agent.cache_rate/100:cacheGlobal;

    const taskMix=agent.task_bias?Object.fromEntries(TASK_TYPES.map(t=>[t.id,t.id===agent.task_bias?60:8])):Object.fromEntries(TASK_TYPES.map(t=>[t.id,t.pct]));
    const totalMix=Object.values(taskMix).reduce((s,v)=>s+v,0)||1;
    const myOM=TASK_TYPES.reduce((s,t)=>s+(taskMix[t.id]/totalMix)*t.outMult,0);

    // Fold guard tokens into the turn input when no separate guard model is
    // selected (s-guard-model=0, gpr=0 below). This makes guard sliders move
    // the headline cost at the main-model rate. When a dedicated guard model
    // IS selected, guards are billed at gpr below via totalGuardCost and
    // excluded here to avoid double-counting.
    const _gpIdxForTurnIn=cfg('s-guard-model');
    const _gprForTurnIn=([0,0.20,0.25,0.75,1.00,3.00][_gpIdxForTurnIn] ?? 0);
    const myGuardTokInTurn = _gprForTurnIn === 0 ? (agent.guardOn ? myGuardIn+myGuardOut+myGuardPii+myGuardPolicy : 0) : 0;
    // Communication-pattern overhead. With N agents:
    //   orchestrator (0): 0 — workers only see the boss's task
    //   peer mesh    (1): each agent reads (N-1) sibling outputs ≈ ~300 tok each
    //   supervisor   (2): hierarchical handoff ≈ ~150 tok × (N-1)
    //   pipeline     (3): Eq. 7 — stage N sees Σ_{i<N} avg_output_tokens_i
    //
    // Patterns 0/1/2 assume parallel execution (all agents see the same
    // sibling-count of peer outputs, independent of order), so the overhead
    // is a flat per-turn additive applied to every agent in the fleet.
    //
    // Pattern 3 (sequential pipeline) is fundamentally different: stage N
    // only sees PRIOR stages' outputs. We therefore add the pipeline
    // overhead as an ABSOLUTE token count to myTotalIn after the per-turn
    // math, not via the per-turn `_commOverheadPerTurn` channel. This
    // preserves the paper's Σ avg_output_tokens_i interpretation regardless
    // of per-agent turnsShare ratios, and prevents pipeline overhead from
    // accidentally pushing turnIn over a long-context pricing threshold.
    const _commPattern = cfg('s-comm-pattern');
    const _commSiblings = Math.max(0, agentCount - 1);
    const _commOverheadPerTurn = _commPattern === 1 ? _commSiblings * 300
                              : _commPattern === 2 ? _commSiblings * 150
                              : 0;  // pattern 3 handled after per-turn math
    // Per-agent sysprompt and inter-agent message size. Orchestrator
    // sysprompts run 1,500–3,000 tok (role + tool catalog + decision
    // rules); worker sysprompts are often 200–500 tok. iamsg size
    // varies by sender role. Fall back to workload-wide sliders when
    // the agent doesn't carry per-row values (preserves paper math).
    const mySysTok=agent.sysprompt??sysTokGlobal;
    const myIaMsg=agent.iamsg??iaMsg;
    // Per-agent prompt overhead (few-shot, JSON schema, persistent
    // memory, citation output). Same "per-agent overrides workload-
    // wide" pattern — only certain agents have these (formatter has
    // few-shots, planner has memory, researcher emits citations).
    const myFewshot=(agent.fewshot!==undefined?agent.fewshot*250:fewshotGlobal);
    const myJsonSchema=agent.jsonschema??jsonSchemaGlobal;
    const myMemory=agent.memory??memoryGlobal;
    const myCitations=agent.citations??citationsGlobal;
    const myPromptOHTurn=myFewshot+myJsonSchema+myMemory;
    // Tool-result cache share (mirrors cost-engine.js). Default 0.5 means
    // half of per-call tool result tokens flow through the agent's cache
    // rate (modeling prefix reuse across stages of the same session); the
    // other half is billed fresh. Setting 0 = strict no-cache, 1.0 =
    // pre-fix-A behavior. Per-agent override beats workload-wide.
    const __trcsDefault = 0.5;
    const __trcsRaw = (agent.tool_result_cache_share != null
                       ? agent.tool_result_cache_share
                       : (window.workload && window.workload.tool_result_cache_share != null
                          ? window.workload.tool_result_cache_share
                          : __trcsDefault));
    const __trcs = Math.max(0, Math.min(1, Number(__trcsRaw)));
    // ReAct accumulation persistence (bug B, mirrors cost-engine.js).
    // Default 0 — no change to existing presets. When > 0, tool result
    // tokens get multiplied by (1 + (calls - 1) × persistence) to model
    // results being seen by subsequent LLM calls in the same ReAct loop.
    // See engine comment for full rationale and double-counting warning.
    const __trrpRaw = (agent.tool_result_react_persistence != null
                       ? agent.tool_result_react_persistence
                       : (window.workload && window.workload.tool_result_react_persistence != null
                          ? window.workload.tool_result_react_persistence
                          : 0));
    const __trrp = Math.max(0, Math.min(1, Number(__trrpRaw)));
    const __agentCallsForReact = Math.max(1, Number(agent.calls_per_query) || 1);
    const __reactMult = 1 + Math.max(0, __agentCallsForReact - 1) * __trrp;
    const __accResultPerTurn = myToolResultOH * __reactMult;
    // The "uncached" portion of (react-accumulated) tool result tokens
    // is pulled OUT of the cacheable input bucket and added separately
    // as a fresh-rate cost below. This is the load-bearing fix for
    // freeform tool returns — see cost-engine.js comment on
    // agentToolTokenBreakdown.
    const __toolResultUncachedPerTurn = __accResultPerTurn * (1 - __trcs);
    const __toolResultCachedPerTurn   = __accResultPerTurn * __trcs;
    const turnIn=(mySysTok/myTurns)+200+myToolSchemaOH+__toolResultCachedPerTurn+myIaMsg+myRagTok+myReasonTok+myGuardTokInTurn+_commOverheadPerTurn+modalTurnTok+myPromptOHTurn;
    const rawTurnOut=Math.round(200*myOM)+myCitations;
    const turnOut=Math.min(rawTurnOut, agent.maxOut||rawTurnOut);
    const tierInfo=resolvePricingTier(m,provider,langMult,turnIn);
    const inRate=tierInfo.inRate,outRate=tierInfo.outRate,priceModel=tierInfo.priceModel;
    // Eq. 7 sequential-pipeline handoff overhead: prior stages' cumulative
    // output is added as an absolute one-shot to this stage's total input
    // (not distributed across turns). Single-agent / first-stage agents see
    // zero pipeline overhead because the accumulator starts at 0.
    const pipelineHandoffTok = _commPattern === 3 ? pipelineCumulativeOutTok : 0;
    const myTotalIn=turnIn*myTurns + pipelineHandoffTok;
    const myTotalOut=turnOut*myTurns;
    // Uncached fresh tool-result tokens. Billed at the full input rate
    // (no cache discount, no batch discount) and added to the model cost
    // alongside the cached-bucket inPrice below.
    const __toolResultFreshCost = (__toolResultUncachedPerTurn * myTurns / 1e6) * inRate;

    let myModelCost=0,myFixed=0,myCacheSave=0,myBatchSave=0,myCacheReadTok=0,myCacheWriteTok=0;
    if(provider.in_mult===0 && provider.out_mult===0){
      myFixed=provider.fixed_mo/Math.max(1,cfg('s-sessions')*30);
      fixedMonthly+=myFixed;
    }else{
      const cwsOverride=parseFloat(document.getElementById('s-cache-write-share')?.value);
      const inPrice=pricedInputCost(myTotalIn,inRate,priceModel,batchRate,myCacheRate, isNaN(cwsOverride)?null:cwsOverride/100);
      const outPrice=pricedOutputCost(myTotalOut,outRate,priceModel,batchRate);
      // Add the uncached portion of tool result tokens (pulled out of
      // myTotalIn above) at the fresh input rate — no cache discount,
      // no batch discount. Mirrors the engine's split in
      // cost-engine.js perQueryCostAgents.
      myModelCost=inPrice.cost+outPrice.cost+__toolResultFreshCost;
      modelApiCost+=myModelCost;
      baseCost+=myModelCost;
      retryWaste+=myModelCost*retryRate*1.5;
      myCacheSave=inPrice.cacheSave;
      myBatchSave=inPrice.batchSave+outPrice.batchSave;
      cacheSave+=myCacheSave;
      batchSave+=myBatchSave;
      cacheReadTok+=inPrice.cacheReadTok;cacheWriteTok+=inPrice.cacheWriteTok;
      myCacheReadTok=inPrice.cacheReadTok;myCacheWriteTok=inPrice.cacheWriteTok;
    }

    const gpriceIdx=cfg('s-guard-model');
    const gprices=[0,0.20,0.25,0.75,1.00,3.00];
    const gpr=gprices[gpriceIdx] ?? 0;
    const guardBaseCost=(myGuardTok*myTurns/1e6)*gpr;
    // myGuardWaste models the OUTPUT-side guard architecture: main model
    // processes the input first, then the guard checks the response and
    // may block it. When that happens, the main-model input tokens are
    // already spent — so the waste is billed at inRate (main model),
    // not gpr (guard model). If your deployment runs guards on the input
    // BEFORE the main model, this formula will overstate cost.
    const myGuardWaste=(cfg('s-guard-block')/100)*(((mySysTok/myTurns)+200+myRagTok)/1e6)*inRate*myTurns;
    totalGuardCost+=guardBaseCost+myGuardWaste;
    guardWaste+=myGuardWaste;

    totalIn+=myTotalIn; totalOut+=myTotalOut;
    ragTokTotal+=myRagTok*myTurns;
    reasonTokTotal+=myReasonTok*myTurns;
    guardTokTotal+=myGuardTok*myTurns;
    guardInTotal+=myGuardIn*myTurns; guardOutTotal+=myGuardOut*myTurns; guardPiiTotal+=myGuardPii*myTurns; guardPolicyTotal+=myGuardPolicy*myTurns;
    toolSchemaTotal+=myToolSchemaOH*myTurns; toolResultTotal+=myToolResultOH*myTurns;
    ragCost+=(myRagTok*myTurns/1e6)*inRate;
    reasonCost+=(myReasonTok*myTurns/1e6)*inRate;
    toolOHCost+=((myToolSchemaOH+myToolResultOH)*myTurns/1e6)*inRate;

    const ctxFill=myTotalIn/m.ctx;
    let mySumm=0;
    if(ctxFill>0.7 && provider.in_mult!==0){
      const overflow=Math.min(1,(ctxFill-0.7)/0.3);
      const summTokens=myTotalIn*0.30*overflow;
      mySumm=(summTokens/1e6)*inRate+(summTokens*0.3/1e6)*outRate;
      summarisationCost+=mySumm;
    }
    // Agent activation rate — fraction of queries the agent actually
    // runs on. Sim-side stores as percent 0-100 (slider direct value);
    // engine-side workload.agents.activation_rate is 0-1. The mirror
    // function converts. Default 1.0 (always runs) when not set.
    const _aRatePct=Number(agent.activation_rate);
    const _aRate=Number.isFinite(_aRatePct)&&_aRatePct>=0&&_aRatePct<=100?_aRatePct/100:1.0;
    const myNet=(myModelCost+guardBaseCost+myGuardWaste+mySumm+myFixed)*_aRate;
    agentBreakdown.push({name:agent.name,role:agent.role,model:usedModel,provider:provider.label,col:agent.col||m.color,netCost:myNet,totalIn:myTotalIn*_aRate,totalOut:myTotalOut*_aRate,turns:myTurns,cacheReadTok:myCacheReadTok*_aRate,cacheWriteTok:myCacheWriteTok*_aRate,cacheSave:myCacheSave*_aRate,batchSave:myBatchSave*_aRate,pricingTier:tierInfo.tier,source:m.source||'',activeRate:_aRate});
    // Eq. 7 pipeline cumulative-output tracking. Accumulate this agent's
    // UNCLAMPED per-turn output (rawTurnOut), not the maxOut-truncated
    // turnOut — the clamp is a UI safety on what the model is asked to
    // produce, not a real limit on what would be concatenated into the
    // next stage's input in production. Per-turn average matches the
    // paper's Σ avg_output_tokens_i.
    pipelineCumulativeOutTok += rawTurnOut;
  });

  const ragQueries=agentsToProcess.reduce((s,a)=>s+((a.ragOn?(a.rag_calls??cfg('s-rag-calls')):0)*baseTurns),0);
  const ragEmbedTok=(cfg('s-rag-query')||0)*ragQueries;
  const ragEmbedCost=(ragEmbedTok/1e6)*EMBEDDING_RATE;
  // Per-provider tool fees: walk each agent and apply that agent's provider+family fee schedule.
  // webSearchCalls/fileSearchCalls are PER-TURN globals; containerSessions is PER-SESSION global.
  // Container sessions are amortised across agents so total still equals the configured value.
  const wsPerTurn=cfg('s-websearch-calls'), fsPerTurn=cfg('s-filesearch-calls'), containerSess=cfg('s-container-sessions');
  let webSearchCallsTotal=0, fileSearchCallsTotal=0, toolFeeCost=0;
  let toolFeeBreakdown=[];
  agentsToProcess.forEach(agent=>{
    const usedModel=overrideModel?mk:agent.model;
    const m=MODELS[usedModel]||MODELS['claude-sonnet-4.6'];
    const provider=providerForAgent(agent,usedModel,overrideModel);
    const fees=feesFor(agent.provider||(m.providerDefault||'managed'), m.family||'other');
    const myTurns=Math.max(1,Math.round(baseTurns*(agent.turnsShare||1.0)));
    const myWS=wsPerTurn*myTurns;
    const myFS=fsPerTurn*myTurns;
    const myContainer=containerSess/agentCount; // amortise across agents
    const myFee=(myWS/1000)*fees.webSearchPer1k + (myFS/1000)*fees.fileSearchPer1k + myContainer*fees.container1GBSession;
    webSearchCallsTotal+=myWS; fileSearchCallsTotal+=myFS;
    toolFeeCost+=myFee;
    toolFeeBreakdown.push({agent:agent.name, provider:agent.provider||'managed', family:m.family||'other', feeKey:toolFeeKey(agent.provider||'managed',m.family||'other'), myFee, myWS, myFS, myContainer});
  });
  const webSearchCalls=webSearchCallsTotal;
  const fileSearchCalls=fileSearchCallsTotal;
  const containerSessions=containerSess;
  const burstPenalty=peakRatio>2?baseCost*0.05*(peakRatio-2):0;
  let netCost=baseCost+retryWaste+totalGuardCost+ragEmbedCost+summarisationCost+fixedMonthly+burstPenalty+toolFeeCost;
  // Workflow mode adds sequential chain, doc ingestion, rerun, fact-check sidecar, template amortization, pause storage
  let workflowExtra = {extraCost:0, breakdown:{}};
  try{
    if(typeof workflowExtensions==='function' && typeof executionMode!=='undefined' && executionMode==='workflow'){
      workflowExtra = workflowExtensions({baseCost, totalIn}, agentsToProcess);
      netCost += workflowExtra.extraCost;
      const concurrencyExtra = concurrencyExtensions({baseCost, totalIn}, agentsToProcess);
      netCost += concurrencyExtra.extraCost;
      workflowExtra.concurrency = concurrencyExtra
    }
  }catch(e){console.warn('workflow extensions error', e);}

  return {
    totalIn,totalOut,cacheIn:cacheReadTok+cacheWriteTok,cacheReadTok,cacheWriteTok,cacheSave,batchSave,
    retryWaste,ragCost,reasonCost,guardCost:totalGuardCost,totalGuardCost,guardWaste,
    toolOHCost,toolSchemaOH:toolSchemaTotal,toolResultOH:toolResultTotal,toolFeeCost,
    ragEmbedTok,ragEmbedCost,summarisationCost,fixedMonthly,burstPenalty,modelApiCost,
    ragTokPerTurn:ragTokTotal/Math.max(1,baseTurns*agentCount),
    reasonTokPerTurn:reasonTokTotal/Math.max(1,baseTurns*agentCount),
    guardTokPerTurn:guardTokTotal/Math.max(1,baseTurns*agentCount),
    guardInTokPerTurn:guardInTotal/Math.max(1,baseTurns*agentCount),
    guardOutTokPerTurn:guardOutTotal/Math.max(1,baseTurns*agentCount),
    guardPiiTokPerTurn:guardPiiTotal/Math.max(1,baseTurns*agentCount),
    guardPolicyTokPerTurn:guardPolicyTotal/Math.max(1,baseTurns*agentCount),
    toolSchemaTokPerTurn:toolSchemaTotal/Math.max(1,baseTurns*agentCount),
    toolResultTokPerTurn:toolResultTotal/Math.max(1,baseTurns*agentCount),
    turnIn:totalIn/Math.max(1,baseTurns*agentCount),turnOut:totalOut/Math.max(1,baseTurns*agentCount),
    baseCost,netCost,sysTurnTok:sysTokGlobal/Math.max(1,baseTurns),iaMsgOH:iaMsg,
    ragChunksTok:ragTokTotal/Math.max(1,baseTurns*agentCount),modelsTouched:Object.keys(modelTouched),agentCount,agentBreakdown,toolFeeBreakdown,workflowExtra:workflowExtra||{extraCost:0,breakdown:{}}
  };
}

function buildLedger(mk){
  const c=computeCost(mk||selectedModel);
  const items=[
    {label:'System prompt',tok:Math.round(c.sysTurnTok),color:'#42a5f5'},
    {label:'User message',tok:200,color:'#c8d8f0'},
    {label:'Conversation history',tok:Math.round(c.turnIn*.25),color:'rgba(180,200,230,.4)'},
    {label:'RAG chunks',tok:Math.round(c.ragTokPerTurn),color:'#7c4dff'},
    {label:'Extended thinking',tok:Math.round(c.reasonTokPerTurn*.7),color:'#00bcd4'},
    {label:'CoT + fact-check',tok:Math.round(c.reasonTokPerTurn*.3),color:'#00838f'},
    {label:'Tool schemas',tok:Math.round(c.toolSchemaTokPerTurn),color:'#ce93d8'},
    {label:'Tool results',tok:Math.round(c.toolResultTokPerTurn),color:'#ab47bc'},
    {label:'Guardrail input',tok:Math.round(c.guardInTokPerTurn),color:'#ff6d00'},
    {label:'Guardrail output',tok:Math.round(c.guardOutTokPerTurn),color:'#e65100'},
    {label:'PII scan',tok:Math.round(c.guardPiiTokPerTurn),color:'#bf360c'},
    {label:'Policy classifier',tok:Math.round(c.guardPolicyTokPerTurn),color:'#ff8f00'},
    {label:'Few-shot examples',tok:cfg('s-fewshot')*250,color:'#1565c0'},
    {label:'JSON schema',tok:cfg('s-jsonschema'),color:'#0d47a1'},
    {label:'Memory / persistent',tok:cfg('s-memory'),color:'#42a5f5'},
    {label:'Image tokens',tok:cfg('s-images')*1568,color:'#ad1457'},
    {label:'Audio tokens (STT)',tok:cfg('s-audio')*25,color:'#880e4f'},
    {label:'PDF tokens',tok:cfg('s-pdf')*1500,color:'#c2185b'},
    {label:'Code interp output',tok:cfg('s-codeinterp'),color:'#f48fb1'},
    {label:'IA msg overhead',tok:c.iaMsgOH,color:'#4dd0e1'},
    {label:'Output tokens',tok:Math.round(c.turnOut),color:'#00e676'},
    {label:'Citation overhead',tok:cfg('s-citations'),color:'#558b2f'},
  ].filter(x=>x.tok>0);
  return items;
}
function renderLedger(){
  const items=buildLedger();
  const total=items.reduce((s,x)=>s+x.tok,0)||1;
  const maxTok=Math.max(...items.map(x=>x.tok));
  const el=document.getElementById('token-ledger');
  if(!el)return;
  el.innerHTML=items.map(item=>`
    <div class="ledger-entry">
      <div class="ledger-label">${item.label}</div>
      <div style="flex:1;height:6px;background:var(--track);border-radius:3px;overflow:hidden">
        <div class="ledger-bar" style="width:${Math.max(2,Math.round(item.tok/maxTok*100))}%;background:${item.color}cc"></div>
      </div>
      <div class="ledger-val" style="color:${item.color}">${item.tok.toLocaleString()}</div>
      <div style="font-size:7px;color:var(--dimmer);min-width:28px;text-align:right">${(item.tok/total*100).toFixed(0)}%</div>
    </div>`).join('');
  // Stack viz
  const sv=document.getElementById('tok-stack-viz');
  const sl=document.getElementById('tok-stack-legend');
  if(sv){sv.innerHTML=items.map(i=>`<div style="flex:${i.tok};background:${i.color}cc;min-width:${i.tok>0?'2px':'0'}" title="${i.label}: ${i.tok}t"></div>`).join('');}
  if(sl){sl.innerHTML=items.map(i=>`<span style="display:flex;align-items:center;gap:2px;color:${i.color}"><span style="width:8px;height:8px;background:${i.color};border-radius:2px;display:inline-block;flex-shrink:0"></span>${i.label}: ${i.tok.toLocaleString()}</span>`).join('');}
  document.getElementById('ledger-turn').textContent='turn ~'+cfg('s-turns');
  // Mini ledger in sim tab
  const ml=document.getElementById('mini-ledger');
  if(ml)ml.innerHTML=items.slice(0,6).map(i=>`<div style="display:flex;justify-content:space-between"><span style="color:${i.color}">${i.label.substring(0,14)}</span><span style="color:${i.color};font-weight:700">${i.tok.toLocaleString()}t</span></div>`).join('');
  updateTokenCards();
  buildTokenChart(items);
  buildCIChart();
}
function updateTokenCards(){
  const c=computeCost();const nT=cfg('s-turns'),nA=c.agentCount||cfg('s-agents')||1;
  document.getElementById('tt-sys').textContent=(Math.round(c.sysTurnTok)*nT*nA).toLocaleString();
  document.getElementById('tt-hist').textContent=Math.round(c.totalIn*.2).toLocaleString();
  document.getElementById('tt-rag').textContent=Math.round(c.ragTokPerTurn*nT*nA).toLocaleString();
  document.getElementById('tt-reason').textContent=Math.round(c.reasonTokPerTurn*nT*nA).toLocaleString();
  document.getElementById('tt-guard').textContent=Math.round(c.guardTokPerTurn*nT*nA).toLocaleString();
  document.getElementById('tt-tools').textContent=Math.round(c.toolSchemaOH+c.toolResultOH).toLocaleString();
  const ragTokEl=document.getElementById('rag-tok-summary');if(ragTokEl)ragTokEl.textContent=Math.round(c.ragTokPerTurn).toLocaleString();
  const ragPctEl=document.getElementById('rag-pct');if(ragPctEl)ragPctEl.textContent=c.turnIn>0?Math.round(c.ragTokPerTurn/c.turnIn*100)+'%':'0%';
  const ragCostEl=document.getElementById('rag-embed-cost');if(ragCostEl)ragCostEl.textContent='$'+(c.ragEmbedCost||0).toFixed(5);
  const rTokEl=document.getElementById('reason-tok-summary');if(rTokEl)rTokEl.textContent=Math.round(c.reasonTokPerTurn).toLocaleString();
  const rCostEl=document.getElementById('reason-cost');if(rCostEl)rCostEl.textContent='$'+(c.reasonCost||0).toFixed(5);
  const gTokEl=document.getElementById('guard-tok-summary');if(gTokEl)gTokEl.textContent=Math.round(c.guardTokPerTurn).toLocaleString();
  const gCostEl=document.getElementById('guard-cost');if(gCostEl)gCostEl.textContent='$'+(c.totalGuardCost||0).toFixed(5);
  const gWasteEl=document.getElementById('guard-waste');if(gWasteEl)gWasteEl.textContent='$'+(c.guardWaste||0).toFixed(5);
  const tf=document.getElementById('tool-fee-cost');if(tf)tf.textContent='$'+(c.toolFeeCost||0).toFixed(5);
}

let charts={};
function buildTokenChart(items){
  const ctx=document.getElementById('chart-tokens');if(!ctx)return;
  if(charts.tokens)charts.tokens.destroy();
  const labels=Array.from({length:Math.min(cfg('s-turns'),8)},(_,i)=>'T'+(i+1));
  const datasets=items.slice(0,8).map(item=>({label:item.label,data:labels.map((_,i)=>Math.round(item.tok*(0.9+i*.02))),backgroundColor:item.color+'88',borderColor:item.color,borderWidth:1,stack:'tok'}));
  charts.tokens=new Chart(ctx.getContext('2d'),{type:'bar',data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{stacked:true,grid:{color:getChartColors().grid},ticks:{color:getChartColors().tick,font:{size:8}}},y:{stacked:true,grid:{color:getChartColors().grid},ticks:{color:getChartColors().tick,font:{size:8}}}}}});
  // Breakdown table
  const total=items.reduce((s,x)=>s+x.tok,0)||1;
  const bd=document.getElementById('token-breakdown-table');
  if(bd)bd.innerHTML=items.map(i=>`<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--b)"><span style="color:${i.color}">${i.label}</span><span style="font-weight:700;color:${i.color}">${i.tok.toLocaleString()}t (${(i.tok/total*100).toFixed(0)}%)</span></div>`).join('');
}
function buildCIChart(){
  const ctx=document.getElementById('chart-ci');if(!ctx)return;
  if(charts.ci)charts.ci.destroy();
  const base=computeCost().netCost;const cv=wCV();
  const sigma=Math.sqrt(Math.log(1+cv*cv));const mu=Math.log(Math.max(base,1e-10))-sigma*sigma/2;
  const points=80;const xVals=Array.from({length:points},(_,i)=>base*0.1+i*(base*5/points));
  const yVals=xVals.map(x=>{if(x<=0)return 0;const z=(Math.log(x)-mu)/sigma;return (1/(x*sigma*Math.sqrt(2*Math.PI)))*Math.exp(-.5*z*z);});
  const maxY=Math.max(...yVals);
  const p90v=p90(base),p99v=p99(base);
  const bgColors=xVals.map(x=>x<=base?'rgba(0,230,118,.4)':x<=p90v?'rgba(255,171,64,.4)':'rgba(255,82,82,.35)');
  charts.ci=new Chart(ctx.getContext('2d'),{type:'bar',data:{labels:xVals.map(x=>'$'+x.toFixed(4)),datasets:[{data:yVals,backgroundColor:bgColors,borderWidth:0,barPercentage:1,categoryPercentage:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:false}}}});
  const stats=document.getElementById('ci-stats');
  if(stats){
    // Each percentile gets a data-tip explaining what it means and why
    // a procurement reviewer cares. p90 is the most important — it's
    // the number to budget against; p50 is dangerously optimistic.
    const tips = {
      'p50 (expected)': '### p50 — median cost per session\n\nHalf your real sessions cost less than this, half cost more. The **central estimate** — what you would quote if asked for "the expected number".\n\n**Why it matters for budget defense:** if you size your envelope to p50, you blow it half the time. p50 is the headline, not the budget. Use it to communicate the typical case; budget against p90.',
      'p75':            '### p75 — 75th percentile\n\nThree in four sessions cost less than this; one in four cost more. Useful when you can tolerate being over budget ~25% of the time (rare in procurement, more common for internal R&D).\n\nLess load-bearing than p90 for production deployments — usually skipped in formal cost defenses but informative for understanding the shape between median and tail.',
      'p90 (budget risk)': '### p90 — the procurement number\n\nNine in ten sessions cost less than this; one in ten will exceed it. **This is the number you bring to the budget defense:** "central estimate $X, p90 worst-case $Y".\n\n**Why it matters:** budgets sized at p50 fail half the time. Budgets sized at p90 fail 10% of the time — manageable, defensible, gives you 9 good months for every 1 over-the-line month. The standard procurement convention for stochastic cost models.',
      'p99 (heuristic tail)': '### p99 — tail risk (heuristic)\n\nOne in 100 sessions could spike this high. Useful for **stress-testing daily caps** — if your $/day cutoff is below p99, occasional power users will get cut off mid-session.\n\n**Why "heuristic":** at p99 the lognormal-distribution assumption starts to diverge from real-world traffic (which has fatter tails from outliers like crawlers, runaway loops, or query-storming bots). Treat p99 as an approximate upper bound, not a literal forecast.',
      'CV (variance)':  '### CV — coefficient of variation\n\nStandard deviation divided by mean, expressed as %. Measures how volatile your $/session is.\n\n**Reading the number:**\n- **<20%** — tight, predictable bill. Most internal workloads with stable traffic.\n- **40–60%** — typical for public-facing chatbots (some short questions, some long).\n- **>100%** — highly volatile (multi-modal traffic, viral spikes). Hard to budget; size envelopes against p99 not p90.\n\nHigh CV means your monthly bill swings month-to-month even at constant MAU. Procurement reviewers should ask why if it exceeds 60%.'
    };
    const escTip = s => String(s||'').replace(/"/g,'&quot;');
    stats.innerHTML=[
      ['p50 (expected)','$'+p50(base).toFixed(5),'var(--green)'],
      ['p75','$'+lnPct(base,.674).toFixed(5),'var(--teal)'],
      ['p90 (budget risk)','$'+p90v.toFixed(5),'var(--amber)'],
      ['p99 (heuristic tail)','$'+p99v.toFixed(5),'var(--red)'],
      ['CV (variance)',( cv*100).toFixed(0)+'%','var(--dimmer)']
    ].map(([l,v,c])=>`<span data-tip="${escTip(tips[l])}" style="color:${c};cursor:help;border-bottom:1px dotted rgba(120,120,120,.45)">${l}</span>: <b style="color:${c}">${v}</b>`).join(' &nbsp;·&nbsp; ');
  }
}

/* ═══════ COST PANEL ═══════ */
function renderPerAgentCost(){
  const el=document.getElementById('per-agent-cost-table');if(!el)return;
  const sumEl=document.getElementById('agent-cost-summary');
  const sc=computeCost();
  const breakdown=(sc.agentBreakdown||[]).slice().sort((a,b)=>b.netCost-a.netCost);
  if(!breakdown.length){el.innerHTML='<div style="font-size:8px;color:var(--dim)">No agents configured.</div>';return;}
  const total=breakdown.reduce((s,x)=>s+x.netCost,0)||1;
  const max=Math.max(...breakdown.map(x=>x.netCost),0.0001);
  el.innerHTML=breakdown.map(x=>{
    const m=MODELS[x.model]||MODELS['claude-sonnet-4.6'];
    return `<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--b)">
      <div style="width:36px;flex-shrink:0;font-weight:700;color:${x.col};font-size:9px">${x.name}</div>
      <div style="font-size:8px;color:var(--dim);min-width:120px">${x.role} · ${(m.label||x.model).substring(0,22)}</div>
      <div style="font-size:7px;color:var(--dimmer);min-width:86px">${x.provider} · ${x.pricingTier||'standard'}</div>
      <div style="flex:1;height:8px;background:var(--track);border-radius:3px;overflow:hidden"><div style="width:${Math.max(2,Math.round(x.netCost/max*100))}%;height:100%;background:${x.col}cc;border-radius:3px"></div></div>
      <div style="width:80px;text-align:right;font-size:9px;font-weight:700;color:${x.col}">${x.netCost.toFixed(5)}</div>
      <div style="width:40px;text-align:right;font-size:7px;color:var(--dim)">${(x.netCost/total*100).toFixed(0)}%</div>
    </div>`;
  }).join('');
  const heteroCost=sc.netCost;
  const sonnetCost=computeCost('claude-sonnet-4.6').netCost;
  const savings=sonnetCost>0?((sonnetCost-heteroCost)/sonnetCost*100):0;
  const dominant=breakdown[0];
  if(sumEl){sumEl.innerHTML=`<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:8px">
    <span>Heterogeneous fleet cost: <b style="color:var(--green)">${heteroCost.toFixed(5)}</b>/sess</span>
    <span>Uniform Sonnet equivalent: <b style="color:var(--cyan)">${sonnetCost.toFixed(5)}</b>/sess</span>
    <span>Delta vs uniform: <b style="color:${savings>0?'var(--green)':'var(--red)'}">${savings>=0?'-':'+'}${Math.abs(savings).toFixed(1)}%</b></span>
    <span>Top driver: <b style="color:${dominant?.col||'var(--cyan)'}">${dominant?.name||'-'}</b> (${dominant?(dominant.netCost/total*100).toFixed(0):0}%)</span>
  </div>`;}
}

function updateCostPanel(){renderPerAgentCost();
  const sess=cfg('s-sessions'),monthly=sess*30;
  const costs=MK.map(k=>({k,c:computeCost(k)}));
  document.getElementById('cost-table-body').innerHTML=costs.map(({k,c})=>{
    const m=MODELS[k];
    return `<tr><td><span class="mpill" style="background:${m.color}14;color:${m.color};border:1px solid ${m.color}28">${(m.label||k).substring(0,18)}</span></td>
    <td style="color:var(--green)">${(c.baseCost||0).toFixed(5)}</td>
    <td style="color:var(--rag)">${(c.ragCost||0).toFixed(5)}</td>
    <td style="color:var(--reason)">${(c.reasonCost||0).toFixed(5)}</td>
    <td style="color:var(--guard)">+${(c.totalGuardCost||0).toFixed(5)}</td>
    <td style="color:var(--purple)">${(c.toolOHCost||0).toFixed(5)}</td>
    <td style="color:var(--purple)">+${(c.toolFeeCost||0).toFixed(5)}</td>
    <td style="color:var(--green)">${(c.cacheSave||0).toFixed(5)}</td>
    <td style="color:var(--red)">+${(c.retryWaste||0).toFixed(5)}</td>
    <td style="color:var(--green);font-weight:700">${(c.netCost||0).toFixed(4)}</td>
    <td style="color:var(--amber)">${p90(c.netCost).toFixed(4)}</td>
    <td style="color:var(--red)">${p99(c.netCost).toFixed(4)}</td></tr>`;
  }).join('');
  const sc=computeCost();
  const compItems=[
    ['Model API total',sc.baseCost,'var(--dim)'],['RAG token share',sc.ragCost,'#7c4dff'],['RAG embedding',sc.ragEmbedCost,'#7c4dff'],
    ['Extended thinking',sc.reasonCost,'#00bcd4'],['Guardrails',sc.totalGuardCost,'#ff6d00'],['Guard block waste',sc.guardWaste,'#ff5252'],
    ['Tool token share',sc.toolOHCost,'#ce93d8'],['External tool fees',sc.toolFeeCost,'#ab47bc'],['Summarisation',sc.summarisationCost,'#42a5f5'],
    ['Burst penalty',sc.burstPenalty,'#ffab40'],['Fixed monthly amort.',sc.fixedMonthly,'#ffd54f'],['Retry waste',sc.retryWaste,'#ff5252'],
    ['Cache saved',-sc.cacheSave,'#00e676'],['Batch saved',-sc.batchSave,'#c6ff00']
  ].filter(([,v])=>Math.abs(v)>0);
  const maxBase=Math.max(...compItems.map(([,v])=>Math.abs(v)),0.0001);
  document.getElementById('component-bars').innerHTML=compItems.map(([l,v,c])=>{
    const pct=Math.min(100,Math.abs(v)/maxBase*100);
    return `<div class="bar-row"><span class="bar-label">${l}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2,pct)}%;background:${c}cc"></div></div><span class="bar-num" style="color:${c}">${v>=0?'+':''}$${v.toFixed(5)}</span></div>`;
  }).join('');
  document.getElementById('cost-breakdown').innerHTML=[
    ['Model API cost','$'+(sc.baseCost||0).toFixed(5),'var(--dim)'],['RAG token share','$'+(sc.ragCost||0).toFixed(5),'#7c4dff'],['RAG embedding','+$'+(sc.ragEmbedCost||0).toFixed(5),'#7c4dff'],
    ['Reasoning token share','$'+(sc.reasonCost||0).toFixed(5),'#00bcd4'],['Guardrail cost','+$'+(sc.totalGuardCost||0).toFixed(5),'#ff6d00'],['Tool token share','$'+(sc.toolOHCost||0).toFixed(5),'#ce93d8'],
    ['External tool fees','+$'+(sc.toolFeeCost||0).toFixed(5),'#ab47bc'],['Retry waste','+$'+(sc.retryWaste||0).toFixed(5),'#ff5252'],['Summarisation','+$'+(sc.summarisationCost||0).toFixed(5),'#42a5f5'],
    ['Burst penalty','+$'+(sc.burstPenalty||0).toFixed(5),'#ffab40'],['Fixed monthly amort.','+$'+(sc.fixedMonthly||0).toFixed(5),'#ffd54f'],['Cache read/write tokens',Math.round(sc.cacheReadTok).toLocaleString()+' read / '+Math.round(sc.cacheWriteTok).toLocaleString()+' write','#00e676'],
    ['Cache savings vs list','$'+(sc.cacheSave||0).toFixed(5),'#00e676'],['Batch savings vs list','$'+(sc.batchSave||0).toFixed(5),'#c6ff00'],['NET per session','$'+(sc.netCost||0).toFixed(5),'#00d4ff'],
    ['Monthly p50','$'+Math.round(sc.netCost*monthly).toLocaleString(),'#00e676'],['Monthly p90','$'+Math.round(p90(sc.netCost*monthly)).toLocaleString(),'#ffab40'],['Monthly p99','$'+Math.round(p99(sc.netCost*monthly)).toLocaleString(),'#ff5252'],
    ['── WORKFLOW EXTRAS ──','','var(--cyan)'],
    ['Sequential chain','$'+((sc.workflowExtra?.breakdown?.sequentialChainCost)||0).toFixed(5),'var(--cyan)'],
    ['Document ingestion','$'+((sc.workflowExtra?.breakdown?.documentIngestionCost)||0).toFixed(5),'#f48fb1'],
    ['Partial rerun cost','$'+((sc.workflowExtra?.breakdown?.partialRerunCost)||0).toFixed(5),'var(--amber)'],
    ['Template amortization','$'+((sc.workflowExtra?.breakdown?.templateAmortDelta)||0).toFixed(5),'var(--green)'],
    ['HITL pause storage','$'+((sc.workflowExtra?.breakdown?.hitlPauseCost)||0).toFixed(7),'var(--gold)'],
    ['── DAG TOPOLOGY ──','','var(--purple)'],
    ['Concurrent usage',((sc.workflowExtra?.concurrency?.breakdown?.concurrentUsage)||0)+' / '+(parseInt(document.getElementById('s-concurrent-quota')?.value)||0)+' quota','var(--purple)'],
    ['Quota utilization',((sc.workflowExtra?.concurrency?.breakdown?.quotaUtilization)||0)+'%','var(--purple)'],
    ['Rate limit overage','$'+((sc.workflowExtra?.concurrency?.breakdown?.rateLimitOverageCost)||0).toFixed(5),'var(--red)'],
    ['Quota exceeded penalty','$'+((sc.workflowExtra?.concurrency?.breakdown?.quotaExceededCost)||0).toFixed(5),'var(--red)'],
  ].map(([l,v,c])=>`<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--b)"><span style="color:var(--dim)">${l}</span><span style="color:${c};font-weight:700">${v}</span></div>`).join('');
  const budget=parseFloat(document.getElementById('budget-input').value)||999999;
  // Compare against the all-in headline (LLM + infra + verification +
  // federal + personnel + agent-engineering + embedding) when app.js has
  // published it, so the badge tracks what the user actually sees in the
  // cost-pill. Fall back to LLM-only on initial paint when the headline
  // hasn't been computed yet.
  const projMo=(typeof window!=='undefined' && typeof window.__lastHeadlineMonthly==='number')
    ? window.__lastHeadlineMonthly
    : sc.netCost*monthly;
  const bs=document.getElementById('budget-status');const bw=document.getElementById('warn-budget');
  if(projMo>budget){bs.textContent='OVER';bs.className='badge-warn';if(bw)bw.className='warn-banner show';}
  else{bs.textContent='OK';bs.className='badge-ok';if(bw)bw.className='warn-banner';}
  budgetSuggest(sc, monthly, budget, projMo);
  buildProjChart();
}

/* Budget heuristic optimizer — when projected monthly > budget, list
   specific knob adjustments ranked by $ savings/month. Pure deterministic
   rules over the per-component cost the engine already exposes. */
function budgetSuggest(sc, monthly, budget, projMoOverride){
  const wrap=document.getElementById('budget-suggestions');
  const list=document.getElementById('budget-suggest-list');
  if(!wrap||!list)return;
  // Prefer the all-in headline passed in from the caller (matches the
  // budget badge); fall back to LLM-only for callers that haven't been
  // updated yet.
  const projMo=(typeof projMoOverride==='number')?projMoOverride:(sc.netCost||0)*monthly;
  if(projMo<=budget){wrap.style.display='none';return;}
  const overBy=projMo-budget;
  const sugg=[];
  // Cache hit rate — every 5pp ≈ 4-9% input cost reduction depending on share.
  const cacheNow=cfg('s-cache');
  if(cacheNow<85){
    const target=Math.min(85,cacheNow+15);
    const inputShare=Math.max(0.4,(sc.baseCost||0)*0.85/Math.max(sc.netCost||1e-9,1e-9));
    const saveFrac=(target-cacheNow)/100*0.85*inputShare;
    sugg.push({s:saveFrac*projMo,t:`Bump <b>Cache hit rate</b> ${cacheNow}% → ${target}%`});
  }
  // Sonnet → Haiku swap on Agent 1.
  if(sim.agents&&sim.agents[0]&&MODELS[sim.agents[0].model]){
    const cur=MODELS[sim.agents[0].model];
    const haiku=MODELS['claude-haiku-4.5'];
    if(haiku&&cur&&(cur.in||0)>(haiku.in||0)*1.5){
      const ratio=(haiku.in/Math.max(cur.in,0.01)+haiku.out/Math.max(cur.out,0.01))/2;
      const saveFrac=(1-ratio)*((sc.baseCost||0)/Math.max(sc.netCost||1e-9,1e-9));
      sugg.push({s:saveFrac*projMo,t:`Switch <b>Agent 1 model</b> ${cur.label||sim.agents[0].model} → Haiku 4.5`});
    }
  }
  // RAG chunks reduction.
  const chunksNow=cfg('s-rag-chunks');
  if(chunksNow>5&&(sc.ragCost||0)>0){
    const target=Math.max(3,Math.round(chunksNow*0.6));
    const saveFrac=(chunksNow-target)/Math.max(chunksNow,1)*((sc.ragCost||0)/Math.max(sc.netCost||1e-9,1e-9));
    sugg.push({s:saveFrac*projMo,t:`Reduce <b>Chunks retrieved</b> ${chunksNow} → ${target}`});
  }
  // Batch async opportunity.
  const batchNow=cfg('s-batch');
  if(batchNow<30){
    const saveFrac=0.30*0.5*((sc.baseCost||0)/Math.max(sc.netCost||1e-9,1e-9));
    sugg.push({s:saveFrac*projMo,t:`Route <b>30% of traffic to batch tier</b> (50% cheaper) — only suitable for offline/non-interactive use`});
  }
  // Retry rate.
  const retryNow=cfg('s-retry');
  if(retryNow>3){
    const saveFrac=(retryNow-3)/100*0.7*((sc.baseCost||0)/Math.max(sc.netCost||1e-9,1e-9));
    sugg.push({s:saveFrac*projMo,t:`Drive <b>Retry rate</b> ${retryNow}% → 3% via better rate-limit handling`});
  }
  // Reasoning %.
  const thinkPct=cfg('s-think-pct');
  if(thinkPct>20&&(sc.reasonCost||0)>0){
    const target=Math.max(5,Math.round(thinkPct*0.4));
    const saveFrac=(thinkPct-target)/Math.max(thinkPct,1)*((sc.reasonCost||0)/Math.max(sc.netCost||1e-9,1e-9));
    sugg.push({s:saveFrac*projMo,t:`Drop <b>Reasoning % of turns</b> ${thinkPct}% → ${target}% (only use thinking on hard queries)`});
  }
  // Sort by $ savings, take top 4.
  sugg.sort((a,b)=>b.s-a.s);
  const top=sugg.filter(x=>x.s>1).slice(0,4);
  if(!top.length){
    list.innerHTML=`Projected <b style="color:var(--red)">$${Math.round(projMo).toLocaleString()}/mo</b> exceeds budget <b>$${Math.round(budget).toLocaleString()}/mo</b> by <b style="color:var(--red)">$${Math.round(overBy).toLocaleString()}</b>. No clear single-knob savings — consider raising the budget or reviewing scale (concurrent users, sessions/day).`;
  }else{
    const rows=top.map(x=>`<li style="margin-bottom:3px"><span style="color:var(--green);font-weight:700">~ -$${Math.round(x.s).toLocaleString()}/mo</span> &nbsp; ${x.t}</li>`).join('');
    list.innerHTML=`Projected <b style="color:var(--red)">$${Math.round(projMo).toLocaleString()}/mo</b> vs budget <b>$${Math.round(budget).toLocaleString()}/mo</b> &nbsp;·&nbsp; over by <b style="color:var(--red)">$${Math.round(overBy).toLocaleString()}</b>.<ul style="margin:6px 0 0 16px;padding:0;list-style:disc">${rows}</ul>`;
  }
  wrap.style.display='block';
}

/* Basic/Advanced toggle removed 2026-05-18. The toggle was hiding 7 real
   cost drivers (cache write share, batch async, context compression,
   retry rate, peak/avg ratio, language multiplier, comm pattern). Each
   one can move the bill by 20-50%; hiding them risked under-quoting.
   The .sr-advanced/.panel-advanced/.block-advanced classes on individual
   elements are now no-ops (kept for HTML stability; safe to remove later
   if anyone touches those elements). The ccs-config-mode localStorage
   key may still be set on returning users' browsers — harmless leftover,
   nothing reads it. */
function buildProjChart(){
  const ctx=document.getElementById('chart-proj');if(!ctx)return;
  if(charts.proj)charts.proj.destroy();
  const growth=cfg('s-growth')/100;const labels=Array.from({length:12},(_,i)=>'M'+(i+1));
  const sess=cfg('s-sessions');const topM=[['claude-sonnet-4.6','Sonnet'],['gpt-5.4','GPT-5.4'],['gemini-3-flash-preview','Gemini 3 Flash']];
  const ds=[];
  topM.forEach(([k,l])=>{const m=MODELS[k];const base=computeCost(k).netCost;const monthly=sess*30;
    const p50d=Array.from({length:12},(_,i)=>Math.round(base*monthly*Math.pow(1+growth,i)));
    const p90d=p50d.map(v=>Math.round(p90(v)));
    ds.push({label:l+' p50',data:p50d,borderColor:m.color,backgroundColor:m.color+'12',borderWidth:2,tension:.35,fill:false,pointRadius:3});
    ds.push({label:l+' p90',data:p90d,borderColor:m.color+'66',borderDash:[4,3],borderWidth:1,tension:.35,fill:false,pointRadius:0});
  });
  charts.proj=new Chart(ctx.getContext('2d'),{type:'line',data:{labels,datasets:ds},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:getChartColors().grid},ticks:{color:getChartColors().tick,font:{size:8}}},y:{grid:{color:getChartColors().grid},ticks:{color:getChartColors().tick,font:{size:8},callback:v=>'$'+v.toLocaleString()}}},interaction:{mode:'index',intersect:false}}});
  const leg=document.getElementById('proj-legend');
  if(leg)leg.innerHTML=topM.map(([k,l])=>`<span style="color:${MODELS[k].color}">${l}: p50 solid · p90 dashed</span>`).join(' &nbsp;');
}

/* ═══════ SENSITIVITY ═══════ */
function updateSensitivity(){
  const base=computeCost().netCost;
  const params=[
    {name:'RAG chunks',id:'s-rag-chunks'},{name:'RAG chunk size',id:'s-rag-chunk-size'},{name:'Thinking tokens',id:'s-think-tokens'},
    {name:'Guard input tok',id:'s-guard-in'},{name:'Guard output tok',id:'s-guard-out'},{name:'Cache hit rate',id:'s-cache'},
    {name:'Tool calls/turn',id:'s-tools'},{name:'Tool result tok',id:'s-toolresult'},{name:'Sessions/day',id:'s-sessions'},
    {name:'Retry rate',id:'s-retry'},{name:'Fact-check passes',id:'s-factcheck'},{name:'CoT length',id:'s-cot'},
    {name:'Guard block rate',id:'s-guard-block'},{name:'Batch async %',id:'s-batch'},
  ];
  const results=params.map(p=>{
    const el=document.getElementById(p.id);if(!el)return null;
    const orig=parseFloat(el.value)||0;
    el.value=orig*1.5;const high=computeCost().netCost;
    el.value=orig*0.5;const low=computeCost().netCost;
    el.value=orig;return{...p,impact:Math.abs(high-low),pctH:((high-base)/base*100),pctL:((low-base)/base*100)};
  }).filter(Boolean).sort((a,b)=>b.impact-a.impact);
  const maxI=Math.max(...results.map(r=>r.impact),.0001);
  const tbl=document.getElementById('sensitivity-table');
  if(tbl)tbl.innerHTML=`<div style="font-size:8px;color:var(--dim);margin-bottom:8px">Green = cheaper at +50%, Red = more expensive. Sorted by impact magnitude.</div>`+results.map(r=>`
    <div class="sens-row">
      <span style="color:var(--text-primary,#c8d8f0);font-size:8px">${r.name}</span>
      <span style="color:${r.pctL<0?'var(--green)':'var(--red)'};text-align:right">${r.pctL>0?'+':''}${r.pctL.toFixed(0)}%</span>
      <div style="height:6px;background:var(--track);border-radius:3px;overflow:hidden"><div style="width:${Math.round(r.impact/maxI*100)}%;height:100%;background:${r.pctH>0?'var(--red)':'var(--green)'};border-radius:3px"></div></div>
      <span style="color:${r.pctH>0?'var(--red)':'var(--green)'};text-align:right">${r.pctH>0?'+':''}${r.pctH.toFixed(0)}%</span>
    </div>`).join('');
  buildTornadoChart(results.slice(0,10));
  buildWhatIf(base);
}
function buildTornadoChart(res){
  const ctx=document.getElementById('chart-tornado');if(!ctx)return;
  if(charts.tornado)charts.tornado.destroy();
  charts.tornado=new Chart(ctx.getContext('2d'),{type:'bar',data:{labels:res.map(r=>r.name),datasets:[{label:'-50%',data:res.map(r=>r.pctL),backgroundColor:'rgba(0,230,118,.5)',borderWidth:0},{label:'+50%',data:res.map(r=>r.pctH),backgroundColor:'rgba(255,82,82,.5)',borderWidth:0}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{color:getChartColors().grid},ticks:{color:getChartColors().tick,font:{size:8},callback:v=>v+'%'}},y:{grid:{display:false},ticks:{color:getChartColors().tick,font:{size:8}}}}}});
}
function buildWhatIf(base){
  // `ensure` forces gating flags / dependent values on all agents so a
  // scenario isn't silently no-op'd when the loaded preset disabled the
  // feature. Without it, "Enable 10K thinking" against an agent that
  // has reasonOn=false and think_pct=0 would compute to zero added
  // tokens — the slider would move but nothing downstream would care.
  const scenarios=[
    {name:'Double RAG chunks',   id:'s-rag-chunks',fn:v=>v*2, ensure:{ragOn:true},
      desc:'Doubles the retrieved chunks-per-query knob. Tests sensitivity to retrieval depth — each extra chunk rides along with every prompt as input tokens, so deep-RAG fleets can see this knob dominate the bill. Reads 0% if your preset has chunks=0 (RAG effectively off).'},
    {name:'Enable 10K thinking', multi:[['s-think-tokens',10000],['s-think-pct',50]], ensure:{reasonOn:true},
      desc:'Turns extended thinking on with 10K hidden reasoning tokens at 50% activation. Tests the cost shock of switching from "answer directly" to a thinking/reasoning model — thinking tokens are billed as output but never shown to the user.'},
    {name:'Add full guardrails', multi:[['s-guard-in',500],['s-guard-out',500],['s-guard-pii',200],['s-guard-policy',800]], ensure:{guardOn:true},
      desc:'Adds the four guardrail prompts (input scan, output scan, PII redaction, policy check ≈ 2K tokens total). Tests the overhead of running a full safety stack on every turn — visible mostly on high-volume, low-token-per-turn fleets.'},
    {name:'Cache 80% hit rate',  id:'s-cache',fn:_=>80,
      desc:'Pins prompt-cache hit rate to 80%. Tests the savings ceiling from aggressive caching — cached input tokens bill at 10–25% of full price, so chatty workloads with stable system prompts see large drops.'},
    {name:'50% batch async',     id:'s-batch',fn:_=>50,
      desc:'Routes half of traffic through the provider Batch API (50% discount on most providers). Tests savings if you can defer non-interactive work — useless for real-time chat, big for nightly summarization / ingest pipelines.'},
    {name:'Triple fact-checking',id:'s-factcheck',fn:_=>3, ensure:{reasonOn:true},
      desc:'Runs 3 verification passes per response instead of 1. Tests cost of high-assurance setups (legal, medical, regulated) where you cross-check the answer against multiple verifiers before returning.'},
    {name:'RAG 20 chunks×512t',  multi:[['s-rag-chunks',20],['s-rag-chunk-size',512]], ensure:{ragOn:true},
      desc:'Aggressive retrieval: 20 chunks × 512 tokens = 10K extra input tokens per query. Tests the "throw more context at it" ceiling — common in legal / research / code-search fleets that lean on retrieval over fine-tuning.'},
    {name:'Minimal guardrails',  multi:[['s-guard-in',0],['s-guard-out',0],['s-guard-pii',0],['s-guard-policy',0]],
      desc:'Strips all guardrail prompts. Tests the savings floor if you remove the safety stack — informative bound, not a recommendation. Reads 0% if your preset already has guardrails at zero.'},
  ];
  const el=document.getElementById('whatif-cards');if(!el)return;
  // Slider → agent-field mapping. When an imported preset's agents
  // carry per-agent overrides for a parameter, computeCost reads the
  // per-agent value (`agent.X ?? cfg('s-X')`) and the slider is
  // shadowed. What-if scenarios that only flip the slider would then
  // silently no-op — showing 0% for every scenario except those that
  // touch globals-only knobs (e.g. batch async). Overriding both keeps
  // the scenarios honest regardless of how richly the loaded preset
  // populated its agents.
  const SLIDER_TO_AGENT_FIELD={
    's-rag-chunks':'rag_chunks','s-rag-chunk-size':'rag_size','s-rag-calls':'rag_calls',
    's-think-tokens':'think_tok','s-think-pct':'think_pct','s-cot':'cot','s-factcheck':'factcheck',
    's-cache':'cache_rate',
    's-guard-in':'guard_in','s-guard-out':'guard_out','s-guard-pii':'guard_pii','s-guard-policy':'guard_policy',
    's-tools':'tools_per','s-toolresult':'result','s-schema':'schema',
  };
  function setOne(id,val,sliderSaves,agentSaves){
    const e=document.getElementById(id);
    if(e){sliderSaves[id]=e.value;e.value=val;}
    const f=SLIDER_TO_AGENT_FIELD[id];
    if(f && typeof sim!=='undefined' && Array.isArray(sim.agents)){
      sim.agents.forEach(a=>{
        if(a[f]!==undefined){agentSaves.push([a,f,a[f]]);a[f]=typeof val==='string'?(parseFloat(val)||0):val;}
      });
    }
  }
  function setEnsureFlags(ensure,agentSaves){
    if(!ensure || typeof sim==='undefined' || !Array.isArray(sim.agents)) return;
    sim.agents.forEach(a=>{
      Object.entries(ensure).forEach(([flag,val])=>{
        agentSaves.push([a,flag,a[flag]]);
        a[flag]=val;
      });
    });
  }
  function restoreAll(sliderSaves,agentSaves){
    Object.entries(sliderSaves).forEach(([id,v])=>{const e=document.getElementById(id);if(e)e.value=v;});
    agentSaves.forEach(([a,f,v])=>{a[f]=v;});
  }
  el.innerHTML=scenarios.map(sc=>{
    const sliderSaves={},agentSaves=[];
    let nc;
    setEnsureFlags(sc.ensure,agentSaves);
    if(sc.multi){
      sc.multi.forEach(([id,v])=>setOne(id,v,sliderSaves,agentSaves));
      nc=computeCost().netCost;
    }else{
      const e=document.getElementById(sc.id);
      if(e){
        const newVal=sc.fn(parseFloat(e.value)||0);
        setOne(sc.id,newVal,sliderSaves,agentSaves);
        nc=computeCost().netCost;
      }else nc=base;
    }
    restoreAll(sliderSaves,agentSaves);
    const d=((nc-base)/base*100);const c=d>0?'var(--red)':'var(--green)';
    // Use data-tip so the site's rich JS tooltip widget (markdown, hover-
    // persistent, themed) picks this up instead of the flaky native HTML
    // `title=` (silently swallowed by some browser/OS combos, slow on
    // others, no markdown rendering). The same document-level delegated
    // handler that wires every other tooltip on the page handles this.
    const tip=(sc.desc||'').replace(/"/g,'&quot;');
    const zero=Math.abs(d)<0.05;
    const labelStr=zero
      ? `${sc.name} <span style="color:var(--dimmer);font-weight:400;font-size:7px">· n/a here</span>`
      : sc.name;
    return `<div class="mcard" data-tip="${tip}" style="cursor:help"><div class="mlabel">${labelStr}</div><div style="font-size:14px;font-weight:700;color:${zero?'var(--dim)':c}">${d>0?'+':''}${d.toFixed(1)}%</div><div style="font-size:7px;color:var(--dim);margin-top:2px">${nc.toFixed(5)}/sess</div></div>`;
  }).join('');
}

/* ═══════ TASK BARS ═══════ */
// Tooltips for the workload-mix task-type sliders. Each tip explains
// what the task type represents and references its output multiplier so
// users can reason about cost shifts when reshaping the mix.
const TASK_MIX_TIPS={
  classify:"### Classification queries\nShare of queries that are short-answer / multi-label classification — sentiment, intent, routing decisions, content moderation pre-checks. Output budget ×0.30, the smallest of any task type. Shrinking this slice means fewer cheap queries and more expensive ones, so the average output bill rises non-linearly.",
  summary: "### Summarisation queries\nShare of queries that compress long input into shorter output — meeting notes, document summaries, email digests. Output budget ×0.65 — cheaper than balanced because the input does most of the work. RAG-heavy workloads with summarisation downstream land here.",
  rag:     "### RAG / Retrieval queries\nShare of queries that retrieve context and answer over it — Q&A over docs, semantic-search responses, knowledge-base lookups. Output budget ×0.85, close to baseline because answers are bounded by source material. Note: retrieval *input* tokens are separate (RAG section in agent cards); this slice scales the LLM's *output* budget.",
  code:    "### Code generation queries\nShare of queries that generate code — boilerplate, refactors, full implementations. Output budget ×2.80, expensive because code is verbose and rarely terse. Coding-agent fleets (SWE-bench, Devin-class) sit ~70%+ here; mixed developer tooling sits 15–25%.",
  longform:"### Long-form NLG queries\nShare of queries producing long natural-language output — blog posts, reports, marketing copy, narrative customer responses. Output budget ×3.60, the second-most expensive task type. Customer-facing chatbots producing answers > ~300 tokens land here.",
  agent:   "### Agentic chain queries\nShare of queries that execute multi-step agent loops — plan, act, observe, revise. Output budget ×4.30, the most expensive task type because each user-visible turn expands to multiple LLM calls with cumulative output. ReAct / extended-thinking workloads dominate this slice.",
};
function renderTaskBars(){
  const t=TASK_TYPES.reduce((s,x)=>s+x.pct,0)||1;
  document.getElementById('task-bars').innerHTML=TASK_TYPES.map((x,i)=>{
    const tip=(TASK_MIX_TIPS[x.id]||'').replace(/"/g,'&quot;');
    const tipAttr=tip?` class="sr-label" data-tip="${tip}"`:'';
    return `
    <div style="display:flex;align-items:center;gap:5px;margin-bottom:5px">
      <span${tipAttr} style="font-size:8px;color:${x.color};width:82px;flex-shrink:0;text-align:right">${x.label}</span>
      <input type="range" min="0" max="100" value="${x.pct}" step="5" style="flex:1" aria-label="${x.label} workload mix percentage" oninput="setTask(${i},this.value)">
      <span style="font-size:8px;font-weight:700;min-width:24px;color:${x.color}" id="tp-${i}">${Math.round(x.pct/t*100)}%</span>
      <span style="font-size:7px;color:var(--dimmer);min-width:36px">×${x.outMult}out</span>
    </div>`;
  }).join('');
  const ob=document.getElementById('out-mult-badge');if(ob)ob.textContent='×'+wOM().toFixed(2)+' out';
}
function setTask(i,v){
  TASK_TYPES[i].pct=parseInt(v);
  const t=TASK_TYPES.reduce((s,x)=>s+x.pct,0)||1;
  TASK_TYPES.forEach((x,j)=>{const e=document.getElementById('tp-'+j);if(e)e.textContent=Math.round(x.pct/t*100)+'%';});
  const ob=document.getElementById('out-mult-badge');if(ob)ob.textContent='×'+wOM().toFixed(2)+' out';
  // Persist the mix on workload so (a) the cost engine can scale output
  // tokens via taskMixOutputMultiplier and (b) the URL hash round-trips
  // the slider state on reload. Workload-mode and agent-mode both consume
  // this — the cost engine only applies the multiplier in workload-mode.
  if (window.workload) {
    window.workload.task_mix = Object.fromEntries(TASK_TYPES.map(x=>[x.id,x.pct]));
  }
  onSlider();
  // Force a workload-mode repaint so the headline reflects the new mix.
  // (onSlider only repaints the simulator panel; renderPreview drives the
  // workload-mode cost engine, which is what the headline reads from.)
  if (typeof window.renderPreview === 'function') {
    try { window.renderPreview(); } catch (_) {}
  }
}

/* ═══════ MODEL SELECTOR ═══════ */
function renderModelSelector(){
  const el=document.getElementById('model-selector');
  if(!el)return;
  el.innerHTML=MK.map(k=>{const m=MODELS[k];const sh=(m.label||k).substring(0,22);return `<div id="ms-${k}" style="padding:6px 8px;border-radius:6px;border:1px solid ${k===selectedModel?m.color+'55':'var(--b)'};background:${k===selectedModel?m.color+'12':'rgba(255,255,255,.02)'};cursor:default;transition:all .2s" title="Selected via Agent 1's model dropdown">
    <div style="font-size:8px;font-weight:700;color:${m.color}">${sh}</div>
    <div style="font-size:7px;color:var(--dim,rgba(180,200,230,.5))">${m.in}/${m.out} per 1M</div>
    <div style="font-size:7px;color:var(--dimmer)">${m.status||'current'} · ${m.lat}ms · ${m.tps}t/s</div>
  </div>`;}).join('');
  const mb=document.getElementById('model-sel-badge');if(mb)mb.textContent=selectedModel;
  const mi=document.getElementById('model-info-bar');
  const sm=MODELS[selectedModel];
  if(mi&&sm){const cached=sm.cacheRead!=null?('$'+sm.cacheRead+'/1M cached input'):'no published cache read discount';mi.textContent=`${sm.label||selectedModel} (${sm.api_id||selectedModel}) · ctx:${(sm.ctx/1000).toFixed(0)}k · input:${sm.in}/1M · output:${sm.out}/1M · ${cached} · batch disc:${Math.round((sm.bd||0)*100)}%${sm.longThreshold?' · long tier >'+Math.round(sm.longThreshold/1000)+'k ctx':''} · verified:${MODEL_PRICE_VERIFIED}`;}
}
function selectModel(k){selectedModel=k;renderModelSelector();onSlider();}
/* Architecture-canvas visualization fully removed 2026-05-16. The
   no-op drawArch stub that previously sat here was deleted alongside
   the 'arch' tab markup. Boot path + showTab no longer reference it. */

/* SIMULATION AND PER-AGENT EDITOR */
let sim={running:false,agents:[],users:[],totalIn:0,totalOut:0,totalCost:0,ragTok:0,reasonTok:0,guardTok:0,cacheSaved:0,apiCalls:0,toolUses:0,msgCount:0,errCount:0,tickInterval:null,processing:false,history:[]};
// Expose sim on window so app.js (procurement-side, lives in an IIFE) can
// read+mutate per-agent state for the bidirectional BYOK mirror. ES6 `let`
// does NOT auto-bind to window like `var` does, so without this app.js's
// `window.sim?.agents?.[idx]` resolves to undefined and the reverse mirror
// silently no-ops.
if (typeof window !== 'undefined') window.sim = sim;
function cfg(id){return parseInt(document.getElementById(id)?.value)||0;}
function cfgF(id){return parseFloat(document.getElementById(id)?.value)||0;}
const AGENT_CONFIG_FIELDS=['model','provider','temp','maxOut','turnsShare','toolsOn','ragOn','reasonOn','guardOn','tools_per','schema','result','rag_chunks','rag_size','rag_calls','think_tok','think_pct','cot','factcheck','guard_in','guard_out','guard_pii','guard_policy','cache_rate','task_bias','tool_result_cache_share','tool_result_react_persistence'];
function cloneAgentBase(src,i){return {...JSON.parse(JSON.stringify(src)),id:i,tokens:0,calls:0,busy:false,utilPct:0,realIn:0,realOut:0,ctxUsed:0,expanded:false};}
function snapshotAgentConfig(){return sim.agents.map(a=>{const o={name:a.name,role:a.role};AGENT_CONFIG_FIELDS.forEach(k=>{if(a[k]!==undefined)o[k]=a[k];});return o;});}
function applyAgentConfigSnapshot(arr){if(!Array.isArray(arr))return;arr.forEach((src,i)=>{const a=sim.agents[i];if(!a||!src)return;AGENT_CONFIG_FIELDS.forEach(k=>{if(src[k]!==undefined)a[k]=src[k];});});renderAgents();updateCostPanel();renderLedger();updateKPIs();}
function buildAgents(forceDefaults=false){
  const prev=forceDefaults?[]:(sim.agents||[]);
  sim.agents=AGENT_DEF.slice(0,cfg('s-agents')).map((def,i)=>{
    const base=cloneAgentBase(def,i);
    const prior=prev.find(p=>p.name===base.name)||prev[i];
    if(prior){AGENT_CONFIG_FIELDS.forEach(k=>{if(prior[k]!==undefined)base[k]=prior[k];});base.expanded=!!prior.expanded;}
    return base;
  });
  renderAgentSettingsSummary();
}
function buildUsers(){sim.users=UNAMES.slice(0,Math.min(cfg('s-users'),UNAMES.length)).map((name,i)=>({name,id:i}));}
function modelLabel(k){const m=MODELS[k]||MODELS['claude-sonnet-4.6'];return (m.label||k).replace('Claude ','').replace('Gemini ','').substring(0,24);}
function fmtAgentVal(k,v){
  const n=Number(v)||0;
  if(k==='turnsShare')return n.toFixed(1);
  if(k==='temp')return n.toFixed(2);
  if(k==='cache_rate'||k==='think_pct'||k==='activation_rate')return Math.round(n)+'%';
  if(k==='calls_per_turn_multiplier')return n.toFixed(1)+'×';
  return Math.round(n).toLocaleString();
}
// Workload-wide fallback for per-agent sliders that delegate to a global
// slider when the agent doesn't carry its own value. Keeps the rendered
// slider position in sync with the effective compute value so users
// don't see "0" while the engine quietly uses 512.
const _agentFallbackSlider={
  sysprompt:'s-sysprompt', iamsg:'s-iamsg', schema:'s-schema', tools_per:'s-tools',
  result:'s-toolresult', cache_rate:null /* uses cacheGlobal in engine */,
  rag_chunks:'s-rag-chunks', rag_size:'s-rag-chunk-size', rag_calls:'s-rag-calls',
  think_tok:'s-think-tokens', think_pct:'s-think-pct', cot:'s-cot', factcheck:'s-factcheck',
  guard_in:'s-guard-in', guard_out:'s-guard-out', guard_pii:'s-guard-pii', guard_policy:'s-guard-policy',
  fewshot:'s-fewshot', jsonschema:'s-jsonschema', memory:'s-memory', citations:'s-citations',
};
function _agentEffectiveVal(a,k){
  if(a[k]!==undefined&&a[k]!==null)return a[k];
  // Calibration knobs default to engine-level defaults when unset on
  // the agent. Without these explicit defaults the sliders would show
  // 0 and immediately misread the engine behavior (engine reads
  // undefined → falls back to its own default, but the SLIDER would
  // render at 0, suggesting the user has set strict no-cache).
  if (k === 'tool_result_cache_share') return 0.5;
  if (k === 'tool_result_react_persistence') return 0;
  const sid=_agentFallbackSlider[k];
  if(!sid)return 0;
  const el=document.getElementById(sid);
  return el?(parseFloat(el.value)||0):0;
}
// Per-agent slider tooltips. The site-wide tooltip handler binds via
// event delegation on [data-tip] and renders a markdown-aware popup
// (see index.html .js-tooltip). Keyed by slider name (agentRangeCtl's
// `k` arg) so call sites stay clean — adding a new agent slider gets
// its tooltip by registering here, not by threading another arg through.
const AGENT_SLIDER_TIPS = {
  turnsShare:      "### Turn share ×\nRelative weight in this agent's turns vs. the global Turns/session slider. ×1 = matches global; ×0.5 = half (orchestrator that fires once while workers loop); ×2 = double (drafter that revises repeatedly). Multiplies this agent's per-query LLM call count, so a ×2 agent on a 6-turn workload bills 12 calls/query.",
  cache_rate:      "### Per-agent cache hit rate\nOverrides the workload-wide Cache slider for this agent only. Useful when one agent has a stable cache-hot sysprompt (high rate) and another rewrites context every call (low rate). Leave at 0 to inherit the workload-wide rate — set explicitly when you've measured this agent's cache behavior.",
  temp:            "### Sampling temperature 🎓 (cost-neutral — here for learning)\n**This slider doesn't move the bill** — token counts don't depend on temperature. It's in the UI because it IS a real production parameter you'll set in code, and understanding it matters when designing an agent.\n\n**What it does operationally:**\n- Low (0.0–0.3) → deterministic output. Better for JSON-schema response_format compliance, routing/classification, structured extraction. Lowers retry rate when the model needs to match a strict schema.\n- Medium (0.4–0.7) → balanced. Default for most assistants.\n- High (0.8–1.0) → diverse generation. Good for creative writing, brainstorming. Higher retry rate on schema-strict outputs.\n\n**Indirect cost path:** lower temperature ⇒ fewer schema-mismatch retries ⇒ slightly lower Retry rate (separate slider in the workload section). Direct cost impact: zero.",
  maxOut:          "### Max output tokens (per call)\nHard cap on this agent's output per call. Lower = lower per-call output bill — important for high-volume terse agents (router, classifier). Set generously for long-form agents (drafter, summarizer). Output tokens are typically 5–20× more expensive per million than input on major models.",
  sysprompt:       "### System prompt size\nPer-agent system prompt in tokens. Bills at the cached input rate after the first call (~10% of fresh input), so a 3,000-tok sysprompt on a cache-eligible agent is cheap. But it still amortizes across calls_per_query — a one-shot agent eats it once per query, a 6-call agent splits it across calls so the per-call impact is smaller.",
  iamsg:           "### Inter-agent message tokens\nStructured payload one agent passes to the next on every call (router → worker, planner → drafter). Added to input on every call, typically NOT cached (changes per query). Sums up fast in chatty fleets — a 500-tok handoff × 6 calls × 1M queries = 3B input tokens/month.",
  fewshot:         "### Few-shot example tokens\nNumber of inline examples in the prompt. Each example is typically 100–500 input tokens; they're cached across calls but compete for context-window space. Drop to 0 if the agent is well-tuned by its system prompt alone; raise when you need consistent output formatting that schema alone won't enforce.",
  jsonschema:      "### JSON schema tokens\nSchema specification injected on every call when using structured output (`response_format` / tool-use schema). Typically 100–800 tokens depending on schema depth. Most providers cache it; some (older Bedrock/Vertex SDKs) re-send fresh each call — check your provider's caching docs before assuming the cache saves you.",
  memory:          "### Persistent memory tokens\nLong-term agent memory injected on every call (user preferences, project context, prior decisions). Distinct from RAG (query-triggered retrieval) — memory is always-on context. Eats cache budget but cheap in steady state since it changes slowly. Watch for memory bloat — most production systems summarize periodically.",
  citations:       "### Citation output tokens\nExtra output tokens for citations / source references. Adds to output bill — at GPT-5.2 output prices ($14/M) and 500 citations × 30 tok = 15K tok/query, that's about $0.21/query of pure citation cost. Track this on RAG-heavy agents; consider compressing to footnote-style refs.",
  activation_rate: "### Activation rate (% queries)\nWhat fraction of queries this agent fires on. 100 = runs on every query; 30 = only on 30% (e.g. a refusal-detection agent that triggers on flagged input). Lowers this agent's effective per-query cost proportionally — useful for modeling conditional fleets where some agents are rare.",
  rag_chunks:      "### Retrieved chunks per call\nNumber of chunks the retriever returns and stuffs into the prompt. More chunks = better recall but linearly more input tokens. Production systems typically land at 5–10; >15 hits diminishing returns and starts to push the context window. Set to 0 if this agent doesn't do RAG.",
  rag_size:        "### Tokens per chunk\nSize of each retrieved chunk. Smaller chunks (256–512 tok) = sharper relevance signal but more chunks needed for coverage; larger (1024–2048) = better continuity but more tokens per hit. 512 is a common default — tune based on your corpus's natural document granularity.",
  rag_calls:       "### Retrieval calls per query\nHow many separate retrieval queries this agent makes per user query. 1 = single retrieval pass; 3+ = iterative / multi-hop (decompose query → retrieve per sub-question → synthesize). Each call multiplies the RAG token bill — watch this on agents with complex query plans.",
  think_tok:       "### Thinking budget\nTokens for the model's internal reasoning trace (Claude extended thinking, OpenAI o-series reasoning, Gemini thinking). Billed at output-token rates even though invisible to the end user. Higher budget = more deliberation, slower latency, higher cost. 5,000 is a common 'medium' setting; high-stakes math/code goes to 32K+.",
  think_pct:       "### Reasoning turns (%)\nFraction of this agent's turns that engage extended thinking. Not every turn needs deep reasoning — a router classifying intent doesn't; a planner deciding next 5 steps does. Set 100 if every turn reasons; 20 if only the planning turn does. Multiplies with Thinking budget for the total reasoning bill.",
  cot:             "### CoT steps\nExplicit chain-of-thought steps prompted in the visible response (separate from Thinking budget's internal trace). Each step adds ~50–150 output tokens of visible reasoning before the final answer. Use 0 for terse responses; 3–5 for stepwise explanations users can verify.",
  factcheck:       "### Fact-check passes (per-agent self-verification)\n**Not the same as the workload-level Verification section** — they model two different verification architectures that can coexist or you can pick one.\n\n**THIS slider (per-agent):** the agent re-runs its OWN main LLM call N times to self-verify — ensemble sampling, self-consistency, critic loops. Each pass roughly doubles this agent's per-call cost. Use for: self-consistency sampling (run 3× and majority-vote), critic loops where the same model re-reads its output.\n\n**Workload-level Verification section:** a separate post-hoc NLI pipeline that runs AFTER the main agent. Atomize the response → check each atomic claim against retrieved evidence with a cheap NLI model → revise. Much cheaper per dollar than re-running the main LLM, and verifies grounding (the FactReasoner architecture in the calc paper). Use for: post-hoc fact-checking against RAG sources at scale.\n\n**TL;DR:** use this slider when you want the agent itself to deliberate harder. Use the workload Verification section when you want cheap atom-level grounding checks.",
  guard_in:        "### Input guard tokens\nTokens spent screening input for prompt injection, jailbreaks, PII before it reaches the main model. Free with built-in moderation (OpenAI Moderation API, Anthropic safety); ~$0.20/M tokens via Llama Guard or similar self-hosted. Required for regulated workloads; skip for low-risk internal tooling.",
  guard_out:       "### Output guard tokens\nTokens spent screening model output for policy violations, hallucinated PII, or unsafe content before returning to the user. Same models / prices as input guards. Sometimes skipped on cached / templated outputs that don't need re-checking; required when generating free-form responses to end users.",
  guard_pii:       "### PII scan tokens\nTokens specifically scanning for personally identifiable information (names, SSNs, emails, addresses). Required for HIPAA, GDPR, FedRAMP workloads. Usually folded into a single Llama-Guard call — keep at 0 if your guard_in/guard_out model already covers PII. Don't double-count.",
  guard_policy:    "### Policy enforcement tokens\nTokens enforcing org-specific policies — banned topics, regulated phrases, brand-voice rules. Custom-prompted, so cost varies widely. Tends to be higher than generic safety guards because the policy specification itself eats input tokens on every call. Tune by measuring real policy-prompt size in your stack.",
  tool_result_cache_share:      "### Tool result cache share — 📊 MEASURED, not a knob you set\n**What it is:** the fraction (0..1) of this agent's tool-RESULT tokens (the payload each tool returns) that end up cached by the provider's prompt cache in practice. Distinct from the agent's overall cache hit rate — that includes the stable sysprompt, which always caches; this is specifically the volatile tool-return content.\n\n**Default 0.5** — the engine's modeled assumption when you don't have measured data. Lands a typical tool-orchestration workload at ~30% templated savings (matching the public geospatial Q&A reference). Reasonable starting point for un-instrumented agents.\n\n**How to measure it for YOUR deployment:**\n1. Instrument your LLM call site to log `response.usage.prompt_tokens_details.cached_tokens` and `prompt_tokens` per call\n2. For each call, also tokenize the tool-return messages in your prompt to get `tool_result_tokens_in_prompt`\n3. Per stage: `share = (cached_tokens - sysprompt_tokens) / tool_result_tokens_in_prompt`\n4. Average across stages weighted by their result token contribution\n\n**Worked example:** the public geospatial Q&A reference agent — measured via 180-call instrumented replay against OpenAI gpt-5.2 — lands at 0.215 (much lower than the 0.5 default). The collapse is driven by stage 6 where stac_search's 18K-token freeform payload from stage 5 exceeds OpenAI's prompt-cache alignment buffer.\n\n**Setting 0** = strict no-cache (most conservative). **Setting 1** = full cache discount (rarely true for freeform). Move the slider only when you have telemetry — guessing here distorts the freeform cost by 4× either direction.",
  tool_result_react_persistence: "### Tool result ReAct persistence — 📊 MEASURED, default off\n**What it is:** the fraction (0..1) of how strongly tool results from prior stages accumulate in subsequent LLM calls' contexts. Models the ReAct loop behavior where a tool return at stage K is still in conversation at stage K+1, K+2, etc., until summarization or context-window pressure pushes it out.\n\n**Default 0** — no behavior change. The existing tool_result_cache_share knob (above) already absorbs the ReAct accumulation effect implicitly via its 0.5 default that lands a tool-orchestration workload at 30% savings. Turning persistence ON without re-tuning share will DOUBLE-COUNT the effect.\n\n**When to use it:** only when you've measured BOTH knobs from production telemetry. The two model overlapping phenomena — share captures \"how much of result tokens caches across same-stage repeats\", persistence captures \"how much of prior-stage result tokens persist in later-stage prompts\". A well-instrumented deployment with per-call cached_tokens telemetry can disentangle them; a guess-based config can't.\n\n**Formula:** result tokens get multiplied by `1 + (calls_per_query - 1) × persistence`. For a 6-call ReAct loop, persistence=0.5 means tool results are billed 3.5× per query on average (each stage's return seen by ~half the subsequent calls).\n\n**Setting 0** = no accumulation (default; works with default share=0.5 to match the reference workload).\n**Setting 1** = full accumulation (every tool result in every subsequent call's context, no summarization).",
};

// Cost-neutral sliders kept in the UI for learning. The agent card
// shows these alongside real levers so users see what parameters
// exist when designing an agent in real code, but the visual cue
// (cyan dotted underline + 🎓 marker, see index.html .is-educational)
// makes clear "don't expect the headline to move when you drag this."
const AGENT_SLIDER_EDUCATIONAL = new Set(['temp']);

// Measured-band per-agent sliders. Render with the same amber dashed
// underline + 📊 marker as the workload-level measured sliders
// (Cache hit rate, Bot factor, etc.) to signal "set this from
// production telemetry, not by guessing." See index.html
// .sr-label.is-measured for the visual styling.
const AGENT_SLIDER_MEASURED = new Set([
  'tool_result_cache_share',
  'tool_result_react_persistence',
]);

function agentRangeCtl(a,scope,k,label,min,max,step,color,type='int'){
  const v=_agentEffectiveVal(a,k);
  const lid=`a-${scope}-${a.id}-${k}`;            // visual value id (existing)
  const labelId=`alb-${scope}-${a.id}-${k}`;      // a11y label-id (new) — referenced by aria-labelledby on the input
  const cast=type==='float'?'parseFloat(this.value)':'parseInt(this.value)';
  // Pull tooltip from the central map — keeps the call sites in agentCardHtml
  // free of per-slider markup and centralizes the content. Missing keys
  // render the label without an underline (no-tooltip).
  const tip=AGENT_SLIDER_TIPS[k];
  const eduClass=AGENT_SLIDER_EDUCATIONAL.has(k)?' is-educational':'';
  const measClass=AGENT_SLIDER_MEASURED.has(k)?' is-measured':'';
  const labelClass=tip?` class="sr-label${eduClass}${measClass}"`:'';
  const tipAttr=tip?` data-tip="${tip.replace(/"/g,'&quot;')}"`:'';
  return `<div class="agent-mini-range"><div class="mini-label"><span id="${labelId}"${labelClass}${tipAttr}>${label}</span><span class="mini-val" id="${lid}" style="color:${color}" aria-hidden="true">${fmtAgentVal(k,v)}</span></div><input type="range" min="${min}" max="${max}" value="${v}" step="${step}" aria-labelledby="${labelId}" aria-valuetext="${fmtAgentVal(k,v)}" oninput="setAP(${a.id},'${k}',${cast},'${lid}',v=>fmtAgentVal('${k}',v))"></div>`;
}
function agentSection(title,color,on,body){
  // OFF state: distinguish via border + a tinted muted status pill, but
  // keep slider values + section heading legible (opacity:0.45 prior
  // crushed every value to unreadable). Active stays color-saturated.
  const borderColor = on ? color + '66' : 'var(--b)';
  const titleColor  = on ? color : 'var(--ink-2,#3a3a3a)';
  const statusBg    = on ? color + '18' : 'rgba(180,180,180,0.10)';
  const statusFg    = on ? color : 'var(--ink-2,#3a3a3a)';
  const statusText  = on ? 'ACTIVE' : 'OFF — values retained';
  return `<div class="agent-detail-section" style="border-color:${borderColor}">
    <div class="agent-section-title" style="color:${titleColor}">
      <span>${title}</span>
      <span style="font-size:8px;font-weight:600;letter-spacing:0.04em;padding:1px 5px;border-radius:3px;background:${statusBg};color:${statusFg}">${statusText}</span>
    </div>
    <div class="agent-edit-grid">${body}</div>
  </div>`;
}
function taskBiasSelect(a, ariaLabelledby){
  const labelAttr = ariaLabelledby ? ` aria-labelledby="${ariaLabelledby}"` : '';
  return `<select${labelAttr} onchange="setAP(${a.id},'task_bias',this.value)" style="width:100%;font-size:12px;padding:3px 5px"><option value="" ${!a.task_bias?'selected':''}>Balanced mix</option>${TASK_TYPES.map(t=>`<option value="${t.id}" ${a.task_bias===t.id?'selected':''}>${t.label}</option>`).join('')}</select>`;
}

// Per-agent enabled-tools checklist (Phase 3 of the tools-registry
// redesign). Reads the workload's tools_registry and renders a
// checkbox + calls/query input per tool. Edits flow through
// togAgentTool / setAgentToolCalls into agent.enabled_tools, which
// app.js renderPreview reads to compute per-agent monthly tool fees.
function agentEnabledToolsHtml(a) {
  const reg = (window.workload && window.workload.tools_registry) || {};
  const enabled = a.enabled_tools || {};
  const entries = Object.entries(reg);
  if (entries.length === 0) return '';
  const fmtRate = (t) => {
    if (t.cost_shape === 'free' || !t.rate_usd) return 'free';
    if (t.cost_shape === 'per_session') return '$' + (t.rate_usd).toFixed(3) + '/sess';
    return '$' + (t.rate_usd * 1000).toFixed(2) + '/1k';
  };
  if (!a._toolExpanded) a._toolExpanded = {};
  return `<div style="grid-column:1 / -1;margin-top:6px">
    <div class="mini-label" style="color:#ce93d8"><span>Enabled tools</span><span style="font-weight:500;color:var(--ink-2,#3a4a62)">tick to enable · set calls/query · ▸ to override return shape</span></div>
    <div style="display:grid;grid-template-columns:1fr;gap:3px;margin-top:4px;padding:5px;border:1px solid var(--b);border-radius:5px;background:rgba(206,147,216,0.04)">
      ${entries.map(([id, t]) => {
        const isOn = id in enabled;
        const spec = enabled[id] || {};
        const calls = spec.calls_per_query != null ? spec.calls_per_query : 1;
        const labelName = (t.label || id).replace(/"/g, '&quot;');
        const hasOverride = !!spec.return_shape_override || Number.isFinite(spec.cap_tokens_override);
        const expanded = !!a._toolExpanded[id];
        const overrideBadge = hasOverride
          ? '<span title="This agent overrides the tool\'s default return shape" style="font-size:9px;color:#f59e00;background:rgba(245,158,0,.12);border:1px solid rgba(245,158,0,.3);padding:0 5px;border-radius:8px;font-weight:600">override</span>'
          : '';
        const effShape = spec.return_shape_override || t.return_shape || 'freeform';
        const effCap = Number.isFinite(spec.cap_tokens_override) ? spec.cap_tokens_override
                       : (Number.isFinite(t.cap_tokens) ? t.cap_tokens : 40);
        const triggerPct = Number.isFinite(spec.trigger_rate) ? Math.round(spec.trigger_rate * 100) : 100;
        const rowHtml = `<div style="display:grid;grid-template-columns:auto 1.2fr 0.45fr 0.4fr 0.55fr auto;gap:5px;align-items:center;font-size:11px">
          <button type="button" onclick="toggleAgentToolExpand(${a.id},'${id}');event.stopPropagation();" ${isOn ? '' : 'disabled'} title="Override return shape per-(agent, tool)" style="background:transparent;border:none;cursor:${isOn?'pointer':'not-allowed'};color:var(--ink-2,#3a4a62);font-size:10px;padding:0 2px;opacity:${isOn ? (expanded ? '1' : '.55') : '.25'}">▸</button>
          <label style="display:flex;gap:5px;align-items:center;cursor:pointer">
            <input type="checkbox" onchange="togAgentTool(${a.id},'${id}',this.checked)" ${isOn ? 'checked' : ''} aria-label="Enable ${labelName} for this agent">
            <span style="font-weight:${isOn ? 600 : 500}">${t.label || id}</span>
            ${overrideBadge}
          </label>
          <input type="number" min="0" step="1" value="${calls}" ${isOn ? '' : 'disabled'} onchange="setAgentToolCalls(${a.id},'${id}',this.value)" style="font-size:11px;padding:2px 4px;width:100%;font-family:var(--mono);${isOn ? '' : 'opacity:0.4;'}" placeholder="calls/q" title="Calls per query when this tool fires" aria-label="${labelName} calls per query">
          <span style="display:flex;align-items:center;gap:2px;font-size:10px;color:var(--ink-2,#3a4a62)" title="Trigger rate — % of this agent's invocations on which this tool actually fires.

Examples:
• 100% = always (default, simple tool use)
• 60% = Designer uses image_gen on 60% of sites (some users bring their own images)
• 30% = SEO-Agent runs web_search on 30% of queries (skips for cached domains)
• 10% = Image-Enhancer's image_gen fires on 10% of requests (only when uploads detected)

Engine math: effective_calls = calls_per_query × trigger_rate × (1 − memoize_hit_rate). Multiplies both the per-call fee and the result-token overhead so the bill reflects the realistic average across queries, not the worst case where every tool always fires."><span>×</span><input type="number" min="0" max="100" step="5" value="${triggerPct}" ${isOn ? '' : 'disabled'} onchange="setAgentToolTriggerRate(${a.id},'${id}',this.value)" style="font-size:11px;padding:2px 3px;width:100%;font-family:var(--mono);${isOn ? '' : 'opacity:0.4;'}" aria-label="${labelName} trigger rate percent"><span>%</span></span>
          <span style="font-size:10px;color:var(--ink-2,#3a4a62);font-family:var(--mono)">${fmtRate(t)}</span>
          <span></span>
        </div>`;
        const overrideRow = (isOn && expanded) ? `
          <div style="grid-column:1/-1;margin:3px 0 5px 24px;padding:6px 8px;background:rgba(245,158,0,.06);border:1px solid rgba(245,158,0,.22);border-radius:4px;display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:center;font-size:10.5px">
            <label style="display:flex;flex-direction:column;gap:2px">
              <span style="color:var(--ink-2,#3a4a62);font-size:9.5px;text-transform:uppercase;letter-spacing:0.04em">Return shape (override)</span>
              <select onchange="setAgentToolOverride(${a.id},'${id}','return_shape_override',this.value)" style="font-size:11px;padding:2px 4px">
                <option value="">(use tool default: ${t.return_shape || 'freeform'})</option>
                <option value="freeform" ${spec.return_shape_override==='freeform'?'selected':''}>freeform</option>
                <option value="templated" ${spec.return_shape_override==='templated'?'selected':''}>templated</option>
              </select>
            </label>
            <label style="display:flex;flex-direction:column;gap:2px">
              <span style="color:var(--ink-2,#3a4a62);font-size:9.5px;text-transform:uppercase;letter-spacing:0.04em">Cap tok (override)</span>
              <input type="number" min="0" step="5" value="${Number.isFinite(spec.cap_tokens_override) ? spec.cap_tokens_override : ''}" placeholder="(use tool default: ${Number.isFinite(t.cap_tokens) ? t.cap_tokens : 40})" onchange="setAgentToolOverride(${a.id},'${id}','cap_tokens_override',this.value)" style="font-size:11px;padding:2px 4px;font-family:var(--mono)">
            </label>
            <div style="font-size:9.5px;color:var(--ink-2,#3a4a62);min-width:90px;text-align:right">
              <div>effective:</div>
              <div style="font-family:var(--mono);font-weight:600">${effShape}, ${effShape==='templated' ? effCap+' tok' : (t.result_tokens_avg||0)+' tok'}</div>
            </div>
          </div>` : '';
        return rowHtml + overrideRow;
      }).join('')}
    </div>
  </div>`;
}

// Per-agent guard-model picker. Spans the full agent-edit-grid row so
// the dropdown has room to show the long preset labels. Defers to the
// cost engine's GUARD_MODEL_PRESETS table; reading window.CostEngine
// avoids a hardcoded duplicate enumeration here. Falls back to a
// minimal hardcoded list if the engine isn't ready yet (rare; only on
// the first paint before cost-engine.js evaluates).
function guardModelDropdownHtml(a){
  const presets = (typeof window !== 'undefined' && window.CostEngine && window.CostEngine.GUARD_MODEL_PRESETS) || {
    'llama-guard-3': { label: 'Meta Llama Guard 3' },
    'custom':        { label: 'Custom' },
  };
  const cur = a.guard_model || 'custom';
  const opts = Object.entries(presets).map(([k, p]) =>
    `<option value="${k}" ${k===cur?'selected':''}>${p.label}</option>`
  ).join('');
  const lid = `alb-guardmodel-${a.id}`;
  return `<div style="grid-column:1 / -1"><div class="mini-label" style="color:#ff6d00;display:flex;align-items:center;gap:6px"><span id="${lid}">Guard model</span><span style="font-weight:500;color:var(--ink-2,#3a4a62)">· per-agent</span></div>
    <select aria-labelledby="${lid}" onchange="setAP(${a.id},'guard_model',this.value)" style="width:100%;font-size:12px;padding:3px 5px">${opts}</select></div>`;
}

// Per-agent fact-checking sub-section. Mirrors the workload.agents
// editor's verify_enabled / verify_coverage / verifier_override fields
// so the simulator card and the calculator share the same controls
// (the bridge mirrors them to workload.agents[i] in lockstep).
// Latency badges on each preset option tell the user whether an
// inline-per-turn fact-check is realistic (FR2 + inline = 90 sec wait
// per turn = won't ship).
function verifyAgentHtml(a){
  const presets = (typeof window !== 'undefined' && window.CostEngine && window.CostEngine.VERIFIER_PRESETS) || {};
  const enabled = !!a.verify_enabled;
  const cov = a.verify_coverage;
  const ovr = a.verifier_override || '';
  const presetOpts = `<option value="">(use workload preset)</option>` +
    Object.entries(presets).map(([k, p]) => {
      const badge = p.latency_class === 'inline' ? '✓ inline'
                  : p.latency_class === 'audit'  ? '⚠ audit (~' + p.latency_sec + 's)'
                  :                                '⚠ batch (~' + p.latency_sec + 's)';
      return `<option value="${k}" ${ovr===k?'selected':''}>${p.label} — ${badge}</option>`;
    }).join('');
  const sub = enabled ? `
    <div class="agent-edit-grid" style="margin-top:6px">
      <div>
        <div class="mini-label" style="color:#1565c0">Coverage override</div>
        <input type="number" min="0" max="1" step="0.05" value="${cov != null ? cov : ''}" placeholder="(use workload)" oninput="setAPVerify(${a.id},'verify_coverage',this.value)" style="width:100%;font-size:12px;padding:3px 5px">
      </div>
      <div style="grid-column:span 1">
        <div class="mini-label" style="color:#1565c0">Verifier override</div>
        <select onchange="setAPVerify(${a.id},'verifier_override',this.value)" style="width:100%;font-size:12px;padding:3px 5px">${presetOpts}</select>
      </div>
    </div>` : '';
  return `<div style="margin-top:8px;padding:7px 9px;background:rgba(21,101,192,0.05);border:1px solid rgba(21,101,192,0.18);border-radius:5px">
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;color:#1565c0;font-weight:600">
      <input type="checkbox" ${enabled?'checked':''} onchange="setAPVerify(${a.id},'verify_enabled',this.checked);event.stopPropagation();" style="margin:0">
      Fact-check this agent's output
    </label>
    <div style="font-size:10px;color:var(--ink-2,#3a4a62);margin-top:3px;line-height:1.4">Default off. Turn on for synthesizer / reporter agents that produce user-facing factual claims. Skip for orchestrators and tool-executors.</div>
    ${sub}
  </div>`;
}

// Verify-field setter. Same shape as setAP but handles the nullable
// override fields (blank → delete the property so engine falls back to
// workload defaults) and re-renders the agent card so the coverage +
// override controls appear/disappear when verify_enabled toggles.
function setAPVerify(id, k, v){
  const a = sim.agents.find(x => x.id === id);
  if (!a) return;
  if (k === 'verify_enabled') a.verify_enabled = !!v;
  else if (v === '' || v == null) delete a[k];
  else if (k === 'verify_coverage') {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n >= 0 && n <= 1) a.verify_coverage = n;
    else delete a.verify_coverage;
  }
  else a[k] = v;
  _mirrorAgentEditToWorkload(id, k, a[k]);
  if (k === 'verify_enabled') renderAgents();
  refreshAfterAgentEdit();
}
// Per-agent "Compare models" expandable. Collapsed by default to avoid
// UI noise. When expanded, computes monthly cost for this agent across
// every model in the workload's rate card (or engine default), sorted
// cheapest-first, with delta vs current model highlighted. Lets the
// designer see "if my Reporter swapped Opus → Sonnet, save $X/mo"
// without leaving the agent card.
function agentModelCompareHtml(a, scope) {
  const open = !!a._modelCompareOpen;
  const headerBtn = `<button type="button" onclick="toggleAgentModelCompare(${a.id});event.stopPropagation();" style="background:none;border:none;cursor:pointer;color:var(--ink-2,#3a4a62);font-size:10.5px;letter-spacing:0.04em;text-transform:uppercase;font-weight:700;padding:0;display:flex;align-items:center;gap:4px;margin-top:8px">
    <span style="display:inline-block;width:9px;font-family:var(--mono);${open ? 'transform:rotate(90deg)' : ''}">▶</span>
    Compare models for this agent
    <span style="font-size:9px;color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400">— see monthly cost if this agent used a different model</span>
  </button>`;
  if (!open) return headerBtn;
  // Collect candidate models: prefer workload.rate_cards keys (which include
  // any overrides), fall back to engine DEFAULT_RATE_CARDS.
  const cardSrc = (window.workload && window.workload.rate_cards && Object.keys(window.workload.rate_cards).length > 0)
    ? window.workload.rate_cards
    : ((window.CostEngine && window.CostEngine.DEFAULT_RATE_CARDS) || {});
  const modelKeys = Object.keys(cardSrc);
  if (modelKeys.length === 0) return headerBtn + '<div style="font-size:11px;color:var(--ink-2,#3a4a62);padding:6px 0">(no rate cards loaded yet)</div>';
  const currentMo = _agentCurrentMonthly(a.id);
  const rows = modelKeys.map(k => {
    const mo = _agentMonthlyUnderModel(a.id, k);
    return { model: k, monthly: mo, isCurrent: k === a.model };
  }).filter(r => r.monthly != null).sort((x, y) => x.monthly - y.monthly);
  if (rows.length === 0) return headerBtn + '<div style="font-size:11px;color:var(--ink-2,#3a4a62);padding:6px 0">(unable to compute model comparison)</div>';
  const fmt$ = (n) => '$' + Math.round(n).toLocaleString();
  const fmtDelta = (delta, base) => {
    if (base <= 0) return '—';
    const pct = (delta / base) * 100;
    const sign = delta >= 0 ? '+' : '−';
    const color = delta < 0 ? '#1b8a4c' : (delta > 0 ? '#c62828' : 'var(--ink-2,#3a4a62)');
    return `<span style="color:${color};font-weight:600">${sign}$${Math.abs(Math.round(delta)).toLocaleString()} (${sign}${Math.abs(pct).toFixed(0)}%)</span>`;
  };
  const tableRows = rows.map(r => {
    const delta = (currentMo != null) ? (r.monthly - currentMo) : 0;
    const rowBg = r.isCurrent ? 'background:rgba(0,200,120,.08);font-weight:700' : '';
    const tag = r.isCurrent ? ' <span style="font-size:9px;color:#1b8a4c;background:rgba(0,200,120,.15);padding:0 5px;border-radius:8px;letter-spacing:.04em">CURRENT</span>' : '';
    const switchBtn = r.isCurrent ? '' : `<button type="button" onclick="setAM(${a.id},'${r.model}');event.stopPropagation();" title="Switch this agent to ${r.model}" style="background:transparent;border:1px solid var(--cyan,#0c8db3);color:var(--cyan,#0c8db3);font-size:9px;padding:1px 6px;border-radius:3px;cursor:pointer;font-weight:600">switch</button>`;
    return `<tr style="${rowBg}">
      <td style="padding:3px 6px;font-size:11px;font-family:var(--mono)">${r.model}${tag}</td>
      <td style="padding:3px 6px;font-size:11px;text-align:right;font-family:var(--mono)">${fmt$(r.monthly)}/mo</td>
      <td style="padding:3px 6px;font-size:11px;text-align:right">${r.isCurrent ? '—' : fmtDelta(delta, currentMo || 0)}</td>
      <td style="padding:3px 6px;text-align:right">${switchBtn}</td>
    </tr>`;
  }).join('');
  return headerBtn + `<div style="margin-top:6px;padding:6px 8px;background:rgba(0,0,0,.02);border:1px solid var(--rule);border-radius:5px">
    <div style="font-size:10px;color:var(--dim);margin-bottom:4px;line-height:1.5">Monthly cost for THIS agent only, holding all other agents and settings constant. Verification, RAG, tool fees stay attached as-is. <strong>Cheaper ≠ better</strong> — verify quality on your own eval set before switching.</div>
    <table style="width:100%;border-collapse:collapse"><tbody>${tableRows}</tbody></table>
  </div>`;
}
function toggleAgentModelCompare(id) {
  const a = sim.agents.find(x => x.id === id);
  if (!a) return;
  a._modelCompareOpen = !a._modelCompareOpen;
  renderAgents();
}
function agentCardHtml(a,scope){
  const m=MODELS[a.model]||MODELS['claude-sonnet-4.6'];
  const ctxP=Math.min(100,Math.round((a.ctxUsed||0)/m.ctx*100));
  const provider=PROVIDERS[a.provider||m.providerDefault||'managed']||PROVIDERS.managed;
  const modelSelect=MK.map(k=>`<option value="${k}" ${k===a.model?'selected':''}>${modelLabel(k)}</option>`).join('');
  const providerSelect=Object.entries(PROVIDERS).map(([k,v])=>`<option value="${k}" ${k===(a.provider||'managed')?'selected':''}>${v.label}</option>`).join('');
  // TOOLS section is now solely the registry-driven enabled-tools
  // checklist. The legacy 'Calls/turn', 'Schema tok/call', 'Result tok/
  // call' sliders were removed 2026-05-16 — they overlapped confusingly
  // with the registry's per-tool schema_tokens / result_tokens_avg
  // fields and were redundant once registry math went live in d09c426.
  const toolsBody = agentEnabledToolsHtml(a);
  const ragBody=[agentRangeCtl(a,scope,'rag_chunks','Chunks',0,20,1,'#7c4dff'),agentRangeCtl(a,scope,'rag_size','Tokens / chunk',64,4096,64,'#7c4dff'),agentRangeCtl(a,scope,'rag_calls','Retrieval calls',0,5,1,'#7c4dff')].join('');
  const reasonBody=[agentRangeCtl(a,scope,'think_tok','Thinking budget',0,10000,500,'#00bcd4'),agentRangeCtl(a,scope,'think_pct','Reasoning turns',0,100,5,'#00bcd4'),agentRangeCtl(a,scope,'cot','CoT steps',0,20,1,'#00bcd4'),agentRangeCtl(a,scope,'factcheck','Fact-check passes',0,3,1,'#00bcd4')].join('');
  const guardModelSelect = guardModelDropdownHtml(a);
  const guardBody=[guardModelSelect,agentRangeCtl(a,scope,'guard_in','Input guard tok',0,2000,50,'#ff6d00'),agentRangeCtl(a,scope,'guard_out','Output guard tok',0,2000,50,'#ff6d00'),agentRangeCtl(a,scope,'guard_pii','PII scan tok',0,1000,50,'#ff6d00'),agentRangeCtl(a,scope,'guard_policy','Policy tok',0,2000,100,'#ff6d00')].join('');
  return `<div class="agent-card ${a.busy?'processing':''}" id="ac-${scope}-${a.id}">
    <div class="agent-header" onclick="togAgent(${a.id})">
      <div class="agent-av" style="background:${a.col}18;border:1px solid ${a.col}44;color:${a.col}">${a.name[0]}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;color:${a.col};display:flex;align-items:center;gap:6px">
          <span>${a.name} <span style="font-size:11px;color:var(--ink-2,#3a4a62);font-weight:500;margin-left:4px">${a.role}</span></span>
          <button type="button" onclick="event.stopPropagation();renameAgentRow(${a.id});" title="Rename agent" style="background:transparent;border:none;cursor:pointer;color:var(--ink-2,#3a4a62);padding:0 2px;font-size:11px;opacity:.6" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.6">✎</button>
          <button type="button" onclick="event.stopPropagation();removeAgentRow(${a.id});" title="Remove agent" style="background:transparent;border:none;cursor:pointer;color:var(--red,#c62828);padding:0 2px;font-size:13px;opacity:.5" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.5">×</button>
        </div>
        <div style="font-size:11px;color:${m.color};margin-top:2px">${modelLabel(a.model)} · ${provider.label}</div>
        <div style="height:3px;background:var(--track);border-radius:2px;margin:4px 0"><div style="width:${a.utilPct||0}%;height:100%;background:${a.col}88;border-radius:2px;transition:width .5s" id="ab-${scope}-${a.id}"></div></div>
        <div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;align-items:center">
          ${a.ragOn?'<span class="badge-rag">RAG</span>':''}${a.reasonOn?'<span class="badge-reason">THINK</span>':''}${a.guardOn?'<span class="badge-guard">GUARD</span>':''}${a.toolsOn?'<span class="badge">TOOLS</span>':''}
          <span class="badge" style="background:rgba(124,77,255,.1);color:var(--purple);border-color:rgba(124,77,255,.2)">×${(a.turnsShare||1).toFixed(1)} turns</span>
          ${(() => {
            // BYOK / Self-host: this agent's API cost is billed to the
            // user's own key or counted under the self-host pricing
            // section, NOT to this deployment's API line. Swap the
            // monthly-cost badge for a clearer "billed elsewhere"
            // indicator so users see the intent ("your key pays")
            // rather than an ambiguous $0 (which could read as "free").
            if (a.provider === 'byok') {
              // Styling moved to .badge-byok in index.html so theme-tactical
              // can override dark-amber-on-dark to a brighter, readable amber.
              return `<span class="badge badge-byok" title="This agent uses the user's own API key — its tokens are billed to that key, not to this deployment's API line. Engine excludes from the headline API total.">BYOK · billed to your key</span>`;
            }
            if (a.provider === 'self-hosted') {
              return `<span class="badge badge-selfhost" title="This agent runs on user-managed GPUs — its tokens are counted under the Self-host capacity section, not the API line.">SELF-HOST · counted under GPU section</span>`;
            }
            const mo = _agentCurrentMonthly(a.id);
            if (mo == null) return '';
            const fleetTotal = (window.__perAgentMonthly||[]).reduce((s,v)=>s+(v||0),0);
            const pct = fleetTotal>0 ? Math.round(100*mo/fleetTotal) : 0;
            return `<span class="badge" title="This agent's monthly LLM-bill contribution (matches headline pill accounting). Pct = share of total per-agent LLM cost." style="background:rgba(0,200,120,.1);color:#1b8a4c;border-color:rgba(0,200,120,.25);font-weight:700">$${Math.round(mo).toLocaleString()}/mo · ${pct}%</span>`;
          })()}
        </div>
        <div style="font-size:10px;color:var(--ink-2,#3a4a62);margin-top:3px" id="as-${scope}-${a.id}">in:${(a.realIn||0).toLocaleString()} · ctx:${ctxP}%</div>
      </div>
      <span class="arrow ${a.expanded?'open':''}">▶</span>
    </div>
    <div class="agent-cfg-panel ${a.expanded?'open':''}" id="cfg-${scope}-${a.id}">
      <div class="agent-edit-grid">
        <div><div id="alb-model-${a.id}" style="font-size:11px;color:var(--ink-2,#3a4a62);margin-bottom:3px">Model</div><select aria-labelledby="alb-model-${a.id}" onchange="setAM(${a.id},this.value)" style="width:100%;font-size:12px;padding:3px 5px">${modelSelect}</select></div>
        <div><div id="alb-provider-${a.id}" style="font-size:11px;color:var(--ink-2,#3a4a62);margin-bottom:3px">Provider</div><select aria-labelledby="alb-provider-${a.id}" onchange="setAP(${a.id},'provider',this.value)" style="width:100%;font-size:12px;padding:3px 5px">${providerSelect}</select></div>
        <div><div id="alb-taskbias-${a.id}" style="font-size:11px;color:var(--ink-2,#3a4a62);margin-bottom:3px">Task bias</div>${taskBiasSelect(a, 'alb-taskbias-' + a.id)}</div>
      </div>
      ${agentModelCompareHtml(a, scope)}
      <div style="font-size:10px;color:var(--ink-2,#3a4a62);margin-bottom:7px">${provider.note}${provider.fixed_mo>0?' · $'+provider.fixed_mo.toLocaleString()+'/mo fixed':''}</div>
      <div class="agent-edit-grid advanced-only">
        ${agentRangeCtl(a,scope,'turnsShare','Turn share x',0.2,3,0.1,'#00d4ff','float')}
        ${agentRangeCtl(a,scope,'cache_rate','Cache hit rate',0,95,5,'#00e676')}
        ${agentRangeCtl(a,scope,'temp','Temperature',0,1,0.05,'#ffab40','float')}
        ${agentRangeCtl(a,scope,'maxOut','Max output tok',64,4096,64,'#42a5f5')}
      </div>
      <div class="agent-edit-grid advanced-only">
        ${agentRangeCtl(a,scope,'tool_result_cache_share','Tool result cache share',0,1,0.05,'#f59e00','float')}
        ${agentRangeCtl(a,scope,'tool_result_react_persistence','Tool result ReAct persistence',0,1,0.05,'#f59e00','float')}
      </div>
      <div class="agent-edit-grid advanced-only">
        ${agentRangeCtl(a,scope,'sysprompt','Sysprompt tok',0,4000,50,'#42a5f5')}
        ${agentRangeCtl(a,scope,'iamsg','Inter-agent msg tok',0,2000,20,'#4dd0e1')}
        ${agentRangeCtl(a,scope,'fewshot','Few-shot examples',0,10,1,'#1565c0')}
        ${agentRangeCtl(a,scope,'jsonschema','JSON schema tok',0,1500,50,'#0d47a1')}
        ${agentRangeCtl(a,scope,'memory','Persistent memory tok',0,2000,50,'#42a5f5')}
        ${agentRangeCtl(a,scope,'citations','Citation output tok',0,500,10,'#558b2f')}
        ${agentRangeCtl(a,scope,'activation_rate','Activation rate (% queries)',0,100,5,'#26a69a')}
      </div>
      <div style="display:flex;gap:3px;flex-wrap:wrap;margin-bottom:5px">
        <button class="tgl ${a.toolsOn?'on':''}" onclick="togAF(${a.id},'toolsOn',this);event.stopPropagation();">TOOLS ${a.toolsOn?'ON':'OFF'}</button>
        <button class="tgl ${a.ragOn?'rag-on':''}" onclick="togAF(${a.id},'ragOn',this);event.stopPropagation();">RAG ${a.ragOn?'ON':'OFF'}</button>
        <button class="tgl ${a.reasonOn?'reason-on':''}" onclick="togAF(${a.id},'reasonOn',this);event.stopPropagation();">THINK ${a.reasonOn?'ON':'OFF'}</button>
        <button class="tgl ${a.guardOn?'guard-on':''}" onclick="togAF(${a.id},'guardOn',this);event.stopPropagation();">GUARD ${a.guardOn?'ON':'OFF'}</button>
      </div>
      ${agentSection('Tools', '#ce93d8', a.toolsOn, toolsBody)}
      ${agentSection('RAG / retrieval', '#7c4dff', a.ragOn, ragBody)}
      ${agentSection('Reasoning', '#00bcd4', a.reasonOn, reasonBody)}
      ${agentSection('Guardrails', '#ff6d00', a.guardOn, guardBody)}
      ${verifyAgentHtml(a)}
      ${sim.agents.length > 1 ? `<div style="margin-top:8px;padding:7px 10px;border:1px dashed var(--b);border-radius:5px;font-size:11px;color:var(--ink-2,#3a4a62);display:flex;justify-content:space-between;align-items:center;gap:10px"><span>Want every agent to share this one's TOOLS / RAG / Reasoning / Guardrails settings?</span><button type="button" onclick="applyAgentSettingsToAll(${a.id});event.stopPropagation();" style="font-size:11px;padding:4px 10px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.35);border-radius:3px;color:var(--cyan);cursor:pointer;white-space:nowrap;font-weight:600">↧ Apply to all agents</button></div>` : ''}
      <div style="font-size:10px;color:var(--ink-2,#3a4a62);margin-top:7px">Task bias: ${a.task_bias||'balanced'} · ctx fill: ${ctxP}% · source: ${m.source||'static bootstrap'}</div>
    </div>
  </div>`;
}
function renderAgentSettingsSummary(){
  const sc=computeCost();
  const n=sim.agents.length||0;
  const rag=sim.agents.filter(a=>a.ragOn).length, tools=sim.agents.filter(a=>a.toolsOn).length, think=sim.agents.filter(a=>a.reasonOn).length, guard=sim.agents.filter(a=>a.guardOn).length;
  const modelCount=new Set(sim.agents.map(a=>a.model)).size;
  const text=`${n} agents - ${modelCount} models - RAG ${rag}/${n}, tools ${tools}/${n}, reasoning ${think}/${n}, guard ${guard}/${n}. Fleet p50: ${(sc.netCost||0).toFixed(5)}/session.`;
  const summary=document.getElementById('agent-editor-summary');if(summary)summary.textContent=text;
  const mini=document.getElementById('agent-config-mini-summary');
  if(mini)mini.innerHTML=[['Agents',n,'var(--cyan)'],['Models',modelCount,'var(--purple)'],['p50 / session','$'+(sc.netCost||0).toFixed(5),'var(--green)'],['RAG agents',rag+'/'+n,'var(--rag)'],['Thinking agents',think+'/'+n,'var(--reason)'],['Guard agents',guard+'/'+n,'var(--guard)']].map(([l,v,c])=>`<div class="mcard"><div class="mlabel">${l}</div><div class="mval" style="font-size:13px;color:${c}">${v}</div></div>`).join('');
  const mb=document.getElementById('agent-config-mini-badge');if(mb)mb.textContent=n+' agents';
  // Fleet-inventory badges read from the live tools_registry (Section B)
  // so the tool count matches what users see there. tools_registry is an
  // object keyed by tool-id; fall back to 0 if the workload isn't
  // initialized yet (sim-only mode). Order is tools → agents → RAG to
  // mirror the build sequence (you wire tools first, then agents that
  // use them, then RAG/vector retrieval on top).
  const tr = (typeof window!=='undefined' && window.workload) ? window.workload.tools_registry : null;
  const toolCount = (tr && typeof tr==='object') ? Object.keys(tr).length : 0;
  const fleetLine = `${toolCount} tools · ${n} agents · ${rag} RAG`;
  const eb=document.getElementById('agent-editor-badge');if(eb)eb.textContent=fleetLine;
  const ap=document.getElementById('appbar-fleet-stats');if(ap)ap.textContent=fleetLine;
  const sb=document.getElementById('agent-count-badge');if(sb)sb.textContent=n;
  // Refresh the topology diagram if its panel is currently open — keeps
  // chips/agent names in sync with edits without forcing the user to
  // re-toggle the panel.
  const archBody=document.getElementById('arch-diagram-body');
  if(archBody && archBody.style.display!=='none') renderArchDiagram();
}

/* ═══════ ARCHITECTURE DIAGRAM ═══════
   Live, hand-rolled HTML+CSS visualization of the fleet's coordination
   shape. Three canonical layouts, picked from sim.agents.length + the
   global executionMode:
     - Single   (1 agent, any mode)     User → Agent → Response
     - Workflow (executionMode==workflow) User → S1 → S2 → ... → Response
     - Fleet    (default, >1 agent)     User → Router → [Agents] → Synth → Response
   Per-agent chips (🛠 📚 🧠 🛡) light up from a.toolsOn / ragOn / reasonOn /
   guardOn so the diagram doubles as a sanity-check on per-agent config.
   The bottom icon strip flags behaviors that real fleets have but the
   canvas doesn't draw (retries / cascade / conditional / fallback) — each
   tooltip points at where that setting lives in the simulator. */
function _archEscape(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
function _archChips(a){
  const out=[];
  if(a.toolsOn) out.push(`<span title="Calls registered tools (~${(a.tools_per||0)|0}/turn). See Section B for the tool registry.">🛠</span>`);
  if(a.ragOn)   out.push(`<span title="Retrieves ~${(a.rag_chunks||0)|0} chunks/query × ${(a.rag_size||0)|0} tok from vector DB before answering.">📚</span>`);
  if(a.reasonOn)out.push(`<span title="Extended thinking enabled (~${(a.think_tok||0)|0} hidden reasoning tokens at ${(a.think_pct||0)|0}% activation).">🧠</span>`);
  if(a.guardOn) out.push(`<span title="Guardrails active (input/output/PII/policy scans on every turn).">🛡</span>`);
  return out.length ? `<div class="arch-chips">${out.join('')}</div>` : '';
}
function _archAgentBox(a,i){
  const col=a.col||'rgba(0,212,255,.45)';
  const name=_archEscape(a.name||('Agent '+(i+1)));
  const role=_archEscape(a.role||'');
  return `<div class="arch-node arch-agent" style="border-color:${col}55">
    <div style="color:${col};font-weight:700">${name}</div>
    ${role?`<div style="font-size:9px;color:var(--dim);font-weight:500">${role}</div>`:''}
    ${_archChips(a)}
  </div>`;
}
function renderArchDiagram(){
  const canvas=document.getElementById('arch-diagram-canvas');
  if(!canvas)return;
  const agents=(typeof sim!=='undefined' && Array.isArray(sim.agents))?sim.agents:[];
  const n=agents.length;
  if(n===0){canvas.innerHTML=`<div class="helper" style="text-align:center;padding:6px 0">No agents configured.</div>`;return;}
  // Pick layout from the user's explicit topology choice (preserved in
  // userTopology), not from n. This way clicking Fleet with 1 agent still
  // renders the Router/Synth fan-out — which is what Fleet means.
  const mode = (typeof userTopology!=='undefined' && userTopology) ? userTopology : 'fleet';

  const userNode='<div class="arch-node arch-edge"><div style="font-size:14px">👤</div><div>User</div></div>';
  const respNode='<div class="arch-node arch-edge"><div style="font-size:14px">💬</div><div>Response</div></div>';
  const arrow  ='<span class="arch-arrow">→</span>';

  let row;
  if(mode==='single'){
    row=[userNode,arrow,_archAgentBox(agents[0],0),arrow,respNode].join('');
  } else if(mode==='workflow'){
    const stages=agents.map((a,i)=>_archAgentBox(a,i)).join(arrow);
    row=[userNode,arrow,stages,arrow,respNode].join('');
  } else { // fleet
    const router=`<div class="arch-node arch-router" title="Fan-out: dispatches the same query to all agents in parallel."><div style="font-size:13px">⇆</div><div>Router</div></div>`;
    const synth =`<div class="arch-node arch-synth"  title="Fan-in: combines parallel agent outputs into one response."><div style="font-size:13px">⤇</div><div>Synth</div></div>`;
    const stack =`<div style="display:flex;flex-direction:column;gap:6px">${agents.map((a,i)=>_archAgentBox(a,i)).join('')}</div>`;
    row=[userNode,arrow,router,arrow,stack,arrow,synth,arrow,respNode].join('');
  }
  canvas.innerHTML=`<div style="display:flex;align-items:center;gap:9px;justify-content:center;flex-wrap:wrap;min-width:max-content">${row}</div>`;

  const extras=document.getElementById('arch-diagram-extras');
  if(extras){
    const retry = (typeof cfg==='function') ? (cfg('s-retry')||0) : 0;
    const w = (typeof window!=='undefined' && window.workload) ? window.workload : {};
    const casc = (w.verification && w.verification.cascade) || null;
    const cascRate = casc && casc.escalate_rate;
    const cascTo   = casc && casc.escalate_to;
    extras.innerHTML=`<div class="arch-meta">
      <span title="Retry rate: ${retry}% — failed API calls auto-reissued. Tune in Section A → Global parameters → Retry rate.">↺ retries (${retry}%)</span>
      <span title="Cascade verification: ${cascRate?'when the primary verifier flags a claim, it re-checks with '+_archEscape(cascTo||'a secondary verifier')+' (~'+(cascRate*100).toFixed(0)+'% escalate).':'not configured — set up in Section D → Fact-checking → Cascade.'}">⇉ cascade verify ${cascRate?'('+(cascRate*100).toFixed(0)+'%)':'(off)'}</span>
      <span title="Conditional branching: real fleets route by intent / confidence / quota (e.g. skip an expensive agent when the cheap one was confident). Not drawn — the diagram shows the canonical shape, not per-request routing decisions.">◇ conditional routing</span>
      <span title="Failure / fallback: on errors or timeouts, fleets typically retry on a cheaper model or return a graceful degrade. Built in to most provider SDKs; not visualized here.">⚠ fallback</span>
    </div>`;
  }
}
function toggleArchDiagram(){
  const body=document.getElementById('arch-diagram-body');
  const caret=document.getElementById('arch-toggle-caret');
  if(!body)return;
  const open = body.style.display==='none';
  body.style.display = open ? 'block' : 'none';
  if(caret) caret.textContent = open ? '▾ hide diagram' : '▸ show diagram';
  if(open) renderArchDiagram();
}

function renderAgents(){
  const targets=[['agent-list','sim'],['agent-settings-list','settings']];
  targets.forEach(([id,scope])=>{const el=document.getElementById(id);if(el)el.innerHTML=sim.agents.map(a=>agentCardHtml(a,scope)).join('');});
  renderAgentSettingsSummary();
}
function refreshAfterAgentEdit(){
  // Sync the global selectedModel to Agent 1 — Model Selection panel
  // is now a read-only rate reference, not an independent selector.
  if (sim.agents && sim.agents[0] && sim.agents[0].model && MODELS[sim.agents[0].model]) {
    selectedModel = sim.agents[0].model;
  }
  renderAgentSettingsSummary();updateCostPanel();renderLedger();updateKPIs();updateSensitivity();
  if (typeof renderModelSelector === 'function') renderModelSelector();
}
function togAgent(id){const a=sim.agents.find(x=>x.id===id);if(a){a.expanded=!a.expanded;renderAgents();}}
function setAllAgentsExpanded(open){sim.agents.forEach(a=>a.expanded=!!open);renderAgents();}

// User-driven add/remove/rename for sim.agents. Three rules:
// 1. Mutate sim.agents directly (don't go through buildAgents which
//    would rebuild from AGENT_DEF and wipe the user's edits).
// 2. Sync the #s-agents slider's value to sim.agents.length so the
//    global "Agents" pill reads correct. We set .value programmatically
//    so onSlider doesn't fire (which would trigger buildAgents).
// 3. Mirror to workload.agents via the existing bridge so the headline
//    pill reflects the new fleet size.
function _syncAgentsSlider() {
  const el = document.getElementById('s-agents');
  if (!el) return;
  // If the new length exceeds the slider's max, bump max so the slider
  // doesn't visually clamp. sim.agents.length is the source of truth.
  const max = parseInt(el.max || '8', 10);
  if (sim.agents.length > max) el.max = String(sim.agents.length);
  el.value = String(sim.agents.length);
  const v = document.getElementById('v-agents');
  if (v) v.textContent = String(sim.agents.length);
}
function _syncAgentsToWorkload() {
  // Push a full sim.agents snapshot into workload.agents so the engine
  // sees the new fleet size + per-agent richness. Uses the existing
  // __promoteAgentModeFromSimulator helper (which calls buildPayload →
  // __importFromSimulator) — same path the auto-sync wrapper uses.
  if (typeof window.__promoteAgentModeFromSimulator === 'function') {
    window.__promoteAgentModeFromSimulator();
  }
  if (typeof window.renderPreview === 'function') window.renderPreview();
}
function addAgentRow() {
  const n = sim.agents.length;
  // Pick a template — cycle through AGENT_DEF so colors / roles vary.
  const def = AGENT_DEF[n % AGENT_DEF.length] || AGENT_DEF[0];
  // Unique id: max existing id + 1 (sim agents historically use 0..N-1
  // but we don't enforce contiguity — id is just a stable handle).
  const nextId = sim.agents.length === 0 ? 0
               : Math.max(...sim.agents.map(a => Number(a.id) || 0)) + 1;
  const base = cloneAgentBase(def, nextId);
  // Give the new agent a distinct name so the list doesn't double up
  // ("Worker · Worker · Worker"). If the cloned base's name already
  // appears, append " #2" / " #3" etc.
  const existingNames = new Set(sim.agents.map(a => a.name));
  if (existingNames.has(base.name)) {
    let n = 2;
    while (existingNames.has(`${base.name} #${n}`)) n++;
    base.name = `${base.name} #${n}`;
  }
  base.expanded = true; // open the new agent so the user can edit it
  sim.agents.push(base);
  _syncAgentsSlider();
  renderAgents();
  refreshAfterAgentEdit();
  _syncAgentsToWorkload();
}
function removeAgentRow(id) {
  if (sim.agents.length <= 1) {
    if (typeof showToast === 'function') showToast('A fleet needs at least one agent. Add another before removing this one.', 3500);
    return;
  }
  const idx = sim.agents.findIndex(a => a.id === id);
  if (idx < 0) return;
  const removed = sim.agents.splice(idx, 1)[0];
  _syncAgentsSlider();
  renderAgents();
  refreshAfterAgentEdit();
  _syncAgentsToWorkload();
  if (typeof showToast === 'function') showToast(`Removed agent "${removed.name}".`, 2500);
}
function renameAgentRow(id) {
  const a = sim.agents.find(x => x.id === id);
  if (!a) return;
  const current = `${a.name}${a.role ? ' / ' + a.role : ''}`;
  const next = prompt('Rename agent — use "Name / Role" to set both, or just a name:', current);
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    a.name = trimmed.slice(0, slash).trim();
    a.role = trimmed.slice(slash + 1).trim();
  } else {
    a.name = trimmed;
  }
  renderAgents();
  refreshAfterAgentEdit();
  // Mirror to workload.agents — the bridge maps a.name/role to
  // workload.agents[i].label = `${name} (${role})`.
  if (window.workload && Array.isArray(window.workload.agents)) {
    const idx = sim.agents.findIndex(x => x.id === id);
    if (idx >= 0 && window.workload.agents[idx]) {
      window.workload.agents[idx].label = a.role ? `${a.name} (${a.role})` : a.name;
      if (typeof window.renderPreview === 'function') window.renderPreview();
    }
  }
}
function setAM(id,m){const a=sim.agents.find(x=>x.id===id);if(a){a.model=m;const md=MODELS[m];if(md&&(!a.provider||a.provider==='managed'||a.provider==='together'))a.provider=md.providerDefault||a.provider||'managed';_mirrorAgentEditToWorkload(id,'model',m);renderAgents();refreshAfterAgentEdit();}}
function setAP(id,k,v,lid,fmt){const a=sim.agents.find(x=>x.id===id);if(a){a[k]=v;if(lid){const el=document.getElementById(lid);if(el&&fmt)el.textContent=fmt(v);}_mirrorAgentEditToWorkload(id,k,v);refreshAfterAgentEdit();}}

// Sim-agent → workload.agents bridge for engine-consumed per-agent fields.
// Without this, editing a per-agent slider in the simulator card (sysprompt,
// iamsg, calls_per_turn_multiplier, model, guard_model) updated only the
// simulator-pane visualization — the cost engine never saw the change, so
// the headline pill stayed put. Maps sim-side keys to the engine's
// workload.agents schema and triggers renderPreview so the pill updates.
function _mirrorAgentEditToWorkload(simAgentId, k, v) {
  const wl = window.workload;
  if (!wl || !Array.isArray(wl.agents) || wl.agents.length === 0) return;
  // sim.agents[i].id is currently the index i (see cloneAgentBase); same
  // index addresses workload.agents[i]. If that invariant ever changes,
  // this mapping needs to swap to an explicit id lookup.
  const idx = simAgentId;
  if (!wl.agents[idx]) return;
  // Provider field is sim-side ('managed' | 'byok' | 'self-hosted' | ...);
  // the engine reads agent.hosting ('api' | 'byok' | 'self-host'). When the
  // user picks BYOK or Self-hosted in the per-agent dropdown, the engine
  // zeroes that agent's API contribution (cost-engine.js:381). Without
  // this translation, the sim dropdown was a no-op for billing —
  // changing it updated only the per-agent header label, not the bill.
  if (k === 'provider') {
    const hostingByProvider = { byok: 'byok', 'self-hosted': 'self-host' };
    wl.agents[idx].hosting = hostingByProvider[v] || 'api';
    if (typeof window.renderPreview === 'function') window.renderPreview();
    // Re-render the procurement-side Hosting dropdown (sec-agents) so it
    // stays in sync with the change made in Section C.
    if (typeof window.renderAgentsList === 'function') window.renderAgentsList();
    // Also re-render the SIM-side agent cards so the BYOK / SELF-HOST
    // badge swap in the header strip (cost-simulator.js agentCardHtml)
    // shows immediately. Without this, the data state changes correctly
    // but users only see the badge update after the next agent edit.
    if (typeof renderAgents === 'function') {
      try { renderAgents(); } catch (_) {}
    }
    return;
  }
  const mapping = {
    sysprompt: 'sysprompt_tokens',
    iamsg: 'iamsg_tokens',
    calls_per_turn_multiplier: 'calls_per_turn_multiplier',
    model: 'model',
    guard_model: 'guard_model',
    // cache_rate slider used to map to 'cache_eligible_rate' which the
    // engine never read. The engine now reads `cache_rate_override` —
    // see perQueryCostAgents in cost-engine.js. Accepts 0-1 fraction or
    // 1-99 integer percent; 0 means "inherit workload-wide rate".
    cache_rate: 'cache_rate_override',
    verify_enabled: 'verify_enabled',
    verify_coverage: 'verify_coverage',
    verifier_override: 'verifier_override',
    activation_rate: 'activation_rate',
    // Newly-wired sliders (2026-06). Until this batch, these all sat in
    // the simulator UI but never wrote to workload.agents, so the
    // headline pill ignored them. Engine fields are documented at the
    // matching block in cost-engine.js perQueryCostAgents.
    turnsShare: 'turn_share',
    maxOut: 'max_output_tokens',
    fewshot: 'fewshot_examples',
    jsonschema: 'jsonschema_tokens',
    memory: 'memory_tokens',
    citations: 'citation_output_tokens',
    rag_chunks: 'rag_chunks',
    rag_size: 'rag_tokens_per_chunk',
    rag_calls: 'rag_calls_per_query',
    think_tok: 'thinking_budget_tokens',
    think_pct: 'reasoning_turns_pct',
    cot: 'cot_steps',
    factcheck: 'factcheck_passes',
    guard_in: 'guard_input_tokens',
    guard_out: 'guard_output_tokens',
    guard_pii: 'guard_pii_tokens',
    guard_policy: 'guard_policy_tokens',
    // Calibration knobs (measured-band). Engine reads matching field
    // names directly off the agent object; precedence inside the engine
    // is agent > workload > engine default. See cost-engine.js
    // perQueryCostAgents tool result cost block.
    tool_result_cache_share: 'tool_result_cache_share',
    tool_result_react_persistence: 'tool_result_react_persistence',
  };
  const wlKey = mapping[k];
  if (!wlKey) return;
  // Nullable verify-override fields: blank/null in sim → DELETE from wl
  // so the engine falls back to workload-wide defaults instead of
  // treating `null` as an explicit zero override.
  if ((wlKey === 'verifier_override' || wlKey === 'verify_coverage') && (v == null || v === '')) {
    delete wl.agents[idx][wlKey];
  } else if (wlKey === 'activation_rate') {
    // Sim slider is 0-100 percent; engine expects 0-1. Convert at the
    // mirror boundary so each side keeps its native units (sliders
    // show integer % to the user; engine math reads a clean fraction).
    const pct = Number(v);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      wl.agents[idx][wlKey] = pct / 100;
    }
  } else {
    wl.agents[idx][wlKey] = v;
  }
  // Companion-field bridging — RAG cost = chunks × tokens_per_chunk ×
  // calls_per_query; reasoning cost = budget × pct/100. If the user
  // moves only one slider in the group, the engine reads the other
  // fields as undefined → 0 → the multiplication is 0 and the slider
  // appears dead. Push the companions' CURRENT sim state alongside the
  // primary edit so a single move propagates correctly.
  const simAgent = sim.agents.find(x => x.id === simAgentId);
  if (simAgent) {
    const companions = {
      rag_chunks: ['rag_size', 'rag_calls'],
      rag_size: ['rag_chunks', 'rag_calls'],
      rag_calls: ['rag_chunks', 'rag_size'],
      think_tok: ['think_pct'],
      think_pct: ['think_tok'],
    };
    for (const cmpKey of (companions[k] || [])) {
      const cmpWlKey = mapping[cmpKey];
      if (cmpWlKey && simAgent[cmpKey] != null) {
        wl.agents[idx][cmpWlKey] = simAgent[cmpKey];
      }
    }
  }
  if (typeof window.renderPreview === 'function') window.renderPreview();
}
// Sim-agent index → workload.agents lookup. sim.agents[i].id is the
// integer index (set by cloneAgentBase), but workload.agents[i].id is
// the JSON-defined string ('orch', 'researcher', ...). The two are
// joined positionally — sim.agents[i] mirrors workload.agents[i].
// Earlier mirror code used `find(x => x.id === a.id)` which silently
// failed for any preset whose JSON used string ids, leaving
// enabled_tools out of sync with the headline.
function _wlAgentForSimId(simId) {
  const idx = sim.agents.findIndex(x => x.id === simId);
  if (idx < 0) return null;
  if (!window.workload || !Array.isArray(window.workload.agents)) return null;
  return window.workload.agents[idx] || null;
}
function _wlAgentIdxForSimId(simId) {
  return sim.agents.findIndex(x => x.id === simId);
}

// Per-agent monthly cost lookup (populated by app.js renderPreview after
// each CostEngine.compute). Returns the agent's monthly $ contribution
// to the LLM bill, matching the headline pill's accounting.
function _agentCurrentMonthly(simId) {
  const idx = _wlAgentIdxForSimId(simId);
  if (idx < 0) return null;
  const arr = window.__perAgentMonthly;
  if (!Array.isArray(arr)) return null;
  return arr[idx] != null ? arr[idx] : null;
}

// Per-agent model-swap calculator. Clones the live workload, swaps
// this one agent's model to `modelKey`, re-runs the engine with the
// same opts the headline used, and reads the swapped agent's monthly
// contribution from the new agent_breakdown. Used by the agent card's
// "Compare models" table.
function _agentMonthlyUnderModel(simId, modelKey) {
  const idx = _wlAgentIdxForSimId(simId);
  if (idx < 0) return null;
  if (!window.workload || !window.workload.agents || !window.workload.agents[idx]) return null;
  if (!window.CostEngine || typeof window.CostEngine.compute !== 'function') return null;
  // Deep-clone just the agents array (rest of workload is shared by reference
  // for speed; the engine doesn't mutate, but a clone of the agent is needed
  // so we don't write through to the live workload).
  const w = Object.assign({}, window.workload);
  w.agents = window.workload.agents.map((a, i) => i === idx ? Object.assign({}, a, { model: modelKey }) : a);
  const opts = window.__lastEngineOpts || { hosting: 'api' };
  try {
    const r = window.CostEngine.compute(w, opts);
    const queries = (r.queries && r.queries.total) || 0;
    const entry = r.api && r.api.agent_breakdown && r.api.agent_breakdown[idx];
    if (!entry) return null;
    return (entry.per_query_cost || 0) * queries;
  } catch (e) { return null; }
}
// Per-agent enabled-tools toggle. Mirrors the agent.enabled_tools shape
// expected by app.js renderPreview (provider tool fees code).
function togAgentTool(id, toolId, checked) {
  const a = sim.agents.find(x => x.id === id);
  if (!a) return;
  if (!a.enabled_tools) a.enabled_tools = {};
  if (checked) {
    if (!a.enabled_tools[toolId]) a.enabled_tools[toolId] = { calls_per_query: 1 };
  } else {
    delete a.enabled_tools[toolId];
  }
  const wa = _wlAgentForSimId(id);
  if (wa) wa.enabled_tools = JSON.parse(JSON.stringify(a.enabled_tools));
  renderAgents();
  refreshAfterAgentEdit();
  if (typeof window.renderPreview === 'function') window.renderPreview();
}
// Expand/collapse the per-(agent, tool) override row beneath an
// enabled-tool entry. Lives on the agent (a._toolExpanded[toolId])
// so re-renders preserve which rows are open. Per-agent UI state —
// not in workload.agents schema.
function toggleAgentToolExpand(id, toolId) {
  const a = sim.agents.find(x => x.id === id);
  if (!a) return;
  if (!a._toolExpanded) a._toolExpanded = {};
  a._toolExpanded[toolId] = !a._toolExpanded[toolId];
  renderAgents();
}
// Per-(agent, tool) override setter. Mirrors return_shape_override
// and cap_tokens_override into agent.enabled_tools[toolId] and
// workload.agents[i].enabled_tools[toolId]. Blank value = delete the
// override so the engine falls back to per-tool registry default.
function setAgentToolOverride(id, toolId, key, valueStr) {
  const a = sim.agents.find(x => x.id === id);
  if (!a || !a.enabled_tools || !a.enabled_tools[toolId]) return;
  const spec = a.enabled_tools[toolId];
  if (valueStr === '' || valueStr == null) {
    delete spec[key];
  } else if (key === 'cap_tokens_override') {
    const v = parseFloat(valueStr);
    if (Number.isFinite(v) && v >= 0) spec[key] = v;
    else delete spec[key];
  } else {
    spec[key] = valueStr;
  }
  const wa2 = _wlAgentForSimId(id);
  if (wa2) wa2.enabled_tools = JSON.parse(JSON.stringify(a.enabled_tools));
  renderAgents();
  refreshAfterAgentEdit();
  if (typeof window.renderPreview === 'function') window.renderPreview();
}
// Per-(agent, tool) trigger rate. UI value is 0-100 (percent); stored
// on agent.enabled_tools[toolId].trigger_rate as 0-1 so it matches the
// workload-schema convention used elsewhere (engine reads 0-1).
function setAgentToolTriggerRate(id, toolId, valueStr) {
  const a = sim.agents.find(x => x.id === id);
  if (!a || !a.enabled_tools || !a.enabled_tools[toolId]) return;
  const pct = parseFloat(valueStr);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return;
  a.enabled_tools[toolId].trigger_rate = pct / 100;
  const wa = _wlAgentForSimId(id);
  if (wa) wa.enabled_tools = JSON.parse(JSON.stringify(a.enabled_tools));
  refreshAfterAgentEdit();
  if (typeof window.renderPreview === 'function') window.renderPreview();
}
function setAgentToolCalls(id, toolId, valueStr) {
  const a = sim.agents.find(x => x.id === id);
  if (!a || !a.enabled_tools || !a.enabled_tools[toolId]) return;
  const v = parseFloat(valueStr);
  a.enabled_tools[toolId].calls_per_query = Number.isFinite(v) && v >= 0 ? v : 0;
  const wa = _wlAgentForSimId(id);
  if (wa) wa.enabled_tools = JSON.parse(JSON.stringify(a.enabled_tools));
  refreshAfterAgentEdit();
  // renderPreview was missing here — engine-side cost (provider tool
  // fees) depends on calls_per_query but the headline pill wasn't
  // re-rendering on a calls/q change. Stale-render bug confirmed:
  // first renderPreview after tool enable showed old fees, second
  // renderPreview showed correct fees. Calling renderPreview here
  // closes the loop so the headline updates on every calls/q edit.
  if (typeof window.renderPreview === 'function') window.renderPreview();
}
function togAF(id,f,btn){const a=sim.agents.find(x=>x.id===id);if(!a)return;a[f]=!a[f];const labels={ragOn:['RAG','rag-on'],reasonOn:['THINK','reason-on'],guardOn:['GUARD','guard-on'],toolsOn:['TOOLS','on']};const[l,cls]=labels[f]||['','on'];if(btn){btn.textContent=l+' '+(a[f]?'ON':'OFF');btn.className='tgl '+(a[f]?cls:'');}renderAgents();refreshAfterAgentEdit();}
// applyGlobalsToAgents() removed — the global RAG/Tools/Guardrails sliders
// it pulled from were deleted in the per-agent canonicalization redesign
// (d03b276). The remaining global sliders are workload-shape only and
// don't broadcast to agents. Bulk-set lives inside each agent card as
// the "↧ Apply to all agents" affordance.
function applySelectedModelToAgents(){sim.agents.forEach(a=>{a.model=selectedModel;const md=MODELS[selectedModel];if(md)a.provider=md.providerDefault||a.provider||'managed';});renderAgents();refreshAfterAgentEdit();}
function resetAgentFleet(){buildAgents(true);renderAgents();refreshAfterAgentEdit();}
// Stage 3 of the per-agent redesign: bulk-set affordance from inside the
// agent card itself, replacing the old global-broadcast pattern. Copies
// every behavioral field (TOOLS / RAG / Reasoning / Guardrails / cache
// rate / temperature / task bias / max output / turn share) from the
// source agent to all others. Model and provider are intentionally NOT
// copied — each agent typically keeps its own model choice; the link's
// purpose is to bulk-equalize behavior settings, not to homogenize the
// fleet model-wise. Use the per-agent Model dropdown to change models.
window.applyAgentSettingsToAll = function(sourceId){
  if (!sim || !Array.isArray(sim.agents) || sim.agents.length <= 1) return;
  const src = sim.agents.find(x => x.id === sourceId);
  if (!src) return;
  // Same field list as AGENT_CONFIG_FIELDS minus model / provider.
  const SHARED_FIELDS = ['temp','maxOut','turnsShare','toolsOn','ragOn','reasonOn','guardOn',
    'tools_per','schema','result','rag_chunks','rag_size','rag_calls',
    'think_tok','think_pct','cot','factcheck',
    'guard_in','guard_out','guard_pii','guard_policy','cache_rate','task_bias'];
  let copied = 0;
  for (const a of sim.agents) {
    if (a.id === sourceId) continue;
    for (const k of SHARED_FIELDS) {
      if (src[k] !== undefined) a[k] = src[k];
    }
    copied++;
  }
  renderAgents();
  refreshAfterAgentEdit();
  if (typeof window.showToast === 'function') {
    window.showToast(`Copied ${src.name}'s settings to ${copied} other agent${copied===1?'':'s'} (model & provider preserved).`, 3500);
  }
};
function normalizeAgentTurns(){const n=sim.agents.length||1;const sum=sim.agents.reduce((s,a)=>s+(a.turnsShare||1),0)||n;const scale=n/sum;sim.agents.forEach(a=>a.turnsShare=Math.max(.2,Math.min(3,Math.round((a.turnsShare||1)*scale*10)/10)));renderAgents();refreshAfterAgentEdit();}

// Live simulator replay (toggleSim / scheduleTicks / runTick / convergence
// detection) was removed when the START button was hidden from the UI.
// The replay loop wrote into the same hidden topbar KPI stubs that
// updateKPIs() also writes to, so static-math updates continue to work;
// only the per-turn animated replay is gone. Helper functions that were
// only called from runTick (runArchPipeline, addUserMsg, addTyping,
// addAgentMsg, logTool, updateUtilBars, updateCtxBars, spawnSparks, etc.)
// are now unused; they're left in place for a follow-up dead-code pass
// rather than risking a wider deletion in this commit.
// Dead chat-replay + simulator-viz helpers removed (only ever called from
// runTick, which was deleted in 3448738). updateAgentChip, addUserMsg,
// addTyping, removeTyping, addAgentMsg, appChat, logTool, updateUtilBars,
// updateCtxBars all wrote to DOM stubs (chat-area, tool-log, util-bars,
// ctx-bars) that are display:none. spawnSparks lower in the file is the
// only remaining one; it's referenced by a vfx setting and left in place.

/* ═══════ KPIs ═══════ */
function updateKPIs(){
  // Gutted 2026-05-16: the kpi-* and arch-status DOM stubs this function
  // wrote to all live inside the topbar block at index.html:3747+ which
  // has been display:none since the per-agent redesign (their comments
  // already noted 'whole block hidden; kept so legacy JS can write to
  // these IDs without throwing'). The simulator-replay loop that fed
  // sim.totalIn/totalOut/etc. is also gone (runTick deleted in 3448738),
  // so even if the panel were re-shown, the values would all be 0.
  // Kept as a no-op function so the many onSlider/renderLedger/etc.
  // call sites stay valid; remove the call sites in a future pass.
}

/* ═══════ ONSLIDER ═══════ */
function onSlider(){
  const sv=(id,fmt)=>{const el=document.getElementById('v-'+id);if(el)el.textContent=fmt(cfg('s-'+id));};
  const svF=(id,fmt)=>{const el=document.getElementById('v-'+id);if(el)el.textContent=fmt(cfgF('s-'+id));};
  sv('agents',v=>v);sv('users',v=>v.toLocaleString());sv('turns',v=>v);
  // s-sessions is a float slider (step 0.01, range 0.01-10) — reading via
  // cfg() (parseInt) silently floors 0.2 → 0 and renders "Daily return
  // rate 0". Use the float reader so sub-1 values display honestly.
  svF('sessions',v=>v.toLocaleString(undefined,{maximumFractionDigits:2}));
  document.getElementById('v-cache').textContent=cfg('s-cache')+'%';
  document.getElementById('v-cache-write-share').textContent=cfg('s-cache-write-share')+'%';
  document.getElementById('v-batch').textContent=cfg('s-batch')+'%';
  const _vcc=document.getElementById('v-context-compression');
  if(_vcc) _vcc.textContent=cfg('s-context-compression')+'%';
  document.getElementById('v-retry').textContent=cfg('s-retry')+'%';
  document.getElementById('v-growth').textContent=cfg('s-growth')+'%';
  // v-peak (×-suffix integer) and v-lang-mult (×-suffix decimal) — both
  // were stuck at their initial hardcoded value because the on-slider
  // label-sync block above never wrote to them. cfgF preserves the 0.1
  // step on s-lang-mult; s-peak is integer-stepped so cfg is fine.
  const _vpk=document.getElementById('v-peak'); if(_vpk) _vpk.textContent=cfg('s-peak')+'×';
  const _vlm=document.getElementById('v-lang-mult'); if(_vlm) _vlm.textContent=cfgF('s-lang-mult').toFixed(1)+'×';
  sv('rag-chunks',v=>v);sv('rag-chunk-size',v=>v);sv('rag-query',v=>v);sv('rag-calls',v=>v);
  sv('think-tokens',v=>v);sv('think-pct',v=>v+'%');sv('factcheck',v=>v);sv('cot',v=>v);
  sv('guard-in',v=>v);sv('guard-out',v=>v);sv('guard-pii',v=>v);sv('guard-policy',v=>v);sv('guard-block',v=>v+'%');
  sv('tools',v=>v);sv('schema',v=>v);sv('toolresult',v=>v);sv('iamsg',v=>v);sv('sysprompt',v=>v);
  // Comm pattern: 0=orch, 1=peer, 2=sup — flip the label so the UI reflects
  // the active pattern. Numerical effect on cost is in computeCost (turnIn).
  const _vcp = document.getElementById('v-comm-pattern');
  if (_vcp) { const _cpv = cfg('s-comm-pattern'); _vcp.textContent = _cpv === 1 ? 'peer' : _cpv === 2 ? 'sup' : _cpv === 3 ? 'pipe' : 'orch'; }
  sv('images',v=>v);sv('audio',v=>v+'s');sv('pdf',v=>v);sv('codeinterp',v=>v);
  sv('fewshot',v=>v);sv('jsonschema',v=>v);sv('citations',v=>v);sv('memory',v=>v);
  sv('websearch-calls',v=>v);sv('filesearch-calls',v=>v);sv('container-sessions',v=>v);
  const gmp=[0,0.20,0.25,0.75,1.00,3.00];const el=document.getElementById('v-guard-model-cost');if(el)el.textContent='$'+gmp[cfg('s-guard-model')];
  // Auto-couple paired sliders so a single slider move always produces a
  // visible cost change. Reasoning gates on think_tok × think_pct/100;
  // moving just one of them yields 0. Guard cost is myGuardTok × guardModelPrice;
  // tokens with no model price selected → $0. Each first-touch lifts its
  // partner from a zero default to a sensible mid-range value so the
  // user sees the lever working immediately. Subsequent moves don't
  // re-couple — they only fire when the partner is still 0.
  if (cfg('s-think-tokens') > 0 && cfg('s-think-pct') === 0) {
    const tp = document.getElementById('s-think-pct'); if (tp) { tp.value = 50; const lbl = document.getElementById('v-think-pct'); if (lbl) lbl.textContent = '50%'; }
  }
  if (cfg('s-think-pct') > 0 && cfg('s-think-tokens') === 0) {
    const tt = document.getElementById('s-think-tokens'); if (tt) { tt.value = 2000; const lbl = document.getElementById('v-think-tokens'); if (lbl) lbl.textContent = '2000'; }
  }
  // No auto-couple for s-guard-model — guards are folded into turnIn when
  // s-guard-model=0 (see myGuardTokInTurn in computeCost). Forcing
  // s-guard-model > 0 would route guards to totalGuardCost which the
  // calc-side bridge doesn't import, hiding the slider's effect.

  // (Redesign 2026-05-15) The global Tools / RAG / Reasoning / Guardrails
  // sliders no longer broadcast to every agent on each tick. The agent
  // card is now the canonical per-agent editing surface. Each agent's
  // own .tools_per / .schema / .rag_chunks / etc. survive across slider
  // moves; the `agent.X ?? cfg('s-X')` fallback inside computeCost still
  // honors the global slider as a default for agents that have no value
  // set yet (e.g. freshly cloned anchor agent inheriting from AGENT_DEF).
  //
  // Phase 2 will remove the global panels entirely. Until then, treat
  // the global sliders as one-shot defaults for new agents — not as a
  // live editor for the fleet.

  renderLedger();updateCostPanel();updateKPIs();updateSensitivity();
  if(sim.agents.length!==cfg('s-agents')){buildAgents();buildUsers();renderAgents();}
  else{renderAgentSettingsSummary();}

  // simulator sliders are the single source of truth for traffic. Every
  // slider change re-runs the calc-side renderPreview so the headline
  // monthly cost reflects the new sessions/turns/etc.
  if (typeof window.renderPreview === 'function') {
    try { window.renderPreview(); } catch (e) { /* preview not ready yet */ }
  }

  // Keep the topbar pill in sync with the configured fleet — the user
  // sees what they actually built, not a stale "Multi-Agent Fleet" label
  // they can't change.
  const _ml = document.getElementById('mode-label');
  if (_ml) {
    const _n = cfg('s-agents');
    if (_n <= 1) _ml.textContent = '1 agent';
    else if (typeof executionMode !== 'undefined' && executionMode === 'workflow') _ml.textContent = `${_n} stages · workflow`;
    else _ml.textContent = `${_n} agents · fleet`;
  }

  // Workflow mode slider labels
  if(document.getElementById('s-stage-handoff')) document.getElementById('v-stage-handoff').textContent = cfg('s-stage-handoff')+'%';
  if(document.getElementById('s-rerun')) document.getElementById('v-rerun').textContent = cfg('s-rerun')+'%';
  if(document.getElementById('s-template-runs')) document.getElementById('v-template-runs').textContent = cfg('s-template-runs');
  if(document.getElementById('s-doc-pdfs')) document.getElementById('v-doc-pdfs').textContent = cfg('s-doc-pdfs');
  if(document.getElementById('s-doc-pages')) document.getElementById('v-doc-pages').textContent = cfg('s-doc-pages');
  if(document.getElementById('s-doc-tok-page')) document.getElementById('v-doc-tok-page').textContent = cfg('s-doc-tok-page');
  if(document.getElementById('s-doc-stages-pct')) document.getElementById('v-doc-stages-pct').textContent = cfg('s-doc-stages-pct')+'%';
  // Legacy s-fc-* label sync removed 2026-05-25 (sliders deleted).
  if(document.getElementById('s-pause-hrs')) document.getElementById('v-pause-hrs').textContent = cfg('s-pause-hrs')+'h';
  if(document.getElementById('s-pauses')) document.getElementById('v-pauses').textContent = cfg('s-pauses');
  if(document.getElementById('s-storage-rate')){
    const storageRates=[0,0.00005,0.0001,0.0005,0.001,0.005,0.01,0.02,0.03,0.04,0.05];
    document.getElementById('v-storage-rate').textContent = '$'+(storageRates[cfg('s-storage-rate')]||0).toFixed(5);
  }
  if(document.getElementById('s-parallel-branches')) document.getElementById('v-parallel-branches').textContent = cfg('s-parallel-branches');
  if(document.getElementById('s-concurrent-quota')) document.getElementById('v-concurrent-quota').textContent = cfg('s-concurrent-quota');
  if(document.getElementById('s-rate-overage')) document.getElementById('v-rate-overage').textContent = cfg('s-rate-overage')+'%';
}

/* ═══════ TAB NAV ═══════
   All simulator tab panels render stacked simultaneously (single-page flow).
   showTab() now just scrolls to the corresponding section header. The
   tab-sim grid stays gated by toggleSim(): when 'sim' is requested we
   reveal the live-simulation grid (which is hidden by default).
   ====================================== */
function showTab(name){
  // Keep .active state purely as a marker (some renderers may inspect it).
  // 'arch' and 'sim' tabs were removed in the 2026-05 cleanup; their
  // markup is gone but other tabs (config/agents/etc.) still wire here.
  const TABS=['config','audience','agents','tokens','cost','routing','methodology','sensitivity'];
  TABS.forEach(t=>{
    const p=document.getElementById('tab-'+t);
    if(p){p.classList.toggle('active',t===name);}
  });
  if(name==='audience' && typeof renderAudience==='function')renderAudience();
  const target=document.getElementById('axiom-h-'+name);
  if(target){target.scrollIntoView({behavior:'smooth',block:'start'});}
}

/* ═══════ REPORT ═══════ */
function openReport(){
  const sc=computeCost();const sess=cfg('s-sessions');const monthly=sc.netCost*sess*30;
  document.getElementById('report-content').innerHTML=`<div style="font-family:'JetBrains Mono',monospace;color:var(--text-primary,#c8d8f0)">
    <div style="font-size:15px;font-weight:700;color:var(--cyan);letter-spacing:3px;margin-bottom:3px">Token Intelligence Report</div>
    <div style="font-size:8px;color:var(--dim);margin-bottom:14px">${new Date().toUTCString()} · Model: ${selectedModel}</div>
    <div class="report-h">Token Cost Summary (p50 / p90 / p99)</div>
    ${[['Net cost / session','$'+(sc.netCost||0).toFixed(5)+' / $'+p90(sc.netCost).toFixed(5)+' / $'+p99(sc.netCost).toFixed(5),'var(--green)'],['Monthly (sessions/day='+sess+')','$'+Math.round(monthly).toLocaleString()+' / $'+Math.round(p90(monthly)).toLocaleString()+' / $'+Math.round(p99(monthly)).toLocaleString(),'var(--amber)'],['RAG token share','$'+(sc.ragCost||0).toFixed(5)+'  ('+Math.round(sc.ragTokPerTurn)+' tok/turn)','var(--rag)'],['RAG embedding cost','+$'+(sc.ragEmbedCost||0).toFixed(5),'var(--rag)'],['Reasoning token share','$'+(sc.reasonCost||0).toFixed(5)+'  ('+Math.round(sc.reasonTokPerTurn)+' tok/turn)','var(--reason)'],['Guardrail cost','+$'+(sc.totalGuardCost||0).toFixed(5)+'  waste:$'+(sc.guardWaste||0).toFixed(5),'var(--guard)'],['Tool token share','$'+(sc.toolOHCost||0).toFixed(5),'var(--purple)'],['External tool fees','+$'+(sc.toolFeeCost||0).toFixed(5),'var(--purple)'],['Cache savings vs list','$'+(sc.cacheSave||0).toFixed(5),'var(--green)'],['Retry waste/sess','+$'+(sc.retryWaste||0).toFixed(5),'var(--red)']].map(([l,v,c])=>`<div class="report-row"><span>${l}</span><span style="color:${c};font-weight:700">${v}</span></div>`).join('')}
    <div class="report-h" style="margin-top:12px">All Model Comparison</div>
    ${MK.map(k=>{const c=computeCost(k);const m=MODELS[k];const mo=Math.round(c.netCost*monthly/sc.netCost);return `<div class="report-row"><span style="color:${m.color}">${k}</span><span>p50:${(c.netCost||0).toFixed(5)} p90:${p90(c.netCost).toFixed(5)} · mo-p50:${Math.round(c.netCost*sess*30).toLocaleString()} mo-p99:${Math.round(p99(c.netCost*sess*30)).toLocaleString()} · lat:${m.lat}ms</span></div>`;}).join('')}
    <div class="report-h" style="margin-top:12px">Methodology</div>
    <div style="font-size:8px;color:var(--dim);line-height:1.8">Token counting: browser heuristic only; validate with provider token counters. RAG: ${cfg('s-rag-chunks')} chunks × ${cfg('s-rag-chunk-size')}t × ${cfg('s-rag-calls')} calls/turn. Extended thinking: ${cfg('s-think-tokens')}t budget at ${cfg('s-think-pct')}% of turns. CoT: ${cfg('s-cot')} steps × 150t. Fact-check: ${cfg('s-factcheck')} passes × 200t. Guardrails: input ${cfg('s-guard-in')}t + output ${cfg('s-guard-out')}t + PII ${cfg('s-guard-pii')}t + policy ${cfg('s-guard-policy')}t per turn. Tool schema ${cfg('s-schema')}t + result ${cfg('s-toolresult')}t per call. CI: lognormal p90=exp(μ+1.282σ), p99=exp(μ+2.326σ), CV=${(wCV()*100).toFixed(0)}% weighted by task mix.</div>
  </div>`;
  document.getElementById('modal-overlay').className='modal-overlay show';
}
function closeReport(){document.getElementById('modal-overlay').className='modal-overlay';}
function exportCSV(){
  const sess=cfg('s-sessions');
  const rows=[['Model','api_id','status','source','input_per_1M','cached_input_per_1M','output_per_1M','long_context_threshold','long_input_per_1M','long_cached_input_per_1M','long_output_per_1M','api_total','rag_token_share','rag_embedding','reasoning_share','guardrails','guard_waste','tool_token_share','external_tool_fees','cache_read_tokens','cache_write_tokens','cache_save_vs_list','batch_save_vs_list','retry','net_p50','net_p90','net_p99','monthly_p50','monthly_p90','monthly_p99']];
  MK.forEach(k=>{const c=computeCost(k);const m=MODELS[k];const mo=c.netCost*sess*30;rows.push([k,m.api_id||k,m.status||'',m.source||'',m.in,m.cacheRead??'',m.out,m.longThreshold||'',m.longIn??'',m.longCacheRead??'',m.longOut??'',(c.baseCost||0).toFixed(6),(c.ragCost||0).toFixed(6),(c.ragEmbedCost||0).toFixed(6),(c.reasonCost||0).toFixed(6),(c.totalGuardCost||0).toFixed(6),(c.guardWaste||0).toFixed(6),(c.toolOHCost||0).toFixed(6),(c.toolFeeCost||0).toFixed(6),Math.round(c.cacheReadTok||0),Math.round(c.cacheWriteTok||0),(c.cacheSave||0).toFixed(6),(c.batchSave||0).toFixed(6),(c.retryWaste||0).toFixed(6),(c.netCost||0).toFixed(6),p90(c.netCost).toFixed(6),p99(c.netCost).toFixed(6),Math.round(mo),Math.round(p90(mo)),Math.round(p99(mo))]);});
  const csv=rows.map(r=>r.map(v=>String(v).includes(',')?'"'+String(v).replace(/"/g,'""')+'"':v).join(',')).join('\n');
  const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download='token_simulator_costs.csv';a.click();
}

/* ═══════ PARTICLE BG ═══════ */
const bgC=document.getElementById('bg');const bgX=bgC.getContext('2d');let bW,bH,bPs=[];
function rzBg(){bW=bgC.width=window.innerWidth;bH=bgC.height=window.innerHeight;}
function iPts(){bPs=Array.from({length:20},()=>({x:Math.random()*bW,y:Math.random()*bH,vx:(Math.random()-.5)*.14,vy:(Math.random()-.5)*.14,r:Math.random()*.8+.3}));}
function dBg(){bgX.clearRect(0,0,bW,bH);bPs.forEach(p=>{p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>bW)p.vx*=-1;if(p.y<0||p.y>bH)p.vy*=-1;bgX.globalAlpha=.1;bgX.fillStyle=document.body.classList.contains('theme-tactical')?'#00d4ff':'#0077cc';bgX.beginPath();bgX.arc(p.x,p.y,p.r,0,Math.PI*2);bgX.fill();bPs.forEach(q=>{const d=Math.hypot(p.x-q.x,p.y-q.y);if(d<70){bgX.globalAlpha=(1-d/70)*.025;bgX.strokeStyle=document.body.classList.contains('theme-tactical')?'#00d4ff':'#0077cc';bgX.lineWidth=.4;bgX.beginPath();bgX.moveTo(p.x,p.y);bgX.lineTo(q.x,q.y);bgX.stroke();}});});bgX.globalAlpha=1;requestAnimationFrame(dBg);}
rzBg();iPts();dBg();window.addEventListener('resize',()=>{rzBg();iPts();});

// spawnSparks() removed — only ever called from runTick (deleted in
// 3448738); fired animated overlay sparks during the live replay.
function shuffle(a){return[...a].sort(()=>Math.random()-.5);}
function wait(ms){return new Promise(r=>setTimeout(r,ms));}
function now(){return new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});}


/* THEME-AWARE CHART COLORS */
function getChartColors(){
  const isDark = document.body.classList.contains('theme-tactical');
  return {
    grid:  isDark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,50,.07)',
    tick:  isDark ? 'rgba(180,200,230,.5)'  : 'rgba(20,40,80,.6)',
    bg:    isDark ? '#04060c' : '#f8f9fb',
    text:  isDark ? '#c8d8f0' : '#1a2332',
  };
}

/* Convergence detection (checkConvergence / showConvergence) was only
   used by the removed runTick loop to early-exit when 10 consecutive
   ticks were within ±2% of the running mean. No live replay = no
   convergence check; deleted with the rest of the replay chain. */
/* THEMES — apply theme class to BOTH <body> (so calc's body-level
   overrides take effect) AND .simulator-pane (so the simulator's existing CSS
   keeps working). Use classList.toggle so unrelated body classes are
   preserved. */
function setTheme(t){
  ['theme-tactical','theme-mission','theme-command'].forEach(c=>{
    document.body.classList.remove(c);
    document.querySelectorAll('.simulator-pane').forEach(p=>p.classList.remove(c));
  });
  document.body.classList.add('theme-'+t);
  document.querySelectorAll('.simulator-pane').forEach(p=>p.classList.add('theme-'+t));
  document.querySelectorAll('.theme-btn').forEach(b=>b.classList.toggle('active',b.dataset.theme===t));
  // Keep the appbar dropdown in sync — it replaced the 3-button pill but
  // setTheme can still be called from programmatic paths.
  const dd=document.getElementById('appbar-theme-select');
  if(dd && dd.value!==t) dd.value=t;
  setTimeout(()=>{
    try{updateCostPanel();renderLedger();updateSensitivity();}catch(e){}
    const ac=document.getElementById('arch-canvas');
    if(ac){const ctx2=ac.getContext('2d');const tc=getChartColors();ctx2.fillStyle=tc.bg;ctx2.fillRect(0,0,ac.width,ac.height);}
  },60);
}
// Apply default theme on load (mission). No persistence across reloads —
// the dropdown is the in-session source of truth.
(function applyDefaultTheme(){
  const apply = () => { try{ setTheme('mission'); }catch(e){ console.warn('setTheme deferred:',e); setTimeout(apply,200);} };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',apply);
  else apply();
})();

/* ═══════ UI MODE (basic vs advanced) ═══════
   Two-mode UI: BASIC hides .advanced-only nodes (per CSS in index.html);
   ADVANCED exposes every knob. Mode persists via URL hash
   (#...&mode=basic|advanced) — no localStorage — so a shared link carries
   the mode through to the recipient. Default boot mode: basic. The engine
   math is unchanged regardless of mode — hidden controls keep their
   preset defaults. */
function setUiMode(m){
  const mode = m === 'advanced' ? 'advanced' : 'basic';
  document.body.classList.remove('mode-basic','mode-advanced');
  document.body.classList.add('mode-' + mode);
  // Sync the segmented-pill toggle (Basic | Advanced). aria-checked
  // drives the CSS that paints the white inner pill on the selected
  // segment; data-mode lets the click handler dispatch back through here.
  // role="radio" inside role="group" is the WAI-ARIA pattern for a 2-state
  // toggle with no panel (not role="tablist", which requires panels).
  const pill = document.getElementById('mode-toggle');
  if (pill) {
    pill.querySelectorAll('[data-mode]').forEach(btn => {
      btn.setAttribute('aria-checked', btn.dataset.mode === mode ? 'true' : 'false');
    });
  }
  // Hash update is delegated to the debounced workload-state serializer
  // in app.js (window.__scheduleHashUpdate, called below). It reads body
  // class and re-emits the canonical #w=<base64>&mode=<mode> form,
  // preserving the workload payload alongside the mode. A synchronous
  // replaceState here would double-write — the debounce would still fire
  // 500ms later with the body class and rebuild the same hash — so we
  // drop the sync write entirely. Body class is the single source of
  // truth; the hash writer reads it on every fire.
  // If the active sidebar tab is now hidden, switch to a safe visible
  // tab so the report area doesn't show a dead state.
  try {
    const active = document.querySelector('.sidebar .tab-btn.active');
    if (mode === 'basic' && active && active.classList.contains('advanced-only')) {
      const fallback = document.querySelector('.sidebar .tab-btn[data-wiz="report"]')
                    || document.querySelector('.sidebar .tab-btn[data-wiz="profile"]')
                    || document.querySelector('.sidebar .tab-btn:not(.advanced-only)');
      if (fallback) fallback.click();
    }
  } catch(_){ /* tab fallback is best-effort */ }
  // Re-trigger the workload-hash serializer (defined in app.js) so the
  // freshly-set body class gets reflected in the hash. Without this,
  // an initial-render renderPreview that fires BEFORE setUiMode finishes
  // would write a hash without mode= and we'd lose the mode in the URL.
  try {
    if (typeof window.__scheduleHashUpdate === 'function') {
      window.__scheduleHashUpdate();
    }
  } catch(_){ /* hash re-trigger is best-effort */ }
}

// Boot: read mode from URL hash, default basic. Wire hashchange so an
// external nav (browser back/forward, or another script editing the
// hash) re-syncs the mode display.
(function _initUiMode(){
  const apply = () => {
    try {
      const m = (window.location.hash || '').match(/[#&]mode=(basic|advanced)/);
      // Default boot mode: advanced. Procurement-only viewers who want
      // the trimmed Basic surface can flip the toggle (the pill in the
      // appbar) or share a URL with #mode=basic.
      setUiMode(m ? m[1] : 'advanced');
    } catch(e){ console.warn('UI mode init deferred:',e); setTimeout(apply,200); }
  };
  const wireHashChange = () => {
    window.addEventListener('hashchange', () => {
      const m = (window.location.hash || '').match(/[#&]mode=(basic|advanced)/);
      const desired = m ? m[1] : 'advanced';
      const current = document.body.classList.contains('mode-advanced') ? 'advanced' : 'basic';
      if (desired !== current) setUiMode(desired);
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { apply(); wireHashChange(); });
  } else {
    apply(); wireHashChange();
  }
})();

/* ═══════ AUDIENCE BLOCK ═══════
   Single canonical UI for editing per-segment audience data (MAU /
   sessions / questions / bot factor). Replaces the legacy duplication
   between the 3 global sliders and the report-side per-segment editor.

   Two visual modes, auto-selected from workload.segments.length:
   - single (1 segment):  3 sliders + "Split into audience types" CTA
   - multi  (2+ segments): per-segment cards + "Add another audience" CTA

   No new persisted state. The view is derived from segments.length on
   every render. Engine math is unchanged — both views write to
   workload.segments[] which is the engine's only audience source of
   truth. The 3 sliders (#s-users / #s-sessions / #s-turns) stay in the
   DOM in all modes so existing reads in app.js / cost-engine.js keep
   working; in multi-mode they're hidden (display:none via the
   data-audience-view container) and their .value is kept synced to the
   aggregate (sum-of-MAU, MAU-weighted sessions and questions) so
   anything that polls them gets a sensible number. */
function renderAudienceBlock() {
  const block = document.getElementById('audience-block');
  if (!block) return; // not on this page
  const w = window.workload;
  if (!w || !Array.isArray(w.segments)) return;
  const single = block.querySelector('[data-audience-view="single"]');
  const multi  = block.querySelector('[data-audience-view="multi"]');
  if (!single || !multi) return;
  const isMulti = w.segments.length >= 2;
  single.hidden = isMulti;
  multi.hidden  = !isMulti;
  // Panel-header badge reflects the current mode at a glance.
  const badge = document.getElementById('audience-mode-badge');
  if (badge) badge.textContent = isMulti ? `${w.segments.length} audiences` : 'single';
  // Always sync the 3 hidden slider inputs to the aggregate so
  // downstream code that reads cfg('s-users')/etc. gets the right
  // number regardless of mode. In single-mode these are the live
  // controls; in multi-mode they're downstream mirrors.
  const totals = w.segments.reduce((acc, seg) => {
    const mau = Number(seg.mau) || 0;
    acc.mau += mau;
    acc.sessionsWeight += mau * (Number(seg.sessions_per_day) || 0);
    acc.questionsWeight += mau * (Number(seg.questions_per_session) || 0);
    return acc;
  }, { mau: 0, sessionsWeight: 0, questionsWeight: 0 });
  const wSess = totals.mau > 0 ? totals.sessionsWeight / totals.mau : 0;
  const wQ    = totals.mau > 0 ? totals.questionsWeight / totals.mau : 0;
  const sUsers = document.getElementById('s-users');
  const sSess  = document.getElementById('s-sessions');
  const sTurns = document.getElementById('s-turns');
  if (sUsers) sUsers.value = String(Math.min(parseInt(sUsers.max || '500000', 10), Math.max(1, Math.round(totals.mau))));
  if (sSess)  sSess.value  = String(Math.max(0.01, Number(wSess.toFixed(2))));
  if (sTurns) sTurns.value = String(Math.max(1, Math.round(wQ)));
  // Update the value-labels next to the sliders (single-mode visible UI).
  const vUsers = document.getElementById('v-users');
  const vSess  = document.getElementById('v-sessions');
  const vTurns = document.getElementById('v-turns');
  if (vUsers) vUsers.textContent = totals.mau.toLocaleString();
  if (vSess)  vSess.textContent  = wSess.toFixed(2);
  if (vTurns) vTurns.textContent = String(Math.round(wQ));
  if (isMulti) renderAudienceMulti(w.segments);
}

function renderAudienceMulti(segs) {
  const summary = document.getElementById('audience-summary');
  const cards = document.getElementById('audience-cards');
  if (!summary || !cards) return;
  const totalMau = segs.reduce((s, x) => s + (Number(x.mau) || 0), 0);
  const wSess = totalMau > 0 ? segs.reduce((s, x) => s + (Number(x.mau) || 0) * (Number(x.sessions_per_day) || 0), 0) / totalMau : 0;
  const wQ    = totalMau > 0 ? segs.reduce((s, x) => s + (Number(x.mau) || 0) * (Number(x.questions_per_session) || 0), 0) / totalMau : 0;
  // Use explicit inline color on the bold totals — earlier <b> rendered
  // invisible because a global b{} rule (or theme override) was making
  // it white-on-light. Inline color forces visibility across themes.
  const b = (txt) => `<span style="color:#0B3D91;font-weight:700">${txt}</span>`;
  summary.innerHTML = `Total: ${b(totalMau.toLocaleString() + ' MAU')} across ${b(segs.length)} audiences · `
                    + `${b(wSess.toFixed(2))} sess/day (weighted) · ${b(Math.round(wQ))} q/session (weighted)`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  cards.innerHTML = segs.map((seg, i) => `
    <fieldset class="audience-card" data-seg-idx="${i}">
      <div class="audience-card-head">
        <input type="text" class="audience-card-label-input" data-seg-label="${i}"
               value="${esc(seg.label || seg.id || `Audience ${i + 1}`)}"
               aria-label="Audience ${i + 1} label">
        <button type="button" class="audience-card-remove" data-seg-remove="${i}"
                title="Remove this audience type">× remove</button>
      </div>
      <div class="audience-card-fields">
        <div class="sr">
          <div class="sr-top">
            <span class="sr-label is-measured" data-tip="### Monthly active users (MAU)

**In plain English:** how many distinct people use this audience in a typical month. Counted as unique humans, NOT visits or sessions.

**Why this audience is measured.** Pull this number from real analytics — login records for authenticated audiences, web-analytics dedup for anonymous ones. The whole bill scales linearly with MAU so a 2× error here means a 2× error on the bill.">Monthly active users</span>
            <span class="sr-val" data-seg-mau-val="${i}" style="color:var(--cyan)">${(Number(seg.mau) || 0).toLocaleString()}</span>
          </div>
          <input type="range" min="1" max="500000" step="1" value="${Number(seg.mau) || 1}" data-seg-mau="${i}" aria-label="Monthly active users for ${esc(seg.label || seg.id)}">
          <div class="sr-hint">📊 from analytics · unique humans per month in this audience</div>
        </div>
        <div class="sr">
          <div class="sr-top">
            <span class="sr-label is-measured" data-tip="### Sessions per user per day

**In plain English:** the average number of times a single user opens a session per day. Fractional rate — most users don't show up every day so realistic values sit well below 1.0.

**Why this audience is measured.** Pull from analytics (login events or web visits). Public portals usually sit around 0.1–0.3 (most visitors don't return). Internal tools sit higher (0.5–3.0).">Sessions / day</span>
            <span class="sr-val" data-seg-sess-val="${i}" style="color:var(--cyan)">${(Number(seg.sessions_per_day) || 0).toFixed(2)}</span>
          </div>
          <input type="range" min="0.01" max="10" step="0.01" value="${Number(seg.sessions_per_day) || 0.01}" data-seg-sess="${i}" aria-label="Sessions per user per day for ${esc(seg.label || seg.id)}">
          <div class="sr-hint">📊 from analytics · how often each user comes back (≤1 typical)</div>
        </div>
        <div class="sr">
          <div class="sr-top">
            <span class="sr-label is-measured" data-tip="### Questions per session

**In plain English:** how many back-and-forth exchanges happen in one chat session for this audience. One question + assistant reply = one turn.

**Why this audience is measured.** Pull from chat-log analytics. Quick Q&A audiences (search-style): 1–3. Deep research / analyst audiences: 8–20.">Questions / session</span>
            <span class="sr-val" data-seg-q-val="${i}" style="color:var(--cyan)">${Math.round(Number(seg.questions_per_session) || 0)}</span>
          </div>
          <input type="range" min="1" max="40" step="1" value="${Math.max(1, Number(seg.questions_per_session) || 1)}" data-seg-q="${i}" aria-label="Questions per session for ${esc(seg.label || seg.id)}">
          <div class="sr-hint">📊 from analytics · turns per session</div>
        </div>
        <label class="bot-cell" title="Apply the global bot-factor multiplier to this audience (typical for anonymous public segments).">
          Apply Bot factor
          <input type="checkbox" data-seg-bot="${i}" ${seg.applyBotFactor ? 'checked' : ''}>
        </label>
      </div>
    </fieldset>
  `).join('');
}

// Expose so app.js can re-render after preset loads / hash restores
// without duplicating the audience-block logic in two places.
window.__renderAudienceBlock = renderAudienceBlock;

/* Click handlers — wired once via event delegation on the block. */
(function _wireAudienceBlock() {
  const block = document.getElementById('audience-block');
  if (!block) return;
  const onMutate = () => {
    // Re-render the block (could be a mode flip) and re-run the
    // cost preview so the headline reflects the new segments.
    renderAudienceBlock();
    if (typeof window.renderPreview === 'function') {
      window.renderPreview();
    } else if (typeof onSlider === 'function') {
      onSlider();
    }
  };
  block.addEventListener('click', (e) => {
    const t = e.target;
    // "+ Split into audience types"
    if (t && t.id === 'audience-split-btn') {
      const w = window.workload;
      if (!w || !Array.isArray(w.segments) || w.segments.length === 0) return;
      // Push a default new segment alongside the existing one.
      w.segments.push({
        id: 'auth', label: 'Authenticated',
        mau: 1000, sessions_per_day: 0.2, questions_per_session: 5,
        applyBotFactor: false
      });
      onMutate();
      return;
    }
    // "+ Add another audience type"
    if (t && t.id === 'audience-add-btn') {
      const w = window.workload;
      if (!w || !Array.isArray(w.segments)) return;
      const used = new Set(w.segments.map(s => s.id));
      let id = 'audience' + (w.segments.length + 1);
      while (used.has(id)) id += '_';
      w.segments.push({
        id, label: id,
        mau: 1000, sessions_per_day: 0.2, questions_per_session: 5,
        applyBotFactor: false
      });
      onMutate();
      return;
    }
    // "× remove" on a card
    if (t && t.dataset && t.dataset.segRemove != null) {
      const w = window.workload;
      const idx = parseInt(t.dataset.segRemove, 10);
      if (!w || !Array.isArray(w.segments) || !Number.isInteger(idx)) return;
      if (w.segments.length <= 1) return; // never go to zero from the UI
      w.segments.splice(idx, 1);
      onMutate();
      return;
    }
  });
  // Number-input edits inside cards
  block.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    const w = window.workload;
    if (!w || !Array.isArray(w.segments)) return;
    const idxStr = t.dataset.segMau ?? t.dataset.segSess ?? t.dataset.segQ ?? t.dataset.segLabel;
    if (idxStr == null) return;
    const idx = parseInt(idxStr, 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= w.segments.length) return;
    const seg = w.segments[idx];
    if (t.dataset.segMau != null) {
      seg.mau = Math.max(0, Number(t.value) || 0);
      const label = document.querySelector(`[data-seg-mau-val="${idx}"]`);
      if (label) label.textContent = seg.mau.toLocaleString();
    } else if (t.dataset.segSess != null) {
      seg.sessions_per_day = Math.max(0, Number(t.value) || 0);
      const label = document.querySelector(`[data-seg-sess-val="${idx}"]`);
      if (label) label.textContent = seg.sessions_per_day.toFixed(2);
    } else if (t.dataset.segQ != null) {
      seg.questions_per_session = Math.max(0, Number(t.value) || 0);
      const label = document.querySelector(`[data-seg-q-val="${idx}"]`);
      if (label) label.textContent = String(Math.round(seg.questions_per_session));
    } else if (t.dataset.segLabel != null) {
      seg.label = String(t.value || '').trim() || seg.id;
    }
    // Don't re-render the cards on every keystroke — that destroys focus.
    // Just sync the hidden inputs + summary + re-run the cost engine.
    renderAudienceBlock_summaryOnly();
    if (typeof window.renderPreview === 'function') window.renderPreview();
    else if (typeof onSlider === 'function') onSlider();
  });
  // Bot-factor checkbox edits
  block.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.dataset || t.dataset.segBot == null) return;
    const w = window.workload;
    const idx = parseInt(t.dataset.segBot, 10);
    if (!w || !Array.isArray(w.segments) || !Number.isInteger(idx)) return;
    if (idx < 0 || idx >= w.segments.length) return;
    w.segments[idx].applyBotFactor = !!t.checked;
    renderAudienceBlock_summaryOnly();
    if (typeof window.renderPreview === 'function') window.renderPreview();
    else if (typeof onSlider === 'function') onSlider();
  });
})();

// Refresh just the summary line + hidden-input mirrors without
// re-rendering the cards (which would steal focus from whatever input
// the user is typing into).
function renderAudienceBlock_summaryOnly() {
  const w = window.workload;
  if (!w || !Array.isArray(w.segments)) return;
  // Hidden mirrors
  const totals = w.segments.reduce((acc, seg) => {
    const mau = Number(seg.mau) || 0;
    acc.mau += mau;
    acc.sessW += mau * (Number(seg.sessions_per_day) || 0);
    acc.qW += mau * (Number(seg.questions_per_session) || 0);
    return acc;
  }, { mau: 0, sessW: 0, qW: 0 });
  const wSess = totals.mau > 0 ? totals.sessW / totals.mau : 0;
  const wQ    = totals.mau > 0 ? totals.qW / totals.mau : 0;
  const sUsers = document.getElementById('s-users');
  const sSess  = document.getElementById('s-sessions');
  const sTurns = document.getElementById('s-turns');
  if (sUsers) sUsers.value = String(Math.min(parseInt(sUsers.max || '500000', 10), Math.max(1, Math.round(totals.mau))));
  if (sSess)  sSess.value  = String(Math.max(0.01, Number(wSess.toFixed(2))));
  if (sTurns) sTurns.value = String(Math.max(1, Math.round(wQ)));
  // Summary line (only in multi-mode)
  if (w.segments.length >= 2) {
    const summary = document.getElementById('audience-summary');
    if (summary) {
      const b = (txt) => `<span style="color:#0B3D91;font-weight:700">${txt}</span>`;
      summary.innerHTML = `Total: ${b(totals.mau.toLocaleString() + ' MAU')} across ${b(w.segments.length)} audiences · `
                        + `${b(wSess.toFixed(2))} sess/day (weighted) · ${b(Math.round(wQ))} q/session (weighted)`;
    }
  }
}

/* ═══════ JSON EXPORT ═══════ */
function exportJSON(){
  const sess=cfg('s-sessions');
  const data={
    metadata:{tool:'Token simulator',timestamp:new Date().toISOString(),
      pricing_date:MODEL_PRICE_VERIFIED,disclaimer:'Planning estimate only — not contractual'},
    config:snapshotConfig(),
    pricing_sources:PRICING_SOURCES,
    models:Object.fromEntries(MK.map(k=>{
      const c=computeCost(k);const m=MODELS[k];
      return [k,{
        label:m.label||k,api_id:m.api_id||k,status:m.status||'',source:m.source||'',
        prices:{in_per_1m:m.in,cached_input_per_1m:m.cacheRead,output_per_1m:m.out,cache_write_5m_per_1m:m.cacheWrite5m,batch_disc:m.bd,long_context_threshold:m.longThreshold||null,long_input_per_1m:m.longIn||null,long_cached_input_per_1m:m.longCacheRead||null,long_output_per_1m:m.longOut||null},
        cost_per_session:{p50:c.netCost,p90:p90(c.netCost),p99:p99(c.netCost)},
        monthly_projection:{p50:c.netCost*sess*30,p90:p90(c.netCost*sess*30),p99:p99(c.netCost*sess*30)},
        breakdown:{api_total:c.baseCost,rag_token_share:c.ragCost,rag_embedding:c.ragEmbedCost,reasoning_share:c.reasonCost,guardrails:c.totalGuardCost,guard_waste:c.guardWaste,tool_token_share:c.toolOHCost,external_tool_fees:c.toolFeeCost,retry_waste:c.retryWaste,cache_read_tokens:c.cacheReadTok,cache_write_tokens:c.cacheWriteTok,cache_savings_vs_list:c.cacheSave,batch_savings_vs_list:c.batchSave}
      }];
    }))
  };
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='token_simulator_'+new Date().toISOString().split('T')[0]+'.json';a.click();
}
function snapshotConfig(){
  const ids=['s-agents','s-users','s-turns','s-sessions','s-peak','s-lang-mult','s-comm-pattern','s-tools','s-schema','s-toolresult','s-cache','s-batch','s-retry','s-iamsg','s-sysprompt','s-rag-chunks','s-rag-chunk-size','s-rag-query','s-rag-calls','s-think-tokens','s-think-pct','s-factcheck','s-cot','s-guard-in','s-guard-out','s-guard-pii','s-guard-policy','s-guard-block','s-guard-model','s-images','s-audio','s-pdf','s-codeinterp','s-fewshot','s-jsonschema','s-citations','s-memory','s-websearch-calls','s-filesearch-calls','s-container-sessions','s-growth','budget-input'];
  const out={};
  ids.forEach(id=>{const el=document.getElementById(id);if(el)out[id]=el.value;});
  out.task_mix=Object.fromEntries(TASK_TYPES.map(t=>[t.id,t.pct]));
  out.agents=snapshotAgentConfig();
  // Persist the user's explicit topology card choice so a shared URL
  // reloads into the same shape (Single ↔ Fleet ↔ Workflow). Without
  // this, executionMode alone is insufficient — 'single' is implemented
  // as 'fleet + agents=1 locked', so the original choice is lost.
  out.topology = (typeof userTopology !== 'undefined' && userTopology) ? userTopology : 'fleet';
  return out;
}

/* ═══════ SHAREABLE URL ═══════ */
function shareConfig(){
  const cfg=snapshotConfig();
  const encoded=btoa(JSON.stringify(cfg));
  const url=window.location.origin+window.location.pathname+'?cfg='+encoded;
  navigator.clipboard.writeText(url).then(()=>alert('Shareable URL copied to clipboard!'),()=>{
    prompt('Copy this URL:',url);
  });
}
function loadFromURL(){
  const params=new URLSearchParams(window.location.search);
  const enc=params.get('cfg');if(!enc)return;
  try{
    const c=JSON.parse(atob(enc));
    Object.entries(c).forEach(([id,v])=>{
      if(id==='task_mix'){
        Object.entries(v).forEach(([tid,pct])=>{const t=TASK_TYPES.find(x=>x.id===tid);if(t)t.pct=pct;});
      }else if(id==='agents'){
        // applied after slider values rebuild the fleet
      }else if(id==='topology'){
        // applied after onSlider so the agent slider exists + lock-state
        // transitions cleanly (setMode reads/writes #s-agents).
      }else{const el=document.getElementById(id);if(el)el.value=v;}
    });
    onSlider();
    if(c.agents)applyAgentConfigSnapshot(c.agents);
    renderTaskBars();
    // Restore explicit topology choice last — setMode mutates the agent
    // slider lock-state and re-renders the arch diagram if open.
    if(c.topology && (c.topology==='single'||c.topology==='fleet'||c.topology==='workflow')){
      try{setMode(c.topology);}catch(_){}
    }
  }catch(e){console.warn('Failed to load config from URL:',e);}
}


function resetDefaults(){
  if(!confirm('Reset all configuration to defaults? This will rebuild all agents.'))return;
  // Reset all sliders to default values
  const defaults={'s-agents':3,'s-users':50,'s-turns':8,'s-sessions':200,
    's-cache':45,'s-batch':0,'s-retry':3,'s-growth':20,'s-peak':1,'s-lang-mult':1.0,'s-comm-pattern':0,
    's-tools':2,'s-schema':320,'s-toolresult':800,'s-iamsg':80,'s-sysprompt':512,
    's-rag-chunks':5,'s-rag-chunk-size':512,'s-rag-query':128,'s-rag-calls':1,
    's-think-tokens':0,'s-think-pct':0,'s-factcheck':0,'s-cot':0,
    's-guard-in':0,'s-guard-out':0,'s-guard-pii':0,'s-guard-policy':0,'s-guard-block':0,'s-guard-model':0,
    's-images':0,'s-audio':0,'s-pdf':0,'s-codeinterp':0,
    's-fewshot':0,'s-jsonschema':0,'s-citations':0,'s-memory':0,
    's-websearch-calls':0,'s-filesearch-calls':0,'s-container-sessions':0,
    'budget-input':10000};
  Object.entries(defaults).forEach(([id,v])=>{const el=document.getElementById(id);if(el)el.value=v;});
  // Reset task mix
  TASK_TYPES[0].pct=20;TASK_TYPES[1].pct=25;TASK_TYPES[2].pct=20;
  TASK_TYPES[3].pct=15;TASK_TYPES[4].pct=10;TASK_TYPES[5].pct=10;
  // Rebuild
  buildAgents(true);buildUsers();renderAgents();renderTaskBars();
  onSlider();
}

/* MODE: single agent / fleet (parallel) / workflow (sequential DAG)
   'single' is a convenience preset that sets agents=1 and underlying
   mode='fleet'; the cost engine treats it as a one-agent fleet. */
let executionMode = 'fleet'; // 'fleet' or 'workflow' — what the cost engine bills for
// userTopology preserves the user's explicit Topology-card choice
// ('single' | 'fleet' | 'workflow'). executionMode collapses 'single' to
// 'fleet' because the cost engine treats Single as a 1-agent fleet, but
// the architecture diagram needs the original choice so toggling between
// Single ↔ Fleet ↔ Workflow with N=1 agents still re-shapes the canvas.
let userTopology = 'fleet';
function setMode(mode){
  userTopology = (mode==='single'||mode==='fleet'||mode==='workflow') ? mode : 'fleet';
  const agentSlider = document.getElementById('s-agents');
  if (mode === 'single') {
    // Force agent count to 1 AND lock the slider so the user can't drift
    // away from a single-agent configuration without explicitly switching
    // topology to Fleet/Workflow.
    if (agentSlider) {
      agentSlider.value = 1;
      agentSlider.disabled = true;
      agentSlider.style.opacity = '0.5';
      agentSlider.style.cursor = 'not-allowed';
      agentSlider.title = 'Locked at 1 because Topology = Single agent. Switch to Fleet or Workflow to add more agents.';
      agentSlider.dispatchEvent(new Event('input', {bubbles:true}));
    }
    executionMode = 'fleet';
  } else {
    if (agentSlider) {
      agentSlider.disabled = false;
      agentSlider.style.opacity = '';
      agentSlider.style.cursor = '';
      agentSlider.title = '';
    }
    executionMode = mode;
  }
  // (Topology dropdown stub removed; the Section A topology cards below
  // are now the only visible selector.)
  // Sync the Section A topology cards (visual selected-state + label).
  document.querySelectorAll('.topology-card').forEach(card => {
    const isActive = card.getAttribute('data-topology') === mode;
    card.style.borderColor = isActive ? 'var(--cyan)' : 'var(--b)';
    card.style.background  = isActive ? 'rgba(0,212,255,0.06)' : 'transparent';
  });
  const friendly = mode==='single' ? 'Single Agent' : (mode==='workflow' ? 'Workflow (sequential)' : 'Multi-Agent Fleet');
  const tcb = document.getElementById('topology-current-badge');
  if (tcb) tcb.textContent = friendly;
  // mode-label is now derived in onSlider() based on the actual agent
  // count + executionMode, so users see what they built ("3 agents · fleet")
  // rather than a stale topology badge.
  const wp = document.getElementById('panel-workflow');
  if(wp) wp.style.display = executionMode==='workflow' ? 'flex' : 'none';
  // Re-render the reference-topology diagram if open — topology change
  // is exactly when its layout flips between Single / Fleet / Workflow.
  const archBody=document.getElementById('arch-diagram-body');
  if(archBody && archBody.style.display!=='none' && typeof renderArchDiagram==='function') renderArchDiagram();
  try{onSlider();}catch(e){}
}

/* Workflow-mode cost extensions — added to base computeCost result */
function workflowExtensions(baseResult, agentsToProcess){
  if(!baseResult || !Array.isArray(agentsToProcess)) return {extraCost:0, breakdown:{}, sequentialChainCost:0};
  if(typeof executionMode==='undefined' || executionMode !== 'workflow') return {extraCost:0, breakdown:{}, sequentialChainCost:0};

  const baseTurns = cfg('s-turns');
  const handoffPct = cfg('s-stage-handoff')/100;       // 0..1, fraction of prior output passed forward
  const rerunRate = cfg('s-rerun')/100;                // 0..1, % stages rerun on review
  const templateRuns = Math.max(1, cfg('s-template-runs'));
  const docPdfs = cfg('s-doc-pdfs');
  const docPages = cfg('s-doc-pages');
  const docTokPage = cfg('s-doc-tok-page');
  const docStagesPct = cfg('s-doc-stages-pct')/100;
  const pauseHrs = cfg('s-pause-hrs');
  const pauses = cfg('s-pauses');
  const storageRateIdx = cfg('s-storage-rate');
  const storageRates = [0, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.02, 0.03, 0.04, 0.05];
  const storageRate = storageRates[storageRateIdx] || 0.0001;

  // 1. Sequential handoff: each stage gets ~handoffPct × prior stage output as added input
  // Approximation: cumulative additional input tokens grow linearly across stages
  let chainCost = 0;
  const stages = agentsToProcess.length;
  if(stages > 1 && handoffPct > 0){
    // For each stage i (1..N-1), add (sum of prior output tokens × handoffPct) to its input
    let cumulativePriorOut = 0;
    agentsToProcess.forEach((agent, idx) => {
      const m = MODELS[agent.model] || MODELS['claude-sonnet-4.6'];
      const provider = providerForAgent(agent, agent.model, false);
      const inRate = m.in * provider.in_mult;
      const myTurns = Math.max(1, Math.round(baseTurns*(agent.turnsShare||1.0)));
      // Approximate: agent's expected turn output
      const om = wOM ? wOM() : 1.0;
      const myOutPerTurn = Math.round(200 * om);
      const myOutTotal = myOutPerTurn * myTurns;
      if(idx > 0){
        // This stage gets cumulativePriorOut * handoffPct extra input
        const extraIn = cumulativePriorOut * handoffPct;
        chainCost += (extraIn / 1e6) * inRate;
      }
      cumulativePriorOut += myOutTotal;
    });
  }

  // 2. Bulk document ingestion (pdf bytes pushed into prompt of % stages)
  let docCost = 0;
  if(docPdfs > 0 && docPages > 0 && docTokPage > 0){
    const totalDocTok = docPdfs * docPages * docTokPage;
    const stagesReadingDocs = Math.max(1, Math.round(stages * docStagesPct));
    let docInRate = 0;
    // Use weighted average input rate of stages reading docs
    agentsToProcess.slice(0, stagesReadingDocs).forEach(agent => {
      const m = MODELS[agent.model] || MODELS['claude-sonnet-4.6'];
      const provider = providerForAgent(agent, agent.model, false);
      docInRate += m.in * provider.in_mult;
    });
    docInRate /= Math.max(1, stagesReadingDocs);
    docCost = (totalDocTok * stagesReadingDocs / 1e6) * docInRate;
  }

  // 3. Partial rerun: each rerun re-executes a stage. Approx = rerunRate × baseCost
  const rerunCost = baseResult.baseCost * rerunRate;

  // (Legacy "4. Fact-check sidecar" removed 2026-05-25 — the s-fc-*
  // sliders were deleted; the wired Fact-checking / workload.verification
  // pipeline is the single source of truth for verification cost.)

  // 5. Template amortization: planning cost spread across runs
  // Rough estimate: orchestrator's first turn × 2 = workflow planning cost, divided by templateRuns
  const planningCost = baseResult.baseCost * 0.05; // assume ~5% of session is one-time planning
  const templateAmort = planningCost / templateRuns;
  const templateAmortDelta = -planningCost + templateAmort; // savings vs no amortization

  // 6. HITL pause storage cost
  // Avg session state ≈ totalIn tokens × 4 bytes/token (KV cache + state) ≈ totalIn × 4 / 1e9 GB
  const stateGB = (baseResult.totalIn * 4) / 1e9;
  const pauseStorageCost = stateGB * pauseHrs * pauses * storageRate;

  const extraCost = chainCost + docCost + rerunCost + templateAmortDelta + pauseStorageCost;

  return {
    extraCost,
    breakdown: {
      sequentialChainCost: chainCost,
      documentIngestionCost: docCost,
      partialRerunCost: rerunCost,
      templateAmortDelta: templateAmortDelta,
      hitlPauseCost: pauseStorageCost,
    }
  };
}


/* AKD Flow preset — models a research workflow DAG matching the AKD Flow application */
function applyAKDFlow(){
  // Switch to workflow mode
  setMode('workflow');
  
  // Set workflow-specific sliders
  const setVal = (id, v) => {const el = document.getElementById(id); if(el) el.value = v;};
  setVal('s-stage-handoff', 80);   // 80% prior output flows forward
  setVal('s-rerun', 20);            // researchers rerun ~20% of stages
  setVal('s-template-runs', 5);     // each workflow template runs ~5x
  setVal('s-doc-pdfs', 8);          // typical research session: 8 PDFs
  setVal('s-doc-pages', 20);        // ~20 pages each
  setVal('s-doc-tok-page', 1000);   // dense academic content
  setVal('s-doc-stages-pct', 60);   // 60% of stages read corpus
  setVal('s-pause-hrs', 4);         // typical review pause
  setVal('s-pauses', 4);            // ~4 approval gates per workflow
  setVal('s-storage-rate', 2);      // standard cloud rate

  // Global config tuned for research workflow
  setVal('s-agents', 5);            // matches AKD Flow stage count (Gap, Capability, Spec, Implementation, Report)
  setVal('s-turns', 8);             // ~8 turn conversation per stage on average
  setVal('s-sessions', 30);         // ~30 sessions/day per researcher team
  setVal('s-cache', 50);            // moderate cache hit rate
  setVal('s-rag-chunks', 10);       // research stages retrieve heavily
  setVal('s-rag-chunk-size', 500);
  setVal('s-rag-calls', 2);
  setVal('s-think-tokens', 4000);   // research benefits from extended thinking
  setVal('s-think-pct', 60);
  setVal('s-cot', 6);
  setVal('s-factcheck', 1);
  setVal('s-guard-in', 0); setVal('s-guard-out', 0);  // research workflows often skip guardrails
  setVal('s-sysprompt', 1500);     // research instructions are detailed
  setVal('s-images', 0); setVal('s-audio', 0); setVal('s-pdf', 0); setVal('s-codeinterp', 0);
  setVal('s-fewshot', 3);          // few research examples in prompts
  setVal('s-jsonschema', 200);     // structured outputs
  setVal('s-citations', 100);      // research papers need citations
  setVal('s-memory', 500);
  
  // Reconfigure agents to mirror AKD Flow structure
  // Gap Agent / Capability Mapper / Spec Builder / Experiment Implementation / Report Generator
  if(typeof AGENT_DEF !== 'undefined' && AGENT_DEF.length >= 5){
    const akdRoles = [
      {name:'GAP', role:'Gap Identification', model:'claude-sonnet-4.6', col:'#00d4ff', task_bias:'rag', ragOn:true, reasonOn:true, guardOn:false, toolsOn:false, turnsShare:1.0, cache_rate:50},
      {name:'CAP', role:'Capability Mapper', model:'claude-opus-4.7', col:'#ff5252', task_bias:'agent', ragOn:true, reasonOn:true, guardOn:false, toolsOn:true, turnsShare:1.5, cache_rate:40},
      {name:'SPEC', role:'Spec Builder', model:'claude-sonnet-4.6', col:'#7c4dff', task_bias:'longform', ragOn:false, reasonOn:true, guardOn:false, toolsOn:false, turnsShare:1.2, cache_rate:60},
      {name:'EXP', role:'Experiment Impl', model:'gpt-5.4', col:'#f48fb1', task_bias:'code', ragOn:false, reasonOn:true, guardOn:false, toolsOn:true, turnsShare:1.0, cache_rate:55},
      {name:'RPT', role:'Report Generator', model:'claude-sonnet-4.6', col:'#00e676', task_bias:'longform', ragOn:true, reasonOn:false, guardOn:true, toolsOn:false, turnsShare:0.8, cache_rate:65},
    ];
    AGENT_DEF.length = 0;
    akdRoles.forEach(r => { if(!r) return; AGENT_DEF.push({...r, provider:'managed', temp:.5, maxOut:2048,
      tools_per:2, schema:300, result:1500,
      rag_chunks:10, rag_size:500, rag_calls:2,
      think_tok:4000, think_pct:60, cot:6, factcheck:1,
      guard_in:0, guard_out:0, guard_pii:0, guard_policy:0})});
  }

  if(typeof buildAgents === 'function') buildAgents();
  if(typeof buildUsers === 'function') buildUsers();
  if(typeof renderAgents === 'function') renderAgents();
  if(typeof renderAgentSettingsSummary === 'function') renderAgentSettingsSummary();
  onSlider();
  // AKD Flow has parallel sub-branches (multiple search agents run concurrently in some stages)
  setVal('s-parallel-branches', 3);
  setVal('s-concurrent-quota', 20);
  setVal('s-rate-overage', 5);
  if(typeof setTopology==='function') setTopology('hybrid');
  alert('Multi-stage research workflow preset applied. 5-stage pipeline with hybrid DAG topology, bulk PDF ingestion, fact-check sidecar, parallel search agents, and HITL pause states.');
}


/* DAG topology: sequential, parallel, or hybrid */
let dagTopology = 'sequential';
function setTopology(topo){
  dagTopology = topo;
  ['seq','par','hyb'].forEach(k=>{
    const btn=document.getElementById('topo-'+k); if(!btn) return;
    const isActive = (k==='seq'&&topo==='sequential')||(k==='par'&&topo==='parallel')||(k==='hyb'&&topo==='hybrid');
    btn.style.background = isActive ? 'rgba(0,212,255,.06)' : '';
    btn.style.borderColor = isActive ? 'rgba(0,212,255,.4)' : '';
    btn.style.color = isActive ? 'var(--cyan)' : '';
  });
  const hints = {
    sequential: 'Sequential: linear pipeline, no concurrency issues. Total wall-clock = sum of stage times.',
    parallel: 'Parallel: all stages run concurrently. Wall-clock = max stage time. Risk: hits rate limits if branches > concurrent quota.',
    hybrid: 'Hybrid DAG: sequential trunk with parallel sub-branches at certain stages. Realistic for multi-stage research workflows where some stages depend on prior stages but others can run independently.'
  };
  const h = document.getElementById('topology-hint');
  if(h) h.textContent = hints[topo] || '';
  const wb = document.getElementById('workflow-badge');
  if(wb) wb.textContent = topo + ' DAG';
  try{onSlider();}catch(e){}
}

/* Concurrency / rate-limit cost calculation for workflow mode */
function concurrencyExtensions(baseResult, agentsToProcess){
  if(!baseResult || !Array.isArray(agentsToProcess)) return {extraCost:0, breakdown:{topologyMultiplier:1,concurrentUsage:0,quotaUtilization:0,rateLimitOverageCost:0,quotaExceededCost:0}};
  if(typeof executionMode==='undefined' || executionMode!=='workflow'){
    return {extraCost:0, breakdown:{topologyMultiplier:1,concurrentUsage:0,quotaUtilization:0,rateLimitOverageCost:0,quotaExceededCost:0}};
  }
  const branches = parseInt(document.getElementById('s-parallel-branches')?.value)||1;
  const quota = parseInt(document.getElementById('s-concurrent-quota')?.value)||10;
  const overagePct = parseInt(document.getElementById('s-rate-overage')?.value)||0;
  const stages = agentsToProcess.length;
  
  let topologyMultiplier = 1.0;
  let concurrentUsage = stages;
  if(dagTopology === 'sequential'){
    concurrentUsage = 1;
    topologyMultiplier = 1.0;
  }else if(dagTopology === 'parallel'){
    concurrentUsage = stages * branches;
    topologyMultiplier = 1.0;
  }else if(dagTopology === 'hybrid'){
    concurrentUsage = Math.max(2, Math.ceil(stages/2) * branches);
    topologyMultiplier = 1.0;
  }
  
  // Rate limit overage cost: failed/retried requests cost ~1.5x
  const overageCost = baseResult.baseCost * (overagePct/100) * 1.5;
  
  // Concurrent quota exceeded penalty: if usage > quota, cap at quota and add queueing overhead
  let quotaExceededCost = 0;
  if(concurrentUsage > quota){
    const overflow = concurrentUsage - quota;
    // Queueing/throttling: simulated as 2% surcharge per overflow request
    quotaExceededCost = baseResult.baseCost * 0.02 * overflow;
  }
  
  return {
    extraCost: overageCost + quotaExceededCost,
    breakdown: {
      topologyMultiplier,
      concurrentUsage,
      quotaUtilization: Math.min(100, Math.round(concurrentUsage/quota*100)),
      rateLimitOverageCost: overageCost,
      quotaExceededCost: quotaExceededCost,
    }
  };
}

// ===================================================================
// Host integration: mirror a calculator workload INTO the simulator.
// The calculator (app.js) owns the canonical workload object. Whenever
// a fresh workload is loaded (preset dropdown, JSON import, URL hash,
// calibration mode toggle), it calls this function so the simulator's
// visible state reflects what's actually being costed.
//
// Mapping:
//   workload.anchor_query.cache_rate_baseline      → #s-cache slider
//   workload.anchor_query.session_baseline_turns   → #s-turns slider
//   sum(workload.segments[].mau)                   → #s-users slider
//   workload.agents[]  (non-empty)                 → sim.agents (best-effort)
//   workload.agents[]  (empty)                     → sim.agents = [single anchor agent]
//
// Per-agent calculator-shape (id, label, model, input_tokens, output_tokens,
// calls_per_query, cache_eligible) is mapped back to simulator-shape by
// starting from AGENT_DEF[i] (or [0] for overflow) and overlaying the
// fields the calculator stores. The simulator's richer per-agent state
// (RAG chunks, tool calls, reasoning toggles, etc.) is retained from the
// AGENT_DEF base. For empty-agents workloads (anchor_query mode), the
// simulator shows a single agent named "Anchor" with all flags off so
// its token math approximates the validated anchor.
//
// Caller MUST suspend writeback (via window.__setSimWritebackEnabled(false))
// before invoking this, then re-enable after, so the onSlider() repaint at
// the end does NOT push stale state back into workload.
window.__setSimulatorFromWorkload = function(workload) {
  if (!workload) return;
  const aq = workload.anchor_query || {};

  // 1. Cache slider
  if (aq.cache_rate_baseline != null) {
    const sCache = document.getElementById('s-cache');
    if (sCache) sCache.value = String(Math.round(aq.cache_rate_baseline * 100));
  }

  // 2. Turns slider — INTENTIONALLY skipped here. The s-turns slider maps
  // to segments[].questions_per_session (user-level questions per session),
  // which is already written by syncAxiomSlidersFromSegments() before this
  // function runs. anchor_query.session_baseline_turns is a different
  // concept (the per-call granularity at which cache_rate_baseline was
  // measured) and overwriting s-turns from it clobbers the workload's
  // questions_per_session — visible in the public geospatial Q&A preset where the two
  // values legitimately diverge (questions=10, baseline_turns=6).

  // 3. MAU slider (sum of segments)
  const segs = Array.isArray(workload.segments) ? workload.segments : [];
  const totalMau = segs.reduce((s, seg) => s + (seg.mau || 0), 0);
  if (totalMau > 0) {
    const sUsers = document.getElementById('s-users');
    if (sUsers) sUsers.value = String(Math.min(parseInt(sUsers.max || '500000', 10), totalMau));
  }

  // 4. sim.agents — mirror workload.agents (or build single anchor agent)
  const wAgents = Array.isArray(workload.agents) ? workload.agents : [];
  if (wAgents.length > 0) {
    sim.agents = wAgents.map((w, i) => {
      const def = AGENT_DEF[i] || AGENT_DEF[0];
      const base = cloneAgentBase(def, i);
      if (w.model) base.model = w.model;
      if (w.label) {
        const m = String(w.label).match(/^(.+?)\s*\((.+)\)\s*$/);
        if (m) { base.name = m[1].trim(); base.role = m[2].trim(); }
        else { base.name = String(w.label); }
      }
      if (w.calls_per_query) base.turnsShare = Number(w.calls_per_query) || base.turnsShare;
      if (w.output_tokens)   base.maxOut    = Math.max(64, Math.round(w.output_tokens));
      if (w.cache_eligible === false) base.cache_rate = 0;
      // Seed engine-driven per-agent fields so the simulator card sliders
      // open to the SAME values that drive the headline pill. Without
      // this, mcp-research-fleet's per-agent sysprompt_tokens=1500 would
      // render as Sysprompt slider value 512 (workload-wide fallback) and
      // any user nudge would visibly jump from the wrong starting point.
      if (w.sysprompt_tokens != null) base.sysprompt = w.sysprompt_tokens;
      if (w.iamsg_tokens != null) base.iamsg = w.iamsg_tokens;
      if (w.calls_per_turn_multiplier != null) base.calls_per_turn_multiplier = w.calls_per_turn_multiplier;
      if (w.guard_model) base.guard_model = w.guard_model;
      if (w.verify_enabled) base.verify_enabled = true;
      if (w.verify_coverage != null) base.verify_coverage = w.verify_coverage;
      if (w.verifier_override) base.verifier_override = w.verifier_override;
      // activation_rate: engine stores 0-1, sim slider shows 0-100.
      if (Number.isFinite(w.activation_rate)) base.activation_rate = Math.round(w.activation_rate * 100);
      // Mirror enabled_tools so the agent card's TOOLS checklist reflects
      // what the engine is actually billing. Without this, presets that
      // ship with enabled_tools (e.g., public-geospatial-qa with 7
      // tools) load with every checkbox unticked, even though the engine
      // is correctly billing them via workload.agents[i].enabled_tools.
      if (w.enabled_tools && typeof w.enabled_tools === 'object') {
        base.enabled_tools = JSON.parse(JSON.stringify(w.enabled_tools));
      }
      return base;
    });
    const sAgents = document.getElementById('s-agents');
    if (sAgents) sAgents.value = String(Math.min(parseInt(sAgents.max || '8', 10), sim.agents.length));
  } else {
    // Anchor-query mode — single representative agent, all extras off.
    const anchorModel = (workload.defaults && workload.defaults.model) || 'gpt-5.2';
    const base = cloneAgentBase(AGENT_DEF[0], 0);
    base.name = 'Anchor';
    base.role = 'Single agent (preset)';
    base.model = anchorModel;
    base.toolsOn  = false;
    base.ragOn    = false;
    base.reasonOn = false;
    base.guardOn  = false;
    base.turnsShare = 1.0;
    if (aq.output_tokens)        base.maxOut     = Math.max(64, Math.round(aq.output_tokens));
    if (aq.cache_rate_baseline != null) base.cache_rate = Math.round(aq.cache_rate_baseline * 100);
    sim.agents = [base];
    const sAgents = document.getElementById('s-agents');
    if (sAgents) sAgents.value = '1';
  }

  // 5. Task mix — mirror workload.task_mix back into TASK_TYPES so the
  // sliders on the "Workload mix — query types" panel show the persisted
  // state on URL-hash reload or JSON import. Missing keys keep the
  // current TASK_TYPES default (no destructive overwrite).
  if (workload.task_mix && typeof workload.task_mix === 'object') {
    for (const t of TASK_TYPES) {
      const v = Number(workload.task_mix[t.id]);
      if (Number.isFinite(v) && v >= 0) t.pct = v;
    }
    if (typeof renderTaskBars === 'function') renderTaskBars();
  }

  // 6. Repaint. onSlider() will fire — caller has suspended writeback so
  // autoSync inside the wrapped onSlider is a no-op.
  if (typeof renderAgents === 'function')   renderAgents();
  if (typeof updateCostPanel === 'function') updateCostPanel();
  if (typeof renderLedger === 'function')   renderLedger();
  if (typeof updateKPIs === 'function')     updateKPIs();
  if (typeof onSlider === 'function')       onSlider();
};

// BOOT
buildAgents();buildUsers();renderAgents();renderTaskBars();renderModelSelector();
// Mark config as the initially-active tab without scrolling; all panels
// render stacked, so this is purely a state marker.
document.getElementById('tab-config')?.classList.add('active');
loadFromURL();
setTimeout(()=>{
  onSlider();
  // Eager init for renderers that used to fire on tab activation.
  if(typeof renderAudience==='function')renderAudience();
  // Initial render of the audience block — single/multi mode is derived
  // from the freshly-loaded workload.segments.length.
  if(typeof renderAudienceBlock==='function')renderAudienceBlock();
},100);
