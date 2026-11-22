// Turn-by-turn directions for a shared route, from the free public OSRM server (OpenStreetMap roads).
import { hav } from './analysis.js';

const OSRM = 'https://router.project-osrm.org/match/v1/driving/';
const MAX_COORDS = 90;

function sample(points, every = 120) {
  const out = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += hav(points[i - 1].la, points[i - 1].lo, points[i].la, points[i].lo);
    if (acc >= every) { out.push(points[i]); acc = 0; }
  }
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function phrase(step) {
  const { type, modifier } = step.maneuver;
  const name = step.name || step.ref || '';
  const onto = name ? ` onto ${name}` : '';
  const dir = modifier ? modifier.replace('sharp ', 'sharp ').replace('slight ', 'slight ') : '';
  switch (type) {
    case 'depart': return name ? `Start on ${name}` : 'Start';
    case 'arrive': return 'Arrive at the end of the route';
    case 'roundabout': case 'rotary': return `At the roundabout, take exit ${step.maneuver.exit || ''}${onto}`.replace('exit  ', 'the exit ');
    case 'merge': return `Merge${dir ? ' ' + dir : ''}${onto}`;
    case 'on ramp': return `Take the ramp${dir ? ' on the ' + dir : ''}${onto}`;
    case 'off ramp': return `Take the exit${dir ? ' on the ' + dir : ''}${onto}`;
    case 'fork': return `Keep ${dir || 'ahead'}${onto}`;
    case 'end of road': return `At the end of the road, turn ${dir}${onto}`;
    case 'continue': return `Continue${dir && dir !== 'straight' ? ' ' + dir : ''}${onto}`;
    case 'new name': return `Continue${onto}`;
    default:
      if (dir === 'uturn') return `Make a U-turn${onto}`;
      if (dir === 'straight') return `Go straight${onto}`;
      return `Turn ${dir}${onto}`;
  }
}

export async function directionsFor(points) {
  const pts = sample(points);
  const steps = [];
  for (let i = 0; i < pts.length - 1; i += MAX_COORDS - 1) {
    const chunk = pts.slice(i, i + MAX_COORDS);
    if (chunk.length < 2) break;
    const coords = chunk.map(p => `${p.lo.toFixed(5)},${p.la.toFixed(5)}`).join(';');
    const radiuses = chunk.map(() => 30).join(';');
    const res = await fetch(`${OSRM}${coords}?steps=true&overview=false&tidy=true&gaps=ignore&radiuses=${radiuses}`);
    if (!res.ok) throw new Error('Directions service ' + res.status);
    const json = await res.json();
    if (json.code !== 'Ok') throw new Error(json.message || json.code);
    for (const m of json.matchings) for (const leg of m.legs) for (const s of leg.steps) steps.push(s);
  }
  // OSRM gives a depart/arrive per leg; keep only the first and last, and fold straight-on steps into the one before.
  const out = [];
  steps.forEach((s, k) => {
    const t = s.maneuver.type;
    const isFirst = k === 0, isLast = k === steps.length - 1;
    const prev = out[out.length - 1];
    const sameRoad = prev && (s.name || '') === (prev.name || '');
    const filler = (t === 'depart' && !isFirst) || (t === 'arrive' && !isLast) ||
      ((t === 'continue' || t === 'new name') && (!s.maneuver.modifier || s.maneuver.modifier === 'straight') && sameRoad) ||
      (t === 'turn' && s.maneuver.modifier === 'straight' && sameRoad);
    if (filler && prev) { prev.distance += s.distance; return; }
    out.push({ text: phrase(s), name: s.name, distance: s.distance, type: t, modifier: s.maneuver.modifier, loc: s.maneuver.location });
  });
  return out;
}

// Google Maps accepts only a handful of stops, so pass evenly spaced points along the route.
export function googleMapsUrl(points) {
  const a = points[0], b = points[points.length - 1];
  const via = [];
  const n = Math.min(8, Math.max(0, points.length - 2));
  for (let k = 1; k <= n; k++) {
    const p = points[Math.round(k * (points.length - 1) / (n + 1))];
    via.push(`${p.la.toFixed(5)},${p.lo.toFixed(5)}`);
  }
  const u = new URL('https://www.google.com/maps/dir/');
  u.searchParams.set('api', '1');
  u.searchParams.set('origin', `${a.la.toFixed(5)},${a.lo.toFixed(5)}`);
  u.searchParams.set('destination', `${b.la.toFixed(5)},${b.lo.toFixed(5)}`);
  if (via.length) u.searchParams.set('waypoints', via.join('|'));
  u.searchParams.set('travelmode', 'driving');
  return u.toString();
}
