// Plan Advisor: goal-driven configuration search.
// Given a mission (platform pair, range, throughput, environment), search
// radio × band × bandwidth × antenna combinations using the validated
// link-budget engine and rank the configurations that meet the target.

import { RADIOS, BANDS, MBPS_20MHZ } from './radios.js';
import { txPowerDbm, sensitivityDbm, throughputMbps, fsplDb, analyzePath, evaluateLink, patternLossDb, elevationAngleDeg, angDiff } from './engine.js';
import { terrainProfile, haversineM, bearingDeg } from './terrain.js';

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

// ===========================================================================
// Extend-existing-infrastructure advisor: evaluate the REAL terrain path from
// an existing node to a target, and find the least-change way to serve it.
// ===========================================================================

export const REMOTE_PLATFORMS = [
  { id: 'uav', label: 'UAV (drone)', height: 100, maxGain: 6, directionalOk: false, formFactor: 'nanoOEM / miniOEM' },
  { id: 'ugv', label: 'UGV / ground robot', height: 1, maxGain: 8, directionalOk: false, formFactor: 'miniOEM / OEM' },
  { id: 'vehicle', label: 'Vehicle', height: 2, maxGain: 8, directionalOk: false, formFactor: 'OEM' },
  { id: 'vessel', label: 'Vessel at sea', height: 4, maxGain: 10, directionalOk: false, formFactor: 'OEM (External)' },
  { id: 'handheld', label: 'Handheld / wearable', height: 1.5, maxGain: 5, directionalOk: false, formFactor: 'Wearable' },
  { id: 'mast', label: 'Fixed site / mast', height: 10, maxGain: 34, directionalOk: true, formFactor: 'OEM (External)' },
];

function remoteAntCandidates(catalog, freqMhz, side) {
  const inBand = catalog.filter((a) => {
    const bands = a.bands_mhz || [a.band_mhz];
    return bands.some(([lo, hi]) => lo <= freqMhz && hi >= freqMhz);
  }).filter((a) => a.gain_dbi <= side.maxGain && (side.directionalOk || a.pattern === 'omni'));
  inBand.sort((x, y) => y.gain_dbi - x.gain_dbi || (y.doodle_recommended ? 1 : 0) - (x.doodle_recommended ? 1 : 0));
  const out = [];
  if (side.directionalOk) { const d = inBand.find((a) => a.pattern === 'directional'); if (d) out.push(d); }
  const o1 = inBand.find((a) => a.pattern === 'omni'); if (o1) out.push(o1);
  const o2 = inBand.find((a) => a.pattern === 'omni' && o1 && a.gain_dbi <= o1.gain_dbi - 3); if (o2) out.push(o2);
  return out;
}

// Evaluate one candidate configuration over a (sub)profile. Returns best usable
// MCS meeting needMbps, with margin, or null.
function evalOver(profile, hA, hB, freqMhz, bwMhz, radio, txCfg) {
  const D = profile[profile.length - 1].distM;
  const pa = analyzePath(profile, hA, hB, freqMhz);
  const res = evaluateLink({
    distM: D, freqMhz, bwMhz, radioA: radio, radioB: radio, pathLoss: pa,
    cfg: { ...txCfg, fadeMargin: 10, antennas: radio.chains === 1 ? 1 : 2 },
  });
  return { pa, res };
}

