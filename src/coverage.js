// Coverage heatmap: ray-cast terrain-aware signal estimation around a node.
// For each azimuth we sample one elevation profile outward, then at every step
// evaluate the link budget to a hypothetical remote node (height + gain configurable),
// including cumulative worst-knife-edge diffraction along that ray.

import { elevationAt } from './terrain.js';
import { txPowerDbm, sensitivityDbm, throughputMbps } from './engine.js';
import { SENS_MCS0_7_20MHZ } from './radios.js';

const R_EARTH = 6371008.8;
const R_EFF = R_EARTH * (4 / 3);

function destination(lng, lat, bearingDeg, distM) {
  const br = (bearingDeg * Math.PI) / 180;
  const dR = distM / R_EARTH;
  const la1 = (lat * Math.PI) / 180, lo1 = (lng * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dR) + Math.cos(la1) * Math.sin(dR) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dR) * Math.cos(la1), Math.cos(dR) - Math.sin(la1) * Math.sin(la2));
  return { lng: (lo2 * 180) / Math.PI, lat: (la2 * 180) / Math.PI };
}

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

export async function computeCoverage(node, radio, opts, onProgress) {
  const { remoteHeightM, remoteGainDbi, fadeMargin, azimuths = 180, steps = 120 } = opts;
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
      const gains = node.antennaGain + remoteGainDbi - node.cableLoss + node.bdaGain;

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
