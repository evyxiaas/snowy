/* Cloudy Music - website logic.
 *
 * Talks to:
 *  1) the Edge extension, through window.postMessage <-> cloudy-content.js (see README "Messaging protocol")
 *  2) the Arduino, through the Web Serial API (newline-delimited text, 9600 baud)
 */
(() => {
'use strict';

const $ = s => document.querySelector(s);
const ORIGIN = location.origin;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const setHidden = (el, h) => el.toggleAttribute('hidden', !!h);   // SVG elements have no .hidden property
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const str = (v, n = 300) => (typeof v === 'string') ? v.slice(0, n) : '';
const fmt = s => {
  if (s == null) return '--:--';
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

const S = {
  start: Date.now(), extSeen: 0, ytmAt: 0,
  track: null, key: '', playing: false, pos: null, dur: null, stamp: 0, vol: null,
  mode: 'player', dragging: false, lastFail: 0, lastErr: '', lastCmd: '',
  ytmLyrics: { key: '', text: '' }, lyShown: '', lyIdx: -2, lyParsed: null, lcdLyric: '',
  ser: { port: null, reader: null, writer: null, rc: null, wc: null, buf: '', open: false, rx: '', rxAt: 0 },
  sent: {}, q: [], qTimer: null,
  lr: {}, lrOn: true, lrErr: '', searching: false,
};

/* ------------------------------------------------------------------ *
 * Extension bridge
 * page -> content script: {source:'cloudy-page', type, ...}
 * content script -> page: {source:'cloudy-ext',  type, ...}
 * Only messages from this same window and origin are accepted.
 * ------------------------------------------------------------------ */
const pending = new Map();
let nextId = 1;
const toExt = msg => window.postMessage({ source: 'cloudy-page', ...msg }, ORIGIN);

function sendCommand(command, value) {
  return new Promise(resolve => {
    const id = nextId++;
    const t = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'No answer from the extension. Is it installed and enabled?' });
    }, 5000);
    pending.set(id, r => { clearTimeout(t); resolve(r); });
    toExt({ type: 'COMMAND', id, command, value });
  });
}

window.addEventListener('message', e => {
  if (e.source !== window || e.origin !== ORIGIN) return;
  const d = e.data;
  if (!d || d.source !== 'cloudy-ext') return;
  switch (d.type) {
    case 'READY':
      S.extSeen = Date.now();
      if (Date.now() - S.ytmAt > 4000) toExt({ type: 'GET_STATE' });
      break;
    case 'STATE': applyState(d.state); break;
    case 'LYRICS':
      if (d.lyrics && typeof d.lyrics.text === 'string') {
        S.ytmLyrics = { key: str(d.lyrics.trackKey), text: d.lyrics.text.slice(0, 20000) };
        if (S.ytmLyrics.key === S.key) { S.lyShown = ''; renderLyrics(); }
      }
      break;
    case 'YTM_CLOSED':
      S.ytmAt = 0; S.track = null; S.key = ''; onTrackChange(); break;
    case 'RESULT': {
      const f = pending.get(d.id);
      if (f) { pending.delete(d.id); f(d.result || { ok: false, error: 'Empty reply' }); }
      break;
    }
  }
});
setInterval(() => toExt({ type: 'HELLO' }), 2000);
toExt({ type: 'HELLO' });

/* ------------------------------------------------------------------ *
 * Playback state
 * ------------------------------------------------------------------ */
function applyState(st) {
  if (!st || typeof st !== 'object') return;
  S.ytmAt = Date.now();
  const t = st.track && st.track.title ? {
    title: str(st.track.title), artist: str(st.track.artist), album: str(st.track.album),
    art: /^https:\/\//.test(str(st.track.art, 1000)) ? str(st.track.art, 1000) : '',
  } : null;
  const key = t ? t.title + '|' + t.artist : '';
  S.playing = !!st.playing; S.pos = num(st.position); S.dur = num(st.duration);
  S.vol = num(st.volume); S.stamp = Date.now();
  if (key !== S.key) { S.key = key; S.track = t; onTrackChange(); }
  else if (t && S.track && t.art !== S.track.art) { S.track.art = t.art; setArt(t.art); }
  maybeLookup();
  render();
}

