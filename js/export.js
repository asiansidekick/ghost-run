// GPX and CSV export of a drive.
const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function gpx(drive, A) {
  const name = drive.name || 'Ghost Run drive';
  const seg = [];
  let cur = [];
  A.pts.forEach((p, i) => {
    if (p.gapBefore && cur.length) { seg.push(cur); cur = []; }
    const raw = drive.points[i];
    cur.push(`      <trkpt lat="${p.la}" lon="${p.lo}"><time>${new Date(p.t).toISOString()}</time><extensions><speed>${(p.v / 3.6).toFixed(2)}</speed></extensions>${raw.ac != null ? `<hdop>${(raw.ac / 5).toFixed(1)}</hdop>` : ''}</trkpt>`);
  });
  if (cur.length) seg.push(cur);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Ghost Run" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${new Date(A.summary.start).toISOString()}</time></metadata>
  <trk><name>${esc(name)}</name>
${seg.map(s => `    <trkseg>\n${s.join('\n')}\n    </trkseg>`).join('\n')}
  </trk>
</gpx>
`;
}

export function csv(drive, A) {
  const rows = ['time_iso,lat,lon,speed_kmh,speed_limit_kmh,limit_source,over_limit,accel_g,motion_peak_g,gps_accuracy_m'];
  A.pts.forEach((p, i) => {
    const raw = drive.points[i];
    rows.push([
      new Date(p.t).toISOString(), p.la, p.lo, p.v.toFixed(1), p.limit ?? '',
      p.limitSrc === 'o' ? 'openstreetmap' : p.limitSrc === 'd' ? 'thai_default' : '',
      p.over ? 1 : 0, p.a.toFixed(3), p.m != null ? p.m.toFixed(3) : '', raw.ac ?? '',
    ].join(','));
  });
  return rows.join('\n') + '\n';
}

export async function saveFile(text, filename, type) {
  const file = new File([text], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
