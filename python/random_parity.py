#!/usr/bin/env python3
"""random_parity.py — randomized JS-vs-Python engine cross-check.

Generates N randomly mutated workloads from the bundled presets (seeded,
reproducible), runs BOTH engines on every case — the JS engine via one
`node scripts/compute-batch.mjs` invocation, the Python engine in-process
— and deep-compares every numeric leaf at the same tolerance as
parity_check.py (rel 1e-9 / abs 1e-6).

    python3 python/random_parity.py            # 300 cases, seed 1
    python3 python/random_parity.py --n 1000 --seed 7

Exit 0 = every case matches (or crashes identically on both sides).
"""
import argparse
import copy
import json
import math
import random
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'python'))
from costcalc import compute                      # noqa: E402
from costcalc.prices import DEFAULT_RATE_CARDS    # noqa: E402

REL_TOL, ABS_TOL = 1e-9, 1e-6

HOSTINGS = ['api', 'self', 'hybrid']
TIERS = ['standard', 'flex', 'batch', 'priority']
COST_MODES = ['optimistic', 'realistic']


def load_presets():
    out = []
    for p in sorted((ROOT / 'public' / 'examples').glob('*.json')):
        d = json.loads(p.read_text())
        w = d.get('workload', d)
        if isinstance(w, dict) and w.get('deployment') and w.get('shapes'):
            out.append((p.stem, w))
    return out


def mutate(w, rng, models, gpus):
    """Apply 2-6 random mutations to a deep copy of workload w."""
    w = copy.deepcopy(w)
    muts = []

    def pick(*fns):
        for f in rng.sample(fns, k=rng.randint(2, min(6, len(fns)))):
            f()

    def m_cache():
        if w.get('anchor_query'):
            w['anchor_query']['cache_rate_baseline'] = round(rng.uniform(0, 0.95), 3)
            muts.append('cache')

    def m_segments():
        segs = w.get('segments') or []
        if segs:
            s = rng.choice(segs)
            s['mau'] = rng.randint(100, 300000)
            s['sessions_per_day'] = round(rng.uniform(0.01, 3), 2)
            s['questions_per_session'] = rng.randint(1, 30)
            s['applyBotFactor'] = rng.random() < 0.5
            muts.append('segment')

    def m_add_segment():
        segs = w.setdefault('segments', [])
        segs.append({'id': f'fz{rng.randint(0, 9999)}', 'label': 'fuzz',
                     'mau': rng.randint(50, 50000),
                     'sessions_per_day': round(rng.uniform(0.05, 2), 2),
                     'questions_per_session': rng.randint(1, 15),
                     'applyBotFactor': rng.random() < 0.5})
        muts.append('add-segment')

    def m_tools():
        reg = w.get('tools_registry') or {}
        for t in reg.values():
            if rng.random() < 0.4:
                t['return_shape'] = rng.choice(['templated', 'freeform'])
            if rng.random() < 0.2:
                t['memoize'] = True
                t['memoize_hit_rate'] = round(rng.uniform(0, 0.8), 2)
        if reg:
            muts.append('tools')

    def m_verification():
        v = w.get('verification')
        if v:
            v['enabled'] = rng.random() < 0.8
            v['coverage'] = round(rng.uniform(0, 1), 2)
            v['variant'] = rng.choice(['minicheck', 'fr1', 'fr2'])
            muts.append('verification')

    def m_daily_cap():
        w['daily_cap'] = {'enabled': True,
                          'amount_usd': rng.choice([5, 50, 500, 5000]),
                          'burst_days': rng.randint(0, 10), 'burst_factor': 1}
        muts.append('cap')

    def m_reservation():
        w['reservations'] = {'enabled': True,
                             'type': 'azure-ptu-yearly',
                             'units': rng.randint(1, 8)}
        muts.append('reservation')

    def m_embedding():
        w['embedding'] = {'enabled': True, 'model': 'text-embedding-3-small',
                          'corpus_size_tokens': rng.randint(10**6, 10**8),
                          'reembed_frequency_months': rng.choice([1, 3, 6, 12]),
                          'query_embedding_tokens': rng.randint(4, 64)}
        muts.append('embedding')

    def m_agents():
        for a in (w.get('agents') or []):
            if rng.random() < 0.5:
                a['output_tokens'] = rng.randint(16, 3000)
            if rng.random() < 0.3:
                a['sysprompt_tokens'] = rng.randint(0, 4000)
            if rng.random() < 0.3:
                a['model'] = rng.choice(models)
        if w.get('agents'):
            muts.append('agents')

    def m_infra():
        infra = w.get('infrastructure')
        if isinstance(infra, dict) and infra:
            k = rng.choice(list(infra))
            infra[k] = rng.randint(0, 2000)
            muts.append('infra')

    pick(m_cache, m_segments, m_add_segment, m_tools, m_verification,
         m_daily_cap, m_reservation, m_embedding, m_agents, m_infra)
    return w, muts


