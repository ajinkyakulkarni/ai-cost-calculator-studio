#!/usr/bin/env bash
# Reproduce the v0.1.0 pilot calibration (9 scenarios, 174 LLM calls)
# referenced in Tables 2 and 3 of the paper.
#
# Run from the root of github.com/ajinkyakulkarni/ai-cost-calculator-studio
# at tag v0.2.0 with provider API keys configured in the environment.
#
# CLI takes one scenario file at a time, so we loop. smoke-test.yml
# (plumbing check) and public-geospatial-react.yml (the May-2026 re-calibration,
# reproduced separately) are intentionally excluded.

set -euo pipefail

PILOT=(
  cached-pipeline
  cached-pipeline-anthropic
  data-discovery
  data-discovery-gpt52
  long-chat
  multi-stage-research
  parallel-fan-out
  streaming-pipeline
  tool-chain
)

for s in "${PILOT[@]}"; do
  agent-cost-bench run "bench/scenarios/${s}.yml" --yes
done
