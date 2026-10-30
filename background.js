/* Cloudy Music Bridge - background service worker (stateless router).
 *
 * YouTube Music tab --YTM_STATE / YTM_LYRICS--> here --> every Cloudy tab
 * Cloudy tab --CLOUDY_COMMAND--> here --COMMAND--> the YouTube Music tab --result--> back
 *
 * Messages are only accepted from the exact origins below (sender.url is set by the browser,
 * so a random website cannot pretend to be one of them).
 */
const YTM = 'https://music.youtube.com/';
const CLOUDY_ORIGINS = ['http://localhost:8765/', 'http://127.0.0.1:8765/'];
const CLOUDY_PATTERNS = CLOUDY_ORIGINS.map(o => o + '*').concat(['https://*.github.io/*']);
// GitHub Pages sites look like https://yourname.github.io/... . To lock Cloudy to ONE address, replace this regex
// (and the two github.io lines in manifest.json) with your exact address, e.g. /^https:\/\/yourname\.github\.io\/cloudy-music\//
const GITHUB_PAGES = /^https:\/\/[a-z0-9-]+\.github\.io\//;
const COMMANDS = new Set(['playPause', 'next', 'previous', 'seek', 'setVolume', 'search', 'getResults', 'playResult']);

const fromYtm = s => !!(s.tab && typeof s.url === 'string' && s.url.startsWith(YTM));
const fromCloudy = s => !!(s.tab && typeof s.url === 'string' && (CLOUDY_ORIGINS.some(o => s.url.startsWith(o)) || GITHUB_PAGES.test(s.url)));

async function toCloudy(msg) {
  const tabs = await chrome.tabs.query({ url: CLOUDY_PATTERNS });
  for (const t of tabs) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
}
async function ytmTab() {
  const tabs = await chrome.tabs.query({ url: YTM + '*' });
  return tabs.find(t => t.audible) || tabs[0] || null;   // prefer the tab that is making sound
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'YTM_STATE' || msg.type === 'YTM_LYRICS') {
    if (fromYtm(sender)) toCloudy(msg);
    return false;
  }

  if (msg.type === 'CLOUDY_COMMAND') {
    if (!fromCloudy(sender) || !COMMANDS.has(msg.command)) return false;
    let value = msg.value;
    if (msg.command === 'seek' && !(typeof value === 'number' && isFinite(value) && value >= 0)) {
      sendResponse({ ok: false, error: 'Bad seek position.' }); return false;
    }
    if (msg.command === 'setVolume' && !(typeof value === 'number' && value >= 0 && value <= 100)) {
      sendResponse({ ok: false, error: 'Bad volume.' }); return false;
    }
    if (msg.command === 'search' && !(typeof value === 'string' && value.trim().length >= 1 && value.length <= 100)) {
      sendResponse({ ok: false, error: 'Bad search.' }); return false;
    }
    if (msg.command === 'getResults' && !(value === undefined || (typeof value === 'string' && value.length <= 100))) {
      sendResponse({ ok: false, error: 'Bad request.' }); return false;
    }
    if (msg.command === 'playResult' && !(Number.isInteger(value) && value >= 0 && value < 50)) {
      sendResponse({ ok: false, error: 'Bad result number.' }); return false;
    }
    (async () => {
      const tab = await ytmTab();
      if (!tab) { sendResponse({ ok: false, error: 'No YouTube Music tab is open.' }); return; }
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'COMMAND', command: msg.command, value });
        sendResponse(r || { ok: false, error: 'YouTube Music did not answer.' });
      } catch (e) {
        sendResponse({ ok: false, error: 'YouTube Music tab is not responding. Reload it (F5).' });
      }
    })();
    return true;   // async response
  }

  if (msg.type === 'CLOUDY_GET_STATE') {
    if (!fromCloudy(sender)) return false;
    (async () => {
      const tab = await ytmTab();
      if (tab) {
        try {
          const r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
          if (r && r.state) toCloudy({ type: 'YTM_STATE', state: r.state });
          if (r && r.lyrics) toCloudy({ type: 'YTM_LYRICS', lyrics: r.lyrics });
        } catch (e) { /* tab not ready yet */ }
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});

// If the last YouTube Music tab is closed, tell Cloudy right away (so the LCD does not keep a stale title).
chrome.tabs.onRemoved.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: YTM + '*' });
  if (!tabs.length) toCloudy({ type: 'YTM_CLOSED' });
});
