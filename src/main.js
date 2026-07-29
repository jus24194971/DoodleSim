import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { RADIOS, BANDS, CHANNEL_WIDTHS, PLATFORMS, CABLES, cableLossDb } from './radios.js';
import { terrainProfile, haversineM, bearingDeg, destination, elevationAt } from './terrain.js';
import { analyzePath, evaluateLink, fsplDb, throughputMbps, patternLossDb, elevationAngleDeg, angDiff } from './engine.js';
import {
  computeCoverage, computeMeshCoverage, computeMinAltitude, computeMeshMinAltitude,
  findLowestFlightLevel,
  colorForMcs, colorForRssi, colorForExcessLoss, colorForMargin, colorForAltitude,
  METRICS, QUALITY,
} from './coverage.js';
import { SCENARIOS, recommend, adviseExtension, REMOTE_PLATFORMS } from './advisor.js';
import { buildReportHtml } from './report.js';
import { startTour } from './tour.js';

// ---------- State ----------
let nodes = []; // {id, label, lngLat, marker, radioId, bandId, freqMhz, bwMhz, powerDbm, antennaGain, heightM, cableLoss, bdaGain, platform}
let links = []; // {id, a, b, result, pathAnalysis, profile}
let nextNodeId = 1;
let mode = null; // 'add' | 'link'
let linkFirstNode = null;
let selectedLink = null;
let antennaCatalog = [];
let coverage = {
  nodeId: null, computing: false, lastRun: null,
  remoteMode: 'agl', remoteHeightM: 2, aslAltM: NaN, remoteGainDbi: 3,
  metric: 'mcs', nearGround: false, scope: 'mesh', targetNodeId: null,
  terrainMinM: null, terrainMaxM: null, meshStats: null,
};

const FADE_MARGIN = 10;

// ---------- Map ----------
const OSM_STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' },
    sat: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, attribution: 'Esri World Imagery' },
    hillshade: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 13 },
  },
  layers: [
    { id: 'osm', type: 'raster', source: 'osm' },
    { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
    { id: 'hills', type: 'hillshade', source: 'hillshade', paint: { 'hillshade-exaggeration': 0.3 } },
  ],
};

const map = new maplibregl.Map({ container: 'map', style: OSM_STYLE, center: [-98.5, 39.8], zoom: 4, preserveDrawingBuffer: true });
map.addControl(new maplibregl.NavigationControl(), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

function setupMapLayers() {
  if (map.getSource('beams')) return;
  mapReady = true;
  map.addSource('beams', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'beams', type: 'fill', source: 'beams',
    paint: { 'fill-color': '#1c7ed6', 'fill-opacity': 0.18 },
  });
  map.addLayer({
    id: 'beam-outline', type: 'line', source: 'beams',
    paint: { 'line-color': '#1c7ed6', 'line-width': 1.5, 'line-opacity': 0.55, 'line-dasharray': [2, 2] },
  });
  map.addSource('links', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'links', type: 'line', source: 'links',
    paint: { 'line-width': 4, 'line-color': ['get', 'color'], 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'link-labels', type: 'symbol', source: 'links',
    layout: { 'symbol-placement': 'line-center', 'text-field': ['get', 'label'], 'text-size': 12, 'text-font': ['Noto Sans Regular'] },
    paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 },
  });
  map.on('click', 'links', (e) => {
    const id = e.features[0]?.properties?.id;
    const link = links.find((l) => l.id === id);
    if (link) showProfile(link);
  });
  map.on('mouseenter', 'links', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'links', () => (map.getCanvas().style.cursor = ''));
  refreshLinks(); refreshBeams();
}
map.on('load', setupMapLayers);

document.getElementById('basemap-toggle').addEventListener('change', (e) => {
  map.setLayoutProperty('sat', 'visibility', e.target.checked ? 'visible' : 'none');
  map.setLayoutProperty('osm', 'visibility', e.target.checked ? 'none' : 'visible');
});

// ---------- Antenna catalog ----------
async function loadCatalog() {
  const [verified, rec, community] = await Promise.all([
    fetch('/data/antennas_app.json').then((r) => r.json()),
    fetch('/data/antennas_recommended.json').then((r) => r.json()).catch(() => ({ antennas: [] })),
    fetch('/api/antennas').then((r) => (r.ok ? r.json() : { antennas: [] })).catch(() => ({ antennas: [] })),
  ]);
  const key = (a) => ((a.manufacturer || '') + a.model).toLowerCase().replace(/\s/g, '');
  const seen = new Set(verified.antennas.map(key));
  const extraRec = rec.antennas.filter((a) => !seen.has(key(a)));
  extraRec.forEach((a) => seen.add(key(a)));
  const extraCommunity = (community.antennas || []).filter((a) => !seen.has(key(a)));
  antennaCatalog = [...extraRec, ...verified.antennas, ...extraCommunity];
  renderSidebar();
}
loadCatalog();

function antennasForFreq(freqMhz) {
  return antennaCatalog.filter((a) => a.band_mhz[0] <= freqMhz && a.band_mhz[1] >= freqMhz);
}

// Custom ("Other") antenna types with typical az/el half-power beamwidths
const CUSTOM_ANT_TYPES = {
  omni: { label: 'Omni (collinear/fiberglass)', az: 360, el: 15 },
  whip: { label: 'Whip / dipole', az: 360, el: 40 },
  sector: { label: 'Sector', az: 90, el: 10 },
  panel: { label: 'Panel / patch', az: 60, el: 60 },
  yagi: { label: 'Yagi', az: 40, el: 35 },
  dish: { label: 'Dish / grid (size-based)', az: 8, el: 8 },
  helical: { label: 'Helical', az: 35, el: 35 },
};

// Parabolic dish estimates from diameter: gain ≈ 10·log10(η·(πD/λ)²), HPBW ≈ 70·λ/D
function dishEstimates(diaM, freqMhz) {
  const lambda = 299.792458 / freqMhz;
  const gain = 10 * Math.log10(0.55 * (Math.PI * diaM / lambda) ** 2);
  const hpbw = Math.max(1, 70 * lambda / diaM);
  return { gain: Math.round(gain * 10) / 10, hpbw: Math.round(hpbw * 10) / 10 };
}

// Resolve a node's antenna radiation pattern (from catalog, or custom fields)
function getPattern(node) {
  const a = node.antennaId ? antennaCatalog.find((x) => x.id === node.antennaId) : null;
  if (a) {
    const omniAz = a.pattern === 'omni';
    return {
      hpbwAz: omniAz ? 360 : (a.hpbw_az_deg && a.hpbw_az_deg < 360 ? a.hpbw_az_deg : 60),
      hpbwEl: a.hpbw_el_deg || (omniAz ? 20 : 25),
      directional: !omniAz,
    };
  }
  return {
    hpbwAz: node.customHpbwAz || 360,
    hpbwEl: node.customHpbwEl || 360,
    directional: (node.customHpbwAz || 360) < 360,
  };
}

function effectiveGain(node, towardBearing, elevAngle) {
  const pat = getPattern(node);
  const loss = patternLossDb({
    offAzDeg: pat.directional ? angDiff(towardBearing, node.azimuthDeg) : 0,
    offElDeg: Math.abs(elevAngle - node.tiltDeg),
    hpbwAz: pat.hpbwAz,
    hpbwEl: pat.hpbwEl,
  });
  return { gain: node.antennaGain - loss, patternLoss: loss };
}

// ---------- Modes ----------
const btnAdd = document.getElementById('btn-add-node');
const btnLink = document.getElementById('btn-link-mode');
const hint = document.getElementById('mode-hint');

function setMode(m) {
  mode = mode === m ? null : m;
  linkFirstNode = null;
  btnAdd.classList.toggle('active', mode === 'add');
  btnLink.classList.toggle('active', mode === 'link');
  nodes.forEach((n) => n.marker.getElement().classList.remove('selected'));
  hint.textContent = mode === 'add' ? 'Click the map to place a node' : mode === 'link' ? 'Click two nodes to link them' : '';
  map.getCanvas().style.cursor = mode === 'add' ? 'crosshair' : '';
}
btnAdd.addEventListener('click', () => setMode('add'));
btnLink.addEventListener('click', () => setMode('link'));
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!nodes.length || confirm('Remove all nodes and links?')) {
    nodes.forEach((n) => { n.marker.remove(); removeBeamHandle(n); });
    nodes = []; links = []; selectedLink = null;
    hideProfile(); refreshLinks(); refreshBeams(); renderSidebar(); persistState();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'n') setMode('add');
  if (e.key === 'l') setMode('link');
});

map.on('click', (e) => {
  if (mode === 'add') { addNode(e.lngLat); setMode(null); }
});

// ---------- Save / Load ----------
function serializeState() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    view: { center: map.getCenter().toArray(), zoom: map.getZoom() },
    coverage: { remoteMode: coverage.remoteMode, remoteHeightM: coverage.remoteHeightM, aslAltM: coverage.aslAltM,
                remoteGainDbi: coverage.remoteGainDbi, metric: coverage.metric, nearGround: coverage.nearGround,
                scope: coverage.scope },
    nodes: nodes.map((n) => {
      const { lng, lat } = n.marker.getLngLat();
      return { id: n.id, label: n.label, lng, lat, radioId: n.radioId, bandId: n.bandId, freqMhz: n.freqMhz, bwMhz: n.bwMhz, powerDbm: n.powerDbm, antennaId: n.antennaId, antennaGain: n.antennaGain, heightM: n.heightM, cableLoss: n.cableLoss, bdaGain: n.bdaGain, platform: n.platform, azimuthDeg: n.azimuthDeg, tiltDeg: n.tiltDeg, customHpbwAz: n.customHpbwAz, customHpbwEl: n.customHpbwEl, customName: n.customName, customType: n.customType, dishDiaM: n.dishDiaM, cableType: n.cableType, cableLenM: n.cableLenM };
    }),
    links: links.map((l) => [l.a.id, l.b.id]),
  };
}

