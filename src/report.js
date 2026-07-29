// Design report generator: a self-contained HTML deliverable summarizing the
// network design — equipment, placement, terrain analysis per link, minimum
// UAV altitudes — suitable for sending to a customer.

import { RADIOS, BANDS, CABLES, PLATFORMS } from './radios.js';
import { analyzePath } from './engine.js';

// Minimum height AGL at `node` for its links to clear 60% of the first Fresnel
// zone (terrain permitting). Uses the already-fetched profiles — no refetch.
export function minClearHeight(link, whichEnd) {
  if (!link.profile) return null;
  const other = whichEnd === 'a' ? link.b : link.a;
  for (let h = 2; h <= 1000; h = h < 30 ? h + 2 : h + 10) {
    const hA = whichEnd === 'a' ? h : link.a.heightM;
    const hB = whichEnd === 'b' ? h : link.b.heightM;
    const pa = analyzePath(link.profile, hA, hB, link.freqMhz || link.a.freqMhz);
    if (!pa.fresnelIntruded) return h;
  }
  return null;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function buildReportHtml({ nodes, links, renderProfilePng, mapImagePng, missionNote, meshStats, meshRemote }) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const nodeRows = nodes.map((n) => {
    const radio = RADIOS.find((r) => r.id === n.radioId);
    const { lng, lat } = n.marker.getLngLat();
    const ant = n.antennaId ? `${n._antName || ''}` : `Custom ${n.antennaGain} dBi`;
    const cable = n.cableType && n.cableType !== 'manual' && n.cableType !== 'none'
      ? `${CABLES[n.cableType].label.split(' ')[0]}, ${n.cableLenM} m (${(+n.cableLoss).toFixed(1)} dB)`
      : `${(+n.cableLoss).toFixed(1)} dB`;
    return `<tr>
      <td><b>${esc(n.label)}</b><br/><span class="dim">${esc(PLATFORMS.find((p) => p.id === n.platform)?.label || n.platform)}</span></td>
      <td>${lat.toFixed(5)}, ${lng.toFixed(5)}<br/><span class="dim">${n.groundElevM != null ? `ground ${n.groundElevM.toFixed(0)} m ASL · antenna +${n.heightM} m AGL (${(n.groundElevM + n.heightM).toFixed(0)} m ASL)` : `${n.heightM} m AGL`}</span></td>
      <td>${esc(radio?.name)}<br/><span class="dim">${n.freqMhz} MHz · ${n.bwMhz} MHz ch · ${n.powerDbm} dBm</span></td>
      <td>${esc(ant)}${n.azimuthDeg && n.antennaId !== null ? `<br/><span class="dim">aimed ${n.azimuthDeg}°${n.tiltDeg ? `, tilt ${n.tiltDeg}°` : ''}</span>` : ''}</td>
      <td>${cable}${n.bdaGain ? `<br/><span class="dim">BDA +${n.bdaGain} dB</span>` : ''}</td>
    </tr>`;
  }).join('');

  const linkSections = links.map((l) => {
    const best = l.result?.best;
    const pa = l.pathAnalysis;
    const status = !pa ? '—' : pa.losBlocked ? '⛔ TERRAIN BLOCKED' : pa.fresnelIntruded ? '⚠ Fresnel intrusion — expect degradation' : '✓ Clear line of sight';
    const uavNotes = [];
    for (const [end, node] of [['a', l.a], ['b', l.b]]) {
      if (node.platform === 'uav') {
        const minH = minClearHeight(l, end);
        uavNotes.push(minH !== null
          ? `<b>Minimum ${esc(node.label)} altitude:</b> ${minH} m AGL for a clear 60% Fresnel path (currently planned at ${node.heightM} m).`
          : `<b>${esc(node.label)}:</b> no altitude up to 1000 m AGL fully clears this path — plan around the obstruction.`);
      }
    }
    const png = renderProfilePng ? renderProfilePng(l) : null;
    return `<div class="link">
      <h3>${esc(l.a.label)} ⟷ ${esc(l.b.label)} — ${(l.distM / 1000).toFixed(2)} km</h3>
      <table class="stats"><tr>
        <td>Path<br/><b>${status}</b></td>
        <td>Free-space loss<br/><b>${l.result ? l.result.fspl.toFixed(1) + ' dB' : '—'}</b></td>
        <td>Diffraction<br/><b>${pa ? pa.diffractionLossDb.toFixed(1) + ' dB' : '—'}</b></td>
        <td>Expected link<br/><b>${best ? `MCS${best.mcs} · ${best.mbps.toFixed(1)} Mbps` : 'DOES NOT CLOSE'}</b></td>
        <td>RSSI / margin<br/><b>${best ? `${best.rssi.toFixed(0)} dBm · +${best.margin.toFixed(0)} dB` : '—'}</b></td>
      </tr></table>
      ${uavNotes.length ? `<p class="uav-note">${uavNotes.join('<br/>')}</p>` : ''}
      ${png ? `<img class="profile" src="${png}" alt="terrain profile"/>` : ''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>RF Network Design — Doodle Labs Mesh Rider</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #212529; max-width: 900px; margin: 24px auto; padding: 0 16px; }
  header { border-bottom: 3px solid #1c7ed6; padding-bottom: 10px; margin-bottom: 18px; }
  h1 { font-size: 22px; margin: 0 0 2px; } h2 { font-size: 16px; margin: 24px 0 8px; border-bottom: 1px solid #dee2e6; padding-bottom: 4px; }
  h3 { font-size: 14px; margin: 0 0 8px; }
  .sub { color: #868e96; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e9ecef; vertical-align: top; }
  th { background: #f1f3f5; }
  .dim { color: #868e96; font-size: 11.5px; }
  .link { margin: 14px 0 22px; page-break-inside: avoid; }
  .stats td { background: #f8f9fa; border: 1px solid #e9ecef; font-size: 11.5px; color: #495057; }
  .stats b { font-size: 13px; color: #212529; }
  .uav-note { background: #e7f5ff; border-left: 3px solid #1c7ed6; padding: 8px 10px; font-size: 12.5px; margin: 8px 0; }
  img.profile { width: 100%; border-radius: 6px; margin-top: 6px; }
  img.map { width: 100%; border-radius: 6px; margin: 8px 0; }
  .mission { background: #fff9db; border-left: 3px solid #f08c00; padding: 8px 10px; font-size: 13px; }
  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #dee2e6; font-size: 11px; color: #868e96; }
  @media print { body { margin: 8px; } }
</style></head>
<body>
<header>
  <h1>RF Network Design Summary</h1>
  <div class="sub">Doodle Labs Mesh Rider deployment plan · Generated ${date} · DoodleSim</div>
</header>
${missionNote ? `<div class="mission"><b>Objective:</b> ${esc(missionNote)}</div>` : ''}
${mapImagePng ? `<h2>Deployment Map</h2><img class="map" src="${mapImagePng}"/>` : ''}
<h2>Equipment &amp; Placement</h2>
<table><tr><th>Node</th><th>Location</th><th>Radio</th><th>Antenna</th><th>Cable / BDA</th></tr>${nodeRows}</table>
${meshStats ? `<h2>Mesh Coverage &amp; Redundancy</h2>
<p class="sub" style="margin-bottom:6px">Combined terrain-aware coverage of all ${meshStats.nodeCount} nodes, for a remote node at ${meshRemote?.h ?? '?'} m AGL with ${meshRemote?.g ?? '?'} dBi. Overlap counted between same-band nodes only (different bands do not mesh). The deployment map above shows the zones.</p>
<table><tr><th>Coverage tier</th><th>Meaning</th><th>Area</th></tr>
<tr><td><b style="color:#7b2cbf">■</b> Extreme (3+ radios)</td><td>A roaming node has three or more mesh peers — maximum resilience and roaming capacity</td><td><b>${meshStats.extremeKm2.toFixed(2)} km²</b></td></tr>
<tr><td><b style="color:#106ebe">■</b> Redundant (2 radios)</td><td>Two independent paths into the mesh — survives any single-node outage</td><td><b>${meshStats.redundantKm2.toFixed(2)} km²</b></td></tr>
<tr><td><b style="color:#78aa3c">■</b> Covered (1 radio)</td><td>Single-radio coverage, shaded by achievable data rate</td><td><b>${meshStats.singleKm2.toFixed(2)} km²</b></td></tr>
<tr><td>Total footprint</td><td></td><td><b>${(meshStats.singleKm2 + meshStats.redundantKm2 + meshStats.extremeKm2).toFixed(2)} km²</b></td></tr></table>` : ''}
<h2>Link Analysis</h2>
${linkSections || '<p class="sub">No links defined.</p>'}
<footer>
  Predictions follow the Doodle Labs official link-budget methodology (conservative per-MCS sensitivities, 10 dB fade margin)
  extended with terrain analysis: SRTM-derived elevation profiles, 4/3-earth curvature, 60% first-Fresnel-zone clearance criterion,
  and ITU-R P.526 knife-edge diffraction. Actual performance depends on site conditions, interference, and installation quality.
  Field-verify critical links before deployment.
</footer>
</body></html>`;
}
