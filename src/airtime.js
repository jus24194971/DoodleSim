// Airtime, congestion and traffic-capacity model for Mesh Rider links.
//
// Design and original implementation: Aaron Do, Doodle Labs Solutions Engineering
// ("Mesh Rider Link Budget + Airtime Estimator"). Ported here from his standalone
// tool so the same maths runs against DoodleSim's terrain-aware path loss and full
// radio library instead of a flat free-space assumption.
//
// What his model contributes that the rest of DoodleSim does not have: a link that
// closes is not the same as a link that carries the offered traffic. This computes
// how much of the medium each flow actually consumes, including the overheads that
// make real throughput fall well short of the PHY rate - ACK and interframe time,
// retries, Batman routing chatter, broadcast replication, and the burst a video
// I-frame imposes once per GOP.
//
// Two of his conventions are preserved deliberately and documented where they sit:
// per-chain transmit power, and the fixed multicast rate for broadcast traffic.

// 802.11n MCS0-15 PHY rates at 20 MHz, long guard interval. MCS8-15 are the
// two-stream rates, which is why they are roughly double their 0-7 counterparts.
export const MCS_BASE_RATE_20MHZ = {
  0: 6.5, 1: 13, 2: 19.5, 3: 26, 4: 39, 5: 52, 6: 58.5, 7: 65,
  8: 13, 9: 26, 10: 39, 11: 52, 12: 78, 13: 104, 14: 117, 15: 130,
};

const SPEED_OF_LIGHT_MPS = 299_792_458;

// Airtime bands used for the status colouring. Above 75% a shared medium is
// effectively saturated once contention and retries are accounted for.
export const AIRTIME_WARN_PERCENT = 50;
export const AIRTIME_BAD_PERCENT = 75;

// ---------------------------------------------------------------- radio basis
//
// The two sources disagree, and the disagreement is smaller than it first looks.
//
//   'datasheet' - Aaron's basis. The datasheet's Combined Output Power column,
//                 divided by chain count to give per-chain, paired with the
//                 datasheet's per-chain sensitivity row.
//   'estimator' - DoodleSim's existing basis, reverse engineered from the official
//                 Range Estimation Tool. Per-chain power plus 3 dB for two
//                 antennas, paired with a sensitivity row 3 dB higher.
//
// Because each basis shifts power and sensitivity in opposite directions, the
// resulting link budgets agree to 0.01 dB at MCS0 and differ by exactly 2.01 dB at
// MCS1-7, with 'estimator' the more optimistic. That residual is a transmit-power
// disagreement, not a sensitivity one: the estimator implies 31 dBm combined at
// MCS1 where the datasheet prints 29 dBm. The same datasheet also publishes two
// power figures 1 dB apart, so this is unresolved in Doodle Labs' own documentation
// and is flagged in the UI rather than silently averaged.
export const BASIS = {
  datasheet: {
    label: 'Datasheet (Aaron Do)',
    note: 'Combined output power from the datasheet, normalised per chain. More conservative at MCS1-7.',
    // combined dBm, MCS0-7, as printed in the Combined Output Power column
    combinedPower: [32, 29, 29, 29, 28, 27, 26, 24],
    sens: [-90, -88, -86, -84, -80, -76, -74, -72],
    perChain: true,
  },
  estimator: {
    label: 'Range Estimation Tool',
    note: 'Per-chain power plus 3 dB for two antennas, as the official estimator computes it. 2 dB more optimistic at MCS1-7.',
    perChainPower: [29, 28, 28, 28, 27, 26, 25, 23],
    sens: [-87, -85, -83, -81, -77, -73, -71, -69],
    perChain: false,
  },
};

/** Sensitivity scales with bandwidth: half the bandwidth, half the noise power. */
export function scaleSensitivity(sensAt20, bandwidthMhz) {
  return sensAt20 + 10 * Math.log10(bandwidthMhz / 20);
}

export function mcsRateMbps(mcs, bandwidthMhz) {
  return (MCS_BASE_RATE_20MHZ[mcs] ?? 6.5) * (bandwidthMhz / 20);
}

export function fsplDb(freqMhz, distanceKm) {
  return 32.44 + 20 * Math.log10(Math.max(freqMhz, 1)) + 20 * Math.log10(Math.max(distanceKm, 0.001));
}

/**
 * Transmit and sensitivity figures for one MCS under the chosen basis.
 * `chains` only affects the datasheet basis, where combined power is divided down.
 */
export function radioFigures(basisKey, mcs, bandwidthMhz, chains = 2) {
  const b = BASIS[basisKey] || BASIS.datasheet;
  const i = mcs % 8;
  const streamPenalty = mcs >= 8 ? 3 : 0;
  let txDbm;
  if (b.perChain) {
    // Aaron's normalisation: the datasheet quotes the sum across ports, so divide
    // by chain count to recover what one chain radiates.
    txDbm = b.combinedPower[i] - 10 * Math.log10(Math.max(1, chains));
  } else {
    txDbm = b.perChainPower[i] + (chains === 2 ? 3 : 0);
  }
  const sens = scaleSensitivity(b.sens[i] + streamPenalty, bandwidthMhz);
  return { txDbm, sensDbm: sens };
}