function onTrackChange() {
  const t = S.track;
  $('#title').textContent = t ? t.title : 'Nothing playing yet';
  $('#artist').textContent = t ? (t.artist || 'Unknown artist') : 'Play a song in YouTube Music';
  $('#album').textContent = t ? t.album : '';
  $('#lyTitle').textContent = t ? t.title : 'Nothing playing yet';
  $('#lyArtist').textContent = t ? t.artist : '';
  const n = t ? t.title.length : 0;                      // long names get a smaller font so they wrap fully
  for (const el of [$('#title'), $('#lyTitle')]) { el.classList.toggle('t-md', n > 34 && n <= 60); el.classList.toggle('t-sm', n > 60); }
 document.title = t ? t.title + ' · Snowy Music' : 'Snowy Music';
  setArt(t ? t.art : '');
  if (S.ytmLyrics.key !== S.key) S.ytmLyrics = { key: '', text: '' };   // never show old song's lyrics
  S.lyShown = ''; S.lyIdx = -2;
  $('#lyEdit').hidden = true; $('#lyBox').hidden = false;
  renderLyrics();
  S.pos = t ? S.pos : null;
}

function setArt(url) {
  const img = $('#artImg'), ph = $('#artPh');
  if (!url) { setHidden(img, true); setHidden(ph, false); img.removeAttribute('src'); return; }
  img.onload = () => { setHidden(img, false); setHidden(ph, true); };
  img.onerror = () => { setHidden(img, true); setHidden(ph, false); };
  img.src = url;
}

function curPos() {
  if (S.pos == null) return null;
  let p = S.pos;
  // Interpolate only between real reports (they arrive every ~1s while playing).
  if (S.playing && Date.now() - S.stamp < 2500) p += (Date.now() - S.stamp) / 1000;
  return S.dur != null ? Math.min(p, S.dur) : p;
}

function render() {
  const p = curPos(), seek = $('#seek');
  seek.disabled = !(S.track && S.dur && p != null);
  if (!S.dragging) {
    const v = S.dur && p != null ? Math.round(p / S.dur * 1000) : 0;
    seek.value = v; seek.style.setProperty('--p', v / 10 + '%');
    $('#tCur').textContent = p == null ? '0:00' : fmt(p);
  }
  $('#tDur').textContent = S.dur ? fmt(S.dur) : '--:--';
  setHidden($('#icoPlay'), S.playing); setHidden($('#icoPause'), !S.playing);
  $('#btnPlay').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  updateStatus();
}
setInterval(() => { render(); renderLyrics(); }, 250);

function computeStatus() {
  const now = Date.now();
  if (!S.extSeen && now - S.start < 3000) return ['wait', 'Looking for the extension…', 'No extension'];
  if (now - S.extSeen > 7000) return ['bad', 'Extension disconnected', 'No extension'];
  if (now - S.lastFail < 5000) return ['warn', 'Playback command failed', ''];
  if (now - S.ytmAt > 6000) return ['wait', 'Waiting for YouTube Music', 'Open YT Music'];
  if (!S.track) return ['wait', 'No active track detected', 'Nothing playing'];
  return ['ok', 'Connected', S.playing ? 'Playing' : 'Paused'];
}
function updateStatus() {
  const [st, text] = computeStatus();
  const dot = $('#dot');
  dot.dataset.s = st; dot.setAttribute('aria-label', text); dot.title = text;
  $('#dot2').dataset.s = st; $('#connText').textContent = text;
  $('#hint').textContent = st !== 'ok' ? text : (S.vol != null && S.track ? 'Volume ' + S.vol + '%' : '');
  const ago = t => t ? ((Date.now() - t) / 1000).toFixed(1) + 's ago' : 'never';
  $('#diag').textContent =
    'Extension bridge seen: ' + ago(S.extSeen) + '\n' +
    'YouTube Music data:    ' + ago(S.ytmAt) + '\n' +
    'Last command:          ' + (S.lastCmd || '-') + '\n' +
    'Last command error:    ' + (S.lastErr || '-') + '\n' +
    'Lyrics lookup error:   ' + (S.lrErr || '-') + '\n' +
    'Arduino:               ' + $('#serStatus').textContent + '\n' +
    'Last Arduino message:  ' + (S.ser.rx || '-') + (S.ser.rxAt ? ' (' + ago(S.ser.rxAt) + ')' : '');
}

