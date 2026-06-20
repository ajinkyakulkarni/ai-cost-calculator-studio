/* archetype-math.js — cost for variable-pipeline agents via query archetypes.
 *
 * Faithful JS port of python/costcalc/archetype.py — see
 * python/docs/archetype-cost-spec.md. PURE: every input is a parameter,
 * no DOM. Dual-exported (browser global `ArchetypeMath` + CommonJS) so it
 * powers both archetype.html and the node parity test
 * (scripts/test-archetype-math.mjs, part of `npm test`).
 *
 * Pricing reuses the same per-million input/cached/output rates + tier
 * multiplier the engine uses, so numbers stay consistent with the calc.
 *
 * Models an agent whose queries fan out across archetypes with genuinely
 * different absolute token profiles (each carries its own cumulative
 * {input, cached, output}); prices per cycle, weights by mix, rolls up to
 * monthly with low/high bands. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();           // Node (parity test)
  } else {
    root.ArchetypeMath = factory();       // Browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Cost of one cycle. Mirrors llm.py: (fresh·in + cached·cached + out·out)
  // / 1e6 × tier_multiplier.
  function cycleCost(input, cached, output, rates, tierMult) {
    const fresh = input - cached;
    return (
      fresh * rates.input_per_million +
      cached * rates.cached_per_million +
      output * rates.output_per_million
    ) / 1e6 * tierMult;
  }

  // Scale a profile's token counts by `factor`, holding the cached ratio
  // constant so a band still satisfies cached ≤ input.
  function scaled(arch, factor) {
    return {
      input: Number(arch.input_tokens) * factor,
      cached: Number(arch.cached_tokens) * factor,
      output: Number(arch.output_tokens) * factor,
    };
  }

  /* archetypeCost(archetypes, opts)
   *   opts: { model, tier, cyclesPerMonth, rateCards, tierMultipliers }
   * rateCards / tierMultipliers default to window.Prices-style maps the
   * caller passes (no global lookup here — keeps it pure & testable).
   * Returns the same shape as the Python helper. Throws on bad input. */
  function archetypeCost(archetypes, opts) {
    opts = opts || {};
    const model = opts.model || 'gpt-5.4';
    const tier = opts.tier || 'standard';
    const cyclesPerMonth = Number(opts.cyclesPerMonth) || 0;
    const cards = opts.rateCards || {};
    const tiers = opts.tierMultipliers || {};

    if (!Array.isArray(archetypes) || archetypes.length === 0) {
      throw new Error('archetypeCost: archetypes list is empty');
    }
    const rates = cards[model];
    if (!rates) throw new Error('archetypeCost: unknown model ' + model);
    if (!(tier in tiers)) throw new Error('archetypeCost: unknown tier ' + tier);
    const tierMult = Number(tiers[tier]);

    let sharesSum = 0;
    archetypes.forEach(function (a) {
      if (Number(a.cached_tokens) > Number(a.input_tokens)) {
        throw new Error(
          'archetype ' + (a.name || '?') + ': cached_tokens (' + a.cached_tokens +
          ') > input_tokens (' + a.input_tokens + ') — cached is a subset of input.'
        );
      }
      sharesSum += Number(a.share) || 0;
    });
    const norm = sharesSum > 0 ? sharesSum : 1;

    const rows = [];
    let blendedCycle = 0, blendedLow = 0, blendedHigh = 0;
    archetypes.forEach(function (a) {
      const share = Number(a.share) || 0;
      const shareN = share / norm;
      const exp = scaled(a, 1.0);
      const cost = cycleCost(exp.input, exp.cached, exp.output, rates, tierMult);

      const lo = scaled(a, a.low_factor != null ? Number(a.low_factor) : 1.0);
      const hi = scaled(a, a.high_factor != null ? Number(a.high_factor) : 1.0);
      const costLo = cycleCost(lo.input, lo.cached, lo.output, rates, tierMult);
      const costHi = cycleCost(hi.input, hi.cached, hi.output, rates, tierMult);

      rows.push({
        name: a.name || '?',
        share: share,
        share_normalized: shareN,
        tool_calls: a.tool_calls != null ? a.tool_calls : null,
        turns: a.turns != null ? a.turns : null,
        input: exp.input, cached: exp.cached, output: exp.output,
        fresh: exp.input - exp.cached,
        cost_cycle: cost,
        cost_cycle_low: costLo,
        cost_cycle_high: costHi,
        monthly: shareN * cost * cyclesPerMonth,
      });
      blendedCycle += shareN * cost;
      blendedLow += shareN * costLo;
      blendedHigh += shareN * costHi;
    });

    return {
      model: model, tier: tier, tier_multiplier: tierMult,
      cycles_per_month: cyclesPerMonth, shares_sum_raw: sharesSum,
      archetypes: rows,
      blended: {
        cost_per_cycle: blendedCycle,
        monthly: blendedCycle * cyclesPerMonth,
        monthly_low: blendedLow * cyclesPerMonth,
        monthly_high: blendedHigh * cyclesPerMonth,
      },
    };
  }

  return { archetypeCost: archetypeCost, cycleCost: cycleCost };
});
