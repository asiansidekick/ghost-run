// A tilted 3D map for replays (buildings stand up, the camera can follow the car), built on MapLibre.
// It mirrors what the flat Leaflet replay map shows: coloured lines, pins and moving dots.
import { loadMapLibre } from './livemap.js';
import { loadStyle, styleNow, isVector, mapTheme, add3dBuildings, labelLayerId, RASTER_STYLE } from './basemap.js';
import { bearing } from './analysis.js';
import { addTerrain } from './terrain.js';

// Pinch (or mouse wheel) that only changes how close the camera sits; the camera keeps following.
export function pinchZoom(el, onDelta) {
  let d0 = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', e => { if (e.touches.length === 2) d0 = dist(e.touches); }, { passive: true });
  el.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !d0) return;
    e.preventDefault();
    const d = dist(e.touches);
    onDelta(Math.log2(d / d0));
    d0 = d;
  }, { passive: false });
  el.addEventListener('touchend', e => { if (e.touches.length < 2) d0 = null; }, { passive: true });
  el.addEventListener('wheel', e => { e.preventDefault(); onDelta(-e.deltaY / 300); }, { passive: false });
}

// autoCam: the camera is driven by the replay; fingers only zoom (no pan or turn that would fight it)
export async function open3D(el, { autoCam = false } = {}) {
  const theme = mapTheme();
  await Promise.all([loadMapLibre(), loadStyle(theme)]);
  const m = new Map3D(el, theme, { autoCam });
  try { await Promise.race([m.ready, new Promise((_, no) => setTimeout(() => no(new Error('3D map timed out')), 12000))]); }
  catch (e) { m.remove(); throw e; }
  return m;
}

export class Map3D {
  constructor(el, theme, { autoCam = false } = {}) {
    const style = styleNow(theme);
    this.vector = isVector(style);
    this.theme = theme;
    this.heading = null;
    this.map = new maplibregl.Map({
      container: el, style: this.vector ? style : RASTER_STYLE, center: [100.5018, 13.7563], zoom: 12, pitch: 66,
      attributionControl: { compact: true }, maxPitch: 85,
    });
    this.lines = 0;
    this.cam = 'heli';
    this.zoomBias = 0; // set by pinching: how much closer (+) or further (−) than the camera's own choice
    if (autoCam) {
      for (const h of ['dragPan', 'dragRotate', 'scrollZoom', 'touchZoomRotate', 'touchPitch', 'doubleClickZoom', 'boxZoom', 'keyboard']) this.map[h]?.disable();
      pinchZoom(el, d => {
        this.zoomBias = Math.max(-4, Math.min(3, this.zoomBias + d));
        this.map.jumpTo({ zoom: this.map.getZoom() + d });
        if (this.onBias) this.onBias(this.zoomBias);
      });
    }
    this.ready = new Promise(res => this.map.once('style.load', () => {
      if (this.vector) add3dBuildings(this.map, theme, 0.9);
      this.before = this.vector ? labelLayerId(this.map) : undefined;
      addTerrain(this.map, { three: true, moving: autoCam, theme, before: this.before });
      res();
    }));
  }

  // lines: [{ coords: [[la, lo], ...], color, weight, opacity, dash }]
  addLines(lines) {
    const id = 'l' + this.lines++;
    const fc = { type: 'FeatureCollection', features: lines.filter(l => l.coords.length > 1).map(l => ({
      type: 'Feature', properties: { color: l.color, w: l.weight || 4, o: l.opacity ?? 1, dash: !!l.dash },
      geometry: { type: 'LineString', coordinates: l.coords.map(([la, lo]) => [lo, la]) },
    })) };
    this.map.addSource(id, { type: 'geojson', data: fc });
    const paint = { 'line-color': ['get', 'color'], 'line-width': ['*', ['get', 'w'], 1.3], 'line-opacity': ['get', 'o'] };
    this.map.addLayer({ id, type: 'line', source: id, filter: ['!', ['get', 'dash']], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint }, this.before);
    this.map.addLayer({ id: id + 'd', type: 'line', source: id, filter: ['get', 'dash'], paint: { ...paint, 'line-dasharray': [1.5, 2] } }, this.before);
    return id;
  }

