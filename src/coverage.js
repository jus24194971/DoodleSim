// Coverage rasters built on the cached ray engine (src/rays.js).
//
//   computeCoverage()     — single node, one metric, one remote mode
//   computeMeshCoverage() — all nodes merged, redundancy tiers
//   computeMinAltitude()  — lowest altitude that closes the link (UAS planning)
//
// Terrain sampling is cached per node geometry, so changing altitude, remote
// mode or display metric re-renders without touching the network or the DEM.

import { txPowerDbm, sensitivityDbm, throughputMbps } from './engine.js';
import { sampleRays, evaluateRays, minAltitudeRays, QUALITY } from './rays.js';

export { QUALITY };

// Max distance worth computing: solve FSPL for the weakest usable budget (MCS0) + slack
export function autoRadiusM(node, radio, remoteGain, fadeMargin, noiseFloorDbm) {
  const tx = txPowerDbm(radio, node.powerDbm, 0, radio.chains === 1 ? 1 : 2);
  const budget = tx + node.antennaGain + remoteGain - node.cableLoss + node.bdaGain - fadeMargin - sensitivityDbm(0, node.bwMhz, noiseFloorDbm);
  const dKm = 10 ** ((budget - 32.45 - 20 * Math.log10(node.freqMhz)) / 20);
  return Math.min(Math.max(dKm * 1000 * 1.1, 2000), 80000);
}

// ---------------------------------------------------------------------------
// Colour ramps
// ---------------------------------------------------------------------------

// Data-rate ramp (best usable MCS)
export function colorForMcs(mcs) {
  if (mcs >= 14) return [26, 135, 60];   // deep green
  if (mcs >= 12) return [77, 171, 61];
  if (mcs >= 10) return [163, 199, 62];
  if (mcs >= 8) return [240, 189, 43];   // yellow
  if (mcs >= 4) return [237, 129, 33];   // orange
  if (mcs >= 0) return [224, 64, 39];    // red — only slowest rates
  return null;
}

// Received level (dBm) — absolute signal strength
export function colorForRssi(dbm) {
  if (!Number.isFinite(dbm)) return null;
  if (dbm >= -55) return [26, 135, 60];
  if (dbm >= -65) return [77, 171, 61];
  if (dbm >= -75) return [163, 199, 62];
  if (dbm >= -82) return [240, 189, 43];
  if (dbm >= -88) return [237, 129, 33];
  if (dbm >= -95) return [224, 64, 39];
  return [120, 20, 20];
}

// Terrain penalty: loss in excess of free space. This is the "what is the
// terrain costing me" view — 0 dB means an unobstructed path.
export function colorForExcessLoss(db) {
  if (!Number.isFinite(db)) return null;
  if (db < 1) return [24, 132, 92];      // clear
  if (db < 6) return [120, 190, 90];
  if (db < 12) return [240, 200, 60];
  if (db < 20) return [240, 140, 50];
  if (db < 30) return [214, 74, 44];
  return [124, 30, 40];                  // deep shadow
}

// Link margin above the required sensitivity
export function colorForMargin(db) {
  if (!Number.isFinite(db)) return null;
  if (db >= 30) return [26, 135, 60];
  if (db >= 20) return [77, 171, 61];
  if (db >= 15) return [163, 199, 62];
  if (db >= 10) return [240, 189, 43];
  if (db >= 5) return [237, 129, 33];
  if (db >= 0) return [224, 64, 39];
  return null;                           // below sensitivity: no link
}

// Lowest altitude that closes the link (UAS planning)
export function colorForAltitude(m) {
  if (!Number.isFinite(m)) return null;
  if (m <= 30) return [26, 135, 60];     // works low — easy
  if (m <= 60) return [120, 190, 90];
  if (m <= 120) return [240, 200, 60];   // 120 m ~ the common 400 ft ceiling
  if (m <= 200) return [240, 140, 50];
  if (m <= 400) return [214, 74, 44];
  return [124, 30, 40];                  // needs to be very high
}

const BELOW_TERRAIN_COLOR = [70, 70, 78]; // flight level is inside the ground here