function restoreState(data) {
  nodes.forEach((n) => n.marker.remove());
  nodes = []; links = []; hideProfile(); clearCoverage();
  nextNodeId = 1;
  for (const s of data.nodes || []) {
    addNode({ lng: s.lng, lat: s.lat });
    const n = nodes[nodes.length - 1];
    Object.assign(n, { label: s.label ?? n.label, radioId: s.radioId, bandId: s.bandId, freqMhz: s.freqMhz, bwMhz: s.bwMhz, powerDbm: s.powerDbm, antennaId: s.antennaId ?? null, antennaGain: s.antennaGain, heightM: s.heightM, cableLoss: s.cableLoss ?? 0, bdaGain: s.bdaGain ?? 0, platform: s.platform ?? 'mast', azimuthDeg: s.azimuthDeg ?? 0, tiltDeg: s.tiltDeg ?? 0, customHpbwAz: s.customHpbwAz ?? 360, customHpbwEl: s.customHpbwEl ?? 360, customName: s.customName ?? '', customType: s.customType ?? 'omni', dishDiaM: s.dishDiaM ?? null, cableType: s.cableType ?? 'manual', cableLenM: s.cableLenM ?? 0 });
    n._savedId = s.id;
    n.marker.getElement().title = n.label;
  }
  for (const [ida, idb] of data.links || []) {
    const a = nodes.find((n) => n._savedId === ida), b = nodes.find((n) => n._savedId === idb);
    if (a && b) links.push({ id: `${a.id}-${b.id}`, a, b, result: null, pathAnalysis: null, profile: null });
  }
  if (data.coverage) Object.assign(coverage, {
    remoteMode: data.coverage.remoteMode ?? 'agl', remoteHeightM: data.coverage.remoteHeightM ?? 2,
    aslAltM: data.coverage.aslAltM ?? NaN, remoteGainDbi: data.coverage.remoteGainDbi ?? 3,
    metric: data.coverage.metric ?? 'mcs', nearGround: data.coverage.nearGround ?? false,
    scope: data.coverage.scope ?? 'mesh',
  });
  if (data.view) map.jumpTo({ center: data.view.center, zoom: data.view.zoom });
  refreshBeams(); renderSidebar(); recomputeAllLinks();
}

let persistTimer = null;
function persistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { localStorage.setItem('doodlesim-layout', JSON.stringify(serializeState())); } catch {}
  }, 400);
}

document.getElementById('btn-save').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(serializeState(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `doodlesim-layout-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
document.getElementById('btn-load').addEventListener('click', () => document.getElementById('file-load').click());

document.getElementById('btn-report').addEventListener('click', async () => {
  if (!nodes.length) { alert('Place nodes and links first — the report summarizes the current design.'); return; }
  const missionNote = prompt('One-line objective for this design (shown at the top of the report):',
    'Reliable Mesh Rider connectivity for the planned deployment area') || '';
  // annotate antenna display names for the report
  for (const n of nodes) {
    const a = n.antennaId ? antennaCatalog.find((x) => x.id === n.antennaId) : null;
    n._antName = a ? `${a.manufacturer} ${a.model} (${a.gain_dbi} dBi ${a.pattern})`
      : (n.customName ? `${n.customName} (${CUSTOM_ANT_TYPES[n.customType]?.label || 'custom'}, ${n.antennaGain} dBi)` : null);
  }
  const off = document.createElement('canvas');
  const renderProfilePng = (link) => {
    if (!link.profile) return null;
    drawProfile(link, off, { w: 860, h: 220 });
    return off.toDataURL('image/png');
  };
  let mapImagePng = null;
  try { mapImagePng = map.getCanvas().toDataURL('image/png'); } catch { /* map WebGL context may block capture */ }
  const html = buildReportHtml({ nodes, links, renderProfilePng, mapImagePng, missionNote, meshStats: coverage.meshStats, meshRemote: { h: coverage.remoteHeightM, g: coverage.remoteGainDbi },
    covRun: coverage.lastRun });
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `doodlesim-design-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
});
document.getElementById('file-load').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { restoreState(JSON.parse(await file.text())); }
  catch (err) { alert('Could not read layout file: ' + err.message); }
  e.target.value = '';
});

// ---------- Help ----------
const helpModal = document.getElementById('help-modal');
document.getElementById('btn-help').addEventListener('click', () => helpModal.classList.remove('hidden'));
document.getElementById('help-close').addEventListener('click', () => helpModal.classList.add('hidden'));
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.classList.add('hidden'); });
document.querySelectorAll('.help-tab-btn').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('.help-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.help-tab').forEach((t) => t.classList.toggle('active', t.id === 'help-tab-' + btn.dataset.tab));
  document.getElementById('help-body').scrollTop = 0;
}));

// ---------- Plan Advisor ----------
const advModal = document.getElementById('advisor-modal');
document.getElementById('adv-scenario').innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
document.getElementById('adv-remote-platform').innerHTML = REMOTE_PLATFORMS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
let advTarget = null;
document.querySelectorAll('input[name=adv-mode]').forEach((r) => r.addEventListener('change', () => {
  const extend = document.querySelector('input[name=adv-mode]:checked').value === 'extend';
  document.querySelectorAll('.adv-new').forEach((e) => e.classList.toggle('hidden', extend));
  document.querySelectorAll('.adv-extend').forEach((e) => e.classList.toggle('hidden', !extend));
  if (extend) {
    document.getElementById('adv-anchor').innerHTML = nodes.length
      ? nodes.map((n) => `<option value="${n.id}">${n.label} (${RADIOS.find((r2) => r2.id === n.radioId)?.name}, ${n.freqMhz} MHz)</option>`).join('')
      : '<option value="">— place a node first —</option>';
  }
}));
document.getElementById('adv-pick-target').addEventListener('click', () => {
  advModal.classList.add('hidden');
  hint.textContent = 'Click the map to set the advisor target location';
  map.getCanvas().style.cursor = 'crosshair';
  map.once('click', (e) => {
    advTarget = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    document.getElementById('adv-target-status').textContent = `${advTarget.lat.toFixed(4)}, ${advTarget.lng.toFixed(4)}`;
    hint.textContent = '';
    map.getCanvas().style.cursor = '';
    advModal.classList.remove('hidden');
  });
});
document.getElementById('btn-advisor').addEventListener('click', () => advModal.classList.remove('hidden'));
document.getElementById('advisor-close').addEventListener('click', () => advModal.classList.add('hidden'));
advModal.addEventListener('click', (e) => { if (e.target === advModal) advModal.classList.add('hidden'); });
document.getElementById('adv-preset').addEventListener('change', (e) => {
  if (e.target.value) document.getElementById('adv-mbps').value = e.target.value;
  e.target.value = '';
});

const esc2 = (s) => String(s ?? '').replace(/</g, '&lt;');

