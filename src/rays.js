// Ray sampling and RF evaluation, split apart so that changing altitude, remote
// mode or display metric re-evaluates WITHOUT re-fetching or re-walking terrain.
//
//   sampleRays()      — expensive, async, cached: terrain elevations along N azimuths
//   evaluateRays()    — cheap, synchronous: link budget per polar cell
//   minAltitudeRays() — cheap, synchronous: lowest altitude that closes the link
//
// Terrain geometry depends only on position/radius/resolution, so the cache
// survives changes to radio config, antenna, altitude and metric.

import { elevationAt, destination } from './terrain.js';
import { txPowerDbm, sensitivityDbm, throughputMbps, patternLossDb, angDiff } from './engine.js';

const R_EFF = 6371008.8 * (4 / 3);

// Quality tiers: coarse while dragging, fine on release.
export const QUALITY = {
  coarse: { azimuths: 90, steps: 80 },
  normal: { azimuths: 180, steps: 120 },
  fine: { azimuths: 360, steps: 160 },
};

const rayCache = new Map();
const MAX_CACHE = 12;

function cacheKey(lng, lat, radiusM, azimuths, steps) {
  return `${lng.toFixed(5)},${lat.toFixed(5)}|${Math.round(radiusM)}|${azimuths}x${steps}`;
}

/**
 * Sample terrain along `azimuths` rays out to `radiusM`.
 * Returns { origin, radiusM, azimuths, steps, dists, elevs, baseElev } where
 * elevs is a Float32Array laid out [azimuth * steps + step] and dists[step] is
 * the ground distance in metres of that step.
 */
export async function sampleRays(origin, radiusM, quality = QUALITY.normal, onProgress) {
  const { azimuths, steps } = quality;
  const key = cacheKey(origin.lng, origin.lat, radiusM, azimuths, steps);
  const hit = rayCache.get(key);
  if (hit) {
    rayCache.delete(key);
    rayCache.set(key, hit); // refresh LRU position
    if (onProgress) onProgress(1);
    return hit;
  }

  const dists = new Float64Array(steps);
  for (let s = 0; s < steps; s++) dists[s] = ((s + 1) / steps) * radiusM;

  const elevs = new Float32Array(azimuths * steps);
  const baseElev = await elevationAt(origin.lng, origin.lat).catch(() => 0);

  for (let a = 0; a < azimuths; a++) {
    const bearing = (a * 360) / azimuths;
    const pts = [];
    for (let s = 0; s < steps; s++) pts.push(destination(origin.lng, origin.lat, bearing, dists[s]));
    const row = await Promise.all(pts.map((p) => elevationAt(p.lng, p.lat).catch(() => 0)));
    for (let s = 0; s < steps; s++) elevs[a * steps + s] = row[s];
    if (onProgress && a % 8 === 0) onProgress(a / azimuths);
  }

  const rays = { origin: { lng: origin.lng, lat: origin.lat }, radiusM, azimuths, steps, dists, elevs, baseElev };
  rayCache.set(key, rays);
  while (rayCache.size > MAX_CACHE) rayCache.delete(rayCache.keys().next().value);
  if (onProgress) onProgress(1);
  return rays;
}

export function invalidateRayCache() { rayCache.clear(); }

// ---------------------------------------------------------------------------
// RF evaluation
// ---------------------------------------------------------------------------

// Empirical near-ground model probed from the official Doodle Labs estimator:
// PL = A(f) + 22.25*log10(d_m), A(f) interpolated in log-frequency.
const GROUND_A = [[250, 36.07], [500, 40.70], [915, 43.25], [1000, 43.66],
                  [2000, 44.62], [2450, 44.75], [4000, 46.06], [5800, 48.05]];

export function groundPathLossDb(freqMhz, distM) {
  const lf = Math.log10(freqMhz);
  let A = GROUND_A[GROUND_A.length - 1][1];
  if (freqMhz <= GROUND_A[0][0]) A = GROUND_A[0][1];
  else for (let i = 1; i < GROUND_A.length; i++) {
    if (freqMhz <= GROUND_A[i][0]) {
      const [f0, a0] = GROUND_A[i - 1], [f1, a1] = GROUND_A[i];
      const t = (lf - Math.log10(f0)) / (Math.log10(f1) - Math.log10(f0));
      A = a0 + t * (a1 - a0);
      break;
    }
  }
  return A + 22.25 * Math.log10(Math.max(distM, 1));
}

