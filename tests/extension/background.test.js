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
  tabs: { onRemoved: { addListener: (listener) => (listeners.tabClosed = listener) } }
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
  return listeners.request.listener({ tabId: 1, type: 'xmlhttprequest', requestHeaders: [{ name: 'Referer', value: 'https://page.example/' }], ...details });
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
  assert.deepEqual(tab1.subtitles, [{ url: 'https://cdn.example/subtitles/eng-2.vtt', label: 'eng-2' }], 'subtitle files are kept apart from videos');
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
  assert.deepEqual(saved.get('tab:1'), { videos: [], subtitles: [], hasDrm: false, hasHiddenVideo: false });
  await listeners.tabClosed(1);
  assert.equal(saved.has('tab:1'), false);
});

test('AC-11: messages from the page mark DRM, hidden videos and video tags', async () => {
  Object.assign(console, quiet);
  const sender = { tab: { id: 5 }, url: 'https://page.example/frame' };
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
  const sender = { tab: { id: 9 }, url: 'https://player.example/embed/1' };
  await background.onPageMessage({ type: 'loaded-links', links: ['https://cdn.example/a/master.m3u8', 'https://cdn.example/a/eng-2.vtt', 'https://cdn.example/a/seg.mp4', 'not a link'] }, sender);
  await background.onPageMessage({ type: 'loaded-links', links: 'not a list' }, sender);
  await background.onPageMessage({ type: 'loaded-links', links: ['https://player.example/b/index.m3u8'] }, sender);
  Object.assign(console, realConsole);
  const info = saved.get('tab:9');
  assert.deepEqual(info.videos.map((video) => [video.kind, video.url]), [['hls', 'https://cdn.example/a/master.m3u8'], ['hls', 'https://player.example/b/index.m3u8']]);
  assert.deepEqual(info.videos[0].headers, { referer: 'https://player.example/', origin: 'https://player.example' }, 'another site gets only the frame\'s site');
  assert.deepEqual(info.videos[1].headers, { referer: 'https://player.example/embed/1', origin: 'https://player.example' }, 'the same site gets the full frame address');
  assert.deepEqual(info.subtitles, [{ url: 'https://cdn.example/a/eng-2.vtt', label: 'eng-2' }]);
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
