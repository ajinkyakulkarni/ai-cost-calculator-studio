# Cost Calculator Studio

> A toolkit for building parameterized AI-agent cost calculators.
> Define your workload as JSON; emit a single-file HTML calculator.
> Like draw.io, but for LLM cost models.

This repository turns the per-program cost-modeling work originally
done for NASA's Earth Information Explorer (EIE) into a generalizable
toolkit. Federal agencies, AI startups, and research programs can use
it to produce procurement-grade cost estimates for their own AI agent
deployments without rebuilding the calculator math from scratch.

## What's in here

```
cost-calculator-studio/
├── README.md                        # this file
├── schema/
│   └── workload-v1.schema.json      # JSON Schema for a "workload spec"
├── lib/
│   ├── cost-engine.js               # parameterized JS cost engine
│   └── excel-generator.py           # builds .xlsx workbook from a workload
├── templates/
│   └── calculator-template.html     # HTML calculator with template slots
├── studio/                          # in-browser authoring app
│   ├── index.html                   # form-based editor + live preview
│   ├── app.js
│   └── styles.css
├── examples/                        # 5 pre-built workload specs
│   ├── nasa-eie.json
│   ├── nih-clinical-trials.json
│   ├── doe-grid-modeling.json
│   ├── noaa-storm-tracking.json
│   └── generic-startup-chatbot.json
├── outputs/                         # generated calculator HTML files
│   └── README.md
├── excel-template/
│   ├── cost-model.xlsx              # pre-generated sophisticated workbook
│   └── README.md                    # how to use the spreadsheet
└── docs/
    ├── getting-started.md           # 10-minute walkthrough
    ├── workload-schema.md           # detailed schema documentation
    ├── publishing.md                # how to deploy your calculator
    ├── methodology.md               # the math, in plain language
    └── faq.md
```

## Three ways to use this toolkit

**1. Build a calculator without writing code.**
Open `studio/index.html` in a browser. Fill in the form fields for
your traffic shapes, segments, models, and verification configuration.
Live-preview the resulting calculator. Click *Generate* to download a
single self-contained HTML file you can host anywhere.

**2. Define your workload as JSON, then run the generator.**
Copy any file from `examples/`, edit it for your program, and run
the generator script to emit a calculator HTML. Suitable for CI
pipelines and reproducible procurement reviews.

**3. Use the Excel template.**
Open `excel-template/cost-model.xlsx`. Paste your workload parameters
into the input sheet. Read off the cost comparison from the output
sheet. Suitable for budget reviews where Excel is the procurement
language.

## Why this exists

A handful of public LLM cost calculators exist
([llm-prices.com](https://www.llm-prices.com/),
[Curlscape](https://curlscape.com/tools/llm-pricing-calculator),
[LiteLLM](https://docs.litellm.ai/docs/proxy/pricing_calculator),
many others), but none of them combine the dimensions a federal AI
procurement actually requires:

- Workload-specific traffic shapes (not "one query")
- Segment-aware prompt-cache modeling
- Verification pipeline overhead (FactReasoner-style)
- Daily-spend-cap refusal accounting
- Capacity-scaled self-host comparison with
  optimistic-vs-realistic toggle
- A same-budget fair comparison row that resolves the
  apples-to-oranges trap pervasive in API-vs-self-host analyses

The methodology is documented in the companion paper
*Cost Modeling for Federal AI-Agent Deployment: A Worked Example with
NASA's Earth Information Explorer*. This toolkit is the
parameterized, generalizable form of the calculator built for that
paper.

## Quick start

```bash
# Open the studio in your default browser
open studio/index.html

# Or generate a calculator from an existing example
node lib/cost-engine.js examples/nasa-eie.json > outputs/nasa-eie.html

# Or generate the Excel workbook
python3 lib/excel-generator.py examples/nasa-eie.json -o my-calc.xlsx
```

## Status

**Active. Initial release May 2026.** APIs are 0.x and may change.
The JSON schema is versioned (`workload-v1`); breaking changes will
bump the major version.

## License

MIT. See `LICENSE`.

## Citing

If you use this toolkit in published work or in a procurement
document, please cite the methodology paper:

```bibtex
@misc{kulkarni2026cost,
  author = {Kulkarni, Ajinkya},
  title  = {Cost Modeling for Federal {AI}-Agent Deployment:
            A Worked Example with {NASA}'s Earth Information Explorer},
  year   = {2026},
  url    = {https://github.com/ajinkya-org/work-productivity}
}
```

## Related work

- [CEBench (arXiv:2407.12797)](https://arxiv.org/abs/2407.12797) — a
  benchmarking toolkit for the cost-effectiveness of LLM pipelines.
  Complementary: CEBench produces empirical throughput numbers that a
  calculator like this one consumes.
- [A Cost-Benefit Analysis of On-Premise LLM Deployment
  (arXiv:2509.18101)](https://arxiv.org/abs/2509.18101) — closest
  academic companion. They estimate a single break-even point; we
  model the full curve.
- [Demystifying Cost-Efficiency in LLM Serving over Heterogeneous
  GPUs (arXiv:2502.00722)](https://arxiv.org/abs/2502.00722) —
  cost-efficient mixed-fleet scheduling.
- [TokenPowerBench (arXiv:2512.03024)](https://arxiv.org/abs/2512.03024)
  — power-consumption methodology.
- [FedRAMP AI prioritization](https://www.fedramp.gov/ai/) and the
  [GSA + NIST partnership](https://www.gsa.gov/about-us/newsroom/news-releases/gsa-and-nist-partner-to-boost-ai-evaluation-science-in-federal-procurement-03182026)
  for the federal procurement context this toolkit plugs into.
