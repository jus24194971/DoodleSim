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

// Receiver noise figure, from the Mesh Rider datasheet ("Receive Noise Figure +4 dB").
export const RX_NOISE_FIGURE_DB = 4;

/** Thermal noise floor a quiet receiver sees in this bandwidth: kTB + NF. */
export function thermalNoiseDbm(bwMhz) {
  return -174 + 10 * Math.log10(Math.max(bwMhz, 0.1) * 1e6) + RX_NOISE_FIGURE_DB;
}

/**
 * How much a raised noise floor costs, in dB.
 *
 * The published sensitivity figures already assume a receiver hearing nothing but
 * its own thermal noise. Every dB the environment sits above that floor is a dB the
 * signal must gain back to keep the same SNR, so the penalty is simply the excess -
 * and it is zero for a quiet site, which keeps existing results unchanged.
 *
 * Deriving it from the sensitivity table rather than a separate SNR table is
 * deliberate: the two cannot then disagree about what a given MCS needs.
 */
export function noisePenaltyDb(noiseFloorDbm, bwMhz) {
  if (!Number.isFinite(noiseFloorDbm)) return 0;
  return Math.max(0, noiseFloorDbm - thermalNoiseDbm(bwMhz));
}

/** SNR this MCS needs, implied by the sensitivity table and the thermal floor. */
export function requiredSnrDb(mcsIndex, bwMhz) {
  return sensitivityDbm(mcsIndex, bwMhz) - thermalNoiseDbm(bwMhz);
}

export function sensitivityDbm(mcsIndex, bwMhz, noiseFloorDbm) {
  const base = SENS_MCS0_7_20MHZ[mcsIndex % 8];
  const streamPenalty = mcsIndex >= 8 ? 3 : 0;
  return base + streamPenalty + 10 * Math.log10(bwMhz / 20)
       + noisePenaltyDb(noiseFloorDbm, bwMhz);
}

export function throughputMbps(mcsIndex, bwMhz) {
  const table = mcsIndex >= 8 ? MBPS_20MHZ.mimo : MBPS_20MHZ.siso;
  return table[mcsIndex % 8] * (bwMhz / 20);
}

// ---- Planning derate -----------------------------------------------------
// Two ways to quote a design. "Calculated" is the model's own answer. "Marginal"
// holds a fixed fraction back, so what we put in front of a customer is short of
// what we expect - the house preference is to be caught being pessimistic.
//
// The derate is deliberately NOT a percentage taken off the dB figures. RSSI and
// sensitivity are logarithmic and negative: 85% of -70 dBm is -59.5 dBm, which is
// a STRONGER signal. Applied that way a pessimism control would quietly make every
// prediction optimistic. It is applied to the two linear quantities a reader
// actually acts on instead - reach and data rate.

export const DERATE_MARGINAL = 0.15;
export const FSPL_EXPONENT = 20;        // dB per decade of distance in free space

/**
 * The extra path loss of a link `derate` further than this one.
 *
 * Quoting 15% less range only means something if the link budget is charged for
 * it, otherwise the map and the numbers disagree. Charging it as loss rather than
 * moving the endpoints leaves the terrain profile alone - the ridge is where it
 * is - and lets a link with less than this much headroom fall to a lower rate or
 * drop out, which is the point.
 *
 * exponent: 20 for free space, ~22.25 for the near-ground model, so the same 15%
 * of reach costs what it really costs under whichever model is in play.
 */
export function derateLossDb(derate, exponent = FSPL_EXPONENT) {
  if (!(derate > 0) || derate >= 1) return 0;
  return exponent * Math.log10(1 / (1 - derate));
}

/** Data rate as quoted: the model's figure less the derate. */
export function deratedMbps(mbps, derate = 0) {
  return derate > 0 && derate < 1 ? mbps * (1 - derate) : mbps;
}

// ---- Antenna pattern model -----------------------------------------------
// Parametric 3GPP-style pattern: parabolic rolloff over the half-power beamwidth
// in azimuth and elevation, with sidelobe floors. Az/el losses combine, capped
// at the front-to-back floor. hpbwAz >= 360 means omnidirectional in azimuth.

export function angDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function patternLossDb({ offAzDeg = 0, offElDeg = 0, hpbwAz = 360, hpbwEl = 360, frontToBackDb = 25 }) {
  const lAz = hpbwAz >= 360 ? 0 : Math.min(12 * (offAzDeg / hpbwAz) ** 2, frontToBackDb);
  const lEl = hpbwEl >= 360 ? 0 : Math.min(12 * (offElDeg / hpbwEl) ** 2, 20);
  return Math.min(lAz + lEl, 30);
}

// Elevation angle (deg) from TX to RX given ASL elevations incl. antenna heights
export function elevationAngleDeg(elevTxAsl, elevRxAsl, distM) {
  if (distM < 1) return 0;
  return (Math.atan2(elevRxAsl - elevTxAsl, distM) * 180) / Math.PI;
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
  // cfg: { powerA, powerB, gainA, gainB, cableA, cableB, bdaA, bdaB, fadeMargin,
  //        antennas, noiseFloorDbm, derate }
  const fspl = fsplDb(distM, freqMhz);
  const derate = cfg.derate ?? 0;
  const derateDb = derateLossDb(derate);
  const totalLoss = fspl + (pathLoss?.diffractionLossDb ?? 0) + derateDb;
  const results = [];
  const maxMcs = cfg.antennas === 2 ? 16 : 8;
  for (let mcs = 0; mcs < maxMcs; mcs++) {
    // A transmits -> B receives (use min of both directions for symmetric planning)
    const txA = txPowerDbm(radioA, cfg.powerA, mcs, cfg.antennas);
    const txB = txPowerDbm(radioB, cfg.powerB, mcs, cfg.antennas);
    const sens = sensitivityDbm(mcs, bwMhz, cfg.noiseFloorDbm);
    const gains = cfg.gainA + cfg.gainB - cfg.cableA - cfg.cableB + cfg.bdaA + cfg.bdaB;
    const rssiAB = txA + gains - totalLoss;
    const rssiBA = txB + gains - totalLoss;
    const rssi = Math.min(rssiAB, rssiBA);
    const margin = rssi - sens;
    results.push({
      mcs, rssi, sens, margin, usable: margin >= cfg.fadeMargin,
      mbps: deratedMbps(throughputMbps(mcs, bwMhz), derate),
    });
  }
  const usable = results.filter((r) => r.usable);
  const best = usable.length ? usable.reduce((a, b) => (b.mbps > a.mbps ? b : a)) : null;
  const mostRobust = usable.length ? usable[0] : null;
  return {
    fspl, diffractionLossDb: pathLoss?.diffractionLossDb ?? 0, totalLoss, results, best, mostRobust,
    derate, derateDb,
  };
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
