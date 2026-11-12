/* SPHEREx Time Machine — static viewer + optional live builder (server/app.py).
   Prepared targets: data/targets.json + data/<id>/manifest.json (pipeline/build.py).
   Any other place: POST <API>/api/fields → poll → <API>/data/<id>/manifest.json. */
'use strict';

const $ = id => document.getElementById(id);
const DATA = 'data/';
const API = (window.TM_API || (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? `http://${location.hostname}:7860` : '')).replace(/\/$/, '');
const ALADIN_URL = 'https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js';
const SESAME = ['https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/S?', 'https://vizier.idia.ac.za/viz-bin/nph-sesame/-oxp/S?'];
const MAPS = [
  { key: '2mass', name: '2MASS infrared (NASA/IRSA)', url: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color', fmt: 'jpeg', order: 9 },
  { key: 'spherex-dr1', name: 'SPHEREx DR1 ≈1.35 µm (NASA/IRSA)', url: 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube', fmt: 'png', order: 5, slice: 25 },
  { key: 'allwise', name: 'AllWISE mid-infrared (NASA/IRSA)', url: 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1', fmt: 'jpeg', order: 8 },
];
const DET = { 1: ['0.75–1.1', 'near-IR'], 2: ['1.1–1.6', 'near-IR'], 3: ['1.6–2.4', 'near-IR'], 4: ['2.4–3.8', 'mid-IR'], 5: ['3.8–4.4', 'mid-IR'], 6: ['4.4–5.0', 'mid-IR'] };
const KIND = {
  star: ['Moving star', 'moves'], variable: ['Variable star', 'changes brightness'], comet: ['Interstellar comet', 'moves within hours'],
  field: ['Sky field', 'look for anything that moves or changes'],
  object: ['Named object', 'stays put — watch its brightness'],
};
const SURVEY_COL = { SPHEREx: '#4fc3f7', '2MASS': '#c792ea', WISE: '#6fdc8c' };
const SPX_PIX = 6.15;

const S = {
  index: [], entry: null, target: null, base: '', det: null, span: 'all', frames: [], i: 0, a: 0, b: 1,
  mode: 'play', playing: false, timer: null, swipe: 0.5, blinkB: false,
  zoom: 1, cx: 0, cy: 0, cmap: 'gray', bright: 0, contrast: 1, sharp: false, futureYear: 2050,
  show: { label: true, pred: true, meas: true, track: true, flags: false },
  aladin: null, map: '2mass', pick: null, polling: null,
};
const grayCache = new Map(), tintCache = new Map(), flagImgs = new Map();

/* ---------------- small helpers ---------------- */
const fmtUTC = s => s ? `${s.slice(0, 10)} ${s.slice(11, 16)} UTC` : '—';
const years = (a, b) => (b - a) / 365.25;
const mjdToYear = m => 2000 + (m - 51544.5) / 365.25;
const yearToMjd = y => (y - 2000) * 365.25 + 51544.5;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function status(msg) { $('status').textContent = msg || ''; }
let flashT = null;
function flash(msg, el = $('status')) { el.textContent = msg; clearTimeout(flashT); flashT = setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3500); }
function sexa(v, hours) {
  let x = hours ? ((v % 360) + 360) % 360 / 15 : Math.abs(v);
  const sign = hours ? '' : (v < 0 ? '−' : '+'); const h = Math.floor(x); x = (x - h) * 60; const m = Math.floor(x); const s = (x - m) * 60;
  const p = n => String(n).padStart(2, '0');
  return `${sign}${p(h)}${hours ? 'h' : '°'}${p(m)}${hours ? 'm' : '′'}${s.toFixed(hours ? 1 : 0).padStart(hours ? 4 : 2, '0')}${hours ? 's' : '″'}`;
}
function sepArcsec(ra1, de1, ra2, de2) {
  const r = Math.PI / 180, c = Math.sin(de1 * r) * Math.sin(de2 * r) + Math.cos(de1 * r) * Math.cos(de2 * r) * Math.cos((ra1 - ra2) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) / r * 3600;
}
const compassWord = pa => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(pa / 45) % 8];
const fmtArc = as => as >= 90 ? `${(as / 60).toFixed(1)}′` : `${as.toFixed(as < 10 ? 1 : 0)}″`;
const frameLabel = f => f.survey === 'SPHEREx' ? `SPHEREx D${f.detector}` : `${f.survey} ${f.band}`;

/** "269.45 4.69", "269.45, -7.2", "08h55m10.8s -07d14m42s", "17 57 48.5 +04 41 36" → [ra, dec] or null. */
function parseCoords(text) {
  const t = text.replace(/[−–]/g, '-').trim();
  if (!/^[\d\s.,:+\-hdms°'′"″]+$/i.test(t)) return null;
  const parts = t.replace(/[hdm:°'′"″s,]/gi, ' ').trim().split(/\s+/);
  if (parts.some(p => !/^[+-]?\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number); let ra, dec;
  if (parts.length === 2) { [ra, dec] = n; if (/h/i.test(t)) ra *= 15; }
  else if (parts.length === 6) { ra = (n[0] + n[1] / 60 + n[2] / 3600) * 15; dec = (Math.abs(n[3]) + n[4] / 60 + n[5] / 3600) * (parts[3].startsWith('-') ? -1 : 1); }
  else return null;
  return ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 ? [ra, dec] : null;
}
function positionAt(ast, year) {
  const dy = year - ast.epoch;
  return [ast.ra + ast.pmra / 3.6e6 * dy / Math.cos(ast.dec * Math.PI / 180), ast.dec + ast.pmdec / 3.6e6 * dy];
}

/* ---------------- grid projection (TAN, north up, east left) ---------------- */
const N = () => S.target ? S.target.grid.size_px : 256;
function imgToWorld(u, v) {
  const g = S.target.grid, n = g.size_px, cd = g.fov_deg / n, r = Math.PI / 180;
  const xi = -(u - n / 2) * cd * r, eta = -(v - n / 2) * cd * r, a0 = g.center[0] * r, d0 = g.center[1] * r;
  const den = Math.cos(d0) - eta * Math.sin(d0);
  return [(((a0 + Math.atan2(xi, den)) / r) % 360 + 360) % 360, Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) / r];
}
function worldToImg(ra, dec) {
  const g = S.target.grid, n = g.size_px, cd = g.fov_deg / n, r = Math.PI / 180;
  const a = ra * r, d = dec * r, a0 = g.center[0] * r, d0 = g.center[1] * r;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  const xi = Math.cos(d) * Math.sin(a - a0) / cosc, eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc;
  return [n / 2 - xi / r / cd, n / 2 - eta / r / cd];
}

/* ---------------- images, colour maps, brightness/contrast ---------------- */
function lut() {
  const out = new Uint8ClampedArray(768), { cmap, bright, contrast } = S;
  for (let v = 0; v < 256; v++) {
    let t = Math.min(1, Math.max(0, (v / 255 - 0.5) * contrast + 0.5 + bright));
    let r, g, b;
    if (cmap === 'invert') r = g = b = 255 * (1 - t);
    else if (cmap === 'heat') { r = 255 * Math.min(1, t * 2.2); g = 255 * Math.min(1, Math.max(0, t * 2.2 - 0.8)); b = 255 * Math.max(0, t * 3 - 2); }
    else if (cmap === 'ice') { r = 255 * Math.max(0, t * 2 - 1); g = 255 * Math.min(1, t * 1.4); b = 255 * Math.min(1, 0.15 + t * 1.6); }
    else r = g = b = 255 * t;
    out[v * 3] = r; out[v * 3 + 1] = g; out[v * 3 + 2] = b;
  }
  return out;
}
const lutKey = () => `${S.cmap}|${S.bright}|${S.contrast}`;
// Images of an unfinished build use a provisional brightness scale; they are re-saved when it completes.
const frameUrl = f => S.base + f.image + (S.target && S.target.complete === false ? '?v=partial' : S.target && S.target.revision ? '?v=final' : '');
function loadGray(url) {
  if (!grayCache.has(url)) grayCache.set(url, new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data, gray = new Uint8Array(c.width * c.height);
      for (let i = 0; i < gray.length; i++) gray[i] = d[i * 4];
      resolve({ gray, w: c.width, h: c.height });
    };
    img.onerror = () => { grayCache.delete(url); reject(new Error('image failed')); };
    img.src = url;
  }));
  return grayCache.get(url);
}
async function tinted(f) {
  const key = frameUrl(f) + '|' + lutKey();
  if (tintCache.has(key)) return tintCache.get(key);
  const g = await loadGray(frameUrl(f)), L = lut();
  const c = document.createElement('canvas'); c.width = g.w; c.height = g.h;
  const x = c.getContext('2d'), im = x.createImageData(g.w, g.h);
  for (let i = 0; i < g.gray.length; i++) { const v = g.gray[i] * 3; im.data[i * 4] = L[v]; im.data[i * 4 + 1] = L[v + 1]; im.data[i * 4 + 2] = L[v + 2]; im.data[i * 4 + 3] = 255; }
  x.putImageData(im, 0, 0);
  if (tintCache.size > 300) tintCache.clear();
  tintCache.set(key, c); return c;
}
async function diffCanvas(fa, fb) {
  const key = 'diff|' + frameUrl(fa) + '|' + frameUrl(fb) + '|' + S.contrast;
  if (tintCache.has(key)) return tintCache.get(key);
  const [A, B] = await Promise.all([loadGray(frameUrl(fa)), loadGray(frameUrl(fb))]);
  const c = document.createElement('canvas'); c.width = A.w; c.height = A.h;
  const x = c.getContext('2d'), im = x.createImageData(A.w, A.h);
  for (let i = 0; i < A.gray.length; i++) {
    const d = (B.gray[i] - A.gray[i]) / 110 * S.contrast, t = Math.min(1, Math.abs(d)), col = d > 0 ? [255, 180, 84] : [79, 195, 247];
    im.data[i * 4] = col[0] * t; im.data[i * 4 + 1] = col[1] * t; im.data[i * 4 + 2] = col[2] * t; im.data[i * 4 + 3] = 255;
  }
  x.putImageData(im, 0, 0); tintCache.set(key, c); return c;
}
function flagImage(f) {
  if (!f.flags) return null;
  const url = S.base + f.flags;
  if (!flagImgs.has(url)) { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = draw; im.src = url; flagImgs.set(url, im); }
  const im = flagImgs.get(url); return im.complete && im.naturalWidth ? im : null;
}

/* ---------------- canvas ---------------- */
const canvas = $('canvas'), ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resizeCanvas() {
  const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1);
  W = r.width; H = r.height; canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  draw(); drawTimeline();
}
const scale = () => Math.min(W, H) / N() * S.zoom;
const toScreen = (u, v) => [(u - S.cx) * scale() + W / 2, (v - S.cy) * scale() + H / 2];
const toImage = (x, y) => [(x - W / 2) / scale() + S.cx, (y - H / 2) / scale() + S.cy];
const fracToImg = xy => [xy[0] * N(), xy[1] * N()];
const hasMotion = () => S.target && S.target.kind === 'star' && S.target.astrometry && Math.hypot(S.target.astrometry.pmra, S.target.astrometry.pmdec) > 50;

let drawToken = 0;
async function draw() {
  if (!S.target || !S.frames.length || !W) return;
  const token = ++drawToken, fa = S.frames[S.a], fb = S.frames[S.b], cur = S.frames[S.i];
  let base, over = null;
  try {
    if (S.mode === 'diff') base = await diffCanvas(fa, fb);
    else if (S.mode === 'swipe') [base, over] = await Promise.all([tinted(fa), tinted(fb)]);
    else if (S.mode === 'blink') base = await tinted(S.blinkB ? fb : fa);
    else base = await tinted(cur);
  } catch { status('This image could not be loaded. Try another date.'); return; }
  if (token !== drawToken) return;
  if ($('buildPanel').hidden) status('');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.fillStyle = '#05080b'; ctx.fillRect(0, 0, W, H);
  const [x0, y0] = toScreen(0, 0), sz = N() * scale();
  ctx.imageSmoothingEnabled = !S.sharp; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, x0, y0, sz, sz);
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.strokeRect(x0, y0, sz, sz);
  if (over) {
    const sx = W * S.swipe;
    ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); ctx.drawImage(over, x0, y0, sz, sz); ctx.restore();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, H / 2, 12, 0, 7); ctx.fill();
    ctx.fillStyle = '#05080b'; ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⇔', sx, H / 2 + 1);
    tag(sx - 8, 14, 'A ' + fa.utc.slice(0, 10), '#4fc3f7', 'right'); tag(sx + 8, 14, 'B ' + fb.utc.slice(0, 10), '#ffb454', 'left');
  }
  if (S.show.flags && S.mode !== 'diff') {
    const fl = flagImage(S.mode === 'play' ? cur : (S.mode === 'blink' && S.blinkB ? fb : fa));
    if (fl) { ctx.globalAlpha = .85; ctx.imageSmoothingEnabled = false; ctx.drawImage(fl, x0, y0, sz, sz); ctx.globalAlpha = 1; }
  }
  drawOverlays(); updateHud();
}
function tag(x, y, text, color, align) {
  ctx.font = '600 12px system-ui,sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'top';
  const w = ctx.measureText(text).width, bx = align === 'right' ? x - w - 6 : align === 'center' ? x - w / 2 - 6 : x - 6;
  ctx.fillStyle = 'rgba(5,8,11,.72)'; ctx.fillRect(bx, y - 3, w + 12, 19);
  ctx.fillStyle = color; ctx.fillText(text, align === 'right' ? x - 0 : x, y);
}
function ring(u, v, r, color, dash) {
  const [x, y] = toScreen(u, v); ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke(); ctx.setLineDash([]); return [x, y];
}
function cross(u, v, color) {
  const [x, y] = toScreen(u, v), r = 7; ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.beginPath();
  ctx.moveTo(x - r, y); ctx.lineTo(x - 2, y); ctx.moveTo(x + 2, y); ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r); ctx.lineTo(x, y - 2); ctx.moveTo(x, y + 2); ctx.lineTo(x, y + r); ctx.stroke();
}
function drawOverlays() {
  const t = S.target; if (t.kind === 'field') return;
  const rr = Math.max(10, 1.4 * SPX_PIX / t.grid.pixel_arcsec * scale());
  // path: year by year from the star's catalogue motion (or the comet's predicted positions)
  if (S.show.track) {
    let pts;
    if (hasMotion()) {
      const y0 = Math.min(mjdToYear(S.frames[0].mjd), 2025) - 1, y1 = Math.max(2027, S.futureYear);
      pts = []; for (let y = y0; y <= y1 + 1e-6; y += Math.max(0.25, (y1 - y0) / 200)) pts.push(worldToImg(...positionAt(t.astrometry, y)));
    } else pts = S.frames.map(f => fracToImg(f.predicted.xy));
    if (pts.length > 1) {
      ctx.strokeStyle = '#c792ea'; ctx.lineWidth = 1.4; ctx.globalAlpha = .75; ctx.setLineDash([5, 4]); ctx.beginPath();
      pts.forEach((p, k) => { const [x, y] = toScreen(...p); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (hasMotion()) for (let y = Math.ceil(mjdToYear(S.frames[0].mjd) / 5) * 5; y <= S.futureYear; y += 5) {
        const [x, yy] = toScreen(...worldToImg(...positionAt(t.astrometry, y)));
        ctx.fillStyle = '#c792ea'; ctx.beginPath(); ctx.arc(x, yy, 2.5, 0, 7); ctx.fill();
        if (scale() > 1.2 && y % 10 === 0) { ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(y, x + 6, yy); }
      }
    }
  }
  if (hasMotion() && S.futureYear > 2026.9) {
    const [u, v] = worldToImg(...positionAt(t.astrometry, S.futureYear));
    const [x, y] = ring(u, v, rr, '#c792ea', [3, 3]);
    if (x > 0 && y > 0 && x < W && y < H) tag(x + rr + 4, y - 8, `${S.futureYear} (predicted)`, '#c792ea', 'left');
  }
  const shown = S.mode === 'play' ? [[S.frames[S.i], '#ffb454', '']] : S.mode === 'blink' ? [[S.blinkB ? S.frames[S.b] : S.frames[S.a], S.blinkB ? '#ffb454' : '#4fc3f7', S.blinkB ? 'B ' : 'A ']]
    : [[S.frames[S.a], '#4fc3f7', 'A '], [S.frames[S.b], '#ffb454', 'B ']];
  for (const [f, col, pre] of shown) {
    const [u, v] = fracToImg(f.predicted.xy);
    if (S.show.pred) ring(u, v, rr, col, S.mode === 'play' ? null : [4, 3]);
    if (S.show.meas && f.measured) cross(...fracToImg(f.measured.xy), '#6fdc8c');
    if (S.show.label) { const [x, y] = toScreen(u, v); tag(x, y + rr + 4, `${pre}${t.name.replace(/ \(.*\)$/, '')} · ${f.utc.slice(0, t.kind === 'comet' ? 16 : 4).replace('T', ' ')}`, col, 'center'); }
  }
}
function updateHud() {
  const f = S.frames[S.i], fa = S.frames[S.a], fb = S.frames[S.b];
  const lam = fr => `${fr.wavelength_um.mean.toFixed(2)} µm`;
  if (S.mode === 'play') {
    $('hudFrame').innerHTML = `<b style="color:${SURVEY_COL[f.survey]}">${frameLabel(f)}</b> · ${lam(f)}<br>${fmtUTC(f.utc)}${f.n_images > 1 ? ` · ${f.n_images} images stacked` : ''}`;
    $('hudMode').textContent = `${S.playing ? '▶ ' : ''}${S.i + 1} / ${S.frames.length}`;
  } else {
    const dt = years(fa.mjd, fb.mjd);
    $('hudFrame').innerHTML = `<span class="a">A</span> ${frameLabel(fa)} · ${fmtUTC(fa.utc)}<br><span class="b">B</span> ${frameLabel(fb)} · ${fmtUTC(fb.utc)}<br>${dt >= 0.1 ? dt.toFixed(1) + ' years apart' : (dt * 365.25 * 24).toFixed(1) + ' hours apart'}`;
    $('hudMode').innerHTML = S.mode === 'diff' ? 'DIFFERENCE<br><span class="a">■ brighter in A</span> <span class="b">■ brighter in B</span>' : S.mode === 'swipe' ? 'SWIPE A | B' : `BLINK ${S.blinkB ? '<span class="b">B</span>' : '<span class="a">A</span>'}`;
  }
  const pxPerArc = scale() / S.target.grid.pixel_arcsec;
  const nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200].find(a => a * pxPerArc >= 70) || 1200;
  $('scaleBar').querySelector('i').style.width = `${nice * pxPerArc}px`;
  $('scaleBar').querySelector('span').textContent = nice >= 60 ? `${nice / 60}′` : `${nice}″`;
}

/* ---------------- target list ---------------- */
function recent() { try { return JSON.parse(localStorage.getItem('tm_recent') || '[]'); } catch { return []; } }
function remember(e) {
  try { const r = recent().filter(x => x.id !== e.id); r.unshift({ id: e.id, name: e.name, manifest: e.manifest, api: true }); localStorage.setItem('tm_recent', JSON.stringify(r.slice(0, 8))); } catch { /* storage off */ }
}
function renderTargets() {
  const groups = new Map();
  for (const t of S.index) { const g = t.group || 'Targets'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
  const rec = recent(); if (rec.length) groups.set('Your searches', rec);
  const html = [...groups].map(([g, list]) => `<h2 class="panel-title">${esc(g)}</h2><ul class="target-list">${list.map(t => `
    <li><button data-id="${esc(t.id)}" ${t.api ? 'data-api="1"' : ''}>
      ${t.thumbnail ? `<img src="${DATA + esc(t.thumbnail)}" alt="" loading="lazy">` : '<span class="noimg">◎</span>'}
      <span><span class="t-name">${esc(t.name)}</span><span class="t-meta">${t.kind ? esc((KIND[t.kind] || ['', ''])[1]) : 'built on request'}${t.first_utc ? ` · ${t.first_utc.slice(0, 4)}–${t.last_utc.slice(0, 4)}` : ''}</span></span>
    </button></li>`).join('')}</ul>`).join('');
  $('targetGroups').innerHTML = html;
  $('targetGroups').querySelectorAll('button[data-id]').forEach(b => b.onclick = () => {
    const id = b.dataset.id;
    if (b.dataset.api) { const r = recent().find(x => x.id === id); openEntry({ ...r, url: API + r.manifest, live: true }); }
    else openEntry(S.index.find(t => t.id === id));
  });
  $('targetNames').innerHTML = S.index.map(t => `<option value="${esc(t.name)}">`).join('');
  markCurrent();
}
function markCurrent() { document.querySelectorAll('#targetGroups button').forEach(b => b.setAttribute('aria-current', !!S.entry && b.dataset.id === S.entry.id)); }

/* ---------------- frames for the chosen detector + span ---------------- */
function selectFrames(keepMjd) {
  const t = S.target, hasDeep = t.frames.some(f => f.survey !== 'SPHEREx') || (t.plan || []).some(p => p.survey !== 'SPHEREx' && p.status !== 'skipped');
  S.frames = t.frames.filter(f => (f.survey === 'SPHEREx' && f.detector === S.det) || (S.span === 'all' && f.survey !== 'SPHEREx')).sort((p, q) => p.mjd - q.mjd);
  if (!S.frames.length) S.frames = t.frames.filter(f => f.survey === 'SPHEREx' && f.detector === S.det);
  $('span').hidden = !hasDeep;
  document.querySelectorAll('#span button').forEach(b => b.classList.toggle('active', b.dataset.span === S.span));
  if (keepMjd != null) S.i = S.frames.reduce((best, f, k) => Math.abs(f.mjd - keepMjd) < Math.abs(S.frames[best].mjd - keepMjd) ? k : best, 0);
  S.i = Math.min(S.i, S.frames.length - 1); S.a = 0; S.b = Math.max(0, S.frames.length - 1);
  S.frames.forEach(f => loadGray(frameUrl(f)).catch(() => {}));
}
function renderDetectors() {
  $('detectors').innerHTML = [1, 2, 3, 4, 5, 6].map(d => {
    const info = S.target.detectors[d] && S.target.detectors[d].frames ? S.target.detectors[d] : null;
    const pending = (S.target.plan || []).some(p => p.detector === d && !['done', 'skipped'].includes(p.status));
    const title = info ? `SPHEREx detector ${d}: ${DET[d][0]} µm (${DET[d][1]}), ${info.frames} dates${pending ? ' so far — more loading' : ''}. Key ${d}` : pending ? 'Still downloading — appears when ready' : 'No images in this detector';
    return `<button data-d="${d}" ${info ? '' : 'disabled'} class="${d === S.det ? 'active' : ''}${pending ? ' loading' : ''}" aria-pressed="${d === S.det}" title="${title}">D${d}<small>${DET[d][0]} µm</small></button>`;
  }).join('');
  $('detectors').querySelectorAll('button').forEach(b => b.onclick = () => setDetector(+b.dataset.d));
}
function setDetector(d) {
  if (!S.target.detectors[d] || !S.target.detectors[d].frames) return;
  const keep = S.frames[S.i]?.mjd; S.det = d; selectFrames(keep); renderDetectors(); renderMotion(); refresh();
}
function setSpan(sp) { const keep = S.frames[S.i]?.mjd; S.span = sp; selectFrames(keep); renderMotion(); fitTarget(); refresh(); }

/* ---------------- info panels ---------------- */
function renderInfo() {
  const f = S.frames[S.mode === 'play' ? S.i : S.b], t = S.target, m = f.measured;
  const row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
  const isSpx = f.survey === 'SPHEREx';
  $('frameInfo').innerHTML = [
    row('Telescope', `<span style="color:${SURVEY_COL[f.survey]}">${isSpx ? 'SPHEREx' : f.survey}</span> · ${f.releases.join(' + ')}`),
    row('Date', fmtUTC(f.utc)),
    isSpx ? row('Detector', `D${f.detector} · ${t.detectors[f.detector].range_um.join('–')} µm`) : row('Band', `${f.band}`),
    row('Wavelength', `${f.wavelength_um.mean.toFixed(2)} µm` + (f.n_images > 1 && f.wavelength_um.max - f.wavelength_um.min > 0.005 ? ` <span class="fine">(${f.wavelength_um.min.toFixed(2)}–${f.wavelength_um.max.toFixed(2)})</span>` : '')),
    row('Images stacked', f.n_images),
    isSpx ? row('Too bright (saturated)', f.saturated ? 'yes' : 'no', f.saturated ? 'warn' : '') : '',
    t.kind === 'field' ? row('Centre', `${sexa(t.grid.center[0], true)} ${sexa(t.grid.center[1], false)}`) : row('Predicted', `${sexa(f.predicted.ra, true)}<br>${sexa(f.predicted.dec, false)}`),
    t.kind === 'field' ? '' : row('Measured', m ? `${sexa(m.ra, true)}<br>${sexa(m.dec, false)}` : 'not found', m ? '' : 'warn'),
    m ? row('Difference', `${m.offset_from_predicted_arcsec.toFixed(1)}″`) : '',
  ].join('');
  $('srcCount').textContent = f.sources.length;
  $('sources').innerHTML = f.sources.map(s => `<li><a href="${esc(s.fits)}" target="_blank" rel="noopener" title="Original image file (FITS)">${esc(s.obs_id)}</a> · ${s.utc.slice(0, 16).replace('T', ' ')}</li>`).join('');
}
function renderMotion() {
  const t = S.target, el = $('motion'), fs = S.frames;
  $('future').hidden = !hasMotion();
  if (t.kind === 'field') {
    el.innerHTML = `<p>This is a patch of sky, not one object. Press ▶ or use <b>Difference</b> to look for anything that moved or changed brightness between ${fs[0].utc.slice(0, 4)} and ${fs[fs.length - 1].utc.slice(0, 4)}.</p>`; return;
  }
  if (t.kind === 'comet') {
    const a = fs[0], b = fs[fs.length - 1], sep = sepArcsec(a.predicted.ra, a.predicted.dec, b.predicted.ra, b.predicted.dec), hrs = (b.mjd - a.mjd) * 24;
    el.innerHTML = `<div class="big">${fmtArc(sep)} in ${hrs.toFixed(1)} hours</div><p>The comet moves against the fixed stars — about ${(sep / hrs / 60).toFixed(1)}′ per hour. Press ▶ and watch the circle.</p><p class="fine">Positions from IRSA's comet ephemeris.</p>`; return;
  }
  const ast = t.astrometry, pm = Math.hypot(ast.pmra, ast.pmdec) / 1000, ms = fs.filter(f => f.measured);
  if (pm < 0.05) {
    el.innerHTML = `<p><b>Brightness</b> is what changes here. Its motion (${(pm * 1000).toFixed(0)} thousandths of an arcsecond per year) is far too small to see.</p><p class="fine">Tip: compare dates with a similar wavelength (shown under "This image") — SPHEREx sees each date at a slightly different colour.</p>`; return;
  }
  if (ms.length < 2) { el.innerHTML = `<p class="fine">The star is not clearly visible in detector D${S.det}. Try another detector or "Since 2000".</p>`; return; }
  const r = Math.PI / 180, ra0 = ms[0].measured.ra, de0 = ms[0].measured.dec, t0 = ms[0].mjd;
  const pts = ms.map(f => ({ t: (f.mjd - t0) / 365.25, x: (f.measured.ra - ra0) * Math.cos(de0 * r) * 3600, y: (f.measured.dec - de0) * 3600 }));
  const slope = k => { const n = pts.length, mt = pts.reduce((s, p) => s + p.t, 0) / n, mv = pts.reduce((s, p) => s + p[k], 0) / n; const den = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0); return den ? pts.reduce((s, p) => s + (p.t - mt) * (p[k] - mv), 0) / den : 0; };
  const vx = slope('x'), vy = slope('y'), rate = Math.hypot(vx, vy), span = pts[pts.length - 1].t, pa = (Math.atan2(vx, vy) / r + 360) % 360;
  const good = Math.abs(rate / pm - 1) < 0.3;
  el.innerHTML = `<p>It <b>moves ${compassWord(pa)}</b> by about <b>${rate.toFixed(1)}″ per year</b> — measured in these images (${ms.length} dates over ${span.toFixed(span < 3 ? 1 : 0)} years).</p>
    <div class="row"><span>Total shift in these images</span><span>${fmtArc(rate * span)}</span></div>
    <div class="row"><span>Known motion (SIMBAD)</span><span>${pm.toFixed(1)}″/yr</span></div>
    <p class="fine ${good ? 'ok' : ''}">${good ? `✓ Matches the known motion (within ${Math.round(Math.abs(rate / pm - 1) * 100)} %).` : `Differs from the known motion by ${Math.round(Math.abs(rate / pm - 1) * 100)} % — the star is faint or too bright here; try another detector${S.span === 'spherex' ? ' or "Since 2000"' : ''}.`} One arcsecond (″) is 1/3600 of a degree; the Moon is about 1800″ wide.</p>`;
  renderFuture();
}
function renderFuture() {
  if (!hasMotion()) return;
  const t = S.target, y = S.futureYear, now = positionAt(t.astrometry, 2026.9), then = positionAt(t.astrometry, y);
  const sep = sepArcsec(...now, ...then), [u, v] = worldToImg(...then), inside = u >= 0 && v >= 0 && u < N() && v < N();
  $('futureOut').textContent = y;
  $('futureText').innerHTML = `In ${y} it will be <b>${fmtArc(sep)}</b> further ${compassWord((Math.atan2(t.astrometry.pmra, t.astrometry.pmdec) / Math.PI * 180 + 360) % 360)} than today${inside ? ' — the dashed purple circle.' : ' — outside this picture.'} This is a prediction from its known motion.`;
}

/* ---------------- timeline (drag or click) ---------------- */
let tlMap = null;
function drawTimeline() {
  const svg = $('timeline'); if (!S.target || !S.frames.length) return;
  const w = svg.clientWidth || 600, h = 74, padL = 18, padR = 18, y = 30, fs = S.frames;
  // piecewise axis: groups of dates more than ~200 days apart get their own segment, joined by a break
  const groups = []; fs.forEach((f, k) => { const g = groups[groups.length - 1]; if (g && f.mjd - fs[g.end].mjd < 500) g.end = k; else groups.push({ start: k, end: k }); });
  const gap = groups.length > 1 ? 26 : 0, avail = w - padL - padR - gap * (groups.length - 1);
  const spans = groups.map(g => Math.max(fs[g.end].mjd - fs[g.start].mjd, 1));
  const weights = spans.map(s => Math.max(s, 120)), tot = weights.reduce((a, b) => a + b, 0);
  let x = padL; const segs = groups.map((g, k) => { const width = avail * weights[k] / tot, seg = { ...g, x0: x + 8, x1: x + width - 8 }; x += width + gap; return seg; });
  const X = k => { const s = segs.find(sg => k >= sg.start && k <= sg.end); if (s.start === s.end) return (s.x0 + s.x1) / 2; return s.x0 + (fs[k].mjd - fs[s.start].mjd) / (fs[s.end].mjd - fs[s.start].mjd) * (s.x1 - s.x0); };
  tlMap = fs.map((_, k) => X(k));
  let out = '';
  segs.forEach((s, k) => {
    out += `<line class="axis" x1="${s.x0 - 8}" x2="${s.x1 + 8}" y1="${y}" y2="${y}"/>`;
    const a = fs[s.start], b = fs[s.end], label = a.utc.slice(0, 4) === b.utc.slice(0, 4) ? a.utc.slice(0, 4) : `${a.utc.slice(0, 4)}–${b.utc.slice(2, 4)}`;
    const surveys = [...new Set(fs.slice(s.start, s.end + 1).map(f => f.survey))].join(' + ');
    out += `<text class="yr" x="${(s.x0 + s.x1) / 2}" y="${y + 26}" text-anchor="middle">${label} · ${surveys}</text>`;
    if (k < segs.length - 1) { const bx = s.x1 + 8 + gap / 2; out += `<text class="brk" x="${bx}" y="${y + 4}" text-anchor="middle">≈</text><text class="yr" x="${bx}" y="${y + 40}" text-anchor="middle">+${Math.round(years(b.mjd, fs[segs[k + 1].start].mjd))} yr</text>`; }
  });
  fs.forEach((f, k) => {
    const cx = tlMap[k];
    if (k === S.a) out += `<circle class="mk-a" cx="${cx}" cy="${y}" r="11"/><text class="lbl a" x="${cx}" y="${y - 15}">A</text>`;
    if (k === S.b) out += `<circle class="mk-b" cx="${cx}" cy="${y}" r="${k === S.a ? 14 : 11}"/><text class="lbl b" x="${cx}" y="${y - (k === S.a ? 18 : 15)}">B</text>`;
    out += `<circle class="dot${k === S.i ? ' cur' : ''}" data-k="${k}" cx="${cx}" cy="${y}" r="${k === S.i ? 8 : 6}" style="--c:${SURVEY_COL[f.survey]}"><title>${frameLabel(f)} · ${fmtUTC(f.utc)}</title></circle>`;
  });
  if (tlMap.length) out += `<text class="cur-lbl" x="${Math.min(w - 60, Math.max(60, tlMap[S.i]))}" y="${y + 40}" text-anchor="middle">${fs[S.i].utc.slice(0, 10)}</text>`;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.innerHTML = out;
  svg.setAttribute('aria-valuemax', fs.length); svg.setAttribute('aria-valuenow', S.i + 1); svg.setAttribute('aria-valuetext', `${frameLabel(fs[S.i])} ${fmtUTC(fs[S.i].utc)}`);
  $('aLabel').textContent = `${fs[S.a].utc.slice(0, 10)} (${frameLabel(fs[S.a])})`;
  $('bLabel').textContent = `${fs[S.b].utc.slice(0, 10)} (${frameLabel(fs[S.b])})`;
}
function nearestFrame(clientX) {
  const r = $('timeline').getBoundingClientRect(), x = (clientX - r.left) * ((($('timeline').viewBox.baseVal || {}).width || r.width) / r.width);
  return tlMap.reduce((best, v, k) => Math.abs(v - x) < Math.abs(tlMap[best] - x) ? k : best, 0);
}
let tlDrag = false;
$('timeline').addEventListener('pointerdown', e => { if (!tlMap) return; tlDrag = true; $('timeline').setPointerCapture(e.pointerId); stop(); if (S.mode !== 'play') setMode('play'); go(nearestFrame(e.clientX)); });
$('timeline').addEventListener('pointermove', e => { if (tlDrag) { const k = nearestFrame(e.clientX); if (k !== S.i) go(k); } });
$('timeline').addEventListener('pointerup', () => { tlDrag = false; });
$('timeline').addEventListener('keydown', e => { if (e.key === 'ArrowRight') { e.preventDefault(); stop(); step(1); } if (e.key === 'ArrowLeft') { e.preventDefault(); stop(); step(-1); } });
$('setA').onclick = () => { S.a = S.i; if (S.a === S.b) S.b = Math.min(S.frames.length - 1, S.a + 1) === S.a ? Math.max(0, S.a - 1) : S.a + 1; if (S.mode === 'play') setMode('blink'); else refresh(); };
$('setB').onclick = () => { S.b = S.i; if (S.a === S.b) S.a = S.b > 0 ? S.b - 1 : S.b + 1; if (S.mode === 'play') setMode('blink'); else refresh(); };

/* ---------------- state ---------------- */
function refresh() { draw(); drawTimeline(); renderInfo(); syncUrl(); }
function go(k) { S.i = k; refresh(); }
function step(d) { go((S.i + d + S.frames.length) % S.frames.length); }
function setMode(m) {
  S.mode = m; S.blinkB = false;
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  if (m !== 'play' && S.frames.length < 2) flash('Only one date here — choose another detector to compare.');
  if (m === 'blink' && !S.playing) play(); else refresh();
}
function tick() { if (S.mode === 'blink') S.blinkB = !S.blinkB; else { S.i = (S.i + 1) % S.frames.length; drawTimeline(); renderInfo(); } draw(); }
function play() {
  if (S.mode === 'swipe' || S.mode === 'diff') { S.mode = 'play'; document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === 'play')); }
  S.playing = true; $('playBtn').textContent = '❚❚'; $('playBtn').setAttribute('aria-label', 'Pause');
  clearInterval(S.timer); S.timer = setInterval(tick, 1000 / +$('speed').value); refresh();
}
function stop() { S.playing = false; clearInterval(S.timer); $('playBtn').textContent = '▶'; $('playBtn').setAttribute('aria-label', 'Play'); }
function fitTarget() {
  // Show the whole path of the target (all dates) with some margin; whole field for fields/comets.
  const t = S.target;
  if (t.kind === 'field' || t.kind === 'comet' || !S.frames.length) { S.zoom = 1; S.cx = S.cy = N() / 2; return; }
  const ps = S.frames.map(f => fracToImg(f.predicted.xy)), xs = ps.map(p => p[0]), ys = ps.map(p => p[1]);
  S.cx = (Math.min(...xs) + Math.max(...xs)) / 2; S.cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 30 / t.grid.pixel_arcsec * 6;
  S.zoom = t.kind === 'object' ? 1.5 : Math.min(3, Math.max(1, N() / ext * 0.8));
}

