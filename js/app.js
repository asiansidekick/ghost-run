import * as store from './store.js';
import { Recorder, finishDrive } from './recorder.js';
import { analyse, bearing, hav } from './analysis.js';
import { computeLimits, defaultLimits, TH_DEFAULTS } from './limits.js';
import { speedChart, gChart, xToIndex } from './charts.js';
import { packDrive, packRoute, unpack, toDrive, shareUrl, shareLink } from './share.js';
import { directionsFor, googleMapsUrl } from './directions.js';
import { gpx, csv, saveFile } from './export.js';
import { sampleDrive } from './sample.js';
import { compareGroup, positionAt } from './compare.js';
import { guideFromDrive, guideFromRoute } from './guide.js';
import { turnsFor, arrowFor, roundDist, Voice } from './turns.js';
import { LiveMap, FlatLiveMap, loadMapLibre, webglOk } from './livemap.js';
import { searchPlaces, suggestPlaces, fuzzyScore, dedupe, routeThrough } from './plan.js';
import { addBasemap, loadStyle, creditsButton } from './basemap.js';
import { open3D, pinchZoom } from './map3d.js';
import { plan3D, flatPlanMap } from './planmap.js';
import { profile, elevChart, gradeLines } from './elevation.js';
import { ACTIVITIES, ROUTE_MODES, actKey, actOf, activityForMode, speedFor, guessActivity } from './activity.js';

