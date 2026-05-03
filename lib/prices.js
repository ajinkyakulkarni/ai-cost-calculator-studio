// =====================================================================
// Cost Calculator Studio — centralized price book
//
// SINGLE SOURCE OF TRUTH for all prices used by the calculator.
// Designed to be:
//   1. Easy to update by hand (change a number, bump last_verified)
//   2. Easy to update by an automated scraper (every value has a
//      `source_url` and `last_verified` field; a scraper can fetch the
//      URL, parse, and write back)
//   3. Easy to extend with new components (add a new entry to the
//      relevant category — engine will pick it up automatically)
//
// Schema convention for every priced entry:
//   {
//     value: <the price>,                      // canonical number
//     unit: '<dollars/X>',                     // human-readable unit
//     source_url: 'https://...',               // where this came from
//     last_verified: 'YYYY-MM-DD',             // ISO date of last check
//     notes: '...optional...',                 // model-id, region, etc.
//   }
//
// Overrides: a workload can override any entry. The engine uses
// `getPrice(category, key, fallback)` which checks the workload first,
// then this module's defaults.
//
// Categories:
//   llm_models             — per-token pricing for inference APIs
//   api_reservations       — reserved-throughput / committed-spend tiers
//   gpu_instances          — EC2 GPU hourly rates + throughput specs
//   embeddings             — embedding model rates
//   vector_dbs             — vector database hosting costs
//   cloud_aws              — AWS service prices (egress, S3, CW, RDS, etc.)
//   personnel              — annual salaries by role (for TCO)
//   ato                    — ATO assessment + continuous monitoring costs
//   tier_multipliers       — service-tier multipliers (Standard/Flex/Priority)
//   federal_multipliers    — FedRAMP × multi-region hosting premiums
// =====================================================================