async function openEntry(entry, opts = {}) {
  if (!entry) return;
  stop(); hideBuild(); status('Loading ' + entry.name + '…');
  const url = entry.url || (DATA + entry.manifest);
  let m;
  try { m = await fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw Error(r.status); return r.json(); }); }
  catch { status('Could not load this target. Check your connection and try again.'); return false; }
  if (!m.frames || !m.frames.length) { status(''); return false; }  // nothing ready yet
  S.target = m; S.entry = entry; S.base = url.replace(/manifest\.json$/, ''); markCurrent();
  const t = S.target, [kindName, change] = KIND[t.kind] || [t.kind, ''];
  $('targetName').textContent = t.name;
  $('kindLabel').textContent = kindName + (entry.live ? ' · built on request' : '');
  const isPlanet = t.kind === 'object' && (/[\d\s][b-h]$/.test(t.name.trim()) || /[\d\s][b-h]$/.test((t.astrometry && t.astrometry.main_id) || ''));
  $('lookFor').textContent = isPlanet ? `${t.name} is a planet — far too faint and too close to its star to see separately. The circle marks its host star; watch its brightness.` : t.kind === 'object' ? `The circle marks ${t.name.replace(/ \(.*\)$/, '')}. It hardly moves, so watch its brightness and its neighbours.` : t.kind === 'star' ? `Watch the star in the circle — it ${change}. Follow the dashed path.` : t.kind === 'variable' ? 'Watch the star in the circle get brighter and fainter.' : t.kind === 'comet' ? 'Watch the comet in the circle move past the stars.' : 'Press ▶ and look for anything that moves or changes.';
  $('blurb').textContent = t.blurb; $('processing').textContent = t.processing;
  const ready = d => t.detectors[d] && t.detectors[d].frames;
  S.det = opts.det && ready(opts.det) ? +opts.det : ready(t.default_detector) ? t.default_detector : +Object.keys(t.detectors).find(ready);
  const hasDeep = t.frames.some(f => f.survey !== 'SPHEREx');
  S.span = opts.span || (hasDeep && hasMotionKind(t) ? 'all' : 'spherex');
  S.i = 0; selectFrames();
  if (opts.f != null) S.i = Math.min(+opts.f, S.frames.length - 1);
  if (opts.a != null) S.a = Math.min(+opts.a, S.frames.length - 1);
  if (opts.b != null) S.b = Math.min(+opts.b, S.frames.length - 1);
  fitTarget(); renderDetectors(); renderMotion();
  S.mode = opts.mode || 'play'; document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === S.mode));
  requestAnimationFrame(resizeCanvas); refresh(); renderLoadCard();
  if (entry.live && t.complete === false) track(entry.id, entry.name);
  return true;
}
const hasMotionKind = t => t.kind === 'star' && t.astrometry && Math.hypot(t.astrometry.pmra, t.astrometry.pmdec) > 50;

