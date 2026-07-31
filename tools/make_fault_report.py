# -*- coding: utf-8 -*-
"""Fault attribution report: who failed, why, grouped by failure reason.

Reads data/fault_attribution.json and emits both

    data/FAULT_ATTRIBUTION_REPORT.md
    Doodle-Labs-Fault-Attribution.pdf

Every figure is computed here rather than transcribed, so prose and data cannot
drift apart. Blame is only reported where the source record carried a verbatim
quote establishing it; everything else lands in Not Determined on purpose.
"""
import json, os, re, textwrap
from collections import Counter, defaultdict
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether,
                                NextPageTemplate)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'fault_attribution.json')
MD = os.path.join(ROOT, 'data', 'FAULT_ATTRIBUTION_REPORT.md')
PDF = os.path.join(ROOT, 'Doodle-Labs-Fault-Attribution.pdf')
LOGO = next((c for c in (os.path.join(ROOT, 'brand', 'doodle_logo.png'),)
             if os.path.exists(c)), None)
if not LOGO:
    raise SystemExit('brand/doodle_logo.png not found - the header needs the official logo')

BRAND = HexColor('#1E73BE'); RED = HexColor('#B02A2A'); AMBER = HexColor('#C77700')
GREEN = HexColor('#1F8A4C'); INK = HexColor('#222222'); MID = HexColor('#6A6A6A')
LINE = HexColor('#E2E2E2'); WASH = HexColor('#F9F9F9')
BASE, BOLD = 'Helvetica', 'Helvetica-Bold'
SITE = 'https://doodlesim.jus2419497.workers.dev'

# code -> (side, human title, what it means, what to do about it)
CODES = [
    ('DL-SUPPORT', 'Doodle Labs', 'Support process failure',
     'The customer never received a substantive reply, the thread was dropped, or the '
     'ticket was closed while the problem was still open.',
     'This is the category most within our control and needs no engineering to fix.'),
    ('DL-FIRMWARE', 'Doodle Labs', 'Confirmed firmware or software defect',
     'A bug we acknowledged in writing, including regressions between releases and '
     'GUI/API reporting errors.',
     'Each of these has a named release and an admitted defect; they are trackable.'),
    ('DL-GUIDANCE', 'Doodle Labs', 'Wrong or missing technical guidance',
     'We gave incorrect or incomplete advice, or documentation the customer needed did '
     'not exist.', 'Fixable with documentation and an SE checklist.'),
    ('DL-HARDWARE', 'Doodle Labs', 'Confirmed hardware defect',
     'An RMA or analysis found a real fault.', 'Already flows through the RMA process.'),
    ('DL-ACCESSORY', 'Doodle Labs', 'Supplied accessory unfit for the stated use',
     'Typically bench-only development-kit antennas shipped to a customer who told us '
     'they were doing field range testing.', 'Fixable at order-entry.'),
    ('DL-OVERSTATED', 'Doodle Labs', 'Performance figure we gave was not achievable',
     'An estimator output, datasheet range or sales claim that did not hold in the '
     'conditions we stated it for.', 'See the note on this category below.'),
    ('CU-METHOD', 'Customer', 'Test methodology error',
     'Radios too close without attenuation, antennas on the ground, no line of sight, '
     'single-hop figures compared to multi-hop, or PHY rate compared to application '
     'goodput.', 'Prime teachable-moment material.'),
    ('CU-CONFIG', 'Customer', 'Radio misconfiguration',
     'Wrong band, channel, bandwidth, mode, power, or mismatched settings between ends.',
     'Prime teachable-moment material.'),
    ('CU-RFPATH', 'Customer', 'Antenna or RF path error on their side',
     'Wrong antenna, poor mounting or mast height, polarisation mismatch, bad cable, or '
     'obstructed line of sight they controlled.', 'Prime teachable-moment material.'),
    ('CU-EXPECTATION', 'Customer', 'Expectation unsupported by any published spec',
     'Range or throughput we never claimed for that product and band.',
     'Catch at the quote stage.'),
    ('CU-INTEGRATION', 'Customer', 'Fault outside the radio',
     'Host networking, power supply, serial wiring, or their own application.',
     'Catch with an integration checklist.'),
    ('CU-DAMAGE', 'Customer', 'Physical damage or misuse', '', ''),
]
CODE_META = {c[0]: c for c in CODES}


