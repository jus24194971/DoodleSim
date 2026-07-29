# -*- coding: utf-8 -*-
"""Implied range over time, from a Mesh Rider log with no GPS.

A single median RSSI cannot position a moving platform, but the per-sample levels
give a range-versus-time profile: how far out it went, when it was closest, how
fast the geometry changed. For a UAS that is effectively the flight profile in one
dimension, recovered from the radio alone.

Emits a CSV per radio-peer pair plus a summary, and flags samples where the
implied range moves faster than a platform plausibly could (which means the level
changed for a reason other than distance - fading, attitude, or obstruction).
"""
import json, os, glob, math, csv, statistics as st

SP = os.path.join(os.environ.get('TEMP', '/tmp'), 'claude')

def implied_range_m(rssi, tx_dbm, gains_dbi, cable_db, freq_mhz):
    pl = tx_dbm + gains_dbi - cable_db - rssi
    return 10 ** ((pl - 32.45 - 20 * math.log10(freq_mhz)) / 20) * 1000.0

def process(bundle_dir, label, tx_dbm, gains_dbi, cable_db, out_dir):
    roots = glob.glob(os.path.join(bundle_dir, '*', 'longtermlog'))
    if not roots:
        return None
    root = roots[0]
    logs = sorted(glob.glob(os.path.join(root, '2*.log')))
    logs += sorted(glob.glob(os.path.join(root, 'nested', '**', '*.log'), recursive=True))
    series = {}
    for lg in logs:
        for line in open(lg, encoding='utf-8', errors='replace'):
            line = line.strip()
            if not line.startswith('{'):
                continue
            try:
                ls = json.loads(line).get('linkstate')
            except Exception:
                continue
            if not isinstance(ls, dict):
                continue
            t = ls.get('sysinfo', {}).get('localtime')
            f = ls.get('oper_freq') or 1675
            for e in (ls.get('sta_stats') or []):
                mac = (e.get('mac') or '').lower()
                r = e.get('rssi')
                if not mac or not isinstance(r, (int, float)) or t is None:
                    continue
                # These radios occasionally emit a placeholder level (0 dBm, and the
                # matching 0.0 dBm noise figure). No Mesh Rider receives at 0 dBm;
                # keeping them would fabricate 1 m ranges and huge closing rates.
                if r >= -5:
                    continue
                series.setdefault(mac, []).append((t, r, f, e.get('mcs')))

    summary = []
    for mac, pts in series.items():
        pts.sort()
        rows = []
        for t, r, f, mcs in pts:
            rows.append({'utc': t, 'rssi_dbm': r, 'mcs': mcs,
                         'implied_range_m': round(implied_range_m(r, tx_dbm, gains_dbi, cable_db, f))})
        # closing/opening rate between consecutive samples
        impl = []
        for i in range(1, len(rows)):
            dt = rows[i]['utc'] - rows[i - 1]['utc']
            if dt <= 0:
                continue
            dr = rows[i]['implied_range_m'] - rows[i - 1]['implied_range_m']
            rows[i]['rate_m_per_s'] = round(dr / dt, 1)
            impl.append(abs(dr / dt))
        name = f"{label.replace(' ', '_')}__{mac.replace(':', '')}"
        path = os.path.join(out_dir, name + '.csv')
        with open(path, 'w', newline='', encoding='utf-8') as fh:
            w = csv.DictWriter(fh, fieldnames=['utc', 'rssi_dbm', 'mcs', 'implied_range_m', 'rate_m_per_s'])
            w.writeheader()
            for r in rows:
                w.writerow(r)
        if len(rows) < 2:
            continue
        ranges = [r['implied_range_m'] for r in rows]
        # a platform cannot really move at these speeds; if it "does", the level
        # changed for a reason other than distance
        implausible = sum(1 for v in impl if v > 60)   # >60 m/s ~ 216 km/h
        summary.append({
            'peer': mac, 'samples': len(rows),
            'duration_min': round((rows[-1]['utc'] - rows[0]['utc']) / 60),
            'implied_range_m': {'min': min(ranges), 'median': round(st.median(ranges)), 'max': max(ranges)},
            'rssi_dbm': {'min': min(r['rssi_dbm'] for r in rows), 'median': round(st.median([r['rssi_dbm'] for r in rows])),
                         'max': max(r['rssi_dbm'] for r in rows)},
            'closing_rate_m_per_s': {'median': round(st.median(impl), 1) if impl else None,
                                     'p95': round(sorted(impl)[int(0.95 * len(impl))], 1) if impl else None},
            'samples_implying_impossible_motion': implausible,
            'implausible_pct': round(100.0 * implausible / max(len(impl), 1), 1),
            'csv': os.path.basename(path),
        })
    return summary

def main():
    HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    bundles_root = None
    for cand in glob.glob(os.path.join(SP, '*', '*', 'scratchpad', 'bundles')):
        bundles_root = cand
    if not bundles_root:
        print('bundle directory not found; re-extract the tarballs first')
        return
    out_dir = os.path.join(HERE, 'data', 'range_profiles')
    os.makedirs(out_dir, exist_ok=True)
    an = json.load(open(os.path.join(HERE, 'data', 'log_analysis.json'), encoding='utf-8'))
    result = {}
    for b, r in an['bundles'].items():
        tx = r.get('mesh_txpower_dbm') or 30.0
        s = process(os.path.join(bundles_root, b), r['label'], tx, 6.0, 2.0, out_dir)
        if s:
            result[b] = {'label': r['label'], 'tx_dbm': tx, 'peers': s}
    dest = os.path.join(HERE, 'data', 'range_profiles', 'summary.json')
    json.dump(result, open(dest, 'w', encoding='utf-8'), indent=1)
    for b, v in result.items():
        print(f"\n{b} {v['label']} (TX {v['tx_dbm']} dBm assumed both ends, 6 dBi combined, 2 dB cable)")
        for p in v['peers']:
            ir = p['implied_range_m']
            print(f"   peer {p['peer'][-5:]}  {p['samples']} samples / {p['duration_min']} min")
            print(f"      implied range  {ir['min']}-{ir['max']} m (median {ir['median']})")
            print(f"      RSSI           {p['rssi_dbm']['min']} to {p['rssi_dbm']['max']} dBm")
            print(f"      closing rate   median {p['closing_rate_m_per_s']['median']} m/s, p95 {p['closing_rate_m_per_s']['p95']} m/s")
            print(f"      implausible motion in {p['implausible_pct']}% of steps -> that fraction of level change is NOT distance")
    print('\nwritten', dest)

if __name__ == '__main__':
    main()
