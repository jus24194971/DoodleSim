// First-run guided tour: dims the app and spotlights each control in sequence.
// Completion (or skip) is remembered in localStorage so returning users go
// straight to the tool.

const DONE_KEY = 'doodlesim-tour-done';

const STEPS = [
  {
    target: null,
    title: 'Welcome to the Doodle Labs RF Link Planner',
    text: 'Design Mesh Rider networks on real terrain: place radios, aim antennas, check links against elevation profiles, and export customer-ready designs. This 60-second tour shows you the essentials.',
  },
  {
    target: '#btn-add-node',
    title: 'Place your radios',
    text: 'Click “+ Add Node”, then click anywhere on the map to drop a radio. Drag nodes to reposition them — every calculation updates live.',
  },
  {
    target: '#sidebar',
    title: 'Configure each install',
    text: 'Every node is a full install: platform (UAV, vessel, mast…), Mesh Rider model and band, antenna from the verified catalog, height above ground, cable run, and amplification. Height and antenna choice drive the terrain math, so keep them honest.',
  },
  {
    target: '#btn-link-mode',
    title: 'Analyze links',
    text: 'Click “⟋ Link Nodes”, then two nodes. The link is checked over the real elevation profile — line of sight, Fresnel-zone clearance, and diffraction — and colored green/amber/orange/red by how healthy it is. Click any link to see its terrain profile.',
  },
  {
    target: '#plan-mode',
    title: 'Quote it optimistically, or honestly',
    text: '“Calculated” gives you the model’s own answer. “Marginal” holds 15% back — ranges shrink to 85%, quoted data rates drop to 85%, and the link budget is charged the path loss that implies, so a link with only a little headroom will flip from working to failing. Use it for anything a customer will hold you to; the exported report says which basis produced its numbers.',
  },
  {
    target: '#btn-advisor',
    reveal: 'm-deliver',
    title: 'Or let the Plan Advisor design it',
    text: 'Describe the mission — what talks to what, how far, how much data — and get ranked, compatible configurations with antennas, aiming, heights and cabling. It can also extend your existing infrastructure and even site a relay when terrain blocks a single hop.',
  },
  {
    target: '#btn-airtime',
    reveal: 'm-analyse',
    title: 'Will it carry the traffic?',
    text: 'A link that closes is not the same as a link that works. Link budget adds the traffic side: pick what the link actually carries - H.264 downlink, MAVLink both ways, a file transfer - and it reports airtime, not just margin. The radio is half duplex, so uplink and downlink spend the same airtime, and a TCP download loads the uplink with its acknowledgements. Model design by Aaron Do.',
  },
  {
    target: '#btn-save',
    reveal: 'm-deliver',
    title: 'Save your work, hand off designs',
    text: 'Layouts save as portable files (the browser also auto-saves as you go), and “📄 Report” exports a customer-ready design document with terrain profiles and minimum UAV altitudes.',
  },
  {
    target: '#btn-help',
    title: 'More detail anytime',
    text: '“Help me plan” has the full guide — color codes, heatmaps, the math behind the predictions, and planning tips. You can replay this tour from there too. Enjoy!',
  },
];

// Phones get different chrome, so the tour describes what is actually on screen
// rather than pointing at a toolbar that is not there.
const MOBILE_STEPS = {
  0: {
    target: '#nav-toggle',
    title: 'Everything lives in the menu',
    text: 'On a phone the toolbar folds into this menu: placing radios, the analysis tools, the Plan Advisor and reports, plus options like fade margin and the satellite basemap. Panels open as sheets from the bottom of the screen.',
  },
  1: {
    target: '#sidebar-toggle',
    title: 'Give the map the whole screen',
    text: 'The node list sits under the map and collapses with this handle, so you get the full screen for positioning a radio and bring the list back to edit it.',
  },
};

let idx = 0;
let els = null;