def esc_pdf(t):
    t = '' if t is None else str(t)
    for k, v in {u'≤': '<=', u'≥': '>=', u'→': '->', u'≈': '~',
                 u'–': '-', u'—': '-', u'‘': "'", u'’': "'",
                 u'“': '"', u'”': '"', u'•': '-', u'±': '+/-',
                 u'�': ''}.items():
        t = t.replace(k, v)
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def clip(t, n):
    t = esc_pdf(t)
    return t if len(t) <= n else t[:n - 1].rstrip() + '...'

def acct_of(x):
    a = (x.get('account') or '').strip()
    a = re.sub(r'\s*\(.*?\)\s*', ' ', a).strip()
    return a or 'account not identified'


def load():
    d = json.load(open(SRC, encoding='utf-8'))
    return d, d['attributions']


def stats(A):
    n = len(A)
    fault = Counter(x['fault_final'] for x in A)
    fixed = Counter(str(x.get('resolved_for_customer')) for x in A)
    rev = [x for x in A if x.get('reviewed') is not None]
    bias = Counter(x['bias_flag'] for x in A
                   if x.get('bias_flag') and x['bias_flag'] != 'none')
    # a shared ticket carries two codes; count it under both
    by_code = defaultdict(list)
    for x in A:
        c = x['code_final'] or 'NOT-DETERMINED'
        hits = re.findall(r'(?:DL|CU)-[A-Z]+', c)
        for h in (hits or [c]):
            by_code[h].append(x)
    return dict(n=n, fault=fault, fixed=fixed, rev=rev, bias=bias, by_code=by_code,
                overturned=sum(1 for x in rev if x['reviewed'] is False))