/**
 * Evaluate the link budget for every polar cell of a sampled ray set.
 *
 * params:
 *   elevTxAsl    absolute elevation of the transmit antenna (ground + mast), m
 *   freqMhz, bwMhz, radio, powerDbm
 *   txGainDbi, remoteGainDbi, cableLossDb, bdaGainDb
 *   txPattern    { azimuthDeg, tiltDeg, hpbwAz, hpbwEl } or null
 *   fadeMarginDb
 *   remoteMode   'agl' (terrain-following) | 'asl' (flight level)
 *   remoteAltM   metres AGL when remoteMode==='agl', metres ASL when 'asl'
 *   nearGround   when true, path loss = max(FSPL+diffraction, empirical near-ground)
 *
 * Returns typed arrays laid out like rays.elevs:
 *   bestMcs      Int8Array   best usable MCS, -1 = no link
 *   rssiDbm      Float32Array received level at the best usable MCS's TX power
 *   pathLossDb   Float32Array total path loss actually used (incl. diffraction / near-ground)
 *   excessLossDb Float32Array path loss above free space (the terrain penalty)
 *   marginDb     Float32Array margin above the sensitivity of the best usable MCS
 *   belowTerrain Uint8Array   1 = the requested flight level is under the ground here
 */
export function evaluateRays(rays, params) {
  const { azimuths, steps, dists, elevs } = rays;
  const {
    elevTxAsl, freqMhz, bwMhz, radio, powerDbm,
    txGainDbi, remoteGainDbi, cableLossDb = 0, bdaGainDb = 0,
    txPattern = null, fadeMarginDb = 10,
    remoteMode = 'agl', remoteAltM = 2, nearGround = false,
  } = params;

  const n = azimuths * steps;
  const bestMcs = new Int8Array(n).fill(-1);
  const rssiDbm = new Float32Array(n).fill(NaN);
  const pathLossDb = new Float32Array(n).fill(NaN);
  const excessLossDb = new Float32Array(n).fill(NaN);
  const marginDb = new Float32Array(n).fill(NaN);
  const belowTerrain = new Uint8Array(n);

  const antennas = radio.chains === 1 ? 1 : 2;
  const maxMcs = antennas === 2 ? 16 : 8;
  const lambda = 299.792458 / freqMhz;
  const fsplConst = 32.45 + 20 * Math.log10(freqMhz) - 60; // -60 folds m->km
  const LOG10 = Math.LN10;

  // Precompute per-MCS TX power and sensitivity (cheap, avoids inner-loop calls)
  const txAt = new Float64Array(maxMcs);
  const sensAt = new Float64Array(maxMcs);
  const mbpsAt = new Float64Array(maxMcs);
  for (let m = 0; m < maxMcs; m++) {
    txAt[m] = txPowerDbm(radio, powerDbm, m, antennas);
    sensAt[m] = sensitivityDbm(m, bwMhz);
    mbpsAt[m] = throughputMbps(m, bwMhz);
  }

  const patAz = txPattern ? (txPattern.azimuthDeg ?? 0) : 0;
  const patTilt = txPattern ? (txPattern.tiltDeg ?? 0) : 0;
  const hpbwAz = txPattern ? (txPattern.hpbwAz ?? 360) : 360;
  const hpbwEl = txPattern ? (txPattern.hpbwEl ?? 360) : 360;

  for (let a = 0; a < azimuths; a++) {
    const base = a * steps;
    const bearing = (a * 360) / azimuths;
    const azLoss = txPattern ? angDiff(bearing, patAz) : 0;

    for (let s = 0; s < steps; s++) {
      const idx = base + s;
      const D = dists[s];
      const groundHere = elevs[idx];

      let elevRx;
      if (remoteMode === 'asl') {
        if (remoteAltM < groundHere) { belowTerrain[idx] = 1; continue; }
        elevRx = remoteAltM;
      } else {
        elevRx = groundHere + remoteAltM;
      }

      // worst knife edge between TX and this receiver position
      let worstV = -Infinity;
      const slope = (elevRx - elevTxAsl) / D;
      for (let i = 0; i < s; i++) {
        const d1 = dists[i];
        const d2 = D - d1;
        if (d2 <= 0) continue;
        const bulge = (d1 * d2) / (2 * R_EFF);
        const ray = elevTxAsl + slope * d1;
        const obstruction = elevs[base + i] + bulge - ray;
        // No early skip on negative obstruction: a shallow clearance with a small
        // Fresnel radius can still be the worst v on the ray, and missing it would
        // under-report diffraction loss (an optimistic error we must not make).
        const f1 = Math.sqrt((lambda * d1 * d2) / D);
        const v = (obstruction * Math.SQRT2) / f1;
        if (v > worstV) worstV = v;
      }

      let diffLoss = 0;
      if (worstV > -0.78) {
        const t = worstV - 0.1;
        diffLoss = 6.9 + 20 * (Math.log(Math.sqrt(t * t + 1) + t) / LOG10);
      }

      const fspl = fsplConst + 20 * (Math.log(Math.max(D, 1)) / LOG10);
      let totalLoss = fspl + diffLoss;
      if (nearGround) totalLoss = Math.max(totalLoss, groundPathLossDb(freqMhz, D));

      let patLoss = 0;
      if (txPattern) {
        const elAngle = (Math.atan2(elevRx - elevTxAsl, D) * 180) / Math.PI;
        patLoss = patternLossDb({
          offAzDeg: azLoss,
          offElDeg: Math.abs(elAngle - patTilt),
          hpbwAz, hpbwEl,
        });
      }

      const gains = txGainDbi - patLoss + remoteGainDbi - cableLossDb + bdaGainDb;

      let best = -1, bestMbps = -1, bestRssi = NaN, bestMargin = NaN;
      for (let m = 0; m < maxMcs; m++) {
        const rssi = txAt[m] + gains - totalLoss;
        const margin = rssi - sensAt[m];
        if (margin >= fadeMarginDb && mbpsAt[m] > bestMbps) {
          best = m; bestMbps = mbpsAt[m]; bestRssi = rssi; bestMargin = margin;
        }
      }

      bestMcs[idx] = best;
      pathLossDb[idx] = totalLoss;
      excessLossDb[idx] = totalLoss - fspl;
      // report level/margin even where no MCS closes, using the most robust rate
      rssiDbm[idx] = best >= 0 ? bestRssi : txAt[0] + gains - totalLoss;
      marginDb[idx] = best >= 0 ? bestMargin : (txAt[0] + gains - totalLoss) - sensAt[0];
    }
  }

  return { bestMcs, rssiDbm, pathLossDb, excessLossDb, marginDb, belowTerrain, azimuths, steps };
}

