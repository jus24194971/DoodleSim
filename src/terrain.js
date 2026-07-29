// Terrain elevation sampling from AWS Terrarium tiles (open data, no API key).
// elevation(m) = (R*256 + G + B/256) - 32768

const TILE_ZOOM = 11;
const tileCache = new Map(); // "z/x/y" -> ImageData | Promise

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

async function getTileData(z, tx, ty) {
  const key = `${z}/${tx}/${ty}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const promise = (async () => {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`terrain tile failed: ${key}`));
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, 256, 256);
    tileCache.set(key, data);
    return data;
  })();
  tileCache.set(key, promise);
  return promise;
}

export async function elevationAt(lon, lat) {
  const { x, y } = lonLatToTile(lon, lat, TILE_ZOOM);
  const tx = Math.floor(x), ty = Math.floor(y);
  const data = await getTileData(TILE_ZOOM, tx, ty);
  const px = Math.min(255, Math.floor((x - tx) * 256));
  const py = Math.min(255, Math.floor((y - ty) * 256));
  const i = (py * 256 + px) * 4;
  const [r, g, b] = [data.data[i], data.data[i + 1], data.data[i + 2]];
  return r * 256 + g + b / 256 - 32768;
}

const R_EARTH = 6371008.8;

export function bearingDeg(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const la1 = toRad(a.lat), la2 = toRad(b.lat), dLon = toRad(b.lng - a.lng);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function destination(lng, lat, bearing, distM) {
  const br = (bearing * Math.PI) / 180;
  const dR = distM / R_EARTH;
  const la1 = (lat * Math.PI) / 180, lo1 = (lng * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dR) + Math.cos(la1) * Math.sin(dR) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dR) * Math.cos(la1), Math.cos(dR) - Math.sin(la1) * Math.sin(la2));
  return { lng: (lo2 * 180) / Math.PI, lat: (la2 * 180) / Math.PI };
}

export function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

// Sample terrain elevations along the great-circle-ish path (linear interp is fine at these ranges)
export async function terrainProfile(a, b, nPoints = 128) {
  const pts = [];
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    pts.push({ lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t, t });
  }
  const elevations = await Promise.all(pts.map((p) => elevationAt(p.lng, p.lat).catch(() => 0)));
  const distM = haversineM(a, b);
  return pts.map((p, i) => ({ ...p, distM: p.t * distM, elevM: Math.max(elevations[i], 0) === elevations[i] ? elevations[i] : elevations[i] }));
}
