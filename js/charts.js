// Small canvas charts: speed with the limit line and red speeding stretches, and acceleration/braking in g.
import { HARSH_ACCEL_G, HARSH_BRAKE_G } from './analysis.js';

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const PAD = { l: 34, r: 8, t: 10, b: 20 };

function frame(ctx, w, h, yMin, yMax, ticks, fmt) {
  ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = css('--muted');
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of ticks) {
    const y = PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (h - PAD.t - PAD.b);
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
    ctx.fillText(fmt(v), PAD.l - 5, y);
  }
}

function timeAxis(ctx, w, h, t0, t1) {
  const span = (t1 - t0) / 60000;
  const step = span <= 6 ? 1 : span <= 15 ? 2 : span <= 40 ? 5 : span <= 90 ? 10 : 20;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = css('--muted');
  for (let m = 0; m <= span; m += step) {
    const x = PAD.l + (m / span) * (w - PAD.l - PAD.r);
    ctx.fillText(m + (m === 0 ? ' min' : ''), x, h - PAD.b + 5);
  }
}

export function xToIndex(canvas, A, clientX) {
  const r = canvas.getBoundingClientRect();
  const x = clientX - r.left;
  const pts = A.pts;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const t = t0 + Math.max(0, Math.min(1, (x - PAD.l) / (r.width - PAD.l - PAD.r))) * (t1 - t0);
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

function cursor(ctx, w, h, x) {
  ctx.strokeStyle = css('--text'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h - PAD.b); ctx.stroke(); ctx.setLineDash([]);
}

export function speedChart(canvas, A, cur = null) {
  const { ctx, w, h } = setup(canvas);
  const pts = A.pts;
  if (pts.length < 2) return;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const maxV = Math.max(40, ...pts.map(p => Math.max(p.v, p.limit || 0)));
  const yMax = Math.ceil(maxV / 20) * 20;
  const X = t => PAD.l + (t - t0) / (t1 - t0 || 1) * (w - PAD.l - PAD.r);
  const Y = v => PAD.t + (1 - v / yMax) * (h - PAD.t - PAD.b);
  const ticks = []; for (let v = 0; v <= yMax; v += yMax > 120 ? 40 : 20) ticks.push(v);
  frame(ctx, w, h, 0, yMax, ticks, v => v);
  timeAxis(ctx, w, h, t0, t1);
  // speed limit (step line)
  ctx.strokeStyle = css('--limit'); ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
  ctx.beginPath();
  let started = false;
  pts.forEach((p, i) => {
    if (p.limit == null) { started = false; return; }
    const x = X(p.t), y = Y(p.limit);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else { ctx.lineTo(x, Y(pts[i - 1].limit ?? p.limit)); ctx.lineTo(x, y); }
  });
  ctx.stroke(); ctx.setLineDash([]);
  // speed, red where over the limit
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b.gapBefore) continue;
    ctx.strokeStyle = a.over && b.over ? css('--red') : css('--accent');
    ctx.beginPath(); ctx.moveTo(X(a.t), Y(a.v)); ctx.lineTo(X(b.t), Y(b.v)); ctx.stroke();
  }
  if (cur != null && pts[cur]) cursor(ctx, w, h, X(pts[cur].t));
}

export function gChart(canvas, A, cur = null) {
  const { ctx, w, h } = setup(canvas);
  const pts = A.pts;
  if (pts.length < 2) return;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const lim = Math.max(0.5, Math.ceil(Math.max(...pts.map(p => Math.abs(p.a))) * 10) / 10);
  const X = t => PAD.l + (t - t0) / (t1 - t0 || 1) * (w - PAD.l - PAD.r);
  const Y = g => PAD.t + (1 - (g + lim) / (2 * lim)) * (h - PAD.t - PAD.b);
  frame(ctx, w, h, -lim, lim, [-lim, 0, lim].map(v => +v.toFixed(1)), v => v.toFixed(1));
  timeAxis(ctx, w, h, t0, t1);
  ctx.strokeStyle = css('--warn'); ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
  for (const g of [HARSH_ACCEL_G, -HARSH_BRAKE_G]) { ctx.beginPath(); ctx.moveTo(PAD.l, Y(g)); ctx.lineTo(w - PAD.r, Y(g)); ctx.stroke(); }
  ctx.setLineDash([]);
  // filled area: green-ish above zero (speeding up), orange below (braking)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (b.gapBefore) continue;
    ctx.fillStyle = (a.a + b.a) / 2 >= 0 ? css('--accel') : css('--brake');
    ctx.beginPath();
    ctx.moveTo(X(a.t), Y(0)); ctx.lineTo(X(a.t), Y(a.a)); ctx.lineTo(X(b.t), Y(b.a)); ctx.lineTo(X(b.t), Y(0));
    ctx.closePath(); ctx.fill();
  }
  if (cur != null && pts[cur]) cursor(ctx, w, h, X(pts[cur].t));
}
