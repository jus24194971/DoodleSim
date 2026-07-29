# -*- coding: utf-8 -*-
"""Analyse Doodle Labs Mesh Rider longtermlog bundles: telemetry stats + issue detection.

Works on any number of bundles. Point --bundles at a directory whose subdirectories
each hold one extracted support bundle (the marker is a */longtermlog inside).
Labels come from a labels.json sidecar in that directory when present, otherwise
from the directory name - so a HubSpot pull of hundreds of bundles needs no code edit.
"""
import json, os, glob, re, argparse, statistics as st
from collections import defaultdict

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The original six bundles were hand-labelled; keep those names exact so previously
# published figures stay reproducible. Anything else is labelled from its directory.
DEFAULT_BUNDLES = os.path.join(
    os.environ.get('TEMP', ''), 'claude', 'C--Users-jus24-Documents-Doodle-Labs-RF-Simulator',
    'e97e0152-920b-456e-abbd-34fa97addf42', 'scratchpad', 'bundles')

LABELS = {
    'b1': 'Air Flight 7',
    'b2': 'GCS Flight 7',
    'b3': 'GCS Kratos DD 6.9.26',
    'b4': 'Relay Kratos DD 6.9.26',
    'b5': 'longtermmon smartradio-301a3af4e9',
    'b6': 'longtermmon smartradio-301a50814f',
}

def discover(bundles_dir):
    """Ordered [(key, dir)] for every subdirectory that actually holds a bundle.

    The */longtermlog marker is what makes a directory a bundle; an empty or
    unrelated subdirectory is skipped rather than analysed into a null result.
    """
    found = []
    for d in sorted(glob.glob(os.path.join(bundles_dir, '*'))):
        if os.path.isdir(d) and glob.glob(os.path.join(d, '*', 'longtermlog')):
            found.append((os.path.basename(d), d))
    return found

def label_for(key, labels):
    if key in labels:
        return labels[key]
    # derived: strip the tarball crust off a filename-shaped key
    t = re.sub(r'\.tar(\s*\d+)?(\.gz)?$', '', key)
    return re.sub(r'[_]+', ' ', t).strip() or key

# DoodleSim sensitivity model (official estimator basis), MCS0-7 @20 MHz; +3 dB for MCS8-15
SENS20 = [-87, -85, -83, -81, -77, -73, -71, -69]
import math
def sens(mcs, bw):
    return SENS20[mcs % 8] + (3 if mcs >= 8 else 0) + 10 * math.log10(bw / 20.0)

def best_mcs_for(rssi, bw, margin_db=0.0, mimo=True):
    top = -1
    for m in range(16 if mimo else 8):
        if rssi - sens(m, bw) >= margin_db:
            top = max(top, m)
    return top

def read_lines(path):
    out = []
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line.startswith('{'):
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            ls = d.get('linkstate')
            if isinstance(ls, dict):
                out.append(ls)
    return out

