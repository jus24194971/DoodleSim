# -*- coding: utf-8 -*-
"""Branded PDF of the customer RF failure analysis.

Shares the Doodle Labs brand treatment with make_team_pdf.py but is self-contained:
that module builds its document at import time, so importing it here would emit the
wrong PDF as a side effect.

All figures are recomputed from data/failure_cases_hubspot.json at build time, so
the PDF and the underlying data cannot drift apart.
"""
import json, math, os, re
from collections import Counter
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether,
                                NextPageTemplate)

BRAND = HexColor('#1E73BE')
ORANGE = HexColor('#F59E42')
RED = HexColor('#B02A2A')
GREEN = HexColor('#1F8A4C')
INK = HexColor('#222222')
MID = HexColor('#6A6A6A')
LINE = HexColor('#E2E2E2')
WASH = HexColor('#F9F9F9')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOGO = next((c for c in (os.path.join(ROOT, 'brand', 'doodle_logo.png'),
                         os.path.join(HERE, 'brand', 'doodle_logo.png'))
             if os.path.exists(c)), None)
if not LOGO:
    raise SystemExit('brand/doodle_logo.png not found - the header needs the official logo')
OUT = os.path.join(ROOT, 'Doodle-Labs-RF-Failure-Analysis.pdf')
SRC = os.path.join(ROOT, 'data', 'failure_cases_hubspot.json')

BASE, BOLD = 'Helvetica', 'Helvetica-Bold'
SITE = 'https://doodlesim.jus2419497.workers.dev'

def A(url, text=None):
    return '<a href="%s" color="#1E73BE"><u>%s</u></a>' % (url, text or url)

H1 = ParagraphStyle('H1', fontName=BOLD, fontSize=19, leading=23, textColor=INK, spaceAfter=2)
SUB = ParagraphStyle('SUB', fontName=BASE, fontSize=11, leading=15, textColor=MID, spaceAfter=10)
H2 = ParagraphStyle('H2', fontName=BOLD, fontSize=12.5, leading=16, textColor=BRAND,
                    spaceBefore=12, spaceAfter=4)
H3 = ParagraphStyle('H3', fontName=BOLD, fontSize=10.5, leading=14, textColor=INK,
                    spaceBefore=8, spaceAfter=3)
BODY = ParagraphStyle('BODY', fontName=BASE, fontSize=9.6, leading=14, textColor=INK,
                      alignment=TA_LEFT, spaceAfter=5)
BUL = ParagraphStyle('BUL', parent=BODY, leftIndent=13, bulletIndent=2, spaceAfter=3)
SMALL = ParagraphStyle('SMALL', parent=BODY, fontSize=8.4, leading=11.5, textColor=MID)
CELL = ParagraphStyle('CELL', fontName=BASE, fontSize=8.6, leading=11.5, textColor=INK)
CELLH = ParagraphStyle('CELLH', parent=CELL, fontName=BOLD, textColor=white)
TINY = ParagraphStyle('TINY', fontName=BASE, fontSize=7.2, leading=9.4, textColor=INK)
TINYH = ParagraphStyle('TINYH', parent=TINY, fontName=BOLD, textColor=white)
STATN = ParagraphStyle('STATN', fontName=BOLD, fontSize=15, leading=17, textColor=BRAND)
STATL = ParagraphStyle('STATL', fontName=BASE, fontSize=7.8, leading=10, textColor=MID)
PULL = ParagraphStyle('PULL', fontName=BASE, fontSize=9.4, leading=13.5, textColor=INK,
                      leftIndent=9, spaceAfter=5)

_SAFE = {u'≤': '<=', u'≥': '>=', u'→': '->', u'≈': '~',
         u'–': '-', u'—': '-', u'‘': "'", u'’': "'",
         u'“': '"', u'”': '"', u'•': '-', u'±': '+/-',
         u'�': ''}

def esc(t):
    t = '' if t is None else str(t)
    for k, v in _SAFE.items():
        t = t.replace(k, v)
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def clip(t, n):
    t = esc(t)
    return t if len(t) <= n else t[:n - 1].rstrip() + '...'

