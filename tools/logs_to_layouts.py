# -*- coding: utf-8 -*-
"""Turn analysed log bundles into DoodleSim layout files.

No bundle contained GPS data (meshmap disabled), so true positions are unknown.
Each system is emitted at its *implied* separation - derived from the measured
receive level and the radio's own reported TX power - anchored at a neutral point
the user is expected to drag onto the real site. Labels carry the measured level
so predicted-vs-measured is visible on screen.
"""
import json, math, os

AN = json.load(open(r'C:\Users\jus24\Documents\Doodle Labs RF Simulator\data\log_analysis.json', encoding='utf-8'))
OUT = r'C:\Users\jus24\Documents\Doodle Labs RF Simulator\data\layouts'
os.makedirs(OUT, exist_ok=True)

# model -> (simulator radio id, bandId, default freq)
def radio_for(model, freq):
    v4 = 'v4' in (model or '')
    if freq and freq < 1000:
        return ('miniOEM_v4' if v4 else 'miniOEM_v3'), 'ism900', freq
    if freq and 1625 <= freq <= 2510:
        return ('miniOEM_v4' if v4 else 'miniOEM_v3'), 'hex', freq
    if freq and 2400 <= freq <= 2500:
        return ('miniOEM_v4' if v4 else 'miniOEM_v3'), 'ism2400', freq
    return ('miniOEM_v4' if v4 else 'miniOEM_v3'), 'hex', freq or 1675

PLATFORM = {'Air': 'uav', 'GCS': 'mast', 'Relay': 'mast', 'longtermmon': 'mast'}

def platform_for(label):
    for k, v in PLATFORM.items():
        if label.startswith(k):
            return v
    return 'mast'

def offset(lat, lng, bearing_deg, dist_m):
    R = 6371008.8
    br = math.radians(bearing_deg)
    dR = dist_m / R
    la1, lo1 = math.radians(lat), math.radians(lng)
    la2 = math.asin(math.sin(la1) * math.cos(dR) + math.cos(la1) * math.sin(dR) * math.cos(br))
    lo2 = lo1 + math.atan2(math.sin(br) * math.sin(dR) * math.cos(la1),
                           math.cos(dR) - math.sin(la1) * math.sin(la2))
    return math.degrees(la2), math.degrees(lo2)

def node(nid, label, lat, lng, model, freq, bw, tx, platform, height, note):
    rid, band, f = radio_for(model, freq)
    return {
        'id': nid, 'label': label, 'lng': round(lng, 6), 'lat': round(lat, 6),
        'radioId': rid, 'bandId': band, 'freqMhz': f, 'bwMhz': bw,
        'powerDbm': int(tx) if tx else 30,
        'antennaId': None, 'antennaGain': 3, 'heightM': height,
        'cableLoss': 1, 'bdaGain': 0, 'platform': platform,
        'azimuthDeg': 0, 'tiltDeg': 0, 'customHpbwAz': 360, 'customHpbwEl': 360,
        'customName': note, 'customType': 'omni', 'dishDiaM': None,
        'cableType': 'manual', 'cableLenM': 0,
    }

ANCHORS = {
    'flight7': (39.7392, -104.9903),
    'Site B': (39.7392, -105.2000),
    'bench': (39.7392, -104.8000),
}

