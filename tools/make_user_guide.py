# -*- coding: utf-8 -*-
"""Build "Using the Doodle Labs Link Planner" - the plain-English user guide.

Screenshots come from tools/capture_guide_shots.mjs, which drives the real
application in Chrome, so every picture is the product as it actually behaves
rather than a mock-up.

    node tools/capture_guide_shots.mjs      # with the dev server running
    python tools/make_user_guide.py

The contents page is clickable and the PDF carries bookmarks, so a reader can jump
straight to a section from either the page or the reader's sidebar.
"""
import os, sys
from PIL import Image as PILImage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brand_pdf import *                                        # noqa: F401,F403
from brand_pdf import build as build_doc
from reportlab.platypus import (Paragraph, Spacer, Image, KeepTogether, PageBreak,
                                Flowable, Table, TableStyle)
from reportlab.lib.units import inch
from reportlab.lib.styles import ParagraphStyle

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'docs', 'guide-shots')
CACHE = os.path.join(ROOT, 'docs', '.guide-cache')
OUT = os.path.join(ROOT, 'Using-the-Doodle-Labs-Link-Planner.pdf')
os.makedirs(CACHE, exist_ok=True)

CONTENT_W = 6.94 * inch          # letter minus the 0.78in margins

# A heading stranded as the last line of a page reads as a mistake. reportlab will
# carry a heading over to the next page with whatever follows it if the style says so;
# these are this document's copies, so the shared brand module is unaffected.
H1.keepWithNext = 1
H1.spaceAfter = 8
H2.keepWithNext = 1
H3.keepWithNext = 1

# ---------------------------------------------------------------- styles
LEAD = ParagraphStyle('LEAD', fontName=BASE, fontSize=11, leading=16, textColor=INK,
                      spaceAfter=9)
STEP = ParagraphStyle('STEP', parent=BODY, leftIndent=20, bulletIndent=6, spaceAfter=6)
CAP = ParagraphStyle('CAP', fontName=BASE, fontSize=8.4, leading=11.5, textColor=MID,
                     spaceBefore=4, spaceAfter=12)
TOCE = ParagraphStyle('TOCE', fontName=BASE, fontSize=11, leading=20, textColor=INK)
TOCN = ParagraphStyle('TOCN', fontName=BASE, fontSize=11, leading=20, textColor=MID,
                      alignment=2)
TOCS = ParagraphStyle('TOCS', fontName=BASE, fontSize=9.4, leading=15, textColor=MID,
                      leftIndent=18)
NOTE = ParagraphStyle('NOTE', parent=BODY, fontSize=9.2, leading=13.5,
                      leftIndent=10, rightIndent=10, textColor=HexColor('#3d4c5f'))
DEFT = ParagraphStyle('DEFT', fontName=BOLD, fontSize=9.6, leading=13, textColor=INK)
DEFD = ParagraphStyle('DEFD', fontName=BASE, fontSize=9.4, leading=13, textColor=INK)


class Anchor(Flowable):
    """Zero-size marker that names a spot in the PDF.

    Gives the contents page somewhere to link to and puts an entry in the reader's
    bookmark sidebar. Drawn rather than declared so it lands on whatever page the
    section actually flowed onto.
    """
    def __init__(self, key, title, level=0):
        Flowable.__init__(self)
        self.key, self.title, self.level = key, title, level
        self.width = self.height = 0

    def draw(self):
        self.canv.bookmarkPage(self.key)
        # key must stay a str: reportlab files titles by key, and a bytes key is
        # decoded later, so the two no longer match and the sidebar shows the key.
        self.canv.addOutlineEntry(self.title, self.key,
                                  level=self.level, closed=(self.level == 0))