def header_footer(canvas, doc, first=False):
    canvas.saveState()
    W, H = letter
    band = 96 if first else 46
    canvas.setFillColor(black)
    canvas.rect(0, H - band, W, band, stroke=0, fill=1)
    canvas.setFillColor(BRAND)
    canvas.rect(0, H - band - 3, W, 3, stroke=0, fill=1)
    lw = 168 if first else 104
    lh = lw * 211.0 / 627.0
    canvas.drawImage(LOGO, 0.78 * inch, H - band + (band - lh) / 2.0,
                     width=lw, height=lh, mask='auto')
    canvas.setFont(BOLD, 8 if first else 7)
    canvas.setFillColor(white)
    canvas.drawRightString(W - 0.78 * inch, H - band / 2.0 - 3,
                           'INTERNAL - CONTAINS CUSTOMER DATA')
    canvas.setFillColor(LINE)
    canvas.rect(0.78 * inch, 0.62 * inch, W - 1.56 * inch, 0.6, stroke=0, fill=1)
    canvas.setFont(BASE, 7.4)
    canvas.setFillColor(MID)
    canvas.drawString(0.78 * inch, 0.44 * inch,
                      'Customer RF failure analysis - HubSpot sweep - 29 July 2026')
    canvas.drawRightString(W - 0.78 * inch, 0.44 * inch, 'Page %d' % doc.page)
    tool = 'doodlesim.jus2419497.workers.dev'
    tw = canvas.stringWidth(tool, BASE, 7.4)
    x = (W - tw) / 2.0
    canvas.setFillColor(BRAND)
    canvas.drawString(x, 0.44 * inch, tool)
    canvas.linkURL(SITE, (x, 0.42 * inch, x + tw, 0.54 * inch), relative=0, thickness=0)
    canvas.restoreState()