async function runCmd(name, value) {
  S.lastCmd = name + (value != null ? ' ' + value : '');
  const r = await sendCommand(name, value);
  if (!r.ok) { S.lastFail = Date.now(); S.lastErr = r.error || 'Command failed'; }
  else {
    S.lastErr = '';
    if (typeof r.playing === 'boolean') { S.playing = r.playing; S.stamp = Date.now(); }
    if (num(r.position) != null) { S.pos = r.position; S.stamp = Date.now(); }
    if (num(r.volume) != null) S.vol = r.volume;
  }
  render();
  return r;
}

$('#btnPlay').onclick = () => runCmd('playPause');
$('#btnPrev').onclick = () => runCmd('previous');
$('#btnNext').onclick = () => runCmd('next');
const seek = $('#seek');
seek.addEventListener('input', () => {
  S.dragging = true;
  seek.style.setProperty('--p', seek.value / 10 + '%');
  if (S.dur) $('#tCur').textContent = fmt(seek.value / 1000 * S.dur);
});
seek.addEventListener('change', async () => {
  if (S.dur) await runCmd('seek', seek.value / 1000 * S.dur);
  S.dragging = false; render();
});

/* ------------------------------------------------------------------ *
 * Modes
 * ------------------------------------------------------------------ */
function setMode(m) {
  S.mode = m === 'lyrics' ? 'lyrics' : 'player';
  const lm = S.mode === 'lyrics';
  S.searching = false; applyViews();
  document.querySelector('.app').classList.toggle('lm', lm);
  // the cloud menu button lives in the top bar, or in the lyrics header (lyrics-only screen)
  (lm ? $('#lySlot') : $('#topbar')).prepend(document.querySelector('.menuwrap'));
  $('#btnMode').textContent = lm ? 'Show Now Playing' : 'Show lyrics';
  closeMenu();
  if (lm) { S.lyIdx = -2; renderLyrics(); }
}
$('#tabLyrics').onclick = () => setMode('lyrics');
$('.lyr-id').onclick = () => setMode('player');
$('#btnMode').onclick = () => setMode(S.mode === 'lyrics' ? 'player' : 'lyrics');

/* ------------------------------------------------------------------ *
 * Lyrics. Sources: (1) text the user saved, (2) text the extension read
 * from the YouTube Music lyrics tab (plain, never timed).
 * Highlighting only happens when the text has real [mm:ss.xx] timestamps.
 * ------------------------------------------------------------------ */
const LS = 'cloudy.lyrics.v1';
const loadSaved = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
const storeSaved = o => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch { /* storage blocked */ } };

function parseLyrics(text) {
  const lineRe = /^((?:\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)\s*(.*)$/;
  const tagRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const timed = [], plain = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(lineRe);
    if (m) {
      for (const t of m[1].matchAll(tagRe))
        timed.push({ t: +t[1] * 60 + +t[2] + (t[3] ? parseFloat('0.' + t[3]) : 0), text: m[2].trim() });
    } else if (!/^\s*\[[a-z]+:.*\]\s*$/i.test(raw)) plain.push({ t: null, text: raw.trim() });
  }
  if (timed.length >= 2) return { synced: true, lines: timed.sort((a, b) => a.t - b.t) };
  return { synced: false, lines: text.split(/\r?\n/).map(x => ({ t: null, text: x.trim() })) };
}

function lyricsSource() {
  if (!S.key) return null;
  const saved = loadSaved()[S.key];
  if (saved) return { text: saved, from: 'saved' };
  const lr = S.lr[S.key];
  if (lr && lr.synced) return { text: lr.synced, from: 'lrclib' };            // real timestamps
  if (S.ytmLyrics.key === S.key && S.ytmLyrics.text) return { text: S.ytmLyrics.text, from: 'ytm' };
  if (lr && lr.plain) return { text: lr.plain, from: 'lrclib-plain' };
  return null;
}