/**
 * Highest MCS whose margin clears the fade requirement.
 *
 * pathLossDb is supplied by the caller, which is the whole point of the port: pass
 * DoodleSim's terrain-aware loss (near-ground term, Fresnel, diffraction) and the
 * airtime model inherits it. Pass fsplDb() to reproduce Aaron's original tool.
 */
export function chooseBestMcs({ pathLossDb, txGainDbi = 0, rxGainDbi = 0, bandwidthMhz = 20,
                                fadeMarginDb = 0, basis = 'datasheet', chains = 2,
                                maxMcs = 15, configuredMaxDbm = null }) {
  let fallback = null;
  for (let mcs = maxMcs; mcs >= 0; mcs--) {
    if (mcs >= 8 && chains < 2) continue;           // no second stream on a SISO part
    const { txDbm, sensDbm } = radioFigures(basis, mcs, bandwidthMhz, chains);
    const tx = configuredMaxDbm == null ? txDbm : Math.min(txDbm, configuredMaxDbm);
    const rxDbm = tx + txGainDbi + rxGainDbi - pathLossDb;
    const marginDb = rxDbm - sensDbm - fadeMarginDb;
    const row = { mcs, txDbm: tx, rxDbm, sensDbm, marginDb,
                  phyRateMbps: mcsRateMbps(mcs, bandwidthMhz) };
    if (marginDb >= 0) return row;
    fallback = row;                                  // remember the lowest attempt
  }
  // Nothing closes. Return the MCS0 attempt with its negative margin so the caller
  // can show how far short the link is rather than just failing.
  return fallback || { mcs: 0, txDbm: 0, rxDbm: -999, sensDbm: 0, marginDb: -999,
                       phyRateMbps: mcsRateMbps(0, bandwidthMhz) };
}

// ---------------------------------------------------------------- airtime
//
// Aaron's per-packet airtime. Preserved as written, including the constants:
//   preamble 40 us, broadcast trailer 20 us, ACK 22 us + 14 bytes at the multicast
//   rate, SIFS+DIFS 16+34 us, and two-way time of flight.
export function packetAirtimeSeconds(payloadBytes, phyRateMbps, isUnicast, opts = {}) {
  const {
    headerOverheadBytes = 60,
    multicastRate20Mbps = 6.5,
    bandwidthMhz = 20,
    distanceM = 0,
  } = opts;
  const rate = Math.max(phyRateMbps, 0.5);
  const overAirBytes = payloadBytes + headerOverheadBytes;
  const preambleUs = 40;
  const dataUs = (overAirBytes * 8) / rate;

  if (!isUnicast) return (preambleUs + dataUs + 20) / 1e6;

  const ackRate = Math.max(multicastRate20Mbps * (bandwidthMhz / 20), 2);
  const ackUs = 22 + (14 * 8) / ackRate;
  const interframeUs = 16 + 34;                       // SIFS + DIFS
  const tofUsOneWay = (Math.max(distanceM, 0) / SPEED_OF_LIGHT_MPS) * 1e6;
  return (preambleUs + dataUs + ackUs + interframeUs + 2 * tofUsOneWay) / 1e6;
}

/** Retries multiply airtime: a 10% loss means every packet costs 1/0.9 of its time. */
export function retryFactor(packetLossFraction) {
  const loss = Math.min(Math.max(packetLossFraction || 0, 0), 0.95);
  return 1 / (1 - loss);
}

export function effectiveThroughputMbps(payloadBytes, phyRateMbps, isUnicast, opts = {}, retries = 1) {
  const airtime = packetAirtimeSeconds(payloadBytes, phyRateMbps, isUnicast, opts);
  const denom = Math.max(airtime * Math.max(retries, 1), 1e-9);
  return ((payloadBytes * 8) / denom) / 1e6;
}

// ---------------------------------------------------------------- traffic
//
// Video burst model. A GOP is one I-frame plus (gop-1) P-frames; the I-frame is
// `iFrameMultiplier` times larger than a P-frame. Solving for frame sizes gives
// both the average packet rate and the peak rate during the I-frame, which is what
// actually saturates a link - an average-only figure hides the stall the viewer sees.
export function videoProfile({ bitrateMbps, fps, gop, iFrameMultiplier = 6, payloadBytes = 1200 }) {
  const f = Math.max(fps || 30, 1);
  const g = Math.max(Math.round(gop || f), 1);
  const mult = Math.max(iFrameMultiplier || 1, 1);
  const bitsPerGop = (bitrateMbps * 1e6) * (g / f);
  // bitsPerGop = I + (g-1)*P, with I = mult*P
  const pBits = bitsPerGop / (mult + (g - 1));
  const iBits = pBits * mult;
  const bytesPerPacket = Math.max(payloadBytes, 64);
  const avgPps = (bitsPerGop / 8) / bytesPerPacket / (g / f);
  // the I-frame has to clear inside one frame interval
  const peakPps = (iBits / 8) / bytesPerPacket * f;
  return { avgPps, peakPps, payloadBytes: bytesPerPacket,
           iFrameBytes: Math.round(iBits / 8), pFrameBytes: Math.round(pBits / 8) };
}

