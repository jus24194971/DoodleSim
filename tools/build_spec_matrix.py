# -*- coding: utf-8 -*-
"""Normalise the collected radio specs into a shot-for-shot comparison matrix.

Reads data/spec_models_raw.json (49 models across Doodle Labs, Silvus and DTC) and
emits data/spec_matrix.json in the shape make_master_report.py consumes.

The per-class assessments below are written by hand rather than generated, because
they are judgements about what the numbers mean. Every one is traceable to a figure
in the raw file, and where a comparison cannot be made the reason is stated instead
of the cell being left blank.
"""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'spec_models_raw.json')
DEST = os.path.join(ROOT, 'data', 'spec_matrix.json')

def short_vendor(v):
    v = v or ''
    if 'Doodle' in v: return 'Doodle Labs'
    if 'Silvus' in v: return 'Silvus'
    if 'Domo' in v or 'DTC' in v: return 'DTC'
    return v[:18]

_SAFE = {u'≤': '<=', u'≥': '>=', u'→': '->', u'≈': '~', u'–': '-', u'—': '-',
         u'‘': "'", u'’': "'", u'“': '"', u'”': '"', u'•': '-', u'±': '+/-',
         u'×': 'x', u'·': '-', u'�': '', u' ': ' '}

def tidy(t, n=200):
    """Normalise a spec value AND escape it for reportlab.

    Escaping happens here, at assembly time, because these values genuinely contain
    angle brackets - the Doodle range claim is literally '>8 Km (>5 Miles)'. The
    caller then wraps the result in <b> markup, so escaping downstream would turn
    those tags into visible text.
    """
    if not t or str(t).strip().lower().startswith('not published'):
        return 'not published'
    t = re.sub(r'\s+', ' ', str(t)).strip()
    # strip the agent's editorial framing, keep the figure
    t = re.sub(r'^(Verbatim[:,]?|Per the [^:]{0,40}:|Datasheet states BOTH:)\s*', '', t, flags=re.I)
    t = t[:n] + ('...' if len(t) > n else '')
    for k, v in _SAFE.items():
        t = t.replace(k, v)
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def key_specs(m):
    """One compact line per model: the fields an SE would actually compare."""
    bits = []
    for label, field, n in (('Bands', 'freq_bands_mhz', 110),
                            ('BW', 'channel_bw_mhz', 95),
                            ('TX', 'tx_power_dbm', 105),
                            ('MIMO', 'mimo', 45),
                            ('Weight', 'weight_g', 45),
                            ('Power', 'power_consumption_w', 55),
                            ('Mesh', 'mesh_nodes', 40),
                            ('Range', 'range_claim', 110)):
        v = tidy(m.get(field), n)
        if v and v != 'not published':
            bits.append('<b>%s</b> %s' % (label, v))
        elif field in ('mesh_nodes', 'range_claim'):
            bits.append('<b>%s</b> not published' % label)
    return '<br/>'.join(bits)

