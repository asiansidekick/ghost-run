// The live map while recording: a 3D, heading-up view that turns with you (like a sat-nav),
// or a flat north-up view. Built on MapLibre with OpenFreeMap vector maps (3D buildings, day and night);
// loaded only when needed.
import { styleNow, isVector, mapTheme, add3dBuildings, labelLayerId } from './basemap.js';
let loading = null;
export function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (!loading) loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/maplibre-gl.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'vendor/maplibre-gl.js';
    s.onload = () => resolve(window.maplibregl);
    s.onerror = () => { loading = null; reject(new Error('map library failed to load')); };
    document.head.appendChild(s);
  });
  return loading;
}

export function webglOk() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

const line = coords => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });

export class LiveMap {
  constructor(el, { center, onUserMove } = {}) {
    this.el = el;
    this.mode = 'pov';
    this.heading = 0;
    this.ready = false;
    this.onUserMove = onUserMove;
    this.theme = mapTheme();
    const style = styleNow(this.theme);
    this.vector = isVector(style);
    el.classList.add('theme-' + this.theme);
    this.map = new maplibregl.Map({
      container: el, style, center: center ? [center[1], center[0]] : [100.5018, 13.7563],
      zoom: 16, pitch: 0, attributionControl: { compact: true }, dragRotate: true, pitchWithRotate: true,
    });
    this.loaded = new Promise(res => this.map.on('load', () => {
      const m = this.map;
      if (this.vector) add3dBuildings(m, this.theme, 0.55);
      const before = this.vector ? labelLayerId(m) : undefined;
      m.addSource('guide', { type: 'geojson', data: line([]) });
      m.addSource('trail', { type: 'geojson', data: line([]) });
      // line widths grow with zoom, like a sat-nav
      const w = k => ['interpolate', ['exponential', 1.5], ['zoom'], 12, k * 0.45, 16, k, 19, k * 1.8];
      m.addLayer({ id: 'guide-casing', type: 'line', source: 'guide', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#000', 'line-width': w(14), 'line-opacity': 0.85 } }, before);
      m.addLayer({ id: 'guide', type: 'line', source: 'guide', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#facc15', 'line-width': w(8) } }, before);
      m.addLayer({ id: 'trail', type: 'line', source: 'trail', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3b82f6', 'line-width': w(5), 'line-opacity': 0.9 } }, before);
      this.ready = true;
      res();
    }));
    // a finger on the map means "let me look around": stop following until Re-centre
    for (const ev of ['dragstart', 'rotatestart', 'pitchstart']) this.map.on(ev, e => { if (e.originalEvent && this.onUserMove) this.onUserMove(); });
    this.map.on('zoomstart', e => { if (e.originalEvent && this.onUserMove) this.onUserMove(); });
  }

  marker(html, cls) {
    const el = document.createElement('div');
    el.className = 'ml-marker ' + (cls || '');
    el.innerHTML = html;
    return new maplibregl.Marker({ element: el, rotationAlignment: 'viewport', pitchAlignment: 'viewport' });
  }

  async setGuide(points) {
    await this.loaded;
    this.map.getSource('guide').setData(line(points.map(p => [p.lo, p.la])));
    const s = points[0], e = points[points.length - 1];
    this.marker('<i class="pin start"></i>').setLngLat([s.lo, s.la]).addTo(this.map);
    this.marker('<i class="pin finish"></i>').setLngLat([e.lo, e.la]).addTo(this.map);
  }

  async setTrail(track) {
    await this.loaded;
    this.map.getSource('trail').setData(line(track.map(([la, lo]) => [lo, la])));
  }

  setMe(ll, speedText, over) {
    if (!this.me) {
      this.meEl = document.createElement('div');
      this.meEl.className = 'ml-me';
      this.meEl.innerHTML = '<div class="me-arrow"></div><span class="spd">0</span>';
      // only the arrow turns; the speed label stays upright
      this.me = new maplibregl.Marker({ element: this.meEl, rotationAlignment: 'viewport', pitchAlignment: 'viewport' }).setLngLat([ll[1], ll[0]]).addTo(this.map);
      this.map.on('rotate', () => this.turnArrow());
    }
    this.me.setLngLat([ll[1], ll[0]]);
    this.turnArrow();
    this.meEl.classList.toggle('over', !!over);
    const sp = this.meEl.querySelector('.spd');
    if (sp) sp.textContent = speedText;
  }

  turnArrow() {
    const a = this.meEl && this.meEl.querySelector('.me-arrow');
    if (a) a.style.transform = `rotate(${this.heading - this.map.getBearing()}deg)`;
  }

  setGhost(ll, label) {
    if (!this.ghost) {
      this.ghost = this.marker('<div class="live-dot ghost-dot" style="--c:#e2e8f0"><i></i><span class="spd">Ghost</span></div>').setLngLat([ll[1], ll[0]]).addTo(this.map);
    }
    this.ghost.setLngLat([ll[1], ll[0]]);
    const sp = this.ghost.getElement().querySelector('.spd');
    if (sp) sp.textContent = label;
  }

  // Move the camera to you. In POV mode the map turns so your direction of travel points up,
  // tilts like a sat-nav and puts you low on the screen so you see the road ahead.
  follow(ll, ahead) {
    const center = [ll[1], ll[0]];
    if (this.mode === 'pov') {
      const h = this.el.clientHeight;
      this.map.easeTo({ center, bearing: this.heading, pitch: 58, zoom: 17, offset: [0, h * 0.2], duration: 900, easing: t => t });
    } else if (ahead) {
      const b = new maplibregl.LngLatBounds(center, center).extend([ahead[1], ahead[0]]);
      this.map.fitBounds(b, { padding: { top: 140, bottom: 90, left: 50, right: 90 }, maxZoom: 17, bearing: 0, pitch: 0, duration: 700 });
    } else {
      this.map.easeTo({ center, bearing: 0, pitch: 0, zoom: Math.max(this.map.getZoom(), 15), duration: 700 });
    }
  }

  fitPoints(lls) {
    const b = new maplibregl.LngLatBounds();
    lls.forEach(([la, lo]) => b.extend([lo, la]));
    this.map.fitBounds(b, { padding: 60, maxZoom: 16, bearing: 0, pitch: 0, duration: 0 });
  }

  // Heading from GPS when it gives one, otherwise from your last few metres of travel; smoothed.
  updateHeading(gpsHeading, track) {
    let h = gpsHeading != null && !isNaN(gpsHeading) ? gpsHeading : null;
    if (h == null && track.length > 1) {
      const [la1, lo1] = track[track.length - 1];
      for (let i = track.length - 2; i >= 0 && i >= track.length - 8; i--) {
        const [la0, lo0] = track[i];
        const dy = (la1 - la0) * 110540, dx = (lo1 - lo0) * 111320 * Math.cos(la1 * Math.PI / 180);
        if (Math.hypot(dx, dy) > 8) { h = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; break; }
      }
    }
    if (h == null) return this.heading;
    let d = ((h - this.heading + 540) % 360) - 180;
    this.heading = (this.heading + d * 0.6 + 360) % 360;
    return this.heading;
  }

  remove() { try { this.map.remove(); } catch {} }
}

// Fallback for phones without WebGL: the same interface on a flat, north-up Leaflet map.
export class FlatLiveMap {
  constructor(el, { center, onUserMove } = {}) {
    this.mode = 'north';
    this.heading = 0;
    this.map = L.map(el, { zoomControl: false }).setView(center || [13.7563, 100.5018], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(this.map);
    this.casing = L.polyline([], { color: '#000', weight: 13, opacity: 0.85 }).addTo(this.map);
    this.guide = L.polyline([], { color: '#facc15', weight: 7 }).addTo(this.map);
    this.trail = L.polyline([], { color: '#3b82f6', weight: 4, opacity: 0.9 }).addTo(this.map);
    this.map.on('dragstart', () => onUserMove && onUserMove());
  }
  setGuide(points) {
    const ll = points.map(p => [p.la, p.lo]);
    this.casing.setLatLngs(ll); this.guide.setLatLngs(ll);
    L.circleMarker(ll[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 }).addTo(this.map);
    L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#111', fillOpacity: 1 }).addTo(this.map);
  }
  setTrail(track) { this.trail.setLatLngs(track); }
  setMe(ll, speedText, over) {
    if (!this.me) this.me = L.marker(ll, { icon: L.divIcon({ className: 'dot-wrap', html: '<div class="live-dot" style="--c:#3b82f6"><i></i><span class="spd">0</span></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 1000, interactive: false }).addTo(this.map);
    this.me.setLatLng(ll);
    const el = this.me.getElement();
    el?.querySelector('.live-dot')?.classList.toggle('over', !!over);
    const sp = el?.querySelector('.spd'); if (sp) sp.textContent = speedText;
  }
  setGhost(ll, label) {
    if (!this.ghost) this.ghost = L.marker(ll, { icon: L.divIcon({ className: 'dot-wrap', html: '<div class="live-dot ghost-dot" style="--c:#e2e8f0"><i></i><span class="spd">Ghost</span></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 900, interactive: false }).addTo(this.map);
    this.ghost.setLatLng(ll);
    const sp = this.ghost.getElement()?.querySelector('.spd'); if (sp) sp.textContent = label;
  }
  follow(ll, ahead) {
    if (ahead) this.map.fitBounds(L.latLngBounds([ll, ahead]), { paddingTopLeft: [50, 120], paddingBottomRight: [50, 80], maxZoom: 17 });
    else this.map.panTo(ll);
  }
  fitPoints(lls) { this.map.fitBounds(L.latLngBounds(lls), { padding: [40, 40] }); }
  updateHeading() { return 0; }
  remove() { const m = this.map; try { m.stop(); } catch {} setTimeout(() => { try { m.remove(); } catch {} }, 600); }
}