/* ---------------- live builder: request, track, merge partial results ---------------- */
function showBuild(title, sub) { $('buildPanel').hidden = false; $('buildTitle').textContent = title; if (sub) $('buildSub').textContent = sub; status(''); }
function hideBuild() { $('buildPanel').hidden = true; } // builds keep being tracked in the background
$('buildCancel').onclick = hideBuild;
const ICON = { done: '✓', skipped: '–', downloading: '↓', processing: '⚙', searching: '⌕', waiting: '…' };
const STATUS_TXT = { waiting: 'waiting', searching: 'searching the archive', downloading: 'downloading', processing: 'processing', done: 'ready', skipped: 'not available' };
function planLine(p) {
  const files = p.files ? ` ${p.files_done || 0}/${p.files}` : '';
  const txt = p.status === 'skipped' ? `not available${p.note ? ': ' + p.note : ''}` : `${STATUS_TXT[p.status] || p.status}${p.status === 'downloading' || p.status === 'waiting' ? files : ''}`;
  return `<li><span class="st ${p.status}">${['downloading', 'processing', 'searching'].includes(p.status) ? `<span class="spin">${ICON[p.status]}</span>` : ICON[p.status] || '•'}</span> ${esc(p.label)} — ${esc(txt)}</li>`;
}
function planSummary(plan) {
  const items = plan.length, ready = plan.filter(p => p.status === 'done').length, closed = plan.filter(p => ['done', 'skipped'].includes(p.status)).length;
  const files = plan.reduce((s, p) => s + (p.files || 0), 0), fdone = plan.reduce((s, p) => s + (p.files_done || 0), 0);
  return { items, ready, closed, pct: items ? Math.round(100 * (0.7 * fdone / Math.max(files, 1) + 0.3 * closed / items)) : 0 };
}
let livePlan = null;
function renderLoadCard() {
  const t = S.target, plan = (livePlan && S.entry && livePlan.id === S.entry.id ? livePlan.plan : null) || (t && t.plan) || [];
  if (!t || t.complete !== false) { $('loadCard').hidden = true; return; }
  const sm = planSummary(plan), open = plan.filter(p => p.status !== 'done');
  $('loadCard').hidden = false;
  $('lcTitle').textContent = `Loading more data — ${sm.ready} of ${sm.items} parts ready`;
  $('lcBar').style.width = `${sm.pct}%`;
  $('lcSub').textContent = 'You can already explore what is shown. New dates and detectors appear here automatically.';
  $('lcList').innerHTML = open.map(planLine).join('') || '<li>Finishing…</li>';
}
$('lcToggle').onclick = () => { $('loadCard').classList.toggle('collapsed'); $('lcToggle').textContent = $('loadCard').classList.contains('collapsed') ? '▸' : '▾'; };

