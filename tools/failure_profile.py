# -*- coding: utf-8 -*-
"""Failure profile: classify why each logged link failed, and whether we fixed it.

Consumes two inputs and joins them:

  1. Telemetry findings  - output of tools/analyze_mesh_rider_logs.py, i.e. what the
                           radio actually recorded.
  2. Ticket records      - what the customer reported and what we told them to do,
                           from HubSpot (connector or export). Optional: without it
                           the telemetry side still produces a failure profile, it
                           just cannot score our diagnosis or the resolution.

The point of joining them is the comparison our support process cannot otherwise
make: reported symptom vs measured cause vs the fix we actually shipped.
"""
import json, os, re, csv, collections, math

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ---------------------------------------------------------------------------
# Failure taxonomy. Each rule reads the telemetry summary for one radio-peer pair
# and returns (confidence 0-1, evidence) when it fires. Rules are deliberately
# independent so a link can carry more than one cause - most real faults do.
# ---------------------------------------------------------------------------

def _peer_vals(peer):
    return {
        'imb': (peer.get('chain_imbalance_db') or {}).get('median'),
        'rssi': (peer.get('rssi_dbm') or {}).get('median'),
        'mcs_max': peer.get('mcs_max_observed'),
        'shortfall': peer.get('mcs_shortfall'),
        'retries': peer.get('retries_per_frame'),
        'failed': peer.get('tx_failed_pct'),
        'tq': (peer.get('batman_tq') or {}).get('median'),
        'pl': (peer.get('pl_ratio_pct') or {}).get('median'),
        'single': peer.get('single_stream'),
    }

def classify(bundle, peer):
    """Return [{'cause','confidence','evidence'}] for one link."""
    v = _peer_vals(peer)
    noise = (bundle.get('noise_dbm') or {}).get('median')
    activity = (bundle.get('activity_pct') or {}).get('median')
    conn = bundle.get('connected_pct')
    out = []

    # 1. Antenna / feed fault on the local radio
    if v['imb'] is not None and v['imb'] >= 5:
        conf = 0.6 + min(0.35, (v['imb'] - 5) * 0.05)
        ev = 'per-chain imbalance %.0f dB' % v['imb']
        if v['single']:
            conf = min(0.95, conf + 0.2)
            ev += '; MCS never exceeded %s on a 2x2 radio' % v['mcs_max']
        out.append({'cause': 'antenna_or_feed_fault', 'confidence': round(conf, 2), 'evidence': ev})

    # 2. RF congestion / interference: channel busy or noise up, while signal is fine
    if activity is not None and activity >= 40 and (v['rssi'] is None or v['rssi'] > -75):
        ev = 'channel busy %.0f%% of the time' % activity
        if noise is not None and noise > -88:
            ev += ', noise floor %.1f dBm' % noise
        conf = 0.45 + min(0.3, (activity - 40) * 0.008)
        if (v['pl'] or 0) > 30 or (v['retries'] or 0) > 1.0:
            conf += 0.2
            ev += ', with heavy retransmission despite adequate signal'
        out.append({'cause': 'rf_congestion_or_interference', 'confidence': round(min(conf, 0.9), 2), 'evidence': ev})

    # 3. Configuration: one end roaming channels or widths while the other sits still
    freqs = bundle.get('freq_mhz') or []
    widths = bundle.get('chan_width_mhz') or []
    if len(freqs) > 1 or len(widths) > 1:
        out.append({'cause': 'configuration_or_channel_churn', 'confidence': 0.55,
                    'evidence': 'operated across %s MHz and %s MHz channel widths within one capture'
                                % ('/'.join(str(f) for f in freqs), '/'.join(str(w) for w in widths))})

    # 4. Link instability
    if conn is not None and conn < 95:
        out.append({'cause': 'link_instability', 'confidence': 0.7,
                    'evidence': 'peer associated only %.1f%% of samples' % conn})

    # 5. Range or geometry limited: weak signal is the actual constraint
    if v['rssi'] is not None and v['rssi'] <= -78:
        out.append({'cause': 'range_or_obstruction_limited', 'confidence': 0.6,
                    'evidence': 'median receive level %.0f dBm - signal is the binding constraint' % v['rssi']})

    # 6. Bench-test artefact: too close to draw conclusions from
    if v['rssi'] is not None and v['rssi'] > -45:
        out.append({'cause': 'bench_test_artefact', 'confidence': 0.5,
                    'evidence': 'median receive level %.0f dBm implies a very short path; front end may be '
                                'near compression, which mimics interference' % v['rssi']})

    # 7. Rate control not matching the signal, with no chain fault to explain it
    if (v['shortfall'] or 0) >= 4 and not any(o['cause'] == 'antenna_or_feed_fault' for o in out):
        out.append({'cause': 'rate_below_signal_unexplained', 'confidence': 0.5,
                    'evidence': 'ran %.0f MCS steps below what the level supports with no chain imbalance'
                                % v['shortfall']})

    # 8. Nothing wrong in the telemetry
    if not out:
        healthy = []
        if v['tq'] is not None: healthy.append('TQ %.0f/255' % v['tq'])
        if v['pl'] is not None: healthy.append('%.1f%% packet loss' % v['pl'])
        if v['mcs_max'] is not None: healthy.append('reached MCS %s' % v['mcs_max'])
        out.append({'cause': 'no_fault_found', 'confidence': 0.6,
                    'evidence': 'telemetry healthy: ' + ', '.join(healthy) if healthy else 'telemetry healthy'})
    return out

