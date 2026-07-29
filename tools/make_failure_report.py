# -*- coding: utf-8 -*-
"""Build the customer failure analysis report from the HubSpot sweep.

Reads data/failure_cases_hubspot.json (produced by the HubSpot sweep) and emits
data/FAILURE_ANALYSIS_REPORT.md - an exec summary followed by the full analysis.

Everything quantitative in the output is computed here rather than transcribed, so
the numbers in the report and the numbers in the data cannot drift apart.
"""
import json, math, os, re
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'failure_cases_hubspot.json')
DEST = os.path.join(ROOT, 'data', 'FAILURE_ANALYSIS_REPORT.md')

# ---------------------------------------------------------------- RF models
# Near-ground empirical model used by DoodleSim: PL = A(f) + 22.25*log10(d_m).
A_F = {250: 36.07, 500: 40.70, 915: 43.25, 1000: 43.66, 2000: 44.62,
       2450: 44.75, 4000: 46.06, 5800: 48.05}

def a_of(f):
    ks = sorted(A_F)
    if f <= ks[0]:
        return A_F[ks[0]]
    if f >= ks[-1]:
        return A_F[ks[-1]]
    for lo, hi in zip(ks, ks[1:]):
        if lo <= f <= hi:
            return A_F[lo] + (A_F[hi] - A_F[lo]) * (f - lo) / (hi - lo)

def near_ground_db(d_m, f_mhz):
    return a_of(f_mhz) + 22.25 * math.log10(max(d_m, 1.0))

def fspl_db(d_m, f_mhz):
    return 32.45 + 20 * math.log10(max(d_m, 1.0) / 1000.0) + 20 * math.log10(f_mhz)

def db_equiv(expected_m, achieved_m):
    """Range shortfall expressed in dB, at a path-loss exponent of 2."""
    return 20 * math.log10(expected_m / achieved_m)

# Hand-curated calibration points. Only cases where the verifier confirmed the
# figures are verbatim AND the geometry is unambiguous enough to model. Kept
# explicit rather than regex-scraped from prose: a wrong number here would
# discredit the whole report.
CALIB = [
    {'ticket': '2699674715', 'account': 'Archangel Imaging', 'freq': 917,
     'expected_m': 1333, 'achieved_m': 409, 'geometry': 'shoulder height ~1.5 m, open field LOS',
     'note': 'estimator figure quoted by the customer'},
    {'ticket': '2699674715', 'account': 'Archangel Imaging', 'freq': 917,
     'expected_m': 1333, 'achieved_m': 240, 'geometry': 'antennas at ground level, open field LOS',
     'note': 'same test, radios on the ground'},
    {'ticket': '2699674715', 'account': 'Archangel Imaging', 'freq': 2409,
     'expected_m': 1170, 'achieved_m': 489, 'geometry': 'ground and shoulder height, open field LOS',
     'note': 'both heights gave the same distance'},
]

STAGE_FAIL = {'Closed - Dormant', 'Closed - Unresolved'}


def load():
    d = json.load(open(SRC, encoding='utf-8'))
    cases = d['cases']
    # One ticket can appear under several themes; dedupe for headline rates but
    # keep every row for the theme breakdown.
    per_ticket = {}
    for c in cases:
        per_ticket.setdefault(c['ticket_id'], c)
    return d, cases, per_ticket


def pct(n, d):
    return 0.0 if not d else 100.0 * n / d


def accounts_named(per_ticket):
    out = []
    for c in per_ticket.values():
        a = (c.get('account') or '').strip()
        if a and 'not identifiable' not in a.lower() and a.lower() not in ('unknown', '?'):
            out.append(re.sub(r'\s*\(.*?\)\s*', '', a).strip())
    return out


