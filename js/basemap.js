// The base map under everything: sharp vector maps from OpenFreeMap (free, no key, OpenStreetMap data),
// in a light day style or a dark night style. Falls back to plain OpenStreetMap tiles when the
// vector maps can't load (no WebGL, offline, or the service is down).
import * as store from './store.js';
import { loadMapLibre, webglOk } from './livemap.js';
import { addTerrain } from './terrain.js';

const STYLE_URL = { light: 'https://tiles.openfreemap.org/styles/liberty', dark: 'https://tiles.openfreemap.org/styles/dark' };
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const VECTOR_ATTR = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' + OSM_ATTR;

export const RASTER_STYLE = {
  version: 8,
  sources: { osm: { type: 'raster', tileSize: 256, maxzoom: 19, tiles: [OSM_TILES], attribution: OSM_ATTR } },
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#04070c' } }, { id: 'osm', type: 'raster', source: 'osm' }],
};

// 'auto' follows the time of day: dark from 6 PM to 6 AM
export function mapTheme() {
  const pref = store.settings().mapStyle || 'dark';
  if (pref === 'light' || pref === 'dark') return pref;
  const h = new Date().getHours();
  return h >= 18 || h < 6 ? 'dark' : 'light';
}

// The night map recoloured for the Neon HUD look: near-black ground, deep blue water,
// roads drawn in dim cyan (main roads brighter), quiet blue-grey labels.
const NEON = {
  background: { 'background-color': '#04070c' },
  water: { 'fill-color': '#061a2a' },
  waterway: { 'line-color': '#061a2a' },
  landuse_residential: { 'fill-color': '#05090f' },
  landcover_wood: { 'fill-color': '#04130f' },
  landuse_park: { 'fill-color': '#04130f' },
  building: { 'fill-color': '#08111a', 'fill-outline-color': '#0d2230' },
  'aeroway-area': { 'fill-color': '#060b12' },
  'aeroway-taxiway': { 'line-color': '#0c2230' },
  'aeroway-runway': { 'line-color': '#0c2a3a' },
  'aeroway-runway-casing': { 'line-color': 'rgba(0,240,255,0.15)' },
  highway_path: { 'line-color': '#0c2532' },
  highway_minor: { 'line-color': '#0e2836' },
  highway_major_casing: { 'line-color': 'rgba(0,200,230,0.28)' },
  highway_major_inner: { 'line-color': '#0a2a38' },
  highway_major_subtle: { 'line-color': '#11465a' },
  highway_motorway_casing: { 'line-color': 'rgba(0,240,255,0.45)' },
  highway_motorway_inner: { 'line-color': '#0b3546' },
  highway_motorway_subtle: { 'line-color': '#14566c' },
  railway_transit: { 'line-color': '#2a1a3a' },
  railway_minor: { 'line-color': '#2a1a3a' },
  railway: { 'line-color': '#3a1d4a' },
  railway_transit_dashline: { 'line-color': '#04070c' },
  railway_minor_dashline: { 'line-color': '#04070c' },
  railway_dashline: { 'line-color': '#04070c' },
};
function neon(style) {
  for (const l of style.layers || []) {
    const p = NEON[l.id];
    if (p) l.paint = { ...(l.paint || {}), ...p };
    else if (l.type === 'symbol' && l.paint && 'text-color' in l.paint) {
      l.paint['text-color'] = l.id.startsWith('highway') ? '#4f7584' : '#7f9aa8';
      l.paint['text-halo-color'] = 'rgba(4,7,12,0.9)';
    }
  }
}

