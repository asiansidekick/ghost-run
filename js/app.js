import * as store from './store.js';
import { Recorder, finishDrive } from './recorder.js';
import { analyse } from './analysis.js';
import { computeLimits, defaultLimits, TH_DEFAULTS } from './limits.js';
import { speedChart, gChart, xToIndex } from './charts.js';
import { packDrive, packRoute, unpack, toDrive, shareUrl, shareLink } from './share.js';
import { directionsFor, googleMapsUrl } from './directions.js';
import { gpx, csv, saveFile } from './export.js';
import { sampleDrive } from './sample.js';
import { compareGroup, positionAt } from './compare.js';
import { guideFromDrive, guideFromRoute } from './guide.js';

const BANGKOK = [13.7563, 100.5018];
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const recorder = new Recorder();
let cleanup = null;

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKm = m => m >= 10000 ? (m / 1000).toFixed(0) + ' km' : m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (ms < 60000) return Math.round(ms / 1000) + ' s';
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}
const fmtClock = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtDate = t => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const driveTitle = d => d.name || `Drive, ${fmtDate(d.startedAt)}`;

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function newMap(el, opts = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, ...opts }).setView(BANGKOK, 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  return map;
}

// ---------- router ----------
async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  window.scrollTo(0, 0);
  const h = location.hash;
  try {
    if (h.startsWith('#s=') || h.startsWith('#r=')) return await sharedView(h.slice(3));
    if (h === '#/record') return recordView();
    if (h.startsWith('#/drive/')) return await ownDriveView(decodeURIComponent(h.slice(8)));
    if (h === '#/settings') return settingsView();
    if (h.startsWith('#/route/')) { const r = await store.getDrive(decodeURIComponent(h.slice(8))); if (r) return renderRoute(r); location.hash = '#/'; return; }
    if (h.startsWith('#/race/')) return await raceFromStore(decodeURIComponent(h.slice(7)));
    return await homeView();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<section class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Back to my drives</a></section>`;
  }
}
window.addEventListener('hashchange', route);

// recording pill in the top bar, visible on every screen while a drive is being logged
const pill = document.createElement('a');
pill.className = 'rec-pill'; pill.href = '#/record'; pill.hidden = true;
$('.topbar').insertBefore(pill, $('.topbar-link'));
recorder.addEventListener('update', () => {
  pill.hidden = !recorder.active || location.hash === '#/record';
  if (recorder.active) pill.textContent = `● ${Math.round(recorder.speedKmh)} km/h`;
});
recorder.addEventListener('autostop', async () => {
  const id = await recorder.stop();
  toast('Parked for a while, so the drive was stopped and saved.', 4000);
  if (id) location.hash = '#/drive/' + id;
});

// ---------- home ----------
async function homeView() {
  const drives = (await store.allDrives()).sort((a, b) => b.startedAt - a.startedAt);
  const interrupted = drives.filter(d => d.status === 'recording' && d.id !== recorder.id);
  const done = drives.filter(d => d.status === 'done');
  const routes = drives.filter(d => d.status === 'route');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  view.innerHTML = `
    ${interrupted.map(d => `
      <section class="card warn-card">
        <strong>A drive was interrupted</strong>
        <p class="muted">Started ${esc(fmtDate(d.startedAt))}. The page closed while recording; everything up to then is saved.</p>
        <div class="row">
          <button class="btn" data-resume="${esc(d.id)}">Continue recording</button>
          <button class="btn ghost" data-finish="${esc(d.id)}">Finish it</button>
        </div>
      </section>`).join('')}
    <a href="#/record" class="btn big start">${recorder.active ? 'Back to recording' : 'Start a drive'}</a>
    ${!standalone ? `<p class="hint">Tip: add Ghost Run to your home screen. On iPhone tap Share, then “Add to Home Screen”. On Android use the browser menu.</p>` : ''}
    ${routes.length ? `<h2 class="section-title">My routes</h2><ul class="drive-list">${routes.map(r => `<li><a href="#/route/${encodeURIComponent(r.id)}" class="drive-item">
        <div class="drive-name">${esc(r.name)}</div>
        <div class="drive-meta">${r.from ? `From ${esc(r.from)} · ` : ''}Tap to follow it</div></a></li>`).join('')}</ul>` : ''}
    <h2 class="section-title">My drives</h2>
    ${done.length ? `<ul class="drive-list">${done.map(d => {
      const A = d.summary || {};
      return `<li><a href="#/drive/${encodeURIComponent(d.id)}" class="drive-item">
        <div class="drive-name">${esc(driveTitle(d))}</div>
        <div class="drive-meta">${d.guide ? `Followed ${esc(d.guide.name)} · ` : ''}${esc(fmtDate(d.startedAt))} · ${fmtKm(A.distance || 0)} · ${fmtDur(A.durationMs || 0)}
        ${A.speedingCount ? `<span class="tag red">${A.speedingCount} over limit</span>` : A.hasLimits ? '<span class="tag green">Under limits</span>' : ''}</div>
      </a></li>`;
    }).join('')}</ul>` : `
      <section class="card empty">
        <p>No drives yet. Mount your phone, tap <strong>Start a drive</strong>, and tap Stop once you're parked.</p>
        <button class="btn ghost" id="sample">Show me a sample drive</button>
        <p class="muted small">Have a backup file? <a href="#/settings">Restore it in Settings</a>.</p>
      </section>`}
  `;
  view.querySelectorAll('[data-resume]').forEach(b => b.onclick = () => {
    recorder.start(b.dataset.resume);
    location.hash = '#/record';
  });
  view.querySelectorAll('[data-finish]').forEach(b => b.onclick = async () => {
    const d = await finishDrive(b.dataset.finish);
    if (d && d.points.length < 2) { await store.deleteDrive(d.id); route(); return; }
    location.hash = '#/drive/' + b.dataset.finish;
  });
  const sb = $('#sample');
  if (sb) sb.onclick = async () => {
    await store.putDrive(sampleDrive());
    await store.putDrive(sampleDrive({ friend: true }));
    location.hash = '#/drive/sample';
  };
}

// ---------- record ----------
let pendingGuide = null;
function followGuide(guide) {
  if (recorder.active) { toast('Stop the current drive first.'); return; }
  pendingGuide = guide;
  if (location.hash === '#/record') route(); else location.hash = '#/record';
}

function recordView() {
  if (!recorder.active) {
    const g = pendingGuide;
    view.innerHTML = `
      ${g ? `<section class="card banner follow-banner">
        <div><strong>Following:</strong> ${esc(g.name)}${g.points[0].t != null ? '<br><span class="small">A ghost car will drive it alongside you, starting when you reach the start of the route.</span>' : ''}</div>
        <button class="btn small ghost" id="nofollow">Don't follow</button>
      </section>` : ''}
      <section class="card">
        <h1>Before you set off</h1>
        <ol class="steps">
          <li>Put the phone in a fixed cradle, ideally plugged in to charge.</li>
          <li>Tap Start while you're parked. Allow location and motion access if asked.</li>
          <li>Leave this page open on screen while you drive. The screen stays on and the map follows you.</li>
          <li>Once parked, hold Stop. If you forget, it stops on its own after ${store.settings().autoStopMin} minutes parked.</li>
        </ol>
        <p class="muted small">Don't touch the phone while driving. Taking a call or switching apps pauses recording, and the gap shows on the map.</p>
      </section>
      <button class="btn big start" id="go">Start</button>`;
    if ($('#nofollow')) $('#nofollow').onclick = () => { pendingGuide = null; recordView(); };
    $('#go').onclick = () => { recorder.start(null, pendingGuide); pendingGuide = null; recordView(); };
    return;
  }
  const g = recorder.guide;
  view.innerHTML = `
    <section class="live live-map-mode">
      <div class="live-top">
        <div class="live-speed-sm"><span id="lv">0</span><small>km/h</small></div>
        <div class="live-mini">
          <div><span id="lt">0:00</span><small>time</small></div>
          <div><span id="ld">0 m</span><small>distance</small></div>
        </div>
        <div class="live-status" id="ls">Waiting for GPS…</div>
      </div>
      <div class="live-map-wrap">
        <div id="lmap" class="live-map"></div>
        <button class="btn small ghost recenter" id="recenter" hidden>Re-centre</button>
        ${g ? `<div class="guide-hud" id="gh"></div>` : ''}
      </div>
      <div class="live-flags" id="lf"></div>
      <button class="btn big hold" id="stop"><span class="hold-fill"></span><span class="hold-label">Hold to stop</span></button>
    </section>`;
  const map = newMap($('#lmap'));
  const blue = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  let guideLine = null;
  if (g) {
    guideLine = L.polyline(g.points.map(p => [p.la, p.lo]), { color: '#a78bfa', weight: 9, opacity: 0.45 }).addTo(map);
    const gp = g.points;
    L.circleMarker([gp[0].la, gp[0].lo], { radius: 7, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 }).addTo(map);
    L.circleMarker([gp[gp.length - 1].la, gp[gp.length - 1].lo], { radius: 7, color: '#fff', weight: 2, fillColor: '#111', fillOpacity: 1 }).addTo(map);
  }
  const trail = L.polyline(recorder.track, { color: blue, weight: 5 }).addTo(map);
  const me = L.marker(recorder.last ? [recorder.last.la, recorder.last.lo] : BANGKOK, { icon: dotIcon(blue), zIndexOffset: 1000, interactive: false }).addTo(map);
  const ghost = g && g.points[0].t != null
    ? L.marker([g.points[0].la, g.points[0].lo], { icon: L.divIcon({ className: 'dot-wrap', html: '<div class="live-dot ghost-dot" style="--c:#e2e8f0"><i></i><span class="spd">Ghost</span></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 900, interactive: false }).addTo(map)
    : null;
  if (recorder.last) map.setView([recorder.last.la, recorder.last.lo], 16);
  else if (guideLine) map.fitBounds(guideLine.getBounds(), { padding: [20, 20] });
  let follow = true;
  map.on('dragstart', () => { follow = false; $('#recenter').hidden = false; });
  $('#recenter').onclick = () => { follow = true; $('#recenter').hidden = true; if (recorder.last) map.setView([recorder.last.la, recorder.last.lo], Math.max(map.getZoom(), 16)); };
  let lastCount = -1;
  const upd = () => {
    if (!recorder.active) return;
    $('#lv').textContent = Math.round(recorder.speedKmh);
    $('#ld').textContent = fmtKm(recorder.distance);
    $('#ls').textContent = recorder.error || (recorder.count ? `Recording · GPS ±${Math.round(recorder.accuracy ?? 0)} m` : 'Waiting for GPS…');
    $('#ls').className = 'live-status ' + (recorder.error ? 'bad' : recorder.count ? 'ok' : '');
    $('#lf').innerHTML = [
      recorder.wakeLock ? 'Screen kept on' : 'Screen may sleep: keep this page open',
      recorder.motionOk ? 'Motion sensor on' : 'Using GPS for braking',
    ].map(t => `<span>${t}</span>`).join('');
    if (recorder.count !== lastCount && recorder.last) {
      const first = lastCount <= 0;
      lastCount = recorder.count;
      const ll = [recorder.last.la, recorder.last.lo];
      me.setLatLng(ll);
      const sp = me.getElement()?.querySelector('.spd'); if (sp) sp.textContent = Math.round(recorder.speedKmh);
      trail.setLatLngs(recorder.track);
      if (follow) first ? map.setView(ll, 16) : map.panTo(ll, { animate: true, duration: 0.5 });
    }
    if (g) {
      const st = recorder.guideState;
      let html;
      if (!st || !st.started) html = `<b>Head to the start</b><span>${st && st.distToStart != null ? fmtKm(st.distToStart) + ' away' : 'Waiting for GPS'}</span>`;
      else if (st.finished) html = `<b>🏁 Route done</b>${st.deltaS != null ? `<span class="${st.deltaS <= 0 ? 'good' : 'bad'}">${fmtGap(st.deltaS)}</span>` : ''}`;
      else html = `${st.off ? `<b class="bad">Off the route (${fmtKm(st.offBy)})</b>` : `<b>${fmtKm(st.remaining)} to go</b>`}${st.deltaS != null ? `<span class="${st.deltaS <= 0 ? 'good' : 'bad'}">${fmtGap(st.deltaS)}</span>` : ''}`;
      $('#gh').innerHTML = html;
    }
  };
  // the ghost glides between updates, timed from the latest GPS fix
  const ghostTick = ghost ? setInterval(() => {
    const tr = recorder.tracker;
    if (!tr || !recorder.last || recorder.lastFixAt == null) return;
    const gp = tr.ghostAt(recorder.last.t + (Date.now() - recorder.lastFixAt));
    if (!gp) return;
    ghost.setLatLng([gp.la, gp.lo]);
    const sp = ghost.getElement()?.querySelector('.spd');
    if (sp) sp.textContent = gp.done ? 'Ghost 🏁' : `Ghost ${Math.round(gp.v)}`;
  }, 250) : null;
  const tick = setInterval(() => { if (recorder.startedAt) $('#lt').textContent = fmtClock(Date.now() - recorder.startedAt); }, 1000);
  recorder.addEventListener('update', upd);
  upd();
  // hold-to-stop so a brush against the screen doesn't end the drive
  const btn = $('#stop');
  let holdT = null;
  const cancel = () => { clearTimeout(holdT); btn.classList.remove('holding'); };
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    btn.classList.add('holding');
    holdT = setTimeout(async () => {
      btn.classList.remove('holding');
      btn.disabled = true; $('.hold-label').textContent = 'Saving…';
      const id = await recorder.stop();
      location.hash = '#/drive/' + id;
    }, 1000);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, cancel));
  btn.addEventListener('contextmenu', e => e.preventDefault());
  cleanup = () => { clearInterval(tick); clearInterval(ghostTick); recorder.removeEventListener('update', upd); dropMap(map); };
}

// A single drive from a GPX or CSV file (ours or another logger's). Returns null for anything else.
function importTrack(text, filename = '') {
  let pts = [];
  const name = filename.replace(/\.(gpx|csv)$/i, '').replace(/[-_]+/g, ' ').trim();
  if (/<gpx[\s>]/i.test(text)) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const nodes = [...doc.getElementsByTagName('trkpt')];
    const list = nodes.length ? nodes : [...doc.getElementsByTagName('rtept')];
    pts = list.map(n => {
      const time = n.getElementsByTagName('time')[0]?.textContent;
      const sp = n.getElementsByTagName('speed')[0]?.textContent;
      return { t: time ? Date.parse(time) : null, la: +n.getAttribute('lat'), lo: +n.getAttribute('lon'), s: sp != null && sp !== '' ? +sp : null, m: null };
    });
  } else if (/^\s*[^\n]*\blat\b[^\n]*\blon/i.test(text)) {
    const rows = text.trim().split(/\r?\n/);
    const head = rows.shift().split(',').map(h => h.trim().toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const ti = col(/^time/), la = col(/^lat/), lo = col(/^(lon|lng)/), sp = col(/^speed_kmh$|^speed/);
    pts = rows.map(r => r.split(',')).map(c => ({
      t: ti >= 0 && c[ti] ? Date.parse(c[ti]) : null, la: +c[la], lo: +c[lo],
      s: sp >= 0 && c[sp] !== '' ? (head[sp] === 'speed_kmh' ? +c[sp] / 3.6 : +c[sp]) : null, m: null,
    }));
  } else return null;
  pts = pts.filter(p => isFinite(p.la) && isFinite(p.lo) && Math.abs(p.la) <= 90);
  if (pts.length < 2) throw new Error('no track points');
  const timed = pts.every(p => p.t && isFinite(p.t));
  const id = 'i' + Date.now().toString(36);
  if (!timed) return { id, status: 'route', name: name || 'Imported route', startedAt: Date.now(), points: pts.map(p => ({ la: p.la, lo: p.lo })) };
  pts.sort((a, b) => a.t - b.t);
  return { id, status: 'done', name: name || 'Imported drive', startedAt: pts[0].t, endedAt: pts[pts.length - 1].t, points: pts };
}

function fmtGap(s) {
  const a = Math.abs(Math.round(s));
  const txt = a >= 60 ? `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}` : `${a} s`;
  return a < 1 ? 'Level with the ghost' : s > 0 ? `${txt} behind the ghost` : `${txt} ahead of the ghost`;
}

// ---------- drive page ----------
async function ensureLimits(drive, save) {
  if (drive.limits && drive.limits.v && drive.limits.v.length === drive.points.length) return;
  drive.limits = await computeLimits(drive.points);
  if (save) await save();
}

async function ownDriveView(id) {
  view.innerHTML = `<p class="loading">Loading drive…</p>`;
  const drive = await store.getDrive(id);
  if (!drive) { view.innerHTML = `<section class="card"><p>That drive isn't on this phone.</p><a class="btn" href="#/">My drives</a></section>`; return; }
  if (drive.status === 'recording') { location.hash = recorder.id === id ? '#/record' : '#/'; return; }
  if (!drive.points || drive.points.length < 2) {
    view.innerHTML = `<section class="card"><h2>Too short to show</h2><p class="muted">This drive has fewer than two GPS readings. GPS may not have locked on.</p><button class="btn ghost" id="del">Delete it</button></section>`;
    $('#del').onclick = async () => { await store.deleteDrive(id); location.hash = '#/'; };
    return;
  }
  const save = async () => { drive.summary = analyse(drive.points, drive.limits).summary; await store.putDrive(drive); };
  // Show the drive straight away with Thai defaults, and look up posted limits in the background.
  const needsLookup = !drive.limits || drive.limits.status === 'defaults' || drive.limits.status === 'pending';
  if (!drive.limits) { drive.limits = { ...defaultLimits(drive.points), status: 'pending' }; await save(); }
  else if (!drive.summary) await save();
  renderDrive(drive, { own: true, save });
  if (needsLookup && !limitLookups.has(id)) {
    limitLookups.add(id);
    computeLimits(drive.points).then(async lim => {
      limitLookups.delete(id);
      if (lim.status !== 'osm' && drive.limits.status !== 'pending') return; // still offline: keep what we had
      drive.limits = lim;
      await save();
      if (location.hash === '#/drive/' + encodeURIComponent(id) || location.hash === '#/drive/' + id) {
        const y = window.scrollY;
        await route();
        window.scrollTo(0, y);
        toast(lim.status === 'osm' ? 'Speed limits updated from OpenStreetMap.' : 'Couldn’t reach OpenStreetMap. Using Thai defaults.');
      }
    });
  }
}
const limitLookups = new Set();