CAUSE_LABEL = {
    'antenna_or_feed_fault': 'Antenna, cable or connector fault',
    'rf_congestion_or_interference': 'RF congestion or interference',
    'configuration_or_channel_churn': 'Configuration / channel churn',
    'link_instability': 'Link instability (repeated dropouts)',
    'range_or_obstruction_limited': 'Range or obstruction limited',
    'bench_test_artefact': 'Bench-test artefact (too close)',
    'rate_below_signal_unexplained': 'Rate below signal, cause unexplained',
    'no_fault_found': 'No fault found in telemetry',
}

# ---------------------------------------------------------------------------
# Resolution parsing: what did we actually tell the customer to do?
# ---------------------------------------------------------------------------

RESOLUTION_PATTERNS = [
    ('replaced_antenna_or_cable', r'\b(replac\w+|swap\w*|new)\b.{0,30}\b(antenna|cable|pigtail|connector|feed)\b'),
    ('rma_or_hardware', r'\b(rma|return|replace\w* (the )?(radio|unit|board)|dead|faulty hardware)\b'),
    ('changed_channel_or_band', r'\b(chang\w+|mov\w+|switch\w+|re-?tun\w+)\b.{0,25}\b(channel|frequency|band)\b'),
    ('config_change', r'\b(config\w*|setting|uci|bandwidth|channel width|tx power|acs)\b.{0,25}\b(chang\w+|set|updat\w+|correct\w+)\b'),
    ('firmware_update', r'\b(firmware|f/?w)\b.{0,25}\b(updat\w+|upgrad\w+|flash\w*)\b'),
    ('antenna_position_or_height', r'\b(rais\w+|mount\w*|re-?aim\w*|realign\w*|height|mast|position)\b'),
    ('added_relay_or_node', r'\b(relay|repeater|additional (radio|node)|extra node)\b'),
    ('no_action_or_user_error', r'\b(no fault|working as (expected|designed)|user error|closed without|no issue found)\b'),
]

def parse_resolution(text):
    t = (text or '').lower()
    hits = [name for name, pat in RESOLUTION_PATTERNS if re.search(pat, t)]
    return hits or (['unrecorded'] if not t.strip() else ['other'])

# Does the fix we shipped address the cause the telemetry points at?
CAUSE_TO_FIX = {
    'antenna_or_feed_fault': {'replaced_antenna_or_cable', 'rma_or_hardware', 'antenna_position_or_height'},
    'rf_congestion_or_interference': {'changed_channel_or_band', 'config_change'},
    'configuration_or_channel_churn': {'config_change', 'changed_channel_or_band', 'firmware_update'},
    'link_instability': {'config_change', 'changed_channel_or_band', 'firmware_update',
                         'replaced_antenna_or_cable', 'rma_or_hardware'},
    'range_or_obstruction_limited': {'antenna_position_or_height', 'added_relay_or_node',
                                     'replaced_antenna_or_cable'},
    'bench_test_artefact': {'no_action_or_user_error'},
    'rate_below_signal_unexplained': {'changed_channel_or_band', 'config_change', 'firmware_update'},
    'no_fault_found': {'no_action_or_user_error'},
}

def score_alignment(causes, fixes):
    """Did the recorded resolution address the measured cause?"""
    if not fixes or fixes == ['unrecorded']:
        return 'resolution_not_recorded'
    primary = max(causes, key=lambda c: c['confidence'])['cause']
    expected = CAUSE_TO_FIX.get(primary, set())
    if expected & set(fixes):
        return 'fix_matches_telemetry'
    if 'no_action_or_user_error' in fixes and primary != 'no_fault_found':
        return 'closed_no_action_despite_finding'
    return 'fix_unrelated_to_telemetry'