async function runExtendAdvisor() {
  const box = document.getElementById('advisor-results');
  const anchorNode = nodes.find((n) => n.id === parseInt(document.getElementById('adv-anchor').value));
  if (!anchorNode) { box.innerHTML = '<div class="adv-empty">Place at least one node on the map first — the advisor extends from your existing infrastructure.</div>'; return; }
  if (!advTarget) { box.innerHTML = '<div class="adv-empty">Set a target location with 📍 Pick on map.</div>'; return; }
  box.innerHTML = '<div class="adv-empty">Analyzing terrain path from your infrastructure…</div>';
  const needMbps = parseFloat(document.getElementById('adv-mbps').value) || 5;
  const out = await adviseExtension({
    anchor: {
      lngLat: anchorNode.marker.getLngLat(), label: anchorNode.label,
      radioId: anchorNode.radioId, freqMhz: anchorNode.freqMhz, bwMhz: anchorNode.bwMhz,
      powerDbm: anchorNode.powerDbm, antennaGain: anchorNode.antennaGain, cableLoss: anchorNode.cableLoss,
      bdaGain: anchorNode.bdaGain, azimuthDeg: anchorNode.azimuthDeg, tiltDeg: anchorNode.tiltDeg,
      heightM: anchorNode.heightM, pattern: getPattern(anchorNode),
    },
    targetLngLat: advTarget,
    remotePlatformId: document.getElementById('adv-remote-platform').value,
    needMbps,
    allowBda: document.getElementById('adv-bda').checked,
    catalog: antennaCatalog,
  });
  if (out.error) { box.innerHTML = `<div class="adv-empty">${out.error}</div>`; return; }
  const distKm = (out.distM / 1000).toFixed(1);
  let html = `<div class="adv-detail" style="margin-bottom:8px"><b>${anchorNode.label}</b> → target: ${distKm} km, bearing ${Math.round(out.brToTarget)}°${out.misaimed ? ` · ⚠ currently aimed ${Math.round(out.patLossNow)} dB off this direction` : ''}</div>`;
  if (out.options.length) {
    html += out.options.map((o, i) => `
      <div class="adv-card ${i === 0 ? 'best' : ''}">
        <h4>${i === 0 ? '🏆 ' : ''}${o.nChanges === 0 ? 'Works with your existing setup' : `${o.nChanges} change${o.nChanges > 1 ? 's' : ''} needed`}
          <span class="adv-tag">+${o.marginDb.toFixed(0)} dB margin</span>
          ${o.fresnel ? '<span class="adv-tag warn">tight Fresnel</span>' : ''}
          <button class="tool-btn adv-apply" data-apply-ext="${i}">Apply to map</button></h4>
        <div class="adv-detail">${o.changes.map((c) => '• ' + c).join('<br/>')}<br/>
        <span class="adv-install">Install spec — ${esc2(anchorNode.label)}: ${getPattern(anchorNode).directional ? `boresight ${Math.round(out.brToTarget)}°, ` : ''}${o.height} m mast, ${out.freq >= 4400 ? 'MC600' : 'MC400'} ${o.height + 2} m feed${o.bda > anchorNode.bdaGain ? ', BDA inline at antenna' : ''} · Remote: ${out.remote.id === 'uav' ? 'airframe mount' : out.remote.height + ' m mount'}, short 2 m jumper, ${o.ant.pattern === 'directional' ? `aim back at ${Math.round((out.brToTarget + 180) % 360)}°` : 'omni — no aiming'}</span><br/>
        → MCS ${o.mcs}, ~${o.mbps.toFixed(1)} Mbps usable at target</div>
      </div>`).join('');
  } else if (out.relay) {
    html += `<div class="adv-card best">
      <h4>🛰 Single hop won't close — add a relay <span class="adv-tag">+${out.relay.minMargin.toFixed(0)} dB min margin</span>
        <button class="tool-btn adv-apply" data-apply-relay>Apply relay + remote</button></h4>
      <div class="adv-detail">• Relay site: ${out.relay.distFromAnchorKm.toFixed(1)} km from ${anchorNode.label} (${out.relay.lngLat.lat.toFixed(4)}, ${out.relay.lngLat.lng.toFixed(4)}, elev ${out.relay.elevM.toFixed(0)} m) — ${out.relay.relayH} m mast, 10 dBi omni, same-band Mesh Rider (mesh hop)<br/>
      ${out.relay.reaim ? `• Re-aim ${anchorNode.label} toward the relay<br/>` : ''}
      • ${out.remote.label} kit: ${out.remote.formFactor} + ${out.relay.ant.manufacturer} ${out.relay.ant.model} (${out.relay.ant.gain_dbi} dBi)</div>
    </div>`;
  } else {
    html += `<div class="adv-empty">No single change closes this path — terrain blocks it and no relay point along the direct line works either.<br/>Consider a different anchor site, a UAV relay, or routing via a third location.</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('[data-apply-ext]').forEach((btn) => btn.addEventListener('click', () => {
    applyExtension(out, out.options[parseInt(btn.dataset.applyExt)], anchorNode);
    advModal.classList.add('hidden');
  }));
  box.querySelector('[data-apply-relay]')?.addEventListener('click', () => {
    applyRelay(out, anchorNode);
    advModal.classList.add('hidden');
  });
}

function makeRemoteNode(out, ant, pos, anchorNode) {
  addNode(pos);
  const n = nodes[nodes.length - 1];
  const anchorRadio = RADIOS.find((r) => r.id === anchorNode.radioId) || RADIOS[0];
  Object.assign(n, {
    label: out.remote.label.split(' ')[0] + ' (new)', platform: out.remote.id, heightM: out.remote.height,
    radioId: anchorRadio.id, freqMhz: out.freq, bwMhz: out.bw,
    powerDbm: anchorRadio.maxConfig,
    antennaId: antennaCatalog.some((a) => a.id === ant.id) ? ant.id : null,
    antennaGain: ant.gain_dbi, cableType: 'none', cableLenM: 0, cableLoss: 1,
  });
  return n;
}

function applyExtension(out, opt, anchorNode) {
  if (opt.aim) anchorNode.azimuthDeg = Math.round(out.brToTarget);
  if (opt.height !== anchorNode.heightM) anchorNode.heightM = opt.height;
  if (opt.bda !== anchorNode.bdaGain) anchorNode.bdaGain = opt.bda;
  const n = makeRemoteNode(out, opt.ant, advTarget, anchorNode);
  links.push({ id: `${anchorNode.id}-${n.id}`, a: anchorNode, b: n, result: null, pathAnalysis: null, profile: null });
  refreshBeams(); renderSidebar(); recomputeAllLinks(); persistState();
}

function applyRelay(out, anchorNode) {
  addNode(out.relay.lngLat);
  const relay = nodes[nodes.length - 1];
  const anchorRadio = RADIOS.find((r) => r.id === anchorNode.radioId);
  if (out.relay.reaim) anchorNode.azimuthDeg = Math.round(bearingDeg(anchorNode.marker.getLngLat(), out.relay.lngLat));
  Object.assign(relay, {
    label: 'Relay (new)', platform: 'mast', heightM: out.relay.relayH, radioId: anchorRadio.id,
    freqMhz: out.freq, bwMhz: out.bw, powerDbm: anchorRadio.maxConfig, antennaGain: 10, cableType: 'c400', cableLenM: out.relay.relayH + 2,
  });
  const auto = cableLossDb(relay.cableType, relay.cableLenM, relay.freqMhz);
  if (auto !== null) relay.cableLoss = auto;
  const n = makeRemoteNode(out, out.relay.ant, advTarget, anchorNode);
  links.push({ id: `${anchorNode.id}-${relay.id}`, a: anchorNode, b: relay, result: null, pathAnalysis: null, profile: null });
  links.push({ id: `${relay.id}-${n.id}`, a: relay, b: n, result: null, pathAnalysis: null, profile: null });
  refreshBeams(); renderSidebar(); recomputeAllLinks(); persistState();
}

document.getElementById('adv-run').addEventListener('click', () => {
  if (document.querySelector('input[name=adv-mode]:checked').value === 'extend') { runExtendAdvisor(); return; }
  const inputs = {
    scenarioId: document.getElementById('adv-scenario').value,
    rangeKm: parseFloat(document.getElementById('adv-range').value) || 5,
    throughputMbps: parseFloat(document.getElementById('adv-mbps').value) || 5,
    allowGovBands: document.getElementById('adv-gov').checked,
    allowBda: document.getElementById('adv-bda').checked,
    catalog: antennaCatalog,
  };
  const { scen, top } = recommend(inputs);
  const box = document.getElementById('advisor-results');
  if (!top.length) {
    box.innerHTML = `<div class="adv-empty">No configuration reaches ${inputs.rangeKm} km @ ${inputs.throughputMbps} Mbps with the current constraints.<br/>
      Try: lower throughput (narrower channels reach further), allow government bands or a Boost BDA, raise antenna heights, or split the path with a relay node.</div>`;
    return;
  }
  box.innerHTML = top.map((r, i) => `
    <div class="adv-card ${i === 0 ? 'best' : ''}">
      <h4>${i === 0 ? '🏆 ' : ''}${r.radio} · ${r.band}
        ${r.bdaDb ? '<span class="adv-tag warn">+ Boost BDA</span>' : ''}
        ${r.isGov ? '<span class="adv-tag gov">licensed band</span>' : ''}
        <span class="adv-tag">+${r.marginDb.toFixed(0)} dB margin</span>
        <button class="tool-btn adv-apply" data-apply="${i}">Apply to map</button></h4>
      <div class="adv-detail">
        <b>${scen.a.name}:</b> ${r.antA.doodle_recommended ? '★ ' : ''}${r.antA.manufacturer} ${r.antA.model} (${r.antA.gain_dbi} dBi ${r.antA.pattern}) @ ${scen.a.height} m<br/>
        <b>${scen.b.name}:</b> ${r.antB.doodle_recommended ? '★ ' : ''}${r.antB.manufacturer} ${r.antB.model} (${r.antB.gain_dbi} dBi ${r.antB.pattern}) @ ${scen.b.height} m<br/>
        ${r.freqMhz} MHz · ${r.bwMhz} MHz channel · MCS ${r.mcs} → ~${r.mbps.toFixed(1)} Mbps usable · reaches ~${r.reachKm.toFixed(1)} km${r.bdaDb ? ' · BDA +13 dB TX' : ''}
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-apply]').forEach((btn) => {
    btn.addEventListener('click', () => {
      applyAdvisorConfig(top[parseInt(btn.dataset.apply)], scen, inputs.rangeKm);
      advModal.classList.add('hidden');
    });
  });
});

function applyAdvisorConfig(r, scen, rangeKm) {
  const c = map.getCenter();
  const half = (rangeKm * 1000) / 2;
  const posA = destination(c.lng, c.lat, 270, half);
  const posB = destination(c.lng, c.lat, 90, half);
  const mk = (pos, side, ant, azTo) => {
    addNode(pos);
    const n = nodes[nodes.length - 1];
    Object.assign(n, {
      label: side.name, platform: side.platform, heightM: side.height,
      radioId: r.radioId, bandId: r.bandId, freqMhz: r.freqMhz, bwMhz: r.bwMhz,
      powerDbm: RADIOS.find((x) => x.id === r.radioId).maxConfig,
      antennaId: antennaCatalog.some((a) => a.id === ant.id) ? ant.id : null,
      antennaGain: ant.gain_dbi, azimuthDeg: azTo,
      bdaGain: r.bdaDb || 0, cableType: 'c400',
      cableLenM: side.platform === 'mast' ? Math.max(2, side.height + 2) : 2,
    });
    const auto = cableLossDb(n.cableType, n.cableLenM, n.freqMhz);
    if (auto !== null) n.cableLoss = auto;
    return n;
  };
  const nA = mk(posA, scen.a, r.antA, 90);
  const nB = mk(posB, scen.b, r.antB, 270);
  links.push({ id: `${nA.id}-${nB.id}`, a: nA, b: nB, result: null, pathAnalysis: null, profile: null });
  refreshBeams(); renderSidebar(); recomputeAllLinks(); persistState();
  map.fitBounds([[posA.lng, posA.lat], [posB.lng, posB.lat]], { padding: 80 });
}

// restore autosaved layout on boot (after map + catalog ready)
map.once('idle', () => {
  try {
    const saved = localStorage.getItem('doodlesim-layout');
    if (saved && !nodes.length) {
      const data = JSON.parse(saved);
      if (data.nodes?.length) restoreState(data);
    }
  } catch {}
  // first-visit guided tour (auto-skipped once completed or dismissed)
  startTour(false);
});
document.getElementById('tour-replay')?.addEventListener('click', () => {
  helpModal.classList.add('hidden');
  startTour(true);
});