/* Optional online lookup of TIMESTAMPED lyrics at lrclib.net (free, no key).
   It sends the song title, first artist and length to lrclib.net. Turn it off in the cloud menu. */
function maybeLookup() { if (S.lrOn && S.track && S.dur && S.lr[S.key] === undefined) lookupLyrics(); }
async function lookupLyrics() {
  const t = S.track, key = S.key, dur = Math.round(S.dur);
  S.lr[key] = 'loading'; S.lyShown = '';
  const base = 'https://lrclib.net/api/';
  const first = (t.artist || '').split(',')[0].trim();
  const q = o => Object.entries(o).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const pick = r => (r && (r.syncedLyrics || r.plainLyrics)) ? { synced: r.syncedLyrics || '', plain: r.plainLyrics || '' } : null;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
  let res = null;
  try {
    const r = await fetch(base + 'get?' + q({ track_name: t.title, artist_name: first, duration: dur }), { signal: ctl.signal });
    if (r.ok) res = pick(await r.json());
    if (!res || !res.synced) {                                                // fallback: search, same length +/- 3 s
      const r2 = await fetch(base + 'search?' + q({ track_name: t.title, artist_name: first }), { signal: ctl.signal });
      if (r2.ok) {
        const list = await r2.json();
        const ok = (Array.isArray(list) ? list : []).filter(x => x && typeof x.duration === 'number' &&
          Math.abs(x.duration - dur) <= 3 && (x.syncedLyrics || x.plainLyrics));
        const p = pick(ok.find(x => x.syncedLyrics) || ok[0]);
        if (p && (!res || p.synced)) res = p;
      }
    }
    S.lrErr = '';
  } catch (e) { S.lrErr = String(e && e.message || e); res = null; }
  clearTimeout(to);
  S.lr[key] = res; S.lyShown = '';
  if (key === S.key) renderLyrics();
}

function renderLyrics() {
  const box = $('#lyBox'), note = $('#lyNote');
  const src = lyricsSource();
  const loading = !src && S.lr[S.key] === 'loading';
  const sig = src ? src.from + ':' + src.text.length + ':' + src.text.slice(0, 40) : (loading ? 'loading:' : 'none:') + S.key;
  if (sig !== S.lyShown) {
    S.lyShown = sig; S.lyIdx = -2; box.textContent = '';
    if (!src) {
      S.lyParsed = null; box.classList.remove('plain');
      const p = document.createElement('p'); p.className = 'empty';
      p.textContent = !S.track ? 'Play a song in YouTube Music first.'
        : loading ? 'Looking for lyrics…'
        : 'No lyrics found. Open the Lyrics tab in YouTube Music, or tap ✎ to paste your own.';
      box.appendChild(p); note.textContent = '';
    } else {
      const L = S.lyParsed = parseLyrics(src.text);
      box.classList.toggle('plain', !L.synced);
      for (const l of L.lines) {
        const p = document.createElement('p');
        if (L.synced) { p.textContent = l.text || '♪'; p.dataset.t = l.t; }   // click a line to jump there
        else if (l.text) p.textContent = l.text; else p.className = 'gap';
        box.appendChild(p);
      }
      note.textContent = L.synced
        ? (src.from === 'lrclib' ? 'Synced lyrics from lrclib.net · tap a line to jump' : 'Synced using your timestamps · tap a line to jump')
        : 'Not synced (no timestamps available for this song)';
    }
  }
  // current line (only with real timestamps)
  let idx = -1;
  const L = S.lyParsed;
  if (L && L.synced) {
    const p = curPos();
    if (p != null) for (let i = 0; i < L.lines.length; i++) { if (L.lines[i].t <= p + 0.15) idx = i; else break; }
  }
  if (idx !== S.lyIdx) {
    S.lyIdx = idx;
    const kids = box.children;
    for (let i = 0; i < kids.length; i++) { kids[i].classList.toggle('on', i === idx); kids[i].classList.toggle('past', i < idx); }
    if (idx >= 0 && S.mode === 'lyrics' && kids[idx])
      box.scrollTo({ top: kids[idx].offsetTop - box.clientHeight / 2 + kids[idx].clientHeight / 2, behavior: REDUCED ? 'auto' : 'smooth' });
  }
  S.lcdLyric = !L ? 'No lyrics yet' : L.synced ? (idx >= 0 ? (L.lines[idx].text || '...') : '...') : 'Lyrics on screen';
}
$('#lyBox').addEventListener('click', e => {
  const p = e.target.closest('p[data-t]');
  if (p) runCmd('seek', parseFloat(p.dataset.t));
});

