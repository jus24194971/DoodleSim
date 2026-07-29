// Doodle Labs radio catalog — data extracted from the official Range Estimation Tool
// (kb.doodlelabs.com/range-estimation-tool, July 2026) and Doodle Labs datasheets.
// power arrays: PER-CHAIN TX power (dBm) indexed by MCS pair [0/8 .. 7/15].
// Combined output with 2 antennas = +3 dB, clamped to user-configured power.
// sensitivity: dBm at 20 MHz for MCS0-7; MCS8-15 = +3 dB worse; scales 10*log10(bw/20).

export const SENS_MCS0_7_20MHZ = [-87, -85, -83, -81, -77, -73, -71, -69];

export const MBPS_20MHZ = {
  siso: [5.4, 10.62, 15.66, 20.52, 29.97, 38.88, 43.11, 47.34],
  mimo: [10.53, 20.43, 29.7, 38.43, 54.72, 69.3, 76.14, 82.71],
};

const V3_POWER = [27, 26, 26, 26, 25, 24, 23, 21];
const V4_POWER = [29, 28, 28, 28, 27, 26, 25, 23];

// Bands the Mesh Rider platform ships in (MHz). Each radio lists which it supports.
export const BANDS = {
  ism900:   { label: '900 MHz ISM (902–928)', lo: 902, hi: 928, def: 915 },
  ism2400:  { label: '2.4 GHz ISM (2400–2482)', lo: 2400, hi: 2482, def: 2450 },
  hex:      { label: 'Hex band (1625–2510)', lo: 1625, hi: 2510, def: 2250 },
  sband:    { label: 'S-band (2200–2500)', lo: 2200, hi: 2500, def: 2350 },
  natoC:    { label: 'NATO C-band (4400–4800)', lo: 4400, hi: 4800, def: 4600 },
  pubsafe:  { label: 'Public Safety (4940–4990)', lo: 4940, hi: 4990, def: 4965 },
  unii:     { label: '5 GHz UNII (5150–5895)', lo: 5150, hi: 5895, def: 5800 },
  ism5800:  { label: '5.8 GHz ISM (5725–5875)', lo: 5725, hi: 5875, def: 5800 },
  vhf245:   { label: 'VHF (245–265)', lo: 245, hi: 265, def: 255 },
  uhf432:   { label: 'UHF (432–478)', lo: 432, hi: 478, def: 455 },
};

export const RADIOS = [
  { id: 'miniOEM_v4', name: 'miniOEM v4', power: V4_POWER, maxConfig: 32, chains: 2, bands: ['ism900', 'ism2400', 'hex', 'sband'] },
  { id: 'nanoOEM_v4', name: 'nanoOEM v4', power: V4_POWER, maxConfig: 32, chains: 1, bands: ['ism900', 'ism2400', 'hex', 'sband'] },
  { id: 'OEM_v4', name: 'OEM v4', power: V4_POWER, maxConfig: 32, chains: 2, bands: ['ism900', 'ism2400', 'hex', 'sband'] },
  { id: 'wearable_v4', name: 'Wearable v4', power: V4_POWER, maxConfig: 32, chains: 2, bands: ['ism900', 'ism2400', 'hex', 'sband'] },
  { id: 'miniOEM_v3', name: 'miniOEM v3', power: V3_POWER, maxConfig: 30, chains: 2, bands: ['ism900', 'ism2400', 'hex', 'sband'] },
  { id: 'nanoOEM_v3', name: 'nanoOEM v3', power: V3_POWER, maxConfig: 30, chains: 1, bands: ['ism900', 'ism2400', 'hex', 'sband'] },
  { id: 'OEM_v3', name: 'OEM v3', power: V3_POWER, maxConfig: 30, chains: 2, bands: ['ism900', 'ism2400', 'hex', 'sband'] },
  { id: 'wearable_v3', name: 'Wearable v3', power: V3_POWER, maxConfig: 30, chains: 2, bands: ['ism900', 'ism2400', 'hex', 'sband'] },
  { id: 'RM5200_44', name: 'RM-5200 (4.4–4.8 GHz)', power: [26, 24, 24, 24, 22, 20, 18, 16], maxConfig: 30, chains: 2, bands: ['natoC'] },
  { id: 'RM5200_51', name: 'RM-5200 (5.1–5.8 GHz)', power: [27, 25, 25, 25, 23, 21, 19, 17], maxConfig: 30, chains: 2, bands: ['pubsafe', 'unii', 'ism5800'] },
  { id: 'RM1300_245', name: 'RM-1300 (245–265 MHz)', power: [24, 21, 21, 21, 20, 19, 18, 16], maxConfig: 27, chains: 2, bands: ['vhf245'] },
  { id: 'RM1300_2200', name: 'RM-1300 (2.2–2.5 GHz)', power: [27, 24, 24, 24, 23, 22, 21, 19], maxConfig: 30, chains: 2, bands: ['sband'] },
  { id: 'RM1400_432', name: 'RM-1400 (432–478 MHz)', power: [24, 21, 21, 21, 20, 19, 18, 16], maxConfig: 27, chains: 2, bands: ['uhf432'] },
  { id: 'RM1400_2200', name: 'RM-1400 (2.2–2.5 GHz)', power: [27, 24, 24, 24, 23, 22, 21, 19], maxConfig: 30, chains: 2, bands: ['sband'] },
];

export const CHANNEL_WIDTHS = [3, 5, 10, 15, 20, 26, 40];

export const PLATFORMS = [
  { id: 'mast', label: 'Fixed mast / tower', defaultHeight: 10 },
  { id: 'uav', label: 'UAV (drone)', defaultHeight: 100 },
  { id: 'ugv', label: 'UGV / ground robot', defaultHeight: 1 },
  { id: 'vehicle', label: 'Vehicle (car/truck)', defaultHeight: 2 },
  { id: 'vessel', label: 'Vessel at sea', defaultHeight: 4 },
  { id: 'handheld', label: 'Handheld / wearable', defaultHeight: 1.5 },
];