  // a line that changes (a trail): returns { setLatLngs }
  liveLine(color, weight = 3, opacity = 0.9) {
    const id = this.addLines([]);
    const src = this.map.getSource(id);
    return {
      setLatLngs: lls => src.setData({ type: 'FeatureCollection', features: lls.length > 1 ? [{
        type: 'Feature', properties: { color, w: weight, o: opacity, dash: false },
        geometry: { type: 'LineString', coordinates: lls.map(([la, lo]) => [lo, la]) },
      }] : [] }),
    };
  }

  // start, finish and hard-braking spots: drawn on the map itself, so far-off ones fade into the distance
  pin([la, lo], fill) {
    const f = { type: 'Feature', properties: { fill }, geometry: { type: 'Point', coordinates: [lo, la] } };
    if (!this.pins) {
      this.pins = { type: 'FeatureCollection', features: [f] };
      this.map.addSource('pins', { type: 'geojson', data: this.pins });
      this.map.addLayer({ id: 'pins', type: 'circle', source: 'pins', paint: {
        'circle-color': ['get', 'fill'], 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
        'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map',
      } });
    } else { this.pins.features.push(f); this.map.getSource('pins').setData(this.pins); }
  }

  // a dot with the same look as on the flat map; returns a Leaflet-like { setLatLng, getElement }
  dot(html, [la, lo]) {
    const el = document.createElement('div');
    el.className = 'dot-wrap dot3d';
    el.innerHTML = html;
    const mk = new maplibregl.Marker({ element: el, pitchAlignment: 'viewport', rotationAlignment: 'viewport' }).setLngLat([lo, la]).addTo(this.map);
    return { setLatLng: ([a, b]) => mk.setLngLat([b, a]), getElement: () => el };
  }

  fit(lls, { padding = 40, duration = 0 } = {}) {
    const b = new maplibregl.LngLatBounds();
    lls.forEach(([la, lo]) => b.extend([lo, la]));
    // frame it as if flat, then tilt and step back a little so the far side still fits
    const cam = this.map.cameraForBounds(b, { padding, maxZoom: 18, bearing: this.map.getBearing() });
    if (!cam) return;
    const opts = { center: cam.center, zoom: Math.min(18, cam.zoom - 0.8), pitch: 66, bearing: this.map.getBearing() };
    if (duration) this.map.easeTo({ ...opts, duration }); else this.map.jumpTo(opts);
  }

  // keep several moving dots framed: glide the camera a little toward the framing each frame
  // Several moving dots: a camera that glides, eased by time (not by frame) so it's equally smooth
  // at any frame rate. It pans quickly, zooms out quickly when someone nears the edge, zooms in
  // slowly as the pack bunches up, and slowly turns to face the way the race is heading.
  track(lls, padding = 50, heading = null, must = null) {
    const now = performance.now(), dt = Math.min(0.1, ((now - (this.lastTrack || now)) / 1000) || 0.016);
    this.lastTrack = now;
    const ease = tau => 1 - Math.exp(-dt / tau);
    const z = this.map.getZoom(), br = this.map.getBearing();
    let nb = br;
    if (heading != null) { const d = ((heading - br + 540) % 360) - 180; if (Math.abs(d) > 10) nb = br + d * ease(3); }
    const b = new maplibregl.LngLatBounds();
    lls.forEach(([la, lo]) => b.extend([lo, la]));
    const cam = this.map.cameraForBounds(b, { padding, maxZoom: 18, bearing: nb });
    if (!cam) return;
    const c = this.map.getCenter(), tc = maplibregl.LngLat.convert(cam.center);
    let tz = Math.min(18.5, cam.zoom - 0.5 + this.zoomBias);
    // whoever is off screen (or about to be) wins: zoom out until they're back
    const off = (must || lls).some(p => !this.inView(p, 0.06));
    if (off) tz = Math.min(tz, z - 0.25);
    // otherwise move toward the framing, zooming in readily but out only when it's really needed
    const goal = off || tz - z > 0.15 || z - tz > 0.4 ? tz : z;
    const kz = ease(goal < z ? (off ? 0.5 : 1.2) : 1.4), kc = ease(0.6);
    this.map.jumpTo({ center: [c.lng + (tc.lng - c.lng) * kc, c.lat + (tc.lat - c.lat) * kc], zoom: z + (goal - z) * kz, pitch: 66, bearing: nb });
  }
  resetTrack() { this.lastTrack = null; }

