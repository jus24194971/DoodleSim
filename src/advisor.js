// Plan Advisor: goal-driven configuration search.
// Given a mission (platform pair, range, throughput, environment), search
// radio × band × bandwidth × antenna combinations using the validated
// link-budget engine and rank the configurations that meet the target.

import { RADIOS, BANDS, MBPS_20MHZ } from './radios.js';
import { txPowerDbm, sensitivityDbm, throughputMbps, fsplDb } from './engine.js';

export const SCENARIOS = [
  { id: 'gcs-uav', label: 'Ground station ⟷ UAV (drone)', a: { name: 'GCS', platform: 'mast', height: 3, maxGain: 30, directionalOk: true }, b: { name: 'UAV', platform: 'uav', height: 100, maxGain: 6, directionalOk: false }, ground: false },
  { id: 'base-ugv', label: 'Base ⟷ UGV / ground robot', a: { name: 'Base', platform: 'mast', height: 5, maxGain: 16, directionalOk: true }, b: { name: 'UGV', platform: 'ugv', height: 1, maxGain: 8, directionalOk: false }, ground: true },
  { id: 'shore-vessel', label: 'Shore ⟷ Vessel at sea', a: { name: 'Shore', platform: 'mast', height: 15, maxGain: 16, directionalOk: true }, b: { name: 'Vessel', platform: 'vessel', height: 4, maxGain: 10, directionalOk: false }, ground: false },
  { id: 'p2p', label: 'Point-to-point backhaul (fixed)', a: { name: 'Site A', platform: 'mast', height: 15, maxGain: 34, directionalOk: true }, b: { name: 'Site B', platform: 'mast', height: 15, maxGain: 34, directionalOk: true }, ground: false },
  { id: 'handheld', label: 'Handheld ⟷ Handheld / wearable mesh', a: { name: 'Operator 1', platform: 'handheld', height: 1.5, maxGain: 5, directionalOk: false }, b: { name: 'Operator 2', platform: 'handheld', height: 1.5, maxGain: 5, directionalOk: false }, ground: true },
  { id: 'vehicle', label: 'Base ⟷ Vehicle convoy', a: { name: 'Base', platform: 'mast', height: 8, maxGain: 16, directionalOk: true }, b: { name: 'Vehicle', platform: 'vehicle', height: 2, maxGain: 8, directionalOk: false }, ground: true },
];

// Ground-mode empirical model (probed from the official Doodle Labs estimator):
// PL = A(f) + 22.25*log10(d_m). A(f) sampled by probing; interpolate in log-f.
const GROUND_A = [[250, 36.07], [500, 40.70], [915, 43.25], [1000, 43.66], [2000, 44.62], [2450, 44.75], [4000, 46.06], [5800, 48.05]];
function groundA(freqMhz) {
  const lf = Math.log10(freqMhz);
  if (freqMhz <= GROUND_A[0][0]) return GROUND_A[0][1];
  for (let i = 1; i < GROUND_A.length; i++) {
    if (freqMhz <= GROUND_A[i][0]) {
      const [f0, a0] = GROUND_A[i - 1], [f1, a1] = GROUND_A[i];
      const t = (lf - Math.log10(f0)) / (Math.log10(f1) - Math.log10(f0));
      return a0 + t * (a1 - a0);
    }
  }
  return GROUND_A[GROUND_A.length - 1][1];
}

function rangeFromBudget(plDb, freqMhz, ground) {
  const dFsplKm = 10 ** ((plDb - 32.45 - 20 * Math.log10(freqMhz)) / 20);
  if (!ground) return dFsplKm * 1000;
  const dGround = 10 ** ((plDb - groundA(freqMhz)) / 22.25);
  return Math.min(dGround, dFsplKm * 1000);
}

const FADE = 10;
const CABLE_ALLOWANCE = 1; // dB per side default (short jumper)

