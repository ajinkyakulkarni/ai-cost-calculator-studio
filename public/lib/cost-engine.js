// =====================================================================
// Cost Calculator Studio — parameterized cost engine
//
// Pure-JS implementation of the cost-modeling math, decoupled from any
// specific deployment. Consumes a workload specification (see
// schema/workload-v1.schema.json) and exposes the same compute
// functions the EIE calculator uses, with all data-layer values
// pulled from the workload spec.
//
// Designed to run both:
//   - In a browser, included via <script> in the studio or generated
//     calculator HTML.
//   - In Node, importable as a module for CLI generation pipelines.
//
// All numerical claims are reproducible from this engine plus a
// workload spec. The Python reference implementation in the
// nasa_cost_calculator/ project mirrors this math for cross-validation.
// =====================================================================

(function (root) {
  'use strict';

  // -------------------------------------------------------------------
  // Pricing data is sourced from lib/prices.js (single source of truth,
  // designed for periodic scraper updates). Browser: window.Prices is
  // already loaded via <script>. Node: require it.
  // -------------------------------------------------------------------
  let Prices = root && root.Prices;
  if (!Prices && typeof require !== 'undefined') {
    try { Prices = require('./prices.js'); } catch (_) { /* prices not available */ }
  }
  if (!Prices) {
    throw new Error('cost-engine.js requires prices.js to be loaded first');
  }

  // Build per-category default maps that the engine can use directly
  // (strips out metadata fields like source_url/last_verified, leaving
  // just the numeric fields the engine needs). `notes` is intentionally
  // dropped from the engine-facing projection because it's free-form
  // human prose (e.g., "rate unverified") that has no place in the
  // numeric computation; the UI/render path reads notes directly from
  // the raw rate-card JSON, so dropping it here doesn't lose information.
  function _stripPriceMeta(entry) {
    const out = {};
    for (const [k, v] of Object.entries(entry || {})) {
      if (k === 'source_url' || k === 'last_verified' || k === 'notes' || k === 'provider') {
        // keep provider for ratecards (used in UI), drop the rest
        if (k === 'provider') out[k] = v;
        continue;
      }
      out[k] = v;
    }
    return out;
  }
  function _projectCategory(cat, includeProvider) {
    const out = {};
    for (const [k, v] of Object.entries(Prices[cat] || {})) {
      if (typeof v !== 'object' || !v) continue;
      out[k] = _stripPriceMeta(v);
      if (!includeProvider) delete out[k].provider;
    }
    return out;
  }

  const DEFAULT_RATE_CARDS = _projectCategory('llm_models', true);
  const DEFAULT_GPU_CATALOG = _projectCategory('gpu_instances', false);
  const DEFAULT_COST_MODES = _projectCategory('self_host_cost_modes', false);

  const DEFAULT_TIER_MULTIPLIERS = (() => {
    const out = {};
    for (const [k, v] of Object.entries(Prices.tier_multipliers || {})) {
      out[k] = v.multiplier;
    }
    return out;
  })();

  const FEDRAMP_MULTIPLIERS = (() => {
    const out = {};
    for (const [k, v] of Object.entries(Prices.federal_multipliers?.fedramp || {})) {
      out[k] = v.multiplier;
    }
    return out;
  })();
  const MULTI_REGION_MULTIPLIERS = (() => {
    const out = {};
    for (const [k, v] of Object.entries(Prices.federal_multipliers?.multi_region || {})) {
      out[k] = v.multiplier;
    }
    return out;
  })();

  const DEFAULT_FEDERAL = {
    fedramp_tier: 'none',
    multi_region: 'single',
    ato_monthly: 0,                          // amortized ATO assessment cost
    egress_gb_per_query: 0.001,              // ~1 KB per query default
    egress_cost_per_gb: 0.09,                // AWS commercial egress
    audit_log_kb_per_query: 5,               // typical structured log entry
    audit_retention_years: 7,                // federal default
    audit_storage_per_gb_month: 0.004,       // S3 Glacier Deep Archive
    retrieval_infra_monthly: 0,              // vector DB hosting (Pinecone / pgvector / etc.)
    pii_redaction_per_million_tokens: 0,     // 0 = disabled; typical $20–$50
  };

  // -------------------------------------------------------------------
  // Workload normalization — fills in defaults so downstream code can
  // assume every field is present.
  // -------------------------------------------------------------------
  // -------------------------------------------------------------------
  // Phase 1 tools registry (foundation, not yet wired into cost math).
  //
  // The registry is a workload-level catalog of available tools — name,
  // provider, cost shape ($/call, $/session, or free), per-call rate,
  // and token overheads (schema in prompt + average result fed back to
  // context). Agents in Phase 3 will declare which tools they enable
  // and at what frequency; until then the registry is read-only data
  // that procurement reviewers can edit to document their tool stack.
  //
  // Cost shapes:
  //   per_call    — billed each invocation (web search, file search,
  //                 most MCP server calls)
  //   per_session — billed once per session (code interpreter
  //                 container, sandbox VMs)
  //   free        — self-hosted or vendor-bundled, $0 per call
  //
  // Default registry seeded from the simulator's TOOL_FEES.managed_openai
  // entry + a few common free placeholders. Producers can extend by
  // adding entries to workload.tools_registry; the normalizer merges
  // their entries over the defaults so user-defined tools always win.
  //
  // return_shape: 'freeform' | 'templated' — when 'templated', the
  // deployment routes the tool's return through a centralized response
  // layer so the LLM only sees a short status string. Effective result
  // tokens collapse to cap_tokens. When 'freeform', the full
  // result_tokens_avg flows back into context. Per-tool defaults reflect
  // realistic out-of-the-box behavior; cap_tokens reflects realistic
  // template payload sizes for that tool's typical response.
  const DEFAULT_TOOLS_REGISTRY = {
    'web_search': {
      label: 'Web Search',
      description: 'Provider-managed web search (OpenAI / Anthropic / Vertex grounding)',
      cost_shape: 'per_call',
      rate_usd: 0.010,          // \$10 per 1k calls (OpenAI Assistants API rate)
      schema_tokens: 120,
      result_tokens_avg: 800,
      return_shape: 'freeform',
      cap_tokens: 80,           // status + top-result url + snippet
      memoize: false,
      memoize_hit_rate: 0.0,    // typical when memoization disabled
      provider: 'managed',
      builtin: true,
    },
    'file_search': {
      label: 'File Search',
      description: 'Provider-managed vector retrieval over attached docs',
      cost_shape: 'per_call',
      rate_usd: 0.0025,         // \$2.50 per 1k calls
      schema_tokens: 80,
      result_tokens_avg: 1200,
      return_shape: 'freeform',
      cap_tokens: 60,           // file id + offset + brief excerpt
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'managed',
      builtin: true,
    },
    'container_session': {
      label: 'Code Interpreter / Container',
      description: 'Sandboxed code-execution session (1GB, 30-min default)',
      cost_shape: 'per_session',
      rate_usd: 0.03,           // \$0.03 per session
      schema_tokens: 200,
      result_tokens_avg: 400,
      return_shape: 'freeform',
      cap_tokens: 80,           // exit code + last few stdout lines
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'managed',
      builtin: true,
    },
    'wikipedia_retrieval': {
      label: 'Wikipedia Retrieval (free)',
      description: 'Self-hosted or free public Wikipedia lookup',
      cost_shape: 'free',
      rate_usd: 0,
      schema_tokens: 80,
      result_tokens_avg: 600,
      return_shape: 'freeform',
      cap_tokens: 50,           // page id + lede sentence
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'self-hosted',
      builtin: true,
    },
    'internal_db_query': {
      label: 'Internal DB Query (placeholder)',
      description: 'Example custom MCP server entry — replace with your real database tool',
      cost_shape: 'free',
      rate_usd: 0,
      schema_tokens: 150,
      result_tokens_avg: 500,
      return_shape: 'freeform',
      cap_tokens: 40,           // row count + id list
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'self-hosted',
      builtin: false,
    },
    // Image generation — first-class commercial-SaaS tool category.
    // Billed per image generated. The LLM sees back only a URL or
    // base64 thumbnail (~30 tok), so result_tokens_avg is small.
    // schema_tokens covers the parameters block (prompt + size + style).
    // Rates verified 2026-05 against published pricing pages:
    'image_gen_dalle3': {
      label: 'Image gen · DALL-E 3 (1024×1024 standard)',
      description: 'OpenAI DALL-E 3 standard quality, 1024×1024. $0.040/image (verified 2026-05).',
      cost_shape: 'per_call',
      rate_usd: 0.040,
      schema_tokens: 80,
      result_tokens_avg: 30,    // image URL + revised prompt
      return_shape: 'freeform',
      cap_tokens: 40,
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'managed',
      builtin: true,
    },
    'image_gen_dalle3_hd': {
      label: 'Image gen · DALL-E 3 HD (1024×1024)',
      description: 'OpenAI DALL-E 3 HD quality, 1024×1024. $0.080/image (2× standard for sharper detail).',
      cost_shape: 'per_call',
      rate_usd: 0.080,
      schema_tokens: 80,
      result_tokens_avg: 30,
      return_shape: 'freeform',
      cap_tokens: 40,
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'managed',
      builtin: true,
    },
    'image_gen_stable_diffusion': {
      label: 'Image gen · Stable Diffusion XL (Stability API)',
      description: 'Stability AI hosted SDXL via REST API. ~$0.040/image at the listed rate.',
      cost_shape: 'per_call',
      rate_usd: 0.040,
      schema_tokens: 80,
      result_tokens_avg: 30,
      return_shape: 'freeform',
      cap_tokens: 40,
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'managed',
      builtin: true,
    },
    'image_gen_bedrock_titan': {
      label: 'Image gen · AWS Bedrock Titan Image',
      description: 'Amazon Titan Image Generator G1 on Bedrock — cheapest commercial option at ~$0.008/image.',
      cost_shape: 'per_call',
      rate_usd: 0.008,
      schema_tokens: 80,
      result_tokens_avg: 30,
      return_shape: 'freeform',
      cap_tokens: 40,
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'bedrock',
      builtin: true,
    },
    'image_gen_self_hosted': {
      label: 'Image gen · Self-hosted SDXL (free per call)',
      description: 'Self-hosted Stable Diffusion XL on your own GPU — zero per-call cost, but flat infra in self-host section.',
      cost_shape: 'free',
      rate_usd: 0,
      schema_tokens: 80,
      result_tokens_avg: 30,
      return_shape: 'freeform',
      cap_tokens: 40,
      memoize: false,
      memoize_hit_rate: 0.0,
      provider: 'self-hosted',
      builtin: true,
    },
  };

  function normalizeWorkload(spec) {
    const w = JSON.parse(JSON.stringify(spec));  // deep copy
    w.rate_cards = Object.assign({}, DEFAULT_RATE_CARDS, w.rate_cards || {});
    w.tier_multipliers = Object.assign({}, DEFAULT_TIER_MULTIPLIERS, w.tier_multipliers || {});
    w.self_host = w.self_host || {};
    w.self_host.gpu_options = Object.assign({}, DEFAULT_GPU_CATALOG, w.self_host.gpu_options || {});
    w.self_host.diurnal_peak_factor = w.self_host.diurnal_peak_factor || 4;
    w.self_host.headroom = w.self_host.headroom || 1.5;
    w.self_host.min_replicas = w.self_host.min_replicas || 2;
    w.self_host.tokens_per_query_default = w.self_host.tokens_per_query_default || 2000;
    w.self_host.cost_modes = w.self_host.cost_modes || {};
    w.self_host.cost_modes.optimistic = Object.assign({}, DEFAULT_COST_MODES.optimistic, w.self_host.cost_modes.optimistic || {});
    w.self_host.cost_modes.realistic  = Object.assign({}, DEFAULT_COST_MODES.realistic,  w.self_host.cost_modes.realistic  || {});
    w.agents = Array.isArray(w.agents) ? w.agents : [];
    w.daily_cap = w.daily_cap || { enabled: true, amount_usd: 1500, burst_days: 7, burst_factor: 1.0 };
    w.rate_limit = w.rate_limit || { strategy: 'edge', monthly_cost: 15, bot_ceiling: 2.5 };
    w.infrastructure = w.infrastructure || {};
    w.federal = Object.assign({}, DEFAULT_FEDERAL, w.federal || {});
    // Backward compat: legacy deployment.fedrampTier mirrored into federal.fedramp_tier
    if (w.deployment && w.deployment.fedrampTier && (!w.federal.fedramp_tier || w.federal.fedramp_tier === 'none')) {
      w.federal.fedramp_tier = w.deployment.fedrampTier;
    }
    w.defaults = Object.assign({
      model: Object.keys(w.rate_cards)[0],
      tier: 'standard',
      mix: Object.keys(w.mix || {})[0],
      rate_limit: w.rate_limit.strategy || 'edge',
      hosting: 'api',
      cost_mode: 'optimistic',
    }, w.defaults || {});
    if (w.anchor_query && !w.anchor_query.session_baseline_turns) {
      w.anchor_query.session_baseline_turns = 6;
    }
    // Tools registry (Phase 1 — foundation). Built-in tool entries always
    // come from DEFAULT_TOOLS_REGISTRY; user-defined entries layer over
    // them so producers can add custom MCP tools or override built-in
    // rates (e.g. their enterprise web-search contract is cheaper than
    // the OpenAI list rate). Hash round-trip preserves user edits since
    // workload.tools_registry is captured in the share-URL payload.
    w.tools_registry = Object.assign({}, DEFAULT_TOOLS_REGISTRY, w.tools_registry || {});
    // Belt-and-suspenders: clamp the headline-driving numeric fields to >= 0.
    // 250+ <input type="number"> elements in the UI don't all carry min="0",
    // so a paste error or stale share-URL can produce a negative segment MAU
    // that silently lowers the aggregate queries instead of producing zero.
    // Clamping in the engine catches every entry point (URL hash, JSON
    // import, programmatic API) with one rule.
    const nonNegative = (obj, keys) => {
      if (!obj) return;
      for (const k of keys) {
        const v = Number(obj[k]);
        if (Number.isFinite(v) && v < 0) obj[k] = 0;
      }
    };
    nonNegative(w.anchor_query, ['input_tokens', 'output_tokens', 'session_baseline_turns']);
    for (const seg of (w.segments || [])) {
      nonNegative(seg, ['mau', 'sessions_per_day', 'questions_per_session']);
    }
    for (const agent of (w.agents || [])) {
      nonNegative(agent, ['input_tokens', 'output_tokens', 'calls_per_query']);
    }
    nonNegative(w.daily_cap, ['amount_usd', 'burst_days', 'burst_factor']);
    return w;
  }

  // -------------------------------------------------------------------
  // Multi-agent pipeline mode.
  //
  // When `workload.agents` is non-empty, per-query cost = sum over
  // agents of (calls_per_query × per-call token cost). Each agent has
  // its own input/output token sizes and may override the main model.
  // This bypasses the shape × mix machinery — agents express the
  // pipeline directly.
  //
  // Note: this path SUMS absolute costs across agents (no weight
  // normalization). The shape-mix path in perQueryCost below
  // *normalizes* by totalWeight, because mix weights are fractions
  // that must sum to 1 to give a single weighted-average per-query
  // cost. The asymmetry is intentional and reflects the two different
  // workload models (concurrent agents that all run vs. one query
  // sampled from a distribution of shapes).
  // -------------------------------------------------------------------
  // Itemized tool tokens for one agent's declared enabled_tools. Tool
  // schemas sit in the prompt on every call; tool results flow back into
  // context. return_shape — 'templated' clamps the result to cap_tokens,
  // 'freeform' passes the full result_tokens_avg — is resolved per
  // (agent,tool) override → per-tool registry default →
  // workload.tool_response_mode. Mirrors cost-simulator.js's per-tool
  // walk (the "(A) Per-tool walk" branch) so the headline and the
  // simulator agree. Returns a per-QUERY input-token total.
  function agentToolInputTokens(agent, workload) {
    const reg = (workload && workload.tools_registry) || {};
    const enabled = (agent && agent.enabled_tools) || {};
    const globalMode = (workload && workload.tool_response_mode) || 'freeform';
    let tokens = 0;
    for (const [tid, spec] of Object.entries(enabled)) {
      if (!spec || !(spec.calls_per_query > 0)) continue;
      const t = reg[tid];
      if (!t) continue;
      const callsNominal = spec.calls_per_query;
      const memo = t.memoize && Number.isFinite(t.memoize_hit_rate) ? t.memoize_hit_rate : 0;
      const trig = Number.isFinite(spec.trigger_rate) && spec.trigger_rate >= 0 && spec.trigger_rate <= 1
        ? spec.trigger_rate : 1.0;
      const callsEff = callsNominal * Math.max(0, 1 - memo) * trig;
      const schema = Number.isFinite(t.schema_tokens) ? t.schema_tokens : 0;
      const rawResult = Number.isFinite(t.result_tokens_avg) ? t.result_tokens_avg : 0;
      const shape = spec.return_shape_override || t.return_shape || globalMode;
      const cap = Number.isFinite(spec.cap_tokens_override) ? spec.cap_tokens_override
                : Number.isFinite(t.cap_tokens) ? t.cap_tokens : 40;
      const effResult = shape === 'templated' ? Math.min(rawResult, cap) : rawResult;
      // schema is seen on every nominal call; result tokens scale with
      // the memoization/trigger-adjusted effective call count.
      tokens += callsNominal * schema + callsEff * effResult;
    }
    return tokens;
  }

  // -------------------------------------------------------------------
  function perQueryCostAgents(workload, mainModelId, tierId, cacheRate, options) {
    const w = workload;
    const mult = w.tier_multipliers[tierId] || 1.0;
    let total = 0;
    const breakdown = [];
    for (const agent of (w.agents || [])) {
      const hosting = agent.hosting || 'api';  // 'api' | 'byok' | 'self-host'
      const calls = agent.calls_per_query != null ? agent.calls_per_query : 1;
      const inT = agent.input_tokens || 0;
      const outT = agent.output_tokens || 0;

      // BYOK: user pays the provider directly, this calc-bundle's API line is $0 for this agent.
      // Self-host: counted under the self-host pricing path, NOT the API line.
      // Both still appear in the breakdown for traceability.
      if (hosting === 'byok' || hosting === 'self-host') {
        breakdown.push({
          id: agent.id, label: agent.label || agent.id,
          hosting, model: agent.model || mainModelId,
          calls, input: inT, output: outT,
          per_call_cost: 0, per_query_cost: 0,
          note: hosting === 'byok'
            ? 'Excluded from API total — user provides their own key.'
            : 'Excluded from API total — costed in self-host section.',
        });
        continue;
      }

      // Default 'api' path — full per-token rate card.
      const modelId = agent.model || mainModelId;
      const rates = w.rate_cards[modelId];
      if (!rates) continue;
      // Per-agent sysprompt and inter-agent message overhead. These
      // were previously workload-wide sliders (s-sysprompt / s-iamsg)
      // applied uniformly across all agents — wrong by 5–10× for
      // orchestrator (3000-tok sysprompt) vs. worker (500-tok). When
      // set per-agent, sysprompt amortizes across calls_per_query
      // (cache-hot prefix), iamsg adds to every call (varies per turn).
      const sysAmortized = (agent.sysprompt_tokens || 0) / Math.max(1, calls);
      const iaPerCall = agent.iamsg_tokens || 0;
      const effInT = inT + sysAmortized + iaPerCall;
      const eff = agent.cache_eligible ? cacheRate : 0;
      const cached = effInT * eff;
      const uncached = effInT - cached;
      // Eq. 2 blend, per-agent (agent may override workload-wide write share).
      const agentWriteShare = agent.cache_write_share != null
        ? agent.cache_write_share
        : (options && options.cacheWriteShare != null ? options.cacheWriteShare : 0);
      const pCachedEff = effectiveCachedRate(rates, agentWriteShare);
      // Per-agent task-character multiplier. agent.task_bias='code' on a
      // Drafter agent multiplies its output tokens by ~2.4× (code is
      // 2.8× output vs. balanced-mix baseline ~1.16×); when task_bias
      // is unset, falls back to workload.task_mix so workload-mix
      // sliders move agent-mode bills the way the unit-cost path does.
      // See taskMixOutputMultiplierForAgent for the full precedence.
      const agentOutMult = taskMixOutputMultiplierForAgent(agent, w);
      const effOutT = outT * agentOutMult;
      const perCall = (
        uncached * rates.input_per_million / 1e6 +
        cached   * pCachedEff / 1e6 +
        effOutT  * rates.output_per_million / 1e6
      ) * mult;
      // ReAct / reflection multiplier — agents that internally loop
      // (think → act → observe → think) fire N LLM calls per logical
      // "call" the user sees. Defaults to 1.0 (one LLM call = one call
      // billed). Typical: simple chat 1.0×, ReAct 3–5×, deep
      // reflection 5–8×. Multiplies the per-call bill; sysprompt
      // amortization above used the OUTER `calls` so the cache
      // accounting stays correct (each inner loop iteration still hits
      // the same cached prefix).
      const loopMult = Number(agent.calls_per_turn_multiplier);
      const llmCallMult = Number.isFinite(loopMult) && loopMult > 0 ? loopMult : 1.0;
      // Agent activation rate — fraction of queries this agent runs on.
      // Default 1.0 (always runs). Use for conditional agents that only
      // trigger on certain query types (e.g. an Image-Enhancer agent
      // that only fires on the 30% of requests mentioning images).
      // Multiplies the monthly contribution so the bill reflects the
      // expected average across queries, not the worst case.
      const activationRate = Number(agent.activation_rate);
      const activeRate = Number.isFinite(activationRate) && activationRate >= 0 && activationRate <= 1
        ? activationRate : 1.0;
      const monthlyContrib = calls * perCall * llmCallMult * activeRate;
      // Itemized tool tokens (per query) — schema on every call + result
      // tokens modulated by return_shape. Billed once per query at the
      // agent's model rate + cache rate (not multiplied by calls or the
      // ReAct loop multiplier — enabled_tools.calls_per_query already
      // expresses the per-query tool-call total).
      const toolInT = agentToolInputTokens(agent, w);
      let toolCost = 0;
      if (toolInT > 0) {
        const toolCached = toolInT * eff;
        toolCost = ((toolInT - toolCached) * rates.input_per_million / 1e6
                    + toolCached * pCachedEff / 1e6) * mult * activeRate;
      }
      total += monthlyContrib + toolCost;
      breakdown.push({
        id: agent.id, label: agent.label || agent.id,
        hosting, model: modelId, calls, input: inT, output: outT,
        tool_input_tokens: toolInT, tool_cost: toolCost,
        per_call_cost: perCall, per_query_cost: monthlyContrib + toolCost,
      });
    }
    return { per_query: total, breakdown };
  }

  // -------------------------------------------------------------------
  // Per-query cost: weighted blend across the configured shape mix.
  // -------------------------------------------------------------------

  // Eq. 3 (eq:cache) per-turn cache-rate slope: cache hit rate moves ~1 pp
  // per turn around the baseline turn count. Empirical from the v0.1.0 pilot
  // (Table 2 of the paper) — a longer session amortizes the cached prefix
  // better; a shorter one pays a higher cold-prefix fraction. Producers
  // running on a different workload class should re-fit this from logged
  // traffic before relying on the curve.
  const CACHE_RATE_PER_TURN_ADJ = 0.01;
  // Bound only the session-length adjustment term so an extreme `q` can't
  // run away; the user-supplied baseline passes through unmodified and is
  // only constrained by the physical [0, 0.99] range. The paper's printed
  // Eq.3 applied the full [0.50, 0.94] clamp to r_eff — which, when the
  // calculator repurposed r_baseline as a free 0–95% slider, produced a
  // dead zone across the entire 0–~48% slider range, so the shipped
  // calculator restricts the clamp to the turn-adjustment term. Within the
  // paper's regime (fixed r_baseline ≈ 0.84) neither form binds, so the
  // numbers are identical; reproduce from tag v0.4.0 (see REPRODUCING.md).
  const TURN_ADJ_BOUND = 0.15;

  function effectiveCacheRate(baseline, questions_per_session, baseline_turns) {
    const rawAdj = (questions_per_session - baseline_turns) * CACHE_RATE_PER_TURN_ADJ;
    const turnAdj = Math.min(TURN_ADJ_BOUND, Math.max(-TURN_ADJ_BOUND, rawAdj));
    return Math.min(0.99, Math.max(0, baseline + turnAdj));
  }

  // Eq. 2 cache-blending helper. Given a model's rate card and an optional
  // workload-supplied cache-write share `w`, return the effective per-million
  // rate for cached input:
  //
  //   p_cached,eff = w · p_write + (1 - w) · p_read
  //
  // For OpenAI-style auto-prefix caching there is no separate write surcharge,
  // so p_write = p_in and w typically ≈ 0 in steady state — the blend collapses
  // to p_read (= 0.1 · p_in by default), matching legacy behavior. For Anthropic
  // the rate card sets cached_write_per_million = 1.25 · input_per_million and
  // w is set by how often the cache rotates.
  function effectiveCachedRate(rates, writeShare) {
    const pIn    = rates.input_per_million;
    const pRead  = rates.cached_per_million != null ? rates.cached_per_million : pIn * 0.1;
    const pWrite = rates.cached_write_per_million != null ? rates.cached_write_per_million : pIn;
    const w      = (writeShare != null && !isNaN(writeShare)) ? writeShare : 0;
    return w * pWrite + (1 - w) * pRead;
  }

  // Task-mix output multiplier. The simulator's "Workload mix — query
  // types" panel persists workload.task_mix as a percentage split across
  // {classify, summary, rag, code, longform, agent}. Each type has a
  // published per-type output multiplier; the weighted multiplier (wOM)
  // is divided by the baseline default-mix wOM so that calibrated
  // presets remain unchanged (multiplier = 1.0) until the user actively
  // rebalances. Workload-mode unit-cost paths read this and scale
  // anchor_query.output_tokens. Agent-mode bypasses it (agents specify
  // tokens directly).
  const TASK_MIX_OUT_MULT = {
    classify: 0.30, summary: 0.65, rag: 0.85,
    code: 2.80, longform: 3.60, agent: 4.30,
  };
  const TASK_MIX_DEFAULT_PCT = {
    classify: 20, summary: 25, rag: 20, code: 15, longform: 10, agent: 10,
  };
  const TASK_MIX_BASELINE_WOM = (function(){
    let t = 0, s = 0;
    for (const k in TASK_MIX_OUT_MULT) {
      const p = TASK_MIX_DEFAULT_PCT[k] || 0;
      t += p;
      s += p * TASK_MIX_OUT_MULT[k];
    }
    return t > 0 ? s / t : 1;
  })();
  function taskMixOutputMultiplier(w) {
    const tm = w && w.task_mix;
    if (!tm || typeof tm !== 'object') return 1.0;
    let total = 0, wom = 0;
    for (const k in TASK_MIX_OUT_MULT) {
      const pct = Number(tm[k]);
      if (!Number.isFinite(pct) || pct < 0) continue;
      total += pct;
      wom += pct * TASK_MIX_OUT_MULT[k];
    }
    if (total <= 0) return 1.0;
    return (wom / total) / TASK_MIX_BASELINE_WOM;
  }

  // Per-agent output multiplier. Three cases, evaluated in order:
  //   1. agent.task_bias set → 60/8/8/8/8/8 mix biased toward that type.
  //      Same synthetic mix the simulator uses, so the simulator's
  //      per-agent ledger and the public engine agree.
  //   2. agent.task_bias unset BUT workload has task_mix → use the
  //      workload-level mix as the per-agent default. Symmetric with
  //      the unit-cost path (which scales anchor_query.output_tokens by
  //      the same workload mix), so workload-mix sliders now move
  //      agent-mode bills as users would expect.
  //   3. Neither set → 1.0 (unchanged). Preserves the "per-agent
  //      output_tokens are specified directly" default for presets that
  //      pre-date the task_mix feature.
  function taskMixOutputMultiplierForAgent(agent, w) {
    const bias = agent && agent.task_bias;
    if (bias && Object.prototype.hasOwnProperty.call(TASK_MIX_OUT_MULT, bias)) {
      const mix = {};
      for (const k in TASK_MIX_OUT_MULT) mix[k] = (k === bias) ? 60 : 8;
      return taskMixOutputMultiplier({ task_mix: mix });
    }
    return taskMixOutputMultiplier(w);
  }

  function perQueryCost(workload, modelId, tierId, mixId, cacheRate, writeShare) {
    const w = workload;
    const rates = w.rate_cards[modelId];
    // Guard against stale model IDs (e.g. a saved URL share that references a
    // model the active price book has since dropped). Mirrors the
    // perQueryCostAgents pattern: degrade to zero rather than throwing inside
    // a slider tick. Callers that care can detect this by reading the
    // breakdown / total being zero with a known-good mix and shape config.
    if (!rates) return 0;
    const mult = w.tier_multipliers[tierId] || 1.0;
    const mix = w.mix[mixId];
    if (!mix || !mix.weights) return 0;
    const anchorIn = w.anchor_query.input_tokens;
    const anchorOut = w.anchor_query.output_tokens * taskMixOutputMultiplier(w);
    const pCachedEff = effectiveCachedRate(rates, writeShare);
    let total = 0;
    let totalWeight = 0;
    for (const [shapeName, weight] of Object.entries(mix.weights)) {
      const shape = w.shapes[shapeName];
      if (!shape) continue;
      const inT = anchorIn * shape.input_factor;
      const outT = anchorOut * shape.output_factor;
      const eff = shape.cache_eligible ? cacheRate : 0;
      const cached = inT * eff;
      const uncached = inT - cached;
      const shapeCost = (
        uncached * rates.input_per_million / 1e6 +
        cached   * pCachedEff / 1e6 +
        outT     * rates.output_per_million / 1e6
      ) * mult;
      total += weight * shapeCost;
      totalWeight += weight;
    }
    return totalWeight > 0 ? total / totalWeight : 0;
  }

  // -------------------------------------------------------------------
  // Monthly query volume (per segment, then aggregated).
  // -------------------------------------------------------------------
  function computeQueries(workload, options) {
    const w = workload;
    const opts = options || {};
    const botFactor = opts.botFactor !== undefined ? opts.botFactor : 1.5;
    const rl = w.rate_limit;
    const botCeiling = rl && rl.bot_ceiling ? rl.bot_ceiling : Infinity;
    const botEffective = Math.min(botFactor, botCeiling);
    const DAYS = 30;
    let auth = 0, anon = 0, total = 0;
    const bySegment = {};
    for (const seg of w.segments) {
      // Accept either camelCase `applyBotFactor` (legacy browser-side schema)
      // or snake_case `apply_bot_factor` (consistent with the rest of the
      // segment object). Either spelling works for a Python/Excel port.
      const segApplyBot = seg.applyBotFactor != null ? seg.applyBotFactor : seg.apply_bot_factor;
      const beta = segApplyBot ? botEffective : 1;
      const q = seg.mau * seg.sessions_per_day * DAYS * seg.questions_per_session * beta;
      bySegment[seg.id] = q;
      total += q;
      if (segApplyBot) anon += q;
      else auth += q;
    }
    return { total, bySegment, auth, anon, botEffective };
  }

  // -------------------------------------------------------------------
  // Hosting multiplier applied to LLM compute and GPU costs:
  //   FedRAMP tier (premium for GovCloud / authorized hosting)
  //   × multi-region / DR factor.
  // Returns 1.0 for commercial single-region deployments.
  // -------------------------------------------------------------------
  function hostingMultiplier(workload) {
    const f = (workload && workload.federal) || {};
    const fr = FEDRAMP_MULTIPLIERS[f.fedramp_tier || 'none'] || 1.0;
    const mr = MULTI_REGION_MULTIPLIERS[f.multi_region || 'single'] || 1.0;
    return fr * mr;
  }

  // -------------------------------------------------------------------
  // API monthly cost (gross, then capped if daily cap active).
  // -------------------------------------------------------------------
  function computeApiCost(workload, queries, options) {
    const w = workload;
    const opts = options || {};
    const modelId = opts.model || w.defaults.model;
    const tierId = opts.tier || w.defaults.tier;
    const mixId = opts.mix || w.defaults.mix;
    const cacheBase = opts.cacheRate !== undefined ? opts.cacheRate : w.anchor_query.cache_rate_baseline;
    // Eq. 2 cache-write share. Read order: explicit opts override → workload
    // default → model rate-card default → 0 (steady state). For OpenAI auto-
    // prefix caching this is typically near 0; for Anthropic explicit caching
    // it tracks how often the deployment rotates the cache (default 0.10 in
    // the published preset).
    const writeShare = opts.cacheWriteShare != null ? opts.cacheWriteShare
                     : (w.anchor_query?.cache_write_share != null ? w.anchor_query.cache_write_share
                     : (w.rate_cards?.[modelId]?.cache_write_share_default != null
                         ? w.rate_cards[modelId].cache_write_share_default
                         : 0));

    // Multi-agent mode? Use agent-sum instead of shape×mix when agents defined.
    const agentMode = Array.isArray(w.agents) && w.agents.length > 0;

    // Per-segment effective cache + per-query cost
    const segPerQuery = {};
    let totalCost = 0;
    let agentBreakdown = null;
    for (const seg of w.segments) {
      const eff = effectiveCacheRate(cacheBase, seg.questions_per_session, w.anchor_query.session_baseline_turns);
      let pq;
      if (agentMode) {
        const agentRes = perQueryCostAgents(w, modelId, tierId, eff, opts);
        pq = agentRes.per_query;
        // Save breakdown only once (agents don't differ per segment except by cache)
        if (!agentBreakdown) agentBreakdown = agentRes.breakdown;
      } else {
        pq = perQueryCost(w, modelId, tierId, mixId, eff, writeShare);
      }
      segPerQuery[seg.id] = { eff_cache: eff, per_query: pq };
      totalCost += queries.bySegment[seg.id] * pq;
    }
    const blended = queries.total > 0 ? totalCost / queries.total : 0;

    // Apply federal hosting multiplier (FedRAMP × multi-region) FIRST, so
    // the daily cap operates on real-dollar spend. Without this ordering,
    // a $100/day cap with a 1.30× FedRAMP premium would yield $130/day
    // actual spend — overshooting the user's intended budget by 30%.
    const hostMult = hostingMultiplier(w);
    const grossWithHost = totalCost * hostMult;

    // Daily-cap clamping + refusal accounting (paper §2.5, Eq. for the
    // equal-budget refusal-aware comparison). Steady-day and burst-day
    // spend are each clamped to the cap; the dollar shortfall vs. gross
    // demand converts to refused queries. Restored 2026-05-21 — this is
    // the paper's central model; a 2026-05-10 overhaul had stripped it
    // out, which left the API side unable to reproduce the paper's
    // capped rows / refusal %. When the cap binds, input sensitivity
    // surfaces in monthly_refused_queries rather than the (cap-pinned)
    // headline — that is the intended, honest behavior.
    const cap = w.daily_cap;
    let cappedWithHost = grossWithHost;
    let monthlyRefused = 0;
    if (cap && cap.enabled && cap.amount_usd > 0) {
      const dailyAvg = grossWithHost / 30;
      const burstDays = cap.burst_days || 0;
      const steadyDays = 30 - burstDays;
      const dailyBurst = dailyAvg * (cap.burst_factor || 1);
      const dailySteadyCapped = Math.min(dailyAvg, cap.amount_usd);
      const dailyBurstCapped = Math.min(dailyBurst, cap.amount_usd);
      cappedWithHost = steadyDays * dailySteadyCapped + burstDays * dailyBurstCapped;
      const refusedFraction = grossWithHost > 0
        ? Math.max(0, (grossWithHost - cappedWithHost) / grossWithHost) : 0;
      monthlyRefused = queries.total * refusedFraction;
    }
    const monthlyCapped = cappedWithHost / (hostMult || 1);  // pre-multiplier view

    // Language-token multiplier (paper §3.3 tooltip): EN=1.0, code=1.3,
    // Spanish/French ~1.1-1.2, CJK 1.8-2.2. Inflates input+output token
    // count proportionally — applied as a scalar on the LLM bill since
    // both input and output rates scale with token count. Default 1.0.
    const langMult = (opts.langMult != null && opts.langMult > 0) ? opts.langMult : 1.0;

    // Batch-tier share (paper §3.3 tier_multipliers): fraction of traffic
    // routed to the batch tier (50% discount). batchShare=0.30 with
    // batch_discount=0.5 → effective scalar = (1 - 0.30 * 0.5) = 0.85.
    // Default 0 → no batch routing → 1.0 scalar.
    const batchShare = Math.max(0, Math.min(1, opts.batchShare != null ? opts.batchShare : 0));
    const batchTierMult = (w.tier_multipliers && w.tier_multipliers.batch) || 0.5;
    const batchScalar = (1 - batchShare) + batchShare * batchTierMult;

    // Context compression: net % saving on the LLM bill from periodic
    // history summarization (Claude Code subagent pattern, LangChain
    // ConversationSummaryBufferMemory, Devin's "memory layer"). When set,
    // older turns are summarized into shorter representations, reducing
    // the input cost on subsequent turns. The knob is the NET saving
    // after subtracting summarization overhead (i.e., what a production
    // team would report: "compression cuts our input bill by 30% net").
    // Default 0 = no compression (legacy behavior, preserves paper math).
    const compressionSavings = Math.max(0, Math.min(0.7, opts.contextCompressionPct != null ? opts.contextCompressionPct : 0));
    const compressionScalar = 1 - compressionSavings;

    // Extra input tokens per query — document parsing, long-form context
    // injection, anything that adds to per-query input beyond the
    // anchor_query / per-agent input_tokens. Bridged from the simulator's
    // s-doc-* sliders (PDFs ingested × pages × tokens/page × % stages
    // reading). Cache-eligible: docs in the same session re-hit cache,
    // so we blend at the segment's effective cache rate.
    const extraInTokensPerQ = Math.max(0, Number(opts.extraInputTokensPerQuery) || 0);
    let extraInputCost = 0;
    if (extraInTokensPerQ > 0) {
      const rates = w.rate_cards[modelId];
      if (rates) {
        // Use the first segment's effective cache for blending (workload-wide
        // approximation — exact per-segment math would double-loop). Cache
        // savings still apply since docs are typically the same across turns.
        const firstSeg = w.segments[0] || { questions_per_session: 6 };
        const eff = effectiveCacheRate(cacheBase, firstSeg.questions_per_session, w.anchor_query.session_baseline_turns);
        const pCachedEff = effectiveCachedRate(rates, writeShare);
        const tokens = extraInTokensPerQ * queries.total;
        const uncached = tokens * (1 - eff);
        const cached = tokens * eff;
        // tierMult / hostMult: declared earlier in this function via
        // the per-query/agent paths above. Re-derive here so the doc
        // bill applies the same multipliers as the rest of the API
        // cost (Priority tier = 2.5× input rate, FedRAMP 1.30× etc.).
        const tierMult = w.tier_multipliers[tierId] || 1.0;
        extraInputCost = (uncached * rates.input_per_million / 1e6
                        + cached   * pCachedEff / 1e6) * tierMult * hostMult;
      }
    }

    const llmScalar = langMult * batchScalar * compressionScalar;
    const cappedScaled = (cappedWithHost + extraInputCost) * llmScalar;

    // Eq. 5 retry inflate: LLM_api · (1 + 1.5r). retry_rate is the fraction
    // of calls that fail rate-limit / transient and are retried; 1.5× accounts
    // for partial output before the failure. Accept either `retry_rate` (paper
    // form) or precomputed `retryInflate` for caller convenience. When neither
    // is supplied we default to 1.0 (no retry), preserving legacy behavior.
    const retryInflate = opts.retryInflate != null
      ? opts.retryInflate
      : (1 + 1.5 * (opts.retry_rate || 0));
    const monthlyWithRetry = cappedScaled * retryInflate;

    return {
      monthly_gross: grossWithHost,
      monthly_capped: cappedScaled,
      monthly_with_retry: monthlyWithRetry,
      retry_inflate: retryInflate,
      lang_mult: langMult,
      batch_share: batchShare,
      batch_scalar: batchScalar,
      monthly_gross_pre_federal: totalCost,
      monthly_capped_pre_federal: monthlyCapped * llmScalar,
      hosting_multiplier: hostMult,
      monthly_refused_queries: monthlyRefused,
      per_query_blended: blended * hostMult * llmScalar,
      per_segment: segPerQuery,
      agent_mode: agentMode,
      agent_breakdown: agentBreakdown,
    };
  }

  // -------------------------------------------------------------------
  // Self-host capacity and cost.
  // -------------------------------------------------------------------
  function computeSelfHost(workload, monthlyQueries, options) {
    const w = workload;
    const opts = options || {};
    const gpuId = opts.gpu || Object.keys(w.self_host.gpu_options)[0];
    const commitmentId = opts.commitment || 'ri-1y';
    const replicas = opts.replicas !== undefined ? opts.replicas : w.self_host.min_replicas;
    const tokensPerQBase = opts.tokensPerQ || w.self_host.tokens_per_query_default;
    // langMult and contextCompressionPct affect total tokens per query just
    // as they do on the API side: bigger tokens (Japanese, multilingual) need
    // proportionally more GPU work; history-summarization compression shrinks
    // input tokens and reduces GPU work. Both feed peak-TPS sizing → replica
    // count → GPU bill. Same scalars as the API path at app.js / cost-engine
    // line 823. Defaults: 1.0 lang × 1.0 (no compression) = 1.0 — no-op for
    // workloads that don't set these opts.
    const langMultSH = (opts.langMult != null && opts.langMult > 0) ? opts.langMult : 1.0;
    const compressionSavingsSH = Math.max(0, Math.min(0.7, opts.contextCompressionPct != null ? opts.contextCompressionPct : 0));
    const tokenScalarSH = langMultSH * (1 - compressionSavingsSH);
    const tokensPerQ = tokensPerQBase * tokenScalarSH;
    const costMode = opts.costMode || 'optimistic';

    const gpu = w.self_host.gpu_options[gpuId];
    const params = w.self_host.cost_modes[costMode];

    const disc = commitmentId === 'on-demand' ? 0
                : commitmentId === 'ri-1y'    ? params.discount_1yr
                : /* ri-3y */                   params.discount_3yr;
    const effTput = gpu.tput_tps * params.throughput_derate;
    const qpsAvg = monthlyQueries / (30 * 86400);
    // Diurnal peak factor — capacity sizing multiplier (peak/avg traffic).
    // Engine workload default is 4 (typical diurnal); explicit opts
    // override (from the simulator's s-peak slider) only applies when > 1
    // so the slider's lazy default 1× doesn't undercut the safer 4×.
    const userPeak = Number(opts.diurnalPeakFactor);
    const effectivePeak = (Number.isFinite(userPeak) && userPeak > 1)
      ? userPeak
      : w.self_host.diurnal_peak_factor;
    const peakTps = qpsAvg * tokensPerQ * effectivePeak * w.self_host.headroom;
    const neededByLoad = effTput > 0 ? Math.ceil(peakTps / effTput) : 0;
    const minFloor = Math.max(w.self_host.min_replicas, replicas);
    const instances = Math.max(neededByLoad, minFloor);
    const gpuHourlyEff = gpu.hourly * (1 - disc);
    const hostMult = hostingMultiplier(w);
    // Duty cycle / scale-to-zero — for bursty traffic (e.g., NOAA storm
    // explainer, batch workloads, business-hours-only). Default 1.0 =
    // GPUs always running. 0.25 = 6 hours/day, etc. HA floor still
    // applies to the running fraction (you still need replicas WHEN you
    // run, just not always).
    const dutyCycle = Math.max(0.05, Math.min(1.0, w.self_host.duty_cycle || 1.0));
    const effectiveHours = 730 * dutyCycle;

    // FedRAMP / multi-region multiplier applies to GPU + ops (federal hosting
    // overhead). FTE and one-time setup are not hosting-region dependent.
    const gpuMonthly = instances * gpuHourlyEff * effectiveHours * hostMult;
    const opsMonthlyEff = params.ops_monthly * hostMult;

    // K8s hidden FTE cost — self-managed Kubernetes adds an MLOps
    // overhead that Fargate/EKS abstracts away. Default $5,333/mo
    // (~0.4 FTE for cluster ops). Disable by setting compute_platform
    // = 'fargate' or 'eks' (default).
    const platform = w.self_host.compute_platform || 'fargate';
    const k8sHiddenCost = platform === 'k8s'
      ? (w.self_host.k8s_hidden_cost || 5333)
      : 0;

    const total = gpuMonthly + opsMonthlyEff + params.fte_monthly + params.setup_amortized + k8sHiddenCost;

    return {
      gpu_spec: gpu,
      cost_mode: costMode,
      compute_platform: platform,
      qps_avg: qpsAvg,
      tokens_per_query: tokensPerQ,
      tokens_per_query_base: tokensPerQBase,
      token_scalar: tokenScalarSH,
      peak_tps: peakTps,
      effective_tput: effTput,
      needed_by_load: neededByLoad,
      instances,
      gpu_monthly: gpuMonthly,
      ops_monthly: opsMonthlyEff,
      fte_monthly: params.fte_monthly,
      setup_amortized: params.setup_amortized,
      k8s_hidden_cost: k8sHiddenCost,
      hosting_multiplier: hostMult,
      duty_cycle: dutyCycle,
      effective_hours: effectiveHours,
      total,
      effective_per_query: monthlyQueries > 0 ? total / monthlyQueries : 0,
    };
  }

  // -------------------------------------------------------------------
  // Break-even — binary-search the monthly query volume at which the
  // self-host cost equals the API cost. Below break-even, API wins on
  // pure $; above, self-host wins (in the cost-mode you selected).
  //
  // This is the "should we even be considering self-host?" number that
  // procurement officers want as a single line. The original static
  // EIE calculator surfaced it; the new generic engine does too.
  //
  // Returns { break_even_queries, api_cost, self_host_cost, found }.
  // `found: false` means no crossover within [1K, 100M] — typically
  // means self-host is always cheaper or always more expensive in the
  // explored range, depending on assumptions.
  // -------------------------------------------------------------------
  function computeBreakEven(workload, options) {
    const opts = options || {};
    const lo = 1_000, hi = 100_000_000;

    // Cost functions at a given volume.
    //
    // ASYMMETRY (intentional, see note returned below): the API side
    // returns monthly_gross_pre_federal (token spend only, no FedRAMP /
    // multi-region mult, no verification, no personnel). The self-host
    // side returns computeSelfHost(...).total, which INCLUDES gpu +
    // ops_monthly + fte_monthly + setup_amortized + k8s_hidden_cost.
    // The break-even is therefore "API token spend = self-host run-rate
    // including fixed costs" — i.e., the volume above which switching
    // platform is cheaper at full run-rate. Earlier comments called
    // this "pure inference $", which was misleading.
    //
    // For API cost we need a `queries` object shape with bySegment for
    // every segment in workload.audience. Distribute the target total
    // proportionally to the workload's actual segment ratios so per-query
    // economics (cache rates by segment) match production.
    const segments = workload.segments || [];
    const baselineQueries = computeQueries(workload, opts);
    const baselineTotal = baselineQueries.total || 1;

    const apiAt = (q) => {
      const fakeQueries = { total: q, bySegment: {} };
      for (const seg of segments) {
        const segShare = (baselineQueries.bySegment?.[seg.id] || 0) / baselineTotal;
        fakeQueries.bySegment[seg.id] = q * segShare;
      }
      // Some downstream code reads queries.auth/anon for back-compat.
      if (baselineQueries.auth !== undefined) fakeQueries.auth = q * (baselineQueries.auth / baselineTotal);
      if (baselineQueries.anon !== undefined) fakeQueries.anon = q * (baselineQueries.anon / baselineTotal);
      try {
        const r = computeApiCost(workload, fakeQueries, opts);
        return r.monthly_gross_pre_federal || r.monthly_gross || 0;
      } catch (_) { return 0; }
    };
    const selfHostAt = (q) => {
      try {
        const r = computeSelfHost(workload, q, opts);
        return r.total || 0;
      } catch (_) { return 0; }
    };

    // Quick check of endpoints — if no crossover, return early.
    const apiLo  = apiAt(lo),  shLo  = selfHostAt(lo);
    const apiHi  = apiAt(hi),  shHi  = selfHostAt(hi);
    const cheaperAtLo = apiLo < shLo ? 'api' : 'self_host';
    const cheaperAtHi = apiHi < shHi ? 'api' : 'self_host';
    if (cheaperAtLo === cheaperAtHi) {
      return {
        found: false,
        break_even_queries: null,
        cheaper_in_range: cheaperAtLo,
        api_at_low: apiLo, self_host_at_low: shLo,
        api_at_high: apiHi, self_host_at_high: shHi,
      };
    }

    // Binary search.
    let l = lo, h = hi;
    for (let i = 0; i < 40 && (h - l) > 1000; i++) {
      const m = Math.floor((l + h) / 2);
      const a = apiAt(m), s = selfHostAt(m);
      if (a < s) l = m; else h = m;
    }
    const q = Math.round((l + h) / 2);
    return {
      found: true,
      break_even_queries: q,
      api_cost_at_break_even: Math.round(apiAt(q)),
      self_host_cost_at_break_even: Math.round(selfHostAt(q)),
      note: 'Above this monthly query volume, API token spend (pre-federal-multiplier) exceeds self-host full run-rate (GPU + ops + FTE + setup + k8s overhead). Both sides exclude verification, federal-additive line items, embedding, and personnel beyond what computeSelfHost already includes via cost-mode FTE/setup fields.',
    };
  }

  // -------------------------------------------------------------------
  // Verification (FactReasoner-style) overhead.
  //
  // Per *verified* query, the pipeline runs:
  //   1 atomizer call, atoms_per_response reviser calls,
  //   atoms × variant_nli_calls NLI calls,
  //   plus retrieval lookups when atoms cite external sources.
  // Coverage (0..1) is the fraction of production queries that are
  // sampled for verification.
  // -------------------------------------------------------------------
  // Total NLI calls per VERIFIED QUERY (i.e., already includes the
  // multiplication by atoms_per_response). Per Marinescu et al. (2025),
  // FactReasoner's FR1 and FR2 variants differ in MRF connectivity:
  //   fr1 = each atom connects only to its own retrieved contexts
  //         → fewer NLI scorer calls (atoms × per-atom-contexts)
  //   fr2 = each atom connects to all retrieved contexts (global)
  //         → more NLI scorer calls (atoms × total-contexts)
  //   fr3 = deeper variant — fictional placeholder for an exhaustive
  //         claim-graph traversal (not in the published paper); same
  //         per-query semantics
  // Values are per-query totals at default atom count; producers should
  // re-fit these from their own trace data. Earlier versions named this
  // variable nliCallsPerAtom and multiplied by atoms_per_response again,
  // overcharging by ~atoms× — the paper's per-query interpretation is
  // correct and the multiplication has been removed.
  const VARIANT_NLI_CALLS = { fr1: 24, fr2: 160, fr3: 350 };

  // Verifier-approach preset table. Three cost shapes:
  //   nliBased     — atomize + per-claim NLI + revise (FactReasoner,
  //                  MiniCheck, AlignScore). Reuses existing pipeline.
  //   selfCheck    — main LLM checks itself (RAGAS faithfulness,
  //                  Anthropic citations). Bills as an output-token
  //                  overhead % applied to main-model output cost.
  //   flatPerCheck — commercial fact-check API (Patronus, Galileo).
  //                  Flat $/check; bypasses atomizer/NLI/reviser.
  //
  // calibration: 'measured' (bench-validated, ±5%) |
  //              'estimated' (architecture-based, ±20%) |
  //              'vendor-listed' (published rate at time of write).
  // latency_sec: typical wall-clock per verified response. Drives the
  // 'inline' vs 'audit' UI hint — anything >5 sec is impractical to
  // block on per-turn; anything >30 sec MUST run as a sidecar/audit
  // sample. Used to render warning badges on the per-agent verify_mode
  // toggle (e.g. 'FR2 + inline' = 'will block users for ~90 sec/turn').
  const VERIFIER_PRESETS = {
    'fr1':                 { label: 'FactReasoner FR1 (lean)',                  calibration: 'measured',      shape: 'nliBased',     nliCallsPerQuery: 24,  latency_sec: 10,  latency_class: 'audit'  },
    'fr2':                 { label: 'FactReasoner FR2 (dense)',                 calibration: 'measured',      shape: 'nliBased',     nliCallsPerQuery: 160, latency_sec: 60,  latency_class: 'audit'  },
    'fr3':                 { label: 'FactReasoner FR3 (exhaustive)',            calibration: 'estimated',     shape: 'nliBased',     nliCallsPerQuery: 350, latency_sec: 120, latency_class: 'batch'  },
    'minicheck':           { label: 'MiniCheck (CMU 2024) — single-call NLI',   calibration: 'estimated',     shape: 'nliBased',     nliCallsPerQuery: 1,   latency_sec: 1,   latency_class: 'inline', skipAtomizer: true, skipReviser: true },
    'factscore':           { label: 'FactScore (Min et al., UW 2023)',          calibration: 'estimated',     shape: 'nliBased',     nliCallsPerQuery: 0,   latency_sec: 20,  latency_class: 'audit',  llmPerAtomTokens: { input: 800, output: 60 } },
    'ragas-faithfulness':  { label: 'RAGAS faithfulness — LLM self-check',      calibration: 'estimated',     shape: 'selfCheck',    outputOverheadPct: 0.30, latency_sec: 4,  latency_class: 'inline' },
    'anthropic-citations': { label: 'Anthropic Claude citations (inline)',      calibration: 'estimated',     shape: 'selfCheck',    outputOverheadPct: 0.10, latency_sec: 0,  latency_class: 'inline' },
    'patronus':            { label: 'Patronus AI (commercial)',                 calibration: 'vendor-listed', shape: 'flatPerCheck', perCheckUsd: 0.010,    latency_sec: 2,   latency_class: 'inline' },
    'galileo':             { label: 'Galileo Luna (commercial)',                calibration: 'vendor-listed', shape: 'flatPerCheck', perCheckUsd: 0.015,    latency_sec: 2,   latency_class: 'inline' },
    'custom':              { label: 'Custom (sliders below)',                   calibration: 'user-defined',  shape: 'nliBased',                            latency_sec: 5,   latency_class: 'inline' },
  };

  // Guard-model preset table. Same dual-purpose pattern as the verifier
  // table — surface real options to procurement reviewers AND give the
  // engine a clean per-agent fee lookup so mixed fleets (one agent on
  // Llama Guard, another on OpenAI Moderation, another on Bedrock
  // Guardrails) bill correctly. Three cost shapes:
  //
  //   perMillionTokens — open-source / self-host classifiers billed by
  //                      input + output tokens (Llama Guard, Granite
  //                      Guardian, etc.). Rate × monthly guard tokens.
  //   perCheck         — managed-service / commercial guardrails billed
  //                      flat $/check (AWS Bedrock Guardrails, Azure
  //                      Content Safety, Patronus Lynx, Lakera Guard).
  //                      Counted as ~3 checks per query (input + output
  //                      + optional PII), configurable via checksPerQuery.
  //   free             — bundled with the main model (Anthropic Claude's
  //                      built-in safety, Google Vertex AI Safety Filters
  //                      bundled with generation, OpenAI Moderation free
  //                      tier). Zero per-call cost.
  const GUARD_MODEL_PRESETS = {
    'llama-guard-3':         { label: 'Meta Llama Guard 3 (8B, self-host)',     shape: 'perMillionTokens', ratePerMillion: 0.10 },
    'llama-guard-3-managed': { label: 'Meta Llama Guard 3 (Together API)',      shape: 'perMillionTokens', ratePerMillion: 0.20 },
    'granite-guardian':      { label: 'IBM Granite Guardian 3.2 (8B, self-host)', shape: 'perMillionTokens', ratePerMillion: 0.10 },
    'openai-moderation':     { label: 'OpenAI Moderation API (free)',           shape: 'free' },
    'bedrock-guardrails':    { label: 'AWS Bedrock Guardrails',                 shape: 'perCheck', perCheckUsd: 0.00075, checksPerQuery: 3 },
    'azure-content-safety':  { label: 'Azure AI Content Safety',                shape: 'perCheck', perCheckUsd: 0.001,   checksPerQuery: 3 },
    'vertex-safety':         { label: 'Google Vertex AI Safety (bundled, free)', shape: 'free' },
    'patronus-lynx':         { label: 'Patronus Lynx (commercial)',             shape: 'perCheck', perCheckUsd: 0.005,   checksPerQuery: 1 },
    'lakera-guard':          { label: 'Lakera Guard (commercial)',              shape: 'perCheck', perCheckUsd: 0.010,   checksPerQuery: 1 },
    'anthropic-builtin':     { label: 'Anthropic Claude built-in (free)',       shape: 'free' },
    'custom':                { label: 'Custom — use $/1M slider',               shape: 'perMillionTokens', ratePerMillion: null /* defer to s-guard-model */ },
  };
  // Flat monthly $ for hosting modes that price by capacity rather than
  // per-token. EC2 entries are on-demand AWS GPU pricing (24/7 × 730h).
  // Bedrock provisioned throughput buys a "model unit" reservation at
  // ~$15/hr → ~$11K/mo for one unit; Azure PTU (Provisioned Throughput
  // Unit) is roughly the same shape. Both are appropriate for steady
  // high-volume verification where flat-rate beats per-token; use the
  // crossover hint near the dropdown to pick.
  const NLI_HOSTING_FLAT = {
    'ec2-g6':              588,    // g6.xlarge on-demand × 730h
    'ec2-g5':              735,    // g5.xlarge on-demand × 730h
    'bedrock-provisioned': 10950,  // 1 model unit × $15/hr × 730h
    'azure-ptu':           10000,  // 1 PTU × ~$13.70/hr × 730h
  };
  // Sustained NLI calls/sec per unit at typical input shapes (~1.2K-token
  // premise + atom hypothesis). Used to scale flat-rate hosting by the
  // verifier variant: fr1's 24 calls/q fits in fewer units than fr2's 160,
  // so picking fr2 forces additional units once peak NLI throughput
  // exceeds one unit's capacity. Without this, switching variants on a
  // flat-rate hosting option would not change cost at all — the procurement
  // reviewer would see fr1 ≡ fr2 ≡ fr3 in the headline.
  // Per-unit values are conservative batched-inference estimates for a
  // small NLI classifier (BERT-large class):
  //   ec2-g6 (1×L4 24GB):  ~80 calls/sec
  //   ec2-g5 (1×A10 24GB): ~120 calls/sec
  //   Bedrock / PTU: 1 model-unit ≈ 250 calls/sec for small models
  const NLI_HOSTING_FLAT_THROUGHPUT = {
    'ec2-g6':              80,
    'ec2-g5':              120,
    'bedrock-provisioned': 250,
    'azure-ptu':           250,
  };
  // Compute how many flat-rate units (GPUs / model units / PTUs) are
  // required to sustain the peak NLI throughput for a given
  // verifiedCount × nliCallsPerQuery. Uses the same diurnal × headroom
  // scaling as the LLM self-host sizing (see computeSelfHost). Returns
  // a minimum of 1 (you can't rent half a GPU).
  function _nliFlatUnitsRequired(verifiedCount, nliCallsPerQuery, nliHosting, workload) {
    const throughputPerUnit = NLI_HOSTING_FLAT_THROUGHPUT[nliHosting] || 100;
    const diurnal = (workload && workload.self_host && workload.self_host.diurnal_peak_factor) || 4;
    const headroom = (workload && workload.self_host && workload.self_host.headroom) || 1.5;
    const meanCallsPerSec = (verifiedCount * nliCallsPerQuery) / (30 * 86400);
    const peakCallsPerSec = meanCallsPerSec * diurnal * headroom;
    return Math.max(1, Math.ceil(peakCallsPerSec / throughputPerUnit));
  }
  // Per-token-priced hosting modes. Multiplier applied to the resolved
  // per-token cost from the rate card. Bedrock on-demand and Azure
  // OpenAI typically bill at parity with the source provider's direct
  // API for the same model — kept as 1.0× until we observe drift.
  const NLI_HOSTING_TOKEN_MULT = {
    'api':              1.0,
    'bedrock-ondemand': 1.0,
    'azure-openai':     1.0,
  };

  // Per-preset cost-for-N-verified helper. Returns { monthly, breakdown }
  // for a single preset and a given verified-query count. Used twice:
  // (a) workload-wide path with verifiedQueries = monthlyQueries × coverage,
  // (b) per-agent path with verifiedQueries = agent_outputs × agent_coverage.
  // Caller adds servicePod (charged once, not per-agent) on top.
  function _verifCostForPreset(preset, verifiedCount, workload, opts, atoms) {
    const w = workload;
    const v = w.verification || {};
    const modelId = opts.verifModel || opts.model || w.defaults.model;
    const tierId = opts.tier || w.defaults.tier;
    const rates = w.rate_cards[modelId];
    const mult = w.tier_multipliers[tierId] || 1.0;
    if (preset.shape === 'selfCheck') {
      const anchorOut = (w.anchor_query && w.anchor_query.output_tokens) || 0;
      const overheadTokens = anchorOut * (preset.outputOverheadPct || 0);
      const overheadCostPerQuery = (rates ? overheadTokens * rates.output_per_million / 1e6 : 0) * mult;
      const monthly = verifiedCount * overheadCostPerQuery;
      return { monthly, breakdown: { self_check_output_overhead: monthly } };
    }
    if (preset.shape === 'flatPerCheck') {
      const monthly = verifiedCount * (preset.perCheckUsd || 0);
      return { monthly, breakdown: { commercial_flat: monthly } };
    }
    // nliBased
    const nliCallsPerQuery =
      (v.atoms_per_response_nli_calls && v.atoms_per_response_nli_calls[preset.__variantKey])
      || preset.nliCallsPerQuery || VARIANT_NLI_CALLS[preset.__variantKey] || 24;
    const tokenCost = (tokens) =>
      ((tokens.input || 0) * rates.input_per_million / 1e6 +
       (tokens.output || 0) * rates.output_per_million / 1e6) * mult;
    const atomizerPerQuery = preset.skipAtomizer ? 0 : tokenCost(v.atomizer_tokens || { input: 1500, output: 400 });
    const reviserPerQuery  = preset.skipReviser  ? 0 : atoms * tokenCost(v.reviser_tokens || { input: 500, output: 30 });
    const factscoreLlmPerQuery = preset.llmPerAtomTokens ? atoms * tokenCost(preset.llmPerAtomTokens) : 0;
    const nliHosting = opts.nliHosting || v.nli_hosting || 'api';
    let nliMonthly;
    let nliFlatUnits = null;
    if (NLI_HOSTING_TOKEN_MULT[nliHosting] != null) {
      const nliPerCall = tokenCost(v.nli_tokens || { input: 1200, output: 20 });
      nliMonthly = verifiedCount * nliCallsPerQuery * nliPerCall * NLI_HOSTING_TOKEN_MULT[nliHosting];
    } else if (NLI_HOSTING_FLAT[nliHosting] != null) {
      nliFlatUnits = _nliFlatUnitsRequired(verifiedCount, nliCallsPerQuery, nliHosting, w);
      nliMonthly = nliFlatUnits * NLI_HOSTING_FLAT[nliHosting];
    } else {
      nliMonthly = 0;
    }
    const retrieval = opts.retrieval || v.retrieval || 'wikipedia';
    const retrievalMonthly = retrieval === 'serper' ? verifiedCount * atoms * (5 / 1000) : 0;
    const atomizerMonthly = verifiedCount * atomizerPerQuery;
    const reviserMonthly = verifiedCount * reviserPerQuery;
    const factscoreLlmMonthly = verifiedCount * factscoreLlmPerQuery;
    const monthly = atomizerMonthly + reviserMonthly + nliMonthly + factscoreLlmMonthly + retrievalMonthly;
    return {
      monthly,
      breakdown: {
        atomizer: atomizerMonthly,
        reviser: reviserMonthly,
        nli: nliMonthly,
        factscore_llm_per_atom: factscoreLlmMonthly,
        retrieval: retrievalMonthly,
      },
      nli_hosting: nliHosting,
      nli_calls_per_query: nliCallsPerQuery,
    };
  }

  // -------------------------------------------------------------------
  // External tool fees — per-call / per-session provider charges for the
  // tools each agent declares in enabled_tools (web search, file search,
  // sandboxed containers, custom MCP servers). cost_shape 'free' tools
  // and registry $0 entries contribute nothing. Agent-mode only:
  // workload-mode (no agents) declares no tools, so the paper preset and
  // every anchor-driven workload return $0. Relocated from app.js's
  // renderPreview so the engine — and therefore calc.js, the Excel
  // export, and the bench — all bill tools identically to the live UI.
  // -------------------------------------------------------------------
  function computeToolFees(workload, queries, options) {
    const w = workload;
    const reg = w.tools_registry || {};
    const agents = Array.isArray(w.agents) ? w.agents : [];
    if (agents.length === 0) return { monthly: 0, breakdown: [] };
    const qTotal = (queries && queries.total) || 0;
    const DAYS = 30;
    // Monthly sessions = Σ segment (mau × sessions/day × 30 × bot factor).
    // Bots open sessions too, so anonymous segments carry botEffective.
    let sessionsMonthly = 0;
    for (const seg of (w.segments || [])) {
      const segApplyBot = seg.applyBotFactor != null ? seg.applyBotFactor : seg.apply_bot_factor;
      const beta = segApplyBot ? ((queries && queries.botEffective) || 1) : 1;
      sessionsMonthly += (seg.mau || 0) * (seg.sessions_per_day || 0) * DAYS * beta;
    }
    let monthly = 0;
    const breakdown = [];
    for (const agent of agents) {
      const aRate = Number(agent.activation_rate);
      const agActive = Number.isFinite(aRate) && aRate >= 0 && aRate <= 1 ? aRate : 1.0;
      const enabled = agent.enabled_tools || {};
      for (const [tid, spec] of Object.entries(enabled)) {
        const t = reg[tid];
        // Bill any tool with rate_usd > 0. 'free' is a default LABEL
        // ("default rate is 0"), not a directive to skip billing — a
        // user editing rate_usd from 0 to e.g. 0.005 on a self-hosted
        // tool (matching their measured per-call infra cost) should
        // see the headline move immediately. cost_shape determines
        // per-call vs per-session aggregation; 'free' falls through
        // to per_call as the default aggregation rule.
        if (!t || !t.rate_usd) continue;
        const cpq = (spec && spec.calls_per_query) || 0;
        if (cpq <= 0) continue;
        const memo = t.memoize && Number.isFinite(t.memoize_hit_rate) ? t.memoize_hit_rate : 0;
        const callMult = Math.max(0, 1 - memo);
        const trig = Number.isFinite(spec.trigger_rate) && spec.trigger_rate >= 0 && spec.trigger_rate <= 1
          ? spec.trigger_rate : 1.0;
        let fee = 0;
        if (t.cost_shape === 'per_session') {
          fee = cpq * t.rate_usd * sessionsMonthly * callMult * trig * agActive;
        } else {
          // per_call or 'free' (default aggregation)
          fee = cpq * t.rate_usd * qTotal * callMult * trig * agActive;
        }
        if (fee > 0) {
          monthly += fee;
          breakdown.push({ agent: agent.id, tool: tid, cost_shape: t.cost_shape, monthly: fee });
        }
      }
    }
    return { monthly, breakdown };
  }

  function computeVerification(workload, monthlyQueries, options) {
    const w = workload;
    const v = w.verification;
    if (!v || !v.enabled) {
      return { enabled: false, monthly: 0, verified_queries: 0, breakdown: {} };
    }
    const opts = options || {};
    const coverage = opts.verifCoverage !== undefined ? opts.verifCoverage : (v.coverage || 0);
    const variant = opts.verifVariant || v.variant || 'fr1';
    const atoms = v.atoms_per_response || 8;
    const preset = Object.assign({ __variantKey: variant }, VERIFIER_PRESETS[variant] || VERIFIER_PRESETS.fr1);
    const servicePod = v.service_pod_monthly || 0;

    // -------------------------------------------------------------------
    // PER-AGENT verification: when any agent declares verify_enabled,
    // walk agents and sum their contributions instead of applying one
    // workload-wide coverage. Each agent can override the preset
    // (verifier_override) and the coverage (verify_coverage). Common
    // pattern: orchestrator + tool-executors skip verification (their
    // outputs aren't user-facing claims); reporter / synthesizer agents
    // get verify_enabled with coverage=1.0 for every final response.
    // -------------------------------------------------------------------
    const agents = Array.isArray(w.agents) ? w.agents : [];
    const perAgentMode = agents.some(a => a.verify_enabled);
    if (perAgentMode) {
      let total = 0;
      const breakdown = { service_pod: servicePod };
      const perAgentBreakdown = [];
      let totalVerified = 0;
      for (const a of agents) {
        if (!a.verify_enabled) continue;
        const agentPresetKey = a.verifier_override || variant;
        const agentPreset = Object.assign({ __variantKey: agentPresetKey }, VERIFIER_PRESETS[agentPresetKey] || preset);
        const agentCov = a.verify_coverage != null ? a.verify_coverage : coverage;
        const agentOutputs = monthlyQueries * (a.calls_per_query || 1);
        const verified = agentOutputs * agentCov;
        totalVerified += verified;
        if (verified <= 0) continue;
        const r = _verifCostForPreset(agentPreset, verified, w, opts, atoms);
        // CASCADING verification: primary verifier runs on every verified
        // output; if it flags (escalate_rate fraction), a SECONDARY
        // verifier runs on the flagged subset. Common production
        // pattern: MiniCheck inline → FR2 on flagged. Defaults:
        //   verify_escalate_to:   null    (no cascade)
        //   verify_escalate_rate: 0.10    (typical "escalate ~10% flagged"
        //                                  rate; overridden per-agent)
        let escalateMonthly = 0;
        let escalatePresetLabel = null;
        const escalateKey = a.verify_escalate_to || v.escalate_to;
        if (escalateKey && VERIFIER_PRESETS[escalateKey]) {
          const escalatePreset = Object.assign({ __variantKey: escalateKey }, VERIFIER_PRESETS[escalateKey]);
          const escalateRate = Math.max(0, Math.min(1,
            a.verify_escalate_rate != null ? a.verify_escalate_rate
            : (v.escalate_rate != null ? v.escalate_rate : 0.10)));
          const escalatedOutputs = verified * escalateRate;
          if (escalatedOutputs > 0) {
            const er = _verifCostForPreset(escalatePreset, escalatedOutputs, w, opts, atoms);
            escalateMonthly = er.monthly;
            escalatePresetLabel = escalatePreset.label;
          }
        }
        const agentMonthly = r.monthly + escalateMonthly;
        total += agentMonthly;
        perAgentBreakdown.push({
          id: a.id, label: a.label || a.id,
          verifier: agentPreset.label, latency_class: agentPreset.latency_class,
          coverage: agentCov, verified_outputs: verified,
          monthly: agentMonthly,
          primary_monthly: r.monthly,
          escalate_to: escalatePresetLabel,
          escalate_monthly: escalateMonthly,
        });
      }
      return {
        enabled: true, coverage, variant,
        per_agent_mode: true,
        verified_queries: totalVerified,
        monthly: total + servicePod,
        breakdown,
        per_agent_breakdown: perAgentBreakdown,
        preset: { label: preset.label, calibration: preset.calibration, shape: preset.shape, latency_sec: preset.latency_sec, latency_class: preset.latency_class },
      };
    }

    // -------------------------------------------------------------------
    // WORKLOAD-WIDE verification: original path. coverage × monthlyQueries
    // sets verified count; one preset applies to the whole bill.
    // -------------------------------------------------------------------
    if (coverage <= 0) {
      return { enabled: true, coverage: 0, monthly: 0, verified_queries: 0, breakdown: {}, variant, nli_hosting: v.nli_hosting };
    }
    const verifiedQueries = monthlyQueries * coverage;

    // WORKLOAD-WIDE cascading verification: if v.escalate_to is set, a
    // secondary verifier runs on the escalate_rate fraction of outputs
    // that the primary flagged. Common production pattern: cheap inline
    // gate (MiniCheck) + audit cascade to FR2 on the 10% it can't
    // confidently approve. Computed once below and added to the
    // workload-wide return below.
    let _cascadeMonthly = 0;
    let _cascadePresetLabel = null;
    let _cascadeRate = 0;
    if (v.escalate_to && VERIFIER_PRESETS[v.escalate_to]) {
      const escalatePreset = Object.assign({ __variantKey: v.escalate_to }, VERIFIER_PRESETS[v.escalate_to]);
      _cascadeRate = Math.max(0, Math.min(1, v.escalate_rate != null ? v.escalate_rate : 0.10));
      const escalatedCount = verifiedQueries * _cascadeRate;
      if (escalatedCount > 0) {
        const er = _verifCostForPreset(escalatePreset, escalatedCount, w, opts, atoms);
        _cascadeMonthly = er.monthly;
        _cascadePresetLabel = escalatePreset.label;
      }
    }

    // SELF-CHECK shape (RAGAS faithfulness, Anthropic citations): no
    // separate verifier model. Bills as output-token overhead on the
    // verified queries' main-model output. Short-circuit early; engine
    // returns just this overhead in the breakdown.
    if (preset.shape === 'selfCheck') {
      const rates = w.rate_cards[opts.verifModel || opts.model || w.defaults.model];
      const mult = w.tier_multipliers[opts.tier || w.defaults.tier] || 1.0;
      const anchorOut = (w.anchor_query && w.anchor_query.output_tokens) || 0;
      const overheadTokens = anchorOut * (preset.outputOverheadPct || 0);
      const overheadCostPerQuery = (rates ? overheadTokens * rates.output_per_million / 1e6 : 0) * mult;
      const overheadMonthly = verifiedQueries * overheadCostPerQuery;
      return {
        enabled: true, coverage, variant, verified_queries: verifiedQueries,
        monthly: overheadMonthly + _cascadeMonthly,
        breakdown: { self_check_output_overhead: overheadMonthly, cascade_escalation: _cascadeMonthly },
        preset: { label: preset.label, calibration: preset.calibration, shape: preset.shape },
        cascade: _cascadePresetLabel ? { escalate_to: _cascadePresetLabel, escalate_rate: _cascadeRate, monthly: _cascadeMonthly } : null,
        nli_hosting: 'none',
        nli_calls_per_query: 0,
      };
    }

    // FLAT-PER-CHECK shape (Patronus, Galileo): vendor charges a flat
    // $/check regardless of token count. Bypasses atomizer/NLI/reviser
    // entirely; users still pay the service-pod $ if set.
    if (preset.shape === 'flatPerCheck') {
      const flatMonthly = verifiedQueries * (preset.perCheckUsd || 0);
      const servicePodFlat = v.service_pod_monthly || 0;
      return {
        enabled: true, coverage, variant, verified_queries: verifiedQueries,
        monthly: flatMonthly + servicePodFlat + _cascadeMonthly,
        breakdown: { commercial_flat: flatMonthly, service_pod: servicePodFlat, cascade_escalation: _cascadeMonthly },
        preset: { label: preset.label, calibration: preset.calibration, shape: preset.shape, perCheckUsd: preset.perCheckUsd },
        cascade: _cascadePresetLabel ? { escalate_to: _cascadePresetLabel, escalate_rate: _cascadeRate, monthly: _cascadeMonthly } : null,
        nli_hosting: 'vendor',
        nli_calls_per_query: 0,
      };
    }

    // NLI-BASED shape (FactReasoner variants, MiniCheck, FactScore).
    // Per-query total. Reads from workload override if present, else
    // from the preset table, else legacy VARIANT_NLI_CALLS.
    const nliCallsPerQuery =
      (v.atoms_per_response_nli_calls && v.atoms_per_response_nli_calls[variant])
      || preset.nliCallsPerQuery
      || VARIANT_NLI_CALLS[variant]
      || 24;

    const modelId = opts.verifModel || opts.model || w.defaults.model;
    const tierId = opts.tier || w.defaults.tier;
    const rates = w.rate_cards[modelId];
    const mult = w.tier_multipliers[tierId] || 1.0;

    // Helper: token cost on a per-call basis (no caching for these short calls).
    const tokenCost = (tokens) =>
      ((tokens.input || 0) * rates.input_per_million / 1e6 +
       (tokens.output || 0) * rates.output_per_million / 1e6) * mult;

    // MiniCheck has no Atomizer / Reviser — single short NLI call replaces
    // the whole pipeline. FactScore replaces NLI with a per-atom LLM call
    // (atomize → LLM verifies each atom → revise; no separate NLI model).
    const atomizerPerQuery = preset.skipAtomizer ? 0 : tokenCost(v.atomizer_tokens || { input: 1500, output: 400 });
    const reviserPerQuery  = preset.skipReviser  ? 0 : atoms * tokenCost(v.reviser_tokens || { input: 500, output: 30 });
    const factscoreLlmPerQuery = preset.llmPerAtomTokens ? atoms * tokenCost(preset.llmPerAtomTokens) : 0;
    const nliHosting = opts.nliHosting || v.nli_hosting || 'api';
    let nliMonthly;
    if (NLI_HOSTING_TOKEN_MULT[nliHosting] != null) {
      // Per-token hosting (direct API / Bedrock on-demand / Azure OpenAI).
      // nliCallsPerQuery is the per-query total, NOT per-atom — do not
      // multiply by `atoms` again. See VARIANT_NLI_CALLS comment.
      const nliPerCall = tokenCost(v.nli_tokens || { input: 1200, output: 20 });
      nliMonthly = verifiedQueries * nliCallsPerQuery * nliPerCall * NLI_HOSTING_TOKEN_MULT[nliHosting];
    } else if (NLI_HOSTING_FLAT[nliHosting] != null) {
      // Flat-rate hosting (EC2 / Bedrock provisioned / Azure PTU). Scale by
      // the units required to sustain peak NLI throughput so the variant
      // actually affects cost once volume exceeds one unit's capacity.
      const units = _nliFlatUnitsRequired(verifiedQueries, nliCallsPerQuery, nliHosting, w);
      nliMonthly = units * NLI_HOSTING_FLAT[nliHosting];
    } else {
      nliMonthly = 0;
    }

    // Retrieval: wikipedia is free; serper is ~$5 per 1000 calls (atoms).
    const retrieval = opts.retrieval || v.retrieval || 'wikipedia';
    const retrievalMonthly = retrieval === 'serper'
      ? verifiedQueries * atoms * (5 / 1000)
      : 0;

    const atomizerMonthly = verifiedQueries * atomizerPerQuery;
    const reviserMonthly = verifiedQueries * reviserPerQuery;
    const factscoreLlmMonthly = verifiedQueries * factscoreLlmPerQuery;
    // servicePod was declared at the top of computeVerification (shared
    // with the per-agent branch above); re-use the outer binding here.
    const monthly = atomizerMonthly + reviserMonthly + nliMonthly + factscoreLlmMonthly + retrievalMonthly + servicePod + _cascadeMonthly;

    return {
      enabled: true,
      coverage,
      variant,
      verified_queries: verifiedQueries,
      monthly,
      breakdown: {
        atomizer: atomizerMonthly,
        reviser: reviserMonthly,
        nli: nliMonthly,
        factscore_llm_per_atom: factscoreLlmMonthly,
        retrieval: retrievalMonthly,
        service_pod: servicePod,
        cascade_escalation: _cascadeMonthly,
      },
      preset: { label: preset.label, calibration: preset.calibration, shape: preset.shape },
      cascade: _cascadePresetLabel ? { escalate_to: _cascadePresetLabel, escalate_rate: _cascadeRate, monthly: _cascadeMonthly } : null,
      nli_hosting: nliHosting,
      nli_calls_per_query: nliCallsPerQuery,
    };
  }

  // -------------------------------------------------------------------
  // Self-host capped to same monthly budget as the API daily cap.
  //
  // SEMANTIC NOTE: computeApiCost no longer enforces the daily cap as a
  // hard refusal (see L390-395) — real cloud LLMs bill usage rather
  // than refusing queries at a $-cap. This function intentionally still
  // applies the cap on the self-host side because it answers a
  // DIFFERENT question: "what's the maximum self-host capacity I can
  // procure at the same monthly budget as the API daily cap × 30?"
  // That's a budget-solver / equal-budget-comparison scenario, not a
  // canonical run-rate cost. The returned object includes
  // `scenario: 'equal-budget'` so downstream callers can distinguish
  // this from a normal self-host cost result.
  // -------------------------------------------------------------------
  function computeSelfHostCapped(workload, monthlyQueries, peerSelfHost, options) {
    const w = workload;
    const opts = options || {};
    if (!w.daily_cap || !w.daily_cap.enabled) return null;
    const monthlyBudget = (w.daily_cap.amount_usd || 0) * 30;
    if (monthlyBudget <= 0) return null;

    const costMode = opts.costMode || 'optimistic';
    const gpuId = opts.gpu || Object.keys(w.self_host.gpu_options)[0];
    const commitmentId = opts.commitment || 'ri-1y';
    const params = w.self_host.cost_modes[costMode];
    const gpu = w.self_host.gpu_options[gpuId];

    const disc = commitmentId === 'on-demand' ? 0
                : commitmentId === 'ri-1y'    ? params.discount_1yr
                : params.discount_3yr;
    const hostMult = hostingMultiplier(w);
    const fixed = params.ops_monthly * hostMult + params.fte_monthly + params.setup_amortized;
    const gpuHourlyEff = gpu.hourly * (1 - disc) * hostMult;
    // Match computeSelfHost's duty-cycle treatment: when duty_cycle < 1 the
    // GPU is billed for fewer hours per month. Previously this branch used
    // a hard-coded 730 hr/month, which made the capped variant overcount
    // GPU spend (and so underestimate the number of instances affordable
    // under the same daily cap) whenever the workload had duty_cycle < 1.
    const dutyCycle = Math.max(0.05, Math.min(1.0, w.self_host.duty_cycle || 1.0));
    const effectiveHours = 730 * dutyCycle;
    const budgetForGpu = Math.max(0, monthlyBudget - fixed);
    const instancesAffordable = Math.floor(budgetForGpu / (gpuHourlyEff * effectiveHours));
    const instances = Math.max(0, Math.min(instancesAffordable, peerSelfHost.instances));
    const gpuMonthly = instances * gpuHourlyEff * effectiveHours;
    const total = gpuMonthly + fixed;

    const capacity = instances * peerSelfHost.effective_tput;
    const fracServed = peerSelfHost.peak_tps > 0 ? Math.min(1, capacity / peerSelfHost.peak_tps) : 1;
    const served = monthlyQueries * fracServed;
    const refused = monthlyQueries - served;

    return {
      scenario: 'equal-budget',  // distinguishes from canonical self-host cost
      monthly_budget: monthlyBudget,
      instances,
      instances_affordable: instancesAffordable,
      gpu_monthly: gpuMonthly,
      total,
      fraction_served: fracServed,
      queries_served: served,
      queries_refused: refused,
      budget_binding: instancesAffordable < peerSelfHost.instances,
      note: 'Equal-budget projection only: shows how many queries a self-host fleet could serve at the same monthly $ as the API daily cap × 30. Not a run-rate cost (API side does not enforce the cap symmetrically). See computeApiCost L390-395.',
    };
  }

  // -------------------------------------------------------------------
  // Federal additive line items (additions on top of LLM cost).
  //   ATO amortization (fixed)
  //   Data egress ($/GB × GB-per-query × queries)
  //   Audit log retention (S3 archive × retention years)
  //   Retrieval infra (vector DB hosting)
  //   PII redaction (per million tokens scrubbed)
  // The hosting multiplier (FedRAMP × multi-region) is applied separately
  // inside computeApiCost / computeSelfHost — not double-counted here.
  // -------------------------------------------------------------------
  function computeFederal(workload, monthlyQueries, apiResult, options) {
    const f = workload.federal || {};
    const ato = f.ato_monthly || 0;
    const egressGB = (f.egress_gb_per_query || 0) * monthlyQueries;
    const egress = egressGB * (f.egress_cost_per_gb || 0);
    // Audit retention: KB/query × queries × 12 months × N years × $/GB-month / 1024^2
    const auditGBperMonth = (f.audit_log_kb_per_query || 0) * monthlyQueries / (1024 * 1024);
    const auditTotalGB = auditGBperMonth * 12 * (f.audit_retention_years || 0);
    // Steady-state monthly storage cost (full retained corpus × $/GB-month)
    const audit = auditTotalGB * (f.audit_storage_per_gb_month || 0);
    const retrieval = f.retrieval_infra_monthly || 0;
    // PII redaction: token count × rate. Approx 1 query ≈ input+output anchor tokens.
    let pii = 0;
    if (f.pii_redaction_per_million_tokens && workload.anchor_query) {
      const tokensPerQ = (workload.anchor_query.input_tokens || 0) + (workload.anchor_query.output_tokens || 0);
      pii = monthlyQueries * tokensPerQ * (f.pii_redaction_per_million_tokens || 0) / 1e6;
    }
    const additive = ato + egress + audit + retrieval + pii;
    return {
      hosting_multiplier: hostingMultiplier(workload),
      fedramp_tier: f.fedramp_tier || 'none',
      multi_region: f.multi_region || 'single',
      breakdown: {
        ato_monthly: ato,
        egress_monthly: egress,
        egress_gb_total: egressGB,
        audit_retention_monthly: audit,
        audit_total_gb: auditTotalGB,
        retrieval_infra_monthly: retrieval,
        pii_redaction_monthly: pii,
      },
      additive_total: additive,
      // Useful for the report: dollar premium added on top of LLM compute.
      hosting_premium_api: apiResult ? (apiResult.monthly_capped - apiResult.monthly_capped_pre_federal) : 0,
    };
  }

  // -------------------------------------------------------------------
  // Plain-text derivation trace — shows every formula and intermediate
  // value used to arrive at the final cost. Designed to be copy-pasted
  // into a third-party AI for cross-verification of the math.
  // -------------------------------------------------------------------
  function deriveTrace(workload, result, options) {
    const w = workload, r = result, opts = options || {};
    const $ = (n) => '$' + (n != null && isFinite(n) ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—');
    const $4 = (n) => '$' + (n != null && isFinite(n) ? Number(n).toFixed(4) : '—');
    const num = (n) => n != null && isFinite(n) ? Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—';
    const pct = (n) => (n * 100).toFixed(0) + '%';

    let out = '';
    out += '=== AI COST CALCULATOR · DERIVATION TRACE ===\n';
    out += `Generated: ${new Date().toISOString()}\n`;
    out += `Deployment: ${w.deployment ? (w.deployment.agency || '') + ' · ' + (w.deployment.name || '') : 'unspecified'}\n`;
    out += `Mode: ${opts.hosting === 'self' ? 'Self-host' : 'API'} · model=${opts.model || w.defaults?.model} · tier=${opts.tier || w.defaults?.tier} · mix=${opts.mix || w.defaults?.mix}\n\n`;

    // ── 1. Queries ──
    out += '──────────────────────────────────────────────────\n';
    out += '1) MONTHLY QUERY VOLUME\n';
    out += '──────────────────────────────────────────────────\n';
    out += 'Formula: MAU × sessions/day × 30 days × questions/session × bot_factor (if anonymous)\n';
    out += `Bot factor: requested ${opts.botFactor != null ? opts.botFactor.toFixed(1) + '×' : '—'}, clamped by rate_limit.bot_ceiling=${w.rate_limit?.bot_ceiling || '∞'} → effective ${(r.queries.botEffective || 1).toFixed(2)}×\n\n`;
    for (const seg of w.segments) {
      const q = r.queries.bySegment[seg.id];
      const segApplyBot = seg.applyBotFactor != null ? seg.applyBotFactor : seg.apply_bot_factor;
      const beta = segApplyBot ? r.queries.botEffective : 1;
      out += `  Segment "${seg.label || seg.id}" (${segApplyBot ? 'anonymous, bot-factored' : 'authenticated'}):\n`;
      out += `    ${num(seg.mau)} MAU × ${seg.sessions_per_day} sess/day × 30 × ${seg.questions_per_session} q/sess × ${beta.toFixed(2)}× = ${num(q)} queries/mo\n`;
    }
    out += `  TOTAL: ${num(r.queries.total)} queries/mo\n\n`;

    // ── 2. Effective cache per segment ──
    out += '──────────────────────────────────────────────────\n';
    out += '2) EFFECTIVE CACHE RATE PER SEGMENT\n';
    out += '──────────────────────────────────────────────────\n';
    out += `Formula: cache_baseline + (questions_per_session − session_baseline_turns) × 0.01, clamped to [0.50, 0.94]\n`;
    out += `Baseline: ${(opts.cacheRate != null ? opts.cacheRate : w.anchor_query.cache_rate_baseline)} at ${w.anchor_query.session_baseline_turns} turns\n\n`;
    for (const seg of w.segments) {
      const ec = (r.api.per_segment[seg.id] || {}).eff_cache || 0;
      out += `  ${seg.label || seg.id}: ${pct(ec)}\n`;
    }
    out += '\n';

    // ── 3. Per-query cost ──
    out += '──────────────────────────────────────────────────\n';
    out += '3) PER-QUERY COST\n';
    out += '──────────────────────────────────────────────────\n';
    const modelId = opts.model || w.defaults?.model;
    const rates = w.rate_cards[modelId];
    const tierId = opts.tier || w.defaults?.tier;
    const tierMult = w.tier_multipliers[tierId] || 1;
    out += `Model: ${modelId} ($${rates?.input_per_million}/M input, $${rates?.cached_per_million || (rates?.input_per_million * 0.1)}/M cached, $${rates?.output_per_million}/M output)\n`;
    out += `Tier multiplier: ${tierId} × ${tierMult}\n`;
    if (r.api.agent_mode) {
      out += `\nAgent-sum mode (shape×mix bypassed):\n`;
      for (const a of (r.api.agent_breakdown || [])) {
        out += `  Agent "${a.label}" (${a.model}): ${a.calls} call(s) × (${a.input} in + ${a.output} out tok) = ${$4(a.per_query_cost)}/q\n`;
      }
    } else {
      const mixId = opts.mix || w.defaults?.mix;
      const mix = w.mix?.[mixId];
      if (mix) {
        out += `\nShape mix preset "${mixId}":\n`;
        const tmOutMult = taskMixOutputMultiplier(w);
        for (const [shapeName, weight] of Object.entries(mix.weights || {})) {
          const sh = w.shapes?.[shapeName];
          if (!sh) continue;
          const inT = w.anchor_query.input_tokens * sh.input_factor;
          const outT = w.anchor_query.output_tokens * tmOutMult * sh.output_factor;
          out += `  ${shapeName} (weight ${weight}, in×${sh.input_factor}, out×${sh.output_factor}, cache=${sh.cache_eligible ? 'yes' : 'no'}): ${num(inT)} in / ${num(outT)} out tok\n`;
        }
      }
    }
    out += `\nBlended per-query (post-multiplier, includes hosting mult): ${$4(r.api.per_query_blended)}\n\n`;

    // ── 4. LLM total + cap + multiplier ──
    out += '──────────────────────────────────────────────────\n';
    out += '4) LLM MONTHLY COST (with hosting multiplier)\n';
    out += '──────────────────────────────────────────────────\n';
    // Derive the pre-multiplier per-query value directly from the
    // pre-federal monthly so the displayed equation is internally
    // consistent (queries × per-q-pre = monthly-pre). Earlier versions
    // accidentally used per_query_blended (post-multiplier) on the
    // left-hand side of a "pre-multiplier" equation, which only
    // multiplied out correctly when hosting_multiplier was 1.0.
    const preFederalPerQuery = r.queries.total > 0
      ? r.api.monthly_gross_pre_federal / r.queries.total
      : 0;
    out += `Pre-multiplier monthly: ${num(r.queries.total)} queries × ${$4(preFederalPerQuery)}/q (pre-multiplier per-query) = ${$(r.api.monthly_gross_pre_federal)}\n`;
    out += `Hosting multiplier: FedRAMP=${w.federal?.fedramp_tier || 'none'} × multi-region=${w.federal?.multi_region || 'single'} = ${(r.api.hosting_multiplier).toFixed(2)}×\n`;
    out += `Post-multiplier monthly: ${$(r.api.monthly_gross_pre_federal)} × ${(r.api.hosting_multiplier).toFixed(2)} = ${$(r.api.monthly_gross)}\n`;
    out += '\n';

    // ── 5. Self-host (if applicable) ──
    if (opts.hosting === 'self' && r.self_host) {
      const sh = r.self_host;
      out += '──────────────────────────────────────────────────\n';
      out += '5) SELF-HOST CAPACITY + COST\n';
      out += '──────────────────────────────────────────────────\n';
      out += `GPU: ${sh.gpu_spec.name} ($${sh.gpu_spec.hourly}/hr, ${sh.gpu_spec.tput_tps} tok/s peak)\n`;
      out += `Cost mode: ${sh.cost_mode}, throughput de-rate ${(w.self_host.cost_modes[sh.cost_mode].throughput_derate).toFixed(2)}× → effective ${num(sh.effective_tput)} tok/s\n`;
      out += `Average QPS: ${num(r.queries.total)} / (30 × 86400) = ${sh.qps_avg.toFixed(2)} q/s\n`;
      const _scalarNote = sh.token_scalar && Math.abs(sh.token_scalar - 1) > 1e-6
        ? ` (base ${Math.round(sh.tokens_per_query_base)} × langMult/compression scalar ${sh.token_scalar.toFixed(3)})`
        : '';
      out += `Peak tokens/sec: ${sh.qps_avg.toFixed(2)} × ${Math.round(sh.tokens_per_query)} tok/q${_scalarNote} × diurnal ${w.self_host.diurnal_peak_factor}× × headroom ${w.self_host.headroom}× = ${num(sh.peak_tps)} tok/s\n`;
      out += `Instances by load: ⌈${num(sh.peak_tps)} / ${num(sh.effective_tput)}⌉ = ${sh.needed_by_load}\n`;
      out += `Instances running: max(${sh.needed_by_load}, HA floor=${w.self_host.min_replicas}) = ${sh.instances}\n`;
      // Use sh.effective_hours so duty_cycle < 1 is visible in the trace —
      // when duty_cycle = 1.0 this equals 730; when duty_cycle = 0.5 (e.g.
      // a fleet that idles overnight) it's 365. Earlier versions printed
      // the literal "730 hr" regardless, hiding the duty-cycle assumption.
      out += `GPU monthly: ${sh.instances} × $${sh.gpu_spec.hourly}/hr × (1 − discount) × ${Math.round(sh.effective_hours)} hr (= 730 × duty_cycle ${(sh.duty_cycle || 1).toFixed(2)}) × ${(sh.hosting_multiplier || 1).toFixed(2)} hosting mult = ${$(sh.gpu_monthly)}\n`;
      out += `Ops monthly: ${$(sh.ops_monthly)} (${sh.cost_mode} mode)\n`;
      out += `FTE allocation: ${$(sh.fte_monthly)}\n`;
      out += `Setup amortized: ${$(sh.setup_amortized)}\n`;
      out += `TOTAL self-host: ${$(sh.total)} ($/q effective: ${$4(sh.effective_per_query)})\n\n`;
    }

    // ── 6. Verification ──
    if (r.verification && r.verification.enabled && r.verification.coverage > 0) {
      const v = r.verification;
      const b = v.breakdown || {};
      out += '──────────────────────────────────────────────────\n';
      out += '6) VERIFICATION (FactReasoner-style)\n';
      out += '──────────────────────────────────────────────────\n';
      out += `Coverage: ${pct(v.coverage)} → ${num(v.verified_queries)} verified queries/mo\n`;
      out += `Variant: ${v.variant.toUpperCase()} (${v.nli_calls_per_query} NLI calls/verified query)\n`;
      out += `NLI hosting: ${v.nli_hosting} ${v.nli_hosting === 'api' ? '(pay-per-token)' : '(flat EC2 box)'}\n`;
      out += `Atomizer: ${$(b.atomizer || 0)}/mo  ·  Reviser: ${$(b.reviser || 0)}/mo  ·  NLI: ${$(b.nli || 0)}/mo  ·  Retrieval: ${$(b.retrieval || 0)}/mo  ·  Service pod: ${$(b.service_pod || 0)}/mo\n`;
      out += `TOTAL verification: ${$(v.monthly)}/mo\n\n`;
    } else if (r.verification && r.verification.enabled) {
      out += '──────────────────────────────────────────────────\n';
      out += '6) VERIFICATION — enabled but coverage 0%, no cost\n';
      out += '──────────────────────────────────────────────────\n\n';
    }

    // ── 7. Federal additive ──
    if (r.federal && r.federal.additive_total > 0) {
      const f = r.federal;
      const fb = f.breakdown || {};
      out += '──────────────────────────────────────────────────\n';
      out += '7) FEDERAL ADDITIVE COSTS\n';
      out += '──────────────────────────────────────────────────\n';
      if (fb.ato_monthly > 0) out += `ATO amortized: ${$(fb.ato_monthly)}/mo\n`;
      if (fb.egress_monthly > 0) out += `Egress: ${(w.federal.egress_gb_per_query)} GB/q × ${num(r.queries.total)} q × $${w.federal.egress_cost_per_gb}/GB = ${$(fb.egress_monthly)}/mo\n`;
      if (fb.audit_retention_monthly > 0) {
        const auditGBperMo = (w.federal.audit_log_kb_per_query || 0) * r.queries.total / (1024 * 1024);
        out += `Audit retention: ${(w.federal.audit_log_kb_per_query)} KB/q × ${num(r.queries.total)} q / 1024² = ${auditGBperMo.toFixed(2)} GB/mo × 12 × ${w.federal.audit_retention_years} yr × $${w.federal.audit_storage_per_gb_month}/GB-mo = ${$(fb.audit_retention_monthly)}/mo\n`;
      }
      if (fb.retrieval_infra_monthly > 0) out += `Retrieval infra: ${$(fb.retrieval_infra_monthly)}/mo\n`;
      if (fb.pii_redaction_monthly > 0) out += `PII redaction: ${$(fb.pii_redaction_monthly)}/mo\n`;
      out += `TOTAL federal additive: ${$(f.additive_total)}/mo\n\n`;
    }

    // ── 8. Fixed costs (with scaling formulas where applicable) ──
    if (r.fixed_costs && r.fixed_costs.total > 0) {
      out += '──────────────────────────────────────────────────\n';
      out += '8) FIXED MONTHLY COSTS\n';
      out += '──────────────────────────────────────────────────\n';
      const breakdown = r.fixed_costs.infrastructure_breakdown || {};
      const items = Object.entries(w.infrastructure || {}).sort((a, b) => (breakdown[b[0]] || 0) - (breakdown[a[0]] || 0));
      for (const [name, val] of items) {
        const cost = breakdown[name] != null ? breakdown[name] : (typeof val === 'number' ? val : 0);
        let formula = '';
        if (typeof val === 'object' && val) {
          if (val.per === 'per_query') formula = `  [${val.rate}/q × ${num(r.queries.total)} q]`;
          else if (val.per === 'per_1k_queries') formula = `  [${val.rate}/1K q × ${num(r.queries.total)} q ÷ 1000]`;
          else if (val.per === 'per_mau') {
            const segs = w.segments || []; const totalMau = segs.reduce((s,sg)=>s+(sg.mau||0),0);
            formula = `  [${val.rate}/MAU × ${num(totalMau)} MAU]`;
          }
          else if (val.per === 'per_session') {
            const turns = (w.anchor_query && w.anchor_query.session_baseline_turns) || 8;
            const sessions = r.queries.total / Math.max(1, turns);
            formula = `  [${val.rate}/sess × ${num(sessions)} sess]`;
          }
          else if (val.per === 'per_million_queries') formula = `  [${val.rate}/1M q × ${num(r.queries.total)} q ÷ 1M]`;
          else if (val.per === 'per_gb_per_query') formula = `  [${val.rate}/GB × ${num(r.queries.total)} q × ${val.gb} GB/q]`;
        }
        out += `  ${name}: ${$(cost)}${formula}\n`;
      }
      if (r.fixed_costs.rate_limit > 0) out += `  Rate-limit strategy (${w.rate_limit?.strategy}): ${$(r.fixed_costs.rate_limit)}\n`;
      out += `TOTAL fixed: ${$(r.fixed_costs.total)}/mo\n\n`;
    }

    // ── 8.1 API Reservation (if applicable) ──
    if (r.reservation && r.reservation.enabled) {
      const v = r.reservation;
      out += '──────────────────────────────────────────────────\n';
      out += '8.1) API RESERVATION\n';
      out += '──────────────────────────────────────────────────\n';
      out += `Type: ${v.type} (${v.spec?.provider || ''})\n`;
      out += `${v.notes || ''}\n`;
      if (v.fixed_monthly > 0) out += `Fixed monthly cost (replaces variable): ${$(v.fixed_monthly)}\n`;
      if (v.applied_discount > 0) out += `Discount applied: ${pct(v.applied_discount)} → effective ${$(v.effective_monthly)}/mo\n`;
      out += `SAVINGS vs on-demand: ${$(v.savings)}/mo\n\n`;
    }

    // ── 8.2 Embeddings (if applicable) ──
    if (r.embedding && r.embedding.enabled) {
      const e = r.embedding;
      out += '──────────────────────────────────────────────────\n';
      out += '8.2) EMBEDDING GENERATION\n';
      out += '──────────────────────────────────────────────────\n';
      out += `Model: ${e.model} (${e.provider}) at $${e.rate_per_million}/M tokens\n`;
      out += `Ingest: ${num(e.corpus_tokens)} corpus tokens × $${e.rate_per_million}/M = ${$(e.ingest_total_cost)} total, amortized over ${e.reembed_months} mo = ${$(e.ingest_amortized)}/mo\n`;
      out += `Per-query: ${e.query_tokens} tok/q × ${num(r.queries.total)} q × $${e.rate_per_million}/M = ${$(e.query_monthly)}/mo\n`;
      out += `TOTAL embedding: ${$(e.monthly)}/mo\n\n`;
    }

    // ── 8.3 Personnel (if applicable) ──
    if (r.personnel && r.personnel.enabled && r.personnel.monthly > 0) {
      const p = r.personnel;
      out += '──────────────────────────────────────────────────\n';
      out += '8.3) PERSONNEL (people working on the system)\n';
      out += '──────────────────────────────────────────────────\n';
      for (const b of p.breakdown) {
        out += `  ${b.role}: ${b.fte} FTE × $${b.annual_base.toLocaleString()} base × ${b.total_comp_multiplier} loaded ÷ 12 = ${$(b.monthly)}/mo\n`;
      }
      out += `TOTAL personnel: ${$(p.monthly)}/mo\n\n`;
    }

    // ── 8.4 ATO tier (if from Prices.ato) ──
    if (r.federal && r.federal.ato_from_tier) {
      const a = r.federal.ato_from_tier;
      out += '──────────────────────────────────────────────────\n';
      out += '8.4) ATO COMPLIANCE\n';
      out += '──────────────────────────────────────────────────\n';
      out += `Tier: ${a.tier}\n`;
      out += `Upfront: ${$(a.upfront)} amortized over ${a.amortization_months} months = ${$(a.upfront_monthly)}/mo\n`;
      out += `Annual continuous monitoring: ${$(a.annual_continuous)} ÷ 12 = ${$(a.continuous_monthly)}/mo\n`;
      out += `TOTAL ATO: ${$(a.monthly)}/mo\n\n`;
    }

    // ── 8.5 Hybrid hosting (if applicable) ──
    if (r.hybrid) {
      out += '──────────────────────────────────────────────────\n';
      out += '8.5) HYBRID HOSTING (split mode)\n';
      out += '──────────────────────────────────────────────────\n';
      out += `Split: ${pct(r.hybrid.api_share)} to API, ${pct(r.hybrid.self_share)} to self-host\n`;
      out += `API side (${num(r.hybrid.api_queries)} queries): ${$(r.hybrid.api_part.monthly_capped)}/mo\n`;
      out += `Self-host side (${num(r.hybrid.self_queries)} queries): ${$(r.hybrid.self_part.total)}/mo\n`;
      out += `Combined LLM: ${$(r.hybrid.total)}/mo\n\n`;
    }

    // ── 9. Grand total ──
    out += '──────────────────────────────────────────────────\n';
    out += '9) GRAND TOTAL (monthly)\n';
    out += '──────────────────────────────────────────────────\n';
    // LLM headline takes the reservation discount/PTU into account when on API
    let llm = opts.hosting === 'hybrid' ? r.hybrid?.total
              : opts.hosting === 'self' ? r.self_host?.total
              : r.api.monthly_capped;
    if ((opts.hosting === 'api' || !opts.hosting) && r.reservation?.enabled) {
      llm = r.reservation.effective_monthly;
    }
    out += `  ${opts.hosting === 'self' ? 'Self-host LLM' : 'API LLM (capped)'}: ${$(llm)}${r.reservation?.enabled ? ' [reservation applied]' : ''}\n`;
    if (r.verification?.monthly > 0) out += `+ Verification: ${$(r.verification.monthly)}\n`;
    if (r.embedding?.enabled && r.embedding.monthly > 0) out += `+ Embeddings: ${$(r.embedding.monthly)}\n`;
    if (r.personnel?.enabled && r.personnel.monthly > 0) out += `+ Personnel: ${$(r.personnel.monthly)}\n`;
    if (r.federal?.additive_total > 0) out += `+ Federal additive: ${$(r.federal.additive_total)}\n`;
    if (r.fixed_costs?.total > 0) out += `+ Fixed monthly: ${$(r.fixed_costs.total)}\n`;
    const total = (llm || 0)
      + (r.verification?.monthly || 0)
      + (r.embedding?.monthly || 0)
      + (r.personnel?.monthly || 0)
      + (r.federal?.additive_total || 0)
      + (r.fixed_costs?.total || 0);
    out += `= ${$(total)}/mo  →  ${$(total * 12)}/yr  →  ${$(total * 36)}/3yr TCO\n`;

    return out;
  }

  // -------------------------------------------------------------------
  // Resolve an infrastructure item to a monthly dollar amount.
  //
  // Backward-compat: a plain number stays flat ($/mo).
  // New schema: an object can express scaling with traffic:
  //   { flat: 42 }                                       — flat $/mo (alt form)
  //   { rate: 0.005, per: 'per_query' }                  — $0.005 per query
  //   { rate: 0.005, per: 'per_1k_queries' }             — $0.005 per 1K queries
  //   { rate: 0.50,  per: 'per_million_queries' }        — $0.50 per 1M queries
  //   { rate: 0.045, per: 'per_gb_per_query', gb: 0.001 }— $0.045 × queries × 0.001 GB
  // -------------------------------------------------------------------
  function resolveInfraCost(value, monthlyQueries, workload) {
    if (typeof value === 'number') return value;
    if (!value || typeof value !== 'object') return 0;
    if (value.flat != null) return Number(value.flat) || 0;
    const rate = Number(value.rate) || 0;
    const per = value.per;
    if (per === 'per_query') return rate * monthlyQueries;
    if (per === 'per_1k_queries') return rate * monthlyQueries / 1000;
    if (per === 'per_million_queries') return rate * monthlyQueries / 1e6;
    if (per === 'per_gb_per_query') {
      const gbPerQ = Number(value.gb) || 0;
      return rate * monthlyQueries * gbPerQ;
    }
    // Per-active-user / per-session cost shapes for commercial SaaS
    // deployment models (CDN, hosting, per-site storage). Both need
    // access to workload context that the per_query / per_1k shapes
    // don't — MAU sum across segments and sessions/month derivation.
    if (per === 'per_mau') {
      const segs = (workload && Array.isArray(workload.segments)) ? workload.segments : [];
      const totalMau = segs.reduce((s, seg) => s + (seg.mau || 0), 0);
      return rate * totalMau;
    }
    if (per === 'per_session') {
      const turns = Math.max(1, (workload && workload.anchor_query && workload.anchor_query.session_baseline_turns) || 8);
      const monthlySessions = monthlyQueries / turns;
      return rate * monthlySessions;
    }
    return 0;
  }

  // -------------------------------------------------------------------
  // Reserved API capacity — applies a discount or PTU-style fixed cost
  // to the computed API LLM bill. Reads from Prices.api_reservations.
  //
  // Modes (depending on reservation type):
  //   1. Discount — reduces per-token cost by `discount` fraction
  //      (Bedrock provisioned, OpenAI Enterprise commit)
  //   2. PTU — replaces variable cost with fixed monthly per unit
  //      (Azure OpenAI PTU). Total = units × dollar_per_unit_per_month.
  // Returns: { type, applied_discount, fixed_monthly, savings, ... }
  // -------------------------------------------------------------------
  // Per-model PTU efficiency — TPS one PTU buys for that model.
  // Approximate values from Azure's published per-model conversion table
  // (see https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/provisioned-throughput).
  // Smaller models pack more on the same physical GPU and get more TPS/PTU.
  // Override by passing `tps_per_ptu` in workload.reservations.
  const TPS_PER_PTU = {
    'gpt-4o':           50,
    'gpt-4o-mini':      200,
    'gpt-5':            30,
    'gpt-5.5':          25,
    'gpt-5.4':          35,
    'gpt-5.2':          40,
    'gpt-5.1':          50,
    'gpt-5-mini':       150,
    'gpt-5-nano':       400,
    'claude-opus-4.7':  30,
    'claude-sonnet-4.6':50,
    'claude-haiku-4.5': 200,
    'gemini-3.1-pro':   50,
    '_default':         50,
  };

  // Auto-size PTU count from peak load. Returns { units, peak_tps,
  // tokens_per_query, derivation } for surfacing in the UI.
  function ptuSizing(workload, options) {
    const opts = options || {};
    const r = workload.reservations || {};
    const modelId = opts.model || workload.defaults?.model;
    const tpsPerPtu = (r.tps_per_ptu != null)
      ? r.tps_per_ptu
      : (TPS_PER_PTU[modelId] || TPS_PER_PTU._default);

    // Average query token total — sum of per-shape (input + output)
    // weighted by the active mix.
    const mix = workload.mix?.[opts.mix || workload.defaults?.mix]?.weights || { full: 1 };
    const anchor = workload.anchor_query || {};
    const tmOutMult = taskMixOutputMultiplier(workload);
    let tokensPerQuery = 0;
    for (const [shape, weight] of Object.entries(mix)) {
      const s = workload.shapes?.[shape];
      if (!s) continue;
      const inT = (s.input_factor || 0) * (anchor.input_tokens || 0);
      const outT = (s.output_factor || 0) * (anchor.output_tokens || 0) * tmOutMult;
      tokensPerQuery += weight * (inT + outT);
    }
    if (tokensPerQuery === 0) tokensPerQuery = workload.self_host?.tokens_per_query_default || 2000;

    // Compute peak TPS: avg QPS × tokens/query × diurnal peak × headroom
    const baselineQueries = computeQueries(workload, opts);
    const qpsAvg = baselineQueries.total / (30 * 86400);
    const diurnal = workload.self_host?.diurnal_peak_factor || 4;
    const headroom = workload.self_host?.headroom || 1.5;
    const peakTps = qpsAvg * tokensPerQuery * diurnal * headroom;

    const units = Math.max(1, Math.ceil(peakTps / tpsPerPtu));

    return {
      units,
      peak_tps: peakTps,
      qps_avg: qpsAvg,
      tokens_per_query: tokensPerQuery,
      tps_per_ptu: tpsPerPtu,
      model: modelId,
      diurnal_peak_factor: diurnal,
      headroom,
      derivation: `peak_tps = ${qpsAvg.toFixed(2)} qps × ${Math.round(tokensPerQuery)} tok/q × ${diurnal}× peak × ${headroom}× headroom = ${Math.round(peakTps)} tok/s. Need ⌈${Math.round(peakTps)}/${tpsPerPtu}⌉ = ${units} PTU.`,
    };
  }

  function computeReservation(workload, apiCostMonthly, options) {
    const r = workload.reservations || {};
    if (!r.enabled || !r.type || r.type === 'none') {
      return { enabled: false, applied_discount: 0, fixed_monthly: 0, effective_monthly: apiCostMonthly, savings: 0 };
    }
    const spec = (Prices.api_reservations && Prices.api_reservations[r.type]) || null;
    if (!spec) return { enabled: false, applied_discount: 0, fixed_monthly: 0, effective_monthly: apiCostMonthly, savings: 0 };

    // PTU-style fixed cost
    if (spec.dollar_per_unit_per_month != null) {
      // Auto-size from peak load if requested; otherwise use the
      // user-specified units field.
      let units = r.units || 1;
      let sizingDetail = null;
      if (r.auto_size_ptu) {
        sizingDetail = ptuSizing(workload, options);
        units = sizingDetail.units;
      }
      const fixedMonthly = units * spec.dollar_per_unit_per_month;
      const savings = Math.max(0, apiCostMonthly - fixedMonthly);
      return {
        enabled: true,
        type: r.type,
        spec,
        units,
        auto_sized: !!r.auto_size_ptu,
        sizing_detail: sizingDetail,
        applied_discount: 0,
        fixed_monthly: fixedMonthly,
        effective_monthly: fixedMonthly,
        savings,
        notes: `${units} PTU × $${spec.dollar_per_unit_per_month}/mo = $${fixedMonthly.toFixed(0)}/mo flat (replaces variable cost)` +
               (sizingDetail ? `\nAuto-sized: ${sizingDetail.derivation}` : ''),
      };
    }
    // Discount-style (Bedrock, OpenAI Enterprise)
    if (spec.discount != null && spec.discount > 0) {
      const discounted = apiCostMonthly * (1 - spec.discount);
      const savings = apiCostMonthly - discounted;
      return {
        enabled: true,
        type: r.type,
        spec,
        applied_discount: spec.discount,
        fixed_monthly: 0,
        effective_monthly: discounted,
        savings,
        notes: `${(spec.discount * 100).toFixed(0)}% discount on API spend`,
      };
    }
    return { enabled: false, applied_discount: 0, fixed_monthly: 0, effective_monthly: apiCostMonthly, savings: 0 };
  }

  // -------------------------------------------------------------------
  // Embedding generation cost — for RAG systems.
  //   Ingest cost (amortized over reembed cycle):
  //     corpus_size_tokens × $/M / 1e6 ÷ reembed_frequency_months
  //   Per-query embedding cost:
  //     query_tokens × monthly_queries × $/M / 1e6
  // -------------------------------------------------------------------
  function computeEmbedding(workload, monthlyQueries, options) {
    const e = workload.embedding || {};
    if (!e.enabled) {
      return { enabled: false, monthly: 0, ingest_amortized: 0, query_monthly: 0 };
    }
    const modelId = e.model || 'text-embedding-3-small';
    const model = (Prices.embeddings && Prices.embeddings[modelId]) || null;
    if (!model) return { enabled: false, monthly: 0, ingest_amortized: 0, query_monthly: 0 };
    const ratePerM = model.dollar_per_million_tokens || 0;
    const corpusTokens = e.corpus_size_tokens || 0;
    const reembedMonths = Math.max(1, e.reembed_frequency_months || 12);
    const ingestTotalCost = corpusTokens * ratePerM / 1e6;
    const ingestAmortized = ingestTotalCost / reembedMonths;
    const queryTokens = e.query_embedding_tokens || 8;
    const queryMonthly = queryTokens * monthlyQueries * ratePerM / 1e6;
    const monthly = ingestAmortized + queryMonthly;
    return {
      enabled: true,
      model: modelId,
      provider: model.provider,
      rate_per_million: ratePerM,
      corpus_tokens: corpusTokens,
      reembed_months: reembedMonths,
      ingest_total_cost: ingestTotalCost,
      ingest_amortized: ingestAmortized,
      query_tokens: queryTokens,
      query_monthly: queryMonthly,
      monthly,
    };
  }

  // -------------------------------------------------------------------
  // Personnel cost — sum of (FTE allocation × fully-loaded annual salary)
  // ÷ 12.  Roles + salaries from Prices.personnel.
  // -------------------------------------------------------------------
  function computePersonnel(workload, options) {
    const p = workload.personnel || {};
    if (!p.enabled || !Array.isArray(p.roles) || p.roles.length === 0) {
      return { enabled: false, monthly: 0, breakdown: [] };
    }
    const breakdown = [];
    let monthly = 0;
    for (const r of p.roles) {
      const def = (Prices.personnel && Prices.personnel[r.role]) || null;
      if (!def) continue;
      const fte = Number(r.fte) || 0;
      const loaded = (def.annual_base || 0) * (def.total_comp_multiplier || 1);
      const m = fte * loaded / 12;
      monthly += m;
      breakdown.push({
        role: r.role,
        fte,
        annual_base: def.annual_base,
        total_comp_multiplier: def.total_comp_multiplier,
        loaded_annual: loaded,
        monthly: m,
      });
    }
    return { enabled: true, monthly, breakdown };
  }

  // -------------------------------------------------------------------
  // ATO (Authority to Operate) — replace flat federal.ato_monthly with
  // proper amortization from Prices.ato when compliance.ato_tier is set.
  //
  //   monthly = (upfront / amortization_months) + (annual_continuous / 12)
  // -------------------------------------------------------------------
  function computeAtoFromPrices(workload) {
    const c = workload.compliance || {};
    const tier = c.ato_tier;
    if (!tier || tier === 'none') return null;
    const def = (Prices.ato && Prices.ato[tier]) || null;
    if (!def) return null;
    const amortMonths = c.upfront_amortization_months || 36;
    const upfrontMonthly = (def.upfront || 0) / amortMonths;
    const continuousMonthly = (def.annual_continuous_monitoring || 0) / 12;
    return {
      tier,
      upfront: def.upfront,
      annual_continuous: def.annual_continuous_monitoring,
      amortization_months: amortMonths,
      upfront_monthly: upfrontMonthly,
      continuous_monthly: continuousMonthly,
      monthly: upfrontMonthly + continuousMonthly,
    };
  }

  // -------------------------------------------------------------------
  // Migration timeline — phased deployment over 36 months.
  //
  // User defines 1-N phases, each with its own hosting/reservation
  // configuration. Engine computes each phase's monthly cost (by
  // re-running compute with phase-specific options) and returns:
  //   - phases[]: { months, monthlyCost, cumulativeAtEnd, opts }
  //   - total_3yr: sum of phase.monthlyCost × phase.months
  //   - chart_points: monthly cost over 0-36 months (for plotting)
  //
  // Designed for procurement decisions like "API year 1 → hybrid year 2
  // → self-host year 3" where TCO depends critically on transitions.
  // -------------------------------------------------------------------
  function computeMigration(workload, options, computeFn) {
    const m = workload.migration || {};
    if (!m.enabled || !Array.isArray(m.phases) || m.phases.length === 0) {
      return { enabled: false };
    }
    const baseOpts = options || {};
    const phases = [];
    let cumulativeMonths = 0;
    let total = 0;
    const chartPoints = [];

    for (const phase of m.phases) {
      const months = Math.max(1, Math.round(phase.months || 12));
      const phaseOpts = Object.assign({}, baseOpts, {
        hosting: phase.hosting || baseOpts.hosting,
      });
      // For hybrid phases, pass apiSplit
      if (phase.apiSplit != null) phaseOpts.apiSplit = phase.apiSplit;
      // Apply phase-specific reservation if specified
      const wCopy = JSON.parse(JSON.stringify(workload));
      if (phase.reservation_type) {
        wCopy.reservations = wCopy.reservations || {};
        wCopy.reservations.enabled = phase.reservation_type !== 'none';
        wCopy.reservations.type = phase.reservation_type;
        if (phase.reservation_units) wCopy.reservations.units = phase.reservation_units;
      }
      // Re-compute with phase config
      const phaseResult = computeFn(wCopy, phaseOpts);
      // Headline monthly = LLM + verif + embedding + personnel + federal + fixed.
      // Eq. 5 (1 + 1.5r) is already applied inside computeApiCost as
      // api.monthly_with_retry. Phase callers read that directly so retry
      // accounting is identical to composeHeadline.
      const apiBill = phaseResult.api?.monthly_with_retry
                   ?? phaseResult.api?.monthly_capped
                   ?? 0;
      const llm = phaseOpts.hosting === 'hybrid' ? (phaseResult.hybrid?.total || 0)
                : phaseOpts.hosting === 'self' ? (phaseResult.self_host?.total || 0)
                : (phaseResult.reservation?.enabled ? phaseResult.reservation.effective_monthly : apiBill);
      const monthlyCost = llm
        + (phaseResult.verification?.monthly || 0)
        + (phaseResult.embedding?.monthly || 0)
        + (phaseResult.personnel?.monthly || 0)
        + (phaseResult.federal?.additive_total || 0)
        + (phaseResult.fixed_costs?.total || 0);
      const phaseSpend = monthlyCost * months;
      total += phaseSpend;
      // Build the chart points (one per month)
      for (let m_i = 0; m_i < months; m_i++) {
        chartPoints.push({
          month: cumulativeMonths + m_i,
          monthly: monthlyCost,
          phase_index: phases.length,
        });
      }
      phases.push({
        index: phases.length,
        label: phase.label || `Phase ${phases.length + 1}`,
        months,
        hosting: phaseOpts.hosting,
        reservation_type: phase.reservation_type || 'none',
        api_split: phase.apiSplit,
        monthly_cost: monthlyCost,
        phase_total: phaseSpend,
        start_month: cumulativeMonths,
        end_month: cumulativeMonths + months,
      });
      cumulativeMonths += months;
    }

    return {
      enabled: true,
      phases,
      total_months: cumulativeMonths,
      total_spend: total,
      chart_points: chartPoints,
    };
  }

  // -------------------------------------------------------------------
  // Risk uncertainty bands — sensitivity analysis on key inputs.
  //
  // Re-runs compute with perturbed inputs across plausible bounds:
  //   token sizing: ±20%
  //   MAU forecast: ±15%
  //   cache hit rate: ±5 percentage points
  //   per-token API rate: ±10% (vendor pricing changes quarterly)
  //
  // Returns { low, nominal, high } total monthly cost. The range
  // captures most procurement-grade uncertainty without needing
  // full Monte Carlo.
  // -------------------------------------------------------------------
  function computeRiskBands(workload, options, computeFn) {
    const opts = options || {};
    const perturbations = [
      { name: 'low',     token: 0.80, mau: 0.85, cache: +0.05, rate: 0.90 },
      { name: 'nominal', token: 1.00, mau: 1.00, cache:  0.00, rate: 1.00 },
      { name: 'high',    token: 1.20, mau: 1.15, cache: -0.05, rate: 1.10 },
    ];
    const totalFor = (p) => {
      const wCopy = JSON.parse(JSON.stringify(workload));
      // Perturb anchor query tokens
      if (wCopy.anchor_query) {
        wCopy.anchor_query.input_tokens = (wCopy.anchor_query.input_tokens || 0) * p.token;
        wCopy.anchor_query.output_tokens = (wCopy.anchor_query.output_tokens || 0) * p.token;
        wCopy.anchor_query.cache_rate_baseline = Math.min(0.94, Math.max(0.50,
          (wCopy.anchor_query.cache_rate_baseline || 0.70) + p.cache));
      }
      // Perturb MAU per segment
      for (const seg of (wCopy.segments || [])) seg.mau = Math.round((seg.mau || 0) * p.mau);
      // Perturb LLM rates by p.rate. Guard each field — cached_per_million
      // is often absent on rate cards (the engine falls back to p_in × 0.1
      // when it's missing), and multiplying null × number produces NaN
      // which then poisons every downstream cost calc. Same for the
      // optional cached_write_per_million on Anthropic-style cards.
      if (p.rate !== 1.0 && wCopy.rate_cards) {
        for (const id in wCopy.rate_cards) {
          const r = wCopy.rate_cards[id];
          if (r && typeof r === 'object') {
            if (r.input_per_million        != null) r.input_per_million        *= p.rate;
            if (r.cached_per_million       != null) r.cached_per_million       *= p.rate;
            if (r.output_per_million       != null) r.output_per_million       *= p.rate;
            if (r.cached_write_per_million != null) r.cached_write_per_million *= p.rate;
          }
        }
      }
      const result = computeFn(wCopy, opts);
      const llm = opts.hosting === 'hybrid' ? (result.hybrid?.total || 0)
                : opts.hosting === 'self' ? (result.self_host?.total || 0)
                : (result.reservation?.enabled ? result.reservation.effective_monthly : result.api.monthly_capped);
      return llm
        + (result.verification?.monthly || 0)
        + (result.embedding?.monthly || 0)
        + (result.personnel?.monthly || 0)
        + (result.federal?.additive_total || 0)
        + (result.fixed_costs?.total || 0);
    };
    const low = totalFor(perturbations[0]);
    const nominal = totalFor(perturbations[1]);
    const high = totalFor(perturbations[2]);
    return {
      low, nominal, high,
      spread_dollars: high - low,
      spread_percent: nominal > 0 ? (high - low) / (2 * nominal) : 0,
      perturbations: {
        token_pct: '±20%',
        mau_pct: '±15%',
        cache_pp: '±5pp',
        rate_pct: '±10%',
      },
    };
  }

  // -------------------------------------------------------------------
  // Hybrid hosting: split traffic between API and self-host. The engine
  // computes both costs scaled by the apiSplit fraction (0..1) and
  // returns a combined view alongside per-side breakdowns.
  // -------------------------------------------------------------------
  function computeHybrid(workload, queries, options) {
    const opts = options || {};
    const split = Math.min(1, Math.max(0, opts.apiSplit != null ? opts.apiSplit : 0.5));

    // Build query subsets for each side
    const scaleQueries = (q, frac) => {
      const out = JSON.parse(JSON.stringify(q));
      out.total = q.total * frac;
      for (const id in (out.bySegment || {})) out.bySegment[id] = q.bySegment[id] * frac;
      out.auth = (q.auth || 0) * frac;
      out.anon = (q.anon || 0) * frac;
      return out;
    };
    const apiQ = scaleQueries(queries, split);
    const shQ = scaleQueries(queries, 1 - split);

    const apiPart = computeApiCost(workload, apiQ, opts);
    const shPart = computeSelfHost(workload, shQ.total, opts);

    return {
      api_share: split,
      self_share: 1 - split,
      api_part: apiPart,
      self_part: shPart,
      api_queries: apiQ.total,
      self_queries: shQ.total,
      total: apiPart.monthly_capped + shPart.total,
    };
  }

  // -------------------------------------------------------------------
  // Top-level entry point — runs the whole pipeline.
  // -------------------------------------------------------------------
  function compute(rawWorkload, options) {
    const workload = normalizeWorkload(rawWorkload);
    const opts = options || {};
    const queries = computeQueries(workload, opts);
    const api = computeApiCost(workload, queries, opts);
    const selfHost = computeSelfHost(workload, queries.total, opts);
    const selfHostCapped = computeSelfHostCapped(workload, queries.total, selfHost, opts);
    // Break-even — at what monthly query volume does self-host beat API?
    // Single-number procurement signal. Skipped when running under
    // recursive contexts (migration / risk-band re-runs) to avoid blowing
    // the call stack.
    const breakEven = (!opts._inMigration && !opts._inRisk)
      ? computeBreakEven(workload, opts)
      : null;
    const verification = computeVerification(workload, queries.total, opts);
    const toolFees = computeToolFees(workload, queries, opts);
    const federal = computeFederal(workload, queries.total, api, opts);
    // Reservation discount/PTU on API LLM cost
    const reservation = computeReservation(workload, api.monthly_capped, opts);
    // Embedding generation (RAG ingest + query)
    const embedding = computeEmbedding(workload, queries.total, opts);
    // Personnel costs (annual salaries × FTE allocation)
    const personnel = computePersonnel(workload, opts);
    // ATO from Prices.ato tiers (replaces flat federal.ato_monthly when set)
    const atoFromPrices = computeAtoFromPrices(workload);
    // If ATO came from prices.ato tier, override federal.additive_total
    if (atoFromPrices) {
      federal.ato_from_tier = atoFromPrices;
      federal.additive_total = (federal.additive_total || 0) - (federal.breakdown.ato_monthly || 0) + atoFromPrices.monthly;
      federal.breakdown.ato_monthly = atoFromPrices.monthly;
      federal.breakdown.ato_tier = atoFromPrices.tier;
    }
    // Hybrid mode (split traffic between API and self-host)
    const hybrid = (opts.hosting === 'hybrid')
      ? computeHybrid(workload, queries, opts)
      : null;
    // Sum infra line items + rate_limit monthly cost into a single fixed bucket.
    // Items can be flat numbers OR scaling objects (per-query / per-1k-queries / etc.)
    const infraItems = workload.infrastructure || {};
    const infraBreakdown = {};
    let infraSum = 0;
    for (const [name, val] of Object.entries(infraItems)) {
      const cost = resolveInfraCost(val, queries.total, workload);
      infraBreakdown[name] = cost;
      infraSum += cost;
    }
    const rateLimitCost = (workload.rate_limit && Number(workload.rate_limit.monthly_cost)) || 0;
    const fixedCosts = {
      infrastructure: infraSum,
      infrastructure_breakdown: infraBreakdown,
      rate_limit: rateLimitCost,
      total: infraSum + rateLimitCost,
    };
    const result = {
      workload, queries, api,
      self_host: selfHost,
      self_host_capped: selfHostCapped,
      break_even: breakEven,
      verification, federal,
      tool_fees: toolFees,
      hybrid,
      reservation,
      embedding,
      personnel,
      fixed_costs: fixedCosts,
    };
    // Migration timeline (uses compute recursively for each phase).
    // Skip when we're inside a recursion (opts._inMigration prevents loop).
    if (workload.migration && workload.migration.enabled && !opts._inMigration) {
      const migOpts = Object.assign({}, opts, { _inMigration: true });
      result.migration = computeMigration(workload, migOpts, (w, o) => compute(w, o));
    } else {
      result.migration = { enabled: false };
    }
    // Risk uncertainty bands (sensitivity analysis). Same recursion guard.
    if (workload.risk && workload.risk.enabled && !opts._inMigration && !opts._inRisk) {
      const riskOpts = Object.assign({}, opts, { _inRisk: true });
      result.risk_bands = computeRiskBands(workload, riskOpts, (w, o) => compute(w, o));
    } else {
      result.risk_bands = null;
    }
    result.derivation = deriveTrace(workload, result, opts);
    return result;
  }

  // -------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------
  const api = {
    Prices, // re-export for callers
    DEFAULT_RATE_CARDS,
    DEFAULT_TIER_MULTIPLIERS,
    DEFAULT_GPU_CATALOG,
    DEFAULT_COST_MODES,
    DEFAULT_FEDERAL,
    FEDRAMP_MULTIPLIERS,
    MULTI_REGION_MULTIPLIERS,
    normalizeWorkload,
    effectiveCacheRate,
    perQueryCost,
    computeQueries,
    computeApiCost,
    computeSelfHost,
    computeSelfHostCapped,
    computeBreakEven,
    ptuSizing,
    TPS_PER_PTU,
    computeVerification,
    computeToolFees,
    computeFederal,
    computeReservation,
    computeEmbedding,
    computePersonnel,
    computeAtoFromPrices,
    computeHybrid,
    computeMigration,
    computeRiskBands,
    hostingMultiplier,
    resolveInfraCost,
    deriveTrace,
    compute,
    GUARD_MODEL_PRESETS,
    VERIFIER_PRESETS,
    DEFAULT_TOOLS_REGISTRY,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.CostEngine = api;
  }
})(typeof window !== 'undefined' ? window : this);