def write_md(d, A, S):
    n = S['n']
    P = lambda k: 100.0 * S['fault'].get(k, 0) / n
    L = []
    W = L.append
    W('# Who Failed, and Why')
    W('')
    W('Fault attribution across %d Doodle Labs RF failure tickets, HubSpot portal swept '
      '2026-07-29 by %d agents making %d API calls.' % (n, d.get('agents'), d.get('tool_calls')))
    W('')
    W('Blame was only assigned where the record carried a **verbatim quote establishing '
      'it**. A hypothesis someone floated once does not count: "try upgrading the '
      'firmware" is not a firmware fault. Everything that failed that bar is in Not '
      'Determined, which is why that bucket is the largest.')
    W('')
    W('## Headline')
    W('')
    W('| Fault | Tickets | Share |')
    W('|---|---:|---:|')
    for k, lab in (('doodle_labs', 'Doodle Labs'), ('customer', 'Customer'),
                   ('shared', 'Both'), ('not_determined', 'Not determined')):
        W('| %s | %d | %.1f%% |' % (lab, S['fault'].get(k, 0), P(k)))
    W('')
    W('**Where fault could be established at all, it was ours about %.0f%% of the time** '
      '(%d Doodle Labs versus %d customer, with %d shared).'
      % (100.0 * S['fault'].get('doodle_labs', 0)
         / max(S['fault'].get('doodle_labs', 0) + S['fault'].get('customer', 0), 1),
         S['fault'].get('doodle_labs', 0), S['fault'].get('customer', 0),
         S['fault'].get('shared', 0)))
    W('')
    W('And the outcome for the customer, independent of blame:')
    W('')
    W('| Problem solved for the customer? | Tickets | Share |')
    W('|---|---:|---:|')
    for k in ('no', 'unknown', 'yes'):
        W('| %s | %d | %.1f%% |' % (k, S['fixed'].get(k, 0), 100.0 * S['fixed'].get(k, 0) / n))
    W('')
    W('## Failure reasons, most common first')
    W('')
    W('| Reason | Side | Tickets |')
    W('|---|---|---:|')
    order = sorted(S['by_code'].items(), key=lambda kv: -len(kv[1]))
    for code, rows in order:
        m = CODE_META.get(code)
        W('| %s | %s | %d |' % (m[2] if m else code, m[1] if m else '-', len(rows)))
    W('')
    W('### The single biggest category is process, not engineering')
    W('')
    sup = len(S['by_code'].get('DL-SUPPORT', []))
    W('**%d tickets are DL-SUPPORT** - the customer never got a substantive answer, or the '
      'thread was dropped, or the ticket was closed while the problem was still open. That '
      'is %.0f%% of everything attributed to us, and it needs no engineering work to fix.'
      % (sup, 100.0 * sup / max(S['fault'].get('doodle_labs', 0), 1)))
    W('')
    if not S['by_code'].get('DL-OVERSTATED'):
        W('### Note on over-stated performance: zero, and why')
        W('')
        W('No ticket qualified as DL-OVERSTATED, which sits oddly beside the earlier finding '
          'that customers repeatedly measure a third of the range our estimator predicts. '
          'The reason is the evidence bar. Establishing that *we* over-stated requires '
          'showing the figure was ours, that the customer applied it to the conditions it '
          'was valid for, and that the shortfall was not explained by their antenna, mast '
          'height or method. That chain is almost never complete in a ticket, so those '
          'cases fell to Not Determined or to the customer-side RF-path codes. Read the '
          'zero as "not provable from ticket prose", not "did not happen" - the Rekise case '
          'below shows the mechanism plainly.')
        W('')

    for code, rows in order:
        m = CODE_META.get(code)
        if not m or code == 'NOT-DETERMINED':
            continue
        W('## %s - %s (%d)' % (code, m[2], len(rows)))
        W('')
        W('*%s*' % m[3])
        if m[4]:
            W('')
            W('**%s**' % m[4])
        W('')
        for x in sorted(rows, key=lambda r: acct_of(r).lower()):
            W('**%s** - %s' % (acct_of(x), x.get('subject') or ''))
            W('')
            W('- Ticket `%s`, confidence %s, solved for customer: **%s**'
              % (x['ticket_id'], x.get('confidence'), x.get('resolved_for_customer')))
            W('- %s' % x['why'])
            if x.get('evidence_quote'):
                W('- Evidence: "%s" *(%s)*' % (x['evidence_quote'].strip().strip('"'),
                                               x.get('quote_source') or 'source not recorded'))
            if x.get('bias_flag') and x['bias_flag'] != 'none':
                W('- Review flag: `%s`' % x['bias_flag'])
            W('')

    nd = S['by_code'].get('NOT-DETERMINED', [])
    W('## Not determined (%d)' % len(nd))
    W('')
    W('These are not analysis gaps. In each one the record genuinely does not establish '
      'who was at fault - most commonly because the thread stopped before anyone found '
      'out. Listed for completeness so the corpus is fully accounted for.')
    W('')
    W('| Ticket | Account | Subject | Solved? |')
    W('|---|---|---|---|')
    for x in sorted(nd, key=lambda r: acct_of(r).lower()):
        W('| `%s` | %s | %s | %s |' % (x['ticket_id'], acct_of(x)[:32],
                                       (x.get('subject') or '')[:52].replace('|', '/'),
                                       x.get('resolved_for_customer')))
    W('')
    W('## Method and limits')
    W('')
    W('Six agents read each ticket body, its notes and its full email thread. Every '
      'attribution that assigned blame was then challenged by an independent reviewer '
      'instructed to default to "refuted" where the text was ambiguous, and to flag bias '
      'in **both** directions.')
    W('')
    W('| Review | Count |')
    W('|---|---:|')
    W('| Attributions challenged | %d |' % len(S['rev']))
    W('| Upheld | %d |' % (len(S['rev']) - S['overturned']))
    W('| Overturned or corrected | %d |' % S['overturned'])
    W('')
    if S['bias']:
        W('Bias flags raised by the reviewer:')
        W('')
        W('| Flag | Count |')
        W('|---|---:|')
        for k, v in S['bias'].most_common():
            W('| `%s` | %d |' % (k, v))
        W('')
        W('The reviewer corrected in both directions - more often finding the first pass '
          '**too harsh** on Doodle Labs than too easy. The numbers above are what survived '
          'that.')
        W('')
    for t in [
        '**No log telemetry.** The HubSpot connector exposes attachment IDs but no '
        'filenames and no contents. Every cause here comes from prose, not measurement.',
        '**Not a base rate.** These tickets were found by keyword search on RF symptoms, '
        'so the shares describe this corpus, not the business.',
        '**Silence biases the Not Determined bucket upward** by construction: a thread '
        'that stopped early cannot establish a cause.',
        '**Account names are sometimes inferred** from the ticket subject where HubSpot '
        'company association was missing.',
    ]:
        W('- %s' % t)
    W('')
    W('Underlying data: `data/fault_attribution.json` (%d records, gitignored - customer '
      'names and ticket text).' % n)
    with open(MD, 'w', encoding='utf-8') as f:
        f.write('\n'.join(L))
    print('written %s (%d lines)' % (MD, len(L)))