export async function adviseExtension({ anchor, targetLngLat, remotePlatformId, needMbps, allowBda, catalog }) {
  const remote = REMOTE_PLATFORMS.find((p) => p.id === remotePlatformId);
  const radio = RADIOS.find((r) => r.id === anchor.radioId);
  const freq = anchor.freqMhz, bw = anchor.bwMhz;
  const distM = haversineM(anchor.lngLat, targetLngLat);
  const brToTarget = bearingDeg(anchor.lngLat, targetLngLat);
  const profile = await terrainProfile(anchor.lngLat, targetLngLat, 160);
  const elevA = profile[0].elevM, elevB = profile[profile.length - 1].elevM;

  // anchor pattern loss toward target as currently aimed
  const elAngle = elevationAngleDeg(elevA + anchor.heightM, elevB + remote.height, distM);
  const patLossNow = patternLossDb({
    offAzDeg: anchor.pattern.directional ? angDiff(brToTarget, anchor.azimuthDeg) : 0,
    offElDeg: Math.abs(elAngle - anchor.tiltDeg),
    hpbwAz: anchor.pattern.hpbwAz, hpbwEl: anchor.pattern.hpbwEl,
  });
  const misaimed = anchor.pattern.directional && patLossNow > 3;

  const ants = remoteAntCandidates(catalog, freq, remote);
  if (!ants.length) return { error: `No catalog antenna covers ${freq} MHz for a ${remote.label}.`, distM };

  // MCS floor for required throughput
  let mcsNeeded = -1;
  const maxMcs = radio.chains === 1 ? 8 : 16;
  for (let m = 0; m < maxMcs; m++) if (throughputMbps(m, bw) * 0.88 >= needMbps) { mcsNeeded = m; break; }
  if (mcsNeeded === -1) return { error: `${needMbps} Mbps is not achievable at ${bw} MHz channel width — widen the channel on ${anchor.label} first.`, distM };

  const options = [];
  const heightsToTry = [anchor.heightM, ...(anchor.heightM < 15 ? [15] : []), ...(anchor.heightM < 30 ? [30] : [])];
  const bdasToTry = [anchor.bdaGain, ...(allowBda && anchor.bdaGain === 0 ? [anchor.bdaGain + (freq >= 4400 && freq <= 6400 ? 13 : 10)] : [])];

  for (const ant of ants) {
    for (const aim of misaimed ? [false, true] : [false]) {
      for (const h of heightsToTry) {
        for (const bda of bdasToTry) {
          const { pa, res } = evalOver(profile, h, remote.height, freq, bw, radio, {
            powerA: anchor.powerDbm, powerB: radio.maxConfig,
            gainA: anchor.antennaGain - (aim ? 0 : patLossNow), gainB: ant.gain_dbi,
            cableA: anchor.cableLoss, cableB: 1,
            bdaA: bda, bdaB: 0,
          });
          const usable = res.results.filter((r) => r.usable && throughputMbps(r.mcs, bw) * 0.88 >= needMbps);
          if (!usable.length) continue;
          const best = usable.reduce((x, y) => (y.mbps > x.mbps ? y : x));
          const changes = [];
          changes.push(`${remote.label} kit: ${remote.formFactor} radio + ${ant.doodle_recommended ? '★ ' : ''}${ant.manufacturer} ${ant.model} (${ant.gain_dbi} dBi)`);
          if (aim) changes.push(`Re-aim ${anchor.label} to ${Math.round(brToTarget)}° (currently ${Math.round(patLossNow)} dB off-boresight)`);
          if (h !== anchor.heightM) changes.push(`Raise ${anchor.label} to ${h} m mast`);
          if (bda !== anchor.bdaGain) changes.push(freq >= 4400 && freq <= 6400 ? `Add Boost BDA (BDA-4464) at ${anchor.label} (+13 dB)` : `Add BDA (e.g. Triad) at ${anchor.label} (+10 dB)`);
          options.push({ type: 'direct', ant, changes, nChanges: changes.length - 1, marginDb: best.margin - 10, mcs: best.mcs, mbps: best.mbps * 0.88, blocked: pa.losBlocked, fresnel: pa.fresnelIntruded, aim, height: h, bda });
        }
      }
    }
  }

  options.sort((x, y) => x.nChanges - y.nChanges || y.marginDb - x.marginDb);
  const dedup = [];
  const seen = new Set();
  for (const o of options) {
    const k = `${o.ant.id}|${o.aim}|${o.height}|${o.bda}`;
    if (seen.has(k)) continue;
    seen.add(k); dedup.push(o);
    if (dedup.length >= 4) break;
  }

  // relay search when nothing closes directly. Anchor is assumed re-aimed at the
  // relay (recorded as a change); relay gets a 12 dBi omni option and 10/20 m masts.
  let relay = null;
  if (!dedup.length) {
    const bestAnt = ants[0];
    let bestRelay = null;
    for (const relayH of [10, 20]) {
      for (let i = 12; i < profile.length - 12; i += 6) {
        const p = profile[i];
        const profA = profile.slice(0, i + 1);
        const profB = profile.slice(i).map((q) => ({ ...q, distM: q.distM - p.distM }));
        const h1 = evalOver(profA, anchor.heightM, relayH, freq, bw, radio, {
          powerA: anchor.powerDbm, powerB: radio.maxConfig, gainA: anchor.antennaGain, gainB: 10,
          cableA: anchor.cableLoss, cableB: 1.5, bdaA: anchor.bdaGain, bdaB: 0,
        });
        const h2 = evalOver(profB, relayH, remote.height, freq, bw, radio, {
          powerA: radio.maxConfig, powerB: radio.maxConfig, gainA: 10, gainB: bestAnt.gain_dbi,
          cableA: 1.5, cableB: 1, bdaA: 0, bdaB: 0,
        });
        const u1 = h1.res.results.filter((r) => r.usable && throughputMbps(r.mcs, bw) * 0.88 >= needMbps);
        const u2 = h2.res.results.filter((r) => r.usable && throughputMbps(r.mcs, bw) * 0.88 >= needMbps);
        if (u1.length && u2.length) {
          const m = Math.min(u1[u1.length - 1].margin, u2[u2.length - 1].margin);
          if (!bestRelay || m > bestRelay.minMargin) {
            bestRelay = { lngLat: { lng: p.lng, lat: p.lat }, distFromAnchorKm: p.distM / 1000, minMargin: m, elevM: p.elevM, ant: bestAnt, relayH, reaim: anchor.pattern.directional };
          }
        }
      }
      if (bestRelay) break; // prefer the shorter mast
    }
    relay = bestRelay;
  }

  return { distM, brToTarget, patLossNow, misaimed, options: dedup, relay, remote, profileBlocked: dedup.length === 0, freq, bw };
}