function antennaCandidates(catalog, freqMhz, side, ground) {
  const inBand = catalog.filter((a) => {
    const bands = a.bands_mhz || [a.band_mhz];
    return bands.some(([lo, hi]) => lo <= freqMhz && hi >= freqMhz);
  });
  const ok = inBand.filter((a) => a.gain_dbi <= side.maxGain && (side.directionalOk || a.pattern === 'omni'));
  // sort: highest gain first, prefer Doodle-recommended on ties
  ok.sort((x, y) => y.gain_dbi - x.gain_dbi || (y.doodle_recommended ? 1 : 0) - (x.doodle_recommended ? 1 : 0));
  // keep a spread: best directional, best omni, a mid omni
  const out = [];
  const bestDir = ok.find((a) => a.pattern === 'directional');
  const bestOmni = ok.find((a) => a.pattern === 'omni');
  if (bestDir) out.push(bestDir);
  if (bestOmni) out.push(bestOmni);
  const midOmni = ok.find((a) => a.pattern === 'omni' && bestOmni && a.gain_dbi <= bestOmni.gain_dbi - 3);
  if (midOmni) out.push(midOmni);
  return out.length ? out : ok.slice(0, 2);
}

export function recommend({ scenarioId, rangeKm, throughputMbps: needMbps, allowGovBands, allowBda, catalog }) {
  const scen = SCENARIOS.find((s) => s.id === scenarioId);
  const targetM = rangeKm * 1000;
  const results = [];

  for (const radio of RADIOS) {
    for (const bandId of radio.bands) {
      const band = BANDS[bandId];
      const isGov = !['ism900', 'ism2400', 'unii', 'ism5800'].includes(bandId);
      if (isGov && !allowGovBands) continue;
      const freq = band.def;
      const antsA = antennaCandidates(catalog, freq, scen.a, scen.ground);
      const antsB = antennaCandidates(catalog, freq, scen.b, scen.ground);
      for (const bw of [3, 5, 10, 20]) {
        // lowest MCS that meets the throughput requirement at this bandwidth
        const maxMcs = radio.chains === 1 ? 8 : 16;
        let mcs = -1;
        for (let m = 0; m < maxMcs; m++) {
          if (throughputMbps(m, bw) * 0.88 >= needMbps) { mcs = m; break; } // 0.88 ≈ airtime overhead
        }
        if (mcs === -1) continue;
        for (const aA of antsA) {
          for (const aB of antsB) {
            for (const bda of allowBda ? [0, 13] : [0]) {
              // Boost BDA is C-band only (4400-6400)
              if (bda && !(freq >= 4400 && freq <= 6400)) continue;
              const tx = Math.min(txPowerDbm(radio, 99, mcs, radio.chains === 1 ? 1 : 2) + (bda ? Math.min(13, 36 - txPowerDbm(radio, 99, mcs, 2)) : 0), bda ? 36 : 99);
              const sens = sensitivityDbm(mcs, bw);
              const pl = tx + aA.gain_dbi + aB.gain_dbi - 2 * CABLE_ALLOWANCE - FADE - sens;
              const reachM = rangeFromBudget(pl, freq, scen.ground);
              if (reachM < targetM) continue;
              // margin at the target distance
              const plAtTarget = scen.ground
                ? Math.max(groundA(freq) + 22.25 * Math.log10(targetM), fsplDb(targetM, freq))
                : fsplDb(targetM, freq);
              const margin = pl - plAtTarget + FADE; // dB above sensitivity at target
              results.push({
                radio: radio.name, radioId: radio.id, bandId, band: band.label, freqMhz: freq, bwMhz: bw,
                mcs, mbps: throughputMbps(mcs, bw) * 0.88, antA: aA, antB: aB, bdaDb: bda,
                reachKm: reachM / 1000, marginDb: margin - FADE, isGov,
              });
            }
          }
        }
      }
    }
  }

  // rank: prefer no-BDA, unlicensed, fewest exotic parts, then highest margin; dedupe per radio+band
  results.sort((x, y) => (x.bdaDb - y.bdaDb) || (x.isGov - y.isGov) || (y.marginDb - x.marginDb));
  const seen = new Set();
  const top = [];
  for (const r of results) {
    const key = `${r.radioId}|${r.bandId}|${r.bdaDb > 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(r);
    if (top.length >= 6) break;
  }
  return { scen, top, totalConsidered: results.length };
}
