// Licensed Mesh Rider features, and what they do to a prediction.
//
// Two of the paid feature sets change the answer the planner gives, so they belong
// in the maths rather than in a footnote. This module is the ONLY place their effect
// is defined, because the magnitudes below are engineering estimates and somebody
// will need to correct them from field data without hunting through the UI.
//
// WHAT IS PUBLISHED, AND WHAT IS ESTIMATED
//
// Sense - published by Doodle Labs:
//   * "an advanced paid feature ... available as a firmware upgrade"
//   * "continuously monitors in-band interference across up to six frequency ranges
//      on a single radio. When it detects signal degradation, it automatically
//      switches to a cleaner channel or band."
//   * at bootup it "creates a whitelist of clean channels and bands"
//   * channel and band switching takes "under ~100ms"
//   The MECHANISM above is documented. The RECOVERY FRACTIONS below are not - they
//   are our estimate of how much of a noisy site's penalty moving to the cleanest
//   whitelisted channel actually buys back. Treat them as a starting point.
//
// Multiple Mesh - the licence that lets one deployment run several concurrent mesh
//   networks for aggregate capacity. Doodle Labs does not publish the mechanics, so
//   everything here is modelled from first principles: independent meshes on
//   non-overlapping channels do not share airtime, which is the whole point, minus a
//   penalty for imperfect isolation and for control traffic that every mesh pays
//   separately.

export const SENSE_MAX_RANGES = 6;        // "up to six frequency ranges on a single radio"
export const SENSE_SWITCH_MS = 100;       // "under ~100ms" per channel or band change

/**
 * How much of the environmental noise penalty Sense buys back.
 *
 * With one band it can only hop channels inside that band, so a wideband jammer or a
 * congested site follows it. Each additional band is a genuinely separate place to
 * hide, so the odds of finding clean spectrum rise - with diminishing returns, since
 * the bands a radio holds are not independent of each other in a contested area.
 */
export function senseRecoveryFraction(rangeCount) {
  const n = Math.max(1, Math.min(Math.round(rangeCount || 1), SENSE_MAX_RANGES));
  return [0, 0.35, 0.60, 0.72, 0.79, 0.83, 0.86][n];
}

/**
 * The noise penalty that survives Sense, in dB.
 *
 * Capped at the raw penalty and floored at zero: the best a clean channel can be is
 * thermal-limited, so Sense can remove the environmental penalty but never do better
 * than a quiet site.
 */
export function sensedNoisePenaltyDb(rawPenaltyDb, rangeCount) {
  if (!(rawPenaltyDb > 0)) return 0;
  return rawPenaltyDb * (1 - senseRecoveryFraction(rangeCount));
}

/**
 * Airtime lost to Sense doing its job, as a percentage of the medium.
 *
 * Every switch is a ~100 ms outage. In benign spectrum Sense sits still and this is
 * nearly zero; under active jamming it moves constantly and the cost is real. The
 * switch rates are per minute and are an estimate, not a measurement.
 */
export const SENSE_ACTIVITY = [
  { id: 'quiet', label: 'Quiet - Sense rarely moves', switchesPerMin: 0.2 },
  { id: 'busy', label: 'Congested - occasional hops', switchesPerMin: 4 },
  { id: 'contested', label: 'Contested / jammed - constant hopping', switchesPerMin: 20 },
];

export function senseOverheadPercent(activityId) {
  const a = SENSE_ACTIVITY.find((x) => x.id === activityId) || SENSE_ACTIVITY[0];
  return (a.switchesPerMin * (SENSE_SWITCH_MS / 1000) / 60) * 100;
}

/**
 * Per-additional-mesh airtime overhead, as a percentage of each mesh's own medium.
 *
 * Concurrent meshes only get independent airtime if they sit on non-overlapping
 * channels - that is the point of the licence. They are never perfectly isolated:
 * adjacent-channel energy raises the floor a little, and every mesh runs its own
 * routing chatter. Charging a few percent per extra mesh keeps the model honest
 * about the fact that four meshes are not four times one mesh.
 */
export const INTER_MESH_OVERHEAD_PERCENT = 3;
export const MAX_MESHES = 4;

export function interMeshOverheadPercent(meshCount) {
  return Math.max(0, (Math.min(meshCount, MAX_MESHES) - 1)) * INTER_MESH_OVERHEAD_PERCENT;
}

export const LICENSED_FEATURES = [
  {
    id: 'sense',
    name: 'Sense',
    blurb: 'Scans every band, whitelists clean channels, and moves off a jammed one in under ~100 ms.',
    effect: 'Recovers part of the noise-floor penalty at a noisy or contested site; '
          + 'charges a small airtime cost for the switching itself.',
  },
  {
    id: 'multimesh',
    name: 'Multiple Mesh',
    blurb: 'Runs several concurrent mesh networks so traffic does not all share one medium.',
    effect: 'Splits the flows across independent meshes, each with its own airtime '
          + 'budget, less an isolation penalty per extra mesh.',
  },
];
