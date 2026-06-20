/* archetype-growth.js — intra-cycle context-growth model (JS port of
 * python/costcalc/growth.py).
 *
 * Turns a per-turn description of a cycle into the cumulative {input, cached,
 * output} token profile the archetype helper consumes. Input grows each turn
 * as conversation history + tool results accumulate (the model re-sends the
 * full running context every turn). Used by the panel's "build from turns"
 * editor so users can construct an archetype profile from per-turn assumptions
 * instead of guessing cumulative totals.
 *
 * cycleFromTurns(base, steps, cacheRatio) — steps: [[added, output], ...]
 * cycleUniform(base, turns, addedPerTurn, outputPerTurn, cacheRatio)
 *
 * Pure; dual-exported (browser global ArchetypeGrowth + CommonJS for tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArchetypeGrowth = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // Empirical cache share for a multi-turn accumulating cycle, from the doc's
  // Multi-source numbers (184,917 cached / 233,498 input).
  var DOC_CACHE_RATIO = 184917 / 233498; // 0.79195...

  function cycleFromTurns(baseTokens, steps, cacheRatio) {
    if (cacheRatio == null) cacheRatio = DOC_CACHE_RATIO;
    if (!(cacheRatio >= 0 && cacheRatio <= 1)) {
      throw new Error('cacheRatio must be in [0,1], got ' + cacheRatio);
    }
    var runningHistory = 0, cumInput = 0, cumOutput = 0, prevOutput = 0;
    for (var i = 0; i < steps.length; i++) {
      var added = +steps[i][0], out = +steps[i][1];
      runningHistory += prevOutput + added;
      cumInput += baseTokens + runningHistory;
      cumOutput += out;
      prevOutput = out;
    }
    return {
      input_tokens: Math.round(cumInput),
      cached_tokens: Math.round(cumInput * cacheRatio),
      output_tokens: Math.round(cumOutput),
      turns: steps.length,
    };
  }

  function cycleUniform(baseTokens, turns, addedPerTurn, outputPerTurn, cacheRatio) {
    var steps = [];
    for (var i = 0; i < (turns | 0); i++) steps.push([+addedPerTurn, +outputPerTurn]);
    return cycleFromTurns(baseTokens, steps, cacheRatio);
  }

  return { cycleFromTurns: cycleFromTurns, cycleUniform: cycleUniform, DOC_CACHE_RATIO: DOC_CACHE_RATIO };
});