// ---------- Nodes ----------
function addNode(lngLat) {
  const id = nextNodeId++;
  const el = document.createElement('div');
  el.className = 'node-marker';
  el.textContent = id;
  const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lngLat).addTo(map);
  const node = {
    id, label: `Node ${id}`, marker,
    radioId: 'miniOEM_v4', bandId: 'ism2400', freqMhz: 2450, bwMhz: 20,
    powerDbm: 32, antennaId: null, antennaGain: 3, heightM: 10, cableLoss: 0, bdaGain: 0, platform: 'mast',
    azimuthDeg: 0, tiltDeg: 0, customHpbwAz: 360, customHpbwEl: 360,
    customName: '', customType: 'omni', dishDiaM: null,
    cableType: 'none', cableLenM: 0,
  };
  marker.on('drag', () => refreshBeams());
  marker.on('dragend', () => { refreshBeams(); recomputeAllLinks(); persistState(); updateGroundElev(node); });
  updateGroundElev(node);
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (mode === 'link') handleLinkClick(node, el);
  });
  nodes.push(node);
  renderSidebar();
  persistState();
}

async function updateGroundElev(node) {
  const { lng, lat } = node.marker.getLngLat();
  try {
    node.groundElevM = await elevationAt(lng, lat);
    node.marker.getElement().title = `${node.label} — ground ${node.groundElevM.toFixed(0)} m ASL, antenna +${node.heightM} m AGL`;
    renderSidebar();
  } catch { node.groundElevM = null; }
}

function handleLinkClick(node, el) {
  if (!linkFirstNode) {
    linkFirstNode = node;
    el.classList.add('selected');
  } else if (linkFirstNode.id !== node.id) {
    const a = linkFirstNode, b = node;
    if (!links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) {
      links.push({ id: `${a.id}-${b.id}`, a, b, result: null, pathAnalysis: null, profile: null });
    }
    setMode(null);
    recomputeAllLinks();
    persistState();
  }
}

function removeNode(node) {
  node.marker.remove();
  removeBeamHandle(node);
  nodes = nodes.filter((n) => n !== node);
  links = links.filter((l) => l.a !== node && l.b !== node);
  if (selectedLink && (selectedLink.a === node || selectedLink.b === node)) hideProfile();
  if (coverage.nodeId === node.id) clearCoverage();
  refreshLinks(); renderSidebar(); persistState();
}

// ---------- Coverage simulation: terrain-following (UGV) / flight level (UAS) ----------
let mapReady = false;
function styleReady() {
  return new Promise((res) => {
    const check = () => {
      if (map.style && map.style._loaded) { setupMapLayers(); res(); return true; }
      return false;
    };
    if (check()) return;
    const iv = setInterval(() => { if (check()) clearInterval(iv); }, 150);
  });
}

function paintCoverage(canvas, bounds, opacity = 0.75) {
  if (map.getLayer('coverage')) map.removeLayer('coverage');
  if (map.getSource('coverage')) map.removeSource('coverage');
  map.addSource('coverage', { type: 'canvas', canvas, coordinates: bounds, animate: false });
  map.addLayer({ id: 'coverage', type: 'raster', source: 'coverage', paint: { 'raster-opacity': opacity } }, 'links');
}

function clearCoverage() {
  if (map.getLayer('coverage')) map.removeLayer('coverage');
  if (map.getSource('coverage')) map.removeSource('coverage');
  coverage.nodeId = null;
  coverage.meshStats = null;
  coverage.lastRun = null;
  document.getElementById('coverage-legend')?.remove();
  const body = document.getElementById('cov-legend-body');
  if (body) body.innerHTML = '';
  renderSidebar();
}

const covPanel = document.getElementById('cov-panel');
const $cov = (id) => document.getElementById(id);

function covRefNode() {
  if (coverage.scope === 'node') return nodes.find((n) => n.id === coverage.targetNodeId) || nodes[0];
  return nodes.find((n) => n.id === coverage.targetNodeId) || nodes[0];
}

// Picking a platform implies what kind of simulation the user wants.
function applyPlatformDefaults(node) {
  if (!node) return;
  const ground = node.groundElevM ?? 0;
  if (node.platform === 'uav') {
    coverage.remoteMode = 'asl';
    coverage.aslAltM = Math.round((ground + 120) / 10) * 10;
    coverage.nearGround = false;
    coverage.remoteGainDbi = 3;
  } else {
    coverage.remoteMode = 'agl';
    const p = PLATFORMS.find((x) => x.id === node.platform);
    coverage.remoteHeightM = p ? Math.min(p.defaultHeight, 10) : 2;
    coverage.nearGround = ['ugv', 'vehicle', 'handheld'].includes(node.platform);
  }
}

function altSliderBounds() {
  const ref = covRefNode();
  const ground = coverage.terrainMinM ?? ref?.groundElevM ?? 0;
  const top = (coverage.terrainMaxM ?? ref?.groundElevM ?? 0) + 1500;
  return { min: Math.floor(ground / 10) * 10, max: Math.ceil(top / 10) * 10 };
}

function syncCovPanel() {
  const ref = covRefNode();
  document.querySelectorAll('.cov-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === coverage.remoteMode));
  document.querySelectorAll('.cov-scope-btn').forEach((b) => b.classList.toggle('active', b.dataset.scope === coverage.scope));
  $cov('cov-agl-row').classList.toggle('hidden', coverage.remoteMode !== 'agl');
  $cov('cov-asl-row').classList.toggle('hidden', coverage.remoteMode !== 'asl');
  $cov('cov-agl').value = coverage.remoteHeightM;
  $cov('cov-nearground').checked = !!coverage.nearGround;
  $cov('cov-gain').value = coverage.remoteGainDbi;
  $cov('cov-metric').value = coverage.metric;

  const nodeSel = $cov('cov-node');
  nodeSel.classList.toggle('hidden', coverage.scope !== 'node');
  nodeSel.innerHTML = nodes.map((n) => `<option value="${n.id}" ${n.id === coverage.targetNodeId ? 'selected' : ''}>${n.label}</option>`).join('');

  const b = altSliderBounds();
  const slider = $cov('cov-asl-slider');
  slider.min = b.min; slider.max = b.max; slider.step = 10;
  if (!Number.isFinite(coverage.aslAltM)) coverage.aslAltM = Math.round(((ref?.groundElevM ?? 0) + 120) / 10) * 10;
  coverage.aslAltM = Math.min(Math.max(coverage.aslAltM, b.min), b.max);
  slider.value = coverage.aslAltM;
  $cov('cov-asl').value = coverage.aslAltM;

  const ground = ref?.groundElevM;
  const above = Number.isFinite(ground) ? coverage.aslAltM - ground : null;
  const ft = Math.round(coverage.aslAltM * 3.28084);
  $cov('cov-alt-readout').innerHTML = Number.isFinite(above)
    ? `${coverage.aslAltM} m ASL (${ft} ft) · ${above >= 0 ? '≈' + Math.round(above) + ' m above' : '≈' + Math.round(-above) + ' m BELOW'} ${ref.label}`
    : `${coverage.aslAltM} m ASL (${ft} ft)`;
}

function openCovPanel({ scope, nodeId, useDefaults } = {}) {
  if (!nodes.length) { alert('Place at least one node first.'); return; }
  if (scope) coverage.scope = scope;
  if (nodeId != null) coverage.targetNodeId = nodeId;
  if (coverage.targetNodeId == null) coverage.targetNodeId = nodes[0].id;
  if (useDefaults) applyPlatformDefaults(covRefNode());
  covPanel.classList.remove('hidden');
  syncCovPanel();
}

function covEntries() {
  const list = coverage.scope === 'node' ? [covRefNode()].filter(Boolean) : nodes;
  return list.map((n) => {
    const radio = RADIOS.find((r) => r.id === n.radioId);
    const pat = getPattern(n);
    return {
      node: n, radio, bandId: n.bandId,
      txPattern: (pat.directional || pat.hpbwEl < 360)
        ? { azimuthDeg: n.azimuthDeg, tiltDeg: n.tiltDeg, hpbwAz: pat.hpbwAz, hpbwEl: pat.hpbwEl } : null,
    };
  });
}

let covGen = 0;
let covTimer = null;

async function simulateCoverage(quality = QUALITY.normal) {
  if (!nodes.length) return;
  const gen = ++covGen;
  coverage.computing = true;
  const status = $cov('cov-status');
  const entries = covEntries();
  if (!entries.length) { coverage.computing = false; return; }
  const ref = covRefNode();
  const isMesh = coverage.scope === 'mesh';
  const common = {
    remoteGainDbi: coverage.remoteGainDbi,
    fadeMargin: FADE_MARGIN,
    remoteMode: coverage.remoteMode,
    remoteAltM: coverage.remoteMode === 'asl' ? coverage.aslAltM : coverage.remoteHeightM,
    remoteHeightM: coverage.remoteHeightM,
    nearGround: coverage.nearGround,
    metric: coverage.metric,
    quality,
  };
  const prog = (p) => { if (gen === covGen) status.textContent = `Simulating… ${Math.round(p * 100)}%`; };

  try {
    let result;
    if (coverage.metric === 'minalt') {
      const o = { ...common, mode: coverage.remoteMode, minMbps: 0 };
      result = isMesh
        ? await computeMeshMinAltitude(entries, o, prog)
        : await computeMinAltitude(ref, entries[0].radio, o, prog);
    } else if (isMesh) {
      result = await computeMeshCoverage(entries, common, prog);
    } else {
      result = await computeCoverage(ref, entries[0].radio, { ...common, txPattern: entries[0].txPattern }, prog);
    }
    if (gen !== covGen) return; // superseded by a newer run
    await styleReady();
    if (gen !== covGen) return;
    paintCoverage(result.canvas, result.bounds, coverage.metric === 'excess' ? 0.8 : 0.75);
    coverage.nodeId = isMesh ? 'mesh' : ref.id;
    coverage.meshStats = isMesh && coverage.metric === 'mcs' ? result.stats : null;
    coverage.lastRun = { stats: result.stats, metric: coverage.metric, mode: coverage.remoteMode,
                         altM: common.remoteAltM, scope: coverage.scope, nearGround: coverage.nearGround };
    if (result.rays) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < result.rays.elevs.length; i++) {
        const e = result.rays.elevs[i];
        if (e < lo) lo = e; if (e > hi) hi = e;
      }
      coverage.terrainMinM = lo; coverage.terrainMaxM = hi;
    }
    renderCovLegend(result);
    status.textContent = '';
    document.getElementById('coverage-legend')?.remove();
    syncCovPanel();
  } catch (err) {
    console.error('coverage simulation failed', err);
    if (gen === covGen) status.textContent = 'Simulation failed — see console';
  }
  if (gen === covGen) coverage.computing = false;
  renderSidebar();
}