def shot(name, width=CONTENT_W, crop_bottom=None):
    """Place a screenshot, downscaled so the PDF stays a sane size to email."""
    src = os.path.join(SHOTS, name + '.png')
    if not os.path.exists(src):
        return Paragraph('<i>[screenshot %s missing - run the capture script]</i>' % name, CAP)
    dst = os.path.join(CACHE, name + '.jpg')
    im = PILImage.open(src).convert('RGB')
    if crop_bottom:
        im = im.crop((0, 0, im.width, int(im.height * crop_bottom)))
    target_px = 1400                      # ~200 dpi across the text column
    if im.width > target_px:
        im = im.resize((target_px, round(im.height * target_px / im.width)),
                       PILImage.LANCZOS)
    im.save(dst, 'JPEG', quality=88, optimize=True, subsampling=0)
    h = width * im.height / im.width
    return Image(dst, width=width, height=h)


def fig(name, caption, width=CONTENT_W, crop_bottom=None):
    return [shot(name, width, crop_bottom), Paragraph(caption, CAP)]


def callout(title, text, colour='#1E73BE'):
    """A boxed aside for the things that trip people up."""
    p = Paragraph('<font color="%s"><b>%s</b></font><br/>%s' % (colour, esc(title), text), NOTE)
    t = Table([[p]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), HexColor('#F2F7FC')),
        ('LINEBEFORE', (0, 0), (0, -1), 3, HexColor(colour)),
        ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 11), ('RIGHTPADDING', (0, 0), (-1, -1), 11)]))
    return [t, Spacer(1, 10)]


def steps(items):
    out = []
    for i, t in enumerate(items, 1):
        out.append(Paragraph(t, STEP, bulletText=str(i) + '.'))
    return out


def bullets(items):
    return [Paragraph(t, BUL, bulletText=u'•') for t in items]


# ---------------------------------------------------------------- sections
SECTIONS = [
    ('what', 'What this tool is'),
    ('quick', 'The five-minute version'),
    ('place', 'Step 1 - Put your radios on the map'),
    ('setup', 'Step 2 - Set each radio up'),
    ('link', 'Step 3 - Join them, and read the answer'),
    ('coverage', 'Step 4 - See where you can actually talk'),
    ('airtime', 'Step 5 - Check it can carry your traffic'),
    ('advisor', 'Letting the Plan Advisor design it'),
    ('share', 'Saving work and handing it over'),
    ('phone', 'Using it on a phone'),
    ('defs', 'Definitions'),
    ('limits', 'Where the numbers come from'),
]

GLOSSARY = [
    ('AGL', 'Above Ground Level. How high the antenna sits above the dirt directly '
            'beneath it. What you set on a mast, and what drone rules are written in.'),
    ('ASL', 'Above Sea Level. Height measured from the sea. An aircraft holding a '
            'constant ASL altitude is at a changing AGL height as the ground rises '
            'and falls beneath it.'),
    ('Airtime', 'The share of the channel your traffic occupies. Two radios cannot '
                'talk at the same instant, so everything - both directions, every '
                'stream - takes turns. Past roughly 75% the link feels broken even '
                'though the signal is strong.'),
    ('Bandwidth (channel width)', 'How wide a slice of spectrum the radio uses, in '
                                  'MHz. Wider carries more data; narrower reaches '
                                  'further. It is a range control as much as a speed '
                                  'control.'),
    ('BDA', 'Bi-Directional Amplifier. An external booster that raises both transmit '
            'power and receive sensitivity.'),
    ('dB', 'Decibel - a ratio, not an amount. Every 3 dB doubles power; every 6 dB '
           'roughly doubles distance. A 10 dB difference is large.'),
    ('dBi', 'Antenna gain. An antenna adds no power; it concentrates what it has into '
            'a narrower beam, so more gain means more reach but a tighter aim.'),
    ('dBm', 'An actual power level. 30 dBm is 1 watt. Received signals are negative '
            'numbers: -60 dBm is strong, -90 dBm is nearly nothing.'),
    ('Diffraction loss', 'Signal lost bending over a ridge or building between the two '
                         'ends. The planner reads this from real elevation data.'),
    ('Fade margin', 'Spare signal held back for bad days - rain, movement, reflections. '
                    'Doodle Labs plan to 10 dB. A link with no margin works in the '
                    'demonstration and fails in service.'),
    ('Fresnel zone', 'The cigar-shaped volume around the straight line between two '
                     'antennas. It needs to be mostly clear, so scraping a treeline '
                     'costs signal even when you can see the far end.'),
    ('Link margin', 'How much signal you have above the minimum the radio needs. '
                    'Positive is good; the fade margin is subtracted from it.'),
    ('MCS', 'Modulation and Coding Scheme - the data rate step the radio picks, 0 to '
            '15. Higher is faster but needs a stronger signal, and the radio steps '
            'down automatically as conditions worsen.'),
    ('Mesh', 'Radios that relay for each other, so traffic can route around a blocked '
             'path rather than simply failing.'),
    ('Noise floor', 'The background hiss at the receiver. A noisy site needs a stronger '
                    'signal to hear the same message, so a busy industrial yard costs '
                    'real range.'),
    ('Path loss', 'Everything the signal loses between the two antennas - distance, '
                  'terrain, obstructions.'),
    ('RSSI', 'Received Signal Strength Indicator. What the far radio actually hears, '
             'in dBm.'),
    ('TDD / half duplex', 'The radio transmits and receives in turns on one channel. '
                          'Uplink and downlink share the same airtime rather than '
                          'having separate budgets.'),
    ('Throughput', 'Data actually delivered, always less than the headline PHY rate '
                   'once overheads, acknowledgements and retries are counted.'),
    ('TX power', 'How hard the radio transmits, in dBm.'),
]


