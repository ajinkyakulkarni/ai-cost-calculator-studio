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
  // Expose workload + renderPreview to the AXIOM-side script so the
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
          renderPreview();
          renderRawJson();
        });
      }
    });

    renderShapesList();
    renderMixesList();
    renderSegmentsList();
    renderAgentsList();
    renderGpuList();
    renderInfraList();
    renderRateCardList();
    renderPersonnelList();
    renderMigrationList();
    populateModelDropdowns();
    populateMixDropdowns();
    populateGpuDropdown();
    renderRawJson();
  }

  function renderShapesList() {
    const list = document.getElementById('shapes-list');
    list.innerHTML = '';
    for (const [name, shape] of Object.entries(workload.shapes)) {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <button class="item-remove" data-shape-remove="${name}">remove</button>
        <div class="item-title">${name}</div>
        <div class="row grid-3">
          <div><label>Input factor</label><input type="number" step="0.01" value="${shape.input_factor}" data-shape="${name}" data-key="input_factor"></div>
          <div><label>Output factor</label><input type="number" step="0.01" value="${shape.output_factor}" data-shape="${name}" data-key="output_factor"></div>
          <div><label>Cache eligible</label><select data-shape="${name}" data-key="cache_eligible"><option value="true"${shape.cache_eligible?' selected':''}>yes</option><option value="false"${!shape.cache_eligible?' selected':''}>no</option></select></div>
        </div>
        <div class="row"><label>Description</label><input type="text" value="${shape.description || ''}" data-shape="${name}" data-key="description"></div>
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
      const weightsHtml = Object.keys(workload.shapes).map(shape => `
        <div>
          <label>${shape}</label>
          <input type="number" step="0.01" min="0" max="1" value="${mix.weights[shape] != null ? mix.weights[shape] : 0}" data-mix="${name}" data-shape="${shape}">
        </div>
      `).join('');
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <button class="item-remove" data-mix-remove="${name}">remove</button>
        <div class="item-title">${name}</div>
        <div class="row"><label>Label</label><input type="text" value="${mix.label || ''}" data-mix-label="${name}"></div>
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

  function renderSegmentsList() {
    const list = document.getElementById('segments-list');
    list.innerHTML = '';
    workload.segments.forEach((seg, idx) => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <button class="item-remove" data-seg-remove="${idx}">remove</button>
        <div class="item-title">${seg.id}</div>
        <div class="row grid-2">
          <div><label>ID</label><input type="text" value="${seg.id}" data-seg="${idx}" data-key="id"></div>
          <div><label>Label</label><input type="text" value="${seg.label || ''}" data-seg="${idx}" data-key="label"></div>
        </div>
        <div class="row grid-3">
          <div><label>MAU</label><input type="number" value="${seg.mau}" data-seg="${idx}" data-key="mau"></div>
          <div><label>Sessions / day</label><input type="number" step="0.1" value="${seg.sessions_per_day}" data-seg="${idx}" data-key="sessions_per_day"></div>
          <div><label>Q / session</label><input type="number" value="${seg.questions_per_session}" data-seg="${idx}" data-key="questions_per_session"></div>
        </div>
        <div class="row checkbox">
          <input type="checkbox" id="bot-${idx}" ${seg.applyBotFactor ? 'checked' : ''} data-seg="${idx}" data-key="applyBotFactor">
          <label for="bot-${idx}">Apply bot factor (typically anonymous segments)</label>
        </div>
      `;
      list.appendChild(div);
    });
    list.querySelectorAll('[data-seg]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = parseInt(el.dataset.seg, 10);
        const key = el.dataset.key;
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'number') v = parseFloat(el.value) || 0;
        else v = el.value;
        workload.segments[idx][key] = v;
        renderPreview();
        renderRawJson();
      });
    });
    list.querySelectorAll('[data-seg-remove]').forEach(b => {
      b.addEventListener('click', (e) => {
        workload.segments.splice(parseInt(e.target.dataset.segRemove, 10), 1);
        renderEditor();
        renderPreview();
      });
    });
  }

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
      el.addEventListener('input', () => {
        const idx = parseInt(el.dataset.agent, 10);
        const key = el.dataset.key;
        let v;
        if (el.tagName === 'SELECT' && (el.value === 'true' || el.value === 'false')) v = el.value === 'true';
        else if (el.value === '') v = key === 'model' ? null : 0;
        else if (el.type === 'number') v = parseFloat(el.value) || 0;
        else v = el.value;
        workload.agents[idx][key] = v;
        // Hosting changes need a full re-render to update the hint text;
        // other fields just refresh the preview.
        if (key === 'hosting') renderAgentsList();
        renderPreview();
        renderRawJson();
      });
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
      div.innerHTML = `
        <button class="item-remove" data-gpu-remove="${id}">remove</button>
        <div class="item-title">
          ${isActive ? '<span class="rc-dot" title="Active"></span>' : ''}
          ${id} <span style="color: var(--muted); font-weight: 400;">· ${gpu.name || ''}</span>
        </div>
        <div class="row grid-3">
          <div><label>$ / hour</label><input type="number" step="0.01" value="${gpu.hourly}" data-gpu="${id}" data-key="hourly"></div>
          <div><label>Throughput tok/s</label><input type="number" value="${gpu.tput_tps}" data-gpu="${id}" data-key="tput_tps"></div>
          <div><label>Capable</label><input type="text" value="${gpu.capable || ''}" data-gpu="${id}" data-key="capable"></div>
        </div>
        <div class="row"><label>Hardware label</label><input type="text" value="${gpu.name || ''}" data-gpu="${id}" data-key="name"></div>
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
      div.innerHTML = `
        <button class="item-remove" data-infra-remove="${encodeURIComponent(name)}">remove</button>
        <div class="row grid-2">
          <div><label>Line item</label><input type="text" value="${name.replace(/"/g, '&quot;')}" data-infra-name="${encodeURIComponent(name)}"></div>
          <div><label>${scalingActive ? 'Computed monthly $' : 'Monthly $'} <span class="tip" data-tip="Flat = fixed $/mo. Toggle scaling to compute as a rate × your monthly query volume (S3, CloudWatch, NAT egress, etc.).">ⓘ</span></label>
            <input type="number" step="1" value="${displayCost}" data-infra-cost="${encodeURIComponent(name)}" ${scalingActive ? 'disabled style="background:#f0e8d8; color:var(--muted);"' : ''}>
          </div>
        </div>
        <div class="row" style="margin-top: 4px;">
          <label style="font-size: 11px; color: var(--muted);">Scaling
            <select data-infra-scaling="${encodeURIComponent(name)}" style="font-family: var(--mono); font-size: 11px; padding: 2px 6px; margin-left: 4px;">
              <option value="flat" ${per === 'flat' ? 'selected' : ''}>Flat $/mo</option>
              <option value="per_query" ${per === 'per_query' ? 'selected' : ''}>$ per query</option>
              <option value="per_1k_queries" ${per === 'per_1k_queries' ? 'selected' : ''}>$ per 1K queries</option>
              <option value="per_million_queries" ${per === 'per_million_queries' ? 'selected' : ''}>$ per 1M queries</option>
              <option value="per_gb_per_query" ${per === 'per_gb_per_query' ? 'selected' : ''}>$/GB × queries × GB/q</option>
            </select>
          </label>
          ${scalingActive ? `
            <span style="margin-left: 8px;"><label style="font-size: 11px;">Rate $</label>
              <input type="number" step="0.0001" value="${rate}" data-infra-rate="${encodeURIComponent(name)}" style="width: 90px; font-family: var(--mono); font-size: 11px;">
            </span>
            ${per === 'per_gb_per_query' ? `
              <span style="margin-left: 8px;"><label style="font-size: 11px;">GB/q</label>
                <input type="number" step="0.0001" value="${gb}" data-infra-gb="${encodeURIComponent(name)}" style="width: 90px; font-family: var(--mono); font-size: 11px;">
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
      div.innerHTML = `
        <button class="item-remove" data-personnel-remove="${idx}">remove</button>
        <div class="row grid-3">
          <div><label>Role</label>
            <select data-personnel-role="${idx}">
              ${roleKeys.map(k => `<option value="${k}"${k === r.role ? ' selected' : ''}>${k}</option>`).join('')}
            </select>
          </div>
          <div><label>FTE allocation</label><input type="number" step="0.05" min="0" max="2" value="${r.fte}" data-personnel-fte="${idx}"></div>
          <div><label>Monthly $</label><input type="text" value="${monthly.toFixed(0)}" disabled style="background:#f0e8d8; color:var(--muted);"></div>
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

  function renderMigrationList() {
    const list = document.getElementById('migration-list');
    if (!list) return;
    list.innerHTML = '';
    if (!workload.migration) workload.migration = { enabled: false, phases: [] };
    if (!Array.isArray(workload.migration.phases)) workload.migration.phases = [];
    workload.migration.phases.forEach((p, idx) => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <button class="item-remove" data-mig-remove="${idx}">remove</button>
        <div class="row grid-2">
          <div><label>Label</label><input type="text" value="${(p.label || '').replace(/"/g, '&quot;')}" data-mig-field="label" data-mig-idx="${idx}"></div>
          <div><label>Months</label><input type="number" min="1" step="1" value="${p.months || 12}" data-mig-field="months" data-mig-idx="${idx}"></div>
        </div>
        <div class="row grid-2">
          <div>
            <label>Hosting</label>
            <select data-mig-field="hosting" data-mig-idx="${idx}">
              <option value="api"${p.hosting === 'api' ? ' selected' : ''}>API (managed)</option>
              <option value="self"${p.hosting === 'self' ? ' selected' : ''}>Self-host on EC2</option>
              <option value="hybrid"${p.hosting === 'hybrid' ? ' selected' : ''}>Hybrid (split)</option>
            </select>
          </div>
          <div>
            <label>API reservation</label>
            <select data-mig-field="reservation_type" data-mig-idx="${idx}">
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
      rows += `<tr class="${isActive ? 'active' : ''}" title="${isActive ? 'Currently selected in Scenario controls' : ''}">
        <td class="rc-name">
          ${isActive ? '<span class="rc-dot" title="Active"></span>' : ''}
          <strong>${id}</strong>
          <span class="rc-provider">${card.provider || 'custom'}</span>
          ${overridden ? '<span class="rc-badge">edited</span>' : ''}
        </td>
        <td><input type="number" step="0.01" min="0" value="${card.input_per_million}" data-card="${id}" data-key="input_per_million"></td>
        <td><input type="number" step="0.001" min="0" value="${card.cached_per_million}" data-card="${id}" data-key="cached_per_million"></td>
        <td><input type="number" step="0.01" min="0" value="${card.output_per_million}" data-card="${id}" data-key="output_per_million"></td>
        <td class="rc-action">${overridden ? `<button class="rc-reset" data-card-remove="${id}" title="Reset to default">↺</button>` : ''}</td>
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

  // -----------------------------------------------------------------
  // Live preview (right pane)
  // -----------------------------------------------------------------
  function renderPreview() {
    document.getElementById('prev-agency').textContent = workload.deployment.agency || '—';
    document.getElementById('prev-name').textContent = workload.deployment.name || '—';
    document.getElementById('prev-desc').textContent = workload.deployment.description || '—';
    const headlineLabel = document.getElementById('prev-headline-label');
    if (headlineLabel) {
      const agency = workload.deployment.agency || 'Total';
      headlineLabel.textContent = `Total monthly cost · ${agency}`;
    }

    const $ = id => document.getElementById(id);
    const val = (id, fallback) => { const el = $(id); return el ? el.value : fallback; };
    const numVal = (id, fallback) => { const el = $(id); return el ? parseFloat(el.value) : fallback; };

    const opts = {
      hosting: val('prev-hosting', workload.defaults.hosting),
      model: val('prev-model', workload.defaults.model),
      tier: val('prev-tier', workload.defaults.tier),
      mix: val('prev-mix', workload.defaults.mix),
      costMode: val('prev-cost-mode', workload.defaults.cost_mode),
      botFactor: numVal('prev-bot', 1.5),
      cacheRate: numVal('prev-cache', workload.anchor_query.cache_rate_baseline),
      verifCoverage: numVal('prev-verif', 0),
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
    const apiBill = result.api.monthly_capped;
    const totalMau = workload.segments.reduce((a, s) => a + (s.mau || 0), 0);
    const fixedCosts = (result.fixed_costs && result.fixed_costs.total) || 0;
    const infraTotal = (result.fixed_costs && result.fixed_costs.infrastructure) || 0;
    const rateLimitCost = (result.fixed_costs && result.fixed_costs.rate_limit) || 0;
    const verifMonthly = result.verification.monthly || 0;
    const federalAdditive = (result.federal && result.federal.additive_total) || 0;
    const hostingPremium = (result.federal && result.federal.hosting_premium_api) || 0;
    const reservation = result.reservation || { enabled: false };
    const embeddingMonthly = (result.embedding && result.embedding.enabled) ? (result.embedding.monthly || 0) : 0;
    const personnelMonthly = (result.personnel && result.personnel.enabled) ? (result.personnel.monthly || 0) : 0;
    // LLM headline takes reservation discount/PTU into account when on API
    let llmHeadline;
    if (opts.hosting === 'hybrid' && result.hybrid) llmHeadline = result.hybrid.total;
    else if (opts.hosting === 'self') llmHeadline = result.self_host.total;
    else if (reservation.enabled) llmHeadline = reservation.effective_monthly;
    else llmHeadline = apiBill;
    const headlineTotal = llmHeadline + fixedCosts + verifMonthly + federalAdditive + embeddingMonthly + personnelMonthly;

    // 3-year TCO: monthly LLM/fixed/federal × 36 + (one-time setup × 1, NOT × 36).
    // For self-host, setup_amortized is already a monthly number (annual setup ÷ 12).
    // Real 3-yr TCO multiplies the monthly recurring by 36, but adds setup ONCE (already amortized into the 12-month view).
    // For consistency we use: 3yr = monthlyTotal × 36.
    const annualTotal = headlineTotal * 12;
    const threeYearTotal = headlineTotal * 36;
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
    const llmLabel = opts.hosting === 'self' ? 'Self-host' : (opts.hosting === 'hybrid' ? 'Hybrid' : 'API LLM');
    totalEl.title =
      `${tcoLabel} = headline monthly × ${tcoPeriod === 'annual' ? '12' : tcoPeriod === '3yr' ? '36' : '1'}\n` +
      `Headline monthly = ${llmLabel} ${fmt$(llmHeadline)}` +
      (verifMonthly > 0 ? ` + verification ${fmt$(verifMonthly)}` : '') +
      (embeddingMonthly > 0 ? ` + embeddings ${fmt$(embeddingMonthly)}` : '') +
      (personnelMonthly > 0 ? ` + personnel ${fmt$(personnelMonthly)}` : '') +
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
        riskRange.textContent = 'click ON to compute';
      }
    }
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

    const star = (cond) => cond ? ' style="background:#f3ecdb;"' : '';
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
      rows += `<tr style="background:#f3ecdb;">
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
      const roleSummary = p.breakdown.map(b => `${b.role.replace(/_/g, ' ')} ${b.fte}`).join(', ');
      rows += `<tr>
        <td>Personnel <em style="color: var(--muted); font-style: normal;">(${escapeHtml(roleSummary)})</em></td>
        <td class="num">${fmt$(personnelMonthly)}</td>
        <td>${p.breakdown.length} role${p.breakdown.length === 1 ? '' : 's'}, FTE-allocated</td>
      </tr>`;
    }
    if (shc) {
      rows += `<tr>
        <td>Self-host <em style="color: var(--muted); font-style: normal;">(capped to same $${workload.daily_cap.amount_usd}/day)</em></td>
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
      const tags = [];
      if (f.fedramp_tier && f.fedramp_tier !== 'none') tags.push(`FedRAMP ${f.fedramp_tier}`);
      if (f.multi_region && f.multi_region !== 'single') tags.push(f.multi_region);
      const tagStr = tags.length > 0 ? `${tags.join(' + ')} · ×${(f.hosting_multiplier || 1).toFixed(2)}` : `×${(f.hosting_multiplier || 1).toFixed(2)}`;
      rows += `<tr>
        <td><em style="color: var(--muted); font-style: normal;">↳ Hosting premium (${tagStr})</em></td>
        <td class="num">${fmt$(hostingPremium)}</td>
        <td>included in API row above</td>
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
      note = `<strong>At equal budget</strong> — ${fmt$(workload.daily_cap.amount_usd)}/day cap buys <strong>${fmtN(apiServed)}</strong> served queries on API vs <strong>${fmtN(shcServed)}</strong> on self-host: ${verdict}. The supposed cost advantage of self-host evaporates at equal budget; the procurement decision pivots to quality, operational burden, and vendor risk.`;
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
      const llmCost = opts.hosting === 'self' ? sh.total : apiCapped;
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
        const segments = components.map(c => {
          const pct = (c.value / total) * 100;
          return `<div class="seg" style="background:${c.color}; width:${pct}%;" title="${c.label}: ${fmt$(c.value)}">${pct >= 8 ? Math.round(pct)+'%' : ''}</div>`;
        }).join('');
        const legend = components.map(c => `
          <div class="legend-item">
            <span class="swatch" style="background:${c.color};"></span>
            <span class="legend-label">${c.label}</span>
            <span class="legend-val">${fmt$(c.value)} · ${Math.round(c.value/total*100)}%</span>
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
        let agentRows = monthlyByAgent.map(a => `<tr>
          <td>${a.label}</td>
          <td><span style="font-family:var(--mono); color:var(--muted); font-size:11px;">${a.model}</span></td>
          <td class="num">${a.calls}</td>
          <td class="num">${a.input.toLocaleString()} / ${a.output.toLocaleString()}</td>
          <td class="num">$${a.per_call_cost.toFixed(4)}</td>
          <td class="num">${fmt$(a.monthly)}</td>
          <td class="num">${totalMonthly > 0 ? Math.round(a.monthly/totalMonthly*100) : 0}%</td>
        </tr>`).join('');
        agentRows += `<tr style="background:#f3ecdb; font-weight:600;">
          <td>Total per query</td><td>—</td><td>—</td><td>—</td>
          <td class="num">$${(totalMonthly/totalQueries).toFixed(4)}</td>
          <td class="num">${fmt$(totalMonthly)}</td><td class="num">100%</td>
        </tr>`;
        agentTable.innerHTML = `<thead><tr>
          <th>Agent</th><th>Model</th>
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
        trows += `<tr style="background:#f3ecdb; font-weight:600;">
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
            <tr style="background: #f3ecdb; font-weight: 600;"><td>Total</td><td class="num">${fmt$(v.monthly)}</td><td>${fmtN(v.verified_queries)} verified queries</td></tr>
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
            <svg width="100%" viewBox="0 0 ${W} ${H}" style="display:block;">
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
            <tr style="background: #f3ecdb; font-weight: 600;"><td>Total self-host</td><td class="num">${fmt$(sh.total)}</td><td>$/query: ${sh.effective_per_query.toFixed(4)}</td></tr>
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
        infraTable.innerHTML = `<tbody><tr><td style="color: var(--muted);">No infrastructure line items configured. Add them in section 10.</td></tr></tbody>`;
      } else {
        let infraRows = items.map(([n, c]) => `<tr><td>${n}</td><td class="num">${fmt$(c)}</td></tr>`).join('');
        infraRows += `<tr style="background: #f3ecdb; font-weight: 600;"><td>Total infrastructure</td><td class="num">${fmt$(infraTotal)}</td></tr>`;
        infraTable.innerHTML = `<thead><tr><th>Line item</th><th style="text-align:right;">Monthly</th></tr></thead><tbody>${infraRows}</tbody>`;
      }
    }

    // Math walkthrough — show the engine's full deriveTrace() output as
    // a copy-pasteable monospace block, ready to drop into any AI for
    // independent verification of every formula and intermediate value.
    const mathEl = document.getElementById('prev-math');
    if (mathEl) {
      const trace = result.derivation || '(no derivation available)';
      mathEl.innerHTML = `
        <div class="math-trace-toolbar">
          <button class="math-copy-btn" id="math-copy-btn">📋 Copy entire derivation</button>
          <span class="math-trace-hint">Paste into any AI (ChatGPT, Claude, Gemini) and ask "verify this math". Every formula and intermediate value is shown.</span>
        </div>
        <pre class="math-trace" id="math-trace-pre">${escapeHtml(trace)}</pre>
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
  }

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
    document.getElementById('segments-add').addEventListener('click', () => {
      const id = prompt('New segment id (e.g., auth, public)?');
      if (!id) return;
      workload.segments.push({ id, label: id, mau: 1000, sessions_per_day: 0.2, questions_per_session: 5, applyBotFactor: false });
      renderEditor(); renderPreview();
    });
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
      const name = prompt('Infrastructure line item name (e.g., NAT Gateway)?');
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
    document.getElementById('ratecard-add').addEventListener('click', () => {
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
          // Show GPU/replicas row when self-host OR hybrid (both need GPU sizing)
          const showSelfHost = el.value === 'self' || el.value === 'hybrid';
          document.getElementById('prev-selfhost-row').style.display = showSelfHost ? 'flex' : 'none';
          // Show split slider only in hybrid mode
          document.getElementById('prev-hybrid-row').style.display = el.value === 'hybrid' ? 'flex' : 'none';
        }
        if (id === 'prev-model') renderRateCardList();
        if (id === 'prev-gpu') renderGpuList();
        renderPreview();
      });
    });
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

    // Example loader
    document.getElementById('example-loader').addEventListener('change', async (e) => {
      const slug = e.target.value;
      if (!slug) return;
      try {
        const resp = await fetch(`examples/${slug}.json`);
        if (!resp.ok) throw new Error('Could not load example');
        const data = await resp.json();
        workload = ensureFields(data); window.workload = workload;
        renderEditor();
        renderPreview();
      } catch (err) {
        alert('Example load failed: ' + err.message);
      }
    });

    // Import / export
    document.getElementById('export-btn').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(workload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const slug = (workload.deployment.name || 'workload').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      a.download = `${slug}.json`;
      a.click();
    });
    document.getElementById('import-btn').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json';
      inp.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          try {
            workload = ensureFields(JSON.parse(ev.target.result)); window.workload = workload;
            renderEditor();
            renderPreview();
          } catch (err) { alert('Invalid JSON: ' + err.message); }
        };
        reader.readAsText(file);
      };
      inp.click();
    });

    // Build section navigator + wire up search
    buildSectionNav();

    // Apply raw JSON edit
    document.getElementById('apply-json').addEventListener('click', () => {
      try {
        workload = ensureFields(JSON.parse(document.getElementById('raw-json').value)); window.workload = workload;
        renderEditor();
        renderPreview();
      } catch (err) { alert('Invalid JSON: ' + err.message); }
    });

    // Generate calculator HTML — defers to a generator module loaded
    // separately. For now, we trigger a download with the workload
    // embedded plus a notice.
    // Share link — copies a self-contained URL with the workload encoded in the hash.
    document.getElementById('share-btn').addEventListener('click', () => {
      try {
        const json = JSON.stringify(workload);
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
        sections.forEach(s => {
          if (s.id !== 'sec-scenario') s.classList.remove('open');
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
  // -----------------------------------------------------------------
  function loadFromHash() {
    try {
      const m = location.hash.match(/w=([^&]+)/);
      if (!m) return false;
      const json = decodeURIComponent(atob(m[1]));
      const parsed = JSON.parse(json);
      if (parsed && parsed.deployment && parsed.shapes) {
        workload = ensureFields(parsed); window.workload = workload;
        return true;
      }
    } catch (_) {}
    return false;
  }

  // Auto-update URL hash on every change so refreshing preserves state
  let hashUpdateTimer = null;
  function scheduleHashUpdate() {
    if (hashUpdateTimer) clearTimeout(hashUpdateTimer);
    hashUpdateTimer = setTimeout(() => {
      try {
        const json = JSON.stringify(workload);
        const hash = btoa(encodeURIComponent(json));
        history.replaceState(null, '', '#w=' + hash);
      } catch (_) {}
    }, 500);
  }

  // Wrap renderPreview to also schedule hash update
  const _origRenderPreview = renderPreview;
  renderPreview = function () {
    _origRenderPreview();
    scheduleHashUpdate();
  };

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
    };
    const r = CostEngine.compute(workload, opts);

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
      ['Cite as: Kulkarni, A. (2026). Cost Modeling for Federal AI-Agent'],
      ['Deployment: A Worked Example with NASA Earth Information Explorer.'],
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
        'API · ' + opts.model + ' (capped at $' + (workload.daily_cap?.amount_usd || 0) + '/day)',
        Math.round(apiCapped),
        Math.round(totalQ - refused),
        Math.round(refused),
        refused > 0 ? 'Cap clips ' + Math.round(100 * refused / totalQ) + '% of traffic' : 'all queries served',
      ],
      [
        'API · ' + opts.model + ' (uncapped, fair peer to self-host full)',
        Math.round(apiGross),
        Math.round(totalQ),
        0,
        'serves all queries',
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
    output.push([]);
    output.push(['Headline (LLM only)', Math.round(apiCapped)]);
    output.push(['Headline + infrastructure', Math.round(apiCapped + Object.values(workload.infrastructure || {}).reduce((a, b) => a + b, 0))]);
    output.push(['Annual', Math.round((apiCapped + Object.values(workload.infrastructure || {}).reduce((a, b) => a + b, 0)) * 12)]);

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

    // Priority: URL hash > NASA EIE default
    if (!loadFromHash()) {
      try {
        const resp = await fetch('examples/nasa-eie.json');
        if (resp.ok) { workload = ensureFields(await resp.json()); window.workload = workload; }
      } catch (_) { /* fall back to blank */ }
    } else {
      // hash-loaded; ensureFields was already called inside loadFromHash
    }
    if (!workload.self_host) { workload = ensureFields(workload); window.workload = workload; }
    renderEditor();
    renderPreview();
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
  }

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
  const ALWAYS_ON_SECTIONS = ['sec-scenario', 'sec-deployment', 'sec-anchor', 'sec-segments'];

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
    {
      id: 'sec-verification',
      name: 'Fact-checking pipeline',
      description: 'Sample answers through a FactReasoner-style verifier to catch hallucinations.',
      icon: '✅',
      category: 'Quality',
      autoActive: (w) => w.verification && w.verification.enabled,
      activate: (w) => {
        if (!w.verification) w.verification = {};
        w.verification.enabled = true;
        if (!(w.verification.coverage > 0)) w.verification.coverage = 0.10;
      },
      deactivate: (w) => { if (w.verification) w.verification.enabled = false; },
    },
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

  // Show/hide sections + add ×/+ affordances
  function refreshComponentVisibility() {
    for (const c of OPTIONAL_COMPONENTS) {
      const el = document.getElementById(c.id);
      if (!el) continue;
      const active = isComponentActive(c.id);
      el.style.display = active ? '' : 'none';
      // Inject × button into header (idempotent)
      ensureRemoveButton(el, c);
    }
    // Also rebuild gallery so newly active items disappear from it
    renderGallery();
  }

  function ensureRemoveButton(sectionEl, component) {
    const h2 = sectionEl.querySelector('h2');
    if (!h2 || h2.querySelector('.sec-remove')) return;
    const btn = document.createElement('button');
    btn.className = 'sec-remove';
    btn.innerHTML = '×';
    btn.title = 'Remove this component (data preserved — re-add anytime)';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deactivateComponent(component.id);
    });
    h2.appendChild(btn);
  }

  function renderGallery() {
    const grid = document.getElementById('gallery-grid');
    const empty = document.getElementById('gallery-empty');
    const cats = document.getElementById('gallery-categories');
    if (!grid) return;

    const search = (document.getElementById('gallery-search')?.value || '').toLowerCase();
    const activeCat = document.querySelector('.gallery-cat-btn.active')?.dataset.cat || 'all';

    // Build category buttons (idempotent — once)
    if (cats && cats.children.length === 0) {
      const allCats = ['all', ...new Set(OPTIONAL_COMPONENTS.map(c => c.category))];
      allCats.forEach(cat => {
        const b = document.createElement('button');
        b.className = 'gallery-cat-btn' + (cat === 'all' ? ' active' : '');
        b.dataset.cat = cat;
        b.textContent = cat === 'all' ? 'All' : cat;
        b.addEventListener('click', () => {
          document.querySelectorAll('.gallery-cat-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          renderGallery();
        });
        cats.appendChild(b);
      });
    }

    // Filter: only inactive components that match search + category
    const inactive = OPTIONAL_COMPONENTS.filter(c => !isComponentActive(c.id));
    const filtered = inactive.filter(c => {
      if (activeCat !== 'all' && c.category !== activeCat) return false;
      if (search) {
        const blob = (c.name + ' ' + c.description + ' ' + c.category).toLowerCase();
        if (!blob.includes(search)) return false;
      }
      return true;
    });

    grid.innerHTML = filtered.map(c => `
      <div class="gallery-card" data-add="${c.id}">
        <div class="gc-head">
          <span class="gc-icon">${c.icon}</span>
          <span class="gc-name">${c.name}</span>
          <span class="gc-add">+ Add</span>
        </div>
        <div class="gc-desc">${c.description}</div>
        <div class="gc-cat">${c.category}</div>
      </div>
    `).join('');

    grid.querySelectorAll('[data-add]').forEach(card => {
      card.addEventListener('click', () => {
        activateComponent(card.dataset.add);
        closeGallery();
      });
    });

    if (empty) empty.style.display = filtered.length === 0 ? '' : 'none';
  }

  function openGallery() {
    const overlay = document.getElementById('gallery-overlay');
    if (!overlay) return;
    overlay.style.display = '';
    renderGallery();
    setTimeout(() => document.getElementById('gallery-search')?.focus(), 50);
  }
  function closeGallery() {
    const overlay = document.getElementById('gallery-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function setupComponentGallery() {
    loadUserActivatedSet();

    // Wire the + Add a component button
    const addBtn = document.getElementById('add-component-btn');
    if (addBtn) addBtn.addEventListener('click', openGallery);

    // Close affordances
    document.getElementById('gallery-close')?.addEventListener('click', closeGallery);
    document.getElementById('gallery-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'gallery-overlay') closeGallery();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('gallery-overlay')?.style.display !== 'none') {
        closeGallery();
      }
    });
    document.getElementById('gallery-search')?.addEventListener('input', renderGallery);

    refreshComponentVisibility();
  }

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
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('[data-tab-panel]').forEach(p => {
      p.classList.toggle('active', p.dataset.tabPanel === name);
    });
    try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch (_) {}
  }

  // Tabs that exist after the layout redesign. Used to validate
  // the localStorage-restored tab so an old 'estimator' value
  // doesn't strand the user on a dead pane.
  // Workspace replaces Build, Components, and Simulator (one continuous
  // scroll: chat + deployment diagram + AXIOM + TCO sections). Old
  // saved values get aliased so returning users land on Workspace.
  const VALID_TABS = ['workspace', 'prices', 'benchmarks', 'report'];
  const TAB_ALIASES = { build: 'workspace', components: 'workspace', simulator: 'workspace' };

  function setupTabs() {
    // The Token Estimator tab is gone (replaced by the AXIOM Simulator).
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
  // anywhere downstream (a Components section opened, an AXIOM slider
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

    // Auto-collapse: any interaction downstream of the chat folds it.
    // Listen on the main scroll container so we don't bind handlers
    // to every slider individually.
    const main = document.getElementById('main');
    if (!main) return;
    let firstInteractionFired = false;
    const onInteract = () => {
      if (firstInteractionFired) return;
      // Don't collapse on clicks/inputs inside the arch-header itself —
      // user is mid-typing into the chat.
      // (This handler is debounced via firstInteractionFired so the
      // first downstream interaction wins.)
      firstInteractionFired = true;
      // Only auto-collapse if the strip is open AND we haven't
      // explicitly forced a state.
      if (!arch.classList.contains('collapsed')) toggle(true);
    };
    // Section header clicks, slider input, AXIOM canvas — anything
    // below arch-header counts.
    main.addEventListener('click', (e) => {
      if (arch.contains(e.target)) return;
      onInteract();
    }, { capture: true });
    main.addEventListener('input', (e) => {
      if (arch.contains(e.target)) return;
      onInteract();
    }, { capture: true });
  }
  setupQuickStartCollapse();

  // Expose tab-switch for chat-builder hint button
  window.__ccsSwitchTab = switchTab;
  // Expose renderPreview for AXIOM-side editors (Audience etc.) to
  // trigger calc TCO refresh after edits.
  window.renderPreview = renderPreview;

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
  // AXIOM Simulator integration — direct call from the inlined AXIOM
  // pane (no iframe). The "Send agents to Cost Calculator" button calls
  // window.__importFromSimulator(payload) directly.
  // ---------------------------------------------------------------------
  // payload.silent === true skips tab-switch and toast — used for the
  // continuous auto-sync from AXIOM's onSlider(). The non-silent path
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
      toast.textContent = `Imported ${workload.agents.length} agents from AXIOM simulator`;
      toast.style.opacity = '1';
      setTimeout(() => { toast.style.opacity = '0'; }, 3000);
    }
  };

  // -----------------------------------------------------------------
  // Chat-driven system builder
  //
  // User describes their AI system in plain English; the agent extracts
  // a structured intent (use case, audience, federal posture, agent
  // topology, sizing) and pre-populates the wizard answers, the
  // architecture diagram, and the federal compliance section.
  //
  // AI-only mode: requires an OpenAI API key (BYOK, stored in
  // localStorage). One-shot extraction — the response includes an
  // execution log of what was applied and suggestions for refinement.
  // No multi-turn loop; the user iterates by editing the description.
  // -----------------------------------------------------------------

  // Curated example prompts covering diverse domains and architectures.
  const CHAT_EXAMPLES = [
    {
      label: 'Federal · NASA Earth science Q&A (LangGraph state machine + RAG + statistics tool)',
      prompt: "Public-facing Earth observation Q&A. Typical queries: 'How did NO2 over NYC change Oct–Dec 2021?', 'Compare Arctic sea ice extent 2010 vs 2024', 'Show MODIS land surface temp anomalies for the Pacific Northwest'. Framework: LangGraph state machine with conditional routing. Nodes: classifier (gpt-5-nano, ~400 in / 80 out, 1 call/q) → retriever (parallel vector search via Weaviate over ~12M Earthdata granule metadata records, top-k=20, embedding via text-embedding-3-small) → statistics tool agent (sequential tool-calls to internal zonal-stats REST API for raster calcs, ~2 tool calls/q avg) → summarizer (gpt-5.2, ~6K in / 400 out). Postgres metadata store for granule lookups (~2 SQL queries/q). Redis prompt cache (84% hit rate). Public, ~10K MAU, 0.2 sessions/day, ~5 questions/session. FedRAMP Moderate (GovCloud), single region. Burst ~7 days/month around AGU and major data releases.",
    },
    {
      label: 'Federal · NIH ClinicalTrials.gov assistant (ReAct loop + structured SQL gen)',
      prompt: "Search + structured-data assistant over the NIH ClinicalTrials.gov corpus (~480K trial records). Query types: eligibility lookup ('am I eligible for trial NCT01234567?'), enrollment status ('how many enrolled at the Boston site?'), outcome browsing, side-effect summaries. Framework: ReAct loop (Reasoning + Acting) with up to 4 iterations. Each iteration: Thought → Action (one of: SQL on Postgres mirror, ClinicalTrials.gov REST API call, vector search via pgvector for protocol-summary text) → Observation. Tools: 1) PostgreSQL trial DB (avg 1.5 SQL queries/q), 2) CT.gov REST API (~1 call/q), 3) pgvector retriever (~1 lookup/q). Summarizer (gpt-5.2) emits structured JSON + plain-language with NCT-ID citations. Tool result tokens ~600 in/q. ~5,000 MAU, mostly clinicians; 3 sessions/week, 4 questions/session. FedRAMP Moderate. Sub-second TTFT required.",
    },
    {
      label: 'Federal · NOAA storm explainer (simple RAG + semantic cache, extreme burst)',
      prompt: "Hurricane / severe-weather public explainer. Query types: storm timeline ('when will it hit Tampa?'), impact translation ('what should I do?'), historical comparison ('worse than Sandy?'), evacuation Q&A. Framework: simple RAG (no agents/tools) — single LLM call per turn after retrieval. Vector store: Pinecone Serverless (NHC advisories + WPC forecast products + local-warning text, ~50K docs). Aggressive semantic cache (Redis + sentence-transformer embeddings) — same questions across users hit cache, 90%+ during peaks. Multi-turn (avg 4 turns/session, conversation history grows ~600 tokens). No tool calls, no DB writes. Quiet baseline ~2K MAU; bursts to 100K+ MAU during named storm landfall (~5 burst days/month, 20× normal traffic). FedRAMP Moderate, single region. Daily cap $5,000 with 10× burst factor allowed on landfall days.",
    },
    {
      label: 'Federal · EPA permit-drafting (LangGraph multi-agent + verifier)',
      prompt: "Internal regulator workflow assistant. Query types: 'draft NPDES permit for facility ID X', 'compare emissions to 2019 baseline', 'flag compliance gaps in this draft', 'summarize last 5 years of inspections'. Framework: LangGraph DAG (planner → fan-out to specialists → join → drafter → verifier). Specialist sub-agents (run in parallel): 1) Retriever — vector search over ~300K permit-precedent docs in Weaviate (gpt-5-nano, ~1.5K in/q, 1 call); 2) Compliance tool agent (gpt-5-mini, sequential REST calls to EPA Compliance API + Emissions DB + facility lookup, avg 4 tool calls/q); 3) Inspections SQL agent (text-to-SQL against internal inspections Postgres, avg 2 SQL queries/q). Drafter (gpt-5.2, ~10K in / 1.5K out long-context). Verifier: FactReasoner FR2 at 25% sampling, gpt-5-mini for NLI judgments. 800 internal users, 2 sessions/day, ~8 questions/session, long sessions. FedRAMP High, multi-region active-passive (RTO 4h), 7-year audit-log retention.",
    },
    {
      label: 'Federal · DOE grid operator advisor (LangGraph hybrid + 100% verifier, safety-critical)',
      prompt: "Internal grid-operations advisor — answers MUST be correct. Query types: 'what's the dispatch order if line 4 trips?', 'projected peak demand next 6 hours', 'handbook lookup for procedure X', 'is this contingency N-1 safe?'. Framework: LangGraph state machine with mandatory verifier gate (no answer ships unverified). Pipeline: classifier → retriever (operator handbooks ~8K docs in pgvector with HNSW indexing) + parallel tool agent (sequential ReAct sub-loop over: live SCADA telemetry REST API, NOAA weather forecast API, real-time market-clearing API; avg 6 tool calls/q) → summarizer (Claude Opus 4.7 for safety-critical reasoning, ~5K in / 600 out) → 100% verifier coverage (FactReasoner FR2, 160 NLI calls/atom × 8 atoms = 1,280 NLI calls/q, NLI runs on EC2 g6 self-hosted DeBERTa). PostgreSQL audit log (every Q+A+evidence trail persisted, ~10 KB/q). 200 operators, 8 sessions/day, ~12 questions/session. FedRAMP High, multi-region ACTIVE-ACTIVE (RTO < 4h, RPO < 5min), HSM-backed keys, 25-year audit retention.",
    },
    {
      label: 'Startup · SaaS B2B customer support (OpenAI Assistants + RAG, public)',
      prompt: "B2B SaaS customer-support chatbot. Query mix: how-to walkthroughs (60%), bug troubleshooting (25%), billing/account questions (10%), out-of-scope refusals (5%). Framework: OpenAI Assistants API (file_search built-in tool over our 1,200-page docs site indexed as Assistants vector store). Single agent with two function-calling tools: 1) escalate_to_zendesk (POST to Zendesk REST API, ~5% of conversations), 2) lookup_account (internal Postgres user-status query, ~30% of conversations). Per query: 1 LLM call typical, occasionally 2 if a tool fires. Prompt caching enabled (~70% hit rate on system prompt + retrieved chunks). Public-facing, ~25K MAU, ~4 sessions/month per user, 6 questions/session avg. Commercial cloud (AWS us-east-1). Edge WAF + bot factor 2.0× for crawlers. Daily cap $500 with edge throttling.",
    },
    {
      label: 'Startup · Legal contract analyzer (LangGraph multi-agent, long-context, 30+ retrieval chunks)',
      prompt: "Internal tool for a 60-lawyer firm. Query types: clause extraction ('list all indemnity clauses'), risk flagging ('flag anything unusual vs market terms'), redline drafting, definition-section lookups. Framework: LangGraph multi-agent supervisor pattern. Pipeline: ingestion (uploaded PDFs → chunked + embedded into Pinecone, run once per upload, NOT per query) → orchestrator (Claude Opus 4.7) → 3 parallel sub-agents: 1) clause-classifier (gpt-5-mini, ~2K in / 500 out, 1 call/q); 2) risk-flagger (Claude Opus 4.7, retrieves 10+ precedent chunks from a separate Pinecone index of 80K market-standard clauses, ~5K in / 800 out); 3) redline drafter (Claude Opus 4.7, long-context ~18K in with 30+ retrieved chunks / 1.5K out). No tool calls, all retrieval. Postgres for upload metadata + audit trail. ~50 active daily users, 5 sessions/day, 15 questions/session (long sessions). Commercial cloud, GDPR controls, encrypt at rest.",
    },
    {
      label: 'Startup · E-commerce recommendation agent (CrewAI tool-heavy, low-LLM)',
      prompt: "Public-facing personalized product recommendation agent on a high-traffic e-comm site. Query types: explicit ('show me running shoes under $100'), implicit (personalization on every product detail page view), 'frequently bought together', 'similar items'. Framework: CrewAI multi-agent with parallel tool-calling. Crew: 1) Intent agent (gpt-5-nano, ~300 in / 50 out — cheap because most queries are implicit/page-view triggered); 2) User-history tool agent (Postgres SQL queries against user_orders + view_history tables, avg 2 SQL/q); 3) Catalog tool agent (Elasticsearch query over 2M SKUs, ~1 ES query/q returning top 100); 4) Personalizer (gpt-5-mini, blends history + catalog, ~1.2K in / 200 out); 5) Ranker (lightweight model, no LLM call for half of queries). Redis cache for popular items (~85% cache hit on similar-item lookups). ~500K MAU, 1.2 sessions/day, ~8 'queries' per session (mostly automatic on page view, low LLM tokens / high tool I/O). Commercial AWS, AWS Bot Control + CAPTCHA on sign-in routes.",
    },
    {
      label: 'Startup · Healthcare scheduling (Anthropic tool-use loop + PII redaction, HIPAA)',
      prompt: "Internal scheduling assistant for a 200-physician multi-site practice. Query types: 'find Dr. Smith availability next week', 'reschedule John Doe's Tuesday appointment to Thursday', 'set up recurring follow-ups for chronic-care patients'. Framework: Anthropic Claude tool-use agentic loop (planner-executor pattern, up to 5 tool iterations per query, average 2.5). Tools: 1) Calendar API (Google Workspace Calendar API, mix of read + write calls — avg 3 calls/q); 2) Patient-records (Epic FHIR API, but ALL calls routed through a Presidio PII-redaction proxy that scrubs PHI before any LLM sees it — adds ~150ms latency + $50/M tokens scrubbing cost); 3) Confirmer (sends booking + verifies, 1 write/q). Postgres for booking audit log. No vector DB (no RAG, just tool-using). 2,000 staff users, 6 sessions/day, ~10 questions/session. HIPAA-sensitive (treat as FedRAMP Moderate equivalent). Audit retention 10 years. SAML SSO + MFA, edge WAF, $1500/day cap.",
    },
    {
      label: 'Startup · Research synthesizer (LangGraph long-form, expensive per query)',
      prompt: "Financial-research analyst tool. Query types: thematic synthesis ('write a 2-page memo on lithium supply-chain risk Q1 2026'), document summarization, source-by-source evidence collection with citations. Framework: LangGraph deep-research pattern (planner → parallel retrieve → reduce → write → audit). Pipeline: 1) Planner (Claude Opus 4.7, decomposes query into ~5 sub-questions, ~800 in / 600 out); 2) Multi-source retriever fan-out (5 parallel calls): Weaviate vector search over internal research library (~200K docs), Bloomberg API (proprietary tool, paid per call), S&P Capital IQ API, internal Postgres of past memos, Brave Search API; loads 20–50 PDFs avg per query; 3) Evidence collector (Claude Opus 4.7, ~12K in / 1K out per sub-question × 5); 4) Synthesis writer (Claude Opus 4.7 long-form, ~25K in / 2.5K out — context window stress test); 5) Citation auditor (gpt-5-mini, verifies each citation against source). Pinecone for chunking + retrieval. ~$1.50/query. 100 internal analysts, ~4 sessions/day, ~3 queries/session (low frequency, very expensive). Commercial cloud, manual analyst review on every output before client delivery.",
    },
  ];

  // (Heuristic keyword extractor removed — AI does all intent extraction now.)
  // (Heuristic keyword extractor and helpers removed — AI does all
  // intent extraction now. See llmIntent() below for the one-shot prompt.)

  // One-shot LLM intent extraction. Sends the user's plain-English
  // description to OpenAI and returns:
  //   { intent, log, suggestions }
  // No multi-turn loop. If the description is ambiguous, the model
  // makes its best guess and surfaces refinement ideas as suggestions.
  // ---------------------------------------------------------------------
  // Proxy endpoint at api.ajinkya.ai. Free + capped + no API key needed.
  // Falls back to BYOK when the shared budget is exhausted.
  // ---------------------------------------------------------------------
  const PROXY_BASE = 'https://api.ajinkya.ai';

  // Stable per-browser id, used as one input to the proxy's fingerprint.
  function getClientId() {
    const KEY = 'ccs-client-id';
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
           (Date.now().toString(36) + Math.random().toString(36).slice(2));
      localStorage.setItem(KEY, id);
    }
    return id;
  }

  // Call the proxy. Returns { intent, log, suggestions, meta } on success.
  // Throws an Error with a `.code` property on quota/cap errors so the
  // caller can decide whether to fall back to BYOK.
  async function llmIntentViaProxy(text) {
    const resp = await fetch(`${PROXY_BASE}/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userPrompt: text, clientId: getClientId() }),
    });
    if (!resp.ok) {
      let err = {};
      try { err = await resp.json(); } catch (_) {}
      const e = new Error(err.error || `proxy_error_${resp.status}`);
      e.code = err.error;
      e.status = resp.status;
      e.byokHint = err.byok_hint || false;
      e.detail = err.detail;
      throw e;
    }
    return await resp.json();
  }

  async function llmIntent(text, apiKey) {
    const systemPrompt = `You are a cost-modeling assistant for AI deployments (federal and commercial). Given a plain-English description of an AI system, extract a structured intent that drives a cost calculator.

Be precise — federal context (any US federal agency mention like NASA/NIH/EPA/DOE/NOAA/etc., or FedRAMP/GovCloud/IL4/IL5/CUI language) means fedrampTier should be moderate or high (NEVER 'none'). HIPAA/PHI mentions also imply moderate at minimum.

Choose archPreset based on what the system does:
- knowledge → simple
- rag (documents/PDFs/knowledge base) → rag
- tools (databases/APIs/function calling) → tool
- multi-agent / planner+sub-agents / orchestrator → multi
- both rag AND tools, or any system with a fact verifier → hybrid

CRITICAL — MAU vs query volume:
- mau = number of UNIQUE PEOPLE / users per month, NOT total queries.
- If the description says "200 operators × 8 sessions/day × 12 questions/session", mau is 200, NOT 200×8×12.
- If the description gives only total query rate, work back: mau = queries / (sessions_per_day × 30 × questions_per_session).

CRITICAL — Burst traffic:
- If the description mentions "bursts to N users during X" or "spikes during Y events", do NOT take the burst as the MAU. Use the BASELINE as mau, and set burst_days + burst_factor to capture the spike.
- Example: "baseline 2K MAU, bursts to 100K during named storms (~5 days/month, 20× normal)" → mau: 2000, burst_days: 5, burst_factor: 20.

CRITICAL — Verification:
- If the description mentions "fact verifier", "FactReasoner", "100% verifier coverage", or "checks every answer" → set verification_coverage to a fraction 0..1 (e.g., 1.0 for 100%).
- Variants: FR1 (lean, 24 NLI calls/atom), FR2 (160), FR3 (350). Map "exhaustive" → fr3, "high recall" → fr2, "lean" → fr1.
- If "self-hosted NLI on EC2 g6" or similar → verification_nli_hosting: 'ec2-g6'. Otherwise 'api'.

CRITICAL — Multi-region / DR:
- "active-active" or "full duplicate in 2nd region" → multiRegion: 'active-active'
- "active-passive" or "warm standby" → multiRegion: 'active-passive'
- "single region" or unstated → multiRegion: 'single'

CRITICAL — Audit retention:
- "7-year audit retention", "25-year retention", etc. → audit_retention_years: <int>

CRITICAL — Self-host duty cycle:
- "scale-to-zero", "business hours only" (~25%), "burst-only" (~10%) → duty_cycle: 0.05..1.0
- Default 1.0 (always-on) when not mentioned.

Output STRICT JSON, no commentary:
{
  "intent": {
    "useCase": one of [support, search, research, data-qa, doc-qa, workflow, custom],
    "answerLen": one of [one-liner, short, detailed, report],
    "contextSize": one of [none, lookup, moderate, comprehensive],
    "conversation": one of [one-shot, short, long],
    "source": one of [knowledge, rag, tools, both],
    "archPreset": one of [simple, rag, tool, multi, hybrid],
    "fedrampTier": one of [none, low, moderate, high],
    "multiRegion": one of [single, active-passive, active-active],
    "mau": integer (UNIQUE USERS, not total queries),
    "agency": string | null,
    "publicFacing": boolean,
    "burst_days": integer (0 if not bursty),
    "burst_factor": number (1 if not bursty),
    "verification_coverage": number 0..1 (0 if not mentioned),
    "verification_variant": string | null (one of fr1, fr2, fr3),
    "verification_nli_hosting": string | null (api, ec2-g6, or ec2-g5),
    "audit_retention_years": integer (0 if not mentioned),
    "duty_cycle": number 0.05..1.0 (1.0 = always-on, default)
  },
  "log": [
    "Detected: short label of what the system is",
    "Agency: <name>",
    "FedRAMP tier: <tier> — <why>",
    "MAU: <number> (unique users, not queries)",
    "Architecture: <preset> preset",
    "Token budget: <input>/<output> (estimated)"
  ],
  "suggestions": [
    "Actionable refinement #1 — what to tweak in the Components tab",
    "Actionable refinement #2 — common gotcha for this kind of system"
  ]
}

Rules:
- Each \`log\` entry: 1 sentence, terse, what you set + brief justification.
- 2-4 \`suggestions\`: practical next steps. Reference specific Components-tab sections by number when relevant ("Section 6 — verification", "Section 7 — daily cap", "Section 1.5 — federal compliance").
- Don't repeat suggestions that are already in the log.
- If MAU is unstated, make a reasonable guess based on context and add a suggestion to confirm.
- Set burst_days/burst_factor/verification_coverage/audit_retention_years/duty_cycle to 0 (or 1.0 for duty_cycle) when not mentioned in the description — do NOT invent values.`;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI API ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    return {
      intent: parsed.intent || {},
      log: Array.isArray(parsed.log) ? parsed.log : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  }

  // Apply an extracted intent to the workload + UI. Returns a list of
  // human-readable summary strings of what changed.
  function applyIntentToWorkload(intent) {
    const summary = [];

    // 1. Wizard-derived token sizing
    const wizAnswers = {
      useCase:     intent.useCase || 'custom',
      answerLen:   intent.answerLen || 'short',
      contextSize: intent.contextSize || 'moderate',
      conversation:intent.conversation || 'short',
      source:      intent.source || 'knowledge',
    };
    const r = computeWizard(wizAnswers);
    workload.anchor_query.input_tokens = r.input;
    workload.anchor_query.output_tokens = r.output;
    summary.push(`Token budget: ${r.input.toLocaleString()} in / ${r.output.toLocaleString()} out`);

    // 2. Audience size
    if (intent.mau && intent.mau > 0) {
      // Apply to the first segment (or the public segment if it exists)
      if (Array.isArray(workload.segments) && workload.segments.length > 0) {
        const target = workload.segments.find(s => s.applyBotFactor) || workload.segments[0];
        target.mau = intent.mau;
        summary.push(`MAU: ${intent.mau.toLocaleString()} (segment "${target.label || target.id}")`);
      }
    }

    // 3. Public/internal posture
    if (intent.publicFacing !== null && intent.publicFacing !== undefined) {
      workload.deployment.publicFacing = intent.publicFacing;
      summary.push(intent.publicFacing ? 'Marked public-facing' : 'Marked internal-only');
    }

    // 4. Federal posture (FedRAMP + multi-region)
    if (intent.fedrampTier && intent.fedrampTier !== 'none') {
      workload.federal = workload.federal || {};
      workload.federal.fedramp_tier = intent.fedrampTier;
      summary.push(`FedRAMP tier: ${intent.fedrampTier}`);
    }
    if (intent.multiRegion && intent.multiRegion !== 'single') {
      workload.federal = workload.federal || {};
      workload.federal.multi_region = intent.multiRegion;
      summary.push(`Multi-region: ${intent.multiRegion}`);
    }

    // 5. Agency naming
    if (intent.agency) {
      workload.deployment.agency = intent.agency;
      summary.push(`Agency: ${intent.agency}`);
    }

    // 6. Architecture preset
    if (intent.archPreset && ARCH_PRESETS[intent.archPreset]) {
      archActive.clear();
      ARCH_PRESETS[intent.archPreset].forEach(id => archActive.add(id));
      applyArchToWorkload();
      summary.push(`Architecture preset: ${intent.archPreset} (${archActive.size} components)`);
    }

    // 7. Burst traffic — auto-apply when AI describes spikes
    if (intent.burst_days != null && intent.burst_days > 0) {
      workload.daily_cap = workload.daily_cap || { enabled: true };
      workload.daily_cap.burst_days = intent.burst_days;
      if (intent.burst_factor != null && intent.burst_factor > 0) {
        workload.daily_cap.burst_factor = intent.burst_factor;
      }
      summary.push(`Burst: ${intent.burst_days} days/mo at ${intent.burst_factor || workload.daily_cap.burst_factor}× factor`);
    }

    // 8. Verification — when AI says "100% verifier coverage", "FactReasoner FR2", etc.
    if (intent.verification_coverage != null) {
      workload.verification = workload.verification || {};
      workload.verification.enabled = intent.verification_coverage > 0;
      workload.verification.coverage = intent.verification_coverage;
      if (intent.verification_variant) workload.verification.variant = intent.verification_variant;
      if (intent.verification_nli_hosting) workload.verification.nli_hosting = intent.verification_nli_hosting;
      summary.push(`Verification: ${(intent.verification_coverage * 100).toFixed(0)}% coverage${intent.verification_variant ? ' (' + intent.verification_variant.toUpperCase() + ')' : ''}`);
    }

    // 9. Audit retention — federal RFPs often specify multi-year retention
    if (intent.audit_retention_years != null && intent.audit_retention_years > 0) {
      workload.federal = workload.federal || {};
      workload.federal.audit_retention_years = intent.audit_retention_years;
      summary.push(`Audit retention: ${intent.audit_retention_years} years`);
    }

    // 10. Self-host duty cycle — for bursty/business-hours workloads
    if (intent.duty_cycle != null && intent.duty_cycle > 0 && intent.duty_cycle < 1) {
      workload.self_host = workload.self_host || {};
      workload.self_host.duty_cycle = intent.duty_cycle;
      summary.push(`Self-host duty cycle: ${(intent.duty_cycle * 100).toFixed(0)}% (scale-to-zero pattern)`);
    }

    return summary;
  }

  function setupChatBuilder() {
    const input = document.getElementById('chat-input');
    const buildBtn = document.getElementById('chat-build');
    const clearBtn = document.getElementById('chat-clear');
    const examplesSel = document.getElementById('chat-examples');
    const keyInput = document.getElementById('chat-api-key');
    const keySaveBtn = document.getElementById('chat-key-save');
    const keyClearBtn = document.getElementById('chat-key-clear');
    const keyStatus = document.getElementById('ai-key-status');
    const output = document.getElementById('chat-output');
    const execLog = document.getElementById('exec-log');
    const suggestionsEl = document.getElementById('suggestions');
    if (!input || !buildBtn) return;

    const STORAGE_KEY = 'ccs-openai-key';

    // Populate examples dropdown
    if (examplesSel && CHAT_EXAMPLES) {
      CHAT_EXAMPLES.forEach((ex, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = ex.label;
        examplesSel.appendChild(opt);
      });
      examplesSel.addEventListener('change', () => {
        const idx = parseInt(examplesSel.value, 10);
        if (!isNaN(idx) && CHAT_EXAMPLES[idx]) {
          input.value = CHAT_EXAMPLES[idx].prompt;
          input.focus();
        }
      });
    }

    // ---- Shared-key availability (from api.ajinkya.ai/health) ----
    // Cached for the page session so we don't hit the endpoint per click.
    let sharedKeyState = null;  // { available, load, per_fingerprint_daily_limit }
    const refreshSharedKeyState = async () => {
      try {
        const resp = await fetch(`${PROXY_BASE}/health`, { method: 'GET' });
        const json = await resp.json();
        sharedKeyState = json.shared_key || null;
      } catch (_) { sharedKeyState = null; }
      updateKeyStatus();
    };

    // Restore saved key + show status. The shared key is the default —
    // BYOK is now the optional fallback.
    const updateKeyStatus = () => {
      const stored = localStorage.getItem(STORAGE_KEY);
      let line;
      if (sharedKeyState && sharedKeyState.available) {
        const loadLabel = { plenty: '🟢 plenty', moderate: '🟡 moderate', low: '🟠 low', exhausted: '🔴 exhausted' }[sharedKeyState.load] || sharedKeyState.load;
        line = `Shared key active — load: ${loadLabel}. ${sharedKeyState.per_fingerprint_daily_limit}/day per user. ` +
               (stored ? '<em>Your own key is saved as fallback.</em>' : '<em>Add an OpenAI key below if you want unlimited use.</em>');
        keyStatus.className = 'ai-key-status saved';
      } else if (sharedKeyState && !sharedKeyState.available) {
        line = '🔴 Shared key budget exhausted today — paste your own OpenAI key below to continue.';
        keyStatus.className = 'ai-key-status';
      } else if (stored) {
        line = '✓ Your OpenAI key is saved (BYOK fallback). Will be used if shared key is unavailable.';
        keyStatus.className = 'ai-key-status saved';
      } else {
        line = 'Shared key (no setup needed) is the default. Add your own OpenAI key for unlimited use.';
        keyStatus.className = 'ai-key-status';
      }
      keyStatus.innerHTML = line;
    };
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) keyInput.value = stored;
    updateKeyStatus();
    refreshSharedKeyState();

    keySaveBtn.addEventListener('click', () => {
      const key = keyInput.value.trim();
      if (!key) {
        keyStatus.textContent = '✗ Empty key';
        keyStatus.className = 'ai-key-status error';
        return;
      }
      localStorage.setItem(STORAGE_KEY, key);
      updateKeyStatus();
    });
    keyClearBtn.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      keyInput.value = '';
      updateKeyStatus();
    });

    const showError = (msg) => {
      output.style.display = '';
      execLog.innerHTML = `<div class="chat-error">✗ ${escapeHtml(msg)}</div>`;
      suggestionsEl.innerHTML = '';
    };

    const renderOutput = (result, applied) => {
      output.style.display = '';
      // Execution log: AI-provided log entries + the workload-application summary
      const logItems = (result.log || []).concat(applied);
      const logHtml = logItems.length > 0
        ? logItems.map(s => `<div class="log-entry"><span class="check">✓</span>${escapeHtml(s)}</div>`).join('')
        : '<div class="log-entry"><em>No log entries returned.</em></div>';
      execLog.innerHTML =
        `<div class="log-title">Execution log</div>${logHtml}` +
        `<details style="margin-top:6px;"><summary style="cursor:pointer; font-size:9px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em;">Raw intent JSON</summary><pre style="background:rgba(0,0,0,0.04); padding:6px; border-radius:2px; font-size:10px; line-height:1.3; margin:4px 0; max-height:140px; overflow:auto;">${escapeHtml(JSON.stringify(result.intent, null, 2))}</pre></details>`;

      // Suggestions: AI-provided refinement ideas + a built-in jump button
      const sugItems = (result.suggestions || []);
      const sugHtml = sugItems.length > 0
        ? sugItems.map(s => `<div class="sug-entry"><span class="bulb">💡</span>${escapeHtml(s)}</div>`).join('')
        : '<div class="sug-entry"><em>No refinement suggestions — looks complete!</em></div>';
      suggestionsEl.innerHTML =
        `<div class="sug-title">Suggestions to refine</div>${sugHtml}` +
        `<div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
           <button class="hint-link" data-jump="components">Open Components ↗</button>
           <button class="hint-link" data-jump="simulator">Tweak token sizing in Simulator ↗</button>
         </div>`;
      suggestionsEl.querySelectorAll('[data-jump]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (typeof window.__ccsSwitchTab === 'function') window.__ccsSwitchTab(btn.dataset.jump);
        });
      });
    };

    const resetChat = () => {
      input.value = '';
      output.style.display = 'none';
      execLog.innerHTML = '';
      suggestionsEl.innerHTML = '';
      if (examplesSel) examplesSel.value = '';
    };

    clearBtn.addEventListener('click', resetChat);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        buildBtn.click();
      }
    });

    buildBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) {
        showError('Type a description above (or pick an example).');
        return;
      }
      const apiKey = (localStorage.getItem(STORAGE_KEY) || keyInput.value || '').trim();

      // Loading state
      output.style.display = '';
      execLog.innerHTML = '<div class="log-title">Execution log</div><div class="log-entry">⏳ Calling shared key (api.ajinkya.ai)…</div>';
      suggestionsEl.innerHTML = '';
      buildBtn.disabled = true;

      // ---- Strategy: try shared first, fall back to BYOK on quota errors.
      // If user has no BYOK saved and shared fails, surface a clear prompt.
      let result, source;
      try {
        try {
          result = await llmIntentViaProxy(text);
          source = 'shared';
        } catch (proxyErr) {
          const isQuotaErr = proxyErr.byokHint || /cap_reached|fp_daily_limit|ip_daily_limit|ip_hourly_limit|ip_daily_cost_cap/.test(proxyErr.code || '');
          if (isQuotaErr && apiKey) {
            execLog.innerHTML = '<div class="log-title">Execution log</div>' +
              `<div class="log-entry">⚠️ Shared key quota reached (${escapeHtml(proxyErr.code || 'cap')}); falling back to your OpenAI key…</div>`;
            result = await llmIntent(text, apiKey);
            source = 'byok-fallback';
          } else if (isQuotaErr && !apiKey) {
            // No BYOK to fall back to
            const e = new Error('Shared key budget reached. Add your own OpenAI key below to continue (it stays in your browser).');
            e.code = proxyErr.code;
            throw e;
          } else if (proxyErr.code === 'origin_not_allowed') {
            // Likely running locally without registering this origin —
            // fall back to BYOK if available, otherwise instruct user.
            if (apiKey) {
              execLog.innerHTML = '<div class="log-title">Execution log</div>' +
                '<div class="log-entry">⚠️ This origin isn\'t allowed by the shared proxy; using your OpenAI key…</div>';
              result = await llmIntent(text, apiKey);
              source = 'byok-fallback';
            } else {
              throw new Error('This origin is not allowed by the shared proxy. Add your own OpenAI key below to use the chat builder.');
            }
          } else {
            // Unknown proxy error — try BYOK if available, otherwise rethrow
            if (apiKey) {
              execLog.innerHTML = '<div class="log-title">Execution log</div>' +
                `<div class="log-entry">⚠️ Shared key error (${escapeHtml(proxyErr.code || 'unknown')}); falling back to your OpenAI key…</div>`;
              result = await llmIntent(text, apiKey);
              source = 'byok-fallback';
            } else {
              throw proxyErr;
            }
          }
        }

        const applied = applyIntentToWorkload(result.intent);
        renderOutput(result, applied);
        // Re-render rest of the calculator to reflect changes
        renderEditor();
        renderArchDiagram();
        renderArchSummary();
        renderPreview();
        // Auto-show any sections the intent touched (verification, federal, etc.)
        if (typeof window.__ccsRefreshComponents === 'function') window.__ccsRefreshComponents();

        // Annotate the log with where the call went + remaining budget
        if (source === 'shared' && result.meta && result.meta.remaining) {
          const r = result.meta.remaining;
          const note = document.createElement('div');
          note.className = 'log-entry';
          note.style.cssText = 'color:var(--muted);font-size:10px;margin-top:4px;';
          note.innerHTML = `via shared key · ${r.per_fingerprint_today} of ${sharedKeyState ? sharedKeyState.per_fingerprint_daily_limit : 10} requests left today · cost this call $${(result.meta.cost_usd || 0).toFixed(4)}`;
          execLog.appendChild(note);
        }
        // Refresh /health view after a successful shared call.
        if (source === 'shared') refreshSharedKeyState();
      } catch (e) {
        showError(e.message);
      } finally {
        buildBtn.disabled = false;
      }
    });
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
})();
