// Coverage heatmap: ray-cast terrain-aware signal estimation around a node.
// For each azimuth we sample one elevation profile outward, then at every step
// evaluate the link budget to a hypothetical remote node (height + gain configurable),
// including cumulative worst-knife-edge diffraction along that ray.

import { elevationAt, destination } from './terrain.js';
import { txPowerDbm, sensitivityDbm, throughputMbps, patternLossDb, elevationAngleDeg, angDiff } from './engine.js';

const R_EARTH = 6371008.8;
const R_EFF = R_EARTH * (4 / 3);

// Max distance worth computing: solve FSPL for the weakest usable budget (MCS0) + slack
export function autoRadiusM(node, radio, remoteGain, fadeMargin) {
  const tx = txPowerDbm(radio, node.powerDbm, 0, radio.chains === 1 ? 1 : 2);
  const budget = tx + node.antennaGain + remoteGain - node.cableLoss + node.bdaGain - fadeMargin - sensitivityDbm(0, node.bwMhz);
  const dKm = 10 ** ((budget - 32.45 - 20 * Math.log10(node.freqMhz)) / 20);
  return Math.min(Math.max(dKm * 1000 * 1.1, 2000), 80000);
}

// MCS-indexed color ramp (throughput-oriented)
export function colorForMcs(mcs) {
  if (mcs >= 14) return [26, 135, 60];   // deep green
  if (mcs >= 12) return [77, 171, 61];
  if (mcs >= 10) return [163, 199, 62];
  if (mcs >= 8) return [240, 189, 43];   // yellow
  if (mcs >= 4) return [237, 129, 33];   // orange
  if (mcs >= 0) return [224, 64, 39];    // red — only slowest rates
  return null;
}

// Compute a node's polar coverage data (bestMcs per azimuth/step). Shared by
// single-node heatmaps and multi-node mesh overlap analysis.
export async function computePolar(node, radio, opts, onProgress) {
  const { remoteHeightM, remoteGainDbi, fadeMargin, azimuths = 180, steps = 120, txPattern = null } = opts;
  const origin = node.marker.getLngLat();
  const radiusM = opts.radiusM || autoRadiusM(node, radio, remoteGainDbi, fadeMargin);
  const antennas = radio.chains === 1 ? 1 : 2;
  const maxMcs = antennas === 2 ? 16 : 8;
  const lambda = 299.792458 / node.freqMhz;
  const baseElev = await elevationAt(origin.lng, origin.lat).catch(() => 0);
  const elevTx = baseElev + node.heightM;
  const polar = new Int8Array(azimuths * steps).fill(-1);

  for (let a = 0; a < azimuths; a++) {
    const bearing = (a * 360) / azimuths;
    const pts = [];
    for (let s = 1; s <= steps; s++) {
      const d = (s / steps) * radiusM;
      pts.push({ d, ...destination(origin.lng, origin.lat, bearing, d) });
    }
    const elevs = await Promise.all(pts.map((p) => elevationAt(p.lng, p.lat).catch(() => 0)));
    for (let s = 0; s < steps; s++) {
      const D = pts[s].d;
      const elevRx = elevs[s] + remoteHeightM;
      let worstV = -Infinity;
      for (let i = 0; i < s; i++) {
        const d1 = pts[i].d, d2 = D - d1;
        if (d2 <= 0) continue;
        const bulge = (d1 * d2) / (2 * R_EFF);
        const ray = elevTx + ((elevRx - elevTx) * d1) / D;
        const obstruction = elevs[i] + bulge - ray;
        const f1 = Math.sqrt((lambda * d1 * d2) / D);
        const v = (obstruction * Math.SQRT2) / f1;
        if (v > worstV) worstV = v;
      }
      let diffLoss = 0;
      if (worstV > -0.78) diffLoss = 6.9 + 20 * Math.log10(Math.sqrt((worstV - 0.1) ** 2 + 1) + worstV - 0.1);
      const fspl = 32.45 + 20 * Math.log10(Math.max(D, 1) / 1000) + 20 * Math.log10(node.freqMhz);
      let patLoss = 0;
      if (txPattern) {
        const elAngle = elevationAngleDeg(elevTx, elevRx, D);
        patLoss = patternLossDb({
          offAzDeg: angDiff(bearing, txPattern.azimuthDeg ?? 0),
          offElDeg: Math.abs(elAngle - (txPattern.tiltDeg ?? 0)),
          hpbwAz: txPattern.hpbwAz ?? 360,
          hpbwEl: txPattern.hpbwEl ?? 360,
        });
      }
      const gains = node.antennaGain - patLoss + remoteGainDbi - node.cableLoss + node.bdaGain;
      let best = -1;
      for (let mcs = maxMcs - 1; mcs >= 0; mcs--) {
        const tx = txPowerDbm(radio, node.powerDbm, mcs, antennas);
        const rssi = tx + gains - fspl - diffLoss;
        if (rssi - sensitivityDbm(mcs, node.bwMhz) >= fadeMargin) {
          if (best === -1 || throughputMbps(mcs, node.bwMhz) > throughputMbps(best, node.bwMhz)) best = mcs;
        }
      }
      polar[a * steps + s] = best;
    }
    if (onProgress && a % 10 === 0) onProgress(a / azimuths);
  }
  return { polar, origin, radiusM, azimuths, steps };
}