const BANGKOK = [13.7563, 100.5018];
export const APP_VERSION = '24 Nov 2026, 8:30 PM (v35)';
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
const fmtMin = s => s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`;
const fmtClock = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtDate = t => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const driveTitle = d => d.name || `${cap(actOf(d).noun)}, ${fmtDate(d.startedAt)}`;

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function newMap(el, opts = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: false, ...opts }).setView(BANGKOK, 12);
  addBasemap(map);
  creditsButton(map);
  // phones pinch to zoom, so the +/− buttons only cover the map there
  if (!matchMedia('(pointer: coarse)').matches) L.control.zoom({ position: 'bottomright' }).addTo(map);
  return map;
}

// ---------- router ----------
async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  window.scrollTo(0, 0);
  const h = location.hash;
  try {
    if (h.startsWith('#s=') || h.startsWith('#r=')) return await sharedView(h.slice(3));
    if (h === '#/record') {
      if (recorder.active && webglOk()) { try { await Promise.all([loadMapLibre(), loadStyle()]); } catch {} }
      return recordView();
    }
    if (h.startsWith('#/drive/')) return await ownDriveView(decodeURIComponent(h.slice(8)));
    if (h === '#/settings') return settingsView();
    if (h === '#/plan') return planView();
    if (h.startsWith('#/plan/')) { const r = await store.getDrive(decodeURIComponent(h.slice(7))); return planView(r && r.plan ? r : null); }
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
        <strong>A recording was interrupted</strong>
        <p class="muted">Started ${esc(fmtDate(d.startedAt))}. The page closed while recording; everything up to then is saved.</p>
        <div class="row">
          <button class="btn" data-resume="${esc(d.id)}">Continue recording</button>
          <button class="btn ghost" data-finish="${esc(d.id)}">Finish it</button>
        </div>
      </section>`).join('')}
    <a href="#/record" class="btn big start">${recorder.active ? 'Back to recording' : 'Start recording'}</a>
    ${recorder.active ? '' : `<a href="#/plan" class="btn ghost plan-btn">🧭 Plan a route or navigate somewhere</a>`}
    ${!standalone ? `<p class="hint">Tip: add Ghost Run to your home screen. On iPhone tap Share, then “Add to Home Screen”. On Android use the browser menu.</p>` : ''}
    ${routes.length ? `<h2 class="section-title">My routes</h2><ul class="drive-list">${routes.map(r => `<li><a href="#/route/${encodeURIComponent(r.id)}" class="drive-item">
        <div class="drive-name">${esc(r.name)}</div>
        <div class="drive-meta">${r.from ? `From ${esc(r.from)} · ` : ''}${r.plan ? `Planned ${ROUTE_MODES[r.plan.mode || 'car'].icon} · ${fmtKm(r.distance || 0)} · ` : ''}Tap to follow it</div></a></li>`).join('')}</ul>` : ''}
    <div class="list-head"><h2 class="section-title">My recordings</h2>${done.length ? `<button class="btn small ghost" id="pickMode">Select</button>` : ''}</div>
    ${done.length ? `<ul class="drive-list">${done.map(d => {
      const A = d.summary || {};
      return `<li class="pickable"><input type="checkbox" class="pick-box" data-id="${esc(d.id)}" aria-label="Pick this drive"><a href="#/drive/${encodeURIComponent(d.id)}" class="drive-item">
        <div class="drive-name"><span class="act-ico">${actOf(d).icon}</span> ${esc(driveTitle(d))}</div>
        <div class="drive-meta">${d.guide ? `Followed ${esc(d.guide.name)} · ` : ''}${esc(fmtDate(d.startedAt))} · ${fmtKm(A.distance || 0)} · ${fmtDur(A.durationMs || 0)}
        ${!actOf(d).limits ? '' : A.speedingCount ? `<span class="tag red">${A.speedingCount} over limit</span>` : A.hasLimits ? '<span class="tag green">Under limits</span>' : ''}</div>
      </a></li>`;
    }).join('')}</ul>` : `
      <section class="card empty">
        <p>Nothing recorded yet. Tap <strong>Start recording</strong>, pick a drive, ride, run, walk or anything else, and hold Stop when you're done.</p>
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
  const pm = $('#pickMode');
  if (pm) {
    const bar = document.createElement('div');
    bar.className = 'pick-bar'; bar.hidden = true;
    bar.innerHTML = `<button class="btn ghost" id="pickCancel">Cancel</button><button class="btn danger" id="pickDel" disabled>Delete</button><button class="btn" id="pickPlay" disabled>Play</button>`;
    view.appendChild(bar);
    const picks = () => [...view.querySelectorAll('.pick-box:checked')].map(b => b.dataset.id);
    const sync = () => {
      const n = picks().length;
      view.querySelectorAll('.pick-box').forEach(b => { b.disabled = !b.checked && n >= RACE_COLORS.length; });
      $('#pickPlay').disabled = n < 1;
      $('#pickPlay').textContent = n < 1 ? 'Play' : n === 1 ? '▶ Play' : `▶ Race ${n}`;
      $('#pickDel').disabled = n < 1;
      $('#pickDel').textContent = n ? `Delete ${n}` : 'Delete';
    };
    pm.onclick = () => { view.classList.add('picking'); bar.hidden = false; pm.hidden = true; sync(); };
    // press and hold a drive: start selecting (to delete or play together), with that one ticked
    view.querySelectorAll('.pickable').forEach(li => {
      const a = li.querySelector('.drive-item'), box = li.querySelector('.pick-box');
      let t = null, held = false, x0 = 0, y0 = 0;
      a.addEventListener('pointerdown', e => {
        held = false; x0 = e.clientX; y0 = e.clientY;
        t = setTimeout(() => {
          held = true;
          if (!view.classList.contains('picking')) pm.onclick();
          if (!box.disabled) box.checked = !box.checked;
          sync();
          if (navigator.vibrate) navigator.vibrate(15);
        }, 550);
      });
      a.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) clearTimeout(t); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => a.addEventListener(ev, () => clearTimeout(t)));
      a.addEventListener('click', e => {
        if (held) { e.preventDefault(); held = false; return; }
        // while picking, a tap ticks the drive instead of opening it
        if (view.classList.contains('picking')) { e.preventDefault(); if (!box.disabled || box.checked) { box.checked = !box.checked; sync(); } }
      });
      a.addEventListener('contextmenu', e => e.preventDefault());
    });
    $('#pickCancel').onclick = () => { view.classList.remove('picking'); bar.hidden = true; pm.hidden = false; };
    view.querySelectorAll('.pick-box').forEach(b => b.onchange = sync);
    $('#pickDel').onclick = async () => {
      const ids = picks();
      if (!ids.length || !confirm(`Delete ${ids.length === 1 ? 'this recording' : ids.length + ' recordings'} from this phone? Links you already shared keep working.`)) return;
      for (const id of ids) await store.deleteDrive(id);
      view.classList.remove('picking');
      toast(ids.length === 1 ? 'Deleted.' : `${ids.length} recordings deleted.`);
      route();
    };
    $('#pickPlay').onclick = async () => {
      const ids = picks();
      // one drive: open it and start its replay
      if (ids.length === 1) { view.classList.remove('picking'); autoPlay = ids[0]; location.hash = '#/drive/' + encodeURIComponent(ids[0]); return; }
      const chosen = done.filter(d => ids.includes(d.id));
      view.classList.remove('picking');
      renderRace(groupForSelection(chosen));
    };
    cleanup = () => view.classList.remove('picking');
  }
  const sb = $('#sample');
  if (sb) sb.onclick = async () => {
    await store.putDrive(sampleDrive());
    await store.putDrive(sampleDrive({ friend: true }));
    location.hash = '#/drive/sample';
  };
}

// ---------- record ----------
let pendingGuide = null;
let autoPlay = null; // a drive to start replaying as soon as its page opens
let lastReroute = 0;
const voice = new Voice();
const turnsCache = new WeakMap();
function getTurns(guide) {
  if (!turnsCache.has(guide)) turnsCache.set(guide, turnsFor(guide.points, guide.steps, guide.mode || 'car'));
  return turnsCache.get(guide);
}
function followGuide(guide) {
  if (recorder.active) { toast('Stop the current recording first.'); return; }
  pendingGuide = guide;
  getTurns(guide); // start working out the turns while you get ready
  if (location.hash === '#/record') route(); else location.hash = '#/record';
}

function recordView() {
  if (!recorder.active) {
    const g = pendingGuide;
    let act = g ? (g.activity && ACTIVITIES[g.activity] ? g.activity : activityForMode(g.mode, store.settings().activity)) : (store.settings().activity || 'drive');
    if (!ACTIVITIES[act]) act = 'drive';
    const tips = a => a === 'drive' ? `
          <li>Put the phone in a fixed cradle, ideally plugged in to charge.</li>
          <li>Tap Start while you're parked. Allow location and motion access if asked.</li>
          <li>Leave this page open on screen while you drive. The screen stays on and the map follows you.</li>
          <li>Once parked, hold Stop. If you forget, it stops on its own after ${store.settings().autoStopMin} minutes parked.</li>` : `
          <li>Tap Start where you set off. Allow location access if asked.</li>
          <li>Keep this page open with the screen on${a === 'ride' ? ', with the phone on a bar mount if you can' : a === 'boat' ? ', and the phone somewhere dry' : ''}. Taking a call or switching apps pauses recording.</li>
          <li>Hold Stop when you're done.${ACTIVITIES[a].moveKmh ? ` If you forget, it stops on its own after ${store.settings().autoStopMin} minutes standing still.` : ''}</li>
          <li>Off-road is fine: it records wherever the GPS can see the sky, roads or not.</li>`;
    view.innerHTML = `
      ${g ? `<section class="card banner follow-banner">
        <div><strong>${g.plan ? 'Navigating' : 'Following'}:</strong> ${esc(g.name)}${g.points[0].t != null ? '<br><span class="small">A ghost will go round it alongside you, starting when you reach the start of the route.</span>' : ''}${g.plan ? `<br><span class="small">${fmtKm(g.distance || 0)}, about ${fmtMin(g.duration || 0)}. Turn-by-turn from wherever you are; if you leave the route it finds a new one.</span>` : ''}</div>
        <button class="btn small ghost" id="nofollow">Don't follow</button>
      </section>` : ''}
      <h2 class="section-title">What are you doing?</h2>
      <div class="act-pick" id="actPick">${Object.entries(ACTIVITIES).map(([k, a]) => `<button class="act-btn${k === act ? ' on' : ''}" data-act="${k}"><span>${a.icon}</span>${a.label}</button>`).join('')}</div>
      <section class="card">
        <h1>Before you set off</h1>
        <ol class="steps" id="tips">${tips(act)}</ol>
        <p class="muted small" id="tipNote">${act === 'drive' ? "Don't touch the phone while driving. Taking a call or switching apps pauses recording, and the gap shows on the map." : 'Gaps in recording show dashed on the map.'}</p>
      </section>
      <button class="btn big start" id="go">Start</button>
      ${g ? '' : `<a href="#/plan" class="btn ghost plan-btn">🧭 Plan a route first</a>`}`;
    $('#actPick').querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
      act = b.dataset.act;
      store.saveSettings({ ...store.settings(), activity: act });
      $('#actPick').querySelectorAll('.act-btn').forEach(x => x.classList.toggle('on', x === b));
      $('#tips').innerHTML = tips(act);
      $('#tipNote').textContent = act === 'drive' ? "Don't touch the phone while driving. Taking a call or switching apps pauses recording, and the gap shows on the map." : 'Gaps in recording show dashed on the map.';
    });
    if ($('#nofollow')) $('#nofollow').onclick = () => { pendingGuide = null; recordView(); };
    $('#go').onclick = () => {
      if (pendingGuide) voice.unlock();
      recorder.start(null, pendingGuide, act); pendingGuide = null;
      if (webglOk()) Promise.all([loadMapLibre(), loadStyle()]).catch(() => {}).then(() => { if (location.hash === '#/record') recordView(); });
      else recordView();
    };
    return;
  }
  const g = recorder.guide;
  view.innerHTML = `
    <section class="live live-map-mode">
      <div class="live-top">
        <div class="live-speed-sm"><span id="lv">0</span><small id="lvu">km/h</small></div>
        <div class="live-mini">
          <div><span id="lt">0:00</span><small>time</small></div>
          <div><span id="ld">0 m</span><small>distance</small></div>
        </div>
        <div class="live-status" id="ls">Waiting for GPS…</div>
      </div>
      <div class="live-map-wrap">
        <div id="lmap" class="live-map"></div>
        <button class="btn small ghost recenter" id="recenter" hidden>Re-centre</button>
        <button class="btn small ghost mapmode-btn" id="mapmode" aria-label="Switch map view"></button>
        ${g ? `<div class="turn-banner" id="tb"><span class="tb-arrow">…</span><span class="tb-text">Working out the turns…</span></div>
        <button class="btn small ghost voice-btn" id="voice" aria-label="Voice on or off"></button>
        <div class="guide-hud" id="gh"></div>` : ''}
      </div>
      <div class="live-flags ${g ? 'compact' : ''}" id="lf"></div>
      <button class="btn big hold" id="stop"><span class="hold-fill"></span><span class="hold-label">Hold to stop</span></button>
    </section>`;
  const blue = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  let follow = true;
  const userMoved = () => { follow = false; $('#recenter').hidden = false; };
  const startLL = recorder.last ? [recorder.last.la, recorder.last.lo] : g ? [g.points[0].la, g.points[0].lo] : BANGKOK;
  const map = window.maplibregl && webglOk() ? new LiveMap($('#lmap'), { center: startLL, onUserMove: userMoved }) : new FlatLiveMap($('#lmap'), { center: startLL, onUserMove: userMoved });
  map.mode = store.settings().mapMode || 'pov';
  if (g) map.setGuide(g.points);
  map.setTrail(recorder.track);
  if (!recorder.last && g) map.fitPoints(g.points.map(p => [p.la, p.lo]));
  const mb = $('#mapmode');
  if (map instanceof FlatLiveMap) mb.hidden = true;
  const showMode = () => { mb.textContent = map.mode === 'pov' ? '3D' : 'N↑'; mb.title = map.mode === 'pov' ? 'Heading up, tilted' : 'North up'; };
  showMode();
  mb.onclick = () => {
    map.mode = map.mode === 'pov' ? 'north' : 'pov';
    store.saveSettings({ ...store.settings(), mapMode: map.mode });
    showMode(); follow = true; $('#recenter').hidden = true;
    if (recorder.last) map.follow([recorder.last.la, recorder.last.lo], g ? lookAhead() : null);
  };
  const ghostOn = g && g.points[0].t != null;
  $('#recenter').onclick = () => { follow = true; $('#recenter').hidden = true; if (recorder.last) map.follow([recorder.last.la, recorder.last.lo], g ? lookAhead() : null); };
  let turns = null, turnSource = null;
  if (g) {
    getTurns(g).then(t => { turns = t.turns; turnSource = t.source; upd(); });
    const vb = $('#voice');
    const showVoice = () => { vb.textContent = voice.on ? '🔊' : '🔇'; };
    voice.on = store.settings().voiceOn !== false;
    showVoice();
    vb.onclick = () => { voice.on = !voice.on; store.saveSettings({ ...store.settings(), voiceOn: voice.on }); showVoice(); if (voice.on) voice.say('Voice on'); };
  }
  let lastCount = -1;
  const upd = () => {
    if (!recorder.active) return;
    const sp = speedFor(ACTIVITIES[recorder.activity] || ACTIVITIES.drive, recorder.speedKmh);
    $('#lv').textContent = sp.n; $('#lvu').textContent = sp.u;
    $('#ld').textContent = fmtKm(recorder.distance);
    $('#ls').textContent = recorder.error || (recorder.count ? `Recording · GPS ±${Math.round(recorder.accuracy ?? 0)} m` : 'Waiting for GPS…');
    $('#ls').className = 'live-status ' + (recorder.error ? 'bad' : recorder.count ? 'ok' : '');
    $('#lf').innerHTML = [
      recorder.wakeLock ? 'Screen kept on' : 'Screen may sleep: keep this page open',
      (ACTIVITIES[recorder.activity] || {}).pace ? `${(ACTIVITIES[recorder.activity] || {}).icon} ${cap(ACTIVITIES[recorder.activity].noun)}` : recorder.motionOk ? 'Motion sensor on' : 'Using GPS for braking',
    ].map(t => `<span>${t}</span>`).join('');
    if (recorder.count !== lastCount && recorder.last) {
      lastCount = recorder.count;
      const ll = [recorder.last.la, recorder.last.lo];
      if (recorder.speedKmh > 4) map.updateHeading(recorder.gpsHeading, recorder.track);
      const overNow = false;
      map.setMe(ll, speedFor(ACTIVITIES[recorder.activity] || ACTIVITIES.drive, recorder.speedKmh).n, overNow);
      map.setTrail(recorder.track);
      if (follow) map.follow(ll, g ? lookAhead() : null);
    }
    if (g) {
      const st = recorder.guideState;
      const tb = $('#tb');
      const nt = nextTurn();
      if (!st || !st.started) {
        tb.className = 'turn-banner';
        tb.innerHTML = `<span class="tb-arrow">⌖</span><span class="tb-text"><b>Head to the start</b>${st && st.distToStart != null ? `<small>${fmtKm(st.distToStart)} away, green dot on the map</small>` : ''}</span>`;
      } else if (st.off) {
        tb.className = 'turn-banner off';
        tb.innerHTML = `<span class="tb-arrow">⚠</span><span class="tb-text"><b>Off the route</b><small>${g.plan ? 'Finding a new route from here…' : 'Get back to the yellow line'}</small></span>`;
      } else if (nt) {
        tb.className = 'turn-banner' + (nt.dist < 120 ? ' soon' : '');
        const then = turns[turns.indexOf(nt.turn) + 1];
        tb.innerHTML = `<span class="tb-arrow">${arrowFor(nt.turn)}</span><span class="tb-text"><b>${roundDist(nt.dist)}</b><small>${esc(nt.turn.text)}</small>${then && then.at - nt.turn.at < 1500 ? `<em>then ${arrowFor(then)} ${esc(lowerFirst(then.text))}</em>` : ''}</span>`;
        voice.update(nt.turn, nt.dist, recorder.speedKmh);
      } else if (!turns) {
        tb.className = 'turn-banner';
        tb.innerHTML = `<span class="tb-arrow">…</span><span class="tb-text">Working out the turns…</span>`;
      }
      let html;
      if (!st || !st.started) html = `<b>Head to the start</b><span>${st && st.distToStart != null ? fmtKm(st.distToStart) + ' away' : 'Waiting for GPS'}</span>`;
      else if (st.finished) html = `<b>🏁 Route done</b>${st.deltaS != null ? `<span class="${st.deltaS <= 0 ? 'good' : 'bad'}">${fmtGap(st.deltaS)}</span>` : ''}`;
      else html = `${st.off ? `<b class="bad">${g.plan ? 'Finding a new route…' : `Off the route (${fmtKm(st.offBy)})`}</b>` : `<b>${fmtKm(st.remaining)} to go${eta(st)}</b>`}${st.deltaS != null ? `<span class="${st.deltaS <= 0 ? 'good' : 'bad'}">${fmtGap(st.deltaS)}</span>` : ''}`;
      $('#gh').innerHTML = html;
      maybeReroute(st);
      const tint = st && st.started && !st.off && st.deltaS != null && Math.abs(st.deltaS) >= 1 ? (st.deltaS < 0 ? ' ahead' : ' behind') : '';
      $('#gh').className = 'guide-hud' + tint;
    }
  };
  // planned routes: expected time left, scaled from the directions service's estimate
  function eta(st) {
    const tr = recorder.tracker;
    if (!g.duration || !tr || !tr.total) return '';
    const left = g.duration * st.remaining / tr.total;
    const at = new Date(Date.now() + left * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return ` · ${fmtMin(left)} <small>(arrive ${at})</small>`;
  }
  // planned routes: when you're away from the line (or not at its start yet), route again from where you are
  let offSince = null, rerouting = false;
  function maybeReroute(st) {
    if (!g.plan || rerouting || !recorder.last || !st || navigator.onLine === false) return;
    const need = st.started ? st.off : st.distToStart > 150;
    if (!need) { offSince = null; return; }
    const now = Date.now();
    if (offSince == null) offSince = now;
    if (now - offSince < (st.started ? 10000 : 0) || now - lastReroute < 20000) return;
    rerouting = true; lastReroute = now;
    const plan = g.plan, tr = recorder.tracker;
    const passed = st.started ? tr.cum[st.idx] : -1;
    const left = plan.stops.filter((x, k) => (plan.stopsAt ? plan.stopsAt[k] : Infinity) > passed + 30);
    const stops = [...(!st.started && !plan.fromMe && plan.start ? [plan.start] : []), ...left];
    if (!stops.length) return;
    const here = { la: recorder.last.la, lo: recorder.last.lo, name: 'You' };
    routeThrough([here, ...stops], plan.mode || 'car', (ACTIVITIES[recorder.activity] || ACTIVITIES.drive).kmh).then(async r => {
      if (!recorder.active || recorder.guide !== g) return;
      const ng = { ...g, points: r.points, steps: r.steps, distance: r.distance, duration: r.duration, plan: { ...plan, fromMe: true, start: null, stops, stopsAt: r.stopsAt } };
      await recorder.setGuide(ng);
      if (st.started) { voice.say('New route'); toast('You left the route, so here is a new one from where you are.'); }
      if (location.hash !== '#/record') return;
      if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
      recordView();
    }).catch(e => { console.warn('Reroute failed', e); rerouting = false; });
  }
  function progress() {
    const tr = recorder.tracker, st = recorder.guideState;
    return tr && st && st.started ? tr.cum[st.idx] : null;
  }
  function nextTurn() {
    const at = progress();
    if (at == null || !turns) return null;
    const turn = turns.find(t => t.at > at + 5);
    return turn ? { turn, dist: turn.at - at } : null;
  }
  // what the map should keep in view besides you: the start, the next turn, or the road 400 m ahead
  function lookAhead() {
    const st = recorder.guideState, tr = recorder.tracker;
    if (!tr) return null;
    if (!st || !st.started) return [g.points[0].la, g.points[0].lo];
    if (st.off) return null;
    const nt = nextTurn();
    if (nt && nt.dist < 600) return [nt.turn.la, nt.turn.lo];
    const target = tr.cum[st.idx] + 400;
    let i = st.idx;
    while (i < tr.cum.length - 1 && tr.cum[i] < target) i++;
    return [g.points[i].la, g.points[i].lo];
  }
  // the ghost glides between updates, timed from the latest GPS fix
  const ghostTick = ghostOn ? setInterval(() => {
    const tr = recorder.tracker;
    if (!tr || !recorder.last || recorder.lastFixAt == null) return;
    const gp = tr.ghostAt(recorder.last.t + (Date.now() - recorder.lastFixAt));
    if (!gp) return;
    map.setGhost([gp.la, gp.lo], gp.done ? 'Ghost 🏁' : `Ghost ${Math.round(gp.v)}`);
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
  cleanup = () => { clearInterval(tick); clearInterval(ghostTick); recorder.removeEventListener('update', upd); map.remove(); };
}

// A single drive from a GPX or CSV file (ours or another logger's). Returns null for anything else.
function importTrack(text, filename = '') {
  let pts = [], hint = '';
  const name = filename.replace(/\.(gpx|csv)$/i, '').replace(/[-_]+/g, ' ').trim();
  if (/<gpx[\s>]/i.test(text)) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const nodes = [...doc.getElementsByTagName('trkpt')];
    const list = nodes.length ? nodes : [...doc.getElementsByTagName('rtept')];
    hint = doc.getElementsByTagName('type')[0]?.textContent || doc.getElementsByTagName('name')[0]?.textContent || '';
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
  const activity = guessActivity(pts, hint + ' ' + filename);
  return { id, status: 'done', activity, name: name || `Imported ${ACTIVITIES[activity].noun}`, startedAt: pts[0].t, endedAt: pts[pts.length - 1].t, points: pts };
}

const lowerFirst = t => t.charAt(0).toLowerCase() + t.slice(1);

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
  if (!drive) { view.innerHTML = `<section class="card"><p>That recording isn't on this phone.</p><a class="btn" href="#/">Home</a></section>`; return; }
  if (drive.status === 'recording') { location.hash = recorder.id === id ? '#/record' : '#/'; return; }
  if (!drive.points || drive.points.length < 2) {
    view.innerHTML = `<section class="card"><h2>Too short to show</h2><p class="muted">This recording has fewer than two GPS readings. GPS may not have locked on.</p><button class="btn ghost" id="del">Delete it</button></section>`;
    $('#del').onclick = async () => { await store.deleteDrive(id); location.hash = '#/'; };
    return;
  }
  const save = async () => { drive.summary = analyse(drive.points, drive.limits).summary; await store.putDrive(drive); };
  // Speed limits only matter for drives
  if (!actOf(drive).limits) {
    if (drive.limits || !drive.summary) { delete drive.limits; await save(); }
    renderDrive(drive, { own: true, save });
    return;
  }
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
  if (!d.limits && actOf(d).limits) await ensureLimits(d);
  renderDrive(d, { own: false });
}