function showEditor(on) { $('#lyEdit').hidden = !on; $('#lyBox').hidden = on; }
$('#btnEdit').onclick = () => {
  if (!S.key) return;
  setMode('lyrics'); showEditor(true);
  const s = lyricsSource(); $('#lyText').value = s ? s.text : ''; $('#lyText').focus();
};
$('#lyCancel').onclick = () => showEditor(false);
$('#lySave').onclick = () => {
  if (!S.key) return;
  const o = loadSaved(), v = $('#lyText').value.trim();
  if (v) o[S.key] = v.slice(0, 20000); else delete o[S.key];
  storeSaved(o); S.lyShown = ''; showEditor(false); renderLyrics();
};
$('#lyClear').onclick = () => {
  const o = loadSaved(); delete o[S.key]; storeSaved(o);
  $('#lyText').value = ''; S.lyShown = ''; showEditor(false); renderLyrics();
};

/* ------------------------------------------------------------------ *
 * Cloud menu
 * ------------------------------------------------------------------ */
const menu = $('#menu'), btnMenu = $('#btnMenu');
function closeMenu() { menu.hidden = true; btnMenu.setAttribute('aria-expanded', 'false'); }
btnMenu.onclick = e => {
  e.stopPropagation();
  const open = menu.hidden;
  menu.hidden = !open; btnMenu.setAttribute('aria-expanded', String(open));
};
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
try { S.lrOn = localStorage.getItem('cloudy.lrclib') !== '0'; } catch { /* storage blocked */ }
$('#lrOn').checked = S.lrOn;
$('#lrOn').onchange = () => {
  S.lrOn = $('#lrOn').checked;
  try { localStorage.setItem('cloudy.lrclib', S.lrOn ? '1' : '0'); } catch { /* ignore */ }
  S.lr = {}; S.lyShown = ''; maybeLookup(); renderLyrics();
};

/* ------------------------------------------------------------------ *
 * Arduino over Web Serial. Protocol (one message per line, "KEY|value"):
 *   Arduino -> site: HELLO|CloudyMusic1, BTN|SHORT, BTN|LONG, POT|0..100
 *   Site -> Arduino: MODE|PLAYER|LYRICS, TITLE|, ARTIST|, STATUS|, LYRIC|, PING|
 * Text is ASCII-only, max 80 chars, with "|" and control characters removed.
 * ------------------------------------------------------------------ */
const lcd = (s, n = 80) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[|\r\n\t]/g, ' ').replace(/[^\x20-\x7E]/g, '?').replace(/\s+/g, ' ').trim().slice(0, n);

function serialLine(line) {            // queued, 40 ms apart, so the UNO's 64-byte RX buffer never overflows
  if (!S.ser.open) return;
  S.q.push(line + '\n');
  if (!S.qTimer) S.qTimer = setTimeout(drain, 0);
}
async function drain() {
  S.qTimer = null;
  const s = S.ser;
  if (!s.open || !s.writer || !S.q.length) return;
  try { await s.writer.write(S.q.shift()); }
  catch (e) { serialClose('Could not write to the Arduino: ' + e.message); return; }
  if (S.q.length) S.qTimer = setTimeout(drain, 40);
}

function syncArduino(force) {
  if (!S.ser.open) return;
  const st = computeStatus();
  const t = S.track;
  const m = {
    MODE: S.mode === 'lyrics' ? 'LYRICS' : 'PLAYER',
    TITLE: lcd(t ? t.title : ''),
    ARTIST: lcd(t ? (t.artist || t.album) : ''),
    STATUS: lcd(st[2], 32),
    LYRIC: lcd(S.lcdLyric),
  };
  for (const k in m) if (force || S.sent[k] !== m[k]) { S.sent[k] = m[k]; serialLine(k + '|' + m[k]); }
}
setInterval(() => syncArduino(false), 400);
setInterval(() => serialLine('PING|'), 2000);

