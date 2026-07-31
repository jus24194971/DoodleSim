# -*- coding: utf-8 -*-
"""Shared Doodle Labs brand treatment for generated PDFs.

The earlier one-off generators (make_team_pdf, make_failure_pdf, make_fault_report)
predate this module and each carry their own copy; they are left alone because they
build at import time and are already shipped. New reports should import from here.

Usage:

    from brand_pdf import *
    doc = document(OUT, 'Title', 'Author', footer='...')
    doc.build(story)
"""
import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor, white, black
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether,
                                NextPageTemplate)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BRAND = HexColor('#1E73BE')        # doodlelabs.com primary blue
ORANGE = HexColor('#F59E42')
RED = HexColor('#B02A2A')
AMBER = HexColor('#C77700')
GREEN = HexColor('#1F8A4C')
INK = HexColor('#222222')
MID = HexColor('#6A6A6A')
LINE = HexColor('#E2E2E2')
WASH = HexColor('#F9F9F9')
BASE, BOLD = 'Helvetica', 'Helvetica-Bold'
SITE = 'https://doodlesim.jus2419497.workers.dev'
REPO = 'https://github.com/jus24194971/DoodleSim'

LOGO = os.path.join(ROOT, 'brand', 'doodle_logo.png')
if not os.path.exists(LOGO):
    raise SystemExit('brand/doodle_logo.png not found - the header needs the official logo')

H1 = ParagraphStyle('H1', fontName=BOLD, fontSize=19, leading=23, textColor=INK, spaceAfter=2)
SUB = ParagraphStyle('SUB', fontName=BASE, fontSize=11, leading=15, textColor=MID, spaceAfter=10)
H2 = ParagraphStyle('H2', fontName=BOLD, fontSize=13, leading=16.5, textColor=BRAND,
                    spaceBefore=13, spaceAfter=4)
H3 = ParagraphStyle('H3', fontName=BOLD, fontSize=10.4, leading=13.6, textColor=INK,
                    spaceBefore=8, spaceAfter=2)
BODY = ParagraphStyle('BODY', fontName=BASE, fontSize=9.6, leading=14, textColor=INK,
                      alignment=TA_LEFT, spaceAfter=5)
BUL = ParagraphStyle('BUL', parent=BODY, leftIndent=13, bulletIndent=2, spaceAfter=3)
SMALL = ParagraphStyle('SMALL', parent=BODY, fontSize=8.4, leading=11.5, textColor=MID)
QUOTE = ParagraphStyle('QUOTE', fontName=BASE, fontSize=8.6, leading=12,
                       textColor=HexColor('#444444'), leftIndent=10, spaceAfter=4)
CELL = ParagraphStyle('CELL', fontName=BASE, fontSize=8.6, leading=11.5, textColor=INK)
CELLH = ParagraphStyle('CELLH', parent=CELL, fontName=BOLD, textColor=white)
TINY = ParagraphStyle('TINY', fontName=BASE, fontSize=7.1, leading=9.3, textColor=INK)
TINYH = ParagraphStyle('TINYH', parent=TINY, fontName=BOLD, textColor=white)
STATN = ParagraphStyle('STATN', fontName=BOLD, fontSize=15, leading=17, textColor=BRAND)
STATL = ParagraphStyle('STATL', fontName=BASE, fontSize=7.8, leading=10, textColor=MID)

_SAFE = {u'≤': '<=', u'≥': '>=', u'→': '->', u'≈': '~', u'–': '-', u'—': '-',
         u'‘': "'", u'’': "'", u'“': '"', u'”': '"', u'•': '-', u'±': '+/-',
         u'×': 'x', u'·': '-', u'�': '', u' ': ' '}

def esc(t):
    t = '' if t is None else str(t)
    for k, v in _SAFE.items():
        t = t.replace(k, v)
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def clip(t, n):
    t = esc(t)
    return t if len(t) <= n else t[:n - 1].rstrip() + '...'

def rawclip(t, n):
    """Truncate WITHOUT escaping, for strings that already carry intentional markup.

    Passing pre-built markup through clip() escapes the tags and prints a literal
    "<b>" on the page, which is exactly what happened to the spec tables. Anything
    handed to this must have had its data escaped when it was assembled.
    """
    t = '' if t is None else str(t)
    if len(t) <= n:
        return t
    cut = t[:n]
    # do not truncate inside a tag, or reportlab sees an unterminated element
    lt, gt = cut.rfind('<'), cut.rfind('>')
    if lt > gt:
        cut = cut[:lt]
    return cut.rstrip() + '...'

