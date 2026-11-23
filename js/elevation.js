// Heights along a route, read from the same free terrain tiles the maps use (not the phone's GPS
// altitude, which wanders by tens of metres). Gives a profile, total climb and descent, and gradients.
import { hav } from './analysis.js';
import { DEM_URL } from './terrain.js';

const tiles = new Map();
function tile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tiles.has(key)) {
    const p = fetch(DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y))
      .then(r => { if (!r.ok) throw new Error('terrain ' + r.status); return r.blob(); })
      .then(b => createImageBitmap(b))
      .then(img => {
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, 256, 256).data;
      });
    p.catch(() => tiles.delete(key));
    tiles.set(key, p);
  }
  return tiles.get(key);
}
const toPx = (la, lo, z) => {
  const n = 2 ** z * 256, r = la * Math.PI / 180;
  return [(lo + 180) / 360 * n, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n];
};
const at = (d, x, y) => { const i = (y * 256 + x) * 4; return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; };

// heights for a list of [la, lo], bilinear between pixels
export async function heights(lls, z = 12) {
  const px = lls.map(([la, lo]) => toPx(la, lo, z));
  const need = new Set();
  px.forEach(([x, y]) => { for (const dx of [0, 1]) for (const dy of [0, 1]) need.add(`${Math.floor((x - 0.5 + dx) / 256)},${Math.floor((y - 0.5 + dy) / 256)}`); });
  const data = {};
  await Promise.all([...need].map(async k => { const [tx, ty] = k.split(',').map(Number); data[k] = await tile(z, tx, ty); }));
  const get = (X, Y) => { const tx = Math.floor(X / 256), ty = Math.floor(Y / 256); return at(data[`${tx},${ty}`], X - tx * 256, Y - ty * 256); };
  return px.map(([x, y]) => {
    const X = x - 0.5, Y = y - 0.5, x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
    return (get(x0, y0) * (1 - fx) + get(x0 + 1, y0) * fx) * (1 - fy) + (get(x0, y0 + 1) * (1 - fx) + get(x0 + 1, y0 + 1) * fx) * fy;
  });
}

// Profile of a route: points every `step` metres (at most ~1200 of them), smoothed, with climb,
// descent (counting only rises and falls of 5 m or more, so terrain noise doesn't add up) and gradient.
export async function profile(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + hav(points[i - 1].la, points[i - 1].lo, points[i].la, points[i].lo));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  const step = Math.max(20, total / 1200);
  const d = [], lls = [];
  for (let s = 0, i = 0; s <= total + 0.01; s += step) {
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const f = cum[i + 1] > cum[i] ? Math.min(1, (s - cum[i]) / (cum[i + 1] - cum[i])) : 0;
    d.push(s);
    lls.push([points[i].la + f * (points[i + 1].la - points[i].la), points[i].lo + f * (points[i + 1].lo - points[i].lo)]);
  }
  const raw = await heights(lls, total > 150000 ? 11 : 12);
  // smooth over about 300 m: terrain data has a few metres of noise (trees, buildings) that would
  // otherwise read as hills on flat ground
  const w = Math.max(1, Math.round(150 / step));
  const e = raw.map((_, i) => { let s = 0, n = 0; for (let k = Math.max(0, i - w); k <= Math.min(raw.length - 1, i + w); k++) { s += raw[k]; n++; } return s / n; });
  let climb = 0, descent = 0, ref = e[0];
  for (const h of e) { if (h - ref >= 5) { climb += h - ref; ref = h; } else if (ref - h >= 5) { descent += ref - h; ref = h; } }
  // gradient (%) over about 150 m either side
  const g2 = Math.max(1, Math.round(150 / step));
  const grade = e.map((_, i) => { const a = Math.max(0, i - g2), b = Math.min(e.length - 1, i + g2); return d[b] > d[a] ? (e[b] - e[a]) / (d[b] - d[a]) * 100 : 0; });
  return {
    step, d, e: e.map(x => Math.round(x * 10) / 10), lls, grade: grade.map(x => Math.round(x * 10) / 10),
    climb: Math.round(climb), descent: Math.round(descent), min: Math.round(Math.min(...e)), max: Math.round(Math.max(...e)),
    steepest: Math.round(Math.max(...grade.map(Math.abs)) * 10) / 10,
  };
}

