// Following a route while recording: where you are along it, how much is left, whether you've
// left it, and (when the route came from a timed drive) where that drive's ghost would be now.
import { hav } from './analysis.js';

const ON_ROUTE_M = 60;
const START_ZONE_M = 400;   // the ghost waits until you reach the first stretch of the route

export function guideFromDrive(drive, name) {
  return { name, from: drive.from || '', points: drive.points.map(p => ({ la: p.la, lo: p.lo, t: p.t })) };
}
export function guideFromRoute(route) {
  const g = { name: route.name || 'Route', from: route.from || '', points: route.points.map(p => ({ la: p.la, lo: p.lo })) };
  // a route planned in the app also carries its turns, stops and expected time
  if (route.plan) Object.assign(g, { plan: route.plan, steps: route.steps, distance: route.distance, duration: route.duration });
  return g;
}

export class GuideTracker {
  constructor(guide, { anywhere = false } = {}) {
    this.name = guide.name;
    this.pts = guide.points;
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) this.cum.push(this.cum[i - 1] + hav(this.pts[i - 1].la, this.pts[i - 1].lo, this.pts[i].la, this.pts[i].lo));
    this.total = this.cum[this.cum.length - 1];
    this.hasTimes = this.pts.length > 1 && this.pts[0].t != null;
    this.anywhere = anywhere;
    this.idx = -1;
    this.startT = null;
    this.state = { started: false, off: false };
  }

  nearest(p, from, to) {
    let best = from, bd = Infinity;
    for (let i = Math.max(0, from); i <= Math.min(this.pts.length - 1, to); i++) {
      const d = hav(this.pts[i].la, this.pts[i].lo, p.la, p.lo);
      if (d < bd) { bd = d; best = i; }
    }
    return { i: best, d: bd };
  }

  update(p) {
    const n = this.pts.length;
    if (this.idx < 0) {
      let end = n - 1;
      if (!this.anywhere) while (end > 0 && this.cum[end] > START_ZONE_M) end--;
      const m = this.nearest(p, 0, end);
      if (m.d > ON_ROUTE_M) {
        this.state = { started: false, distToStart: hav(this.pts[0].la, this.pts[0].lo, p.la, p.lo), remaining: this.total };
        return this.state;
      }
      this.idx = m.i;
      this.startT = p.t;
      this.guideStartT = this.hasTimes ? this.pts[m.i].t : null;
    }
    let m = this.nearest(p, this.idx - 10, this.idx + 120);
    if (m.d > ON_ROUTE_M) {
      // rejoined further along (or took a short cut)? look over the whole route
      const g = this.nearest(p, 0, n - 1);
      if (g.d <= ON_ROUTE_M / 2) m = g;
    }
    const off = m.d > ON_ROUTE_M;
    if (!off) this.idx = m.i;
    const remaining = Math.max(0, this.total - this.cum[this.idx]);
    const st = { started: true, off, offBy: m.d, idx: this.idx, remaining, finished: remaining < 40 && !off };
    if (this.hasTimes) {
      const yours = p.t - this.startT;
      const theirs = this.pts[this.idx].t - this.guideStartT;
      st.deltaS = (yours - theirs) / 1000; // positive: you're behind the ghost
    }
    this.state = st;
    return st;
  }

  // Where the earlier drive was after the same time since the start.
  ghostAt(t) {
    if (!this.hasTimes || this.startT == null) return null;
    const target = this.guideStartT + (t - this.startT);
    const P = this.pts;
    if (target >= P[P.length - 1].t) return { la: P[P.length - 1].la, lo: P[P.length - 1].lo, done: true, v: 0 };
    let lo = 0, hi = P.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid].t <= target) lo = mid; else hi = mid; }
    const a = P[lo], b = P[hi];
    const f = b.t > a.t ? (target - a.t) / (b.t - a.t) : 0;
    const v = b.t > a.t ? hav(a.la, a.lo, b.la, b.lo) / ((b.t - a.t) / 1000) * 3.6 : 0;
    return { la: a.la + f * (b.la - a.la), lo: a.lo + f * (b.lo - a.lo), done: false, v };
  }
}
