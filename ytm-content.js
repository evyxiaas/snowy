/* Cloudy Music Bridge - content script injected into music.youtube.com.
 * Reads what the visible player bar shows (DOM) plus the page's <video> element, and performs
 * commands by clicking the same buttons you would click. No private APIs, no cookies, no tokens.
 *
 * YouTube Music can change its page at any time; the selectors below are the part most likely to break.
 */
(() => {
  if (window.__cloudyYtm) return;
  window.__cloudyYtm = true;

  const $ = s => document.querySelector(s);
  const bar = () => $('ytmusic-player-bar');
  const txt = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fail = error => ({ ok: false, error });

  /* ---------- reading ---------- */
  function bigArt(url) {                       // the bar shows a 60px thumbnail; ask Google's CDN for a bigger one
    if (!url || url.startsWith('data:')) return '';
    return url.replace(/=w\d+-h\d+[-\w]*$/, '=w544-h544-l90-rj');
  }

  function readTrack() {
    const b = bar(); if (!b) return null;
    const title = txt(b.querySelector('.title'));
    if (!title) return null;
    let artist = '', album = '';
    const by = b.querySelector('.byline');
    if (by) {
      const links = [...by.querySelectorAll('a')];
      artist = links.filter(a => /channel\//.test(a.getAttribute('href') || '')).map(txt).join(', ');
      const al = links.find(a => /browse\/MPRE/.test(a.getAttribute('href') || ''));
      album = al ? txt(al) : '';
      if (!artist) artist = txt(by).split('•')[0].trim();   // fallback: "Artist • Album • Year"
    }
    const img = b.querySelector('img.image') || b.querySelector('#song-image img');
    return { title, artist, album, art: bigArt(img ? img.currentSrc || img.src : '') };
  }

  function snapshot() {
    const v = $('video'), track = readTrack();
    const dur = v && isFinite(v.duration) && v.duration > 0 ? v.duration : null;   // null = unknown, never faked
    return {
      track,
      playing: !!v && !v.paused && !v.ended,
      position: v && isFinite(v.currentTime) ? v.currentTime : null,
      duration: dur,
      volume: v ? Math.round(v.volume * 100) : null,
    };
  }
  const trackKey = () => { const t = readTrack(); return t ? t.title + '|' + t.artist : ''; };

  /* Lyrics: only readable when the person has opened the "Lyrics" tab of the YouTube Music side panel.
     UNVERIFIED selectors - best effort. Always plain text, never timestamps. */
  function readLyrics() {
    const tabs = [...document.querySelectorAll('tp-yt-paper-tab')];
    const sel = tabs.find(t => t.getAttribute('aria-selected') === 'true');
    if (!sel || !/lyrics/i.test(txt(sel))) return '';
    const shelf = document.querySelector('ytmusic-description-shelf-renderer');
    const el = shelf && (shelf.querySelector('.description') || shelf.querySelector('yt-formatted-string'));
    const text = el ? (el.innerText || '').trim() : '';
    return /^lyrics not available/i.test(text) ? '' : text.slice(0, 20000);
  }

  /* ---------- sending ---------- */
  let timer = null, obs = null, observed = null, boundVideo = null;
  function shutdown() { clearInterval(timer); if (obs) obs.disconnect(); }
  function post(m) {
    try { chrome.runtime.sendMessage(m).catch(() => {}); }
    catch (e) { shutdown(); }                    // extension was reloaded: this old script must stop
  }

  let lastSig = '', lastAt = 0, lastKey = '', lastLyr = '', staleLyr = '', keyChangedAt = 0, lastLyrSent = '';
  function push(force) {
    const s = snapshot(), now = Date.now();
    const sig = JSON.stringify([s.track, s.playing, s.duration]);
    if (force || sig !== lastSig || now - lastAt >= (s.playing ? 1000 : 3000)) {
      lastSig = sig; lastAt = now;
      post({ type: 'YTM_STATE', state: s });
    }
    const key = s.track ? s.track.title + '|' + s.track.artist : '';
    if (key !== lastKey) { lastKey = key; keyChangedAt = now; staleLyr = lastLyr; lastLyrSent = ''; }
    const lyr = readLyrics();
    lastLyr = lyr;
    // After a track change the lyrics panel may still show the previous song for a moment: ignore it.
    if (lyr && key && now - keyChangedAt > 1500 && lyr !== staleLyr && lyr !== lastLyrSent) {
      lastLyrSent = lyr;
      post({ type: 'YTM_LYRICS', lyrics: { trackKey: key, text: lyr } });
    }
  }

  let debounce = null;
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => push(false), 150); };

  function attach() {
    const b = bar();
    if (b && b !== observed) {                   // watch the player bar for title/artist/art changes
      if (obs) obs.disconnect();
      observed = b;
      obs = new MutationObserver(schedule);
      obs.observe(b, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    const v = $('video');
    if (v && v !== boundVideo) {                 // react immediately to play / pause / seek
      boundVideo = v;
      ['play', 'pause', 'seeked', 'loadedmetadata', 'durationchange', 'ended', 'volumechange']
        .forEach(ev => v.addEventListener(ev, () => push(true)));
    }
  }

  timer = setInterval(() => { attach(); push(false); }, 1000);   // 1 light read per second
  attach(); push(true);

  /* ---------- commands ---------- */
  async function waitFor(fn, ms = 2000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(100); }
    return !!fn();
  }

  /* ---------- search (UNVERIFIED selectors: YouTube Music's search page layout) ---------- */
  const resultItems = () => [...document.querySelectorAll('ytmusic-responsive-list-item-renderer')];
  function readResults() {
    return resultItems().slice(0, 20).map((el, i) => {
      const img = el.querySelector('img');
      const src = img ? (img.currentSrc || img.src || '') : '';
      return {
        index: i,
        title: txt(el.querySelector('.title-column .title') || el.querySelector('yt-formatted-string.title')),
        sub: txt(el.querySelector('.secondary-flex-columns')),
        art: src.startsWith('https://') ? src.replace(/=w\d+-h\d+[-\w]*$/, '=w120-h120-l90-rj') : '',
      };
    }).filter(r => r.title);
  }
  const urlQuery = () => new URLSearchParams(location.search).get('q');

  async function run(cmd, value) {
    if (cmd === 'search') {
      const q = String(value || '').trim().slice(0, 100);
      if (!q) return fail('Empty search.');
      // 1) type into YouTube Music's own search box (keeps the current song playing)
      const box = document.querySelector('ytmusic-search-box input');
      if (box) {
        try {
          box.focus(); box.value = q;
          box.dispatchEvent(new Event('input', { bubbles: true }));
          for (const t of ['keydown', 'keypress', 'keyup'])
            box.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        } catch (e) { /* fall through to the reliable way */ }
        if (await waitFor(() => location.pathname === '/search' && urlQuery() === q, 2500)) return { ok: true };
      }
      // 2) reliable fallback: open the search page (reloads the tab, so the current song stops)
      setTimeout(() => location.assign('/search?q=' + encodeURIComponent(q)), 80);
      return { ok: true };
    }
    if (cmd === 'getResults') {
      const onPage = location.pathname === '/search' && (!value || urlQuery() === value);
      return { ok: true, results: onPage ? readResults() : [] };
    }
    if (cmd === 'playResult') {
      const el = resultItems()[value];
      if (!el) return fail('That result is no longer on the page.');
      const k = trackKey();
      const tries = [
        () => { const p = el.querySelector('ytmusic-play-button-renderer'); if (p) (p.querySelector('#play-button') || p).click(); },
        () => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })),
      ];
      for (const t of tries) {
        t();
        if (await waitFor(() => trackKey() !== k, 3500)) return { ok: true };
      }
      return fail('YouTube Music did not start it. Click the song in the YouTube Music tab instead.');
    }

    const v = $('video'), b = bar();
    if (!v || !b) return fail('The YouTube Music player is not ready on this tab.');

    if (cmd === 'playPause') {
      const was = !v.paused, btn = b.querySelector('#play-pause-button');
      if (btn) btn.click(); else if (was) v.pause(); else { try { await v.play(); } catch (e) { return fail(String(e.message || e)); } }
      const ok = await waitFor(() => (!v.paused) !== was, 1500);
      return ok ? { ok: true, playing: !v.paused } : fail('YouTube Music did not change between play and pause.');
    }

    if (cmd === 'next' || cmd === 'previous') {
      const btn = b.querySelector(cmd === 'next' ? '.next-button' : '.previous-button');
      if (!btn) return fail('Could not find the ' + cmd + ' button on the page.');
      const k = trackKey(), t0 = v.currentTime;
      btn.click();
      // "Previous" restarts the song when it has played for more than a few seconds, so accept that as success too.
      const ok = await waitFor(() => trackKey() !== k || (cmd === 'previous' && t0 > 3 && v.currentTime < t0 - 1), 2500);
      return ok ? { ok: true, position: v.currentTime } : fail('The track did not change (end of the queue?).');
    }

    if (cmd === 'seek') {
      if (!(typeof value === 'number' && isFinite(value)) || !isFinite(v.duration)) return fail('Cannot seek: duration unknown.');
      const t = Math.max(0, Math.min(value, v.duration - 0.5));
      v.currentTime = t;
      const ok = await waitFor(() => Math.abs(v.currentTime - t) < 2.5, 1500);
      return ok ? { ok: true, position: v.currentTime } : fail('YouTube Music did not accept the seek.');
    }

    if (cmd === 'setVolume') {
      const n = Math.max(0, Math.min(100, Math.round(value)));
      v.volume = n / 100;       // sets the player's real volume; YouTube Music's own slider may not move
      const ok = await waitFor(() => Math.abs(Math.round(v.volume * 100) - n) <= 2, 800);
      return ok ? { ok: true, volume: Math.round(v.volume * 100) } : fail('YouTube Music did not keep the new volume.');
    }
    return fail('Unknown command.');
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !msg) return false;   // only our own extension
      if (msg.type === 'GET_STATE') {
        const key = trackKey(), l = readLyrics();
        sendResponse({ state: snapshot(), lyrics: l && key ? { trackKey: key, text: l } : null });
        return false;
      }
      if (msg.type === 'COMMAND') {
        run(msg.command, msg.value).then(sendResponse).catch(e => sendResponse(fail(String(e && e.message || e))));
        return true;
      }
      return false;
    });
  } catch (e) { shutdown(); }
})();