async function sharedView(payload) {
  view.innerHTML = `<p class="loading">Opening shared link…</p>`;
  let obj;
  try { obj = await unpack(payload); }
  catch { view.innerHTML = `<section class="card"><h2>This link looks broken</h2><p class="muted">It may have been cut short when it was sent. Ask your friend to share it again.</p><a class="btn" href="#/">My drives</a></section>`; return; }
  const d = toDrive(obj);
  if (d.kind === 'route') return renderRoute(d);
  if (!d.limits) await ensureLimits(d);
  renderDrive(d, { own: false });
}

function stars(n) { return '●'.repeat(n) + '○'.repeat(5 - n); }

function renderDrive(drive, { own, save }) {
  const A = analyse(drive.points, drive.limits);
  const S = A.summary;
  const lim = drive.limits || {};
  const limitsNote = lim.status === 'pending'
    ? 'Checking OpenStreetMap for posted speed limits. Until then this uses Thai defaults (80 km/h in greater Bangkok, 90 outside), and the page updates by itself.'
    : lim.status === 'defaults'
    ? 'Couldn’t reach OpenStreetMap, so every limit here is a Thai default (80 km/h in greater Bangkok, 90 outside).'
    : `About ${Math.round(S.osmShare * 100)}% of this route has a posted limit in OpenStreetMap; the rest uses Thai defaults (80 km/h in greater Bangkok, 90 outside). Limits are approximate.`;
  view.innerHTML = `
    ${!own ? `<section class="card banner">Shared drive${drive.from ? ` from <strong>${esc(drive.from)}</strong>` : ''}. The first and last few hundred metres may be hidden for privacy.</section>` : ''}
    <div class="title-row">
      ${own ? `<input class="title-input" id="name" value="${esc(drive.name)}" placeholder="${esc(driveTitle({ ...drive, name: '' }))}" aria-label="Drive name">` : `<h1>${esc(driveTitle(drive))}</h1>`}
    </div>
    <p class="muted small">${esc(fmtDate(S.start))} to ${esc(new Date(S.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</p>
    <div class="map" id="map"></div>
    <div class="replay">
      <button class="btn small" id="play" aria-label="Play replay">▶</button>
      <input type="range" id="scrub" min="0" max="${A.pts.length - 1}" value="0" aria-label="Replay position">
    </div>
    <div class="readout" id="readout"></div>
    <div class="legend"><span><i class="sw blue"></i>Under the limit</span><span><i class="sw red"></i>Over the limit</span><span><i class="sw gap"></i>Recording gap</span><span><i class="dot orange"></i>Hard braking or acceleration</span></div>

    <section class="stats">
      <div><b>${fmtKm(S.distance)}</b><small>distance</small></div>
      <div><b>${fmtDur(S.durationMs)}</b><small>total time</small></div>
      <div><b>${fmtDur(S.movingMs)}</b><small>moving time</small></div>
      <div><b>${Math.round(S.avgKmh)}</b><small>avg km/h moving</small></div>
      <div><b>${Math.round(S.maxKmh)}</b><small>top km/h</small></div>
      <div><b>${S.stops}</b><small>stops</small></div>
      <div><b>${S.harshBrake}</b><small>hard braking</small></div>
      <div><b>${S.harshAccel}</b><small>hard acceleration</small></div>
      <div><b class="stars">${stars(S.smoothness)}</b><small>smoothness</small></div>
    </section>

    <section class="card ${S.speedingCount ? 'red-card' : 'green-card'}">
      ${S.speedingCount
        ? `<strong>${S.speedingCount} stretch${S.speedingCount > 1 ? 'es' : ''} over the limit</strong>
           <p class="small">${fmtKm(S.speedingDist)} in total, ${fmtDur(S.speedingMs)}, up to ${Math.round(S.maxOver)} km/h over.</p>
           <ul class="over-list">${A.speeding.map((x, k) => `<li><button class="linkish" data-jump="${x.i0}">${fmtTime(A.pts[x.i0].t)}</button> · ${fmtKm(x.dist)} where the limit is ${x.limit}, up to ${Math.round(x.limit + x.maxOver)} km/h</li>`).join('')}</ul>`
        : `<strong>No stretches over the limit</strong>`}
      <p class="muted small">${esc(limitsNote)}</p>
    </section>
    <section id="same"></section>
    ${S.gaps ? `<p class="muted small">Recording paused ${S.gaps} time${S.gaps > 1 ? 's' : ''} (page closed or GPS lost). Gaps are shown dashed on the map.</p>` : ''}

    <h2 class="section-title">Speed</h2>
    <canvas class="chart" id="cs"></canvas>
    <p class="muted small chart-key"><i class="sw blue"></i> speed <i class="sw red"></i> over the limit <i class="sw limit"></i> speed limit</p>
    <h2 class="section-title">Acceleration and braking (g)</h2>
    <canvas class="chart" id="cg"></canvas>
    <p class="muted small chart-key">Above the line is speeding up, below is braking. Dotted lines mark hard acceleration (0.30 g) and hard braking (0.35 g).</p>

    <section class="actions">
      <button class="btn start-alt" id="follow">Follow this route with a ghost</button>
      <button class="btn" id="shareDrive">Share this drive</button>
      <button class="btn ghost" id="shareRoute">Share just the route</button>
      ${!own ? `<button class="btn ghost" id="saveCopy">Save to my drives</button>` : ''}
      <button class="btn ghost" id="gpx">Export GPX</button>
      <button class="btn ghost" id="csv">Export CSV</button>
      ${own ? `<button class="btn ghost" id="recheck">Recheck speed limits</button><button class="btn danger" id="delete">Delete drive</button>` : ''}
    </section>
  `;

  // map
  const map = newMap($('#map'));
  const blue = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const red = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
  let run = [A.pts[0]], runOver = A.pts[0].over;
  const flush = () => { if (run.length > 1) L.polyline(run.map(p => [p.la, p.lo]), { color: runOver ? red : blue, weight: runOver ? 6 : 5, opacity: 0.95 }).addTo(map); };
  for (let i = 1; i < A.pts.length; i++) {
    const p = A.pts[i];
    if (p.gapBefore) {
      flush();
      L.polyline([[A.pts[i - 1].la, A.pts[i - 1].lo], [p.la, p.lo]], { color: '#888', weight: 3, dashArray: '6 8' }).addTo(map);
      run = [p]; runOver = p.over; continue;
    }
    if (p.over !== runOver) { run.push(p); flush(); run = [p]; runOver = p.over; }
    else run.push(p);
  }
  flush();
  for (const e of A.events) {
    const p = A.pts[e.i];
    L.circleMarker([p.la, p.lo], { radius: 6, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1 })
      .bindPopup(`${e.type === 'brake' ? 'Hard braking' : 'Hard acceleration'}, ${Math.abs(e.g).toFixed(2)} g<br>${fmtTime(p.t)}`).addTo(map);
  }
  const first = A.pts[0], last = A.pts[A.pts.length - 1];
  L.circleMarker([first.la, first.lo], { radius: 7, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 }).bindPopup('Start').addTo(map);
  L.circleMarker([last.la, last.lo], { radius: 7, color: '#fff', weight: 2, fillColor: '#111', fillOpacity: 1 }).bindPopup('Finish').addTo(map);
  map.fitBounds(L.latLngBounds(A.pts.map(p => [p.la, p.lo])), { padding: [24, 24] });
  const trail = L.polyline([], { color: '#fff', weight: 3, opacity: 0.85 }).addTo(map);
  const marker = L.marker([first.la, first.lo], { icon: dotIcon(blue), zIndexOffset: 1000, interactive: false }).addTo(map);
  const dotEl = () => marker.getElement();
  const setSpd = v => { const el = dotEl()?.querySelector('.spd'); if (el) el.textContent = Math.round(v); };

  // replay + charts
  const cs = $('#cs'), cg = $('#cg'), scrub = $('#scrub'), readout = $('#readout');
  let idx = 0;
  const setIdx = (i, pan) => {
    idx = Math.max(0, Math.min(A.pts.length - 1, i));
    const p = A.pts[idx];
    if (!playing) {
      marker.setLatLng([p.la, p.lo]);
      trail.setLatLngs(idx ? A.pts.slice(0, idx + 1).map(q => [q.la, q.lo]) : []);
    }
    dotEl()?.classList.toggle('over', !!p.over);
    if (!playing) setSpd(p.v);
    if (pan && !map.getBounds().pad(-0.1).contains([p.la, p.lo])) map.panTo([p.la, p.lo]);
    scrub.value = idx;
    readout.innerHTML = `<span>${fmtClock(p.t - first.t)}</span><span class="${p.over ? 'red-text' : ''}"><b>${Math.round(p.v)}</b> km/h</span><span>limit ${p.limit ?? '–'}${p.limitSrc === 'd' ? '*' : ''}</span><span>${p.a >= 0 ? '+' : ''}${p.a.toFixed(2)} g</span>`;
    speedChart(cs, A, idx); gChart(cg, A, idx);
  };
  scrub.oninput = () => { stopPlay(); setIdx(+scrub.value, true); };
  const onChart = c => e => { stopPlay(); setIdx(xToIndex(c, A, e.clientX), true); };
  for (const c of [cs, cg]) { c.addEventListener('pointerdown', onChart(c)); c.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') onChart(c)(e); }); }
  // replay at 20× real time; the dot glides between GPS fixes and leaves a trail
  let playing = false, raf = null;
  const stopPlay = () => { playing = false; cancelAnimationFrame(raf); $('#play').textContent = '▶'; dotEl()?.classList.remove('moving'); };
  $('#play').onclick = () => {
    if (playing) return stopPlay();
    if (idx >= A.pts.length - 1) setIdx(0);
    playing = true;
    $('#play').textContent = '❚❚';
    dotEl()?.classList.add('moving');
    let simT = A.pts[idx].t, lastFrame = performance.now();
    const trailPts = A.pts.slice(0, idx + 1).map(q => [q.la, q.lo]);
    const frameFn = now => {
      if (!playing) return;
      simT += (now - lastFrame) * 20; lastFrame = now;
      let j = idx;
      while (j < A.pts.length - 1 && A.pts[j + 1].t <= simT) { j++; trailPts.push([A.pts[j].la, A.pts[j].lo]); }
      const a = A.pts[j], b = A.pts[Math.min(j + 1, A.pts.length - 1)];
      const f = b.t > a.t && !b.gapBefore ? Math.min(1, (simT - a.t) / (b.t - a.t)) : 0;
      const ll = [a.la + f * (b.la - a.la), a.lo + f * (b.lo - a.lo)];
      marker.setLatLng(ll);
      setSpd(a.v + f * (b.v - a.v));
      trail.setLatLngs([...trailPts, ll]);
      if (j !== idx) setIdx(j, true);
      if (j >= A.pts.length - 1) { stopPlay(); return; }
      raf = requestAnimationFrame(frameFn);
    };
    raf = requestAnimationFrame(frameFn);
  };
  view.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => { stopPlay(); setIdx(+b.dataset.jump, true); $('#map').scrollIntoView({ behavior: 'smooth' }); });
  setIdx(0);
  const onResize = () => { speedChart(cs, A, idx); gChart(cg, A, idx); };
  window.addEventListener('resize', onResize);

  // actions
  const me = store.settings().name;
  $('#shareDrive').onclick = async () => {
    const payload = await packDrive(drive, { trim: own && store.settings().trimShare, from: own ? me : drive.from });
    const r = await shareLink(shareUrl('s', payload), driveTitle(drive), `${driveTitle(drive)}: ${fmtKm(S.distance)} on Ghost Run`);
    if (r === 'copied') toast('Link copied. Paste it to a friend.');
  };
  $('#shareRoute').onclick = async () => {
    const payload = await packRoute(drive.points, { name: driveTitle(drive), from: own ? me : drive.from, trim: own && store.settings().trimShare });
    const r = await shareLink(shareUrl('r', payload), 'Route: ' + driveTitle(drive), `A route to drive: ${driveTitle(drive)}`);
    if (r === 'copied') toast('Route link copied. Your friend gets a map and directions.');
  };
  $('#follow').onclick = () => followGuide(guideFromDrive(drive, driveTitle(drive)));
  const fname = (driveTitle(drive).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'drive').slice(0, 60);
  $('#gpx').onclick = () => saveFile(gpx(drive, A), fname + '.gpx', 'application/gpx+xml');
  $('#csv').onclick = () => saveFile(csv(drive, A), fname + '.csv', 'text/csv');
  if ($('#saveCopy')) $('#saveCopy').onclick = async () => {
    const id = 'd' + Date.now().toString(36);
    await store.putDrive({ id, status: 'done', from: drive.from || 'Friend', name: driveTitle(drive) + (drive.from ? ` (from ${drive.from})` : ''), startedAt: drive.startedAt, endedAt: drive.endedAt, points: drive.points, limits: drive.limits, summary: S });
    toast('Saved to your drives.');
    location.hash = '#/drive/' + id;
  };
  if (own) {
    $('#name').onchange = async e => { drive.name = e.target.value.trim(); await store.putDrive(drive); toast('Name saved.'); };
    $('#recheck').onclick = async e => {
      e.target.disabled = true; e.target.textContent = 'Checking…';
      drive.limits = await computeLimits(drive.points);
      await save();
      toast(drive.limits.status === 'osm' ? 'Speed limits updated from OpenStreetMap.' : 'Couldn’t reach OpenStreetMap. Using Thai defaults.');
      route();
    };
    $('#delete').onclick = async () => {
      if (!confirm('Delete this drive from this phone? Links you already shared keep working.')) return;
      await store.deleteDrive(drive.id);
      location.hash = '#/';
    };
  }
  cleanup = () => { stopPlay(); window.removeEventListener('resize', onResize); dropMap(map); };

  // other drives on the same route: yours, and friends' drives you've saved
  store.allDrives().then(all => {
    const others = all.filter(d => d.status === 'done' && d.id !== drive.id && !!d.sample === !!drive.sample);
    const group = compareGroup(drive, others, me);
    const box = $('#same');
    if (!box) return;
    if (!group) {
      box.innerHTML = `<p class="muted small same-empty">No other drives on this route yet. Share the route with a friend; when they drive it and send you their drive, save it and you can race the two here.</p>`;
      return;
    }
    renderCompareList(box, group, () => renderRace(group));
  });
}

