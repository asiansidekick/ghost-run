// Speed limits for a drive: OpenStreetMap maxspeed where roads are tagged, Thai defaults elsewhere.
import { hav, bearing } from './analysis.js';

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Thai general limits (Land Traffic Act, as amended 2021). Approximate; posted signs win.
export const TH_DEFAULTS = [
  { label: 'Bangkok and other towns (most roads)', kmh: 80 },
  { label: 'Outside towns', kmh: 90 },
  { label: 'Expressways in greater Bangkok, when not tagged', kmh: 90 },
  { label: 'Motorways outside greater Bangkok (e.g. M7, M9 outer)', kmh: 120 },
];

// Rough box around greater Bangkok (Bangkok, Nonthaburi, Pathum Thani, Samut Prakan).
export function inGreaterBangkok(lat, lon) {
  return lat > 13.45 && lat < 14.15 && lon > 100.25 && lon < 100.95;
}

export function defaultLimit(highway, lat, lon) {
  const urban = inGreaterBangkok(lat, lon);
  if (highway && highway.startsWith('motorway')) return urban ? 90 : 120;
  return urban ? 80 : 90;
}

export function parseMaxspeed(v) {
  if (!v) return null;
  v = String(v).trim();
  const named = { 'TH:urban': 80, 'TH:rural': 90, 'TH:motorway': 120, 'TH:living_street': 20 };
  if (named[v]) return named[v];
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] && m[2].toLowerCase() === 'mph' ? Math.round(n * 1.609) : n;
}

const HIGHWAYS = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road';

// Every ~80 m along the drive, so Overpass gets a polyline to search around.
function samplePath(points) {
  const out = [];
  let last = null;
  for (const p of points) {
    if (!last || hav(last.la, last.lo, p.la, p.lo) > 80) { out.push(p); last = p; }
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end) out.push(end);
  return out;
}

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error('Overpass ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export async function fetchWays(points) {
  const path = samplePath(points);
  const ways = new Map();
  for (let i = 0; i < path.length; i += 250) {
    const chunk = path.slice(Math.max(0, i - 1), i + 250);
    const coords = chunk.map(p => `${p.la.toFixed(6)},${p.lo.toFixed(6)}`).join(',');
    const q = `[out:json][timeout:40];way(around:30,${coords})[highway~"^(${HIGHWAYS})$"];out tags geom;`;
    const json = await overpass(q);
    for (const el of json.elements || []) if (el.type === 'way' && el.geometry) ways.set(el.id, el);
  }
  return [...ways.values()];
}

// Match each point to the nearest road, preferring roads heading the same way and the road matched last.
export function matchLimits(points, ways) {
  const n = points.length;
  const v = new Array(n).fill(null), src = new Array(n).fill('d'), wayIds = new Array(n).fill(null);
  if (!n) return { v, src };
  const lat0 = points[0].la, cos0 = Math.cos(lat0 * Math.PI / 180);
  const X = lo => lo * 111320 * cos0, Y = la => la * 110540;
  const CELL = 60;
  const grid = new Map();
  const segs = [];
  for (const w of ways) {
    const g = w.geometry;
    for (let k = 0; k < g.length - 1; k++) {
      const s = { w, ax: X(g[k].lon), ay: Y(g[k].lat), bx: X(g[k + 1].lon), by: Y(g[k + 1].lat) };
      s.h = bearing(g[k].lat, g[k].lon, g[k + 1].lat, g[k + 1].lon);
      const idx = segs.push(s) - 1;
      const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL), x1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
      const y0 = Math.floor(Math.min(s.ay, s.by) / CELL), y1 = Math.floor(Math.max(s.ay, s.by) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const key = cx + ':' + cy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(idx);
      }
    }
  }
  let prev = null;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const px = X(p.lo), py = Y(p.la);
    const a = points[Math.max(0, i - 2)], b = points[Math.min(n - 1, i + 2)];
    const heading = hav(a.la, a.lo, b.la, b.lo) > 8 ? bearing(a.la, a.lo, b.la, b.lo) : null;
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
    let best = null, bestCost = Infinity;
    const seen = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const idx of grid.get((cx + dx) + ':' + (cy + dy)) || []) {
        if (seen.has(idx)) continue; seen.add(idx);
        const s = segs[idx];
        const ex = s.bx - s.ax, ey = s.by - s.ay, L = ex * ex + ey * ey;
        let t = L ? ((px - s.ax) * ex + (py - s.ay) * ey) / L : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - (s.ax + t * ex), py - (s.ay + t * ey));
        if (d > 35) continue;
        let cost = d;
        if (heading != null) cost += 20 * (1 - Math.abs(Math.cos((heading - s.h) * Math.PI / 180)));
        if (prev && s.w.id === prev) cost -= 5;
        if (cost < bestCost) { bestCost = cost; best = s.w; }
      }
    }
    wayIds[i] = best;
    prev = best ? best.id : prev;
  }
  // drop one-point blips onto a side road
  for (let i = 1; i < n - 1; i++) {
    if (wayIds[i - 1] && wayIds[i - 1] === wayIds[i + 1] && wayIds[i] !== wayIds[i - 1]) wayIds[i] = wayIds[i - 1];
  }
  for (let i = 0; i < n; i++) {
    const w = wayIds[i], p = points[i];
    const tagged = w ? parseMaxspeed(w.tags.maxspeed) : null;
    if (tagged) { v[i] = tagged; src[i] = 'o'; }
    else { v[i] = defaultLimit(w ? w.tags.highway : null, p.la, p.lo); src[i] = 'd'; }
  }
  return { v, src };
}

export function defaultLimits(points) {
  return { v: points.map(p => defaultLimit(null, p.la, p.lo)), src: points.map(() => 'd') };
}

// Returns { v, src, status: 'osm' | 'defaults', at }
export async function computeLimits(points) {
  try {
    const ways = await fetchWays(points);
    return { ...matchLimits(points, ways), status: 'osm', at: Date.now() };
  } catch (e) {
    console.warn('Speed limit lookup failed, using Thai defaults', e);
    return { ...defaultLimits(points), status: 'defaults', at: Date.now() };
  }
}