def meta(bdir):
    d = {}
    root = None
    for cand in glob.glob(os.path.join(bdir, '*', 'longtermlog')):
        root = cand
    if not root:
        return d, None
    def rd(name, n=400):
        p = os.path.join(root, name)
        try:
            return open(p, encoding='utf-8', errors='replace').read(n).strip()
        except Exception:
            return ''
    d['model'] = rd('fes_model')
    d['date'] = rd('date')
    d['uptime'] = rd('uptime')
    osr = rd('os-release', 900)
    m = re.search(r'VERSION="([^"]+)"', osr)
    d['firmware'] = m.group(1) if m else '?'
    # IMPORTANT: these radios expose two interfaces - wlan0 is the mesh radio and
    # wlan1 is a 5 GHz Wi-Fi hotspot. Take the MESH interface's MAC and tx power,
    # never the first 'addr' in the file (that is usually the hotspot).
    iwd = rd('iw_dev', 4000) + chr(10) + rd('iw_wlan0_info', 4000)
    d['own_mac'] = None
    d['mesh_txpower_dbm'] = None
    d['hotspot_txpower_dbm'] = None
    blocks = re.split(r'(?=phy#)', iwd)
    for blk in blocks:
        mac = re.search(r'addr ((?:[0-9a-f]{2}:){5}[0-9a-f]{2})', blk, re.I)
        pwr = re.search(r'txpower ([0-9.]+) dBm', blk)
        is_mesh = ('mesh point' in blk) or ('wlan0' in blk)
        if is_mesh:
            if mac and not d['own_mac']:
                d['own_mac'] = mac.group(1).lower()
            if pwr and d['mesh_txpower_dbm'] is None:
                d['mesh_txpower_dbm'] = float(pwr.group(1))
        elif pwr and d['hotspot_txpower_dbm'] is None:
            d['hotspot_txpower_dbm'] = float(pwr.group(1))
    if not d['own_mac']:
        m = re.search(r'addr ((?:[0-9a-f]{2}:){5}[0-9a-f]{2})', iwd, re.I)
        d['own_mac'] = m.group(1).lower() if m else None
    # configured mesh tx power, for comparison with what the driver reports
    wl = os.path.join(root, 'config', 'wireless')
    if os.path.exists(wl):
        txt = open(wl, encoding='utf-8', errors='replace').read()
        m = re.search(r"option txpower '([0-9]+)'", txt)
        d['cfg_txpower_dbm'] = int(m.group(1)) if m else None
    reg = rd('iw_reg_get', 900)
    m = re.search(r'country ([A-Z]{2})', reg)
    d['regdomain'] = m.group(1) if m else '?'
    # tx power from config if present
    cfgdir = os.path.join(root, 'config')
    d['cfg'] = {}
    for cf in ('linkstate', 'link_status_log', 'dynamic_mesh', 'ath9k_tpcd', 'central_acs', 'acs_multiband'):
        p = os.path.join(cfgdir, cf)
        if os.path.exists(p):
            d['cfg'][cf] = open(p, encoding='utf-8', errors='replace').read()[:1200]
    return d, root