# Which classes roll up into which comparison group.
GROUPS = [
    {
        'group': 'A. Airborne embedded / OEM modules',
        'role': 'Board-level and drop-in modules for integration into a UAS or small UGV. '
                'The class where SWaP decides the design-in.',
        'classes': ['airborne_embedded'],
        'doodle_leads':
            'Channel granularity at the top end and published receive sensitivity. Our '
            'datasheets print a full per-MCS sensitivity table (mini-OEM MCS0 -93 dBm at '
            '20 MHz, scaling with bandwidth) which neither competitor matches at module '
            'level. The hex-band parts give six software-selectable bands across '
            '1625-2500 MHz with a dedicated SAW filter per band, against Silvus and DTC '
            'both selling fixed band-coded variants where changing band means changing '
            'hardware. On raw power we beat the smallest DTC module comfortably: 32 dBm '
            'combined against the BluSDR-6 at 200 mW total (23 dBm).',
        'doodle_trails':
            'Three things, and none are close. (1) Narrowest channel: we stop at 3 MHz '
            'while DTC ships 1.25 MHz as standard and Silvus offers 1.25 MHz as an '
            'option - narrow channels are the primary range lever, so this is a real gap '
            'rather than a spec-sheet nicety. (2) Mesh scale: we publish no node count at '
            'all, while Silvus states 550+ and DTC states 144. A customer asking "how many '
            'nodes" gets a number from both competitors and silence from us. (3) SWaP is '
            'not the win we claim here - the Silvus SL5200 is 26 g bare PCB against our '
            'mini-OEM at 36.5 g, and the DTC BluSDR-6 core PCB is also 26 g. Our advantage '
            'is real against complete radios, not against board-level modules.',
        'not_comparable':
            'Silvus does not print a MIMO order for the SL5200, so "2x2" cannot be quoted '
            'as a Silvus spec for that part - only the two RF ports and the MIMO technique '
            'list are published. Silvus also never states whether its 2 W native figure is '
            'per chain or total, so it cannot be compared like-for-like with our 32 dBm '
            'combined or DTC\'s explicit per-output-and-total pairs. DTC publishes no '
            'bandwidth list on the SOL8SDR-C datasheet.',
    },
    {
        'group': 'B. Small airborne complete radios',
        'role': 'Enclosed radios small enough to fly, one step up from a bare module.',
        'classes': ['airborne_small'],
        'doodle_leads':
            'Nothing decisive on published specification in this class. Our comparable '
            'parts are the same hex-band mini and nano in enclosures, so the module-level '
            'points carry over: sensitivity transparency and per-band filtering.',
        'doodle_trails':
            'Transmit power at the top of the class. The DTC BluSDR-90-R publishes 5 W per '
            'output and 10 W total; the BluSDR-30 publishes 1 W per output and 2 W total. '
            'Silvus SM5200 publishes 2 W native and up to 4 W effective at 182 g. Our '
            'airborne parts sit at roughly 1.6 W combined, so on raw power we are a class '
            'below both, and both competitors also reach narrower channels.',
        'not_comparable':
            'DTC does not publish a range figure for the SOL8SDR2x1W-P, and the BluSDR-30 '
            'range entry is a qualitative suitability statement ("medium range '
            'applications") rather than a distance. Weight comparison is muddied because '
            'DTC quotes several build variants per model (clamshell core, plain board) and '
            'Silvus quotes bare versus shielded.',
    },
    {
        'group': 'C. Handheld / wearable',
        'role': 'Body-worn or hand-carried radios for dismounted operators and GCS use.',
        'classes': ['handheld_wearable'],
        'doodle_leads':
            'Our Wearable carries the same hex-band software-selectable architecture, and '
            'we publish the full sensitivity ladder. Notably the DTC Sentry Mesh 6161 '
            'publishes no range figure at all despite marketing "performance, range, and '
            'versatility", so on published receive performance we are more transparent '
            'than DTC in this class.',
        'doodle_trails':
            'Channel granularity again: the Sentry 6161 lists 1.25 MHz upward through a '
            'fourteen-step ladder against our four steps. On mesh scale the Sentry states '
            '144 nodes and Silvus 550+, while we publish none.',
        'not_comparable':
            'Silvus SC4200E and SC4200EP are handheld-class by form factor but share a '
            'datasheet with the OEM module, so their published figures are not '
            'form-factor specific. DTC does not publish a bandwidth list on the SOL8SDR-H2 '
            'datasheet - only the product page gives "1.25 to 20 MHz".',
    },
    {
        'group': 'D. Vehicular, ground and high power',
        'role': 'Ground stations, vehicle installs and high-power base nodes.',
        'classes': ['vehicular', 'ground_base', 'dual_radio'],
        'doodle_leads':
            'Breadth of band coverage across the catalogue - the ground and multiband OEM '
            'parts span 245 MHz to 5.9 GHz including NATO C, CBRS and Japanese 5.7 GHz '
            'variants, which is wider than either competitor lists. The Mesh Rider Boost '
            'BDA gives an amplification path that neither competitor sells as a separate '
            'line item.',
        'doodle_trails':
            'Raw power, decisively. DTC publishes 15 W per channel and 30 W total on the '
            'BluSDR-200 and NETNode2x15W-5RH; Silvus publishes 20 W native on the SC4400E. '
            'Our ground parts do not approach those figures. DTC also publishes a typical '
            'range TABLE with separate NLOS and LOS rows (NLOS light urban 4 km, LOS '
            'ground-to-air 300 km on the 2x15W), which is both more useful and more '
            'defensible than a single headline number.',
        'not_comparable':
            'DTC qualifies its 15 W figure by modulation, so a single wattage cannot be '
            'compared without stating the modulation alongside. Silvus 20 W is published '
            'without a per-chain split. Our own ground-class datasheets were the weakest '
            'source material in this exercise - several models were collected at medium or '
            'low confidence because the published figures are thin.',
    },
]