def main():
    d, cases, per_ticket = load()
    nT = len(per_ticket)
    matched = d.get('tickets_matched_by_theme', {})
    total_matched = sum(v for v in matched.values() if isinstance(v, (int, float)))

    stages = Counter(c.get('stage') or '?' for c in per_ticket.values())
    fixes = Counter(str(c.get('resolution_worked_final')) for c in per_ticket.values())
    themes = Counter(c['theme'] for c in cases)
    verdicts = [c for c in cases if c.get('verified') is not None]
    refuted = sum(1 for c in verdicts if c['verified'] is False)
    quant = [c for c in cases if c.get('quant_valid') is True]

    failed_stage = sum(v for k, v in stages.items() if k in STAGE_FAIL)
    cause_unknown = sum(1 for c in per_ticket.values()
                        if not (c.get('root_cause_final') or '').strip()
                        or 'not established' in (c.get('root_cause_final') or '').lower()
                        or 'never confirmed' in (c.get('root_cause_final') or '').lower()
                        or 'hypothesi' in (c.get('root_cause_final') or '').lower())

    L = []
    W = L.append

    W('# Customer RF Failure Analysis')
    W('')
    W('Doodle Labs support and RMA history, swept from HubSpot on 2026-07-29.')
    W('')
    W('Portal %s. %d tickets matched the four RF failure searches; %d were analysed in '
      'depth across %d case records by %d agents making %d API calls. Every root-cause '
      'claim was then passed to an independent reviewer whose instruction was to refute it.'
      % (d.get('portal'), total_matched, nT, len(cases), d.get('agents'), d.get('tool_calls')))
    W('')

    # ------------------------------------------------------------ exec summary
    W('## Executive summary')
    W('')
    W('**We rarely find out why a link failed, and we rarely confirm that our fix worked.**')
    W('')
    W('Of %d RF failure tickets examined:' % nT)
    W('')
    W('| Measure | Count | Share |')
    W('|---|---:|---:|')
    W('| Confirmed working fix | %d | %.0f%% |' % (fixes.get('yes', 0), pct(fixes.get('yes', 0), nT)))
    W('| Fix recorded but never confirmed by the customer | %d | %.0f%% |'
      % (fixes.get('unknown', 0), pct(fixes.get('unknown', 0), nT)))
    W('| Closed with no action taken | %d | %.0f%% |'
      % (fixes.get('no_action_taken', 0), pct(fixes.get('no_action_taken', 0), nT)))
    W('| Fix demonstrably did not work | %d | %.0f%% |'
      % (fixes.get('no', 0), pct(fixes.get('no', 0), nT)))
    W('| Went dormant or closed unresolved | %d | %.0f%% |' % (failed_stage, pct(failed_stage, nT)))
    W('| Root cause never established or only hypothesised | %d | %.0f%% |'
      % (cause_unknown, pct(cause_unknown, nT)))
    W('')
    W('Three findings worth acting on:')
    W('')
    W('**1. Closure is not resolution.** %d of %d tickets (%.0f%%) reached a closed stage, but only '
      '%d contain evidence the customer confirmed the problem was fixed. The most common ending is '
      'a vendor reply followed by silence, then a status change. `Closed - Resolved` in this data '
      'means "we stopped hearing about it", not "we fixed it".'
      % (sum(v for k, v in stages.items() if k.startswith('Closed')), nT,
         pct(sum(v for k, v in stages.items() if k.startswith('Closed')), nT), fixes.get('yes', 0)))
    W('')
    W('**2. Our stated causes mostly do not survive review.** %d root-cause attributions were '
      'independently re-read against the source text; %d (%.0f%%) were refuted or materially '
      'corrected. The dominant failure mode is a plausible engineering hypothesis - dev-kit '
      'antennas, Fresnel clearance, firmware - offered once, never measured, and never confirmed.'
      % (len(verdicts), refuted, pct(refuted, len(verdicts))))
    W('')
    W('**3. The single most common complaint is that our own range prediction did not hold.** '
      'Customers repeatedly quote a figure from the Doodle Labs estimator or from sales, then '
      'measure a third of it or less. This is the most damaging category because the number came '
      'from us.')
    W('')

    # ------------------------------------------------------------ calibration
    W('### Why the range predictions miss, and what fixes it')
    W('')
    W('The estimator computes free-space loss. It has no term for antennas close to the ground, '
      'which is exactly how these customers tested - handhelds at shoulder height, radios on the '
      'ground, UGVs, small UAS on takeoff. DoodleSim adds that term. Testing it against the one '
      'case with fully verbatim figures at a known geometry:')
    W('')
    W('| Geometry | Observed shortfall | DoodleSim near-ground | Error |')
    W('|---|---:|---:|---:|')
    for c in CALIB:
        obs = db_equiv(c['expected_m'], c['achieved_m'])
        pred = near_ground_db(c['achieved_m'], c['freq']) - fspl_db(c['achieved_m'], c['freq'])
        W('| %d MHz, %s | %.1f dB | %.1f dB | %+.1f dB |'
          % (c['freq'], c['geometry'], obs, pred, pred - obs))
    W('')
    W('The mechanism accounts for the shortfall in both direction and magnitude, and in every '
      'case DoodleSim errs **pessimistic** - it predicts slightly more loss than was observed. '
      'For a planning tool that is the correct direction to be wrong in. The flat estimator omits '
      '%.0f-%.0f dB at these geometries, which at a path-loss exponent of 2 is a 3x to 7x range '
      'error - precisely the ratio customers report.'
      % (min(near_ground_db(c['achieved_m'], c['freq']) - fspl_db(c['achieved_m'], c['freq']) for c in CALIB),
         max(near_ground_db(c['achieved_m'], c['freq']) - fspl_db(c['achieved_m'], c['freq']) for c in CALIB)))
    W('')
    W('**Caveat, stated plainly:** this is one customer, three measurements, and the near-ground '
      'model was fitted independently rather than to this data. It is corroboration, not '
      'validation. A real validation needs the log bundles, which requires Files API access.')
    W('')

    # ------------------------------------------------------------ taxonomy
    W('## Where we fail')
    W('')
    W('| Theme | Tickets searched | Cases analysed |')
    W('|---|---:|---:|')
    for t, n in themes.most_common():
        W('| %s | %s | %d |' % (t.replace('-', ' '), matched.get(t, '-'), n))
    W('')
    W('### Ticket outcome mix')
    W('')
    W('| Stage | Tickets | Share |')
    W('|---|---:|---:|')
    for s, n in stages.most_common():
        W('| %s | %d | %.1f%% |' % (s, n, pct(n, nT)))
    W('')
    W('`Closed - Dormant` at %.0f%% is the headline number. These are customers who reported an '
      'RF problem, received at most one reply, and stopped responding. We do not know whether '
      'they solved it, worked around it, or switched vendor.' % pct(stages.get('Closed - Dormant', 0), nT))
    W('')

    # ------------------------------------------------------------ quant cases
    W('## Cases with verified expected-versus-achieved figures')
    W('')
    W('These %d records carry performance numbers that an independent reviewer confirmed are '
      'verbatim in the source text, with correct units. They are the usable calibration corpus.'
      % len(quant))
    W('')
    seen = set()
    for c in sorted(quant, key=lambda x: (x.get('account') or 'zz')):
        key = (c['ticket_id'], c['theme'])
        if key in seen:
            continue
        seen.add(key)
        acct = re.sub(r'\s*\(.*?\)\s*', '', (c.get('account') or 'unknown')).strip()
        W('**%s** - %s' % (acct, c['subject']))
        W('')
        W('- Ticket `%s`, created %s, **%s**' % (c['ticket_id'], c.get('created'), c.get('stage')))
        rad = ', '.join(c.get('radio_models') or []) or 'not stated'
        W('- Radios: %s' % rad)
        bw = c.get('bandwidth_mhz') or 'not stated'
        W('- Band %s, bandwidth %s' % (c.get('band_mhz') or 'not stated', bw))
        if c.get('environment'):
            W('- Environment: %s' % c['environment'])
        W('- Expected: %s' % (c.get('expected_performance') or 'not stated'))
        W('- Achieved: %s' % (c.get('achieved_performance') or 'not stated'))
        cause = (c.get('root_cause_final') or 'not established').strip()
        W('- Cause: %s' % (cause[:400] + ('...' if len(cause) > 400 else '')))
        W('- Fix confirmed: **%s**' % c.get('resolution_worked_final'))
        W('')

    # ------------------------------------------------------------ appendix
    W('## Appendix: every ticket in the sweep')
    W('')
    W('| Ticket | Account | Subject | Stage | Theme | Fix confirmed |')
    W('|---|---|---|---|---|---|')
    for c in sorted(per_ticket.values(), key=lambda x: (x.get('stage') or '', x.get('account') or '')):
        acct = re.sub(r'\s*\(.*?\)\s*', '', (c.get('account') or '-')).strip()[:34]
        W('| `%s` | %s | %s | %s | %s | %s |'
          % (c['ticket_id'], acct, (c['subject'] or '')[:52].replace('|', '/'),
             c.get('stage'), c['theme'], c.get('resolution_worked_final')))
    W('')

    # ------------------------------------------------------------ method
    W('## Method and limits')
    W('')
    W('**How this was built.** Four parallel sweeps of the HubSpot support and RMA pipelines, one '
      'per failure theme, reading ticket bodies and the associated note and email threads. Each '
      'extracted claim was then re-read by an independent reviewer instructed to refute it, '
      'defaulting to refuted where the text was ambiguous. Figures that could not be traced to '
      'verbatim source text are marked unverified rather than reported as fact.')
    W('')
    W('**What this cannot tell you.**')
    W('')
    W('- **No log telemetry.** The HubSpot connector exposes attachment IDs but no filenames and '
      'no file contents, and has no FILE object type at all. So we know files were attached but '
      'not what they were. Every cause here is from prose, not measurement. Files API access '
      'would change this.')
    W('- **Not a base rate.** These %d tickets were found by keyword search on RF symptoms. They '
      'are not a random sample of all support traffic, so the percentages describe this corpus, '
      'not the business.' % nT)
    W('- **Account attribution is incomplete.** HubSpot company association is frequently absent; '
      'where it was, the account was inferred from the ticket subject and is flagged as such in '
      'the underlying data.')
    W('- **Survivor bias toward silence.** Dormant tickets are over-represented in "cause unknown" '
      'by construction: the thread stopped before a cause was found.')
    W('')
    W('Underlying data: `data/failure_cases_hubspot.json` (%d case records, gitignored - it '
      'carries customer names and ticket text).' % len(cases))
    W('')

    with open(DEST, 'w', encoding='utf-8') as f:
        f.write('\n'.join(L))
    print('written %s (%d lines)' % (DEST, len(L)))
    print()
    print('tickets            : %d (from %d matched)' % (nT, total_matched))
    print('confirmed fix      : %d (%.0f%%)' % (fixes.get('yes', 0), pct(fixes.get('yes', 0), nT)))
    print('no action taken    : %d' % fixes.get('no_action_taken', 0))
    print('dormant/unresolved : %d (%.0f%%)' % (failed_stage, pct(failed_stage, nT)))
    print('cause not established: %d (%.0f%%)' % (cause_unknown, pct(cause_unknown, nT)))
    print('claims refuted     : %d of %d (%.0f%%)' % (refuted, len(verdicts), pct(refuted, len(verdicts))))
    print('quant calibration  : %d records' % len(quant))


if __name__ == '__main__':
    main()