def analyse(bkey, bdir, label):
    m, root = meta(bdir)
    logs = sorted(glob.glob(os.path.join(root, '2*.log')))
    logs += sorted(glob.glob(os.path.join(root, 'nested', '**', '*.log'), recursive=True))
    samples = []
    for lg in logs:
        samples.extend(read_lines(lg))
    samples.sort(key=lambda s: s.get('sysinfo', {}).get('localtime', 0))

    res = {'bundle': bkey, 'label': label, **{k: v for k, v in m.items() if k != 'cfg'},
           'log_files': len(logs), 'samples': len(samples), 'issues': [], 'peers': {}}
    if not samples:
        res['issues'].append({'sev': 'high', 'title': 'No telemetry samples could be parsed'})
        return res, m

    t0 = samples[0]['sysinfo']['localtime']
    t1 = samples[-1]['sysinfo']['localtime']
    res['window_utc'] = [t0, t1]
    res['duration_s'] = t1 - t0
    freqs = sorted({s.get('oper_freq') for s in samples if s.get('oper_freq')})
    widths = sorted({str(s.get('chan_width')) for s in samples if s.get('chan_width')})
    res['freq_mhz'] = freqs
    res['chan_width_mhz'] = widths
    bw = float(widths[0]) if widths else 20.0

    noise = [float(s['noise']) for s in samples if s.get('noise') not in (None, '')]
    res['noise_dbm'] = {'min': round(min(noise), 1), 'median': round(st.median(noise), 1),
                        'max': round(max(noise), 1)} if noise else None
    act = [s.get('activity') for s in samples if isinstance(s.get('activity'), (int, float))]
    res['activity_pct'] = {'median': round(st.median(act), 1), 'max': max(act)} if act else None

    # per-peer time series
    peer = defaultdict(lambda: defaultdict(list))
    connected_samples = 0
    for s in samples:
        sta = s.get('sta_stats') or []
        if sta:
            connected_samples += 1
        for e in sta:
            mac = (e.get('mac') or '').lower()
            if not mac:
                continue
            p = peer[mac]
            for k in ('rssi', 'mcs', 'pl_ratio', 'tx_packets', 'tx_retries', 'tx_failed', 'inactive'):
                if isinstance(e.get(k), (int, float)):
                    p[k].append(e[k])
            ra = e.get('rssi_ant')
            if isinstance(ra, list) and len(ra) >= 2 and all(isinstance(v, (int, float)) for v in ra[:2]):
                p['ant0'].append(ra[0]); p['ant1'].append(ra[1])
                p['imbalance'].append(abs(ra[0] - ra[1]))
        for ms in (s.get('mesh_stats') or []):
            mac = (ms.get('orig_address') or '').lower()
            if mac and isinstance(ms.get('tq'), (int, float)):
                peer[mac]['tq'].append(ms['tq'])
                peer[mac]['hop'].append(ms.get('hop_status'))

    res['connected_pct'] = round(100.0 * connected_samples / len(samples), 1)
    if connected_samples == 0:
        res['issues'].append({'sev': 'critical', 'title': 'No peer ever associated during the entire log',
            'detail': f'{len(samples)} samples over {(t1-t0)/60:.0f} min on {freqs} MHz / {bw:g} MHz: sta_stats empty throughout. '
                      'The radio was transmitting/receiving but never formed a link.'})
    elif res['connected_pct'] < 95:
        res['issues'].append({'sev': 'high', 'title': f'Link present only {res["connected_pct"]}% of the time',
            'detail': f'{len(samples)-connected_samples} of {len(samples)} samples had no associated peer — the link dropped repeatedly.'})

    for mac, p in peer.items():
        d = {'samples': len(p.get('rssi', []))}
        if p.get('rssi'):
            d['rssi_dbm'] = {'min': min(p['rssi']), 'median': round(st.median(p['rssi']), 1), 'max': max(p['rssi'])}
        if p.get('imbalance'):
            d['chain_imbalance_db'] = {'median': round(st.median(p['imbalance']), 1), 'max': max(p['imbalance'])}
            d['ant_median_dbm'] = [round(st.median(p['ant0']), 1), round(st.median(p['ant1']), 1)]
        if p.get('mcs'):
            d['mcs'] = {'min': min(p['mcs']), 'median': round(st.median(p['mcs']), 1), 'max': max(p['mcs'])}
        if p.get('tx_packets') and p.get('tx_retries'):
            tp, tr = max(p['tx_packets']), max(p['tx_retries'])
            d['retries_per_frame'] = round(tr / tp, 2) if tp else None
        if p.get('tx_packets') and p.get('tx_failed'):
            tp, tf = max(p['tx_packets']), max(p['tx_failed'])
            d['tx_failed_pct'] = round(100.0 * tf / tp, 2) if tp else None
        if p.get('pl_ratio'):
            d['pl_ratio_pct'] = {'median': round(st.median(p['pl_ratio']), 1), 'max': round(max(p['pl_ratio']), 1)}
        if p.get('tq'):
            d['batman_tq'] = {'min': min(p['tq']), 'median': round(st.median(p['tq']), 1), 'max': max(p['tq'])}
        if p.get('hop'):
            d['hop_status'] = sorted({h for h in p['hop'] if h})

        # rate anomaly: what MCS should this RSSI support?
        if p.get('rssi') and p.get('mcs'):
            med_rssi = st.median(p['rssi'])
            mimo = bool(p.get('ant0'))
            expect = best_mcs_for(med_rssi, bw, margin_db=10, mimo=mimo)
            d['mcs_expected_at_median_rssi'] = expect
            gap = expect - st.median(p['mcs'])
            d['mcs_shortfall'] = round(gap, 1)
            if gap >= 4:
                res['issues'].append({'sev': 'high', 'title': f'Rate far below what the signal supports (peer {mac})',
                    'detail': f'median RSSI {med_rssi:.0f} dBm at {bw:g} MHz should carry about MCS {expect} '
                              f'(10 dB fade margin) but the radio ran at median MCS {st.median(p["mcs"]):.0f}. '
                              'Signal strength is not the limit here — look at interference, retries or multipath.'})
        if d.get('chain_imbalance_db', {}).get('median', 0) >= 5:
            res['issues'].append({'sev': 'high', 'title': f'Antenna chain imbalance {d["chain_imbalance_db"]["median"]} dB (peer {mac})',
                'detail': f'chain medians {d.get("ant_median_dbm")} dBm. A persistent difference of 5 dB or more points at '
                          'one antenna, cable or connector — not at propagation.'})
        if (d.get('retries_per_frame') or 0) >= 0.3:
            res['issues'].append({'sev': 'high' if d['retries_per_frame'] >= 1.0 else 'medium',
                'title': f'{d["retries_per_frame"]} retries per transmitted frame (peer {mac})',
                'detail': 'Frames are being retransmitted heavily, which burns airtime and adds latency even when RSSI looks healthy. '
                          'Above 1.0 the radio is spending more airtime on retries than on first attempts.'})
        if (d.get('tx_failed_pct') or 0) >= 2:
            res['issues'].append({'sev': 'medium', 'title': f'Frames abandoned: {d["tx_failed_pct"]}% tx_failed (peer {mac})'})
        if d.get('batman_tq') and d['batman_tq']['median'] < 150:
            res['issues'].append({'sev': 'medium', 'title': f'Mesh link quality low: TQ {d["batman_tq"]["median"]}/255 (peer {mac})',
                'detail': 'BATMAN transmit quality below 150 means the routing layer already sees this hop as poor.'})
        if d.get('pl_ratio_pct') and d['pl_ratio_pct']['median'] >= 20:
            res['issues'].append({'sev': 'medium', 'title': f'Packet-loss ratio median {d["pl_ratio_pct"]["median"]}% (peer {mac})'})
        if p.get('mcs'):
            d['mcs_max_observed'] = max(p['mcs'])
            d['single_stream'] = bool(p.get('ant0')) and max(p['mcs']) <= 7
            if d['single_stream']:
                res['issues'].append({'sev': 'high', 'title': f'Never used both spatial streams (peer {mac})',
                    'detail': f'MCS never exceeded {max(p["mcs"])} on a 2x2 radio, so the second stream was never usable. '
                              'Combined with the chain imbalance above, this points at one antenna/cable path rather than propagation.'})
        # infer separation from the measured level, stating the assumptions
        if p.get('rssi'):
            med = st.median(p['rssi'])
            tx_assumed, gains_assumed = 30.0, 6.0
            fspl = tx_assumed + gains_assumed - med
            f = freqs[0] if freqs else 2450
            d_km = 10 ** ((fspl - 32.45 - 20 * math.log10(f)) / 20)
            d['implied_separation_m'] = round(d_km * 1000)
            d['implied_assumes'] = f'{tx_assumed:g} dBm TX, {gains_assumed:g} dBi combined antenna gain, free space'
            if med > -45:
                res['issues'].append({'sev': 'medium', 'title': f'Very hot receive level {med:.0f} dBm (peer {mac})',
                    'detail': f'That is roughly {round(d_km*1000)} m of free-space path. At this level the receive front end can be near '
                              'compression, which produces exactly these symptoms (retries and low rates despite a huge signal). '
                              'If this was a bench or ramp test, add attenuators or separate the radios before drawing conclusions.'})
        res['peers'][mac] = d

    if res.get('noise_dbm') and res['noise_dbm']['median'] > -85:
        res['issues'].append({'sev': 'high', 'title': f'Elevated noise floor {res["noise_dbm"]["median"]} dBm',
            'detail': f'At {bw:g} MHz a quiet band should sit near -95 dBm. This raises the level every rate needs.'})
    return res, m

