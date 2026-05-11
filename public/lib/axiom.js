/* ===========================================================================
 * AXIOM v9.6 — Multi-Agent Token Simulator
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
    const useLong=!!(model.longThreshold && turnIn>model.longThreshold && model.longIn!=null && model.longOut!=null);
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

  const imgTok=cfg('s-images')*1568, audioTok=cfg('s-audio')*25, pdfTok=cfg('s-pdf')*1500, codeInterp=cfg('s-codeinterp');
  const fewshot=cfg('s-fewshot')*250, jsonSchema=cfg('s-jsonschema'), citations=cfg('s-citations'), memory=cfg('s-memory');
  const modalTurnTok=imgTok+audioTok+pdfTok+codeInterp;
  const promptOHTurn=fewshot+jsonSchema+memory;

  agentsToProcess.forEach(agent=>{
    const usedModel=overrideModel ? mk : agent.model;
    const m=MODELS[usedModel]||MODELS['claude-sonnet-4.6'];
    const provider=providerForAgent(agent,usedModel,overrideModel);
    modelTouched[usedModel]=true;

    const myTurns=Math.max(1,Math.round(baseTurns*(agent.turnsShare||1.0)));
    const myToolsPer=agent.toolsOn?(agent.tools_per??cfg('s-tools')):0;
    const mySchema=agent.schema??cfg('s-schema');
    const myResult=agent.result??cfg('s-toolresult');
    const myToolSchemaOH=myToolsPer*mySchema;
    const myToolResultOH=myToolsPer*myResult;
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
    // Applied as extra input tokens per turn per agent. Single-agent runs
    // never pay this overhead (siblings = 0).
    const _commPattern = cfg('s-comm-pattern');
    const _commSiblings = Math.max(0, agentCount - 1);
    const _commOverheadPerTurn = _commPattern === 1 ? _commSiblings * 300
                              : _commPattern === 2 ? _commSiblings * 150
                              : 0;
    const turnIn=(sysTokGlobal/myTurns)+200+myToolSchemaOH+myToolResultOH+iaMsg+myRagTok+myReasonTok+myGuardTokInTurn+_commOverheadPerTurn+modalTurnTok+promptOHTurn;
    const rawTurnOut=Math.round(200*myOM)+citations;
    const turnOut=Math.min(rawTurnOut, agent.maxOut||rawTurnOut);
    const tierInfo=resolvePricingTier(m,provider,langMult,turnIn);
    const inRate=tierInfo.inRate,outRate=tierInfo.outRate,priceModel=tierInfo.priceModel;
    const myTotalIn=turnIn*myTurns;
    const myTotalOut=turnOut*myTurns;

    let myModelCost=0,myFixed=0,myCacheSave=0,myBatchSave=0,myCacheReadTok=0,myCacheWriteTok=0;
    if(provider.in_mult===0 && provider.out_mult===0){
      myFixed=provider.fixed_mo/Math.max(1,cfg('s-sessions')*30);
      fixedMonthly+=myFixed;
    }else{
      const cwsOverride=parseFloat(document.getElementById('s-cache-write-share')?.value);
      const inPrice=pricedInputCost(myTotalIn,inRate,priceModel,batchRate,myCacheRate, isNaN(cwsOverride)?null:cwsOverride/100);
      const outPrice=pricedOutputCost(myTotalOut,outRate,priceModel,batchRate);
      myModelCost=inPrice.cost+outPrice.cost;
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
    const myGuardWaste=(cfg('s-guard-block')/100)*(((sysTokGlobal/myTurns)+200+myRagTok)/1e6)*inRate*myTurns;
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
    const myNet=myModelCost+guardBaseCost+myGuardWaste+mySumm+myFixed;
    agentBreakdown.push({name:agent.name,role:agent.role,model:usedModel,provider:provider.label,col:agent.col||m.color,netCost:myNet,totalIn:myTotalIn,totalOut:myTotalOut,turns:myTurns,cacheReadTok:myCacheReadTok,cacheWriteTok:myCacheWriteTok,cacheSave:myCacheSave,batchSave:myBatchSave,pricingTier:tierInfo.tier,source:m.source||''});
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
  if(stats)stats.innerHTML=[['p50 (expected)','$'+p50(base).toFixed(5),'var(--green)'],['p75','$'+lnPct(base,.674).toFixed(5),'var(--teal)'],['p90 (budget risk)','$'+p90v.toFixed(5),'var(--amber)'],['p99 (heuristic tail)','$'+p99v.toFixed(5),'var(--red)'],['CV (variance)',( cv*100).toFixed(0)+'%','var(--dimmer)']].map(([l,v,c])=>`<span style="color:${c}">${l}: <b>${v}</b></span>`).join(' &nbsp;·&nbsp; ');
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
    ['Fact-check sidecar','$'+((sc.workflowExtra?.breakdown?.factCheckSidecarCost)||0).toFixed(5),'var(--reason)'],
    ['Template amortization','$'+((sc.workflowExtra?.breakdown?.templateAmortDelta)||0).toFixed(5),'var(--green)'],
    ['HITL pause storage','$'+((sc.workflowExtra?.breakdown?.hitlPauseCost)||0).toFixed(7),'var(--gold)'],
    ['── DAG TOPOLOGY ──','','var(--purple)'],
    ['Concurrent usage',((sc.workflowExtra?.concurrency?.breakdown?.concurrentUsage)||0)+' / '+(parseInt(document.getElementById('s-concurrent-quota')?.value)||0)+' quota','var(--purple)'],
    ['Quota utilization',((sc.workflowExtra?.concurrency?.breakdown?.quotaUtilization)||0)+'%','var(--purple)'],
    ['Rate limit overage','$'+((sc.workflowExtra?.concurrency?.breakdown?.rateLimitOverageCost)||0).toFixed(5),'var(--red)'],
    ['Quota exceeded penalty','$'+((sc.workflowExtra?.concurrency?.breakdown?.quotaExceededCost)||0).toFixed(5),'var(--red)'],
  ].map(([l,v,c])=>`<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid var(--b)"><span style="color:var(--dim)">${l}</span><span style="color:${c};font-weight:700">${v}</span></div>`).join('');
  const budget=parseFloat(document.getElementById('budget-input').value)||999999;
  const projMo=sc.netCost*monthly;
  const bs=document.getElementById('budget-status');const bw=document.getElementById('warn-budget');
  if(projMo>budget){bs.textContent='OVER';bs.className='badge-warn';if(bw)bw.className='warn-banner show';}
  else{bs.textContent='OK';bs.className='badge-ok';if(bw)bw.className='warn-banner';}
  budgetSuggest(sc, monthly, budget);
  buildProjChart();
}

/* Budget heuristic optimizer — when projected monthly > budget, list
   specific knob adjustments ranked by $ savings/month. Pure deterministic
   rules over the per-component cost the engine already exposes. */
function budgetSuggest(sc, monthly, budget){
  const wrap=document.getElementById('budget-suggestions');
  const list=document.getElementById('budget-suggest-list');
  if(!wrap||!list)return;
  const projMo=(sc.netCost||0)*monthly;
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

/* Basic / Advanced toggle. Persists in localStorage. */
function setConfigMode(mode){
  document.body.classList.toggle('config-basic', mode==='basic');
  const ba=document.getElementById('cfg-mode-basic');
  const ad=document.getElementById('cfg-mode-advanced');
  if(ba)ba.classList.toggle('active', mode==='basic');
  if(ad)ad.classList.toggle('active', mode==='advanced');
  const hint=document.getElementById('cfg-mode-hint');
  if(hint){
    hint.textContent = mode==='basic'
      ? 'Showing core knobs only — switch to Advanced for full control over reasoning, multimodal, prompt overhead, guardrails, etc.'
      : 'All knobs visible — every cost driver, including rare/edge-case adjustments.';
  }
  try{localStorage.setItem('ccs-config-mode', mode);}catch(_){}
}
/* Init: default to basic, restore from localStorage if set. */
(function initConfigMode(){
  let saved='basic';
  try{const v=localStorage.getItem('ccs-config-mode'); if(v==='advanced'||v==='basic')saved=v;}catch(_){}
  setConfigMode(saved);
})();
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
  const scenarios=[
    {name:'Double RAG chunks',id:'s-rag-chunks',fn:v=>v*2},{name:'Enable 10K thinking',id:'s-think-tokens',fn:_=>10000},
    {name:'Add full guardrails',multi:[['s-guard-in',500],['s-guard-out',500],['s-guard-pii',200],['s-guard-policy',800]]},
    {name:'Cache 80% hit rate',id:'s-cache',fn:_=>80},{name:'50% batch async',id:'s-batch',fn:_=>50},
    {name:'Triple fact-checking',id:'s-factcheck',fn:_=>3},{name:'RAG 20 chunks×512t',multi:[['s-rag-chunks',20],['s-rag-chunk-size',512]]},
    {name:'Minimal guardrails',multi:[['s-guard-in',0],['s-guard-out',0],['s-guard-pii',0],['s-guard-policy',0]]},
  ];
  const el=document.getElementById('whatif-cards');if(!el)return;
  el.innerHTML=scenarios.map(sc=>{
    let nc;const saves={};
    if(sc.multi){sc.multi.forEach(([id,v])=>{const e=document.getElementById(id);if(e){saves[id]=e.value;e.value=v;}});nc=computeCost().netCost;Object.entries(saves).forEach(([id,v])=>{const e=document.getElementById(id);if(e)e.value=v;});}
    else{const e=document.getElementById(sc.id);if(e){saves[sc.id]=e.value;e.value=sc.fn(parseFloat(e.value)||0);nc=computeCost().netCost;e.value=saves[sc.id];}else nc=base;}
    const d=((nc-base)/base*100);const c=d>0?'var(--red)':'var(--green)';
    return `<div class="mcard"><div class="mlabel">${sc.name}</div><div style="font-size:14px;font-weight:700;color:${c}">${d>0?'+':''}${d.toFixed(1)}%</div><div style="font-size:7px;color:var(--dim);margin-top:2px">${nc.toFixed(5)}/sess</div></div>`;
  }).join('');
}