function stars(n) { return '●'.repeat(n) + '○'.repeat(5 - n); }

function renderDrive(drive, { own, save }) {
  const act = actOf(drive), motor = !act.pace;
  const spd = v => speedFor(act, v);
  const A = analyse(drive.points, act.limits ? drive.limits : undefined);
  const S = A.summary;
  const lim = drive.limits || {};
  const limitsNote = lim.status === 'pending'
    ? 'Checking OpenStreetMap for posted speed limits. Until then this uses Thai defaults (80 km/h in greater Bangkok, 90 outside), and the page updates by itself.'
    : lim.status === 'defaults'
    ? 'Couldn’t reach OpenStreetMap, so every limit here is a Thai default (80 km/h in greater Bangkok, 90 outside).'
    : `About ${Math.round(S.osmShare * 100)}% of this route has a posted limit in OpenStreetMap; the rest uses Thai defaults (80 km/h in greater Bangkok, 90 outside). Limits are approximate.`;
  view.innerHTML = `
    ${!own ? `<section class="card banner">${act.icon} Shared ${esc(act.noun)}${drive.from ? ` from <strong>${esc(drive.from)}</strong>` : ''}. The first and last few hundred metres may be hidden for privacy.</section>` : ''}
    <div class="title-row">
      ${own ? `<input class="title-input" id="name" value="${esc(drive.name)}" placeholder="${esc(driveTitle({ ...drive, name: '' }))}" aria-label="Name">` : `<h1>${esc(driveTitle(drive))}</h1>`}
    </div>
    ${own ? `<label class="act-row"><span class="muted small">Activity</span><select id="actSel" aria-label="Activity">${Object.entries(ACTIVITIES).map(([k, a]) => `<option value="${k}"${k === actKey(drive) ? ' selected' : ''}>${a.icon} ${a.label}</option>`).join('')}</select></label>` : ''}
    <p class="muted small">${esc(fmtDate(S.start))} to ${esc(new Date(S.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</p>
    <div class="map-box"><div class="map" id="map"></div><div class="map map3d" id="map3d" hidden></div><button class="btn small ghost grade-btn" id="gradeBtn" hidden aria-pressed="false">⛰ Steepness</button><div class="gbar-overlay" id="gbar"${motor ? '' : ' hidden'}>${gBarHTML()}</div>${webglOk() ? '<button class="btn small ghost view3d-btn" id="v3d" aria-label="Change camera view">🚁</button>' : ''}</div>
    <div class="replay">
      <button class="btn small" id="play" aria-label="Play replay">▶</button>
      <input type="range" id="scrub" min="0" max="${A.pts.length - 1}" value="0" aria-label="Replay position">
      <button class="btn small ghost" id="rspeed" aria-label="Replay speed">20×</button>
    </div>
    <div class="readout" id="readout"></div>
    <div class="legend">${act.limits ? '<span><i class="sw blue"></i>Under the limit</span><span><i class="sw red"></i>Over the limit</span>' : `<span><i class="sw blue"></i>Your ${esc(act.noun)}</span>`}<span><i class="sw gap"></i>Recording gap</span>${motor ? '<span><i class="dot orange"></i>Hard braking or acceleration</span>' : ''}</div>

    <section class="stats">
      <div><b>${fmtKm(S.distance)}</b><small>distance</small></div>
      <div><b>${fmtDur(S.durationMs)}</b><small>total time</small></div>
      <div><b>${fmtDur(S.movingMs)}</b><small>moving time</small></div>
      <div><b>${spd(S.avgKmh).n}</b><small>${act.pace ? 'avg pace, min/km' : 'avg km/h moving'}</small></div>
      <div><b>${spd(S.maxKmh).n}</b><small>${act.pace ? 'best pace, min/km' : 'top km/h'}</small></div>
      <div><b>${S.stops}</b><small>stops</small></div>
      ${motor ? `<div><b>${S.harshBrake}</b><small>hard braking</small></div>
      <div><b>${S.harshAccel}</b><small>hard acceleration</small></div>
      <div><b class="stars">${stars(S.smoothness)}</b><small>smoothness</small></div>` : `<div><b>${act.pace ? Math.round(S.avgKmh * 10) / 10 : ''}</b><small>avg km/h</small></div>`}
    </section>

    ${act.limits ? `<section class="card ${S.speedingCount ? 'red-card' : 'green-card'}">
      ${S.speedingCount
        ? `<strong>${S.speedingCount} stretch${S.speedingCount > 1 ? 'es' : ''} over the limit</strong>
           <p class="small">${fmtKm(S.speedingDist)} in total, ${fmtDur(S.speedingMs)}, up to ${Math.round(S.maxOver)} km/h over.</p>
           <ul class="over-list">${A.speeding.map((x, k) => `<li><button class="linkish" data-jump="${x.i0}">${fmtTime(A.pts[x.i0].t)}</button> · ${fmtKm(x.dist)} where the limit is ${x.limit}, up to ${Math.round(x.limit + x.maxOver)} km/h</li>`).join('')}</ul>`
        : `<strong>No stretches over the limit</strong>`}
      <p class="muted small">${esc(limitsNote)}</p>
    </section>` : ''}
    <section id="same"></section>
    ${S.gaps ? `<p class="muted small">Recording paused ${S.gaps} time${S.gaps > 1 ? 's' : ''} (page closed or GPS lost). Gaps are shown dashed on the map.</p>` : ''}

    <h2 class="section-title">Speed</h2>
    <canvas class="chart" id="cs"></canvas>
    <p class="muted small chart-key">${act.limits ? '<i class="sw blue"></i> speed <i class="sw red"></i> over the limit <i class="sw limit"></i> speed limit' : '<i class="sw blue"></i> speed, km/h'}</p>
    <div${motor ? '' : ' hidden'}>
    <h2 class="section-title">Acceleration and braking (g)</h2>
    <canvas class="chart" id="cg"></canvas>
    <p class="muted small chart-key">Above the line is speeding up, below is braking. Dotted lines mark hard acceleration (0.30 g) and hard braking (0.35 g).</p>
    </div>
    <h2 class="section-title">Elevation</h2>
    <p class="small elev-sum" id="elevSum"><span class="muted">Working out heights from terrain data…</span></p>
    <canvas class="chart elev-chart" id="ce"></canvas>
    <p class="muted small chart-key">Shaded by steepness: <i class="sw" style="background:#22c55e"></i> under 2% <i class="sw" style="background:#facc15"></i> 2–5% <i class="sw" style="background:#f97316"></i> 5–8% <i class="sw" style="background:#ef4444"></i> steeper. Heights come from terrain data (about 30 m detail), not the phone's GPS. Tap ⛰ Steepness on the map to colour the route the same way.</p>

    <section class="actions">
      <button class="btn start-alt" id="follow">Follow this route with a ghost</button>
      <button class="btn" id="shareDrive">Share this ${esc(act.noun)}</button>
      <button class="btn ghost" id="shareRoute">Share just the route</button>
      ${!own ? `<button class="btn ghost" id="saveCopy">Save to my recordings</button>` : ''}
      <button class="btn ghost" id="gpx">Export GPX</button>
      <button class="btn ghost" id="csv">Export CSV</button>
      ${own ? `${act.limits ? '<button class="btn ghost" id="recheck">Recheck speed limits</button>' : ''}<button class="btn danger" id="delete">Delete ${esc(act.noun)}</button>` : ''}
    </section>
  `;

  // map
  const map = newMap($('#map'));
  const blue = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const red = getComputedStyle(document.documentElement).getPropertyValue('--red').trim();
  // everything drawn is also kept in lines/pins so the 3D view can draw the same
  const lines = [], pins = [];
  const speedLayer = L.layerGroup().addTo(map);
  const seg = (coords, o) => { lines.push({ coords, ...o, dash: !!o.dashArray }); L.polyline(coords, o).addTo(speedLayer); };
  let run = [A.pts[0]], runOver = A.pts[0].over;
  const flush = () => { if (run.length > 1) seg(run.map(p => [p.la, p.lo]), { color: runOver ? red : blue, weight: runOver ? 6 : 5, opacity: 0.95 }); };
  for (let i = 1; i < A.pts.length; i++) {
    const p = A.pts[i];
    if (p.gapBefore) {
      flush();
      seg([[A.pts[i - 1].la, A.pts[i - 1].lo], [p.la, p.lo]], { color: '#888', weight: 3, dashArray: '6 8' });
      run = [p]; runOver = p.over; continue;
    }
    if (p.over !== runOver) { run.push(p); flush(); run = [p]; runOver = p.over; }
    else run.push(p);
  }
  flush();
  for (const e of A.events) {
    const p = A.pts[e.i];
    pins.push({ ll: [p.la, p.lo], fill: '#f59e0b', title: e.type === 'brake' ? 'Hard braking' : 'Hard acceleration' });
    L.circleMarker([p.la, p.lo], { radius: 6, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1 })
      .bindPopup(`${e.type === 'brake' ? 'Hard braking' : 'Hard acceleration'}, ${Math.abs(e.g).toFixed(2)} g<br>${fmtTime(p.t)}`).addTo(map);
  }
  const first = A.pts[0], last = A.pts[A.pts.length - 1];
  pins.push({ ll: [first.la, first.lo], fill: '#22c55e', title: 'Start' }, { ll: [last.la, last.lo], fill: '#111', title: 'Finish' });
  L.circleMarker([first.la, first.lo], { radius: 7, color: '#fff', weight: 2, fillColor: '#22c55e', fillOpacity: 1 }).bindPopup('Start').addTo(map);
  L.circleMarker([last.la, last.lo], { radius: 7, color: '#fff', weight: 2, fillColor: '#111', fillOpacity: 1 }).bindPopup('Finish').addTo(map);
  map.fitBounds(L.latLngBounds(A.pts.map(p => [p.la, p.lo])), { padding: [24, 24] });
  const trail = L.polyline([], { color: '#fff', weight: 3, opacity: 0.85 }).addTo(map);
  const marker = L.marker([first.la, first.lo], { icon: dotIcon(blue), zIndexOffset: 1000, interactive: false }).addTo(map);
  // the 3D view (when on) mirrors the dot and trail
  let m3 = null, m3dot = null, m3trail = null, m3lines = null, m3grade = null;
  // elevation: worked out once from terrain data, kept with your own recordings
  let prof = drive.elev && drive.elev.v === 1 ? drive.elev.p : null, gradeOn = false, gradeLayer = null, elevCh = null;
  function applyGrade() {
    if (!prof) return;
    const gl = gradeLines(prof).map(l => ({ ...l, weight: 5, opacity: 0.95 }));
    if (gradeOn) {
      if (!gradeLayer) gradeLayer = L.layerGroup(gl.map(l => L.polyline(l.coords, { color: l.color, weight: 5, opacity: 0.95 })));
      map.removeLayer(speedLayer); gradeLayer.addTo(map);
    } else { if (gradeLayer) map.removeLayer(gradeLayer); speedLayer.addTo(map); }
    if (m3) {
      if (gradeOn && !m3grade) m3grade = m3.addLines(gl);
      if (m3lines) m3.showLines(m3lines, !gradeOn);
      if (m3grade) m3.showLines(m3grade, gradeOn);
    }
  }
  function drawElev() { if (prof && $('#ce')) elevCh = elevChart($('#ce'), prof, A.pts[idx] ? A.pts[idx].dist : null); }
  function showElev() {
    if (!$('#elevSum')) return;
    $('#elevSum').innerHTML = `<b>↑ ${prof.climb} m</b> climb · <b>↓ ${prof.descent} m</b> descent · ${prof.min}–${prof.max} m high · steepest ${prof.steepest}%`;
    $('#gradeBtn').hidden = false;
    drawElev();
  }
  const dotEls = () => [marker.getElement(), m3dot?.getElement()].map(e => e?.querySelector('.live-dot')).filter(Boolean);
  const setSpd = v => dotEls().forEach(d => { d.querySelector('.spd').textContent = spd(v).n; });
  const prevOf = i => { const q = A.pts[Math.max(0, i - 8)]; return [q.la, q.lo]; };
  // camera views: helicopter (default), street level, or the flat map
  const VIEWS = { heli: '🎥 Chase', street: '🚁 High', '2d': '🗺 2D' };
  let viewMode = store.settings().replayView || 'heli';
  async function setView(mode) {
    viewMode = mode;
    store.saveSettings({ ...store.settings(), replayView: mode });
    if ($('#v3d')) $('#v3d').textContent = VIEWS[mode];
    if (mode === '2d') return set3D(false);
    await set3D(true);
    if (m3) { m3.cam = mode; m3.zoomBias = 0; const p = A.pts[idx]; m3.follow([p.la, p.lo], idx ? prevOf(idx) : null, { duration: 600 }); }
  }
  async function set3D(on) {
    if (!$('#v3d')) return;
    if (!on) { if (m3) { m3.remove(); m3 = m3dot = m3trail = null; } $('#map3d').hidden = true; $('#map').style.visibility = ''; return; }
    if (m3) return;
    $('#map3d').hidden = false; $('#map').style.visibility = 'hidden';
    try {
      m3 = await open3D($('#map3d'), { autoCam: true }); m3.cam = viewMode;
      m3.onBias = () => { if (!playing && m3) { const p = A.pts[idx]; m3.follow([p.la, p.lo], idx ? prevOf(idx) : null, { duration: 1 }); } };
    }
    catch (e) { console.warn(e); toast('The 3D view isn’t available on this phone.'); viewMode = '2d'; if ($('#v3d')) $('#v3d').textContent = VIEWS['2d']; return set3D(false); }
    if (!document.body.contains($('#map3d'))) { m3.remove(); m3 = null; return; }
    m3lines = m3.addLines(lines);
    m3grade = null; applyGrade();
    pins.forEach(p => m3.pin(p.ll, p.fill, p.title));
    m3trail = m3.liveLine('#fff', 3, 0.85);
    m3dot = m3.dot(`<div class="live-dot${playing ? ' moving' : ''}" style="--c:${blue}"><i></i><span class="spd">0</span></div>`, [A.pts[idx].la, A.pts[idx].lo]);
    const p = A.pts[idx];
    m3dot.setLatLng([p.la, p.lo]); m3trail.setLatLngs(A.pts.slice(0, idx + 1).map(q => [q.la, q.lo]));
    setSpd(p.v);
    m3.follow([p.la, p.lo], idx ? prevOf(idx) : [A.pts[Math.min(4, A.pts.length - 1)].la, A.pts[Math.min(4, A.pts.length - 1)].lo].map((x, k) => 2 * [p.la, p.lo][k] - x));
  }
  if ($('#v3d')) $('#v3d').onclick = () => setView({ heli: 'street', street: '2d', '2d': 'heli' }[viewMode]);

  // replay + charts
  const cs = $('#cs'), cg = $('#cg'), scrub = $('#scrub'), readout = $('#readout');
  let idx = 0;
  const setIdx = (i, pan) => {
    idx = Math.max(0, Math.min(A.pts.length - 1, i));
    const p = A.pts[idx];
    if (!playing) {
      marker.setLatLng([p.la, p.lo]);
      trail.setLatLngs(idx ? A.pts.slice(0, idx + 1).map(q => [q.la, q.lo]) : []);
      if (m3) {
        m3dot.setLatLng([p.la, p.lo]); m3trail.setLatLngs(A.pts.slice(0, idx + 1).map(q => [q.la, q.lo]));
        if (pan) { m3.follow([p.la, p.lo], prevOf(idx), { duration: 300 }); }
      }
    }
    dotEls().forEach(d => d.classList.toggle('over', !!p.over));
    if (!playing) { setSpd(p.v); gSoft = p.a; setGBar($('#gbar'), p.a); }
    if (pan && !map.getBounds().pad(-0.1).contains([p.la, p.lo])) map.panTo([p.la, p.lo]);
    scrub.value = idx;
    readout.innerHTML = `<span>${fmtClock(p.t - first.t)}</span><span class="${p.over ? 'red-text' : ''}"><b>${spd(p.v).n}</b> ${spd(p.v).u}</span>${act.limits ? `<span>limit ${p.limit ?? '–'}${p.limitSrc === 'd' ? '*' : ''}</span>` : ''}${motor ? `<span>${p.a >= 0 ? '+' : ''}${p.a.toFixed(2)} g</span>` : act.pace ? `<span>${Math.round(p.v)} km/h</span>` : ''}`;
    speedChart(cs, A, idx); gChart(cg, A, idx); drawElev();
  };
  scrub.oninput = () => { stopPlay(); setIdx(+scrub.value, true); };
  const onChart = c => e => { stopPlay(); setIdx(xToIndex(c, A, e.clientX), true); };
  for (const c of [cs, cg]) { c.addEventListener('pointerdown', onChart(c)); c.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') onChart(c)(e); }); }
  // replay (20× real time to start); the dot glides between GPS fixes and leaves a trail
  let playing = false, raf = null, rate = 20, gSoft = null;
  $('#rspeed').onclick = e => { rate = nextRate(rate); e.target.textContent = rate + '×'; };
  const stopPlay = () => { playing = false; cancelAnimationFrame(raf); $('#play').textContent = '▶'; dotEls().forEach(d => d.classList.remove('moving')); };
  $('#play').onclick = () => {
    if (playing) return stopPlay();
    if (idx >= A.pts.length - 1) setIdx(0);
    playing = true;
    $('#play').textContent = '❚❚';
    dotEls().forEach(d => d.classList.add('moving'));
    let simT = A.pts[idx].t, lastFrame = performance.now();
    const trailPts = A.pts.slice(0, idx + 1).map(q => [q.la, q.lo]);
    const frameFn = now => {
      if (!playing) return;
      simT += (now - lastFrame) * rate; lastFrame = now;
      let j = idx;
      while (j < A.pts.length - 1 && A.pts[j + 1].t <= simT) { j++; trailPts.push([A.pts[j].la, A.pts[j].lo]); }
      const a = A.pts[j], b = A.pts[Math.min(j + 1, A.pts.length - 1)];
      const f = b.t > a.t && !b.gapBefore ? Math.min(1, (simT - a.t) / (b.t - a.t)) : 0;
      const ll = [a.la + f * (b.la - a.la), a.lo + f * (b.lo - a.lo)];
      marker.setLatLng(ll);
      if (m3) {
        m3dot.setLatLng(ll);
        m3trail.setLatLngs([...trailPts, ll]);
        m3.follow(ll, prevOf(j), { speed: a.v + f * (b.v - a.v) });
      }
      setSpd(a.v + f * (b.v - a.v));
      gSoft = ease(gSoft, a.a + f * (b.a - a.a));
      setGBar($('#gbar'), gSoft);
      trail.setLatLngs([...trailPts, ll]);
      if (j !== idx) setIdx(j, true);
      if (j >= A.pts.length - 1) { stopPlay(); return; }
      raf = requestAnimationFrame(frameFn);
    };
    raf = requestAnimationFrame(frameFn);
  };
  view.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => { stopPlay(); setIdx(+b.dataset.jump, true); $('#map').scrollIntoView({ behavior: 'smooth' }); });
  setIdx(0);
  const onResize = () => { speedChart(cs, A, idx); gChart(cg, A, idx); drawElev(); };
  // elevation chart: tap or drag to jump there; the map button colours the route by steepness
  const onElev = e => { if (!elevCh) return; stopPlay(); const m = elevCh.distAt(e.clientX); let j = 0; while (j < A.pts.length - 1 && A.pts[j + 1].dist <= m) j++; setIdx(j, true); };
  $('#ce').addEventListener('pointerdown', onElev);
  $('#ce').addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') onElev(e); });
  $('#gradeBtn').onclick = () => { gradeOn = !gradeOn; $('#gradeBtn').classList.toggle('on', gradeOn); $('#gradeBtn').setAttribute('aria-pressed', gradeOn); applyGrade(); };
  if (prof) showElev();
  else profile(drive.points).then(async p => {
    if (!p || !document.body.contains($('#ce'))) return;
    prof = p; showElev();
    if (own) { drive.elev = { v: 1, p }; await store.putDrive(drive); }
  }).catch(e => { console.warn('Elevation unavailable', e); if ($('#elevSum')) $('#elevSum').innerHTML = '<span class="muted">Couldn’t get terrain data right now. It’ll try again next time you open this.</span>'; });
  window.addEventListener('resize', onResize);

  // actions
  const me = store.settings().name;
  $('#shareDrive').onclick = async () => {
    const payload = await packDrive(drive, { trim: own && store.settings().trimShare, from: own ? me : drive.from });
    const r = await shareLink(shareUrl('s', payload), driveTitle(drive), `${driveTitle(drive)}: ${fmtKm(S.distance)} on Ghost Run`);
    if (r === 'copied') toast('Link copied. Paste it to a friend.');
  };
  $('#shareRoute').onclick = async () => {
    const payload = await packRoute(drive.points, { name: driveTitle(drive), from: own ? me : drive.from, trim: own && store.settings().trimShare, mode: act.route, activity: actKey(drive) });
    const r = await shareLink(shareUrl('r', payload), 'Route: ' + driveTitle(drive), `A route to ${act.pace ? act.noun : act.route === 'car' ? 'drive' : 'follow'}: ${driveTitle(drive)}`);
    if (r === 'copied') toast('Route link copied. Your friend gets a map and directions.');
  };
  $('#follow').onclick = () => followGuide(guideFromDrive(drive, driveTitle(drive)));
  const fname = (driveTitle(drive).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'drive').slice(0, 60);
  $('#gpx').onclick = () => saveFile(gpx(drive, A), fname + '.gpx', 'application/gpx+xml');
  $('#csv').onclick = () => saveFile(csv(drive, A), fname + '.csv', 'text/csv');
  if ($('#saveCopy')) $('#saveCopy').onclick = async () => {
    const id = 'd' + Date.now().toString(36);
    await store.putDrive({ id, status: 'done', activity: actKey(drive), from: drive.from || 'Friend', name: driveTitle(drive) + (drive.from ? ` (from ${drive.from})` : ''), startedAt: drive.startedAt, endedAt: drive.endedAt, points: drive.points, limits: drive.limits, summary: S });
    toast('Saved to your recordings.');
    location.hash = '#/drive/' + id;
  };
  if (own) {
    $('#name').onchange = async e => { drive.name = e.target.value.trim(); await store.putDrive(drive); toast('Name saved.'); };
    $('#actSel').onchange = async e => {
      drive.activity = e.target.value;
      if (!actOf(drive).limits) delete drive.limits;
      drive.summary = null;
      await store.putDrive(drive);
      toast(`Now a ${actOf(drive).noun}.`);
      route();
    };
    if ($('#recheck')) $('#recheck').onclick = async e => {
      e.target.disabled = true; e.target.textContent = 'Checking…';
      drive.limits = await computeLimits(drive.points);
      await save();
      toast(drive.limits.status === 'osm' ? 'Speed limits updated from OpenStreetMap.' : 'Couldn’t reach OpenStreetMap. Using Thai defaults.');
      route();
    };
    $('#delete').onclick = async () => {
      if (!confirm(`Delete this ${act.noun} from this phone? Links you already shared keep working.`)) return;
      await store.deleteDrive(drive.id);
      location.hash = '#/';
    };
  }
  const viewReady = webglOk() ? setView(viewMode) : (viewMode = '2d', null);
  if (own && autoPlay === drive.id) { autoPlay = null; Promise.resolve(viewReady).then(() => { if (document.body.contains($('#play')) && !playing) $('#play').click(); }); }
  mapHint($('.map-box'), matchMedia('(pointer: coarse)').matches ? undefined : 'Scroll to zoom · right-drag to turn and tilt');
  cleanup = () => { stopPlay(); window.removeEventListener('resize', onResize); dropMap(map); if (m3) { m3.remove(); m3 = null; } };

  // other drives on the same route: yours, and friends' drives you've saved
  store.allDrives().then(all => {
    const others = all.filter(d => d.status === 'done' && d.id !== drive.id && !!d.sample === !!drive.sample);
    const group = compareGroup(drive, others, me);
    const box = $('#same');
    if (!box) return;
    if (!group) {
      box.innerHTML = `<p class="muted small same-empty">Nothing else recorded on this route yet. Share the route with a friend; when they do it and send you theirs, save it and you can race the two here, whatever each of you went by.</p>`;
      return;
    }
    renderCompareList(box, group, g2 => renderRace(g2));
  });
}