let volTimer = null, volWanted = 0;
function onPot(v) {
  volWanted = v; S.vol = v;
  if (volTimer) return;
  volTimer = setTimeout(async () => { volTimer = null; await runCmd('setVolume', volWanted); }, 150);
}

function onSerialLine(line) {
  S.ser.rx = line.slice(0, 40); S.ser.rxAt = Date.now();
  const i = line.indexOf('|');
  const k = i < 0 ? line : line.slice(0, i), a = i < 0 ? '' : line.slice(i + 1);
  if (k === 'HELLO') syncArduino(true);
  else if (k === 'BTN' && a === 'SHORT') runCmd('playPause');
  else if (k === 'BTN' && a === 'LONG') { setMode(S.mode === 'player' ? 'lyrics' : 'player'); syncArduino(false); }
  else if (k === 'POT') { const v = parseInt(a, 10); if (v >= 0 && v <= 100) onPot(v); }
}

function setSerUI(text, open) {
  $('#serStatus').textContent = text;
  $('#btnConnect').hidden = !!open; $('#btnDisconnect').hidden = !open;
}

async function readLoop(reader) {
  const s = S.ser;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      s.buf += value;
      let i;
      while ((i = s.buf.indexOf('\n')) >= 0) { onSerialLine(s.buf.slice(0, i).replace(/\r$/, '')); s.buf = s.buf.slice(i + 1); }
      if (s.buf.length > 500) s.buf = '';
    }
    if (s.open) serialClose('The Arduino stopped sending data.');
  } catch (e) {
    if (s.open) serialClose('Arduino connection lost (' + e.message + ').');
  }
}

async function serialConnect() {
  if (!('serial' in navigator)) { setSerUI('Web Serial is not available. Use Microsoft Edge on http://localhost:8765.', false); return; }
  const s = S.ser;
  try {
    s.port = await navigator.serial.requestPort();     // must come from a click
    await s.port.open({ baudRate: 9600 });
    const dec = new TextDecoderStream();
    s.rc = s.port.readable.pipeTo(dec.writable).catch(() => {});
    s.reader = dec.readable.getReader();
    const enc = new TextEncoderStream();
    s.wc = enc.readable.pipeTo(s.port.writable).catch(() => {});
    s.writer = enc.writable.getWriter();
    s.open = true; s.buf = ''; S.sent = {}; S.q = [];
    setSerUI('Connected. The Arduino restarts for about 2 seconds…', true);
    readLoop(s.reader);
    setTimeout(() => { if (s.open) { syncArduino(true); setSerUI('Connected', true); } }, 2500);
  } catch (e) {
    s.port = null;
    setSerUI(e.name === 'NotFoundError' ? 'No port selected.' :
      'Could not open the port: ' + e.message + ' (close the Arduino IDE Serial Monitor and try again)', false);
  }
}

async function serialClose(reason, graceful) {
  const s = S.ser;
  if (!s.port) return;
  const wasOpen = s.open; s.open = false;
  clearTimeout(S.qTimer); S.qTimer = null; S.q = [];
  if (graceful && wasOpen && s.writer) {
    try { await s.writer.write('TITLE|\nARTIST|\nLYRIC|\nSTATUS|Cloudy closed\n'); } catch { /* ignore */ }
  }
  try { if (s.reader) await s.reader.cancel(); } catch { /* ignore */ }
  try { if (s.rc) await s.rc; } catch { /* ignore */ }
  try { if (s.writer) await s.writer.close(); } catch { /* ignore */ }
  try { if (s.wc) await s.wc; } catch { /* ignore */ }
  try { await s.port.close(); } catch { /* ignore */ }
  s.port = s.reader = s.writer = s.rc = s.wc = null; S.sent = {};
  setSerUI(reason || 'Not connected', false);
}

$('#btnConnect').onclick = () => { closeMenu(); serialConnect(); };
$('#btnDisconnect').onclick = () => serialClose('Not connected', true);
if ('serial' in navigator) navigator.serial.addEventListener('disconnect', e => {
  if (e.target === S.ser.port) serialClose('Arduino unplugged.');
});