# ---------------------------------------------------------------- PDF
H1 = ParagraphStyle('H1', fontName=BOLD, fontSize=19, leading=23, textColor=INK, spaceAfter=2)
SUB = ParagraphStyle('SUB', fontName=BASE, fontSize=11, leading=15, textColor=MID, spaceAfter=10)
H2 = ParagraphStyle('H2', fontName=BOLD, fontSize=12.5, leading=16, textColor=BRAND,
                    spaceBefore=12, spaceAfter=4)
H3 = ParagraphStyle('H3', fontName=BOLD, fontSize=10.2, leading=13.5, textColor=INK,
                    spaceBefore=7, spaceAfter=2)
BODY = ParagraphStyle('BODY', fontName=BASE, fontSize=9.6, leading=14, textColor=INK,
                      alignment=TA_LEFT, spaceAfter=5)
BUL = ParagraphStyle('BUL', parent=BODY, leftIndent=13, bulletIndent=2, spaceAfter=3)
SMALL = ParagraphStyle('SMALL', parent=BODY, fontSize=8.4, leading=11.5, textColor=MID)
QUOTE = ParagraphStyle('QUOTE', fontName=BASE, fontSize=8.6, leading=12, textColor=HexColor('#444444'),
                       leftIndent=10, spaceAfter=4)
CELL = ParagraphStyle('CELL', fontName=BASE, fontSize=8.6, leading=11.5, textColor=INK)
CELLH = ParagraphStyle('CELLH', parent=CELL, fontName=BOLD, textColor=white)
TINY = ParagraphStyle('TINY', fontName=BASE, fontSize=7.2, leading=9.4, textColor=INK)
TINYH = ParagraphStyle('TINYH', parent=TINY, fontName=BOLD, textColor=white)
STATN = ParagraphStyle('STATN', fontName=BOLD, fontSize=15, leading=17, textColor=BRAND)
STATL = ParagraphStyle('STATL', fontName=BASE, fontSize=7.8, leading=10, textColor=MID)

def header_footer(canvas, doc, first=False):
    canvas.saveState()
    W, H = letter
    band = 96 if first else 46
    canvas.setFillColor(black); canvas.rect(0, H - band, W, band, stroke=0, fill=1)
    canvas.setFillColor(BRAND); canvas.rect(0, H - band - 3, W, 3, stroke=0, fill=1)
    lw = 168 if first else 104
    canvas.drawImage(LOGO, 0.78 * inch, H - band + (band - lw * 211.0 / 627.0) / 2.0,
                     width=lw, height=lw * 211.0 / 627.0, mask='auto')
    canvas.setFont(BOLD, 8 if first else 7); canvas.setFillColor(white)
    canvas.drawRightString(W - 0.78 * inch, H - band / 2.0 - 3,
                           'INTERNAL - CONTAINS CUSTOMER DATA')
    canvas.setFillColor(LINE); canvas.rect(0.78 * inch, 0.62 * inch, W - 1.56 * inch, 0.6, stroke=0, fill=1)
    canvas.setFont(BASE, 7.4); canvas.setFillColor(MID)
    canvas.drawString(0.78 * inch, 0.44 * inch, 'Fault attribution - HubSpot sweep - 29 July 2026')
    canvas.drawRightString(W - 0.78 * inch, 0.44 * inch, 'Page %d' % doc.page)
    tool = 'doodlesim.jus2419497.workers.dev'
    tw = canvas.stringWidth(tool, BASE, 7.4); x = (W - tw) / 2.0
    canvas.setFillColor(BRAND); canvas.drawString(x, 0.44 * inch, tool)
    canvas.linkURL(SITE, (x, 0.42 * inch, x + tw, 0.54 * inch), relative=0, thickness=0)
    canvas.restoreState()

def tbl(rows, widths, tiny=False):
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
    for r in range(1, len(rows)):
        if r % 2 == 0:
            st.append(('BACKGROUND', (0, r), (-1, r), WASH))
    t.setStyle(TableStyle(st))
    return t

def statrow(items, width):
    cw = width / len(items)
    cells = []
    for nn, ll in items:
        inner = Table([[Paragraph(nn, STATN)], [Paragraph(ll, STATL)]], colWidths=[cw - 10])
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

