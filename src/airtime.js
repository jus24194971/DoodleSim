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

import { sensedNoisePenaltyDb, senseOverheadPercent,
         interMeshOverheadPercent } from './licensed.js';

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
                                maxMcs = 15, configuredMaxDbm = null, rateDerate = 0,
                                noisePenaltyDb = 0 }) {
  // Marginal planning takes its haircut off the PHY rate here, at the one place the
  // rate enters the model. Everything downstream - per-packet airtime, the percentage
  // of the medium, spare capacity - is derived from this figure, so deflating it once
  // makes the whole panel pessimistic rather than just the headline number.
  const derateRate = (r) => (rateDerate > 0 && rateDerate < 1 ? r * (1 - rateDerate) : r);
  let fallback = null;
  for (let mcs = maxMcs; mcs >= 0; mcs--) {
    if (mcs >= 8 && chains < 2) continue;           // no second stream on a SISO part
    const { txDbm, sensDbm: rawSens } = radioFigures(basis, mcs, bandwidthMhz, chains);
    // Published sensitivities assume a thermally quiet receiver. A noisy site raises
    // the level every rate needs by the excess over thermal, which is the number
    // Sense claws back.
    const sensDbm = rawSens + Math.max(0, noisePenaltyDb);
    const tx = configuredMaxDbm == null ? txDbm : Math.min(txDbm, configuredMaxDbm);
    const rxDbm = tx + txGainDbi + rxGainDbi - pathLossDb;
    const marginDb = rxDbm - sensDbm - fadeMarginDb;
    const row = { mcs, txDbm: tx, rxDbm, sensDbm, marginDb,
                  phyRateMbps: derateRate(mcsRateMbps(mcs, bandwidthMhz)) };
    if (marginDb >= 0) return row;
    fallback = row;                                  // remember the lowest attempt
  }
  // Nothing closes. Return the MCS0 attempt with its negative margin so the caller
  // can show how far short the link is rather than just failing.
  return fallback || { mcs: 0, txDbm: 0, rxDbm: -999, sensDbm: 0, marginDb: -999,
                       phyRateMbps: derateRate(mcsRateMbps(0, bandwidthMhz)) };
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

// ================================================================ multi-flow
//
// A real drone link never carries one stream. It carries video down, command and
// control both ways, telemetry down, and often a management session - each with its
// own protocol, direction and bitrate.
//
// Why this needs modelling rather than adding up bitrates: Mesh Rider is TDD
// half-duplex on a single channel, so every direction of every flow contends for the
// SAME airtime. A 4 Mbps downlink and a 200 kbps uplink are not independent budgets;
// they sum. And a TCP flow that looks one-way is not one-way on the air, because its
// acknowledgements are real frames in the reverse direction paying full preamble,
// interframe and 802.11-ACK cost. Small in bits, far from small in airtime.

export const PROTOCOLS = {
  udp: {
    label: 'UDP',
    note: 'No transport acknowledgement. Loss shows up as artefacts or a missed command, '
        + 'not as retransmission. Airtime is what you send.',
    ackRatio: 0,
  },
  tcp: {
    label: 'TCP',
    // Delayed ACK: one acknowledgement per two data segments is the common case.
    note: 'Every two data segments draw an acknowledgement in the reverse direction. '
        + 'Those are tiny packets but full-price airtime, so a one-way TCP transfer '
        + 'still loads the return path.',
    ackRatio: 0.5,
    ackBytes: 64,
  },
};

export const DIRECTIONS = {
  down: { label: 'Downlink only (air to ground)', forward: 0, reverse: 1 },
  up: { label: 'Uplink only (ground to air)', forward: 1, reverse: 0 },
  bi: { label: 'Bidirectional', forward: 1, reverse: 1 },
};

// The suggestion library. Each entry carries the protocol and directionality the
// traffic actually uses in a UAS deployment, with the reason stated - the point is to
// stop a video downlink being modelled as bidirectional, or C2 as one-way.
export const TRAFFIC_PRESETS = [
  {
    id: 'h264-video', group: 'Video', label: 'H.264 video downlink',
    protocol: 'udp', direction: 'down', kind: 'video',
    bitrateMbps: 4, fps: 30, gop: 30, iFrameMultiplier: 6, payloadBytes: 1200,
    why: 'H.264 over RTP/UDP from the aircraft. Effectively one-way - the ground station '
       + 'sends nothing back on this stream. A retransmission would arrive too late to be '
       + 'useful, which is why it is UDP.',
  },
  {
    id: 'h265-video', group: 'Video', label: 'H.265 video downlink',
    protocol: 'udp', direction: 'down', kind: 'video',
    bitrateMbps: 2, fps: 30, gop: 30, iFrameMultiplier: 6, payloadBytes: 1200,
    why: 'H.265 gives roughly the same picture as H.264 at about half the bitrate, so it is '
       + 'the first lever to pull when airtime is tight. Same one-way UDP behaviour.',
  },
  {
    id: 'video-2stream', group: 'Video', label: 'Dual camera downlink',
    protocol: 'udp', direction: 'down', kind: 'video',
    bitrateMbps: 8, fps: 30, gop: 30, iFrameMultiplier: 6, payloadBytes: 1200,
    why: 'Two feeds multiplexed. The I-frames of both cameras can align and burst together, '
       + 'which is the case that saturates a link that looked fine on averages.',
  },
  {
    id: 'rtsp-ctl', group: 'Video', label: 'RTSP session control',
    protocol: 'tcp', direction: 'bi', kind: 'constant',
    pps: 2, payloadBytes: 200, reverseScale: 1,
    why: 'The control channel beside the stream - PLAY, PAUSE, keepalive. Tiny, TCP, and '
       + 'genuinely bidirectional. Negligible bits, but a real reverse-path talker.',
  },
  {
    id: 'mavlink', group: 'Command and control', label: 'MAVLink telemetry + commands',
    protocol: 'udp', direction: 'bi', kind: 'constant',
    pps: 50, payloadBytes: 90, reverseScale: 0.25,
    why: 'Genuinely bidirectional and asymmetric: the aircraft streams attitude, GPS and '
       + 'status down continuously while the operator sends comparatively few commands up. '
       + 'UDP, because a late command is worse than a lost one.',
  },
  {
    id: 'rc-control', group: 'Command and control', label: 'RC control uplink',
    protocol: 'udp', direction: 'up', kind: 'constant',
    pps: 50, payloadBytes: 64, reverseScale: 0,
    why: 'Stick inputs from the ground. Small packets at a high rate, which is airtime-heavy '
       + 'out of all proportion to its bitrate because every frame pays preamble and '
       + 'interframe cost regardless of size. Latency-critical, so never TCP.',
  },
  {
    id: 'c2-heartbeat', group: 'Command and control', label: 'C2 heartbeat / keepalive',
    protocol: 'udp', direction: 'bi', kind: 'constant',
    pps: 4, payloadBytes: 64, reverseScale: 1,
    why: 'Symmetric by design - each end has to prove it is still there. Trivial bitrate, '
       + 'included because it is one more small-packet talker competing for the medium.',
  },
  {
    id: 'payload-dl', group: 'Payload and data', label: 'Payload file download',
    protocol: 'tcp', direction: 'down', kind: 'constant',
    pps: 400, payloadBytes: 1400,
    why: 'Bulk imagery or logs pulled off the aircraft. TCP, so it will take whatever capacity '
       + 'is left - and its acknowledgements load the uplink. Schedule it away from '
       + 'flight-critical traffic rather than trusting it to back off politely.',
  },
  {
    id: 'mission-upload', group: 'Payload and data', label: 'Mission / waypoint upload',
    protocol: 'tcp', direction: 'up', kind: 'constant',
    pps: 60, payloadBytes: 500,
    why: 'A short uplink burst before or during flight. TCP because a corrupted waypoint is '
       + 'unacceptable and the latency cost is affordable here.',
  },
  {
    id: 'ssh-mgmt', group: 'Payload and data', label: 'SSH / web management',
    protocol: 'tcp', direction: 'bi', kind: 'constant',
    pps: 10, payloadBytes: 200, reverseScale: 0.6,
    why: 'An engineer on the radio GUI or a shell. Bidirectional and bursty. Worth modelling '
       + 'because troubleshooting sessions happen exactly when the link is already struggling.',
  },
];

export function presetById(id) {
  return TRAFFIC_PRESETS.find((p) => p.id === id) || null;
}

/**
 * Expand one configured flow into the directional sub-flows that actually hit the air:
 * the forward traffic, any reverse traffic, and the TCP acknowledgements each spawns.
 *
 * Entries are tagged 'forward' or 'reverse' so the caller can report per-direction
 * loading as well as the combined total the half-duplex medium actually sees.
 */
export function expandFlow(flow) {
  const dir = DIRECTIONS[flow.direction] || DIRECTIONS.bi;
  const proto = PROTOCOLS[flow.protocol] || PROTOCOLS.udp;
  const out = [];
  const base = flow.kind === 'video' ? videoProfile(flow) : constantProfile(flow);

  // reverseScale lets a bidirectional flow be asymmetric - MAVLink sends far more down
  // than up, and modelling it as symmetric overstates the uplink badly.
  const revScale = flow.reverseScale != null ? flow.reverseScale : 1;

  if (dir.forward) {
    out.push({ leg: 'forward', label: flow.label, profile: base,
               isUnicast: flow.isUnicast !== false });
  }
  if (dir.reverse) {
    const scale = dir.forward ? revScale : 1;   // a one-way flow carries full rate on its leg
    out.push({
      leg: 'reverse', label: flow.label,
      profile: { ...base, avgPps: base.avgPps * scale, peakPps: base.peakPps * scale },
      isUnicast: flow.isUnicast !== false,
    });
  }

  // TCP acknowledgements travel opposite each data leg
  if (proto.ackRatio > 0) {
    for (const leg of out.slice()) {
      const opposite = leg.leg === 'forward' ? 'reverse' : 'forward';
      out.push({
        leg: opposite, label: flow.label + ' (TCP ACK)', isAck: true, isUnicast: true,
        profile: { avgPps: leg.profile.avgPps * proto.ackRatio,
                   peakPps: leg.profile.peakPps * proto.ackRatio,
                   payloadBytes: proto.ackBytes },
      });
    }
  }
  return out;
}

/**
 * Airtime across several simultaneous flows on one half-duplex link.
 *
 * Reports forward, reverse and combined. Combined is the number that decides whether
 * the link works, because TDD means both directions spend the same medium - which
 * surprises people who size uplink and downlink separately.
 */
export function analyseMultiFlow({ pathLossDb, distanceM = 0, freqMhz = 2450,
                                   bandwidthMhz = 20, txGainDbi = 3, rxGainDbi = 3,
                                   fadeMarginDb = 12, basis = 'datasheet', chains = 2,
                                   configuredMaxDbm = null, flows = [], meshMode = 'batman',
                                   packetLoss = 0.1, nodes = 2, ogmIntervalS = 1,
                                   headerOverheadBytes = 60, multicastRate20Mbps = 6.5,
                                   extraPathLossDb = 0, rateDerate = 0,
                                   noisePenaltyDb = 0, sense = null, meshCount = 1 }) {
  // extraPathLossDb is the planning derate charged by the caller, added here rather
  // than folded into pathLossDb so the free-space branch is covered too.
  const loss = (pathLossDb != null ? pathLossDb : fsplDb(freqMhz, distanceM / 1000)) + extraPathLossDb;
  // Sense moves the radio to the cleanest channel it whitelisted, so the site's noise
  // penalty is partly bought back before it ever reaches the rate table.
  const rawPenalty = Math.max(0, noisePenaltyDb);
  const effPenalty = sense ? sensedNoisePenaltyDb(rawPenalty, sense.rangeCount) : rawPenalty;
  const link = chooseBestMcs({ pathLossDb: loss, txGainDbi, rxGainDbi, bandwidthMhz,
                               fadeMarginDb, basis, chains, configuredMaxDbm, rateDerate,
                               noisePenaltyDb: effPenalty });
  const opts = { headerOverheadBytes, multicastRate20Mbps, bandwidthMhz, distanceM };

  const rows = [];
  for (const f of flows) {
    if (f.enabled === false) continue;
    for (const leg of expandFlow(f)) {
      const a = flowAirtime({ profile: leg.profile, link, isUnicast: leg.isUnicast,
                              meshMode, packetLoss, opts });
      rows.push({ ...leg, protocol: f.protocol, direction: f.direction,
                  presetId: f.id, mesh: Math.max(0, Math.min(f.mesh || 0, meshCount - 1)),
                  ...a });
    }
  }

  const legSum = (leg, key) => rows.filter((r) => r.leg === leg)
    .reduce((s, r) => s + r[key], 0);
  const ogmPercent = MESH_MODES[meshMode]?.ogm
    ? ogmAirtimePercent({ nodes, ogmIntervalS, phyRateMbps: link.phyRateMbps, opts })
    : 0;

  // Every mesh pays its own routing chatter, its own Sense switching, and a penalty
  // for not being perfectly isolated from the others.
  const senseOverhead = sense ? senseOverheadPercent(sense.activity) : 0;
  const isolation = interMeshOverheadPercent(meshCount);
  const perMeshFloor = ogmPercent + senseOverhead + isolation;

  const nMesh = Math.max(1, meshCount);
  const meshes = [];
  for (let m = 0; m < nMesh; m++) {
    const mine = rows.filter((r) => r.mesh === m);
    meshes.push({
      index: m,
      labels: [...new Set(mine.map((r) => r.label.replace(/ \(TCP ACK\)$/, '')))],
      avgPercent: mine.reduce((acc, r) => acc + r.avgPercent, 0) + perMeshFloor,
      peakPercent: mine.reduce((acc, r) => acc + r.peakPercent, 0) + perMeshFloor,
      offeredMbps: mine.reduce((acc, r) => acc + r.goodputMbps, 0),
    });
  }
  // The binding constraint is the busiest mesh, not the average of them: a design with
  // one saturated mesh and three idle ones is a design that stutters.
  const avgPercent = Math.max(...meshes.map((m) => m.avgPercent));
  const peakPercent = Math.max(...meshes.map((m) => m.peakPercent));
  const capacityPerMesh = effectiveThroughputMbps(1500, link.phyRateMbps, true, opts,
                                                  retryFactor(packetLoss));
  const capacityMbps = capacityPerMesh * nMesh;
  const offeredMbps = rows.reduce((s, r) => s + r.goodputMbps, 0);

  return {
    pathLossDb: loss, link, rows, ogmPercent,
    meshes, meshCount: nMesh, capacityPerMesh,
    senseOverheadPercent: senseOverhead, interMeshPercent: isolation,
    noisePenaltyDb: rawPenalty, effectiveNoisePenaltyDb: effPenalty,
    senseRecoveredDb: rawPenalty - effPenalty,
    forward: { avgPercent: legSum('forward', 'avgPercent'),
               peakPercent: legSum('forward', 'peakPercent'),
               mbps: rows.filter((r) => r.leg === 'forward')
                 .reduce((s, r) => s + r.goodputMbps, 0) },
    reverse: { avgPercent: legSum('reverse', 'avgPercent'),
               peakPercent: legSum('reverse', 'peakPercent'),
               mbps: rows.filter((r) => r.leg === 'reverse')
                 .reduce((s, r) => s + r.goodputMbps, 0) },
    avgPercent, peakPercent, offeredMbps, capacityMbps,
    ackPercent: rows.filter((r) => r.isAck).reduce((s, r) => s + r.avgPercent, 0),
    status: airtimeStatus(peakPercent),
    closes: link.marginDb >= 0,
    headroomMbps: Math.max(capacityMbps - offeredMbps, 0),
  };
}
