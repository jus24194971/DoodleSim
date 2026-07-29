# -*- coding: utf-8 -*-
"""Reconstruct where radios are, from the levels they report about each other.

Radios with no GPS still constrain their own geometry: every measured level implies
a range, and enough ranges fix the shape of the network. This solves the relative
geometry by stress majorisation (SMACOF) over the pairwise ranges that exist,
weighting by relative error because RSSI-derived ranges are multiplicative.

What it can and cannot recover:
  * shape and scale     - yes, where a radio has 2+ independent ranges
  * absolute position   - no, unless one node's position is known
  * rotation            - no, unless a bearing between two nodes is known
  * mirror image        - no, a reflected layout fits the ranges equally well
  * a node with a single range - a ring, not a point
"""
import json, math, os, random

# ---------------------------------------------------------------- range model
def implied_range_m(rssi_dbm, tx_dbm, gains_dbi, cable_db, freq_mhz):
    """Free-space inversion: PL = TX + gains - cable - RSSI."""
    pl = tx_dbm + gains_dbi - cable_db - rssi_dbm
    return 10 ** ((pl - 32.45 - 20 * math.log10(freq_mhz)) / 20) * 1000.0

# ---------------------------------------------------------------- SMACOF
def solve(nodes, edges, iters=800, seed=7):
    """nodes: [id]; edges: {(i,j): dist_m}. Returns {id: (x, y)} in metres."""
    idx = {n: i for i, n in enumerate(nodes)}
    N = len(nodes)
    rnd = random.Random(seed)
    scale = sum(edges.values()) / max(len(edges), 1)
    # seed on a circle so no two points coincide
    P = [[scale * math.cos(2 * math.pi * i / N) + rnd.uniform(-1, 1),
          scale * math.sin(2 * math.pi * i / N) + rnd.uniform(-1, 1)] for i in range(N)]

    # relative-error weighting: w = 1/d^2 makes a 10% error on a short link
    # count the same as a 10% error on a long one
    W = {}
    for (a, b), d in edges.items():
        W[(idx[a], idx[b])] = 1.0 / max(d, 1.0) ** 2

    for _ in range(iters):
        num = [[0.0, 0.0] for _ in range(N)]
        den = [0.0] * N
        for (i, j), w in W.items():
            d_target = edges[(nodes[i], nodes[j])]
            dx, dy = P[i][0] - P[j][0], P[i][1] - P[j][1]
            cur = math.hypot(dx, dy) or 1e-9
            # Guttman transform step
            ux, uy = dx / cur * d_target, dy / cur * d_target
            num[i][0] += w * (P[j][0] + ux); num[i][1] += w * (P[j][1] + uy)
            num[j][0] += w * (P[i][0] - ux); num[j][1] += w * (P[i][1] - uy)
            den[i] += w; den[j] += w
        for i in range(N):
            if den[i] > 0:
                P[i][0] = num[i][0] / den[i]
                P[i][1] = num[i][1] / den[i]
    return {nodes[i]: (P[i][0], P[i][1]) for i in range(N)}

def residuals(pos, edges):
    out = []
    for (a, b), d in edges.items():
        got = math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1])
        out.append({'edge': f'{a[-5:]}-{b[-5:]}', 'measured_m': round(d), 'fitted_m': round(got),
                    'error_m': round(got - d), 'error_pct': round(100 * (got - d) / max(d, 1), 1),
                    'error_db': round(20 * math.log10(max(got, 1) / max(d, 1)), 2)})
    return out

# ---------------------------------------------------------------- self-test
def selftest():
    """A vertex with only two ranges can mirror across the line joining them, so the
    correct pass criterion is that the MEASURED edges are reproduced - not that the
    layout matches the original, which is not uniquely determined."""
    truth = {'A': (0, 0), 'B': (1800, 0), 'C': (900, 1500), 'D': (2400, 1200)}
    e = {}
    for a in truth:
        for b in truth:
            if a < b:
                e[(a, b)] = math.hypot(truth[a][0] - truth[b][0], truth[a][1] - truth[b][1])
    del e[('A', 'D')]                      # leave one range missing, as in real data
    got = solve(list(truth), e)
    r = residuals(got, e)
    worst = max(abs(x['error_m']) for x in r)
    # recover scale-independent check: compare all fitted vs true distances
    err = []
    for a in truth:
        for b in truth:
            if a < b:
                t = math.hypot(truth[a][0] - truth[b][0], truth[a][1] - truth[b][1])
                g = math.hypot(got[a][0] - got[b][0], got[a][1] - got[b][1])
                err.append(abs(g - t))
    return {'worst_edge_residual_m': round(worst, 1),
            'edges_reproduced': worst < 1.0,
            'unconstrained_vertex_moved_m': round(max(err), 1),
            'note': 'D has only two ranges, so it may mirror across BC. Edge residual near zero '
                    'with a displaced D is the expected, correct outcome.'}