# ---------------------------------------------------------------------------
def build(analysis_path, tickets_path=None):
    an = json.load(open(analysis_path, encoding='utf-8'))
    tickets = {}
    if tickets_path and os.path.exists(tickets_path):
        if tickets_path.endswith('.json'):
            for t in json.load(open(tickets_path, encoding='utf-8')):
                tickets[str(t.get('bundle') or t.get('attachment') or t.get('id'))] = t
        else:
            with open(tickets_path, newline='', encoding='utf-8') as fh:
                for t in csv.DictReader(fh):
                    tickets[str(t.get('bundle') or t.get('attachment') or t.get('id'))] = t

    links, per_cause = [], collections.Counter()
    per_model, per_band, per_fw = collections.Counter(), collections.Counter(), collections.Counter()
    alignment = collections.Counter()

    for bkey, b in an['bundles'].items():
        tk = tickets.get(bkey, {})
        fixes = parse_resolution(tk.get('resolution') or tk.get('notes') or '')
        for mac, peer in (b.get('peers') or {}).items():
            causes = classify(b, peer)
            align = score_alignment(causes, fixes) if tk else 'no_ticket_linked'
            primary = max(causes, key=lambda c: c['confidence'])
            links.append({
                'bundle': bkey, 'label': b.get('label'), 'peer': mac,
                'model': b.get('model'), 'firmware': b.get('firmware'),
                'band_mhz': (b.get('freq_mhz') or [None])[0],
                'causes': causes, 'primary_cause': primary['cause'],
                'primary_confidence': primary['confidence'],
                'ticket': {k: tk.get(k) for k in ('id', 'company', 'created', 'subject', 'stage', 'resolution') if tk.get(k)},
                'recorded_fixes': fixes if tk else [],
                'alignment': align,
            })
            for c in causes:
                per_cause[c['cause']] += 1
            per_model[b.get('model') or 'unknown'] += 1
            per_band[(b.get('freq_mhz') or ['unknown'])[0]] += 1
            per_fw[b.get('firmware') or 'unknown'] += 1
            alignment[align] += 1

    total = len(links)
    profile = {
        'links_analysed': total,
        'bundles': len(an['bundles']),
        'tickets_linked': sum(1 for l in links if l['ticket']),
        'cause_frequency': [{'cause': c, 'label': CAUSE_LABEL[c], 'links': n,
                             'pct_of_links': round(100.0 * n / max(total, 1), 1)}
                            for c, n in per_cause.most_common()],
        'primary_cause_frequency': [{'cause': c, 'label': CAUSE_LABEL[c], 'links': n,
                                     'pct': round(100.0 * n / max(total, 1), 1)}
                                    for c, n in collections.Counter(l['primary_cause'] for l in links).most_common()],
        'by_model': dict(per_model), 'by_band_mhz': {str(k): v for k, v in per_band.items()},
        'by_firmware': dict(per_fw),
        'resolution_alignment': dict(alignment),
        'links': links,
    }
    return profile

def main():
    ap = os.path.join(ROOT, 'data', 'log_analysis.json')
    tp = os.path.join(ROOT, 'data', 'tickets.json')       # produced by the HubSpot ingest
    prof = build(ap, tp if os.path.exists(tp) else None)
    dest = os.path.join(ROOT, 'data', 'failure_profile.json')
    json.dump(prof, open(dest, 'w', encoding='utf-8'), indent=1)

    print('links analysed: %d across %d bundles; tickets linked: %d'
          % (prof['links_analysed'], prof['bundles'], prof['tickets_linked']))
    print('\nWhere we fail (a link can have more than one cause):')
    for c in prof['cause_frequency']:
        print('  %-42s %3d links  %5.1f%%' % (c['label'], c['links'], c['pct_of_links']))
    print('\nMost likely primary cause per link:')
    for c in prof['primary_cause_frequency']:
        print('  %-42s %3d links  %5.1f%%' % (c['label'], c['links'], c['pct']))
    print('\nDid our fix address what the telemetry showed?')
    for k, v in prof['resolution_alignment'].items():
        print('  %-42s %3d' % (k, v))
    if not prof['tickets_linked']:
        print('\nNo ticket data present. Drop a HubSpot export at data/tickets.json with fields '
              'bundle, id, company, created, subject, stage, resolution to unlock the diagnosis '
              'and resolution scoring.')
    print('\nwritten', dest)

if __name__ == '__main__':
    main()