/* ═══════ TASK BARS ═══════ */
function renderTaskBars(){
  const t=TASK_TYPES.reduce((s,x)=>s+x.pct,0)||1;
  document.getElementById('task-bars').innerHTML=TASK_TYPES.map((x,i)=>`
    <div style="display:flex;align-items:center;gap:5px;margin-bottom:5px">
      <span style="font-size:8px;color:${x.color};width:82px;flex-shrink:0;text-align:right">${x.label}</span>
      <input type="range" min="0" max="100" value="${x.pct}" step="5" style="flex:1" oninput="setTask(${i},this.value)">
      <span style="font-size:8px;font-weight:700;min-width:24px;color:${x.color}" id="tp-${i}">${Math.round(x.pct/t*100)}%</span>
      <span style="font-size:7px;color:var(--dimmer);min-width:36px">×${x.outMult}out</span>
    </div>`).join('');
  const ob=document.getElementById('out-mult-badge');if(ob)ob.textContent='×'+wOM().toFixed(2)+' out';
}
function setTask(i,v){TASK_TYPES[i].pct=parseInt(v);const t=TASK_TYPES.reduce((s,x)=>s+x.pct,0)||1;TASK_TYPES.forEach((x,j)=>{const e=document.getElementById('tp-'+j);if(e)e.textContent=Math.round(x.pct/t*100)+'%';});const ob=document.getElementById('out-mult-badge');if(ob)ob.textContent='×'+wOM().toFixed(2)+' out';onSlider();}

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

/* ═══════ ARCHITECTURE DIAGRAM ═══════ */
const ARCH_NODES={
  users:    {x:.05,y:.45,w:.10,h:.12,label:'Users',color:'#c8d8f0',icon:'👤'},
  ctx:      {x:.22,y:.38,w:.12,h:.14,label:'Context\nAssembler',color:'#42a5f5',icon:'📦'},
  rag:      {x:.22,y:.15,w:.12,h:.12,label:'RAG\nPipeline',color:'#7c4dff',icon:'🔍'},
  reason:   {x:.22,y:.62,w:.12,h:.12,label:'Fact\nReasoner',color:'#00bcd4',icon:'🧠'},
  guard_in: {x:.40,y:.20,w:.12,h:.11,label:'Input\nGuardrails',color:'#ff6d00',icon:'🛡️'},
  model:    {x:.40,y:.38,w:.13,h:.14,label:'LLM\nModel',color:'#00d4ff',icon:'⚡'},
  guard_out:{x:.40,y:.62,w:.12,h:.11,label:'Output\nGuardrails',color:'#e65100',icon:'🛡️'},
  tools:    {x:.60,y:.20,w:.12,h:.12,label:'Tool\nCalls',color:'#ce93d8',icon:'🔧'},
  ia_route: {x:.60,y:.50,w:.12,h:.12,label:'IA\nRouter',color:'#4dd0e1',icon:'🔀'},
  output:   {x:.80,y:.38,w:.10,h:.12,label:'Response\nOutput',color:'#00e676',icon:'📤'},
};
const ARCH_EDGES=[
  {from:'users',to:'ctx',label:'user msg'},
  {from:'rag',to:'ctx',label:'chunks'},
  {from:'reason',to:'ctx',label:'CoT'},
  {from:'ctx',to:'guard_in',label:'pre-check'},
  {from:'ctx',to:'model',label:'full ctx'},
  {from:'guard_in',to:'model',label:'cleared'},
  {from:'model',to:'tools',label:'tool call'},
  {from:'tools',to:'model',label:'results'},
  {from:'model',to:'guard_out',label:'raw out'},
  {from:'model',to:'ia_route',label:'handoff'},
  {from:'guard_out',to:'output',label:'safe out'},
  {from:'ia_route',to:'model',label:'re-route'},
];
const PIPELINE_STAGES=[
  {nodes:['users'],label:'User message',detail:'Input received',color:'#c8d8f0'},
  {nodes:['rag'],label:'RAG retrieval',detail:'Fetching chunks',color:'#7c4dff'},
  {nodes:['reason'],label:'Fact reasoning',detail:'Extended thinking',color:'#00bcd4'},
  {nodes:['ctx'],label:'Context assembly',detail:'Building full prompt',color:'#42a5f5'},
  {nodes:['guard_in'],label:'Input guardrails',detail:'Safety classification',color:'#ff6d00'},
  {nodes:['model'],label:'LLM inference',detail:'Token generation',color:'#00d4ff'},
  {nodes:['tools'],label:'Tool execution',detail:'External API calls',color:'#ce93d8'},
  {nodes:['guard_out'],label:'Output guardrails',detail:'Response scanning',color:'#e65100'},
  {nodes:['ia_route'],label:'IA routing',detail:'Agent coordination',color:'#4dd0e1'},
  {nodes:['output'],label:'Response delivery',detail:'Complete',color:'#00e676'},
];

let archAnim={stage:-1,particles:[],nodeGlow:{},activeEdges:[],interval:null,simRunning:false};

function getNodeCenter(nk,W,H){const n=ARCH_NODES[nk];return{x:(n.x+n.w/2)*W,y:(n.y+n.h/2)*H};}
function getStageNodes(){
  const stageIdx=Math.abs(archAnim.stage)%PIPELINE_STAGES.length;
  return PIPELINE_STAGES[stageIdx];
}

