// Distance and position from signal strength, for radios with no GPS.
//
// Most Mesh Rider units do not carry GPS, so geometry has to come out of the
// link budget: measured RSSI + known TX power and antenna gains imply a path
// loss, and a propagation model turns that into a distance.
//
// The honest part is the uncertainty. Every dB of doubt about antenna gain,
// cable loss, TX tolerance or fading becomes a MULTIPLICATIVE distance error,
// so results are always returned as a band, never a single number.

import { haversineM, bearingDeg, destination } from './terrain.js';

// Path-loss models expressed as PL = A(f) + 10*n*log10(d_m)
//   free space : n = 2.00  (20.0 dB/decade)
//   near ground: n = 2.225 (22.25 dB/decade), fitted to the official Doodle Labs
//                near-ground behaviour; less distance-sensitive per dB of error
const GROUND_A = [[250, 36.07], [500, 40.70], [915, 43.25], [1000, 43.66],
                  [2000, 44.62], [2450, 44.75], [4000, 46.06], [5800, 48.05]];

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

export const MODELS = {
  fspl: {
    label: 'Free space (clear line of sight)',
    n: 2.0,
    A: (f) => 32.45 + 20 * Math.log10(f) - 60, // -60 converts km to m
    note: 'Attributes every dB of loss to distance, so it gives an UPPER bound: '
        + 'any obstruction means the radios are closer than this.',
  },
  ground: {
    label: 'Near ground (ground platforms, cluttered)',
    n: 2.225,
    A: (f) => groundA(f),
    note: 'Doodle Labs’ conservative near-ground behaviour. Appropriate when both '
        + 'ends are low to the ground; returns a shorter distance for the same signal.',
  },
};

/**
 * Path loss implied by a measurement.
 * PL = TX + Gtx + Grx - cable losses - RSSI
 */
export function impliedPathLossDb({ rssiDbm, txDbm, txGainDbi = 0, rxGainDbi = 0,
                                    cableLossDb = 0, bdaGainDb = 0 }) {
  return txDbm + txGainDbi + rxGainDbi + bdaGainDb - cableLossDb - rssiDbm;
}

/**
 * Distance implied by a measured receive level.
 *
 * uncertaintyDb is the total 1-sigma doubt in the budget (gains, cable, TX
 * tolerance, RSSI reporting, fading). It maps to a distance factor of
 * 10^(U / (10*n)) — which is why a 6 dB doubt is a factor of two in free space.
 *
 * Returns { m, loM, hiM, plDb, factor, model }.
 */
export function impliedRangeM(opts) {
  const { freqMhz, model = 'fspl', uncertaintyDb = 6 } = opts;
  const M = MODELS[model] || MODELS.fspl;
  const pl = impliedPathLossDb(opts);
  const dB10n = 10 * M.n;
  const m = 10 ** ((pl - M.A(freqMhz)) / dB10n);
  const factor = 10 ** (uncertaintyDb / dB10n);
  return {
    m, loM: m / factor, hiM: m * factor,
    plDb: pl, factor, model, n: M.n, uncertaintyDb,
  };
}

/** Inverse: the level you would expect at a known distance (for validation). */
export function expectedRssiDbm({ distM, freqMhz, txDbm, txGainDbi = 0, rxGainDbi = 0,
                                  cableLossDb = 0, bdaGainDb = 0, model = 'fspl',
                                  excessLossDb = 0 }) {
  const M = MODELS[model] || MODELS.fspl;
  const pl = M.A(freqMhz) + 10 * M.n * Math.log10(Math.max(distM, 1)) + excessLossDb;
  return txDbm + txGainDbi + rxGainDbi + bdaGainDb - cableLossDb - pl;
}

/**
 * Averaging the two directions of a link cancels part of the equipment error and
 * exposes the rest. On a reciprocal channel both directions must imply the same
 * path loss; the difference is equipment, not propagation.
 */
export function reciprocalPathLoss(aToB, bToA) {
  const pl1 = impliedPathLossDb(aToB);
  const pl2 = impliedPathLossDb(bToA);
  return {
    meanPlDb: (pl1 + pl2) / 2,
    errorDb: pl1 - pl2,
    note: Math.abs(pl1 - pl2) > 4
      ? 'The two directions disagree by more than 4 dB. On a reciprocal channel that is an '
      + 'equipment difference (antenna, cable or TX calibration), not propagation — resolve it '
      + 'before trusting a distance derived from either direction alone.'
      : 'Both directions agree, so the averaged path loss is a sound basis for a distance estimate.',
  };
}

// ---------------------------------------------------------------------------
// Position from several ranges
// ---------------------------------------------------------------------------

function toLocal(origin, p) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (p.lng - origin.lng) * mPerDegLng, y: (p.lat - origin.lat) * mPerDegLat };
}
function fromLocal(origin, x, y) {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  return { lng: origin.lng + x / mPerDegLng, lat: origin.lat + y / mPerDegLat };
}

/**
 * Least-squares position from range circles, solved in LOG distance space because
 * the errors are multiplicative. Grid search then refine — no dependencies, and
 * robust with only two or three anchors.
 *
 * anchors: [{ lng, lat, rangeM, weight? }]
 * Returns { best:{lng,lat}, residualDb, spreadM, candidates, anchorsUsed }
 */