def build(pages=None, out=OUT):
    S = []
    W = S.append

    # ------------------------------------------------------------ cover
    W(Spacer(1, 44))
    W(Paragraph('Using the<br/>Link Planner', ParagraphStyle(
        'COVER', fontName=BOLD, fontSize=34, leading=39, textColor=INK)))
    W(Spacer(1, 10))
    W(Paragraph('Designing Mesh Rider networks on real terrain - a practical guide',
                ParagraphStyle('CSUB', fontName=BASE, fontSize=13.5, leading=19,
                               textColor=MID)))
    W(Spacer(1, 22))
    W(shot('01-overview', CONTENT_W))
    W(Spacer(1, 14))
    W(Paragraph(
        'Written for anyone who has to answer <b>"will this link work?"</b> - whether or '
        'not you design radio networks for a living. No RF background is assumed. Terms '
        'in <b>bold</b> the first time they appear are explained in '
        + A_INT('defs', 'Definitions') + ' at the back.', BODY))
    W(Paragraph('Doodle Labs Solutions Engineering &nbsp;·&nbsp; ' + A(SITE), SMALL))
    W(PageBreak())

    # ------------------------------------------------------------ contents
    W(Paragraph('Contents', H1))
    W(Spacer(1, 6))
    W(Paragraph('Every entry below is a link - click to jump straight there.', SMALL))
    W(Spacer(1, 10))
    blurbs = {
        'what': 'What the planner does, and what it will not do for you',
        'quick': 'The whole workflow in one page',
        'place': 'Dropping radios where they will really go',
        'setup': 'The settings that change the answer, and the ones that do not',
        'link': 'Reading a link result without an RF background',
        'coverage': 'Ground vehicles, drones, and the difference between them',
        'airtime': 'Why a strong link can still stutter',
        'advisor': 'Describe the mission, get a design back',
        'share': 'Layouts, reports and handover',
        'phone': 'The same tool in the field',
        'defs': 'Plain-English glossary of every term used',
        'limits': 'What the predictions rest on, and where to be careful',
    }
    for i, (key, title) in enumerate(SECTIONS, 1):
        num = Paragraph(str(pages.get(key, '')) if pages else '', TOCN)
        row = Table([[Paragraph('%d.&nbsp;&nbsp;%s' % (i, A_INT(key, title)), TOCE), num]],
                    colWidths=[CONTENT_W - 40, 40])
        row.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
        W(row)
        W(Paragraph(blurbs[key], TOCS))
    W(PageBreak())

    def H(key, title, n):
        # No Spacer after the heading: keepWithNext would happily keep the heading
        # with the spacer and still strand it at the foot of the page. The gap comes
        # from the style instead.
        return [Anchor(key, '%d. %s' % (n, title)),
                Paragraph('%d. %s' % (n, esc(title)), H1)]

    # ------------------------------------------------------------ 1 what
    S += H('what', 'What this tool is', 1)
    W(Paragraph(
        'The Link Planner answers one question: <b>if I put radios here, will they talk '
        'to each other, and how well?</b> It does that against real ground - actual hills '
        'and valleys from elevation data - rather than assuming the world is flat.', LEAD))
    W(Paragraph('It will tell you:', BODY))
    S += bullets([
        'Whether two radios can see each other over the terrain between them',
        'What data rate to expect, and how much signal you have spare',
        'Where a whole network reaches, drawn as a heat map on the map',
        'How low a drone can fly and stay connected',
        'Whether the link can carry your video and control traffic, not just connect',
        'What to buy and where to put it, if you would rather describe the job than design it',
    ])
    W(Spacer(1, 4))
    S += callout(
        'What it does not know',
        'Buildings, trees and vehicles are <b>not</b> in the terrain data - only the shape '
        'of the ground. In a city or a forest, treat the answer as the best case and add '
        'margin. It also cannot know about interference that is not there yet.',
        '#C77700')

    # ------------------------------------------------------------ 2 quick
    S += H('quick', 'The five-minute version', 2)
    W(Paragraph('If you only read one page, read this one.', LEAD))
    S += steps([
        '<b>Place your radios.</b> Add Node, then click the map where each one will be.',
        '<b>Set each one up.</b> Pick the radio model, band, antenna and how high it is '
        'mounted. Height matters more than almost anything else.',
        '<b>Join them.</b> Link Nodes, then click two radios. The line turns green, amber '
        'or red.',
        '<b>Look at the result.</b> The card tells you the distance, whether the path is '
        'clear, the expected data rate and the spare signal.',
        '<b>Check coverage</b> if you need to know where else you could go, and the '
        '<b>link budget</b> if you need to know whether your video will fit.',
        '<b>Export a report</b> when you are happy, or save the layout to come back to.',
    ])
    W(Spacer(1, 6))
    S += fig('01-overview',
             'The whole tool. Map and radios on the left, the selected radio\'s settings '
             'and the link results on the right.')

    # ------------------------------------------------------------ 3 place
    S += H('place', 'Step 1 - Put your radios on the map', 3)
    W(Paragraph(
        'Click <b>+ Add Node</b>, then click the map. Each radio appears as a numbered '
        'circle you can drag at any time - every calculation updates as it moves, so it '
        'is worth dragging a mast around to see how much the answer improves.', BODY))
    S += bullets([
        'Place radios where they will <i>actually</i> be installed, not where it is tidy. '
        'A hundred metres along a ridge can be the difference between working and not.',
        'Use the <b>Satellite</b> switch, top right, to see what is really on the ground.',
        'Finished setting one up? Use the <b>duplicate</b> button on its card to copy it '
        'complete with every setting, then drag the copy where it belongs.',
    ])

    # ------------------------------------------------------------ 4 setup
    S += H('setup', 'Step 2 - Set each radio up', 4)
    W(Paragraph(
        'Selecting a radio opens its settings. There are a lot of them, but only a few '
        'change the answer much.', LEAD))
    W(Paragraph('The ones that matter most', H2))
    S += bullets([
        '<b>Height above ground (AGL)</b> - the single biggest lever. Raising a mast '
        'usually beats buying a better antenna, because it clears obstructions rather '
        'than shouting through them.',
        '<b>Antenna and its gain (dBi)</b> - more gain reaches further but over a '
        'narrower beam, so a high-gain antenna must be aimed. Omnidirectional antennas '
        'cover everything and reach less far.',
        '<b>Band and channel width</b> - narrower channels reach further and carry less. '
        'If a link is marginal, narrowing from 20 MHz to 10 MHz is often the cheapest fix.',
        '<b>Noise floor</b> - how electrically busy the site is. A quiet field and a '
        'factory floor are not the same radio problem, and this is where you say so.',
        '<b>Cable type and length</b> - long thin coax quietly throws away signal before '
        'it reaches the antenna. The planner works the loss out from the type and run.',
    ])
    S += fig('02-node-settings', 'One radio\'s settings. Everything here affects the '
             'prediction, but the highlighted few dominate it.', width=3.3 * inch)
    S += callout(
        'If you set one thing carefully, set the height',
        'Antenna height is the setting people guess at and the one the maths is most '
        'sensitive to. A mast height entered as a hopeful number rather than a measured '
        'one will make every other figure on the page wrong in the same direction.')

    # ------------------------------------------------------------ 5 link
    S += H('link', 'Step 3 - Join them, and read the answer', 5)
    W(Paragraph(
        'Click <b>Link Nodes</b>, then click two radios. The planner cuts a slice through '
        'the elevation data between them and works out what the signal has to get past.',
        BODY))
    S += fig('03-link-and-profile',
             'A finished link. The green line is healthy; the label shows distance and '
             'expected rate, and the card on the right gives the detail.')
    W(Paragraph('What the colours mean', H2))
    S += bullets([
        '<b>Green</b> - comfortable. Signal to spare above your fade margin.',
        '<b>Amber</b> - works, but with little in hand. Fine for a demonstration, risky '
        'for a deployment.',
        '<b>Red</b> - will not carry a usable link as configured.',
    ])
    W(Paragraph('What the card tells you', H2))
    S += bullets([
        '<b>Distance</b> - straight-line distance between the two radios.',
        '<b>Path</b> - whether the ground gets in the way. "Clear LOS" means the '
        '<b>Fresnel zone</b> is unobstructed, not merely that you could see the far end.',
        '<b>Diffraction loss</b> - signal lost bending over whatever is in the way. Zero '
        'is what you want.',
        '<b>Best MCS / Throughput</b> - the data rate step the radio should settle at, and '
        'roughly what that delivers.',
        '<b>RSSI / Margin</b> - what the far radio hears, and how much spare signal there '
        'is above the minimum <i>after</i> your fade margin is taken out.',
    ])
    S += callout(
        'A red link is information, not a failure',
        'Most useful designs start red. Raise a mast, narrow the channel, add gain, or put '
        'a relay on high ground between the two - then watch the same numbers move. That '
        'iteration is what the tool is for.')

    # ------------------------------------------------------------ 6 coverage
    S += H('coverage', 'Step 4 - See where you can actually talk', 6)
    W(Paragraph(
        'A link tells you about two points. <b>Coverage simulation</b> paints every '
        'direction at once, so you can see the shape of what you have built.', LEAD))
    S += fig('04-coverage',
             'Coverage across the whole network. Colour shows where one, two, or three '
             'and more radios reach - the darker areas have redundancy if one goes down.')
    W(Paragraph('Two ways to ask the question', H2))
    S += bullets([
        '<b>Terrain-following</b> - for anything that stays near the ground: vehicles, '
        'handhelds, boats, people. Set a height above ground and the simulation follows '
        'the landscape up and down.',
        '<b>Flight level</b> - for aircraft, which hold an altitude rather than following '
        'the ground. Enter the altitude the aircraft holds and the readout tells you what '
        'that means in <b>AGL</b> over your reference point.',
    ])
    S += callout(
        'Flight level and height above ground are not the same number',
        'An aircraft holding a constant altitude is getting closer to the ground as the '
        'terrain rises. The panel leads with the AGL figure because that is what pilots '
        'and regulations use, and shows the altitude actually held beneath it - but that '
        'AGL is only true over the reference point.')
    W(Paragraph(
        'The <b>Find lowest workable flight level</b> button answers the question drone '
        'operators actually ask: how low can I fly and stay connected? It sweeps altitudes '
        'and stops at the lowest one that still covers the area.', BODY))

    # ------------------------------------------------------------ 7 airtime
    S += H('airtime', 'Step 5 - Check it can carry your traffic', 7)
    W(Paragraph(
        'A link closing and a link doing its job are different questions. A radio can show '
        'a strong signal and still deliver stuttering video, because the channel is full. '
        'This is the panel that tells you.', LEAD))
    S += fig('06-link-budget-popped',
             'The link budget and airtime panel. Add the traffic the link really carries '
             'and it reports how much of the channel each stream eats.')
    W(Paragraph('Adding your traffic', H2))
    W(Paragraph(
        'Pick from the list - H.264 video down from the aircraft, MAVLink telemetry both '
        'ways, an RC control uplink, a file transfer - and add as many as the link '
        'carries. Each one already knows whether it runs on <b>TCP</b> or <b>UDP</b> and '
        'which direction it flows, because that changes the answer.', BODY))
    S += callout(
        'Two things that surprise people',
        '<b>Uplink and downlink share one budget.</b> The radio talks in turns on a single '
        'channel, so a 4 Mbps video feed down and a small control stream up are not '
        'separate allowances - they add up.<br/><br/>'
        '<b>A download loads the uplink.</b> A TCP transfer sends an acknowledgement back '
        'for roughly every two packets. Those are tiny messages but they cost full airtime, '
        'so a one-way-looking file copy is not one-way on the air.')
    W(Paragraph('Reading the result', H2))
    S += bullets([
        '<b>Under 50%</b> - comfortable.',
        '<b>50-75%</b> - busy. It works until something else needs the channel.',
        '<b>Over 75%</b> - saturated. Expect latency and dropped frames.',
        '<b>Peak above 100%</b> - the burst does not fit. Video sends a large keyframe '
        'about once a second, and if that cannot clear in time you get stutter even though '
        'the average looks fine.',
    ])

    # ------------------------------------------------------------ 8 advisor
    S += H('advisor', 'Letting the Plan Advisor design it', 8)
    W(Paragraph(
        'If you would rather describe the job than design it, the <b>Plan Advisor</b> takes '
        'the mission - what needs to talk to what, how far apart, how much data - and '
        'returns ranked configurations: radio, band, antenna, aiming, mast height and '
        'cabling. It will work with radios you have already placed, and can site a relay '
        'when terrain blocks a single hop.', BODY))
    S += fig('07-plan-advisor', 'Describe the outcome; get back configurations that '
             'achieve it, each with the reasoning attached.')

    # ------------------------------------------------------------ 9 share
    S += H('share', 'Saving work and handing it over', 9)
    S += bullets([
        '<b>Save layout</b> writes a file you can email or archive. The browser also keeps '
        'your current work automatically, so closing the tab does not lose it.',
        '<b>Load layout</b> opens a saved design - useful for keeping a library of '
        'standard deployments to start from.',
        '<b>Report</b> exports a customer-ready document with the terrain profiles, link '
        'results and minimum drone altitudes worked out.',
    ])
    S += callout(
        'Send the layout, not just the picture',
        'A screenshot shows what you concluded. The layout file lets the person receiving '
        'it change a mast height and see the consequence for themselves, which is usually '
        'the conversation you actually want to have.')

    # ------------------------------------------------------------ 10 phone
    S += H('phone', 'Using it on a phone', 10)
    W(Paragraph(
        'The planner works on a phone, which matters when the question comes up on site '
        'rather than at a desk.', BODY))
    S += bullets([
        'The three round buttons on the map add a radio, join two, or delete one. Delete '
        'asks you to arm it first, then tap the radio - so a stray tap cannot remove '
        'anything.',
        'The <b>Nodes &amp; links</b> handle collapses the list when you want the whole '
        'screen for the map.',
        'Panels slide up from the bottom instead of sitting in a corner.',
    ])
    t = Table([[shot('08-mobile', 2.5 * inch), shot('09-mobile-menu', 2.5 * inch)]],
              colWidths=[3.2 * inch, 3.2 * inch])
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'),
                           ('LEFTPADDING', (0, 0), (-1, -1), 0),
                           ('RIGHTPADDING', (0, 0), (-1, -1), 12)]))
    W(t)
    W(Paragraph('Left: the map takes the screen, with the radio list collapsible beneath '
                'it. Right: everything else lives behind the menu button.', CAP))

    # ------------------------------------------------------------ 11 definitions
    W(Spacer(1, 10))
    S += H('defs', 'Definitions', 11)
    W(Paragraph('Every term used in this guide, in plain English.', LEAD))
    rows = [[Paragraph(esc(t), DEFT), Paragraph(esc(d), DEFD)] for t, d in GLOSSARY]
    tbl_defs = Table(rows, colWidths=[1.55 * inch, CONTENT_W - 1.55 * inch])
    st = [('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
          ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
          ('LINEBELOW', (0, 0), (-1, -2), 0.4, LINE)]
    for i in range(len(rows)):
        if i % 2 == 1:
            st.append(('BACKGROUND', (0, i), (-1, i), HexColor('#FAFBFD')))
    tbl_defs.setStyle(TableStyle(st))
    W(tbl_defs)

    # ------------------------------------------------------------ 12 limits
    W(Spacer(1, 12))
    S += H('limits', 'Where the numbers come from', 12)
    W(Paragraph(
        'Worth knowing, so you can judge how much to trust any given answer.', LEAD))
    S += bullets([
        '<b>Radio performance</b> comes from Doodle Labs\' own published figures - the '
        'transmit power and sensitivity for each model and data rate.',
        '<b>Terrain</b> comes from roughly 30-metre elevation data. It models the shape of '
        'the ground: hills and valleys, not buildings or trees.',
        '<b>Path loss</b> is free-space loss plus terrain diffraction, with an extra '
        'correction available for antennas close to the ground - which is where simple '
        'calculations are most optimistic.',
        '<b>Antenna patterns</b> are modelled from the beamwidths you enter, including the '
        'loss when a link sits off the centre of the beam.',
        '<b>Airtime and traffic</b> use a model designed by Aaron Do, Doodle Labs Solutions '
        'Engineering.',
    ])
    S += callout(
        'Be careful where it is optimistic',
        'Antennas near the ground, links through buildings or forest, and busy spectrum are '
        'the three places predictions flatter reality. Real deployments have repeatedly '
        'measured a fraction of what a simple free-space calculation promised in exactly '
        'these conditions - which is why the near-ground correction and the noise floor '
        'setting exist. Use them, and keep your fade margin honest.',
        '#B02A2A')
    W(Spacer(1, 6))
    W(Paragraph('Questions, or something that looks wrong? Talk to Solutions Engineering - '
                'a case where the tool disagrees with the field is worth more to us than '
                'one where it agrees. Live tool: ' + A(SITE) + '.', BODY))

    doc = document(out, 'Using the Doodle Labs Link Planner',
                   'Doodle Labs Solutions Engineering',
                   'Using the Doodle Labs Link Planner',
                   banner='USER GUIDE')
    build_doc(doc, S)
    return out


def A_INT(key, text):
    """Internal link to an Anchor."""
    return '<a href="#%s" color="#1E73BE">%s</a>' % (key, esc(text))


def main():
    """Build twice.

    The contents page quotes page numbers, and those are only known once the document
    has flowed. The first pass is thrown away except for where each anchor landed; the
    second pass fills the numbers in. Because the numbers sit in a fixed-width column,
    adding them cannot re-wrap anything, so the two passes paginate identically.
    """
    import fitz
    scratch = os.path.join(CACHE, '_pass1.pdf')
    build(None, scratch)
    doc = fitz.open(scratch)
    pages = {}
    for i, (key, _title) in enumerate(SECTIONS):
        entry = doc.get_toc()[i]
        pages[key] = entry[2]
    doc.close()
    os.remove(scratch)
    build(pages, OUT)
    print('written', OUT, '(%.1f MB)' % (os.path.getsize(OUT) / 1e6))


if __name__ == '__main__':
    main()
