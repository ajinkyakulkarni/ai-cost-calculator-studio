/* archetype-panel.js — the archetype cost UI, as a mountable widget.
 *
 * Owns ALL its own markup so it can drop into any container: the
 * standalone archetype.html AND an inline section of the main calc both
 * call ArchetypePanel.mount(rootEl, opts) — one UI, no duplication.
 *
 * Pure presentation; the math is window.ArchetypeMath (archetype-math.js,
 * itself a port of python/costcalc/archetype.py). Reads rates from the
 * price book passed in opts.prices (window.Prices in the browser).
 *
 * mount(rootEl, { prices, archetypes, scoped }) → { recompute }
 *   prices     : Prices-like object with .llm_models + .tier_multipliers
 *   archetypes : initial archetype set (defaults to the EIE example)
 *   scoped     : if true, inject a <style> with panel-scoped CSS (used by
 *                the inline calc mount, which doesn't share archetype.html's
 *                stylesheet). The standalone page passes its own CSS.
 */
(function (root) {
  'use strict';

  // EIE new-direction archetype set (mirrors python/examples/eie-new-direction.json).
  var EIE = [
    {name:'Simple', share:0.6, tool_calls:6, turns:6, input_tokens:80000, cached_tokens:70000, output_tokens:600, low_factor:0.8, high_factor:1.3},
    {name:'Multi-source', share:0.3, tool_calls:8, turns:11, input_tokens:233498, cached_tokens:184917, output_tokens:885, low_factor:0.8, high_factor:1.4},
    {name:'Planning+routing', share:0.1, tool_calls:13, turns:13, input_tokens:360938, cached_tokens:285842, output_tokens:3115, low_factor:0.6, high_factor:1.8},
  ];

  var FIELDS = [
    ['share','share'], ['tool_calls','int'], ['turns','int'],
    ['input_tokens','int'], ['cached_tokens','int'], ['output_tokens','int'],
    ['low_factor','f'], ['high_factor','f'],
  ];

  var SCOPED_CSS = ''
    + '.apz{font-size:13px;color:#3a4a62}'
    + '.apz-controls{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}'
    + '.apz-controls label{display:flex;flex-direction:column;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#8a96a8;gap:4px}'
    + '.apz-controls select,.apz-controls input{font:inherit;font-size:13px;padding:6px 9px;border:1px solid #dde4ee;border-radius:6px;background:#fff;color:#14213d}'
    + '.apz-controls input{width:120px;font-family:monospace}'
    + '.apz table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dde4ee;border-radius:8px;overflow:hidden;font-size:12.5px}'
    + '.apz th,.apz td{padding:7px 8px;text-align:right;border-bottom:1px solid #dde4ee}'
    + '.apz th{background:#eef3fa;font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;color:#3a4a62;font-weight:700;white-space:nowrap}'
    + '.apz th:first-child,.apz td:first-child{text-align:left}'
    + '.apz td input{width:100%;font:inherit;font-size:12px;font-family:monospace;border:1px solid transparent;border-radius:4px;padding:3px 5px;text-align:right;background:transparent;color:#14213d}'
    + '.apz td input:hover{border-color:#dde4ee}'
    + '.apz td input:focus{border-color:#1e5fc9;background:#fff;outline:none}'
    + '.apz td.name input{text-align:left;font-family:inherit}'
    + '.apz td.calc{font-family:monospace;color:#0B3D91}'
    + '.apz td.calc .band{display:block;font-size:10px;color:#8a96a8}'
    + '.apz tr.blended td{border-top:2px solid #1e5fc9;font-weight:700;background:#f0f6ff;font-size:13px}'
    + '.apz .row-del{cursor:pointer;color:#8a96a8;border:none;background:none;font-size:15px}'
    + '.apz .row-del:hover{color:#c62828}'
    + '.apz-btns{margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}'
    + '.apz-btns button{font-size:12px;padding:7px 13px;border:1px solid #dde4ee;background:#fff;border-radius:6px;cursor:pointer;color:#3a4a62}'
    + '.apz-btns button:hover{border-color:#1e5fc9;color:#1e5fc9}'
    + '.apz-btns button.primary{background:#0B3D91;border-color:#0B3D91;color:#fff}'
    + '.apz-btns .warn{font-size:11.5px;color:#b26a00}'
    + '.apz-hl{margin-top:18px;background:#fff;border:1px solid #dde4ee;border-radius:8px;padding:15px 20px;display:flex;gap:28px;flex-wrap:wrap;align-items:baseline}'
    + '.apz-hl .big{font-family:monospace;font-size:30px;font-weight:800;color:#0B3D91}'
    + '.apz-hl .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8a96a8;display:block;margin-bottom:3px}'
    + '.apz-hl .range{font-family:monospace;font-size:15px;color:#3a4a62}'
    + '.apz-err{color:#c62828;font-size:12.5px;margin-top:8px;font-family:monospace}';

  function mount(rootEl, opts) {
    opts = opts || {};
    var prices = opts.prices || (typeof window !== 'undefined' ? window.Prices : null) || {};
    var Math_ = (typeof window !== 'undefined' ? window.ArchetypeMath : null) || root.ArchetypeMath;
    if (!Math_) throw new Error('ArchetypePanel.mount: ArchetypeMath not loaded');

    var rateCards = prices.llm_models || {};
    var tierMult = {};
    Object.keys(prices.tier_multipliers || {}).forEach(function (k) {
      tierMult[k] = prices.tier_multipliers[k].multiplier;
    });

    var archetypes = JSON.parse(JSON.stringify(opts.archetypes || EIE));
    var fmt = function (n) { return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 0 }); };
    var fmtc = function (n) { return '$' + n.toFixed(4); };

    // Build markup inside rootEl.
    var styleTag = opts.scoped ? '<style>' + SCOPED_CSS + '</style>' : '';
    rootEl.innerHTML = styleTag +
      '<div class="apz">' +
        '<div class="apz-controls">' +
          '<label>Model<select class="apz-model"></select></label>' +
          '<label>Tier<select class="apz-tier"></select></label>' +
          '<label>Cycles / month<input class="apz-cycles" type="text" inputmode="numeric" value="600000"></label>' +
        '</div>' +
        '<table><thead><tr>' +
          '<th>Archetype</th><th>Mix %</th><th>Tool calls</th><th>Turns</th>' +
          '<th>Input tok</th><th>Cached tok</th><th>Output tok</th><th>Low×</th><th>High×</th>' +
          '<th>$/cycle</th><th>$/month</th><th></th>' +
        '</tr></thead><tbody class="apz-rows"></tbody><tfoot class="apz-foot"></tfoot></table>' +
        '<div class="apz-err" hidden></div>' +
        '<div class="apz-btns">' +
          '<button class="primary apz-add">+ Add archetype</button>' +
          '<button class="apz-reset">Reset to EIE example</button>' +
          '<span class="warn apz-sharewarn" hidden></span>' +
        '</div>' +
        '<div class="apz-hl">' +
          '<div><span class="lbl">Blended $/cycle</span><span class="big apz-hl-cycle">—</span></div>' +
          '<div><span class="lbl">Estimated monthly</span><span class="big apz-hl-month">—</span></div>' +
          '<div><span class="lbl">Range (low – high)</span><span class="range apz-hl-range">—</span></div>' +
        '</div>' +
      '</div>';

    var $ = function (sel) { return rootEl.querySelector(sel); };
    var modelSel = $('.apz-model'), tierSel = $('.apz-tier'), cyclesIn = $('.apz-cycles');

    Object.keys(rateCards).forEach(function (m) {
      var o = document.createElement('option'); o.value = m; o.textContent = m;
      if (m === 'gpt-5.4') o.selected = true; modelSel.appendChild(o);
    });
    Object.keys(tierMult).forEach(function (t) {
      var o = document.createElement('option'); o.value = t;
      o.textContent = t + ' (×' + tierMult[t] + ')';
      if (t === 'standard') o.selected = true; tierSel.appendChild(o);
    });

    [modelSel, tierSel, cyclesIn].forEach(function (el) { el.addEventListener('input', compute); });
    $('.apz-add').addEventListener('click', function () {
      archetypes.push({name:'New archetype', share:0.1, tool_calls:5, turns:5, input_tokens:50000, cached_tokens:40000, output_tokens:500, low_factor:0.8, high_factor:1.3});
      render();
    });
    $('.apz-reset').addEventListener('click', function () {
      archetypes = JSON.parse(JSON.stringify(opts.archetypes || EIE)); render();
    });

    function render() {
      var tbody = $('.apz-rows'); tbody.innerHTML = '';
      archetypes.forEach(function (a, i) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td class="name"><input data-i="' + i + '" data-k="name" value="' + a.name + '"></td>' +
          FIELDS.map(function (f) {
            var k = f[0], t = f[1];
            var val = k === 'share' ? (a.share * 100) : a[k];
            return '<td><input data-i="' + i + '" data-k="' + k + '" data-t="' + t + '" value="' + val + '"></td>';
          }).join('') +
          '<td class="calc apz-cy" data-i="' + i + '"></td><td class="calc apz-mo" data-i="' + i + '"></td>' +
          '<td><button class="row-del" data-del="' + i + '" title="Remove">×</button></td>';
        tbody.appendChild(tr);
      });
      tbody.querySelectorAll('input').forEach(function (inp) { inp.addEventListener('input', onEdit); });
      tbody.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function (e) { archetypes.splice(+e.target.dataset.del, 1); render(); });
      });
      compute();
    }

    function onEdit(e) {
      var i = +e.target.dataset.i, k = e.target.dataset.k, t = e.target.dataset.t, v = e.target.value;
      if (k === 'name') archetypes[i].name = v;
      else if (k === 'share') archetypes[i].share = (parseFloat(v) || 0) / 100;
      else archetypes[i][k] = t === 'int' ? (parseInt(v) || 0) : (parseFloat(v) || 0);
      compute();
    }

    function compute() {
      var err = $('.apz-err'); err.hidden = true;
      var r;
      try {
        r = Math_.archetypeCost(archetypes, {
          model: modelSel.value, tier: tierSel.value,
          cyclesPerMonth: parseFloat(cyclesIn.value) || 0,
          rateCards: rateCards, tierMultipliers: tierMult,
        });
      } catch (ex) { err.hidden = false; err.textContent = '⚠ ' + ex.message; return; }

      r.archetypes.forEach(function (a, i) {
        var cy = rootEl.querySelector('.apz-cy[data-i="' + i + '"]');
        var mo = rootEl.querySelector('.apz-mo[data-i="' + i + '"]');
        if (cy) cy.innerHTML = fmtc(a.cost_cycle) + '<span class="band">' + a.cost_cycle_low.toFixed(3) + '–' + a.cost_cycle_high.toFixed(3) + '</span>';
        if (mo) mo.textContent = fmt(a.monthly);
      });
      var b = r.blended;
      $('.apz-foot').innerHTML = '<tr class="blended"><td>BLENDED</td><td>100%</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>' +
        '<td class="calc">' + fmtc(b.cost_per_cycle) + '</td><td class="calc">' + fmt(b.monthly) + '</td><td></td></tr>';
      $('.apz-hl-cycle').textContent = fmtc(b.cost_per_cycle);
      $('.apz-hl-month').textContent = fmt(b.monthly);
      $('.apz-hl-range').textContent = fmt(b.monthly_low) + ' – ' + fmt(b.monthly_high);

      var sw = $('.apz-sharewarn');
      if (Math.abs(r.shares_sum_raw - 1) > 1e-6) {
        sw.hidden = false; sw.textContent = 'mix sums to ' + (r.shares_sum_raw * 100).toFixed(0) + '% — normalized to 100%';
      } else sw.hidden = true;
    }

    render();
    return { recompute: compute };
  }

  root.ArchetypePanel = { mount: mount, EIE: EIE };
})(typeof self !== 'undefined' ? self : this);