  // chase camera: behind the car, facing where it's going (heading smoothed so it doesn't swing)
  follow([la, lo], from, { duration = 0, speed = null } = {}) {
    // 'heli' is the chase camera (race footage): low and tight behind the car, swinging round with it;
    // 'street' is a calmer, higher view
    const chase = this.cam !== 'street';
    // eased by real time, so the camera moves like a steady operator whatever the frame rate
    const now = performance.now(), dt = Math.min(0.1, ((now - (this.lastFollow || now)) / 1000) || 0.016);
    this.lastFollow = now;
    const ease = tau => (duration ? 1 : 1 - Math.exp(-dt / tau));
    if (from && (from[0] !== la || from[1] !== lo)) {
      const h = bearing(from[0], from[1], la, lo);
      if (this.heading == null) this.heading = h;
      else {
        const d = ((h - this.heading + 540) % 360) - 180;
        // small wiggles are ignored; real bends are followed smoothly
        if (Math.abs(d) > 4) this.heading = (this.heading + d * ease(chase ? 0.9 : 1.6) + 360) % 360;
        // how hard we're turning (eased): used to swing the camera out wide through bends
        this.turn = (this.turn || 0) + (Math.max(-60, Math.min(60, d)) - (this.turn || 0)) * ease(1.5);
      }
    }
    if (speed != null) this.speed = this.speed == null ? speed : this.speed + (speed - this.speed) * ease(3);
    // pulls back a little as the speed rises, like a camera car keeping pace
    const pull = Math.min(1, (this.speed || 0) / 120) * 0.4;
    // buildings go see-through close in, so a tower between the camera and the car doesn't hide it
    this.buildingOpacity(chase ? 0.4 : 0.75);
    const opts = { center: [lo, la], zoom: Math.max(12, Math.min(20, (chase ? 18.4 - pull : 17.4) + this.zoomBias)), pitch: chase ? 70 : 60, bearing: this.heading ?? this.map.getBearing() };
    const el = this.map.getContainer();
    el.classList.toggle('cam-chase', chase);
    // the car sits low in the picture, with the road ahead filling the rest
    // through a bend the car slides toward the inside of the picture, as if the camera car swings wide
    const swing = chase ? -(this.turn || 0) / 60 * el.clientWidth * 0.12 : 0;
    opts.offset = [swing, el.clientHeight * (chase ? 0.24 : 0.15)];
    this.map.easeTo({ ...opts, duration });
  }

  buildingOpacity(o) {
    if (this.bop === o || !this.map.getLayer('building-3d')) return;
    this.bop = o;
    this.map.setPaintProperty('building-3d', 'fill-extrusion-opacity', o);
  }

  inView([la, lo], inset = 0.15) {
    const c = this.map.getContainer(), p = this.map.project([lo, la]);
    return p.x > c.clientWidth * inset && p.x < c.clientWidth * (1 - inset) && p.y > c.clientHeight * inset && p.y < c.clientHeight * (1 - inset);
  }

  // show or hide a set of lines added with addLines
  showLines(id, on) {
    for (const l of [id, id + 'd']) if (this.map.getLayer(l)) this.map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
  }

  remove() { try { this.map.remove(); } catch {} }
}