/** Merge a newer manifest of the target being viewed, keeping the current date/detector/view. */
function mergeLive(m) {
  const curId = S.frames[S.i]?.id, aId = S.frames[S.a]?.id, bId = S.frames[S.b]?.id, keepMjd = S.frames[S.i]?.mjd;
  const firstDet = !S.target.detectors[S.det]?.frames;
  S.target = m;
  if (firstDet || !m.detectors[S.det]) S.det = m.detectors[m.default_detector] ? m.default_detector : +Object.keys(m.detectors)[0];
  selectFrames(keepMjd);
  const idx = id => S.frames.findIndex(f => f.id === id);
  if (idx(curId) >= 0) S.i = idx(curId);
  if (idx(aId) >= 0) S.a = idx(aId);
  if (idx(bId) >= 0 && idx(bId) !== S.a) S.b = idx(bId);
  renderDetectors(); renderMotion(); refresh(); renderLoadCard();
}

const trackers = new Map();  // job id → interval
function track(id, name) {
  if (!API || trackers.has(id)) return;
  let opened = S.entry && S.entry.id === id, lastRev = -1;
  const t0 = Date.now();
  const tick = async () => {
    let r;
    try { r = await fetch(`${API}/api/fields/${id}`, { cache: 'no-store' }).then(x => x.json()); } catch { return; }
    if (r.detail) { clearInterval(trackers.get(id)); trackers.delete(id); return; }
    const plan = r.plan || [], sm = planSummary(plan), viewing = S.entry && S.entry.id === id;
    livePlan = { id, plan };
    const entry = { id, name: name || r.name || id, manifest: `/data/${id}/manifest.json`, url: `${API}/data/${id}/manifest.json`, live: true };
    if (r.status === 'error') {
      clearInterval(trackers.get(id)); trackers.delete(id);
      if (!$('buildPanel').hidden) $('buildLog').innerHTML = `<li class="err">${esc(r.error)}</li>`; else flash(`Could not build ${entry.name}: ${r.error}`);
      return;
    }
    // Before anything is ready: show the plan in the build panel.
    if (!opened && !$('buildPanel').hidden) {
      $('buildBar').style.width = `${Math.max(3, sm.pct)}%`;
      $('buildLog').innerHTML = (r.queue_position ? `<li>Waiting for a free builder slot — #${r.queue_position} in line…</li>` : '') +
        (plan.length ? plan.map(planLine).join('') : (r.log || []).slice(-4).map(l => `<li>${esc(l)}</li>`).join('')) + `<li class="fine">${Math.round((Date.now() - t0) / 1000)} s</li>`;
    }
    // First date ready → open it straight away (if the user is still waiting for this place).
    if (!opened && sm.ready > 0 && r.manifest && !$('buildPanel').hidden) {
      remember(entry); renderTargets();
      opened = await openEntry(entry);
    } else if (viewing) {
      if (sm.ready !== lastRev || r.status === 'done') {
        lastRev = sm.ready;
        try { const m = await fetch(`${API}/data/${id}/manifest.json`, { cache: 'no-store' }).then(x => x.json()); if (m.frames.length && (m.revision !== S.target.revision || m.complete !== S.target.complete)) mergeLive(m); } catch { /* next tick */ }
      }
      renderLoadCard();
    }
    if (r.status === 'done') {
      clearInterval(trackers.get(id)); trackers.delete(id); livePlan = null;
      remember(entry); renderTargets();
      if (!opened && !$('buildPanel').hidden) { hideBuild(); openEntry(entry); }
      else if (viewing) { flash('All data loaded.'); renderLoadCard(); }
      else flash(`${entry.name} is ready — open it from "Your searches" or Downloads.`);
    }
    pollJobs();
  };
  trackers.set(id, setInterval(tick, 2500)); tick();
}
async function requestField(ra, dec, name) {
  if (!API) { flash('The live builder is not connected, so only the listed targets are available right now.'); return; }
  stop(); showBuild(`Building: ${name || `RA ${ra.toFixed(3)}°, Dec ${dec.toFixed(3)}°`}`);
  $('buildLog').innerHTML = '<li>Contacting the builder…</li>'; $('buildBar').style.width = '3%';
  let res;
  try {
    const q = new URLSearchParams({ ra: ra.toFixed(4), dec: dec.toFixed(4), fov: '0.15', ...(name ? { name } : {}) });
    const r = await fetch(`${API}/api/fields?${q}`, { method: 'POST' });
    res = await r.json(); if (!r.ok) throw Error(res.detail || r.status);
  } catch (e) { $('buildLog').innerHTML = `<li class="err">The builder could not be reached (${esc(e.message)}). Try a listed target.</li>`; return; }
  const label = name || `RA ${ra.toFixed(3)} Dec ${dec.toFixed(3)}`;
  if (res.status === 'done') { hideBuild(); const e = { id: res.id, name: label, manifest: res.manifest, url: API + res.manifest, live: true }; remember(e); renderTargets(); openEntry(e); return; }
  track(res.id, label); pollJobs();
}

