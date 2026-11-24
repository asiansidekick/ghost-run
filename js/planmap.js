// The map on the route planner: tilted 3D (MapLibre, buildings, rotate with two fingers) where the
// phone can, flat Leaflet otherwise. Both offer the same few things the planner needs.
import { open3D } from './map3d.js';

const lnglat = ([la, lo]) => [lo, la];

export async function plan3D(el) {
  const m3 = await open3D(el);
  const map = m3.map;
  map.setMaxPitch(70);
  map.jumpTo({ pitch: 50 });
  m3.cam = 'plan';
  const casing = m3.liveLine('#000', 10, 0.85), line = m3.liveLine('#00f0ff', 6, 1);
  let me = null;
  return {
    is3D: true,
    addPin(ll, html, onDrag) {
      const e = document.createElement('div');
      e.innerHTML = html;
      const mk = new maplibregl.Marker({ element: e, draggable: true }).setLngLat(lnglat(ll)).addTo(map);
      mk.on('dragend', () => { const p = mk.getLngLat(); onDrag([p.lat, p.lng]); });
      return { remove: () => mk.remove() };
    },
    setRoute(lls) { casing.setLatLngs(lls || []); line.setLatLngs(lls || []); },
    fit(lls) {
      const b = new maplibregl.LngLatBounds();
      lls.forEach(p => b.extend(lnglat(p)));
      const cam = map.cameraForBounds(b, { padding: 50, maxZoom: 17, bearing: map.getBearing() });
      if (cam) map.easeTo({ center: cam.center, zoom: cam.zoom - (map.getPitch() > 20 ? 0.6 : 0), duration: 600 });
    },
    setView(ll, z) { map.easeTo({ center: lnglat(ll), zoom: z, duration: 600 }); },
    center() { const c = map.getCenter(); return [c.lat, c.lng]; },
    zoom() { return map.getZoom(); },
    onClick(cb) { map.on('click', e => cb([e.lngLat.lat, e.lngLat.lng])); },
    setMe(ll) {
      if (!me) { const e = document.createElement('div'); e.className = 'me-dot'; me = new maplibregl.Marker({ element: e }).setLngLat(lnglat(ll)).addTo(map); }
      else me.setLngLat(lnglat(ll));
    },
    tilt(on) { map.easeTo({ pitch: on ? 50 : 0, bearing: on ? map.getBearing() : 0, duration: 500 }); },
    remove() { m3.remove(); },
  };
}

export function flatPlanMap(el, newMap) {
  const map = newMap(el);
  let route = null, me = null;
  return {
    is3D: false,
    addPin(ll, html, onDrag) {
      const mk = L.marker(ll, { icon: L.divIcon({ className: 'dot-wrap', html, iconSize: [28, 28], iconAnchor: [14, 14] }), draggable: true }).addTo(map);
      mk.on('dragend', () => { const p = mk.getLatLng(); onDrag([p.lat, p.lng]); });
      return { remove: () => mk.remove() };
    },
    setRoute(lls) {
      if (route) { route.remove(); route = null; }
      if (lls && lls.length) route = L.layerGroup([L.polyline(lls, { color: '#000', weight: 10, opacity: 0.8 }), L.polyline(lls, { color: '#00f0ff', weight: 6 })]).addTo(map);
    },
    fit(lls) { map.fitBounds(L.latLngBounds(lls), { padding: [30, 30] }); },
    setView(ll, z) { map.setView(ll, z); },
    center() { const c = map.getCenter(); return [c.lat, c.lng]; },
    zoom() { return map.getZoom(); },
    onClick(cb) { map.on('click', e => cb([e.latlng.lat, e.latlng.lng])); },
    setMe(ll) {
      if (!me) me = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#00f0ff', fillOpacity: 1, interactive: false }).addTo(map);
      else me.setLatLng(ll);
    },
    remove() { try { map.stop(); } catch {} setTimeout(() => { try { map.off(); map.remove(); } catch {} }, 600); },
  };
}
