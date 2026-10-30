/* Cloudy Music Bridge - content script injected into the Cloudy page (localhost:8765 or GitHub Pages).
 * It is the only piece that can talk to both the page (postMessage) and the extension (chrome.runtime).
 *
 * page -> here:  {source:'cloudy-page', type:'HELLO'|'GET_STATE'|'COMMAND', id, command, value}
 * here -> page:  {source:'cloudy-ext',  type:'READY'|'STATE'|'LYRICS'|'YTM_CLOSED'|'RESULT', ...}
 */
(() => {
  const ORIGIN = location.origin;
  const COMMANDS = ['playPause', 'next', 'previous', 'seek', 'setVolume', 'search', 'getResults', 'playResult'];
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  const post = m => window.postMessage({ source: 'cloudy-ext', ...m }, ORIGIN);

  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== ORIGIN) return;       // same window + same origin only
    const d = e.data;
    if (!d || d.source !== 'cloudy-page' || !alive()) return;

    if (d.type === 'HELLO') { post({ type: 'READY', version: '1.0.0' }); return; }

    if (d.type === 'GET_STATE') {
      chrome.runtime.sendMessage({ type: 'CLOUDY_GET_STATE' }).catch(() => {});
      return;
    }

    if (d.type === 'COMMAND') {
      const id = d.id;
      if (typeof id !== 'number' || !COMMANDS.includes(d.command)) return;
      const isText = (d.command === 'search' || d.command === 'getResults') && typeof d.value === 'string' && d.value.length <= 100;
      const value = (typeof d.value === 'number' || isText) ? d.value : undefined;
      chrome.runtime.sendMessage({ type: 'CLOUDY_COMMAND', command: d.command, value })
        .then(r => {
          r = r || {};
          post({ type: 'RESULT', id, result: {
            ok: r.ok === true, error: typeof r.error === 'string' ? r.error : undefined,
            playing: typeof r.playing === 'boolean' ? r.playing : undefined,
            position: typeof r.position === 'number' ? r.position : undefined,
            volume: typeof r.volume === 'number' ? r.volume : undefined,
            results: Array.isArray(r.results) ? r.results.slice(0, 20).map(x => ({
              index: (x && x.index) | 0,
              title: String(x && x.title || '').slice(0, 120),
              sub: String(x && x.sub || '').slice(0, 140),
              art: /^https:\/\//.test(String(x && x.art || '')) ? String(x.art).slice(0, 500) : '' })) : undefined } });
        })
        .catch(err => post({ type: 'RESULT', id, result: { ok: false, error: String(err && err.message || err) } }));
    }
  });

  // Forward what the YouTube Music tab reports (relayed by the background worker).
  try {
    chrome.runtime.onMessage.addListener(msg => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'YTM_STATE' && msg.state && typeof msg.state === 'object') post({ type: 'STATE', state: msg.state });
      else if (msg.type === 'YTM_LYRICS' && msg.lyrics && typeof msg.lyrics.text === 'string') post({ type: 'LYRICS', lyrics: msg.lyrics });
      else if (msg.type === 'YTM_CLOSED') post({ type: 'YTM_CLOSED' });
    });
  } catch (e) { /* extension was reloaded; refresh the page */ }
})();