def run(bundles_dir, dest, labels=None):
    labels = dict(LABELS, **(labels or {}))
    found = discover(bundles_dir)
    if not found:
        raise SystemExit('no bundles found under %s (expected subdirs containing */longtermlog)'
                         % bundles_dir)
    out = {}
    for bkey, bdir in found:
        r, _m = analyse(bkey, bdir, label_for(bkey, labels))
        out[bkey] = r

    # ---- cross-bundle pairing
    own = {b: out[b].get('own_mac') for b in out}
    pairs = []
    for a in out:
        for c in out:
            if a >= c:
                continue
            if own.get(c) and own[c] in out[a]['peers'] and own.get(a) and own[a] in out[c]['peers']:
                pa, pc = out[a]['peers'][own[c]], out[c]['peers'][own[a]]
                asym = None
                if pa.get('rssi_dbm') and pc.get('rssi_dbm'):
                    asym = round(pa['rssi_dbm']['median'] - pc['rssi_dbm']['median'], 1)
                # reciprocity check: path loss must be the same both ways, so
                # (TX of the far end) - (RSSI here) should match in both directions.
                txa = out[a].get('mesh_txpower_dbm')
                txc = out[c].get('mesh_txpower_dbm')
                pl_a_to_c = pl_c_to_a = recip = None
                if txa is not None and txc is not None and pa.get('rssi_dbm') and pc.get('rssi_dbm'):
                    pl_c_to_a = round(txc - pa['rssi_dbm']['median'], 1)   # c transmits, a receives
                    pl_a_to_c = round(txa - pc['rssi_dbm']['median'], 1)   # a transmits, c receives
                    recip = round(pl_c_to_a - pl_a_to_c, 1)
                pairs.append({'a': a, 'b': c, 'a_label': out[a]['label'], 'b_label': out[c]['label'],
                              'rssi_a_sees_b': pa.get('rssi_dbm', {}).get('median'),
                              'rssi_b_sees_a': pc.get('rssi_dbm', {}).get('median'),
                              'asymmetry_db': asym,
                              'tx_a_dbm': txa, 'tx_b_dbm': txc,
                              'implied_pathloss_b_to_a_db': pl_c_to_a,
                              'implied_pathloss_a_to_b_db': pl_a_to_c,
                              'reciprocity_error_db': recip})
    res = {'bundles': out, 'pairs': pairs,
           'own_macs': own,
           'unmatched': [b for b in out if not any(b in (p['a'], p['b']) for p in pairs)]}

    with open(dest, 'w', encoding='utf-8') as f:
        json.dump(res, f, indent=1)
    print('written', dest)
    for b, r in out.items():
        print(f"\n{b} {r['label']}: {r.get('model')} fw={r.get('firmware')} {r.get('freq_mhz')} MHz/{r.get('chan_width_mhz')} MHz "
              f"samples={r['samples']} dur={r.get('duration_s', 0)/60:.0f}min connected={r.get('connected_pct')}% issues={len(r['issues'])}")
        for i in r['issues']:
            print(f"   [{i['sev']}] {i['title']}")
    print('\nPAIRS:', json.dumps(pairs, indent=1))
    print('UNMATCHED:', res['unmatched'])
    return res

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--bundles', default=DEFAULT_BUNDLES,
                    help='directory of extracted bundles (default: the original scratchpad set)')
    ap.add_argument('--out', default=os.path.join(HERE, 'data', 'log_analysis.json'))
    ap.add_argument('--labels', help='optional JSON map of bundle-dir name -> display label')
    a = ap.parse_args()
    labels = {}
    # a labels.json sitting beside the bundles is picked up automatically, so an
    # ingest can record real ticket/company names without a command-line argument
    side = os.path.join(a.bundles, 'labels.json')
    for src in (side, a.labels):
        if src and os.path.exists(src):
            labels.update(json.load(open(src, encoding='utf-8')))
    run(a.bundles, a.out, labels)

if __name__ == '__main__':
    main()