function swatch(rgb) { return `<span class="leg-swatch" style="background:rgb(${rgb.join(',')})"></span>`; }

function renderCovLegend(result) {
  const ref = covRefNode();
  const body = $cov('cov-legend-body');
  const st = result.stats || {};
  const modeLabel = coverage.remoteMode === 'asl'
    ? `flight level ${coverage.aslAltM} m ASL`
    : `${coverage.remoteHeightM} m above ground`;
  let rows = '';

  if (coverage.metric === 'minalt') {
    const bands = [[30, '≤ 30 m'], [60, '31–60 m'], [120, '61–120 m'], [200, '121–200 m'], [400, '201–400 m'], [600, '> 400 m']];
    rows = bands.map(([v, l]) => `<div class="leg-row">${swatch(colorForAltitude(v))}${l}</div>`).join('')
      + `<div class="leg-row leg-note">Lowest ${coverage.remoteMode === 'asl' ? 'altitude ASL' : 'height above ground'} that closes a link · ${st.reachablePct?.toFixed(0) ?? '?'}% of area reachable</div>`
      + (st.ceilingBreakPct > 0.5 ? `<div class="cov-hint">⚠ ${st.ceilingBreakPct.toFixed(0)}% of the area also drops out again at higher altitude (vertical pattern null) — climb is not always better.</div>` : '');
  } else if (coverage.scope === 'mesh' && coverage.metric === 'mcs') {
    rows = `${swatch([123, 44, 191])}3+ radios · EXTREME (${st.extremeKm2?.toFixed(1)} km²)`.replace(/^/, '<div class="leg-row">') + '</div>'
      + `<div class="leg-row">${swatch([16, 110, 190])}2 radios · redundant (${st.redundantKm2?.toFixed(1)} km²)</div>`
      + `<div class="leg-row">${swatch([120, 170, 60])}1 radio · covered (${st.singleKm2?.toFixed(1)} km²)</div>`
      + (st.belowTerrainKm2 > 0.05 ? `<div class="leg-row">${swatch([70, 70, 78])}below terrain (${st.belowTerrainKm2.toFixed(1)} km²)</div>` : '')
      + `<div class="leg-row leg-note">Overlap counted between same-band nodes only</div>`;
  } else if (coverage.metric === 'mcs') {
    const bands = [[14, 'MCS 14–15'], [12, 'MCS 12–13'], [10, 'MCS 10–11'], [8, 'MCS 8–9'], [4, 'MCS 4–7'], [0, 'MCS 0–3']];
    rows = bands.map(([m, l]) => `<div class="leg-row">${swatch(colorForMcs(m))}${l} · ≥${throughputMbps(m, ref.bwMhz).toFixed(0)} Mbps</div>`).join('')
      + (st.servedPct != null ? `<div class="leg-row leg-note">${st.servedKm2.toFixed(1)} km² served (${st.servedPct.toFixed(0)}% of the ${st.totalKm2.toFixed(0)} km² search area)</div>` : '');
  } else if (coverage.metric === 'rssi') {
    rows = [[-50, '≥ −55 dBm'], [-60, '−56…−65'], [-70, '−66…−75'], [-80, '−76…−82'], [-85, '−83…−88'], [-92, '−89…−95']]
      .map(([v, l]) => `<div class="leg-row">${swatch(colorForRssi(v))}${l}</div>`).join('');
  } else if (coverage.metric === 'excess') {
    rows = [[0, 'clear path (< 1 dB)'], [3, '1–6 dB'], [9, '6–12 dB'], [16, '12–20 dB'], [25, '20–30 dB'], [40, '> 30 dB (deep shadow)']]
      .map(([v, l]) => `<div class="leg-row">${swatch(colorForExcessLoss(v))}${l}</div>`).join('')
      + `<div class="leg-row leg-note">Loss above free space — the price the terrain charges</div>`;
  } else if (coverage.metric === 'margin') {
    rows = [[32, '≥ 30 dB'], [24, '20–29'], [17, '15–19'], [12, '10–14'], [7, '5–9'], [2, '0–4 (marginal)']]
      .map(([v, l]) => `<div class="leg-row">${swatch(colorForMargin(v))}${l}</div>`).join('');
  }

  body.innerHTML = `<div class="cov-label">${METRICS[coverage.metric]?.label || 'Minimum altitude'}</div>`
    + rows
    + `<div class="leg-row leg-note">Remote: ${modeLabel}, ${coverage.remoteGainDbi} dBi${coverage.nearGround ? ' · near-ground penalty on' : ''}</div>`
    + (coverage.remoteMode === 'asl' && coverage.metric !== 'minalt'
        ? `<div class="leg-row leg-note">${swatch([70, 70, 78])}grey = this flight level is inside terrain</div>` : '');
}

// Real-time altitude control
function scheduleSim(quality, delay = 70) {
  clearTimeout(covTimer);
  covTimer = setTimeout(() => simulateCoverage(quality), delay);
}

document.querySelectorAll('.cov-seg-btn').forEach((b) => b.addEventListener('click', () => {
  coverage.remoteMode = b.dataset.mode;
  if (coverage.remoteMode === 'asl' && !Number.isFinite(coverage.aslAltM)) {
    const ref = covRefNode();
    coverage.aslAltM = Math.round(((ref?.groundElevM ?? 0) + 120) / 10) * 10;
  }
  syncCovPanel();
  if (coverage.lastRun) scheduleSim(QUALITY.normal, 10);
}));
document.querySelectorAll('.cov-scope-btn').forEach((b) => b.addEventListener('click', () => {
  coverage.scope = b.dataset.scope;
  syncCovPanel();
  if (coverage.lastRun) scheduleSim(QUALITY.normal, 10);
}));
$cov('cov-close').addEventListener('click', () => covPanel.classList.add('hidden'));
$cov('cov-run').addEventListener('click', () => simulateCoverage(QUALITY.normal));
$cov('cov-agl').addEventListener('input', () => {
  coverage.remoteHeightM = parseFloat($cov('cov-agl').value) || 2;
  if (coverage.lastRun) scheduleSim(QUALITY.coarse);
});
$cov('cov-agl').addEventListener('change', () => { if (coverage.lastRun) scheduleSim(QUALITY.normal, 10); });
$cov('cov-nearground').addEventListener('change', () => {
  coverage.nearGround = $cov('cov-nearground').checked;
  if (coverage.lastRun) scheduleSim(QUALITY.normal, 10);
});
$cov('cov-gain').addEventListener('change', () => {
  coverage.remoteGainDbi = parseFloat($cov('cov-gain').value) || 3;
  if (coverage.lastRun) scheduleSim(QUALITY.normal, 10);
});
$cov('cov-metric').addEventListener('change', () => {
  coverage.metric = $cov('cov-metric').value;
  if (coverage.lastRun) scheduleSim(QUALITY.normal, 10);
});
$cov('cov-node').addEventListener('change', () => {
  coverage.targetNodeId = parseInt($cov('cov-node').value);
  syncCovPanel();
  if (coverage.lastRun) scheduleSim(QUALITY.normal, 10);
});
$cov('cov-asl-slider').addEventListener('input', () => {
  coverage.aslAltM = parseFloat($cov('cov-asl-slider').value);
  $cov('cov-asl').value = coverage.aslAltM;
  syncCovPanel();
  scheduleSim(QUALITY.coarse, 45); // live while dragging
});
$cov('cov-asl-slider').addEventListener('change', () => scheduleSim(QUALITY.normal, 10));
$cov('cov-asl').addEventListener('change', () => {
  coverage.aslAltM = parseFloat($cov('cov-asl').value);
  syncCovPanel();
  scheduleSim(QUALITY.normal, 10);
});

$cov('cov-find-fl').addEventListener('click', async () => {
  const status = $cov('cov-status');
  status.textContent = 'Sweeping flight levels…';
  try {
    const res = await findLowestFlightLevel(covEntries(), {
      remoteGainDbi: coverage.remoteGainDbi, fadeMargin: FADE_MARGIN,
      nearGround: false, quality: QUALITY.coarse, targetFraction: 0.9,
    }, (p) => { status.textContent = `Sweeping flight levels… ${Math.round(p * 100)}%`; });
    coverage.aslAltM = res.chosen.altM;
    coverage.remoteMode = 'asl';
    coverage.terrainMinM = res.terrainMin;
    coverage.terrainMaxM = res.terrainMax;
    syncCovPanel();
    await simulateCoverage(QUALITY.normal);
    status.textContent = `Lowest workable level: ${res.chosen.altM} m ASL — covers `
      + `${(100 * res.chosen.servedFraction).toFixed(0)}% of the search area, i.e. `
      + `${(100 * res.targetFraction).toFixed(0)}% of the best any altitude reaches `
      + `(${(100 * res.bestFraction).toFixed(0)}%). Terrain nearby: ${Math.round(res.terrainMin)}–${Math.round(res.terrainMax)} m ASL.`;
  } catch (err) {
    console.error('flight level sweep failed', err);
    status.textContent = 'Flight-level sweep failed — see console';
  }
});

