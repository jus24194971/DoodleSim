// Capture the screenshots used in the user guide.
//
// Drives the real application in Chrome rather than mocking anything up, so the
// pictures in the guide are the product as it actually is. Run the dev server
// first, then:  node tools/capture_guide_shots.mjs
//
// A purpose-built demo layout is seeded through the app's own save format: the
// layouts saved from real log analysis carry diagnostic labels like
// "smartradio-...50814f (rx -31 dBm)" which are meaningless to a reader.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.GUIDE_URL || 'http://localhost:5173';
const OUT = path.join(process.cwd(), 'docs', 'guide-shots');
fs.mkdirSync(OUT, { recursive: true });

// A small realistic network: ground station, a relay on high ground, and a UAV.
// Spread over ~9 km so the map reads as a real deployment rather than a bench.
const DEMO = {
  version: 1,
  fadeMarginDb: 10,
  nodes: [
    { id: 1, label: 'Ground Station', lng: -104.990, lat: 39.740,
      radioId: 'OEM_v4', bandId: 'ism2400', freqMhz: 2450, bwMhz: 10, powerDbm: 32,
      antennaId: null, antennaGain: 12, heightM: 20, cableLoss: 1.5, bdaGain: 0,
      platform: 'mast', azimuthDeg: 71, tiltDeg: 0, customHpbwAz: 90, customHpbwEl: 12,
      customName: 'Sector 12 dBi', customType: 'sector', dishDiaM: null,
      cableType: 'lmr400', cableLenM: 15, noiseProfileId: 'suburban', noiseCustomDbm: -90 },
    { id: 2, label: 'Relay - Ridge Mast', lng: -104.945, lat: 39.752,
      radioId: 'OEM_v4', bandId: 'ism2400', freqMhz: 2450, bwMhz: 10, powerDbm: 32,
      antennaId: null, antennaGain: 10, heightM: 30, cableLoss: 1, bdaGain: 0,
      platform: 'mast', azimuthDeg: 0, tiltDeg: 0, customHpbwAz: 360, customHpbwEl: 15,
      customName: 'Omni 10 dBi', customType: 'omni', dishDiaM: null,
      cableType: 'lmr400', cableLenM: 10, noiseProfileId: 'suburban', noiseCustomDbm: -90 },
    { id: 3, label: 'UAV - Survey 1', lng: -104.900, lat: 39.762,
      radioId: 'miniOEM_v4', bandId: 'ism2400', freqMhz: 2450, bwMhz: 10, powerDbm: 32,
      antennaId: null, antennaGain: 3, heightM: 120, cableLoss: 0, bdaGain: 0,
      platform: 'uav', azimuthDeg: 0, tiltDeg: 0, customHpbwAz: 360, customHpbwEl: 40,
      customName: 'Whip 3 dBi', customType: 'whip', dishDiaM: null,
      cableType: 'none', cableLenM: 0, noiseProfileId: 'rural', noiseCustomDbm: -90 },
  ],
  links: [[1, 2], [2, 3]],
  view: { center: [-104.945, 39.751], zoom: 12.2 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name, clip) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, clip });
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  ${name}.png  ${kb} kB`);
}

const run = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--window-size=1440,900', '--hide-scrollbars', '--force-device-scale-factor=2'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  // seed the demo layout and the "tour already seen" flag, then load for real
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.evaluate((d) => {
    localStorage.setItem('doodlesim-layout', JSON.stringify(d));
    localStorage.setItem('doodlesim-tour-done', '1');
  }, DEMO);
  await page.goto(URL, { waitUntil: 'networkidle2' });
  await sleep(6000);                       // terrain tiles, elevation lookups, link maths

  console.log('capturing:');
  await shot(page, '01-overview');

  // node card detail - crop to the sidebar so the settings are legible in print
  const sb = await page.$('#sidebar');
  const box = await sb.boundingBox();
  await shot(page, '02-node-settings',
    { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 620) });

  // link detail: click the link line to open the terrain profile
  await page.evaluate(() => {
    const c = document.querySelector('#link-list .card');
    if (c) c.scrollIntoView();
  });
  await sleep(400);
  await shot(page, '03-link-and-profile');

  // coverage simulation
  await page.evaluate(() => {
    document.querySelector('[data-menu="m-analyse"]').click();
    document.getElementById('btn-mesh-coverage').click();
  });
  await sleep(600);
  await page.evaluate(() => document.getElementById('cov-run').click());
  await sleep(9000);                        // ray sampling + terrain
  await shot(page, '04-coverage');

  await page.evaluate(() => document.getElementById('cov-close').click());
  await sleep(400);

  // link budget and airtime
  await page.evaluate(() => {
    document.querySelector('[data-menu="m-analyse"]').click();
    document.getElementById('btn-airtime').click();
  });
  await sleep(1200);
  await shot(page, '05-link-budget');

  // popped out, so the flow table is readable
  await page.evaluate(() => document.querySelector('#air-panel .panel-pop').click());
  await sleep(600);
  await shot(page, '06-link-budget-popped');
  await page.evaluate(() => document.getElementById('air-close').click());
  await sleep(300);

  // plan advisor
  await page.evaluate(() => {
    document.querySelector('[data-menu="m-deliver"]').click();
    document.getElementById('btn-advisor').click();
  });
  await sleep(900);
  await shot(page, '07-plan-advisor');
  await page.keyboard.press('Escape');
  await sleep(300);

  // phone layout
  const m = await browser.newPage();
  await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true,
                        hasTouch: true });
  await m.goto(URL, { waitUntil: 'networkidle2' });
  await sleep(6000);
  await shot(m, '08-mobile');
  await m.evaluate(() => document.getElementById('nav-toggle').click());
  await sleep(600);
  await shot(m, '09-mobile-menu');

  await browser.close();
  console.log('\nwritten to', OUT);
};

run().catch((e) => { console.error(e); process.exit(1); });
