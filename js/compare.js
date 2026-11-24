// Finds drives that cover the same route and lines them up over the stretch they all share,
// so their times can be compared and replayed side by side.
import { hav, analyse } from './analysis.js';
import { ACTIVITIES, actOf } from './activity.js';

const NEAR_M = 70;          // how close two tracks must be to count as the same road
const MATCH_SHARE = 0.85;   // share of sampled points that must be near the other track
const MIN_OVERLAP = 0.6;    // shared stretch must be at least this much of the reference drive

function sampleIdx(points, every = 50) {
  const idx = [0];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += hav(points[i - 1].la, points[i - 1].lo, points[i].la, points[i].lo);
    if (acc >= every) { idx.push(i); acc = 0; }
  }
  if (idx[idx.length - 1] !== points.length - 1) idx.push(points.length - 1);
  return idx;
}

function cumDist(points) {
  const d = [0];
  for (let i = 1; i < points.length; i++) d.push(d[i - 1] + hav(points[i - 1].la, points[i - 1].lo, points[i].la, points[i].lo));
  return d;
}

function nearest(points, idxList, p) {
  let best = -1, bd = Infinity;
  for (const i of idxList) {
    const d = hav(points[i].la, points[i].lo, p.la, p.lo);
    if (d < bd) { bd = d; best = i; }
  }
  return { i: best, d: bd };
}

function nearestIn(points, p, from = 0, to = points.length - 1) {
  let best = from, bd = Infinity;
  for (let i = from; i <= to; i++) {
    const d = hav(points[i].la, points[i].lo, p.la, p.lo);
    if (d < bd) { bd = d; best = i; }
  }
  return { i: best, d: bd };
}

// Where drive B sits along reference drive A, or null if they aren't the same route.
export function overlapOn(A, B) {
  if (A.length < 3 || B.length < 3) return null;
  const sa = sampleIdx(A), sb = sampleIdx(B);
  let near = 0;
  for (const j of sb) if (nearest(A, sa, B[j]).d <= NEAR_M) near++;
  if (near / sb.length < MATCH_SHARE) return null;
  const aStart = nearestIn(A, B[0]).i;
  const aEnd = nearestIn(A, B[B.length - 1]).i;
  if (aEnd <= aStart) return null; // driven the other way
  const cum = cumDist(A);
  if (cum[aEnd] - cum[aStart] < MIN_OVERLAP * cum[cum.length - 1]) return null;
  let nearA = 0, countA = 0;
  for (const i of sa) {
    if (i < aStart || i > aEnd) continue;
    countA++;
    if (nearest(B, sb, A[i]).d <= NEAR_M) nearA++;
  }
  if (!countA || nearA / countA < MATCH_SHARE) return null;
  return { aStart, aEnd };
}

export function labelFor(d, myName) {
  const who = d.from || myName || 'You';
  const when = new Date(d.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const a = d.activity && d.activity !== 'drive' && ACTIVITIES[d.activity];
  return `${a ? a.icon + ' ' : ''}${who}, ${when}`;
}

// ref: the drive being looked at; candidates: other drives. Returns entries sorted fastest first.
export function compareGroup(ref, candidates, myName) {
  const matched = [];
  for (const c of candidates) {
    if (c === ref || c.id && c.id === ref.id || !c.points || c.points.length < 3) continue;
    const o = overlapOn(ref.points, c.points);
    if (o) matched.push({ d: c, o });
  }
  if (!matched.length) return null;
  const cs = Math.max(0, ...matched.map(m => m.o.aStart));
  const ce = Math.min(ref.points.length - 1, ...matched.map(m => m.o.aEnd));
  if (ce - cs < 3) return null;
  const startP = ref.points[cs], endP = ref.points[ce];
  const all = [{ d: ref }, ...matched];
  const entries = all.map(({ d }) => {
    const i0 = nearestIn(d.points, startP).i;
    const i1 = nearestIn(d.points, endP, i0 + 1).i;
    const A = analyse(d.points, actOf(d).limits ? d.limits : undefined);
    const slice = A.pts.slice(i0, i1 + 1);
    const ms = d.points[i1].t - d.points[i0].t;
    const dist = slice[slice.length - 1].dist - slice[0].dist;
    const red = A.speeding.filter(s => s.i1 >= i0 && s.i0 <= i1);
    return {
      drive: d, A, i0, i1, ms, dist,
      label: labelFor(d, myName),
      isRef: d === ref,
      avgKmh: ms > 0 ? dist / (ms / 1000) * 3.6 : 0,
      redCount: red.length,
      redMaxOver: red.reduce((m, s) => Math.max(m, s.maxOver), 0),
      gaps: slice.filter((p, k) => k && p.gapBefore).length,
    };
  }).filter(e => e.i1 > e.i0 && e.ms > 0);
  entries.sort((a, b) => a.ms - b.ms);
  return { entries, refStart: cs, refEnd: ce, stretchM: cumDist(ref.points.slice(cs, ce + 1)).pop() };
}

// Position of an entry after `elapsed` ms on the shared stretch, interpolated between fixes.
export function positionAt(e, elapsed) {
  const P = e.A.pts;
  const t0 = P[e.i0].t, target = t0 + elapsed;
  if (target >= P[e.i1].t) { const p = P[e.i1]; return { la: p.la, lo: p.lo, v: p.v, g: 0, over: p.over, limit: p.limit, i: e.i1, done: true, prog: p.dist - P[e.i0].dist }; }
  let lo = e.i0, hi = e.i1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid].t <= target) lo = mid; else hi = mid; }
  const a = P[lo], b = P[hi];
  const f = b.t > a.t ? (target - a.t) / (b.t - a.t) : 0;
  return {
    la: a.la + f * (b.la - a.la), lo: a.lo + f * (b.lo - a.lo),
    v: a.v + f * (b.v - a.v), g: a.a + f * (b.a - a.a), over: a.over, limit: a.limit, i: lo, done: false,
    prog: a.dist + f * (b.dist - a.dist) - P[e.i0].dist,
  };
}

// Seconds into an entry's run when it had covered `d` metres of the stretch.
export function timeAtProg(e, d) {
  const P = e.A.pts, base = P[e.i0].dist;
  let lo = e.i0, hi = e.i1;
  if (d <= 0) return 0;
  if (P[hi].dist - base <= d) return P[hi].t - P[e.i0].t;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid].dist - base <= d) lo = mid; else hi = mid; }
  const a = P[lo], b = P[hi], f = b.dist > a.dist ? (d - (a.dist - base)) / (b.dist - a.dist) : 0;
  return a.t + f * (b.t - a.t) - P[e.i0].t;
}
