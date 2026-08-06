# -*- coding: utf-8 -*-
"""Team summary PDF, styled to the Doodle Labs website brand."""
import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, Image, KeepTogether)

BRAND = HexColor('#1E73BE')        # doodlelabs.com primary blue
ORANGE = HexColor('#F59E42')       # secondary accent
INK = HexColor('#222222')
MID = HexColor('#6A6A6A')
LINE = HexColor('#E2E2E2')
WASH = HexColor('#F9F9F9')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
# brand asset lives at the repo root; fall back to a sibling brand/ dir
LOGO = next((c for c in (os.path.join(ROOT, 'brand', 'doodle_logo.png'),
                         os.path.join(HERE, 'brand', 'doodle_logo.png'))
             if os.path.exists(c)), None)
if not LOGO:
    raise SystemExit('brand/doodle_logo.png not found - the header needs the official logo')
OUT = os.path.join(ROOT, 'RF-Link-Planner-Team-Summary.pdf')

BASE, BOLD = 'Helvetica', 'Helvetica-Bold'

SITE = 'https://doodlesim.jus2419497.workers.dev'
REPO = 'https://github.com/jus24194971/DoodleSim'
def A(url, text=None):
    """Clickable link, brand blue and underlined."""
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
CELLB = ParagraphStyle('CELLB', parent=CELL, fontName=BOLD)
CELLH = ParagraphStyle('CELLH', parent=CELL, fontName=BOLD, textColor=white)
STATN = ParagraphStyle('STATN', fontName=BOLD, fontSize=15, leading=17, textColor=BRAND)
STATL = ParagraphStyle('STATL', fontName=BASE, fontSize=7.8, leading=10, textColor=MID)
URLST = ParagraphStyle('URLST', fontName=BOLD, fontSize=11.5, leading=15, textColor=BRAND, spaceAfter=13)
PULL = ParagraphStyle('PULL', fontName=BASE, fontSize=9.4, leading=13.5, textColor=INK,
                      leftIndent=9, spaceAfter=5)

def header_footer(canvas, doc, first=False):
    canvas.saveState()
    W, H = letter
    band = 96 if first else 46
    canvas.setFillColor(black)
    canvas.rect(0, H - band, W, band, stroke=0, fill=1)
    # brand blue keyline under the band
    canvas.setFillColor(BRAND)
    canvas.rect(0, H - band - 3, W, 3, stroke=0, fill=1)
    if LOGO:
        lw = 168 if first else 104
        lh = lw * 211.0 / 627.0
        canvas.drawImage(LOGO, 0.78 * inch, H - band + (band - lh) / 2.0,
                         width=lw, height=lh, mask='auto')
    canvas.setFont(BOLD, 8 if first else 7)
    canvas.setFillColor(white)
    canvas.drawRightString(W - 0.78 * inch, H - band / 2.0 - 3,
                           'INTERNAL - NOT FOR CUSTOMER RELEASE')
    # footer
    canvas.setFillColor(LINE)
    canvas.rect(0.78 * inch, 0.62 * inch, W - 1.56 * inch, 0.6, stroke=0, fill=1)
    canvas.setFont(BASE, 7.4)
    canvas.setFillColor(MID)
    canvas.drawString(0.78 * inch, 0.44 * inch, 'RF Link Planner - program summary - 29 July 2026')
    canvas.drawRightString(W - 0.78 * inch, 0.44 * inch, 'Page %d' % doc.page)
    # centred, clickable link to the live tool
    tool = 'doodlesim.jus2419497.workers.dev'
    tw = canvas.stringWidth(tool, BASE, 7.4)
    x = (W - tw) / 2.0
    canvas.setFillColor(BRAND)
    canvas.drawString(x, 0.44 * inch, tool)
    canvas.linkURL(SITE, (x, 0.42 * inch, x + tw, 0.54 * inch), relative=0, thickness=0)
    canvas.restoreState()