function ensureDom() {
  if (els) return els;
  const overlay = document.createElement('div');
  overlay.id = 'tour-overlay';
  overlay.innerHTML = `
    <div id="tour-spot"></div>
    <div id="tour-card">
      <div id="tour-title"></div>
      <div id="tour-text"></div>
      <div id="tour-nav">
        <button id="tour-skip" class="tour-btn ghost">Skip tutorial</button>
        <span id="tour-count"></span>
        <button id="tour-back" class="tour-btn ghost">‹ Back</button>
        <button id="tour-next" class="tour-btn primary">Next ›</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#tour-skip').addEventListener('click', endTour);
  overlay.querySelector('#tour-back').addEventListener('click', () => show(idx - 1));
  overlay.querySelector('#tour-next').addEventListener('click', () => (idx >= STEPS.length - 1 ? endTour() : show(idx + 1)));
  window.addEventListener('resize', () => els && show(idx));
  els = overlay;
  return overlay;
}

function show(i) {
  idx = Math.max(0, Math.min(i, STEPS.length - 1));
  const navBtn = document.getElementById('nav-toggle');
  const isMobile = navBtn && getComputedStyle(navBtn).display !== 'none';
  const step = (isMobile && MOBILE_STEPS[idx]) ? MOBILE_STEPS[idx] : STEPS[idx];
  const overlay = ensureDom();
  overlay.style.display = 'block';
  const spot = overlay.querySelector('#tour-spot');
  const card = overlay.querySelector('#tour-card');
  overlay.querySelector('#tour-title').textContent = step.title;
  overlay.querySelector('#tour-text').textContent = step.text;
  overlay.querySelector('#tour-count').textContent = `${idx + 1} / ${STEPS.length}`;
  overlay.querySelector('#tour-back').style.visibility = idx === 0 ? 'hidden' : 'visible';
  overlay.querySelector('#tour-next').textContent = idx === STEPS.length - 1 ? 'Start planning ✓' : 'Next ›';

  // A target may sit inside a collapsed dropdown or the mobile drawer. Open its
  // container first: otherwise getBoundingClientRect returns zeros and the highlight
  // lands in the corner over nothing.
  if (step.reveal) {
    const tog = document.getElementById('nav-toggle');
    const drawer = document.getElementById('nav-drawer');
    if (tog && getComputedStyle(tog).display !== 'none' && drawer) {
      drawer.classList.add('open');
      const sc = document.getElementById('nav-scrim');
      if (sc) sc.classList.add('hidden');       // the tour supplies its own backdrop
    }
    const menu = document.getElementById(step.reveal);
    if (menu) {
      menu.classList.remove('hidden');
      // The click that advanced the tour is still bubbling, and the app closes all
      // dropdowns on a document click. Re-open on the next frame so the highlighted
      // item is still on screen instead of the spotlight sitting over nothing.
      requestAnimationFrame(() => menu.classList.remove('hidden'));
    }
  } else {
    document.querySelectorAll('.tool-menu').forEach((m) => m.classList.add('hidden'));
  }

  const target = step.target ? document.querySelector(step.target) : null;

  // On a phone most targets live inside the nav drawer. Open it before measuring,
  // and suppress the slide transition while the tour is driving, or the rect is
  // read mid-animation and the highlight lands off the edge of the screen.
  const navD = document.getElementById('nav-drawer');
  const navT = document.getElementById('nav-toggle');
  if (target && navD && navT && getComputedStyle(navT).display !== 'none'
      && navD.contains(target)) {
    navD.classList.add('tour-snap', 'open');
    const nsc = document.getElementById('nav-scrim');
    if (nsc) nsc.classList.add('hidden');        // the tour has its own backdrop
  } else if (navD) {
    navD.classList.remove('open');
  }

  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    Object.assign(spot.style, {
      display: 'block',
      left: r.left - pad + 'px', top: r.top - pad + 'px',
      width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px',
    });
    // place card below the target if room, else above; clamp horizontally
    const cw = Math.min(400, window.innerWidth - 24);
    card.style.width = cw + 'px';
    let cx = Math.max(12, Math.min(r.left, window.innerWidth - cw - 12));
    let cy = r.bottom + pad + 12;
    if (cy > window.innerHeight - 190) cy = Math.max(12, r.top - pad - 190);
    Object.assign(card.style, { left: cx + 'px', top: cy + 'px', transform: 'none' });
  } else {
    spot.style.display = 'none';
    Object.assign(card.style, { left: '50%', top: '42%', transform: 'translate(-50%, -50%)', width: Math.min(440, window.innerWidth - 24) + 'px' });
  }
}

export function endTour() {
  // the tour opens menus and the drawer to point at things; put them back
  document.querySelectorAll('.tool-menu').forEach((m) => m.classList.add('hidden'));
  const d = document.getElementById('nav-drawer');
  if (d) d.classList.remove('open', 'tour-snap');
  const sc = document.getElementById('nav-scrim');
  if (sc) sc.classList.add('hidden');
  const tg = document.getElementById('nav-toggle');
  if (tg) tg.setAttribute('aria-expanded', 'false');
  try { localStorage.setItem(DONE_KEY, '1'); } catch {}
  if (els) els.style.display = 'none';
}

export function startTour(force = false) {
  try { if (!force && localStorage.getItem(DONE_KEY)) return; } catch {}
  show(0);
}
