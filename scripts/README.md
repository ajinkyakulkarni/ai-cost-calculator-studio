# scripts/

Maintenance utilities for the cost calculator price book.

## refresh-prices.js — periodic price refresher

Walks every priced entry in `lib/prices.js` that has a `source_url`,
fetches the page, runs the text through an LLM extractor, and diffs
the extracted numbers against the current values. By default just
prints a diff; `--apply` writes the proposed changes back.

The script edits values **in place via targeted regex replacements**, so
comments, ordering, and formatting in `prices.js` are preserved. It will
never add or remove entries — those are intentional human actions.

### Setup

```bash
export OPENAI_API_KEY=sk-...
cd cost-calculator-studio
node scripts/refresh-prices.js --help    # see flags below
```

Requires Node 18+ (uses native `fetch`).

### Modes

```bash
# Dry-run, all categories (default — just prints what would change)
node scripts/refresh-prices.js

# Write proposed changes back to lib/prices.js
node scripts/refresh-prices.js --apply

# Limit to a single category
node scripts/refresh-prices.js --category=llm_models

# One specific entry
node scripts/refresh-prices.js --category=llm_models --key=gpt-5

# Test against the first 3 entries
node scripts/refresh-prices.js --limit=3

# Use a different OpenAI model for extraction (default: gpt-4o-mini)
node scripts/refresh-prices.js --model=gpt-5-mini

# Skip fetch + LLM, useful for smoke-testing the iterator
node scripts/refresh-prices.js --offline

# Print extraction evidence quotes
node scripts/refresh-prices.js --verbose
```

### Recommended workflow

1. Run dry-run: `node scripts/refresh-prices.js > diff.txt`
2. Inspect `diff.txt` — flag anything that looks wrong (>50% drift, unit
   confusion, etc.)
3. If a specific entry looks wrong, narrow with
   `--category=X --key=Y --verbose` to see the LLM's evidence quote.
4. Apply: `node scripts/refresh-prices.js --apply`
5. `git diff lib/prices.js` and review. Commit if good.

### What it refreshes

The script will only update fields in the `NUMERIC_FIELDS` allow-list at
the top of `refresh-prices.js`. To allow refreshing a new field, add its
name there. The `notes`, `name`, `description`, and `source_url` fields
are never auto-edited — those need human review.

### What it skips

- Entries with no `source_url` (industry averages, internal estimates).
- The `meta` block, `self_host_cost_modes` (no URLs), and helper
  functions (`getPrice`, `listKeys`, `pickRdsTier`).

### How extraction works

For each entry, the script:
1. Fetches the URL with a basic User-Agent.
2. Strips HTML to plain text (cap 30K chars).
3. Sends a system prompt + the entry's current numeric values + the page
   text to OpenAI with `response_format: json_object`.
4. The LLM returns `{ "fields": { "<field>": <new_number> }, "evidence": "<quote>" }`.
5. Only fields in the allow-list with `typeof v === 'number'` are kept.
6. Diff vs current; if changed, either print (dry-run) or write.

### Failure modes

- **Page behind a paywall / requires JS rendering** — fetch returns
  HTML that won't have the price text. LLM returns no fields. Logged
  as "no change". Manually update those entries.
- **Pricing page restructured** — LLM may misread. Always dry-run
  first; if the diff is suspicious (large drift, odd units), drop the
  entry from this run with `--category=` filter and update by hand.
- **OpenAI rate limiting** — script is sequential; no built-in retry.
  For a large run, pre-filter with `--category=` and run in chunks.

## verify-aws-instances.js — AWS GPU price refresher (no LLM)

`refresh-prices.js` works on plain HTML pricing pages but stalls on AWS
because:

- `aws.amazon.com/ec2/instance-types/<family>/` pages are spec sheets,
  not pricing — they don't carry hourly rates at all.
- `aws.amazon.com/ec2/pricing/on-demand/` is a JS-heavy SPA that pulls
  prices from a JSON API at runtime; raw HTML scraping returns mostly
  empty shells.
- The official AWS Price List Bulk API
  (`pricing.us-east-1.amazonaws.com`) is too heavy for casual use:
  the EC2 us-east-1 file alone is ~470 MB.

This script side-steps the problem by using
`https://instances.vantage.sh/aws/ec2/<instance-type>` — a public mirror
of AWS pricing with plain HTML pages that have the on-demand hourly rate
inline. Regex-extracted, no LLM call, no token cost.

```bash
node scripts/verify-aws-instances.js          # dry-run
node scripts/verify-aws-instances.js --apply  # write changes back
node scripts/verify-aws-instances.js --verbose
```

It also runs a sanity check: if the scraped price is implausibly low
relative to the current entry (e.g. $1.84 for an 8-GPU instance), the
drift is flagged "⚠ SUSPICIOUS — manual verify" and excluded from
`--apply`. Vantage occasionally has mislabeled markup on newer instance
types where the "On Demand" label is paired with a Spot or per-GPU rate.

### Other providers

- **Azure** has a public Retail Prices API
  (`https://prices.azure.com/api/retail/prices`) returning JSON. A
  parallel `verify-azure.js` script following the same pattern is the
  natural extension.
- **GCP** has a Cloud Billing Catalog API but it requires a GCP service
  account; not currently scraped.
- **OpenAI / Anthropic / GitHub Copilot / Cursor / etc.** all use plain
  HTML pricing pages and work via `refresh-prices.js` directly.

## test-apply.js

Unit-test for the in-place regex replacement logic in `refresh-prices.js`.
Run with:

```bash
node scripts/test-apply.js
```

Covers: flat field edits, nested keys (`federal_multipliers.fedramp.moderate`),
sub-objects (`cloud_aws.s3`), benchmark entries, missing-key errors,
and `last_verified` bumping. Should pass with `All tests passed.`
