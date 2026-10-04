'use strict';
// Tests the background script with a pretend `chrome` object.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const saved = new Map();
const listeners = {};
let failStorage = false;

globalThis.chrome = {
  storage: {
    session: {
      async get(key) {
        if (failStorage) throw new Error('storage is full');
        return saved.has(key) ? { [key]: saved.get(key) } : {};
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) saved.set(key, value);
      },
      async remove(key) {
        saved.delete(key);
      }
    }
  },
  webRequest: { onSendHeaders: { addListener: (listener, filter, extra) => (listeners.request = { listener, filter, extra }) } },
  runtime: { onMessage: { addListener: (listener) => (listeners.message = listener) } },
  tabs: {
    onRemoved: { addListener: (listener) => (listeners.tabClosed = listener) },
    onUpdated: { addListener: (listener) => (listeners.tabUpdated = listener) }
  }
};

let background;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const realConsole = { ...console };

before(async () => {
  Object.assign(console, quiet);
  background = await import('../../extension/background.js');
  Object.assign(console, realConsole);
});

beforeEach(() => {
  saved.clear();
  failStorage = false;
});

function request(details) {
  return listeners.request.listener({ tabId: 1, frameId: 0, type: 'xmlhttprequest', requestHeaders: [{ name: 'Referer', value: 'https://page.example/' }], ...details });
}

test('listens for requests with their cookie headers', () => {
  assert.deepEqual(listeners.request.extra, ['requestHeaders', 'extraHeaders']);
  assert.ok(listeners.request.filter.types.includes('media'));
  assert.equal(typeof listeners.message, 'function');
  assert.equal(listeners.tabClosed, background.onTabClosed);
});

test('AC-10: a video request is added to its tab once, with its headers', async () => {
  Object.assign(console, quiet);
  await request({ url: 'https://cdn.example/master.m3u8' });
  await request({ url: 'https://cdn.example/master.m3u8' });
  await request({ url: 'https://cdn.example/seg1.ts' });
  await request({ url: 'https://cdn.example/subtitles/eng-2.vtt' });
  await request({ url: 'https://cdn.example/subtitles/eng-2.vtt' });
  await request({ url: 'https://cdn.example/film.mp4', tabId: 2, type: 'media' });
  await request({ url: 'https://cdn.example/other.mp4', tabId: -1, type: 'media' });
  Object.assign(console, realConsole);

  const tab1 = saved.get('tab:1');
  assert.equal(tab1.videos.length, 1);
  assert.deepEqual(tab1.subtitles.map((subtitle) => [subtitle.url, subtitle.label, subtitle.frameId]), [['https://cdn.example/subtitles/eng-2.vtt', 'eng-2', 0]], 'subtitle files are kept apart from videos');
  assert.equal(tab1.videos[0].frameId, 0, 'the frame that asked for it is remembered');
  assert.equal(tab1.videos[0].kind, 'hls');
  assert.deepEqual(tab1.videos[0].headers, { referer: 'https://page.example/' });
  assert.equal(typeof tab1.videos[0].foundAt, 'number');
  assert.equal(saved.get('tab:2').videos[0].kind, 'file');
  assert.equal(saved.has('tab:-1'), false);
});

test('a new page in the tab clears its list; closing the tab removes it', async () => {
  Object.assign(console, quiet);
  await request({ url: 'https://cdn.example/master.m3u8' });
  Object.assign(console, realConsole);
  await request({ url: 'https://site.example/next-page', type: 'main_frame' });
  const cleared = saved.get('tab:1');
  assert.deepEqual({ ...cleared, since: 0 }, { videos: [], subtitles: [], hasDrm: false, hasHiddenVideo: false, page: 'site.example/next-page', since: 0 });
  assert.ok(cleared.since > Date.now() - 5000);
  await listeners.tabClosed(1);
  assert.equal(saved.has('tab:1'), false);
});

test('AC-11: messages from the page mark DRM, hidden videos and video tags', async () => {
  Object.assign(console, quiet);
  const sender = { tab: { id: 5 }, frameId: 3, url: 'https://page.example/frame' };
  await background.onPageMessage({ type: 'drm' }, sender);
  await background.onPageMessage({ type: 'drm' }, sender);
  await background.onPageMessage({ type: 'hidden-video' }, sender);
  await background.onPageMessage({ type: 'hidden-video' }, sender);
  await background.onPageMessage({ type: 'video', url: 'https://cdn.example/clip.mp4' }, sender);
  await background.onPageMessage({ type: 'video', url: 'blob:https://page.example/1' }, sender);
  await background.onPageMessage({ type: 'unknown' }, sender);
  await background.onPageMessage(null, sender);
  await background.onPageMessage({ type: 'drm' }, {});
  listeners.message({ type: 'drm' }, sender);
  Object.assign(console, realConsole);

  const info = saved.get('tab:5');
  assert.equal(info.hasDrm, true);
  assert.equal(info.hasHiddenVideo, true);
  assert.equal(info.videos.length, 1);
  assert.deepEqual(info.videos[0].headers, { referer: 'https://page.example/', origin: 'https://page.example' }, 'to another site only the frame\'s site is sent as Referer');
  assert.equal(saved.size, 1);
});

