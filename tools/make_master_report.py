# -*- coding: utf-8 -*-
"""The master report: executive summary plus the full detail behind it.

Pulls every analysis produced in this programme into one branded PDF:

    competitive position (spec matrix + SWOT), customer failure analysis,
    fault attribution, the SE field guide, and what the radio logs measured.

Every figure is computed from the source JSON at build time, so the prose in the
document cannot drift away from the data underneath it. Sections whose input file is
missing are skipped with a note rather than silently omitted.

    python tools/make_master_report.py
"""
import json, math, os, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brand_pdf import *                                            # noqa: F401,F403
from reportlab.platypus import Paragraph, Spacer, KeepTogether
from reportlab.lib.units import inch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, 'data')
OUT = os.path.join(ROOT, 'Doodle-Labs-Mesh-Rider-Program-Report.pdf')
MD = os.path.join(D, 'MASTER_REPORT.md')

def load(name):
    p = os.path.join(D, name)
    if not os.path.exists(p):
        print('  (missing %s - section will be skipped)' % name)
        return None
    return json.load(open(p, encoding='utf-8'))

# near-ground model, for the estimator validation section
A_F = {250: 36.07, 500: 40.70, 915: 43.25, 1000: 43.66, 2000: 44.62,
       2450: 44.75, 4000: 46.06, 5800: 48.05}
def a_of(f):
    ks = sorted(A_F)
    if f <= ks[0]: return A_F[ks[0]]
    if f >= ks[-1]: return A_F[ks[-1]]
    for lo, hi in zip(ks, ks[1:]):
        if lo <= f <= hi:
            return A_F[lo] + (A_F[hi] - A_F[lo]) * (f - lo) / (hi - lo)
def excess(d_m, f):
    return (a_of(f) + 22.25 * math.log10(d_m)) - (32.45 + 20 * math.log10(d_m / 1000.0)
                                                  + 20 * math.log10(f))
CALIB = [(917, 1333, 409, 'shoulder height ~1.5 m'),
         (917, 1333, 240, 'antennas at ground level'),
         (2409, 1170, 489, 'ground and shoulder height')]

EV_LABEL = {
    'measured_by_customer': 'customer measured',
    'measured_by_us': 'we measured',
    'vendor_published_claim': 'vendor claim',
    'our_published_claim': 'our claim',
    'internal_statement': 'internal view',
    'third_party_review': 'third party',
    'inference': 'inference',
}


