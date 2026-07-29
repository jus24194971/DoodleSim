// Mission route analysis: sample a waypoint route and, at every position,
// evaluate the link to every compatible radio on the map. Produces the
// achievable bandwidth along the route, which node serves each stretch
// (the network structure), and where the link drops out.
//
// Runs synchronously off pre-warmed terrain tiles so it can re-run instantly
// while waypoints are dragged.

import { elevationAtSync, haversineM, bearingDeg } from './terrain.js';
import {
  txPowerDbm, sensitivityDbm, throughputMbps, patternLossDb,
  elevationAngleDeg, angDiff, analyzePath,
} from './engine.js';

// Colour a route segment by achievable throughput
export function colorForMbps(mbps) {
  if (!(mbps > 0)) return [224, 64, 39];   // no link
  if (mbps >= 50) return [26, 135, 60];
  if (mbps >= 25) return [77, 171, 61];
  if (mbps >= 10) return [163, 199, 62];
  if (mbps >= 5) return [240, 189, 43];
  if (mbps >= 1) return [237, 129, 33];
  return [214, 74, 44];
}

// Distinct colours for the serving-node strip (the "structure" view)
export const NODE_COLORS = [
  [28, 126, 214], [230, 119, 0], [130, 60, 200], [16, 150, 120],
  [200, 50, 110], [90, 140, 30], [0, 150, 199], [190, 100, 40],
];
export function nodeColor(i) { return NODE_COLORS[i % NODE_COLORS.length]; }

function interpolate(a, b, t) {
  return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
}

/** Even-ish samples along the waypoint polyline, with cumulative distance. */
export function sampleRoute(waypoints, spacingM) {
  const legs = [];
  let total = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const len = haversineM(waypoints[i], waypoints[i + 1]);
    legs.push({ a: waypoints[i], b: waypoints[i + 1], len, start: total });
    total += len;
  }
  const out = [];
  if (!legs.length) return { samples: [], totalM: 0 };
  const n = Math.max(2, Math.min(1200, Math.ceil(total / spacingM)));
  for (let k = 0; k <= n; k++) {
    const d = (k / n) * total;
    let leg = legs[legs.length - 1];
    for (const L of legs) { if (d <= L.start + L.len) { leg = L; break; } }
    const t = leg.len > 0 ? (d - leg.start) / leg.len : 0;
    out.push({ ...interpolate(leg.a, leg.b, Math.min(Math.max(t, 0), 1)), distM: d });
  }
  return { samples: out, totalM: total };
}

// Terrain profile between two points using cached tiles only (synchronous).
function profileSync(a, b, distM) {
  const n = Math.max(16, Math.min(128, Math.round(distM / 120)));
  const prof = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = interpolate(a, b, t);
    const e = elevationAtSync(p.lng, p.lat);
    prof[i] = { distM: t * distM, elevM: Number.isFinite(e) ? e : 0 };
  }
  return prof;
}

/**
 * Analyse a route.
 *
 * waypoints : [{lng, lat}]
 * vehicle   : { radio, bandId, freqMhz, bwMhz, powerDbm, antennaGain, heightM,
 *               cableLoss, bdaGain, mode: 'agl'|'asl', altM, pattern: {hpbwAz,hpbwEl,directional},
 *               tracking: bool }
 * infra     : [{ node, radio, pattern }]  — the radios placed on the map
 *
 * Returns { samples, stats, segments, handovers, servingNodes }
 */