def build_opts(w, rng, models, gpus):
    d = w.get('defaults') or {}
    return {
        'model': rng.choice(models) if rng.random() < 0.3 else d.get('model', 'gpt-5.2'),
        'tier': rng.choice(TIERS),
        'mix': d.get('mix', 'mixed'),
        'hosting': rng.choice(HOSTINGS),
        'rateLimit': d.get('rate_limit', 'edge'),
        'costMode': rng.choice(COST_MODES),
        'gpu': rng.choice(gpus) if gpus else None,
        'commitment': rng.choice(['on-demand', 'ri-1y', 'ri-3y']),
    }


def diff_paths(a, b, path='', out=None):
    if out is None:
        out = []
    if len(out) >= 10:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            diff_paths(a.get(k), b.get(k), f'{path}.{k}', out)
    elif isinstance(a, list) and isinstance(b, list):
        for i in range(max(len(a), len(b))):
            ai = a[i] if i < len(a) else None
            bi = b[i] if i < len(b) else None
            diff_paths(ai, bi, f'{path}[{i}]', out)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) \
            and not isinstance(a, bool) and not isinstance(b, bool):
        fa, fb = float(a), float(b)
        if math.isnan(fa) and math.isnan(fb):
            return out
        if not math.isclose(fa, fb, rel_tol=REL_TOL, abs_tol=ABS_TOL):
            out.append((path, a, b))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--n', type=int, default=300)
    ap.add_argument('--seed', type=int, default=1)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    models = sorted(DEFAULT_RATE_CARDS.keys()) or ['gpt-5.2']
    presets = load_presets()

    # Generate cases
    cases = []
    for i in range(args.n):
        name, base = presets[i % len(presets)]
        w, muts = mutate(base, rng, models, [])
        gpus = sorted(((w.get('self_host') or {}).get('gpu_options') or {}).keys())
        opts = build_opts(w, rng, models, gpus)
        cases.append({'id': f'{name}#{i}:{"+".join(muts)}:{opts["hosting"]}/{opts["tier"]}',
                      'workload': w, 'opts': opts})

    # JS side — one node process for the whole batch
    with tempfile.TemporaryDirectory() as td:
        cp, op = Path(td) / 'cases.json', Path(td) / 'out.json'
        cp.write_text(json.dumps(cases))
        subprocess.run(['node', str(ROOT / 'scripts' / 'compute-batch.mjs'),
                        str(cp), str(op)], check=True)
        js = {r['id']: r for r in json.loads(op.read_text())}

    # Python side + compare
    fails, sym_crashes = [], 0
    for c in cases:
        j = js[c['id']]
        try:
            r = compute(copy.deepcopy(c['workload']), c['opts'])
        except Exception as e:
            if not j['ok']:
                sym_crashes += 1          # both sides crashed — symmetric
                continue
            fails.append((c['id'], [('(python crashed)', str(e), 'JS ok')]))
            continue
        if not j['ok']:
            fails.append((c['id'], [('(JS crashed)', j['error'], 'PY ok')]))
            continue
        d = diff_paths(j['result'], r)
        if d:
            fails.append((c['id'], d))

    print(f'random_parity: {args.n} cases, seed {args.seed} — '
          f'{args.n - len(fails) - sym_crashes} match, '
          f'{sym_crashes} symmetric crashes, {len(fails)} FAIL')
    for cid, ds in fails[:10]:
        print(f'  ✗ {cid}')
        for p, a, b in ds[:5]:
            print(f'      {p}: js={a}  py={b}')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