// Entry points
async function runCoverage(node) {
  openCovPanel({ scope: 'node', nodeId: node.id, useDefaults: true });
  await simulateCoverage(QUALITY.normal);
}
async function runMeshCoverage() {
  openCovPanel({ scope: 'mesh', useDefaults: false });
  await simulateCoverage(QUALITY.normal);
}
document.getElementById('btn-mesh-coverage').addEventListener('click', () => {
  if (!nodes.length) { alert('Place at least one node first.'); return; }
  openCovPanel({ scope: nodes.length > 1 ? 'mesh' : 'node', useDefaults: !coverage.lastRun });
});

function removeLink(link) {
  links = links.filter((l) => l !== link);
  if (selectedLink === link) hideProfile();
  refreshLinks(); renderSidebar(); persistState();
}

// ---------- Link computation ----------
let computeSeq = 0;
async function recomputeAllLinks() {
  const seq = ++computeSeq;
  for (const link of links) {
    const a = link.a.marker.getLngLat(), b = link.b.marker.getLngLat();
    const distM = haversineM(a, b);
    const freqMhz = link.a.freqMhz; // planner assumes both ends on Node A's channel
    const bwMhz = Math.min(link.a.bwMhz, link.b.bwMhz);
    try {
      const profile = await terrainProfile(a, b, 160);
      if (seq !== computeSeq) return;
      const pathAnalysis = analyzePath(profile, link.a.heightM, link.b.heightM, freqMhz);
      const radioA = RADIOS.find((r) => r.id === link.a.radioId);
      const radioB = RADIOS.find((r) => r.id === link.b.radioId);
      const antennas = radioA.chains === 1 || radioB.chains === 1 ? 1 : 2;
      // antenna pattern: off-boresight losses from geometry (bearing + elevation angle)
      const elevAAsl = profile[0].elevM + link.a.heightM;
      const elevBAsl = profile[profile.length - 1].elevM + link.b.heightM;
      const brAB = bearingDeg(a, b);
      const brBA = bearingDeg(b, a);
      const elAB = elevationAngleDeg(elevAAsl, elevBAsl, distM);
      const effA = effectiveGain(link.a, brAB, elAB);
      const effB = effectiveGain(link.b, brBA, -elAB);
      const result = evaluateLink({
        distM, freqMhz, bwMhz, radioA, radioB,
        pathLoss: pathAnalysis,
        cfg: {
          powerA: link.a.powerDbm, powerB: link.b.powerDbm,
          gainA: effA.gain, gainB: effB.gain,
          cableA: link.a.cableLoss, cableB: link.b.cableLoss,
          bdaA: link.a.bdaGain, bdaB: link.b.bdaGain,
          fadeMargin: FADE_MARGIN, antennas,
        },
      });
      Object.assign(link, { result, pathAnalysis, profile, distM, freqMhz, bwMhz, patternLossA: effA.patternLoss, patternLossB: effB.patternLoss });
    } catch (err) {
      console.error('link compute failed', err);
      Object.assign(link, { result: null, pathAnalysis: null, profile: null, distM });
    }
  }
  refreshLinks(); renderSidebar();
  if (selectedLink) showProfile(selectedLink);
}

function linkColor(link) {
  if (!link.result?.best) return '#e03131';
  if (link.pathAnalysis?.losBlocked) return '#e8590c';
  if (link.pathAnalysis?.fresnelIntruded) return '#f08c00';
  return '#2f9e44';
}

function linkLabel(link) {
  if (!link.result?.best) return '✕ no link';
  const km = (link.distM / 1000).toFixed(1);
  return `${km} km · MCS${link.result.best.mcs} · ${link.result.best.mbps.toFixed(0)} Mbps`;
}

function refreshLinks() {
  const src = map.getSource('links');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: links.map((l) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [l.a.marker.getLngLat().toArray(), l.b.marker.getLngLat().toArray()] },
      properties: { id: l.id, color: linkColor(l), label: linkLabel(l) },
    })),
  });
}

// ---------- Antenna beam visualization + drag-to-aim ----------
function beamRadiusM(node) {
  return 400 + Math.max(node.antennaGain, 0) * 130;
}

function refreshBeams() {
  const src = map.getSource('beams');
  if (!src) return;
  const features = [];
  for (const node of nodes) {
    const pat = getPattern(node);
    if (!pat.directional) { removeBeamHandle(node); continue; }
    const { lng, lat } = node.marker.getLngLat();
    const R = beamRadiusM(node);
    const half = Math.max(pat.hpbwAz, 8) / 2;
    const ring = [[lng, lat]];
    for (let a = node.azimuthDeg - half; a <= node.azimuthDeg + half + 0.01; a += Math.max(half / 8, 1)) {
      const p = destination(lng, lat, a, R);
      ring.push([p.lng, p.lat]);
    }
    ring.push([lng, lat]);
    features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id: node.id } });
    ensureBeamHandle(node);
  }
  src.setData({ type: 'FeatureCollection', features });
}

function ensureBeamHandle(node) {
  const { lng, lat } = node.marker.getLngLat();
  const tip = destination(lng, lat, node.azimuthDeg, beamRadiusM(node));
  if (!node._beamHandle) {
    const el = document.createElement('div');
    el.className = 'beam-handle';
    el.title = 'Drag to aim antenna';
    const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(tip).addTo(map);
    marker.on('drag', () => {
      const hp = marker.getLngLat();
      node.azimuthDeg = Math.round(bearingDeg(node.marker.getLngLat(), hp)) % 360;
      refreshBeams();
      const azInput = document.querySelector(`[data-node="${node.id}"][data-f="azimuthDeg"]`);
      if (azInput) azInput.value = node.azimuthDeg;
    });
    marker.on('dragend', () => {
      ensureBeamHandle(node); // snap handle back onto the arc
      recomputeAllLinks(); persistState();
      if (coverage.nodeId === node.id) runCoverage(node);
    });
    node._beamHandle = marker;
  } else {
    node._beamHandle.setLngLat(tip);
  }
}

function removeBeamHandle(node) {
  if (node._beamHandle) { node._beamHandle.remove(); node._beamHandle = null; }
}

