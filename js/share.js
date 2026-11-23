// Packs a drive or a route into a link. The data travels in the part of the link after '#',
// which browsers never send to a server, so no backend or accounts are needed.
import { hav, simplifyIdx } from './analysis.js';

const MAX_SHARE_POINTS = 1200;

export function encodePolyline(coords, factor = 1e5) {
  let out = '', pLat = 0, pLon = 0;
  const enc = v => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [la, lo] of coords) {
    const a = Math.round(la * factor), b = Math.round(lo * factor);
    out += enc(a - pLat) + enc(b - pLon);
    pLat = a; pLon = b;
  }
  return out;
}

export function decodePolyline(str, factor = 1e5) {
  const out = [];
  let i = 0, la = 0, lo = 0;
  const dec = () => {
    let r = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) { la += dec(); lo += dec(); out.push([la / factor, lo / factor]); }
  return out;
}

const rle = arr => {
  const out = [];
  for (const v of arr) {
    const last = out[out.length - 1];
    if (last && last[0] === v) last[1]++; else out.push([v, 1]);
  }
  return out;
};
const unrle = arr => arr.flatMap(([v, n]) => new Array(n).fill(v));

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

async function pack(obj) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream !== 'undefined') return 'z' + b64url(await pipe(json, new CompressionStream('deflate-raw')));
  return 'j' + b64url(json);
}

export async function unpack(str) {
  const kind = str[0];
  const bytes = unb64url(str.slice(1));
  const raw = kind === 'z' ? await pipe(bytes, new DecompressionStream('deflate-raw')) : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}

// Hide where a drive starts and ends (usually home) by cutting the first and last 200 m.
export function trimEnds(points, metres = 200) {
  if (points.length < 4) return { from: 0, to: points.length - 1 };
  let d = 0, from = 0, to = points.length - 1;
  for (let i = 1; i < points.length; i++) { d += hav(points[i - 1].la, points[i - 1].lo, points[i].la, points[i].lo); if (d >= metres) { from = i; break; } }
  d = 0;
  for (let i = points.length - 2; i > 0; i--) { d += hav(points[i + 1].la, points[i + 1].lo, points[i].la, points[i].lo); if (d >= metres) { to = i; break; } }
  if (to - from < 2) return { from: 0, to: points.length - 1 };
  return { from, to };
}

function pick(arr, idx) { return idx.map(i => arr[i]); }

export async function packDrive(drive, { trim = true, from = '' } = {}) {
  let { from: a, to: b } = trim ? trimEnds(drive.points) : { from: 0, to: drive.points.length - 1 };
  let idx = [];
  for (let i = a; i <= b; i++) idx.push(i);
  if (idx.length > MAX_SHARE_POINTS) {
    const step = idx.length / MAX_SHARE_POINTS;
    const kept = [];
    for (let k = 0; k < MAX_SHARE_POINTS; k++) kept.push(idx[Math.floor(k * step)]);
    kept[kept.length - 1] = idx[idx.length - 1];
    idx = kept;
  }
  const pts = pick(drive.points, idx);
  const t0 = pts[0].t;
  const obj = {
    v: 1, k: 'd', n: drive.name || '', f: from, t0, a: drive.activity && drive.activity !== 'drive' ? drive.activity : undefined,
    p: encodePolyline(pts.map(p => [p.la, p.lo])),
    d: pts.map((p, i) => i ? Math.round((p.t - pts[i - 1].t) / 100) : 0),
    s: pts.map(p => p.s == null ? -1 : Math.round(p.s * 10)),
    m: pts.some(p => p.m != null) ? pts.map(p => p.m == null ? -1 : Math.round(p.m * 10)) : undefined,
  };
  if (drive.limits && (!drive.activity || drive.activity === 'drive')) {
    obj.l = rle(pick(drive.limits.v, idx));
    obj.ls = rle(pick(drive.limits.src, idx));
    obj.lst = drive.limits.status;
  }
  return pack(obj);
}

export async function packRoute(points, { name = '', from = '', trim = true, mode = 'car', activity } = {}) {
  let { from: a, to: b } = trim ? trimEnds(points) : { from: 0, to: points.length - 1 };
  const slice = points.slice(a, b + 1);
  const keep = simplifyIdx(slice, 6);
  return pack({ v: 1, k: 'r', n: name, f: from, m: mode !== 'car' ? mode : undefined, a: activity, p: encodePolyline(keep.map(i => [slice[i].la, slice[i].lo])) });
}

// Back to the same shape as a stored drive.
export function toDrive(obj) {
  const coords = decodePolyline(obj.p);
  if (obj.k === 'r') return { kind: 'route', name: obj.n, from: obj.f, mode: obj.m || 'car', activity: obj.a, points: coords.map(([la, lo]) => ({ la, lo })) };
  let t = obj.t0;
  const points = coords.map(([la, lo], i) => {
    t += (obj.d[i] || 0) * 100;
    return { t, la, lo, s: obj.s[i] < 0 ? null : obj.s[i] / 10, m: obj.m && obj.m[i] >= 0 ? obj.m[i] / 10 : null };
  });
  const drive = { kind: 'drive', name: obj.n, from: obj.f, activity: obj.a, startedAt: points[0]?.t, endedAt: points[points.length - 1]?.t, points };
  if (obj.l) drive.limits = { v: unrle(obj.l), src: unrle(obj.ls), status: obj.lst || 'osm' };
  return drive;
}

export function shareUrl(kind, payload) {
  const base = location.href.split('#')[0];
  return `${base}#${kind}=${payload}`;
}

export async function shareLink(url, title, text) {
  if (navigator.share) {
    // the link goes inside the text too: some apps (and Copy) keep only the text and drop the url field
    try { await navigator.share({ title, text: `${text}\n${url}` }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  try { await navigator.clipboard.writeText(url); return 'copied'; }
  catch { window.prompt('Copy this link', url); return 'prompted'; }
}