(function (root) {
  'use strict';

  const Prices = {

    // -----------------------------------------------------------------
    // Metadata — version and global last-checked date.
    // -----------------------------------------------------------------
    meta: {
      version: '1.0',
      last_checked: '2026-05-03',
      sources_root: {
        openai:    'https://openai.com/api/pricing/',
        anthropic: 'https://www.anthropic.com/pricing',
        google:    'https://ai.google.dev/pricing',
        aws_ec2:   'https://aws.amazon.com/ec2/instance-types/',
        aws_rds:   'https://aws.amazon.com/rds/postgresql/pricing/',
        aws_s3:    'https://aws.amazon.com/s3/pricing/',
        aws_cw:    'https://aws.amazon.com/cloudwatch/pricing/',
        aws_govcloud: 'https://aws.amazon.com/govcloud-us/pricing/',
        pinecone:  'https://www.pinecone.io/pricing/',
        weaviate:  'https://weaviate.io/pricing',
        bls_salary:'https://www.bls.gov/oes/current/oes_nat.htm',
        fedramp:   'https://www.fedramp.gov/about/',
      },
    },

    // -----------------------------------------------------------------
    // LLM model rates ($ per million tokens). Validated 2026-04-25.
    // -----------------------------------------------------------------
    llm_models: {
      'gpt-5.5':         { input_per_million: 5.00, cached_per_million: 0.50,  output_per_million: 30.00, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'gpt-5.4':         { input_per_million: 2.50, cached_per_million: 0.25,  output_per_million: 15.00, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'gpt-5.2':         { input_per_million: 1.75, cached_per_million: 0.175, output_per_million: 14.00, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'gpt-5.1':         { input_per_million: 1.25, cached_per_million: 0.125, output_per_million: 10.00, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'gpt-5':           { input_per_million: 1.25, cached_per_million: 0.125, output_per_million: 10.00, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'gpt-5-mini':      { input_per_million: 0.25, cached_per_million: 0.025, output_per_million:  2.00, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'gpt-5-nano':      { input_per_million: 0.05, cached_per_million: 0.005, output_per_million:  0.40, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'gpt-4o':          { input_per_million: 2.50, cached_per_million: 1.25,  output_per_million: 10.00, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'gpt-4o-mini':     { input_per_million: 0.15, cached_per_million: 0.075, output_per_million:  0.60, provider: 'OpenAI',     source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'claude-opus-4.7': { input_per_million: 5.00, cached_per_million: 0.50,  output_per_million: 25.00, provider: 'Anthropic',  source_url: 'https://www.anthropic.com/pricing', last_verified: '2026-04-25' },
      'claude-sonnet-4.6': { input_per_million: 3.00, cached_per_million: 0.30,  output_per_million: 15.00, provider: 'Anthropic',  source_url: 'https://www.anthropic.com/pricing', last_verified: '2026-04-25' },
      'claude-haiku-4.5':{ input_per_million: 0.80, cached_per_million: 0.08,  output_per_million:  4.00, provider: 'Anthropic',  source_url: 'https://www.anthropic.com/pricing', last_verified: '2026-04-25' },
      'gemini-3.1-pro':  { input_per_million: 2.00, cached_per_million: 0.20,  output_per_million: 12.00, provider: 'Google',     source_url: 'https://ai.google.dev/pricing',     last_verified: '2026-04-25' },
    },

    // -----------------------------------------------------------------
    // Service-tier multipliers (Standard / Flex / Batch / Priority).
    // Applied to the base llm_model rate.
    // -----------------------------------------------------------------
    tier_multipliers: {
      standard: { multiplier: 1.00, sla: 'best-effort latency',                    notes: 'default tier' },
      flex:     { multiplier: 0.50, sla: 'minutes — relaxed latency',              notes: 'OpenAI Flex tier' },
      batch:    { multiplier: 0.50, sla: '24h — bulk job',                         notes: 'Anthropic / OpenAI Batch API' },
      priority: { multiplier: 2.50, sla: 'guaranteed throughput, no rate limits',  notes: 'OpenAI Priority / Anthropic priority routing' },
    },

    // -----------------------------------------------------------------
    // Reserved API capacity — committed-spend / provisioned-throughput.
    // Big procurement lever; usually 30–50% effective discount with
    // commitment.
    // -----------------------------------------------------------------
    api_reservations: {
      'none': {
        provider: 'any',
        name: 'On-demand (no reservation)',
        discount: 0.00,
        commitment_months: 0,
        notes: 'Default — pay-per-token, no commitment',
        source_url: '',
        last_verified: '2026-04-25',
      },
      'azure-ptu-monthly': {
        provider: 'Azure OpenAI',
        name: 'Provisioned Throughput Unit (monthly)',
        dollar_per_unit_per_month: 1875,
        throughput_per_unit_tps: 50,
        commitment_months: 1,
        notes: 'PTU = provisioned tokens/sec; sized per workload',
        source_url: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/provisioned-throughput',
        last_verified: '2026-04-25',
      },
      'azure-ptu-yearly': {
        provider: 'Azure OpenAI',
        name: 'Provisioned Throughput Unit (annual)',
        dollar_per_unit_per_month: 1325,
        throughput_per_unit_tps: 50,
        commitment_months: 12,
        discount_vs_monthly: 0.29,
        notes: '~30% discount vs monthly PTU',
        source_url: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/provisioned-throughput',
        last_verified: '2026-04-25',
      },
      'bedrock-provisioned-1mo': {
        provider: 'AWS Bedrock',
        name: 'Provisioned Throughput (1-month commit)',
        commitment_months: 1,
        discount_below_breakeven: 0.00,
        notes: 'Sized in model units; rate varies by model',
        source_url: 'https://aws.amazon.com/bedrock/pricing/',
        last_verified: '2026-04-25',
      },
      'bedrock-provisioned-6mo': {
        provider: 'AWS Bedrock',
        name: 'Provisioned Throughput (6-month commit)',
        commitment_months: 6,
        discount_vs_on_demand: 0.20,
        notes: '~20% discount, sized in model units',
        source_url: 'https://aws.amazon.com/bedrock/pricing/',
        last_verified: '2026-04-25',
      },
      'openai-enterprise-100k': {
        provider: 'OpenAI Enterprise',
        name: 'Enterprise commit ≥ $100K/mo',
        committed_monthly_spend: 100000,
        discount: 0.10,
        commitment_months: 12,
        notes: '~10% off list at $100K+/mo committed',
        source_url: 'https://openai.com/enterprise',
        last_verified: '2026-04-25',
      },
      'openai-enterprise-1m': {
        provider: 'OpenAI Enterprise',
        name: 'Enterprise commit ≥ $1M/mo',
        committed_monthly_spend: 1000000,
        discount: 0.20,
        commitment_months: 12,
        notes: '~20% off list at $1M+/mo committed',
        source_url: 'https://openai.com/enterprise',
        last_verified: '2026-04-25',
      },
    },

    // -----------------------------------------------------------------
    // Federal hosting multipliers (FedRAMP × multi-region/DR).
    // -----------------------------------------------------------------
    federal_multipliers: {
      fedramp: {
        none:     { multiplier: 1.00, notes: 'commercial cloud' },
        low:      { multiplier: 1.00, notes: 'minimal premium' },
        moderate: { multiplier: 1.15, notes: '~15% above commercial', source_url: 'https://aws.amazon.com/govcloud-us/pricing/', last_verified: '2026-04-25' },
        high:     { multiplier: 1.30, notes: '~30% above commercial', source_url: 'https://aws.amazon.com/govcloud-us/pricing/', last_verified: '2026-04-25' },
      },
      multi_region: {
        single:          { multiplier: 1.00, notes: 'single region' },
        'active-passive':{ multiplier: 1.50, notes: 'warm standby in 2nd region' },
        'active-active': { multiplier: 2.00, notes: 'full duplicate in 2nd region' },
      },
    },

    // -----------------------------------------------------------------
    // GPU instances (AWS EC2). hourly = on-demand $/hr in commercial.
    // tput_tps = peak tokens/sec per instance running a 70B model
    // at int8 quantization (typical self-host config).
    // -----------------------------------------------------------------
    gpu_instances: {
      'g6e.12xl': { hourly: 10.49, tput_tps: 1200, name: '4× L40S 48GB',  capable: '70B int8',  source_url: 'https://aws.amazon.com/ec2/instance-types/g6e/', last_verified: '2026-04-25' },
      'g5.48xl':  { hourly: 16.29, tput_tps:  900, name: '8× A10G 24GB',  capable: '70B int4',  source_url: 'https://aws.amazon.com/ec2/instance-types/g5/',  last_verified: '2026-04-25' },
      'p5.48xl':  { hourly: 98.32, tput_tps: 4500, name: '8× H100 80GB',  capable: '400B fp8',  source_url: 'https://aws.amazon.com/ec2/instance-types/p5/',  last_verified: '2026-04-25' },
      'p5e.48xl': { hourly: 86.50, tput_tps: 4500, name: '8× H200 141GB', capable: '400B fp8',  source_url: 'https://aws.amazon.com/ec2/instance-types/p5/',  last_verified: '2026-04-25' },
    },

    // -----------------------------------------------------------------
    // Self-host cost modes (operational overhead beyond GPU $).
    // -----------------------------------------------------------------
    self_host_cost_modes: {
      optimistic: {
        ops_monthly:        350,    fte_monthly: 2500, setup_amortized:    0,
        throughput_derate:  1.00,   discount_1yr: 0.40, discount_3yr: 0.60,
        notes: 'vendor demo numbers — no setup, low ops',
      },
      realistic: {
        ops_monthly:       1800,    fte_monthly: 8000, setup_amortized: 8333,
        throughput_derate:  0.75,   discount_1yr: 0.33, discount_3yr: 0.55,
        notes: 'production reality — $100K setup amortized over 12mo, real FTE allocation, 25% throughput de-rate',
      },
    },

    // -----------------------------------------------------------------
    // Embedding model rates ($ per million tokens).
    // -----------------------------------------------------------------
    embeddings: {
      'text-embedding-3-small': { dollar_per_million_tokens: 0.02, dimensions: 1536, provider: 'OpenAI',    source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'text-embedding-3-large': { dollar_per_million_tokens: 0.13, dimensions: 3072, provider: 'OpenAI',    source_url: 'https://openai.com/api/pricing/', last_verified: '2026-04-25' },
      'cohere-embed-v3':        { dollar_per_million_tokens: 0.10, dimensions: 1024, provider: 'Cohere',    source_url: 'https://cohere.com/pricing',      last_verified: '2026-04-25' },
      'voyage-3':               { dollar_per_million_tokens: 0.06, dimensions: 1024, provider: 'Voyage AI', source_url: 'https://www.voyageai.com/pricing', last_verified: '2026-04-25' },
      'self-hosted-bge':        { dollar_per_million_tokens: 0.00, dimensions: 1024, provider: 'self',      source_url: '', last_verified: '2026-04-25', notes: 'self-hosted; cost lives in GPU/infra' },
    },

    // -----------------------------------------------------------------
    // Vector DBs.
    // -----------------------------------------------------------------
    vector_dbs: {
      'pinecone-serverless': {
        dollar_per_million_vectors_stored: 0.33,
        dollar_per_million_reads: 8.25,
        dollar_per_million_writes: 4.00,
        provider: 'Pinecone',
        source_url: 'https://www.pinecone.io/pricing/',
        last_verified: '2026-04-25',
      },
      'pinecone-pod-s1':         { monthly_flat: 70,  vector_capacity: 1_000_000, provider: 'Pinecone',  source_url: 'https://www.pinecone.io/pricing/', last_verified: '2026-04-25', notes: 'starter pod, 1M vectors' },
      'weaviate-managed-small':  { monthly_flat: 295, vector_capacity: 5_000_000, provider: 'Weaviate',  source_url: 'https://weaviate.io/pricing',      last_verified: '2026-04-25' },
      'pgvector-self':           { monthly_flat:  75, provider: 'self', notes: 'just the underlying RDS Postgres cost', source_url: '', last_verified: '2026-04-25' },
      'qdrant-cloud-small':      { monthly_flat: 200, vector_capacity: 5_000_000, provider: 'Qdrant',    source_url: 'https://qdrant.tech/pricing/',     last_verified: '2026-04-25' },
    },

    // -----------------------------------------------------------------
    // AWS cloud services — for traffic-scaled infra costs.
    // Govcloud column is approximate (varies per service ~25-40% over).
    // -----------------------------------------------------------------
    cloud_aws: {
      egress: {
        commercial_per_gb: 0.090,
        govcloud_per_gb:   0.155,
        source_url: 'https://aws.amazon.com/ec2/pricing/on-demand/',
        last_verified: '2026-04-25',
      },
      s3: {
        put_per_1k:                0.005,
        get_per_1k:                0.0004,
        storage_per_gb_month:      0.023,
        ia_storage_per_gb_month:   0.0125,
        glacier_per_gb_month:      0.004,
        glacier_deep_per_gb_month: 0.00099,
        source_url: 'https://aws.amazon.com/s3/pricing/',
        last_verified: '2026-04-25',
      },
      cloudwatch: {
        logs_ingest_per_gb:           0.50,
        logs_storage_per_gb_month:    0.03,
        custom_metric_per_month:      0.30,
        source_url: 'https://aws.amazon.com/cloudwatch/pricing/',
        last_verified: '2026-04-25',
      },
      rds_postgres: {
        // tier ladder — calculator picks the smallest tier that supports the QPS
        tiers: [
          { name: 'db.t3.medium',  hourly: 0.068, capable_qps:   50 },
          { name: 'db.m5.large',   hourly: 0.171, capable_qps:  200 },
          { name: 'db.m5.xlarge',  hourly: 0.342, capable_qps:  500 },
          { name: 'db.m5.2xlarge', hourly: 0.684, capable_qps: 1500 },
          { name: 'db.m5.4xlarge', hourly: 1.368, capable_qps: 4000 },
        ],
        source_url: 'https://aws.amazon.com/rds/postgresql/pricing/',
        last_verified: '2026-04-25',
      },
      nat_gateway: {
        hourly:                  0.045,
        data_processing_per_gb:  0.045,
        source_url: 'https://aws.amazon.com/vpc/pricing/',
        last_verified: '2026-04-25',
      },
      alb: {
        hourly:                  0.0225,
        lcu_per_hour:            0.008,
        source_url: 'https://aws.amazon.com/elasticloadbalancing/pricing/',
        last_verified: '2026-04-25',
      },
    },

    // -----------------------------------------------------------------
    // Personnel costs — annual base salary by role.
    // total_comp_multiplier converts base to fully-loaded cost
    // (benefits, payroll tax, equipment, overhead — typically 1.30×).
    // -----------------------------------------------------------------
    personnel: {
      mlops_engineer:    { annual_base: 180000, total_comp_multiplier: 1.30, notes: 'BLS + market premium, US' },
      prompt_engineer:   { annual_base: 150000, total_comp_multiplier: 1.30, notes: 'emerging role, market data thin' },
      eval_engineer:     { annual_base: 170000, total_comp_multiplier: 1.30, notes: 'overlaps with QA + data science' },
      security_reviewer: { annual_base: 175000, total_comp_multiplier: 1.30, notes: 'SecOps / compliance' },
      product_manager:   { annual_base: 160000, total_comp_multiplier: 1.30 },
      sre_oncall:        { annual_base: 195000, total_comp_multiplier: 1.30, notes: 'incident response + paging' },
      // Federal-specific roles
      ato_assessor:      { annual_base: 165000, total_comp_multiplier: 1.30, notes: 'federal ISSO equivalent' },
      contracting_officer: { annual_base: 130000, total_comp_multiplier: 1.30 },
    },

    // -----------------------------------------------------------------
    // Published cost benchmarks — real cited per-user, per-query, or
    // per-deployment numbers from public studies, vendor pricing pages,
    // earnings calls, and government reports. Use cases:
    //   - sanity-check the user's calc ("if you're 10× off the
    //     benchmark, something's wrong")
    //   - support procurement defenses ("our model says $X, similar
    //     federal deployments report $Y per Z published study")
    //
    // Each entry: human-readable + numeric for comparison + source URL
    // for verification. Scraper can periodically refresh the numbers
    // from the source URL; meanwhile users can edit in the UI.
    //
    // Comparison axes (pick the one most relevant to user's deployment):
    //   - dollar_per_user_per_month
    //   - dollar_per_query
    //   - dollar_per_seat_per_month
    //   - annual_total_for_org
    // -----------------------------------------------------------------
    benchmarks: {
      'chatgpt-enterprise': {
        category: 'Commercial · per-seat',
        name: 'ChatGPT Enterprise',
        description: 'OpenAI enterprise tier — unlimited GPT-5, longer context, admin controls',
        dollar_per_seat_per_month: 60,
        notes: 'List price; large customers negotiate down to ~$40-50/seat',
        source_url: 'https://openai.com/chatgpt/enterprise/',
        last_verified: '2026-04-25',
      },
      'microsoft-copilot-m365': {
        category: 'Commercial · per-seat',
        name: 'Microsoft Copilot for M365',
        description: 'Embedded AI across Word/Excel/Outlook/Teams',
        dollar_per_seat_per_month: 30,
        notes: 'Annual commitment; standalone Copilot Pro is $20/mo',
        source_url: 'https://www.microsoft.com/en-us/microsoft-365/business/copilot',
        last_verified: '2026-04-25',
      },
      'github-copilot-enterprise': {
        category: 'Commercial · per-seat',
        name: 'GitHub Copilot Enterprise',
        description: 'AI pair programming + repo Q&A',
        dollar_per_seat_per_month: 39,
        notes: 'Business tier $19/seat; Enterprise adds repo indexing',
        source_url: 'https://github.com/features/copilot/plans',
        last_verified: '2026-04-25',
      },
      'salesforce-agentforce': {
        category: 'Commercial · per-conversation',
        name: 'Salesforce Agentforce',
        description: 'Autonomous customer service / sales agents',
        dollar_per_conversation: 2.00,
        notes: 'Announced Sept 2024; outcome-based pricing',
        source_url: 'https://www.salesforce.com/agentforce/pricing/',
        last_verified: '2026-04-25',
      },
      'klarna-ai-assistant': {
        category: 'Commercial · case study',
        name: 'Klarna AI customer service',
        description: 'Handles 2/3 of customer service queries; equivalent to 700 FTE',
        annual_savings_estimate: 40000000,
        case_study_user_count: 150000000,  // 150M monthly users
        notes: 'Klarna stated $40M annual savings; AI cost not publicly disclosed but estimated 5-10% of savings',
        source_url: 'https://www.klarna.com/international/press/klarnas-ai-assistant-handles-two-thirds-of-customer-service-chats-in-its-first-month/',
        last_verified: '2026-04-25',
      },
      'slack-ai': {
        category: 'Commercial · add-on',
        name: 'Slack AI (Enterprise+)',
        description: 'Channel summaries, search, recap',
        dollar_per_seat_per_month: 10,
        notes: 'Add-on to Business+ ($15/seat) or Enterprise+ tiers',
        source_url: 'https://slack.com/intl/en-gb/help/articles/14116600559123-Slack-AI-billing-and-payment',
        last_verified: '2026-04-25',
      },
      'anthropic-claude-enterprise': {
        category: 'Commercial · per-seat',
        name: 'Claude Enterprise (Anthropic)',
        description: 'Team plan w/ Projects, longer context, SOC 2',
        dollar_per_seat_per_month: 30,
        notes: 'Team tier $30/seat (annual); Enterprise custom-priced',
        source_url: 'https://www.anthropic.com/pricing',
        last_verified: '2026-04-25',
      },
      'gao-federal-ai-fy24': {
        category: 'Federal · GAO report',
        name: 'GAO Federal AI Spending FY24',
        description: 'Aggregate federal AI spending across agencies',
        federal_total_estimate: 1700000000,  // $1.7B aggregate
        notes: 'Average federal AI program: $5M-$15M/yr; large IRS/SSA pilots up to $50M',
        source_url: 'https://www.gao.gov/products/gao-25-107237',
        last_verified: '2026-04-25',
      },
      'a16z-llm-cost-of-goods': {
        category: 'Industry · analysis',
        name: 'a16z: LLM startup COGS',
        description: 'Series A AI startups spend 50-80% of revenue on inference',
        cogs_pct_of_revenue: 0.65,
        notes: 'Across 30+ portfolio companies; trending down as models cheapen',
        source_url: 'https://a16z.com/the-cost-of-large-language-models/',
        last_verified: '2026-04-25',
      },
      'mit-sloan-ai-roi-2024': {
        category: 'Industry · academic',
        name: 'MIT Sloan: AI ROI Study',
        description: 'Most enterprise AI projects do not pay back for 2-3 years',
        median_payback_months: 30,
        notes: '~80% of pilots fail to reach production at sustainable cost',
        source_url: 'https://sloanreview.mit.edu/projects/the-state-of-ai-in-the-workplace-2024/',
        last_verified: '2026-04-25',
      },
      'public-chatbot-typical': {
        category: 'Commercial · industry average',
        name: 'Public-facing chatbot (commercial cloud)',
        description: 'Industry-average per-query cost across SaaS deployments',
        dollar_per_query: 0.05,  // mid of $0.03-$0.10 range
        dollar_per_user_per_month: 0.50,  // ~10 q/MAU/mo × $0.05
        notes: 'Wide variance based on RAG corpus + answer length; range $0.01-$0.30',
        source_url: '',
        last_verified: '2026-04-25',
      },
      'enterprise-internal-ai-typical': {
        category: 'Enterprise · industry average',
        name: 'Internal staff AI assistant (enterprise)',
        description: 'Mid-market industry-average per-employee cost',
        dollar_per_user_per_month: 80,
        notes: 'Range $50-$200/user; varies with depth of integration',
        source_url: '',
        last_verified: '2026-04-25',
      },
      'federal-rfp-typical-1m-mau': {
        category: 'Federal · procurement target',
        name: 'Federal public-facing AI agent (typical)',
        description: 'Reasonable target for ~1M MAU federal deployment with FedRAMP Mod',
        annual_budget_estimate: 5000000,
        annual_min: 2000000,
        annual_max: 12000000,
        notes: 'Includes API + ATO + personnel + audit; assumes mid-procurement sophistication',
        source_url: '',
        last_verified: '2026-04-25',
      },
      // ── Federal-specific cost studies ────────────────────────────────
      'gao-irs-direct-file': {
        category: 'Federal · IRS pilot',
        name: 'GAO: IRS Direct File AI components',
        description: 'IRS Direct File pilot used AI for tax-form Q&A; FY24 cost reporting',
        annual_total_for_org: 13000000,
        notes: 'Combined IT + AI build; only ~10-15% attributable to AI per GAO breakdown',
        source_url: 'https://www.gao.gov/products/gao-25-107237',
        last_verified: '2026-04-25',
      },
      'dod-jadc2-ai': {
        category: 'Federal · DoD',
        name: 'DoD JADC2 AI components',
        description: 'Joint All-Domain Command & Control AI/ML budget line — FY25 enacted',
        annual_total_for_org: 1400000000,
        notes: 'AI-specific carve-outs across Army, Navy, Air Force; multi-vendor (Anthropic, Palantir, OpenAI)',
        source_url: 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/fy2025/fy2025_Budget_Request_Overview_Book.pdf',
        last_verified: '2026-04-25',
      },
      'anthropic-palantir-dod': {
        category: 'Federal · DoD partnership',
        name: 'Anthropic + Palantir DoD partnership',
        description: 'Public deal: Claude for classified workloads via Palantir AIP',
        annual_total_for_org: 200000000,
        notes: 'Estimated based on contract awards; Anthropic share not publicly disclosed',
        source_url: 'https://www.palantir.com/newsroom/press-releases/anthropic-aws-and-palantir-partnership-to-bring-claude-models-to-us-intelligence-and-defense-agencies/',
        last_verified: '2026-04-25',
      },
      // ── Developer / coding tools ────────────────────────────────────
      'replit-ghostwriter': {
        category: 'Commercial · developer tool',
        name: 'Replit Core (Ghostwriter)',
        description: 'AI coding + cloud IDE',
        dollar_per_seat_per_month: 20,
        notes: 'Includes inference credits worth roughly $25-50/mo of API usage',
        source_url: 'https://replit.com/pricing',
        last_verified: '2026-04-25',
      },
      'cursor-pro': {
        category: 'Commercial · developer tool',
        name: 'Cursor Pro',
        description: 'AI-first code editor (VS Code fork)',
        dollar_per_seat_per_month: 20,
        notes: 'Business tier $40/seat; Cursor pays inference cost from this',
        source_url: 'https://cursor.com/pricing',
        last_verified: '2026-04-25',
      },
      'codeium-enterprise': {
        category: 'Commercial · developer tool',
        name: 'Codeium / Windsurf Enterprise',
        description: 'Enterprise IDE AI with self-host option',
        dollar_per_seat_per_month: 35,
        notes: 'Cited range $30-50/seat for enterprise tier',
        source_url: 'https://codeium.com/pricing',
        last_verified: '2026-04-25',
      },
      'perplexity-pro': {
        category: 'Commercial · search assistant',
        name: 'Perplexity Pro',
        description: 'AI-powered search with citations',
        dollar_per_seat_per_month: 20,
        notes: 'Enterprise tier $40/seat; includes Pro Search + file uploads',
        source_url: 'https://www.perplexity.ai/pro',
        last_verified: '2026-04-25',
      },
      // ── SaaS AI add-ons ─────────────────────────────────────────────
      'notion-ai': {
        category: 'Commercial · SaaS add-on',
        name: 'Notion AI',
        description: 'AI features inside Notion: writing, summaries, Q&A',
        dollar_per_seat_per_month: 10,
        notes: 'Added to Plus/Business/Enterprise tiers',
        source_url: 'https://www.notion.com/help/notion-ai-faqs',
        last_verified: '2026-04-25',
      },
      'snowflake-cortex': {
        category: 'Commercial · data platform',
        name: 'Snowflake Cortex (LLM functions)',
        description: 'Usage-based AI in SQL — credits per 1M tokens',
        dollar_per_query: 0.012,
        notes: 'Cortex credits: ~$2/M tokens for Llama 3 70B equivalent on-platform',
        source_url: 'https://www.snowflake.com/en/data-cloud/cortex/',
        last_verified: '2026-04-25',
      },
      'databricks-mosaic': {
        category: 'Commercial · data platform',
        name: 'Databricks Mosaic AI',
        description: 'Foundation model API + training on Databricks',
        dollar_per_query: 0.015,
        notes: 'DBU consumption-based; effective $/query varies by model',
        source_url: 'https://www.databricks.com/product/pricing/foundation-models',
        last_verified: '2026-04-25',
      },
      // ── Industry-wide ───────────────────────────────────────────────
      'stanford-ai-index-2024': {
        category: 'Industry · academic',
        name: 'Stanford HAI: AI Index 2024',
        description: 'Government AI spending up 18% YoY; private investment up to $189B globally',
        federal_total_estimate: 1700000000,
        notes: 'US federal AI contract spend +1900% from 2017-2023',
        source_url: 'https://aiindex.stanford.edu/report/',
        last_verified: '2026-04-25',
      },
      'cb-insights-genai-revenue-2024': {
        category: 'Industry · market research',
        name: 'CB Insights: Enterprise GenAI Spending 2024',
        description: 'Global enterprise GenAI spend tracked',
        federal_total_estimate: 32000000000,  // ~$32B globally
        notes: 'Up from ~$8B in 2023; ~30% on inference, 25% on data labeling, rest on tools/personnel',
        source_url: 'https://www.cbinsights.com/research/generative-ai-bets-corporates/',
        last_verified: '2026-04-25',
      },
      'a16z-llmops-survey-2024': {
        category: 'Industry · survey',
        name: 'a16z: 16 Changes in How Enterprises Build with AI',
        description: '70+ Fortune 500 enterprises surveyed on GenAI spend / build patterns',
        cogs_pct_of_revenue: 0.35,  // typical AI line as % of total IT
        notes: 'Average enterprise GenAI budget for 2024: $18M (up from $7M in 2023)',
        source_url: 'https://a16z.com/generative-ai-enterprise-2024/',
        last_verified: '2026-04-25',
      },
    },

    // -----------------------------------------------------------------
    // ATO (Authority to Operate) — federal compliance overhead.
    // -----------------------------------------------------------------
    ato: {
      none:             { upfront: 0,      annual_continuous_monitoring: 0,      assessment_cycle_months: 0,  notes: 'commercial — N/A' },
      fedramp_li_saas:  { upfront: 100000, annual_continuous_monitoring: 30000,  assessment_cycle_months: 12, notes: 'FedRAMP Low Impact SaaS' },
      fedramp_low:      { upfront: 75000,  annual_continuous_monitoring: 25000,  assessment_cycle_months: 12 },
      fedramp_moderate: { upfront: 250000, annual_continuous_monitoring: 50000,  assessment_cycle_months: 12, notes: 'most common federal tier' },
      fedramp_high:     { upfront: 500000, annual_continuous_monitoring: 100000, assessment_cycle_months: 12 },
      il4:              { upfront: 350000, annual_continuous_monitoring: 75000,  assessment_cycle_months: 12, notes: 'DoD impact level 4 (CUI)' },
      il5:              { upfront: 600000, annual_continuous_monitoring: 120000, assessment_cycle_months: 12, notes: 'DoD impact level 5 (NSS)' },
    },

    // -----------------------------------------------------------------
    // Helper: resolve a price entry by category + key.
    // Workload override layer is added by the engine; this just returns
    // the default if no override exists.
    // -----------------------------------------------------------------
  };

  // Helper: get a value, optionally overridden by a workload object.
  // workload.prices?.<category>?.<key> takes precedence.
  function getPrice(category, key, workload) {
    if (workload && workload.prices && workload.prices[category] && workload.prices[category][key] != null) {
      return workload.prices[category][key];
    }
    return Prices[category] ? Prices[category][key] : undefined;
  }

  // Helper: list all keys in a category (for UI rendering).
  function listKeys(category) {
    return Prices[category] ? Object.keys(Prices[category]).filter(k => k !== 'meta') : [];
  }

  // Helper: pick the smallest RDS tier that can handle a given QPS.
  function pickRdsTier(qps) {
    const tiers = Prices.cloud_aws.rds_postgres.tiers;
    for (const t of tiers) {
      if (qps <= t.capable_qps) return t;
    }
    return tiers[tiers.length - 1];
  }

  Prices.getPrice = getPrice;
  Prices.listKeys = listKeys;
  Prices.pickRdsTier = pickRdsTier;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Prices;
  } else {
    root.Prices = Prices;
  }
})(typeof window !== 'undefined' ? window : this);