// Sample a polar dataset at an absolute lat/lng. Returns bestMcs or -1.
function samplePolar(pd, lng, lat) {
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
  return pd.polar[ai * pd.steps + si];
}

// Multi-node mesh coverage: shared raster colored by redundancy tier.
// Overlap counts only among nodes on the same band (different bands don't mesh).
export async function computeMeshCoverage(entries, opts, onProgress) {
  // entries: [{node, radio, txPattern, bandId}]
  const datasets = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const pd = await computePolar(e.node, e.radio, { ...opts, txPattern: e.txPattern },
      (p) => onProgress && onProgress((i + p) / entries.length));
    datasets.push({ ...pd, bandId: e.bandId });
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
  const stats = { tier1Px: 0, tier2Px: 0, tier3Px: 0 };
  const midLat = (minLat + maxLat) / 2;
  const pxAreaM2 = ((maxLng - minLng) * 111320 * Math.cos((midLat * Math.PI) / 180) / SIZE)
                 * ((maxLat - minLat) * 111320 / SIZE);
  for (let py = 0; py < SIZE; py++) {
    const lat = maxLat - ((py + 0.5) / SIZE) * (maxLat - minLat);
    for (let px = 0; px < SIZE; px++) {
      const lng = minLng + ((px + 0.5) / SIZE) * (maxLng - minLng);
      const perBand = new Map();
      let maxMcs = -1;
      for (const pd of datasets) {
        const m = samplePolar(pd, lng, lat);
        if (m >= 0) {
          perBand.set(pd.bandId, (perBand.get(pd.bandId) || 0) + 1);
          if (m > maxMcs) maxMcs = m;
        }
      }
      if (maxMcs < 0) continue;
      const redundancy = Math.max(...perBand.values());
      let c, alpha;
      if (redundancy >= 3) { c = [123, 44, 191]; alpha = 205; stats.tier3Px++; }        // extreme: purple
      else if (redundancy === 2) { c = [16, 110, 190]; alpha = 185; stats.tier2Px++; }   // redundant: deep blue
      else { c = colorForMcs(maxMcs); alpha = 135; stats.tier1Px++; }                    // single: MCS ramp, softer
      const o = (py * SIZE + px) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (onProgress) onProgress(1);
  return {
    canvas,
    bounds: [[minLng, maxLat], [maxLng, maxLat], [maxLng, minLat], [minLng, minLat]],
    stats: {
      singleKm2: (stats.tier1Px * pxAreaM2) / 1e6,
      redundantKm2: (stats.tier2Px * pxAreaM2) / 1e6,
      extremeKm2: (stats.tier3Px * pxAreaM2) / 1e6,
      nodeCount: entries.length,
    },
  };
}

export async function computeCoverage(node, radio, opts, onProgress) {
  const { remoteHeightM, remoteGainDbi, fadeMargin, azimuths = 180, steps = 120, txPattern = null } = opts;
  // txPattern: { azimuthDeg, tiltDeg, hpbwAz, hpbwEl } — null means isotropic-in-azimuth
  const origin = node.marker.getLngLat();
  const radiusM = opts.radiusM || autoRadiusM(node, radio, remoteGainDbi, fadeMargin);
  const antennas = radio.chains === 1 ? 1 : 2;
  const maxMcs = antennas === 2 ? 16 : 8;
  const lambda = 299.792458 / node.freqMhz;

  const baseElev = await elevationAt(origin.lng, origin.lat).catch(() => 0);
  const elevTx = baseElev + node.heightM;

  // result grid in polar form: bestMcs[az][step]
  const polar = new Int8Array(azimuths * steps).fill(-1);

  for (let a = 0; a < azimuths; a++) {
    const bearing = (a * 360) / azimuths;
    // sample elevations along the ray (parallel fetch per ray; tiles are cached)
    const pts = [];
    for (let s = 1; s <= steps; s++) {
      const d = (s / steps) * radiusM;
      pts.push({ d, ...destination(origin.lng, origin.lat, bearing, d) });
    }
    const elevs = await Promise.all(pts.map((p) => elevationAt(p.lng, p.lat).catch(() => 0)));

    for (let s = 0; s < steps; s++) {
      const D = pts[s].d;
      const elevRx = elevs[s] + remoteHeightM;
      // worst knife edge between TX and this receiver position
      let worstV = -Infinity;
      for (let i = 0; i < s; i++) {
        const d1 = pts[i].d, d2 = D - d1;
        if (d2 <= 0) continue;
        const bulge = (d1 * d2) / (2 * R_EFF);
        const ray = elevTx + ((elevRx - elevTx) * d1) / D;
        const obstruction = elevs[i] + bulge - ray;
        const f1 = Math.sqrt((lambda * d1 * d2) / D);
        const v = (obstruction * Math.SQRT2) / f1;
        if (v > worstV) worstV = v;
      }
      let diffLoss = 0;
      if (worstV > -0.78) diffLoss = 6.9 + 20 * Math.log10(Math.sqrt((worstV - 0.1) ** 2 + 1) + worstV - 0.1);

      const fspl = 32.45 + 20 * Math.log10(Math.max(D, 1) / 1000) + 20 * Math.log10(node.freqMhz);
      let patLoss = 0;
      if (txPattern) {
        const elAngle = elevationAngleDeg(elevTx, elevRx, D);
        patLoss = patternLossDb({
          offAzDeg: angDiff(bearing, txPattern.azimuthDeg ?? 0),
          offElDeg: Math.abs(elAngle - (txPattern.tiltDeg ?? 0)),
          hpbwAz: txPattern.hpbwAz ?? 360,
          hpbwEl: txPattern.hpbwEl ?? 360,
        });
      }
      const gains = node.antennaGain - patLoss + remoteGainDbi - node.cableLoss + node.bdaGain;

      let best = -1;
      for (let mcs = maxMcs - 1; mcs >= 0; mcs--) {
        const tx = txPowerDbm(radio, node.powerDbm, mcs, antennas);
        const rssi = tx + gains - fspl - diffLoss;
        if (rssi - sensitivityDbm(mcs, node.bwMhz) >= fadeMargin) {
          // find the highest-throughput usable MCS (mbps ordering == mcs%8 ordering within group)
          if (best === -1 || throughputMbps(mcs, node.bwMhz) > throughputMbps(best, node.bwMhz)) best = mcs;
        }
      }
      polar[a * steps + s] = best;
    }
    if (onProgress && a % 10 === 0) onProgress(a / azimuths);
  }

  // paint polar data onto a raster canvas
  const SIZE = 640;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const degPerMLat = 1 / 111320;
  const degPerMLng = 1 / (111320 * Math.cos((origin.lat * Math.PI) / 180));
  const bounds = [
    [origin.lng - radiusM * degPerMLng, origin.lat + radiusM * degPerMLat], // top-left
    [origin.lng + radiusM * degPerMLng, origin.lat + radiusM * degPerMLat],
    [origin.lng + radiusM * degPerMLng, origin.lat - radiusM * degPerMLat],
    [origin.lng - radiusM * degPerMLng, origin.lat - radiusM * degPerMLat],
  ];
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = ((px + 0.5) / SIZE - 0.5) * 2 * radiusM;
      const dy = (0.5 - (py + 0.5) / SIZE) * 2 * radiusM;
      const dist = Math.hypot(dx, dy);
      if (dist > radiusM || dist < 1) continue;
      let az = (Math.atan2(dx, dy) * 180) / Math.PI;
      if (az < 0) az += 360;
      const ai = Math.round((az / 360) * azimuths) % azimuths;
      const si = Math.min(steps - 1, Math.max(0, Math.round((dist / radiusM) * steps) - 1));
      const mcs = polar[ai * steps + si];
      const c = colorForMcs(mcs);
      if (!c) continue;
      const o = (py * SIZE + px) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2];
      img.data[o + 3] = 165;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (onProgress) onProgress(1);
  return { canvas, bounds, radiusM };
}