export function locateFromRanges(anchors, opts = {}) {
  const used = anchors.filter((a) => a.rangeM > 0);
  if (used.length === 0) return null;
  const origin = { lng: used[0].lng, lat: used[0].lat };
  const pts = used.map((a) => ({ ...toLocal(origin, a), r: a.rangeM, w: a.weight ?? 1 }));

  // cost in log-distance space: mismatch in dB-equivalent terms
  const cost = (x, y) => {
    let s = 0;
    for (const p of pts) {
      const d = Math.max(Math.hypot(x - p.x, y - p.y), 1);
      const e = Math.log10(d / p.r);
      s += p.w * e * e;
    }
    return s;
  };

  const maxR = Math.max(...pts.map((p) => p.r));
  let span = maxR * 2.2;
  let cx = pts.reduce((t, p) => t + p.x, 0) / pts.length;
  let cy = pts.reduce((t, p) => t + p.y, 0) / pts.length;

  // coarse-to-fine grid search
  for (let iter = 0; iter < 7; iter++) {
    const step = span / 12;
    let bx = cx, by = cy, bc = Infinity;
    for (let gx = -6; gx <= 6; gx++) {
      for (let gy = -6; gy <= 6; gy++) {
        const x = cx + gx * step, y = cy + gy * step;
        const c = cost(x, y);
        if (c < bc) { bc = c; bx = x; by = y; }
      }
    }
    cx = bx; cy = by; span = step * 3;
  }

  // residual expressed in dB so it is comparable with the budget uncertainty
  let sum = 0;
  for (const p of pts) {
    const d = Math.max(Math.hypot(cx - p.x, cy - p.y), 1);
    sum += (10 * 2.0 * Math.log10(d / p.r)) ** 2;
  }
  const residualDb = Math.sqrt(sum / pts.length);

  // with two anchors the solution is ambiguous: report both mirror points
  const candidates = [];
  if (used.length === 2) {
    const [p0, p1] = pts;
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const D = Math.hypot(dx, dy) || 1;
    const a = (p0.r * p0.r - p1.r * p1.r + D * D) / (2 * D);
    const h2 = p0.r * p0.r - a * a;
    if (h2 > 0) {
      const h = Math.sqrt(h2);
      const mx = p0.x + (a * dx) / D, my = p0.y + (a * dy) / D;
      candidates.push(fromLocal(origin, mx + (h * dy) / D, my - (h * dx) / D));
      candidates.push(fromLocal(origin, mx - (h * dy) / D, my + (h * dx) / D));
    }
  }

  return {
    best: fromLocal(origin, cx, cy),
    residualDb,
    anchorsUsed: used.length,
    candidates,
    spreadM: used.reduce((t, a, i) => {
      const d = Math.hypot(cx - pts[i].x, cy - pts[i].y);
      return t + Math.abs(d - a.rangeM);
    }, 0) / used.length,
  };
}

// Deterministic PRNG so the same inputs always produce the same confidence
// region — a sales figure should not jitter between runs.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gauss(rnd) {
  const u = Math.max(rnd(), 1e-9), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Position plus an honest confidence region.
 *
 * The least-squares residual is a poor uncertainty proxy when there are only two
 * or three anchors — the fit simply absorbs the error. Instead this perturbs every
 * range within its dB uncertainty many times and reports how far the resulting fix
 * actually moves.
 *
 * Returns { best, r68M, r95M, cloud, anchorsUsed, ambiguous }
 */
export function locateWithUncertainty(anchors, opts = {}) {
  const { uncertaintyDb = 6, n = 2.0, trials = 120, seed = 12345 } = opts;
  const base = locateFromRanges(anchors);
  if (!base) return null;
  const rnd = lcg(seed);
  const dB10n = 10 * n;
  const cloud = [];
  const dists = [];
  for (let t = 0; t < trials; t++) {
    const perturbed = anchors.map((a) => ({
      ...a,
      rangeM: a.rangeM * 10 ** ((gauss(rnd) * uncertaintyDb) / dB10n),
    }));
    const f = locateFromRanges(perturbed);
    if (!f) continue;
    cloud.push(f.best);
    dists.push(haversineM(base.best, f.best));
  }
  dists.sort((a, b) => a - b);
  const pick = (q) => (dists.length ? dists[Math.min(dists.length - 1, Math.floor(q * dists.length))] : 0);
  return {
    ...base,
    r68M: pick(0.68),
    r95M: pick(0.95),
    cloud,
    ambiguous: anchors.filter((a) => a.rangeM > 0).length < 3,
  };
}

/** Circle of points for drawing a range ring. */
export function ringCoords(center, radiusM, steps = 96) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const p = destination(center.lng, center.lat, (i * 360) / steps, radiusM);
    out.push([p.lng, p.lat]);
  }
  return out;
}

/** Annulus (lo..hi) as a polygon with a hole, for the uncertainty band. */
export function annulusCoords(center, loM, hiM) {
  return [ringCoords(center, hiM), ringCoords(center, loM).slice().reverse()];
}

export { haversineM, bearingDeg };