function dotIcon(color) {
  return L.divIcon({ className: 'dot-wrap', html: `<div class="live-dot" style="--c:${color}"><i></i><span class="spd">0</span></div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}

const RACE_COLORS = ['#3b82f6', '#f472b6', '#facc15', '#22d3ee', '#a78bfa', '#fb923c'];

function renderCompareList(box, group, onRace) {
  const best = group.entries[0].ms;
  box.innerHTML = `
    <h2 class="section-title">Same route</h2>
    <section class="card">
      <p class="small muted">Times over the ${fmtKm(group.stretchM)} stretch every drive below covers, fastest first. A red mark means part of that time was over the limit.</p>
      <ol class="cmp-list">${group.entries.map((e, k) => `
        <li class="${e.isRef ? 'me' : ''}">
          <span class="cmp-pos">${k + 1}</span>
          <span class="cmp-name">${esc(e.label)}${e.isRef ? ' <em>(this drive)</em>' : ''}</span>
          <span class="cmp-time">${fmtClock(e.ms)}${k ? `<small>+${fmtClock(e.ms - best)}</small>` : ''}</span>
          <span class="cmp-red">${e.redCount ? `<span class="tag red">${e.redCount} red</span>` : '<span class="tag green">clean</span>'}</span>
        </li>`).join('')}</ol>
      <button class="btn" id="raceBtn">▶ Race replay</button>
    </section>`;
  $('#raceBtn', box).onclick = onRace;
}

async function raceFromStore(id) {
  view.innerHTML = `<p class="loading">Lining up drives…</p>`;
  const all = await store.allDrives();
  const ref = all.find(d => d.id === id);
  const group = ref && compareGroup(ref, all.filter(d => d.status === 'done' && d.id !== id && !!d.sample === !!ref.sample), store.settings().name);
  if (!group) { view.innerHTML = `<section class="card"><p>No other drives on this route to race against.</p><a class="btn" href="#/">My drives</a></section>`; return; }
  renderRace(group, true);
}

// ---------- race replay: a moving dot per driver over the shared stretch ----------
function renderRace(group, fromHash) {
  if (!fromHash && cleanup) { try { cleanup(); } catch {} cleanup = null; }
  const entries = group.entries.slice(0, RACE_COLORS.length);
  entries.forEach((e, k) => { e.color = RACE_COLORS[k]; });
  const maxMs = Math.max(...entries.map(e => e.ms));
  const refId = entries.find(e => e.isRef)?.drive.id;
  window.scrollTo(0, 0);
  view.innerHTML = `
    <div class="race-head">
      <button class="btn small ghost" id="back">‹ Back</button>
      <h1>Race replay</h1>
    </div>
    <div class="race-wrap">
      <div class="map race-map" id="map"></div>
      <div class="race-hud" id="hud"></div>
      <div class="race-clock" id="clock">0:00</div>
    </div>
    <div class="replay">
      <button class="btn small" id="play" aria-label="Play">▶</button>
      <input type="range" id="scrub" min="0" max="${maxMs}" value="0" step="250" aria-label="Race position">
      <button class="btn small ghost" id="speed">20×</button>
    </div>
    <p class="muted small">Everyone starts together at the start of the shared stretch (${fmtKm(group.stretchM)}). Drives were made at different times, so traffic and lights differ.</p>
    <section class="card"><ol class="cmp-list">${entries.map((e, k) => `
      <li><span class="cmp-pos" style="background:${e.color}">${k + 1}</span><span class="cmp-name">${esc(e.label)}</span>
      <span class="cmp-time">${fmtClock(e.ms)}</span><span class="cmp-red">${e.redCount ? `<span class="tag red">${e.redCount} red</span>` : '<span class="tag green">clean</span>'}</span></li>`).join('')}</ol></section>`;
  $('#back').onclick = () => { if (fromHash || !refId) history.back(); else route(); };
  const map = newMap($('#map'));
  const refE = entries.find(e => e.isRef) || entries[0];
  const stretch = refE.A.pts.slice(refE.i0, refE.i1 + 1).map(p => [p.la, p.lo]);
  L.polyline(stretch, { color: '#94a3b8', weight: 8, opacity: 0.35 }).addTo(map);
  map.fitBounds(L.latLngBounds(stretch), { padding: [30, 30] });
  const dots = entries.map((e, k) => {
    const trail = L.polyline([], { color: e.color, weight: 4, opacity: 0.9 }).addTo(map);
    const m = L.marker([e.A.pts[e.i0].la, e.A.pts[e.i0].lo], { icon: L.divIcon({ className: 'dot-wrap', html: `<div class="live-dot race${k % 2 ? " alt" : ""}" style="--c:${e.color}"><i></i><b>${k + 1}</b><span class="spd">0</span></div>`, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 1000 - k, interactive: false }).addTo(map);
    return { e, trail, m };
  });
  let t = 0, playing = false, raf = null, rate = 20;
  const draw = () => {
    $('#clock').textContent = fmtClock(t);
    $('#scrub').value = t;
    const rows = dots.map(({ e, trail, m }) => {
      const p = positionAt(e, t);
      m.setLatLng([p.la, p.lo]);
      const el = m.getElement();
      el?.classList.toggle('over', !!p.over && !p.done);
      el?.classList.toggle('done', p.done);
      const sp = el?.querySelector('.spd');
      if (sp) sp.textContent = p.done ? '🏁' : Math.round(p.v);
      const P = e.A.pts, end = Math.min(e.i1, e.i0 + Math.max(0, upperIdx(P, e.i0, e.i1, P[e.i0].t + t)));
      trail.setLatLngs([...P.slice(e.i0, end + 1).map(q => [q.la, q.lo]), [p.la, p.lo]]);
      return { e, p };
    });
    rows.sort((a, b) => (b.p.done - a.p.done) || (a.p.done ? a.e.ms - b.e.ms : b.p.prog - a.p.prog));
    const lead = rows[0];
    $('#hud').innerHTML = rows.map(({ e, p }, k) => `
      <div class="hud-row ${p.over && !p.done ? 'over' : ''}">
        <i style="background:${e.color}"></i>
        <span class="hud-name">${esc(e.label.split(',')[0])}</span>
        <span class="hud-val">${p.done ? `🏁 ${fmtClock(e.ms)}` : `${Math.round(p.v)} km/h`}</span>
        <span class="hud-gap">${k === 0 ? 'lead' : p.done ? '' : `−${fmtKm(Math.max(0, lead.p.prog - p.prog))}`}</span>
      </div>`).join('');
  };
  const stop = () => { playing = false; cancelAnimationFrame(raf); $('#play').textContent = '▶'; };
  $('#play').onclick = () => {
    if (playing) return stop();
    if (t >= maxMs) t = 0;
    playing = true; $('#play').textContent = '❚❚';
    let last = performance.now();
    const frameFn = now => {
      if (!playing) return;
      t = Math.min(maxMs, t + (now - last) * rate); last = now;
      draw();
      if (t >= maxMs) { stop(); return; }
      raf = requestAnimationFrame(frameFn);
    };
    raf = requestAnimationFrame(frameFn);
  };
  $('#scrub').oninput = e => { stop(); t = +e.target.value; draw(); };
  $('#speed').onclick = e => { rate = rate === 20 ? 60 : rate === 60 ? 5 : 20; e.target.textContent = rate + '×'; };
  draw();
  cleanup = () => { stop(); dropMap(map); };
}

function upperIdx(P, lo, hi, t) {
  // number of fixes after lo with time <= t
  let a = lo, b = hi;
  while (a < b) { const mid = (a + b + 1) >> 1; if (P[mid].t <= t) a = mid; else b = mid - 1; }
  return a - lo;
}

// ---------- shared route with directions ----------
function renderRoute(r) {
  const pts = r.points;
  view.innerHTML = `
    <section class="card banner">Route${r.from ? ` from <strong>${esc(r.from)}</strong>` : ''}. Check the way before you set off; don't read directions while driving.</section>
    <h1>${esc(r.name || 'Shared route')}</h1>
    <div class="map" id="map"></div>
    <section class="actions">
      <a class="btn" href="${esc(googleMapsUrl(pts))}" target="_blank" rel="noopener">Open in Google Maps</a>
      <button class="btn start-alt" id="followRoute">Follow this route</button>
      ${r.id ? `<button class="btn danger" id="delRoute">Remove from my routes</button>` : `<button class="btn ghost" id="saveRoute">Save to my routes</button>`}
    </section>
    <p class="muted small">Google Maps only takes a few stops along the way, so its route may differ a little from this one.</p>
    <h2 class="section-title">Directions</h2>
    <ol class="directions" id="dir"><li class="muted">Working out directions…</li></ol>`;
  $('#followRoute').onclick = () => followGuide(guideFromRoute(r));
  if ($('#saveRoute')) $('#saveRoute').onclick = async e => {
    const id = 'r' + Date.now().toString(36);
    await store.putDrive({ id, status: 'route', name: r.name || 'Shared route', from: r.from || '', startedAt: Date.now(), points: r.points });
    e.target.outerHTML = '<span class="muted small">Saved. It’s on your home screen under My routes.</span>';
  };
  if ($('#delRoute')) $('#delRoute').onclick = async () => {
    if (!confirm('Remove this route from your phone?')) return;
    await store.deleteDrive(r.id); location.hash = '#/';
  };
  const map = newMap($('#map'));
  const line = L.polyline(pts.map(p => [p.la, p.lo]), { color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), weight: 5 }).addTo(map);
  L.circleMarker([pts[0].la, pts[0].lo], { radius: 7, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 }).bindPopup('Start').addTo(map);
  L.circleMarker([pts[pts.length - 1].la, pts[pts.length - 1].lo], { radius: 7, color: '#fff', weight: 2, fillColor: '#111', fillOpacity: 1 }).bindPopup('Finish').addTo(map);
  map.fitBounds(line.getBounds(), { padding: [24, 24] });
  let stepMarker = null;
  let total = 0;
  directionsFor(pts).then(steps => {
    $('#dir').innerHTML = steps.map((s, k) => {
      const at = total; total += s.distance;
      return `<li data-k="${k}"><span class="dir-text">${esc(s.text)}</span><span class="dir-dist">${s.type === 'arrive' ? fmtKm(at) + ' total' : 'then ' + fmtKm(s.distance)}</span></li>`;
    }).join('');
    $('#dir').querySelectorAll('li').forEach(li => li.onclick = () => {
      const s = steps[+li.dataset.k];
      if (!s.loc) return;
      const ll = [s.loc[1], s.loc[0]];
      if (stepMarker) stepMarker.remove();
      stepMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#f59e0b', fillOpacity: 1 }).addTo(map);
      map.setView(ll, 17);
      $('#map').scrollIntoView({ behavior: 'smooth' });
    });
  }).catch(e => {
    console.warn(e);
    $('#dir').innerHTML = `<li class="muted">Couldn't get directions right now (${esc(e.message)}). The map above and Google Maps still work.</li>`;
  });
  cleanup = () => dropMap(map);
}