def tbl(rows, widths, header=True, zebra=True):
    data = [[Paragraph(str(c), CELLH if (header and i == 0) else CELL) for c in r]
            for i, r in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    st = [('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
          ('LEFTPADDING', (0, 0), (-1, -1), 7), ('RIGHTPADDING', (0, 0), (-1, -1), 7),
          ('LINEBELOW', (0, 0), (-1, -2), 0.5, LINE)]
    if header:
        st += [('BACKGROUND', (0, 0), (-1, 0), BRAND)]
    if zebra:
        for r in range(1, len(rows)):
            if r % 2 == 0:
                st.append(('BACKGROUND', (0, r), (-1, r), WASH))
    t.setStyle(TableStyle(st))
    return t

def stats(items, width):
    cw = width / len(items)
    cells = [[Paragraph(n, STATN), Paragraph(l, STATL)] for n, l in items]
    inner = [Table([[c[0]], [c[1]]], colWidths=[cw - 10],
                   style=TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 0),
                                     ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                                     ('TOPPADDING', (0, 0), (-1, -1), 1),
                                     ('BOTTOMPADDING', (0, 0), (-1, -1), 1)])) for c in cells]
    t = Table([inner], colWidths=[cw] * len(items))
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BACKGROUND', (0, 0), (-1, -1), WASH),
        ('LINEBEFORE', (1, 0), (-1, -1), 0.6, LINE),
        ('TOPPADDING', (0, 0), (-1, -1), 9), ('BOTTOMPADDING', (0, 0), (-1, -1), 9),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
    ]))
    return t

def callout(title, body):
    inner = Table([[Paragraph('<b>%s</b>' % title, CELL)], [Paragraph(body, CELL)]],
                  colWidths=[6.35 * inch],
                  style=TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 10),
                                    ('RIGHTPADDING', (0, 0), (-1, -1), 10),
                                    ('TOPPADDING', (0, 0), (0, 0), 8),
                                    ('BOTTOMPADDING', (0, 1), (0, 1), 9),
                                    ('BACKGROUND', (0, 0), (-1, -1), WASH),
                                    ('LINEBEFORE', (0, 0), (0, -1), 3, ORANGE)]))
    return inner

story = []
S = story.append
CW = 6.9 * inch

S(Paragraph('RF Link Planner', H1))
S(Paragraph('Terrain-aware network planning for Mesh Rider radios. What the tool does, '
            'how far we can trust it, and what it has already found.', SUB))

S(Paragraph(A(SITE, 'doodlesim.jus2419497.workers.dev')
            + ' &nbsp;&nbsp;<font size="9" color="#6A6A6A">Live now - no login, nothing to install</font>', URLST))
S(stats([('$0 / mo', 'Hosted on our own Cloudflare account'),
         ('14 radios', 'Full per-MCS data, including v4 and RM-1300/1400'),
         ('90 antennas', 'Every row audited against manufacturer datasheets'),
         ('Exact', 'Reproduces the official Doodle Labs estimator')], CW))
S(Spacer(1, 9))

S(Paragraph('In one paragraph', H2))
S(Paragraph('We have an in-house planning tool that puts Mesh Rider links on a real map. You place radios, '
            'pick the actual radio, band, antenna and mast height, and it tells you what the link will really do - '
            'throughput, margin, coverage footprint, and where it breaks. Underneath it reproduces the official '
            'Doodle Labs range estimator exactly, then adds the terrain that a distance-only calculator cannot see. '
            'It is internal-only today. Two independent checks sit behind it: a field result reported from '
            'Ukraine, and a separate, unrelated batch of customer radio logs.', BODY))

S(Paragraph('What you can do with it', H2))
for t, d in [
    ('Plan a link',
     'Place radios and get distance, best usable MCS, throughput and margin. Click a link for the terrain '
     'cross-section with the Fresnel zone drawn, so you can see which ridge is costing you.'),
    ('Coverage maps, two ways',
     '<b>Terrain-following</b> for UGVs, vehicles and handhelds - what can something driving around here reach? '
     'And <b>flight level</b> for UAS, where you drag an altitude slider and coverage repaints live. It also maps '
     'the minimum altitude a drone needs to connect, point by point.'),
    ('Mesh overlap and redundancy',
     'Combines every radio footprint and colours by how many radios cover each spot - one, two (survives any '
     'single outage), or three or more. Reports the area of each in square kilometres.'),
    ('Mission routes',
     'Paste a waypoint list or click it on the map, set up the vehicle radio, and get percentage of route with a '
     'link, percentage at your required data rate, longest dropout in metres, handover count, and which radio '
     'serves which stretch.'),
    ('Plan Advisor',
     'Describe the mission - "ground station to UAV, 10 km, 5 Mbps" - and it searches every radio, band, channel '
     'width and antenna combination, then hands back ranked builds with aiming, heights and cabling. It will also '
     'extend an existing network and site a relay when one hop cannot reach.'),
    ('Locate by signal',
     'Nano and Mini radios carry no GPS. Use the OEM and Wearable units, which do, as anchors: enter the levels '
     'they report and the tool works out position from the link budget, with an honest confidence circle rather '
     'than a false pin.'),
    ('Customer-ready reports',
     'One click exports a document with the map, equipment table, per-link terrain analysis and minimum UAV '
     'altitudes. Prints straight to PDF.'),
    ('Fade margin you control',
     'Set 10 dB for our standard plan, 12-14 dB for field practice, higher for contested RF. Every calculation '
     'follows it and the report states the value used, so nothing goes out based on a looser number than you quoted.'),
]:
    S(Paragraph('<b>%s.</b> %s' % (t, d), BUL, bulletText='\u2022'))

