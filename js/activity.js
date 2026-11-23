// What kind of trip a recording is: a drive, a ride, a run, a walk or hike, a boat trip, or anything else.
// It sets the units (speed or pace), whether speed limits apply, and how planned routes find their way
// (roads, bike paths, footpaths and trails, or straight lines across anything).
export const ACTIVITIES = {
  drive: { icon: '🚗', label: 'Drive', noun: 'drive', route: 'car', limits: true, kmh: 35, moveKmh: 10 },
  ride: { icon: '🚴', label: 'Ride', noun: 'ride', route: 'bike', kmh: 16, moveKmh: 8 },
  run: { icon: '🏃', label: 'Run', noun: 'run', route: 'foot', pace: true, kmh: 10, moveKmh: 6 },
  walk: { icon: '🥾', label: 'Walk or hike', noun: 'walk', route: 'foot', pace: true, kmh: 4.5, moveKmh: null },
  boat: { icon: '⛵', label: 'Boat', noun: 'boat trip', route: 'line', kmh: 15, moveKmh: 5 },
  other: { icon: '📍', label: 'Other', noun: 'trip', route: 'line', kmh: 10, moveKmh: null },
};
export const actKey = d => (d && ACTIVITIES[d.activity] ? d.activity : 'drive');
export const actOf = d => ACTIVITIES[actKey(d)];

// How a planned route finds its way between stops
export const ROUTE_MODES = {
  car: { icon: '🚗', label: 'Roads' },
  bike: { icon: '🚴', label: 'Bike' },
  foot: { icon: '🥾', label: 'Trails', long: 'footpaths and trails' },
  line: { icon: '📏', label: 'Straight', long: 'straight lines' },
};
// the activity that best fits a route mode, keeping the one you last used when it fits
export function activityForMode(mode, last) {
  if (!mode) return last || 'drive';
  if (ACTIVITIES[last] && ACTIVITIES[last].route === mode) return last;
  return { car: 'drive', bike: 'ride', foot: 'walk', line: ACTIVITIES[last] ? last : 'other' }[mode] || 'drive';
}

// minutes per km, as m:ss
export function fmtPace(kmh) {
  if (!kmh || kmh < 1) return '–:––';
  const s = Math.round(3600 / kmh);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// speed as the activity shows it: { n: the number, u: its unit }
export function speedFor(act, kmh) {
  return act.pace ? { n: fmtPace(kmh), u: 'min/km' } : { n: String(Math.round(kmh || 0)), u: 'km/h' };
}

// A guess for imported tracks: the file's own type when it has one, otherwise the typical moving speed
export function guessActivity(points, hint = '') {
  const h = String(hint).toLowerCase();
  if (/run|jog/.test(h)) return 'run';
  if (/walk|hik|trek/.test(h)) return 'walk';
  if (/cycl|bik|ride|ebike/.test(h)) return 'ride';
  if (/boat|sail|kayak|row|paddle|canoe|swim/.test(h)) return 'boat';
  if (/driv|car|motor/.test(h)) return 'drive';
  const sp = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (!a.t || !b.t || b.t <= a.t || b.t - a.t > 60000) continue;
    const dLat = (b.la - a.la) * 111320, dLon = (b.lo - a.lo) * 111320 * Math.cos(a.la * Math.PI / 180);
    const v = Math.hypot(dLat, dLon) / ((b.t - a.t) / 1000) * 3.6;
    if (v > 1.5) sp.push(v);
  }
  if (sp.length < 5) return 'drive';
  sp.sort((x, y) => x - y);
  const med = sp[Math.floor(sp.length / 2)];
  return med < 6.5 ? 'walk' : med < 14 ? 'run' : med < 28 ? 'ride' : 'drive';
}
