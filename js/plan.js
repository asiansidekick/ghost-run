// Planning a route: find places (OpenStreetMap's free Nominatim search) and get a road route
// through your stops (the free public OSRM server). No keys, no sign-up.
import { hav } from './analysis.js';
import { decodePolyline } from './share.js';
import { tidySteps } from './directions.js';

const ROUTE = 'https://router.project-osrm.org/route/v1/driving/';
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
export async function routeThrough(stops) {
  if (stops.length < 2) throw new Error('Need a start and somewhere to go');
  const coords = stops.map(s => `${s.lo.toFixed(6)},${s.la.toFixed(6)}`).join(';');
  const res = await fetch(`${ROUTE}${coords}?overview=full&geometries=polyline6&steps=true`);
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
  // how far along the route each stop is (so we know which ones you've passed)
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
  return { points, steps: tidySteps(raw), distance: r.distance, duration: r.duration, stopsAt };
}