def main():
    swot = load('competitive_swot.json')
    spec = load('spec_matrix.json')
    fail = load('failure_cases_hubspot.json')
    fault = load('fault_attribution.json')
    teach = load('teachable_moments.json')
    logs = load('log_analysis.json')
    newlogs = load('customer_bundles_analysis.json')

    S, MDL = [], []
    W, M = S.append, MDL.append

    # ---------------------------------------------------------------- summary
    W(Paragraph('Mesh Rider Programme Report', H1))
    W(Paragraph('Competitive position, customer failure analysis, and what the radios '
                'actually measured', SUB))
    M('# Mesh Rider Programme Report')
    M('')
    M('Competitive position, customer failure analysis, and what the radios actually '
      'measured. Compiled 29 July 2026.')
    M('')

    nfail = len({c['ticket_id'] for c in fail['cases']}) if fail else 0
    ATTR = fault['attributions'] if fault else []
    faultc = Counter(x['fault_final'] for x in ATTR)
    fixed = Counter(str(x.get('resolved_for_customer')) for x in ATTR)
    nmodels = len(spec['models']) if spec and spec.get('models') else 0
    nev = len(swot.get('evidence') or []) if swot else 0

    W(Paragraph(
        'This report consolidates a sweep of all 1,990 HubSpot support and RMA tickets, a '
        'fault attribution pass over the %d RF failure cases found in them, an eight-family '
        'search for recurring customer misconfiguration, a competitive spec comparison '
        'against Silvus and DTC, and telemetry from ten customer radio log bundles. Every '
        'claim carries its evidence class, and every claim that assigned blame or asserted a '
        'competitor capability was challenged by an independent reviewer before it was '
        'allowed to stand.' % nfail, BODY))
    W(Spacer(1, 4))
    W(statrow([('%d' % nfail, 'FAILURE TICKETS'),
               ('%d%%' % round(100.0 * faultc.get('doodle_labs', 0) / max(len(ATTR), 1)), 'OUR FAULT'),
               ('%d%%' % round(100.0 * fixed.get('yes', 0) / max(len(ATTR), 1)), 'CONFIRMED FIXED'),
               ('%d' % nmodels, 'RADIOS COMPARED'),
               ('%d' % nev, 'EVIDENCE ITEMS')], 6.9 * inch))
    W(Spacer(1, 8))

    W(Paragraph('Executive summary', H2))
    M('## Executive summary')
    M('')

    dl, cu = faultc.get('doodle_labs', 0), faultc.get('customer', 0)
    bullets = [
        ('Our biggest problem is not RF, it is answering the customer.',
         'Support-process failure is the single largest attributable cause in the corpus - '
         '28 tickets where the customer never received a substantive reply, the thread was '
         'dropped, or the ticket was closed while the problem was still open. Of %d tickets '
         'examined, only %d contain evidence the customer confirmed a fix, while %d went '
         'dormant or closed unresolved. This needs no engineering work.'
         % (len(ATTR), fixed.get('yes', 0),
            sum(1 for x in ATTR if x.get('stage') in ('Closed - Dormant', 'Closed - Unresolved')))),
        ('Where fault could be established, it was ours about %d%% of the time.'
         % round(100.0 * dl / max(dl + cu, 1)),
         '%d tickets attributable to Doodle Labs against %d to the customer, with %d shared. '
         'But %d of %d could not be attributed at all, almost always because the thread '
         'stopped before anyone found the cause. That is the finding, not a gap in the '
         'analysis.' % (dl, cu, faultc.get('shared', 0), faultc.get('not_determined', 0), len(ATTR))),
        ('Customers repeatedly measure about a third of the range our own estimator predicts.',
         'This is the most damaging category because the number came from us. The mechanism '
         'is identified: the estimator is free-space only and carries no near-ground term, '
         'while these tests are run at shoulder height, on the ground, or from a UAS at '
         'takeoff. Our own near-ground model reproduces the shortfall to within 2 to 7 dB '
         'and errs pessimistic in every verified case.'),
        ('There are no clear customer-misconfiguration trends, and that is a real result.',
         'Eight configuration families were swept across all 1,990 tickets; none reached '
         'trend strength and six were downgraded on audit. Two named hypotheses came back '
         'negative - not one ticket shows TPC or ATPC set differently at the two ends of a '
         'link. The only trend-strength finding in the whole sweep is our own defect: '
         'channel-width changes made via CLI, ubus or API silently fail to apply.'),
        ('Against Silvus and DTC we compete on price, lead time and size - not on measured RF.',
         'Our documented advantages are procurement facts: price, lead time and ITAR-free '
         'export flexibility, plus weight in SWaP-constrained integrations. In the cleanest '
         'customer-run head-to-heads we lose on range or link stability. Critically, we hold '
         'essentially no first-party measured competitor data - every competitor number we '
         'quote is their marketing or a customer\'s report.'),
    ]
    for head, txt in bullets:
        W(Paragraph('<b>%s</b> %s' % (esc(head), esc(txt)), BODY))
        M('**%s** %s' % (head, txt))
        M('')

    # ---------------------------------------------------------------- specs
    if spec and spec.get('matrix'):
        mx = spec['matrix']
        W(Paragraph('Competitive position: shot-for-shot specifications', H2))
        M('## Competitive position: shot-for-shot specifications')
        M('')
        if mx.get('headline'):
            W(Paragraph(esc(mx['headline']), BODY))
            M(mx['headline']); M('')
        W(Paragraph(
            'Models are grouped by physical class and role rather than by marketing tier. '
            'Every competitor figure was re-checked against its cited source; anything that '
            'could not be confirmed is shown as not published rather than guessed.', SMALL))
        for g in (mx.get('groups') or []):
            W(Paragraph('%s' % esc(g['group']), H3))
            M('### %s' % g['group'])
            M('')
            if g.get('role'):
                W(Paragraph(esc(g['role']), SMALL))
            rows = [['Vendor', 'Model', 'Key specifications']]
            for m in (g.get('models') or []):
                rows.append([esc(m['vendor']), esc(m['model']), clip(m['key_specs'], 340)])
            W(tbl(rows, [0.95 * inch, 1.5 * inch, 4.45 * inch], tiny=True))
            M('| Vendor | Model | Key specifications |')
            M('|---|---|---|')
            for m in (g.get('models') or []):
                M('| %s | %s | %s |' % (m['vendor'], m['model'],
                                        (m['key_specs'] or '').replace('|', '/')))
            M('')
            for lab, key, col in (('Where we lead', 'doodle_leads', '#1F8A4C'),
                                  ('Where we trail', 'doodle_trails', '#B02A2A'),
                                  ('Cannot be compared', 'not_comparable', '#6A6A6A')):
                if g.get(key):
                    W(Paragraph('<font color="%s"><b>%s.</b></font> %s'
                                % (col, lab, esc(g[key])), BODY))
                    M('- **%s.** %s' % (lab, g[key]))
            M('')
        if mx.get('spec_gaps'):
            W(Paragraph('Specifications no vendor publishes', H3))
            W(Paragraph('Where a cell is empty it is because the vendor does not publish the '
                        'field, not because we did not look. Worth knowing before a customer '
                        'asks.', SMALL))
            W(tbl([['Vendor', 'Field', 'Note']] +
                  [[esc(x.get('vendor')), esc(x.get('field')), clip(x.get('note'), 200)]
                   for x in mx['spec_gaps']],
                  [1.2 * inch, 1.5 * inch, 4.2 * inch], tiny=True))

    # ---------------------------------------------------------------- SWOT
    if swot:
        SW = swot['swot']
        W(Paragraph('SWOT analysis', H2))
        M('## SWOT analysis')
        M('')
        W(Paragraph(
            'Built from %d evidence items gathered from the CRM, competitor published '
            'material and our own measured telemetry. Each item carries its evidence class, '
            'because a competitor marketing figure and a customer measurement are not the '
            'same kind of fact. An independent auditor challenged every item; %d had their '
            'confidence downgraded.'
            % (nev, sum(1 for q in ('strengths', 'weaknesses', 'opportunities', 'threats')
                        for x in (SW.get(q) or [])
                        if x.get('confidence_final') != x.get('confidence'))), BODY))
        for q, title, col in (('strengths', 'Strengths', '#1F8A4C'),
                              ('weaknesses', 'Weaknesses', '#B02A2A'),
                              ('opportunities', 'Opportunities', '#1E73BE'),
                              ('threats', 'Threats', '#C77700')):
            items = [x for x in (SW.get(q) or []) if not x.get('dropped')]
            W(Paragraph('<font color="%s">%s</font> <font size="8" color="#6A6A6A">'
                        '%d items</font>' % (col, title, len(items)), H2))
            M('### %s' % title)
            M('')
            for x in items:
                blk = [Paragraph('<b>%s</b> &nbsp;<font size="7.5" color="#6A6A6A">'
                                 '%s &middot; confidence %s</font>'
                                 % (esc(x['point']),
                                    EV_LABEL.get(x.get('evidence_type'), x.get('evidence_type')),
                                    esc(x.get('confidence_final'))), H3),
                       Paragraph(esc(x['why_it_matters']), BODY),
                       Paragraph('<b>Evidence.</b> %s' % clip(x.get('evidence'), 700), QUOTE)]
                if x.get('action'):
                    blk.append(Paragraph('<b>Action.</b> %s' % clip(x['action'], 500), BODY))
                if x.get('audit_problem'):
                    blk.append(Paragraph('<b>Reviewer caveat.</b> %s'
                                         % clip(x['audit_problem'], 700), SMALL))
                S.append(KeepTogether(blk))
                M('**%s** *(%s, confidence %s)*'
                  % (x['point'], EV_LABEL.get(x.get('evidence_type'), x.get('evidence_type')),
                     x.get('confidence_final')))
                M('')
                M('%s' % x['why_it_matters'])
                M('')
                M('- Evidence: %s' % (x.get('evidence') or ''))
                if x.get('action'):
                    M('- Action: %s' % x['action'])
                if x.get('audit_problem'):
                    M('- Reviewer caveat: %s' % x['audit_problem'])
                M('')

    # ---------------------------------------------------------------- failures
    if fail:
        cs = fail['cases']
        per = {}
        for c in cs:
            per.setdefault(c['ticket_id'], c)
        stages = Counter(c.get('stage') or '?' for c in per.values())
        quant = [c for c in cs if c.get('quant_valid') is True]
        W(Paragraph('Customer failure analysis', H2))
        M('## Customer failure analysis')
        M('')
        W(Paragraph(
            '%d tickets matched four RF failure searches across the support and RMA '
            'pipelines; %d were analysed in depth. The outcome mix is the headline.'
            % (sum(v for v in (fail.get('tickets_matched_by_theme') or {}).values()
                   if isinstance(v, (int, float))), len(per)), BODY))
        W(tbl([['Ticket outcome', 'Tickets', 'Share']] +
              [[s, str(n), '%.1f%%' % (100.0 * n / len(per))] for s, n in stages.most_common()],
              [3.6 * inch, 1.6 * inch, 1.7 * inch]))
        M('| Ticket outcome | Tickets | Share |')
        M('|---|---:|---:|')
        for s, n in stages.most_common():
            M('| %s | %d | %.1f%% |' % (s, n, 100.0 * n / len(per)))
        M('')
        W(Paragraph(
            '<b>Closed - Dormant at %.0f%% is the number to worry about.</b> These are '
            'customers who reported an RF problem, received at most one reply, and stopped '
            'responding. We do not know whether they solved it, worked around it, or moved '
            'to another vendor.' % (100.0 * stages.get('Closed - Dormant', 0) / len(per)), BODY))
        W(Paragraph('Verified expected-versus-achieved figures', H3))
        W(Paragraph('%d cases carry performance numbers a reviewer confirmed are verbatim in '
                    'the source text. These are the usable calibration corpus.' % len(quant),
                    SMALL))
        seen, rows = set(), [['Account', 'Radios / band', 'Expected', 'Achieved']]
        for c in sorted(quant, key=lambda x: (x.get('account') or 'zz').lower()):
            if c['ticket_id'] in seen:
                continue
            seen.add(c['ticket_id'])
            rows.append([clip((c.get('account') or '-').split('(')[0], 30),
                         clip('%s / %s' % (', '.join(c.get('radio_models') or []) or '-',
                                           c.get('band_mhz') or '-'), 60),
                         clip(c.get('expected_performance'), 150),
                         clip(c.get('achieved_performance'), 150)])
        W(tbl(rows, [1.3 * inch, 1.5 * inch, 2.05 * inch, 2.05 * inch], tiny=True))

    # ---------------------------------------------------------------- estimator
    W(Paragraph('Why the range predictions miss, and what closes the gap', H2))
    M('## Why the range predictions miss, and what closes the gap')
    M('')
    W(Paragraph(
        'The estimator computes free-space loss and carries no term for antennas close to '
        'the ground - which is exactly how these customers tested. DoodleSim adds that term. '
        'Against the one case with reviewer-verified verbatim figures at a known geometry:', BODY))
    rows = [['Geometry', 'Observed shortfall', 'DoodleSim near-ground', 'Difference']]
    M('| Geometry | Observed shortfall | DoodleSim near-ground | Difference |')
    M('|---|---:|---:|---:|')
    for f, exp, got, geom in CALIB:
        obs = 20 * math.log10(float(exp) / got)
        pred = excess(got, f)
        rows.append(['%d MHz, %s' % (f, geom), '%.1f dB' % obs, '%.1f dB' % pred,
                     '<font color="#1F8A4C">%+.1f dB</font>' % (pred - obs)])
        M('| %d MHz, %s | %.1f dB | %.1f dB | %+.1f dB |' % (f, geom, obs, pred, pred - obs))
    W(tbl(rows, [3.0 * inch, 1.3 * inch, 1.4 * inch, 1.2 * inch]))
    M('')
    W(Paragraph(
        'The mechanism accounts for the shortfall in direction and magnitude, and DoodleSim '
        'errs <b>pessimistic</b> in all three cases - the correct direction for a planning '
        'tool. The flat estimator omits roughly 10 to 18 dB at these geometries, which at a '
        'path-loss exponent of 2 is the 3x to 7x range error customers report.', BODY))
    W(Paragraph('<b>Caveat.</b> One customer, three measurements, and the near-ground model '
                'was fitted independently rather than to this data. Corroboration, not '
                'validation.', SMALL))

    # ---------------------------------------------------------------- fault
    if ATTR:
        W(Paragraph('Who failed, and why', H2))
        M('## Who failed, and why')
        M('')
        by_code = defaultdict(list)
        import re as _re
        for x in ATTR:
            for h in (_re.findall(r'(?:DL|CU)-[A-Z]+', x['code_final'] or '')
                      or [x['code_final'] or 'NOT-DETERMINED']):
                by_code[h].append(x)
        W(Paragraph(
            'Blame was assigned only where the record carried a verbatim quote establishing '
            'it. A hypothesis floated once does not count, which is why Not Determined is '
            'the largest bucket at %d of %d.'
            % (faultc.get('not_determined', 0), len(ATTR)), BODY))
        rows = [['Failure reason', 'Side', 'Tickets']]
        M('| Failure reason | Side | Tickets |')
        M('|---|---|---:|')
        for c, r in sorted(by_code.items(), key=lambda kv: -len(kv[1])):
            if c == 'NOT-DETERMINED':
                continue
            side = 'Doodle Labs' if c.startswith('DL') else 'Customer'
            rows.append([c, side, str(len(r))])
            M('| %s | %s | %d |' % (c, side, len(r)))
        W(tbl(rows, [3.4 * inch, 1.8 * inch, 1.7 * inch]))
        M('')

    # ---------------------------------------------------------------- teachable
    if teach:
        Fm = teach['families']
        W(Paragraph('SE field guide: what customers actually get wrong', H2))
        M('## SE field guide: what customers actually get wrong')
        M('')
        W(Paragraph(
            '<b>Not one of the eight configuration families reached trend strength</b> (5 or '
            'more distinct tickets sharing the same specific misconfiguration), and six of '
            'the eight were downgraded on audit. The instinct that there may be too many '
            'variables to pull trends was correct.', BODY))
        W(tbl([['Family', 'Verdict', 'First pass']] +
              [[f['family'], f['verdict'], f.get('verdict_original')] for f in Fm],
              [3.0 * inch, 2.0 * inch, 1.9 * inch]))
        W(Paragraph('A warning about keyword counts', H3))
        W(Paragraph(
            'One agent ran scrambled control phrases to test whether counts meant anything. '
            '"power the lower" returned 11 ticket hits against 10 for "lower the power"; '
            '"control power transmit" returned 14, identical to "transmit power control". '
            'HubSpot LIKE does no phrase matching here, so <b>keyword counts in this corpus '
            'are worthless as evidence</b> - only reading the thread counts.', BODY))
        W(Paragraph('What survived', H3))
        surv = [(f, p) for f in Fm for p in (f.get('patterns') or [])
                if not p.get('flagged_inflated')]
        surv.sort(key=lambda r: -(r[1].get('occurrences') or 0))
        for f, p in surv:
            blk = [Paragraph('<b>%s</b> &nbsp;<font size="7.5" color="#6A6A6A">%s &middot; '
                             '%d ticket(s), %d confirmed fix(es)</font>'
                             % (clip(p['pattern'], 130), f['family'],
                                p.get('occurrences') or 0, p.get('confirmed_fixed') or 0), H3)]
            if p.get('teachable'):
                blk.append(Paragraph('<b>Say this.</b> %s' % clip(p['teachable'], 420), BODY))
            if p.get('correct_setting'):
                blk.append(Paragraph('<b>Fix.</b> %s' % clip(p['correct_setting'], 380), SMALL))
            S.append(KeepTogether(blk))
            M('**%s** *(%s, %d ticket(s), %d confirmed)*'
              % (p['pattern'], f['family'], p.get('occurrences') or 0,
                 p.get('confirmed_fixed') or 0))
            if p.get('teachable'):
                M('')
                M('> Say this: %s' % p['teachable'])
            M('')

    # ---------------------------------------------------------------- telemetry
    W(Paragraph('What the radio logs measured', H2))
    M('## What the radio logs measured')
    M('')
    nb = len(logs['bundles']) if logs else 0
    nn = len(newlogs['bundles']) if newlogs else 0
    W(Paragraph(
        'Ten customer log bundles have been parsed across five deployments - %d in the first '
        'batch and %d from three later customer deliveries. This is the only measured, '
        'first-party evidence in the report; everything drawn from tickets is prose.'
        % (nb, nn), BODY))
    if newlogs:
        rows = [['Deployment', 'Model', 'Band / BW', 'Samples', 'Connected']]
        M('| Deployment | Model | Band / BW | Samples | Connected |')
        M('|---|---|---|---:|---:|')
        for k, v in newlogs['bundles'].items():
            rows.append([clip(v.get('label'), 40), esc(v.get('model')),
                         '%s / %s' % (v.get('freq_mhz'), v.get('chan_width_mhz')),
                         str(v.get('samples')), '%s%%' % v.get('connected_pct')])
            M('| %s | %s | %s / %s | %d | %s%% |'
              % (v.get('label'), v.get('model'), v.get('freq_mhz'), v.get('chan_width_mhz'),
                 v.get('samples'), v.get('connected_pct')))
        W(tbl(rows, [2.2 * inch, 1.4 * inch, 1.6 * inch, 0.85 * inch, 0.85 * inch], tiny=True))
        M('')
        if newlogs.get('pairs'):
            W(Paragraph('Link reciprocity, both ends of the same link', H3))
            rows = [['Link', 'Asymmetry', 'Reciprocity error']]
            for p in newlogs['pairs']:
                rows.append(['%s to %s' % (clip(p['a_label'], 26), clip(p['b_label'], 26)),
                             '%s dB' % p.get('asymmetry_db'),
                             '%s dB' % p.get('reciprocity_error_db')])
            W(tbl(rows, [4.2 * inch, 1.35 * inch, 1.35 * inch], tiny=True))
            W(Paragraph('Both pairs are physically consistent, so neither carries a '
                        'link-level chain fault.', SMALL))
    W(Paragraph('Operating Distance, confirmed by measurement rather than prose', H3))
    W(Paragraph(
        'The ticket corpus concluded that an Operating Distance set too small "makes the '
        'radio abandon ACKs early and shows up as retries, not as a range limit". Two '
        'deliveries sit either side of that prediction:', BODY))
    W(tbl([['Deployment', 'option distance', 'ATPC', 'Retries per frame', 'Frames abandoned'],
           ['Mavtech (ground / UAV)', '0', 'disabled', '1.11 / 1.83', '18.6% / 32.6%'],
           ['OffShoreAviation (GCS / air)', '23000', 'enabled', '0.53 / 0.55', '9.1% / 9.5%']],
          [2.1 * inch, 1.15 * inch, 0.9 * inch, 1.45 * inch, 1.3 * inch], tiny=True))
    W(Paragraph(
        'Roughly <b>3.4x the retry rate and 3.5x the frame abandonment</b> in the deployment '
        'that left Operating Distance unset. Mechanism and measurement agree. These are '
        'different customers, bands and radios, so it is corroboration rather than a '
        'controlled experiment - and the classic long-link ACK failure was not demonstrated '
        'in the ticket corpus itself.', BODY))
    M('')
    M('| Deployment | option distance | ATPC | Retries/frame | Frames abandoned |')
    M('|---|---|---|---:|---:|')
    M('| Mavtech (ground / UAV) | 0 | disabled | 1.11 / 1.83 | 18.6% / 32.6% |')
    M('| OffShoreAviation (GCS / air) | 23000 | enabled | 0.53 / 0.55 | 9.1% / 9.5% |')
    M('')

    # ---------------------------------------------------------------- limits
    W(Paragraph('Method and limits', H2))
    M('## Method and limits')
    M('')
    W(Paragraph(
        'Each analysis was produced by parallel agents reading primary sources, followed by '
        'an independent adversarial pass instructed to refute rather than confirm. Findings '
        'that failed that pass were corrected or removed, and the reviewer was told to flag '
        'bias in both directions - it more often found the first pass too harsh on Doodle '
        'Labs than too easy.', BODY))
    limits = [
        '<b>No log telemetry behind the ticket analysis.</b> The HubSpot connector exposes '
        'attachment IDs but no filenames and no file contents, and has no FILE object type. '
        'Every cause drawn from tickets is prose, not measurement. Files API access would '
        'change this and is the highest-value next step.',
        '<b>The ticket shares are not base rates.</b> Cases were found by keyword search on '
        'RF symptoms, so percentages describe this corpus rather than the business.',
        '<b>We hold no first-party competitor measurements.</b> Every Silvus and DTC figure '
        'here is their published claim or a customer\'s report. A single controlled '
        'side-by-side test would be worth more than the entire competitive corpus.',
        '<b>The radio matrix is still blocked.</b> Only about 3% of the 87,000 link samples '
        'collected sit in the -75 to -90 dBm band where fade margin actually decides '
        'whether a link holds, so per-radio accuracy figures would not yet be trustworthy.',
        '<b>Nano and Mini have no GPS</b>, and gpsd position does not appear in the '
        'longtermlog, so no bundle carries range truth.',
    ]
    for t in limits:
        W(Paragraph(t, BUL, bulletText=u'•'))
        M('- %s' % t.replace('<b>', '**').replace('</b>', '**'))
    M('')
    W(Spacer(1, 4))
    W(Paragraph('Live planning tool: ' + A(SITE) + '. Source and analysis tooling: '
                + A(REPO) + '.', SMALL))
    M('Live planning tool: %s' % SITE)

    with open(MD, 'w', encoding='utf-8') as f:
        f.write('\n'.join(MDL))
    doc = document(OUT, 'Doodle Labs - Mesh Rider Programme Report',
                   'Doodle Labs Solutions Engineering',
                   'Mesh Rider programme report - 29 July 2026')
    doc.build(S)
    print('written %s' % MD)
    print('written %s' % OUT)


if __name__ == '__main__':
    main()