// ---------- settings ----------
function settingsView() {
  const s = store.settings();
  view.innerHTML = `
    <h1>Settings</h1>
    <section class="card form">
      <label>Your name on shared links<input id="sname" value="${esc(s.name)}" placeholder="e.g. Phil"></label>
      <label class="check"><input type="checkbox" id="strim" ${s.trimShare ? 'checked' : ''}> Hide the first and last 200 m when sharing, so friends can't see where you live</label>
      <label>Stop recording after parked for
        <select id="sauto">${[3, 5, 10, 15].map(m => `<option value="${m}" ${m === s.autoStopMin ? 'selected' : ''}>${m} minutes</option>`).join('')}</select>
      </label>
    </section>
    <h2 class="section-title">Speed limits</h2>
    <section class="card">
      <p class="small">Where a road has a posted limit in OpenStreetMap, that's used. Elsewhere Ghost Run falls back to Thai defaults:</p>
      <table class="tbl">${TH_DEFAULTS.map(d => `<tr><td>${esc(d.label)}</td><td>${d.kmh} km/h</td></tr>`).join('')}</table>
      <p class="muted small">A stretch shows red only when you were more than 2 km/h over for at least 2 seconds, to allow for GPS error. Treat it as a guide: the signs on the road are what count.</p>
    </section>
    <h2 class="section-title">Your data</h2>
    <section class="card">
      <p class="small">Drives are stored only in this copy of the app. On iPhone, Safari and each home-screen icon keep their own separate drives. Back up to a file to keep them safe or move them to another copy or phone.</p>
      <div class="row">
        <button class="btn" id="backup">Back up all drives</button>
        <button class="btn ghost" id="restoreBtn">Restore or import a file</button>
        <input type="file" id="restoreFile" accept=".json,.gpx,.csv,application/json,application/gpx+xml,text/csv,text/xml" hidden>
      </div>
      <p class="muted small" id="backupInfo"></p>
      <p class="muted small">Restore takes a backup file, or a single drive exported as GPX or CSV (from this app or another GPS logger).</p>
      <button class="btn danger" id="wipe">Delete all my drives</button>
    </section>
    <p class="muted small">Maps and road data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>. Directions by OSRM.</p>`;
  const persist = () => store.saveSettings({ name: $('#sname').value.trim(), trimShare: $('#strim').checked, autoStopMin: +$('#sauto').value });
  ['#sname', '#strim', '#sauto'].forEach(sel => $(sel).addEventListener('change', () => { persist(); toast('Saved.'); }));
  store.allDrives().then(all => {
    const n = all.filter(d => d.status === 'done').length, r = all.filter(d => d.status === 'route').length;
    $('#backupInfo').textContent = `${n} drive${n === 1 ? '' : 's'} and ${r} saved route${r === 1 ? '' : 's'} in this copy of the app.`;
  });
  $('#backup').onclick = async () => {
    const all = (await store.allDrives()).filter(d => (d.status === 'done' || d.status === 'route') && !d.sample);
    if (!all.length) { toast('Nothing to back up yet.'); return; }
    const stamp = new Date().toISOString().slice(0, 10);
    await saveFile(JSON.stringify({ app: 'ghost-run', v: 1, at: Date.now(), drives: all }), `ghost-run-backup-${stamp}.json`, 'application/json');
  };
  $('#restoreBtn').onclick = () => $('#restoreFile').click();
  $('#restoreFile').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const one = importTrack(text, f.name);
      if (one) {
        await store.putDrive(one);
        toast('Drive imported.');
        location.hash = (one.status === 'route' ? '#/route/' : '#/drive/') + one.id;
        return;
      }
      const data = JSON.parse(text);
      if (data.app !== 'ghost-run' || !Array.isArray(data.drives)) throw new Error('not a Ghost Run backup');
      const have = await store.allDrives();
      const key = d => d.status + ':' + d.startedAt + ':' + (d.points?.length || 0);
      const seen = new Set(have.map(key));
      let added = 0;
      for (const d of data.drives) {
        if (!d || !Array.isArray(d.points) || !['done', 'route'].includes(d.status) || seen.has(key(d))) continue;
        if (have.some(h => h.id === d.id)) d.id = d.id + '-' + Date.now().toString(36);
        await store.putDrive(d); seen.add(key(d)); added++;
      }
      toast(added ? `Restored ${added} item${added === 1 ? '' : 's'}.` : 'Everything in that backup is already here.');
      if (added) setTimeout(() => { location.hash = '#/'; }, 800);
    } catch (err) {
      toast('Couldn’t read that file. Use a Ghost Run backup, GPX or CSV.');
    }
    e.target.value = '';
  };
  $('#wipe').onclick = async () => {
    if (!confirm('Delete every drive on this phone? This can’t be undone.')) return;
    await store.wipe(); toast('All drives deleted.'); location.hash = '#/';
  };
}

// ---------- start ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();

// Leaflet finishes a zoom animation on a timer; removing the map before it fires throws.
// So stop it now and remove it once any animation has had time to end.
function dropMap(map) {
  try { map.stop(); } catch {}
  setTimeout(() => { try { map.off(); map.remove(); } catch {} }, 600);
}