/* ---------------- Downloads panel ---------------- */
let jobsCache = [];
const dlOpen = new Set(), dlDetail = new Map();
/** Step-by-step view of one build: every part with its status, plus the latest server messages. */
async function loadDetail(id) {
  let r = null, plan = [], log = [];
  try { r = await fetch(`${API}/api/fields/${id}`, { cache: 'no-store' }).then(x => x.json()); plan = r.plan || []; log = r.log || []; } catch { /* below */ }
  if (!plan.length) { try { plan = (await fetch(`${API}/data/${id}/manifest.json`, { cache: 'no-store' }).then(x => x.json())).plan || []; } catch { /* none */ } }
  const sm = planSummary(plan);
  const html = (plan.length ? `<p class="fine">${sm.ready} of ${sm.items} parts ready${r && r.queue_position ? ` · #${r.queue_position} in line` : ''}${r && r.elapsed_s ? ` · ${Math.round(r.elapsed_s)} s` : ''}</p><ul class="plan">${plan.map(planLine).join('')}</ul>` : '<p class="fine">No step details were kept for this build.</p>')
    + (log.length ? `<details><summary>Server messages</summary><pre>${log.map(esc).join('\n')}</pre></details>` : '')
    + (r && r.error ? `<p class="err">${esc(r.error)}</p>` : '');
  dlDetail.set(id, html);
  const el = document.getElementById('det-' + id); if (el) el.innerHTML = html;
}
async function pollJobs() {
  if (!API) return;
  try { jobsCache = (await fetch(`${API}/api/jobs`, { cache: 'no-store' }).then(r => r.json())).jobs || []; } catch { return; }
  const active = jobsCache.filter(j => ['running', 'queued'].includes(j.status)).length;
  $('dlBadge').hidden = !active; $('dlBadge').textContent = active;
  if ($('dlDlg').open) { renderJobs(); dlOpen.forEach(loadDetail); }
}
function renderJobs() {
  if (!API) { $('dlList').innerHTML = '<li>The live builder is not connected, so nothing is downloading. Ready-made targets work without it.</li>'; return; }
  if (!jobsCache.length) { $('dlList').innerHTML = '<li>Nothing yet. Search any star or coordinates, or pick a place on the sky map.</li>'; return; }
  $('dlList').innerHTML = jobsCache.map(j => {
    const p = j.progress || {}, pct = j.status === 'done' ? 100 : p.files_total ? Math.round(100 * (0.7 * p.files_done / p.files_total + 0.3 * p.items_done / Math.max(1, p.items_total))) : 0;
    const st = j.status === 'queued' && j.queue_position ? `queued #${j.queue_position}` : j.status;
    const meta = j.status === 'done' ? `${j.frames ?? '?'} dates ready${j.elapsed_s ? ` · built in ${Math.round(j.elapsed_s)} s` : ''}`
      : j.status === 'error' ? esc(j.error || 'failed') : `${p.items_done || 0}/${p.items_total || '?'} parts · ${p.files_done || 0}/${p.files_total || '?'} files · ${Math.round(j.elapsed_s || 0)} s`;
    const open = dlOpen.has(j.id);
    return `<li data-job="${esc(j.id)}" class="${open ? 'open' : ''}" title="Click to ${open ? 'hide' : 'show'} the steps"><span class="nm">${open ? '▾' : '▸'} ${esc(j.name)}<span class="chip-st ${j.status}">${esc(st)}</span></span>
      <span class="meta">${meta}</span><div class="bar"><i style="width:${pct}%"></i></div>
      <span class="act">${j.manifest ? `<button data-open="${esc(j.id)}" data-name="${esc(j.name)}">${j.status === 'done' ? 'Open' : 'Open (partial)'}</button>` : ''}</span>
      ${open ? `<div class="steps-detail" id="det-${esc(j.id)}">${dlDetail.get(j.id) || '<p class="fine">Loading steps…</p>'}</div>` : ''}</li>`;
  }).join('');
  $('dlList').querySelectorAll('li[data-job]').forEach(li => li.onclick = e => {
    if (e.target.closest('button')) return;
    const id = li.dataset.job; if (dlOpen.has(id)) dlOpen.delete(id); else { dlOpen.add(id); loadDetail(id); }
    renderJobs();
  });
  $('dlList').querySelectorAll('button[data-open]').forEach(b => b.onclick = async () => {
    const id = b.dataset.open, e = { id, name: b.dataset.name, manifest: `/data/${id}/manifest.json`, url: `${API}/data/${id}/manifest.json`, live: true };
    $('dlDlg').close(); remember(e); renderTargets();
    if (!(await openEntry(e))) flash('Nothing is ready to show yet — try again in a moment.');
  });
}
$('dlBtn').onclick = () => { renderJobs(); $('dlDlg').showModal(); pollJobs(); };
if (API) { pollJobs(); setInterval(() => { if (!document.hidden) pollJobs(); }, 5000); }
else $('dlBtn').title = 'The live builder is not connected';

async function resolveName(name) {
  if (API) { try { const r = await fetch(`${API}/api/resolve?name=${encodeURIComponent(name)}`); if (r.ok) return r.json(); if (r.status === 404) return null; } catch { /* fall back */ } }
  for (const base of SESAME) {
    try {
      const xml = new DOMParser().parseFromString(await fetch(base + encodeURIComponent(name)).then(r => r.text()), 'text/xml');
      const res = xml.querySelector('Resolver'); if (!res || !res.querySelector('jradeg')) return null;
      return { name, main_id: res.querySelector('oname')?.textContent, ra: +res.querySelector('jradeg').textContent, dec: +res.querySelector('jdedeg').textContent };
    } catch { /* next mirror */ }
  }
  return null;
}
const ALIASES = { barnard: ['barnard', 'gj 699'], 'eps-indi-b': ['eps ind', 'epsilon ind', 'ε ind'], 'wise-0855': ['wise 0855', 'wise0855', '0855'], 'rw-aur': ['rw aur'], 'r-dra': ['r dra'], '3i-atlas': ['3i', 'atlas'] };
// Solar System bodies move every day, so name catalogues (SIMBAD) have no fixed position for them.
const SOLAR = {
  sun: 'SPHEREx never looks near the Sun.', mercury: 'Mercury never gets more than about 28° from the Sun, and SPHEREx always points roughly at right angles to the Sun — so SPHEREx can never see Mercury.',
  venus: 'Venus never gets more than about 47° from the Sun, and SPHEREx always points roughly at right angles to the Sun — so SPHEREx can never see Venus.',
  moon: 'The Moon moves across the sky in hours and is far too bright for SPHEREx; it is not in this tool.',
  earth: 'SPHEREx orbits the Earth and looks away from it.',
};
const MOVING_SS = ['mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'ceres', 'vesta', 'pallas'];
async function search(q) {
  q = q.trim(); if (!q) return; const ql = q.toLowerCase().replace(/^the /, '');
  if (SOLAR[ql]) { flash(SOLAR[ql]); return; }
  if (MOVING_SS.includes(ql)) { flash(`${q[0].toUpperCase() + q.slice(1)} is in our Solar System, so it moves every day and has no fixed position in star catalogues. This version only follows stars and fixed places (plus comet 3I/ATLAS).`); return; }
  const hit = S.index.find(t => t.name.toLowerCase() === ql || t.id === ql) || S.index.find(t => (ALIASES[t.id] || []).some(a => ql.includes(a)) || t.name.toLowerCase().includes(ql));
  if (hit) { openEntry(hit); return; }
  let c = parseCoords(q), name = null;
  if (!c) { status(`Looking up "${q}"…`); const r = await resolveName(q); status(''); if (!r) { flash(`No star or object called "${q}" was found. Try another name or coordinates.`); return; } c = [r.ra, r.dec]; name = q; }
  const near = S.index.filter(t => t.kind !== 'comet').map(t => ({ t, d: sepArcsec(c[0], c[1], t.center[0], t.center[1]) / 3600 })).sort((p, q2) => p.d - q2.d)[0];
  if (near && near.d < 0.03) { openEntry(near.t); return; }
  requestField(c[0], c[1], name);
}
$('search').onsubmit = e => { e.preventDefault(); search($('q').value); $('q').blur(); };

/* ---------------- sky picker (Aladin Lite) ---------------- */
const hips = l => window.A.HiPS(l.url, { name: l.name, imgFormat: l.fmt, maxOrder: l.order, cooFrame: 'equatorial' });
/** SPHEREx DR1 is a 102-channel cube. Aladin 3.8 maps a slice number to a wavelength linearly but picks
 *  tiles linearly in frequency, so convert; retry until the layer is attached. */
function applySlice(layer, k, tries = 40) {
  if (!layer || !layer.setSliceNumber || k == null) return;
  if (!layer.added || !layer.cubeDepth) { if (tries > 0) setTimeout(() => applySlice(layer, k, tries - 1), 150); return; }
  const c = 299792458, lo = layer.emMin, hi = layer.emMax, D = layer.cubeDepth, fmin = c / hi, fmax = c / lo, f = fmin + (k + 0.5) / D * (fmax - fmin);
  layer.setSliceNumber((c / f - lo) / (hi - lo) * D);
}
function setMap(l) { const h = hips(l); S.aladin.setBaseImageLayer(h); applySlice(h, l.slice); }
/** Is a map server answering? Waits up to 20 s and tries twice (first requests to IRSA can be slow).
 *  Returns { ok, why } so the page can say what went wrong. */
const mapCheck = new Map();
async function mapOnline(l) {
  if (mapCheck.get(l.url) === true) return { ok: true };
  let why = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(l.url + '/properties', { signal: ctl.signal });
      if (r.ok && /hips_|obs_title/.test(await r.text())) { mapCheck.set(l.url, true); return { ok: true }; }
      why = `the server answered with error ${r.status}`;
    } catch (e) {
      why = e.name === 'AbortError' ? 'it took longer than 20 seconds to answer (slow connection to the US)'
        : 'the request was blocked — usually by an ad/tracker blocker or strict privacy setting; allow irsa.ipac.caltech.edu';
    } finally { clearTimeout(tm); }
  }
  console.warn('Map check failed:', l.url, why);
  return { ok: false, why };
}
/* Map tile progress: Aladin does not report it, so count requests to the map servers (fetch and <img>). */
const tiles = { started: 0, done: 0, failed: 0, base: 0, hideT: null };
const isTile = u => typeof u === 'string' && /\/Norder\d+\//.test(u) && MAPS.some(m => u.startsWith(m.url));
function tileStart() {
  if (tiles.done + tiles.failed >= tiles.started) tiles.base = tiles.started;  // a new batch begins
  tiles.started++; showTiles();
}
function tileEnd(ok) { ok ? tiles.done++ : tiles.failed++; showTiles(); }
function showTiles() {
  const total = tiles.started - tiles.base, fin = tiles.done + tiles.failed - tiles.base, el = $('tileBar');
  if (!el) return;
  clearTimeout(tiles.hideT);
  if (total <= 0) return;
  const pct = Math.round(100 * Math.min(fin, total) / total);
  el.hidden = false;
  $('tileFill').style.width = pct + '%';
  $('tileText').textContent = fin >= total ? `Map loaded — ${total} tiles${tiles.failed ? ` (${tiles.failed} could not be loaded)` : ''}` : `Loading map tiles: ${fin} of ${total} (${pct}%)`;
  if (fin >= total) tiles.hideT = setTimeout(() => { el.hidden = true; }, 1500);
}
(function watchTiles() {
  const f = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    if (!isTile(url)) return f.call(this, input, init);
    tileStart();
    return f.call(this, input, init).then(r => { tileEnd(r.ok); return r; }, e => { tileEnd(false); throw e; });
  };
  const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true, get() { return desc.get.call(this); },
    set(v) {
      if (isTile(v)) {
        tileStart();
        const done = ok => () => { this.removeEventListener('load', onL); this.removeEventListener('error', onE); tileEnd(ok); };
        const onL = done(true), onE = done(false);
        this.addEventListener('load', onL); this.addEventListener('error', onE);
      }
      desc.set.call(this, v);
    },
  });
})();
async function openSky() {
  $('skyDlg').showModal();
  if (S.aladin) return;
  $('skyStatus').textContent = 'Loading sky map…';
  try {
    if (!window.A) window.A = (await import(ALADIN_URL)).default;
    await A.init;
    let layer = MAPS.find(m => m.key === S.map), chk = await mapOnline(layer);
    if (!chk.ok) {
      const alt = MAPS.find(m => m !== layer);
      const chk2 = await mapOnline(alt);
      if (!chk2.ok) throw new Error(`NASA's map server could not be reached: ${chk.why}.`);
      flash(`${layer.name} could not be loaded (${chk.why}) — showing ${alt.name}.`, $('skyStatus')); layer = alt;
    }
    const c = S.target ? S.target.grid.center : [269.45, 4.7];
    S.aladin = A.aladin('#aladin', { survey: (S.firstHips = hips(layer)), hipsList: MAPS.map(m => ({ id: m.url, url: m.url, name: m.name })), fov: 3, target: `${c[0]} ${c[1]}`,
      cooFrame: 'ICRS', showReticle: false, showLayersControl: false, showCooGridControl: true, showFullscreenControl: false, showContextMenu: false, backgroundColor: 'rgb(5,8,11)' });
    const cat = A.catalog({ name: 'Ready-made targets', sourceSize: 18, color: '#ffb454', shape: 'circle' }); S.aladin.addCatalog(cat);
    cat.addSources(S.index.filter(t => t.kind !== 'comet').map(t => A.marker(t.center[0], t.center[1], { popupTitle: esc(t.name), popupDesc: 'Ready-made target' })));
    S.pickCat = A.catalog({ name: 'Your point', sourceSize: 22, color: '#4fc3f7', shape: 'cross' }); S.aladin.addCatalog(S.pickCat);
    S.aladin.on('click', e => { if (!e || e.ra == null) return; S.pick = [e.ra, e.dec]; S.pickCat.removeAll(); S.pickCat.addSources([A.source(e.ra, e.dec)]);
      $('skyPick').textContent = `Chosen: ${sexa(e.ra, true)} ${sexa(e.dec, false)}`; $('skyBuild').disabled = false; });
    applySlice(S.firstHips, layer.slice); S.map = layer.key;
    $('survey').value = layer.key; $('skyStatus').textContent = '';
  } catch (e) { console.error(e); $('skyStatus').textContent = (e.message && e.message.startsWith("NASA's") ? e.message : 'The sky map could not load (it needs internet and WebGL2).') + ' You can still type coordinates in the search box.'; }
}
$('survey').innerHTML = MAPS.map(m => `<option value="${m.key}">${m.name}</option>`).join('');
$('survey').onchange = async e => {
  const l = MAPS.find(m => m.key === e.target.value); if (!S.aladin) return;
  const chk = await mapOnline(l);
  if (!chk.ok) { flash(`${l.name} could not be loaded: ${chk.why}.`, $('skyStatus')); $('survey').value = S.map; return; }
  S.map = l.key; setMap(l);
};
$('skyBuild').onclick = () => { if (!S.pick) return; $('skyDlg').close(); search(`${S.pick[0].toFixed(5)} ${S.pick[1].toFixed(5)}`); };
$('skyBtn').onclick = openSky;

