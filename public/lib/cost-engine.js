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
  // just the numeric fields the engine needs).
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
      const eff = agent.cache_eligible ? cacheRate : 0;
      const cached = inT * eff;
      const uncached = inT - cached;
      const perCall = (
        uncached * rates.input_per_million / 1e6 +
        cached   * (rates.cached_per_million || rates.input_per_million * 0.1) / 1e6 +
        outT     * rates.output_per_million / 1e6
      ) * mult;
      const monthlyContrib = calls * perCall;
      total += monthlyContrib;
      breakdown.push({
        id: agent.id, label: agent.label || agent.id,
        hosting, model: modelId, calls, input: inT, output: outT,
        per_call_cost: perCall, per_query_cost: monthlyContrib,
      });
    }
    return { per_query: total, breakdown };
  }

  // -------------------------------------------------------------------
  // Per-query cost: weighted blend across the configured shape mix.
  // -------------------------------------------------------------------
  function effectiveCacheRate(baseline, questions_per_session, baseline_turns) {
    // 1 percentage point per turn above/below baseline; clamped [0.5, 0.94].
    const adj = baseline + (questions_per_session - baseline_turns) * 0.01;
    return Math.min(0.94, Math.max(0.50, adj));
  }

  function perQueryCost(workload, modelId, tierId, mixId, cacheRate) {
    const w = workload;
    const rates = w.rate_cards[modelId];
    const mult = w.tier_multipliers[tierId] || 1.0;
    const mix = w.mix[mixId];
    if (!mix || !mix.weights) return 0;
    const anchorIn = w.anchor_query.input_tokens;
    const anchorOut = w.anchor_query.output_tokens;
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
        cached   * (rates.cached_per_million || rates.input_per_million * 0.1) / 1e6 +
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
      const beta = seg.applyBotFactor ? botEffective : 1;
      const q = seg.mau * seg.sessions_per_day * DAYS * seg.questions_per_session * beta;
      bySegment[seg.id] = q;
      total += q;
      if (seg.applyBotFactor) anon += q;
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
        pq = perQueryCost(w, modelId, tierId, mixId, eff);
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

    // Daily-cap math removed — was a misleading abstraction for procurement.
    // Real cloud LLM contracts don't refuse queries at a $-cap; they just
    // bill what was used. Cap-based clipping was masking slider sensitivity
    // (when cap was binding, no input changes moved the headline). The
    // procurement question "what's the max scale on $X budget?" is answered
    // by the inverse Budget Solver panel instead. We keep the field names
    // so downstream consumers don't have to change.
    const cappedWithHost = grossWithHost;
    const monthlyRefused = 0;
    const monthlyCapped = cappedWithHost / (hostMult || 1);  // pre-multiplier view

    return {
      monthly_gross: grossWithHost,
      monthly_capped: cappedWithHost,
      monthly_gross_pre_federal: totalCost,
      monthly_capped_pre_federal: monthlyCapped,
      hosting_multiplier: hostMult,
      monthly_refused_queries: monthlyRefused,
      per_query_blended: blended * hostMult,
      per_segment: segPerQuery,
      cap_active: monthlyCapped < totalCost - 0.01,
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
    const tokensPerQ = opts.tokensPerQ || w.self_host.tokens_per_query_default;
    const costMode = opts.costMode || 'optimistic';

    const gpu = w.self_host.gpu_options[gpuId];
    const params = w.self_host.cost_modes[costMode];

    const disc = commitmentId === 'on-demand' ? 0
                : commitmentId === 'ri-1y'    ? params.discount_1yr
                : /* ri-3y */                   params.discount_3yr;
    const effTput = gpu.tput_tps * params.throughput_derate;
    const qpsAvg = monthlyQueries / (30 * 86400);
    const peakTps = qpsAvg * tokensPerQ * w.self_host.diurnal_peak_factor * w.self_host.headroom;
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

    // Cost functions at a given volume — pure inference cost only,
    // no verification / federal / personnel / fixed infra (these are
    // common to both paths and don't affect the crossover).
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
      note: 'Above this monthly query volume, self-host beats API on pure inference $. Excludes verification, federal, personnel, fixed infra.',
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
  const VARIANT_NLI_CALLS = { fr1: 24, fr2: 160, fr3: 350 };
  const NLI_HOSTING_FLAT = { 'ec2-g6': 588, 'ec2-g5': 735 };

  function computeVerification(workload, monthlyQueries, options) {
    const w = workload;
    const v = w.verification;
    if (!v || !v.enabled) {
      return { enabled: false, monthly: 0, verified_queries: 0, breakdown: {} };
    }
    const opts = options || {};
    const coverage = opts.verifCoverage !== undefined ? opts.verifCoverage : (v.coverage || 0);
    if (coverage <= 0) {
      return { enabled: true, coverage: 0, monthly: 0, verified_queries: 0, breakdown: {}, variant: v.variant, nli_hosting: v.nli_hosting };
    }
    const variant = opts.verifVariant || v.variant || 'fr1';
    const atoms = v.atoms_per_response || 8;
    const nliCallsPerAtom =
      (v.atoms_per_response_nli_calls && v.atoms_per_response_nli_calls[variant])
      || VARIANT_NLI_CALLS[variant] || 24;
    const verifiedQueries = monthlyQueries * coverage;

    const modelId = opts.verifModel || opts.model || w.defaults.model;
    const tierId = opts.tier || w.defaults.tier;
    const rates = w.rate_cards[modelId];
    const mult = w.tier_multipliers[tierId] || 1.0;

    // Helper: token cost on a per-call basis (no caching for these short calls).
    const tokenCost = (tokens) =>
      ((tokens.input || 0) * rates.input_per_million / 1e6 +
       (tokens.output || 0) * rates.output_per_million / 1e6) * mult;

    const atomizerPerQuery = tokenCost(v.atomizer_tokens || { input: 1500, output: 400 });
    const reviserPerQuery = atoms * tokenCost(v.reviser_tokens || { input: 500, output: 30 });
    const nliHosting = opts.nliHosting || v.nli_hosting || 'api';
    let nliMonthly;
    if (nliHosting === 'api') {
      const nliPerCall = tokenCost(v.nli_tokens || { input: 1200, output: 20 });
      nliMonthly = verifiedQueries * atoms * nliCallsPerAtom * nliPerCall;
    } else {
      nliMonthly = NLI_HOSTING_FLAT[nliHosting] || 0;
    }

    // Retrieval: wikipedia is free; serper is ~$5 per 1000 calls (atoms).
    const retrieval = opts.retrieval || v.retrieval || 'wikipedia';
    const retrievalMonthly = retrieval === 'serper'
      ? verifiedQueries * atoms * (5 / 1000)
      : 0;

    const atomizerMonthly = verifiedQueries * atomizerPerQuery;
    const reviserMonthly = verifiedQueries * reviserPerQuery;
    const servicePod = v.service_pod_monthly || 0;
    const monthly = atomizerMonthly + reviserMonthly + nliMonthly + retrievalMonthly + servicePod;

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
        retrieval: retrievalMonthly,
        service_pod: servicePod,
      },
      nli_hosting: nliHosting,
      nli_calls_per_atom: nliCallsPerAtom,
    };
  }

  // -------------------------------------------------------------------
  // Self-host capped to same monthly budget as the API daily cap.
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
    const budgetForGpu = Math.max(0, monthlyBudget - fixed);
    const instancesAffordable = Math.floor(budgetForGpu / (gpuHourlyEff * 730));
    const instances = Math.max(0, Math.min(instancesAffordable, peerSelfHost.instances));
    const gpuMonthly = instances * gpuHourlyEff * 730;
    const total = gpuMonthly + fixed;

    const capacity = instances * peerSelfHost.effective_tput;
    const fracServed = peerSelfHost.peak_tps > 0 ? Math.min(1, capacity / peerSelfHost.peak_tps) : 1;
    const served = monthlyQueries * fracServed;
    const refused = monthlyQueries - served;

    return {
      monthly_budget: monthlyBudget,
      instances,
      instances_affordable: instancesAffordable,
      gpu_monthly: gpuMonthly,
      total,
      fraction_served: fracServed,
      queries_served: served,
      queries_refused: refused,
      budget_binding: instancesAffordable < peerSelfHost.instances,
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
      const beta = seg.applyBotFactor ? r.queries.botEffective : 1;
      out += `  Segment "${seg.label || seg.id}" (${seg.applyBotFactor ? 'anonymous, bot-factored' : 'authenticated'}):\n`;
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
        for (const [shapeName, weight] of Object.entries(mix.weights || {})) {
          const sh = w.shapes?.[shapeName];
          if (!sh) continue;
          const inT = w.anchor_query.input_tokens * sh.input_factor;
          const outT = w.anchor_query.output_tokens * sh.output_factor;
          out += `  ${shapeName} (weight ${weight}, in×${sh.input_factor}, out×${sh.output_factor}, cache=${sh.cache_eligible ? 'yes' : 'no'}): ${num(inT)} in / ${num(outT)} out tok\n`;
        }
      }
    }
    out += `\nBlended per-query (post-multiplier): ${$4(r.api.per_query_blended)}\n\n`;

    // ── 4. LLM total + cap + multiplier ──
    out += '──────────────────────────────────────────────────\n';
    out += '4) LLM MONTHLY COST (with hosting multiplier)\n';
    out += '──────────────────────────────────────────────────\n';
    out += `Pre-multiplier monthly: ${num(r.queries.total)} queries × ${$4(r.api.per_query_blended)}/q (blended per-query above) = ${$(r.api.monthly_gross_pre_federal)}\n`;
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
      out += `Peak tokens/sec: ${sh.qps_avg.toFixed(2)} × ${opts.tokensPerQ || w.self_host.tokens_per_query_default} tok/q × diurnal ${w.self_host.diurnal_peak_factor}× × headroom ${w.self_host.headroom}× = ${num(sh.peak_tps)} tok/s\n`;
      out += `Instances by load: ⌈${num(sh.peak_tps)} / ${num(sh.effective_tput)}⌉ = ${sh.needed_by_load}\n`;
      out += `Instances running: max(${sh.needed_by_load}, HA floor=${w.self_host.min_replicas}) = ${sh.instances}\n`;
      out += `GPU monthly: ${sh.instances} × $${sh.gpu_spec.hourly}/hr × (1 − discount) × 730 hr × ${(sh.hosting_multiplier || 1).toFixed(2)} hosting mult = ${$(sh.gpu_monthly)}\n`;
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
      out += `Variant: ${v.variant.toUpperCase()} (${v.nli_calls_per_atom} NLI calls/atom × ${w.verification.atoms_per_response || 8} atoms = ${(v.nli_calls_per_atom * (w.verification.atoms_per_response || 8))} NLI calls/q)\n`;
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
  function resolveInfraCost(value, monthlyQueries) {
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
    let tokensPerQuery = 0;
    for (const [shape, weight] of Object.entries(mix)) {
      const s = workload.shapes?.[shape];
      if (!s) continue;
      const inT = (s.input_factor || 0) * (anchor.input_tokens || 0);
      const outT = (s.output_factor || 0) * (anchor.output_tokens || 0);
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
      // Headline monthly = LLM + verif + embedding + personnel + federal + fixed
      const llm = phaseOpts.hosting === 'hybrid' ? (phaseResult.hybrid?.total || 0)
                : phaseOpts.hosting === 'self' ? (phaseResult.self_host?.total || 0)
                : (phaseResult.reservation?.enabled ? phaseResult.reservation.effective_monthly : phaseResult.api.monthly_capped);
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
      // Perturb LLM rates by p.rate
      if (p.rate !== 1.0 && wCopy.rate_cards) {
        for (const id in wCopy.rate_cards) {
          const r = wCopy.rate_cards[id];
          if (r && typeof r === 'object') {
            r.input_per_million *= p.rate;
            r.cached_per_million *= p.rate;
            r.output_per_million *= p.rate;
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
      const cost = resolveInfraCost(val, queries.total);
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
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.CostEngine = api;
  }
})(typeof window !== 'undefined' ? window : this);
