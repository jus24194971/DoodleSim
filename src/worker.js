// DoodleSim Worker: serves the static app and the community antenna library API.
//   GET  /api/antennas  -> list community-submitted antennas
//   POST /api/antennas  -> submit one (validated; deduped on manufacturer+model)

const JUNK_WORDS = ['test', 'asdf', 'qwerty', 'aaaa', 'none', 'n/a', 'na', 'xxx', 'abc', 'foo', 'bar', 'fake', 'todo', 'tbd', 'unknown', 'garbage', 'blah'];

function validateSubmission(b) {
  const errs = [];
  const mfr = String(b.manufacturer || '').trim();
  const model = String(b.model || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9 .&'\-]{1,39}$/.test(mfr)) errs.push('Manufacturer must be 2-40 chars, starting with a letter.');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._\/\-+]{2,39}$/.test(model)) errs.push('Model number must be 3-40 chars (letters, digits, - . / _).');
  if (!/[0-9]/.test(model) || !/[A-Za-z]/.test(model)) errs.push('Model number must contain both letters and digits (a referenceable part number).');
  if (new Set(model.toLowerCase().replace(/[^a-z0-9]/g, '')).size < 3) errs.push('Model number looks like filler.');
  const lm = model.toLowerCase(), lf = mfr.toLowerCase();
  if (JUNK_WORDS.some((w) => lm === w || lf === w || lm.startsWith(w + w) )) errs.push('Model/manufacturer looks like placeholder text.');
  const lo = +b.band_lo_mhz, hi = +b.band_hi_mhz, gain = +b.gain_dbi, az = +b.hpbw_az_deg, el = +b.hpbw_el_deg;
  if (!(lo >= 30 && hi <= 60000 && lo < hi)) errs.push('Frequency range must be 30-60000 MHz with low < high.');
  if (!(gain >= -10 && gain <= 50)) errs.push('Gain must be between -10 and 50 dBi.');
  if (!(az >= 1 && az <= 360) || !(el >= 1 && el <= 360)) errs.push('Beamwidths must be 1-360 degrees.');
  if (!['omni', 'directional'].includes(b.pattern)) errs.push('Pattern must be omni or directional.');
  return { ok: errs.length === 0, errs, clean: { manufacturer: mfr, model, band_lo_mhz: lo, band_hi_mhz: hi, gain_dbi: gain, pattern: b.pattern, hpbw_az_deg: az, hpbw_el_deg: el, ant_type: String(b.ant_type || '').slice(0, 40) } };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/antennas') {
      if (request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM community_antennas ORDER BY manufacturer, model').all();
        return json({ antennas: results.map((r) => ({
          id: 'community-' + r.id, manufacturer: r.manufacturer, model: r.model,
          band_mhz: [r.band_lo_mhz, r.band_hi_mhz], gain_dbi: r.gain_dbi, pattern: r.pattern,
          hpbw_az_deg: r.hpbw_az_deg, hpbw_el_deg: r.hpbw_el_deg, type: r.ant_type,
          community: true,
        })) });
      }
      if (request.method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
        const v = validateSubmission(body);
        if (!v.ok) return json({ error: v.errs.join(' ') }, 422);
        try {
          await env.DB.prepare(
            'INSERT INTO community_antennas (manufacturer, model, band_lo_mhz, band_hi_mhz, gain_dbi, pattern, hpbw_az_deg, hpbw_el_deg, ant_type) VALUES (?,?,?,?,?,?,?,?,?)'
          ).bind(v.clean.manufacturer, v.clean.model, v.clean.band_lo_mhz, v.clean.band_hi_mhz, v.clean.gain_dbi, v.clean.pattern, v.clean.hpbw_az_deg, v.clean.hpbw_el_deg, v.clean.ant_type).run();
        } catch (e) {
          if (String(e).includes('UNIQUE')) return json({ error: 'This manufacturer + model is already in the library.' }, 409);
          return json({ error: 'database error' }, 500);
        }
        return json({ ok: true });
      }
      return json({ error: 'method not allowed' }, 405);
    }
    return env.ASSETS.fetch(request);
  },
};