export const METRICS = {
  mcs: { label: 'Data rate (MCS)', color: colorForMcs, field: 'bestMcs', alpha: 165 },
  rssi: { label: 'Signal level (dBm)', color: colorForRssi, field: 'rssiDbm', alpha: 165 },
  excess: { label: 'Terrain loss vs free space (dB)', color: colorForExcessLoss, field: 'excessLossDb', alpha: 175 },
  margin: { label: 'Link margin (dB)', color: colorForMargin, field: 'marginDb', alpha: 165 },
};

// ---------------------------------------------------------------------------
// Rasterisation
// ---------------------------------------------------------------------------

function boundsFor(origin, radiusM) {
  const degPerMLat = 1 / 111320;
  const degPerMLng = 1 / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  return [
    [origin.lng - radiusM * degPerMLng, origin.lat + radiusM * degPerMLat],
    [origin.lng + radiusM * degPerMLng, origin.lat + radiusM * degPerMLat],
    [origin.lng + radiusM * degPerMLng, origin.lat - radiusM * degPerMLat],
    [origin.lng - radiusM * degPerMLng, origin.lat - radiusM * degPerMLat],
  ];
}

// Paint a polar dataset centred on its own origin into a square canvas.
function rasterizePolar(geom, valueAt, colorFn, opts = {}) {
  const { azimuths, steps, radiusM } = geom;
  const SIZE = opts.size || 640;
  const alpha = opts.alpha ?? 165;
  const canvas = opts.canvas || document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  for (let py = 0; py < SIZE; py++) {
    const dy = (0.5 - (py + 0.5) / SIZE) * 2 * radiusM;
    for (let px = 0; px < SIZE; px++) {
      const dx = ((px + 0.5) / SIZE - 0.5) * 2 * radiusM;
      const dist = Math.hypot(dx, dy);
      if (dist > radiusM || dist < 1) continue;
      let az = (Math.atan2(dx, dy) * 180) / Math.PI;
      if (az < 0) az += 360;
      const ai = Math.round((az / 360) * azimuths) % azimuths;
      const si = Math.min(steps - 1, Math.max(0, Math.round((dist / radiusM) * steps) - 1));
      const idx = ai * steps + si;
      const c = colorFn(valueAt(idx), idx);
      if (!c) continue;
      const o = (py * SIZE + px) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      img.data[o + 3] = c[3] ?? alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Coverage statistics over a polar dataset, area-weighted by annulus.
function polarStats(geom, predicate) {
  const { azimuths, steps, radiusM } = geom;
  const cellR = radiusM / steps;
  let served = 0, total = 0;
  for (let a = 0; a < azimuths; a++) {
    for (let s = 0; s < steps; s++) {
      // annulus area share grows with radius
      const r1 = s * cellR, r2 = (s + 1) * cellR;
      const w = (r2 * r2 - r1 * r1);
      total += w;
      if (predicate(a * steps + s)) served += w;
    }
  }
  const areaKm2 = (Math.PI * radiusM * radiusM) / 1e6;
  return { servedKm2: (served / total) * areaKm2, totalKm2: areaKm2, servedPct: (100 * served) / total };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Single-node coverage raster.
 * opts: { remoteMode, remoteAltM, remoteGainDbi, fadeMargin, metric, nearGround,
 *         txPattern, quality, radiusM }
 */
export async function computeCoverage(node, radio, opts, onProgress) {
  const {
    remoteGainDbi, fadeMargin = 10, txPattern = null,
    remoteMode = 'agl', remoteAltM = opts.remoteHeightM ?? 2,
    metric = 'mcs', nearGround = false, quality = QUALITY.normal,
  } = opts;
  const origin = node.marker.getLngLat();
  const radiusM = opts.radiusM || autoRadiusM(node, radio, remoteGainDbi, fadeMargin, opts.noiseFloorDbm);

  const rays = await sampleRays(origin, radiusM, quality, (p) => onProgress && onProgress(p * 0.85));
  const ev = evaluateRays(rays, {
    elevTxAsl: rays.baseElev + node.heightM,
    freqMhz: node.freqMhz, bwMhz: node.bwMhz, radio, powerDbm: node.powerDbm,
    txGainDbi: node.antennaGain, remoteGainDbi, cableLossDb: node.cableLoss, bdaGainDb: node.bdaGain,
    txPattern, fadeMarginDb: fadeMargin, remoteMode, remoteAltM, nearGround,
    derate: opts.derate ?? 0,
    noiseFloorDbm: opts.noiseFloorDbm,
  });

  const geom = { azimuths: rays.azimuths, steps: rays.steps, radiusM };
  const m = METRICS[metric] || METRICS.mcs;
  const arr = ev[m.field];
  const canvas = rasterizePolar(geom, (i) => arr[i], (v, i) => {
    if (ev.belowTerrain[i]) return [...BELOW_TERRAIN_COLOR, 150];
    if (ev.bestMcs[i] < 0 && metric !== 'excess') return null; // no link: leave clear
    return m.color(v);
  }, { alpha: m.alpha });

  const stats = polarStats(geom, (i) => ev.bestMcs[i] >= 0);
  if (onProgress) onProgress(1);
  return { canvas, bounds: boundsFor(origin, radiusM), radiusM, rays, ev, stats, geom, baseElevM: rays.baseElev };
}

/**
 * Lowest altitude at which the link closes, as a raster (UAS mission planning).
 */
export async function computeMinAltitude(node, radio, opts, onProgress) {
  const { remoteGainDbi, fadeMargin = 10, txPattern = null, minMbps = 0,
          nearGround = false, quality = QUALITY.normal } = opts;
  const origin = node.marker.getLngLat();
  const radiusM = opts.radiusM || autoRadiusM(node, radio, remoteGainDbi, fadeMargin, opts.noiseFloorDbm);
  const rays = await sampleRays(origin, radiusM, quality, (p) => onProgress && onProgress(p * 0.6));

  const params = {
    elevTxAsl: rays.baseElev + node.heightM,
    freqMhz: node.freqMhz, bwMhz: node.bwMhz, radio, powerDbm: node.powerDbm,
    txGainDbi: node.antennaGain, remoteGainDbi, cableLossDb: node.cableLoss, bdaGainDb: node.bdaGain,
    txPattern, fadeMarginDb: fadeMargin, nearGround, derate: opts.derate ?? 0,
  };
  const res = minAltitudeRays(rays, params, { minMbps });
  const geom = { azimuths: rays.azimuths, steps: rays.steps, radiusM };
  const canvas = rasterizePolar(geom, (i) => res.minAlt[i], (v) => colorForAltitude(v), { alpha: 175 });

  let breaks = 0, reachable = 0;
  for (let i = 0; i < res.minAlt.length; i++) {
    if (Number.isFinite(res.minAlt[i])) reachable++;
    if (res.ceilingBreak[i]) breaks++;
  }
  if (onProgress) onProgress(1);
  return {
    canvas, bounds: boundsFor(origin, radiusM), radiusM, res, geom,
    stats: { reachablePct: (100 * reachable) / res.minAlt.length, ceilingBreakPct: (100 * breaks) / res.minAlt.length },
    baseElevM: rays.baseElev,
  };
}

/**
 * Mesh-aware minimum altitude: for every point, the lowest altitude at which
 * ANY node in the mesh closes the link. This is the UAS mission-planning view of
 * a whole ground network.
 */
export async function computeMeshMinAltitude(entries, opts, onProgress) {
  const { remoteGainDbi, fadeMargin = 10, minMbps = 0, nearGround = false, quality = QUALITY.normal } = opts;
  const datasets = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const origin = e.node.marker.getLngLat();
    const radiusM = opts.radiusM || autoRadiusM(e.node, e.radio, remoteGainDbi, fadeMargin, e.noiseFloorDbm);
    const rays = await sampleRays(origin, radiusM, quality,
      (p) => onProgress && onProgress((i + p) / entries.length));
    const res = minAltitudeRays(rays, {
      elevTxAsl: rays.baseElev + e.node.heightM,
      freqMhz: e.node.freqMhz, bwMhz: e.node.bwMhz, radio: e.radio, powerDbm: e.node.powerDbm,
      txGainDbi: e.node.antennaGain, remoteGainDbi, cableLossDb: e.node.cableLoss,
      bdaGainDb: e.node.bdaGain, txPattern: e.txPattern, fadeMarginDb: fadeMargin, nearGround,
      derate: opts.derate ?? 0,
      noiseFloorDbm: e.noiseFloorDbm,
    }, { minMbps });
    datasets.push({ origin, radiusM, azimuths: rays.azimuths, steps: rays.steps, res });
  }

  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const pd of datasets) {
    const degPerMLat = 1 / 111320;
    const degPerMLng = 1 / (111320 * Math.cos((pd.origin.lat * Math.PI) / 180));
    minLng = Math.min(minLng, pd.origin.lng - pd.radiusM * degPerMLng);
    maxLng = Math.max(maxLng, pd.origin.lng + pd.radiusM * degPerMLng);
    minLat = Math.min(minLat, pd.origin.lat - pd.radiusM * degPerMLat);
    maxLat = Math.max(maxLat, pd.origin.lat + pd.radiusM * degPerMLat);
  }

  const SIZE = 800;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  let reachable = 0, breaks = 0, painted = 0;
  for (let py = 0; py < SIZE; py++) {
    const lat = maxLat - ((py + 0.5) / SIZE) * (maxLat - minLat);
    for (let px = 0; px < SIZE; px++) {
      const lng = minLng + ((px + 0.5) / SIZE) * (maxLng - minLng);
      let best = NaN, anyBreak = false, inRange = false;
      for (const pd of datasets) {
        const idx = polarIndexAt(pd, lng, lat);
        if (idx < 0) continue;
        inRange = true;
        const v = pd.res.minAlt[idx];
        if (Number.isFinite(v) && (Number.isNaN(best) || v < best)) best = v;
        if (pd.res.ceilingBreak[idx]) anyBreak = true;
      }
      if (!inRange) continue;
      painted++;
      if (Number.isFinite(best)) reachable++;
      if (anyBreak) breaks++;
      const c = colorForAltitude(best);
      if (!c) continue;
      const o = (py * SIZE + px) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 175;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (onProgress) onProgress(1);
  return {
    canvas,
    bounds: [[minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat]],
    stats: {
      reachablePct: painted ? (100 * reachable) / painted : 0,
      ceilingBreakPct: painted ? (100 * breaks) / painted : 0,
      nodeCount: entries.length, mode: 'agl',
    },
  };
}


/**
 * Lowest constant flight level (ASL) that achieves `targetFraction` of the best
 * coverage obtainable within the sweep. Answers "how high do we need to fly?"
 * for a whole ground network. Cheap because terrain rays are cached.
 */
export async function findLowestFlightLevel(entries, opts, onProgress) {
  const { remoteGainDbi, fadeMargin = 10, nearGround = false, quality = QUALITY.coarse,
          targetFraction = 0.9, steps: sweepSteps = 12 } = opts;

  // sample every node once, then re-evaluate at each candidate altitude
  const prepared = [];
  let terrainMin = Infinity, terrainMax = -Infinity;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const origin = e.node.marker.getLngLat();
    const radiusM = opts.radiusM || autoRadiusM(e.node, e.radio, remoteGainDbi, fadeMargin, e.noiseFloorDbm);
    const rays = await sampleRays(origin, radiusM, quality,
      (p) => onProgress && onProgress(0.5 * (i + p) / entries.length));
    for (let k = 0; k < rays.elevs.length; k++) {
      const v = rays.elevs[k];
      if (v < terrainMin) terrainMin = v;
      if (v > terrainMax) terrainMax = v;
    }
    prepared.push({ e, rays, radiusM,
      params: {
        elevTxAsl: rays.baseElev + e.node.heightM,
        freqMhz: e.node.freqMhz, bwMhz: e.node.bwMhz, radio: e.radio, powerDbm: e.node.powerDbm,
        txGainDbi: e.node.antennaGain, remoteGainDbi, cableLossDb: e.node.cableLoss,
        bdaGainDb: e.node.bdaGain, txPattern: e.txPattern, fadeMarginDb: fadeMargin, nearGround,
      derate: opts.derate ?? 0,
      noiseFloorDbm: e.noiseFloorDbm,
      } });
  }

  const lo = Math.floor(terrainMin / 10) * 10;
  const hi = Math.ceil((terrainMax + 900) / 10) * 10;
  const candidates = [];
  for (let i = 0; i < sweepSteps; i++) candidates.push(Math.round((lo + ((hi - lo) * i) / (sweepSteps - 1)) / 10) * 10);

  const scored = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    const alt = candidates[ci];
    let served = 0, total = 0;
    for (const pr of prepared) {
      const ev = evaluateRays(pr.rays, { ...pr.params, remoteMode: 'asl', remoteAltM: alt });
      // area-weight each polar cell by its annulus share
      const cellR = pr.radiusM / pr.rays.steps;
      for (let a = 0; a < pr.rays.azimuths; a++) {
        for (let s2 = 0; s2 < pr.rays.steps; s2++) {
          const r1 = s2 * cellR, r2 = (s2 + 1) * cellR;
          const w = r2 * r2 - r1 * r1;
          total += w;
          if (ev.bestMcs[a * pr.rays.steps + s2] >= 0) served += w;
        }
      }
    }
    scored.push({ altM: alt, servedFraction: total ? served / total : 0 });
    if (onProgress) onProgress(0.5 + 0.5 * ((ci + 1) / candidates.length));
  }

  const bestFraction = Math.max(...scored.map((x) => x.servedFraction));
  const target = bestFraction * targetFraction;
  const chosen = scored.find((x) => x.servedFraction >= target) || scored[scored.length - 1];
  if (onProgress) onProgress(1);
  return { chosen, scored, terrainMin, terrainMax, bestFraction, targetFraction };
}

// Sample a polar dataset at an absolute lng/lat. Returns the cell index or -1.
function polarIndexAt(pd, lng, lat) {
  const degPerMLat = 1 / 111320;
  const degPerMLng = 1 / (111320 * Math.cos((pd.origin.lat * Math.PI) / 180));
  const dx = (lng - pd.origin.lng) / degPerMLng;
  const dy = (lat - pd.origin.lat) / degPerMLat;
  const dist = Math.hypot(dx, dy);
  if (dist > pd.radiusM || dist < 1) return -1;
  let az = (Math.atan2(dx, dy) * 180) / Math.PI;
  if (az < 0) az += 360;
  const ai = Math.round((az / 360) * pd.azimuths) % pd.azimuths;
  const si = Math.min(pd.steps - 1, Math.max(0, Math.round((dist / pd.radiusM) * pd.steps) - 1));
  return ai * pd.steps + si;
}

/**
 * Multi-node mesh coverage on one shared raster, coloured by redundancy tier.
 * Overlap counts only among same-band nodes (different bands do not mesh).
 * entries: [{ node, radio, txPattern, bandId }]
 */
export async function computeMeshCoverage(entries, opts, onProgress) {
  const {
    remoteGainDbi, fadeMargin = 10, remoteMode = 'agl',
    remoteAltM = opts.remoteHeightM ?? 2, nearGround = false, quality = QUALITY.normal,
    metric = 'mcs',
  } = opts;

  const datasets = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const origin = e.node.marker.getLngLat();
    const radiusM = opts.radiusM || autoRadiusM(e.node, e.radio, remoteGainDbi, fadeMargin, e.noiseFloorDbm);
    const rays = await sampleRays(origin, radiusM, quality,
      (p) => onProgress && onProgress((i + p) / entries.length));
    const ev = evaluateRays(rays, {
      elevTxAsl: rays.baseElev + e.node.heightM,
      freqMhz: e.node.freqMhz, bwMhz: e.node.bwMhz, radio: e.radio, powerDbm: e.node.powerDbm,
      txGainDbi: e.node.antennaGain, remoteGainDbi, cableLossDb: e.node.cableLoss,
      bdaGainDb: e.node.bdaGain, txPattern: e.txPattern, fadeMarginDb: fadeMargin, derate: opts.derate ?? 0,
      remoteMode, remoteAltM, nearGround,
    });
    datasets.push({
      origin, radiusM, azimuths: rays.azimuths, steps: rays.steps,
      bandId: e.bandId, label: e.node.label, ev,
    });
  }

  // union bbox
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const pd of datasets) {
    const degPerMLat = 1 / 111320;
    const degPerMLng = 1 / (111320 * Math.cos((pd.origin.lat * Math.PI) / 180));
    minLng = Math.min(minLng, pd.origin.lng - pd.radiusM * degPerMLng);
    maxLng = Math.max(maxLng, pd.origin.lng + pd.radiusM * degPerMLng);
    minLat = Math.min(minLat, pd.origin.lat - pd.radiusM * degPerMLat);
    maxLat = Math.max(maxLat, pd.origin.lat + pd.radiusM * degPerMLat);
  }

  const SIZE = 800;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const counts = { t1: 0, t2: 0, t3: 0, below: 0 };
  const midLat = (minLat + maxLat) / 2;
  const pxAreaM2 = ((maxLng - minLng) * 111320 * Math.cos((midLat * Math.PI) / 180) / SIZE)
                 * ((maxLat - minLat) * 111320 / SIZE);

  for (let py = 0; py < SIZE; py++) {
    const lat = maxLat - ((py + 0.5) / SIZE) * (maxLat - minLat);
    for (let px = 0; px < SIZE; px++) {
      const lng = minLng + ((px + 0.5) / SIZE) * (maxLng - minLng);
      const perBand = new Map();
      let maxMcs = -1, anyBelow = false, bestPd = null, bestIdx = -1, bestRssi = -Infinity;
      for (const pd of datasets) {
        const idx = polarIndexAt(pd, lng, lat);
        if (idx < 0) continue;
        if (pd.ev.belowTerrain[idx]) { anyBelow = true; continue; }
        const m = pd.ev.bestMcs[idx];
        // best-serving node: highest usable rate, ties broken on received level
        const r = pd.ev.rssiDbm[idx];
        if (m > maxMcs || (m === maxMcs && r > bestRssi)) { bestPd = pd; bestIdx = idx; bestRssi = r; }
        if (m >= 0) {
          perBand.set(pd.bandId, (perBand.get(pd.bandId) || 0) + 1);
          if (m > maxMcs) maxMcs = m;
        }
      }
      let c, alpha;
      if (maxMcs < 0) {
        // no usable link: only paint the "inside terrain" case, or the loss field
        if (metric === 'excess' && bestPd) {
          c = METRICS.excess.color(bestPd.ev.excessLossDb[bestIdx]); alpha = 175;
          if (!c) continue;
        } else if (anyBelow) {
          c = BELOW_TERRAIN_COLOR; alpha = 150; counts.below++;
        } else continue;
      } else if (metric === 'mcs') {
        const redundancy = Math.max(...perBand.values());
        if (redundancy >= 3) { c = [123, 44, 191]; alpha = 205; counts.t3++; }
        else if (redundancy === 2) { c = [16, 110, 190]; alpha = 185; counts.t2++; }
        else { c = colorForMcs(maxMcs); alpha = 135; counts.t1++; }
      } else {
        // best-server view of a continuous metric across the mesh
        const m = METRICS[metric] || METRICS.mcs;
        c = m.color(bestPd.ev[m.field][bestIdx]); alpha = m.alpha;
        if (!c) continue;
        const redundancy = Math.max(...perBand.values());
        if (redundancy >= 3) counts.t3++; else if (redundancy === 2) counts.t2++; else counts.t1++;
      }
      const o = (py * SIZE + px) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (onProgress) onProgress(1);
  return {
    canvas,
    bounds: [[minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat]],
    datasets,
    stats: {
      singleKm2: (counts.t1 * pxAreaM2) / 1e6,
      redundantKm2: (counts.t2 * pxAreaM2) / 1e6,
      extremeKm2: (counts.t3 * pxAreaM2) / 1e6,
      belowTerrainKm2: (counts.below * pxAreaM2) / 1e6,
      nodeCount: entries.length,
      remoteMode, remoteAltM, metric,
    },
  };
}