// ---------- Sidebar ----------
function renderSidebar() {
  const nodeList = document.getElementById('node-list');
  const linkList = document.getElementById('link-list');
  nodeList.innerHTML = nodes.length ? '' : '<div class="empty-hint">Click “+ Add Node”, then click the map to place your first radio.</div>';

  for (const node of nodes) {
    const radio = RADIOS.find((r) => r.id === node.radioId);
    const card = document.createElement('div');
    card.className = 'card';
    const ants = antennasForFreq(node.freqMhz);
    card.innerHTML = `
      <h3><span class="badge" style="background:#1c7ed6">${node.id}</span>
        <input class="label-input" value="${node.label.replace(/"/g, '&quot;')}" title="Node name (shown to customers)"/>
        <button class="del" title="Delete node">🗑</button></h3>
      <div class="row"><label>Platform</label><select data-f="platform">${PLATFORMS.map((p) => `<option value="${p.id}" ${p.id === node.platform ? 'selected' : ''}>${p.label}</option>`).join('')}</select></div>
      <div class="row"><label>Radio</label><select data-f="radioId">${RADIOS.map((r) => `<option value="${r.id}" ${r.id === node.radioId ? 'selected' : ''}>${r.name}</option>`).join('')}</select></div>
      <div class="row"><label>Band</label><select data-f="bandId">${radio.bands.map((b) => `<option value="${b}" ${b === node.bandId ? 'selected' : ''}>${BANDS[b].label}</option>`).join('')}</select></div>
      <div class="row"><label>Freq (MHz)</label><input type="number" data-f="freqMhz" value="${node.freqMhz}" min="${BANDS[node.bandId].lo}" max="${BANDS[node.bandId].hi}"/></div>
      <div class="row"><label>Bandwidth</label><select data-f="bwMhz">${CHANNEL_WIDTHS.map((w) => `<option value="${w}" ${w === node.bwMhz ? 'selected' : ''}>${w} MHz</option>`).join('')}</select></div>
      <div class="row"><label>TX power (dBm)</label><input type="number" data-f="powerDbm" value="${node.powerDbm}" min="0" max="${radio.maxConfig}"/></div>
      <div class="row"><label>Antenna</label><select data-f="antennaId">
        <option value="">Other (specify custom)…</option>
        ${[...ants].sort((x, y) => (y.doodle_recommended ? 1 : 0) - (x.doodle_recommended ? 1 : 0) || y.gain_dbi - x.gain_dbi).map((a) => `<option value="${a.id}" ${a.id === node.antennaId ? 'selected' : ''}>${a.doodle_recommended ? '★ ' : a.community ? '☁ ' : ''}${(a.manufacturer || '').split(' ')[0]} ${a.model} (${a.gain_dbi} dBi ${a.pattern})</option>`).join('')}
      </select></div>
      ${!node.antennaId ? `
      <div class="row"><label>Ant. name</label><input type="text" data-f="customName" value="${(node.customName || '').replace(/"/g, '&quot;')}" placeholder="e.g. Customer's existing yagi" style="flex:1;min-width:0;padding:3px 6px;border:1px solid #ced4da;border-radius:4px;font-size:12px"/></div>
      <div class="row"><label>Ant. type</label><select data-f="customType">${Object.entries(CUSTOM_ANT_TYPES).map(([k, t]) => `<option value="${k}" ${k === node.customType ? 'selected' : ''}>${t.label}</option>`).join('')}</select></div>
      ${node.customType === 'dish' ? `<div class="row"><label>Dish diameter (m)</label><input type="number" data-f="dishDiaM" value="${node.dishDiaM ?? ''}" min="0.1" step="0.1" placeholder="auto-estimates gain" title="Gain and beamwidth estimated from diameter at the operating frequency"/></div>` : ''}
      <div class="row"><button class="tool-btn" data-share-ant style="width:100%" title="Add this antenna to the shared library so every user can select it">☁ Share to antenna library</button></div>` : ''}
      <div class="row"><label>Ant. gain (dBi)</label><input type="number" data-f="antennaGain" value="${node.antennaGain}" step="0.5" ${node.antennaId ? 'disabled' : ''}/></div>
      ${node.antennaId ? `<div class="row"><label>Beamwidth az/el</label><span class="pat-info">${getPattern(node).directional ? getPattern(node).hpbwAz + '° / ' + getPattern(node).hpbwEl + '°' : 'omni / ' + getPattern(node).hpbwEl + '°'}</span></div>`
        : `<div class="row"><label>Beamwidth az (°)</label><input type="number" data-f="customHpbwAz" value="${node.customHpbwAz}" min="5" max="360" step="5" title="360 = omnidirectional"/></div>
           <div class="row"><label>Beamwidth el (°)</label><input type="number" data-f="customHpbwEl" value="${node.customHpbwEl}" min="5" max="360" step="5" title="360 = no elevation rolloff"/></div>`}
      ${getPattern(node).directional ? `<div class="row"><label>Azimuth (°)</label><input type="number" data-f="azimuthDeg" data-node="${node.id}" value="${node.azimuthDeg}" min="0" max="359" title="Boresight bearing — or drag the beam handle on the map"/></div>` : ''}
      ${getPattern(node).hpbwEl < 360 ? `<div class="row"><label>Tilt (°, + up)</label><input type="number" data-f="tiltDeg" value="${node.tiltDeg}" min="-90" max="90" step="1" title="Elevation boresight tilt: positive aims up, negative down"/></div>` : ''}
      <div class="row"><label>Height AGL (m)</label><input type="number" data-f="heightM" value="${node.heightM}" min="0.1" step="0.5"/></div>
      <div class="row"><label>Elevation</label><span class="pat-info">${node.groundElevM != null ? `ground ${node.groundElevM.toFixed(0)} m ASL + ${node.heightM} m mast = <b>${(node.groundElevM + node.heightM).toFixed(0)} m ASL</b> antenna` : 'fetching terrain…'}</span></div>
      <div class="row"><label>Cable type</label><select data-f="cableType">${Object.entries(CABLES).map(([k, c]) => `<option value="${k}" ${k === node.cableType ? 'selected' : ''}>${c.label}</option>`).join('')}</select></div>
      ${node.cableType !== 'manual' && node.cableType !== 'none' ? `<div class="row"><label>Cable length (m)</label><input type="number" data-f="cableLenM" value="${node.cableLenM}" min="0" step="0.5"/></div>` : ''}
      <div class="row"><label>Cable loss (dB)</label><input type="number" data-f="cableLoss" value="${node.cableLoss.toFixed ? node.cableLoss.toFixed(1) : node.cableLoss}" min="0" step="0.5" ${node.cableType !== 'manual' ? 'disabled' : ''} title="${node.cableType !== 'manual' ? 'Auto-computed from cable type, length, and frequency (incl. 0.5 dB connectors)' : 'Manual cable + connector loss'}"/></div>
      <div class="row"><label>BDA gain (dB)</label><input type="number" data-f="bdaGain" value="${node.bdaGain}" min="0" step="1"/></div>
      <div class="row"><label>Remote ant. (m / dBi)</label>
        <input type="number" data-cov="remoteHeightM" value="${coverage.remoteHeightM}" min="0.1" step="0.5" title="Remote node height AGL for coverage"/>
        <input type="number" data-cov="remoteGainDbi" value="${coverage.remoteGainDbi}" step="0.5" title="Remote node antenna gain for coverage"/></div>
      <div class="row cov-row">
        <button class="tool-btn" data-coverage ${coverage.computing ? 'disabled' : ''}>${coverage.nodeId === node.id ? '↻ Recompute coverage' : '▦ Simulate coverage'}</button>
        ${coverage.nodeId === node.id ? '<button class="tool-btn" data-coverage-clear title="Remove heatmap">✕</button>' : ''}
      </div>`;
    card.querySelector('.del').addEventListener('click', () => removeNode(node));
    card.querySelector('.label-input').addEventListener('change', (ev) => {
      node.label = ev.target.value.trim() || `Node ${node.id}`;
      node.marker.getElement().title = node.label;
      renderSidebar(); refreshLinks(); persistState();
    });
    card.querySelector('[data-share-ant]')?.addEventListener('click', () => openShareDialog(node));
    card.querySelector('[data-coverage]')?.addEventListener('click', () => runCoverage(node));
    card.querySelector('[data-coverage-clear]')?.addEventListener('click', () => clearCoverage());
    card.querySelectorAll('[data-cov]').forEach((el) => {
      el.addEventListener('change', () => { coverage[el.dataset.cov] = parseFloat(el.value); });
    });
    card.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('change', () => {
        const f = el.dataset.f;
        const v = el.type === 'number' ? parseFloat(el.value) : el.value;
        node[f] = v;
        if (f === 'customType') {
          const t = CUSTOM_ANT_TYPES[v];
          node.customHpbwAz = t.az; node.customHpbwEl = t.el;
          if (v !== 'dish') node.dishDiaM = null;
        }
        if ((f === 'dishDiaM' && v > 0) || (f === 'freqMhz' && node.customType === 'dish' && node.dishDiaM > 0 && !node.antennaId)) {
          const est = dishEstimates(node.dishDiaM, f === 'freqMhz' ? v : node.freqMhz);
          node.antennaGain = est.gain;
          node.customHpbwAz = est.hpbw; node.customHpbwEl = est.hpbw;
        }
        if (f === 'platform') {
          node.heightM = PLATFORMS.find((p) => p.id === v).defaultHeight;
        }
        if (f === 'radioId') {
          const r = RADIOS.find((x) => x.id === v);
          if (!r.bands.includes(node.bandId)) node.bandId = r.bands[0];
          node.freqMhz = BANDS[node.bandId].def;
          node.powerDbm = Math.min(node.powerDbm, r.maxConfig);
        }
        if (f === 'bandId') node.freqMhz = BANDS[v].def;
        if (f === 'antennaId') {
          const a = antennaCatalog.find((x) => x.id === v);
          if (a) node.antennaGain = a.gain_dbi;
        }
        // auto cable loss depends on cable selection AND operating frequency
        const auto = cableLossDb(node.cableType, node.cableLenM, node.freqMhz);
        if (auto !== null) node.cableLoss = auto;
        refreshBeams();
        renderSidebar(); recomputeAllLinks(); persistState();
      });
    });
    nodeList.appendChild(card);
  }

  linkList.innerHTML = links.length ? '<h3 style="margin:6px 0">Links</h3>' : (nodes.length >= 2 ? '<div class="empty-hint">Use “⟋ Link Nodes” to connect two nodes.</div>' : '');
  for (const link of links) {
    const card = document.createElement('div');
    card.className = 'card';
    const best = link.result?.best;
    const pa = link.pathAnalysis;
    card.innerHTML = `
      <h3><span class="badge" style="background:${linkColor(link)}">●</span> ${link.a.label} ⟷ ${link.b.label}
        <button class="del" title="Delete link">🗑</button></h3>
      <div class="link-stat"><span>Distance</span><b>${link.distM ? (link.distM / 1000).toFixed(2) + ' km' : '—'}</b></div>
      <div class="link-stat"><span>Path</span><b>${!pa ? '—' : pa.losBlocked ? '⛔ Terrain blocked' : pa.fresnelIntruded ? '⚠ Fresnel intrusion' : '✓ Clear LOS'}</b></div>
      <div class="link-stat"><span>Diffraction loss</span><b>${pa ? pa.diffractionLossDb.toFixed(1) + ' dB' : '—'}</b></div>
      ${(link.patternLossA > 0.5 || link.patternLossB > 0.5) ? `<div class="link-stat"><span>Pattern (off-axis) loss</span><b>${link.patternLossA.toFixed(1)} / ${link.patternLossB.toFixed(1)} dB</b></div>` : ''}
      <div class="link-stat"><span>Best MCS / Throughput</span><b>${best ? `MCS${best.mcs} · ${best.mbps.toFixed(1)} Mbps` : 'No usable link'}</b></div>
      <div class="link-stat"><span>RSSI / Margin</span><b>${best ? `${best.rssi.toFixed(0)} dBm · +${best.margin.toFixed(0)} dB` : '—'}</b></div>
      <button class="tool-btn" style="width:100%;margin-top:6px" data-profile>Terrain profile ▾</button>`;
    card.querySelector('.del').addEventListener('click', () => removeLink(link));
    card.querySelector('[data-profile]').addEventListener('click', () => showProfile(link));
    linkList.appendChild(card);
  }
}