// The acceleration / braking bar: grows right (green) when speeding up, left (red) when braking.
// Full width is 0.5 g; it turns brighter past the "hard" thresholds. Eased so it moves softly.
const G_FULL = 0.5;
const gBarHTML = (mini = false) => `<div class="gbar${mini ? ' mini' : ''}">${mini ? '' : '<span class="gb-lbl">Braking</span>'}<div class="gb-track"><i class="gb-mid"></i><div class="gb-fill"></div></div>${mini ? '' : '<span class="gb-lbl">Accel</span><span class="gb-val">0.00 g</span>'}</div>`;
const gFillStyle = g => { const w = Math.min(1, Math.abs(g) / G_FULL) * 50; return `left:${g < 0 ? 50 - w : 50}%;width:${w}%`; };
const gFillClass = g => 'gb-fill ' + (g < 0 ? 'brake' : 'accel') + (g >= 0.3 || g <= -0.35 ? ' hard' : '');
function setGBar(el, g) {
  if (!el) return;
  const f = el.querySelector('.gb-fill');
  f.style.cssText = gFillStyle(g); f.className = gFillClass(g);
  const v = el.querySelector('.gb-val');
  if (v) v.textContent = `${g >= 0 ? '+' : '−'}${Math.abs(g).toFixed(2)} g`;
}
const ease = (prev, g, k = 0.18) => prev == null ? g : prev + (g - prev) * k;