export const GRADE_COLORS = [[2, '#22c55e'], [5, '#facc15'], [8, '#f97316'], [Infinity, '#ef4444']];
export const gradeColor = g => GRADE_COLORS.find(([lim]) => Math.abs(g) < lim)[1];

// The route as runs of the same steepness colour: [{ coords, color }]
export function gradeLines(prof) {
  const out = [];
  let cur = null;
  prof.lls.forEach((ll, i) => {
    const c = gradeColor(prof.grade[i]);
    if (!cur || cur.color !== c) { cur = { color: c, coords: i ? [prof.lls[i - 1], ll] : [ll] }; out.push(cur); }
    else cur.coords.push(ll);
  });
  return out.filter(l => l.coords.length > 1);
}

// The profile as a filled chart, coloured by steepness, with a cursor at `atM` metres.
export function elevChart(canvas, prof, atM = null) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth || 320, H = canvas.clientHeight || 120;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888';
  const pad = { l: 34, r: 6, t: 8, b: 16 };
  const span = Math.max(20, prof.max - prof.min), lo = prof.min - span * 0.1, hi = prof.max + span * 0.15;
  const total = prof.d[prof.d.length - 1] || 1;
  const X = m => pad.l + m / total * (W - pad.l - pad.r), Y = h => H - pad.b - (h - lo) / (hi - lo) * (H - pad.t - pad.b);
  // fill, one slice per sample, coloured by gradient
  for (let i = 1; i < prof.d.length; i++) {
    ctx.fillStyle = gradeColor(prof.grade[i]) + '66';
    ctx.beginPath();
    ctx.moveTo(X(prof.d[i - 1]), Y(lo)); ctx.lineTo(X(prof.d[i - 1]), Y(prof.e[i - 1])); ctx.lineTo(X(prof.d[i]), Y(prof.e[i])); ctx.lineTo(X(prof.d[i]), Y(lo));
    ctx.closePath(); ctx.fill();
  }
  ctx.strokeStyle = css('--text'); ctx.lineWidth = 1.5; ctx.beginPath();
  prof.d.forEach((m, i) => (i ? ctx.lineTo(X(m), Y(prof.e[i])) : ctx.moveTo(X(m), Y(prof.e[i]))));
  ctx.stroke();
  ctx.fillStyle = css('--muted'); ctx.font = '10px system-ui, sans-serif';
  ctx.fillText(prof.max + ' m', 2, Y(prof.max) + 3); ctx.fillText(prof.min + ' m', 2, Y(prof.min) + 3);
  const km = total / 1000;
  ctx.fillText('0', pad.l, H - 3); ctx.textAlign = 'right'; ctx.fillText((km < 10 ? km.toFixed(1) : Math.round(km)) + ' km', W - pad.r, H - 3); ctx.textAlign = 'left';
  if (atM != null) {
    const i = Math.min(prof.d.length - 1, Math.max(0, Math.round(atM / prof.step)));
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(prof.d[i]), pad.t); ctx.lineTo(X(prof.d[i]), H - pad.b); ctx.stroke();
    ctx.fillStyle = css('--accent'); ctx.beginPath(); ctx.arc(X(prof.d[i]), Y(prof.e[i]), 4, 0, 7); ctx.fill();
    ctx.fillStyle = css('--text'); ctx.textAlign = X(prof.d[i]) > W - 90 ? 'right' : 'left';
    ctx.fillText(`${Math.round(prof.e[i])} m · ${prof.grade[i] > 0 ? '+' : ''}${prof.grade[i].toFixed(1)}%`, X(prof.d[i]) + (ctx.textAlign === 'right' ? -6 : 6), pad.t + 8);
    ctx.textAlign = 'left';
  }
  return { distAt: clientX => { const r = canvas.getBoundingClientRect(); return Math.max(0, Math.min(total, (clientX - r.left - pad.l) / (W - pad.l - pad.r) * total)); } };
}
