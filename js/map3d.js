// A tilted 3D map for replays (buildings stand up, the camera can follow the car), built on MapLibre.
// It mirrors what the flat Leaflet replay map shows: coloured lines, pins and moving dots.
import { loadMapLibre } from './livemap.js';
import { loadStyle, styleNow, isVector, mapTheme, add3dBuildings, labelLayerId, RASTER_STYLE } from './basemap.js';
import { bearing } from './analysis.js';

export async function open3D(el) {
  const theme = mapTheme();
  await Promise.all([loadMapLibre(), loadStyle(theme)]);
  const m = new Map3D(el, theme);
  try { await Promise.race([m.ready, new Promise((_, no) => setTimeout(() => no(new Error('3D map timed out')), 12000))]); }
  catch (e) { m.remove(); throw e; }
  return m;
}

export class Map3D {
  constructor(el, theme) {
    const style = styleNow(theme);
    this.vector = isVector(style);
    this.theme = theme;
    this.heading = null;
    this.map = new maplibregl.Map({
      container: el, style: this.vector ? style : RASTER_STYLE, center: [100.5018, 13.7563], zoom: 12, pitch: 66,
      attributionControl: { compact: true }, maxPitch: 80,
    });
    this.lines = 0;
    // a pinch sets how close the chase camera sits from then on
    this.cam = 'heli';
    this.map.on('zoomend', e => { if (e.originalEvent) this.manualZoom = this.map.getZoom(); });
    this.ready = new Promise(res => this.map.on('load', () => {
      if (this.vector) add3dBuildings(this.map, theme, 0.9);
      this.before = this.vector ? labelLayerId(this.map) : undefined;
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

  pin([la, lo], fill, title) {
    const el = document.createElement('div');
    el.className = 'pin3d';
    el.style.background = fill;
    if (title) el.title = title;
    return new maplibregl.Marker({ element: el }).setLngLat([lo, la]).addTo(this.map);
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
  track(lls, padding = 50) {
    const b = new maplibregl.LngLatBounds();
    lls.forEach(([la, lo]) => b.extend([lo, la]));
    const cam = this.map.cameraForBounds(b, { padding, maxZoom: 18, bearing: this.map.getBearing() });
    if (!cam) return;
    const c = this.map.getCenter(), z = this.map.getZoom(), tc = maplibregl.LngLat.convert(cam.center);
    const tz = Math.min(18, cam.zoom - 0.9), k = 0.25;
    this.map.jumpTo({ center: [c.lng + (tc.lng - c.lng) * k, c.lat + (tc.lat - c.lat) * k], zoom: z + (tz - z) * k, pitch: 66 });
  }

  // chase camera: behind the car, facing where it's going (heading smoothed so it doesn't swing)
  follow([la, lo], from, { duration = 0 } = {}) {
    if (from && (from[0] !== la || from[1] !== lo)) {
      const h = bearing(from[0], from[1], la, lo);
      if (this.heading == null) this.heading = h;
      else { const d = ((h - this.heading + 540) % 360) - 180; this.heading = (this.heading + d * (this.cam === 'street' ? 0.08 : 0.035) + 360) % 360; }
    }
    // 'heli': drone footage, low behind the car looking along the road; 'street': closer, a little higher
    const street = this.cam === 'street';
    const opts = { center: [lo, la], zoom: this.manualZoom ?? (street ? 17.8 : 17.2), pitch: street ? 62 : 74, bearing: this.heading ?? this.map.getBearing() };
    // the car sits in the lower part of the picture, with the road ahead above it
    opts.offset = [0, this.map.getContainer().clientHeight * 0.2];
    this.map.easeTo({ ...opts, duration });
  }

  inView([la, lo], inset = 0.15) {
    const c = this.map.getContainer(), p = this.map.project([lo, la]);
    return p.x > c.clientWidth * inset && p.x < c.clientWidth * (1 - inset) && p.y > c.clientHeight * inset && p.y < c.clientHeight * (1 - inset);
  }

  remove() { try { this.map.remove(); } catch {} }
}