/* ---------------- canvas interaction ---------------- */
let drag = null;
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId); const x = e.clientX - canvas.getBoundingClientRect().left;
  drag = { x: e.clientX, y: e.clientY, cx: S.cx, cy: S.cy, swipe: S.mode === 'swipe' && Math.abs(x - W * S.swipe) < 28 }; canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', e => {
  const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (S.target) { const [u, v] = toImage(x, y); $('cursor').textContent = u >= 0 && v >= 0 && u < N() && v < N() ? (([ra, dec]) => `RA ${sexa(ra, true)}  Dec ${sexa(dec, false)}`)(imgToWorld(u, v)) : 'RA — Dec —'; }
  if (!drag) return;
  if (drag.swipe) { S.swipe = Math.min(1, Math.max(0, x / W)); draw(); return; }
  S.cx = drag.cx - (e.clientX - drag.x) / scale(); S.cy = drag.cy - (e.clientY - drag.y) / scale(); draw();
});
const endDrag = () => { drag = null; canvas.classList.remove('dragging'); };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', e => { e.preventDefault(); const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; zoomBy(Math.exp(-e.deltaY * 0.0015), ...toImage(x, y), x, y); }, { passive: false });
canvas.addEventListener('dblclick', e => { const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; zoomBy(2, ...toImage(x, y), x, y); });
function zoomBy(f, u, v, x, y) { S.zoom = Math.min(40, Math.max(0.5, S.zoom * f)); if (u != null) { S.cx = u - (x - W / 2) / scale(); S.cy = v - (y - H / 2) / scale(); } draw(); }
$('zoomIn').onclick = () => zoomBy(1.5); $('zoomOut').onclick = () => zoomBy(1 / 1.5);
$('zoomFit').onclick = () => { S.zoom = 1; S.cx = S.cy = N() / 2; draw(); };
$('zoomTarget').onclick = () => { const f = S.frames[S.i]; [S.cx, S.cy] = fracToImg((f.measured || f.predicted).xy); S.zoom = Math.max(S.zoom, 4); draw(); };
$('prev').onclick = () => { stop(); step(-1); }; $('next').onclick = () => { stop(); step(1); };
$('playBtn').onclick = () => S.playing ? stop() : play();
$('speed').oninput = e => { $('speedOut').textContent = `${e.target.value}/s`; if (S.playing) play(); };
document.querySelectorAll('#modes button').forEach(b => b.onclick = () => { stop(); setMode(b.dataset.mode); });
document.querySelectorAll('#span button').forEach(b => b.onclick = () => setSpan(b.dataset.span));
for (const k of ['label', 'pred', 'meas', 'track', 'flags']) $('show' + k[0].toUpperCase() + k.slice(1)).onchange = e => { S.show[k] = e.target.checked; draw(); };
$('cmap').onchange = e => { S.cmap = e.target.value; draw(); };
$('bright').oninput = e => { S.bright = +e.target.value; draw(); };
$('contrast').oninput = e => { S.contrast = +e.target.value; draw(); };
$('sharp').onchange = e => { S.sharp = e.target.checked; draw(); };
$('futureYear').oninput = e => { S.futureYear = +e.target.value; renderFuture(); draw(); };
document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea') || document.querySelector('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey || !S.target) return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); S.playing ? stop() : play(); }
  else if (k === 'arrowright') { stop(); step(1); } else if (k === 'arrowleft') { stop(); step(-1); }
  else if (k === 'a') $('setA').click(); else if (k === 'z') $('setB').click();
  else if (k === 'b') { stop(); setMode('blink'); } else if (k === 's') { stop(); setMode('swipe'); } else if (k === 'd') { stop(); setMode('diff'); } else if (k === 'p') { stop(); setMode('play'); }
  else if (k === '+' || k === '=') zoomBy(1.5); else if (k === '-') zoomBy(1 / 1.5);
  else if (k === '0') $('zoomFit').click(); else if (k === 't') $('zoomTarget').click();
  else if (/^[1-6]$/.test(k)) setDetector(+k); else if (k === '?') $('helpDlg').showModal();
});