export function analyzeRoute({ waypoints, vehicle, infra, fadeMarginDb = 10, spacingM, targetMbps = 5 }) {
  const { samples, totalM } = sampleRoute(waypoints, spacingM || Math.min(250, Math.max(25, totalGuess(waypoints) / 400)));
  const compatible = infra.filter((e) => e.node.bandId === vehicle.bandId);

  for (let si = 0; si < samples.length; si++) {
    const s = samples[si];
    const ground = elevationAtSync(s.lng, s.lat);
    s.groundElevM = Number.isFinite(ground) ? ground : 0;
    s.vehicleElevAsl = vehicle.mode === 'asl' ? vehicle.altM : s.groundElevM + vehicle.heightM;
    s.belowTerrain = vehicle.mode === 'asl' && vehicle.altM < s.groundElevM;
    s.candidates = [];
    s.best = null;
    if (s.belowTerrain) continue;
    // course over ground, used when a directional vehicle antenna is bolted down
    const prev = samples[Math.max(0, si - 1)];
    const next = samples[Math.min(samples.length - 1, si + 1)];
    s.courseDeg = prev === next ? 0 : bearingDeg(prev, next);

    for (const e of compatible) {
      const nodePos = e.node.marker.getLngLat();
      const D = haversineM(nodePos, s);
      if (D < 1) continue;
      const prof = profileSync(nodePos, s, D);
      const nodeGround = prof[0].elevM;
      const hA = e.node.heightM;
      const hB = s.vehicleElevAsl - prof[prof.length - 1].elevM; // effective AGL at the vehicle
      const pa = analyzePath(prof, hA, hB, e.node.freqMhz);

      const elevTxAsl = nodeGround + hA;
      const elAngle = elevationAngleDeg(elevTxAsl, s.vehicleElevAsl, D);
      const brNodeToVeh = bearingDeg(nodePos, s);

      // fixed-infrastructure antenna pattern, as actually aimed
      const patLossNode = e.pattern.directional || e.pattern.hpbwEl < 360
        ? patternLossDb({
            offAzDeg: e.pattern.directional ? angDiff(brNodeToVeh, e.node.azimuthDeg) : 0,
            offElDeg: Math.abs(elAngle - (e.node.tiltDeg || 0)),
            hpbwAz: e.pattern.hpbwAz, hpbwEl: e.pattern.hpbwEl,
          })
        : 0;

      // Vehicle antenna. An omni pays only the elevation cut. A directional one
      // either tracks the serving node (gimbal/auto-align → on boresight) or is
      // fixed to the hull, in which case it points along the course over ground
      // and pays for however far off that the node is.
      const vehOffAz = !vehicle.pattern.directional ? 0
        : vehicle.tracking ? 0
        : angDiff(s.courseDeg, brNodeToVeh + 180);
      const patLossVeh = (vehicle.pattern.directional || vehicle.pattern.hpbwEl < 360)
        ? patternLossDb({
            offAzDeg: vehOffAz,
            offElDeg: Math.abs(elAngle),
            hpbwAz: vehicle.pattern.hpbwAz, hpbwEl: vehicle.pattern.hpbwEl,
          })
        : 0;

      const fspl = 32.45 + 20 * Math.log10(Math.max(D, 1) / 1000) + 20 * Math.log10(e.node.freqMhz);
      const totalLoss = fspl + pa.diffractionLossDb;
      const gains = e.node.antennaGain - patLossNode + vehicle.antennaGain - patLossVeh
                  - e.node.cableLoss - vehicle.cableLoss + e.node.bdaGain + vehicle.bdaGain;

      const antennas = (e.radio.chains === 1 || vehicle.radio.chains === 1) ? 1 : 2;
      const maxMcs = antennas === 2 ? 16 : 8;
      const bw = Math.min(e.node.bwMhz, vehicle.bwMhz);
      let best = null;
      for (let m = 0; m < maxMcs; m++) {
        // worst of the two directions governs a bidirectional link
        const txN = txPowerDbm(e.radio, e.node.powerDbm, m, antennas);
        const txV = txPowerDbm(vehicle.radio, vehicle.powerDbm, m, antennas);
        const rssi = Math.min(txN, txV) + gains - totalLoss;
        const margin = rssi - sensitivityDbm(m, bw);
        const mbps = throughputMbps(m, bw);
        if (margin >= fadeMarginDb && (!best || mbps > best.mbps)) {
          best = { mcs: m, mbps, rssi, margin };
        }
      }
      const cand = {
        nodeId: e.node.id, label: e.node.label, distM: D,
        losBlocked: pa.losBlocked, fresnelIntruded: pa.fresnelIntruded,
        diffractionDb: pa.diffractionLossDb, patternLossNodeDb: patLossNode,
        ...(best || {
          mcs: -1, mbps: 0,
          rssi: Math.min(...txMin(e, vehicle, antennas)) + gains - totalLoss,
          margin: Math.min(...txMin(e, vehicle, antennas)) + gains - totalLoss - sensitivityDbm(0, bw),
        }),
      };
      s.candidates.push(cand);
      if (best && (!s.best || cand.mbps > s.best.mbps || (cand.mbps === s.best.mbps && cand.margin > s.best.margin))) {
        s.best = cand;
      }
    }
  }

  // ---- structure: serving node per stretch, handovers, per-node share
  // Distances are trapezoidal: interior samples carry a full step, the two end
  // samples carry half a step each, so the weights sum to exactly the route length.
  const step = samples.length > 1 ? totalM / (samples.length - 1) : 0;
  const weightAt = (i) => (i === 0 || i === samples.length - 1 ? step / 2 : step);

  const servingNodes = new Map();
  const handovers = [];
  let prevId = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const id = s.best ? s.best.nodeId : null;
    if (id !== prevId) {
      if (prevId !== null || id !== null) handovers.push({ distM: s.distM, from: prevId, to: id, label: s.best?.label ?? null });
      prevId = id;
    }
    if (id !== null) {
      const cur = servingNodes.get(id) || { nodeId: id, label: s.best.label, samples: 0, metres: 0 };
      cur.samples++;
      cur.metres += weightAt(i);
      servingNodes.set(id, cur);
    }
  }

  // ---- coverage/bandwidth statistics
  let coveredM = 0, aboveTargetM = 0, belowTerrainM = 0, mbpsSum = 0, mbpsN = 0;
  let minMbps = Infinity, maxMbps = 0, worstGap = 0, gap = 0, gapStart = null, worstGapStart = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const w = weightAt(i);
    const mbps = s.best ? s.best.mbps : 0;
    if (s.belowTerrain) belowTerrainM += w;
    if (s.best) {
      coveredM += w;
      mbpsSum += mbps; mbpsN++;
      if (mbps < minMbps) minMbps = mbps;
      if (mbps > maxMbps) maxMbps = mbps;
      if (mbps >= targetMbps) aboveTargetM += w;
      if (gap > worstGap) { worstGap = gap; worstGapStart = gapStart; }
      gap = 0; gapStart = null;
    } else {
      if (gapStart === null) gapStart = s.distM;
      gap += w;
    }
  }
  if (gap > worstGap) { worstGap = gap; worstGapStart = gapStart; }

  const stats = {
    totalM, sampleCount: samples.length, spacingM: step,
    coveredM, coveragePct: totalM ? (100 * coveredM) / totalM : 0,
    aboveTargetM, aboveTargetPct: totalM ? (100 * aboveTargetM) / totalM : 0, targetMbps,
    belowTerrainM,
    minMbps: mbpsN ? minMbps : 0, maxMbps, meanMbps: mbpsN ? mbpsSum / mbpsN : 0,
    worstGapM: worstGap, worstGapStartM: worstGapStart,
    handoverCount: handovers.filter((h) => h.from !== null && h.to !== null).length,
    servingNodes: [...servingNodes.values()].map((v) => ({
      ...v, pct: totalM ? (100 * v.metres) / totalM : 0,
    })).sort((a, b) => b.metres - a.metres),
    compatibleNodeCount: compatible.length,
    skippedNodeCount: infra.length - compatible.length,
    vehicleMode: vehicle.mode, vehicleAltM: vehicle.mode === 'asl' ? vehicle.altM : vehicle.heightM,
  };

  // ---- map segments coloured by achievable rate
  const segments = [];
  let run = null;
  for (const s of samples) {
    const mbps = s.best ? s.best.mbps : 0;
    const c = colorForMbps(mbps);
    const key = c.join(',');
    if (!run || run.key !== key) {
      if (run) { run.coords.push([s.lng, s.lat]); segments.push(run); }
      run = { key, color: `rgb(${key})`, mbps, coords: [[s.lng, s.lat]] };
    } else {
      run.coords.push([s.lng, s.lat]);
    }
  }
  if (run && run.coords.length > 1) segments.push(run);

  return { samples, stats, segments, handovers, servingNodes: stats.servingNodes };
}