def A(url, text=None):
    return '<a href="%s" color="#1E73BE"><u>%s</u></a>' % (url, text or url)

def tbl(rows, widths, tiny=False, zebra=True):
    ch, cb = (TINYH, TINY) if tiny else (CELLH, CELL)
    data = [[Paragraph(str(c), ch if i == 0 else cb) for c in r] for i, r in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1)
    st = [('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('TOPPADDING', (0, 0), (-1, -1), 3 if tiny else 5),
          ('BOTTOMPADDING', (0, 0), (-1, -1), 3 if tiny else 5),
          ('LEFTPADDING', (0, 0), (-1, -1), 4 if tiny else 7),
          ('RIGHTPADDING', (0, 0), (-1, -1), 4 if tiny else 7),
          ('LINEBELOW', (0, 0), (-1, -2), 0.5, LINE),
          ('BACKGROUND', (0, 0), (-1, 0), BRAND)]
    if zebra:
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

def _hf(canvas, doc, first, footer_text, banner):
    canvas.saveState()
    W, H = letter
    band = 96 if first else 46
    canvas.setFillColor(black); canvas.rect(0, H - band, W, band, stroke=0, fill=1)
    canvas.setFillColor(BRAND); canvas.rect(0, H - band - 3, W, 3, stroke=0, fill=1)
    lw = 168 if first else 104
    canvas.drawImage(LOGO, 0.78 * inch, H - band + (band - lw * 211.0 / 627.0) / 2.0,
                     width=lw, height=lw * 211.0 / 627.0, mask='auto')
    canvas.setFont(BOLD, 8 if first else 7); canvas.setFillColor(white)
    canvas.drawRightString(W - 0.78 * inch, H - band / 2.0 - 3, banner)
    canvas.setFillColor(LINE); canvas.rect(0.78 * inch, 0.62 * inch, W - 1.56 * inch, 0.6,
                                           stroke=0, fill=1)
    canvas.setFont(BASE, 7.4); canvas.setFillColor(MID)
    canvas.drawString(0.78 * inch, 0.44 * inch, footer_text)
    canvas.drawRightString(W - 0.78 * inch, 0.44 * inch, 'Page %d' % doc.page)
    tool = 'doodlesim.jus2419497.workers.dev'
    tw = canvas.stringWidth(tool, BASE, 7.4); x = (W - tw) / 2.0
    canvas.setFillColor(BRAND); canvas.drawString(x, 0.44 * inch, tool)
    canvas.linkURL(SITE, (x, 0.42 * inch, x + tw, 0.54 * inch), relative=0, thickness=0)
    canvas.restoreState()

FIRST_BAND, LATER_BAND, KEYLINE, HEAD_GAP = 96, 46, 3, 10

def document(out, title, author, footer, banner='INTERNAL - CONTAINS CUSTOMER DATA'):
    doc = BaseDocTemplate(out, pagesize=letter, leftMargin=0.78 * inch,
                          rightMargin=0.78 * inch, topMargin=0.62 * inch,
                          bottomMargin=0.78 * inch, title=title, author=author)
    # Derive each frame's top from the header band that page actually draws, rather
    # than nudging doc.height by a guessed offset. The guessed version overlapped the
    # band by ~16 pt, so the first line of every page printed under the black bar.
    H = letter[1]
    top_first = H - FIRST_BAND - KEYLINE - HEAD_GAP
    top_later = H - LATER_BAND - KEYLINE - HEAD_GAP
    ff = Frame(doc.leftMargin, doc.bottomMargin, doc.width,
               top_first - doc.bottomMargin, id='f')
    fl = Frame(doc.leftMargin, doc.bottomMargin, doc.width,
               top_later - doc.bottomMargin, id='l')
    doc.addPageTemplates([
        PageTemplate(id='first', frames=[ff],
                     onPage=lambda c, d: _hf(c, d, True, footer, banner)),
        PageTemplate(id='later', frames=[fl],
                     onPage=lambda c, d: _hf(c, d, False, footer, banner))])
    return doc

def build(doc, story):
    """Build the document with the compact header active from page two onward.

    BaseDocTemplate never advances past its first PageTemplate on its own, so
    without the leading NextPageTemplate the 'later' template is dead code: every
    page draws the tall 96 pt title banner and loses roughly an inch of usable
    height. Always build through this rather than calling doc.build directly.
    """
    doc.build([NextPageTemplate('later')] + list(story))
