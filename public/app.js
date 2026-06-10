// =====================================================================
// Cost Calculator Studio — authoring app
//
// Form-based editor for workload specifications, with live preview of
// the resulting calculator output. Generates a standalone HTML
// calculator on demand. Pure client-side; no backend.
// =====================================================================

(function () {
  'use strict';

  const fmt$ = (v) => {
    if (!isFinite(v) || isNaN(v)) return '—';
    if (v === 0) return '$0';
    if (Math.abs(v) >= 10000) return '$' + Math.round(v).toLocaleString();
    if (Math.abs(v) >= 100) return '$' + Math.round(v).toLocaleString();
    if (Math.abs(v) >= 1) return '$' + v.toFixed(2);
    return '$' + v.toFixed(4);
  };
  const fmtN = (v) => Math.round(v).toLocaleString();

  // -----------------------------------------------------------------
  // State + bind helpers
  // -----------------------------------------------------------------
  let workload = makeBlank();
  // Expose workload + renderPreview to the simulator-side script so the
  // Audience editor (defined in the inlined integration script) can
  // read/write segments and trigger recomputation.
  window.workload = workload;

  function makeBlank() {
    return {
      schemaVersion: '1.0',
      deployment: {
        name: 'My AI Agent',
        agency: 'My Agency',
        description: 'A natural-language interface to our datasets.',
        publicFacing: true,
        fedrampTier: 'none',
      },
      anchor_query: {
        input_tokens: 10000,
        output_tokens: 500,
        cache_rate_baseline: 0.7,
        session_baseline_turns: 6,
        example: '',
      },
      shapes: {
        full:    { input_factor: 1.00, output_factor: 1.00, cache_eligible: true,  description: 'Full pipeline' },
        rag:     { input_factor: 0.30, output_factor: 0.50, cache_eligible: true,  description: 'Retrieval-only' },
        refusal: { input_factor: 0.05, output_factor: 0.10, cache_eligible: false, description: 'Out-of-scope' },
      },
      mix: {
        mixed: { label: 'Mixed (default)', weights: { full: 0.5, rag: 0.4, refusal: 0.1 } },
      },
      segments: [
        { id: 'public', label: 'Public users', mau: 5000, sessions_per_day: 0.2, questions_per_session: 5, applyBotFactor: true },
      ],
      verification: {
        enabled: false,
        coverage: 0.10,
        atoms_per_response: 8,
        variant: 'fr2',
        atoms_per_response_nli_calls: { fr1: 24, fr2: 160, fr3: 350 },
        atomizer_tokens: { input: 1500, output: 400 },
        reviser_tokens:  { input:  500, output:  30 },
        nli_tokens:      { input: 1200, output:  20 },
        retrieval: 'wikipedia',
        nli_hosting: 'api',
        service_pod_monthly: 36,
      },
      rate_limit: { strategy: 'edge', monthly_cost: 15, bot_ceiling: 2.5 },
      daily_cap:  { enabled: true, amount_usd: 1500, burst_days: 7, burst_factor: 1.0 },
      infrastructure: {
        'Compute platform': 179,
        'RDS Postgres': 292,
        'ALB': 35,
      },
      federal: {
        fedramp_tier: 'none',
        multi_region: 'single',
        ato_monthly: 0,
        egress_gb_per_query: 0.001,
        egress_cost_per_gb: 0.09,
        audit_log_kb_per_query: 5,
        audit_retention_years: 7,
        audit_storage_per_gb_month: 0.004,
        retrieval_infra_monthly: 0,
        pii_redaction_per_million_tokens: 0,
      },
      compliance: {
        ato_tier: 'none',                 // 'none' | 'fedramp_low' | 'fedramp_moderate' | 'fedramp_high' | 'il4' | 'il5'
        upfront_amortization_months: 36,
      },
      reservations: {
        enabled: false,
        type: 'none',
        units: 4,
      },
      embedding: {
        enabled: false,
        model: 'text-embedding-3-small',
        corpus_size_tokens: 50_000_000,
        reembed_frequency_months: 6,
        query_embedding_tokens: 8,
      },
      personnel: {
        enabled: false,
        roles: [
          { role: 'mlops_engineer', fte: 0.5 },
          { role: 'prompt_engineer', fte: 0.25 },
        ],
      },
      // Agent engineering — upfront design-phase roles + helper-agent LLM
      // budget + maintenance cadence. Amortized over deployment lifetime.
      // Methodology-agnostic; defaults approximate a CARE-style engagement.
      agent_engineering: {
        enabled: false,
        duration_months: 4,
        amortization_months: 36,
        helper_agent_monthly: 400,
        roles: [
          { role: 'agent_sme_external', fte: 0.5 },
          { role: 'agent_design_lead',  fte: 1.0 },
          { role: 'agent_developer',    fte: 1.0 },
          { role: 'eval_engineer',      fte: 0.25 },
        ],
        maintenance_interval_months: 6,
        maintenance_hours_per_session: 40,
      },
      migration: {
        enabled: false,
        phases: [
          { label: 'Year 1 — pilot on API', months: 12, hosting: 'api', reservation_type: 'none' },
          { label: 'Year 2 — committed-spend',   months: 12, hosting: 'api', reservation_type: 'azure-ptu-yearly', reservation_units: 4 },
          { label: 'Year 3 — self-host',         months: 12, hosting: 'self', reservation_type: 'none' },
        ],
      },
      risk: {
        enabled: false,
      },
      rate_cards: {},
      tier_multipliers: { standard: 1.0, flex: 0.5, batch: 0.5, priority: 2.5 },
      self_host: {
        gpu_options: {
          'g6e.12xl': { hourly: 10.49, tput_tps: 1200, name: '4× L40S 48GB',  capable: '70B int8' },
          'g5.48xl':  { hourly: 16.29, tput_tps:  900, name: '8× A10G 24GB',  capable: '70B int4' },
          'p5.48xl':  { hourly: 98.32, tput_tps: 4500, name: '8× H100 80GB',  capable: '400B fp8' },
        },
        diurnal_peak_factor: 4,
        headroom: 1.5,
        min_replicas: 2,
        tokens_per_query_default: 2000,
        cost_modes: {
          optimistic: { ops_monthly:  350, fte_monthly: 2500, setup_amortized:    0, throughput_derate: 1.00, discount_1yr: 0.40, discount_3yr: 0.60 },
          realistic:  { ops_monthly: 1800, fte_monthly: 8000, setup_amortized: 8333, throughput_derate: 0.75, discount_1yr: 0.33, discount_3yr: 0.55 },
        },
      },
      defaults: { model: 'gpt-5.2', tier: 'standard', mix: 'mixed', rate_limit: 'edge', hosting: 'api', cost_mode: 'optimistic' },
    };
  }

  // Fill in any missing fields so the editor can bind without errors.
  // Imported workloads from older schemas may not have self_host etc.
  function ensureFields(w) {
    const blank = makeBlank();
    w.tier_multipliers = w.tier_multipliers || blank.tier_multipliers;
    w.rate_cards = w.rate_cards || {};
    w.self_host = w.self_host || blank.self_host;
    w.self_host.gpu_options = w.self_host.gpu_options || blank.self_host.gpu_options;
    w.self_host.cost_modes = w.self_host.cost_modes || blank.self_host.cost_modes;
    w.self_host.cost_modes.optimistic = Object.assign({}, blank.self_host.cost_modes.optimistic, w.self_host.cost_modes.optimistic || {});
    w.self_host.cost_modes.realistic  = Object.assign({}, blank.self_host.cost_modes.realistic,  w.self_host.cost_modes.realistic  || {});
    w.self_host.diurnal_peak_factor = w.self_host.diurnal_peak_factor || 4;
    w.self_host.headroom = w.self_host.headroom || 1.5;
    w.self_host.min_replicas = w.self_host.min_replicas || 2;
    w.self_host.tokens_per_query_default = w.self_host.tokens_per_query_default || 2000;
    w.verification = w.verification || blank.verification;
    w.verification.atomizer_tokens = w.verification.atomizer_tokens || { input: 1500, output: 400 };
    w.verification.reviser_tokens  = w.verification.reviser_tokens  || { input:  500, output:  30 };
    w.verification.nli_tokens      = w.verification.nli_tokens      || { input: 1200, output:  20 };
    w.infrastructure = w.infrastructure || {};
    w.agents = Array.isArray(w.agents) ? w.agents : [];
    // Some newer presets (health, legal, finance) omit the legacy daily_cap
    // block entirely. Backfill from blank so the two app.js code paths that
    // still read workload.daily_cap.amount_usd (display strings only, no
    // engine math) don't crash on load.
    w.daily_cap = Object.assign({}, blank.daily_cap, w.daily_cap || {});
    w.federal = Object.assign({}, blank.federal, w.federal || {});
    w.compliance = Object.assign({}, blank.compliance, w.compliance || {});
    w.reservations = Object.assign({}, blank.reservations, w.reservations || {});
    w.embedding = Object.assign({}, blank.embedding, w.embedding || {});
    w.personnel = Object.assign({}, blank.personnel, w.personnel || {});
    w.migration = Object.assign({}, blank.migration, w.migration || {});
    if (!Array.isArray(w.migration.phases)) w.migration.phases = blank.migration.phases;
    w.risk = Object.assign({}, blank.risk, w.risk || {});
    // Backward compat: legacy deployment.fedrampTier mirrored into federal.fedramp_tier
    if (w.deployment && w.deployment.fedrampTier && (!w.federal.fedramp_tier || w.federal.fedramp_tier === 'none')) {
      w.federal.fedramp_tier = w.deployment.fedrampTier;
    }
    w.defaults = Object.assign({}, blank.defaults, w.defaults || {});
    // Tools registry — merge the engine's DEFAULT_TOOLS_REGISTRY into
    // workload.tools_registry so the UI (renderToolsRegistry) sees the
    // built-in tools even on presets that pre-date the registry. The
    // engine separately re-merges defaults inside normalizeWorkload,
    // but UI rendering happens off window.workload, so we need the
    // merge to happen on the app-side workload reference too.
    const defaultRegistry = (window.CostEngine && window.CostEngine.DEFAULT_TOOLS_REGISTRY) || {};
    w.tools_registry = Object.assign({}, defaultRegistry, w.tools_registry || {});
    return w;
  }

  // Get/set nested values via "a.b.c" path
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      o[parts[i]] = o[parts[i]] || {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
  }

  // Hosting-dependent section visibility: hide Reservations when not API,
  // hide Self-host capacity when API/On-prem (where its GPU sizing math
  // doesn't apply). Reduces noise on the page.
  function updateHostingDependentVisibility(hosting) {
    const reservations = document.getElementById('sec-reservations');
    const selfhost     = document.getElementById('sec-selfhost');
    // Auto-expand a section when it becomes visible (so the user actually
    // sees the controls without hunting for the chevron). On collapse,
    // close it so a re-show doesn't pop open stale content.
    const setVis = (el, shouldShow) => {
      if (!el) return;
      const wasShown = el.style.display !== 'none';
      el.style.display = shouldShow ? '' : 'none';
      if (shouldShow && !wasShown) el.classList.add('open');
      else if (!shouldShow) el.classList.remove('open');
    };
    setVis(reservations, hosting === 'api' || hosting === 'hybrid');
    setVis(selfhost,     hosting === 'self' || hosting === 'hybrid');
  }

  // Grey-out sliders whose underlying engine path is silent in the current
  // hosting mode. Without this, users drag (e.g.) s-peak in API mode and
  // wonder why the headline doesn't budge. Mirrors the agent-topology lock
  // pattern: disabled + opacity + cursor + an sr-hint suffix so screen
  // readers + sighted users both get the "why".
  function applyHostingConditionalSliders(hosting) {
    const apiLike  = hosting === 'api' || hosting === 'hybrid';
    const selfLike = hosting === 'self' || hosting === 'hybrid' || hosting === 'onprem';
    const config = [
      { id: 's-peak',              active: selfLike, reason: 'disabled in API mode — only sizes self-host capacity' },
      { id: 'self-host-duty',      active: selfLike, reason: 'disabled in API mode — only sizes self-host capacity' },
      { id: 's-cache-write-share', active: apiLike,  reason: 'disabled in self-host — no provider-side cache-write surcharge' },
      { id: 's-batch',             active: apiLike,  reason: 'disabled in self-host — batch-tier discount is API-only' },
    ];
    config.forEach(({ id, active, reason }) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = !active;
      el.style.opacity = active ? '' : '0.45';
      el.style.cursor  = active ? '' : 'not-allowed';
      // sr-hint sibling lives inside the parent .sr block (s-peak, s-batch,
      // s-cache-write-share). self-host-duty has no .sr-hint — skip silently.
      const hint = el.parentElement && el.parentElement.querySelector
        ? el.parentElement.querySelector('.sr-hint')
        : null;
      if (hint) {
        if (hint.dataset.baseHint == null) hint.dataset.baseHint = hint.textContent;
        const base = hint.dataset.baseHint;
        hint.textContent = active ? base : `${base} · grey: ${reason}`;
      }
    });
  }

  // -----------------------------------------------------------------
  // Render the editor form from current workload
  // -----------------------------------------------------------------
  function renderEditor() {
    // Bind static fields
    document.querySelectorAll('[data-bind]').forEach(el => {
      const path = el.getAttribute('data-bind');
      const val = getPath(workload, path);
      if (el.type === 'checkbox') {
        el.checked = !!val;
      } else if (el.tagName === 'SELECT') {
        el.value = String(val == null ? '' : val);
      } else {
        el.value = val == null ? '' : val;
      }
      // Wire change handler once
      if (!el.dataset.bound) {
        el.dataset.bound = '1';
        el.addEventListener('input', () => {
          let v;
          if (el.type === 'checkbox') v = el.checked;
          else if (el.type === 'number') v = el.value === '' ? null : parseFloat(el.value);
          else if (el.tagName === 'SELECT' && (el.value === 'true' || el.value === 'false')) v = el.value === 'true';
          else v = el.value;
          setPath(workload, path, v);
          // Agent engineering: re-render so per-row phaseTotal + summary
          // recompute when duration / amortization / helper budget change.
          if (path.startsWith('agent_engineering.') && typeof renderAgentEngineeringList === 'function') {
            renderAgentEngineeringList();
          }
          renderPreview();
          renderRawJson();
        });
      }
    });

    renderShapesList();
    renderMixesList();
    // Segments are now owned by #audience-block in tab-config (rendered
    // by cost-simulator.js). The legacy renderSegmentsList() and its
    // sec-segments markup were removed 2026-06-09. Trigger an
    // audience-block re-render here to keep things in sync when the
    // calc-side editor refreshes for other reasons (preset switch,
    // hash restore, raw-JSON edit).
    window.__renderAudienceBlock?.();
    renderAgentsList();
    renderGpuList();
    renderInfraList();
    renderRateCardList();
    renderPersonnelList();
    renderAgentEngineeringList();
    renderMigrationList();
    renderToolsRegistry();
    populateModelDropdowns();
    populateMixDropdowns();
    populateGpuDropdown();
    renderRawJson();
  }

  // Tools registry renderer — inline-editable. Each row shows the tool's
  // label, cost shape, rate, token overhead (schema in prompt + average
  // result fed back to context), and provider. Built-in entries can have
  // their rates / token estimates overridden but not removed; custom
  // entries can be removed via the × button. The "+ Add custom tool"
  // affordance at the bottom creates a new entry with a generated id.
  function renderToolsRegistry() {
    const host = document.getElementById('tools-registry-list');
    if (!host) return;
    if (!workload.tools_registry) workload.tools_registry = {};
    const reg = workload.tools_registry;
    const entries = Object.entries(reg);
    const SHAPES = ['per_call', 'per_session', 'free'];
    // Collapsible card per tool, like the agent card pattern. Built-in
    // rows default collapsed (procurement reviewers rarely re-price the
    // OpenAI list rate); custom rows default expanded (user just added
    // it). Expansion state lives in a side Set so workload JSON stays
    // clean — no _expanded keys polluting the share URL.
    if (!window.__expandedTools) window.__expandedTools = new Set();
    const rateHint = (t) => {
      if (t.cost_shape === 'free' || !t.rate_usd) return 'free';
      if (t.cost_shape === 'per_session') return '$' + (t.rate_usd).toFixed(3) + '/sess';
      return '$' + (t.rate_usd * 1000).toFixed(2) + '/1k';
    };
    const rowHtml = (id, t) => {
      const expanded = window.__expandedTools.has(id);
      const label = (t.label || id).replace(/"/g,'&quot;');
      const desc = (t.description || '').replace(/"/g,'&quot;');
      return `
      <div data-tool-id="${id}" style="background:rgba(0,0,0,0.02);border:1px solid var(--rule);border-radius:5px;font-size:12px;overflow:hidden">
        <div data-tool-header="${id}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;cursor:pointer;user-select:none;${expanded ? 'border-bottom:1px solid var(--rule)' : ''}" title="Click to ${expanded ? 'collapse' : 'expand'}">
          <span style="display:inline-block;width:10px;font-family:var(--mono);color:var(--muted);transition:transform .15s;${expanded ? 'transform:rotate(90deg)' : ''}">▶</span>
          <strong style="flex:1;font-size:13px">${label}</strong>
          <span style="font-size:10px;padding:1px 6px;border-radius:3px;background:rgba(0,0,0,0.05);color:var(--ink-2,#3a4a62);font-weight:600">${t.cost_shape || 'per_call'}</span>
          <span style="font-size:11px;color:var(--ink-2,#3a4a62);font-family:var(--mono);min-width:80px;text-align:right">${rateHint(t)}</span>
          ${t.builtin
            ? '<span style="font-size:9px;color:var(--muted);padding:1px 5px;border:1px solid var(--rule);border-radius:3px">BUILTIN</span>'
            : `<button type="button" data-remove="${id}" onclick="event.stopPropagation()" style="background:none;border:1px solid var(--rule);color:var(--bad,#b3333d);font-size:13px;cursor:pointer;padding:1px 7px;border-radius:3px" title="Remove this tool">×</button>`}
        </div>
        <div data-tool-body="${id}" style="${expanded ? '' : 'display:none;'}padding:9px 10px">
          <input type="text" data-field="label" value="${label}" style="width:100%;font-size:13px;font-weight:600;padding:3px 6px;border:1px solid var(--rule);border-radius:3px;margin-bottom:6px" placeholder="Tool name" aria-label="Tool name">
          <input type="text" data-field="description" value="${desc}" style="width:100%;font-size:11px;color:var(--ink-2,#3a4a62);padding:3px 6px;border:1px dashed var(--rule);border-radius:3px;margin-bottom:8px" placeholder="(optional description — what does this tool do?)" aria-label="Tool description">
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(115px, 1fr));gap:6px">
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Cost shape</span>
              <select data-field="cost_shape" style="width:100%;font-size:11px;padding:3px 5px">
                ${SHAPES.map(s => `<option value="${s}" ${(t.cost_shape||'per_call')===s?'selected':''}>${s}</option>`).join('')}
              </select></label>
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Rate (USD)</span>
              <input type="number" min="0" step="0.001" data-field="rate_usd" value="${t.rate_usd || 0}" style="width:100%;font-size:12px;padding:3px 5px;font-family:var(--mono)" title="Your measured per-call cost in USD. Bills as cost_shape × rate × calls/query × queries/month (any rate > 0 bills, even if cost_shape='free'). Typical ranges:
• Self-hosted parser (parse_datetime, select_collection): $0 — pure compute, infra-absorbed
• Self-hosted geocode/STAC search: $0 (infra-absorbed) — $0.0001/call (derive: monthly infra $ / monthly queries)
• Managed geocode (Mapbox/Google Geocoding): ~$0.005/call
• Managed search (OpenAI File Search): $0.0025/call
• Managed web search (OpenAI/Anthropic grounding): ~$0.01/call
• Raster/stats compute (self-hosted): $0 (infra-absorbed) — $0.001/call (commercial COG service)
Self-hosted tools with fixed infrastructure should normally stay at $0 here (the infra line in the Infrastructure block already accounts for them); only enter a per-call rate if your tool is metered (managed API, per-query GPU minutes, etc.)."></label>
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Schema tok</span>
              <input type="number" min="0" step="10" data-field="schema_tokens" value="${t.schema_tokens || 0}" style="width:100%;font-size:12px;padding:3px 5px;font-family:var(--mono)" title="Tokens added to system prompt for this tool's schema"></label>
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Result tok avg</span>
              <input type="number" min="0" step="50" data-field="result_tokens_avg" value="${t.result_tokens_avg || 0}" style="width:100%;font-size:12px;padding:3px 5px;font-family:var(--mono)" title="Average tokens of tool result fed back to context (freeform path)"></label>
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Return shape <span title="Highest-leverage cost knob in tool-heavy agents — measured ~3–6× cost difference (templated vs freeform) on production geospatial-Q&amp;A workloads, with ~7.8× as a single-run upper bound on the heaviest configuration. Templated pattern: an agent wrapper layer routes every tool return through a fixed-shape response template (json.dumps({status, message, key_fields})) — zero engineering cost, large bill reduction." style="color:#f59e00;cursor:help;font-size:10px;text-transform:none;letter-spacing:0">✨</span></span>
              <select data-field="return_shape" style="width:100%;font-size:11px;padding:3px 5px" title="Freeform = full result tokens flow back into context. Templated = wrapper layer collapses result to Cap tok (status-only / id-only / summary). Note: per-tool changes only move the headline cost if an agent declares this tool in its enabled_tools — workload-mode presets without agents bill all tool work through the calibrated anchor_query (use the global Tool return shape dropdown in the topbar for those).">
                <option value="freeform" ${(t.return_shape||'freeform')==='freeform'?'selected':''}>freeform</option>
                <option value="templated" ${(t.return_shape||'freeform')==='templated'?'selected':''}>templated</option>
              </select></label>
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Cap tok</span>
              <input type="number" min="0" step="5" data-field="cap_tokens" value="${Number.isFinite(t.cap_tokens) ? t.cap_tokens : 40}" style="width:100%;font-size:12px;padding:3px 5px;font-family:var(--mono)" title="Effective result tokens when RETURN SHAPE is 'templated' (this tool's typical wrapper payload). Only affects cost while RETURN SHAPE = templated — changing this with shape=freeform is a no-op."></label>
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Memoize</span>
              <select data-field="memoize" style="width:100%;font-size:11px;padding:3px 5px" title="Same-session result memoization. Enable when this tool is called repeatedly with the same args in one session (file_search, db_query, wikipedia). Disable for tools that rarely repeat (web_search of current events). Needs HIT RATE > 0 to actually move cost — toggling Memoize on while HIT RATE = 0 is a no-op.">
                <option value="false" ${!t.memoize?'selected':''}>off</option>
                <option value="true" ${t.memoize?'selected':''}>on</option>
              </select></label>
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Hit rate</span>
              <input type="number" min="0" max="0.95" step="0.05" data-field="memoize_hit_rate" value="${Number.isFinite(t.memoize_hit_rate) ? t.memoize_hit_rate : 0}" style="width:100%;font-size:12px;padding:3px 5px;font-family:var(--mono)" title="Fraction of calls served from the local result cache (0.0–0.95). Typical: file_search ~0.4, db_query ~0.6, web_search ~0.05. Only affects cost while MEMOIZE = on — changing this with Memoize off is a no-op."></label>
            <label style="font-size:10px;color:var(--muted)"><span style="display:block;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px">Provider</span>
              <input type="text" data-field="provider" value="${(t.provider || 'managed').replace(/"/g,'&quot;')}" readonly tabindex="-1" style="width:100%;font-size:11px;padding:3px 5px;color:var(--muted);background:rgba(0,0,0,0.03);cursor:not-allowed" title="Informational only. Provider routing happens at the AGENT level (each agent picks its own hosting/provider); changing this per-tool name does NOT move cost. Edit the agent's hosting/model instead."></label>
          </div>
        </div>
      </div>
    `;};
    const headerHtml = `<div style="display:flex;align-items:center;justify-content:space-between;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;font-weight:600;padding:0 4px;margin-bottom:2px"><span>Registered tools (${entries.length})</span><span style="display:flex;gap:6px"><button type="button" id="tools-expand-all" style="background:none;border:1px solid var(--rule);font-size:9px;color:var(--muted);padding:1px 6px;border-radius:3px;cursor:pointer">Expand all</button><button type="button" id="tools-collapse-all" style="background:none;border:1px solid var(--rule);font-size:9px;color:var(--muted);padding:1px 6px;border-radius:3px;cursor:pointer">Collapse all</button></span></div>`;
    host.innerHTML = headerHtml + entries.map(([id, t]) => rowHtml(id, t)).join('') +
      `<button type="button" id="add-tool-btn" style="margin-top:4px;padding:5px 10px;border:1px dashed var(--cyan,#0c8db3);background:rgba(0,212,255,0.05);color:var(--cyan,#0c8db3);border-radius:3px;font-size:11px;cursor:pointer;font-weight:600">+ Add custom tool</button>`;

    // Wire collapsible headers
    host.querySelectorAll('[data-tool-header]').forEach(h => {
      h.addEventListener('click', () => {
        const tid = h.getAttribute('data-tool-header');
        if (window.__expandedTools.has(tid)) window.__expandedTools.delete(tid);
        else window.__expandedTools.add(tid);
        renderToolsRegistry();
      });
    });
    // Wire expand-all / collapse-all
    const expAll = document.getElementById('tools-expand-all');
    if (expAll) expAll.addEventListener('click', () => {
      entries.forEach(([id]) => window.__expandedTools.add(id));
      renderToolsRegistry();
    });
    const colAll = document.getElementById('tools-collapse-all');
    if (colAll) colAll.addEventListener('click', () => {
      window.__expandedTools.clear();
      renderToolsRegistry();
    });

    // Wire input bindings
    host.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('input', () => {
        const row = el.closest('[data-tool-id]');
        if (!row) return;
        const tid = row.dataset.toolId;
        const field = el.dataset.field;
        let v;
        if (el.tagName === 'INPUT' && el.type === 'number') v = parseFloat(el.value) || 0;
        else if (el.tagName === 'SELECT' && (el.value === 'true' || el.value === 'false')) v = el.value === 'true';
        else v = el.value;
        if (!workload.tools_registry[tid]) workload.tools_registry[tid] = {};
        workload.tools_registry[tid][field] = v;
        renderPreview();
      });
    });
    // Wire remove buttons
    host.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tid = btn.getAttribute('data-remove');
        if (!confirm(`Remove "${workload.tools_registry[tid].label || tid}" from the registry?`)) return;
        delete workload.tools_registry[tid];
        // Also clear any per-agent enabled_tools references to this id
        for (const ag of (workload.agents || [])) {
          if (ag.enabled_tools && ag.enabled_tools[tid]) delete ag.enabled_tools[tid];
        }
        renderToolsRegistry();
        renderPreview();
      });
    });
    // Wire add button
    const addBtn = document.getElementById('add-tool-btn');
    if (addBtn) addBtn.addEventListener('click', () => {
      // Generate a unique id
      let n = 1;
      while (workload.tools_registry['custom_tool_' + n]) n++;
      const newId = 'custom_tool_' + n;
      workload.tools_registry[newId] = {
        label: 'New custom tool',
        description: 'Edit this description',
        cost_shape: 'per_call',
        rate_usd: 0.005,
        schema_tokens: 100,
        result_tokens_avg: 500,
        provider: 'self-hosted',
        builtin: false,
      };
      // Auto-expand newly added tools so the user sees the edit fields.
      window.__expandedTools.add(newId);
      renderToolsRegistry();
      renderPreview();
    });

    // Keep the Section C header badge ("N agents · Y tools · M RAG") in
    // sync with the tools_registry mutations above. Without this, the
    // badge only refreshes when an agent is edited, so adding a tool in
    // Section B leaves a stale count in Section C until the next agent
    // interaction.
    if (typeof window.renderAgentSettingsSummary === 'function') {
      window.renderAgentSettingsSummary();
    }
  }

  function renderShapesList() {
    const list = document.getElementById('shapes-list');
    list.innerHTML = '';
    for (const [name, shape] of Object.entries(workload.shapes)) {
      const div = document.createElement('div');
      div.className = 'item';
      const safe = name.replace(/[^a-z0-9-]/gi, '_');
      div.innerHTML = `
        <button class="item-remove" data-shape-remove="${name}" aria-label="Remove shape ${name}">remove</button>
        <div class="item-title">${name}</div>
        <div class="row grid-3">
          <div><label for="shape-${safe}-input">Input factor</label><input id="shape-${safe}-input" type="number" min="0" step="0.01" value="${shape.input_factor}" data-shape="${name}" data-key="input_factor"></div>
          <div><label for="shape-${safe}-output">Output factor</label><input id="shape-${safe}-output" type="number" min="0" step="0.01" value="${shape.output_factor}" data-shape="${name}" data-key="output_factor"></div>
          <div><label for="shape-${safe}-cache">Cache eligible</label><select id="shape-${safe}-cache" data-shape="${name}" data-key="cache_eligible"><option value="true"${shape.cache_eligible?' selected':''}>yes</option><option value="false"${!shape.cache_eligible?' selected':''}>no</option></select></div>
        </div>
        <div class="row"><label for="shape-${safe}-desc">Description</label><input id="shape-${safe}-desc" type="text" value="${shape.description || ''}" data-shape="${name}" data-key="description"></div>
      `;
      list.appendChild(div);
    }
    list.querySelectorAll('[data-shape]').forEach(el => {
      el.addEventListener('input', () => {
        const name = el.dataset.shape;
        const key = el.dataset.key;
        const val = el.tagName === 'SELECT' && (el.value === 'true' || el.value === 'false')
          ? el.value === 'true'
          : (el.type === 'number' ? parseFloat(el.value) : el.value);
        if (workload.shapes[name]) workload.shapes[name][key] = val;
        renderPreview();
        renderRawJson();
      });
    });
    list.querySelectorAll('[data-shape-remove]').forEach(b => {
      b.addEventListener('click', (e) => {
        const name = e.target.dataset.shapeRemove;
        delete workload.shapes[name];
        // Also strip from any mix weights
        for (const mix of Object.values(workload.mix)) {
          if (mix.weights) delete mix.weights[name];
        }
        renderEditor();
        renderPreview();
      });
    });
  }

  function renderMixesList() {
    const list = document.getElementById('mixes-list');
    list.innerHTML = '';
    for (const [name, mix] of Object.entries(workload.mix)) {
      const safe = name.replace(/[^a-z0-9-]/gi, '_');
      const weightsHtml = Object.keys(workload.shapes).map(shape => {
        const safeShape = shape.replace(/[^a-z0-9-]/gi, '_');
        return `
        <div>
          <label for="mix-${safe}-weight-${safeShape}">${shape}</label>
          <input id="mix-${safe}-weight-${safeShape}" type="number" step="0.01" min="0" max="1" value="${mix.weights[shape] != null ? mix.weights[shape] : 0}" data-mix="${name}" data-shape="${shape}">
        </div>
      `;
      }).join('');
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <button class="item-remove" data-mix-remove="${name}" aria-label="Remove mix ${name}">remove</button>
        <div class="item-title">${name}</div>
        <div class="row"><label for="mix-${safe}-label">Label</label><input id="mix-${safe}-label" type="text" value="${mix.label || ''}" data-mix-label="${name}"></div>
        <div class="row grid-${Math.min(4, Math.max(2, Object.keys(workload.shapes).length))}">${weightsHtml}</div>
      `;
      list.appendChild(div);
    }
    list.querySelectorAll('[data-mix][data-shape]').forEach(el => {
      el.addEventListener('input', () => {
        const m = el.dataset.mix, s = el.dataset.shape;
        workload.mix[m].weights[s] = parseFloat(el.value) || 0;
        renderPreview();
        renderRawJson();
      });
    });
    list.querySelectorAll('[data-mix-label]').forEach(el => {
      el.addEventListener('input', () => {
        workload.mix[el.dataset.mixLabel].label = el.value;
        renderRawJson();
      });
    });
    list.querySelectorAll('[data-mix-remove]').forEach(b => {
      b.addEventListener('click', (e) => {
        delete workload.mix[e.target.dataset.mixRemove];
        renderEditor();
        renderPreview();
      });
    });
  }

  // renderSegmentsList — REMOVED 2026-06-09. Audience editing moved
  // to #audience-block in tab-config (owned by cost-simulator.js's
  // renderAudienceBlock()). Single canonical UI. The block reads/writes
  // workload.segments[] directly and keeps the hidden s-users /
  // s-sessions / s-turns slider inputs in sync with the aggregate so
  // downstream code that polls those IDs keeps working unchanged.

  // Common multi-agent pipeline templates
  const AGENT_TEMPLATES = {
    rag: [
      { id: 'planner',    label: 'Query planner',     input_tokens: 1500, output_tokens: 200, calls_per_query: 1, model: null,           cache_eligible: true,  description: 'Decides retrieval strategy and routes to tools.' },
      { id: 'retriever',  label: 'Retriever (rerank)',input_tokens: 2000, output_tokens: 100, calls_per_query: 1, model: 'gpt-5-nano',   cache_eligible: false, description: 'Reranks documents from vector search.' },
      { id: 'answerer',   label: 'Answer generator',  input_tokens: 4000, output_tokens: 600, calls_per_query: 1, model: null,           cache_eligible: true,  description: 'Composes the final answer from retrieved docs.' },
    ],
    multi: [
      { id: 'orchestr',   label: 'Orchestrator',      input_tokens: 2000, output_tokens: 300, calls_per_query: 1, model: null,           cache_eligible: true,  description: 'Top-level planner; routes to sub-agents.' },
      { id: 'subagent_a', label: 'Sub-agent A (data)',input_tokens: 1500, output_tokens: 200, calls_per_query: 2, model: 'gpt-5-mini',   cache_eligible: true,  description: 'Specialized data-gathering sub-agent.' },
      { id: 'subagent_b', label: 'Sub-agent B (synth)', input_tokens: 3000, output_tokens: 400, calls_per_query: 1, model: null,         cache_eligible: true,  description: 'Synthesizes results from sub-agents.' },
      { id: 'critic',     label: 'Critic / reviewer', input_tokens: 1200, output_tokens: 150, calls_per_query: 1, model: 'gpt-5-mini',   cache_eligible: false, description: 'Reviews and refines the final answer.' },
    ],
    tool: [
      { id: 'planner',    label: 'Tool planner',      input_tokens: 1200, output_tokens: 200, calls_per_query: 1, model: null,           cache_eligible: true,  description: 'Picks which tool(s) to call.' },
      { id: 'caller',     label: 'Tool-call generator', input_tokens: 800,  output_tokens: 150, calls_per_query: 2, model: 'gpt-5-mini', cache_eligible: false, description: 'Formulates each tool call (DB query, API params).' },
      { id: 'answerer',   label: 'Answer composer',   input_tokens: 3500, output_tokens: 500, calls_per_query: 1, model: null,           cache_eligible: true,  description: 'Composes answer from tool results.' },
    ],
    hybrid: [
      { id: 'planner',    label: 'Planner',           input_tokens: 2000, output_tokens: 300, calls_per_query: 1, model: null,           cache_eligible: true,  description: 'Decides retrieval + tool strategy.' },
      { id: 'retriever',  label: 'Retriever',         input_tokens: 2000, output_tokens: 100, calls_per_query: 1, model: 'gpt-5-nano',   cache_eligible: false, description: 'Vector search + rerank.' },
      { id: 'tool',       label: 'Tool agent',        input_tokens: 1000, output_tokens: 200, calls_per_query: 2, model: 'gpt-5-mini',   cache_eligible: false, description: 'Calls databases or external APIs.' },
      { id: 'answerer',   label: 'Answer generator',  input_tokens: 4500, output_tokens: 700, calls_per_query: 1, model: null,           cache_eligible: true,  description: 'Composes the final answer from docs + tools.' },
      { id: 'verifier',   label: 'Fact verifier',     input_tokens: 1500, output_tokens: 100, calls_per_query: 1, model: 'gpt-5-mini',   cache_eligible: false, description: 'Checks claims against retrieved docs.' },
    ],
  };

  function updateAgentModeBanner() {
    const banner = document.getElementById('agents-mode-banner');
    const shapesSec = document.getElementById('sec-shapes');
    const mixSec = document.getElementById('sec-mix');
    const active = Array.isArray(workload.agents) && workload.agents.length > 0;
    if (banner) banner.style.display = active ? '' : 'none';
    if (shapesSec) shapesSec.classList.toggle('mode-disabled', active);
    if (mixSec) mixSec.classList.toggle('mode-disabled', active);
  }

  function renderAgentsList() {
    const list = document.getElementById('agents-list');
    if (!list) return;
    list.innerHTML = '';
    if (!Array.isArray(workload.agents)) workload.agents = [];
    updateAgentModeBanner();
    const models = Object.keys(Object.assign({}, CostEngine.DEFAULT_RATE_CARDS, workload.rate_cards || {}));
    workload.agents.forEach((agent, idx) => {
      const div = document.createElement('div');
      div.className = 'item';
      const modelOpts = ['<option value="">(use main model)</option>']
        .concat(models.map(m => `<option value="${m}"${agent.model === m ? ' selected' : ''}>${m}</option>`))
        .join('');
      const hosting = agent.hosting || 'api';
      const hostingHint = {
        'api': '',
        'byok': '<em style="color:var(--accent);">Excluded from API cost — user provides their own key.</em>',
        'self-host': '<em style="color:var(--accent);">Excluded from API cost — counted in the self-host section.</em>',
      }[hosting] || '';

      div.innerHTML = `
        <button class="item-remove" data-agent-remove="${idx}">remove</button>
        <div class="item-title">${agent.label || agent.id || ('agent ' + (idx + 1))}</div>
        <div class="row grid-2">
          <div><label>Agent ID</label><input type="text" value="${agent.id || ''}" data-agent="${idx}" data-key="id"></div>
          <div><label>Display label</label><input type="text" value="${agent.label || ''}" data-agent="${idx}" data-key="label"></div>
        </div>
        <div class="row grid-3">
          <div><label>Input tokens / call</label><input type="number" value="${agent.input_tokens || 0}" data-agent="${idx}" data-key="input_tokens"></div>
          <div><label>Output tokens / call</label><input type="number" value="${agent.output_tokens || 0}" data-agent="${idx}" data-key="output_tokens"></div>
          <div><label>Calls per user query</label><input type="number" step="0.1" value="${agent.calls_per_query != null ? agent.calls_per_query : 1}" data-agent="${idx}" data-key="calls_per_query"></div>
        </div>
        <div class="row grid-2">
          <div><label>Sysprompt tokens <em>(amortized across calls)</em> <span class="tip" data-tip="### Sysprompt tokens (per agent)

**What it is:** the role description, tool catalog, decision rules, and any persistent instructions sent to the LLM at the start of every call by this specific agent.

**Why it varies per agent**
- **Orchestrator / supervisor:** 1500–3000 tok (full role description + tool list + routing rules + when to delegate)
- **Worker / specialist:** 200–500 tok (focused task description, no tool catalog if they don't have tools)
- **Tool-runner only:** 100–200 tok (just 'run this tool, return result')

**Why per-agent matters**
Previously this was workload-wide (s-sysprompt), applied uniformly to every agent. Using one number is wrong by 5–10× for heterogeneous fleets (orchestrator's 3000-tok sysprompt vs worker's 300-tok). The engine amortizes by calls_per_query (it's a stable prefix that benefits from prompt cache, doesn't repeat per turn).">ⓘ</span></label><input type="number" min="0" step="50" value="${agent.sysprompt_tokens || 0}" data-agent="${idx}" data-key="sysprompt_tokens"></div>
          <div><label>Inter-agent msg tokens / call <em>(handoff overhead)</em> <span class="tip" data-tip="### Inter-agent message tokens (per call)

**What it is:** tokens this agent sends to / receives from peer agents on each call. Counted as input on top of the agent's normal input_tokens.

**Why it varies by role**
- **Orchestrator → workers:** short (~50 tok per handoff — 'do X with these args')
- **Workers → orchestrator:** long (~200+ tok per response — full result summary)
- **Peer mesh:** symmetric ~150 tok each direction
- **Pipeline (sequential stages):** Σ prior stage outputs accumulate

**Why per-agent matters**
The workload-wide s-iamsg slider treats every agent's handoff cost as identical. In real fleets the orchestrator's outbound messages are tiny while the synthesizer's inbound messages are large — applying one constant misprices the fleet.">ⓘ</span></label><input type="number" min="0" step="20" value="${agent.iamsg_tokens || 0}" data-agent="${idx}" data-key="iamsg_tokens"></div>
        </div>
        <div class="row grid-2">
          <div>
            <label>LLM calls / turn multiplier <em>(ReAct / reflection)</em> <span class="tip" data-tip="### LLM calls / turn multiplier (ReAct loop expansion)

**What it is:** how many LLM calls this agent fires per logical 'turn' the user sees. The engine bills calls_per_query × multiplier per query.

**Typical values**
- **1.0** (default): simple chat — one prompt, one response
- **3–5**: ReAct loop (think → act → observe → think → act → final)
- **5–8**: deep reflection / self-critique (initial answer → critique → revise → critique → finalize)
- **10+**: agentic exploration (long-running task with many tool roundtrips)

**Why it matters for cost**
A ReAct loop with 4 inner calls bills 4× the per-call cost. Sysprompt amortization stays correct (the cached prefix benefits every inner iteration), but per-turn input + output bills compound. This is a common pre-shipping surprise — designers build 'just one turn per query' and discover the agent loops 5× before responding.

**Reference**
Yao et al. (ReAct, 2022) — formalized the think-act-observe loop. Production ReAct agents (e.g. Devin, Claude Code subagents) commonly run 5-20 inner LLM calls per user-visible turn.">ⓘ</span></label>
            <input type="number" min="0.1" step="0.5" value="${agent.calls_per_turn_multiplier || 1.0}" data-agent="${idx}" data-key="calls_per_turn_multiplier">
          </div>
          <div>
            <label>Activation rate <em>(0–1, fraction of queries this agent runs on)</em> <span class="tip" data-tip="### Activation rate (per agent)

**What it is:** fraction of queries this agent actually runs on. 1.0 = always (default). 0.3 = fires on 30% of queries.

**When to use < 1.0**
- **Conditional agents** that fire only on specific request types (Image-Enhancer fires when the user uploads / mentions images → 0.3)
- **Auth-gated agents** that only run for authenticated users (Compliance agent → 0.65 if 65% of traffic is authenticated)
- **Rare-path specialists** (Refund-handler fires on the 5% of support tickets requesting refunds → 0.05)
- **Quality-gated agents** that only fire when the previous stage flagged uncertainty (Fact-checker → 0.10 for audit sampling)

**Why this matters**
Without activation_rate, the only way to model a conditional agent was to either omit it (loses traceability) or fake it with fractional calls_per_query (ugly and breaks the per-call cost intuition).

**Math**
Engine multiplies this agent's monthly contribution by activation_rate. Per-(agent,tool) trigger_rate inside enabled_tools chains on top — total effective fires = activation_rate × calls_per_query × trigger_rate per tool.">ⓘ</span></label>
            <input type="number" min="0" max="1" step="0.05" value="${agent.activation_rate != null ? agent.activation_rate : 1}" data-agent="${idx}" data-key="activation_rate">
          </div>
        </div>
        <div class="row" style="margin-top:6px;padding:6px 8px;background:rgba(120,180,255,0.06);border:1px solid rgba(120,180,255,0.18);border-radius:5px">
          <div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:5px">
            <input type="checkbox" id="agent-${idx}-verify-enabled" data-agent="${idx}" data-key="verify_enabled" ${agent.verify_enabled ? 'checked' : ''} style="margin:0">
            <label for="agent-${idx}-verify-enabled" style="margin:0;cursor:pointer">Fact-check this agent's output</label>
            <span class="tip" data-tip="### Per-agent fact-checking

**When to enable**
Turn ON for agents that produce user-facing factual claims that need verification — typically:
- **Synthesizer / Reporter** agents (compose the final answer)
- **Research** agents (extract claims from sources)
- **Customer-facing** agents that quote policies, prices, dates

**When to leave OFF (the default)**
- **Orchestrators / Routers** — they don't generate facts, just route tasks
- **Tool-executors** — return raw data, not interpretations
- **Internal pipeline stages** that hand off to a later agent which IS fact-checked

**The latency trap**
FactReasoner FR2 takes ~60s per response. Putting it on every agent's output blocks the user for 60s × N agents. The per-agent toggle lets you fact-check only the FINAL user-facing output (typically just one agent).

**Why this matters for cost**
Verification cost = monthly_outputs × coverage × per-output_cost. Setting verify_enabled only on the reporter agent (one of three) cuts verification spend by ~3×. Combined with verifier_override (use MiniCheck inline on the orchestrator, FR2 audit-sample on the reporter), you can match production latency budgets while still catching hallucinations.">ⓘ</span>
            <span style="font-size:10px;color:var(--dim)">(default off — orchestrators and tool-executors rarely produce checkable claims)</span>
          </div>
          ${agent.verify_enabled ? `
          <div class="row grid-2" style="margin-top:4px">
            <div>
              <label for="agent-${idx}-verify-coverage" style="font-size:11px">Coverage override <em>(0–1, blank = workload default)</em> <span class="tip" data-tip="### Per-agent coverage override

Fraction of THIS agent's outputs sampled for fact-checking. Leave blank to inherit the workload-wide coverage from the Fact-checking section (typically 0.10 for audit sampling).

**When to override**
- **User-facing final answers** → coverage = 1.0 (check every reply)
- **Internal pipeline outputs** → coverage = 0.05 (occasional spot-check)
- **Production-critical agents** (clinical, financial) → coverage = 1.0
- **Audit-only mode** → coverage = 0.10 (paper default)

Engine math: verified_outputs = monthly_queries × agent.calls_per_query × this_coverage. Each verified output runs the chosen verifier preset once.">ⓘ</span></label>
              <input id="agent-${idx}-verify-coverage" type="number" min="0" max="1" step="0.05" value="${agent.verify_coverage != null ? agent.verify_coverage : ''}" data-agent="${idx}" data-key="verify_coverage" placeholder="(use workload coverage)" style="font-size:12px">
            </div>
            <div>
              <label for="agent-${idx}-verifier-override" style="font-size:11px">Verifier override <em>(blank = workload preset)</em> <span class="tip" data-tip="### Per-agent verifier override

Pick a DIFFERENT verifier preset for this agent than the workload-wide default. Leave blank to use the preset configured in the Fact-checking section.

**Common mixed setups**
- **Orchestrator** (fast inline gate): MiniCheck (~1s, 1 NLI call)
- **Researcher** (medium audit): FactReasoner FR1 (~10s, 24 NLI calls)
- **Reporter** (deep audit): FactReasoner FR2 (~60s, 160 NLI calls)
- **Compliance agent** (strict): FactReasoner FR3 (~120s, 350 NLI calls)

**Latency badges** in the dropdown:
- ✓ inline = sub-5s, can block per-turn (MiniCheck, Patronus, RAGAS)
- ⚠ audit = 10–60s, run async on a sample (FR1, FR2, FactScore)
- ⚠ batch = 60s+, nightly/offline only (FR3)

**Cost spread**
FR2 (160 NLI calls/query) ≈ 160× MiniCheck per check. At equal coverage, FR2 is 160× the LLM bill — picking inline-class verifiers for high-coverage agents saves ~99% of verification spend.">ⓘ</span></label>
              <select id="agent-${idx}-verifier-override" data-agent="${idx}" data-key="verifier_override" style="font-size:12px">
                <option value="">(use workload preset)</option>
                ${Object.entries((window.CostEngine && window.CostEngine.VERIFIER_PRESETS) || {}).map(([k, p]) => {
                  const badge = p.latency_class === 'inline' ? '✓ inline' : p.latency_class === 'audit' ? '⚠ audit (~' + p.latency_sec + 's)' : '⚠ batch (~' + p.latency_sec + 's)';
                  return `<option value="${k}" ${agent.verifier_override === k ? 'selected' : ''}>${p.label} — ${badge}</option>`;
                }).join('')}
              </select>
            </div>
          </div>
          <div class="row grid-2" style="margin-top:6px;padding-top:6px;border-top:1px dashed rgba(120,180,255,0.25)">
            <div>
              <label for="agent-${idx}-verify-escalate-to" style="font-size:11px">Cascade to <em>(escalate flagged to deeper verifier — blank = no cascade)</em> <span class="tip" data-tip="### Cascading verification (production pattern)

**The idea:** primary verifier runs fast on every output; a SECONDARY (slower, deeper) verifier only runs on the fraction flagged by the primary. Cost = (fast × 100%) + (slow × escalate_rate).

**Why it matters**
A flat 'always use FR2' on 100% of outputs costs ~$100 per 1000 outputs. A cascade of MiniCheck → FR2-on-10%-flagged costs ~$10 + $10 = $20 per 1000 — **5× cheaper** at the same final quality (because FR2 only runs on ambiguous cases).

**Common production patterns**
- **MiniCheck → FR2** — Claude Code subagents' default. Catches 90% with fast NLI; FR2 deep-checks the ambiguous 10%.
- **Anthropic citations (inline) → FactReasoner FR2** — Inline citation hint is free; FR2 audits a sample.
- **Patronus → FactReasoner FR3** — Commercial fast check + nightly batch deep audit.

**How escalate_rate is set in real systems**
Production teams measure their primary's confidence-score distribution; escalate_rate = fraction below confidence threshold. Typical 5–20%. Higher rates indicate the primary is too lax — tune the threshold.

**Default (blank)**: no cascade. Single verifier runs on all verified outputs.">ⓘ</span></label>
              <select id="agent-${idx}-verify-escalate-to" data-agent="${idx}" data-key="verify_escalate_to" style="font-size:12px">
                <option value="">(no cascade)</option>
                ${Object.entries((window.CostEngine && window.CostEngine.VERIFIER_PRESETS) || {}).map(([k, p]) => {
                  const badge = p.latency_class === 'inline' ? '✓ inline' : p.latency_class === 'audit' ? '⚠ audit (~' + p.latency_sec + 's)' : '⚠ batch (~' + p.latency_sec + 's)';
                  return `<option value="${k}" ${agent.verify_escalate_to === k ? 'selected' : ''}>${p.label} — ${badge}</option>`;
                }).join('')}
              </select>
            </div>
            <div>
              <label for="agent-${idx}-verify-escalate-rate" style="font-size:11px">Escalate rate <em>(0–1, fraction the primary flags)</em></label>
              <input id="agent-${idx}-verify-escalate-rate" type="number" min="0" max="1" step="0.05" value="${agent.verify_escalate_rate != null ? agent.verify_escalate_rate : ''}" data-agent="${idx}" data-key="verify_escalate_rate" placeholder="0.10 (typical)" style="font-size:12px" title="Fraction of outputs the primary verifier flags as ambiguous → escalated to the secondary. Typical 0.05–0.20. Default 0.10 if blank.">
            </div>
          </div>` : ''}
        </div>
        <div class="row grid-3">
          <div>
            <label>Hosting <em>(who pays?)</em></label>
            <select data-agent="${idx}" data-key="hosting">
              <option value="api"${hosting === 'api' ? ' selected' : ''}>API (this calc pays)</option>
              <option value="byok"${hosting === 'byok' ? ' selected' : ''}>BYOK (user pays)</option>
              <option value="self-host"${hosting === 'self-host' ? ' selected' : ''}>Self-host (GPU)</option>
            </select>
          </div>
          <div><label>Model override</label><select data-agent="${idx}" data-key="model">${modelOpts}</select></div>
          <div><label>Cache eligible?</label><select data-agent="${idx}" data-key="cache_eligible"><option value="true"${agent.cache_eligible?' selected':''}>yes</option><option value="false"${!agent.cache_eligible?' selected':''}>no</option></select></div>
        </div>
        ${hostingHint ? `<div class="row" style="font-size:11px;margin-top:-2px;">${hostingHint}</div>` : ''}
        <div class="row"><label>Description <em>(optional)</em></label><input type="text" value="${(agent.description || '').replace(/"/g,'&quot;')}" data-agent="${idx}" data-key="description"></div>
      `;
      list.appendChild(div);
    });
    list.querySelectorAll('[data-agent]').forEach(el => {
      const handler = () => {
        const idx = parseInt(el.dataset.agent, 10);
        const key = el.dataset.key;
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.tagName === 'SELECT' && (el.value === 'true' || el.value === 'false')) v = el.value === 'true';
        else if (el.value === '') {
          // Blank values: nullable for the optional per-agent verify fields
          // (so the engine falls back to workload defaults). Otherwise treat
          // model as null and numeric fields as 0.
          if (key === 'model' || key === 'verifier_override' || key === 'verify_coverage'
              || key === 'verify_escalate_to' || key === 'verify_escalate_rate') v = null;
          else v = 0;
        }
        else if (el.type === 'number') v = parseFloat(el.value) || 0;
        else v = el.value;
        if (v === null) delete workload.agents[idx][key];
        else workload.agents[idx][key] = v;
        // Hosting and verify_enabled changes need a full re-render to update
        // visibility of dependent rows (hint text / verify coverage + override).
        if (key === 'hosting' || key === 'verify_enabled') renderAgentsList();
        // Mirror procurement-side Hosting change back to simulator-side
        // Section C agent.provider so the per-agent Provider dropdown +
        // header BYOK badge stay in sync with whichever editor the user
        // touched first. Reverse of cost-simulator.js's provider→hosting
        // mirror; together they make the two editors bidirectional.
        if (key === 'hosting' && window.sim?.agents?.[idx]) {
          const providerByHosting = { byok: 'byok', 'self-host': 'self-hosted' };
          const target = providerByHosting[v]
            || (['byok','self-hosted'].includes(window.sim.agents[idx].provider) ? 'managed' : window.sim.agents[idx].provider);
          window.sim.agents[idx].provider = target;
          if (typeof window.renderAgents === 'function') window.renderAgents();
        }
        renderPreview();
        renderRawJson();
      };
      el.addEventListener('input', handler);
      // Checkboxes don't fire 'input' in some older browsers; register
      // 'change' as a belt-and-braces backup.
      if (el.type === 'checkbox') el.addEventListener('change', handler);
    });
    list.querySelectorAll('[data-agent-remove]').forEach(b => {
      b.addEventListener('click', e => {
        workload.agents.splice(parseInt(e.target.dataset.agentRemove, 10), 1);
        renderEditor();
        renderPreview();
      });
    });
  }

  function renderGpuList() {
    const list = document.getElementById('gpu-list');
    if (!list) return;
    list.innerHTML = '';
    const opts = workload.self_host.gpu_options || {};
    const activeGpu = (document.getElementById('prev-gpu') || {}).value || Object.keys(opts)[0];
    for (const [id, gpu] of Object.entries(opts)) {
      const isActive = id === activeGpu;
      const div = document.createElement('div');
      div.className = 'item gpu-card' + (isActive ? ' active' : '');
      div.title = isActive ? 'Currently selected in Scenario controls' : '';
      const safe = id.replace(/[^a-z0-9-]/gi, '_');
      div.innerHTML = `
        <button class="item-remove" data-gpu-remove="${id}" aria-label="Remove GPU ${id}">remove</button>
        <div class="item-title">
          ${isActive ? '<span class="rc-dot" title="Active"></span>' : ''}
          ${id} <span style="color: var(--muted); font-weight: 400;">· ${gpu.name || ''}</span>
        </div>
        <div class="row grid-3">
          <div><label for="gpu-${safe}-hourly">$ / hour</label><input id="gpu-${safe}-hourly" type="number" step="0.01" value="${gpu.hourly}" data-gpu="${id}" data-key="hourly"></div>
          <div><label for="gpu-${safe}-tput_tps">Throughput tok/s</label><input id="gpu-${safe}-tput_tps" type="number" value="${gpu.tput_tps}" data-gpu="${id}" data-key="tput_tps"></div>
          <div><label for="gpu-${safe}-capable">Capable</label><input id="gpu-${safe}-capable" type="text" value="${gpu.capable || ''}" data-gpu="${id}" data-key="capable"></div>
        </div>
        <div class="row"><label for="gpu-${safe}-name">Hardware label</label><input id="gpu-${safe}-name" type="text" value="${gpu.name || ''}" data-gpu="${id}" data-key="name"></div>
      `;
      list.appendChild(div);
    }
    list.querySelectorAll('[data-gpu]').forEach(el => {
      el.addEventListener('input', () => {
        const id = el.dataset.gpu, key = el.dataset.key;
        const v = el.type === 'number' ? parseFloat(el.value) || 0 : el.value;
        if (workload.self_host.gpu_options[id]) workload.self_host.gpu_options[id][key] = v;
        renderPreview(); renderRawJson();
      });
    });
    list.querySelectorAll('[data-gpu-remove]').forEach(b => {
      b.addEventListener('click', e => {
        delete workload.self_host.gpu_options[e.target.dataset.gpuRemove];
        renderEditor(); renderPreview();
      });
    });
  }

  function renderInfraList() {
    const list = document.getElementById('infra-list');
    if (!list) return;
    list.innerHTML = '';
    const items = workload.infrastructure || {};
    for (const [name, value] of Object.entries(items)) {
      const div = document.createElement('div');
      div.className = 'item';
      const isObj = typeof value === 'object' && value !== null;
      const displayCost = isObj ? (value.flat != null ? value.flat : '—') : value;
      const scalingActive = isObj && value.per != null && value.per !== 'flat';
      const per = isObj ? (value.per || 'flat') : 'flat';
      const rate = isObj ? (value.rate != null ? value.rate : '') : '';
      const gb = isObj && value.gb != null ? value.gb : '';
      const safe = name.replace(/[^a-z0-9-]/gi, '_');
      div.innerHTML = `
        <button class="item-remove" data-infra-remove="${encodeURIComponent(name)}" aria-label="Remove infrastructure line ${name}">remove</button>
        <div class="row grid-2">
          <div><label for="infra-${safe}-name">Service / Component</label><input id="infra-${safe}-name" type="text" value="${name.replace(/"/g, '&quot;')}" data-infra-name="${encodeURIComponent(name)}"></div>
          <div><label for="infra-${safe}-cost">${scalingActive ? 'Computed monthly $' : 'Monthly $'} <span class="tip" data-tip="Flat = fixed $/mo. Toggle scaling to compute as a rate × your monthly query volume (S3, CloudWatch, NAT egress, etc.).">ⓘ</span></label>
            <input id="infra-${safe}-cost" type="number" step="1" value="${displayCost}" data-infra-cost="${encodeURIComponent(name)}" ${scalingActive ? 'disabled style="background:var(--card2, rgba(0,0,0,0.04)); color:var(--muted); cursor:not-allowed;"' : ''}>
          </div>
        </div>
        <div class="row" style="margin-top: 4px;">
          <label for="infra-${safe}-scaling" style="font-size: 11px; color: var(--muted);">Scaling
            <select id="infra-${safe}-scaling" data-infra-scaling="${encodeURIComponent(name)}" style="font-family: var(--mono); font-size: 11px; padding: 2px 6px; margin-left: 4px;">
              <option value="flat" ${per === 'flat' ? 'selected' : ''}>Flat $/mo</option>
              <option value="per_query" ${per === 'per_query' ? 'selected' : ''}>$ per query</option>
              <option value="per_1k_queries" ${per === 'per_1k_queries' ? 'selected' : ''}>$ per 1K queries</option>
              <option value="per_million_queries" ${per === 'per_million_queries' ? 'selected' : ''}>$ per 1M queries</option>
              <option value="per_gb_per_query" ${per === 'per_gb_per_query' ? 'selected' : ''}>$/GB × queries × GB/q</option>
              <option value="per_mau" ${per === 'per_mau' ? 'selected' : ''}>$ per active user / mo (CDN, hosting)</option>
              <option value="per_session" ${per === 'per_session' ? 'selected' : ''}>$ per session (Vercel, serverless)</option>
            </select>
          </label>
          ${scalingActive ? `
            <span style="margin-left: 8px;"><label for="infra-${safe}-rate" style="font-size: 11px;">Rate $</label>
              <input id="infra-${safe}-rate" type="number" step="0.0001" value="${rate}" data-infra-rate="${encodeURIComponent(name)}" style="width: 90px; font-family: var(--mono); font-size: 11px;">
            </span>
            ${per === 'per_gb_per_query' ? `
              <span style="margin-left: 8px;"><label for="infra-${safe}-gb" style="font-size: 11px;">GB/q</label>
                <input id="infra-${safe}-gb" type="number" step="0.0001" value="${gb}" data-infra-gb="${encodeURIComponent(name)}" style="width: 90px; font-family: var(--mono); font-size: 11px;">
              </span>` : ''}
          ` : ''}
        </div>
      `;
      list.appendChild(div);
    }
    // Cost input (only active when flat)
    list.querySelectorAll('[data-infra-cost]').forEach(el => {
      el.addEventListener('input', () => {
        const name = decodeURIComponent(el.dataset.infraCost);
        workload.infrastructure[name] = parseFloat(el.value) || 0;
        renderPreview(); renderRawJson();
      });
    });
    // Scaling dropdown
    list.querySelectorAll('[data-infra-scaling]').forEach(el => {
      el.addEventListener('change', () => {
        const name = decodeURIComponent(el.dataset.infraScaling);
        const newPer = el.value;
        if (newPer === 'flat') {
          // Convert back to plain number, preserving the most recent computed value if available
          const cur = workload.infrastructure[name];
          const fallback = (typeof cur === 'object' && cur && cur.flat != null) ? cur.flat : 0;
          workload.infrastructure[name] = fallback;
        } else {
          // Convert to scaling object, preserving rate if any
          const cur = workload.infrastructure[name];
          const obj = typeof cur === 'object' && cur ? Object.assign({}, cur) : {};
          obj.per = newPer;
          if (obj.rate == null) obj.rate = 0;
          if (newPer === 'per_gb_per_query' && obj.gb == null) obj.gb = 0.001;
          workload.infrastructure[name] = obj;
        }
        renderInfraList();
        renderPreview();
        renderRawJson();
      });
    });
    list.querySelectorAll('[data-infra-rate]').forEach(el => {
      el.addEventListener('input', () => {
        const name = decodeURIComponent(el.dataset.infraRate);
        const cur = workload.infrastructure[name];
        if (typeof cur === 'object' && cur) {
          cur.rate = parseFloat(el.value) || 0;
          renderPreview(); renderRawJson();
        }
      });
    });
    list.querySelectorAll('[data-infra-gb]').forEach(el => {
      el.addEventListener('input', () => {
        const name = decodeURIComponent(el.dataset.infraGb);
        const cur = workload.infrastructure[name];
        if (typeof cur === 'object' && cur) {
          cur.gb = parseFloat(el.value) || 0;
          renderPreview(); renderRawJson();
        }
      });
    });
    list.querySelectorAll('[data-infra-name]').forEach(el => {
      el.addEventListener('change', () => {
        const oldName = decodeURIComponent(el.dataset.infraName);
        const newName = el.value.trim();
        if (!newName || newName === oldName) return;
        if (workload.infrastructure[newName] != null) { alert('Name already in use'); el.value = oldName; return; }
        workload.infrastructure[newName] = workload.infrastructure[oldName];
        delete workload.infrastructure[oldName];
        renderEditor(); renderPreview();
      });
    });
    list.querySelectorAll('[data-infra-remove]').forEach(b => {
      b.addEventListener('click', e => {
        delete workload.infrastructure[decodeURIComponent(e.target.dataset.infraRemove)];
        renderEditor(); renderPreview();
      });
    });
  }

  // Human-readable labels for the snake_case personnel role keys used
  // in window.Prices.personnel. Falls back to a Title-Case version of
  // the key if no explicit label is registered.
  const ROLE_LABELS = {
    mlops_engineer: 'MLOps engineer',
    prompt_engineer: 'Prompt engineer',
    eval_engineer: 'Eval engineer',
    security_reviewer: 'Security reviewer',
    product_manager: 'Product manager',
    sre_oncall: 'SRE / on-call',
    ato_assessor: 'ATO assessor',
    contracting_officer: 'Contracting officer',
    data_engineer: 'Data engineer',
    ml_researcher: 'ML researcher',
    privacy_officer: 'Privacy officer',
    qa_engineer: 'QA engineer',
    agent_design_lead:  'Agent design lead',
    agent_developer:    'Agent developer',
    agent_sme_external: 'Subject matter expert (host team)',
  };
  function humanizeRole(k) {
    if (!k) return '';
    if (ROLE_LABELS[k]) return ROLE_LABELS[k];
    return String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function renderPersonnelList() {
    const list = document.getElementById('personnel-list');
    if (!list) return;
    list.innerHTML = '';
    if (!workload.personnel) workload.personnel = { enabled: false, roles: [] };
    if (!Array.isArray(workload.personnel.roles)) workload.personnel.roles = [];
    const roleKeys = window.Prices && window.Prices.personnel ? Object.keys(window.Prices.personnel) : [];
    workload.personnel.roles.forEach((r, idx) => {
      const def = (window.Prices && window.Prices.personnel && window.Prices.personnel[r.role]) || {};
      const loaded = (def.annual_base || 0) * (def.total_comp_multiplier || 1);
      const monthly = (Number(r.fte) || 0) * loaded / 12;
      const div = document.createElement('div');
      div.className = 'item';
      const safe = String(r.role || idx).replace(/[^a-z0-9-]/gi, '_');
      div.innerHTML = `
        <button class="item-remove" data-personnel-remove="${idx}" aria-label="Remove personnel role ${humanizeRole(r.role)}">remove</button>
        <div class="row grid-3">
          <div><label for="personnel-${safe}-${idx}-role">Role</label>
            <select id="personnel-${safe}-${idx}-role" data-personnel-role="${idx}">
              ${roleKeys.map(k => `<option value="${k}"${k === r.role ? ' selected' : ''}>${humanizeRole(k)}</option>`).join('')}
            </select>
          </div>
          <div><label for="personnel-${safe}-${idx}-fte">FTE allocation</label><input id="personnel-${safe}-${idx}-fte" type="number" step="0.05" min="0" max="2" value="${r.fte}" data-personnel-fte="${idx}"></div>
          <div><label for="personnel-${safe}-${idx}-monthly">Monthly $</label><input id="personnel-${safe}-${idx}-monthly" type="text" value="${monthly.toFixed(0)}" disabled style="background:var(--card2, rgba(0,0,0,0.04)); color:var(--muted); cursor:not-allowed;"></div>
        </div>
        <p class="helper" style="font-size: 11px; margin-top: 2px;">$${(def.annual_base || 0).toLocaleString()} base × ${(def.total_comp_multiplier || 1)} loaded × ${r.fte} FTE ÷ 12 = $${monthly.toFixed(0)}/mo. ${def.notes || ''}</p>
      `;
      list.appendChild(div);
    });
    list.querySelectorAll('[data-personnel-role]').forEach(el => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.personnelRole, 10);
        workload.personnel.roles[idx].role = el.value;
        renderPersonnelList(); renderPreview(); renderRawJson();
      });
    });
    list.querySelectorAll('[data-personnel-fte]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = parseInt(el.dataset.personnelFte, 10);
        workload.personnel.roles[idx].fte = parseFloat(el.value) || 0;
        renderPersonnelList(); renderPreview(); renderRawJson();
      });
    });
    list.querySelectorAll('[data-personnel-remove]').forEach(b => {
      b.addEventListener('click', e => {
        const idx = parseInt(e.target.dataset.personnelRemove, 10);
        workload.personnel.roles.splice(idx, 1);
        renderPersonnelList(); renderPreview(); renderRawJson();
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Agent engineering — design-phase roles × FTE × duration, amortized
  // over deployment lifetime; plus periodic re-spec maintenance.
  // ─────────────────────────────────────────────────────────────────────
  function computeAgentEngineering() {
    const ae = workload.agent_engineering || {};
    if (!ae.enabled) return { enabled: false, upfront: 0, amortized_monthly: 0, maintenance_monthly: 0, monthly: 0 };
    const dur   = Math.max(0, Number(ae.duration_months) || 0);
    const amort = Math.max(1, Number(ae.amortization_months) || 36);
    const helper = Math.max(0, Number(ae.helper_agent_monthly) || 0);
    const roles = Array.isArray(ae.roles) ? ae.roles : [];
    let upfront = 0;
    roles.forEach(r => {
      const def = (window.Prices && window.Prices.personnel && window.Prices.personnel[r.role]) || {};
      const loaded = (def.annual_base || 0) * (def.total_comp_multiplier || 1);
      upfront += (Number(r.fte) || 0) * loaded * (dur / 12);
    });
    upfront += helper * dur;
    const amortized_monthly = upfront / amort;
    // Maintenance: design-lead loaded hourly × hours per session ÷ months between sessions.
    // Mirrors scripts/calc.js's fail-loud policy: if prices.js doesn't define
    // personnel.agent_design_lead, surface a console error and zero out the
    // maintenance line rather than silently masking the gap with a hardcoded
    // fallback that can drift away from prices.js. Previously this path used
    // 230000 × 1.30 as a silent default — divergent from calc.js which throws.
    const lead = (window.Prices && window.Prices.personnel && window.Prices.personnel.agent_design_lead) || null;
    let maintenance_monthly = 0;
    if (lead && lead.annual_base) {
      const leadLoadedAnnual = lead.annual_base * (lead.total_comp_multiplier || 1);
      const leadHourly = leadLoadedAnnual / 2080;  // 40hr × 52wk
      const interval = Math.max(1, Number(ae.maintenance_interval_months) || 6);
      const hoursPerSession = Math.max(0, Number(ae.maintenance_hours_per_session) || 0);
      maintenance_monthly = (leadHourly * hoursPerSession) / interval;
    } else {
      console.error('prices.js: personnel.agent_design_lead is missing — maintenance line zeroed. Update lib/prices.js to define annual_base + total_comp_multiplier for this role.');
    }
    return {
      enabled: true,
      upfront,
      amortized_monthly,
      maintenance_monthly,
      monthly: amortized_monthly + maintenance_monthly,
    };
  }

  function renderAgentEngineeringList() {
    const list = document.getElementById('agent-eng-list');
    if (!list) return;
    list.innerHTML = '';
    if (!workload.agent_engineering) workload.agent_engineering = { enabled: false, roles: [], duration_months: 4, amortization_months: 36, helper_agent_monthly: 400, maintenance_interval_months: 6, maintenance_hours_per_session: 40 };
    if (!Array.isArray(workload.agent_engineering.roles)) workload.agent_engineering.roles = [];
    const dur = Math.max(0, Number(workload.agent_engineering.duration_months) || 0);
    const roleKeys = window.Prices && window.Prices.personnel ? Object.keys(window.Prices.personnel) : [];
    workload.agent_engineering.roles.forEach((r, idx) => {
      const def = (window.Prices && window.Prices.personnel && window.Prices.personnel[r.role]) || {};
      const loaded = (def.annual_base || 0) * (def.total_comp_multiplier || 1);
      const phaseTotal = (Number(r.fte) || 0) * loaded * (dur / 12);
      const div = document.createElement('div');
      div.className = 'item';
      const safe = String(r.role || idx).replace(/[^a-z0-9-]/gi, '_');
      div.innerHTML = `
        <button class="item-remove" data-aeng-remove="${idx}" aria-label="Remove agent engineering role ${humanizeRole(r.role)}">remove</button>
        <div class="row grid-3">
          <div><label for="aeng-${safe}-${idx}-role">Role</label>
            <select id="aeng-${safe}-${idx}-role" data-aeng-role="${idx}">
              ${roleKeys.map(k => `<option value="${k}"${k === r.role ? ' selected' : ''}>${humanizeRole(k)}</option>`).join('')}
            </select>
          </div>
          <div><label for="aeng-${safe}-${idx}-fte">FTE during design</label><input id="aeng-${safe}-${idx}-fte" type="number" step="0.05" min="0" max="2" value="${r.fte}" data-aeng-fte="${idx}"></div>
          <div><label for="aeng-${safe}-${idx}-phasetotal">Phase total $</label><input id="aeng-${safe}-${idx}-phasetotal" type="text" value="${Math.round(phaseTotal).toLocaleString()}" disabled style="background:var(--card2, rgba(0,0,0,0.04)); color:var(--muted); cursor:not-allowed;"></div>
        </div>
        <p class="helper" style="font-size: 11px; margin-top: 2px;">$${(def.annual_base || 0).toLocaleString()} base × ${(def.total_comp_multiplier || 1)} loaded × ${r.fte} FTE × ${dur} mo ÷ 12 = $${Math.round(phaseTotal).toLocaleString()} for the design phase. ${def.notes || ''}</p>
      `;
      list.appendChild(div);
    });
    list.querySelectorAll('[data-aeng-role]').forEach(el => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.dataset.aengRole, 10);
        workload.agent_engineering.roles[idx].role = el.value;
        renderAgentEngineeringList(); renderPreview(); renderRawJson();
      });
    });
    list.querySelectorAll('[data-aeng-fte]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = parseInt(el.dataset.aengFte, 10);
        workload.agent_engineering.roles[idx].fte = parseFloat(el.value) || 0;
        renderAgentEngineeringList(); renderPreview(); renderRawJson();
      });
    });
    list.querySelectorAll('[data-aeng-remove]').forEach(b => {
      b.addEventListener('click', e => {
        const idx = parseInt(e.target.dataset.aengRemove, 10);
        workload.agent_engineering.roles.splice(idx, 1);
        renderAgentEngineeringList(); renderPreview(); renderRawJson();
      });
    });
    // Update the summary box
    const ae = computeAgentEngineering();
    const fmt$ = n => '$' + Math.round(n).toLocaleString();
    const up = document.getElementById('ae-upfront');
    const am = document.getElementById('ae-amortized');
    const mt = document.getElementById('ae-maintenance');
    if (up) up.innerHTML = `<strong>Upfront design phase:</strong> ${fmt$(ae.upfront)} (${dur} mo)`;
    if (am) am.innerHTML = `<strong>Amortized monthly:</strong> ${fmt$(ae.amortized_monthly)}/mo over ${workload.agent_engineering.amortization_months} mo deployment lifetime`;
    if (mt) mt.innerHTML = `<strong>Maintenance:</strong> ${fmt$(ae.maintenance_monthly)}/mo (re-spec every ${workload.agent_engineering.maintenance_interval_months} mo)`;
  }

  function renderMigrationList() {
    const list = document.getElementById('migration-list');
    if (!list) return;
    list.innerHTML = '';
    if (!workload.migration) workload.migration = { enabled: false, phases: [] };
    if (!Array.isArray(workload.migration.phases)) workload.migration.phases = [];
    workload.migration.phases.forEach((p, idx) => {
      const div = document.createElement('div');
      div.className = 'item';
      const safe = String(p.label || idx).replace(/[^a-z0-9-]/gi, '_');
      div.innerHTML = `
        <button class="item-remove" data-mig-remove="${idx}" aria-label="Remove migration phase ${p.label || idx}">remove</button>
        <div class="row grid-2">
          <div><label for="mig-${safe}-${idx}-label">Label</label><input id="mig-${safe}-${idx}-label" type="text" value="${(p.label || '').replace(/"/g, '&quot;')}" data-mig-field="label" data-mig-idx="${idx}"></div>
          <div><label for="mig-${safe}-${idx}-months">Months</label><input id="mig-${safe}-${idx}-months" type="number" min="1" step="1" value="${p.months || 12}" data-mig-field="months" data-mig-idx="${idx}"></div>
        </div>
        <div class="row grid-2">
          <div>
            <label for="mig-${safe}-${idx}-hosting">Hosting</label>
            <select id="mig-${safe}-${idx}-hosting" data-mig-field="hosting" data-mig-idx="${idx}">
              <option value="api"${p.hosting === 'api' ? ' selected' : ''}>API (managed)</option>
              <option value="self"${p.hosting === 'self' ? ' selected' : ''}>Self-host on EC2</option>
              <option value="hybrid"${p.hosting === 'hybrid' ? ' selected' : ''}>Hybrid (split)</option>
            </select>
          </div>
          <div>
            <label for="mig-${safe}-${idx}-reservation_type">API reservation</label>
            <select id="mig-${safe}-${idx}-reservation_type" data-mig-field="reservation_type" data-mig-idx="${idx}">
              <option value="none"${(p.reservation_type === 'none' || !p.reservation_type) ? ' selected' : ''}>None — on-demand</option>
              <option value="azure-ptu-monthly"${p.reservation_type === 'azure-ptu-monthly' ? ' selected' : ''}>Azure PTU monthly</option>
              <option value="azure-ptu-yearly"${p.reservation_type === 'azure-ptu-yearly' ? ' selected' : ''}>Azure PTU yearly</option>
              <option value="bedrock-provisioned-1mo"${p.reservation_type === 'bedrock-provisioned-1mo' ? ' selected' : ''}>Bedrock 1-month</option>
              <option value="bedrock-provisioned-6mo"${p.reservation_type === 'bedrock-provisioned-6mo' ? ' selected' : ''}>Bedrock 6-month</option>
              <option value="openai-enterprise-100k"${p.reservation_type === 'openai-enterprise-100k' ? ' selected' : ''}>OpenAI Ent ≥$100K/mo</option>
              <option value="openai-enterprise-1m"${p.reservation_type === 'openai-enterprise-1m' ? ' selected' : ''}>OpenAI Ent ≥$1M/mo</option>
            </select>
          </div>
        </div>
      `;
      list.appendChild(div);
    });
    list.querySelectorAll('[data-mig-field]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = parseInt(el.dataset.migIdx, 10);
        const field = el.dataset.migField;
        const val = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value;
        workload.migration.phases[idx][field] = val;
        renderPreview(); renderRawJson();
      });
    });
    list.querySelectorAll('[data-mig-remove]').forEach(b => {
      b.addEventListener('click', e => {
        const idx = parseInt(e.target.dataset.migRemove, 10);
        workload.migration.phases.splice(idx, 1);
        renderMigrationList(); renderPreview(); renderRawJson();
      });
    });
  }

  function renderRateCardList() {
    const list = document.getElementById('ratecard-list');
    if (!list) return;
    list.innerHTML = '';
    const cards = Object.assign({}, CostEngine.DEFAULT_RATE_CARDS, workload.rate_cards || {});
    // Currently-active model from runtime select (or default)
    const activeModel = (document.getElementById('prev-model') || {}).value || workload.defaults.model;

    const tbl = document.createElement('table');
    tbl.className = 'ratecard-table';
    let rows = '';
    for (const [id, card] of Object.entries(cards)) {
      const overridden = workload.rate_cards && workload.rate_cards[id];
      const isActive = id === activeModel;
      const safe = id.replace(/[^a-z0-9-]/gi, '_');
      rows += `<tr class="${isActive ? 'active' : ''}" title="${isActive ? 'Currently selected in Scenario controls' : ''}">
        <td class="rc-name">
          ${isActive ? '<span class="rc-dot" title="Active"></span>' : ''}
          <strong>${id}</strong>
          <span class="rc-provider">${card.provider || 'custom'}</span>
          ${overridden ? '<span class="rc-badge">edited</span>' : ''}
        </td>
        <td><input id="ratecard-${safe}-input_per_million" aria-label="${id} input $/M" type="number" step="0.01" min="0" value="${card.input_per_million}" data-card="${id}" data-key="input_per_million"></td>
        <td><input id="ratecard-${safe}-cached_per_million" aria-label="${id} cached $/M" type="number" step="0.001" min="0" value="${card.cached_per_million}" data-card="${id}" data-key="cached_per_million"></td>
        <td><input id="ratecard-${safe}-output_per_million" aria-label="${id} output $/M" type="number" step="0.01" min="0" value="${card.output_per_million}" data-card="${id}" data-key="output_per_million"></td>
        <td class="rc-action">${overridden ? `<button class="rc-reset" data-card-remove="${id}" title="Reset to default" aria-label="Reset ${id} rate card to default">↺</button>` : ''}</td>
      </tr>`;
    }
    tbl.innerHTML = `<thead><tr>
      <th class="rc-name">Model</th>
      <th>Input $/M</th>
      <th>Cached $/M</th>
      <th>Output $/M</th>
      <th></th>
    </tr></thead><tbody>${rows}</tbody>`;
    list.appendChild(tbl);

    tbl.querySelectorAll('[data-card]').forEach(el => {
      el.addEventListener('input', () => {
        const id = el.dataset.card, key = el.dataset.key;
        if (!workload.rate_cards) workload.rate_cards = {};
        if (!workload.rate_cards[id]) {
          workload.rate_cards[id] = Object.assign({}, CostEngine.DEFAULT_RATE_CARDS[id] || {});
        }
        workload.rate_cards[id][key] = parseFloat(el.value) || 0;
        renderPreview(); renderRawJson();
        renderRateCardList();  // refresh override badge
      });
    });
    tbl.querySelectorAll('[data-card-remove]').forEach(b => {
      b.addEventListener('click', e => {
        if (workload.rate_cards) delete workload.rate_cards[e.currentTarget.dataset.cardRemove];
        renderEditor(); renderPreview();
      });
    });
  }

  function populateGpuDropdown() {
    const sel = document.getElementById('prev-gpu');
    if (!sel) return;
    const opts = workload.self_host.gpu_options || {};
    sel.innerHTML = Object.entries(opts).map(([id, g]) =>
      `<option value="${id}">${id} · ${g.name || ''} · $${g.hourly}/hr</option>`
    ).join('');
  }

  function populateModelDropdowns() {
    const rates = Object.assign({}, CostEngine.DEFAULT_RATE_CARDS, workload.rate_cards || {});
    const ids = Object.keys(rates);
    for (const selectId of ['defaults-model', 'prev-model']) {
      const sel = document.getElementById(selectId);
      if (!sel) continue;
      sel.innerHTML = ids.map(id => `<option value="${id}"${id === workload.defaults.model ? ' selected' : ''}>${id}</option>`).join('');
    }
  }
  function populateMixDropdowns() {
    const ids = Object.keys(workload.mix);
    for (const selectId of ['defaults-mix', 'prev-mix']) {
      const sel = document.getElementById(selectId);
      if (!sel) continue;
      sel.innerHTML = ids.map(id => `<option value="${id}"${id === workload.defaults.mix ? ' selected' : ''}>${id}</option>`).join('');
    }
  }

  function renderRawJson() {
    const ta = document.getElementById('raw-json');
    if (ta) ta.value = JSON.stringify(workload, null, 2);
  }

  // Single source of truth for the headline composition. Every panel that
  // displays a $/month total (preview, sensitivity, model compare, budget
  // solver, preset compare) routes through this so they can't drift —
  // a recurring bug source where one panel applied retry-inflate and
  // another didn't, producing inconsistent KPIs across the page.
  function composeHeadline(r, w, opts, retryInflate = 1) {
    // Eq. 5 (1 + 1.5r) retry inflate is now applied inside the engine
    // (api.monthly_with_retry). We keep the retryInflate arg for migration
    // phase callers and fall back to a manual multiplication only when the
    // engine didn't compute monthly_with_retry (older callers/payloads).
    const apiBill = r.api?.monthly_with_retry != null
      ? r.api.monthly_with_retry
      : (r.api?.monthly_capped || 0) * retryInflate;
    const fixed = r.fixed_costs?.total || 0;
    const verif = r.verification?.monthly || 0;
    // External tool fees (per-call / per-session provider charges for the
    // agents' enabled_tools) are now an engine line — r.tool_fees — so
    // calc.js, the Excel export and the bench all bill them identically.
    const toolFees = r.tool_fees?.monthly || 0;
    const fed = r.federal?.additive_total || 0;
    const emb = (r.embedding?.enabled ? r.embedding.monthly : 0) || 0;
    const pers = (r.personnel?.enabled ? r.personnel.monthly : 0) || 0;
    const aeBlock = computeAgentEngineering();
    const ae = aeBlock.enabled ? aeBlock.monthly : 0;
    let llm;
    if (opts.hosting === 'hybrid' && r.hybrid) llm = r.hybrid.total;
    else if (opts.hosting === 'self') llm = r.self_host?.total || 0;
    else if (opts.hosting === 'onprem') llm = parseFloat(w.on_prem_monthly) || 0;
    else if (r.reservation?.enabled) llm = r.reservation.effective_monthly;
    else llm = apiBill;
    const headline = llm + fixed + verif + toolFees + fed + emb + pers + ae;
    return { headline, llm, apiBill, fixed, verif, toolFees, fed, emb, pers, ae };
  }

  // Render the calibration badge above the headline. Reads
  // workload.anchor_query._calibration; shows nothing when absent.
  //
  // Shared helper — applies one named payload mode (e.g. 'minimal',
  // 'moderate', 'heavy') from the current workload's calibration block.
  // Used by both the 3-way mode-toggle buttons and the coarse
  // freeform/templated dropdown so they stay in sync.
  function applyPayloadMode(k) {
    const modes = workload?.anchor_query?._calibration?.payload_modes;
    const mode = modes?.[k];
    if (!mode) return;
    workload._payload_mode_active = k;
    // Rewrite the anchor — preserve session_baseline_turns + example.
    if (mode.input_tokens != null) workload.anchor_query.input_tokens = mode.input_tokens;
    if (mode.output_tokens != null) workload.anchor_query.output_tokens = mode.output_tokens;
    if (mode.cache_rate_baseline != null) workload.anchor_query.cache_rate_baseline = mode.cache_rate_baseline;
    // Mirror updated anchor into the simulator (s-cache slider + anchor agent)
    // with writeback suspended so the repaint doesn't push stale state back.
    window.__setSimWritebackEnabled?.(false);
    window.__setSimulatorFromWorkload?.(workload);
    renderPreview();
    window.__setSimWritebackEnabled?.(true);
  }

  // When _calibration.payload_modes is present, renders three toggle
  // buttons (Minimal / Moderate / Heavy). Selecting one rewrites
  // anchor_query.input_tokens / output_tokens / cache_rate_baseline
  // to the chosen mode and re-renders. The active mode is persisted
  // on workload._payload_mode_active so it survives renderPreview
  // re-entries.
  function renderCalibrationBadge() {
    const el = document.getElementById('prev-calibration');
    if (!el) return;
    const cal = workload.anchor_query?._calibration;
    if (!cal || !cal.validated_on) {
      el.hidden = true;
      el.innerHTML = '';
      el.className = 'calibration-badge';
      return;
    }
    // Determine which payload mode is active. Default to 'minimal'
    // (the validated one) on first render.
    const modes = cal.payload_modes || null;
    const activeMode = workload._payload_mode_active || 'minimal';
    const isValidatedMode = activeMode === 'minimal' || !modes;

    el.className = 'calibration-badge';
    if (modes && activeMode !== 'minimal') {
      el.classList.add(`mode-${activeMode}`);
    }

    const report = cal.validation_report
      ? `https://github.com/ajinkyakulkarni/ai-cost-calculator-studio/blob/main/${cal.validation_report}`
      : null;
    const linkHtml = report
      ? `<a href="${report}" target="_blank" rel="noopener">view bench report</a>`
      : '';
    const sample = cal.sample_size ? `, ${escapeHtml(cal.sample_size)}` : '';

    // Header line — different copy depending on whether the user is
    // viewing the validated mode or an estimated upper-bound mode.
    const headerHtml = isValidatedMode
      ? `<span class="cal-check">✓</span>
         <span>Validated against ${escapeHtml(cal.validated_against || 'real API')}</span>
         <span class="cal-date">${escapeHtml(cal.validated_on)}${sample}</span>`
      : `<span class="cal-check">⚠</span>
         <span>Estimated upper bound (not yet measured)</span>
         <span class="cal-date">based on ${escapeHtml(cal.validated_on)} calibration</span>`;

    // Summary line — the procurement-grade accuracy claim, visible
    // not just on hover. For non-validated modes, swaps in the upper-
    // bound caveat.
    let summaryHtml = '';
    if (isValidatedMode && cal.accuracy_statement) {
      summaryHtml = `<div class="cal-summary">${escapeHtml(cal.accuracy_statement)}</div>`;
    } else if (!isValidatedMode && modes && modes[activeMode]?.description) {
      summaryHtml = `<div class="cal-summary">${escapeHtml(modes[activeMode].description)} — these numbers are estimated, not measured against real API.</div>`;
    }

    // Payload-mode toggle — only rendered when payload_modes exists.
    let modesHtml = '';
    if (modes) {
      const buttons = ['minimal', 'moderate', 'heavy']
        .filter(k => modes[k])
        .map(k => {
          const isActive = k === activeMode;
          const label = modes[k].label || k;
          return `<button class="cal-mode-btn${isActive ? ' active' : ''}" data-mode="${k}" type="button"><span>${escapeHtml(label)}</span></button>`;
        }).join('');
      modesHtml = `
        <div class="cal-modes">
          <span class="cal-mode-label">Retrieval payload:</span>
          ${buttons}
        </div>`;
    }

    el.innerHTML = `
      <div class="cal-header">${headerHtml} ${linkHtml ? '· ' + linkHtml : ''}</div>
      ${summaryHtml}
      ${modesHtml}
    `;
    el.hidden = false;
    if (cal.notes) el.title = cal.notes;

    // Wire mode-toggle clicks. Each click rewrites the workload's
    // anchor_query to the chosen mode's values and triggers a
    // re-render. The CSS bridge in renderPreview reads the new
    // values on the next pass.
    el.querySelectorAll('.cal-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.mode;
        applyPayloadMode(k);
      });
    });
  }

  // -----------------------------------------------------------------
  // Override-count badges. Scans the override hierarchy for tool
  // return_shape and surfaces "(N overrides apply)" markers next to
  // the global slider AND on per-tool registry rows. Users see at a
  // glance whether their global default is being respected or shadowed
  // by per-tool / per-(agent,tool) overrides downstream.
  //
  // Override precedence (lowest → highest):
  //   1. global #s-tool-response-mode (workload-wide default)
  //   2. workload.tools_registry[id].return_shape (per-tool)
  //   3. workload.agents[i].enabled_tools[id].return_shape_override (per-agent-tool)
  // -----------------------------------------------------------------
  function updateOverrideBadges() {
    try {
      const reg = (workload && workload.tools_registry) || {};
      const ag = (workload && Array.isArray(workload.agents)) ? workload.agents : [];
      // Count tools whose per-tool return_shape exists (i.e., they
      // declare a value rather than inheriting global). Tools default
      // to 'freeform' in DEFAULT_TOOLS_REGISTRY, so "explicit override"
      // means a non-default value OR a registry-set freeform when global
      // is templated. Cleanest signal: count tools whose effective
      // shape DIFFERS from the global slider's current value.
      const globalShape = document.getElementById('s-tool-response-mode')?.value || 'freeform';
      let perToolOverrides = 0;
      const overriddenToolIds = new Set();
      for (const [id, t] of Object.entries(reg)) {
        // ONLY count tools that EXPLICITLY set return_shape AND it
        // differs from the global default. Tools without return_shape
        // (undefined) are inheriting global — not overriding.
        if (t.return_shape && t.return_shape !== globalShape) {
          perToolOverrides++;
          overriddenToolIds.add(id);
        }
      }
      // Count per-(agent,tool) overrides — any agent's enabled_tools[id]
      // entry with return_shape_override or cap_tokens_override set.
      let perAgentToolOverrides = 0;
      const perToolAgentOverrideCount = {};  // toolId → count of agents overriding it
      for (const a of ag) {
        const enabled = a.enabled_tools || {};
        for (const [tid, spec] of Object.entries(enabled)) {
          if (spec && (spec.return_shape_override || Number.isFinite(spec.cap_tokens_override))) {
            perAgentToolOverrides++;
            perToolAgentOverrideCount[tid] = (perToolAgentOverrideCount[tid] || 0) + 1;
          }
        }
      }
      // Update the global "Tool return shape" badge
      const globalBadge = document.getElementById('tool-return-shape-override-badge');
      if (globalBadge) {
        const parts = [];
        if (perToolOverrides > 0) parts.push(`${perToolOverrides} per-tool`);
        if (perAgentToolOverrides > 0) parts.push(`${perAgentToolOverrides} per-(agent,tool)`);
        if (parts.length > 0) {
          globalBadge.textContent = parts.join(' + ') + ' override' + (parts.length > 1 || perToolOverrides + perAgentToolOverrides > 1 ? 's' : '') + ' active';
          globalBadge.style.display = '';
          globalBadge.title = 'Specific tools / agents are overriding this default. Click a tool in the Tools registry to see its per-tool shape, or expand an agent\'s Tools section to see per-(agent,tool) overrides.';
        } else {
          globalBadge.style.display = 'none';
          globalBadge.textContent = '';
        }
      }
      // Update per-tool registry row badges (if rendered)
      for (const [tid, count] of Object.entries(perToolAgentOverrideCount)) {
        const row = document.querySelector(`[data-tool-id="${tid}"]`);
        if (!row) continue;
        let b = row.querySelector('[data-agent-override-badge]');
        if (!b) {
          // Lazy-insert badge into the row header (shows when collapsed too)
          const hdr = row.querySelector('[data-tool-header]');
          if (!hdr) continue;
          b = document.createElement('span');
          b.setAttribute('data-agent-override-badge', '1');
          b.style.cssText = 'font-size:9px;color:#f59e00;background:rgba(245,158,0,.12);border:1px solid rgba(245,158,0,.3);padding:0 5px;border-radius:8px;font-weight:600;margin-left:6px';
          // Place between cost_shape badge and rate hint (last child before BUILTIN / remove)
          hdr.insertBefore(b, hdr.children[3] || null);
        }
        b.textContent = `${count} agent${count===1?'':'s'} override`;
        b.title = `${count} agent${count===1?'':'s'} use a per-(agent,tool) override for this tool — their copy uses a different RETURN SHAPE or CAP TOK than this default.`;
      }
      // Remove stale badges for tools that lost their overrides
      document.querySelectorAll('[data-agent-override-badge]').forEach(b => {
        const row = b.closest('[data-tool-id]');
        if (!row) return;
        const tid = row.dataset.toolId;
        if (!perToolAgentOverrideCount[tid]) b.remove();
      });
    } catch (e) { /* badges are decorative — silent on error */ }
  }

  // -----------------------------------------------------------------
  // Live preview (right pane)
  // -----------------------------------------------------------------
  function renderPreview() {
    updateOverrideBadges();
    document.getElementById('prev-agency').textContent = workload.deployment.agency || '—';
    document.getElementById('prev-name').textContent = workload.deployment.name || '—';
    document.getElementById('prev-desc').textContent = workload.deployment.description || '—';
    const headlineLabel = document.getElementById('prev-headline-label');
    if (headlineLabel) {
      const agency = workload.deployment.agency || 'Total';
      headlineLabel.textContent = `Total monthly cost · ${agency}`;
    }

    // Payload-mode persistence. When a calibrated workload has selected a
    // payload mode (via the 3-way Minimal/Moderate/Heavy buttons OR the
    // freeform/templated dropdown), re-derive the anchor from that mode on
    // EVERY render. The freeform/templated dropdown carries an inline
    // onchange="onSlider()" that triggers a full rebuild; without this
    // re-derivation the rebuild would re-read the default calibrated anchor
    // (3342) and the chosen mode's tokens would be silently dropped — the
    // dropdown moved nothing while the buttons worked. Sourcing from
    // _payload_mode_active here makes the choice survive any rebuild and
    // hardens the buttons too. Agent-mode workloads (no payload_modes) and
    // un-selected calibrated workloads are untouched.
    {
      const _pm = workload?.anchor_query?._calibration?.payload_modes;
      const _activeMode = workload?._payload_mode_active;
      const _mode = _activeMode && _pm ? _pm[_activeMode] : null;
      if (_mode) {
        if (_mode.input_tokens != null) workload.anchor_query.input_tokens = _mode.input_tokens;
        if (_mode.output_tokens != null) workload.anchor_query.output_tokens = _mode.output_tokens;
        if (_mode.cache_rate_baseline != null) workload.anchor_query.cache_rate_baseline = _mode.cache_rate_baseline;
        // Keep the freeform/templated dropdown's displayed value consistent
        // with the active payload mode: minimal→templated, heavy→freeform.
        // 'moderate' has no dropdown equivalent, so leave the control as-is.
        const _shapeSel = document.getElementById('s-tool-response-mode');
        if (_shapeSel) {
          if (_activeMode === 'minimal' && _shapeSel.value !== 'templated') _shapeSel.value = 'templated';
          else if (_activeMode === 'heavy' && _shapeSel.value !== 'freeform') _shapeSel.value = 'freeform';
        }
      }
    }

    const $ = id => document.getElementById(id);
    const val = (id, fallback) => { const el = $(id); return el ? el.value : fallback; };
    const numVal = (id, fallback) => { const el = $(id); return el ? parseFloat(el.value) : fallback; };

    // Simulator-side sliders (MAU / sessions / turns) drive traffic for
    // single-segment workloads. For multi-segment workloads, the sliders
    // display the rollup (sum of MAU, weighted-average sessions/day and
    // questions/session) — renderPreview pushes those onto the sliders
    // here, and slider drags route through scaleSegments (app.js:3787)
    // which proportionally rescales each segment so the next render's
    // rollup matches the user's drag. The two directions stay in sync.
    {
      const mau = numVal('s-users', 500);
      const sessionsPerUserPerDay = numVal('s-sessions', 0.3);
      const turnsPerSession = numVal('s-turns', 8);
      const segs = workload.segments || [];
      if (segs.length <= 1) {
        // Single-segment / fresh-start path: sliders ARE the segment.
        // Preserve preset-supplied id/label/applyBotFactor/description if a
        // segment already exists (presets like voice-support-agent have
        // applyBotFactor:false and a curated description that should not be
        // unconditionally clobbered). Only the numeric traffic fields are
        // sourced from the sliders — those are mirrored from the form-edit
        // path in renderSegmentsList so they stay in sync either way.
        const existing = segs[0] || {};
        workload.segments = [{
          id: existing.id || 'all',
          label: existing.label || 'All users',
          mau: mau,
          sessions_per_day: sessionsPerUserPerDay,
          questions_per_session: turnsPerSession,
          applyBotFactor: existing.applyBotFactor != null ? existing.applyBotFactor : true,
          description: existing.description || 'Aggregate traffic — MAU × sessions/user/day × turns/session × bot factor.',
        }];
      } else {
        // Multi-segment path: leave segments alone (the per-segment editor
        // is the editing surface). Push rollup values to the sliders so
        // the global panel shows totals consistent with the segments.
        const totalMau = segs.reduce((a, s) => a + (s.mau || 0), 0);
        const wAvgSess = totalMau > 0
          ? segs.reduce((a, s) => a + (s.mau || 0) * (s.sessions_per_day || 0), 0) / totalMau
          : 0;
        const wAvgTurns = totalMau > 0
          ? segs.reduce((a, s) => a + (s.mau || 0) * (s.questions_per_session || 0), 0) / totalMau
          : 0;
        const mauEl = document.getElementById('s-users');
        const sessEl = document.getElementById('s-sessions');
        const turnsEl = document.getElementById('s-turns');
        if (mauEl) mauEl.value = totalMau;
        if (sessEl) sessEl.value = wAvgSess.toFixed(1);
        if (turnsEl) turnsEl.value = Math.round(wAvgTurns);
      }
    }

    // Capture simulator totals for derivation display ONLY — never overwrite
    // workload.anchor_query. The workload is the source of truth for the
    // anchor; the simulator is a view+editor on the workload, and pushes
    // back to it only via user-driven autoSync (see index.html integration
    // block). Overwriting on every render used to clobber the validated
    // anchor with the simulator's default fleet math on page load.
    let _axTotalIn = null, _axTotalOut = null, _axTurns = null;
    if (typeof window.computeCost === 'function') {
      try {
        const axRes = window.computeCost();
        _axTurns = Math.max(1, numVal('s-turns', 8));
        if (axRes && Number.isFinite(axRes.totalIn)  && axRes.totalIn  > 0) _axTotalIn  = axRes.totalIn;
        if (axRes && Number.isFinite(axRes.totalOut) && axRes.totalOut > 0) _axTotalOut = axRes.totalOut;
      } catch (_) { /* simulator not ready yet on first paint */ }
    }

    // Cache-hit-rate slider (s-cache, in 0-100%) is the canonical
    // source of truth now. Fall back to the legacy prev-cache control or
    // the workload's anchor_query.cache_rate_baseline if the simulator slider
    // isn't in the DOM (e.g., in a stripped-down embedded view).
    const sCacheEl = $('s-cache');
    const cacheFromAxiom = sCacheEl ? parseFloat(sCacheEl.value) / 100 : null;

    // Retry-rate slider (s-retry, in 0-100%) inflates the API bill —
    // each retry pays the full input cost again, so we apply a multiplier
    // (1 + retry_rate × 1.5) on top of CostEngine's headline. The 1.5
    // factor accounts for partial output already generated before failure.
    const sRetryEl = $('s-retry');
    const retryRate = sRetryEl ? parseFloat(sRetryEl.value) / 100 : 0;

    const opts = {
      hosting: val('prev-hosting', workload.defaults.hosting),
      model: val('prev-model', workload.defaults.model),
      tier: val('prev-tier', workload.defaults.tier),
      mix: val('prev-mix', workload.defaults.mix),
      costMode: val('prev-cost-mode', workload.defaults.cost_mode),
      botFactor: numVal('prev-bot', 1.5),
      cacheRate: cacheFromAxiom !== null ? cacheFromAxiom : numVal('prev-cache', workload.anchor_query.cache_rate_baseline),
      // s-cache-write-share threads the per-million premium for first-write
      // cached tokens (Anthropic 1.25×–2× input, OpenAI 0× auto-prefix).
      // Without this, the cost engine fell back to 0 (read-only blend) and
      // the slider was visibly dead. Slider is 0-100%; engine wants 0-1.
      cacheWriteShare: (() => {
        const el = document.getElementById('s-cache-write-share');
        if (!el) return undefined;
        const v = parseFloat(el.value);
        return Number.isFinite(v) ? v / 100 : undefined;
      })(),
      // Language-token multiplier (s-lang-mult: 1.0–2.5). Was silent —
      // simulator's `langMult` only flowed into computeCost (simulator
      // pane), not the engine that drives the headline pill. Now bridged.
      langMult: (() => {
        const el = document.getElementById('s-lang-mult');
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) && v > 0 ? v : undefined;
      })(),
      // Batch-tier share (s-batch: 0–100% of traffic routed to batch
      // tier with 50% discount). Same silent-broadcast pattern as
      // langMult — bridged now so the slider actually moves the bill.
      batchShare: (() => {
        const el = document.getElementById('s-batch');
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) ? v / 100 : undefined;
      })(),
      // Context compression — net % saving on LLM bill from history
      // summarization (Claude Code subagent / LangChain memory / Devin
      // memory-layer patterns). 0 = legacy, preserves paper math.
      contextCompressionPct: (() => {
        const el = document.getElementById('s-context-compression');
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) ? v / 100 : undefined;
      })(),
      // Document parsing — bridges the s-doc-* sliders to per-query
      // extra input tokens. (PDFs ingested) × (pages/PDF) × (tok/page)
      // × (% stages reading docs). Default product is 0 (no docs) so
      // existing workloads are unaffected. Engine adds this as an
      // additive input-token cost line, cache-blended at the segment's
      // effective cache rate.
      extraInputTokensPerQuery: (() => {
        const pdfs = parseFloat(document.getElementById('s-doc-pdfs')?.value) || 0;
        const pages = parseFloat(document.getElementById('s-doc-pages')?.value) || 0;
        const tokPage = parseFloat(document.getElementById('s-doc-tok-page')?.value) || 0;
        const stagesPct = parseFloat(document.getElementById('s-doc-stages-pct')?.value) || 0;
        const tokens = pdfs * pages * tokPage * (stagesPct / 100);
        return tokens > 0 ? tokens : undefined;
      })(),
      // Self-host diurnal peak factor — bridges s-peak. Only overrides
      // engine's safer 4× default when slider is dialed above 1 so the
      // slider's lazy 1× default doesn't accidentally undersize the
      // fleet for users who never touched it.
      diurnalPeakFactor: (() => {
        const el = document.getElementById('s-peak');
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) && v > 1 ? v : undefined;
      })(),
      // Verification coverage is the data-bound workload value (the
      // "Sampling coverage" field in the Fact-checking editor), NOT the
      // orphaned #prev-verif slider — that slider is a hidden leftover
      // stuck at 0, which silently zeroed verification cost in every
      // headline regardless of the enable toggle, coverage, or variant.
      verifCoverage: (workload.verification && Number(workload.verification.coverage)) || 0,
      // Threaded into the engine so Migration Timeline phase costs match
      // the canonical headline (engine applies it inside computeMigration).
      retryInflate: 1 + (retryRate * 1.5),
      apiSplit: numVal('prev-api-split', 50) / 100,
      gpu: val('prev-gpu', undefined),
      commitment: val('prev-commitment', 'ri-1y'),
      replicas: Math.round(numVal('prev-replicas', 2)),
      tokensPerQ: Math.round(numVal('prev-tokens', 2000)),
    };

    let result;
    try {
      result = CostEngine.compute(workload, opts);
    } catch (e) {
      console.error('Compute error', e);
      document.getElementById('prev-total').textContent = '—';
      document.getElementById('prev-total-caption').textContent = 'Configuration error: ' + e.message;
      return;
    }

    const queries = result.queries.total;
    // Apply retry-rate multiplier from the simulator s-retry slider. Each retry
    // pays input cost again + ~50% of output (partial generation before
    // failure), so we use 1.5× the retry fraction as the inflate factor.
    // Formula lives in lib/derivation-trace.js (retryInflateFactor) —
    // unit-tested in Node, and section B of the derivation appendix
    // prints the same expression so trace and math can't drift apart.
    const retryInflate = DerivationTrace.retryInflateFactor(retryRate);
    const totalMau = workload.segments.reduce((a, s) => a + (s.mau || 0), 0);
    const infraTotal = (result.fixed_costs && result.fixed_costs.infrastructure) || 0;
    const rateLimitCost = (result.fixed_costs && result.fixed_costs.rate_limit) || 0;
    const hostingPremium = (result.federal && result.federal.hosting_premium_api) || 0;
    const reservation = result.reservation || { enabled: false };
    // Agent engineering: upfront design effort amortized + maintenance.
    // Methodology-agnostic; defaults approximate a CARE-style engagement.
    const agentEngineering = computeAgentEngineering();
    const composed = composeHeadline(result, workload, opts, retryInflate);
    const apiBill = composed.apiBill;
    const fixedCosts = composed.fixed;
    const verifMonthly = composed.verif;
    const federalAdditive = composed.fed;
    const embeddingMonthly = composed.emb;
    const personnelMonthly = composed.pers;
    const agentEngMonthly = composed.ae;
    const llmHeadline = composed.llm;
    // Provider tool fees (per-call / per-session charges for the agents'
    // enabled_tools) are now computed by cost-engine.js — computeToolFees —
    // and already folded into composed.headline via composeHeadline's
    // r.tool_fees term. The previous inline block here divided each
    // agent's fees by its share of total agent calls, which under-counted
    // multi-agent fleets; the engine version drops that and bills each
    // declared tool call in full.
    // Per-agent guardrail-model fees. Same shape as provider tool fees:
    // each agent picks a guard model preset (Llama Guard, Granite
    // Guardian, OpenAI Moderation, Bedrock Guardrails, etc.), each
    // preset has its own cost shape (per-token / per-check / free).
    // Compute one line per agent, sum into headline. Skipped silently
    // if cost-engine's GUARD_MODEL_PRESETS isn't loaded yet.
    let guardModelFeesMonthly = 0;
    try {
      const presets = window.CostEngine && window.CostEngine.GUARD_MODEL_PRESETS;
      if (presets) {
        const agentsList = (workload.agents && workload.agents.length > 0)
          ? workload.agents
          : [{ guard_model: 'custom', input_tokens: 0, calls_per_query: 1 }];
        const totalCalls = agentsList.reduce((a, x) => a + (x.calls_per_query || 1), 0) || 1;
        for (const ag of agentsList) {
          const preset = presets[ag.guard_model || 'custom'];
          if (!preset || preset.shape === 'free') continue;
          const callsShare = (ag.calls_per_query || 1) / totalCalls;
          if (preset.shape === 'perMillionTokens') {
            if (preset.ratePerMillion == null) continue; // 'custom' defers to legacy s-guard-model slider
            // Approx guard tokens per query = guard_in + guard_out + guard_pii + guard_policy.
            // For agent-mode workloads these aren't carried on workload.agents (engine reads
            // composite input_tokens). Use a reasonable per-query guard-token estimate:
            // 5% of the agent's input_tokens, floored at 200 tok (matches typical Llama
            // Guard 3 input+output ~500 tokens per check × 3 checks/turn).
            const guardTokensPerQuery = Math.max(200, Math.round((ag.input_tokens || 0) * 0.05));
            guardModelFeesMonthly += (guardTokensPerQuery / 1e6) * preset.ratePerMillion * queries * callsShare;
          } else if (preset.shape === 'perCheck') {
            const checks = preset.checksPerQuery || 3;
            guardModelFeesMonthly += checks * preset.perCheckUsd * queries * callsShare;
          }
        }
      }
    } catch (_) { /* engine not ready */ }

    // composed.headline already includes engine-computed tool fees
    // (r.tool_fees); guard-model fees remain an app.js-side addition.
    const headlineTotal = composed.headline + guardModelFeesMonthly;
    // Publish the all-in headline so downstream panels (the budget warning
    // banner inside the cost simulator, in particular) compare against the
    // same number the user sees in the cost-pill. Without this, the budget
    // check only saw the LLM-bill portion and a $43M/mo headline could
    // silently exceed a $10K budget without firing the OVER badge.
    window.__lastHeadlineMonthly = headlineTotal;
    // Cache per-agent monthly cost contributions + the opts that produced
    // them, so the per-agent "Compare models" view in the agent card can
    // re-run CostEngine with a swapped model and read the agent's new
    // monthly contribution. Keeps the comparison aligned with whatever
    // hosting/tier/cache/etc. the user has set in the live UI.
    const _qTotal = (result.queries && result.queries.total) || 0;
    window.__perAgentMonthly = (result.api && result.api.agent_breakdown)
      ? result.api.agent_breakdown.map(b => (b && b.per_query_cost ? b.per_query_cost * _qTotal : 0))
      : [];
    window.__lastEngineOpts = opts;

    // Annual + 3-year TCO. The cost-over-time projection chart and the
    // topbar pill's /3yr supplement both need to compound the monthly
    // baseline by the Growth/month slider (otherwise the slider visibly
    // does nothing — a long-running confusion).
    //
    //   sum_{m=1..N} baseline·(1+r)^(m-1)
    //     = baseline·N                                  (r=0)
    //     = baseline·((1+r)^N - 1) / r                  (r>0)
    //
    // setup_amortized is already a monthly number for self-host (annual
    // setup ÷ 12), so the growth-compounded recurring sum is the right
    // TCO without an extra one-time term.
    const _growthEl = document.getElementById('s-growth');
    const _growthPct = _growthEl ? parseFloat(_growthEl.value) : 0;
    const _growthRate = Number.isFinite(_growthPct) ? _growthPct / 100 : 0;
    const cumulativeOverMonths = (months) => {
      if (_growthRate === 0) return headlineTotal * months;
      return headlineTotal * (Math.pow(1 + _growthRate, months) - 1) / _growthRate;
    };
    const annualTotal = cumulativeOverMonths(12);
    const threeYearTotal = cumulativeOverMonths(36);
    const tcoPeriod = (document.querySelector('input[name="tco-period"]:checked') || {}).value || 'monthly';
    const tcoLabel = tcoPeriod === 'annual' ? 'Annual cost' : tcoPeriod === '3yr' ? '3-year cumulative cost' : 'Total monthly cost';
    const tcoValue = tcoPeriod === 'annual' ? annualTotal : tcoPeriod === '3yr' ? threeYearTotal : headlineTotal;
    const headlineEl = document.getElementById('prev-headline-label');
    if (headlineEl) headlineEl.textContent = tcoLabel + (workload.deployment.agency ? ' · ' + workload.deployment.agency : '');
    // Build hover formulas for every key number so users can see the derivation inline
    const totalEl = document.getElementById('prev-total');
    totalEl.textContent = fmt$(tcoValue);
    // Live-update the topbar cost badge — visible across all tabs.
    const cbNum = document.getElementById('cb-num');
    const cbSuffix = document.getElementById('cb-suffix');
    if (cbNum) cbNum.textContent = fmt$(tcoValue);
    if (cbSuffix) cbSuffix.textContent = tcoPeriod === 'annual' ? '/yr' : (tcoPeriod === '3yr' ? '/3yr' : '/mo');
    // Secondary 3-year TCO supplement on the pill. The growth slider only
    // moves projections (not the headline-month), so without a 3-yr
    // number visible the user gets no feedback from dragging it. Hide
    // when the primary tcoPeriod is already 3yr to avoid duplication.
    const cbTco = document.getElementById('cb-tco');
    const cbTcoSep = document.getElementById('cb-tco-sep');
    if (cbTco && cbTcoSep) {
      if (tcoPeriod === '3yr') {
        cbTco.style.display = 'none';
        cbTcoSep.style.display = 'none';
      } else {
        cbTco.style.display = '';
        cbTcoSep.style.display = '';
        cbTco.textContent = fmt$(threeYearTotal) + '/3yr';
      }
    }
    // Daily-cap binding indicator. The engine clips API cost at the
    // configured daily cap (Section §refusals). When binding, gross >
    // capped and some queries are refused — without this badge, dragging
    // s-agents or s-users above the cap-saturation point looks like a
    // silent no-op on the headline. The badge surfaces refusal rate so
    // procurement sees the "you're paying the cap, refusing N%" reality.
    const cbCapWarn = document.getElementById('cb-cap-warn');
    if (cbCapWarn) {
      const apiGross   = result.api?.monthly_gross || 0;
      const apiCapped  = result.api?.monthly_capped || 0;
      const refused    = result.api?.monthly_refused_queries || 0;
      const queries    = result.queries?.total || 0;
      const isBinding  = apiGross > apiCapped + 1 && refused > 0;
      if (isBinding) {
        const refusedPct = queries > 0 ? (100 * refused / queries) : 0;
        const capDollars = workload?.daily_cap?.amount_usd || 0;
        cbCapWarn.textContent = `Cap · ${refusedPct.toFixed(0)}% refused`;
        cbCapWarn.style.display = '';
        // Inject the LIVE numbers into the rich data-tip from index.html so
        // hovering shows the exact gross/capped/refused numbers for the
        // current workload, not just the generic explainer. We rebuild the
        // tip each render to keep dollars/queries fresh as sliders move.
        const liveStats =
          `### What this badge means\n\n` +
          `Your **daily spend cap of $${capDollars.toLocaleString()}/day** is binding — projected demand would cost more per day than the cap allows, so the engine refuses queries above the cap.\n\n` +
          `**Live numbers right now:**\n` +
          `- Gross (uncapped): **${fmt$(apiGross)}/mo**\n` +
          `- After cap: **${fmt$(apiCapped)}/mo** (saves ${fmt$(apiGross - apiCapped)})\n` +
          `- Refused: **${refused.toLocaleString()} queries/mo** out of ${queries.toLocaleString()} (${refusedPct.toFixed(1)}%)\n\n` +
          `**What '${refusedPct.toFixed(0)}% refused' means:** that share of monthly queries get rejected with HTTP 429/503 once the daily $-budget is hit. Real users see errors, not LLM responses.\n\n` +
          `### Why this is happening\n\n` +
          `Either your cap is low relative to projected traffic, OR you've dragged MAU/sessions/questions up past what the cap can fund, OR the loaded preset's default cap is below this workload's actual demand.\n\n` +
          `### What to do — three options\n\n` +
          `**(1) Raise the cap** to match your real production budget.\n\n` +
          `**(2) Reduce demand** — lower MAU, sessions/day, or questions/session until the badge stops appearing.\n\n` +
          `**(3) Accept the refusal rate** — if ${refusedPct.toFixed(0)}% refused is acceptable for your SLA, this is a legitimate cost-containment posture.\n\n` +
          `### Where to adjust the cap\n\n` +
          `The daily-cap input was retired from the standard UI (most users don't tune it) but the field is still in the workload JSON. To change it:\n\n` +
          `1. Click **'Edit JSON'** in the top bar\n` +
          `2. Find \`daily_cap.amount_usd\` (currently $${capDollars.toLocaleString()})\n` +
          `3. Edit, save, reload\n\n` +
          `Heads-up: dragging s-agents or s-users while the cap is binding moves GROSS cost up but not the headline — the cap clips the difference. That's why the headline looks unresponsive.`;
        cbCapWarn.setAttribute('data-tip', liveStats);
      } else {
        cbCapWarn.style.display = 'none';
      }
    }
    const llmLabel = opts.hosting === 'self' ? 'Self-host'
                   : opts.hosting === 'hybrid' ? 'Hybrid'
                   : opts.hosting === 'onprem' ? 'On-prem (amortized)'
                   : 'API LLM';
    totalEl.title =
      `${tcoLabel} = headline monthly × ${tcoPeriod === 'annual' ? '12' : tcoPeriod === '3yr' ? '36' : '1'}\n` +
      `Headline monthly = ${llmLabel} ${fmt$(llmHeadline)}` +
      (verifMonthly > 0 ? ` + verification ${fmt$(verifMonthly)}` : '') +
      (embeddingMonthly > 0 ? ` + embeddings ${fmt$(embeddingMonthly)}` : '') +
      (personnelMonthly > 0 ? ` + personnel ${fmt$(personnelMonthly)}` : '') +
      (agentEngMonthly > 0 ? ` + agent-eng ${fmt$(agentEngMonthly)}` : '') +
      (federalAdditive > 0 ? ` + federal ${fmt$(federalAdditive)}` : '') +
      (fixedCosts > 0 ? ` + fixed ${fmt$(fixedCosts)}` : '') +
      `\n  = ${fmt$(headlineTotal)}/mo`;
    const captionParts = [
      `Monthly: ${fmt$(headlineTotal)}`,
      `${queries.toLocaleString(undefined, { maximumFractionDigits: 0 })} queries/mo`,
      `Hosting: ${opts.hosting}`,
    ];
    if (verifMonthly > 0) captionParts.push(`Verif: +${fmt$(verifMonthly)}`);
    document.getElementById('prev-total-caption').textContent = captionParts.join(' · ');

    // Risk uncertainty bands — show ±range from sensitivity analysis
    const riskBand = document.getElementById('prev-risk-band');
    const riskRange = document.getElementById('prev-risk-range');
    const riskToggle = document.getElementById('prev-risk-toggle');
    if (riskBand) {
      const riskOn = workload.risk && workload.risk.enabled;
      riskBand.style.display = '';
      riskBand.classList.toggle('off', !riskOn);
      if (riskToggle) riskToggle.textContent = riskOn ? 'ON' : 'OFF';
      if (riskOn && result.risk_bands) {
        const r = result.risk_bands;
        // Apply same period multiplier as the headline
        const mult = tcoPeriod === 'annual' ? 12 : tcoPeriod === '3yr' ? 36 : 1;
        if (riskRange) riskRange.textContent = `${fmt$(r.low * mult)} – ${fmt$(r.high * mult)}  (±${Math.round(r.spread_percent * 100)}%)`;
      } else if (riskRange) {
        riskRange.textContent = 'turn ON to compute the variance band';
      }
    }
    // Calibration badge — surfaces "validated against real API" status
    // for presets whose anchor_query has a _calibration block (written
    // by scripts/validate-preset.py). Includes a retrieval-payload mode
    // toggle (minimal / moderate / heavy) when payload_modes is defined,
    // so the user can dial up from "measured floor" to "estimated upper
    // bound" without leaving the headline.
    renderCalibrationBadge();

    const annualEl = document.getElementById('prev-annual');
    annualEl.textContent = fmt$(annualTotal);
    annualEl.title = `${fmt$(headlineTotal)}/mo × 12 = ${fmt$(annualTotal)}/yr`;
    const threeYearEl = document.getElementById('prev-3yr');
    if (threeYearEl) {
      threeYearEl.textContent = fmt$(threeYearTotal);
      threeYearEl.title = `${fmt$(headlineTotal)}/mo × 36 months = ${fmt$(threeYearTotal)} cumulative\n(simple TCO; doesn't include phase transitions — use Migration Timeline for those)`;
    }
    const perUserEl = document.getElementById('prev-per-user');
    perUserEl.textContent = totalMau > 0 ? '$' + (headlineTotal / totalMau).toFixed(2) : '—';
    perUserEl.title = totalMau > 0
      ? `${fmt$(headlineTotal)}/mo ÷ ${fmtN(totalMau)} total MAU = $${(headlineTotal / totalMau).toFixed(2)}/user/month\n(Compare against published benchmarks in 📊 Benchmarks tab)`
      : 'Set MAU on a segment to compute';
    const queriesEl2 = document.getElementById('prev-queries');
    queriesEl2.textContent = fmtN(queries);
    const segCount = workload.segments.length;
    const sumDetails = workload.segments.map(s => {
      const beta = s.applyBotFactor ? (result.queries.botEffective || 1) : 1;
      const q = (s.mau || 0) * (s.sessions_per_day || 0) * 30 * (s.questions_per_session || 0) * beta;
      return `  ${s.label || s.id}: ${fmtN(s.mau || 0)} × ${s.sessions_per_day || 0}/day × 30 × ${s.questions_per_session || 0}/sess${s.applyBotFactor ? ` × ${beta.toFixed(1)} bot` : ''} = ${fmtN(q)}`;
    }).join('\n');
    queriesEl2.title = `Total queries/month = sum across ${segCount} segment${segCount === 1 ? '' : 's'}:\n${sumDetails}\n  TOTAL: ${fmtN(queries)}`;

    // Refresh benchmarks comparison whenever the headline updates
    if (typeof window.__ccsUpdateBenchmark === 'function') window.__ccsUpdateBenchmark();

    // Comparison table
    const table = document.getElementById('prev-compare');
    const sh = result.self_host;
    const shc = result.self_host_capped;
    const apiCapped = result.api.monthly_capped;
    const apiGross = result.api.monthly_gross;
    const refused = result.api.monthly_refused_queries;

    const star = (cond) => cond ? ' class="row-highlight"' : '';
    let rows = '';
    rows += `<tr${star(opts.hosting === 'api')}>
      <td>API · ${opts.model} <em style="color: var(--muted); font-style: normal;">(capped)</em></td>
      <td class="num">${fmt$(apiCapped)}</td>
      <td>${refused > 0 ? `${fmtN(queries - refused)} served · <span class="refused">${fmtN(refused)} refused</span>` : 'all queries'}</td>
    </tr>`;
    if (Math.abs(apiGross - apiCapped) > 50) {
      rows += `<tr>
        <td>API · ${opts.model} <em style="color: var(--muted); font-style: normal;">(uncapped — fair peer)</em></td>
        <td class="num">${fmt$(apiGross)}</td>
        <td>all queries</td>
      </tr>`;
    }
    rows += `<tr${star(opts.hosting === 'self')}>
      <td>Self-host · ${sh.gpu_spec.name} × ${sh.instances} <em style="color: var(--muted); font-style: normal;">(${sh.cost_mode}, ${opts.commitment})</em></td>
      <td class="num">${fmt$(sh.total)}</td>
      <td>all queries · <span class="refused">−8–15 pts quality ⚠</span></td>
    </tr>`;
    if (opts.hosting === 'hybrid' && result.hybrid) {
      const h = result.hybrid;
      const lowSelfWarning = (h.self_share > 0 && h.self_share < 0.30)
        ? `<br><span style="color:#b3333d; font-size:10px; font-style:italic;">⚠ At ${Math.round(h.self_share*100)}% self-host share, fixed ops/FTE costs dominate. Hybrid is rarely cost-effective below 30% self-host.</span>`
        : '';
      rows += `<tr class="row-highlight">
        <td><strong>Hybrid (split):</strong> ${Math.round(h.api_share*100)}% API + ${Math.round(h.self_share*100)}% self-host${lowSelfWarning}</td>
        <td class="num"><strong>${fmt$(h.total)}</strong></td>
        <td>API ${fmt$(h.api_part.monthly_capped)} + Self-host ${fmt$(h.self_part.total)}</td>
      </tr>`;
    }
    if (reservation.enabled && reservation.savings > 0) {
      const r = reservation;
      rows += `<tr>
        <td>↳ API reservation (${r.type}) <em style="color: var(--muted); font-style: normal;">${escapeHtml(r.notes || '')}</em></td>
        <td class="num"><span style="color: var(--good, #2a6a2a);">−${fmt$(r.savings)}</span></td>
        <td>savings vs on-demand</td>
      </tr>`;
    }
    // Surface auto-PTU-sizing derivation in the dedicated detail panel
    // so users can see how the unit count was computed.
    const sizingPanel = document.getElementById('ptu-sizing-detail');
    if (sizingPanel) {
      const sd = reservation && reservation.sizing_detail;
      if (sd) {
        sizingPanel.style.display = 'block';
        sizingPanel.innerHTML = `
          <strong>Auto-sized:</strong> <strong>${sd.units} PTU</strong> needed for <code>${sd.model || '(default model)'}</code>
          <span style="color:var(--muted);">(${sd.tps_per_ptu} TPS/PTU)</span>
          <br><span style="color:var(--muted); font-size:10.5px;">${escapeHtml(sd.derivation)}</span>
        `;
      } else {
        sizingPanel.style.display = 'none';
      }
    }
    if (embeddingMonthly > 0 && result.embedding) {
      const e = result.embedding;
      rows += `<tr>
        <td>Embeddings <em style="color: var(--muted); font-style: normal;">(${e.model}: ingest ${fmt$(e.ingest_amortized)}/mo + query ${fmt$(e.query_monthly)}/mo)</em></td>
        <td class="num">${fmt$(embeddingMonthly)}</td>
        <td>RAG ingest + per-query embedding</td>
      </tr>`;
    }
    if (personnelMonthly > 0 && result.personnel) {
      const p = result.personnel;
      const roleSummary = p.breakdown.map(b => `${humanizeRole(b.role)} ${b.fte}`).join(', ');
      rows += `<tr>
        <td>Personnel <em style="color: var(--muted); font-style: normal;">(${escapeHtml(roleSummary)})</em></td>
        <td class="num">${fmt$(personnelMonthly)}</td>
        <td>${p.breakdown.length} role${p.breakdown.length === 1 ? '' : 's'}, FTE-allocated</td>
      </tr>`;
    }
    if (shc) {
      rows += `<tr>
        <td>Self-host <em style="color: var(--muted); font-style: normal;">(capped to same $${workload.daily_cap?.amount_usd ?? 0}/day)</em></td>
        <td class="num">${fmt$(shc.total)}</td>
        <td>${fmtN(shc.queries_served)} served · ${shc.queries_refused > 0 ? `<span class="refused">${fmtN(shc.queries_refused)} refused</span>` : 'all queries'}</td>
      </tr>`;
    }
    if (verifMonthly > 0) {
      const v = result.verification;
      rows += `<tr>
        <td>Verification · ${v.variant.toUpperCase()} <em style="color: var(--muted); font-style: normal;">(${Math.round(v.coverage*100)}% coverage, ${v.nli_hosting})</em></td>
        <td class="num">${fmt$(verifMonthly)}</td>
        <td>${fmtN(v.verified_queries)} verified queries</td>
      </tr>`;
    }
    if (federalAdditive > 0) {
      const fb = result.federal.breakdown || {};
      const items = [];
      if (fb.ato_monthly) items.push('ATO');
      if (fb.egress_monthly) items.push('egress');
      if (fb.audit_retention_monthly) items.push('audit');
      if (fb.retrieval_infra_monthly) items.push('retrieval');
      if (fb.pii_redaction_monthly) items.push('PII');
      rows += `<tr>
        <td>Federal compliance <em style="color: var(--muted); font-style: normal;">(${items.join(', ') || 'misc'})</em></td>
        <td class="num">${fmt$(federalAdditive)}</td>
        <td>additive line items</td>
      </tr>`;
    }
    if (hostingPremium > 0.5) {
      const f = result.federal || {};
      const mult = f.hosting_multiplier || 1;
      const premiumPct = Math.round((mult - 1) * 100);
      const tierLabel = (f.fedramp_tier && f.fedramp_tier !== 'none')
        ? `FedRAMP ${f.fedramp_tier}`
        : ((f.multi_region && f.multi_region !== 'single') ? `Multi-region (${f.multi_region})` : 'Compliance');
      const llmBase = Math.max(1, (apiBill || 0) - hostingPremium);
      const llmPct = Math.round((hostingPremium / llmBase) * 100);
      rows += `<tr>
        <td><strong>${tierLabel} premium</strong> <em style="color: var(--muted); font-style: normal;">(×${mult.toFixed(2)} multiplier · +${premiumPct}%)</em></td>
        <td class="num">+${fmt$(hostingPremium)}</td>
        <td>${llmPct}% of LLM compute · already included in API row</td>
      </tr>`;
    }
    if (fixedCosts > 0) {
      const infraCount = Object.keys(workload.infrastructure || {}).length;
      const labelParts = [];
      if (infraTotal > 0) labelParts.push(`${infraCount} infra item${infraCount === 1 ? '' : 's'}`);
      if (rateLimitCost > 0) labelParts.push(`rate-limiting`);
      rows += `<tr>
        <td>Fixed monthly costs <em style="color: var(--muted); font-style: normal;">(${labelParts.join(' + ')})</em></td>
        <td class="num">${fmt$(fixedCosts)}</td>
        <td>fixed monthly</td>
      </tr>`;
    }
    table.innerHTML = `<thead><tr><th>Strategy</th><th style="text-align:right;">$ / month</th><th>Notes</th></tr></thead><tbody>${rows}</tbody>`;

    // Summary note
    const apiServed = queries - refused;
    const shcServed = shc ? shc.queries_served : 0;
    let note = '';
    if (shc && apiServed > 0) {
      const diff = ((shcServed - apiServed) / apiServed) * 100;
      const verdict = Math.abs(diff) < 10
        ? `both strategies serve roughly the same number of queries`
        : (diff > 0
            ? `<strong style="color: var(--good);">self-host serves ~${Math.abs(Math.round(diff))}% more queries</strong> at the same budget`
            : `<strong style="color: var(--bad);">API serves ~${Math.abs(Math.round(diff))}% more queries</strong> at the same budget`);
      note = `<strong>At equal budget</strong> — ${fmt$(workload.daily_cap?.amount_usd ?? 0)}/day cap buys <strong>${fmtN(apiServed)}</strong> served queries on API vs <strong>${fmtN(shcServed)}</strong> on self-host: ${verdict}. The supposed cost advantage of self-host evaporates at equal budget; the procurement decision pivots to quality, operational burden, and vendor risk.`;
    } else {
      note = 'Configure a daily cap to see the same-budget fair comparison.';
    }
    // Break-even line — single-number procurement signal: at what
    // monthly volume does self-host beat API on pure inference $?
    const be = result.break_even;
    if (be && be.found && be.break_even_queries) {
      const above = queries > be.break_even_queries;
      note += `<br><br><strong>Break-even:</strong> self-host beats API above <strong>${fmtN(be.break_even_queries)}</strong> queries/month (pure inference $; excludes verification, federal, personnel, fixed infra). Your current volume of ${fmtN(queries)} is <strong style="color: var(--${above ? 'good' : 'muted'});">${above ? 'above' : 'below'}</strong> the crossover.`;
    } else if (be && !be.found) {
      const which = be.cheaper_in_range === 'api' ? 'API' : 'self-host';
      note += `<br><br><strong>Break-even:</strong> ${which} is cheaper across the full 1K–100M queries/mo range; no crossover under current assumptions.`;
    }
    document.getElementById('prev-summary').innerHTML = note;

    // Scenario tag
    const tagEl = document.getElementById('prev-scenario-tag');
    if (tagEl) {
      const parts = [
        `${opts.hosting === 'self' ? 'Self-host' : 'API'} · ${opts.model}`,
        `tier=${opts.tier}`,
        `mix=${opts.mix}`,
        `${opts.costMode}`,
      ];
      if (opts.hosting === 'self') parts.push(`${opts.commitment}`);
      if (opts.verifCoverage > 0) parts.push(`verif ${Math.round(opts.verifCoverage*100)}%`);
      tagEl.textContent = parts.join(' · ');
    }

    // Cost composition stacked bar
    const compEl = document.getElementById('prev-composition-chart');
    if (compEl) {
      // Use the hosting-resolved, retry-inflated LLM cost so the
       // composition reconciles to the headline total.
      const llmCost = llmHeadline;
      const components = [
        { label: opts.hosting === 'self' ? 'Self-host LLM' : (opts.hosting === 'hybrid' ? 'Hybrid LLM' : 'API LLM'), value: llmCost, color: '#8b2331' },
        { label: 'Verification', value: verifMonthly, color: '#0a5d5a' },
        { label: 'Embeddings', value: embeddingMonthly, color: '#2a6a2a' },
        { label: 'Personnel', value: personnelMonthly, color: '#1f5a8a' },
        { label: 'Federal compliance', value: federalAdditive, color: '#5a3870' },
        { label: 'Fixed monthly', value: fixedCosts, color: '#8a5d00' },
      ].filter(c => c.value > 0);
      const total = components.reduce((a, c) => a + c.value, 0);
      if (total > 0) {
        // Show small slices with real precision (e.g. "0.4%", "<0.1%")
        // instead of misleading "0%". When the dominant slice is the
        // only material one, drop its inline "100%" label — pairing
        // "100%" inside the bar with "0%" rows below looked wrong.
        const fmtPct = (pct) => {
          if (pct >= 1)   return Math.round(pct) + '%';
          if (pct >= 0.1) return pct.toFixed(1) + '%';
          if (pct > 0)    return '<0.1%';
          return '0%';
        };
        const dominantIdx = components.reduce((bi, c, i, arr) => c.value > arr[bi].value ? i : bi, 0);
        const dominantPct = (components[dominantIdx].value / total) * 100;
        const dominantIsOnlyMaterial = dominantPct >= 99.5;
        const segments = components.map((c, i) => {
          const pct = (c.value / total) * 100;
          const showInline = pct >= 8 && !(dominantIsOnlyMaterial && i === dominantIdx);
          return `<div class="seg" style="background:${c.color}; width:${pct}%;" title="${c.label}: ${fmt$(c.value)} (${fmtPct(pct)})">${showInline ? Math.round(pct)+'%' : ''}</div>`;
        }).join('');
        const legend = components.map(c => `
          <div class="legend-item">
            <span class="swatch" style="background:${c.color};"></span>
            <span class="legend-label">${c.label}</span>
            <span class="legend-val">${fmt$(c.value)} · ${fmtPct((c.value/total)*100)}</span>
          </div>`).join('');
        compEl.innerHTML = `<div class="stack-bar">${segments}</div><div class="legend">${legend}</div>`;
      } else {
        compEl.innerHTML = '<em style="color:var(--muted);">No cost components yet.</em>';
      }
    }

    // Per-agent breakdown (multi-agent mode)
    const agentSection = document.getElementById('prev-agents-section');
    const agentChart = document.getElementById('prev-agents-chart');
    const agentTable = document.getElementById('prev-agents-table');
    if (agentSection && agentChart && agentTable) {
      const agentBreakdown = result.api.agent_breakdown;
      if (result.api.agent_mode && agentBreakdown && agentBreakdown.length > 0) {
        agentSection.style.display = '';
        // Scale: sum monthly contribution = totalCost / queries.total × queries.total
        // But we already have per_query_cost from the breakdown (assuming default segment cache)
        const totalQueries = queries;
        const monthlyByAgent = agentBreakdown.map(a => ({
          ...a, monthly: a.per_query_cost * totalQueries,
        }));
        const totalMonthly = monthlyByAgent.reduce((a, b) => a + b.monthly, 0);
        const maxMonthly = Math.max(...monthlyByAgent.map(a => a.monthly));
        agentChart.innerHTML = monthlyByAgent.map(a => {
          const pct = maxMonthly > 0 ? (a.monthly / maxMonthly) * 100 : 0;
          return `<div class="agent-row">
            <div class="agent-label" title="${a.label}">${a.label}</div>
            <div class="agent-bar-track"><div class="agent-bar-fill" style="width:${pct}%;"></div></div>
            <div class="agent-num">${fmt$(a.monthly)}</div>
          </div>`;
        }).join('');
        // BYOK / self-host agents have a.hosting set + an a.note from the
        // engine. Surface that in the procurement table so a reviewer
        // doesn't read a $0 monthly as "missed line item" — they see the
        // intentional 'billed elsewhere' annotation. Also adds a Hosting
        // column so the procurement memo explicitly itemizes which agents
        // bill to the user's key vs the API line vs self-host capacity.
        let hasNonApi = false;
        let agentRows = monthlyByAgent.map(a => {
          const hosting = a.hosting || 'api';
          const nonApi = hosting === 'byok' || hosting === 'self-host';
          if (nonApi) hasNonApi = true;
          const hostingCell = nonApi
            ? `<span style="color:var(--accent,#8b2331);font-weight:600;font-size:11px;" title="${(a.note || '').replace(/"/g,'&quot;')}">${hosting === 'byok' ? 'BYOK' : 'self-host'}</span>`
            : `<span style="color:var(--muted);font-size:11px;">API</span>`;
          const monthlyCell = nonApi
            ? `<span style="color:var(--accent,#8b2331);font-style:italic;" title="${(a.note || '').replace(/"/g,'&quot;')}">$0 (excl.)</span>`
            : fmt$(a.monthly);
          const pctCell = nonApi ? '—' : `${totalMonthly > 0 ? Math.round(a.monthly/totalMonthly*100) : 0}%`;
          return `<tr${nonApi ? ' style="opacity:.78"' : ''}>
            <td>${a.label}</td>
            <td><span style="font-family:var(--mono); color:var(--muted); font-size:11px;">${a.model}</span></td>
            <td>${hostingCell}</td>
            <td class="num">${a.calls}</td>
            <td class="num">${a.input.toLocaleString()} / ${a.output.toLocaleString()}</td>
            <td class="num">$${a.per_call_cost.toFixed(4)}</td>
            <td class="num">${monthlyCell}</td>
            <td class="num">${pctCell}</td>
          </tr>`;
        }).join('');
        agentRows += `<tr class="row-highlight" style="font-weight:600;">
          <td>Total per query</td><td>—</td><td>—</td><td>—</td><td>—</td>
          <td class="num">$${(totalMonthly/totalQueries).toFixed(4)}</td>
          <td class="num">${fmt$(totalMonthly)}</td><td class="num">100%</td>
        </tr>`;
        if (hasNonApi) {
          agentRows += `<tr><td colspan="8" style="font-size:10.5px;color:var(--muted);font-style:italic;padding-top:6px;border-top:1px dashed var(--rule);">
            BYOK / self-host agents are intentionally excluded from the API line above. BYOK tokens bill to the user's own API key; self-host tokens are counted under the Self-host capacity section instead.
          </td></tr>`;
        }
        agentTable.innerHTML = `<thead><tr>
          <th>Agent</th><th>Model</th><th>Hosting</th>
          <th style="text-align:right;">Calls/q</th>
          <th style="text-align:right;">In / Out tok</th>
          <th style="text-align:right;">$ / call</th>
          <th style="text-align:right;">Monthly</th>
          <th style="text-align:right;">% of LLM</th>
        </tr></thead><tbody>${agentRows}</tbody>`;
      } else {
        agentSection.style.display = 'none';
      }
    }

    // Per-segment breakdown table
    const segTable = document.getElementById('prev-segments');
    if (segTable) {
      let segRows = '';
      for (const seg of workload.segments) {
        const segPq = result.api.per_segment[seg.id] || {};
        const segQ = result.queries.bySegment[seg.id] || 0;
        const segMonthly = segQ * (segPq.per_query || 0);
        segRows += `<tr>
          <td>${seg.label || seg.id} ${seg.applyBotFactor ? '<em style="color:var(--muted); font-style:normal;">· bot×' + (result.queries.botEffective).toFixed(1) + '</em>' : ''}</td>
          <td class="num">${fmtN(seg.mau)}</td>
          <td class="num">${fmtN(segQ)}</td>
          <td class="num">${((segPq.eff_cache || 0) * 100).toFixed(0)}%</td>
          <td class="num">$${(segPq.per_query || 0).toFixed(4)}</td>
          <td class="num">${fmt$(segMonthly)}</td>
        </tr>`;
      }
      segTable.innerHTML = `<thead><tr>
        <th>Segment</th>
        <th style="text-align:right;">MAU</th>
        <th style="text-align:right;">Queries/mo</th>
        <th style="text-align:right;">Eff cache</th>
        <th style="text-align:right;">$/query</th>
        <th style="text-align:right;">Monthly</th>
      </tr></thead><tbody>${segRows}</tbody>`;
    }

    // Verification breakdown
    // Migration timeline — render bar chart + per-phase table
    const migSection = document.getElementById('prev-migration-section');
    if (migSection) {
      if (result.migration && result.migration.enabled && Array.isArray(result.migration.phases) && result.migration.phases.length > 0) {
        migSection.style.display = '';
        const m = result.migration;
        // Build a stacked time-series bar: x = months, height = monthly cost,
        // colored by phase
        const W = 720, H = 180;
        const padL = 50, padR = 12, padT = 14, padB = 30;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const totalMonths = m.total_months;
        const maxMonthly = Math.max(...m.phases.map(p => p.monthly_cost), 1);
        const colors = ['#8b2331', '#1f5a8a', '#2a6a2a', '#5a3870', '#8a5d00', '#0a5d5a'];
        let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
        // Y axis grid + labels
        for (let yPct = 0; yPct <= 1; yPct += 0.25) {
          const y = padT + (1 - yPct) * plotH;
          svg += `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#eee" stroke-width="0.5"/>`;
          svg += `<text class="axis-label" x="${padL - 4}" y="${y + 3}" text-anchor="end">${fmt$(maxMonthly * yPct)}</text>`;
        }
        // Phase bars
        let cumX = 0;
        for (let i = 0; i < m.phases.length; i++) {
          const ph = m.phases[i];
          const xStart = padL + (cumX / totalMonths) * plotW;
          const xEnd = padL + ((cumX + ph.months) / totalMonths) * plotW;
          const yTop = padT + (1 - ph.monthly_cost / maxMonthly) * plotH;
          const yBot = padT + plotH;
          const color = colors[i % colors.length];
          svg += `<rect class="phase-bar" x="${xStart}" y="${yTop}" width="${xEnd - xStart}" height="${yBot - yTop}" fill="${color}"/>`;
          // Phase label
          const labelX = (xStart + xEnd) / 2;
          if (xEnd - xStart > 50) {
            svg += `<text class="phase-label" x="${labelX}" y="${yTop + 14}" text-anchor="middle">${escapeHtml(ph.label)}</text>`;
            svg += `<text class="phase-label" x="${labelX}" y="${yTop + 24}" text-anchor="middle">${fmt$(ph.monthly_cost)}/mo</text>`;
          }
          // Month tick
          svg += `<text class="axis-label" x="${xEnd}" y="${yBot + 12}" text-anchor="middle">m${cumX + ph.months}</text>`;
          cumX += ph.months;
        }
        // X-axis baseline
        svg += `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#999" stroke-width="0.5"/>`;
        svg += `<text class="axis-label" x="${padL}" y="${padT + plotH + 12}" text-anchor="start">m0</text>`;
        svg += `</svg>`;
        document.getElementById('prev-migration-chart').innerHTML =
          `<div style="font-family: var(--sans); font-size: 11px; color: var(--muted); margin-bottom: 4px;">
            <strong>Cost over time</strong> across ${m.phases.length} phase${m.phases.length === 1 ? '' : 's'} · ${m.total_months} months total
          </div>${svg}`;
        // Per-phase table
        const tbl = document.getElementById('prev-migration-table');
        let trows = '';
        m.phases.forEach((p, i) => {
          trows += `<tr>
            <td><span style="display:inline-block; width:10px; height:10px; background:${colors[i % colors.length]}; margin-right:6px; border-radius:2px;"></span>${escapeHtml(p.label)}</td>
            <td>${p.months} mo</td>
            <td>${p.hosting}${p.reservation_type && p.reservation_type !== 'none' ? ` · ${p.reservation_type}` : ''}</td>
            <td class="num">${fmt$(p.monthly_cost)}/mo</td>
            <td class="num">${fmt$(p.phase_total)}</td>
          </tr>`;
        });
        trows += `<tr class="row-highlight" style="font-weight:600;">
          <td>Total ${m.total_months}-month TCO</td>
          <td>—</td><td>—</td>
          <td class="num">${fmt$(m.total_spend / m.total_months)}/mo avg</td>
          <td class="num">${fmt$(m.total_spend)}</td>
        </tr>`;
        tbl.innerHTML = `<thead><tr><th>Phase</th><th>Months</th><th>Hosting</th><th style="text-align:right;">Monthly</th><th style="text-align:right;">Phase total</th></tr></thead><tbody>${trows}</tbody>`;
      } else {
        migSection.style.display = 'none';
      }
    }

    const verifSection = document.getElementById('prev-verif-section');
    const verifTable = document.getElementById('prev-verif-table');
    if (verifSection && verifTable) {
      if (result.verification.enabled && result.verification.coverage > 0) {
        verifSection.style.display = '';
        const v = result.verification;
        const b = v.breakdown || {};
        verifTable.innerHTML = `<thead><tr><th>Component</th><th style="text-align:right;">Monthly</th><th>Notes</th></tr></thead>
          <tbody>
            <tr><td>Atomizer (1 call/verified query)</td><td class="num">${fmt$(b.atomizer || 0)}</td><td>${fmtN(v.verified_queries)} × atomizer tokens</td></tr>
            <tr><td>Reviser (atoms × 1 call)</td><td class="num">${fmt$(b.reviser || 0)}</td><td>${(workload.verification.atoms_per_response || 8)} atoms each</td></tr>
            <tr><td>NLI (${v.variant.toUpperCase()} · ${v.nli_calls_per_atom} calls/atom)</td><td class="num">${fmt$(b.nli || 0)}</td><td>${v.nli_hosting === 'api' ? 'pay-per-token' : 'flat EC2 box'}</td></tr>
            <tr><td>Retrieval (${workload.verification.retrieval || 'wikipedia'})</td><td class="num">${fmt$(b.retrieval || 0)}</td><td>${workload.verification.retrieval === 'serper' ? '$5/1k calls' : 'free'}</td></tr>
            <tr><td>Service pod</td><td class="num">${fmt$(b.service_pod || 0)}</td><td>fixed monthly</td></tr>
            <tr class="row-highlight" style="font-weight:600;"><td>Total</td><td class="num">${fmt$(v.monthly)}</td><td>${fmtN(v.verified_queries)} verified queries</td></tr>
          </tbody>`;
        // Marginal-benefit curve: cost grows linearly with coverage, but
        // quality (hallucination catch-rate) saturates. Shows the
        // diminishing-return curve so users see why 100% rarely makes sense.
        const curveEl = document.getElementById('prev-verif-curve');
        if (curveEl) {
          const W = 320, H = 90;
          const padL = 32, padR = 8, padT = 8, padB = 22;
          const plotW = W - padL - padR, plotH = H - padT - padB;
          // Cost is linear in coverage. Catch-rate ≈ 1 − (1 − base)^k where k scales with coverage.
          const points = [];
          for (let i = 0; i <= 20; i++) {
            const cov = i / 20;  // 0..1
            const cost = cov;    // normalized
            const catch_rate = 1 - Math.pow(0.4, cov * 3);  // saturating curve
            points.push({ cov, cost, catch_rate });
          }
          const xCov = i => padL + i / 20 * plotW;
          const yCost = c => padT + (1 - c) * plotH;
          const yCatch = c => padT + (1 - c) * plotH;
          const costPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xCov(i)} ${yCost(p.cost)}`).join(' ');
          const catchPath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xCov(i)} ${yCatch(p.catch_rate)}`).join(' ');
          const userMarker = v.coverage * 20;
          curveEl.innerHTML = `
            <div style="font-family: var(--sans); font-size: 11px; color: var(--muted); margin-bottom: 4px;">
              <strong>Marginal benefit:</strong> cost rises linearly with coverage; hallucination-catch saturates. Diminishing returns above ~30% coverage.
            </div>
            <svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block; max-width: 360px;">
              <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#999" stroke-width="0.5"/>
              <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#999" stroke-width="0.5"/>
              <path d="${costPath}" stroke="#8b2331" fill="none" stroke-width="1.5"/>
              <path d="${catchPath}" stroke="#0a5d5a" fill="none" stroke-width="1.5"/>
              <line x1="${xCov(userMarker)}" y1="${padT}" x2="${xCov(userMarker)}" y2="${padT + plotH}" stroke="#d4761f" stroke-width="1" stroke-dasharray="3,2"/>
              <text x="${xCov(userMarker) + 3}" y="${padT + 10}" font-family="var(--mono)" font-size="9" fill="#d4761f">${Math.round(v.coverage * 100)}% (you)</text>
              <text x="${padL - 4}" y="${padT + 4}" font-size="8" font-family="var(--mono)" fill="#999" text-anchor="end">100%</text>
              <text x="${padL - 4}" y="${padT + plotH + 2}" font-size="8" font-family="var(--mono)" fill="#999" text-anchor="end">0%</text>
              <text x="${padL}" y="${H - 6}" font-size="9" font-family="var(--sans)" fill="#999">0%</text>
              <text x="${padL + plotW}" y="${H - 6}" font-size="9" font-family="var(--sans)" fill="#999" text-anchor="end">100% coverage</text>
              <text x="${padL + plotW - 60}" y="${padT + 10}" font-size="9" font-family="var(--sans)" fill="#8b2331">— cost</text>
              <text x="${padL + plotW - 60}" y="${padT + 22}" font-size="9" font-family="var(--sans)" fill="#0a5d5a">— catch-rate</text>
            </svg>`;
        }
      } else {
        verifSection.style.display = 'none';
      }
    }

    // Self-host capacity math
    const shSection = document.getElementById('prev-selfhost-section');
    const shTable = document.getElementById('prev-selfhost-table');
    if (shSection && shTable) {
      if (opts.hosting === 'self') {
        shSection.style.display = '';
        const tokensPerQ = opts.tokensPerQ;
        shTable.innerHTML = `<thead><tr><th>Quantity</th><th style="text-align:right;">Value</th><th>Where it comes from</th></tr></thead>
          <tbody>
            <tr><td>Average QPS</td><td class="num">${sh.qps_avg.toFixed(2)}</td><td>${fmtN(queries)} queries / (30 × 86,400 s)</td></tr>
            <tr><td>Peak tokens/sec needed</td><td class="num">${fmtN(sh.peak_tps)}</td><td>QPS × ${tokensPerQ} tok/q × diurnal ${workload.self_host.diurnal_peak_factor}× × headroom ${workload.self_host.headroom}×</td></tr>
            <tr><td>Per-instance throughput</td><td class="num">${fmtN(sh.effective_tput)}</td><td>${sh.gpu_spec.tput_tps} tok/s ${sh.cost_mode === 'realistic' ? '× 0.75 derate' : ''}</td></tr>
            <tr><td>Instances by load</td><td class="num">${sh.needed_by_load}</td><td>peak ÷ per-instance, ceiling</td></tr>
            <tr><td>Instances running</td><td class="num">${sh.instances}</td><td>max(load, HA floor=${workload.self_host.min_replicas})</td></tr>
            <tr><td>GPU spend</td><td class="num">${fmt$(sh.gpu_monthly)}</td><td>${sh.instances} × $${sh.gpu_spec.hourly}/hr × (1 − ${opts.commitment === 'on-demand' ? '0' : opts.commitment === 'ri-1y' ? Math.round(workload.self_host.cost_modes[sh.cost_mode].discount_1yr*100) + '%' : Math.round(workload.self_host.cost_modes[sh.cost_mode].discount_3yr*100) + '%'}) × 730 hr</td></tr>
            <tr><td>Ops monthly</td><td class="num">${fmt$(sh.ops_monthly)}</td><td>${sh.cost_mode} mode</td></tr>
            <tr><td>MLOps FTE allocation</td><td class="num">${fmt$(sh.fte_monthly)}</td><td>${sh.cost_mode} mode</td></tr>
            <tr><td>Setup amortized</td><td class="num">${fmt$(sh.setup_amortized)}</td><td>${sh.cost_mode === 'realistic' ? 'one-time setup spread over months' : 'optimistic mode hides this'}</td></tr>
            <tr class="row-highlight" style="font-weight:600;"><td>Total self-host</td><td class="num">${fmt$(sh.total)}</td><td>$/query: ${sh.effective_per_query.toFixed(4)}</td></tr>
          </tbody>`;
      } else {
        shSection.style.display = 'none';
      }
    }

    // Infrastructure breakdown
    const infraTable = document.getElementById('prev-infra');
    if (infraTable) {
      const items = Object.entries(workload.infrastructure || {}).sort((a, b) => b[1] - a[1]);
      if (items.length === 0) {
        infraTable.innerHTML = `<tbody><tr><td style="color: var(--muted);">No infrastructure services / components configured. Add them in section 10.</td></tr></tbody>`;
      } else {
        let infraRows = items.map(([n, c]) => `<tr><td>${n}</td><td class="num">${fmt$(c)}</td></tr>`).join('');
        infraRows += `<tr class="row-highlight" style="font-weight:600;"><td>Total infrastructure</td><td class="num">${fmt$(infraTotal)}</td></tr>`;
        infraTable.innerHTML = `<thead><tr><th>Service / Component</th><th style="text-align:right;">Monthly</th></tr></thead><tbody>${infraRows}</tbody>`;
      }
    }

    // Math walkthrough — show the engine's full deriveTrace() output as
    // a copy-pasteable monospace block, ready to drop into any AI for
    // independent verification of every formula and intermediate value.
    // Engine's trace covers queries → per-query → LLM → federal → fixed →
    // embeddings → personnel → grand total. App.js adds three things on
    // top of that: simulator input flow, retry inflation, agent engineering.
    // Append those as additional sections so the trace is self-contained.
    const mathEl = document.getElementById('prev-math');
    if (mathEl) {
      const engineTrace = result.derivation || '(no derivation available)';
      // Appendix sections A–D (workload→inputs, retry inflation, agent
      // engineering, final headline) are built by the PURE module
      // lib/derivation-trace.js — unit-tested in Node via
      // scripts/test-derivation-trace.js. This call site only gathers
      // the already-computed values from this render.
      const trace = engineTrace + DerivationTrace.buildAppendix({
        axTotalIn: _axTotalIn, axTotalOut: _axTotalOut, axTurns: _axTurns,
        retryRate, retryInflate,
        apiBillBefore: result.api.monthly_capped || 0, apiBill,
        agentEngineering, agentEngMonthly,
        hosting: opts.hosting,
        llmHeadline, verifMonthly, embeddingMonthly, personnelMonthly,
        federalAdditive, fixedCosts, headlineTotal,
      });
      mathEl.innerHTML = `
        <div class="math-trace-toolbar">
          <button class="math-copy-btn" id="math-copy-btn">📋 Copy entire derivation</button>
          <span class="math-trace-hint">Paste into any AI (ChatGPT, Claude, Gemini) and ask "verify this math". Every formula and intermediate value is shown.</span>
        </div>
        <pre class="math-trace" id="math-trace-pre">${colorizeTrace(trace)}</pre>
      `;
      const copyBtn = document.getElementById('math-copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(trace);
            copyBtn.textContent = '✓ Copied';
            setTimeout(() => { copyBtn.textContent = '📋 Copy entire derivation'; }, 1500);
          } catch (e) {
            copyBtn.textContent = '✗ Copy failed';
          }
        });
      }
    }

    // Model cost comparison — re-run the same compute against every model
    // in the price book and show sorted savings vs the current pick.
    renderModelCompare(opts, headlineTotal, retryInflate);

    // Budget solver — given the user's target budget, solve for max MAU at
    // current settings and show optimization knobs to unlock more headroom.
    renderBudgetSolver(opts, result, headlineTotal, retryInflate);

    // Sensitivity panel — tornado chart of headline shifts under ±perturbation
    // on the top drivers (MAU, cache, rates, bot, turns).
    renderSensitivity(opts, headlineTotal, retryInflate);

    // Cost-over-time projection (uses simulator s-growth slider).
    renderCostOverTime(headlineTotal);

    // Side-by-side preset compare — uses cached preset JSONs + the live opts.
    renderPresetCompare(opts, retryInflate).catch(() => {});

    // AS-IS vs proposed — compare against the user's current contract spend.
    renderAsIsCompare(headlineTotal);

    // Grey out sliders that are inert in the current mode so users
    // don't drag them and wonder why the cost doesn't change.
    syncSliderModeState();
  }

  // Marks sliders as disabled + greyed-out when they have no effect in
  // the current configuration, and re-enables them when they become live.
  // Called at the end of every renderPreview() pass.
  function syncSliderModeState() {
    // s-users / s-sessions / s-turns stay editable in BOTH single- and
    // multi-segment modes. In multi-segment, dragging routes through
    // scaleSegments() (app.js:3787) which proportionally rescales each
    // segment so the rollup matches the new slider value — segment
    // ratios are preserved. (Prior to 2026-05-30 these sliders were
    // greyed out in multi-segment, which violated the "presets are a
    // starting point, not a cage" principle: the working scaleSegments
    // path was always there.) A hover tooltip on multi-segment notes
    // the proportional behaviour so users know what to expect.
    const multiSeg = Array.isArray(workload.segments) && workload.segments.length > 1;
    const multiSegTip = multiSeg
      ? 'Multi-segment preset — dragging this rescales all segments proportionally (segment ratios preserved). Edit individual segments in the per-segment editor below for fine control.'
      : '';
    ['s-users', 's-sessions', 's-turns'].forEach(function(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = false;
      el.title = multiSegTip;
      const row = el.closest('div');
      if (row) row.classList.toggle('slider-inert', false);
    });

    // s-agents and s-comm-pattern stay editable even when workload.agents
    // is empty — they are PROMOTE_TRIGGERS (app.js:3858-3862): a real drag
    // on either one mirrors the workload-mode rollup into N agent rows
    // and switches the cost path to per-agent. Disabling them in noAgents
    // mode (as a prior commit did) was contradictory — it removed the
    // only mechanism to bootstrap into agent mode. A disabled <input
    // type=range> also swallows keyboard arrow events, which broke the
    // agent-promotion E2E scenario. Now a tooltip explains the
    // promotion behaviour so users know what dragging will do.
    const noAgents = !Array.isArray(workload.agents) || workload.agents.length === 0;
    const noAgentsTip = noAgents
      ? 'Drag to promote this workload-mode preset into a multi-agent fleet (mirrors current rollup into N agent rows; the ✓ MEASURED badge flies away to signal you’ve left the calibrated regime).'
      : '';
    ['s-agents', 's-comm-pattern'].forEach(function(id) {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = false;
      el.title = noAgentsTip;
      // No .slider-inert visual: dragging promotes the workload, which
      // is a meaningful action, not an inert one.
      const row = el.closest('div');
      if (row) row.classList.toggle('slider-inert', false);
    });

    // s-growth: always active (drives 3-yr TCO), but commonly misread as
    // affecting the monthly headline. Clarify with a static tooltip.
    const growthEl = document.getElementById('s-growth');
    if (growthEl && !growthEl.title) {
      growthEl.title = 'Affects the 3-year TCO projection, not the monthly cost headline.';
    }
  }

  // Inverse calculator: given a target budget, what's the maximum MAU the
  // deployment can serve at the current per-query cost rate? Plus a small
  // table showing how much more MAU you'd unlock by tweaking high-leverage
  // knobs (cache hit rate, model swap, batch tier, retry rate).
  function renderBudgetSolver(currentOpts, currentResult, currentHeadline, retryInflate = 1) {
    const headlineEl = document.getElementById('budget-result-headline');
    const detailEl   = document.getElementById('budget-result-detail');
    const inputEl    = document.getElementById('budget-target');
    if (!headlineEl || !inputEl) return;
    const budget = parseFloat(inputEl.value);
    if (!Number.isFinite(budget) || budget <= 0) {
      headlineEl.textContent = 'Enter a monthly budget above.';
      if (detailEl) detailEl.innerHTML = '';
      return;
    }
    const queries = currentResult.queries?.total || 0;
    const apiCost = currentResult.api?.monthly_with_retry != null
                    ? currentResult.api.monthly_with_retry
                    : (currentResult.api?.monthly_capped || 0) * retryInflate;
    const fixedCosts = (currentResult.fixed_costs?.total || 0);
    const verifMonthly = (currentResult.verification?.monthly || 0);
    const federalAdditive = (currentResult.federal?.additive_total || 0);
    const embeddingMonthly = (currentResult.embedding?.enabled ? currentResult.embedding.monthly : 0) || 0;
    const personnelMonthly = (currentResult.personnel?.enabled ? currentResult.personnel.monthly : 0) || 0;
    const agentEng = computeAgentEngineering();
    const agentEngMonthly = agentEng.enabled ? agentEng.monthly : 0;
    // Variable costs scale linearly with queries. Fixed costs don't.
    const fixedOverhead = fixedCosts + personnelMonthly + agentEngMonthly + (currentResult.embedding?.enabled ? (currentResult.embedding.ingest_amortized || 0) : 0);
    const variablePerQuery = queries > 0 ? (apiCost + verifMonthly + federalAdditive + (embeddingMonthly - (currentResult.embedding?.ingest_amortized || 0))) / queries : 0;
    const queriesAffordable = variablePerQuery > 0 ? Math.max(0, (budget - fixedOverhead) / variablePerQuery) : 0;
    // Convert affordable queries → affordable MAU (using current sessions/turns/bot)
    const $ = id => document.getElementById(id);
    const numVal = (id, fb) => { const e = $(id); return e ? parseFloat(e.value) : fb; };
    const sessionsPerUser = numVal('s-sessions', 0.3);
    const turnsPerSession = numVal('s-turns', 8);
    const bot = numVal('prev-bot', 1.5);
    const denom = sessionsPerUser * turnsPerSession * 30 * bot;
    const maxMAU = denom > 0 ? Math.floor(queriesAffordable / denom) : 0;
    const currentMAU = Math.round((workload.segments?.[0]?.mau) || 0);
    const fitsCurrent = budget >= Math.round(currentHeadline);
    // Headline message
    let headline;
    if (fitsCurrent) {
      const headroom = Math.max(0, budget - currentHeadline);
      headline = `<strong>✓ Your $${fmtNum(budget)}/mo budget covers the current $${fmtNum(Math.round(currentHeadline))}/mo deployment</strong> with $${fmtNum(headroom)}/mo headroom (${Math.round(headroom / budget * 100)}%).`;
    } else if (maxMAU >= currentMAU) {
      headline = `<strong>Affordable scale at $${fmtNum(budget)}/mo: up to <span style="color:var(--accent)">${fmtNum(maxMAU)} MAU</span></strong>`;
    } else {
      const shortfall = currentHeadline - budget;
      headline = `<strong style="color:#b3333d">⚠ Current deployment ($${fmtNum(Math.round(currentHeadline))}/mo) overshoots budget by $${fmtNum(Math.round(shortfall))}/mo.</strong> Affordable scale: <span style="color:var(--accent)">${fmtNum(maxMAU)} MAU</span> (${Math.round(maxMAU / Math.max(1, currentMAU) * 100)}% of current ${fmtNum(currentMAU)}).`;
    }
    headlineEl.innerHTML = headline;
    // Detail: optimization levers
    if (!detailEl) return;
    if (queries === 0 || variablePerQuery <= 0) {
      detailEl.innerHTML = '<p class="helper" style="font-style:italic">Configure traffic above (MAU + sessions/turns) to see budget projections.</p>';
      return;
    }
    // Each lever re-runs CostEngine.compute() with a perturbed opts/workload
    // so the row shows the actual delta this workload would see, not a flat
    // heuristic that ignores cache shape, model class, and traffic mix.
    function variablePerQueryFromResult(result, qTotal) {
      if (qTotal <= 0) return 0;
      const api = result.api?.monthly_with_retry != null
                ? result.api.monthly_with_retry
                : (result.api?.monthly_capped || 0) * retryInflate;
      const verif = result.verification?.monthly || 0;
      const fed = result.federal?.additive_total || 0;
      const emb = (result.embedding?.enabled ? result.embedding.monthly : 0) || 0;
      const embIngest = (result.embedding?.enabled ? (result.embedding.ingest_amortized || 0) : 0);
      return (api + verif + fed + (emb - embIngest)) / qTotal;
    }
    function deriveLever(perturb) {
      try {
        const { w, o } = perturb();
        const r = CostEngine.compute(w, o);
        const qNew = r.queries?.total || queries;
        return { perQ: variablePerQueryFromResult(r, qNew), qNew };
      } catch (_) {
        return { perQ: variablePerQuery, qNew: queries };
      }
    }
    // Map current model to a "cheaper class" peer in the same provider.
    // Empty string ⇒ no smaller-model lever row (already at the floor or
    // catalog doesn't have a cheaper sibling).
    function cheaperModel(current) {
      const m = String(current || '').toLowerCase();
      if (m.startsWith('gpt-')) {
        if (m === 'gpt-5-nano') return '';
        if (m === 'gpt-5-mini') return 'gpt-5-nano';
        return 'gpt-5-mini';
      }
      if (m.startsWith('claude-haiku')) return '';
      if (m.startsWith('claude-')) return 'claude-haiku-4.5';
      if (m.startsWith('gemini-')) return '';
      return '';
    }
    const currentCacheRate = currentOpts.cacheRate != null ? currentOpts.cacheRate
                           : (workload.anchor_query?.cache_rate_baseline || 0.84);
    const smallerSlug = cheaperModel(currentOpts.model);
    const cacheLever = deriveLever(() => ({
      w: workload,
      o: Object.assign({}, currentOpts, { cacheRate: Math.min(0.99, currentCacheRate + 0.20) }),
    }));
    const modelLever = smallerSlug
      ? deriveLever(() => {
          const w2 = JSON.parse(JSON.stringify(workload));
          if (Array.isArray(w2.agents)) for (const a of w2.agents) a.model = smallerSlug;
          return { w: w2, o: Object.assign({}, currentOpts, { model: smallerSlug }) };
        })
      : null;
    const batchLever = deriveLever(() => ({
      w: workload,
      o: Object.assign({}, currentOpts, { batchShare: 0.5 }),
    }));
    const turnsLever = deriveLever(() => {
      const w2 = JSON.parse(JSON.stringify(workload));
      if (Array.isArray(w2.segments)) {
        for (const s of w2.segments) {
          if (typeof s.questions_per_session === 'number') {
            s.questions_per_session = Math.max(1, s.questions_per_session / 2);
          }
        }
      }
      return { w: w2, o: currentOpts };
    });

    function rowFromLever(label, lever, note) {
      // Adjust denom for the turns lever — halving questions/session also
      // halves the queries-per-MAU denominator, so affordable MAU scales
      // with both the lower per-query cost AND the lower per-MAU usage.
      const myDenom = lever.qNew > 0 && currentMAU > 0
        ? (lever.qNew / currentMAU)
        : denom;
      const newQueriesAfford = lever.perQ > 0
        ? Math.max(0, (budget - fixedOverhead) / lever.perQ)
        : 0;
      const newMAU = myDenom > 0 ? Math.floor(newQueriesAfford / myDenom) : 0;
      const delta = newMAU - maxMAU;
      const sign = delta > 0 ? '+' : '';
      const color = delta > 0 ? 'var(--good, #2a8c3a)' : delta < 0 ? '#b3333d' : 'var(--muted)';
      return `<tr style="border-bottom:1px solid var(--rule)">
        <td style="padding:8px 10px">${label}</td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmtNum(newMAU)} MAU</td>
        <td style="padding:8px 10px;text-align:right;color:${color};font-weight:600">${sign}${fmtNum(delta)}</td>
        <td style="padding:8px 10px;color:var(--muted);font-size:11.5px">${note}</td>
      </tr>`;
    }
    const rows = [
      rowFromLever('At current settings', { perQ: variablePerQuery, qNew: queries }, 'no change'),
      rowFromLever(`Cache hit rate +20pp (${Math.round(currentCacheRate * 100)}% → ${Math.round(Math.min(0.99, currentCacheRate + 0.20) * 100)}%)`,
        cacheLever, 'engineering effort: stable system prompts, multi-turn sessions'),
      modelLever
        ? rowFromLever(`Switch to ${smallerSlug}`, modelLever, 'lose ~5–15 quality points; validate against your eval set')
        : '',
      rowFromLever('Move 50% to batch tier (offline)', batchLever, 'batch latency in minutes-to-hours; fine for analytics, not chat'),
      rowFromLever('Cut turns/session by half', turnsLever, 'shorter sessions = fewer queries per user, but fewer cache hits too'),
    ];
    detailEl.innerHTML = `
      <p class="helper" style="margin-bottom:6px">Optimization levers — what each one would do to your affordable MAU at the same $${fmtNum(budget)}/mo budget:</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="text-align:left;border-bottom:1.5px solid var(--rule)">
            <th style="padding:8px 10px">Optimization</th>
            <th style="padding:8px 10px;text-align:right">Affordable MAU</th>
            <th style="padding:8px 10px;text-align:right">Δ vs current</th>
            <th style="padding:8px 10px">Tradeoff</th>
          </tr>
        </thead>
        <tbody>
          ${rows.filter(Boolean).join('')}
        </tbody>
      </table>
      <p class="helper" style="margin-top:10px;font-size:11.5px;color:var(--muted)">Levers are re-derived from the engine on your current workload — actual deltas, not heuristic constants.</p>
    `;
  }
  function fmtNum(n) { return Math.round(n).toLocaleString(); }


  // Re-runs CostEngine.compute() per model and renders a sorted savings
  // table. Holds everything else constant — same hosting, infra, federal,
  // verification, etc. Only the LLM model varies.
  function renderModelCompare(currentOpts, currentHeadline, retryInflate = 1) {
    const body = document.getElementById('model-compare-body');
    if (!body) return;
    const models = Object.keys(Object.assign({}, CostEngine.DEFAULT_RATE_CARDS, workload.rate_cards || {}));
    const rows = [];
    for (const m of models) {
      const o = Object.assign({}, currentOpts, { model: m });
      // In agent-mode the engine reads each agent's own .model field and
      // ignores opts.model — so a naive comparison would show identical
      // costs across rows. Clone the workload and override every agent's
      // model to `m` so the entire fleet runs on the candidate model.
      let wForModel = workload;
      if (Array.isArray(workload.agents) && workload.agents.length > 0) {
        wForModel = JSON.parse(JSON.stringify(workload));
        for (const a of wForModel.agents) a.model = m;
      }
      let r;
      try { r = CostEngine.compute(wForModel, o); } catch (e) { continue; }
      const monthly = composeHeadline(r, wForModel, o, retryInflate).headline;
      const queries = r.queries?.total || 0;
      const perQuery = queries > 0 ? monthly / queries : 0;
      rows.push({ model: m, monthly, perQuery, isCurrent: m === currentOpts.model });
    }
    rows.sort((a, b) => a.monthly - b.monthly);
    if (rows.length === 0) { body.innerHTML = '<tr><td colspan="5" style="padding:10px;color:var(--muted)">No models available.</td></tr>'; return; }
    const cheapest = rows[0].monthly;
    const currentRow = rows.find(r => r.isCurrent);
    const currentMonthly = currentRow ? currentRow.monthly : currentHeadline;
    body.innerHTML = rows.map((r, i) => {
      const annual = r.monthly * 12;
      const deltaAnnual = (r.monthly - currentMonthly) * 12;
      const deltaPct = currentMonthly > 0 ? (r.monthly - currentMonthly) / currentMonthly * 100 : 0;
      const isCheapest = r.monthly === cheapest;
      const deltaColor = deltaAnnual < -1 ? 'var(--good, #2a8c3a)' : deltaAnnual > 1 ? 'var(--red, #b3333d)' : 'var(--muted)';
      const deltaText = r.isCurrent
        ? '<em style="color:var(--muted)">— current —</em>'
        : `${deltaAnnual > 0 ? '+' : '−'}${fmt$(Math.abs(deltaAnnual))} <span style="color:var(--muted);font-size:11px">(${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%)</span>`;
      const rowBg = r.isCurrent ? 'rgba(0,119,204,0.06)' : (isCheapest ? 'rgba(42,140,58,0.06)' : 'transparent');
      const cheapestBadge = isCheapest && !r.isCurrent ? ' <span style="background:#2a8c3a;color:white;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;letter-spacing:0.05em">CHEAPEST</span>' : '';
      const currentBadge = r.isCurrent ? ' <span style="background:#0077cc;color:white;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;letter-spacing:0.05em">CURRENT</span>' : '';
      return `<tr style="background:${rowBg};border-bottom:1px solid var(--rule)">
        <td style="padding:8px 10px;font-family:var(--mono, monospace);font-size:11.5px"><strong>${escapeHtml(r.model)}</strong>${currentBadge}${cheapestBadge}</td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">$${r.perQuery.toFixed(4)}</td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmt$(r.monthly)}</td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">${fmt$(annual)}</td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;color:${deltaColor};font-weight:${r.isCurrent ? '400' : '600'}">${deltaText}</td>
      </tr>`;
    }).join('');
  }

  // -----------------------------------------------------------------
  // Sensitivity / tornado chart. Perturbs each top driver around its
  // baseline and re-runs CostEngine.compute() to show how much the
  // headline shifts. Sorted by spread (biggest driver on top).
  // -----------------------------------------------------------------
  function renderSensitivity(currentOpts, baselineHeadline, retryInflate = 1) {
    const body = document.getElementById('sensitivity-body');
    if (!body) return;

    const $ = id => document.getElementById(id);
    const numVal = (id, fb) => { const e = $(id); return e ? parseFloat(e.value) : fb; };

    // Headline per perturbed (workload, opts) routed through the shared
    // composeHeadline so the baseline and lever values use identical math.
    // Retry inflate is held constant (it's not a lever).
    const computeHeadline = (w, o) => {
      const r = CostEngine.compute(w, o);
      return composeHeadline(r, w, o, retryInflate).headline;
    };

    const clone = (x) => JSON.parse(JSON.stringify(x));

    // Each lever returns a (workload, opts) pair perturbed for low/high cases.
    // Levers that live in `opts` (botFactor, cacheRate) mutate opts; levers in
    // `workload` (segments[].mau, rate_cards) mutate the cloned workload.
    const cacheBaseline = currentOpts.cacheRate != null ? currentOpts.cacheRate : 0;
    const botBaseline = currentOpts.botFactor != null ? currentOpts.botFactor : 1.5;

    const levers = [
      {
        name: 'MAU',
        desc: '±20%',
        lowLabel: '−20%',
        highLabel: '+20%',
        perturb: (factor) => {
          const w = clone(workload);
          for (const s of (w.segments || [])) s.mau = (s.mau || 0) * factor;
          return { w, o: currentOpts };
        },
        low: 0.8, high: 1.2,
      },
      {
        name: 'Cache hit rate',
        desc: '±10pp',
        lowLabel: cacheBaseline > 0.05 ? '−10pp' : 'baseline',
        highLabel: '+10pp',
        perturb: (delta) => {
          const o = Object.assign({}, currentOpts);
          o.cacheRate = Math.max(0, Math.min(0.95, cacheBaseline + delta));
          return { w: workload, o };
        },
        low: -0.10, high: +0.10,
      },
      {
        name: 'Provider rates',
        desc: '±15%',
        lowLabel: '−15%',
        highLabel: '+15%',
        perturb: (factor) => {
          const w = clone(workload);
          if (!w.rate_cards) w.rate_cards = {};
          const all = Object.assign({}, CostEngine.DEFAULT_RATE_CARDS || {}, w.rate_cards || {});
          // Engine reads `input_per_million` / `output_per_million` /
          // `cached_per_million` (the unit prices, in $/M tokens) — scale
          // those, not the legacy `input` / `output` / `cached_input` keys.
          for (const m of Object.keys(all)) {
            const r = Object.assign({}, all[m]);
            if (r.input_per_million != null)  r.input_per_million  = r.input_per_million  * factor;
            if (r.output_per_million != null) r.output_per_million = r.output_per_million * factor;
            if (r.cached_per_million != null) r.cached_per_million = r.cached_per_million * factor;
            w.rate_cards[m] = r;
          }
          return { w, o: currentOpts };
        },
        low: 0.85, high: 1.15,
      },
      {
        name: 'Bot factor',
        desc: '±20%',
        lowLabel: '−20%',
        highLabel: '+20%',
        perturb: (factor) => {
          const o = Object.assign({}, currentOpts);
          o.botFactor = botBaseline * factor;
          return { w: workload, o };
        },
        low: 0.8, high: 1.2,
        // Engine clamps botEffective to rate_limit.bot_ceiling. If the
        // ceiling is at or below the baseline, perturbing botFactor up
        // or down lands at the same clamped value → headline is flat.
        // Flag that explicitly so users don't read "$0 delta" as
        // "no sensitivity" when really the lever is gated by config.
        skipIfNoOp: true,
        noOpHint: (() => {
          const ceil = workload?.rate_limit?.bot_ceiling;
          if (ceil != null && ceil <= botBaseline) {
            return `Capped by rate-limit (bot_ceiling = ${ceil}×). Bot factor only swings cost on public-facing deployments where the ceiling is set above the baseline.`;
          }
          return null;
        })(),
      },
      {
        name: 'Turns/session',
        desc: '±20%',
        lowLabel: '−20%',
        highLabel: '+20%',
        perturb: (factor) => {
          const w = clone(workload);
          for (const s of (w.segments || [])) s.questions_per_session = (s.questions_per_session || 0) * factor;
          return { w, o: currentOpts };
        },
        low: 0.8, high: 1.2,
      },
    ];

    const results = [];
    for (const lever of levers) {
      try {
        const lo = lever.perturb(lever.low);
        const hi = lever.perturb(lever.high);
        const lowH = computeHeadline(lo.w, lo.o);
        const highH = computeHeadline(hi.w, hi.o);
        const lowDelta = lowH - baselineHeadline;
        const highDelta = highH - baselineHeadline;
        const spread = Math.abs(highH - lowH);
        results.push({ ...lever, lowH, highH, lowDelta, highDelta, spread });
      } catch (e) {
        console.warn('sensitivity: lever failed', lever.name, e);
      }
    }
    if (results.length === 0) {
      body.innerHTML = '<tr><td colspan="4" style="padding:10px;color:var(--muted)">Sensitivity unavailable.</td></tr>';
      return;
    }
    results.sort((a, b) => b.spread - a.spread);
    const maxAbs = Math.max(1, ...results.map(r => Math.max(Math.abs(r.lowDelta), Math.abs(r.highDelta))));

    body.innerHTML = results.map(r => {
      // No-op rows: lever has zero effect at current configuration.
      // Render a single explanatory row instead of misleading "$0 delta"
      // cells — e.g. Bot factor when rate_limit.bot_ceiling clamps it.
      if (r.spread < 0.01 && r.noOpHint) {
        return `<tr style="border-bottom:1px solid var(--rule)">
          <td style="padding:8px 10px;white-space:nowrap"><strong>${r.name}</strong> <em style="color:var(--muted);font-style:normal;font-size:11px">${r.desc}</em></td>
          <td colspan="3" style="padding:8px 10px;color:var(--muted);font-size:11.5px;font-style:italic">
            n/a — ${escapeHtml(r.noOpHint)}
          </td>
        </tr>`;
      }
      // Bar is 100% wide, baseline at 50%. Each side scales |delta|/maxAbs * 50%.
      const lowW  = Math.min(50, Math.abs(r.lowDelta)  / maxAbs * 50);
      const highW = Math.min(50, Math.abs(r.highDelta) / maxAbs * 50);
      const lowSign = r.lowDelta < 0 ? '−' : (r.lowDelta > 0 ? '+' : '');
      const highSign = r.highDelta < 0 ? '−' : (r.highDelta > 0 ? '+' : '');
      // Visual: red bar grows leftward when delta<0, rightward when delta>0.
      // (Rare but possible for cache where +10pp can be a no-op if baseline=95%.)
      const lowBar = r.lowDelta < 0
        ? `<div style="position:absolute;right:50%;top:0;height:100%;width:${lowW}%;background:#b3333d;opacity:0.6;border-radius:2px 0 0 2px"></div>`
        : `<div style="position:absolute;left:50%;top:0;height:100%;width:${lowW}%;background:#b3333d;opacity:0.6;border-radius:0 2px 2px 0"></div>`;
      const highBar = r.highDelta > 0
        ? `<div style="position:absolute;left:50%;top:0;height:100%;width:${highW}%;background:#2a8c3a;opacity:0.6;border-radius:0 2px 2px 0"></div>`
        : `<div style="position:absolute;right:50%;top:0;height:100%;width:${highW}%;background:#2a8c3a;opacity:0.6;border-radius:2px 0 0 2px"></div>`;
      return `<tr style="border-bottom:1px solid var(--rule)">
        <td style="padding:8px 10px;white-space:nowrap"><strong>${r.name}</strong> <em style="color:var(--muted);font-style:normal;font-size:11px">${r.desc}</em></td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;font-size:11.5px">
          <div>${fmt$(r.lowH)}</div>
          <div style="color:#b3333d;font-size:11px">${lowSign}${fmt$(Math.abs(r.lowDelta))}</div>
        </td>
        <td style="padding:8px 6px;position:relative">
          <div style="position:relative;height:20px;background:rgba(0,0,0,0.04);border-radius:3px">
            ${lowBar}${highBar}
            <div style="position:absolute;left:50%;top:-3px;bottom:-3px;width:1.5px;background:var(--ink, #111)"></div>
          </div>
          <div style="display:flex;justify-content:space-between;color:var(--muted);font-size:10px;margin-top:3px">
            <span>${r.lowLabel}</span><span>baseline ${fmt$(baselineHeadline)}</span><span>${r.highLabel}</span>
          </div>
        </td>
        <td style="padding:8px 10px;text-align:left;font-variant-numeric:tabular-nums;font-size:11.5px">
          <div>${fmt$(r.highH)}</div>
          <div style="color:#2a8c3a;font-size:11px">${highSign}${fmt$(Math.abs(r.highDelta))}</div>
        </td>
      </tr>`;
    }).join('');
  }

  // -----------------------------------------------------------------
  // Cost-over-time projection — line chart of monthly + cumulative
  // cost across 36 months given the simulator s-growth rate. Shows three
  // markers: month 1, month 12 (annual), month 36 (3-year cumulative).
  // -----------------------------------------------------------------
  function renderCostOverTime(baselineMonthly) {
    const host = document.getElementById('cost-over-time-chart');
    const summary = document.getElementById('cost-over-time-summary');
    if (!host) return;
    const growthEl = document.getElementById('s-growth');
    const growthPct = growthEl ? parseFloat(growthEl.value) : 0;
    const growthRate = (Number.isFinite(growthPct) ? growthPct : 0) / 100;
    if (!(baselineMonthly > 0)) {
      host.innerHTML = '<p style="color:var(--muted);font-size:12px;text-align:center;padding:32px 0">Configure traffic above to see the projection.</p>';
      if (summary) summary.innerHTML = '';
      return;
    }
    const months = 36;
    const monthlyData = [];
    let cumulative = 0;
    for (let m = 1; m <= months; m++) {
      const monthly = baselineMonthly * Math.pow(1 + growthRate, m - 1);
      cumulative += monthly;
      monthlyData.push({ month: m, monthly, cumulative });
    }
    const m12 = monthlyData[11];
    const m36 = monthlyData[35];

    // Layout
    const W = 880, H = 260, padL = 70, padR = 80, padT = 18, padB = 38;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // Two y-axes: left for monthly, right for cumulative
    const monthlyMax = Math.max(...monthlyData.map(d => d.monthly));
    const cumMax = m36.cumulative;
    const xFor = (mi) => padL + ((mi - 1) / (months - 1)) * plotW;
    const yMonthlyFor = (v) => padT + plotH - (v / monthlyMax) * plotH;
    const yCumFor = (v) => padT + plotH - (v / cumMax) * plotH;

    // Build line paths
    const monthlyPath = monthlyData.map((d, i) => `${i === 0 ? 'M' : 'L'}${xFor(d.month).toFixed(1)},${yMonthlyFor(d.monthly).toFixed(1)}`).join(' ');
    const cumPath = monthlyData.map((d, i) => `${i === 0 ? 'M' : 'L'}${xFor(d.month).toFixed(1)},${yCumFor(d.cumulative).toFixed(1)}`).join(' ');

    // Cumulative area fill (light tint)
    const cumAreaPath = cumPath + ` L${xFor(months).toFixed(1)},${(padT + plotH).toFixed(1)} L${xFor(1).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

    // Y-axis ticks (left = monthly, right = cumulative)
    const monthlyTicks = [0, 0.25, 0.5, 0.75, 1].map(f => f * monthlyMax);
    const cumTicks = [0, 0.25, 0.5, 0.75, 1].map(f => f * cumMax);
    const fmtBig = (v) => v >= 1e9 ? '$' + (v/1e9).toFixed(1) + 'B' : v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + Math.round(v/1e3) + 'K' : '$' + Math.round(v);

    const leftAxisSvg = monthlyTicks.map(v => {
      const y = yMonthlyFor(v);
      return `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#eee" stroke-width="1"/>
              <text x="${padL - 6}" y="${y + 3}" text-anchor="end" fill="#666" font-size="10" font-family="var(--mono, monospace)">${fmtBig(v)}</text>`;
    }).join('');
    const rightAxisSvg = cumTicks.map(v => {
      const y = yCumFor(v);
      return `<text x="${padL + plotW + 6}" y="${y + 3}" fill="#888" font-size="10" font-family="var(--mono, monospace)">${fmtBig(v)}</text>`;
    }).join('');

    // X-axis ticks: month 1, 6, 12, 18, 24, 30, 36
    const xTicks = [1, 6, 12, 18, 24, 30, 36];
    const xAxisSvg = xTicks.map(mi => {
      const x = xFor(mi);
      return `<line x1="${x}" y1="${padT + plotH}" x2="${x}" y2="${padT + plotH + 4}" stroke="#999" stroke-width="1"/>
              <text x="${x}" y="${padT + plotH + 18}" text-anchor="middle" fill="#666" font-size="10">M${mi}</text>`;
    }).join('');

    // Highlight markers at M12 and M36
    const markerSvg = [
      { d: m12, label: '12mo', y: yMonthlyFor(m12.monthly) },
      { d: m36, label: '36mo', y: yMonthlyFor(m36.monthly) },
    ].map(({ d, label, y }) => {
      const x = xFor(d.month);
      return `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="#bbb" stroke-width="1" stroke-dasharray="3,3"/>
              <circle cx="${x}" cy="${y}" r="5" fill="#0077cc" stroke="#fff" stroke-width="1.5"/>
              <text x="${x}" y="${y - 10}" text-anchor="middle" fill="#0077cc" font-size="11" font-weight="700">${escapeHtml(fmtBig(d.monthly))}</text>`;
    }).join('');

    // Axis headers sit ABOVE the plot area so they don't collide with the
    // top tick label (was overlapping "Monthly $" with "$202.7M" etc.).
    // Bump padT below to make room — but rather than re-laying out, just
    // place the headers at H-margin negative-y above padT.
    host.innerHTML = `
      <svg viewBox="0 -16 ${W} ${H + 16}" width="100%" height="${H + 16}" style="display:block;font-family:var(--sans, sans-serif)">
        ${leftAxisSvg}
        ${xAxisSvg}
        <text x="${padL - 6}" y="-4" text-anchor="end" fill="#0077cc" font-size="10.5" font-weight="700">Monthly $</text>
        <text x="${padL + plotW + 6}" y="-4" fill="#999" font-size="10.5" font-weight="700">Cumulative $</text>
        <path d="${cumAreaPath}" fill="rgba(127,127,127,0.10)" stroke="none"/>
        <path d="${cumPath}" stroke="#999" stroke-width="1.4" fill="none" stroke-dasharray="4,3"/>
        <path d="${monthlyPath}" stroke="#0077cc" stroke-width="2.5" fill="none"/>
        ${markerSvg}
        <text x="${W - padR}" y="${padT + plotH + 32}" text-anchor="end" fill="#666" font-size="10.5">Growth ${(growthRate * 100).toFixed(1)}%/mo · solid blue = monthly · gray dashed = 36-mo cumulative</text>
      </svg>
    `;

    if (summary) {
      const fmt$ = (v) => '$' + Math.round(v).toLocaleString();
      summary.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
          <div style="padding:8px 10px;background:rgba(0,119,204,0.06);border-left:3px solid #0077cc;border-radius:4px">
            <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Month 1</div>
            <div style="font-size:14px;font-weight:700">${fmt$(baselineMonthly)}</div>
          </div>
          <div style="padding:8px 10px;background:rgba(0,119,204,0.06);border-left:3px solid #0077cc;border-radius:4px">
            <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Month 12</div>
            <div style="font-size:14px;font-weight:700">${fmt$(m12.monthly)}/mo</div>
          </div>
          <div style="padding:8px 10px;background:rgba(0,119,204,0.06);border-left:3px solid #0077cc;border-radius:4px">
            <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Year 1 cumulative</div>
            <div style="font-size:14px;font-weight:700">${fmt$(monthlyData.slice(0,12).reduce((s,d) => s + d.monthly, 0))}</div>
          </div>
          <div style="padding:8px 10px;background:rgba(127,127,127,0.06);border-left:3px solid #888;border-radius:4px">
            <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">3-year cumulative</div>
            <div style="font-size:14px;font-weight:700">${fmt$(m36.cumulative)}</div>
          </div>
        </div>
      `;
    }
  }

  // -----------------------------------------------------------------
  // Side-by-side preset compare — fetch the preset JSON, run it through
  // CostEngine, and diff against another preset (or the live scenario).
  // Cached so flipping selectors doesn't re-fetch.
  // -----------------------------------------------------------------
  const _presetCache = {};
  async function loadPresetWorkload(slug) {
    if (slug === '__current__') return null;  // caller handles live scenario
    if (_presetCache[slug]) return _presetCache[slug];
    try {
      const resp = await fetch(`examples/${slug}.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const w = ensureFields(await resp.json());
      _presetCache[slug] = w;
      return w;
    } catch (e) {
      console.warn('preset load failed', slug, e);
      return null;
    }
  }

  // Compute the snapshot of a workload+opts combo: queries, headline,
  // per-MAU, annual, and the lever inputs we want to surface in the diff.
  function computeScenarioSnapshot(w, o, retryInflate = 1) {
    let r;
    try { r = CostEngine.compute(w, o); } catch (e) { return null; }
    const composed = composeHeadline(r, w, o, retryInflate);
    const fed = composed.fed;
    const fixed = composed.fixed;
    const headline = composed.headline;
    const llm = composed.llm;
    const queries = r.queries?.total || 0;
    const totalMau = (w.segments || []).reduce((a, s) => a + (s.mau || 0), 0);
    const seg0 = w.segments?.[0] || {};
    return {
      name: w.deployment?.name || '(unnamed)',
      agency: w.deployment?.agency || '',
      mau: totalMau,
      sessionsPerDay: seg0.sessions_per_day || 0,
      turns: seg0.questions_per_session || 0,
      botFactor: r.queries?.botEffective || 1,
      model: o.model,
      hosting: o.hosting,
      fedrampTier: w.federal?.fedramp_tier || 'none',
      hostingMultiplier: r.api?.hosting_multiplier || 1,
      queries,
      perQueryBlended: r.api?.per_query_blended || 0,
      llm,
      federal_additive: fed,
      fixed,
      headline,
      perMau: totalMau > 0 ? headline / totalMau : 0,
      annual: headline * 12,
      tco3yr: headline * 36,
    };
  }

  // Generation counter: every renderPresetCompare invocation increments
  // this. After the awaits resolve, only the latest generation is allowed
  // to write to the DOM — earlier in-flight calls discard their results
  // so a stale fetch can't overwrite a newer selection.
  let _presetCmpGen = 0;
  async function renderPresetCompare(currentOpts, retryInflate = 1) {
    const host = document.getElementById('preset-compare-result');
    if (!host) return;
    const aSel = document.getElementById('cmp-preset-a');
    const bSel = document.getElementById('cmp-preset-b');
    if (!aSel || !bSel) return;
    const myGen = ++_presetCmpGen;
    const aSlug = aSel.value;
    const bSlug = bSel.value;

    // Resolve each side: either the live scenario or a fetched preset.
    const resolveSide = async (slug) => {
      if (slug === '__current__') {
        // Live scenario: apply current retry inflate to match the headline.
        return computeScenarioSnapshot(workload, currentOpts, retryInflate);
      }
      const w = await loadPresetWorkload(slug);
      if (!w) return null;
      // Build a default opts for this preset using its own defaults.
      // Presets don't carry a retry rate, so leave inflate at 1.0 — that
      // keeps preset-vs-preset comparisons consistent with each preset's
      // own headline as published.
      const o = {
        hosting: w.defaults?.hosting || 'api',
        model: w.defaults?.model || 'gpt-5.2',
        tier: w.defaults?.tier || 'standard',
        mix: w.defaults?.mix || 'mixed',
        costMode: w.defaults?.cost_mode || 'optimistic',
        botFactor: 1.5,
        cacheRate: w.anchor_query?.cache_rate_baseline || 0.7,
        verifCoverage: w.verification?.coverage || 0,
      };
      return computeScenarioSnapshot(w, o);
    };
    const [A, B] = await Promise.all([resolveSide(aSlug), resolveSide(bSlug)]);
    // Stale-write guard: if a newer call has started since this one began,
    // discard our result so the newer one wins.
    if (myGen !== _presetCmpGen) return;
    if (!A || !B) {
      host.innerHTML = '<p style="color:var(--muted);font-size:12px">Could not load both scenarios.</p>';
      return;
    }

    // Diff helpers
    const fmt$ = (n) => '$' + Math.round(n).toLocaleString();
    const fmt$4 = (n) => '$' + (n || 0).toFixed(4);
    const fmtN = (n) => Math.round(n).toLocaleString();
    const pctDiff = (a, b) => {
      if (!isFinite(a) || !isFinite(b)) return null;
      // Both zero — unchanged.
      if (a === 0 && b === 0) return 0;
      // A is zero but B isn't — flag as 'new line item appearing'.
      // Returning Infinity (positive when B>A, negative when B<A) lets the
      // formatter render "+∞%" so reviewers see the change instead of "—".
      if (a === 0) return b > 0 ? Infinity : -Infinity;
      return (b - a) / a;
    };
    const fmtPct = (p) => {
      if (p == null) return '—';
      if (!isFinite(p)) return p > 0 ? '+∞%' : '−∞%';
      return (p > 0 ? '+' : '') + (p * 100).toFixed(1) + '%';
    };
    const pctClass = (p) => {
      if (p == null) return '';
      if (!isFinite(p)) return p > 0 ? 'cmp-up' : 'cmp-down';
      return Math.abs(p) < 0.05 ? 'cmp-small' : p > 0 ? 'cmp-up' : 'cmp-down';
    };

    // Rows: [label, A-display, B-display, % diff (numeric only)]
    const rows = [
      ['Scenario name',         A.name,                              B.name,                              null],
      ['Agency / org',          A.agency || '—',                     B.agency || '—',                     null],
      ['MAU',                   fmtN(A.mau),                          fmtN(B.mau),                          pctDiff(A.mau, B.mau)],
      ['Sessions / user / day', A.sessionsPerDay.toFixed(2),          B.sessionsPerDay.toFixed(2),          pctDiff(A.sessionsPerDay, B.sessionsPerDay)],
      ['Turns / session',       A.turns.toString(),                   B.turns.toString(),                   pctDiff(A.turns, B.turns)],
      ['Bot factor',            A.botFactor.toFixed(2) + '×',         B.botFactor.toFixed(2) + '×',         pctDiff(A.botFactor, B.botFactor)],
      ['Model',                 A.model,                              B.model,                              null],
      ['Hosting',               A.hosting,                            B.hosting,                            null],
      ['FedRAMP tier',          A.fedrampTier,                        B.fedrampTier,                        null],
      ['Queries / month',       fmtN(A.queries),                      fmtN(B.queries),                      pctDiff(A.queries, B.queries)],
      ['$ / query (blended)',   fmt$4(A.perQueryBlended),             fmt$4(B.perQueryBlended),             pctDiff(A.perQueryBlended, B.perQueryBlended)],
      ['LLM monthly',           fmt$(A.llm),                          fmt$(B.llm),                          pctDiff(A.llm, B.llm)],
      ['Federal additive',      fmt$(A.federal_additive),             fmt$(B.federal_additive),             pctDiff(A.federal_additive, B.federal_additive)],
      ['Fixed monthly',         fmt$(A.fixed),                        fmt$(B.fixed),                        pctDiff(A.fixed, B.fixed)],
      ['Headline monthly',      fmt$(A.headline),                     fmt$(B.headline),                     pctDiff(A.headline, B.headline)],
      ['$ / MAU / month',       '$' + A.perMau.toFixed(2),            '$' + B.perMau.toFixed(2),            pctDiff(A.perMau, B.perMau)],
      ['Annual',                fmt$(A.annual),                       fmt$(B.annual),                       pctDiff(A.annual, B.annual)],
      ['3-year TCO',            fmt$(A.tco3yr),                       fmt$(B.tco3yr),                       pctDiff(A.tco3yr, B.tco3yr)],
    ];

    const rowsHtml = rows.map(([label, a, b, p]) => {
      const cls = pctClass(p);
      const colorStyle = cls === 'cmp-up' ? 'color:#b3333d;font-weight:700' : cls === 'cmp-down' ? 'color:#2a8c3a;font-weight:700' : cls === 'cmp-small' ? 'color:var(--muted)' : 'color:var(--muted)';
      return `<tr style="border-bottom:1px solid var(--rule)">
        <td style="padding:7px 10px;color:var(--ink);font-size:11.5px">${escapeHtml(label)}</td>
        <td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;font-size:11.5px">${escapeHtml(String(a))}</td>
        <td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;font-size:11.5px">${escapeHtml(String(b))}</td>
        <td style="padding:7px 10px;text-align:right;font-variant-numeric:tabular-nums;font-size:11px;${colorStyle}">${fmtPct(p)}</td>
      </tr>`;
    }).join('');

    host.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="text-align:left;border-bottom:1.5px solid var(--rule);background:rgba(0,0,0,0.02)">
              <th style="padding:9px 10px;font-weight:600">Field</th>
              <th style="padding:9px 10px;text-align:right;font-weight:600;color:#0077cc">Scenario A</th>
              <th style="padding:9px 10px;text-align:right;font-weight:600;color:#7c4dff">Scenario B</th>
              <th style="padding:9px 10px;text-align:right;font-weight:600">B vs A</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <p class="helper" style="margin-top:8px;font-size:11px;color:var(--muted)">B-vs-A column: red = B costs more than A; green = B costs less. Comparing presets uses each preset's bundled defaults (model, hosting, mix). Comparing against <strong>Current</strong> uses your live simulator slider settings.</p>
    `;
  }

  // Wire the compare selectors (one-time bind on first DOM load)
  function bindPresetCompareSelectors() {
    const aSel = document.getElementById('cmp-preset-a');
    const bSel = document.getElementById('cmp-preset-b');
    if (!aSel || !bSel || aSel.dataset.bound === '1') return;
    aSel.dataset.bound = '1';
    const handler = () => {
      // Re-trigger renderPreview so renderPresetCompare runs with the latest opts
      if (typeof renderPreview === 'function') renderPreview();
    };
    aSel.addEventListener('change', handler);
    bSel.addEventListener('change', handler);
  }
  setTimeout(bindPresetCompareSelectors, 0);

  // -----------------------------------------------------------------
  // AS-IS vs proposed — compare the calculator's headline annual cost
  // against the user's current contract spend. Surfaces the delta with
  // payback timeline when there's a migration cost.
  // -----------------------------------------------------------------
  function renderAsIsCompare(proposedMonthly) {
    const host = document.getElementById('asis-result');
    if (!host) return;
    const asisEl = document.getElementById('asis-annual');
    const migEl = document.getElementById('asis-migration');
    const asisAnnual = asisEl ? parseFloat(asisEl.value) : NaN;
    const migration = migEl ? (parseFloat(migEl.value) || 0) : 0;
    if (!Number.isFinite(asisAnnual) || asisAnnual <= 0) {
      host.innerHTML = '<p class="helper" style="color:var(--muted);font-size:12px;margin:0">Enter your current annual contract above to see the comparison.</p>';
      return;
    }
    const proposedAnnual = proposedMonthly * 12;
    const annualDelta = proposedAnnual - asisAnnual;          // positive = costs more
    const monthlyDelta = annualDelta / 12;
    const pct = asisAnnual > 0 ? annualDelta / asisAnnual : 0;
    const isSavings = annualDelta < 0;
    const absDelta = Math.abs(annualDelta);
    const fmt$ = (n) => '$' + Math.round(n).toLocaleString();
    const fmt$2 = (n) => '$' + Math.round(n).toLocaleString();

    // Payback: only meaningful when proposed is cheaper AND there's
    // a migration cost. Months until cumulative savings = migration.
    let paybackHtml = '';
    if (isSavings && migration > 0) {
      const monthlySavings = -monthlyDelta;  // positive
      const paybackMonths = migration / monthlySavings;
      const paybackYears = paybackMonths / 12;
      paybackHtml = `
        <div style="padding:10px 12px;background:rgba(42,140,58,0.08);border-left:3px solid #2a8c3a;border-radius:4px;margin-top:10px">
          <strong>Payback timeline:</strong> at ${fmt$(monthlySavings)}/mo savings, the
          ${fmt$(migration)} migration investment pays back in
          <strong>${paybackMonths.toFixed(1)} months</strong> (≈ ${paybackYears.toFixed(1)} years).
          ${paybackMonths < 18
            ? ' Well inside a typical 3-year procurement cycle.'
            : paybackMonths < 36
              ? ' Inside the typical procurement cycle but the case depends on the contract length.'
              : ' Longer than a typical 3-year cycle — consider whether the migration cost can be reduced.'}
        </div>`;
    } else if (isSavings && migration === 0) {
      paybackHtml = `
        <div style="padding:10px 12px;background:rgba(42,140,58,0.08);border-left:3px solid #2a8c3a;border-radius:4px;margin-top:10px">
          <strong>No migration cost entered.</strong> Annual savings of ${fmt$(absDelta)} flow through from month 1.
          If there's a real migration cost, add it in the field above.
        </div>`;
    } else if (!isSavings && migration > 0) {
      paybackHtml = `
        <div style="padding:10px 12px;background:rgba(179,51,61,0.08);border-left:3px solid #b3333d;border-radius:4px;margin-top:10px">
          <strong>Overrun + migration cost stack up.</strong> Proposed is ${fmt$(absDelta)}/yr
          more expensive AND there's ${fmt$(migration)} of migration cost. Difficult to
          justify without a non-cost reason (capability uplift, vendor lock-in escape, compliance).
        </div>`;
    }

    const deltaColor = isSavings ? '#2a8c3a' : '#b3333d';
    const deltaWord = isSavings ? 'SAVINGS' : 'OVERRUN';
    const arrow = isSavings ? '↓' : '↑';
    const verdict = isSavings
      ? `Proposed deployment <strong>saves ${fmt$(absDelta)}/yr</strong> (${(pct * -100).toFixed(1)}% less than current).`
      : `Proposed deployment <strong>costs ${fmt$(absDelta)}/yr more</strong> (+${(pct * 100).toFixed(1)}% over current).`;

    host.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div style="padding:10px 12px;background:rgba(0,0,0,0.04);border-radius:4px">
          <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Current (AS-IS)</div>
          <div style="font-size:18px;font-weight:700;font-family:var(--mono)">${fmt$(asisAnnual)}</div>
          <div style="font-size:10.5px;color:var(--muted)">per year</div>
        </div>
        <div style="padding:10px 12px;background:rgba(0,119,204,0.06);border-left:3px solid var(--accent);border-radius:0 4px 4px 0">
          <div style="font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Proposed</div>
          <div style="font-size:18px;font-weight:700;font-family:var(--mono);color:var(--accent)">${fmt$(proposedAnnual)}</div>
          <div style="font-size:10.5px;color:var(--muted)">per year (from this calculator)</div>
        </div>
        <div style="padding:10px 12px;background:${isSavings ? 'rgba(42,140,58,0.08)' : 'rgba(179,51,61,0.08)'};border-left:3px solid ${deltaColor};border-radius:0 4px 4px 0">
          <div style="font-size:10.5px;color:${deltaColor};text-transform:uppercase;letter-spacing:0.05em;font-weight:700">${deltaWord} ${arrow}</div>
          <div style="font-size:18px;font-weight:700;font-family:var(--mono);color:${deltaColor}">${fmt$(absDelta)}</div>
          <div style="font-size:10.5px;color:${deltaColor}">${(Math.abs(pct) * 100).toFixed(1)}% vs current · ${fmt$(monthlyDelta < 0 ? -monthlyDelta : monthlyDelta)}/mo</div>
        </div>
      </div>
      <p class="helper" style="margin-top:10px;font-size:12.5px;line-height:1.5">${verdict}</p>
      ${paybackHtml}
      <p class="helper" style="margin-top:10px;font-size:11.5px;color:var(--muted)">
        For procurement defense: put the proposed annual ($${proposedAnnual.toLocaleString()})
        and the AS-IS annual ($${asisAnnual.toLocaleString()}) side-by-side in your justification
        package. Cite this calculator's <strong>Derivation</strong> section for the proposed-state
        breakdown — every line item is traced to inputs.
      </p>
    `;
  }

  // Bind the AS-IS inputs so they trigger renderPreview (which calls
  // renderAsIsCompare with the latest headline).
  function bindAsIsInputs() {
    const a = document.getElementById('asis-annual');
    const m = document.getElementById('asis-migration');
    if (!a || a.dataset.bound === '1') return;
    a.dataset.bound = '1';
    const handler = () => { if (typeof renderPreview === 'function') renderPreview(); };
    a.addEventListener('input', handler);
    if (m) m.addEventListener('input', handler);
  }
  setTimeout(bindAsIsInputs, 0);

  // -----------------------------------------------------------------
  // Wire add buttons + topbar buttons
  // -----------------------------------------------------------------
  function setupHandlers() {
    document.getElementById('shapes-add').addEventListener('click', () => {
      const id = prompt('New shape id (e.g., heavy)?');
      if (!id || workload.shapes[id]) return;
      workload.shapes[id] = { input_factor: 1.0, output_factor: 1.0, cache_eligible: true, description: '' };
      renderEditor(); renderPreview();
    });
    document.getElementById('mixes-add').addEventListener('click', () => {
      const id = prompt('New mix id (e.g., lookup_heavy)?');
      if (!id || workload.mix[id]) return;
      const weights = {};
      Object.keys(workload.shapes).forEach(s => weights[s] = 0);
      workload.mix[id] = { label: id, weights };
      renderEditor(); renderPreview();
    });
    // segments-add handler — REMOVED 2026-06-09. The audience-block in
    // tab-config owns "+ Add another audience type" via its delegated
    // click handler in cost-simulator.js (#audience-add-btn).
    document.getElementById('agents-add').addEventListener('click', () => {
      const id = prompt('Agent id (e.g., planner, retriever, summarizer)?');
      if (!id) return;
      if (!Array.isArray(workload.agents)) workload.agents = [];
      if (workload.agents.find(a => a.id === id)) { alert('Agent id already exists'); return; }
      workload.agents.push({
        id, label: id, input_tokens: 1000, output_tokens: 200,
        calls_per_query: 1, model: null, cache_eligible: true, description: '',
      });
      renderEditor(); renderPreview();
    });
    document.querySelectorAll('.template-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tpl = btn.dataset.template;
        if (!AGENT_TEMPLATES[tpl]) return;
        if ((workload.agents || []).length > 0 &&
            !confirm('This will replace your current agent pipeline. Continue?')) return;
        workload.agents = JSON.parse(JSON.stringify(AGENT_TEMPLATES[tpl]));
        renderEditor(); renderPreview();
      });
    });
    document.getElementById('gpu-add').addEventListener('click', () => {
      const id = prompt('GPU instance type (e.g., g6e.4xl)?');
      if (!id || workload.self_host.gpu_options[id]) return;
      workload.self_host.gpu_options[id] = { hourly: 5.0, tput_tps: 800, name: '', capable: '' };
      renderEditor(); renderPreview();
    });
    document.getElementById('infra-add').addEventListener('click', () => {
      const name = prompt('Infrastructure service / component name (e.g., NAT Gateway, RDS Postgres, CloudWatch)?');
      if (!name || workload.infrastructure[name] != null) return;
      workload.infrastructure[name] = 0;
      renderEditor(); renderPreview();
    });
    const migAddBtn = document.getElementById('migration-add');
    if (migAddBtn) migAddBtn.addEventListener('click', () => {
      if (!workload.migration) workload.migration = { enabled: true, phases: [] };
      if (!Array.isArray(workload.migration.phases)) workload.migration.phases = [];
      workload.migration.phases.push({ label: `Phase ${workload.migration.phases.length + 1}`, months: 12, hosting: 'api', reservation_type: 'none' });
      renderMigrationList(); renderPreview(); renderRawJson();
    });
    const personnelAddBtn = document.getElementById('personnel-add');
    if (personnelAddBtn) personnelAddBtn.addEventListener('click', () => {
      if (!workload.personnel) workload.personnel = { enabled: true, roles: [] };
      if (!Array.isArray(workload.personnel.roles)) workload.personnel.roles = [];
      const roleKeys = window.Prices && window.Prices.personnel ? Object.keys(window.Prices.personnel) : ['mlops_engineer'];
      // Pick first role not already added, fallback to first
      const taken = new Set(workload.personnel.roles.map(r => r.role));
      const next = roleKeys.find(k => !taken.has(k)) || roleKeys[0];
      workload.personnel.roles.push({ role: next, fte: 0.25 });
      renderPersonnelList(); renderPreview(); renderRawJson();
    });
    const aengAddBtn = document.getElementById('agent-eng-add');
    if (aengAddBtn) aengAddBtn.addEventListener('click', () => {
      if (!workload.agent_engineering) workload.agent_engineering = { enabled: true, roles: [], duration_months: 4, amortization_months: 36, helper_agent_monthly: 400, maintenance_interval_months: 6, maintenance_hours_per_session: 40 };
      if (!Array.isArray(workload.agent_engineering.roles)) workload.agent_engineering.roles = [];
      const roleKeys = window.Prices && window.Prices.personnel ? Object.keys(window.Prices.personnel) : ['agent_design_lead'];
      const taken = new Set(workload.agent_engineering.roles.map(r => r.role));
      const next = roleKeys.find(k => !taken.has(k)) || roleKeys[0];
      workload.agent_engineering.roles.push({ role: next, fte: 0.25 });
      renderAgentEngineeringList(); renderPreview(); renderRawJson();
    });
    document.getElementById('ratecard-add')?.addEventListener('click', () => {
      const id = prompt('Model id to add or override (e.g., gpt-5.2, claude-opus-4.7)?');
      if (!id) return;
      if (!workload.rate_cards) workload.rate_cards = {};
      const existing = CostEngine.DEFAULT_RATE_CARDS[id];
      workload.rate_cards[id] = existing
        ? Object.assign({}, existing)
        : { input_per_million: 1.0, cached_per_million: 0.1, output_per_million: 4.0, provider: 'custom' };
      renderEditor(); renderPreview();
    });

    // Live preview controls — primary row
    ['prev-hosting', 'prev-model', 'prev-tier', 'prev-mix', 'prev-cost-mode',
     'prev-gpu', 'prev-commitment'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => {
        if (id === 'prev-hosting') {
          // Hybrid split slider visible only in hybrid mode.
          const hybridRow = document.getElementById('prev-hybrid-row');
          if (hybridRow) hybridRow.style.display = el.value === 'hybrid' ? 'flex' : 'none';
          // On-prem amortized monthly input visible only when on-prem.
          const onpremRow = document.getElementById('prev-onprem-row');
          if (onpremRow) onpremRow.style.display = el.value === 'onprem' ? 'flex' : 'none';
          // Gate Reservations + Self-host capacity by hosting mode.
          // Reservations only matters when paying API providers; Self-host
          // capacity only matters when running owned GPUs (or hybrid).
          updateHostingDependentVisibility(el.value);
          applyHostingConditionalSliders(el.value);
        }
        if (id === 'prev-model') renderRateCardList();
        if (id === 'prev-gpu') renderGpuList();
        renderPreview();
      });
    });
    // Hosting cards drive the hidden #prev-hosting select. Clicking a card
    // syncs the select's value, fires a change event so the existing handler
    // runs, and toggles the .active class for visual feedback.
    const hostingCards = document.getElementById('hosting-cards');
    const hostingSelect = document.getElementById('prev-hosting');
    function syncHostingCardActive() {
      if (!hostingCards || !hostingSelect) return;
      const cur = hostingSelect.value;
      hostingCards.querySelectorAll('.hosting-card').forEach(c => {
        const on = c.dataset.hosting === cur;
        c.classList.toggle('active', on);
        c.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    if (hostingCards && hostingSelect) {
      hostingCards.addEventListener('click', (e) => {
        const card = e.target.closest('.hosting-card');
        if (!card) return;
        const v = card.dataset.hosting;
        if (!v || hostingSelect.value === v) { syncHostingCardActive(); return; }
        hostingSelect.value = v;
        hostingSelect.dispatchEvent(new Event('change'));
        syncHostingCardActive();
      });
      // Keep cards in sync if hosting changes externally (preset load, hash).
      hostingSelect.addEventListener('change', syncHostingCardActive);
      syncHostingCardActive();
    }

    // Initial visibility pass for hosting-dependent sections.
    updateHostingDependentVisibility((document.getElementById('prev-hosting') || {}).value || 'api');
    applyHostingConditionalSliders((document.getElementById('prev-hosting') || {}).value || 'api');
    // Visible Self-host capacity controls mirror the hidden prev-* originals.
    // Bi-directional: visible→hidden on change, hidden→visible on any external
    // change (URL hash load, intent apply, scenario import).
    [['prev-gpu-visible',         'prev-gpu'],
     ['prev-commitment-visible',  'prev-commitment'],
     ['prev-cost-mode-visible',   'prev-cost-mode']].forEach(([visibleId, hiddenId]) => {
      const visible = document.getElementById(visibleId);
      const hidden  = document.getElementById(hiddenId);
      if (!visible || !hidden) return;
      const syncOptions = () => {
        if (hidden.tagName === 'SELECT' && visible.tagName === 'SELECT'
            && visible.innerHTML !== hidden.innerHTML) {
          visible.innerHTML = hidden.innerHTML;
        }
        if (visible.value !== hidden.value) visible.value = hidden.value;
      };
      syncOptions();
      // Periodic resync — cheap and catches any external mutation
      // (URL-hash load, scenario import, JSON apply) without needing a
      // central event bus.
      setInterval(syncOptions, 500);
      visible.addEventListener('change', () => {
        if (hidden.value !== visible.value) {
          hidden.value = visible.value;
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    });
    // On-prem amortized monthly: persist to workload.on_prem_monthly so the
    // cost engine can pick it up when it learns about the on-prem hosting path.
    const onpremEl = document.getElementById('prev-onprem-monthly');
    if (onpremEl) {
      onpremEl.addEventListener('input', () => {
        workload.on_prem_monthly = parseFloat(onpremEl.value) || 0;
        renderPreview();
      });
    }
    // Sliders with companion span
    [['prev-bot', 'prev-bot-val', v => v.toFixed(1) + '×'],
     ['prev-cache', 'prev-cache-val', v => Math.round(v * 100) + '%'],
     ['prev-verif', 'prev-verif-val', v => Math.round(v * 100) + '%'],
     ['prev-replicas', 'prev-replicas-val', v => String(Math.round(v))],
     ['prev-tokens', 'prev-tokens-val', v => String(Math.round(v))],
     ['prev-api-split', 'prev-api-split-val', v => {
       const selfSpan = document.getElementById('prev-self-share');
       if (selfSpan) selfSpan.textContent = (100 - Math.round(v)) + '%';
       return Math.round(v) + '%';
     }]
    ].forEach(([sliderId, spanId, fmt]) => {
      const sl = document.getElementById(sliderId);
      const sp = document.getElementById(spanId);
      if (!sl || !sp) return;
      const update = () => { sp.textContent = fmt(parseFloat(sl.value)); renderPreview(); };
      sl.addEventListener('input', update);
      update();
    });

    // Bidirectional sync: simulator-side `s-cache` is the user-facing
    // cache-rate control, but the canonical home is workload.anchor_query
    // .cache_rate_baseline. Without this listener, the two drift and the
    // shareable URL ends up capturing two conflicting values (UI slider vs
    // anchor_query); the anchor wins on restore, breaking the share link.
    const sCacheBidirectional = document.getElementById('s-cache');
    if (sCacheBidirectional) {
      sCacheBidirectional.addEventListener('input', (ev) => {
        // Only mirror to workload on GENUINE user input. Programmatic
        // dispatchEvent calls (from the bench calibration loader, from
        // setSimulatorFromWorkload's repaint chain, from restoreUiState)
        // have isTrusted=false. If we wrote on those too, the async
        // bench-coefficients loader would overwrite the URL-hash-restored
        // anchor.cache_rate_baseline whenever it raced past our boot,
        // breaking shareable links.
        if (!ev.isTrusted) return;
        if (!workload.anchor_query) workload.anchor_query = {};
        const pct = parseFloat(sCacheBidirectional.value);
        if (!Number.isNaN(pct)) workload.anchor_query.cache_rate_baseline = pct / 100;
        // renderPreview is already triggered by the simulator's inline
        // oninput="onSlider()" → wrapped onSlider, which fires renderPreview
        // via the calc-side bridge. No need to call it again here.
      });
    }

    // Bidirectional sync for the traffic-shape sliders (s-users / s-turns /
    // s-sessions). In single-segment mode renderPreview already writes the
    // slider into the lone segment, so user drags stick. But in multi-segment
    // mode (auth + public, etc.) renderPreview computes a rollup (sum MAU,
    // weighted-avg sessions/day, weighted-avg turns) and pushes it BACK onto
    // the slider for display. That rollup writeback clobbers the user's drag
    // on the very next render — visible as: drag MAU to 500,000, slider
    // snaps back to the segments total ~10,500 within milliseconds.
    //
    // Fix: when the drag is genuine user input AND we're in multi-segment
    // mode, scale each segment proportionally so the rollup matches the new
    // slider value. Segment RATIOS are preserved (auth:public stays the same)
    // and the slider position survives the next render. Single-segment mode
    // is left alone — the existing renderPreview path handles it.
    function scaleSegments(field, newValue, weighted) {
      const segs = (workload && workload.segments) || [];
      if (segs.length <= 1) return; // single-segment handled elsewhere
      if (!Number.isFinite(newValue) || newValue <= 0) return;
      let oldAgg;
      if (weighted) {
        const totalMau = segs.reduce((a, s) => a + (Number(s.mau) || 0), 0);
        if (totalMau <= 0) return;
        oldAgg = segs.reduce((a, s) => a + (Number(s.mau) || 0) * (Number(s[field]) || 0), 0) / totalMau;
      } else {
        oldAgg = segs.reduce((a, s) => a + (Number(s[field]) || 0), 0);
      }
      if (!Number.isFinite(oldAgg) || oldAgg <= 0) return;
      const ratio = newValue / oldAgg;
      for (const s of segs) {
        if (typeof s[field] !== 'number') continue;
        s[field] = s[field] * ratio;
      }
      // MAU is a whole-count; round to integer to keep the URL hash tidy.
      if (field === 'mau') for (const s of segs) s.mau = Math.max(0, Math.round(s.mau));
    }
    // Use capture-phase on document so the segment scaling runs BEFORE the
    // slider's inline oninput="onSlider()" handler. If we registered as a
    // normal target-phase listener it would run AFTER onSlider, by which
    // time renderPreview has already read the (unchanged) segments rollup
    // and written slider.value back to the old total, clobbering the drag.
    // Capture-on-document fires during the descent before any target-phase
    // handlers, so segments get scaled first and the rollup matches.
    // Sliders whose first real drag promotes the workload from workload-
    // mode (calibrated anchor_query) to agent-mode (configuration-derived
    // per-agent tokens). The user-mental-model fix for "I dragged a tool/
    // schema/RAG/guard slider and the headline didn't move." Promotion is
    // sticky for this session; to restore measured-mode, reload the
    // example preset (the loader resets workload.agents = []).
    // Per-agent simulator sliders whose first real drag promotes the
    // workload from measured workload-mode → configuration-derived
    // agent-mode. Listed in the same order as the UI panels so additions
    // are easy to spot.
    //
    // Explicitly NOT in this set:
    //   - s-users / s-turns / s-sessions     (capture-listener scales segments in workload-mode)
    //   - s-cache                            (bidirectional listener to anchor_query.cache_rate_baseline)
    //   - s-retry                            (workload-mode retry inflate, app.js feeds it to cost-engine)
    //   - s-peak                             (workload-mode self-host TPS sizing)
    //   - s-growth                           (projection chart input + /3yr pill supplement, not the
    //                                         monthly headline — visible via pill's /3yr number)
    //   - s-pauses / s-pause-hrs             (no cost effect anywhere)
    // PROMOTE_TRIGGERS pruned 2026-05-16: most of the per-agent simulator
    // sliders previously listed here had their markup deleted in the per-
    // agent-canonicalization redesign (d03b276). The remaining IDs are
    // workload-level or workflow-mode controls whose markup is still on
    // the page. Per-agent edits now happen inside agent cards directly,
    // which mutate sim.agents and autoSync into workload.agents on their
    // own — no global promotion needed for those.
    // PROMOTE_TRIGGERS — sliders that, when touched in workload-mode,
    // imply "I want per-agent customization" and should auto-promote
    // workload.agents = [] → a synthesized fleet.
    //
    // PRUNED 2026-05-17: removed knobs that have been bridged to engine
    // opts (s-batch, s-lang-mult, s-tool-response-mode, s-tool-templated-cap,
    // s-doc-*) — touching them now flows through opts directly and
    // shouldn't trigger a surprise mode flip. Same for workflow-only
    // sliders that mostly affect visualization (s-storage-rate,
    // s-rerun, etc.). What remains is the literal fleet-size knob and
    // multi-agent topology controls — sliders whose UX explicitly
    // implies "I'm building a fleet".
    const PROMOTE_TRIGGERS = new Set([
      's-agents',
      's-comm-pattern',
      's-parallel-branches',
    ]);

    const handleSimChange = (ev) => {
      if (!ev.isTrusted) return;
      const t = ev.target;
      if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'SELECT')) return;
      const v = parseFloat(t.value);
      if (t.id === 's-users')         scaleSegments('mau',                   v, false);
      else if (t.id === 's-turns')    scaleSegments('questions_per_session', v, true);
      else if (t.id === 's-sessions') scaleSegments('sessions_per_day',      v, true);

      // (The freeform/templated dropdown → payload-mode mapping lives in a
      // dedicated, non-isTrusted-gated listener registered below — see
      // s-tool-response-mode handler. It can't live here because this handler
      // early-returns on !ev.isTrusted, and the mapping must also re-derive
      // the anchor for programmatic/synthetic change events.)

      // Per-agent simulator slider drag in workload-mode → promote.
      if (PROMOTE_TRIGGERS.has(t.id)
          && workload && Array.isArray(workload.agents) && workload.agents.length === 0) {
        // Animate the ✓ MEASURED badge off the cost pill so the user gets
        // a visible signal that the calc has left the calibrated regime.
        const badge = document.getElementById('cb-calibrated');
        if (badge && !badge.classList.contains('fly-away')) {
          badge.classList.add('fly-away');
          setTimeout(() => { badge.remove(); }, 650);
        }
        // Defer one tick so the simulator's onSlider has finished rebuilding
        // sim.agents, then mirror that fleet into workload.agents.
        setTimeout(() => { window.__promoteAgentModeFromSimulator?.(); }, 0);
        // One-shot hint: tell the user how to get back to measured-mode.
        if (!window.__promoteToastShown) {
          window.__promoteToastShown = true;
          if (typeof showToast === 'function') {
            showToast('Now editing a configured agent — reload the example to restore measured numbers.', 4500);
          }
        }
      }
    };
    // Capture-phase on document so we run before any target-phase inline
    // oninput handler — needed by scaleSegments so the slider drag isn't
    // clobbered by renderPreview's rollup writeback. SELECTs primarily
    // fire 'change' not 'input', so we register for both.
    document.addEventListener('input',  handleSimChange, true);
    document.addEventListener('change', handleSimChange, true);

    // Freeform/templated "Tool return shape" dropdown → payload-mode lever.
    // Registered directly on the SELECT (not via the isTrusted-gated
    // handleSimChange) so it fires for both real user changes and any
    // programmatic change events. We set _payload_mode_active and let the
    // renderPreview re-derivation (top of renderPreview) source the anchor
    // from payload_modes — that path also survives the inline
    // onchange="onSlider()" rebuild the dropdown carries. Agent-mode
    // workloads (no payload_modes) are left to the existing per-tool cap
    // path: the dropdown still feeds tool_response_mode opts there.
    {
      const shapeSel = document.getElementById('s-tool-response-mode');
      if (shapeSel) {
        // Capture phase so this runs BEFORE the SELECT's inline
        // onchange="onSlider()" target-phase handler. onSlider triggers a
        // renderPreview that re-syncs the dropdown's value from
        // _payload_mode_active — if we read shapeSel.value AFTER that, we'd
        // see the stale re-synced value (the bug that pinned the lever at
        // 1.0). Reading + applying here, first, sets _payload_mode_active to
        // the user's actual selection so the ensuing onSlider render derives
        // the right anchor.
        shapeSel.addEventListener('change', () => {
          const v = shapeSel.value;
          // Calibrated path: the dropdown swaps the anchor between
          // minimal (templated) and heavy (freeform) calibrated modes.
          const hasModes = !!(workload?.anchor_query?._calibration?.payload_modes);
          if (hasModes) {
            if (v === 'templated') applyPayloadMode('minimal');
            else if (v === 'freeform') applyPayloadMode('heavy');
          }
          // Per-tool path: bulk-apply the new value to every tool in the
          // registry that has an explicit return_shape. Without this,
          // the per-tool path diverges from the global — a user flipping
          // the dropdown sees the calibrated lever move (when payload_modes
          // exists) but per-tool fees stay frozen, and on agent-mode
          // presets without payload_modes the dropdown moves nothing at
          // all because the engine's "default for missing return_shape"
          // never fires (presets set return_shape on every tool). One
          // canonical knob, one lever direction.
          const reg = workload?.tools_registry;
          if (reg && typeof reg === 'object') {
            for (const id of Object.keys(reg)) {
              const t = reg[id];
              if (t && typeof t === 'object' && t.return_shape) {
                t.return_shape = v;
                // Also write to the visible select element so the user
                // sees the per-tool row reflect the new value.
                // renderPreview only updates the cost pill; there is no
                // standalone renderToolRegistry to call here.
                const sel = document.querySelector(`[data-tool-id="${id}"] [data-field="return_shape"]`);
                if (sel) sel.value = v;
              }
            }
            if (typeof renderPreview === 'function') renderPreview();
          }
        }, true);
      }
    }

    // (Appbar example-loader removed — unified into the chat-builder
    // "Describe your AI system" picker. The handler below was looking
    // up a select that no longer exists, so the listener is gone.)

    // -----------------------------------------------------------------
    // JSON view / edit / import modal
    //
    // Replaces the older inline raw-JSON textarea and the separate
    // Export JSON / Import JSON menu items with one consolidated UI.
    // Three tabs:
    //   • View   — read-only formatted JSON + Copy + Download
    //   • Edit   — paste & Apply with inline validation
    //   • Import — pick a .json file from disk
    // -----------------------------------------------------------------
    const jsonModal = document.getElementById('json-modal');
    const jsonView = document.getElementById('json-view');
    const jsonEdit = document.getElementById('json-edit');
    const jsonEditError = document.getElementById('json-edit-error');
    const jsonImportError = document.getElementById('json-import-error');

    function openJsonModal(initialTab = 'view') {
      if (!jsonModal) return;
      // Refresh the View + Edit content from the current workload.
      const formatted = JSON.stringify(workload, null, 2);
      if (jsonView) jsonView.textContent = formatted;
      if (jsonEdit) jsonEdit.value = formatted;
      if (jsonEditError) { jsonEditError.hidden = true; jsonEditError.textContent = ''; }
      if (jsonImportError) { jsonImportError.hidden = true; jsonImportError.textContent = ''; }
      switchJsonTab(initialTab);
      jsonModal.dataset.open = '1';
      // Focus the close button for keyboard accessibility.
      document.getElementById('json-modal-close')?.focus();
    }
    function closeJsonModal() {
      if (jsonModal) jsonModal.dataset.open = '0';
    }
    function switchJsonTab(name) {
      jsonModal?.querySelectorAll('.json-modal-tab').forEach(t => {
        const active = t.dataset.tab === name;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      jsonModal?.querySelectorAll('.json-modal-tab-panel').forEach(p => {
        p.hidden = p.dataset.panel !== name;
      });
    }

    document.getElementById('json-btn')?.addEventListener('click', () => openJsonModal('view'));
    document.getElementById('json-modal-close')?.addEventListener('click', closeJsonModal);
    jsonModal?.addEventListener('click', (e) => {
      // Close when clicking the backdrop (outside the panel)
      if (e.target === jsonModal) closeJsonModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && jsonModal?.dataset.open === '1') closeJsonModal();
    });
    jsonModal?.querySelectorAll('.json-modal-tab').forEach(tab => {
      tab.addEventListener('click', () => switchJsonTab(tab.dataset.tab));
    });

    // View tab — Copy + Download
    document.getElementById('json-copy-btn')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(jsonView?.textContent || '');
        showToast('JSON copied to clipboard ✓');
      } catch (err) {
        alert('Copy failed: ' + err.message);
      }
    });
    document.getElementById('json-download-btn')?.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(workload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const slug = (workload.deployment.name || 'workload').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      a.download = `${slug}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    // Edit tab — Apply + Reset
    document.getElementById('json-apply-btn')?.addEventListener('click', () => {
      const raw = jsonEdit?.value || '';
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.deployment || !parsed.shapes) {
          throw new Error('Missing required top-level fields (deployment, shapes). Did you paste a workload JSON?');
        }
        workload = ensureFields(parsed); window.workload = workload;
        window.__syncAxiomFromSegments?.();
        renderEditor();
        renderPreview();
        if (jsonEditError) { jsonEditError.hidden = true; jsonEditError.textContent = ''; }
        showToast('Workload updated ✓');
        closeJsonModal();
      } catch (err) {
        if (jsonEditError) {
          jsonEditError.textContent = 'Could not apply: ' + err.message;
          jsonEditError.hidden = false;
        }
      }
    });
    document.getElementById('json-edit-reset-btn')?.addEventListener('click', () => {
      if (jsonEdit) jsonEdit.value = JSON.stringify(workload, null, 2);
      if (jsonEditError) { jsonEditError.hidden = true; jsonEditError.textContent = ''; }
    });

    // Import tab — file picker
    document.getElementById('json-file')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const parsed = JSON.parse(ev.target.result);
          if (!parsed || !parsed.deployment || !parsed.shapes) {
            throw new Error('File is missing required top-level fields (deployment, shapes).');
          }
          workload = ensureFields(parsed); window.workload = workload;
          // Mirror imported workload into the simulator with writeback suspended.
          window.__setSimWritebackEnabled?.(false);
          window.__syncAxiomFromSegments?.();
          window.__setSimulatorFromWorkload?.(workload);
          renderEditor();
          renderPreview();
          window.__setSimWritebackEnabled?.(true);
          // If the imported workload is in measured-mode (no agents),
          // re-add the ✓ MEASURED badge and reset the promotion toast.
          // If it already carries agents, leave the badge gone — the
          // calc is in agent-mode by the imported state.
          window.__promoteToastShown = false;
          if (!Array.isArray(workload.agents) || workload.agents.length === 0) {
            window.__restoreMeasuredBadge?.();
          }
          if (jsonImportError) { jsonImportError.hidden = true; jsonImportError.textContent = ''; }
          showToast(`Loaded ${file.name} ✓`);
          closeJsonModal();
        } catch (err) {
          if (jsonImportError) {
            jsonImportError.textContent = 'Could not import: ' + err.message;
            jsonImportError.hidden = false;
          }
        }
        // Reset the input so re-selecting the same file fires change again.
        e.target.value = '';
      };
      reader.readAsText(file);
    });

    // Budget solver — recompute on every keystroke so users see live answers.
    document.getElementById('budget-target')?.addEventListener('input', () => {
      if (typeof renderPreview === 'function') renderPreview();
    });

    async function applyPresetSlug(slug) {
      const resp = await fetch(`examples/${slug}.json`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      workload = ensureFields(await resp.json()); window.workload = workload;
      // Mirror new preset into the simulator with writeback suspended.
      window.__setSimWritebackEnabled?.(false);
      syncAxiomSlidersFromSegments();
      window.__setSimulatorFromWorkload?.(workload);
      renderEditor();
      renderPreview();
      // Re-render the audience block so single/multi mode + summary line
      // reflect the freshly-loaded preset's segments.
      window.__renderAudienceBlock?.();
      window.__setSimWritebackEnabled?.(true);
      // Fresh preset → workload is back in measured-mode (agents=[]).
      // Re-add the ✓ MEASURED badge if a prior promotion removed it,
      // and reset the one-shot promotion toast so the next promotion
      // explains itself again.
      window.__promoteToastShown = false;
      window.__restoreMeasuredBadge?.();
      // Remember the slug in-session so the ↻ Reset button can undo any
      // URL-hash drift the user introduces by tweaking sliders.
      // Intentionally NOT persisted across reloads — fresh page = fresh state.
      window.__currentPresetSlug = slug;
      const resetBtn = document.getElementById('reset-preset-btn');
      if (resetBtn) {
        resetBtn.style.display = '';
        resetBtn.title = `Reset to ${slug} defaults`;
      }
    }
    document.getElementById('example-loader')?.addEventListener('change', async (e) => {
      const slug = e.target.value;
      if (!slug) return;
      try { await applyPresetSlug(slug); }
      catch (err) { alert(`Failed to load ${slug}: ${err.message}`); }
      finally { e.target.value = ''; }
    });
    document.getElementById('reset-preset-btn')?.addEventListener('click', async () => {
      const slug = window.__currentPresetSlug;
      if (!slug) return;
      try { await applyPresetSlug(slug); }
      catch (err) { alert(`Failed to reset to ${slug}: ${err.message}`); }
    });

    // Sum any incoming workload.segments (from a preset / JSON / URL hash)
    // and write the totals back to the simulator MAU + Sessions/user/day +
    // Turns/session sliders so the visible knobs reflect what the preset
    // described. After this, renderPreview's segment-override logic takes
    // over and segments become a derived view of the sliders.
    function syncAxiomSlidersFromSegments() {
      const segs = workload.segments || [];
      let totalMAU = 0;
      let weightedSessionsPerUser = 0;
      let weightedTurns = 0;
      let weight = 0;
      for (const s of segs) {
        const m = s.mau || 0;
        totalMAU += m;
        const segSessionsPerUser = s.sessions_per_day || 0;
        const segTurns = s.questions_per_session || 0;
        // Weight sessions/turns by MAU so larger segments dominate the avg.
        weightedSessionsPerUser += m * segSessionsPerUser;
        weightedTurns += m * segTurns;
        weight += m;
      }
      const avgSessionsPerUser = weight > 0 ? weightedSessionsPerUser / weight : 0.3;
      const avgTurns = weight > 0 ? weightedTurns / weight : 8;
      const su = document.getElementById('s-users');
      const ss = document.getElementById('s-sessions');
      const st = document.getElementById('s-turns');
      if (su && totalMAU > 0) su.value = Math.max(1, Math.round(totalMAU));
      if (ss && avgSessionsPerUser > 0) ss.value = Math.max(0.01, Math.round(avgSessionsPerUser * 100) / 100);
      if (st && avgTurns > 0) st.value = Math.max(1, Math.round(avgTurns));
      // the simulator's onSlider() reads these values and re-renders panels.
      if (typeof window.onSlider === 'function') {
        try { window.onSlider(); } catch (_) {}
      }
    }
    // Expose so the URL-hash loader / import-btn / setup paths can call it.
    window.__syncAxiomFromSegments = syncAxiomSlidersFromSegments;

    // Build section navigator + wire up search
    buildSectionNav();

    // (The old inline "Apply edited JSON" button was removed —
    // the JSON view/edit/import modal above is the canonical entry point.)

    // Generate calculator HTML — defers to a generator module loaded
    // separately. For now, we trigger a download with the workload
    // embedded plus a notice.
    // PDF / Print — opens the browser print dialog. The @media print
    // stylesheet hides nav/sidebar/simulator and expands every section so
    // the resulting PDF is a clean self-contained procurement report.
    document.getElementById('pdf-btn')?.addEventListener('click', () => {
      // Force every collapsible section open so the print snapshot
      // captures all content (the print CSS also covers this, but
      // doing it in JS first makes the on-screen state match what
      // the PDF will look like, so users can preview).
      document.querySelectorAll('.section').forEach(s => s.classList.add('open'));
      // Slight delay so any reflow / chart re-render happens before printing.
      setTimeout(() => window.print(), 50);
    });

    // Share link — copies a self-contained URL. Encodes both the
    // workload and the current simulator/dropdown slider state so the
    // recipient sees the same headline you do.
    document.getElementById('share-btn').addEventListener('click', () => {
      try {
        const payload = { workload, ui: captureUiState() };
        const json = JSON.stringify(payload);
        const hash = btoa(encodeURIComponent(json));
        const url = location.origin + location.pathname + '#w=' + hash;
        navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard ✓'));
      } catch (err) {
        alert('Share failed: ' + err.message);
      }
    });

    // Excel export — uses SheetJS (loaded via CDN) to produce a .xlsx
    // workbook from the current workload + computed results.
    document.getElementById('excel-btn').addEventListener('click', () => {
      if (typeof XLSX === 'undefined') {
        alert('Excel export requires SheetJS. The CDN may be blocked or offline.');
        return;
      }
      generateExcel();
    });
  }

  // -----------------------------------------------------------------
  // Visual architecture builder
  //
  // Reference architecture for AI agent systems. Each component is a
  // box on the diagram; clicking toggles it on/off. Active components
  // contribute their share to the workload (agents, infrastructure
  // line items, verification settings).
  // -----------------------------------------------------------------
  const ARCH_COMPONENTS = {
    // Edge / front
    cdn:       { x:  60, y:  20, w: 110, h: 46, type: 'edge',     label: 'CDN / WAF',          infra: { 'CloudFront': 40 } },
    ratelimit: { x: 200, y:  20, w: 110, h: 46, type: 'edge',     label: 'Rate Limit',         infra: { 'WAF rate-limit': 35 } },
    auth:      { x: 340, y:  20, w: 110, h: 46, type: 'auth',     label: 'Auth / OAuth',       infra: { 'Cognito + KMS': 13 } },
    alb:       { x: 200, y:  90, w: 250, h: 38, type: 'gateway',  label: 'Load Balancer / ALB',infra: { 'ALB': 35 } },

    // Orchestration / agents
    orchestr:  { x: 200, y: 160, w: 250, h: 50, type: 'agent',    label: 'Orchestrator',
                 agent: { id: 'orchestr', label: 'Orchestrator', input_tokens: 2000, output_tokens: 300, calls_per_query: 1, model: null, cache_eligible: true, description: 'Top-level planner — routes to sub-agents.' } },
    retriever: { x:  20, y: 240, w: 150, h: 50, type: 'agent',    label: 'Retriever Agent',
                 agent: { id: 'retriever', label: 'Retriever', input_tokens: 1500, output_tokens: 100, calls_per_query: 1, model: 'gpt-5-nano', cache_eligible: false, description: 'Vector search + rerank.' } },
    toolagent: { x: 195, y: 240, w: 150, h: 50, type: 'agent',    label: 'Tool-call Agent',
                 agent: { id: 'toolagent', label: 'Tool-call agent', input_tokens: 1000, output_tokens: 200, calls_per_query: 2, model: 'gpt-5-mini', cache_eligible: false, description: 'Calls databases or APIs.' } },
    summarize: { x: 370, y: 240, w: 150, h: 50, type: 'agent',    label: 'Answer / Summarizer',
                 agent: { id: 'summarize', label: 'Answer / Summarizer', input_tokens: 4000, output_tokens: 700, calls_per_query: 1, model: null, cache_eligible: true, description: 'Composes the final answer.' } },
    verifier:  { x: 545, y: 240, w: 150, h: 50, type: 'agent',    label: 'Fact Verifier',
                 agent: { id: 'verifier', label: 'Fact verifier', input_tokens: 1500, output_tokens: 100, calls_per_query: 1, model: 'gpt-5-mini', cache_eligible: false, description: 'Checks claims against retrieved docs.' },
                 enables_verif: true },

    // Backing services
    llm:       { x: 280, y: 340, w: 170, h: 46, type: 'llm',      label: 'LLM (API or self-host)' },
    cache:     { x: 480, y: 340, w: 130, h: 46, type: 'cache',    label: 'Prompt Cache',       infra: { 'ElastiCache Redis': 47 } },

    // Tools / data
    vectordb:  { x:  20, y: 410, w: 150, h: 46, type: 'storage',  label: 'Vector DB',          infra: { 'Vector DB': 75 } },
    docstore:  { x: 195, y: 410, w: 150, h: 46, type: 'storage',  label: 'Document Store',     infra: { 'S3 documents': 40 } },
    toolapis:  { x: 370, y: 410, w: 150, h: 46, type: 'tool',     label: 'External APIs',      infra: { 'External API quota': 100 } },
    rds:       { x: 545, y: 410, w: 150, h: 46, type: 'storage',  label: 'RDS Postgres',       infra: { 'RDS Postgres': 292 } },

    // Cross-cutting
    observ:    { x:  20, y: 490, w: 220, h: 46, type: 'meta',     label: 'Observability',      infra: { 'CloudWatch + X-Ray': 290 } },
    secrets:   { x: 260, y: 490, w: 200, h: 46, type: 'meta',     label: 'Secrets / KMS',      infra: { 'Secrets Manager + KMS': 13 } },
    egress:    { x: 480, y: 490, w: 220, h: 46, type: 'meta',     label: 'NAT / egress',       infra: { 'NAT Gateway': 33 } },
  };

  const ARCH_CONNECTIONS = [
    ['cdn', 'alb'], ['ratelimit', 'alb'], ['auth', 'alb'],
    ['alb', 'orchestr'],
    ['orchestr', 'retriever'], ['orchestr', 'toolagent'],
    ['orchestr', 'summarize'], ['orchestr', 'verifier'],
    ['retriever', 'vectordb'], ['retriever', 'docstore'],
    ['toolagent', 'toolapis'], ['toolagent', 'rds'],
    ['summarize', 'cache'], ['summarize', 'llm'],
    ['retriever', 'llm'], ['toolagent', 'llm'], ['verifier', 'llm'],
    ['orchestr', 'llm'],
  ];

  const ARCH_PRESETS = {
    simple:  ['auth', 'alb', 'llm', 'observ', 'secrets'],
    rag:     ['cdn', 'ratelimit', 'auth', 'alb', 'orchestr', 'retriever', 'summarize', 'llm', 'cache', 'vectordb', 'docstore', 'observ', 'secrets', 'egress'],
    tool:    ['cdn', 'ratelimit', 'auth', 'alb', 'orchestr', 'toolagent', 'summarize', 'llm', 'cache', 'toolapis', 'rds', 'observ', 'secrets', 'egress'],
    multi:   ['cdn', 'ratelimit', 'auth', 'alb', 'orchestr', 'retriever', 'toolagent', 'summarize', 'llm', 'cache', 'vectordb', 'docstore', 'toolapis', 'observ', 'secrets', 'egress'],
    hybrid:  ['cdn', 'ratelimit', 'auth', 'alb', 'orchestr', 'retriever', 'toolagent', 'summarize', 'verifier', 'llm', 'cache', 'vectordb', 'docstore', 'toolapis', 'rds', 'observ', 'secrets', 'egress'],
    clear:   [],
  };

  const archActive = new Set();

  function isArchActive(id) { return archActive.has(id); }

  function applyArchToWorkload() {
    // Clear arch-managed agents/infra (those whose ids match component agents)
    if (!Array.isArray(workload.agents)) workload.agents = [];
    const agentIdsManaged = new Set();
    const infraNamesManaged = new Set();
    for (const c of Object.values(ARCH_COMPONENTS)) {
      if (c.agent) agentIdsManaged.add(c.agent.id);
      if (c.infra) Object.keys(c.infra).forEach(n => infraNamesManaged.add(n));
    }
    workload.agents = workload.agents.filter(a => !agentIdsManaged.has(a.id));
    for (const name of infraNamesManaged) delete workload.infrastructure[name];

    // Re-add active components' contributions
    let verifEnabled = false;
    for (const id of archActive) {
      const c = ARCH_COMPONENTS[id];
      if (!c) continue;
      if (c.agent) {
        // Avoid duplicate ids if user manually added one with same id
        if (!workload.agents.find(a => a.id === c.agent.id)) {
          workload.agents.push(JSON.parse(JSON.stringify(c.agent)));
        }
      }
      if (c.infra) {
        for (const [name, cost] of Object.entries(c.infra)) {
          workload.infrastructure[name] = cost;
        }
      }
      if (c.enables_verif) verifEnabled = true;
    }
    if (verifEnabled) {
      workload.verification.enabled = true;
      if (!(workload.verification.coverage > 0)) workload.verification.coverage = 0.10;
    }
  }

  function renderArchSummary() {
    const el = document.getElementById('arch-summary');
    if (!el) return;
    if (archActive.size === 0) {
      el.innerHTML = '<em>No components selected. Pick a preset above or click any box to start.</em>';
      return;
    }
    const byType = {};
    for (const id of archActive) {
      const c = ARCH_COMPONENTS[id];
      if (!c) continue;
      if (!byType[c.type]) byType[c.type] = [];
      byType[c.type].push(c.label);
    }
    const order = ['edge', 'auth', 'gateway', 'agent', 'llm', 'cache', 'storage', 'tool', 'meta'];
    const TYPE_LABEL = {
      edge: 'Edge', auth: 'Auth', gateway: 'Gateway', agent: 'Agents',
      llm: 'LLM', cache: 'Cache', storage: 'Storage', tool: 'Tools', meta: 'Operational',
    };
    const parts = order.filter(t => byType[t]).map(t => {
      const tags = byType[t].map(l => `<span class="pill-tag">${l}</span>`).join('');
      return `<div style="margin-top:4px;"><strong>${TYPE_LABEL[t]}:</strong> ${tags}</div>`;
    });
    el.innerHTML = `<strong>Active components (${archActive.size}):</strong>${parts.join('')}`;
  }

  function renderArchDiagram() {
    const svg = document.getElementById('arch-diagram');
    if (!svg) return;
    let html = '';

    // Group definitions: bg rect + label position
    const GROUPS = [
      { x:  10, y:  10, w: 450, h:  62, label: 'Edge & Auth' },
      { x:  10, y: 150, w: 690, h: 150, label: 'Agents' },
      { x: 270, y: 330, w: 350, h:  68, label: 'LLM & Cache' },
      { x:  10, y: 400, w: 690, h:  68, label: 'Tools / Data' },
      { x:  10, y: 480, w: 690, h:  68, label: 'Cross-cutting' },
    ];

    // 1. Group backgrounds (lowest z-order)
    for (const g of GROUPS) {
      html += `<rect class="group-bg" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}"/>`;
    }

    // 2. Connections
    for (const [from, to] of ARCH_CONNECTIONS) {
      const a = ARCH_COMPONENTS[from], b = ARCH_COMPONENTS[to];
      if (!a || !b) continue;
      const x1 = a.x + a.w / 2, y1 = a.y + a.h;
      const x2 = b.x + b.w / 2, y2 = b.y;
      const active = archActive.has(from) && archActive.has(to);
      html += `<path class="conn ${active ? 'active' : ''}" d="M ${x1} ${y1} C ${x1} ${(y1+y2)/2}, ${x2} ${(y1+y2)/2}, ${x2} ${y2}"/>`;
    }

    // 3. Nodes
    for (const [id, c] of Object.entries(ARCH_COMPONENTS)) {
      const active = archActive.has(id);
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      const costStr = c.infra ? '$' + Object.values(c.infra).reduce((a, b) => a + b, 0) + '/mo' :
                      (c.agent ? `${c.agent.input_tokens}+${c.agent.output_tokens} tok` : '');
      html += `<g class="node ${active ? 'active' : ''}" data-arch-node="${id}" style="cursor:default;">
        <rect class="node-rect" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="4"/>
        <text class="node-label" x="${cx}" y="${cy - 1}">${c.label}</text>
        <text class="node-cost" x="${cx}" y="${cy + 14}">${costStr}</text>
      </g>`;
    }

    // 4. Group labels LAST (highest z-order) — anchored to top-left INSIDE
    //    their group bg with a paper-colored backing rect for legibility.
    for (const g of GROUPS) {
      const labelX = g.x + 8;
      const labelY = g.y + 13;
      const labelW = g.label.length * 6.5 + 10;  // approximate text width
      html += `<rect x="${labelX - 4}" y="${labelY - 9}" width="${labelW}" height="13" fill="var(--paper)" stroke="none"/>`;
      html += `<text class="group-label" x="${labelX}" y="${labelY}">${g.label}</text>`;
    }

    svg.innerHTML = html;
    // Architecture diagram is READ-ONLY — it visualizes what the chat
    // produced. Add/remove of components happens via the Components tab
    // gallery, not via clicking diagram nodes.
  }

  // -----------------------------------------------------------------
  // Splitter dragging — adjusts CSS variable --col2 on the root layout.
  // (col1 was removed when the side filters column was dropped.)
  // -----------------------------------------------------------------
  function setupSplitters() {
    const layout = document.getElementById('layout');
    if (!layout) return;

    // Clamp col2 so right column never gets squeezed below ~380px.
    function clampForViewport(_unused, col2) {
      const vw = window.innerWidth;
      const RIGHT_MIN = 380;
      const col2HardMax = Math.max(340, vw - 10 - RIGHT_MIN);
      const col2Max = Math.min(1100, Math.round(vw * 0.62), col2HardMax);
      const c2 = Math.min(col2Max, Math.max(340, col2));
      return { col1: 0, col2: c2 };
    }
    function applyCols(_unused, c2) {
      layout.style.setProperty('--col2', c2 + 'px');
    }

    // Restore persisted width, then clamp to viewport
    let initial = { col2: 540 };
    try {
      const saved = JSON.parse(localStorage.getItem('layoutCols') || '{}');
      if (saved.col2) initial.col2 = saved.col2;
    } catch (_) { /* ignore */ }
    const clamped = clampForViewport(0, initial.col2);
    applyCols(0, clamped.col2);
    if (clamped.col2 !== initial.col2) {
      try { localStorage.setItem('layoutCols', JSON.stringify({ col2: clamped.col2 })); } catch (_) {}
    }

    window.addEventListener('resize', () => {
      const cs = getComputedStyle(layout);
      const c2 = parseFloat(cs.getPropertyValue('--col2')) || 540;
      const re = clampForViewport(0, c2);
      applyCols(0, re.col2);
    });

    const persist = () => {
      const cs = getComputedStyle(layout);
      const col2 = parseFloat(cs.getPropertyValue('--col2')) || 540;
      try { localStorage.setItem('layoutCols', JSON.stringify({ col2 })); } catch (_) {}
    };

    document.querySelectorAll('.splitter').forEach(splitter => {
      splitter.addEventListener('mousedown', (startE) => {
        startE.preventDefault();
        const startX = startE.clientX;
        const cs = getComputedStyle(layout);
        const startCol2 = parseFloat(cs.getPropertyValue('--col2')) || 540;
        splitter.classList.add('dragging');

        const onMove = (e) => {
          const dx = e.clientX - startX;
          const re = clampForViewport(0, startCol2 + dx);
          applyCols(0, re.col2);
        };
        const onUp = () => {
          splitter.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          persist();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      splitter.addEventListener('dblclick', () => {
        const def = clampForViewport(0, 540);
        applyCols(def.col1, def.col2);
        persist();
      });
    });
  }

  // -----------------------------------------------------------------
  // Architecture diagram zoom — adjust SVG viewBox.
  // Smaller viewBox = larger content; bigger viewBox = smaller content.
  // -----------------------------------------------------------------
  const ARCH_DEFAULT_VIEWBOX = { x: 0, y: 0, w: 720, h: 620 };
  const archViewBox = { ...ARCH_DEFAULT_VIEWBOX };

  function applyArchViewBox() {
    const svg = document.getElementById('arch-diagram');
    if (!svg) return;
    svg.setAttribute('viewBox', `${archViewBox.x} ${archViewBox.y} ${archViewBox.w} ${archViewBox.h}`);
  }

  // Bounds for zoom — viewBox dimensions
  const ZOOM_MIN = 120;     // most zoomed-in (smallest viewBox)
  const ZOOM_MAX_W = 2400;
  const ZOOM_MAX_H = 2000;

  function clampZoom(w, h) {
    const ratio = ARCH_DEFAULT_VIEWBOX.w / ARCH_DEFAULT_VIEWBOX.h;
    w = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX_W, w));
    h = Math.max(ZOOM_MIN / ratio, Math.min(ZOOM_MAX_H, h));
    return { w, h };
  }

  // Animate viewBox to a target with ease-out cubic over `duration` ms.
  let zoomAnimFrame = null;
  function animateViewBoxTo(target, duration = 180) {
    if (zoomAnimFrame) cancelAnimationFrame(zoomAnimFrame);
    const start = { ...archViewBox };
    const t0 = performance.now();
    function step(now) {
      const t = Math.min(1, (now - t0) / duration);
      const e = 1 - Math.pow(1 - t, 3);
      archViewBox.x = start.x + (target.x - start.x) * e;
      archViewBox.y = start.y + (target.y - start.y) * e;
      archViewBox.w = start.w + (target.w - start.w) * e;
      archViewBox.h = start.h + (target.h - start.h) * e;
      applyArchViewBox();
      if (t < 1) zoomAnimFrame = requestAnimationFrame(step);
      else zoomAnimFrame = null;
    }
    zoomAnimFrame = requestAnimationFrame(step);
  }

  // Apply zoom with `factor` < 1 for zoom-in, > 1 for zoom-out, around an
  // anchor expressed as fractional coords [0..1] within the SVG viewport.
  // px/py default to 0.5/0.5 (center).
  function zoomBy(factor, px = 0.5, py = 0.5, animate = false) {
    const { w, h } = clampZoom(archViewBox.w * factor, archViewBox.h * factor);
    const newX = archViewBox.x + (archViewBox.w - w) * px;
    const newY = archViewBox.y + (archViewBox.h - h) * py;
    if (animate) animateViewBoxTo({ x: newX, y: newY, w, h });
    else {
      archViewBox.x = newX; archViewBox.y = newY;
      archViewBox.w = w;    archViewBox.h = h;
      applyArchViewBox();
    }
  }

  function setupArchZoom() {
    const inBtn = document.getElementById('arch-zoom-in');
    const outBtn = document.getElementById('arch-zoom-out');
    const resetBtn = document.getElementById('arch-zoom-reset');
    const wrap = document.getElementById('arch-diagram-wrap');
    const svg = document.getElementById('arch-diagram');
    if (!inBtn || !outBtn || !resetBtn || !wrap || !svg) return;

    inBtn.addEventListener('click', () => zoomBy(0.78, 0.5, 0.5, true));
    outBtn.addEventListener('click', () => zoomBy(1.28, 0.5, 0.5, true));
    resetBtn.addEventListener('click', () => animateViewBoxTo({ ...ARCH_DEFAULT_VIEWBOX }, 220));

    // ---- Trackpad/wheel: pan or zoom. Direct (non-animated) for responsiveness. ----
    wrap.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      // ctrl/meta = pinch-zoom on macOS trackpads (browsers translate pinch to ctrl+wheel)
      // Also: ctrl+wheel on a mouse = explicit zoom
      if (e.ctrlKey || e.metaKey) {
        // Pinch-zoom centered on cursor for natural feel
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        // Smaller deltaY → smaller factor → smoother
        const factor = Math.exp(e.deltaY * 0.012);
        zoomBy(factor, px, py, false);
      } else {
        // Two-finger pan on trackpad: deltaX + deltaY in pixels
        const scaleX = archViewBox.w / rect.width;
        const scaleY = archViewBox.h / rect.height;
        archViewBox.x += e.deltaX * scaleX;
        archViewBox.y += e.deltaY * scaleY;
        applyArchViewBox();
      }
    }, { passive: false });

    // ---- Click-and-drag pan with mouse, animated via requestAnimationFrame for smoothness. ----
    wrap.style.cursor = 'grab';
    let isPanning = false;
    let lastClientX = 0, lastClientY = 0;
    let pendingDx = 0, pendingDy = 0;
    let panSuppressClick = false;
    let panRafScheduled = false;

    function flushPan() {
      panRafScheduled = false;
      if (pendingDx === 0 && pendingDy === 0) return;
      const rect = svg.getBoundingClientRect();
      archViewBox.x -= pendingDx * archViewBox.w / rect.width;
      archViewBox.y -= pendingDy * archViewBox.h / rect.height;
      applyArchViewBox();
      pendingDx = 0; pendingDy = 0;
    }

    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('[data-arch-node]')) return;
      isPanning = true;
      panSuppressClick = false;
      lastClientX = e.clientX; lastClientY = e.clientY;
      wrap.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      const dx = e.clientX - lastClientX;
      const dy = e.clientY - lastClientY;
      lastClientX = e.clientX; lastClientY = e.clientY;
      pendingDx += dx; pendingDy += dy;
      if (Math.abs(pendingDx) + Math.abs(pendingDy) > 3) panSuppressClick = true;
      if (!panRafScheduled) {
        panRafScheduled = true;
        requestAnimationFrame(flushPan);
      }
    });

    document.addEventListener('mouseup', () => {
      if (!isPanning) return;
      isPanning = false;
      wrap.style.cursor = 'grab';
      if (pendingDx !== 0 || pendingDy !== 0) flushPan();
    });

    // Prevent stray clicks if a pan happened
    svg.addEventListener('click', (e) => {
      if (panSuppressClick) {
        e.stopPropagation();
        e.preventDefault();
        panSuppressClick = false;
      }
    }, true);

    // ---- Touch support: 1-finger pan, 2-finger pinch zoom ----
    let touchMode = null;
    let touchStart = null;

    wrap.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        // Don't pan if user touched a node
        if (e.target.closest('[data-arch-node]')) { touchMode = null; return; }
        touchMode = 'pan';
        touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const dx = t0.clientX - t1.clientX, dy = t0.clientY - t1.clientY;
        touchMode = 'pinch';
        touchStart = {
          dist: Math.hypot(dx, dy),
          midX: (t0.clientX + t1.clientX) / 2,
          midY: (t0.clientY + t1.clientY) / 2,
          viewBox: { ...archViewBox },
        };
      }
    }, { passive: true });

    wrap.addEventListener('touchmove', (e) => {
      if (!touchMode || !touchStart) return;
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (touchMode === 'pan' && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - touchStart.x;
        const dy = t.clientY - touchStart.y;
        archViewBox.x -= dx * archViewBox.w / rect.width;
        archViewBox.y -= dy * archViewBox.h / rect.height;
        applyArchViewBox();
        touchStart.x = t.clientX; touchStart.y = t.clientY;
      } else if (touchMode === 'pinch' && e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1];
        const dx = t0.clientX - t1.clientX, dy = t0.clientY - t1.clientY;
        const dist = Math.hypot(dx, dy);
        if (dist === 0) return;
        const factor = touchStart.dist / dist;  // > 1 = zoom out, < 1 = zoom in
        // Anchor zoom on midpoint of the two fingers
        const px = (touchStart.midX - rect.left) / rect.width;
        const py = (touchStart.midY - rect.top) / rect.height;
        const target = clampZoom(touchStart.viewBox.w * factor, touchStart.viewBox.h * factor);
        archViewBox.x = touchStart.viewBox.x + (touchStart.viewBox.w - target.w) * px;
        archViewBox.y = touchStart.viewBox.y + (touchStart.viewBox.h - target.h) * py;
        archViewBox.w = target.w; archViewBox.h = target.h;
        applyArchViewBox();
      }
    }, { passive: false });

    wrap.addEventListener('touchend', () => {
      touchMode = null; touchStart = null;
    });
  }

  function setupArchitecture() {
    document.querySelectorAll('[data-arch]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.arch;
        if (!ARCH_PRESETS[preset]) return;
        if (archActive.size > 0 && !confirm('This will replace your current architecture selection. Continue?')) return;
        archActive.clear();
        ARCH_PRESETS[preset].forEach(id => archActive.add(id));
        applyArchToWorkload();
        renderArchDiagram();
        renderArchSummary();
        renderEditor();
        renderPreview();
      });
    });
    renderArchDiagram();
    renderArchSummary();
  }

  // -----------------------------------------------------------------
  // Token-estimate wizard
  //
  // High-level questions → infers token budgets for each component
  // (system prompt, RAG, tools, conversation history, output) and
  // sums them into anchor input/output. Calibrated against common
  // deployment shapes; ±20% accuracy without measurement.
  // -----------------------------------------------------------------
  const WIZ_PROFILES = {
    // System prompt size (tokens) — instructions, persona, format rules, examples
    systemPrompt: {
      'support': 600, 'search': 400, 'research': 1200,
      'data-qa': 1000, 'doc-qa': 800, 'workflow': 2000, 'custom': 700,
    },
    // Number of retrieval documents loaded per query
    docCount: {
      'none': 0, 'lookup': 2, 'moderate': 6, 'comprehensive': 15,
    },
    // Average tokens per retrieved document chunk
    docTokens: {
      'none': 0, 'lookup': 700, 'moderate': 600, 'comprehensive': 500,
    },
    // Tool-result tokens (DB rows, API responses, etc.) returned into the prompt
    toolTokens: {
      'knowledge': 0, 'rag': 0, 'tools': 600, 'both': 800,
    },
    // Conversation-history accumulated tokens by chat length
    convHistory: {
      'one-shot': 0, 'short': 600, 'long': 1500,
    },
    // Average tokens added by the user's question itself
    userQuery: 60,
    // Output size by length category
    output: {
      'one-liner': 80, 'short': 250, 'detailed': 600, 'report': 1500,
    },
    // Tokens added by tool-call instructions in the system prompt
    toolBoost: {
      'knowledge': 0, 'rag': 200, 'tools': 400, 'both': 500,
    },
  };

  function computeWizard(answers) {
    const P = WIZ_PROFILES;
    const sysBase = P.systemPrompt[answers.useCase] || P.systemPrompt.custom;
    const sysExtra = P.toolBoost[answers.source] || 0;
    const sys = sysBase + sysExtra;

    const ragApplies = answers.source === 'rag' || answers.source === 'both';
    const docs = ragApplies ? P.docCount[answers.contextSize] : 0;
    const docTok = ragApplies ? P.docTokens[answers.contextSize] : 0;
    const rag = docs * docTok;

    const tools = P.toolTokens[answers.source] || 0;
    const history = P.convHistory[answers.conversation] || 0;
    const query = P.userQuery;

    const input = sys + rag + tools + history + query;
    const output = P.output[answers.answerLen] || 0;

    return {
      sys, rag, tools, history, query, input, output,
      docs, docTok,
    };
  }

  function setupWizard() {
    const toggle = document.getElementById('wizard-toggle');
    const wizard = document.getElementById('token-wizard');
    if (!toggle || !wizard) return;
    toggle.addEventListener('click', () => {
      const open = wizard.style.display !== 'none';
      wizard.style.display = open ? 'none' : 'block';
      toggle.firstElementChild.textContent = open
        ? 'Estimate tokens in 30 seconds →'
        : 'Hide estimator';
    });

    const answers = {};
    const update = () => {
      const total = document.getElementById('wiz-input-total');
      const totalOut = document.getElementById('wiz-output-total');
      const cost = document.getElementById('wiz-cost');
      const breakdown = document.getElementById('wiz-breakdown');
      const apply = document.getElementById('wiz-apply');

      const required = ['useCase', 'answerLen', 'contextSize', 'conversation', 'source'];
      const missing = required.filter(k => !answers[k]);
      if (missing.length > 0) {
        breakdown.innerHTML = `<em>Pick options above to see the breakdown. <strong>${missing.length}</strong> question${missing.length>1?'s':''} remaining.</em>`;
        apply.disabled = true;
        return;
      }

      const r = computeWizard(answers);
      total.textContent = r.input.toLocaleString();
      totalOut.textContent = r.output.toLocaleString();

      // Quick cost estimate at gpt-5.2 standard rates: input $1.75/M cached/uncached blended,
      // assume 0.84 cache → uncached 16% × $1.75 + cached 84% × $0.175 + output × $14
      const inUncached = r.input * 0.16, inCached = r.input * 0.84;
      const perQuery = inUncached * 1.75 / 1e6 + inCached * 0.175 / 1e6 + r.output * 14 / 1e6;
      cost.textContent = '$' + perQuery.toFixed(4);

      const lines = [
        ['System prompt + tool instructions', r.sys],
        ['User question', r.query],
      ];
      if (r.rag > 0) lines.push([`Retrieved documents (${r.docs} × ${r.docTok})`, r.rag]);
      if (r.tools > 0) lines.push(['Tool / API results', r.tools]);
      if (r.history > 0) lines.push(['Conversation history', r.history]);
      lines.push(['Input total', r.input]);
      lines.push(['Output (the answer)', r.output]);

      breakdown.innerHTML = lines.map(([label, n]) => `
        <div class="row"><span>${label}</span><span class="num">${n.toLocaleString()} tok</span></div>
      `).join('');

      apply.disabled = false;
    };

    wizard.querySelectorAll('input[type="radio"]').forEach(input => {
      input.addEventListener('change', () => {
        const q = input.name.replace('wiz-', '');
        answers[q] = input.value;
        update();
      });
    });

    document.getElementById('wiz-apply').addEventListener('click', () => {
      const r = computeWizard(answers);
      if (!isFinite(r.input) || !isFinite(r.output)) return;
      // Update workload + form
      workload.anchor_query.input_tokens = r.input;
      workload.anchor_query.output_tokens = r.output;
      // Reflect in form inputs
      document.querySelector('[data-bind="anchor_query.input_tokens"]').value = r.input;
      document.querySelector('[data-bind="anchor_query.output_tokens"]').value = r.output;
      renderPreview();
      renderRawJson();
      showToast(`Applied: ${r.input.toLocaleString()} in / ${r.output.toLocaleString()} out`);
    });

    document.getElementById('wiz-reset').addEventListener('click', () => {
      Object.keys(answers).forEach(k => delete answers[k]);
      wizard.querySelectorAll('input[type="radio"]').forEach(i => i.checked = false);
      update();
    });

    update();

    // ----- Sample-text mode -----
    const sampleIn = document.getElementById('wiz-sample-in');
    const sampleOut = document.getElementById('wiz-sample-out');
    const sampleApply = document.getElementById('wiz-sample-apply');
    if (sampleIn && sampleOut && sampleApply) {
      const charsToTokens = (s) => Math.ceil((s || '').length / 4);
      const updateSample = () => {
        const inChars = (sampleIn.value || '').length;
        const outChars = (sampleOut.value || '').length;
        const inTok = charsToTokens(sampleIn.value);
        const outTok = charsToTokens(sampleOut.value);
        document.getElementById('wiz-sample-in-stats').textContent = `${inChars.toLocaleString()} / ${inTok.toLocaleString()}`;
        document.getElementById('wiz-sample-out-stats').textContent = `${outChars.toLocaleString()} / ${outTok.toLocaleString()}`;
        // Cost at gpt-5.2 standard, assume 0.84 cache hit on input
        const inUncached = inTok * 0.16, inCached = inTok * 0.84;
        const cost = inUncached * 1.75 / 1e6 + inCached * 0.175 / 1e6 + outTok * 14 / 1e6;
        document.getElementById('wiz-sample-cost').textContent = inTok > 0 || outTok > 0 ? '$' + cost.toFixed(4) : '—';
        sampleApply.disabled = !(inTok > 0 && outTok > 0);
      };
      sampleIn.addEventListener('input', updateSample);
      sampleOut.addEventListener('input', updateSample);
      sampleApply.addEventListener('click', () => {
        const inTok = charsToTokens(sampleIn.value);
        const outTok = charsToTokens(sampleOut.value);
        workload.anchor_query.input_tokens = inTok;
        workload.anchor_query.output_tokens = outTok;
        document.querySelector('[data-bind="anchor_query.input_tokens"]').value = inTok;
        document.querySelector('[data-bind="anchor_query.output_tokens"]').value = outTok;
        renderPreview();
        renderRawJson();
        showToast(`Applied from sample: ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out`);
      });
      document.getElementById('wiz-sample-clear').addEventListener('click', () => {
        sampleIn.value = ''; sampleOut.value = ''; updateSample();
      });
      updateSample();
    }
  }

  // -----------------------------------------------------------------
  // Section navigator + search
  // -----------------------------------------------------------------
  // Plain-English category labels for pill grouping
  const CATEGORY_LABELS = {
    scenario: 'Scenario',
    setup: 'Setup',
    traffic: 'Traffic',
    quality: 'Quality',
    limits: 'Limits',
    selfhost: 'Self-host',
    reference: 'Reference',
  };
  const CATEGORY_ORDER = ['scenario', 'setup', 'traffic', 'limits', 'quality', 'selfhost', 'reference'];

  function buildSectionNav() {
    // Build pill list into BOTH the side-column nav and the embedded-tablet nav
    const pillContainers = [
      document.getElementById('section-pills'),
      document.getElementById('section-pills-side'),
    ].filter(Boolean);
    const searchInputs = [
      document.getElementById('section-search'),
      document.getElementById('section-search-side'),
    ].filter(Boolean);

    // Section IDs + collapsible h2 click handlers — wire these BEFORE
    // the pill-container check below. Pills (the old top-of-page filter
    // UI) were removed during the Workspace merger, but section
    // expand/collapse is still the primary interaction pattern. If
    // we early-return when pillContainers is empty (as the original
    // code did), section h2 clicks silently no-op.
    const sections = Array.from(document.querySelectorAll('.editor-body .section'));
    sections.forEach((s, i) => {
      if (!s.id) s.id = 'sec-' + (i + 1);
    });
    sections.forEach(s => {
      const h2 = s.querySelector('h2');
      if (!h2 || h2.dataset.bound) return;
      h2.dataset.bound = '1';
      h2.addEventListener('click', () => {
        s.classList.toggle('open');
      });
    });

    if (pillContainers.length === 0) return;

    function rebuildPills() {
      pillContainers.forEach(pills => {
        pills.innerHTML = '';
        const grouped = {};
        sections.forEach(s => {
          const cat = s.dataset.cat || 'reference';
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push(s);
        });
        for (const cat of CATEGORY_ORDER) {
          const list = grouped[cat];
          if (!list || list.length === 0) continue;
          const grp = document.createElement('div');
          grp.className = 'pill-group';
          const lab = document.createElement('span');
          lab.className = 'group-label';
          lab.textContent = CATEGORY_LABELS[cat] || cat;
          grp.appendChild(lab);
          list.forEach(s => {
            const h2 = s.querySelector('h2');
            const lead = h2 ? (h2.querySelector('.lead') || {}).textContent : null;
            const num = h2 ? (h2.querySelector('.num') || {}).textContent : null;
            const pill = document.createElement('span');
            pill.className = 'pill';
            pill.textContent = (num ? num + ' · ' : '') + (lead || 'Section');
            pill.dataset.target = s.id;
            pill.addEventListener('click', () => {
              // Auto-switch to Components tab so the section is actually visible
              if (typeof window.__ccsSwitchTab === 'function') window.__ccsSwitchTab('components');
              const el = document.getElementById(pill.dataset.target);
              if (el) {
                el.classList.add('open');
                // Defer scroll so the panel has time to display
                setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                highlightActive(pill.dataset.target);
              }
            });
            grp.appendChild(pill);
          });
          pills.appendChild(grp);
        }
      });
    }
    rebuildPills();
    // For backward compatibility with the rest of this function, alias
    // `pills` to the FIRST pill container so existing references work:
    const pills = pillContainers[0];
    const search = searchInputs[0];

    function highlightActive(id) {
      pillContainers.forEach(pc => {
        pc.querySelectorAll('.pill').forEach(p => {
          p.classList.toggle('active', p.dataset.target === id);
        });
      });
    }

    // Search filter — works from either input; mirrors value to the other.
    function applyFilter(sourceInput) {
      const q = (sourceInput ? sourceInput.value : (searchInputs[0]?.value || '')).trim().toLowerCase();
      // Mirror value to the other input so they stay in sync
      searchInputs.forEach(inp => { if (inp !== sourceInput) inp.value = q; });

      let firstMatchId = null;
      sections.forEach(s => {
        const text = s.textContent.toLowerCase();
        const matches = q === '' || text.includes(q);
        s.classList.toggle('match', q !== '' && matches);
        s.classList.toggle('dimmed', q !== '' && !matches);
        if (q !== '' && matches) {
          s.classList.add('open');
          if (!firstMatchId) firstMatchId = s.id;
        }
      });
      pillContainers.forEach(pc => {
        pc.querySelectorAll('.pill').forEach(p => {
          const target = document.getElementById(p.dataset.target);
          const matches = !target || target.textContent.toLowerCase().includes(q);
          p.classList.toggle('hidden', !matches);
        });
        pc.querySelectorAll('.pill-group').forEach(g => {
          const visible = g.querySelectorAll('.pill:not(.hidden)').length;
          g.style.display = visible === 0 ? 'none' : 'flex';
        });
      });
      if (q !== '' && firstMatchId) {
        const el = document.getElementById(firstMatchId);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        highlightActive(firstMatchId);
      }
    }
    searchInputs.forEach(inp => {
      inp.addEventListener('input', () => applyFilter(inp));
      inp.addEventListener('keydown', e => {
        if (e.key === 'Escape') { inp.value = ''; applyFilter(inp); }
      });
    });

    // Expand-all / Collapse-all (works from BOTH toolbars)
    ['section-toolbar', 'section-toolbar-side'].forEach(tbId => {
      const toolbar = document.getElementById(tbId);
      if (!toolbar || toolbar.dataset.bound) return;
      toolbar.dataset.bound = '1';
      toolbar.querySelector('[data-act="expand"]').addEventListener('click', () => {
        sections.forEach(s => s.classList.add('open'));
      });
      toolbar.querySelector('[data-act="collapse"]').addEventListener('click', () => {
        // sec-scenario was retired (merged into sec-deployment); the
        // exclusion that used to live here is now a no-op. All sections
        // collapse uniformly.
        sections.forEach(s => {
          s.classList.remove('open');
        });
      });
    });

    // Track scroll → highlight active pill via IntersectionObserver
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) highlightActive(entry.target.id);
      });
    }, { root: document.querySelector('.editor'), threshold: 0.3, rootMargin: '-100px 0px 0px 0px' });
    sections.forEach(s => io.observe(s));
  }

  // -----------------------------------------------------------------
  // URL hash sharing
  //
  // The hash carries both the workload JSON and a small snapshot of the
  // simulator sliders + opts dropdowns (`ui`). Without the ui block, two
  // people opening the same share-link saw different headlines because
  // retry rate, cache override, and the hosting/model/tier dropdowns
  // were missing from the encoded payload.
  //
  // Encoded shape: { workload: {...}, ui: {...} }
  // Legacy compat: an unwrapped workload (with top-level `deployment`
  // + `shapes`) is still accepted; the ui block is skipped.
  // -----------------------------------------------------------------
  const UI_SELECTORS = [
    's-users', 's-sessions', 's-turns', 's-cache', 's-retry', 's-growth',
    'prev-hosting', 'prev-model', 'prev-tier', 'prev-mix', 'prev-cost-mode',
    'prev-bot', 'prev-verif', 'prev-cache', 'prev-api-split',
    'prev-gpu', 'prev-commitment', 'prev-replicas', 'prev-tokens',
    'budget-target', 'self-host-duty',
  ];
  function captureUiState() {
    const ui = {};
    for (const id of UI_SELECTORS) {
      const el = document.getElementById(id);
      if (el && el.value !== '' && el.value != null) ui[id] = el.value;
    }
    const tco = document.querySelector('input[name="tco-period"]:checked');
    if (tco) ui.tcoPeriod = tco.value;
    return ui;
  }
  function restoreUiState(ui) {
    if (!ui || typeof ui !== 'object') return;
    for (const id of UI_SELECTORS) {
      if (!(id in ui)) continue;
      const el = document.getElementById(id);
      if (!el) continue;
      el.value = ui[id];
      // Dispatch input + change so any listeners (simulator onSlider,
      // budget solver, etc.) pick up the restored value.
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (ui.tcoPeriod) {
      const r = document.querySelector(`input[name="tco-period"][value="${ui.tcoPeriod}"]`);
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    // Mirror selected UI values back into workload so the two stay in sync.
    // Without this, any code path that re-reads from workload (e.g., a later
    // __setSimulatorFromWorkload call, a re-render, a preset switch) would
    // overwrite the user-set UI value with the original workload value,
    // breaking shareable links for those fields.
    if (workload) {
      if ('s-cache' in ui && workload.anchor_query) {
        const pct = parseFloat(ui['s-cache']);
        if (!Number.isNaN(pct)) workload.anchor_query.cache_rate_baseline = pct / 100;
      }
    }
  }
  // Stashed across loadFromHash → restoreUiState window so the UI
  // values can be applied AFTER the simulator script has wired its
  // sliders (it doesn't exist at loadFromHash time).
  let _pendingUiRestore = null;

  function loadFromHash() {
    try {
      const m = location.hash.match(/w=([^&]+)/);
      if (!m) return false;
      const json = decodeURIComponent(atob(m[1]));
      const parsed = JSON.parse(json);
      // New format: { workload, ui }
      if (parsed && parsed.workload && parsed.workload.deployment && parsed.workload.shapes) {
        workload = ensureFields(parsed.workload); window.workload = workload;
        _pendingUiRestore = parsed.ui || null;
        return true;
      }
      // Legacy: unwrapped workload at the top level
      if (parsed && parsed.deployment && parsed.shapes) {
        workload = ensureFields(parsed); window.workload = workload;
        return true;
      }
    } catch (_) {}
    return false;
  }

  // Auto-update URL hash on every change so refreshing preserves state.
  // Preserves the &mode=basic|advanced param if it's set so toggling
  // between Basic and Advanced sticks across workload edits and reloads.
  let hashUpdateTimer = null;
  function scheduleHashUpdate() {
    if (hashUpdateTimer) clearTimeout(hashUpdateTimer);
    hashUpdateTimer = setTimeout(() => {
      try {
        const payload = { workload, ui: captureUiState() };
        const json = JSON.stringify(payload);
        const hash = btoa(encodeURIComponent(json));
        // Carry the UI mode through. Read it from the body class
        // (set by setUiMode) rather than the URL hash because on the
        // initial render this serializer can fire before setUiMode has
        // had a chance to write its #mode= param — body class is the
        // canonical source of truth and is always set by this point.
        const modeClass = document.body.classList.contains('mode-advanced')
          ? 'advanced'
          : (document.body.classList.contains('mode-basic') ? 'basic' : null);
        const modeSuffix = modeClass ? '&mode=' + modeClass : '';
        history.replaceState(null, '', '#w=' + hash + modeSuffix);
      } catch (_) {}
    }, 500);
  }

  // Wrap renderPreview to also schedule hash update
  const _origRenderPreview = renderPreview;
  renderPreview = function () {
    _origRenderPreview();
    scheduleHashUpdate();
  };
  // Expose so setUiMode (in cost-simulator.js) can re-trigger the hash
  // serializer after toggling mode — guarantees the mode= param survives
  // even on initial load when the renderPreview timer may have fired
  // before setUiMode established the body class.
  window.__scheduleHashUpdate = scheduleHashUpdate;

  // -----------------------------------------------------------------
  // Toast
  // -----------------------------------------------------------------
  function showToast(msg, ms = 2000) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.style.opacity = '1';
    setTimeout(() => { t.style.opacity = '0'; }, ms);
  }
  // Expose to simulator-side handlers (Apply-to-all link, promotion toast).
  window.showToast = showToast;

  // -----------------------------------------------------------------
  // Excel export (SheetJS)
  // -----------------------------------------------------------------
  function generateExcel() {
    const wb = XLSX.utils.book_new();
    const opts = {
      model: document.getElementById('prev-model').value || workload.defaults.model,
      mix: document.getElementById('prev-mix').value || workload.defaults.mix,
      tier: workload.defaults.tier,
      costMode: document.getElementById('prev-cost-mode').value,
      hosting: document.getElementById('prev-hosting')?.value || workload.defaults.hosting,
      botFactor: parseFloat(document.getElementById('prev-bot')?.value) || 1.5,
      cacheRate: parseFloat(document.getElementById('s-cache')?.value) / 100 || workload.anchor_query?.cache_rate_baseline,
      verifCoverage: Number(workload.verification?.coverage) || 0,
    };
    const r = CostEngine.compute(workload, opts);
    // Mirror renderPreview's retry inflate so the "Headline" rows below
    // match what the user sees in the live UI.
    const retryRate = parseFloat(document.getElementById('s-retry')?.value) / 100 || 0;
    const retryInflate = 1 + (retryRate * 1.5);
    const composed = composeHeadline(r, workload, opts, retryInflate);

    // ---- README sheet ----
    const readme = [
      ['Cost Calculator · ' + (workload.deployment.name || 'AI Agent')],
      [workload.deployment.agency || ''],
      [],
      [workload.deployment.description || ''],
      [],
      ['About this workbook'],
      ['Generated by AI Cost Calculator at ' + new Date().toISOString().slice(0, 10)],
      [],
      ['Methodology: same arithmetic as the live calculator at the URL'],
      ['where this workbook was generated. The Output sheet shows the'],
      ['four-row API-vs-self-host comparison; the Workload sheet shows'],
      ['the input parameters; the Computation sheet shows derived values.'],
      [],
      ['To re-run with different parameters, change the workload JSON in'],
      ['the Workload sheet and import it back into the live calculator.'],
      [],
      ['Cite as: Kulkarni, A. (2026). Cost Modeling for Public-Facing'],
      ['LLM Chat Applications. https://calc.ajinkya.ai'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(readme), 'README');

    // ---- Output sheet (the four-row comparison) ----
    const sh = r.self_host;
    const shc = r.self_host_capped;
    const apiCapped = r.api.monthly_capped;
    const apiGross = r.api.monthly_gross;
    const refused = r.api.monthly_refused_queries;
    const totalQ = r.queries.total;

    const output = [
      ['API vs Self-Host Comparison'],
      ['Model: ' + opts.model + ' · Mix: ' + opts.mix + ' · Cost mode: ' + opts.costMode],
      [],
      ['Strategy', 'LLM monthly ($)', 'Queries served', 'Queries refused', 'Notes'],
      [
        'API · ' + opts.model + ' (engine raw, pre-retry, capped at $' + (workload.daily_cap?.amount_usd || 0) + '/day)',
        Math.round(apiCapped),
        Math.round(totalQ - refused),
        Math.round(refused),
        refused > 0 ? 'Cap clips ' + Math.round(100 * refused / totalQ) + '% of traffic' : 'all queries served',
      ],
      [
        'API · ' + opts.model + ' (engine raw, pre-retry, uncapped)',
        Math.round(apiGross),
        Math.round(totalQ),
        0,
        'serves all queries — fair peer to self-host full',
      ],
      [
        'Self-host · ' + sh.gpu_spec.name + ' × ' + sh.instances + ' (' + sh.cost_mode + ')',
        Math.round(sh.total),
        Math.round(totalQ),
        0,
        '−8 to −15 pts quality vs commercial flagship',
      ],
    ];
    if (shc) {
      output.push([
        'Self-host (capped to same $' + (workload.daily_cap?.amount_usd || 0) + '/day budget)',
        Math.round(shc.total),
        Math.round(shc.queries_served),
        Math.round(shc.queries_refused),
        'fair peer to API capped row',
      ]);
    }
    // Headline rows below mirror the live UI exactly: includes retry
    // inflate + verification + federal + fixed + embeddings + personnel
    // + agent engineering. Routed through composeHeadline (the same
    // helper renderPreview uses) so Excel never drifts from the page.
    output.push([]);
    output.push(['Headline monthly (matches live UI)', Math.round(composed.headline)]);
    output.push(['  · LLM (post-retry × ' + retryInflate.toFixed(4) + ')', Math.round(composed.llm)]);
    if (composed.verif > 0)    output.push(['  · Verification',     Math.round(composed.verif)]);
    if (composed.fed > 0)      output.push(['  · Federal additive', Math.round(composed.fed)]);
    if (composed.emb > 0)      output.push(['  · Embeddings',       Math.round(composed.emb)]);
    if (composed.pers > 0)     output.push(['  · Personnel',        Math.round(composed.pers)]);
    if (composed.ae > 0)       output.push(['  · Agent engineering', Math.round(composed.ae)]);
    if (composed.fixed > 0)    output.push(['  · Fixed monthly',    Math.round(composed.fixed)]);
    output.push(['Annual',     Math.round(composed.headline * 12)]);
    output.push(['3-year TCO', Math.round(composed.headline * 36)]);

    const outputSheet = XLSX.utils.aoa_to_sheet(output);
    outputSheet['!cols'] = [{ wch: 60 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, outputSheet, 'Output');

    // ---- Workload sheet (full JSON for reference) ----
    const workloadSheet = [
      ['Workload Specification (JSON)'],
      [],
      ['Edit and re-import via the live calculator at the URL where this'],
      ['workbook was generated. The JSON below is the single source of'],
      ['truth for every number above.'],
      [],
    ];
    JSON.stringify(workload, null, 2).split('\n').forEach(line => {
      workloadSheet.push([line]);
    });
    const wlSheet = XLSX.utils.aoa_to_sheet(workloadSheet);
    wlSheet['!cols'] = [{ wch: 100 }];
    XLSX.utils.book_append_sheet(wb, wlSheet, 'Workload');

    // ---- Per-segment breakdown ----
    const segData = [['Segment', 'MAU', 'Sessions/day', 'Q/session', 'Bot factor', 'Queries/mo', 'Eff cache', 'Per-query $', 'Monthly $']];
    workload.segments.forEach(seg => {
      const segPq = r.api.per_segment[seg.id] || {};
      segData.push([
        seg.label || seg.id,
        seg.mau,
        seg.sessions_per_day,
        seg.questions_per_session,
        seg.applyBotFactor ? 'yes' : 'no',
        Math.round(r.queries.bySegment[seg.id] || 0),
        ((segPq.eff_cache || 0) * 100).toFixed(1) + '%',
        '$' + (segPq.per_query || 0).toFixed(4),
        '$' + Math.round((r.queries.bySegment[seg.id] || 0) * (segPq.per_query || 0)).toLocaleString(),
      ]);
    });
    const segSheet = XLSX.utils.aoa_to_sheet(segData);
    segSheet['!cols'] = [{ wch: 30 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, segSheet, 'Segments');

    // ---- Self-host capacity sheet ----
    const shData = [
      ['Self-Host Capacity Math'],
      [],
      ['Cost mode', sh.cost_mode],
      ['GPU instance', sh.gpu_spec.name],
      ['Tokens per query (assumption)', workload.self_host?.tokens_per_query_default || 2000],
      ['Avg QPS', sh.qps_avg.toFixed(2)],
      ['Peak tok/sec (× diurnal × headroom)', Math.round(sh.peak_tps)],
      ['Per-instance throughput (effective)', Math.round(sh.effective_tput)],
      ['Instances needed by load', sh.needed_by_load],
      ['Running instances', sh.instances],
      ['GPU monthly ($)', Math.round(sh.gpu_monthly)],
      ['Ops monthly ($)', sh.ops_monthly],
      ['MLOps FTE monthly ($)', sh.fte_monthly],
      ['Setup amortized ($)', sh.setup_amortized],
      ['Total ($/mo)', Math.round(sh.total)],
      ['Effective $/query', sh.effective_per_query.toFixed(4)],
    ];
    const shSheet = XLSX.utils.aoa_to_sheet(shData);
    shSheet['!cols'] = [{ wch: 40 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, shSheet, 'Self-Host');

    // Trigger download
    const slug = (workload.deployment.name || 'cost-model').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    XLSX.writeFile(wb, slug + '-cost-model.xlsx');
    showToast('Excel workbook downloaded ✓');
  }

  // -----------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    setupHandlers();

    // Priority: URL hash > default example preset
    if (!loadFromHash()) {
      try {
        const resp = await fetch('examples/public-geospatial-qa.json');
        if (resp.ok) { workload = ensureFields(await resp.json()); window.workload = workload; }
      } catch (_) { /* fall back to blank */ }
    } else {
      // hash-loaded; ensureFields was already called inside loadFromHash
    }
    if (!workload.self_host) { workload = ensureFields(workload); window.workload = workload; }
    renderEditor();
    // Mirror the loaded workload INTO the simulator. Writeback (sim → workload)
    // stays OFF during this push and is enabled later, so the boot-time
    // onSlider() inside the simulator can't inject its default Claude fleet
    // back into workload.agents (the bug that produced the $303K headline).
    window.__setSimWritebackEnabled?.(false);
    window.__syncAxiomFromSegments?.();
    window.__setSimulatorFromWorkload?.(workload);
    // If the URL hash carried a `ui` block, apply it now — overrides the
    // segment-derived slider values so a shared link reproduces the
    // sender's exact knob state (cache, retry, hosting, model, etc.).
    if (_pendingUiRestore) {
      restoreUiState(_pendingUiRestore);
      _pendingUiRestore = null;
    }
    renderPreview();
    // Boot-time mirror complete. Defer enabling writeback past the simulator's
    // own boot-time setTimeout(...,100ms) at the bottom of cost-simulator.js,
    // which fires onSlider() asynchronously. Without this delay, that tick
    // races us and one stale autoSync push lands on workload.agents.
    setTimeout(() => { window.__setSimWritebackEnabled?.(true); }, 300);
    setupTabs();        // must run before setupWizard so wizard moves first
    setupWizard();
    setupArchitecture();
    setupSplitters();
    setupArchZoom();
    setupChatBuilder();
    setupComponentGallery();
    setupPricesTab();
    setupBenchmarksTab();
    // 3-year TCO toggle re-renders the headline on change
    document.querySelectorAll('input[name="tco-period"]').forEach(r => {
      r.addEventListener('change', renderPreview);
    });
    // Risk band toggle
    const riskToggleBtn = document.getElementById('prev-risk-toggle');
    if (riskToggleBtn) {
      riskToggleBtn.addEventListener('click', () => {
        if (!workload.risk) workload.risk = {};
        workload.risk.enabled = !workload.risk.enabled;
        renderPreview();
      });
    }
    // Self-host duty cycle slider
    const dutySlider = document.getElementById('self-host-duty');
    const dutyVal = document.getElementById('self-host-duty-val');
    if (dutySlider) {
      // Initialize from workload
      const cur = workload.self_host && workload.self_host.duty_cycle != null ? workload.self_host.duty_cycle : 1.0;
      dutySlider.value = String(Math.round(cur * 100));
      if (dutyVal) dutyVal.textContent = Math.round(cur * 100) + '%';
      dutySlider.addEventListener('input', () => {
        const pct = parseInt(dutySlider.value, 10);
        if (dutyVal) dutyVal.textContent = pct + '%';
        if (!workload.self_host) workload.self_host = {};
        workload.self_host.duty_cycle = pct / 100;
        renderPreview();
        renderRawJson();
      });
    }
  });

  // -----------------------------------------------------------------
  // Prices tab — renders all categories from window.Prices.
  //
  // Editing any cell writes to workload.prices[category][key][field],
  // which the engine reads via Prices.getPrice() (override layer).
  // The prices.js file remains pristine — workload-level overrides
  // travel with the URL hash so shared links preserve them.
  // -----------------------------------------------------------------
  const PRICE_CATEGORIES = [
    { id: 'llm_models',           title: 'LLM model rates',          fields: ['input_per_million', 'cached_per_million', 'output_per_million', 'provider'], money: ['input_per_million', 'cached_per_million', 'output_per_million'] },
    { id: 'tier_multipliers',     title: 'Service-tier multipliers', fields: ['multiplier', 'sla', 'notes'],                                                  money: [] },
    { id: 'api_reservations',     title: 'API reservations / committed-spend', fields: ['provider', 'name', 'discount', 'commitment_months', 'notes'],        money: [] },
    { id: 'gpu_instances',        title: 'GPU instances (EC2)',      fields: ['hourly', 'tput_tps', 'name', 'capable'],                                       money: ['hourly'] },
    { id: 'self_host_cost_modes', title: 'Self-host cost modes',     fields: ['ops_monthly', 'fte_monthly', 'setup_amortized', 'throughput_derate', 'discount_1yr', 'discount_3yr'], money: ['ops_monthly', 'fte_monthly', 'setup_amortized'] },
    { id: 'embeddings',           title: 'Embedding model rates',    fields: ['dollar_per_million_tokens', 'dimensions', 'provider'],                        money: ['dollar_per_million_tokens'] },
    { id: 'vector_dbs',           title: 'Vector databases',         fields: ['monthly_flat', 'dollar_per_million_vectors_stored', 'dollar_per_million_reads', 'provider'], money: ['monthly_flat', 'dollar_per_million_vectors_stored', 'dollar_per_million_reads'] },
    { id: 'cloud_aws',            title: 'AWS infrastructure',       custom: 'cloud_aws_renderer' },
    { id: 'personnel',            title: 'Personnel salaries (US)',  fields: ['annual_base', 'total_comp_multiplier', 'notes'],                              money: ['annual_base'] },
    { id: 'ato',                  title: 'ATO / compliance costs',   fields: ['upfront', 'annual_continuous_monitoring', 'assessment_cycle_months', 'notes'], money: ['upfront', 'annual_continuous_monitoring'] },
    { id: 'federal_multipliers_fedramp', title: 'FedRAMP hosting multipliers', source: 'federal_multipliers.fedramp', fields: ['multiplier', 'notes'], money: [] },
    { id: 'federal_multipliers_multiregion', title: 'Multi-region / DR multipliers', source: 'federal_multipliers.multi_region', fields: ['multiplier', 'notes'], money: [] },
  ];

  function setupPricesTab() {
    const host = document.getElementById('prices-host');
    if (!host) return;
    const lastChecked = document.getElementById('prices-last-checked');
    if (lastChecked && window.Prices && window.Prices.meta) {
      lastChecked.textContent = window.Prices.meta.last_checked || '—';
    }
    renderPricesTab();
  }

  function getPriceCategoryData(catId) {
    if (!window.Prices) return {};
    if (catId.includes('.')) {
      const [a, b] = catId.split('.');
      return (window.Prices[a] && window.Prices[a][b]) || {};
    }
    return window.Prices[catId] || {};
  }

  function renderPricesTab() {
    const host = document.getElementById('prices-host');
    if (!host) return;
    let html = '';
    for (const cat of PRICE_CATEGORIES) {
      const dataKey = cat.source || cat.id;
      const data = getPriceCategoryData(dataKey);
      const keys = Object.keys(data);
      const rowCount = keys.length;
      html += `<details class="price-category" id="pc-${cat.id}">
        <summary>${cat.title} <em>${rowCount} entries</em></summary>
        <div class="pc-body">`;
      if (cat.custom === 'cloud_aws_renderer') {
        html += renderCloudAwsTable();
      } else {
        html += renderGenericPriceTable(cat, dataKey, data);
      }
      html += `</div></details>`;
    }
    host.innerHTML = html;
    wirePriceTableInputs();
  }

  function renderGenericPriceTable(cat, dataKey, data) {
    const fields = cat.fields || [];
    let html = `<table class="price-table">
      <thead><tr>
        <th>Key</th>
        ${fields.map(f => `<th>${f}</th>`).join('')}
        <th>Source</th>
        <th>Verified</th>
      </tr></thead>
      <tbody>`;
    for (const [key, entry] of Object.entries(data)) {
      const isStale = isVerifiedStale(entry.last_verified);
      html += `<tr class="${isStale ? 'row-stale' : ''}">
        <td class="row-id">${escapeHtml(key)}</td>`;
      for (const f of fields) {
        const v = entry[f];
        const isMoney = (cat.money || []).includes(f);
        if (typeof v === 'number') {
          html += `<td><input type="number" step="${isMoney ? '0.001' : (Number.isInteger(v) ? '1' : '0.01')}" value="${v}" data-price-edit="${dataKey}|${escapeAttr(key)}|${f}"></td>`;
        } else if (typeof v === 'string') {
          html += `<td><input type="text" value="${escapeAttr(v)}" data-price-edit="${dataKey}|${escapeAttr(key)}|${f}" style="width: 160px;"></td>`;
        } else {
          html += `<td style="color: var(--muted); font-size: 10px;">—</td>`;
        }
      }
      html += `<td class="row-source">${entry.source_url ? `<a href="${escapeAttr(entry.source_url)}" target="_blank" rel="noopener">↗ source</a>` : '—'}</td>`;
      html += `<td class="row-verified">${entry.last_verified || '—'}</td>`;
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    return html;
  }

  function renderCloudAwsTable() {
    if (!window.Prices || !window.Prices.cloud_aws) return '<p>—</p>';
    const c = window.Prices.cloud_aws;
    let html = `<table class="price-table">
      <thead><tr><th>Service</th><th>Field</th><th>$ value</th><th>Source</th><th>Verified</th></tr></thead><tbody>`;
    const flatten = (obj, parent) => {
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'source_url' || k === 'last_verified' || k === 'tiers') continue;
        if (typeof v === 'object' && v !== null) {
          flatten(v, parent + '.' + k);
        } else if (typeof v === 'number') {
          html += `<tr>
            <td class="row-id">${parent.replace(/^\./, '')}</td>
            <td class="row-id">${k}</td>
            <td><input type="number" step="0.001" value="${v}" data-price-edit="cloud_aws|${parent.replace(/^\./, '')}|${k}"></td>
            <td class="row-source">${obj.source_url ? `<a href="${obj.source_url}" target="_blank" rel="noopener">↗ source</a>` : '—'}</td>
            <td class="row-verified">${obj.last_verified || '—'}</td>
          </tr>`;
        }
      }
    };
    for (const [svc, sub] of Object.entries(c)) {
      if (typeof sub === 'object' && sub !== null && !Array.isArray(sub)) {
        flatten(sub, svc);
      }
    }
    // RDS tier ladder
    if (c.rds_postgres && Array.isArray(c.rds_postgres.tiers)) {
      for (const t of c.rds_postgres.tiers) {
        html += `<tr>
          <td class="row-id">rds_postgres</td>
          <td class="row-id">${escapeHtml(t.name)}</td>
          <td><input type="number" step="0.001" value="${t.hourly}" data-price-edit-rds="${escapeAttr(t.name)}|hourly"> $/hr · capable up to <input type="number" step="1" value="${t.capable_qps}" data-price-edit-rds="${escapeAttr(t.name)}|capable_qps" style="width: 80px;"> QPS</td>
          <td class="row-source"><a href="${c.rds_postgres.source_url || '#'}" target="_blank" rel="noopener">↗ source</a></td>
          <td class="row-verified">${c.rds_postgres.last_verified || '—'}</td>
        </tr>`;
      }
    }
    html += `</tbody></table>`;
    return html;
  }

  function isVerifiedStale(dateStr) {
    if (!dateStr) return true;
    try {
      const d = new Date(dateStr);
      const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
      return ageDays > 90;  // mark red if older than 90 days
    } catch (_) { return true; }
  }

  function wirePriceTableInputs() {
    document.querySelectorAll('[data-price-edit]').forEach(el => {
      el.addEventListener('input', () => {
        const [dataKey, rowKey, field] = el.dataset.priceEdit.split('|');
        const newVal = el.type === 'number' ? parseFloat(el.value) : el.value;
        // Path lookup: dataKey may include '.' for nested categories
        const path = dataKey.split('.');
        let obj = window.Prices;
        for (const p of path) obj = obj[p];
        if (obj && obj[rowKey]) obj[rowKey][field] = newVal;
        // Re-normalize workload + re-render
        renderPreview();
      });
    });
    document.querySelectorAll('[data-price-edit-rds]').forEach(el => {
      el.addEventListener('input', () => {
        const [tierName, field] = el.dataset.priceEditRds.split('|');
        const tier = window.Prices.cloud_aws.rds_postgres.tiers.find(t => t.name === tierName);
        if (tier) {
          tier[field] = el.type === 'number' ? parseFloat(el.value) : el.value;
          renderPreview();
        }
      });
    });
  }

  function escapeAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // -----------------------------------------------------------------
  // Benchmarks tab — show published cost studies alongside user's calc
  // for sanity-check and procurement defense.
  // -----------------------------------------------------------------
  function setupBenchmarksTab() {
    if (!window.Prices || !window.Prices.benchmarks) return;
    renderBenchmarksTab();
  }

  function renderBenchmarksTab() {
    const host = document.getElementById('benchmarks-host');
    if (!host || !window.Prices) return;
    const benchmarks = window.Prices.benchmarks || {};
    let html = '';
    for (const [id, b] of Object.entries(benchmarks)) {
      const numRows = [];
      if (b.dollar_per_seat_per_month != null) numRows.push(['$ / seat / month', '$' + b.dollar_per_seat_per_month]);
      if (b.dollar_per_user_per_month != null) numRows.push(['$ / MAU / month', '$' + b.dollar_per_user_per_month]);
      if (b.dollar_per_query != null) numRows.push(['$ / query', '$' + b.dollar_per_query.toFixed(2)]);
      if (b.dollar_per_conversation != null) numRows.push(['$ / conversation', '$' + b.dollar_per_conversation.toFixed(2)]);
      if (b.annual_total_for_org != null) numRows.push(['Annual', '$' + (b.annual_total_for_org / 1e6).toFixed(1) + 'M']);
      if (b.annual_savings_estimate != null) numRows.push(['Annual savings', '$' + (b.annual_savings_estimate / 1e6).toFixed(0) + 'M']);
      if (b.cogs_pct_of_revenue != null) numRows.push(['COGS % of revenue', (b.cogs_pct_of_revenue * 100).toFixed(0) + '%']);
      if (b.median_payback_months != null) numRows.push(['Median payback', b.median_payback_months + ' months']);
      if (b.federal_total_estimate != null) numRows.push(['Federal aggregate', '$' + (b.federal_total_estimate / 1e9).toFixed(1) + 'B']);
      if (b.annual_budget_estimate != null) numRows.push(['Typical annual', '$' + (b.annual_budget_estimate / 1e6).toFixed(1) + 'M']);
      if (b.annual_min != null && b.annual_max != null) numRows.push(['Range', '$' + (b.annual_min / 1e6).toFixed(0) + 'M – $' + (b.annual_max / 1e6).toFixed(0) + 'M']);
      html += `<div class="benchmark-card" data-bench-id="${id}">
        <div class="bc-info">
          <span class="bc-cat">${escapeHtml(b.category || '')}</span>
          <div class="bc-name">${escapeHtml(b.name || id)}</div>
          <div class="bc-desc">${escapeHtml(b.description || '')}</div>
          ${b.notes ? `<div class="bc-notes">📝 ${escapeHtml(b.notes)}</div>` : ''}
          <div class="bc-source">${b.source_url ? `<a href="${escapeAttr(b.source_url)}" target="_blank" rel="noopener">↗ source</a> · verified ${b.last_verified || '—'}` : 'verified ' + (b.last_verified || '—')}</div>
        </div>
        <div class="bc-numbers">
          ${numRows.map(([label, value]) => `
            <div class="bc-num-row">
              <span class="bc-num-label">${label}</span>
              <span class="bc-num-value">${value}</span>
            </div>
          `).join('')}
          <div class="bc-delta" data-delta-for="${id}"></div>
        </div>
      </div>`;
    }
    host.innerHTML = html;
    updateBenchmarkComparison();
  }

  // Update the "Your calc" header + per-card delta when calc changes.
  function updateBenchmarkComparison() {
    const totalEl = document.getElementById('prev-total');
    const queriesEl = document.getElementById('prev-queries');
    const annualEl = document.getElementById('prev-annual');
    const perUserEl = document.getElementById('prev-per-user');
    const yourTotal = parseFloat((totalEl?.textContent || '0').replace(/[$,]/g, '')) || 0;
    const yourAnnual = parseFloat((annualEl?.textContent || '0').replace(/[$,]/g, '')) || 0;
    const yourQueries = parseFloat((queriesEl?.textContent || '0').replace(/[,]/g, '')) || 0;
    const yourPerUser = parseFloat((perUserEl?.textContent || '0').replace(/[$,]/g, '')) || 0;
    const yourPerQuery = yourQueries > 0 ? yourTotal / yourQueries : 0;

    const headlineSpan = document.getElementById('bench-your-headline');
    const perUserSpan = document.getElementById('bench-your-per-user');
    const perQuerySpan = document.getElementById('bench-your-per-query');
    const annualSpan = document.getElementById('bench-your-annual');
    if (headlineSpan) headlineSpan.textContent = '$' + yourTotal.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (perUserSpan) perUserSpan.textContent = '$' + yourPerUser.toFixed(2);
    if (perQuerySpan) perQuerySpan.textContent = '$' + yourPerQuery.toFixed(4);
    if (annualSpan) annualSpan.textContent = '$' + yourAnnual.toLocaleString(undefined, { maximumFractionDigits: 0 });

    // Per-card delta — pick the most relevant metric
    const benchmarks = (window.Prices && window.Prices.benchmarks) || {};
    for (const [id, b] of Object.entries(benchmarks)) {
      const deltaEl = document.querySelector(`[data-delta-for="${id}"]`);
      if (!deltaEl) continue;
      let deltaText = '';
      let deltaClass = '';
      if (b.dollar_per_user_per_month != null && yourPerUser > 0) {
        const ratio = yourPerUser / b.dollar_per_user_per_month;
        deltaText = `your $${yourPerUser.toFixed(2)}/MAU vs benchmark $${b.dollar_per_user_per_month}/MAU = ${ratio.toFixed(2)}×`;
        deltaClass = ratio > 0.5 && ratio < 2 ? 'in-range' : ratio > 0.2 && ratio < 5 ? 'high' : 'way-off';
      } else if (b.dollar_per_query != null && yourPerQuery > 0) {
        const ratio = yourPerQuery / b.dollar_per_query;
        deltaText = `your $${yourPerQuery.toFixed(4)}/q vs benchmark $${b.dollar_per_query.toFixed(2)}/q = ${ratio.toFixed(2)}×`;
        deltaClass = ratio > 0.5 && ratio < 2 ? 'in-range' : ratio > 0.2 && ratio < 5 ? 'high' : 'way-off';
      } else if (b.annual_budget_estimate != null && yourAnnual > 0) {
        const ratio = yourAnnual / b.annual_budget_estimate;
        deltaText = `your $${(yourAnnual / 1e6).toFixed(1)}M/yr vs benchmark $${(b.annual_budget_estimate / 1e6).toFixed(1)}M/yr = ${ratio.toFixed(2)}×`;
        deltaClass = ratio > 0.4 && ratio < 2.5 ? 'in-range' : ratio > 0.1 && ratio < 10 ? 'high' : 'way-off';
      } else if (b.dollar_per_seat_per_month != null && yourPerUser > 0) {
        // Per-seat benchmarks compared loosely to per-user (different concept but useful sanity check)
        const ratio = yourPerUser / b.dollar_per_seat_per_month;
        deltaText = `your $${yourPerUser.toFixed(2)}/MAU vs commercial seat $${b.dollar_per_seat_per_month}/seat (different metric)`;
        deltaClass = '';
      } else {
        deltaText = '(reference only — no direct comparison)';
        deltaClass = '';
      }
      deltaEl.textContent = deltaText;
      deltaEl.className = 'bc-delta' + (deltaClass ? ' ' + deltaClass : '');
    }
    // Re-render the chart whenever the comparison numbers change.
    renderBenchmarkChart();
  }

  // -----------------------------------------------------------------
  // Benchmark chart — log-axis dot plot.
  //   - X-axis = chosen metric ($/seat-mo, $/query, $/conversation, annual $)
  //   - Each cited benchmark = one dot, color-coded by category
  //   - User's current scenario = highlighted blue dot with a label
  //
  // Uses inline SVG (no chart library). Log scale because benchmarks span
  // 4-5 orders of magnitude (e.g. $0.012/q to $13M/yr).
  // -----------------------------------------------------------------
  let _benchChartMetric = 'seat';
  function renderBenchmarkChart() {
    const host = document.getElementById('benchmark-chart');
    if (!host) return;
    const benchmarks = (window.Prices && window.Prices.benchmarks) || {};
    const metric = _benchChartMetric;

    // Pull the user's calc-side numbers
    const totalEl = document.getElementById('prev-total');
    const queriesEl = document.getElementById('prev-queries');
    const annualEl = document.getElementById('prev-annual');
    const perUserEl = document.getElementById('prev-per-user');
    const yourTotal = parseFloat((totalEl?.textContent || '0').replace(/[$,]/g, '')) || 0;
    const yourAnnual = parseFloat((annualEl?.textContent || '0').replace(/[$,]/g, '')) || 0;
    const yourQueries = parseFloat((queriesEl?.textContent || '0').replace(/[,]/g, '')) || 0;
    const yourPerUser = parseFloat((perUserEl?.textContent || '0').replace(/[$,]/g, '')) || 0;
    const yourPerQuery = yourQueries > 0 ? yourTotal / yourQueries : 0;

    // Map metric -> field on benchmark + user's value + axis label + format
    const metricMap = {
      seat:         { field: 'dollar_per_seat_per_month', userValue: yourPerUser, label: '$ / seat-month', fmt: (v) => '$' + v.toFixed(2) },
      query:        { field: 'dollar_per_query',          userValue: yourPerQuery, label: '$ / query',     fmt: (v) => '$' + v.toFixed(4) },
      conversation: { field: 'dollar_per_conversation',   userValue: yourPerQuery, label: '$ / conversation', fmt: (v) => '$' + v.toFixed(2) },
      annual:       { field: 'annual_total_for_org',      userValue: yourAnnual,   label: 'Annual $',
                       fmt: (v) => v >= 1e9 ? '$' + (v/1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : '$' + Math.round(v/1e3) + 'K' },
    };
    const m = metricMap[metric];
    if (!m) { host.innerHTML = '<p style="color:var(--muted)">Unknown metric.</p>'; return; }

    // Collect benchmarks that have this field
    const points = [];
    for (const [id, b] of Object.entries(benchmarks)) {
      const v = b[m.field];
      if (v == null || !isFinite(v) || v <= 0) continue;
      const cat = (b.category || '').toLowerCase();
      const color =
        cat.includes('federal') ? '#7c4dff' :
        cat.includes('commercial') ? '#2a8c3a' :
        '#888';
      points.push({ id, name: b.name || id, value: v, color, source: b.source_url || '', notes: b.notes || '' });
    }
    if (m.userValue > 0) {
      // Build a rich hover tip for the user dot — surfaces the cost
      // drivers that explain the gap vs commercial seat-license benches.
      // Most of the per-MAU delta lives in: small user base, FedRAMP
      // multiplier, agent fleet, fixed-infra floor, federal additives.
      const w = window.workload || {};
      const drivers = [];
      const totalMau = (w.segments || []).reduce((a, s) => a + (s.mau || 0), 0);
      if (totalMau > 0 && totalMau < 5000) drivers.push(`Small base: ${totalMau.toLocaleString()} MAU (commercial benchmarks amortize across millions)`);
      const tier = w.federal?.fedramp_tier;
      if (tier && tier !== 'none') drivers.push(`FedRAMP ${tier} (×1.${tier === 'high' ? '30' : '15'} hosting multiplier)`);
      const agents = Array.isArray(w.agents) ? w.agents.length : 0;
      if (agents > 1) drivers.push(`${agents}-agent fleet (each query fans out across orchestrator + analyst + researcher)`);
      const verifOn = w.verification?.enabled && (w.verification?.coverage || 0) > 0;
      if (verifOn) drivers.push(`Verification at ${Math.round(w.verification.coverage * 100)}% coverage`);
      const driverText = drivers.length ? `\n\nWhy higher than the commercial benches:\n· ${drivers.join('\n· ')}` : '';
      points.push({
        id: '__user__', name: 'Your scenario', value: m.userValue,
        color: '#0077cc', source: '', isUser: true,
        notes: `Math: ${m.fmt(m.userValue)} = headline ÷ MAU. Commercial seat-license benches (Slack AI, ChatGPT Enterprise, etc.) are shared-infra consumer SaaS amortized across millions of seats — not directly comparable to a compliance-bound custom deployment.${driverText}`,
      });
    }

    if (points.length === 0) {
      host.innerHTML = `<p style="color:var(--muted);font-size:12px;padding:24px 0;text-align:center">No benchmarks have a <strong>${m.label}</strong> figure. Pick another metric tab.</p>`;
      return;
    }

    // Sort ascending by value (cheapest first), so the chart reads as a
    // ranked scoreboard. The user's scenario appears wherever its number
    // lands in the ordering — that's the answer to "where do I fall?"
    points.sort((a, b) => a.value - b.value);

    // Log-axis domain
    const vals = points.map(p => p.value);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const lo = Math.log10(minV);
    const hi = Math.log10(maxV);
    const padLo = lo - 0.15;
    const padHi = hi + 0.15;
    const span = Math.max(0.1, padHi - padLo);

    // Layout: one row per benchmark, sorted cheapest → priciest
    const rowH = 26;
    const labelW = 230;       // left column for benchmark names
    const valueW = 90;        // right column for the $ value
    const padL = 14, padR = 14, padT = 30, padB = 36;
    const W = 880;
    const H = padT + padB + points.length * rowH;
    const plotL = padL + labelW;
    const plotR = W - padR - valueW;
    const plotW = plotR - plotL;

    const xFor = (v) => plotL + ((Math.log10(v) - padLo) / span) * plotW;

    // Axis ticks
    const tickValues = [];
    const startExp = Math.floor(padLo);
    const endExp = Math.ceil(padHi);
    for (let exp = startExp; exp <= endExp; exp++) {
      const v = Math.pow(10, exp);
      if (Math.log10(v) >= padLo - 0.001 && Math.log10(v) <= padHi + 0.001) tickValues.push(v);
    }
    const tickLabel = (v) => {
      if (metric === 'annual') {
        if (v >= 1e9) return '$' + (v/1e9) + 'B';
        if (v >= 1e6) return '$' + (v/1e6) + 'M';
        if (v >= 1e3) return '$' + (v/1e3) + 'K';
        return '$' + v;
      }
      if (v >= 1) return '$' + v;
      if (v >= 0.01) return '$' + v.toFixed(2);
      return '$' + v.toFixed(3);
    };

    // Top-axis ticks + grid lines down through every row
    const ticksSvg = tickValues.map(v => {
      const x = xFor(v);
      return `<line x1="${x}" y1="${padT - 4}" x2="${x}" y2="${H - padB + 4}" stroke="var(--rule)" stroke-width="1"/>
              <text x="${x}" y="${padT - 8}" text-anchor="middle" fill="var(--muted)" font-size="10" font-family="var(--mono, monospace)">${tickLabel(v)}</text>`;
    }).join('');

    // One row per benchmark: name on the left, lollipop bar in the middle, $ on the right
    const truncate = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
    const rowsSvg = points.map((p, i) => {
      const y = padT + i * rowH + rowH / 2;
      const x = xFor(p.value);
      const isUser = !!p.isUser;
      const labelFill = isUser ? 'var(--accent)' : 'var(--ink)';
      const labelWeight = isUser ? '700' : '500';
      const labelText = (isUser ? '▶ ' : '') + truncate(p.name, 36);
      const valueFill = isUser ? 'var(--accent)' : 'var(--ink-2)';
      const valueWeight = isUser ? '700' : '500';
      const dotR = isUser ? 7 : 5;
      const barColor = isUser ? '#0077cc' : p.color;
      const rowBg = isUser ? '<rect x="0" y="' + (y - rowH/2) + '" width="' + W + '" height="' + rowH + '" fill="rgba(0,119,204,0.07)"/>' : '';
      const tipText = `${p.name}: ${m.fmt(p.value)}${p.notes ? '\n' + p.notes : ''}`;
      return `${rowBg}
        <text x="${plotL - 8}" y="${y + 4}" text-anchor="end" fill="${labelFill}" font-size="11.5" font-weight="${labelWeight}" font-family="var(--sans, sans-serif)">${escapeHtml(labelText)}</text>
        <line x1="${plotL}" y1="${y}" x2="${x}" y2="${y}" stroke="${barColor}" stroke-width="${isUser ? 2.5 : 1.5}" opacity="${isUser ? 1 : 0.6}"/>
        <circle class="bench-dot" cx="${x}" cy="${y}" r="${dotR}" fill="${barColor}" stroke="${isUser ? '#003a66' : 'rgba(0,0,0,0.3)'}" stroke-width="${isUser ? 1.8 : 1}" opacity="${isUser ? 1 : 0.85}">
          <title>${escapeHtml(tipText)}</title>
        </circle>
        <text x="${plotR + 8}" y="${y + 4}" fill="${valueFill}" font-size="11" font-weight="${valueWeight}" font-family="var(--mono, monospace)">${escapeHtml(m.fmt(p.value))}</text>`;
    }).join('');

    host.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="display:block;font-family:var(--sans, sans-serif)" preserveAspectRatio="xMidYMin meet">
        ${ticksSvg}
        <line x1="${plotL}" y1="${padT - 4}" x2="${plotL}" y2="${H - padB + 4}" stroke="var(--muted)" stroke-width="1"/>
        ${rowsSvg}
        <text x="${plotL}" y="${H - 12}" fill="var(--muted)" font-size="10.5">log scale ·  ${m.label}  · sorted cheapest → priciest</text>
        <text x="${W - padR}" y="${H - 12}" text-anchor="end" fill="var(--muted)" font-size="10.5">${points.length} rows (${points.filter(p => !p.isUser).length} cited benchmarks)</text>
      </svg>
      <p style="margin:6px 0 0;font-size:11px;color:var(--muted);line-height:1.45">Each row is one benchmark, sorted cheapest at the top. Your scenario is highlighted in blue. Hover any dot to see notes. Greens = commercial seat/conversation, purple = federal cost studies, gray = industry/academic references.</p>
      <p style="margin:8px 0 0;padding:8px 10px;font-size:11px;color:var(--ink-2);line-height:1.5;background:rgba(124,77,255,0.06);border-left:3px solid #7c4dff;border-radius:3px">
        <strong>⚠ Not a like-for-like comparison.</strong> Commercial seat-license prices (Slack AI, ChatGPT Enterprise, Copilot) are <em>shared-infrastructure consumer SaaS</em> amortized across millions of users. A custom deployment with a small user base, FedRAMP compliance, agent fleets, or domain-specific retrieval will run 5–50× higher per seat — that's the cost of doing work the consumer products don't do. Hover the blue "Your scenario" dot for the specific drivers in your config.
      </p>
    `;
  }

  // Wire the metric tabs (one-time bind on first chart render)
  function bindBenchmarkChartTabs() {
    const tabs = document.getElementById('bench-chart-tabs');
    if (!tabs || tabs.dataset.bound === '1') return;
    tabs.dataset.bound = '1';
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.bench-tab');
      if (!btn) return;
      _benchChartMetric = btn.dataset.metric || 'seat';
      tabs.querySelectorAll('.bench-tab').forEach(b => b.classList.toggle('active', b === btn));
      renderBenchmarkChart();
    });
  }
  // Bind on next tick so the DOM is ready
  setTimeout(bindBenchmarkChartTabs, 0);

  // Hook into renderPreview so the comparison updates whenever calc changes
  window.__ccsUpdateBenchmark = updateBenchmarkComparison;

  // -----------------------------------------------------------------
  // Active Components + Gallery dropdown
  //
  // Components tab shows only "active" sections — the ones the user (or
  // chat-builder AI) has explicitly added. Inactive sections live in a
  // searchable gallery dropdown ("+ Add a component"). Removing a
  // component preserves its underlying workload data so re-adding
  // restores the previous configuration.
  //
  // Active state is determined by:
  //   1. Explicit user toggle (persisted in localStorage)
  //   2. OR detection from workload state via autoActive(workload)
  // The OR rule lets AI/import/preset workflows auto-show relevant
  // sections without needing to update the toggle set explicitly.
  // -----------------------------------------------------------------

  // Always-on sections — required to model anything; no remove button.
  // (sec-scenario was retired, merged into sec-deployment — see the
  // comment near sec-deployment in index.html.)
  const ALWAYS_ON_SECTIONS = ['sec-deployment', 'sec-anchor', 'sec-segments'];

  // Optional components — toggleable via × on the section header or +
  // from the gallery dropdown.
  const OPTIONAL_COMPONENTS = [
    {
      id: 'sec-federal',
      name: 'Federal compliance & hosting',
      description: 'FedRAMP tier, multi-region/DR, ATO, data egress, audit retention, PII redaction.',
      icon: '🛡️',
      category: 'Federal',
      autoActive: (w) => w.federal && (
        (w.federal.fedramp_tier && w.federal.fedramp_tier !== 'none') ||
        (w.federal.multi_region && w.federal.multi_region !== 'single') ||
        w.federal.ato_monthly > 0 ||
        w.federal.retrieval_infra_monthly > 0 ||
        w.federal.pii_redaction_per_million_tokens > 0
      ),
      activate: (w) => { /* no-op — user fills fields */ },
      deactivate: (w) => {
        if (!w.federal) return;
        w.federal.fedramp_tier = 'none';
        w.federal.multi_region = 'single';
        // Note: numeric fields preserved (ato_monthly, egress, audit, etc.)
      },
    },
    {
      id: 'sec-shapes',
      name: 'Question types (shapes)',
      description: 'Custom traffic shape definitions — rag, refusal, heavy, etc. Skip if defaults are fine.',
      icon: '📊',
      category: 'Queries',
      autoActive: (w) => w.shapes && Object.keys(w.shapes).length > 1,
      activate: (w) => {},
      deactivate: (w) => { /* preserve shapes data, just hide UI */ },
    },
    {
      id: 'sec-agents',
      name: 'Multi-agent pipeline',
      description: 'Several LLM calls per query — planner, retriever, summarizer, verifier.',
      icon: '🔗',
      category: 'Queries',
      autoActive: (w) => Array.isArray(w.agents) && w.agents.length > 0,
      activate: (w) => { /* user adds agents from inside the section */ },
      deactivate: (w) => { w.agents = []; },
    },
    {
      id: 'sec-mix',
      name: 'Traffic mix presets',
      description: 'How questions split across types — worst-case, mixed, lookup-heavy.',
      icon: '🎚️',
      category: 'Queries',
      autoActive: (w) => w.mix && Object.keys(w.mix).length > 1,
      activate: (w) => {},
      deactivate: (w) => {},
    },
    // sec-verification moved into the simulator Configuration as a fixed sub-block —
    // no longer an optional component (always rendered, with its own
    // Enable verification on this deployment checkbox driving the toggle).
    {
      id: 'sec-cap',
      name: 'Daily spending cap',
      description: 'Hard ceiling on LLM spend per day — refuses requests when exceeded.',
      icon: '💰',
      category: 'Limits',
      autoActive: (w) => w.daily_cap && w.daily_cap.enabled,
      activate: (w) => {
        if (!w.daily_cap) w.daily_cap = { amount_usd: 1500, burst_days: 7, burst_factor: 1.0 };
        w.daily_cap.enabled = true;
      },
      deactivate: (w) => { if (w.daily_cap) w.daily_cap.enabled = false; },
    },
    {
      id: 'sec-ratelimit',
      name: 'Bot rate limiting',
      description: 'WAF / session throttling for public endpoints. Caps the bot factor multiplier.',
      icon: '🚧',
      category: 'Limits',
      autoActive: (w) => w.rate_limit && w.rate_limit.strategy && w.rate_limit.strategy !== 'none',
      activate: (w) => {
        if (!w.rate_limit) w.rate_limit = { monthly_cost: 15, bot_ceiling: 2.5 };
        if (!w.rate_limit.strategy || w.rate_limit.strategy === 'none') w.rate_limit.strategy = 'edge';
      },
      deactivate: (w) => { if (w.rate_limit) w.rate_limit.strategy = 'none'; },
    },
    {
      id: 'sec-selfhost',
      name: 'Self-host capacity',
      description: 'GPU instance catalog, diurnal sizing, headroom, HA replicas, throughput de-rate.',
      icon: '🖥️',
      category: 'Self-host',
      autoActive: (w) => w.defaults && w.defaults.hosting === 'self',
      activate: (w) => { if (w.defaults) w.defaults.hosting = 'self'; },
      deactivate: (w) => { if (w.defaults) w.defaults.hosting = 'api'; },
    },
    {
      id: 'sec-reservations',
      name: 'API reservations / committed-spend',
      description: 'Azure PTU, AWS Bedrock provisioned, OpenAI Enterprise commit. 30–50% savings at scale.',
      icon: '🎟️',
      category: 'Limits',
      autoActive: (w) => w.reservations && w.reservations.enabled,
      activate: (w) => { if (!w.reservations) w.reservations = {}; w.reservations.enabled = true; if (!w.reservations.type || w.reservations.type === 'none') w.reservations.type = 'azure-ptu-yearly'; },
      deactivate: (w) => { if (w.reservations) w.reservations.enabled = false; },
    },
    {
      id: 'sec-embeddings',
      name: 'Embeddings (RAG ingest + per-query)',
      description: 'Embedding cost for RAG: corpus ingest amortized + per-query embedding. Often $50–$500/mo.',
      icon: '🧬',
      category: 'Quality',
      autoActive: (w) => w.embedding && w.embedding.enabled,
      activate: (w) => { if (!w.embedding) w.embedding = {}; w.embedding.enabled = true; },
      deactivate: (w) => { if (w.embedding) w.embedding.enabled = false; },
    },
    {
      id: 'sec-personnel',
      name: 'Personnel / staffing',
      description: 'Fully-loaded labor cost: MLOps, prompt engineers, eval, security, oncall. Federal RFPs require this.',
      icon: '👥',
      category: 'Federal',
      autoActive: (w) => w.personnel && w.personnel.enabled,
      activate: (w) => { if (!w.personnel) w.personnel = { roles: [{ role: 'mlops_engineer', fte: 0.5 }] }; w.personnel.enabled = true; },
      deactivate: (w) => { if (w.personnel) w.personnel.enabled = false; },
    },
    {
      id: 'sec-migration',
      name: 'Migration timeline (3-year phased)',
      description: 'Plan year-by-year: e.g., API year 1 → committed-spend year 2 → self-host year 3. Computes per-phase cost + 3yr TCO.',
      icon: '📅',
      category: 'Limits',
      autoActive: (w) => w.migration && w.migration.enabled,
      activate: (w) => { if (!w.migration) w.migration = { phases: [] }; w.migration.enabled = true; },
      deactivate: (w) => { if (w.migration) w.migration.enabled = false; },
    },
  ];

  const COMPONENT_BY_ID = Object.fromEntries(OPTIONAL_COMPONENTS.map(c => [c.id, c]));
  const ACTIVE_STORAGE_KEY = 'ccs-active-components';
  let userActivatedSet = new Set();

  function loadUserActivatedSet() {
    try {
      const saved = JSON.parse(localStorage.getItem(ACTIVE_STORAGE_KEY) || '[]');
      if (Array.isArray(saved)) userActivatedSet = new Set(saved);
    } catch (_) { userActivatedSet = new Set(); }
  }
  function persistUserActivatedSet() {
    try {
      localStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify([...userActivatedSet]));
    } catch (_) {}
  }

  function isComponentActive(id) {
    if (userActivatedSet.has(id)) return true;
    const c = COMPONENT_BY_ID[id];
    return !!(c && c.autoActive(workload));
  }

  function activateComponent(id) {
    const c = COMPONENT_BY_ID[id];
    if (!c) return;
    c.activate(workload);
    userActivatedSet.add(id);
    persistUserActivatedSet();
    refreshComponentVisibility();
    renderEditor();
    renderPreview();
    // Scroll to the freshly added section
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('open');
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 80);
  }
  // Expose for the wizard sidebar dispatcher (in index.html). Allows
  // a sidebar click to reveal an optional section that's currently
  // gated by workload state.
  window.__ccsActivateComponent = activateComponent;

  function deactivateComponent(id) {
    const c = COMPONENT_BY_ID[id];
    if (!c) return;
    c.deactivate(workload);
    userActivatedSet.delete(id);
    persistUserActivatedSet();
    refreshComponentVisibility();
    renderEditor();
    renderPreview();
  }

  // Component gallery dropped — all components render inline at all
  // times. Each gates itself via its own Enable checkbox in the section.
  // We keep this function as a no-op-ish stub so callers don't need to
  // be touched; it just ensures every section is visible.
  function refreshComponentVisibility() {
    for (const c of OPTIONAL_COMPONENTS) {
      const el = document.getElementById(c.id);
      if (!el) continue;
      el.style.display = '';
    }
  }

  // Component gallery dropped — all 4 components render inline at all
  // times. The legacy ensureRemoveButton / renderGallery / openGallery /
  // closeGallery / setupComponentGallery functions are no longer needed.
  // We keep stubs so any external caller that referenced them silently
  // no-ops instead of crashing.
  function ensureRemoveButton() {}
  function renderGallery() {}
  function openGallery() {}
  function closeGallery() {}
  function setupComponentGallery() { refreshComponentVisibility(); }

  // Expose so chat-builder + other entry points can refresh after intent apply
  window.__ccsRefreshComponents = refreshComponentVisibility;

  // -----------------------------------------------------------------
  // Tab navigation for column 2 (Build / Components / Token Estimator).
  // The wizard is physically moved from Section 2 into the Estimator tab
  // so it gets its own dedicated space.
  // -----------------------------------------------------------------
  const TAB_STORAGE_KEY = 'ccs-active-tab';

  function switchTab(name) {
    // Apply aliases centrally so callers using legacy tab names
    // (build/components/simulator) still resolve to 'workspace'.
    if (TAB_ALIASES[name]) name = TAB_ALIASES[name];
    document.querySelectorAll('.tab-btn').forEach(b => {
      // Only toggle .active on legacy data-tab buttons. Wizard sidebar
      // items use data-wiz and own their own active state.
      if (b.dataset.wiz) return;
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('[data-tab-panel]').forEach(p => {
      p.classList.toggle('active', p.dataset.tabPanel === name);
    });
    try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch (_) {}
  }
  // Expose to the wizard dispatcher (defined in index.html bottom).
  window.__switchToTab = switchTab;

  // Tabs that exist after the layout redesign. Used to validate
  // the localStorage-restored tab so an old 'estimator' value
  // doesn't strand the user on a dead pane.
  // Workspace replaces Build, Components, and Simulator (one continuous
  // scroll: chat + deployment diagram + simulator + TCO sections). Old
  // saved values get aliased so returning users land on Workspace.
  const VALID_TABS = ['workspace', 'prices', 'benchmarks', 'report'];
  const TAB_ALIASES = { build: 'workspace', components: 'workspace', simulator: 'workspace' };

  function setupTabs() {
    // The Token Estimator tab is gone (replaced by the simulator Simulator).
    // Hide the legacy wizard if it's still in the DOM and route the
    // old CTA to the Simulator tab instead.
    const wizard = document.getElementById('token-wizard');
    if (wizard) wizard.style.display = 'none';
    const cta = document.getElementById('wizard-toggle');
    if (cta) {
      cta.innerHTML = '<strong>→ Open the Simulator tab</strong> <span style="color: var(--muted); font-weight: 400; font-size: 12px;">configure agent topology + simulate per-agent token usage</span>';
      cta.addEventListener('click', () => switchTab('simulator'));
    }

    document.querySelectorAll('.tab-btn').forEach(btn => {
      // Wizard sidebar buttons use data-wiz-* attrs instead of data-tab;
      // their dispatch is handled separately in the wizard handler at
      // the end of index.html. Skip them here so we don't switchTab to
      // undefined.
      if (btn.dataset.wiz) return;
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Restore last-used tab — fall back to 'workspace' if saved value
    // is a tab that no longer exists. Migrate aliases (build /
    // components / simulator → workspace) so users coming back after
    // the unification don't get stranded on a dead pane.
    const saved = (() => { try { return localStorage.getItem(TAB_STORAGE_KEY); } catch (_) { return null; } })();
    const target = TAB_ALIASES[saved] || saved;
    switchTab(VALID_TABS.includes(target) ? target : 'workspace');
  }

  // ---------------------------------------------------------------------
  // Workspace sub-nav — sticky scroll-spy. Visible when active tab is
  // 'workspace', hidden otherwise. Buttons jump to anchored sections
  // via smooth-scroll; IntersectionObserver tracks which section is
  // currently in view and highlights the matching button.
  // ---------------------------------------------------------------------
  function setupWorkspaceSubnav() {
    const subnav = document.getElementById('workspace-subnav');
    if (!subnav) return;
    const buttons = Array.from(subnav.querySelectorAll('button[data-anchor]'));

    // Show/hide based on current tab. switchTab() already toggles
    // .active on tab-panels; mirror that on the subnav.
    function syncVisibility() {
      const active = document.querySelector('.tab-btn.active')?.dataset.tab;
      subnav.classList.toggle('hidden', active !== 'workspace');
    }
    // Re-sync on every switchTab call.
    const origSwitch = window.__ccsSwitchTab;
    if (typeof origSwitch === 'function') {
      window.__ccsSwitchTab = function(name) {
        const r = origSwitch.apply(this, arguments);
        syncVisibility();
        return r;
      };
    }
    document.querySelectorAll('.tab-btn').forEach(btn =>
      btn.addEventListener('click', () => setTimeout(syncVisibility, 0)));
    syncVisibility();

    // Click → smooth-scroll to anchor. The main scroll container is
    // <main class="main">; scrollTo(target) inside it.
    const mainEl = document.getElementById('main');
    buttons.forEach(b => {
      b.addEventListener('click', () => {
        const target = document.getElementById(b.dataset.anchor);
        if (!target || !mainEl) return;
        const top = target.getBoundingClientRect().top
                  - mainEl.getBoundingClientRect().top
                  + mainEl.scrollTop
                  - subnav.offsetHeight - 8;
        mainEl.scrollTo({ top, behavior: 'smooth' });
      });
    });

    // IntersectionObserver — root is the main scroll container so
    // visibility is judged inside it, not the viewport.
    if (!mainEl || typeof IntersectionObserver !== 'function') return;
    const targets = buttons.map(b => document.getElementById(b.dataset.anchor)).filter(Boolean);
    const lookup = new Map();
    targets.forEach(t => lookup.set(t.id, subnav.querySelector(`button[data-anchor="${t.id}"]`)));
    let activeAnchor = null;
    const observer = new IntersectionObserver((entries) => {
      // Pick the entry highest in the viewport that's intersecting.
      const visible = entries
        .filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length === 0) return;
      const id = visible[0].target.id;
      if (id === activeAnchor) return;
      activeAnchor = id;
      buttons.forEach(b => b.classList.toggle('active', b.dataset.anchor === id));
    }, {
      root: mainEl,
      // Trigger when the section's top is in the upper third of the
      // scroll viewport (so the highlight matches what's visually "at
      // the top of attention").
      rootMargin: '0px 0px -66% 0px',
      threshold: 0,
    });
    targets.forEach(t => observer.observe(t));
  }
  setupWorkspaceSubnav();

  // ---------------------------------------------------------------------
  // Quick Start chat strip — auto-collapse after first interaction
  // anywhere downstream (a Components section opened, an simulator slider
  // moved, an arch-diagram box clicked). User can click the collapsed
  // bar to expand again. Choice persists in localStorage.
  // ---------------------------------------------------------------------
  function setupQuickStartCollapse() {
    const arch = document.getElementById('arch-header');
    if (!arch) return;
    const KEY = 'ccs-quickstart-collapsed';
    const saved = (() => { try { return localStorage.getItem(KEY); } catch (_) { return null; } })();
    if (saved === '1') arch.classList.add('collapsed');

    const toggle = (collapsed) => {
      arch.classList.toggle('collapsed', collapsed);
      try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (_) {}
    };
    arch.addEventListener('click', (e) => {
      // Only the ::before pseudo bar triggers expand. Real-element clicks
      // inside an expanded panel shouldn't toggle.
      if (!arch.classList.contains('collapsed')) return;
      // The pseudo-element click bubbles from the .arch-header itself,
      // not from a real child. If target === arch, we're on the bar.
      if (e.target === arch) toggle(false);
    });

    // Quick Start no longer auto-collapses on first downstream interaction.
    // Users can still collapse manually by clicking the bar after they've
    // toggled it shut once; the state persists via localStorage. The
    // auto-collapse listener was removed because it hid the chat-builder
    // before users discovered the auto-fill capability.
  }
  setupQuickStartCollapse();

  // Expose tab-switch for chat-builder hint button
  window.__ccsSwitchTab = switchTab;
  // Expose renderPreview for simulator-side editors (Audience etc.) to
  // trigger calc TCO refresh after edits.
  window.renderPreview = renderPreview;
  // Expose renderAgentsList so the simulator-side BYOK provider mirror
  // can refresh the procurement-side Hosting dropdown — keeps the two
  // editors in sync when a user flips BYOK in Section C.
  window.renderAgentsList = renderAgentsList;

  // Topbar cost badge — click to jump to Report tab.
  const costBadge = document.getElementById('cost-pill');
  if (costBadge) costBadge.addEventListener('click', () => switchTab('report'));

  // ---------------------------------------------------------------------
  // Appbar Share/Export dropdown — open on trigger click, close on
  // outside click / Escape / item click. The actual buttons inside
  // (Excel, Copy link, Import, Export JSON) keep their original IDs
  // so existing handlers in app.js bind to them unchanged.
  // ---------------------------------------------------------------------
  (function setupShareMenu() {
    const menu = document.getElementById('appbar-share-menu');
    const trigger = document.getElementById('appbar-share-trigger');
    if (!menu || !trigger) return;
    const open = () => {
      menu.dataset.open = '1';
      trigger.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      delete menu.dataset.open;
      trigger.setAttribute('aria-expanded', 'false');
    };
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.dataset.open ? close() : open();
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });
    // Auto-close after picking a menu item — let the original handler
    // run first (microtask), then collapse.
    menu.querySelectorAll('.appbar-menu-item').forEach(b =>
      b.addEventListener('click', () => setTimeout(close, 0))
    );
  })();

  // ---------------------------------------------------------------------
  // simulator Simulator integration — direct call from the inlined simulator
  // pane (no iframe). The "Send agents to Cost Calculator" button calls
  // window.__importFromSimulator(payload) directly.
  // ---------------------------------------------------------------------
  // payload.silent === true skips tab-switch and toast — used for the
  // continuous auto-sync from the simulator's onSlider(). The non-silent path
  // is reserved for explicit imports (e.g., from a future "Apply
  // template" button), but isn't currently used.
  //
  // renderPreview() is coalesced via rAF (see __schedulePreview) so
  // dragging a slider doesn't thrash the heavy preview render.
  let __previewScheduled = false;
  function __schedulePreview() {
    if (__previewScheduled) return;
    __previewScheduled = true;
    requestAnimationFrame(() => {
      __previewScheduled = false;
      if (typeof renderPreview === 'function') renderPreview();
    });
  }

  window.__importFromSimulator = function(payload) {
    if (!payload || !Array.isArray(payload.agents)) return;
    const silent = payload.silent === true;
    workload.agents = payload.agents.map(a => ({
      id: a.id || ('agent-' + Math.random().toString(36).slice(2, 8)),
      label: a.label || a.id || 'Agent',
      input_tokens: a.input_tokens || 0,
      output_tokens: a.output_tokens || 0,
      calls_per_query: a.calls_per_query || 1,
      model: a.model || null,
      cache_eligible: !!a.cache_eligible,
      hosting: a.hosting || 'api',
      description: a.description || '',
    }));
    if (silent) {
      // Auto-sync path: only re-render the cost preview (the topbar
      // pill, the Report). Skip the editor re-render — it can stomp
      // on whatever the user is currently editing in Components.
      __schedulePreview();
      return;
    }
    if (typeof renderEditor === 'function')   renderEditor();
    if (typeof renderPreview === 'function')  renderPreview();
    if (typeof renderArchDiagram === 'function') renderArchDiagram();
    if (typeof renderArchSummary === 'function') renderArchSummary();
    if (typeof window.__ccsRefreshComponents === 'function') window.__ccsRefreshComponents();
    switchTab('components');
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = `Imported ${workload.agents.length} agents from cost simulator`;
      toast.style.opacity = '1';
      setTimeout(() => { toast.style.opacity = '0'; }, 3000);
    }
  };


  function setupChatBuilder() {
    // Chat-builder + example dropdown removed for production. Procurement
    // users configure via the wizard sidebar (Project profile / Config /
    // Agent fleet / etc.) not via an LLM intent parser. The function is
    // kept as a no-op so the call site at boot stays valid.
    return;
  }

  // HTML-escape helper used inside chat transcript (user text may contain <>&)
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


  // -----------------------------------------------------------------
  // colorizeTrace — syntax-highlight the engine's derivation trace.
  //
  // The trace is plain text emitted by cost-engine.js + app-side
  // appendix. To make it scannable on screen (was pure b&w monospace)
  // we wrap recognizable tokens in <span class="t-*"> + style via CSS.
  //
  // Tokens recognized:
  //   ===  banner  ===            → header band (orange-ish)
  //   ─────────────                → divider line (muted)
  //   1) SECTION HEADING           → section label (blue, bold)
  //   Formula:/Baseline:/Mode:/…   → meta lines (italic gray)
  //   TOTAL: …                     → totals (purple, bold)
  //   $1,234 / $1.2M / $5.6B       → money (green)
  //   45% / 0.15%                  → percentages (orange)
  //   1,234 / 12,345               → integers with comma sep (cyan)
  //
  // Returns escaped HTML (drop directly into innerHTML).
  // -----------------------------------------------------------------
  function colorizeTrace(text) {
    const esc = (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const lines = String(text || '').split('\n');
    return lines.map(line => {
      // Line-level decoration first: pick the dominant style for the line.
      if (/^={3,}.+={3,}\s*$/.test(line)) {
        return `<span class="t-banner">${esc(line)}</span>`;
      }
      if (/^─{6,}\s*$/.test(line)) {
        return `<span class="t-rule">${esc(line)}</span>`;
      }
      if (/^[A-D0-9]+(?:\.\d+)?\)\s+[A-Z]/.test(line)) {
        return `<span class="t-section">${esc(line)}</span>`;
      }
      // Token-level highlighting for normal lines.
      let h = esc(line);
      // Meta-prefix lines (Formula:, Baseline:, Bot factor:, Mode:, Deployment:, Generated:)
      h = h.replace(/^(Formula|Baseline|Mode|Generated|Deployment|Bot factor|Tier multiplier|Hosting multiplier|Pre-multiplier monthly|Post-multiplier monthly|Coverage|Variant|NLI hosting|Atomizer|Reviser|NLI|Retrieval infra|PII redaction|TOTAL agent engineering|Retry rate|Inflate factor|API bill before retry|API bill after retry)(\s*:)/,
        '<span class="t-meta">$1$2</span>');
      // TOTAL or = lines (rolling totals)
      h = h.replace(/(^|\s)(TOTAL[^:]*:|=)/g, '$1<span class="t-total">$2</span>');
      // Money — must come BEFORE plain-number rule so $1,234 doesn't
      // get caught as a number.
      h = h.replace(/\$\d+(?:[,\d]+)?(?:\.\d+)?(?:[BMK])?/g, '<span class="t-money">$&</span>');
      // Percentages
      h = h.replace(/(?:^|\s|\()(\d+(?:\.\d+)?\s*%)/g, (m, p) => m.replace(p, `<span class="t-pct">${p}</span>`));
      // Big comma-separated integers (queries/tokens)
      h = h.replace(/\b\d{1,3}(?:,\d{3})+\b/g, '<span class="t-num">$&</span>');
      return h;
    }).join('\n');
  }
})();
