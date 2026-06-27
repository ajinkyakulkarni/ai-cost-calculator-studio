/* workload-schema.mjs — classification of workload inputs into REQUIRED
 * (hard gate; agent must propose + user confirm) vs SUGGESTIBLE (defaulted,
 * surfaced as an assumption). Drives validate.mjs and the interview. */

export const REQUIRED = [
  {
    field: 'volume',
    present: (w) => Array.isArray(w.segments) && w.segments.some(s =>
      Number(s.mau) > 0 && s.sessions_per_day != null && s.questions_per_session != null),
    why: 'Total query volume drives every cost line.',
    suggested_value: { segments: [{ id: 'all', mau: 5000, sessions_per_day: 0.2, questions_per_session: 10 }] },
    rationale: 'Mid-size agency pilot ≈ 5,000 MAU × 0.2 sessions/day × 10 questions.',
  },
  {
    field: 'model',
    present: (w) => !!(w.defaults && w.defaults.model),
    why: 'Per-token rates depend on the model.',
    suggested_value: { defaults: { model: 'gpt-5.4' } },
    rationale: 'A current flagship; pick your actual model.',
  },
  {
    field: 'hosting',
    present: (w) => !!(w.defaults && w.defaults.hosting),
    why: 'API vs BYOK vs self-host changes the cost structure entirely.',
    suggested_value: { defaults: { hosting: 'api' } },
    rationale: 'Managed API is the common starting point.',
  },
  {
    field: 'cache_rate_baseline',
    present: (w) => !!(w.anchor_query && w.anchor_query.cache_rate_baseline != null),
    why: 'Prompt-cache hit rate strongly moves the token bill.',
    suggested_value: { anchor_query: { cache_rate_baseline: 0.8 } },
    rationale: 'Stable system prompts typically cache ~0.8; confirm from telemetry.',
  },
  {
    field: 'token_profile',
    present: (w) =>
      (w.anchor_query && Number(w.anchor_query.input_tokens) > 0) ||
      (Array.isArray(w.agents) && w.agents.some(a =>
        Number(a.input_tokens) > 0 || (Array.isArray(a.archetypes) && a.archetypes.length > 0))) ||
      (Array.isArray(w.archetypes) && w.archetypes.length > 0),
    why: 'The per-query token shape (anchor, agents, or archetypes) is the cost basis.',
    suggested_value: { anchor_query: { input_tokens: 3000, output_tokens: 500 } },
    rationale: 'A single-call RAG answer is ~3k in / ~500 out; replace with your trace.',
  },
];

export const CONDITIONAL = [
  {
    field: 'self_host_gpu',
    applies: (w) => w.defaults && w.defaults.hosting === 'self-host',
    present: (w) => !!(w.self_host && w.self_host.gpu_choice),
    why: 'Self-host cost depends on the chosen GPU + throughput.',
  },
  {
    field: 'fedramp_tier',
    applies: (w) => !!(w.federal && w.federal.indicated),
    present: (w) => !!(w.federal && w.federal.fedramp_tier && w.federal.fedramp_tier !== 'none'),
    why: 'FedRAMP tier adds large compliance overhead.',
  },
];

export const SUGGESTIBLE = [
  { field: 'tier',      get: (w) => w.defaults?.tier,      default: 'standard',   source: 'default' },
  { field: 'cost_mode', get: (w) => w.defaults?.cost_mode, default: 'optimistic', source: 'default' },
  { field: 'mix',       get: (w) => w.defaults?.mix,       default: 'worst',      source: 'default' },
];
