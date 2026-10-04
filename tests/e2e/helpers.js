'use strict';
// Shared tools for the browser tests: a pretend video site with real pages and a video that
// really plays, browser launchers (plain, and with the extension loaded), and small waiters.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { createApp } = require('../../server/app');
const { setupLogger } = require('../../server/logger');
const { call, wait } = require('../server/tools');

const EXTENSION_FOLDER = path.join(__dirname, '..', '..', 'extension');
const CLIP = fs.readFileSync(path.join(__dirname, 'fixtures', 'clip.webm'));
const CLIP_SECONDS = 90;
// Where the popup looks for the server until another address is saved in it.
const DEFAULT_POPUP_SERVER = 'http://127.0.0.1:8787';
const SITE_COOKIE = 'login=e2e-cookie-value';
// Lets a video with sound start without a key press, like a TV browser that allows it.
const AUTOPLAY = '--autoplay-policy=no-user-gesture-required';

// Two seconds of silence as a WAV file, for the page that has only an <audio> tag.
function silentWav() {
  const samples = 16000;
  const wav = Buffer.alloc(44 + samples, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  return wav;
}

const html = (title, body) => '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title></head><body>' + body + '</body></html>';

// The pages of the pretend site. `other` is the same site under its second name (localhost
// instead of 127.0.0.1), which the browser treats as a different site: used for the iframe.
function pages(other) {
  return {
    '/watch.html': html('Holiday film', '<video id="v" src="/media/clip.webm" autoplay muted loop width="320"></video>'),
    '/embed.html': html('Player frame', '<video id="v" src="/media/framed.webm" autoplay muted loop width="320"></video>'),
    '/iframe.html': html('Page with a player in a frame', '<h1>Frame</h1><iframe id="f" src="' + other + '/embed.html" width="400" height="300"></iframe>'),
    '/hls.html': html(
      'Live stream',
      '<script>fetch("/hls/master.m3u8?token=abc").then(function () { return Promise.all([fetch("/hls/low/seg1.ts"), fetch("/hls/low/seg2.ts"), fetch("/hls/low/seg3.ts")]); }).then(function () { document.title = "Live stream loaded"; });</script>'
    ),
    '/several.html': html(
      'Several videos',
      '<video id="a" src="/media/clip.webm" autoplay muted loop width="160"></video><video id="b" src="/media/trailer.webm" autoplay muted loop width="160"></video>' +
        '<script>fetch("/hls/master.m3u8"); fetch("/dash/manifest.mpd"); fetch("/data.json");</script>'
    ),
    '/numbered.html': html(
      'Two numbered videos',
      '<video id="a" src="/media/episode1.webm" autoplay muted loop width="160"></video><video id="b" src="/media/episode2.webm" autoplay muted loop width="160"></video>'
    ),
    // A protected player: asks for a key system, then sets the keys on its video.
    '/drm.html': html(
      'Protected film',
      '<video id="v" autoplay muted loop width="320"></video><script>' +
        'var v = document.getElementById("v");' +
        'navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{ initDataTypes: ["webm"], videoCapabilities: [{ contentType: \'video/webm; codecs="vp8"\' }], audioCapabilities: [{ contentType: \'audio/webm; codecs="opus"\' }] }])' +
        '.then(function (access) { return access.createMediaKeys(); }).then(function (keys) { return v.setMediaKeys(keys); })' +
        '.then(function () { v.src = "/media/clip.webm"; document.title = "drm set up"; }, function (error) { document.title = "drm failed: " + error; });</script>'
    ),
    // A page that only asks whether protected playback is possible, as many players do at start-up.
    '/drm-question.html': html(
      'Just asking',
      '<video id="v" src="/media/clip.webm" autoplay muted loop width="320"></video>' +
        '<script>navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{ initDataTypes: ["webm"], videoCapabilities: [{ contentType: \'video/webm; codecs="vp8"\' }] }])' +
        '.then(function () { document.title = "drm asked: ok"; }, function () { document.title = "drm asked: refused"; });</script>'
    ),
    '/blob.html': html(
      'Player that builds its video',
      '<video id="v" autoplay muted loop width="320"></video><script>fetch("/media/bytes").then(function (r) { return r.blob(); }).then(function (b) { document.getElementById("v").src = URL.createObjectURL(b); });</script>'
    ),
    '/audio.html': html('Just a song', '<audio id="a" src="/media/song.wav" autoplay muted loop></audio>'),
    '/plain.html': html('No video here', '<p>Nothing to watch.</p><script>fetch("/data.json");</script>')
  };
}

// A video site with real pages. Like many real sites it refuses a video request that does not
// carry a Referer from one of its own pages. Every request is kept in `seen`.
async function startVideoSite() {
  const seen = [];
  const wav = silentWav();
  let port = 0;
  const server = http.createServer((request, response) => {
    const route = request.url.split('?')[0];
    seen.push({ path: request.url, route, method: request.method, headers: request.headers });
    const origins = ['http://127.0.0.1:' + port, 'http://localhost:' + port];
    const send = (status, type, body, extra) => {
      response.writeHead(status, Object.assign({ 'content-type': type, 'cache-control': 'no-store' }, extra));
      response.end(body);
    };
    const page = pages(origins[1])[route];
    if (page) return send(200, 'text/html; charset=utf-8', page, route === '/watch.html' ? { 'set-cookie': SITE_COOKIE + '; Path=/' } : {});
    if (route === '/data.json') return send(200, 'application/json', '{}');
    if (route === '/favicon.ico') return send(404, 'text/plain', '');

    const referer = String(request.headers.referer || '');
    if (!origins.some((origin) => referer.startsWith(origin + '/'))) return send(403, 'text/plain', 'no referer, no video');

    if (/^\/media\/([a-z0-9]+\.webm|bytes)$/.test(route)) return sendWithRanges(request, response, CLIP, 'video/webm');
    if (route === '/media/eng.vtt') return send(200, 'text/vtt', 'WEBVTT\n\n00:05.000 --> 00:07.000\nFirst line\n\n00:10.000 --> 00:12.000\nSecond line\n');
    if (route === '/media/song.wav') return sendWithRanges(request, response, wav, 'audio/wav');
    if (route === '/hls/master.m3u8') return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n');
    if (route === '/hls/low/index.m3u8') {
      return send(200, 'application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nseg2.ts\n#EXTINF:4,\nseg3.ts\n#EXT-X-ENDLIST\n');
    }
    if (/^\/hls\/low\/seg\d\.ts$/.test(route)) return send(200, 'video/mp2t', Buffer.alloc(376, 0x47));
    if (route === '/dash/manifest.mpd') return send(200, 'application/dash+xml', '<MPD></MPD>');
    send(404, 'text/plain', 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    seen,
    port,
    link: (route) => 'http://127.0.0.1:' + port + route,
    otherLink: (route) => 'http://localhost:' + port + route,
    requestsFor: (route) => seen.filter((request) => request.route === route),
    stop() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

function sendWithRanges(request, response, bytes, type) {
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
  const common = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (!range) {
    response.writeHead(200, Object.assign({ 'content-length': bytes.length }, common));
    return response.end(request.method === 'HEAD' ? undefined : bytes);
  }
  const from = Number(range[1]);
  const to = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  const part = bytes.subarray(from, to + 1);
  response.writeHead(206, Object.assign({ 'content-range': 'bytes ' + from + '-' + to + '/' + bytes.length, 'content-length': part.length }, common));
  response.end(request.method === 'HEAD' ? undefined : part);
}

// Stands in for the part of the server that searches the home network for TVs and opens pages
// on them. Tests must never touch the real network or a real TV, so by default it finds nothing.
const NO_REAL_TVS = {
  findTvs: async () => [],
  openPageOnTv: async () => {
    throw Object.assign(new Error('tv_unreachable'), { code: 'tv_unreachable' });
  }
};

// Starts the VCast server inside the test process. Keeps server logs off the screen.
async function startApp(options) {
  setupLogger({ level: 'off' });
  const app = createApp(Object.assign({ listenOn: '127.0.0.1', wrongCodesPerMinute: 1000, tvRemote: NO_REAL_TVS }, options));
  const port = await app.start();
  return { app, port, stop: () => app.stop() };
}

// Waits until `check` returns something truthy and returns it. `what` goes in the failure text.
async function until(check, what, timeoutMs) {
  const endAt = Date.now() + (timeoutMs || 10000);
  let last;
  let lastError;
  for (;;) {
    try {
      last = await check();
      lastError = null;
      if (last) return last;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > endAt) {
      throw new Error('Timed out waiting for: ' + what + (lastError ? ' (last error: ' + lastError.message + ')' : ' (last value: ' + JSON.stringify(last) + ')'));
    }
    await wait(100);
  }
}

// The TV page uses the first remote key press to go full screen. Most tests are about what the
// keys do after that, so they run in a browser that says it has no full screen.
function withoutFullScreen() {
  for (const name of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
    Object.defineProperty(Element.prototype, name, { value: undefined, configurable: true });
  }
}

async function launchBrowser(options) {
  options = options || {};
  const browser = await chromium.launch({ args: options.autoplay === false ? [] : [AUTOPLAY] });
  if (options.fullScreen) return browser;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (contextOptions) => {
    const context = await newContext(contextOptions);
    await context.addInitScript(withoutFullScreen);
    return context;
  };
  return browser;
}

// Starts Chromium with the VCast extension loaded. Returns the browser context, the extension's
// service worker and the extension id.
async function launchWithExtension() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vcast-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: ['--disable-extensions-except=' + EXTENSION_FOLDER, '--load-extension=' + EXTENSION_FOLDER, AUTOPLAY]
  });
  await context.addInitScript(withoutFullScreen);
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const extensionId = new URL(worker.url()).host;
  await untilExtensionSeesRequests(context, worker);
  return {
    context,
    worker,
    extensionId,
    popupLink: 'chrome-extension://' + extensionId + '/popup.html',
    // Saves the server address in the extension, as the popup's own "Save" button does.
    useServer: (port) => worker.evaluate((address) => chrome.storage.local.set({ serverAddress: address }), 'http://127.0.0.1:' + port),
    // Everything the extension keeps about tabs, as { 'tab:<id>': info }.
    savedTabs: () => worker.evaluate(() => chrome.storage.session.get(null)),
    tabIdOf: (link) => worker.evaluate(async (url) => ((await chrome.tabs.query({})).find((tab) => tab.url === url) || {}).id, link),
    async tabInfoOf(link) {
      const id = await this.tabIdOf(link);
      return id === undefined ? undefined : (await this.savedTabs())['tab:' + id];
    },
    async close() {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  };
}

// For a moment after the browser starts, the extension is not yet told about network requests.
// A person never opens a page that fast, but a test does, so wait until a page load is noticed.
async function untilExtensionSeesRequests(context, worker) {
  const server = http.createServer((request, response) => response.end('<title>warm-up</title>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const link = 'http://127.0.0.1:' + server.address().port + '/';
  try {
    await until(async () => {
      const page = await context.newPage();
      await page.goto(link);
      await wait(150);
      const saved = await worker.evaluate(() => chrome.storage.session.get(null));
      await page.close();
      return Object.keys(saved).length > 0;
    }, 'the extension to notice a page load', 20000);
    await wait(200);
    await worker.evaluate(() => chrome.storage.session.clear());
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// The TV page's video, as plain numbers.
function videoOf(page) {
  return page.evaluate(() => {
    const video = /** @type {HTMLVideoElement} */ (document.getElementById('video'));
    return {
      time: video.currentTime,
      paused: video.paused,
      ended: video.ended,
      volume: video.volume,
      duration: video.duration,
      src: video.getAttribute('src'),
      readyState: video.readyState
    };
  });
}

// Which of the TV page's three screens is on show.
function screenOf(page) {
  return page.evaluate(() => ['pairScreen', 'readyScreen', 'playerScreen'].filter((id) => document.getElementById(id).className === 'screen').join(','));
}

// Waits until the TV page's video is really moving, and returns its position.
async function untilPlaying(page, fromSeconds) {
  let before = null;
  return until(
    async () => {
      const now = await videoOf(page);
      const moving = before !== null && !now.paused && now.time > before && now.time >= (fromSeconds || 0);
      before = now.time;
      return moving ? now : null;
    },
    'the TV video to play' + (fromSeconds ? ' from ' + fromSeconds + ' s' : ''),
    15000
  );
}

// Finds a port nothing is using. The extension tests run their server there and save that
// address in the popup, so they do not clash with a VCast server already running on 8787.
function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('net').AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

module.exports = {
  CLIP_SECONDS,
  DEFAULT_POPUP_SERVER,
  SITE_COOKIE,
  call,
  wait,
  startVideoSite,
  startApp,
  until,
  launchBrowser,
  launchWithExtension,
  videoOf,
  screenOf,
  untilPlaying,
  freePort
};
