// Records a drive: GPS fixes, motion sensor peaks between fixes, screen wake lock, auto-stop.
import * as store from './store.js';
import { hav } from './analysis.js';
import { GuideTracker } from './guide.js';

const MAX_ACCURACY_M = 50;
const FLUSH_EVERY = 10;

export class Recorder extends EventTarget {
  constructor() {
    super();
    this.active = false;
    this.reset();
  }

  reset() {
    this.id = null; this.seq = 0; this.buf = []; this.count = 0;
    this.distance = 0; this.last = null; this.startedAt = null;
    this.speedKmh = 0; this.accuracy = null; this.motionPeak = null; this.motionOk = false;
    this.stillSince = null; this.hasMoved = false; this.wakeLock = null; this.error = null;
    this.track = []; this.tracker = null; this.guide = null; this.guideState = null; this.lastFixAt = null;
  }

  // Must be called straight from a tap: iPhone only shows the motion permission prompt then.
  async start(resumeId, guide = null) {
    if (this.active) return this.id;
    const motionPerm = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function'
      ? DeviceMotionEvent.requestPermission().catch(() => 'denied') : Promise.resolve('granted');
    this.reset();
    this.active = true;
    if (guide && !resumeId) { this.guide = guide; this.tracker = new GuideTracker(guide); }
    const s = store.settings();
    this.autoStopMs = (s.autoStopMin || 5) * 60000;
    if (resumeId) {
      const d = await store.getDrive(resumeId);
      const pts = await store.chunkPoints(resumeId);
      this.id = resumeId; this.startedAt = d.startedAt;
      this.seq = (pts.length ? Math.ceil(pts.length / FLUSH_EVERY) : 0) + 1000; // never collide with earlier chunks
      this.count = pts.length;
      for (let i = 1; i < pts.length; i++) this.distance += hav(pts[i - 1].la, pts[i - 1].lo, pts[i].la, pts[i].lo);
      this.last = pts[pts.length - 1] || null;
      this.track = pts.map(p => [p.la, p.lo]);
      this.hasMoved = true;
      if (d.guide) { this.guide = d.guide; this.tracker = new GuideTracker(d.guide, { anywhere: true }); }
    } else {
      this.id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this.startedAt = Date.now();
      await store.putDrive({ id: this.id, status: 'recording', startedAt: this.startedAt, name: '', guide: guide || undefined });
    }
    if ((await motionPerm) === 'granted') {
      this.onMotion = e => {
        const a = e.acceleration;
        if (!a || a.x == null) return;
        const mag = Math.hypot(a.x, a.y, a.z);
        this.motionOk = true;
        if (this.motionPeak == null || mag > this.motionPeak) this.motionPeak = mag;
      };
      window.addEventListener('devicemotion', this.onMotion);
    }
    await this.lockScreen();
    this.onVis = () => { if (document.visibilityState === 'visible' && this.active) this.lockScreen(); };
    document.addEventListener('visibilitychange', this.onVis);
    if (!('geolocation' in navigator)) { this.error = 'This browser has no GPS access.'; this.emit(); return this.id; }
    this.watch = navigator.geolocation.watchPosition(p => this.onPos(p), err => {
      this.error = err.code === 1 ? 'Location permission was refused. Allow location for this site in your browser settings.' : 'Waiting for GPS…';
      this.emit();
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    this.emit();
    return this.id;
  }

  // A new route while driving (after leaving the planned one): keep recording, follow the new line.
  async setGuide(guide) {
    this.guide = guide;
    this.tracker = new GuideTracker(guide, { anywhere: true });
    this.guideState = null;
    try { const d = await store.getDrive(this.id); if (d) await store.putDrive({ ...d, guide }); } catch {}
    this.emit();
  }

  async lockScreen() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; this.emit(); });
      }
    } catch { this.wakeLock = null; }
    this.emit();
  }

  onPos(pos) {
    const c = pos.coords;
    this.accuracy = c.accuracy;
    this.error = null;
    if (c.accuracy > MAX_ACCURACY_M) { this.emit(); return; }
    const t = pos.timestamp || Date.now();
    if (this.last && t <= this.last.t) return;
    const p = { t, la: +c.latitude.toFixed(6), lo: +c.longitude.toFixed(6), ac: Math.round(c.accuracy), s: c.speed != null && !isNaN(c.speed) ? +c.speed.toFixed(2) : null, m: this.motionPeak != null ? +this.motionPeak.toFixed(2) : null };
    this.motionPeak = null;
    let kmh = p.s != null ? p.s * 3.6 : 0;
    if (this.last) {
      const d = hav(this.last.la, this.last.lo, p.la, p.lo);
      if (t - this.last.t < 15000) this.distance += d;
      if (p.s == null) kmh = d / ((t - this.last.t) / 1000) * 3.6;
    }
    this.speedKmh = kmh;
    this.last = p;
    this.lastFixAt = Date.now();
    this.gpsHeading = c.heading != null && !isNaN(c.heading) && kmh > 5 ? c.heading : null;
    this.track.push([p.la, p.lo]);
    if (this.tracker) this.guideState = this.tracker.update(p);
    this.buf.push(p);
    this.count++;
    if (this.buf.length >= FLUSH_EVERY) this.flush();
    // auto-stop once parked for a while after having driven
    if (kmh > 10) this.hasMoved = true;
    if (kmh < 3) { if (this.stillSince == null) this.stillSince = t; }
    else this.stillSince = null;
    this.emit();
    if (this.hasMoved && this.stillSince != null && t - this.stillSince >= this.autoStopMs) {
      this.dispatchEvent(new CustomEvent('autostop'));
    }
  }

  flush() {
    if (!this.buf.length) return Promise.resolve();
    const pts = this.buf; this.buf = [];
    return store.putChunk(this.id, this.seq++, pts);
  }

  async stop() {
    if (!this.active) return null;
    this.active = false;
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    if (this.onMotion) window.removeEventListener('devicemotion', this.onMotion);
    document.removeEventListener('visibilitychange', this.onVis);
    try { await this.wakeLock?.release(); } catch {}
    await this.flush();
    const id = this.id;
    await finishDrive(id);
    this.reset();
    this.emit();
    return id;
  }

  emit() { this.dispatchEvent(new Event('update')); }
}

// Gathers the saved chunks into the drive record. Also used to rescue a drive interrupted by a closed page.
export async function finishDrive(id) {
  const d = await store.getDrive(id);
  if (!d) return;
  const pts = await store.chunkPoints(id);
  pts.sort((a, b) => a.t - b.t);
  // trim time spent parked at the very end (auto-stop waits a few minutes)
  let end = pts.length - 1;
  while (end > 1 && (pts[end].s ?? 0) < 0.8 && hav(pts[end].la, pts[end].lo, pts[end - 1].la, pts[end - 1].lo) < 3) end--;
  const points = pts.slice(0, end + 1);
  Object.assign(d, { status: 'done', points, endedAt: points.length ? points[points.length - 1].t : d.startedAt });
  await store.putDrive(d);
  await store.clearChunks(id);
  return d;
}
