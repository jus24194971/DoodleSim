// Link-budget engine.
// RF math validated against the official Doodle Labs Range Estimation Tool (FSPL mode
// reproduced exactly, July 2026), extended with terrain: 4/3-earth curvature,
// Fresnel-zone clearance and single knife-edge diffraction (worst obstruction).

import { SENS_MCS0_7_20MHZ, MBPS_20MHZ } from './radios.js';

const K_FACTOR = 4 / 3;
const R_EFF = 6371008.8 * K_FACTOR;

export function fsplDb(distM, freqMhz) {
  const dKm = Math.max(distM, 1) / 1000;
  return 32.45 + 20 * Math.log10(dKm) + 20 * Math.log10(freqMhz);
}

// Effective TX power at a given MCS (matches official estimator behavior)
export function txPowerDbm(radio, configuredDbm, mcsIndex, antennas) {
  const perChain = radio.power[mcsIndex % 8];
  const combined = perChain + (antennas === 2 ? 3 : 0);
  return Math.min(configuredDbm, combined);
}

export function sensitivityDbm(mcsIndex, bwMhz) {
  const base = SENS_MCS0_7_20MHZ[mcsIndex % 8];
  const streamPenalty = mcsIndex >= 8 ? 3 : 0;
  return base + streamPenalty + 10 * Math.log10(bwMhz / 20);
}

export function throughputMbps(mcsIndex, bwMhz) {
  const table = mcsIndex >= 8 ? MBPS_20MHZ.mimo : MBPS_20MHZ.siso;
  return table[mcsIndex % 8] * (bwMhz / 20);
}

// ---- Terrain analysis ----------------------------------------------------

// Given a profile (from terrain.js) and the two node heights AGL, analyze
// LOS clearance, worst Fresnel intrusion, and knife-edge diffraction loss.
export function analyzePath(profile, hA, hB, freqMhz) {
  const n = profile.length;
  const D = profile[n - 1].distM;
  if (D < 1) return { diffractionLossDb: 0, worstV: -Infinity, clearanceOk: true, losBlocked: false, fresnelIntruded: false, worst: null };
  const lambda = 299.792458 / freqMhz; // meters
  const elevA = profile[0].elevM + hA;
  const elevB = profile[n - 1].elevM + hB;

  let worst = null; // point with max diffraction parameter v
  let worstV = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const p = profile[i];
    const d1 = p.distM, d2 = D - d1;
    // earth bulge under the ray (effective earth radius)
    const bulge = (d1 * d2) / (2 * R_EFF);
    const losHeight = elevA + ((elevB - elevA) * d1) / D; // straight ray in eff-earth space
    const obstruction = p.elevM + bulge - losHeight; // + means terrain above the ray
    const f1 = Math.sqrt((lambda * d1 * d2) / D); // first Fresnel radius at this point
    const v = (obstruction * Math.sqrt(2)) / f1; // knife-edge diffraction parameter
    if (v > worstV) {
      worstV = v;
      worst = { i, distM: d1, obstruction, f1, elevM: p.elevM, bulge };
    }
  }

  // ITU-R P.526 single knife-edge approximation
  let diffractionLossDb = 0;
  if (worstV > -0.78) {
    diffractionLossDb = 6.9 + 20 * Math.log10(Math.sqrt((worstV - 0.1) ** 2 + 1) + worstV - 0.1);
  }
  const losBlocked = worstV > 0; // terrain above the direct ray
  const fresnelIntruded = worstV > -0.6 * Math.SQRT2; // less than 60% of F1 clear

  return { diffractionLossDb, worstV, losBlocked, fresnelIntruded, clearanceOk: !fresnelIntruded, worst };
}

// ---- Full link evaluation ------------------------------------------------

export function evaluateLink({ distM, freqMhz, bwMhz, radioA, radioB, cfg, pathLoss }) {
  // cfg: { powerA, powerB, gainA, gainB, cableA, cableB, bdaA, bdaB, fadeMargin, antennas }
  const fspl = fsplDb(distM, freqMhz);
  const totalLoss = fspl + (pathLoss?.diffractionLossDb ?? 0);
  const results = [];
  const maxMcs = cfg.antennas === 2 ? 16 : 8;
  for (let mcs = 0; mcs < maxMcs; mcs++) {
    // A transmits -> B receives (use min of both directions for symmetric planning)
    const txA = txPowerDbm(radioA, cfg.powerA, mcs, cfg.antennas);
    const txB = txPowerDbm(radioB, cfg.powerB, mcs, cfg.antennas);
    const sens = sensitivityDbm(mcs, bwMhz);
    const gains = cfg.gainA + cfg.gainB - cfg.cableA - cfg.cableB + cfg.bdaA + cfg.bdaB;
    const rssiAB = txA + gains - totalLoss;
    const rssiBA = txB + gains - totalLoss;
    const rssi = Math.min(rssiAB, rssiBA);
    const margin = rssi - sens;
    results.push({ mcs, rssi, sens, margin, usable: margin >= cfg.fadeMargin, mbps: throughputMbps(mcs, bwMhz) });
  }
  const usable = results.filter((r) => r.usable);
  const best = usable.length ? usable.reduce((a, b) => (b.mbps > a.mbps ? b : a)) : null;
  const mostRobust = usable.length ? usable[0] : null;
  return { fspl, diffractionLossDb: pathLoss?.diffractionLossDb ?? 0, totalLoss, results, best, mostRobust };
}

export function marginColor(link) {
  if (!link.best) return '#e03131'; // no usable MCS
  const m = link.best.margin - 10; // headroom beyond fade margin baseline handled in cfg
  if (link.pathAnalysis?.losBlocked) return '#e8590c';
  if (link.best.mbps >= 50) return '#2f9e44';
  if (link.best.mbps >= 20) return '#66a80f';
  if (link.best.mbps >= 10) return '#f08c00';
  return '#e8590c';
}