const styles = {};
const resolved = {};
// The style description, fetched once per theme. Resolves to null when it can't be had.
export function loadStyle(theme = mapTheme()) {
  if (!styles[theme]) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    styles[theme] = fetch(STYLE_URL[theme], { signal: ctl.signal })
      .then(r => { if (!r.ok) throw new Error('style ' + r.status); return r.json(); })
      .then(s => { if (theme === 'dark') neon(s); resolved[theme] = s; return s; })
      .catch(e => { console.warn('Vector map unavailable, using plain tiles', e); delete styles[theme]; return null; })
      .finally(() => clearTimeout(timer));
  }
  return styles[theme];
}
// Already-fetched style for this theme (or the plain tiles), without waiting.
export function styleNow(theme = mapTheme()) {
  const s = resolved[theme];
  return s ? JSON.parse(JSON.stringify(s)) : RASTER_STYLE;
}
export const isVector = style => style !== RASTER_STYLE && !!(style && style.sources && style.sources.openmaptiles);

// Buildings that stand up when the map is tilted; the dark style has none of its own.
export function add3dBuildings(map, theme, opacity = 0.8) {
  if (!map.getSource('openmaptiles')) return;
  if (!map.getLayer('building-3d')) {
    const firstSymbol = map.getStyle().layers.find(l => l.type === 'symbol');
    map.addLayer({
      id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
      filter: ['!', ['has', 'hide_3d']],
      paint: {
        'fill-extrusion-base': ['get', 'render_min_height'], 'fill-extrusion-height': ['get', 'render_height'],
        'fill-extrusion-color': theme === 'dark' ? '#123544' : 'hsl(35,8%,85%)', 'fill-extrusion-opacity': opacity,
      },
    }, firstSymbol && firstSymbol.id);
  } else map.setPaintProperty('building-3d', 'fill-extrusion-opacity', opacity);
}

// Where our own lines go: above roads and buildings, below the street names and place labels.
export function labelLayerId(map) {
  const layers = map.getStyle().layers;
  const b = layers.findIndex(l => l.id === 'building-3d');
  const l = layers.slice(b + 1).find(x => x.type === 'symbol');
  return l ? l.id : undefined;
}

let leafletGL = null;
function loadLeafletGL() {
  if (window.L && L.maplibreGL) return Promise.resolve();
  if (!leafletGL) leafletGL = loadMapLibre().then(() => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/leaflet-maplibre-gl.js';
    s.onload = resolve;
    s.onerror = () => { leafletGL = null; reject(new Error('map plugin failed to load')); };
    document.head.appendChild(s);
  }));
  return leafletGL;
}

// Map credits as a small (i) in the corner that opens on tap, instead of a strip across the map.
export function creditsButton(map) {
  const C = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd: () => {
      const el = L.DomUtil.create('div', 'map-credits');
      el.innerHTML = '<button type="button" aria-label="Map credits">i</button><span hidden></span>';
      const txt = el.querySelector('span');
      el.querySelector('button').onclick = e => {
        e.stopPropagation();
        txt.innerHTML = map.getContainer().dataset.attr === 'vector' ? VECTOR_ATTR : OSM_ATTR;
        txt.hidden = !txt.hidden;
      };
      L.DomEvent.disableClickPropagation(el);
      return el;
    },
  });
  new C().addTo(map);
}

// Give a Leaflet map (drive, race, route and plan maps) its base map.
export function addBasemap(map) {
  let dead = false;
  map.on('unload', () => { dead = true; });
  const raster = () => { if (!dead && map._mapPane) L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTR }).addTo(map); };
  if (!webglOk()) { raster(); return; }
  const theme = mapTheme();
  map.getContainer().classList.add('theme-' + theme);
  Promise.all([loadLeafletGL(), loadStyle(theme)]).then(([, style]) => {
    if (dead || !map._mapPane) return; // the map was closed meanwhile
    if (!style) { raster(); return; }
    const gl = L.maplibreGL({ style: styleNow(theme) }).addTo(map);
    map.getContainer().dataset.attr = 'vector';
    // hill shading and contour lines on the flat maps too
    try { const m = gl.getMaplibreMap(); m.once('style.load', () => addTerrain(m, { theme, before: labelLayerId(m) })); } catch (e) { console.warn(e); }
  }).catch(() => raster());
}