function txMin(e, vehicle, antennas) {
  return [txPowerDbm(e.radio, e.node.powerDbm, 0, antennas), txPowerDbm(vehicle.radio, vehicle.powerDbm, 0, antennas)];
}

function totalGuess(waypoints) {
  let t = 0;
  for (let i = 0; i < waypoints.length - 1; i++) t += haversineM(waypoints[i], waypoints[i + 1]);
  return t;
}

// ---------------------------------------------------------------------------
// Coordinate parsing for pasted waypoint lists
// ---------------------------------------------------------------------------

/**
 * Parse pasted coordinates. Accepts one waypoint per line in any of:
 *   40.0150, -105.2705
 *   40.0150 -105.2705
 *   -105.2705, 40.0150      (when lonFirst is true)
 *   40 01.5 N, 105 16.2 W   (degrees + decimal minutes)
 *   40°01'30"N 105°16'12"W  (degrees/minutes/seconds)
 * Returns { waypoints, errors }.
 */
export function parseCoordinates(text, lonFirst = false) {
  const waypoints = [];
  const errors = [];
  const lines = text.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const dms = [...line.matchAll(/(-?\d+(?:\.\d+)?)[°\s:]+(\d+(?:\.\d+)?)?['′\s:]*(\d+(?:\.\d+)?)?["″]?\s*([NSEW])/gi)];
    if (dms.length >= 2) {
      const vals = dms.slice(0, 2).map((m) => {
        const deg = parseFloat(m[1]);
        const min = m[2] ? parseFloat(m[2]) : 0;
        const sec = m[3] ? parseFloat(m[3]) : 0;
        const hemi = m[4].toUpperCase();
        let v = Math.abs(deg) + min / 60 + sec / 3600;
        if (hemi === 'S' || hemi === 'W') v = -v;
        return { v, hemi };
      });
      const lat = vals.find((x) => x.hemi === 'N' || x.hemi === 'S');
      const lng = vals.find((x) => x.hemi === 'E' || x.hemi === 'W');
      if (lat && lng) { waypoints.push({ lat: lat.v, lng: lng.v }); continue; }
    }
    const nums = [...line.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
    if (nums.length >= 2) {
      let lat = lonFirst ? nums[1] : nums[0];
      let lng = lonFirst ? nums[0] : nums[1];
      // if the pair is unambiguous the wrong way round, fix it
      if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) { const t = lat; lat = lng; lng = t; }
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) { waypoints.push({ lat, lng }); continue; }
    }
    errors.push(line.slice(0, 40));
  }
  return { waypoints, errors };
}