/* ------------------------------------------------------------------ *
 * Search. Cloudy asks the extension to search inside your YouTube Music tab, then reads the
 * result list from that page and plays the one you tap. Experimental: it depends on YouTube Music's
 * page layout. If the list can't be read, the results are still open in the YouTube Music tab.
 * ------------------------------------------------------------------ */
function applyViews() {
  $('#viewSearch').hidden = !S.searching;
  $('#viewPlayer').hidden = S.searching || S.mode !== 'player';
  $('#viewLyrics').hidden = S.searching || S.mode !== 'lyrics';
}
let searchId = 0;
const srchNote = t => { $('#srchNote').textContent = t || ''; };
const wait = ms => new Promise(r => setTimeout(r, ms));

function closeSearch() { searchId++; S.searching = false; applyViews(); }

async function doSearch(q) {
  q = q.trim().slice(0, 100);
  if (!q) return;
  const id = ++searchId;
  S.searching = true; applyViews(); closeMenu();
  $('#srchHead').textContent = 'Results for “' + q + '”';
  $('#srchList').textContent = '';
  srchNote('Searching YouTube Music…');
  const r = await sendCommand('search', q);
  if (id !== searchId) return;
  if (!r.ok) { S.lastErr = r.error || 'Search failed'; srchNote(r.error || 'Search failed. Is YouTube Music open in a tab?'); return; }
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && id === searchId) {
    await wait(900);
    if (id !== searchId) return;
    const g = await sendCommand('getResults', q);          // the page may still be loading: just try again
    if (g.ok && g.results && g.results.length) { if (id === searchId) showResults(g.results); return; }
  }
  if (id === searchId) srchNote('Could not read the results. They are open in your YouTube Music tab: pick one there.');
}

function showResults(list) {
  const ul = $('#srchList');
  ul.textContent = ''; srchNote('');
  for (const it of list) {
    const li = document.createElement('li'), b = document.createElement('button');
    const th = document.createElement('span'), tx = document.createElement('span');
    th.className = 'th'; tx.className = 'tx';
    if (it.art) {
      const im = document.createElement('img'); im.alt = ''; im.referrerPolicy = 'no-referrer'; im.src = it.art;
      im.onerror = () => im.remove(); th.appendChild(im);
    } else th.textContent = '♪';
    const t = document.createElement('b'), s = document.createElement('small');
    t.textContent = it.title; s.textContent = it.sub;
    tx.append(t, s); b.append(th, tx);
    b.onclick = () => playResult(it.index);
    li.appendChild(b); ul.appendChild(li);
  }
}

async function playResult(i) {
  srchNote('Starting…');
  const r = await sendCommand('playResult', i);
  if (r.ok) { setMode('player'); } else { S.lastErr = r.error || ''; srchNote(r.error || 'Could not start it.'); }
}
$('#searchForm').onsubmit = e => { e.preventDefault(); doSearch($('#q').value); };
$('#srchBack').onclick = closeSearch;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.searching) closeSearch(); });

/* Falling snow: many flakes spread across the width, each with its own size, speed and start time,
   so several are always on screen at different positions. With reduced motion they just sit scattered. */
(function snow() {
  const box = $('#snow'), glyphs = ['❄', '❅', '❆', '•', '❄', '•', '❅'];
  const n = REDUCED ? 24 : 70, r = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'flake';
    s.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
    s.style.left = ((i + Math.random()) / n * 100).toFixed(1) + '%';      // evenly spread, slightly jittered
    s.style.fontSize = r(9, 26).toFixed(0) + 'px';
    s.style.opacity = r(.55, 1).toFixed(2);
    const d = r(7, 24);                                                    // fall time: fast and slow flakes
    s.style.setProperty('--d', d.toFixed(1) + 's');
    s.style.setProperty('--dl', '-' + r(0, d).toFixed(1) + 's');           // start part-way down: no empty start
    s.style.setProperty('--x', r(-80, 80).toFixed(0) + 'px');
    if (REDUCED) s.style.top = r(2, 95) + '%';
    box.appendChild(s);
  }
})();

setMode('player');
onTrackChange();
render();
})();