test('links the page loaded before the extension was listening are added, with the frame as Referer', async () => {
  Object.assign(console, quiet);
  const sender = { tab: { id: 9 }, frameId: 4, url: 'https://player.example/embed/1' };
  const at = Date.now();
  const loaded = (...links) => ({ type: 'loaded-links', links: links.map((url) => ({ url, at })) });
  await background.onPageMessage(loaded('https://cdn.example/a/master.m3u8', 'https://cdn.example/a/eng-2.vtt', 'https://cdn.example/a/seg.mp4', 'not a link'), sender);
  await background.onPageMessage({ type: 'loaded-links', links: 'not a list' }, sender);
  await background.onPageMessage(loaded('https://player.example/b/index.m3u8'), sender);
  Object.assign(console, realConsole);
  const info = saved.get('tab:9');
  assert.deepEqual(info.videos.map((video) => [video.kind, video.url]), [['hls', 'https://cdn.example/a/master.m3u8'], ['hls', 'https://player.example/b/index.m3u8']]);
  assert.deepEqual(info.videos[0].headers, { referer: 'https://player.example/', origin: 'https://player.example' }, 'another site gets only the frame\'s site');
  assert.deepEqual(info.videos[1].headers, { referer: 'https://player.example/embed/1', origin: 'https://player.example' }, 'the same site gets the full frame address');
  assert.deepEqual(info.subtitles, [{ url: 'https://cdn.example/a/eng-2.vtt', label: 'eng-2', frameId: 4, foundAt: at }]);
});

test('AC-22: next episode without a page load: the address change empties the list', async () => {
  Object.assign(console, quiet);
  await request({ url: 'https://site.example/watch/show/ep-1', type: 'main_frame' });
  await request({ url: 'https://cdn.example/ep1/master.m3u8', frameId: 7 });
  await request({ url: 'https://cdn.example/ep1/eng.vtt', frameId: 7 });
  const urlsNow = () => saved.get('tab:1').videos.map((video) => video.url).concat(saved.get('tab:1').subtitles.map((subtitle) => subtitle.url));

  await listeners.tabUpdated(1, { status: 'loading' });
  await background.onTabUpdated(1, { url: 'https://site.example/watch/show/ep-1?t=120#top' });
  assert.equal(urlsNow().length, 2, 'only the part after ? or # changed: same page, list kept');

  const before = Date.now();
  await background.onTabUpdated(1, { url: 'https://site.example/watch/show/ep-2' });
  assert.deepEqual(urlsNow(), [], 'another page: the list starts again');
  assert.equal(saved.get('tab:1').page, 'site.example/watch/show/ep-2');

  await request({ url: 'https://cdn.example/ep2/master.m3u8', frameId: 7 });
  // The popup looks at the page again: the frame still remembers episode 1's links.
  const sender = { tab: { id: 1 }, frameId: 7, url: 'https://player.example/embed' };
  await background.onPageMessage({ type: 'loaded-links', links: [
    { url: 'https://cdn.example/ep1/master.m3u8', at: before - 60000 },
    { url: 'https://cdn.example/ep1/eng.vtt', at: before - 60000 },
    { url: 'https://cdn.example/ep2/master.m3u8', at: before + 5 },
    { url: 'https://cdn.example/ep2/eng.vtt', at: before + 5 }
  ] }, sender);
  Object.assign(console, realConsole);
  assert.deepEqual(urlsNow(), ['https://cdn.example/ep2/master.m3u8', 'https://cdn.example/ep2/eng.vtt'], 'links from before the change are not brought back');
});

test('AC-22: a frame that loads a new page loses its entries; other frames keep theirs', async () => {
  Object.assign(console, quiet);
  await request({ url: 'https://cdn.example/sub/master.m3u8', frameId: 7 });
  await request({ url: 'https://cdn.example/sub/eng.vtt', frameId: 7 });
  await request({ url: 'https://other.example/trailer/master.m3u8', frameId: 9 });
  await request({ url: 'https://ads.example/frame', type: 'sub_frame', frameId: 11 });
  assert.equal(saved.get('tab:1').videos.length, 2, 'a frame without entries changes nothing');

  await request({ url: 'https://player.example/embed/dub', type: 'sub_frame', frameId: 7 });
  await request({ url: 'https://cdn.example/dub/master.m3u8', frameId: 7 });
  Object.assign(console, realConsole);
  const info = saved.get('tab:1');
  assert.deepEqual(info.videos.map((video) => video.url), ['https://other.example/trailer/master.m3u8', 'https://cdn.example/dub/master.m3u8']);
  assert.deepEqual(info.subtitles, []);
});

test('a storage problem is logged and later changes still work', async () => {
  const errors = [];
  console.error = (message, fields) => errors.push([message, fields]);
  Object.assign(console, { info() {} });
  failStorage = true;
  await request({ url: 'https://cdn.example/a.mp4', type: 'media' });
  failStorage = false;
  await request({ url: 'https://cdn.example/b.mp4', type: 'media' });
  Object.assign(console, realConsole);
  assert.deepEqual(errors, [['[VCast background] Could not save tab info', { reason: 'storage is full' }]]);
  assert.equal(saved.get('tab:1').videos.length, 1);
});