/**
 * Lowest HEIGHT ABOVE GROUND at which the link closes.
 *
 * Always solved in AGL terms — "how high must the aircraft be above the ground
 * beneath it" is the question an operator can act on, and it is the only version
 * that is comparable across varying terrain. (A constant flight level over
 * varying terrain is a different question, answered by the flight-level sweep.)
 *
 * Stepped scan from low to high — NOT a bisection. Climbing is not guaranteed
 * monotonic: it clears terrain (better) but also climbs the vertical pattern of
 * the ground antenna, so a narrow-beam omni or a downtilted sector can lose a
 * target that is too high. The scan returns the lowest workable height and flags
 * cells that stop working again higher up.
 *
 * Returns { minAlt: Float32Array (NaN = never closes), ceilingBreak: Uint8Array
 * (1 = closes at some height but fails again above it) }.
 */
export function minAltitudeRays(rays, params, options = {}) {
  const { altitudes = [5, 10, 20, 30, 45, 60, 90, 120, 150, 200, 300, 400, 600, 900], minMbps = 0 } = options;
  const mode = 'agl';
  const n = rays.azimuths * rays.steps;
  const minAlt = new Float32Array(n).fill(NaN);
  const ceilingBreak = new Uint8Array(n);
  const worked = new Uint8Array(n);

  for (const alt of altitudes) {
    const res = evaluateRays(rays, { ...params, remoteMode: mode, remoteAltM: alt });
    for (let i = 0; i < n; i++) {
      const mcs = res.bestMcs[i];
      const ok = mcs >= 0 && (minMbps <= 0 || throughputMbps(mcs, params.bwMhz) >= minMbps);
      if (ok) {
        if (Number.isNaN(minAlt[i])) minAlt[i] = alt;
        worked[i] = 1;
      } else if (worked[i]) {
        ceilingBreak[i] = 1;
      }
    }
  }
  return { minAlt, ceilingBreak, azimuths: rays.azimuths, steps: rays.steps };
}