S(Paragraph('Why the numbers can be trusted', H2))
S(Paragraph('The link budget <b>reproduces the official Doodle Labs Range Estimation Tool exactly</b> - same '
            'conservative sensitivities, same per-MCS transmit powers - verified to the metre across roughly '
            'thirty test cases. On top of that it adds what a distance-only calculator cannot: real elevation '
            'data, earth curvature, Fresnel-zone clearance, diffraction, antenna radiation patterns and '
            'frequency-dependent cable loss.', BODY))
S(Paragraph('The antenna audit', H3))
S(Paragraph('Our recommended-antenna spreadsheet was checked row by row against manufacturer datasheets. '
            'That work is now baked into the tool:', BODY))
S(tbl([['Result', 'Count', 'What it means'],
       ['Confirmed', '31', 'Sheet matched the manufacturer datasheet'],
       ['Specs corrected', '19', 'Real product, wrong numbers on our sheet'],
       ['Partly verified', '14', 'Some fields confirmed; the rest unpublished or self-contradictory'],
       ['Not a real product', '20', 'Family labels, radio platforms, or part numbers that do not exist'],
       ['Unverifiable', '6', 'No authoritative source found anywhere'],
       ['<b>Total</b>', '<b>90</b>', '<b>Every row on the sheet</b>']],
      [1.5 * inch, 0.7 * inch, 4.7 * inch]))
S(Paragraph('Every one of the 90 is listed individually in the appendix.', SMALL))
S(Spacer(1, 5))
S(callout('Four catches worth knowing about',
          'Most of the L-com HG4958-xx part numbers do not exist as written. Both Poynting entries are '
          'cellular antennas we had listed as Wi-Fi. The Triad BDA is rated 25 W, not the 16 W on our sheet. '
          'And one recommended sector antenna, rated 5 W maximum input, was paired with a 20 W amplifier '
          'that would have destroyed it.'))

S(Paragraph('Tested against reality', H2))
S(Paragraph('Check 1: Ukraine field test (colleague-reported figures only)', H3))
S(Paragraph('A colleague working in country gave us the values he had on hand: a 24 dBi parabolic on the ground '
            'station at 2 m, a 3 dBi multipolarised omni on the aircraft at 1000 m, a 5 MHz channel swept from '
            '1675 to 2500 MHz, clear air with no jamming, and the link dropping out at 42-44 km. He works to a '
            '12-14 dB fade margin. Fed only those numbers, the tool puts the cliff inside his exact window with '
            'no adjustment:', BODY))
S(tbl([['Fade margin', 'Tool prediction at 42.6 km'],
       ['10 dB', 'MCS 10, 7.4 Mbps, +10.5 dB margin'],
       ['12 dB', 'MCS 9, 5.1 Mbps, +12.5 dB margin'],
       ['14 dB', 'MCS 1, 2.7 Mbps, +15.5 dB margin'],
       ['20 dB', 'No link']],
      [1.4 * inch, 5.5 * inch]))
S(Spacer(1, 5))
S(Spacer(1, 5))
S(callout('What this check is, and is not',
          'These are the only figures we have from that site - his stated kit, heights, channel and the '
          'distance at which he lost the link. There are no logs and no measured signal levels from Ukraine, '
          'so this is a consistency check against what he reported, not an independent measurement. It is '
          'still meaningful: the model was not tuned to match, and it landed in his window first time.'))
S(Paragraph('It also gave him two things to act on. His frequency sweep up to 2500 MHz costs about 3.5 dB, '
            'so staying near 1675 MHz is worth roughly 1.5 times the range. And the tightest point on the whole '
            '43 km path is 200 m in front of his ground station, where a 2 m antenna only just clears - lifting '
            'that dish is the cheapest margin he can buy.', BODY))

S(Paragraph('Check 2: what it found in customer logs (a separate, unrelated batch)', H3))
S(Paragraph('We built parsers for Mesh Rider support bundles and ran six of them, from three unrelated '
            'customer systems, about 28,000 telemetry samples. These are an arbitrary sample of logs and '
            'have <b>nothing to do with the Ukraine test above</b> - they are a second, independent check '
            'that the tooling finds real faults:', BODY))
