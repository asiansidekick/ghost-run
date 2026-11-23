// Turn-by-turn for a route being followed: a list of turns with their distance along the route,
// from the directions service when it answers, otherwise worked out from the shape of the route.
import { hav, bearing, simplifyIdx } from './analysis.js';
import { directionsFor } from './directions.js';

function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + hav(points[i - 1].la, points[i - 1].lo, points[i].la, points[i].lo));
  return cum;
}

function nearestIdx(points, la, lo, from = 0) {
  let best = from, bd = Infinity;
  for (let i = from; i < points.length; i++) {
    const d = hav(points[i].la, points[i].lo, la, lo);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Turns from the route's own shape: any bend sharper than 30 degrees.
export function geometricTurns(points) {
  const cum = cumulative(points);
  const keep = simplifyIdx(points, 12);
  const turns = [];
  const pointAt = (i, metres, dir) => {
    let j = i;
    while (j + dir >= 0 && j + dir < points.length && Math.abs(cum[j] - cum[i]) < metres) j += dir;
    return points[j];
  };
  for (let k = 1; k < keep.length - 1; k++) {
    const i = keep[k], p = points[i];
    const a = pointAt(i, 35, -1), b = pointAt(i, 35, 1);
    const inB = bearing(a.la, a.lo, p.la, p.lo), outB = bearing(p.la, p.lo, b.la, b.lo);
    const diff = ((outB - inB + 540) % 360) - 180; // negative = left
    const mag = Math.abs(diff);
    if (mag < 30) continue;
    const side = diff < 0 ? 'left' : 'right';
    const modifier = mag > 160 ? 'uturn' : mag > 120 ? 'sharp ' + side : mag < 55 ? 'slight ' + side : side;
    const prev = turns[turns.length - 1];
    if (prev && cum[i] - prev.at < 40) continue;
    turns.push({ at: cum[i], la: p.la, lo: p.lo, modifier, type: 'turn', name: '', text: modifier === 'uturn' ? 'Make a U-turn' : `${modifier.startsWith('slight') ? 'Bear' : 'Turn'} ${modifier.replace('slight ', '')}` });
  }
  turns.push({ at: cum[cum.length - 1], la: points[points.length - 1].la, lo: points[points.length - 1].lo, type: 'arrive', modifier: '', name: '', text: 'Arrive at the end of the route' });
  return turns;
}

// Directions steps (from the directions service) placed along the route's points.
export function turnsFromSteps(points, steps) {
  const cum = cumulative(points);
  let from = 0;
  const turns = [];
  for (const s of steps) {
    if (s.type === 'depart' || !s.loc) continue;
    const i = nearestIdx(points, s.loc[1], s.loc[0], from);
    from = i;
    turns.push({ at: cum[i], la: s.loc[1], lo: s.loc[0], type: s.type, modifier: s.modifier || '', name: s.name || '', text: s.text });
  }
  return turns;
}

export async function turnsFor(points, steps = null) {
  if (steps && steps.length) return { source: 'osrm', turns: turnsFromSteps(points, steps) };
  try {
    const turns = turnsFromSteps(points, await directionsFor(points));
    if (turns.length) return { source: 'osrm', turns };
  } catch (e) { console.warn('Directions service unavailable, using route shape', e); }
  return { source: 'shape', turns: geometricTurns(points) };
}

export function arrowFor(t) {
  if (t.type === 'arrive') return '🏁';
  if (t.type === 'waypoint') return '📍';
  if (t.type === 'roundabout' || t.type === 'rotary') return '⟳';
  const m = t.modifier || '';
  if (m === 'uturn') return '⤺';
  if (m === 'sharp left') return '↙';
  if (m === 'sharp right') return '↘';
  if (m === 'slight left') return '↖';
  if (m === 'slight right') return '↗';
  if (m === 'left') return '←';
  if (m === 'right') return '→';
  return '↑';
}

export function roundDist(m) {
  if (m >= 1000) return (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km';
  if (m >= 100) return Math.round(m / 50) * 50 + ' m';
  return Math.max(10, Math.round(m / 10) * 10) + ' m';
}

// Spoken prompts: one well ahead of each turn and one just before it.
export class Voice {
  constructor() { this.said = new Set(); this.on = true; }
  unlock() {
    // iPhone only lets a page speak after a tap, so say something short on Start.
    try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch {}
  }
  say(text) {
    if (!this.on || !('speechSynthesis' in window)) return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-GB'; u.rate = 1; speechSynthesis.speak(u); } catch {}
  }
  update(turn, distToTurn, speedKmh) {
    if (!turn) return;
    const key = turn.at.toFixed(0);
    const farAt = Math.max(250, Math.min(800, speedKmh * 8)); // further out at higher speed
    if (distToTurn <= farAt && distToTurn > 80 && !this.said.has(key + 'far')) {
      this.said.add(key + 'far');
      this.say(turn.type === 'arrive' ? `In ${spoken(distToTurn)}, you reach the end of the route` : `In ${spoken(distToTurn)}, ${lower(turn.text)}`);
    } else if (distToTurn <= 60 && !this.said.has(key + 'near')) {
      this.said.add(key + 'near');
      this.say(turn.type === 'arrive' ? 'You have reached the end of the route' : turn.text);
    }
  }
}
const spoken = m => m >= 1000 ? `${(m / 1000).toFixed(1).replace('.0', '')} kilometres` : `${Math.round(m / 50) * 50 || 50} metres`;
const lower = s => s.charAt(0).toLowerCase() + s.slice(1);
