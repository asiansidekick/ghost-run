// A made-up drive along Sukhumvit Road (Asok to On Nut) so the app can be tried before a real drive.
import { hav } from './analysis.js';

const PATH = [
  [13.73745, 100.56030], [13.73460, 100.56500], [13.73050, 100.56970], [13.72780, 100.57360],
  [13.72430, 100.57840], [13.72180, 100.58200], [13.71960, 100.58510], [13.71720, 100.58830],
  [13.71520, 100.59160], [13.71240, 100.59520], [13.70880, 100.59860], [13.70560, 100.60110],
];

export function sampleDrive() {
  const cum = [0];
  for (let i = 1; i < PATH.length; i++) cum.push(cum[i - 1] + hav(...PATH[i - 1], ...PATH[i]));
  const total = cum[cum.length - 1];
  const at = s => {
    let k = 1; while (k < cum.length - 1 && cum[k] < s) k++;
    const f = (s - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
    return [PATH[k - 1][0] + f * (PATH[k][0] - PATH[k - 1][0]), PATH[k - 1][1] + f * (PATH[k][1] - PATH[k - 1][1])];
  };
  // stops (distance m, wait s, braking m/s²) and target speeds (km/h) for the stretch before each stop
  const stops = [
    { d: 1050, wait: 35, brake: 2.4, target: 48, accel: 1.8 },
    { d: 2500, wait: 50, brake: 4.6, target: 62, accel: 1.6 },   // one hard stop
    { d: 4700, wait: 25, brake: 2.2, target: 91, accel: 3.4 },   // quick getaway, over 80 for a while
    { d: total, wait: 0, brake: 2.0, target: 50, accel: 1.6 },
  ];
  const t0 = Date.now() - 3600 * 1000;
  const pts = [];
  let s = 0, v = 0, t = t0, k = 0, waiting = 0, braking = false;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  while (k < stops.length && pts.length < 3000) {
    const st = stops[k];
    if (waiting > 0) { waiting--; v = 0; }
    else {
      const remain = st.d - s;
      const need = (v * v) / (2 * st.brake);
      if (braking || remain <= need + v) { braking = true; v = Math.min(v, Math.sqrt(2 * st.brake * Math.max(0, remain - v / 2))); }
      else if (v * 3.6 < st.target) v = Math.min(st.target / 3.6, v + st.accel);
      else v = Math.max(st.target / 3.6, v - 1.2);
      s += v;
      if (braking && (st.d - s < 3 || v < 0.6)) { s = Math.min(s, st.d); v = 0; waiting = st.wait; braking = false; k++; }
    }
    const [la, lo] = at(Math.min(s, total));
    pts.push({ t, la: +(la + rnd() * 0.00002).toFixed(6), lo: +(lo + rnd() * 0.00002).toFixed(6), ac: 5, s: +Math.max(0, v + rnd() * 0.3).toFixed(2), m: null });
    t += 1000;
    if (k === stops.length - 1 && s >= total - 1) break;
  }
  return { id: 'sample', status: 'done', name: 'Sample: Sukhumvit, Asok to On Nut', startedAt: pts[0].t, endedAt: pts[pts.length - 1].t, points: pts, sample: true };
}