S(tbl([['System', 'Finding'],
       ['Flight 7 ground station',
        'One receive chain <b>10 dB down</b> (chains at -73 and -63 dBm). The link stayed associated the whole '
        'time yet was unusable: 80% packet loss, never got past MCS 6, because a dead chain means the second '
        'data stream never works. Signal strength was never the problem.'],
       ['Flight 7 channel',
        'The 918 MHz channel was busy 70% of the time with noise peaks to -75 dBm, against 9% on a healthy '
        'reference pair.'],
       ['Site B fleet',
        'The same 5-7 dB chain imbalance on both the ground station and the relay, against every peer - which '
        'localises it to their own antenna paths rather than the air.'],
       ['Site B relay',
        'Linked only <b>69.6%</b> of the time while hopping across three frequencies and two channel widths, '
        'against a ground station that never left one channel.']],
      [1.6 * inch, 5.3 * inch]))
S(Spacer(1, 5))
S(callout('It also caught its own false alarms',
          'A "transmit power is only 15 dBm" that turned out to be the 5 GHz Wi-Fi hotspot interface, not the '
          'mesh radio (which runs 30-32 dBm as configured). A "98.9% error rate" that was simply spectral-scan '
          'samples being counted as errors. And one of our own conclusions withdrawn after a timing audit showed '
          'two logs were captured 32 minutes apart rather than simultaneously. Being able to rule things out '
          'matters as much as finding them.'))

S(Paragraph('Where it is honest about its limits', H2))
for b in [
    'Terrain data is about 30 m resolution, so <b>buildings and trees are not modelled</b>. Urban and forest '
    'predictions run optimistic - budget extra margin there.',
    'Interference and rain are covered only by the fade margin, not modelled explicitly.',
    'Predictions are planning-grade engineering estimates, not a warranty. Field-verify critical links.',
    'The core link budget is thoroughly validated. The newer features - coverage modes, routes, signal-based '
    'ranging - are self-audited but have <b>not had independent review</b> yet.',
    'Radios without GPS can only be positioned when several of them measure each other <b>at the same time</b>. '
    'Sequential captures cannot be combined, and the tool refuses rather than guessing.',
]:
    S(Paragraph(b, BUL, bulletText='\u2022'))

RES = [Paragraph('Where to find more', H2), tbl([['Resource', 'Link'],
       ['The tool itself', A(SITE, 'doodlesim.jus2419497.workers.dev')],
       ['Source, data and all documentation', A(REPO, 'github.com/jus24194971/DoodleSim')],
       ['Antenna verification, all 90 rows',
        A(REPO + '/blob/main/data/verification_report.md', 'data/verification_report.md')],
       ['Customer log findings, six bundles',
        A(REPO + '/blob/main/data/LOG_FINDINGS.md', 'data/LOG_FINDINGS.md')],
       ['Ukraine field validation',
        A(REPO + '/blob/main/data/FIELD_VALIDATION_UA.md', 'data/FIELD_VALIDATION_UA.md')],
       ['Technical summary, for engineering review',
        A(REPO + '/blob/main/DoodleSim-Technical-Summary.pdf', 'DoodleSim-Technical-Summary.pdf')]],
      [2.5 * inch, 4.4 * inch]),
    Paragraph('Repository links need access to the DoodleSim repo; the tool itself needs nothing.', SMALL)]
S(KeepTogether(RES))

S(Paragraph('What would help most', H2))
S(Paragraph('Have a play - a 60-second tour runs on your first visit, and Help has tutorials and an FAQ. Then '
            'tell us where it is wrong, especially anywhere it disagrees with something you have actually '
            'measured: hit <b>Save</b> and send the .json with what you saw. Access control goes in before '
            'anything reaches a customer.', BODY))


# ---------------------------------------------------------------- appendix
import json as _json

_SAFE = {
    u"\u2264": "<=", u"\u2265": ">=", u"\u2192": "->", u"\u2248": "~",
    u"\u2013": "-", u"\u2014": "-", u"\u2018": "'", u"\u2019": "'",
    u"\u201c": '"', u"\u201d": '"', u"\u2022": "-", u"\u00b1": "+/-",
}

def esc(t):
    t = u"" if t is None else unicode(t) if str is bytes else str(t)
    for k, v in _SAFE.items():
        t = t.replace(k, v)
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def clip(t, n):
    t = esc(t)
    return t if len(t) <= n else t[:n - 1].rstrip() + "..."

