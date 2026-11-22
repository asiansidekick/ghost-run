// Turns raw GPS points into speeds, acceleration, events, speeding stretches and a summary.
// A point is { t: ms epoch, la, lo, ac: accuracy m, s: GPS speed m/s or null, m: motion peak m/s² or null }.

export const G = 9.80665;
export const GAP_MS = 15000;          // longer than this between fixes counts as a recording gap
export const SPEED_TOLERANCE = 2;     // km/h over the limit before a point counts as speeding
export const SPEEDING_MIN_MS = 2000;  // a stretch must last this long to be marked red
export const HARSH_ACCEL_G = 0.30;
export const HARSH_BRAKE_G = 0.35;
const MOVING_KMH = 5;
const STOPPED_KMH = 2;

export function hav(aLat, aLon, bLat, bLon) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

export function bearing(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const y = Math.sin((bLon - aLon) * r) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos((bLon - aLon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

// limits: { v: [km/h|null per point], src: ['o'|'d' per point] } or undefined
export function analyse(points, limits) {
  const n = points.length;
  const out = new Array(n);
  let dist = 0;
  const raw = new Array(n).fill(0);
  const gapBefore = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    let step = 0;
    if (i > 0) {
      const q = points[i - 1];
      const dt = p.t - q.t;
      step = hav(q.la, q.lo, p.la, p.lo);
      if (dt > GAP_MS) gapBefore[i] = true;
      else dist += step;
      if (p.s != null && p.s >= 0) raw[i] = p.s;
      else raw[i] = dt > 0 && !gapBefore[i] ? step / (dt / 1000) : raw[i - 1];
    } else {
      raw[i] = p.s != null && p.s >= 0 ? p.s : 0;
    }
    out[i] = { i, t: p.t, la: p.la, lo: p.lo, dist, gapBefore: gapBefore[i] };
  }
  // smooth: median of 3 then a light weighted average, never across a gap
  const med = raw.map((v, i) => {
    if (i === 0 || i === n - 1 || gapBefore[i] || gapBefore[i + 1]) return v;
    return median3(raw[i - 1], v, raw[i + 1]);
  });
  const sm = med.map((v, i) => {
    if (i === 0 || i === n - 1 || gapBefore[i] || gapBefore[i + 1]) return v;
    return 0.25 * med[i - 1] + 0.5 * v + 0.25 * med[i + 1];
  });
  for (let i = 0; i < n; i++) out[i].v = sm[i] * 3.6; // km/h

  // longitudinal acceleration (g) from the change in speed
  for (let i = 0; i < n; i++) {
    let a = 0;
    const lo = i > 0 && !gapBefore[i] ? i - 1 : i;
    const hi = i < n - 1 && !gapBefore[i + 1] ? i + 1 : i;
    const dt = (points[hi].t - points[lo].t) / 1000;
    if (hi !== lo && dt > 0.2) a = (sm[hi] - sm[lo]) / dt / G;
    out[i].a = Math.max(-1.5, Math.min(1.5, a));
    out[i].m = points[i].m != null ? points[i].m / G : null;
  }

  // speed limits and speeding
  for (let i = 0; i < n; i++) {
    out[i].limit = limits && limits.v ? limits.v[i] ?? null : null;
    out[i].limitSrc = limits && limits.src ? limits.src[i] ?? null : null;
    out[i].over = false;
  }
  const speeding = [];
  let runStart = -1;
  const closeRun = (end) => {
    if (runStart < 0) return;
    const span = out[end].t - out[runStart].t;
    if (span >= SPEEDING_MIN_MS) {
      let maxOver = 0, d = 0;
      for (let k = runStart; k <= end; k++) {
        out[k].over = true;
        maxOver = Math.max(maxOver, out[k].v - out[k].limit);
      }
      d = out[end].dist - out[runStart].dist;
      speeding.push({ i0: runStart, i1: end, maxOver, dist: d, ms: span, limit: out[runStart].limit });
    }
    runStart = -1;
  };
  for (let i = 0; i < n; i++) {
    const o = out[i];
    const isOver = o.limit != null && o.v > o.limit + SPEED_TOLERANCE && !o.gapBefore;
    if (isOver && runStart < 0) runStart = i;
    else if (!isOver && runStart >= 0) closeRun(i - 1);
    else if (isOver && o.gapBefore) { closeRun(i - 1); runStart = i; }
  }
  if (runStart >= 0) closeRun(n - 1);

  // harsh events
  const events = [];
  let ev = null;
  for (let i = 0; i < n; i++) {
    const a = out[i].a;
    const type = a >= HARSH_ACCEL_G ? 'accel' : a <= -HARSH_BRAKE_G ? 'brake' : null;
    if (type && ev && ev.type === type) { if (Math.abs(a) > Math.abs(ev.g)) { ev.g = a; ev.i = i; } }
    else {
      if (ev) events.push(ev);
      ev = type ? { type, i, g: a } : null;
    }
  }
  if (ev) events.push(ev);

  // stops and moving time
  let moving = false, stops = 0, stoppedSince = null, movingMs = 0, maxV = 0;
  for (let i = 0; i < n; i++) {
    const o = out[i];
    maxV = Math.max(maxV, o.v);
    if (i > 0 && !o.gapBefore && (o.v > STOPPED_KMH || out[i - 1].v > STOPPED_KMH)) movingMs += o.t - out[i - 1].t;
    if (o.v > MOVING_KMH) { moving = true; stoppedSince = null; }
    else if (o.v < STOPPED_KMH && moving) {
      if (stoppedSince == null) stoppedSince = o.t;
      else if (o.t - stoppedSince >= 3000) { stops++; moving = false; stoppedSince = null; }
    }
  }
  // a drive that ends parked shouldn't count that final stop
  if (!moving && stops > 0 && n && out[n - 1].v < STOPPED_KMH) stops--;

  const durationMs = n ? points[n - 1].t - points[0].t : 0;
  const harshAccel = events.filter(e => e.type === 'accel').length;
  const harshBrake = events.filter(e => e.type === 'brake').length;
  // hard events per 10 km, counting short drives as 10 km so one event doesn't sink a short trip
  const per10 = (harshAccel + harshBrake) / (Math.max(dist, 10000) / 10000);
  const smoothness = per10 === 0 ? 5 : per10 <= 1 ? 4 : per10 <= 2 ? 3 : per10 <= 4 ? 2 : 1;
  const gaps = gapBefore.filter(Boolean).length;
  const withLimit = out.filter(o => o.limit != null);
  const osmShare = withLimit.length ? withLimit.filter(o => o.limitSrc === 'o').length / withLimit.length : 0;

  return {
    pts: out,
    speeding,
    events,
    summary: {
      start: n ? points[0].t : null,
      end: n ? points[n - 1].t : null,
      durationMs,
      movingMs,
      distance: dist,
      avgKmh: movingMs > 0 ? dist / (movingMs / 1000) * 3.6 : 0,
      maxKmh: maxV,
      stops,
      harshAccel,
      harshBrake,
      smoothness,
      gaps,
      speedingCount: speeding.length,
      speedingDist: speeding.reduce((s, x) => s + x.dist, 0),
      speedingMs: speeding.reduce((s, x) => s + x.ms, 0),
      maxOver: speeding.reduce((m, x) => Math.max(m, x.maxOver), 0),
      osmShare,
      hasLimits: withLimit.length > 0,
    },
  };
}

// Douglas–Peucker on lat/lon, tolerance in metres. Returns kept indices.
export function simplifyIdx(points, tol) {
  const n = points.length;
  if (n < 3) return points.map((_, i) => i);
  const lat0 = points[0].la * Math.PI / 180;
  const X = p => p.lo * 111320 * Math.cos(lat0), Y = p => p.la * 110540;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = X(points[a]), ay = Y(points[a]), bx = X(points[b]), by = Y(points[b]);
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = X(points[i]), py = Y(points[i]);
      let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const res = [];
  for (let i = 0; i < n; i++) if (keep[i]) res.push(i);
  return res;
}