// A short hint over a map on how to move it; fades after a few seconds or at the first touch.
function mapHint(box, text = '🤏 Pinch to zoom · two fingers to turn and tilt') {
  if (!box) return;
  const h = document.createElement('div');
  h.className = 'map-hint';
  h.textContent = text;
  box.appendChild(h);
  const go = () => { h.classList.add('gone'); setTimeout(() => h.remove(), 600); };
  const t = setTimeout(go, 5000);
  box.addEventListener('touchstart', () => { clearTimeout(t); go(); }, { once: true, passive: true });
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
      <ol class="cmp-list pick">${group.entries.map((e, k) => `
        <li class="${e.isRef ? 'me' : ''}">
          <label class="cmp-check"><input type="checkbox" data-k="${k}" ${k < RACE_COLORS.length ? 'checked' : ''}><span class="cmp-pos">${k + 1}</span></label>
          <span class="cmp-name">${esc(e.label)}${e.isRef ? ' <em>(this one)</em>' : ''}</span>
          <span class="cmp-time">${fmtClock(e.ms)}${k ? `<small>+${fmtClock(e.ms - best)}</small>` : ''}</span>
          <span class="cmp-red">${e.redCount ? `<span class="tag red">${e.redCount} red</span>` : '<span class="tag green">clean</span>'}</span>
        </li>`).join('')}</ol>
      <button class="btn" id="raceBtn">▶ Race replay</button>
      <p class="muted small">Tick the drives to include, up to ${RACE_COLORS.length}.</p>
    </section>`;
  const boxes = [...box.querySelectorAll('input[data-k]')];
  const sync = () => {
    const n = boxes.filter(b => b.checked).length;
    boxes.forEach(b => { b.disabled = !b.checked && n >= RACE_COLORS.length; });
    $('#raceBtn', box).disabled = n < 1;
    $('#raceBtn', box).textContent = n > 1 ? `▶ Race ${n} drives` : '▶ Replay';
  };
  boxes.forEach(b => b.onchange = sync);
  sync();
  $('#raceBtn', box).onclick = () => {
    const picked = boxes.filter(b => b.checked).map(b => group.entries[+b.dataset.k]);
    onRace({ ...group, entries: picked });
  };
}

function groupForSelection(drives) {
  const me = store.settings().name;
  const [ref, ...rest] = drives;
  const g = compareGroup(ref, rest, me);
  if (g && g.entries.length === drives.length) return { ...g, sameRoute: true };
  const entries = drives.map(d => {
    const A = analyse(d.points, actOf(d).limits ? d.limits : undefined);
    const n = d.points.length - 1;
    return {
      drive: d, A, i0: 0, i1: n, ms: d.points[n].t - d.points[0].t, dist: A.summary.distance,
      label: (actKey(d) !== 'drive' ? actOf(d).icon + ' ' : '') + (d.from ? d.from + ': ' : '') + driveTitle(d), isRef: false, redCount: A.speeding.length,
    };
  }).sort((a, b) => a.drive.startedAt - b.drive.startedAt);
  return { entries, sameRoute: false };
}

async function raceFromStore(id) {
  view.innerHTML = `<p class="loading">Lining up the race…</p>`;
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
      <h1>${group.sameRoute === false ? 'Playback' : 'Race replay'}</h1>
    </div>
    <div class="race-wrap">
      <div class="map race-map" id="map"></div>
      <div class="map race-map map3d" id="map3d" hidden></div>
      <div class="race-clock" id="clock">0:00</div>
      ${webglOk() ? '<button class="btn small ghost view3d-btn race-3d" id="v3d">🗺 2D</button>' : ''}
      <button class="btn small ghost race-fit" id="fitAll" hidden>Show everyone</button>
    </div>
    <div class="replay">
      <button class="btn small" id="play" aria-label="Play">▶</button>
      <input type="range" id="scrub" min="0" max="${maxMs}" value="0" step="250" aria-label="Race position">
      <button class="btn small ghost" id="speed">20×</button>
    </div>
    <div class="race-hud" id="hud"></div>
    <p class="muted small">${group.sameRoute === false
      ? 'These drives cover different roads, so each one plays from its own start, all at the same time.'
      : `Everyone starts together at the start of the shared stretch (${fmtKm(group.stretchM)}). Drives were made at different times, so traffic and lights differ.`}</p>
    <section class="card"><ol class="cmp-list">${entries.map((e, k) => `
      <li><span class="cmp-pos" style="background:${e.color}">${k + 1}</span><span class="cmp-name">${esc(e.label)}</span>
      <span class="cmp-time">${fmtClock(e.ms)}</span><span class="cmp-red">${e.redCount ? `<span class="tag red">${e.redCount} red</span>` : '<span class="tag green">clean</span>'}</span></li>`).join('')}</ol></section>`;
  $('#back').onclick = () => { if (fromHash) history.back(); else route(); };
  const map = newMap($('#map'), { zoomSnap: 0 });
  const refE = entries.find(e => e.isRef) || entries[0];
  const lines = [];
  if (group.sameRoute === false) {
    const all = [];
    for (const e of entries) {
      const ll = e.A.pts.map(p => [p.la, p.lo]);
      all.push(...ll);
      lines.push({ coords: ll, color: e.color, weight: 6, opacity: 0.3 });
      L.polyline(ll, { color: e.color, weight: 6, opacity: 0.3 }).addTo(map);
    }
    map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
  } else {
    const stretch = refE.A.pts.slice(refE.i0, refE.i1 + 1).map(p => [p.la, p.lo]);
    lines.push({ coords: stretch, color: '#94a3b8', weight: 8, opacity: 0.35 });
    L.polyline(stretch, { color: '#94a3b8', weight: 8, opacity: 0.35 }).addTo(map);
    map.fitBounds(L.latLngBounds(stretch), { padding: [30, 30] });
  }
  const dots = entries.map((e, k) => {
    const trail = L.polyline([], { color: e.color, weight: 4, opacity: 0.9 }).addTo(map);
    const html = `<div class="live-dot race${k % 2 ? " alt" : ""}" style="--c:${e.color}"><i></i><b>${k + 1}</b><span class="spd">0</span></div>`;
    const m = L.marker([e.A.pts[e.i0].la, e.A.pts[e.i0].lo], { icon: L.divIcon({ className: 'dot-wrap', html, iconSize: [26, 26], iconAnchor: [13, 13] }), zIndexOffset: 1000 - k, interactive: false }).addTo(map);
    return { e, trail, m, html };
  });
  const firstNames = entries.map(e => e.label.split(',')[0]);
  const dupNames = new Set(firstNames).size < firstNames.length;
  let t = 0, playing = false, raf = null, rate = 20;
  // keep everyone in view while it plays; a pinch only sets how close the camera sits
  let lastFit = 0;
  // 3D view: same lines and dots on a tilted map with buildings
  let m3 = null;
  async function set3D(on) {
    store.saveSettings({ ...store.settings(), raceView: on ? '3d' : '2d' });
    if (!$('#v3d')) return;
    $('#v3d').textContent = on ? '🚁 Drone' : '🗺 2D';
    if (!on) { if (m3) { m3.remove(); m3 = null; dots.forEach(d => { d.m3 = d.t3 = null; }); } $('#map3d').hidden = true; $('#map').style.visibility = ''; return; }
    if (m3) return;
    $('#map3d').hidden = false; $('#map').style.visibility = 'hidden';
    try { m3 = await open3D($('#map3d'), { autoCam: true }); m3.onBias = b => { $('#fitAll').hidden = b <= 0.3; if (!playing) kick(); }; }
    catch (e) { console.warn(e); toast('The 3D view isn’t available on this phone.'); return set3D(false); }
    if (!document.body.contains($('#map3d'))) { m3.remove(); m3 = null; return; }
    m3.addLines(lines);
    dots.forEach(d => { d.t3 = m3.liveLine(d.e.color, 4, 0.9); d.m3 = m3.dot(d.html, [d.e.A.pts[d.e.i0].la, d.e.A.pts[d.e.i0].lo]); });
    m3.fit(lines.flatMap(l => l.coords), { padding: 40 });
    lastFit = 0;
    draw();
    fitAll(true);
  }
  if ($('#v3d')) $('#v3d').onclick = () => set3D(!m3);
  $('#fitAll').onclick = () => { lastFit = 0; bias2d = 0; if (m3) m3.zoomBias = 0; $('#fitAll').hidden = true; fitAll(true); };
  // when paused, keep the camera moving for a moment so a pinch shows straight away
  let kickT = 0;
  function kick() { const until = performance.now() + 900; const step = () => { if (playing) return; fitAll(false); if (performance.now() < until) kickT = requestAnimationFrame(step); }; cancelAnimationFrame(kickT); kickT = requestAnimationFrame(step); }
  // flat map: fingers only zoom too, and the camera keeps following
  let bias2d = 0;
  for (const h of ['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard']) map[h]?.disable();
  pinchZoom($('#map'), d => { bias2d = Math.max(-4, Math.min(3, bias2d + d)); $('#fitAll').hidden = bias2d <= 0.3; if (!playing) kick(); });
  function fitAll(force) {
    const live = dots.map(({ e }) => positionAt(e, t)).filter(p => !p.done);
    const pts = (live.length ? live : dots.map(({ e }) => positionAt(e, t))).map(p => [p.la, p.lo]);
    if (!pts.length) return;
    if (m3) {
      // also frame where they'll be in a moment, so the camera leads rather than lags
      // (a couple of seconds of race time, not more: at fast replay speeds a long look-ahead zoomed the camera far out)
      const ahead = dots.map(({ e }) => positionAt(e, Math.min(maxMs, t + Math.min(rate * 700, 2500)))).filter(p => !p.done).map(p => [p.la, p.lo]);
      // face the way the leader is going
      const lead = dots.map(({ e }) => ({ e, p: positionAt(e, t) })).filter(x => !x.p.done).sort((a, b) => b.p.prog - a.p.prog)[0];
      let hd = null;
      if (lead) { const q = positionAt(lead.e, Math.max(0, t - 4000)); if (q.la !== lead.p.la || q.lo !== lead.p.lo) hd = bearing(q.la, q.lo, lead.p.la, lead.p.lo); }
      if (force) { m3.resetTrack(); m3.fit(pts, { padding: 60, duration: 600 }); } else m3.track([...pts, ...ahead], 60, hd, pts);
      return;
    }
    // flat map: the same gliding camera (fractional zoom), instead of jumps every few seconds
    if (!force) {
      const now2 = performance.now(), dt = Math.min(0.1, ((now2 - (lastFit || now2)) / 1000) || 0.016);
      lastFit = now2;
      const ease = tau => 1 - Math.exp(-dt / tau);
      const ahead = dots.map(({ e }) => positionAt(e, Math.min(maxMs, t + Math.min(rate * 700, 2500)))).filter(p => !p.done).map(p => [p.la, p.lo]);
      const bb = L.latLngBounds([...pts, ...ahead]);
      let tz = Math.min(19, map.getBoundsZoom(bb, false, L.point(80, 100)) + bias2d);
      const z = map.getZoom(), c = map.getCenter(), tc = bb.getCenter();
      // everyone stays on screen, even when pinched in
      const inner = map.getBounds().pad(-0.06);
      if (pts.some(p => !inner.contains(p))) tz = Math.min(tz, z - 0.25);
      const kz = ease(tz < z ? 0.35 : 1.4), kc = ease(0.3);
      map.setView([c.lat + (tc.lat - c.lat) * kc, c.lng + (tc.lng - c.lng) * kc], z + (tz - z) * kz, { animate: false });
      return;
    }
    const now = performance.now();
    const outside = m3 ? pts.some(p => !m3.inView(p, 0.18)) : (() => { const inner = map.getBounds().pad(-0.2); return pts.some(p => !inner.contains(p)); })();
    // re-frame when someone nears the edge, or every few seconds so it zooms back in as they bunch up
    if (!force && !outside && now - lastFit < 3000) return;
    if (!force && now - lastFit < 700) return;
    lastFit = now;
    if (m3) m3.fit(pts, { padding: { top: 70, bottom: 50, left: 50, right: 50 }, duration: 800 });
    else map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [40, 50], paddingBottomRight: [40, 40], maxZoom: 17, animate: true, duration: 0.8 });
  }
  const draw = () => {
    $('#clock').textContent = fmtClock(t);
    $('#scrub').value = t;
    const rows = dots.map(d => {
      const { e, trail, m } = d;
      const p = positionAt(e, t);
      m.setLatLng([p.la, p.lo]);
      if (d.m3) d.m3.setLatLng([p.la, p.lo]);
      for (const el of [m.getElement(), d.m3?.getElement()].map(x => x?.querySelector('.live-dot')).filter(Boolean)) {
        el.classList.toggle('over', !!p.over && !p.done);
        el.classList.toggle('done', p.done);
        const sp = el.querySelector('.spd');
        if (sp) sp.textContent = p.done ? '🏁' : Math.round(p.v);
      }
      const P = e.A.pts, end = Math.min(e.i1, e.i0 + Math.max(0, upperIdx(P, e.i0, e.i1, P[e.i0].t + t)));
      const tr = [...P.slice(e.i0, end + 1).map(q => [q.la, q.lo]), [p.la, p.lo]];
      trail.setLatLngs(tr);
      if (d.t3) d.t3.setLatLngs(tr);
      e.gSoft = playing ? ease(e.gSoft, p.g) : p.g;
      return { e, p };
    });
    if (group.sameRoute !== false) rows.sort((a, b) => (b.p.done - a.p.done) || (a.p.done ? a.e.ms - b.e.ms : b.p.prog - a.p.prog));
    const lead = rows[0];
    $('#hud').innerHTML = rows.map(({ e, p }, k) => `
      <div class="hud-row ${p.over && !p.done ? 'over' : ''}">
        <i style="background:${e.color}"></i>
        <span class="hud-name">${esc(group.sameRoute === false || dupNames ? e.label : e.label.split(',')[0])}</span>
        <span class="hud-val">${p.done ? `🏁 ${fmtClock(e.ms)}` : `${Math.round(p.v)} km/h`}</span>
        <span class="hud-gap">${group.sameRoute === false ? fmtKm(p.prog) : k === 0 ? 'lead' : p.done ? '' : `−${fmtKm(Math.max(0, lead.p.prog - p.prog))}`}</span>
        <div class="gbar mini"><div class="gb-track"><i class="gb-mid"></i><div class="${gFillClass(e.gSoft || 0)}" style="${gFillStyle(p.done ? 0 : e.gSoft || 0)}"></div></div></div>
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
      fitAll(false);
      if (t >= maxMs) { stop(); return; }
      raf = requestAnimationFrame(frameFn);
    };
    raf = requestAnimationFrame(frameFn);
  };
  $('#scrub').oninput = e => { stop(); t = +e.target.value; draw(); };
  $('#speed').onclick = e => { rate = nextRate(rate); e.target.textContent = rate + '×'; };
  draw();
  if (webglOk() && store.settings().raceView !== '2d') set3D(true);
  mapHint($('.race-wrap'), matchMedia('(pointer: coarse)').matches ? undefined : 'Scroll to zoom · right-drag to turn and tilt');
  cleanup = () => { stop(); dropMap(map); if (m3) { m3.remove(); m3 = null; } };
}

const RATES = [1, 5, 10, 20, 60];
const nextRate = r => RATES[(RATES.indexOf(r) + 1) % RATES.length];

function upperIdx(P, lo, hi, t) {
  // number of fixes after lo with time <= t
  let a = lo, b = hi;
  while (a < b) { const mid = (a + b + 1) >> 1; if (P[mid].t <= t) a = mid; else b = mid - 1; }
  return a - lo;
}

// ---------- shared route with directions ----------
function renderRoute(r) {
  const pts = r.points;
  const rmode = ROUTE_MODES[r.mode || (r.plan && r.plan.mode)] ? r.mode || r.plan.mode : 'car';
  view.innerHTML = `
    <section class="card banner">${ROUTE_MODES[rmode].icon} Route${r.from ? ` from <strong>${esc(r.from)}</strong>` : ''}${rmode === 'line' ? ', in straight lines (off any road or path)' : rmode === 'foot' ? ', on footpaths and trails' : rmode === 'bike' ? ', by bike' : ''}. Check the way before you set off${rmode === 'car' ? "; don't read directions while driving" : ''}.</section>
    <h1>${esc(r.name || 'Shared route')}</h1>
    <div class="map" id="map"></div>
    <section class="actions">
      ${rmode !== 'line' ? `<a class="btn" href="${esc(googleMapsUrl(pts, rmode))}" target="_blank" rel="noopener">Open in Google Maps</a>` : ''}
      <button class="btn start-alt" id="followRoute">Follow this route</button>
      ${r.id && r.plan ? `<a class="btn ghost" href="#/plan/${encodeURIComponent(r.id)}">Edit route</a>` : ''}
      ${r.id ? `<button class="btn danger" id="delRoute">Remove from my routes</button>` : `<button class="btn ghost" id="saveRoute">Save to my routes</button>`}
    </section>
    ${rmode !== 'line' ? '<p class="muted small">Google Maps only takes a few stops along the way, so its route may differ a little from this one.</p>' : ''}
    <h2 class="section-title">Directions</h2>
    <ol class="directions" id="dir"><li class="muted">Working out directions…</li></ol>`;
  $('#followRoute').onclick = () => followGuide(guideFromRoute(r));
  if ($('#saveRoute')) $('#saveRoute').onclick = async e => {
    const id = 'r' + Date.now().toString(36);
    await store.putDrive({ id, status: 'route', name: r.name || 'Shared route', from: r.from || '', startedAt: Date.now(), points: r.points, mode: rmode, activity: r.activity });
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
  (r.steps ? Promise.resolve(r.steps) : rmode === 'line' ? turnsFor(pts, null, 'line').then(t => [{ at: 0, la: pts[0].la, lo: pts[0].lo, type: 'depart', text: 'Start, following the line on the map' }, ...t.turns].map((x, k, all) => ({ text: x.text, distance: (all[k + 1] ? all[k + 1].at : x.at) - x.at, type: x.type, loc: [x.lo, x.la] }))) : directionsFor(pts, rmode)).then(steps => {
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

// ---------- plan a route ----------
// Search for places or tap the map to add stops; the last stop is where you're going.
async function planView(saved = null) {
  const P = saved ? saved.plan : {};
  const st = {
    fromMe: saved ? !!P.fromMe : true, start: P.start || null,
    stops: (P.stops || []).map(x => ({ ...x })), me: null, result: null,
    mode: P.mode || (ACTIVITIES[store.settings().activity] || ACTIVITIES.drive).route,
  };
  const modeKmh = () => ACTIVITIES[activityForMode(st.mode, store.settings().activity)].kmh;
  view.innerHTML = `
    <h1>${saved ? 'Edit route' : 'Plan a route'}</h1>
    <form class="search-row" id="sf"><input type="search" id="sq" placeholder="Search for a place" enterkeyhint="search" autocomplete="off" autocorrect="off" spellcheck="false"><button class="btn" type="submit">Search</button></form>
    <ul class="results" id="sr" hidden></ul>
    <div class="mode-row" id="pmode" role="group" aria-label="How the route finds its way">${Object.entries(ROUTE_MODES).map(([k, m]) => `<button class="mode-btn${k === st.mode ? ' on' : ''}" data-mode="${k}">${m.icon} ${m.label}</button>`).join('')}</div>
    <div class="plan-map-wrap"><div class="map plan-map" id="pmap"></div><div class="map-chip" id="pchip"></div><button class="btn small ghost view3d-btn plan-tilt" id="ptilt" hidden>2D</button></div>
    <p class="muted small" id="phint">Quick tap on the map to drop a stop (don't hold). Drag a pin to move it. The last stop 🏁 is where you're going. Pinch to zoom; two fingers turn and tilt the map. For water, fields or trails the map doesn't know, pick 📏 Straight and tap out the way.</p>
    <label class="check-row"><input type="checkbox" id="fromMe" ${st.fromMe ? 'checked' : ''}> Start from where I am</label>
    <ol class="stops" id="stops"></ol>
    <div class="plan-sum" id="psum"></div>
    <canvas class="chart elev-chart small" id="pelev" hidden></canvas>
    <section class="actions">
      <button class="btn start-alt" id="pgo" disabled>▶ Navigate and record</button>
      <input type="text" id="pname" class="name-input" placeholder="Route name (optional)" value="${esc(saved ? saved.name : '')}">
      <button class="btn ghost" id="psave" disabled>${saved ? 'Save changes' : 'Save to my routes'}</button>
      <button class="btn ghost" id="pshare" disabled>Share route</button>
    </section>`;
  // a tilted 3D map where the phone can, otherwise the flat one
  const el = $('#pmap');
  let map = null;
  if (webglOk() && store.settings().planView !== '2d') {
    $('#pchip').textContent = 'Loading the map…';
    $('#sf').onsubmit = e => e.preventDefault(); // replaced once the map is ready
    try { map = await plan3D(el); } catch (e) { console.warn('3D planner map unavailable', e); el.innerHTML = ''; }
    if (!document.body.contains(el)) { map?.remove(); return; }
  }
  if (!map) map = flatPlanMap(el, newMap);
  if (map.is3D) {
    let tilted = true;
    const tb = $('#ptilt');
    tb.hidden = false;
    tb.onclick = () => { tilted = !tilted; map.tilt(tilted); tb.textContent = tilted ? '2D' : '3D'; };
  }
  const pinHTML = (txt, cls = '') => `<div class="stop-pin ${cls}">${txt}</div>`;
  let markers = [], timer = null, reqNo = 0;
  const origin = () => st.fromMe ? (st.me ? { ...st.me, name: 'Your location' } : null) : st.start;
  const routeName = () => $('#pname').value.trim() || (st.stops.length ? `To ${st.stops[st.stops.length - 1].name}` : 'Planned route');

  function draw() {
    markers.forEach(m => m.remove()); markers = [];
    if (!st.fromMe && st.start) {
      markers.push(map.addPin([st.start.la, st.start.lo], pinHTML('S', 'start'), ([la, lo]) => { st.start = { la, lo, name: 'Pinned start' }; changed(); }));
    }
    st.stops.forEach((x, k) => {
      const last = k === st.stops.length - 1;
      markers.push(map.addPin([x.la, x.lo], pinHTML(last ? '🏁' : k + 1, last ? 'dest' : ''), ([la, lo]) => { st.stops[k] = { la, lo, name: x.name.startsWith('Pin') ? x.name : 'Pin near ' + x.name }; changed(); }));
    });
    const o = origin();
    $('#pchip').textContent = !st.fromMe && !st.start ? '👆 Tap the map to set your start'
      : !st.stops.length ? '👆 Tap the map where you’re going'
      : '👆 Tap to add a stop · last one is the finish';
    $('#stops').innerHTML = `
      <li class="stop-item origin"><span class="stop-tag ${o ? 'start' : ''}">S</span><span class="stop-name">${st.fromMe ? (st.me ? 'Your location' : 'Finding your location…') : st.start ? esc(st.start.name) : '<span class="muted">Tap the map to set the start</span>'}</span></li>
      ${st.stops.map((x, k) => `
      <li class="stop-item"><span class="stop-tag ${k === st.stops.length - 1 ? 'dest' : ''}">${k === st.stops.length - 1 ? '🏁' : k + 1}</span><span class="stop-name">${esc(x.name)}</span>
        ${k ? `<button class="btn small ghost" data-up="${k}" aria-label="Move earlier">↑</button>` : ''}<button class="btn small ghost" data-del="${k}" aria-label="Remove stop">✕</button></li>`).join('')}`;
    $('#stops').querySelectorAll('[data-del]').forEach(b => b.onclick = () => { st.stops.splice(+b.dataset.del, 1); changed(); });
    $('#stops').querySelectorAll('[data-up]').forEach(b => b.onclick = () => { const k = +b.dataset.up; [st.stops[k - 1], st.stops[k]] = [st.stops[k], st.stops[k - 1]]; changed(); });
  }

  function setResult(r) {
    st.result = r;
    ['#pgo', '#psave', '#pshare'].forEach(id => { $(id).disabled = !r; });
    map.setRoute(r ? r.points.map(p => [p.la, p.lo]) : null);
    $('#pelev').hidden = true;
    if (!r) return;
    profile(r.points).then(p => {
      if (st.result !== r || !p) return;
      $('#psum').insertAdjacentHTML('beforeend', `<div class="small">⛰ <b>↑ ${p.climb} m</b> · <b>↓ ${p.descent} m</b> · steepest ${p.steepest}%</div>`);
      $('#pelev').hidden = false; elevChart($('#pelev'), p);
    }).catch(e => console.warn('Elevation unavailable', e));
    $('#psum').innerHTML = `${ROUTE_MODES[st.mode].icon} <b>${fmtKm(r.distance)}</b> · about <b>${fmtMin(r.duration)}</b>${st.stops.length > 1 ? ` · ${st.stops.length - 1} stop${st.stops.length > 2 ? 's' : ''} on the way` : ''}`;
  }

  function changed(fit = false) {
    draw();
    clearTimeout(timer);
    const o = origin();
    if (!o || !st.stops.length) {
      setResult(null);
      $('#psum').innerHTML = !st.stops.length ? '<span class="muted">Add where you want to go.</span>' : '';
      return;
    }
    $('#psum').innerHTML = '<span class="muted">Working out the route…</span>';
    timer = setTimeout(async () => {
      const n = ++reqNo;
      try {
        const r = await routeThrough([o, ...st.stops], st.mode, modeKmh());
        if (n !== reqNo) return;
        setResult(r);
        if (fit) map.fit(r.points.map(p => [p.la, p.lo]));
      } catch (e) {
        if (n !== reqNo) return;
        setResult(null);
        $('#psum').innerHTML = `<span class="bad">Couldn't get a route right now (${esc(e.message)}). Check your connection and try again${st.mode !== 'line' ? ', or pick 📏 Straight' : ''}.</span>`;
      }
    }, 350);
  }

  $('#pmode').querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    st.mode = b.dataset.mode;
    $('#pmode').querySelectorAll('.mode-btn').forEach(x => x.classList.toggle('on', x === b));
    changed();
  });
  map.onClick(([la, lo]) => {
    const p = { la, lo };
    if (!st.fromMe && !st.start) st.start = { ...p, name: 'Pinned start' };
    else st.stops.push({ ...p, name: `Pin ${st.stops.length + 1}` });
    changed();
  });
  $('#fromMe').onchange = e => { st.fromMe = e.target.checked; if (!st.fromMe && !st.start && st.me) st.start = { ...st.me, name: 'Pinned start' }; changed(); };

  // place search: suggestions as you type, recent places when the box is empty, full search on Search
  const box = $('#sr'), sq = $('#sq');
  const near = () => st.me ? [st.me.la, st.me.lo] : map.center();
  const recents = () => (store.settings().recentPlaces || []);
  let sugT = null, sugCtl = null, shown = [];
  function showList(list, note = '') {
    shown = list;
    box.hidden = !list.length && !note;
    box.innerHTML = list.map((r, k) => `<li><button type="button" class="result" data-k="${k}"><b>${r.recent ? '🕘 ' : ''}${esc(r.name)}</b>${r.detail || r.km != null ? `<small>${r.km != null ? `${r.km < 1 ? Math.round(r.km * 1000) + ' m' : r.km < 100 ? r.km.toFixed(1) + ' km' : Math.round(r.km) + ' km'} away${r.detail ? ' · ' : ''}` : ''}${esc(r.detail || '')}</small>` : ''}</button></li>`).join('') + (note ? `<li class="muted">${note}</li>` : '');
    box.querySelectorAll('[data-k]').forEach(b => b.onclick = () => pick(shown[+b.dataset.k]));
  }
  function pick(r) {
    st.stops.push({ la: r.la, lo: r.lo, name: r.name });
    const keep = recents().filter(x => !(x.name === r.name && Math.abs(x.la - r.la) < 1e-4));
    store.saveSettings({ ...store.settings(), recentPlaces: [{ name: r.name, detail: r.detail || '', la: r.la, lo: r.lo }, ...keep].slice(0, 8) });
    box.hidden = true; sq.value = ''; sq.blur();
    map.setView([r.la, r.lo], Math.max(map.zoom(), 14));
    changed(true);
  }
  const recentMatches = q => recents().map(r => ({ ...r, recent: true, sc: fuzzyScore(q, r.name) })).filter(r => r.sc < Infinity).sort((a, b) => a.sc - b.sc).slice(0, 3);
  const withKm = list => list.map(r => r.km != null ? r : { ...r, km: hav(near()[0], near()[1], r.la, r.lo) / 1000 });
  const merge = (a, b) => dedupe([...a, ...b]);
  sq.addEventListener('focus', () => { if (!sq.value.trim() && recents().length) showList(withKm(recents().map(r => ({ ...r, recent: true })))); });
  sq.addEventListener('input', () => {
    clearTimeout(sugT); if (sugCtl) sugCtl.abort();
    const q = sq.value.trim();
    if (!q) { showList(withKm(recents().map(r => ({ ...r, recent: true })))); return; }
    const mine = recentMatches(q);
    if (q.length < 3) { showList(withKm(mine)); return; }
    showList(withKm(mine), 'Looking…');
    sugT = setTimeout(async () => {
      sugCtl = new AbortController();
      try {
        const list = await suggestPlaces(q, near(), sugCtl.signal);
        if (sq.value.trim() !== q) return;
        const all = withKm(merge(mine, list)).sort((x, y) => (x.km > 60) - (y.km > 60));
        showList(all, all.length ? '' : 'No matches yet. Keep typing, or tap Search.');
      } catch (err) { if (err.name !== 'AbortError' && sq.value.trim() === q) showList(mine, 'Suggestions aren’t available right now. Tap Search.'); }
    }, 300);
  });
  $('#sf').onsubmit = async e => {
    e.preventDefault();
    clearTimeout(sugT); if (sugCtl) sugCtl.abort();
    const q = sq.value.trim();
    if (!q) return;
    showList([], 'Searching…');
    // both services: Photon copes with spelling slips, Nominatim knows some names Photon doesn't
    const [a, b] = await Promise.allSettled([suggestPlaces(q, near()), searchPlaces(q, near())]);
    if (sq.value.trim() !== q) return;
    const list = merge(merge(recentMatches(q), a.status === 'fulfilled' ? a.value : []), b.status === 'fulfilled' ? b.value : []);
    if (list.length) showList(withKm(list).sort((x, y) => (x.km > 60) - (y.km > 60)).slice(0, 8));
    else if (a.status === 'rejected' && b.status === 'rejected') showList([], `Search isn't working right now (${esc(b.reason.message)}). You can still tap the map.`);
    else showList([], `Nothing called “${esc(q)}” nearby. OpenStreetMap may not list it: try its street or a landmark next to it, or tap the map.`);
  };

  const guide = () => ({
    name: routeName(), from: '', points: st.result.points, steps: st.result.steps,
    distance: st.result.distance, duration: st.result.duration, mode: st.mode,
    plan: { fromMe: st.fromMe, start: st.fromMe ? null : st.start, stops: st.stops, stopsAt: st.result.stopsAt, mode: st.mode },
  });
  $('#pgo').onclick = () => { lastReroute = 0; followGuide(guide()); };
  $('#psave').onclick = async () => {
    const g = guide();
    const id = saved ? saved.id : 'r' + Date.now().toString(36);
    await store.putDrive({ id, status: 'route', name: g.name, from: '', startedAt: saved ? saved.startedAt : Date.now(), points: g.points, steps: g.steps, plan: g.plan, mode: g.mode, distance: g.distance, duration: g.duration });
    toast(saved ? 'Route saved.' : 'Saved. It’s on your home screen under My routes.');
    location.hash = '#/route/' + encodeURIComponent(id);
  };
  $('#pshare').onclick = async () => {
    const g = guide();
    const payload = await packRoute(g.points, { name: g.name, from: store.settings().name, trim: false, mode: g.mode });
    const r = await shareLink(shareUrl('r', payload), 'Route: ' + g.name, `A route: ${g.name} (${fmtKm(g.distance)})`);
    if (r === 'copied') toast('Route link copied. Your friend gets a map and directions.');
  };

  // where you are now, as the start
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(pos => {
    st.me = { la: pos.coords.latitude, lo: pos.coords.longitude };
    if (!document.body.contains(el)) return;
    map.setMe([st.me.la, st.me.lo]);
    if (!st.stops.length) map.setView([st.me.la, st.me.lo], 14);
    changed(!saved);
  }, () => {
    if (st.fromMe) {
      st.fromMe = false; $('#fromMe').checked = false;
      if (saved && !st.start) st.start = { la: saved.points[0].la, lo: saved.points[0].lo, name: 'Route start' };
      $('#phint').textContent = "Couldn't get your location, so tap the map to set a start first, then your stops.";
    }
    changed();
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  if (saved) {
    const all = [...(st.start ? [st.start] : []), ...st.stops].map(x => [x.la, x.lo]);
    if (saved.points && saved.points.length) map.fit(saved.points.map(p => [p.la, p.lo]));
    else if (all.length) map.fit(all);
  }
  changed(!saved);
  cleanup = () => { clearTimeout(timer); map.remove(); };
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
      <label>Map style
        <select id="sstyle">${[['auto', 'Day and night (dark after 6 PM)'], ['light', 'Always light'], ['dark', 'Always dark']].map(([v, t]) => `<option value="${v}" ${v === (s.mapStyle || 'auto') ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </label>
      <label>Hills and terrain
        <select id="sterrain">${[['auto', '3D hills in the planner, shading and contours elsewhere'], ['on', '3D hills everywhere (replays may stutter)'], ['flat', 'Shading and contours only'], ['off', 'Off']].map(([v, t]) => `<option value="${v}" ${v === (s.terrain || 'auto') ? 'selected' : ''}>${t}</option>`).join('')}</select>
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
        <input type="file" id="restoreFile" hidden>
      </div>
      <p class="muted small" id="backupInfo"></p>
      <p class="muted small">Restore takes a backup file, or a single drive exported as GPX or CSV (from this app or another GPS logger).</p>
      <button class="btn danger" id="wipe">Delete all my drives</button>
    </section>
    <p class="muted small">Version: ${APP_VERSION}. If this looks older than expected, close the app fully and open it again.</p>
    <p class="muted small">Maps by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> and OpenMapTiles. Map and road data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>. Directions by OSRM, place search by Nominatim.</p>`;
  const persist = () => store.saveSettings({ ...store.settings(), name: $('#sname').value.trim(), trimShare: $('#strim').checked, autoStopMin: +$('#sauto').value, mapStyle: $('#sstyle').value, terrain: $('#sterrain').value });
  ['#sname', '#strim', '#sauto', '#sstyle', '#sterrain'].forEach(sel => $(sel).addEventListener('change', () => { persist(); toast('Saved.'); }));
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
if (webglOk()) loadStyle(); // fetch the map style early so maps open straight away
route();

// Leaflet finishes a zoom animation on a timer; removing the map before it fires throws.
// So stop it now and remove it once any animation has had time to end.
function dropMap(map) {
  try { map.stop(); } catch {}
  setTimeout(() => { try { map.off(); map.remove(); } catch {} }, 600);
}