// ---------- Share custom antenna to community library ----------
function openShareDialog(node) {
  document.getElementById('share-ant-modal')?.remove();
  const band = BANDS[node.bandId];
  const pat = getPattern(node);
  // best-effort split of "Brand Model" from the custom name
  const parts = (node.customName || '').trim().split(/\s+/);
  const guessMfr = parts.length > 1 ? parts[0] : '';
  const guessModel = parts.length > 1 ? parts.slice(1).join(' ') : (node.customName || '');
  const div = document.createElement('div');
  div.id = 'share-ant-modal';
  div.innerHTML = `<div id="share-ant-box">
    <div id="share-ant-head"><b>☁ Share to antenna library</b><button id="share-ant-close">✕</button></div>
    <p class="share-note">Adds this antenna to the shared library for <b>all users</b>. Please give the real, referenceable manufacturer and model number — submissions are validated and deduplicated.</p>
    <div class="adv-row"><label>Manufacturer</label><input id="sa-mfr" value="${guessMfr.replace(/"/g, '&quot;')}" placeholder="e.g. L-com"/></div>
    <div class="adv-row"><label>Model number</label><input id="sa-model" value="${guessModel.replace(/"/g, '&quot;')}" placeholder="e.g. HG2424EG"/></div>
    <div class="adv-row"><label>Band (MHz)</label><input id="sa-lo" type="number" value="${band.lo}" style="width:90px"/> – <input id="sa-hi" type="number" value="${band.hi}" style="width:90px"/></div>
    <div class="adv-row"><label>Gain (dBi)</label><input id="sa-gain" type="number" step="0.1" value="${node.antennaGain}" style="width:90px"/></div>
    <div class="adv-row"><label>Beamwidth az/el (°)</label><input id="sa-az" type="number" value="${pat.hpbwAz}" style="width:90px"/> / <input id="sa-el" type="number" value="${pat.hpbwEl}" style="width:90px"/></div>
    <div class="adv-row"><label>Type</label><input id="sa-type" value="${(CUSTOM_ANT_TYPES[node.customType]?.label || '').replace(/"/g, '&quot;')}"/></div>
    <div id="sa-msg"></div>
    <button id="sa-submit" class="tour-btn primary" style="width:100%">Submit to library</button>
  </div>`;
  document.body.appendChild(div);
  div.addEventListener('click', (e) => { if (e.target === div) div.remove(); });
  div.querySelector('#share-ant-close').addEventListener('click', () => div.remove());
  div.querySelector('#sa-submit').addEventListener('click', async () => {
    const msg = div.querySelector('#sa-msg');
    const payload = {
      manufacturer: div.querySelector('#sa-mfr').value.trim(),
      model: div.querySelector('#sa-model').value.trim(),
      band_lo_mhz: parseFloat(div.querySelector('#sa-lo').value),
      band_hi_mhz: parseFloat(div.querySelector('#sa-hi').value),
      gain_dbi: parseFloat(div.querySelector('#sa-gain').value),
      pattern: parseFloat(div.querySelector('#sa-az').value) >= 360 ? 'omni' : 'directional',
      hpbw_az_deg: parseFloat(div.querySelector('#sa-az').value),
      hpbw_el_deg: parseFloat(div.querySelector('#sa-el').value),
      ant_type: div.querySelector('#sa-type').value.trim(),
    };
    msg.className = ''; msg.textContent = 'Submitting…';
    try {
      const res = await fetch('/api/antennas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) { msg.className = 'sa-err'; msg.textContent = data.error || 'Submission rejected.'; return; }
      msg.className = 'sa-ok'; msg.textContent = '✓ Added to the shared library!';
      await loadCatalog();
      setTimeout(() => div.remove(), 1200);
    } catch {
      msg.className = 'sa-err'; msg.textContent = 'Library service unreachable (dev mode?). Try on the live site.';
    }
  });
}

// ---------- Profile chart ----------
const panel = document.getElementById('profile-panel');
const canvas = document.getElementById('profile-canvas');
document.getElementById('profile-close').addEventListener('click', hideProfile);

function hideProfile() { panel.classList.add('hidden'); selectedLink = null; }

function showProfile(link) {
  if (!link.profile) return;
  selectedLink = link;
  panel.classList.remove('hidden');
  document.getElementById('profile-title').textContent = `${link.a.label} ⟷ ${link.b.label}`;
  const best = link.result?.best;
  document.getElementById('profile-stats').textContent =
    `${(link.distM / 1000).toFixed(2)} km @ ${link.freqMhz} MHz / ${link.bwMhz} MHz · FSPL ${link.result?.fspl.toFixed(1)} dB · diffraction ${link.pathAnalysis?.diffractionLossDb.toFixed(1)} dB · ${best ? `MCS${best.mcs} ${best.mbps.toFixed(0)} Mbps, margin +${best.margin.toFixed(0)} dB` : 'NO LINK'}`;
  requestAnimationFrame(() => drawProfile(link));
}

function drawProfile(link, targetCanvas = canvas, fixedSize = null) {
  const dpr = fixedSize ? 1 : (window.devicePixelRatio || 1);
  const w = fixedSize ? fixedSize.w : targetCanvas.clientWidth;
  const h = fixedSize ? fixedSize.h : targetCanvas.clientHeight;
  targetCanvas.width = w * dpr; targetCanvas.height = h * dpr;
  const ctx = targetCanvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (fixedSize) { ctx.fillStyle = '#101418'; ctx.fillRect(0, 0, w, h); }

  const prof = link.profile;
  const D = link.distM;
  const lambda = 299.792458 / link.freqMhz;
  const elevA = prof[0].elevM + link.a.heightM;
  const elevB = prof[prof.length - 1].elevM + link.b.heightM;
  const R_EFF = 6371008.8 * (4 / 3);

  // vertical extent: terrain + ray + fresnel
  let minE = Infinity, maxE = -Infinity;
  const rows = prof.map((p) => {
    const d1 = p.distM, d2 = D - d1;
    const bulge = (d1 * d2) / (2 * R_EFF);
    const ray = elevA + ((elevB - elevA) * d1) / D;
    const f1 = D > 0 ? Math.sqrt((lambda * d1 * d2) / Math.max(D, 1)) : 0;
    const terr = p.elevM + bulge;
    minE = Math.min(minE, terr, ray - f1);
    maxE = Math.max(maxE, terr, ray + f1);
    return { d: d1, terr, ray, f1 };
  });
  const pad = Math.max((maxE - minE) * 0.12, 8);
  minE -= pad; maxE += pad;

  const X = (d) => 46 + (d / D) * (w - 60);
  const Y = (e) => h - 22 - ((e - minE) / (maxE - minE)) * (h - 34);

  // Fresnel ellipse (60% zone shaded darker)
  ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(X(r.d), Y(r.ray - r.f1)) : ctx.moveTo(X(r.d), Y(r.ray - r.f1))));
  for (let i = rows.length - 1; i >= 0; i--) ctx.lineTo(X(rows[i].d), Y(rows[i].ray + rows[i].f1));
  ctx.closePath();
  ctx.fillStyle = 'rgba(28,126,214,0.15)';
  ctx.fill();

  // LOS ray
  ctx.beginPath();
  ctx.moveTo(X(0), Y(rows[0].ray));
  ctx.lineTo(X(D), Y(rows[rows.length - 1].ray));
  ctx.strokeStyle = '#74c0fc';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // Terrain fill
  ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(X(r.d), Y(r.terr)) : ctx.moveTo(X(r.d), Y(r.terr))));
  ctx.lineTo(X(D), h - 22); ctx.lineTo(X(0), h - 22);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#4a5d43'); grad.addColorStop(1, '#2b3a28');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.strokeStyle = '#8ba888';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Worst obstruction marker
  const worst = link.pathAnalysis?.worst;
  if (worst && link.pathAnalysis.fresnelIntruded) {
    ctx.beginPath();
    ctx.arc(X(worst.distM), Y(worst.elevM + worst.bulge), 5, 0, Math.PI * 2);
    ctx.fillStyle = link.pathAnalysis.losBlocked ? '#e03131' : '#f08c00';
    ctx.fill();
  }

  // Node towers
  for (const [p0, node] of [[rows[0], link.a], [rows[rows.length - 1], link.b]]) {
    const x = X(p0.d);
    ctx.beginPath();
    ctx.moveTo(x, Y(p0.terr - (p0 === rows[0] ? 0 : 0)));
    ctx.moveTo(x, Y(p0.ray - node.heightM + node.heightM)); // top
    ctx.lineTo(x, Y(p0.ray) + (Y(p0.terr) - Y(p0.ray)));
    ctx.strokeStyle = '#ffd43b';
    ctx.lineWidth = 2.5;
    ctx.moveTo(x, Y(p0.ray));
    ctx.lineTo(x, Y(p0.ray - 0) + (Y(p0.terr) - Y(p0.ray)));
    ctx.stroke();
    ctx.fillStyle = '#ffd43b';
    ctx.beginPath();
    ctx.arc(x, Y(p0.ray), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Axes labels
  ctx.fillStyle = '#91a7c0';
  ctx.font = '11px system-ui';
  ctx.fillText(`${Math.round(maxE - pad)} m`, 4, 14);
  ctx.fillText(`${Math.round(minE + pad)} m`, 4, h - 26);
  ctx.fillText('0 km', 46, h - 8);
  ctx.fillText(`${(D / 1000).toFixed(1)} km`, w - 54, h - 8);
}

window.addEventListener('resize', () => selectedLink && drawProfile(selectedLink));

// Dev/test hook
window.__app = {
  map, RADIOS,
  get nodes() { return nodes; },
  get links() { return links; },
  addNodeAt: (lng, lat) => { addNode({ lng, lat }); return nodes[nodes.length - 1]; },
  linkNodes: (idA, idB) => {
    const a = nodes.find((n) => n.id === idA), b = nodes.find((n) => n.id === idB);
    links.push({ id: `${a.id}-${b.id}`, a, b, result: null, pathAnalysis: null, profile: null });
    return recomputeAllLinks();
  },
  recompute: () => recomputeAllLinks(),
  runCoverage: (id) => runCoverage(nodes.find((n) => n.id === id)),
  runMeshCoverage,
  clearCoverage,
  simulateCoverage,
  openCovPanel,
  QUALITY,
  get coverage() { return coverage; },
};