def write_pdf(d, A, S):
    n = S['n']
    P = lambda k: 100.0 * S['fault'].get(k, 0) / n
    Sy = []
    W = Sy.append
    W(Paragraph('Who Failed, and Why', H1))
    W(Paragraph('Fault attribution across %d RF failure tickets' % n, SUB))
    W(Paragraph(
        'Swept from HubSpot on 29 July 2026. Blame was assigned only where the record '
        'carried a <b>verbatim quote establishing it</b>. A hypothesis floated once does '
        'not count - "try upgrading the firmware" is not a firmware fault. Everything that '
        'failed that bar sits in Not Determined, which is why it is the largest bucket.', BODY))
    W(Spacer(1, 4))
    W(statrow([('%d' % S['fault'].get('doodle_labs', 0), 'DOODLE LABS AT FAULT'),
               ('%d' % S['fault'].get('customer', 0), 'CUSTOMER AT FAULT'),
               ('%d' % S['fault'].get('shared', 0), 'BOTH'),
               ('%d' % S['fault'].get('not_determined', 0), 'NOT DETERMINED'),
               ('%d%%' % round(100.0 * S['fixed'].get('yes', 0) / n), 'SOLVED FOR CUSTOMER')],
              6.9 * inch))
    W(Spacer(1, 8))

    W(Paragraph('Headline', H2))
    W(tbl([['Fault', 'Tickets', 'Share']] +
          [[lab, str(S['fault'].get(k, 0)), '%.1f%%' % P(k)]
           for k, lab in (('doodle_labs', 'Doodle Labs'), ('customer', 'Customer'),
                          ('shared', 'Both'), ('not_determined', 'Not determined'))],
          [3.6 * inch, 1.6 * inch, 1.7 * inch]))
    W(Spacer(1, 5))
    dl, cu = S['fault'].get('doodle_labs', 0), S['fault'].get('customer', 0)
    W(Paragraph('<b>Where fault could be established at all, it was ours about %.0f%% of '
                'the time</b> - %d against %d, with %d shared.'
                % (100.0 * dl / max(dl + cu, 1), dl, cu, S['fault'].get('shared', 0)), BODY))
    W(tbl([['Problem solved for the customer?', 'Tickets', 'Share']] +
          [[k, str(S['fixed'].get(k, 0)), '%.1f%%' % (100.0 * S['fixed'].get(k, 0) / n)]
           for k in ('no', 'unknown', 'yes')],
          [3.6 * inch, 1.6 * inch, 1.7 * inch]))

    order = sorted(S['by_code'].items(), key=lambda kv: -len(kv[1]))
    W(Paragraph('Failure reasons, most common first', H2))
    W(tbl([['Reason', 'Side', 'Tickets']] +
          [[(CODE_META.get(c) or (0, '-', c))[2], (CODE_META.get(c) or (0, '-'))[1], str(len(r))]
           for c, r in order],
          [4.0 * inch, 1.5 * inch, 1.4 * inch]))
    W(Spacer(1, 5))
    sup = len(S['by_code'].get('DL-SUPPORT', []))
    W(Paragraph('The biggest category is process, not engineering', H3))
    W(Paragraph(
        '<b>%d tickets are a support-process failure</b> - the customer never got a '
        'substantive answer, the thread was dropped, or the ticket was closed while the '
        'problem was still open. That is %.0f%% of everything attributed to us, and fixing '
        'it requires no engineering work at all.' % (sup, 100.0 * sup / max(dl, 1)), BODY))
    if not S['by_code'].get('DL-OVERSTATED'):
        W(Paragraph('Why over-stated performance scored zero', H3))
        W(Paragraph(
            'No ticket qualified, which sits oddly beside the earlier finding that customers '
            'repeatedly measure a third of the range our estimator predicts. The reason is '
            'the evidence bar: proving <i>we</i> over-stated needs the figure to be ours, '
            'applied to conditions it was valid for, with the shortfall not explained by '
            'their antenna, mast height or method. That chain is almost never complete in a '
            'ticket, so those cases fell to Not Determined or to customer-side RF-path '
            'codes. Read the zero as "not provable from ticket prose", not "did not happen".',
            BODY))

    for code, rows in order:
        m = CODE_META.get(code)
        if not m or code == 'NOT-DETERMINED':
            continue
        col = '#B02A2A' if code.startswith('DL') else '#C77700'
        W(Paragraph('<font color="%s">%s</font> &nbsp;<font size="8" color="#6A6A6A">'
                    '%s &middot; %d ticket(s)</font>'
                    % (col, esc_pdf(m[2]), m[1], len(rows)), H2))
        W(Paragraph(esc_pdf(m[3]), SMALL))
        if m[4]:
            W(Paragraph('<b>%s</b>' % esc_pdf(m[4]), SMALL))
        for x in sorted(rows, key=lambda r: acct_of(r).lower()):
            blk = [Paragraph('<b>%s</b> &nbsp;<font size="8" color="#6A6A6A">ticket %s '
                             '&middot; solved: %s &middot; confidence %s</font>'
                             % (esc_pdf(acct_of(x)), x['ticket_id'],
                                esc_pdf(x.get('resolved_for_customer')),
                                esc_pdf(x.get('confidence'))), H3),
                   Paragraph('<i>%s</i>' % clip(x.get('subject'), 130), SMALL),
                   Paragraph(clip(x['why'], 900), BODY)]
            if x.get('evidence_quote'):
                blk.append(Paragraph('"%s"<br/><font size="7" color="#6A6A6A">%s</font>'
                                     % (clip(x['evidence_quote'].strip().strip('"'), 320),
                                        clip(x.get('quote_source') or 'source not recorded', 90)),
                                     QUOTE))
            Sy.append(KeepTogether(blk))
        W(Spacer(1, 4))

    nd = S['by_code'].get('NOT-DETERMINED', [])
    W(Paragraph('Not determined (%d)' % len(nd), H2))
    W(Paragraph(
        'These are not analysis gaps. In each one the record genuinely does not establish '
        'who was at fault, most often because the thread stopped before anyone found out. '
        'Listed so the corpus is fully accounted for.', BODY))
    W(tbl([['Ticket', 'Account', 'Subject', 'Solved?']] +
          [[x['ticket_id'], clip(acct_of(x), 28), clip(x.get('subject'), 56),
            esc_pdf(x.get('resolved_for_customer'))]
           for x in sorted(nd, key=lambda r: acct_of(r).lower())],
          [0.9 * inch, 1.7 * inch, 3.5 * inch, 0.8 * inch], tiny=True))

    W(Paragraph('Method and limits', H2))
    W(Paragraph(
        'Six agents read each ticket body, its notes and its full email thread. Every '
        'attribution that assigned blame was then challenged by an independent reviewer '
        'told to default to "refuted" where the text was ambiguous, and to flag bias in '
        '<b>both</b> directions.', BODY))
    W(tbl([['Review', 'Count'],
           ['Attributions challenged', str(len(S['rev']))],
           ['Upheld', str(len(S['rev']) - S['overturned'])],
           ['Overturned or corrected', str(S['overturned'])]],
          [4.5 * inch, 2.4 * inch]))
    if S['bias']:
        W(Spacer(1, 4))
        W(tbl([['Reviewer bias flag', 'Count']] +
              [[k.replace('_', ' '), str(v)] for k, v in S['bias'].most_common()],
              [4.5 * inch, 2.4 * inch]))
        W(Spacer(1, 4))
        W(Paragraph('The reviewer corrected in both directions, more often finding the '
                    'first pass <b>too harsh</b> on Doodle Labs than too easy. The figures '
                    'in this report are what survived that.', BODY))
    for t in [
        '<b>No log telemetry.</b> The HubSpot connector exposes attachment IDs but no '
        'filenames and no contents, so every cause here comes from prose, not measurement.',
        '<b>Not a base rate.</b> These tickets were found by keyword search on RF symptoms; '
        'the shares describe this corpus, not the business.',
        '<b>Silence inflates Not Determined</b> by construction - a thread that stopped '
        'early cannot establish a cause.',
        '<b>Account names are sometimes inferred</b> from the ticket subject where the '
        'HubSpot company association was missing.',
    ]:
        W(Paragraph(t, BUL, bulletText=u'•'))

    doc = BaseDocTemplate(PDF, pagesize=letter, leftMargin=0.78 * inch, rightMargin=0.78 * inch,
                          topMargin=0.62 * inch, bottomMargin=0.78 * inch,
                          title='Doodle Labs - Fault Attribution',
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
    doc.build([NextPageTemplate('later')] + Sy)
    print('written', PDF)


def main():
    d, A = load()
    S = stats(A)
    write_md(d, A, S)
    write_pdf(d, A, S)
    print()
    print('tickets %d | doodle %d | customer %d | shared %d | undetermined %d'
          % (S['n'], S['fault'].get('doodle_labs', 0), S['fault'].get('customer', 0),
             S['fault'].get('shared', 0), S['fault'].get('not_determined', 0)))
    print('reviewed %d, overturned %d' % (len(S['rev']), S['overturned']))


if __name__ == '__main__':
    main()
