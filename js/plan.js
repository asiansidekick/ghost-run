// Planning a route: find places (OpenStreetMap's free Nominatim search) and get a route through your
// stops: by road (the free public OSRM server), by bike or on foot (FOSSGIS's free OSRM servers, which
// know cycle paths, footpaths and trails), or as straight lines across anything. No keys, no sign-up.
import { hav, bearing } from './analysis.js';

const compass = b => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(b / 45) % 8];
import { decodePolyline } from './share.js';
import { tidySteps } from './directions.js';

export const ROUTERS = {
  car: 'https://router.project-osrm.org/route/v1/driving/',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/',
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/',
};
const SEARCH = 'https://nominatim.openstreetmap.org/search';

// Nominatim asks for searches on submit only (no search-as-you-type), at most one a second.
export async function searchPlaces(q, near) {
  const u = new URL(SEARCH);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '6');
  u.searchParams.set('accept-language', 'en,th');
  if (near) {
    // prefer places near you, without ruling out anywhere else
    const [la, lo] = near, d = 0.6;
    u.searchParams.set('viewbox', [lo - d, la + d, lo + d, la - d].map(x => x.toFixed(4)).join(','));
  }
  const res = await fetch(u);
  if (!res.ok) throw new Error('Search service ' + res.status);
  const list = await res.json();
  return list.map(r => {
    const parts = String(r.display_name || '').split(', ');
    const name = r.name || parts[0] || 'Place';
    return { name, detail: parts.filter(p => p !== name).slice(0, 3).join(', '), la: +r.lat, lo: +r.lon };
  });
}

// Extra points along long straight roads, so "am I on the route?" can check every 20 m.
function densify(coords, every = 20) {
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    const [la, lo] = coords[i];
    if (i) {
      const [la0, lo0] = coords[i - 1];
      const d = hav(la0, lo0, la, lo);
      const n = Math.floor(d / every);
      for (let k = 1; k < n; k++) out.push({ la: la0 + (la - la0) * k / n, lo: lo0 + (lo - lo0) * k / n });
    }
    out.push({ la, lo });
  }
  return out;
}

// stops[0] is where you set off from; the rest are visited in order and the last is the destination.
// mode: 'car' | 'bike' | 'foot' | 'line'; kmh: the speed used to estimate time for straight lines
export async function routeThrough(stops, mode = 'car', kmh = 5) {
  if (stops.length < 2) throw new Error('Need a start and somewhere to go');
  if (mode === 'line' || !ROUTERS[mode]) return straightThrough(stops, kmh);
  const coords = stops.map(s => `${s.lo.toFixed(6)},${s.la.toFixed(6)}`).join(';');
  const res = await fetch(`${ROUTERS[mode]}${coords}?overview=full&geometries=polyline6&steps=true`);
  if (!res.ok) throw new Error('Directions service ' + res.status);
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes || !json.routes.length) throw new Error(json.message || 'No road route found');
  const r = json.routes[0];
  const raw = [];
  r.legs.forEach((leg, k) => {
    const last = k === r.legs.length - 1;
    const label = stops[k + 1].name || (last ? '' : `stop ${k + 1}`);
    leg.steps.forEach((s, j) => {
      if (j === leg.steps.length - 1 && s.maneuver.type === 'arrive') {
        s = { ...s, label, maneuver: { ...s.maneuver, type: last ? 'arrive' : 'waypoint' } };
      }
      raw.push(s);
    });
  });
  const points = densify(decodePolyline(r.geometry, 1e6));
  return { points, steps: tidySteps(raw), distance: r.distance, duration: r.duration, stopsAt: stopsAlong(points, stops) };
}

// Straight lines from stop to stop: across water, fields, trails no map knows, anything.
function straightThrough(stops, kmh) {
  const points = densify(stops.map(s => [s.la, s.lo]));
  let distance = 0;
  for (let i = 1; i < points.length; i++) distance += hav(points[i - 1].la, points[i - 1].lo, points[i].la, points[i].lo);
  const legs = stops.slice(1).map((s, k) => hav(stops[k].la, stops[k].lo, s.la, s.lo));
  const toward = k => `Head ${compass(bearing(stops[k].la, stops[k].lo, stops[k + 1].la, stops[k + 1].lo))} in a straight line`;
  const steps = [{ text: toward(0), name: '', distance: legs[0], type: 'depart', modifier: '', loc: [stops[0].lo, stops[0].la] }];
  stops.slice(1).forEach((s, k) => {
    const last = k === stops.length - 2;
    const label = s.name || (last ? '' : `stop ${k + 1}`);
    steps.push(last
      ? { text: label ? `Arrive at ${label}` : 'Arrive at the end of the route', name: '', distance: 0, type: 'arrive', modifier: '', loc: [s.lo, s.la] }
      : { text: `You've reached ${label}. ${toward(k + 1)}`, name: '', distance: legs[k + 1], type: 'waypoint', modifier: '', loc: [s.lo, s.la] });
  });
  return { points, steps, distance, duration: distance / (kmh / 3.6), stopsAt: stopsAlong(points, stops) };
}

// how far along the route each stop is (so we know which ones you've passed)
function stopsAlong(points, stops) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + hav(points[i - 1].la, points[i - 1].lo, points[i].la, points[i].lo));
  const stopsAt = [];
  let from = 0;
  for (const s of stops.slice(1)) {
    let best = from, bd = Infinity;
    for (let i = from; i < points.length; i++) {
      const d = hav(points[i].la, points[i].lo, s.la, s.lo);
      if (d < bd) { bd = d; best = i; }
    }
    from = best;
    stopsAt.push(cum[best]);
  }
  return stopsAt;
}