GROUPS = [
    ("confirmed", "Confirmed", "#1F8A4C",
     "Our sheet matched the manufacturer datasheet on band, gain, pattern and type."),
    ("corrected", "Specs corrected", "#C77700",
     "A real product, but our sheet had it wrong. The tool carries the verified figures."),
    ("partially_verified", "Partly verified", "#1E73BE",
     "Some fields confirmed; the rest is unpublished, marketplace-grade, or the vendor contradicts "
     "itself. Treat the unconfirmed fields with care."),
    ("not_a_product", "Not a real product", "#B02A2A",
     "Family labels, radio platforms rather than antennas, or part numbers that do not exist as "
     "written. These should come off the sheet."),
    ("unverifiable", "Unverifiable", "#6A6A6A",
     "No authoritative source could be found. Not necessarily wrong, but nothing supports it."),
]

def _appendix_table(data):
    ap = ParagraphStyle("AP", fontName=BASE, fontSize=7.1, leading=9.2, textColor=INK)
    aph = ParagraphStyle("APH", parent=ap, fontName=BOLD, textColor=white)
    body = [[Paragraph(c, aph if i == 0 else ap) for c in row] for i, row in enumerate(data)]
    t = Table(body, colWidths=[0.26 * inch, 1.82 * inch, 1.22 * inch, 1.38 * inch, 2.22 * inch],
              repeatRows=1)
    st = [("VALIGN", (0, 0), (-1, -1), "TOP"),
          ("BACKGROUND", (0, 0), (-1, 0), BRAND),
          ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
          ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
          ("LINEBELOW", (0, 0), (-1, -2), 0.4, LINE)]
    for i in range(1, len(data)):
        if i % 2 == 0:
            st.append(("BACKGROUND", (0, i), (-1, i), WASH))
    t.setStyle(TableStyle(st))
    return t

def antenna_appendix(flow):
    rows_all = _json.load(open(os.path.join(ROOT, "data", "antennas_verified_master.json"),
                               encoding="utf-8"))
    flow.append(Paragraph("Appendix: every antenna checked", H2))
    flow.append(Paragraph(
        "All " + str(len(rows_all)) + " rows of the recommended-antenna sheet, each audited against the "
        "manufacturer's own datasheet. Where our sheet and the datasheet disagree, both figures are shown. "
        "Source links for every row are in "
        + A(REPO + "/blob/main/data/verification_report.md", "data/verification_report.md") + ".", BODY))
    n = 0
    for key, title, colour, blurb in GROUPS:
        group = [r for r in rows_all if r["status"] == key]
        if not group:
            continue
        flow.append(KeepTogether([
            Paragraph('<font color="%s"><b>%s</b></font> &nbsp;<font size="8" color="#6A6A6A">'
                      "%d of %d</font>" % (colour, title, len(group), len(rows_all)), H3),
            Paragraph(blurb, SMALL)]))
        data = [["#", "Manufacturer and model", "Band (verified)", "Gain: sheet / verified", "Note"]]
        for r in sorted(group, key=lambda x: (esc(x.get("manufacturer") or "zzz").lower(),
                                              esc(x.get("model")).lower())):
            n += 1
            band = r["fields"]["band"].get("verified") or r["fields"]["band"].get("sheet") or "-"
            gs = r["fields"]["gain_dbi"].get("sheet")
            gv = r["fields"]["gain_dbi"].get("verified")
            if key == "confirmed" or not gv or esc(gs) == esc(gv):
                gain = clip(gs if gs not in (None, "", "-") else (gv or "-"), 28)
            else:
                gain = clip(gs, 12) + " / " + clip(gv, 26)
            note = "" if key == "confirmed" else clip(r.get("notes"), 108)
            data.append([str(n),
                         "<b>" + esc(r.get("manufacturer") or "-") + "</b><br/>" + esc(r.get("model") or "-"),
                         clip(band, 30), gain, note])
        flow.append(_appendix_table(data))
        flow.append(Spacer(1, 7))

antenna_appendix(story)

doc = BaseDocTemplate(OUT, pagesize=letter,
                      leftMargin=0.78 * inch, rightMargin=0.78 * inch,
                      topMargin=1.55 * inch, bottomMargin=0.85 * inch,
                      title='RF Link Planner - Team Summary',
                      author='Doodle Labs Sales Engineering')
frame_first = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='f')
frame_later = Frame(doc.leftMargin, doc.bottomMargin, doc.width,
                    doc.height + (1.55 - 0.95) * inch, id='l')
doc.addPageTemplates([
    PageTemplate(id='first', frames=[frame_first],
                 onPage=lambda c, d: header_footer(c, d, True)),
    PageTemplate(id='later', frames=[frame_later],
                 onPage=lambda c, d: header_footer(c, d, False)),
])
doc.build(story)
print('written', OUT)