# ---------------------------------------------------------------- build from logs
def main():
    HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    AN = json.load(open(os.path.join(HERE, 'data', 'log_analysis.json'), encoding='utf-8'))
    B = AN['bundles']
    own = {k: v.get('own_mac') for k, v in B.items()}

    GAINS_DBI = 6.0     # assumed 3 dBi at each end
    CABLE_DB = 2.0      # assumed 1 dB per end

    # collect every measured level, averaging the two directions where both exist
    meas = {}
    for bk, r in B.items():
        me = own[bk]
        tx = r.get('mesh_txpower_dbm') or 30.0
        freq = (r.get('freq_mhz') or [1675])[0]
        for mac, p in r['peers'].items():
            if not p.get('rssi_dbm'):
                continue
            key = tuple(sorted([me, mac]))
            meas.setdefault(key, []).append(
                implied_range_m(p['rssi_dbm']['median'], tx, GAINS_DBI, CABLE_DB, freq))

    edges = {k: sum(v) / len(v) for k, v in meas.items()}
    twoway = {k for k, v in meas.items() if len(v) > 1}

    # Simultaneity gate. Ranges only describe one geometry if they were measured at
    # the same time. Sequential captures of a moving platform cannot be combined.
    windows = {k: r.get('window_utc') for k, r in B.items() if r.get('window_utc')}
    simultaneity = []
    keys = sorted(windows)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            wa, wb = windows[keys[i]], windows[keys[j]]
            ov = min(wa[1], wb[1]) - max(wa[0], wb[0])
            simultaneity.append({'a': keys[i], 'b': keys[j],
                                 'overlap_s': ov,
                                 'verdict': 'overlapping' if ov > 0 else f'no overlap, gap {round(abs(ov)/60)} min'})
    any_overlap = any(x['overlap_s'] > 0 for x in simultaneity)

    # Triangle-inequality audit: a violation proves the ranges describe different moments
    violations = []
    nodes_all = sorted({n for k in edges for n in k})
    for i in nodes_all:
        for j in nodes_all:
            for k2 in nodes_all:
                if not (i < j < k2):
                    continue
                e = [edges.get(tuple(sorted([i, j]))), edges.get(tuple(sorted([j, k2]))),
                     edges.get(tuple(sorted([i, k2])))]
                if None in e:
                    continue
                e.sort()
                if e[0] + e[1] < e[2] * 0.999:
                    violations.append({'triple': [i[-5:], j[-5:], k2[-5:]],
                                       'shortfall_m': round(e[2] - e[0] - e[1])})

    # degree tells us which radios are actually positionable
    deg = {}
    for (a, b) in edges:
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1

    # solve each connected component separately
    parent = {n: n for n in deg}
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for (a, b) in edges:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    comps = {}
    for n in deg:
        comps.setdefault(find(n), []).append(n)

    label_of = {}
    for k, r in B.items():
        label_of[own[k]] = r['label']

    report = {'selftest': selftest(),
        'simultaneity': simultaneity,
        'any_logs_overlap_in_time': any_overlap,
        'triangle_inequality_violations': violations,
        'solvable': any_overlap and not violations,
        'gate': ('Ranges from different time windows cannot be combined into one geometry. '
                 'These captures do not overlap, so no static solve is attempted.'
                 if not any_overlap else
                 ('Triangle inequality violated - the ranges describe different moments, so no static '
                  'solve is attempted.' if violations else 'Inputs are consistent; solving.')),
        'assumptions': {
        'combined_antenna_gain_dbi': GAINS_DBI, 'cable_loss_db': CABLE_DB,
        'model': 'free space', 'note':
        'Scale rides on these assumptions: a common gain error scales the whole layout, '
        'a per-radio error distorts its shape. Shape is more trustworthy than scale.'},
        'components': []}

    for root, members in comps.items():
        sub = {k: v for k, v in edges.items() if k[0] in members and k[1] in members}
        solvable = [m for m in members if deg[m] >= 2]
        entry = {
            'radios': [{'mac': m, 'label': label_of.get(m, 'peer ' + m[-5:]),
                        'ranges': deg[m], 'positionable': deg[m] >= 2} for m in
                       sorted(members, key=lambda x: -deg[x])],
            'edge_count': len(sub),
            'positionable_count': len(solvable),
        }
        if report['solvable'] and len(members) >= 3 and len(sub) >= 3:
            pos = solve(members, sub)
            # centre and rotate so the longest edge runs east, for a stable presentation
            cx = sum(p[0] for p in pos.values()) / len(pos)
            cy = sum(p[1] for p in pos.values()) / len(pos)
            pos = {k: (v[0] - cx, v[1] - cy) for k, v in pos.items()}
            longest = max(sub, key=lambda k: sub[k])
            ax, ay = pos[longest[0]]; bx, by = pos[longest[1]]
            th = -math.atan2(by - ay, bx - ax)
            c, s = math.cos(th), math.sin(th)
            pos = {k: (v[0] * c - v[1] * s, v[0] * s + v[1] * c) for k, v in pos.items()}
            entry['relative_xy_m'] = {k: [round(v[0]), round(v[1])] for k, v in pos.items()}
            entry['residuals'] = residuals(pos, sub)
            entry['rms_error_db'] = round(
                math.sqrt(sum(r['error_db'] ** 2 for r in entry['residuals']) / len(entry['residuals'])), 2)
        else:
            entry['relative_xy_m'] = None
            entry['why'] = (report['gate'] if not report['solvable'] else
                            'Only a separation is recoverable: with a single measured link there is one '
                            'range and no bearing, so the far radio lies anywhere on a circle.')
            if len(members) == 2:
                (a, b), d = list(sub.items())[0]
                entry['separation_m'] = round(d)
                entry['two_way_averaged'] = (a, b) in twoway
        report['components'].append(entry)

    dest = os.path.join(HERE, 'data', 'mesh_geometry.json')
    with open(dest, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=1)
    print(json.dumps(report, indent=1))
    print('\nwritten', dest)

if __name__ == '__main__':
    main()