function drawArch(){
  const canvas=document.getElementById('arch-canvas');if(!canvas)return;
  const W=canvas.offsetWidth||800;canvas.width=W;const H=canvas.height=480;
  const ctx2=canvas.getContext('2d');
  ctx2.clearRect(0,0,W,H);
  // BG
  const _tc=getChartColors();ctx2.fillStyle=_tc.bg;ctx2.fillRect(0,0,W,H);
  // Grid
  ctx2.strokeStyle='rgba(0,212,255,.04)';ctx2.lineWidth=1;
  for(let x=0;x<W;x+=40){ctx2.beginPath();ctx2.moveTo(x,0);ctx2.lineTo(x,H);ctx2.stroke();}
  for(let y=0;y<H;y+=40){ctx2.beginPath();ctx2.moveTo(0,y);ctx2.lineTo(W,y);ctx2.stroke();}
  // Edges
  ARCH_EDGES.forEach(e=>{
    const s=getNodeCenter(e.from,W,H),t=getNodeCenter(e.to,W,H);
    const isActive=archAnim.activeEdges.includes(e.from+'-'+e.to);
    ctx2.save();ctx2.strokeStyle=isActive?'rgba(0,212,255,.8)':'rgba(255,255,255,.12)';
    ctx2.lineWidth=isActive?2:.8;
    if(isActive){ctx2.shadowColor='rgba(0,212,255,.8)';ctx2.shadowBlur=8;}
    ctx2.setLineDash(isActive?[]:[4,4]);
    ctx2.beginPath();ctx2.moveTo(s.x,s.y);
    const mx=(s.x+t.x)/2,my=(s.y+t.y)/2-20;
    ctx2.quadraticCurveTo(mx,my,t.x,t.y);ctx2.stroke();
    // Arrow
    const dx=t.x-mx,dy=t.y-my;const ang=Math.atan2(dy,dx);
    ctx2.fillStyle=isActive?'rgba(0,212,255,.8)':'rgba(255,255,255,.2)';
    ctx2.beginPath();ctx2.moveTo(t.x,t.y);ctx2.lineTo(t.x-8*Math.cos(ang-0.4),t.y-8*Math.sin(ang-0.4));ctx2.lineTo(t.x-8*Math.cos(ang+0.4),t.y-8*Math.sin(ang+0.4));ctx2.closePath();ctx2.fill();
    // Edge label
    if(isActive&&e.label){ctx2.fillStyle='rgba(0,212,255,.9)';ctx2.font='bold 9px JetBrains Mono,monospace';ctx2.fillText(e.label,(s.x+t.x)/2-20,(s.y+t.y)/2-28);}
    ctx2.restore();
  });
  // Particles
  archAnim.particles=archAnim.particles.filter(p=>{
    p.t+=.02;if(p.t>1)return false;
    const sn=getNodeCenter(p.from,W,H),tn=getNodeCenter(p.to,W,H);
    const mx=(sn.x+tn.x)/2,my=(sn.y+tn.y)/2-20;
    const t2=p.t;const inv=1-t2;
    const px=inv*inv*sn.x+2*inv*t2*mx+t2*t2*tn.x;
    const py=inv*inv*sn.y+2*inv*t2*my+t2*t2*tn.y;
    ctx2.save();ctx2.shadowColor=p.color;ctx2.shadowBlur=10;
    ctx2.fillStyle=p.color;ctx2.beginPath();ctx2.arc(px,py,4,0,Math.PI*2);ctx2.fill();
    // Token count label on particle
    if(p.tokLabel){ctx2.font='bold 8px JetBrains Mono,monospace';ctx2.fillStyle=p.color;ctx2.fillText(p.tokLabel,px+6,py-4);}
    ctx2.restore();
    return true;
  });
  // Nodes
  Object.entries(ARCH_NODES).forEach(([nk,n])=>{
    const nx=n.x*W,ny=n.y*H,nw=n.w*W,nh=n.h*H;
    const isActive=archAnim.nodeGlow[nk]>0;
    const glow=archAnim.nodeGlow[nk]||0;
    if(isActive)archAnim.nodeGlow[nk]=Math.max(0,glow-.02);
    ctx2.save();
    if(isActive){ctx2.shadowColor=n.color;ctx2.shadowBlur=20+glow*30;}
    const alpha=isActive?Math.min(1,glow+.3):.15;
    ctx2.fillStyle=n.color+Math.round(alpha*255).toString(16).padStart(2,'0');
    ctx2.strokeStyle=n.color+(isActive?'cc':'44');ctx2.lineWidth=isActive?2:1;
    ctx2.beginPath();ctx2.roundRect(nx,ny,nw,nh,6);ctx2.fill();ctx2.stroke();
    ctx2.fillStyle=isActive?'#fff':n.color;ctx2.font=`bold ${isActive?10:9}px JetBrains Mono,monospace`;ctx2.textAlign='center';
    const lines=n.label.split('\n');lines.forEach((l,i)=>ctx2.fillText(l,nx+nw/2,ny+nh/2+(i-lines.length/2+.5)*13));
    // Token count badge if active
    if(isActive&&archAnim.nodeTokens&&archAnim.nodeTokens[nk]){
      ctx2.fillStyle='rgba(0,0,0,.7)';ctx2.beginPath();ctx2.roundRect(nx+nw-28,ny-12,28,14,4);ctx2.fill();
      ctx2.fillStyle='#00d4ff';ctx2.font='bold 8px JetBrains Mono,monospace';ctx2.textAlign='center';
      ctx2.fillText(archAnim.nodeTokens[nk]+'t',nx+nw-14,ny-2);
    }
    ctx2.restore();
  });
  ctx2.textAlign='left';
  requestAnimationFrame(drawArch);
}

function fireParticle(from,to,color,tokLabel){
  archAnim.particles.push({from,to,t:0,color,tokLabel});
}
function activateNode(nk,tokens){
  archAnim.nodeGlow[nk]=1;
  if(!archAnim.nodeTokens)archAnim.nodeTokens={};
  archAnim.nodeTokens[nk]=tokens||'';
}

function runArchPipeline(turnData){
  if(!turnData)return;
  archAnim.stage=0;
  const stages=[
    ()=>{activateNode('users',turnData.userTok);document.getElementById('arch-active-node').textContent='Users';document.getElementById('arch-active-detail').textContent='User message: '+turnData.userTok+'t';document.getElementById('arch-stage').textContent='Input';document.getElementById('arch-stage-detail').textContent='Receiving query';document.getElementById('arch-tokens-flight').textContent=turnData.userTok;},
    ()=>{if(turnData.ragTok>0){activateNode('rag',turnData.ragTok);archAnim.activeEdges=['rag-ctx'];fireParticle('rag','ctx','#7c4dff',turnData.ragTok+'t');document.getElementById('arch-active-node').textContent='RAG Pipeline';document.getElementById('arch-active-detail').textContent='Retrieving '+cfg('s-rag-chunks')+' chunks × '+cfg('s-rag-chunk-size')+'t';document.getElementById('arch-status').textContent='RAG active';}},
    ()=>{if(turnData.reasonTok>0){activateNode('reason',turnData.reasonTok);archAnim.activeEdges=['reason-ctx'];fireParticle('reason','ctx','#00bcd4',turnData.reasonTok+'t');document.getElementById('arch-active-node').textContent='Fact Reasoner';document.getElementById('arch-active-detail').textContent='Extended thinking: '+turnData.reasonTok+'t';document.getElementById('arch-status').textContent='Reasoning';}},
    ()=>{activateNode('ctx',turnData.ctxTok);archAnim.activeEdges=['users-ctx'];fireParticle('users','ctx','#42a5f5',turnData.ctxTok+'t');document.getElementById('arch-active-node').textContent='Context Assembler';document.getElementById('arch-active-detail').textContent='Full context: '+turnData.ctxTok+'t';document.getElementById('arch-stage').textContent='Assembly';document.getElementById('arch-tokens-flight').textContent=turnData.ctxTok;},
    ()=>{if(turnData.guardTok>0){activateNode('guard_in',turnData.guardTok);archAnim.activeEdges=['ctx-guard_in','guard_in-model'];fireParticle('ctx','guard_in','#ff6d00',turnData.guardTok+'t');document.getElementById('arch-active-node').textContent='Input Guardrails';document.getElementById('arch-active-detail').textContent='Safety scan: '+turnData.guardTok+'t overhead';document.getElementById('arch-status').textContent='Guard active';}else{archAnim.activeEdges=['ctx-model'];fireParticle('ctx','model','#00d4ff',turnData.ctxTok+'t');}},
    ()=>{activateNode('model',turnData.outTok);archAnim.activeEdges=['model'];document.getElementById('arch-active-node').textContent='LLM Model';document.getElementById('arch-active-detail').textContent='Generating: '+turnData.outTok+'t output';document.getElementById('arch-stage').textContent='Inference';document.getElementById('arch-stage-detail').textContent=selectedModel;document.getElementById('arch-status').textContent='Generating';},
    ()=>{if(turnData.toolTok>0){activateNode('tools',turnData.toolTok);archAnim.activeEdges=['model-tools','tools-model'];fireParticle('model','tools','#ce93d8',turnData.toolTok+'t');setTimeout(()=>fireParticle('tools','model','#ab47bc',turnData.toolResultTok+'t'),300);document.getElementById('arch-active-node').textContent='Tool Calls';document.getElementById('arch-active-detail').textContent=cfg('s-tools')+' calls · schema:'+turnData.toolTok+'t · results:'+turnData.toolResultTok+'t';}},
    ()=>{if(turnData.guardOutTok>0){activateNode('guard_out',turnData.guardOutTok);archAnim.activeEdges=['model-guard_out','guard_out-output'];fireParticle('model','guard_out','#e65100',turnData.guardOutTok+'t');}else{archAnim.activeEdges=['model-ia_route'];fireParticle('model','ia_route','#4dd0e1','');}},
    ()=>{activateNode('ia_route',turnData.iaTok);archAnim.activeEdges=['ia_route-model'];fireParticle('model','ia_route','#4dd0e1',turnData.iaTok+'t');document.getElementById('arch-active-node').textContent='IA Router';document.getElementById('arch-active-detail').textContent='Agent handoff: '+turnData.iaTok+'t overhead';},
    ()=>{activateNode('output',turnData.outTok);archAnim.activeEdges=['guard_out-output'];fireParticle('guard_out','output','#00e676',turnData.outTok+'t');document.getElementById('arch-active-node').textContent='Response Output';document.getElementById('arch-active-detail').textContent='Complete: net $'+turnData.cost.toFixed(5);document.getElementById('arch-stage').textContent='Complete';document.getElementById('arch-status').textContent='Done';archAnim.activeEdges=[];},
  ];
  let si=0;
  const next=()=>{if(si<stages.length){stages[si]();si++;setTimeout(next,400);}};
  next();
}