export function constantProfile({ pps, payloadBytes = 1200 }) {
  return { avgPps: Math.max(pps || 0, 0), peakPps: Math.max(pps || 0, 0),
           payloadBytes: Math.max(payloadBytes, 64) };
}

// ---------------------------------------------------------------- flows
//
// Mesh-mode overheads, Aaron's values:
//   Batman replicates broadcast three times, and every node emits an OGM once per
//   interval (default 1 s). WDS does neither.
export const MESH_MODES = {
  batman: { label: 'Batman (mesh)', broadcastReplication: 3, ogm: true },
  wds: { label: 'WDS AP/Client', broadcastReplication: 1, ogm: false },
};

/**
 * Airtime for one traffic flow.
 * `link` is the result of chooseBestMcs (or anything carrying phyRateMbps).
 */
export function flowAirtime({ profile, link, isUnicast = true, meshMode = 'batman',
                              packetLoss = 0.1, opts = {} }) {
  const mode = MESH_MODES[meshMode] || MESH_MODES.batman;
  const replication = isUnicast ? 1 : mode.broadcastReplication;
  const retries = isUnicast ? retryFactor(packetLoss) : 1;   // broadcast is not ACKed
  const per = packetAirtimeSeconds(profile.payloadBytes, link.phyRateMbps, isUnicast, opts);
  const avgFraction = per * profile.avgPps * retries * replication;
  const peakFraction = per * profile.peakPps * retries * replication;
  return {
    perPacketSeconds: per,
    avgPercent: avgFraction * 100,
    peakPercent: peakFraction * 100,
    goodputMbps: (profile.payloadBytes * 8 * profile.avgPps) / 1e6,
    retries, replication,
  };
}

/** Batman routing chatter: every node emits an OGM per interval to every neighbour. */
export function ogmAirtimePercent({ nodes, ogmIntervalS = 1, phyRateMbps, opts = {},
                                    ogmBytes = 52 }) {
  const n = Math.max(nodes || 0, 0);
  if (n < 2) return 0;
  const per = packetAirtimeSeconds(ogmBytes, phyRateMbps, false, opts);
  return per * (n / Math.max(ogmIntervalS, 0.05)) * 100;
}

export function airtimeStatus(percent) {
  if (percent >= AIRTIME_BAD_PERCENT) return 'bad';
  if (percent >= AIRTIME_WARN_PERCENT) return 'warn';
  return 'ok';
}

/**
 * Whole-link summary: does it close, and does it carry the traffic?
 * Those are separate questions and the answer is often yes to the first, no to the
 * second - which is precisely the failure customers report as "poor throughput".
 */
export function analyseLink({ pathLossDb, distanceM = 0, freqMhz = 2450, bandwidthMhz = 20,
                              txGainDbi = 3, rxGainDbi = 3, fadeMarginDb = 12,
                              basis = 'datasheet', chains = 2, configuredMaxDbm = null,
                              flows = [], meshMode = 'batman', packetLoss = 0.1,
                              nodes = 2, ogmIntervalS = 1,
                              headerOverheadBytes = 60, multicastRate20Mbps = 6.5 }) {
  const loss = pathLossDb != null ? pathLossDb : fsplDb(freqMhz, distanceM / 1000);
  const link = chooseBestMcs({ pathLossDb: loss, txGainDbi, rxGainDbi, bandwidthMhz,
                               fadeMarginDb, basis, chains, configuredMaxDbm });
  const opts = { headerOverheadBytes, multicastRate20Mbps, bandwidthMhz, distanceM };

  const rows = flows.map((f) => {
    const profile = f.kind === 'video' ? videoProfile(f) : constantProfile(f);
    const a = flowAirtime({ profile, link, isUnicast: f.isUnicast !== false,
                            meshMode, packetLoss, opts });
    return { ...f, profile, ...a };
  });

  const ogmPercent = MESH_MODES[meshMode]?.ogm
    ? ogmAirtimePercent({ nodes, ogmIntervalS, phyRateMbps: link.phyRateMbps, opts })
    : 0;
  const avgPercent = rows.reduce((s, r) => s + r.avgPercent, 0) + ogmPercent;
  const peakPercent = rows.reduce((s, r) => s + r.peakPercent, 0) + ogmPercent;
  const offeredMbps = rows.reduce((s, r) => s + r.goodputMbps, 0);

  // Capacity headroom: what a single saturating unicast flow could carry here.
  const capacityMbps = effectiveThroughputMbps(1500, link.phyRateMbps, true, opts,
                                               retryFactor(packetLoss));

  return {
    pathLossDb: loss, link, rows, ogmPercent,
    avgPercent, peakPercent, offeredMbps, capacityMbps,
    status: airtimeStatus(peakPercent),
    closes: link.marginDb >= 0,
    headroomMbps: Math.max(capacityMbps - offeredMbps, 0),
  };
}