/* ---------------- URL + share ---------------- */
let urlT = null;
function syncUrl() {
  clearTimeout(urlT);
  urlT = setTimeout(() => {
    if (!S.entry) return;
    const p = new URLSearchParams(S.entry.live ? { field: S.entry.id } : { t: S.entry.id });
    p.set('det', S.det); p.set('span', S.span); p.set('mode', S.mode);
    if (S.mode === 'play') p.set('f', S.i); else { p.set('a', S.a); p.set('b', S.b); }
    history.replaceState(null, '', '?' + p);
  }, 250);
}
$('shareBtn').onclick = async () => { syncUrl(); await new Promise(r => setTimeout(r, 300)); try { await navigator.clipboard.writeText(location.href); flash('Link copied — it opens this exact view.'); } catch { flash('Copy the address from the browser bar to share.'); } };

/* ---------------- dialogs, theme, tip ---------------- */
$('helpBtn').onclick = () => $('helpDlg').showModal();
$('aboutBtn').onclick = () => $('aboutDlg').showModal();
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
(function theme() {
  const root = document.documentElement;
  if (!root.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches) root.dataset.theme = 'light';
  $('themeBtn').onclick = () => { root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light'; try { localStorage.setItem('theme', root.dataset.theme); } catch { /* storage off */ } drawTimeline(); };
})();
if (matchMedia('(prefers-reduced-motion: reduce)').matches) { $('speed').value = 1; $('speedOut').textContent = '1/s'; }

/* ---------------- start ---------------- */
new ResizeObserver(() => resizeCanvas()).observe($('viewer'));
(async function init() {
  try { S.index = (await fetch(DATA + 'targets.json').then(r => { if (!r.ok) throw Error(r.status); return r.json(); })).targets; }
  catch { status('Could not load the target list. Serve the dist/ folder with a web server and refresh.'); return; }
  renderTargets();
  const p = new URLSearchParams(location.search), opts = { det: p.get('det'), span: p.get('span'), f: p.get('f'), a: p.get('a'), b: p.get('b'), mode: p.get('mode') };
  if (p.get('field') && API) { const id = p.get('field'); await openEntry({ id, name: id, url: `${API}/data/${id}/manifest.json`, manifest: `/data/${id}/manifest.json`, live: true }, opts); return; }
  const id = p.get('t') || p.get('target');
  await openEntry(S.index.find(t => t.id === id) || S.index[0], opts);
})();