def emit(name, anchor, members, links, headline):
    lat0, lng0 = anchor
    nodes = []
    nid = 1
    placed = {}
    for i, m in enumerate(members):
        if i == 0:
            lat, lng = lat0, lng0
        else:
            lat, lng = offset(lat0, lng0, (i * 360.0 / max(len(members) - 1, 1)) % 360, m['sep_m'])
        nodes.append(node(nid, m['label'], lat, lng, m['model'], m['freq'], m['bw'], m['tx'],
                          m['platform'], m['height'], m['note']))
        placed[m['key']] = nid
        nid += 1
    layout = {
        'version': 1,
        'savedAt': '2026-07-29T00:00:00.000Z',
        '_source': 'Generated from Mesh Rider longtermlog bundles by DoodleSim log analysis',
        '_warning': 'SYNTHETIC POSITIONS. No bundle contained GPS data. Separations are implied by the '
                    'measured receive level and reported TX power assuming 3 dBi omnis and free space; '
                    'bearings are arbitrary. Drag the nodes onto the real site before drawing conclusions.',
        '_headline': headline,
        'view': {'center': [lng0, lat0], 'zoom': 13},
        'coverage': {'remoteMode': 'agl', 'remoteHeightM': 2, 'aslAltM': None,
                     'remoteGainDbi': 3, 'metric': 'mcs', 'nearGround': False, 'scope': 'mesh'},
        'nodes': nodes,
        'links': [[placed[a], placed[b]] for a, b in links if a in placed and b in placed],
    }
    p = os.path.join(OUT, name + '.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(layout, f, indent=1)
    print('wrote', p, f'({len(nodes)} nodes, {len(layout["links"])} links)')

B = AN['bundles']

def peer_of(bkey, mac):
    return B[bkey]['peers'].get(mac, {})

# ---- Flight 7 (b1 Air <-> b2 GCS)
p12 = peer_of('b2', B['b1']['own_mac'])
sep = p12.get('implied_separation_m') or 2000
emit('flight7', ANCHORS['flight7'], [
    {'key': 'b2', 'label': f"GCS Flight 7 (rx {B['b2']['peers'][B['b1']['own_mac']]['rssi_dbm']['median']:.0f} dBm, chains -73/-63)",
     'model': B['b2']['model'], 'freq': 918, 'bw': 10, 'tx': B['b2']['mesh_txpower_dbm'],
     'platform': 'mast', 'height': 3, 'note': 'measured: 10 dB chain imbalance, MCS<=6, 84% packet loss', 'sep_m': 0},
    {'key': 'b1', 'label': f"Air Flight 7 (rx {B['b1']['peers'][B['b2']['own_mac']]['rssi_dbm']['median']:.0f} dBm)",
     'model': B['b1']['model'], 'freq': 918, 'bw': 10, 'tx': B['b1']['mesh_txpower_dbm'],
     'platform': 'uav', 'height': 100, 'note': 'measured: MCS<=6, 80% packet loss, channel 70% busy', 'sep_m': sep},
], [('b1', 'b2')], 'Flight 7: GCS receive chain down ~10 dB + congested 918 MHz channel; link up but unusable (MCS 0, 80% loss)')

# ---- Site B mesh (b3 GCS + b4 Relay + their peers)
members = [{'key': 'b3', 'label': f"GCS Site B (chains -31/-25, {len(B['b3']['peers'])} peers)",
            'model': B['b3']['model'], 'freq': 1636, 'bw': 20, 'tx': B['b3']['mesh_txpower_dbm'],
            'platform': 'mast', 'height': 3, 'note': 'measured: own chain 0 down 5-7 dB vs every peer', 'sep_m': 0}]
links = []
for mac, pp in B['b3']['peers'].items():
    if not pp.get('rssi_dbm'):
        continue
    is_relay = mac == B['b4']['own_mac']
    members.append({
        'key': mac,
        'label': ('Relay Site B' if is_relay else f"Site B node {mac[-5:]}")
                 + f" (rx {pp['rssi_dbm']['median']:.0f} dBm)",
        'model': B['b4']['model'] if is_relay else B['b3']['model'],
        'freq': 1636, 'bw': 20, 'tx': 32,
        'platform': 'mast' if is_relay else 'uav', 'height': 10 if is_relay else 60,
        'note': ('measured: single-stream only (MCS<=6), link up 69.6% of the time' if is_relay
                 else f"measured: {pp.get('retries_per_frame')} retries/frame"),
        'sep_m': pp.get('implied_separation_m') or 50,
    })
    links.append(('b3', mac))
emit('site-b-mesh', ANCHORS['Site B'], members, links,
     'Site B: both GCS and Relay show a local 5-7 dB antenna chain imbalance; Relay ran single-stream only and was linked 69.6% of the time')

# ---- healthy bench pair (b5 <-> b6) as the control
p56 = peer_of('b6', B['b5']['own_mac'])
emit('bench-pair-healthy', ANCHORS['bench'], [
    {'key': 'b6', 'label': "smartradio-...50814f (rx -31 dBm, MCS 15, TQ 255)",
     'model': B['b6']['model'], 'freq': 1675, 'bw': 10, 'tx': B['b6']['mesh_txpower_dbm'],
     'platform': 'mast', 'height': 2, 'note': 'healthy reference: chains balanced, 0% loss', 'sep_m': 0},
    {'key': 'b5', 'label': "smartradio-...3af4e9 (rx -29 dBm, MCS 15, 5 dB chain imbalance)",
     'model': B['b5']['model'], 'freq': 1675, 'bw': 10, 'tx': B['b5']['mesh_txpower_dbm'],
     'platform': 'mast', 'height': 2, 'note': 'healthy but 5 dB chain imbalance worth checking', 'sep_m': p56.get('implied_separation_m') or 30},
], [('b5', 'b6')], 'Healthy control: both ends MCS 15, TQ 255/255, zero packet loss at ~25-30 m')