# Cross-vendor gaps worth surfacing on their own, each traceable to the raw file.
SPEC_GAPS = [
    {'vendor': 'Doodle Labs', 'field': 'Mesh node count',
     'note': 'Not published on any Mesh Rider datasheet reviewed. Silvus publishes 550+ '
             'and DTC 144. This is the most conspicuous missing number in our catalogue.'},
    {'vendor': 'Doodle Labs', 'field': 'Transmit power consistency',
     'note': 'The mini-OEM datasheet publishes two power figures that disagree by 1 dB at '
             'MCS0/8 - an SMA-port figure and a "Combined Output Power" table. Both are '
             'recorded here; neither is wrong, but a customer comparing sheets will notice.'},
    {'vendor': 'Doodle Labs', 'field': 'Range claim conditions',
     'note': 'The ">8 km" module figure carries conditions (3 dBi both ends, unobstructed). '
             'The platform-level "field tested >100 km" claim carries none - no bandwidth, '
             'MCS, antenna, geometry or altitude. Both competitors attach conditions to '
             'their headline range claims, so this one is exposed.'},
    {'vendor': 'Doodle Labs', 'field': 'Certification identifiers',
     'note': 'The hex-band 1625-2500 MHz datasheet prints FCC ID 2AG87RM2450-2L and CE '
             '"Fully Certified (2.4-GHz)" - the 2.4 GHz part identifiers on a sheet for a '
             'different band. Recorded as printed; looks like a vendor copy error and is '
             'worth fixing before a customer raises it.'},
    {'vendor': 'Silvus', 'field': 'Per-chain vs total transmit power',
     'note': 'Never stated. Datasheets give "native" and "effective (with beamforming)" '
             'power without an antenna count in the same breath, so the figures cannot be '
             'converted to a per-chain comparison. Effective is consistently 2x native '
             'across the line, which is beamforming array arithmetic rather than radiated '
             'power from one port.'},
    {'vendor': 'Silvus', 'field': 'MIMO order on the SL5200',
     'note': 'No MIMO configuration row on that datasheet. Only two RF ports and a MIMO '
             'technique list are published, so "2x2" cannot be quoted as a Silvus figure '
             'for the SL5200 specifically.'},
    {'vendor': 'Silvus', 'field': 'Throughput conditions',
     'note': '"Up to 100 Mbps (adaptive)" appears with no bandwidth, MCS, range or duplex '
             'condition attached anywhere on the datasheet or product page.'},
    {'vendor': 'DTC', 'field': 'Bandwidth list on SDR datasheets',
     'note': 'The SOL8SDR-C and SOL8SDR2x1W-P datasheets carry no bandwidth list in the '
             'transceiver block; only the product pages give a range. The NETNode and '
             'BluSDR sheets do publish the full ladder.'},
    {'vendor': 'DTC', 'field': 'Range on personal and OEM radios',
     'note': 'The Sentry Mesh 6161 publishes no range figure despite marketing range, and '
             'the SOL8SDR-C publishes none either.'},
]

HEADLINE = (
    'Across all four classes the picture is consistent: we are competitive on band '
    'flexibility, published receive sensitivity and price, and we trail on narrowband '
    'channel granularity, raw transmit power and published mesh scale. The single most '
    'exposed gap is that we publish no mesh node count anywhere while both competitors '
    'do, and the single most useful competitive fact is that Silvus "effective" watts are '
    'beamforming arithmetic - consistently exactly twice the native figure - not radiated '
    'power a customer can compare against ours.'
)


def main():
    raw = json.load(open(SRC, encoding='utf-8'))
    models = raw['models']
    by_class = {}
    for m in models:
        by_class.setdefault(m.get('class') or 'other', []).append(m)

    groups, used = [], set()
    for g in GROUPS:
        rows = []
        for cls in g['classes']:
            for m in by_class.get(cls, []):
                rows.append(m)
                used.add(id(m))
        # Doodle first so the reader anchors on us, then competitors alphabetically
        rows.sort(key=lambda m: (0 if 'Doodle' in (m.get('vendor') or '') else 1,
                                 short_vendor(m.get('vendor')), m.get('model', '')))
        groups.append({
            'group': g['group'], 'role': g['role'],
            'models': [{'vendor': short_vendor(m.get('vendor')),
                        'model': re.sub(r'\s*\(.*$', '', m.get('model', ''))[:58],
                        'key_specs': key_specs(m)} for m in rows],
            'doodle_leads': g['doodle_leads'],
            'doodle_trails': g['doodle_trails'],
            'not_comparable': g['not_comparable'],
        })

    leftover = [m for m in models if id(m) not in used]
    out = {'source': raw.get('source'), 'generated': raw.get('generated'),
           'models': models,
           'matrix': {'groups': groups, 'spec_gaps': SPEC_GAPS, 'headline': HEADLINE},
           'coverage': raw.get('coverage'),
           'ungrouped': [m.get('model') for m in leftover]}
    json.dump(out, open(DEST, 'w', encoding='utf-8'), indent=1)

    print('written %s' % DEST)
    print('  %d models in %d comparison groups' % (sum(len(g['models']) for g in groups), len(groups)))
    for g in groups:
        vend = {}
        for m in g['models']:
            vend[m['vendor']] = vend.get(m['vendor'], 0) + 1
        print('    %-42s %s' % (g['group'][:42], dict(vend)))
    if leftover:
        print('  %d model(s) not in a comparison group (platform profiles, BDA, legacy):'
              % len(leftover))
        for m in leftover:
            print('    - %s' % (m.get('model') or '')[:70])


if __name__ == '__main__':
    main()
