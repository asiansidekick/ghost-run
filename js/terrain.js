// Hills and valleys: free global terrain tiles (Terrarium format, from the AWS Open Data terrain set,
// about 30 m detail, no key). Used for 3D terrain on tilted maps, hill shading, and contour lines
// (drawn in the phone with maplibre-contour). Settings → Terrain turns it down or off.
import * as store from './store.js';

export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_MAX = 15;

// 'auto': 3D hills on maps you move yourself (the planner), shading and contours where the camera
// moves every frame (replays, races, navigation), since raised terrain there can stutter on phones
// · 'on': 3D hills everywhere · 'flat': shading and contours only · 'off'
export const terrainPref = () => store.settings().terrain || 'auto';

let contourLib = null, demSource = null;
function loadContours() {
  if (window.mlcontour) return Promise.resolve();
  if (!contourLib) contourLib = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/maplibre-contour.min.js';
    s.onload = resolve;
    s.onerror = () => { contourLib = null; reject(new Error('contour library failed to load')); };
    document.head.appendChild(s);
  });
  return contourLib;
}
function contourSource() {
  if (!demSource) {
    demSource = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: 13, worker: true, cacheSize: 60 });
    demSource.setupMaplibre(maplibregl);
  }
  return demSource;
}

// Add terrain to a MapLibre map whose style has loaded. three: a tilted map that could raise the ground
// in 3D; moving: its camera is driven every frame (replays, races, navigation).
export async function addTerrain(map, { three = false, moving = false, theme = 'light', before } = {}) {
  const pref = terrainPref();
  if (pref === 'off' || !map.getStyle()) return;
  const dark = theme === 'dark';
  try {
    if (!map.getSource('dem-hs')) {
      map.addSource('dem-hs', { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: DEM_MAX });
      // shading goes under roads and buildings: just above the land and water fills
      const layers = map.getStyle().layers;
      const firstLine = layers.find(l => l.type === 'line' || l.type === 'fill-extrusion' || l.type === 'symbol');
      map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-hs', paint: {
        'hillshade-exaggeration': 0.45,
        'hillshade-shadow-color': dark ? 'rgba(0,0,0,0.55)' : 'rgba(60,50,40,0.35)',
        'hillshade-highlight-color': dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.35)',
        'hillshade-accent-color': dark ? 'rgba(0,0,0,0.3)' : 'rgba(60,50,40,0.2)',
      } }, firstLine && firstLine.id);
    }
    if (three && (pref === 'on' || (pref === 'auto' && !moving)) && !map.getSource('dem')) {
      map.addSource('dem', { type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: DEM_MAX });
      map.setTerrain({ source: 'dem', exaggeration: 1.25 });
    }
  } catch (e) { console.warn('Terrain unavailable', e); }
  // contour lines with heights, in metres
  try {
    await loadContours();
    if (!map.getStyle() || map.getSource('contours')) return;
    const src = contourSource();
    map.addSource('contours', { type: 'vector', maxzoom: 15, tiles: [src.contourProtocolUrl({
      multiplier: 1,
      thresholds: { 9: [200, 1000], 11: [100, 500], 12: [50, 250], 13: [20, 100], 14: [10, 50], 15: [5, 25] },
      elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
    })] });
    const col = dark ? 'rgba(190,200,220,0.28)' : 'rgba(120,90,60,0.35)';
    map.addLayer({ id: 'contour-lines', type: 'line', source: 'contours', 'source-layer': 'contours',
      paint: { 'line-color': col, 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] } }, before);
    const glyphs = !!map.getStyle().glyphs;
    if (glyphs) map.addLayer({ id: 'contour-labels', type: 'symbol', source: 'contours', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0],
      layout: { 'symbol-placement': 'line', 'text-size': 10, 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'], 'text-font': ['Noto Sans Regular'] },
      paint: { 'text-color': dark ? 'rgba(200,210,230,0.7)' : 'rgba(110,80,50,0.8)', 'text-halo-color': dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)', 'text-halo-width': 1 } }, before);
  } catch (e) { console.warn('Contours unavailable', e); }
}