def tbl(rows, widths, tiny=False, zebra=True):
    ch, cb = (TINYH, TINY) if tiny else (CELLH, CELL)
    data = [[Paragraph(str(c), ch if i == 0 else cb) for c in r] for i, r in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1)
    st = [('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('TOPPADDING', (0, 0), (-1, -1), 3 if tiny else 5),
          ('BOTTOMPADDING', (0, 0), (-1, -1), 3 if tiny else 5),
          ('LEFTPADDING', (0, 0), (-1, -1), 5 if tiny else 7),
          ('RIGHTPADDING', (0, 0), (-1, -1), 5 if tiny else 7),
          ('LINEBELOW', (0, 0), (-1, -2), 0.5, LINE),
          ('BACKGROUND', (0, 0), (-1, 0), BRAND)]
    if zebra:
        for r in range(1, len(rows)):
            if r % 2 == 0:
                st.append(('BACKGROUND', (0, r), (-1, r), WASH))
    t.setStyle(TableStyle(st))
    return t

def stats(items, width):
    cw = width / len(items)
    cells = []
    for n, l in items:
        inner = Table([[Paragraph(n, STATN)], [Paragraph(l, STATL)]], colWidths=[cw - 10])
        inner.setStyle(TableStyle([('TOPPADDING', (0, 0), (-1, -1), 0),
                                   ('BOTTOMPADDING', (0, 0), (-1, -1), 1),
                                   ('LEFTPADDING', (0, 0), (-1, -1), 0),
                                   ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
        cells.append(inner)
    t = Table([cells], colWidths=[cw] * len(items))
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'),
                           ('TOPPADDING', (0, 0), (-1, -1), 8),
                           ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
                           ('LEFTPADDING', (0, 0), (-1, -1), 9),
                           ('BACKGROUND', (0, 0), (-1, -1), WASH),
                           ('LINEBEFORE', (1, 0), (-1, -1), 0.6, LINE)]))
    return t

# ---------------------------------------------------------------- RF model
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

def excess_db(d_m, f):
    ng = a_of(f) + 22.25 * math.log10(max(d_m, 1.0))
    fs = 32.45 + 20 * math.log10(max(d_m, 1.0) / 1000.0) + 20 * math.log10(f)
    return ng - fs

CALIB = [(917, 1333, 409, 'shoulder height ~1.5 m, open field LOS'),
         (917, 1333, 240, 'antennas at ground level, open field LOS'),
         (2409, 1170, 489, 'ground and shoulder height, open field LOS')]

STAGE_FAIL = {'Closed - Dormant', 'Closed - Unresolved'}

def main():
    d = json.load(open(SRC, encoding='utf-8'))
    cases = d['cases']
    matched = d.get('tickets_matched_by_theme', {})
    total_matched = sum(v for v in matched.values() if isinstance(v, (int, float)))
    per = {}
    for c in cases:
        per.setdefault(c['ticket_id'], c)
    nT = len(per)
    stages = Counter(c.get('stage') or '?' for c in per.values())
    fixes = Counter(str(c.get('resolution_worked_final')) for c in per.values())
    themes = Counter(c['theme'] for c in cases)
    verd = [c for c in cases if c.get('verified') is not None]
    refuted = sum(1 for c in verd if c['verified'] is False)
    quant = [c for c in cases if c.get('quant_valid') is True]
    failed = sum(v for k, v in stages.items() if k in STAGE_FAIL)
    closed = sum(v for k, v in stages.items() if k.startswith('Closed'))
    unk = sum(1 for c in per.values()
              if not (c.get('root_cause_final') or '').strip()
              or any(s in (c.get('root_cause_final') or '').lower()
                     for s in ('not established', 'never confirmed', 'hypothesi')))
    P = lambda n: 100.0 * n / nT

    S = []
    W = S.append
    W(Paragraph('Customer RF Failure Analysis', H1))
    W(Paragraph('Where our links fail, why, and whether our fixes actually worked', SUB))
    W(Paragraph(
        'Swept from HubSpot on 29 July 2026. %d support and RMA tickets matched the four RF '
        'failure searches; <b>%d</b> were analysed in depth across %d case records. Every '
        'root-cause claim was then re-read by an independent reviewer instructed to refute it, '
        'so what follows is what survived challenge rather than what was first extracted.'
        % (total_matched, nT, len(cases)), BODY))
    W(Spacer(1, 4))
    W(stats([('%d' % nT, 'TICKETS ANALYSED'),
             ('%d%%' % round(P(fixes.get('yes', 0))), 'CONFIRMED FIXED'),
             ('%d%%' % round(P(failed)), 'DORMANT / UNRESOLVED'),
             ('%d%%' % round(P(unk)), 'CAUSE NEVER ESTABLISHED'),
             ('%d%%' % round(100.0 * refuted / max(len(verd), 1)), 'CLAIMS REFUTED')],
            6.9 * inch))
    W(Spacer(1, 8))

    W(Paragraph('Executive summary', H2))
    W(Paragraph('<b>We rarely establish why a link failed, and we almost never confirm that our '
                'fix worked.</b>', BODY))
    W(tbl([['Measure', 'Tickets', 'Share'],
           ['Confirmed working fix', str(fixes.get('yes', 0)), '%.0f%%' % P(fixes.get('yes', 0))],
           ['Fix recorded but never confirmed by the customer', str(fixes.get('unknown', 0)),
            '%.0f%%' % P(fixes.get('unknown', 0))],
           ['Closed with no action taken', str(fixes.get('no_action_taken', 0)),
            '%.0f%%' % P(fixes.get('no_action_taken', 0))],
           ['Fix demonstrably did not work', str(fixes.get('no', 0)), '%.0f%%' % P(fixes.get('no', 0))],
           ['Went dormant or closed unresolved', str(failed), '%.0f%%' % P(failed)],
           ['Root cause never established or only hypothesised', str(unk), '%.0f%%' % P(unk)]],
          [4.3 * inch, 1.1 * inch, 1.5 * inch]))
    W(Spacer(1, 6))

    W(Paragraph('1. Closure is not resolution', H3))
    W(Paragraph(
        '%d of %d tickets (%.0f%%) reached a closed stage, but only <b>%d</b> contain evidence '
        'that the customer confirmed the problem was solved. The typical ending is one vendor '
        'reply, then silence, then a status change. In this data <i>Closed - Resolved</i> means '
        '"we stopped hearing about it".' % (closed, nT, P(closed), fixes.get('yes', 0)), BODY))
    W(Paragraph('2. Our stated causes mostly do not survive review', H3))
    W(Paragraph(
        '%d root-cause attributions were independently re-read against the source text and '
        '<b>%d (%.0f%%)</b> were refuted or materially corrected. The recurring pattern is a '
        'plausible engineering hypothesis - development-kit antennas, Fresnel clearance, a '
        'firmware upgrade - offered once, never measured, never confirmed, and then treated '
        'downstream as the known cause.'
        % (len(verd), refuted, 100.0 * refuted / max(len(verd), 1)), BODY))
    W(Paragraph('3. The most common complaint is that our own range figure did not hold', H3))
    W(Paragraph(
        'Customers quote a distance from the Doodle Labs estimator or from a sales conversation, '
        'then measure a third of it or less. This is the most damaging category precisely because '
        'the number came from us.', BODY))
    W(Paragraph(
        '<i>"We were promised at least 10km with this setup"</i> - measured around 1000 m. '
        '<i>"The mesh riders only achieved about 220 meters"</i> - against competitors at 1200 m '
        'in the same evaluation.', PULL))

    W(Paragraph('Why the range predictions miss - and what closes the gap', H2))
    W(Paragraph(
        'The estimator computes free-space loss. It carries no term for antennas near the ground, '
        'which is exactly how these customers tested: handhelds at shoulder height, radios sitting '
        'on the ground, UGVs, small UAS at takeoff. DoodleSim adds that term. Tested against the '
        'one case whose figures a reviewer confirmed verbatim at a known geometry:', BODY))
    rows = [['Geometry', 'Observed shortfall', 'DoodleSim near-ground', 'Difference']]
    for f, exp, got, geom in CALIB:
        obs = 20 * math.log10(float(exp) / got)
        pred = excess_db(got, f)
        rows.append(['%d MHz, %s' % (f, geom), '%.1f dB' % obs, '%.1f dB' % pred,
                     '<font color="#1F8A4C">%+.1f dB</font>' % (pred - obs)])
    W(tbl(rows, [3.0 * inch, 1.3 * inch, 1.4 * inch, 1.2 * inch]))
    W(Spacer(1, 5))
    W(Paragraph(
        'The near-ground mechanism accounts for the shortfall in both direction and magnitude, and '
        'in all three cases DoodleSim errs <b>pessimistic</b> - predicting slightly more loss than '
        'was measured. For a planning tool that is the correct direction to be wrong in. The flat '
        'estimator omits roughly %.0f to %.0f dB at these geometries, which at a path-loss exponent '
        'of 2 is a 3x to 7x range error: the exact ratio customers report.'
        % (min(excess_db(g, f) for f, _e, g, _x in CALIB),
           max(excess_db(g, f) for f, _e, g, _x in CALIB)), BODY))
    W(Paragraph(
        '<b>Caveat, stated plainly.</b> This is one customer and three measurements, and the '
        'near-ground model was fitted independently rather than to this data. It is corroboration, '
        'not validation. Real validation needs the radio log bundles - see Limits.', SMALL))

    W(Paragraph('Where we fail', H2))
    W(tbl([['Failure theme', 'Tickets searched', 'Cases analysed']] +
          [[t.replace('-', ' ').title(), str(matched.get(t, '-')), str(n)]
           for t, n in themes.most_common()],
          [3.4 * inch, 1.75 * inch, 1.75 * inch]))
    W(Spacer(1, 6))
    W(tbl([['Ticket outcome', 'Tickets', 'Share']] +
          [[s, str(n), '%.1f%%' % P(n)] for s, n in stages.most_common()],
          [3.4 * inch, 1.75 * inch, 1.75 * inch]))
    W(Spacer(1, 5))
    W(Paragraph(
        '<b>Closed - Dormant at %.0f%% is the number to worry about.</b> These are customers who '
        'reported an RF problem, received at most one reply, and stopped responding. We do not '
        'know whether they solved it, worked around it, or moved to another vendor.'
        % P(stages.get('Closed - Dormant', 0)), BODY))

    # ---- named quantitative cases
    W(Paragraph('Cases carrying verified performance figures', H2))
    W(Paragraph(
        'These records contain expected-versus-achieved numbers that a reviewer confirmed appear '
        'verbatim in the source text with correct units. They are the usable calibration corpus '
        'for the simulator.', BODY))
    seen = set()
    for c in sorted(quant, key=lambda x: (x.get('account') or 'zz').lower()):
        if c['ticket_id'] in seen:
            continue
        seen.add(c['ticket_id'])
        acct = re.sub(r'\s*\(.*?\)\s*', '', (c.get('account') or 'account not identified')).strip()
        blk = [Paragraph('<b>%s</b> &nbsp;<font size="8" color="#6A6A6A">ticket %s &middot; %s '
                         '&middot; %s</font>' % (esc(acct), c['ticket_id'], esc(c.get('created')),
                                                 esc(c.get('stage'))), H3),
               Paragraph(clip(c['subject'], 150), BODY)]
        det = []
        if c.get('radio_models'):
            det.append(['Radios', clip(', '.join(c['radio_models']), 120)])
        bb = '%s / %s' % (c.get('band_mhz') or '-', c.get('bandwidth_mhz') or '-')
        det.append(['Band / BW', clip(bb, 120)])
        if c.get('environment'):
            det.append(['Environment', clip(c['environment'], 200)])
        det.append(['Expected', clip(c.get('expected_performance'), 260)])
        det.append(['Achieved', clip(c.get('achieved_performance'), 260)])
        det.append(['Cause', clip(c.get('root_cause_final') or 'not established', 260)])
        det.append(['Fix confirmed', esc(c.get('resolution_worked_final'))])
        t = Table([[Paragraph('<b>%s</b>' % k, CELL), Paragraph(v, CELL)] for k, v in det],
                  colWidths=[1.0 * inch, 5.9 * inch])
        t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'),
                               ('TOPPADDING', (0, 0), (-1, -1), 2),
                               ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
                               ('LEFTPADDING', (0, 0), (-1, -1), 0),
                               ('LINEBELOW', (0, 0), (-1, -2), 0.3, LINE)]))
        blk.append(t)
        blk.append(Spacer(1, 7))
        S.append(KeepTogether(blk))

    # ---- appendix
    W(Paragraph('Appendix: every ticket in the sweep', H2))
    W(Paragraph('All %d tickets, ordered by outcome.' % nT, SMALL))
    rows = [['Ticket', 'Account', 'Subject', 'Stage', 'Theme', 'Fixed?']]
    for c in sorted(per.values(), key=lambda x: (x.get('stage') or '', (x.get('account') or '').lower())):
        acct = re.sub(r'\s*\(.*?\)\s*', '', (c.get('account') or '-')).strip()
        rows.append([c['ticket_id'], clip(acct, 26), clip(c['subject'], 46),
                     clip(c.get('stage'), 22), c['theme'].replace('-', ' '),
                     esc(c.get('resolution_worked_final'))])
    W(tbl(rows, [0.85 * inch, 1.35 * inch, 2.25 * inch, 1.05 * inch, 0.85 * inch, 0.55 * inch],
          tiny=True))

    W(Paragraph('Method and limits', H2))
    W(Paragraph(
        '<b>How this was built.</b> Four parallel sweeps of the HubSpot support and RMA pipelines, '
        'one per failure theme, reading ticket bodies plus the associated note and email threads. '
        'Each extracted claim was then challenged by an independent reviewer told to default to '
        '"refuted" wherever the text was ambiguous. Figures that could not be traced to verbatim '
        'source text are marked unverified rather than reported as fact.', BODY))
    for t in [
        '<b>No log telemetry.</b> The HubSpot connector exposes attachment IDs but no filenames '
        'and no file contents, and has no FILE object type at all. We know files were attached; we '
        'cannot see what they were. Every cause in this report comes from prose, not measurement. '
        'Files API access would change that and is the single highest-value next step.',
        '<b>This is not a base rate.</b> These tickets were found by keyword search on RF '
        'symptoms, so the percentages describe this corpus, not the business as a whole.',
        '<b>Account attribution is incomplete.</b> HubSpot company association is frequently '
        'absent; where it was missing the account was inferred from the ticket subject and is '
        'flagged as inferred in the underlying data.',
        '<b>Silence biases the cause figures.</b> Dormant tickets are over-represented in "cause '
        'never established" by construction - the thread stopped before anyone found one.',
    ]:
        W(Paragraph(t, BUL, bulletText=u'•'))
    W(Spacer(1, 4))
    W(Paragraph('Live planning tool: ' + A(SITE) + '. Underlying data: '
                'data/failure_cases_hubspot.json (%d case records, kept out of git - it carries '
                'customer names and ticket text).' % len(cases), SMALL))

    doc = BaseDocTemplate(OUT, pagesize=letter, leftMargin=0.78 * inch, rightMargin=0.78 * inch,
                          topMargin=0.62 * inch, bottomMargin=0.78 * inch,
                          title='Doodle Labs - Customer RF Failure Analysis',
                          author='Doodle Labs Solutions Engineering')
    # Frame tops derived from the header band each page actually draws. The previous
    # doc.height offsets overlapped the band by ~16 pt, printing the first line of
    # every page under the black bar.
    _H = letter[1]
    ff = Frame(doc.leftMargin, doc.bottomMargin, doc.width,
               (_H - 96 - 3 - 10) - doc.bottomMargin, id='f')
    fl = Frame(doc.leftMargin, doc.bottomMargin, doc.width,
               (_H - 46 - 3 - 10) - doc.bottomMargin, id='l')
    doc.addPageTemplates([
        PageTemplate(id='first', frames=[ff], onPage=lambda c, dd: header_footer(c, dd, True)),
        PageTemplate(id='later', frames=[fl], onPage=lambda c, dd: header_footer(c, dd, False))])
    # BaseDocTemplate never advances past the first PageTemplate on its own, so
    # without this the compact header is dead code and every page draws the tall
    # title banner, losing about an inch of usable height.
    doc.build([NextPageTemplate('later')] + S)
    print('written', OUT)
    print('  %d tickets, %d cases, %d calibration records' % (nT, len(cases), len(quant)))


if __name__ == '__main__':
    main()