/* SIMULATION AND PER-AGENT EDITOR */
let sim={running:false,agents:[],users:[],totalIn:0,totalOut:0,totalCost:0,ragTok:0,reasonTok:0,guardTok:0,cacheSaved:0,apiCalls:0,toolUses:0,msgCount:0,errCount:0,tickInterval:null,processing:false,history:[]};
function cfg(id){return parseInt(document.getElementById(id)?.value)||0;}
function cfgF(id){return parseFloat(document.getElementById(id)?.value)||0;}
const AGENT_CONFIG_FIELDS=['model','provider','temp','maxOut','turnsShare','toolsOn','ragOn','reasonOn','guardOn','tools_per','schema','result','rag_chunks','rag_size','rag_calls','think_tok','think_pct','cot','factcheck','guard_in','guard_out','guard_pii','guard_policy','cache_rate','task_bias'];
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
  if(k==='cache_rate'||k==='think_pct')return Math.round(n)+'%';
  return Math.round(n).toLocaleString();
}
function agentRangeCtl(a,scope,k,label,min,max,step,color,type='int'){
  const v=a[k]??0;const lid=`a-${scope}-${a.id}-${k}`;const cast=type==='float'?'parseFloat(this.value)':'parseInt(this.value)';
  return `<div class="agent-mini-range"><div class="mini-label"><span>${label}</span><span class="mini-val" id="${lid}" style="color:${color}">${fmtAgentVal(k,v)}</span></div><input type="range" min="${min}" max="${max}" value="${v}" step="${step}" oninput="setAP(${a.id},'${k}',${cast},'${lid}',v=>fmtAgentVal('${k}',v))"></div>`;
}
function agentSection(title,color,on,body){return `<div class="agent-detail-section" style="border-color:${on?color+'44':'var(--b)'};opacity:${on?1:.45}"><div class="agent-section-title" style="color:${color}"><span>${title}</span><span style="font-size:7px;color:${on?color:'var(--dimmer)'}">${on?'active':'off - values retained'}</span></div><div class="agent-edit-grid">${body}</div></div>`;}
function taskBiasSelect(a){return `<select onchange="setAP(${a.id},'task_bias',this.value)" style="width:100%;font-size:8px"><option value="" ${!a.task_bias?'selected':''}>Balanced mix</option>${TASK_TYPES.map(t=>`<option value="${t.id}" ${a.task_bias===t.id?'selected':''}>${t.label}</option>`).join('')}</select>`;}
function agentCardHtml(a,scope){
  const m=MODELS[a.model]||MODELS['claude-sonnet-4.6'];
  const ctxP=Math.min(100,Math.round((a.ctxUsed||0)/m.ctx*100));
  const provider=PROVIDERS[a.provider||m.providerDefault||'managed']||PROVIDERS.managed;
  const modelSelect=MK.map(k=>`<option value="${k}" ${k===a.model?'selected':''}>${modelLabel(k)}</option>`).join('');
  const providerSelect=Object.entries(PROVIDERS).map(([k,v])=>`<option value="${k}" ${k===(a.provider||'managed')?'selected':''}>${v.label}</option>`).join('');
  const toolsBody=[agentRangeCtl(a,scope,'tools_per','Calls / turn',0,8,1,'#ce93d8'),agentRangeCtl(a,scope,'schema','Schema tok / call',0,2000,20,'#ce93d8'),agentRangeCtl(a,scope,'result','Result tok / call',0,8000,100,'#ce93d8')].join('');
  const ragBody=[agentRangeCtl(a,scope,'rag_chunks','Chunks',0,20,1,'#7c4dff'),agentRangeCtl(a,scope,'rag_size','Tokens / chunk',64,4096,64,'#7c4dff'),agentRangeCtl(a,scope,'rag_calls','Retrieval calls',0,5,1,'#7c4dff')].join('');
  const reasonBody=[agentRangeCtl(a,scope,'think_tok','Thinking budget',0,10000,500,'#00bcd4'),agentRangeCtl(a,scope,'think_pct','Reasoning turns',0,100,5,'#00bcd4'),agentRangeCtl(a,scope,'cot','CoT steps',0,20,1,'#00bcd4'),agentRangeCtl(a,scope,'factcheck','Fact-check passes',0,3,1,'#00bcd4')].join('');
  const guardBody=[agentRangeCtl(a,scope,'guard_in','Input guard tok',0,2000,50,'#ff6d00'),agentRangeCtl(a,scope,'guard_out','Output guard tok',0,2000,50,'#ff6d00'),agentRangeCtl(a,scope,'guard_pii','PII scan tok',0,1000,50,'#ff6d00'),agentRangeCtl(a,scope,'guard_policy','Policy tok',0,2000,100,'#ff6d00')].join('');
  return `<div class="agent-card ${a.busy?'processing':''}" id="ac-${scope}-${a.id}">
    <div class="agent-header" onclick="togAgent(${a.id})">
      <div class="agent-av" style="background:${a.col}18;border:1px solid ${a.col}44;color:${a.col}">${a.name[0]}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:10px;font-weight:700;color:${a.col}">${a.name} <span style="font-size:7px;color:var(--dim);font-weight:400">${a.role}</span></div>
        <div style="font-size:7px;color:${m.color}">${modelLabel(a.model)} - ${provider.label}</div>
        <div style="height:3px;background:var(--track);border-radius:2px;margin:2px 0"><div style="width:${a.utilPct||0}%;height:100%;background:${a.col}88;border-radius:2px;transition:width .5s" id="ab-${scope}-${a.id}"></div></div>
        <div style="display:flex;gap:3px;margin-top:2px;flex-wrap:wrap">
          ${a.ragOn?'<span class="badge-rag">RAG</span>':''}${a.reasonOn?'<span class="badge-reason">THINK</span>':''}${a.guardOn?'<span class="badge-guard">GUARD</span>':''}${a.toolsOn?'<span class="badge">TOOLS</span>':''}
          <span class="badge" style="background:rgba(124,77,255,.1);color:var(--purple);border-color:rgba(124,77,255,.2)">x${(a.turnsShare||1).toFixed(1)} turns</span>
        </div>
        <div style="font-size:7px;color:var(--dimmer)" id="as-${scope}-${a.id}">in:${(a.realIn||0).toLocaleString()} ctx:${ctxP}%</div>
      </div>
      <span class="arrow ${a.expanded?'open':''}">▶</span>
    </div>
    <div class="agent-cfg-panel ${a.expanded?'open':''}" id="cfg-${scope}-${a.id}">
      <div class="agent-edit-grid">
        <div><div style="font-size:7px;color:var(--dim);margin-bottom:2px">Model</div><select onchange="setAM(${a.id},this.value)" style="width:100%;font-size:8px">${modelSelect}</select></div>
        <div><div style="font-size:7px;color:var(--dim);margin-bottom:2px">Provider</div><select onchange="setAP(${a.id},'provider',this.value)" style="width:100%;font-size:8px">${providerSelect}</select></div>
        <div><div style="font-size:7px;color:var(--dim);margin-bottom:2px">Task bias</div>${taskBiasSelect(a)}</div>
      </div>
      <div style="font-size:7px;color:var(--dimmer);margin-bottom:6px">${provider.note}${provider.fixed_mo>0?' - $'+provider.fixed_mo.toLocaleString()+'/mo fixed':''}</div>
      <div class="agent-edit-grid">
        ${agentRangeCtl(a,scope,'turnsShare','Turn share x',0.2,3,0.1,'#00d4ff','float')}
        ${agentRangeCtl(a,scope,'cache_rate','Cache hit rate',0,95,5,'#00e676')}
        ${agentRangeCtl(a,scope,'temp','Temperature',0,1,0.05,'#ffab40','float')}
        ${agentRangeCtl(a,scope,'maxOut','Max output tok',64,4096,64,'#42a5f5')}
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
      <div style="font-size:7px;color:var(--dimmer);margin-top:5px">Task bias: ${a.task_bias||'balanced'} - ctx fill: ${ctxP}% - source: ${m.source||'static bootstrap'}</div>
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
  const eb=document.getElementById('agent-editor-badge');if(eb)eb.textContent=n+' agents';
  const sb=document.getElementById('agent-count-badge');if(sb)sb.textContent=n;
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
function setAM(id,m){const a=sim.agents.find(x=>x.id===id);if(a){a.model=m;const md=MODELS[m];if(md&&(!a.provider||a.provider==='managed'||a.provider==='together'))a.provider=md.providerDefault||a.provider||'managed';renderAgents();refreshAfterAgentEdit();}}
function setAP(id,k,v,lid,fmt){const a=sim.agents.find(x=>x.id===id);if(a){a[k]=v;if(lid){const el=document.getElementById(lid);if(el&&fmt)el.textContent=fmt(v);}refreshAfterAgentEdit();}}
function togAF(id,f,btn){const a=sim.agents.find(x=>x.id===id);if(!a)return;a[f]=!a[f];const labels={ragOn:['RAG','rag-on'],reasonOn:['THINK','reason-on'],guardOn:['GUARD','guard-on'],toolsOn:['TOOLS','on']};const[l,cls]=labels[f]||['','on'];if(btn){btn.textContent=l+' '+(a[f]?'ON':'OFF');btn.className='tgl '+(a[f]?cls:'');}renderAgents();refreshAfterAgentEdit();}
function applyGlobalsToAgents(){sim.agents.forEach(a=>{a.cache_rate=cfg('s-cache');a.tools_per=cfg('s-tools');a.schema=cfg('s-schema');a.result=cfg('s-toolresult');a.rag_chunks=cfg('s-rag-chunks');a.rag_size=cfg('s-rag-chunk-size');a.rag_calls=cfg('s-rag-calls');a.think_tok=cfg('s-think-tokens');a.think_pct=cfg('s-think-pct');a.cot=cfg('s-cot');a.factcheck=cfg('s-factcheck');a.guard_in=cfg('s-guard-in');a.guard_out=cfg('s-guard-out');a.guard_pii=cfg('s-guard-pii');a.guard_policy=cfg('s-guard-policy');});renderAgents();refreshAfterAgentEdit();}
function applySelectedModelToAgents(){sim.agents.forEach(a=>{a.model=selectedModel;const md=MODELS[selectedModel];if(md)a.provider=md.providerDefault||a.provider||'managed';});renderAgents();refreshAfterAgentEdit();}
function resetAgentFleet(){buildAgents(true);renderAgents();refreshAfterAgentEdit();}
function normalizeAgentTurns(){const n=sim.agents.length||1;const sum=sim.agents.reduce((s,a)=>s+(a.turnsShare||1),0)||n;const scale=n/sum;sim.agents.forEach(a=>a.turnsShare=Math.max(.2,Math.min(3,Math.round((a.turnsShare||1)*scale*10)/10)));renderAgents();refreshAfterAgentEdit();}

function toggleSim(){
  sim.running=!sim.running;
  const btn=document.getElementById('sim-btn');const dot=document.getElementById('status-dot');const st=document.getElementById('sys-status');
  if(sim.running){converged=false;costHistory=[];const cb=document.getElementById('conv-banner');if(cb)cb.className='conv-banner';btn.textContent='STOP';btn.className='sim-btn stop';st.textContent='RUNNING';st.style.color='var(--amber)';dot.style.background='var(--amber)';document.getElementById('empty-msg')?.remove();buildAgents();buildUsers();renderAgents();showTab('sim');scheduleTicks();}
  else{btn.textContent='START';btn.className='sim-btn';st.textContent='PAUSED';st.style.color='var(--red)';dot.style.background='var(--red)';clearInterval(sim.tickInterval);sim.tickInterval=null;}
}
function scheduleTicks(){const spds=[2000,1100,650,350,160,80];sim.tickInterval=setInterval(runTick,spds[parseInt(document.getElementById('sim-speed-sel')?.value||2)]);}

async function runTick(){
  if(sim.processing)return;sim.processing=true;clearInterval(sim.tickInterval);
  const nT=Math.min(cfg('s-turns'),3);
  for(let t=0;t<nT;t++){
    if(!sim.running)break;
    const user=sim.users[t%Math.max(1,sim.users.length)];
    const agent=sim.agents[t%sim.agents.length];
    const model=MODELS[agent.model]||MODELS['claude-sonnet-4.6'];
    const isWorkflow = (typeof executionMode!=='undefined' && executionMode==='workflow');
    const userPool = isWorkflow ? UMSGS_LONG : UMSGS_SHORT;
    const userText=userPool[Math.floor(Math.random()*userPool.length)];
    const sysTok=tok(SYS_P[agent.role]||'')+cfg('s-sysprompt');
    const histTok=sim.history.slice(-4).reduce((s,m)=>s+tok(m)+4,0);
    const userTok=tok(userText)+4;
    const maxTools=agent.toolsOn?Math.max(0,agent.tools_per??cfg('s-tools')):0;
    const nTools=agent.toolsOn?Math.floor(Math.random()*(maxTools+1)):0;
    const toolSch=nTools*(agent.schema??cfg('s-schema'));const toolRes=nTools*(agent.result??cfg('s-toolresult'));
    const ragTokT=agent.ragOn?(((agent.rag_chunks??cfg('s-rag-chunks'))*(agent.rag_size??cfg('s-rag-chunk-size'))+(cfg('s-rag-query')||0))*(agent.rag_calls??cfg('s-rag-calls'))):0;
    const thinkPct=agent.reasonOn?((agent.think_pct??cfg('s-think-pct'))/100):0;
    const reasonTokT=agent.reasonOn?((agent.think_tok??cfg('s-think-tokens'))*thinkPct+(agent.cot??cfg('s-cot'))*150+(agent.factcheck??cfg('s-factcheck'))*200):0;
    const guardTokT=agent.guardOn?((agent.guard_in??cfg('s-guard-in'))+(agent.guard_out??cfg('s-guard-out'))+(agent.guard_pii??cfg('s-guard-pii'))+(agent.guard_policy??cfg('s-guard-policy'))):0;
    const iaMsgOH=cfg('s-iamsg');
    const realIn=sysTok+histTok+userTok+toolSch+toolRes+ragTokT+reasonTokT+guardTokT+iaMsgOH+3;
    const om=wOM();const tools=shuffle(TOOLS_LIST).slice(0,nTools);
    const respPool = isWorkflow ? RESPS_LONG : RESPS_SHORT; const rfn=respPool[Math.floor(Math.random()*respPool.length)];const rawR=rfn(agent,agent.temp,tools);
    const tW=Math.floor(agent.maxOut*om*.6);const words=rawR.split(' ');
    const finalR=words.length>tW?words.slice(0,tW).join(' ')+'…':rawR;
    const realOut=tok(finalR);
    const cR=((agent.cache_rate!==undefined)?agent.cache_rate:cfg('s-cache'))/100;const bR=cfg('s-batch')/100;const retR=cfg('s-retry')/100;
    const provider=providerForAgent(agent,agent.model,false);
    const langMult=parseFloat(document.getElementById('s-lang-mult')?.value||'1.0')||1.0;
    const tierInfo=resolvePricingTier(model,provider,langMult,realIn);
    let base=0,cacheSave=0;
    if(provider.in_mult===0&&provider.out_mult===0){base=provider.fixed_mo/Math.max(1,cfg('s-sessions')*30);}else{
      const inPrice=pricedInputCost(realIn,tierInfo.inRate,tierInfo.priceModel,bR,cR);
      const outPrice=pricedOutputCost(realOut,tierInfo.outRate,tierInfo.priceModel,bR);
      base=inPrice.cost+outPrice.cost;cacheSave=inPrice.cacheSave;
    }
    const isErr=Math.random()<retR;const retryW=isErr?base*1.5:0;
    const netCost=base+retryW;
    sim.totalIn+=realIn;sim.totalOut+=realOut;sim.totalCost+=netCost;costHistory.push(netCost);if(!converged&&checkConvergence()){converged=true;showConvergence();toggleSim();}sim.cacheSaved+=cacheSave;
    sim.ragTok+=ragTokT;sim.reasonTok+=reasonTokT;sim.guardTok+=guardTokT;
    sim.apiCalls++;sim.toolUses+=nTools;sim.msgCount+=2;if(isErr)sim.errCount++;
    agent.tokens+=realIn+realOut;agent.realIn+=realIn;agent.realOut+=realOut;
    agent.ctxUsed=Math.min(agent.ctxUsed+realIn+realOut,model.ctx);
    agent.calls++;agent.busy=true;agent.utilPct=Math.min(100,agent.utilPct+Math.floor(Math.random()*22+10));
    sim.history.push(userText,finalR);if(sim.history.length>12)sim.history=sim.history.slice(-12);
    // Fire arch animation
    const turnData={userTok,ctxTok:realIn,outTok:realOut,ragTok:ragTokT,reasonTok:reasonTokT,guardTok:guardTokT,guardOutTok:(agent.guard_out??cfg('s-guard-out')),toolTok:toolSch,toolResultTok:toolRes,iaTok:iaMsgOH,cost:netCost};
    runArchPipeline(turnData);
    updateAgentChip(agent);addUserMsg(user,agent,userText,realIn);await wait(90+Math.random()*60);addTyping(agent);await wait(agent.stream?150+Math.random()*110:200+Math.random()*150);removeTyping();
    addAgentMsg(agent,finalR,realIn,realOut,netCost,cacheSave,tools,isErr,ragTokT,reasonTokT,guardTokT);
    tools.forEach(t=>logTool(agent,t));agent.busy=false;agent.utilPct=Math.max(0,agent.utilPct-Math.floor(Math.random()*18));
    updateAgentChip(agent);updateKPIs();updateCostPanel();renderLedger();updateUtilBars();updateCtxBars();spawnSparks();
  }
  sim.processing=false;if(sim.running)scheduleTicks();
}
function updateAgentChip(a){
  const m=MODELS[a.model]||MODELS['claude-sonnet-4.6'];const ctxP=Math.min(100,Math.round((a.ctxUsed||0)/m.ctx*100));
  ['sim','settings'].forEach(scope=>{
    const card=document.getElementById('ac-'+scope+'-'+a.id);if(card)card.className='agent-card '+(a.busy?'processing':'');
    const bar=document.getElementById('ab-'+scope+'-'+a.id);if(bar)bar.style.width=(a.utilPct||0)+'%';
    const st=document.getElementById('as-'+scope+'-'+a.id);if(st)st.textContent='in:'+(a.realIn||0).toLocaleString()+' ctx:'+ctxP+'%';
  });
}
function addUserMsg(user,agent,text,tokens){const chat=document.getElementById('chat-area');if(!chat)return;const div=document.createElement('div');div.className='msg right';div.innerHTML=`<div class="msg-av" style="background:#ffffff0b;border:1px solid #ffffff16;color:#a0b4cc">${user.name[0]}</div><div class="msg-body"><div class="msg-meta"><span style="font-weight:700;color:var(--text-primary,#c8d8f0)">${user.name}</span><span>→${agent.name}</span><span>${now()}</span></div><div class="msg-bubble" style="background:var(--surface-hover,rgba(255,255,255,.04));border:1px solid var(--b)">${text}</div><div class="msg-toks">in:${tokens.toLocaleString()}t</div></div>`;appChat(chat,div);}
function addTyping(a){const chat=document.getElementById('chat-area');if(!chat)return;const div=document.createElement('div');div.id='typ';div.className='msg';div.innerHTML=`<div class="msg-av" style="background:${a.col}18;border:1px solid ${a.col}44;color:${a.col}">${a.name[0]}</div><div class="msg-body"><div class="msg-meta"><span style="color:${a.col};font-weight:700">${a.name}</span></div><div class="msg-bubble" style="background:${a.col}09;border:1px solid ${a.col}28"><div class="typing"><div class="td"></div><div class="td"></div><div class="td"></div></div></div></div>`;chat.appendChild(div);chat.scrollTop=chat.scrollHeight;}
function removeTyping(){document.getElementById('typ')?.remove();}
function addAgentMsg(agent,text,inTok,outTok,cost,cacheSave,tools,isErr,ragT,reasonT,guardT){
  const m=MODELS[agent.model]||MODELS['claude-sonnet-4.6'];const chat=document.getElementById('chat-area');if(!chat)return;
  const div=document.createElement('div');div.className='msg';
  const tc=tools.map(t=>`<span class="chip" style="background:rgba(206,147,216,.09);border:1px solid rgba(206,147,216,.2);color:var(--purple)">${t}</span>`).join('');
  div.innerHTML=`<div class="msg-av" style="background:${agent.col}18;border:1px solid ${agent.col}44;color:${agent.col}">${agent.name[0]}</div><div class="msg-body">
    <div class="msg-meta"><span style="color:${agent.col};font-weight:700">${agent.name}</span>
    <span class="chip" style="background:${m.color}14;border:1px solid ${m.color}30;color:${m.color}">${agent.model.replace('claude-','').substring(0,9)}</span>
    ${ragT>0?`<span class="chip" style="background:rgba(124,77,255,.1);border:1px solid rgba(124,77,255,.25);color:var(--rag)">RAG+${ragT}t</span>`:''}
    ${reasonT>0?`<span class="chip" style="background:rgba(0,188,212,.1);border:1px solid rgba(0,188,212,.25);color:var(--reason)">THINK+${Math.round(reasonT)}t</span>`:''}
    ${guardT>0?`<span class="chip" style="background:rgba(255,109,0,.1);border:1px solid rgba(255,109,0,.25);color:var(--guard)">GUARD+${guardT}t</span>`:''}
    ${isErr?`<span class="chip" style="background:rgba(255,82,82,.1);border:1px solid rgba(255,82,82,.25);color:var(--red)">RETRY</span>`:''}
    <span>${now()}</span></div>
    <div class="msg-bubble" style="background:${agent.col}09;border:1px solid ${agent.col}22">${text}</div>
    ${tc?`<div style="display:flex;flex-wrap:wrap;gap:2px;margin-top:3px">${tc}</div>`:''}
    <div class="msg-toks">in:${inTok.toLocaleString()} out:${outTok.toLocaleString()} · cache:-${cacheSave.toFixed(5)} · net:${cost.toFixed(5)}</div>
  </div>`;
  appChat(chat,div);document.getElementById('stream-count').textContent=sim.msgCount+' msgs';
}
function appChat(chat,div){chat.appendChild(div);if(chat.children.length>80)chat.removeChild(chat.firstChild);chat.scrollTop=chat.scrollHeight;}
function logTool(agent,tool){const log=document.getElementById('tool-log');if(!log)return;const cols={web_search:'var(--cyan)',db_query:'var(--amber)',code_exec:'var(--green)',vector_search:'var(--rag)',default:'var(--purple)'};const c=cols[tool]||cols.default;const e=document.createElement('div');e.className='log-entry';e.style.borderLeftColor=c;e.innerHTML=`<div style="display:flex;justify-content:space-between"><span style="font-weight:700;font-size:8px;color:${c}">${tool}</span><span style="font-size:7px;color:var(--dimmer)">${now()}</span></div><div style="font-size:7px;color:var(--dim,rgba(180,200,230,.5))">${agent.name} · ${Math.floor(Math.random()*300+50)}ms</div>`;log.prepend(e);while(log.children.length>5)log.removeChild(log.lastChild);}
function updateUtilBars(){const el=document.getElementById('util-bars');if(!el)return;el.innerHTML=sim.agents.map(a=>`<div style="display:flex;align-items:center;gap:4px;font-size:7px"><span style="color:${a.col};width:30px;flex-shrink:0;font-weight:700">${a.name}</span><div style="flex:1;height:5px;background:var(--track);border-radius:2px;overflow:hidden"><div style="width:${a.utilPct||0}%;height:100%;background:${a.col}99;border-radius:2px;transition:width .5s"></div></div><span style="color:var(--dim);width:22px;text-align:right">${a.utilPct||0}%</span></div>`).join('');}
function updateCtxBars(){const el=document.getElementById('ctx-bars');if(!el)return;el.innerHTML=sim.agents.map(a=>{const m=MODELS[a.model]||MODELS['claude-sonnet-4.6'];const pct=Math.min(100,Math.round(a.ctxUsed/m.ctx*100));const c=pct>80?'var(--red)':pct>50?'var(--amber)':'var(--cyan)';return `<div style="display:flex;align-items:center;gap:4px;font-size:7px"><span style="color:${a.col};width:30px;flex-shrink:0;font-weight:700">${a.name}</span><div style="flex:1;height:5px;background:var(--track);border-radius:2px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${c};border-radius:2px;transition:width .5s"></div></div><span style="color:${c};width:22px;text-align:right">${pct}%</span></div>`;}).join('');}

/* ═══════ KPIs ═══════ */
function updateKPIs(){
  const tot=sim.totalIn+sim.totalOut;
  document.getElementById('kpi-tokens').textContent=tot.toLocaleString();
  document.getElementById('kpi-tr').textContent='p90:'+Math.round(p90(tot)).toLocaleString();
  document.getElementById('kpi-cost').textContent='$'+sim.totalCost.toFixed(4);
  document.getElementById('kpi-cr').textContent='p90:$'+p90(sim.totalCost).toFixed(4);
  const monthly=sim.totalCost*(cfg('s-sessions')*30/Math.max(sim.apiCalls,1));
  document.getElementById('kpi-monthly').textContent='$'+Math.round(monthly).toLocaleString();
  document.getElementById('kpi-mr').textContent='p90:$'+Math.round(p90(monthly)).toLocaleString();
  document.getElementById('kpi-rag').textContent=sim.ragTok.toLocaleString();
  document.getElementById('kpi-reason').textContent=sim.reasonTok.toLocaleString();
  document.getElementById('kpi-guard').textContent=sim.guardTok.toLocaleString();
  document.getElementById('kpi-calls').textContent=sim.apiCalls.toLocaleString();
  document.getElementById('kpi-er').textContent=sim.errCount+' err';
  document.getElementById('arch-status').textContent=sim.running?'Running':'Idle';
  const sc=computeCost();
  document.getElementById('kpi-rag').textContent=(sim.ragTok||Math.round(sc.ragTokPerTurn*cfg('s-turns')*cfg('s-agents'))).toLocaleString();
}

/* ═══════ ONSLIDER ═══════ */
function onSlider(){
  const sv=(id,fmt)=>{const el=document.getElementById('v-'+id);if(el)el.textContent=fmt(cfg('s-'+id));};
  sv('agents',v=>v);sv('users',v=>v.toLocaleString());sv('turns',v=>v);sv('sessions',v=>v.toLocaleString());
  document.getElementById('v-cache').textContent=cfg('s-cache')+'%';
  document.getElementById('v-cache-write-share').textContent=cfg('s-cache-write-share')+'%';
  document.getElementById('v-batch').textContent=cfg('s-batch')+'%';
  document.getElementById('v-retry').textContent=cfg('s-retry')+'%';
  document.getElementById('v-growth').textContent=cfg('s-growth')+'%';
  sv('rag-chunks',v=>v);sv('rag-chunk-size',v=>v);sv('rag-query',v=>v);sv('rag-calls',v=>v);
  sv('think-tokens',v=>v);sv('think-pct',v=>v+'%');sv('factcheck',v=>v);sv('cot',v=>v);
  sv('guard-in',v=>v);sv('guard-out',v=>v);sv('guard-pii',v=>v);sv('guard-policy',v=>v);sv('guard-block',v=>v+'%');
  sv('tools',v=>v);sv('schema',v=>v);sv('toolresult',v=>v);sv('iamsg',v=>v);sv('sysprompt',v=>v);
  // Comm pattern: 0=orch, 1=peer, 2=sup — flip the label so the UI reflects
  // the active pattern. Numerical effect on cost is in computeCost (turnIn).
  const _vcp = document.getElementById('v-comm-pattern');
  if (_vcp) { const _cpv = cfg('s-comm-pattern'); _vcp.textContent = _cpv === 1 ? 'peer' : _cpv === 2 ? 'sup' : 'orch'; }
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

  // Make global sliders the canonical source of truth for every agent.
  // AGENT_DEF predefines per-agent overrides (rag_chunks:5, tools_per:3,
  // schema:320 etc.) which silently shadow the global sliders via the
  // `agent.rag_chunks ?? cfg('s-rag-chunks')` pattern in computeCost. To
  // keep the sliders load-bearing, we both (a) flip the on/off gate when
  // the slider is non-zero, AND (b) broadcast the slider's numeric value
  // into every agent's per-agent override. Users can still customize a
  // single agent via the per-agent editor — but the next slider move
  // re-broadcasts. Tradeoff: simple + responsive over fine-grained.
  if (Array.isArray(sim?.agents)) {
    // Field map: slider id → agent field. Broadcast happens only when a
    // slider's value has CHANGED since the last broadcast. This preserves
    // genuine per-agent edits made via the per-agent editor — moving an
    // unrelated slider (e.g. batch %) no longer clobbers Agent 2's
    // hand-tuned RAG chunk count.
    if (!window._sliderBcastPrev) window._sliderBcastPrev = {};
    const fields = [
      ['s-rag-chunks',     'rag_chunks'],
      ['s-rag-chunk-size', 'rag_size'],
      ['s-rag-calls',      'rag_calls'],
      ['s-tools',          'tools_per'],
      ['s-schema',         'schema'],
      ['s-toolresult',     'result'],
      ['s-think-tokens',   'think_tok'],
      ['s-think-pct',      'think_pct'],
      ['s-cot',            'cot'],
      ['s-factcheck',      'factcheck'],
      ['s-guard-in',       'guard_in'],
      ['s-guard-out',      'guard_out'],
      ['s-guard-pii',      'guard_pii'],
      ['s-guard-policy',   'guard_policy'],
    ];
    const changed = {};
    for (const [sid, field] of fields) {
      const v = cfg(sid);
      if (window._sliderBcastPrev[sid] !== v) {
        changed[field] = v;
        window._sliderBcastPrev[sid] = v;
      }
    }
    // On/off gates flip true whenever the relevant slider group is non-zero.
    // These don't need change-tracking — they're additive (turning a slider
    // on enables the feature; turning it back to 0 doesn't auto-disable it
    // since the flag may have been set deliberately).
    const ragChunks   = cfg('s-rag-chunks');
    const ragSize     = cfg('s-rag-chunk-size');
    const ragCalls    = cfg('s-rag-calls');
    const toolsPer    = cfg('s-tools');
    const schemaTok   = cfg('s-schema');
    const toolResult  = cfg('s-toolresult');
    const thinkTok    = cfg('s-think-tokens');
    const cotN        = cfg('s-cot');
    const factcheckN  = cfg('s-factcheck');
    const guardIn     = cfg('s-guard-in');
    const guardOut    = cfg('s-guard-out');
    const guardPii    = cfg('s-guard-pii');
    const guardPolicy = cfg('s-guard-policy');
    const ragGlobal    = (ragChunks > 0) || (ragSize > 0) || (ragCalls > 0);
    const toolsGlobal  = (toolsPer > 0)  || (schemaTok > 0) || (toolResult > 0);
    const reasonGlobal = (thinkTok > 0)  || (cotN > 0)      || (factcheckN > 0);
    const guardGlobal  = (guardIn > 0)   || (guardOut > 0)  || (guardPii > 0) || (guardPolicy > 0);
    for (const a of sim.agents) {
      if (ragGlobal)    a.ragOn    = true;
      if (toolsGlobal)  a.toolsOn  = true;
      if (reasonGlobal) a.reasonOn = true;
      if (guardGlobal)  a.guardOn  = true;
      // Only write fields whose underlying slider just moved. Per-agent
      // edits to other fields are preserved.
      for (const k of Object.keys(changed)) a[k] = changed[k];
    }
  }

  renderLedger();updateCostPanel();updateKPIs();updateSensitivity();
  if(sim.agents.length!==cfg('s-agents')){buildAgents();buildUsers();renderAgents();}
  else{renderAgentSettingsSummary();}

  // AXIOM sliders are the single source of truth for traffic. Every
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
  if(document.getElementById('s-fc-pct')) document.getElementById('v-fc-pct').textContent = cfg('s-fc-pct')+'%';
  if(document.getElementById('s-fc-in')) document.getElementById('v-fc-in').textContent = cfg('s-fc-in');
  if(document.getElementById('s-fc-price')){
    const fcPrices=[0,0.20,0.80,1.50,3.00,5.00];
    document.getElementById('v-fc-price').textContent = '$'+fcPrices[cfg('s-fc-price')]?.toFixed(2);
  }
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
   All AXIOM tab panels render stacked simultaneously (single-page flow).
   showTab() now just scrolls to the corresponding section header. The
   tab-sim grid stays gated by toggleSim(): when 'sim' is requested we
   reveal the live-simulation grid (which is hidden by default).
   ====================================== */
function showTab(name){
  // Keep .active state purely as a marker (some renderers may inspect it).
  const TABS=['config','audience','agents','arch','tokens','cost','routing','methodology','sensitivity','sim'];
  TABS.forEach(t=>{
    const p=document.getElementById('tab-'+t);
    if(p){p.classList.toggle('active',t===name);}
  });
  // Live-simulation grid: reveal when sim activates, otherwise leave alone.
  const g=document.getElementById('tab-sim-grid');
  if(g && name==='sim'){g.style.display='grid';}
  // Lazy renderer hooks.
  if(name==='arch' && typeof drawArch==='function')drawArch();
  if(name==='audience' && typeof renderAudience==='function')renderAudience();
  // Scroll to the section header (not the grid for sim — the grid is hidden
  // until sim runs, so for 'sim' we scroll to the agents section instead).
  const target=name==='sim'
    ? document.getElementById('tab-sim-grid')
    : document.getElementById('axiom-h-'+name);
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

function spawnSparks(){const vfx=document.getElementById('vfx');['RAG','GUARD','CoT','BPE','p90'].forEach((sym,i)=>{setTimeout(()=>{const s=document.createElement('div');s.className='spark';s.textContent=sym;s.style.left=(15+Math.random()*70)+'%';s.style.top=(25+Math.random()*55)+'%';s.style.color=['var(--rag)','var(--guard)','var(--reason)','var(--cyan)','var(--amber)'][i];vfx.appendChild(s);setTimeout(()=>s.remove(),1000);},i*65);});}
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

/* CONVERGENCE */
const CONV_THRESHOLD=0.02,CONV_WINDOW=10;
let costHistory=[],converged=false;
function checkConvergence(){
  const maxR=parseInt(document.getElementById('max-rounds')?.value)||60;
  if(sim.apiCalls>=maxR)return true;
  if(costHistory.length<CONV_WINDOW)return false;
  const recent=costHistory.slice(-CONV_WINDOW);
  const mean=recent.reduce((s,v)=>s+v,0)/recent.length;
  return Math.max(...recent.map(v=>Math.abs(v-mean)/Math.max(mean,1e-10)))<CONV_THRESHOLD;
}
function showConvergence(){
  const b=document.getElementById('conv-banner');
  if(!b)return;
  b.className='conv-banner show';
  const sc=computeCost();
  const sess=cfg('s-sessions');
  const parts=[];
  parts.push('<div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;animation:bl 1s ease-in-out infinite"></div>');
  parts.push('<div>');
  parts.push('<div style="font-weight:700;color:var(--green)">Simulation converged — cost estimate stable within &plusmn;2%</div>');
  parts.push('<div style="font-size:8px;margin-top:2px">');
  parts.push('p50: <b style="color:var(--green)">$' + (sc.netCost||0).toFixed(5) + '</b>');
  parts.push(' &nbsp;&middot;&nbsp; p90: <b style="color:var(--amber)">$' + p90(sc.netCost).toFixed(5) + '</b>');
  parts.push(' &nbsp;&middot;&nbsp; p99: <b style="color:var(--red)">$' + p99(sc.netCost).toFixed(5) + '</b>');
  parts.push(' &nbsp;&middot;&nbsp; Monthly: <b style="color:var(--cyan)">$' + Math.round(sc.netCost*sess*30).toLocaleString() + '</b>');
  parts.push('</div></div>');
  parts.push('<button id="conv-close" style="margin-left:auto;background:none;border:none;color:var(--dim);cursor:pointer;font-size:16px;padding:0 4px">&#215;</button>');
  b.innerHTML = parts.join('');
  const cb = document.getElementById('conv-close');
  if(cb) cb.onclick = function(){ b.className='conv-banner'; };
}
/* THEMES — apply theme class to BOTH <body> (so calc's body-level
   overrides take effect) AND .simulator-pane (so AXIOM's existing CSS
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
  try{ localStorage.setItem('ccs-theme', t); }catch(_){}
  setTimeout(()=>{
    try{updateCostPanel();renderLedger();updateSensitivity();}catch(e){}
    const ac=document.getElementById('arch-canvas');
    if(ac){const ctx2=ac.getContext('2d');const tc=getChartColors();ctx2.fillStyle=tc.bg;ctx2.fillRect(0,0,ac.width,ac.height);}
  },60);
}
// Restore saved theme on load (default: mission).
(function restoreTheme(){
  let t='mission';
  try{ t = localStorage.getItem('ccs-theme') || 'mission'; }catch(_){}
  if(!['tactical','mission','command'].includes(t)) t='mission';
  // Defer until DOM (and AXIOM init) is ready.
  const apply = () => { try{ setTheme(t); }catch(e){ console.warn('setTheme deferred:',e); setTimeout(apply,200);} };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',apply);
  else apply();
})();

/* ═══════ MULTI-MODEL ROUTING ═══════ */
let routingSplit = Object.assign(Object.fromEntries(MK.map(k=>[k,0])), {'claude-haiku-4.5':60,'claude-sonnet-4.6':25,'claude-opus-4.7':5,'gpt-5.4':5,'gemini-3-flash-preview':5});

function renderRoutingSliders(){
  const container=document.getElementById('routing-sliders');
  if(!container)return;
  container.innerHTML=MK.map(k=>{
    const m=MODELS[k];const v=routingSplit[k]||0;
    return `<div style="display:flex;align-items:center;gap:7px">
      <span style="font-size:9px;color:${m.color};width:144px;flex-shrink:0;font-weight:700">${(m.label||k).substring(0,24)}</span>
      <input type="range" min="0" max="100" step="5" value="${v}" oninput="setRouting('${k}',this.value)" style="flex:1">
      <span style="font-size:10px;font-weight:700;min-width:42px;text-align:right;color:${m.color}" id="route-${k.replace(/[^a-z0-9]/gi,'')}">${v}%</span>
      <span style="font-size:8px;color:var(--dim);min-width:60px;text-align:right">${m.in}/${m.out}</span>
    </div>`;
  }).join('');
  updateRoutingDisplay();
}
function setRouting(k,v){
  routingSplit[k]=parseInt(v);
  const safeK=k.replace(/[^a-z0-9]/gi,'');
  const el=document.getElementById('route-'+safeK);if(el)el.textContent=v+'%';
  updateRoutingDisplay();
}
function applyRouting(preset){
  const empty=Object.fromEntries(MK.map(k=>[k,0]));
  const presets={
    triage:{...empty,'claude-haiku-4.5':70,'claude-sonnet-4.6':25,'claude-opus-4.7':5},
    production:{...empty,'claude-haiku-4.5':85,'claude-sonnet-4.6':15},
    hybrid:{...empty,'gemini-3-flash-preview':50,'claude-sonnet-4.6':30,'claude-opus-4.7':20},
    conservative:{...empty,'claude-sonnet-4.6':100},
    cost:{...empty,'gemini-2.5-flash-lite':65,'gemini-3.1-flash-lite-preview':20,'llama-3.3-70b-together':10,'claude-sonnet-4.6':5},
    quality:{...empty,'claude-sonnet-4.6':55,'claude-opus-4.7':30,'gpt-5.5':15},
  };
  routingSplit=presets[preset]||routingSplit;
  renderRoutingSliders();
}
function updateRoutingDisplay(){
  const total=Object.values(routingSplit).reduce((s,v)=>s+v,0)||1;
  let blended=0;
  Object.entries(routingSplit).forEach(([k,pct])=>{
    if(pct>0)blended+=(pct/total)*computeCost(k).netCost;
  });
  const baseline=computeCost('claude-sonnet-4.6').netCost;
  const savings=((baseline-blended)/baseline*100);
  const sess=cfg('s-sessions');
  const rc=document.getElementById('routed-cost');if(rc)rc.textContent='$'+blended.toFixed(5);
  const rs=document.getElementById('routed-savings');
  if(rs){rs.textContent=(savings>0?'-':'+')+Math.abs(savings).toFixed(1)+'%';rs.style.color=savings>0?'var(--green)':'var(--red)';}
  const rm=document.getElementById('routed-monthly');if(rm)rm.textContent='$'+Math.round(blended*sess*30).toLocaleString();
  buildRoutingChart(blended,baseline);
}
function buildRoutingChart(routed,single){
  const ctx=document.getElementById('chart-routing');if(!ctx)return;
  if(charts.routing)charts.routing.destroy();
  const sess=cfg('s-sessions');
  charts.routing=new Chart(ctx.getContext('2d'),{
    type:'bar',
    data:{labels:['Single Sonnet','Multi-Model Routed'],
      datasets:[{label:'Cost/sess',data:[single,routed],backgroundColor:['rgba(0,212,255,.5)','rgba(0,230,118,.5)'],borderColor:['rgba(0,212,255,.9)','rgba(0,230,118,.9)'],borderWidth:1}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{x:{grid:{color:getChartColors().grid},ticks:{color:getChartColors().tick,font:{size:9}}},
        y:{grid:{color:getChartColors().grid},ticks:{color:getChartColors().tick,font:{size:8},callback:v=>'$'+v.toFixed(4)}}}}
  });
}

/* ═══════ JSON EXPORT ═══════ */
function exportJSON(){
  const sess=cfg('s-sessions');
  const data={
    metadata:{tool:'Token simulator',timestamp:new Date().toISOString(),
      pricing_date:MODEL_PRICE_VERIFIED,disclaimer:'Planning estimate only — not contractual'},
    config:snapshotConfig(),
    routing:routingSplit,
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
      }else{const el=document.getElementById(id);if(el)el.value=v;}
    });
    onSlider();
    if(c.agents)applyAgentConfigSnapshot(c.agents);
    renderTaskBars();
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
  onSlider();renderRoutingSliders();
}

/* MODE: single agent / fleet (parallel) / workflow (sequential DAG)
   'single' is a convenience preset that sets agents=1 and underlying
   mode='fleet'; the cost engine treats it as a one-agent fleet. */
let executionMode = 'fleet'; // 'fleet' or 'workflow'
function setMode(mode){
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
  // Sync the topology dropdown so URL/state restores show the right option.
  const sel = document.getElementById('topology-select');
  if (sel && sel.value !== mode) sel.value = mode;
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
  const fcPct = cfg('s-fc-pct')/100;
  const fcIn = cfg('s-fc-in');
  const fcPriceIdx = Math.min(5, Math.max(0, cfg('s-fc-price')));
  const fcPrices = [0, 0.20, 0.80, 1.50, 3.00, 5.00];
  const fcPrice = fcPrices[fcPriceIdx] || 0;
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

  // 4. Fact-check sidecar: per stage with FC enabled, additional FC inference call
  let fcCost = 0;
  if(fcPct > 0 && fcIn > 0 && fcPrice > 0){
    const fcStages = stages * fcPct;
    fcCost = (fcStages * fcIn / 1e6) * fcPrice;
  }

  // 5. Template amortization: planning cost spread across runs
  // Rough estimate: orchestrator's first turn × 2 = workflow planning cost, divided by templateRuns
  const planningCost = baseResult.baseCost * 0.05; // assume ~5% of session is one-time planning
  const templateAmort = planningCost / templateRuns;
  const templateAmortDelta = -planningCost + templateAmort; // savings vs no amortization

  // 6. HITL pause storage cost
  // Avg session state ≈ totalIn tokens × 4 bytes/token (KV cache + state) ≈ totalIn × 4 / 1e9 GB
  const stateGB = (baseResult.totalIn * 4) / 1e9;
  const pauseStorageCost = stateGB * pauseHrs * pauses * storageRate;

  const extraCost = chainCost + docCost + rerunCost + fcCost + templateAmortDelta + pauseStorageCost;

  return {
    extraCost,
    breakdown: {
      sequentialChainCost: chainCost,
      documentIngestionCost: docCost,
      partialRerunCost: rerunCost,
      factCheckSidecarCost: fcCost,
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
  setVal('s-fc-pct', 100);          // every stage fact-checked in AKD
  setVal('s-fc-in', 3000);          // stage outputs are detailed
  setVal('s-fc-price', 1);          // Haiku-class fact checker
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
  alert('AKD Flow preset applied. 5-stage research workflow with hybrid DAG topology, bulk PDF ingestion, fact-check sidecar, parallel search agents, and HITL pause states.');
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
    hybrid: 'Hybrid DAG: sequential trunk with parallel sub-branches at certain stages. Realistic for AKD-style workflows where some stages depend on prior stages but others can run independently.'
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

// BOOT
buildAgents();buildUsers();renderAgents();renderTaskBars();renderModelSelector();
// Mark config as the initially-active tab without scrolling; all panels
// render stacked, so this is purely a state marker.
document.getElementById('tab-config')?.classList.add('active');
loadFromURL();
setTimeout(()=>{
  onSlider();
  renderRoutingSliders();
  // Eager init for renderers that used to fire on tab activation.
  if(typeof renderAudience==='function')renderAudience();
  if(typeof drawArch==='function')drawArch();
},100);
