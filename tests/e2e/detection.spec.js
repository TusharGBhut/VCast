'use strict';
// Flow 3: the extension finding videos in real pages. Each test opens a page of the pretend
// site in a browser with the extension loaded, then reads what the extension saved for that
// tab in chrome.storage.session.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { SITE_COOKIE, wait, startVideoSite, until, launchWithExtension } = require('./helpers');

let site;
let chrome;
const openPages = [];

before(async () => {
  site = await startVideoSite();
  chrome = await launchWithExtension();
  // The site hands out its login cookie on /watch.html; visit it once so later pages have it.
  const page = await chrome.context.newPage();
  await page.goto(site.link('/watch.html'));
  await page.close();
});

afterEach(async () => {
  while (openPages.length) await openPages.pop().close();
});

after(async () => {
  await chrome.close();
  await site.stop();
});

async function open(link) {
  const page = await chrome.context.newPage();
  openPages.push(page);
  await page.goto(link);
  return page;
}

// Waits until the extension has saved `count` videos for the tab showing `link`.
function untilVideos(link, count) {
  return until(async () => {
    const info = await chrome.tabInfoOf(link);
    return info && info.videos.length >= count ? info : null;
  }, count + ' video(s) saved for ' + link);
}

// Gives the page-watcher and network listener time to report anything more, then reads the list.
async function settledInfo(link) {
  await wait(1200);
  return chrome.tabInfoOf(link);
}

test('the extension loads and its service worker is running', async () => {
  assert.match(chrome.extensionId, /^[a-p]{32}$/);
  const manifest = await chrome.worker.evaluate(() => globalThis.chrome.runtime.getManifest());
  assert.equal(manifest.name, 'VCast');
  assert.equal(manifest.manifest_version, 3);
});

test('<video src=...webm>: one entry with the link and the request headers', async () => {
  const link = site.link('/watch.html');
  const page = await open(link);
  await untilVideos(link, 1);
  await page.waitForFunction(() => /** @type {HTMLVideoElement} */ (document.getElementById('v')).currentTime > 0.3);
  const info = await settledInfo(link);

  assert.equal(info.hasDrm, false);
  assert.equal(info.hasHiddenVideo, false);
  assert.equal(info.videos.length, 1, 'the network request and the <video> tag count as one video');
  const [video] = info.videos;
  assert.equal(video.url, site.link('/media/clip.webm'));
  assert.equal(video.kind, 'file');
  assert.equal(typeof video.foundAt, 'number');
  assert.equal(video.headers.referer, link);
  assert.equal(video.headers.userAgent, await page.evaluate(() => navigator.userAgent));
  assert.equal(video.headers.cookie, SITE_COOKIE);
});

test('video inside an iframe from another site: listed for the tab, with the frame as Referer', async () => {
  const link = site.link('/iframe.html');
  await open(link);
  await untilVideos(link, 1);
  const info = await settledInfo(link);
  assert.equal(info.videos.length, 1);
  assert.equal(info.videos[0].url, site.otherLink('/media/framed.webm'));
  assert.equal(info.videos[0].kind, 'file');
  assert.equal(info.videos[0].headers.referer, site.otherLink('/embed.html'), 'the Referer the site saw, not the top page');
  assert.match(info.videos[0].headers.userAgent, /Chrome/);
});

test('page that fetches an .m3u8: one HLS entry, segments are not listed', async () => {
  const link = site.link('/hls.html');
  const page = await open(link);
  await page.waitForFunction(() => document.title === 'Live stream loaded');
  await untilVideos(link, 1);
  const info = await settledInfo(link);
  assert.equal(info.videos.length, 1, 'three .ts segments add nothing');
  assert.equal(info.videos[0].url, site.link('/hls/master.m3u8?token=abc'), 'the link keeps its token');
  assert.equal(info.videos[0].kind, 'hls');
  assert.equal(info.videos[0].headers.referer, link);
  assert.equal(info.videos[0].headers.cookie, SITE_COOKIE);
  assert.match(info.videos[0].headers.userAgent, /Chrome/);
  assert.ok(site.requestsFor('/hls/low/seg3.ts').length > 0, 'the page really fetched the segments');
});

test('page with several videos: each is listed once with its kind, other requests are ignored', async () => {
  const link = site.link('/several.html');
  await open(link);
  await untilVideos(link, 4);
  const info = await settledInfo(link);
  const found = info.videos.map((video) => video.kind + ' ' + new URL(video.url).pathname).sort();
  assert.deepEqual(found, ['dash /dash/manifest.mpd', 'file /media/clip.webm', 'file /media/trailer.webm', 'hls /hls/master.m3u8']);
  for (const video of info.videos) assert.equal(video.headers.referer, link);
  assert.ok(site.requestsFor('/data.json').length > 0, 'the page also fetched something that is not a video');
});

test('page with two videos whose names differ only by a number lists both', async () => {
  const link = site.link('/numbered.html');
  const page = await open(link);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every((video) => video.currentTime > 0.2));
  const info = await settledInfo(link);
  assert.deepEqual(info.videos.map((video) => new URL(video.url).pathname).sort(), ['/media/episode1.webm', '/media/episode2.webm']);
});

test('page that sets up DRM (asks for a key system and sets media keys on its video) is marked as DRM', async () => {
  const link = site.link('/drm.html');
  const page = await open(link);
  await page.waitForFunction(() => document.title !== 'Protected film');
  assert.equal(await page.title(), 'drm set up', 'the test page could set up its keys');
  const info = await until(async () => {
    const now = await chrome.tabInfoOf(link);
    return now && now.hasDrm ? now : null;
  }, 'the DRM mark');
  assert.equal(info.hasDrm, true);
});

test('page that only asks whether DRM is possible (requestMediaKeySystemAccess alone) is not marked, and its video is listed', async () => {
  // SPEC.md, "Extension permissions": a page that only asks is not marked.
  const link = site.link('/drm-question.html');
  const page = await open(link);
  await page.waitForFunction(() => document.title.startsWith('drm asked'));
  assert.equal(await page.title(), 'drm asked: ok');
  await untilVideos(link, 1);
  const info = await settledInfo(link);
  assert.equal(info.hasDrm, false);
  assert.equal(info.videos.length, 1);
});

test('page that plays a blob: video is marked as a hidden video', async () => {
  const link = site.link('/blob.html');
  const page = await open(link);
  await page.waitForFunction(() => /** @type {HTMLVideoElement} */ (document.getElementById('v')).currentTime > 0.2);
  const info = await until(async () => {
    const now = await chrome.tabInfoOf(link);
    return now && now.hasHiddenVideo ? now : null;
  }, 'the hidden-video mark');
  assert.deepEqual(info.videos, []);
  assert.equal(info.hasDrm, false);
});

test('page without a video has an empty list', async () => {
  const link = site.link('/plain.html');
  await open(link);
  const info = await settledInfo(link);
  assert.deepEqual(info.videos, []);
  assert.equal(info.hasDrm, false);
  assert.equal(info.hasHiddenVideo, false);
});

test('page with only an <audio> tag lists no video', async () => {
  const link = site.link('/audio.html');
  const page = await open(link);
  await page.waitForFunction(() => /** @type {HTMLAudioElement} */ (document.getElementById('a')).readyState >= 2);
  const info = await settledInfo(link);
  assert.deepEqual(info.videos, []);
});

test('reloading the page keeps exactly one entry', async () => {
  const link = site.link('/watch.html');
  const page = await open(link);
  await untilVideos(link, 1);
  await page.reload();
  await page.waitForFunction(() => /** @type {HTMLVideoElement} */ (document.getElementById('v')).currentTime > 0.2);
  const info = await settledInfo(link);
  assert.equal(info.videos.length, 1);
});

test('navigating to a new page clears the list', async () => {
  const link = site.link('/watch.html');
  const page = await open(link);
  await untilVideos(link, 1);
  const tabId = await chrome.tabIdOf(link);

  await page.goto(site.link('/plain.html'));
  const info = await until(async () => {
    const now = (await chrome.savedTabs())['tab:' + tabId];
    return now && now.videos.length === 0 ? now : null;
  }, 'the list to be emptied');
  await wait(800);
  const settled = (await chrome.savedTabs())['tab:' + tabId];
  assert.deepEqual(settled.videos, [], 'and the old video does not come back');
  assert.equal(settled.hasDrm, false);
  assert.equal(settled.hasHiddenVideo, false);
  assert.deepEqual(info.videos, []);
});

test('navigating away from a DRM page clears the DRM mark', async () => {
  const link = site.link('/drm.html');
  const page = await open(link);
  await until(async () => ((await chrome.tabInfoOf(link)) || {}).hasDrm, 'the DRM mark');
  const tabId = await chrome.tabIdOf(link);
  await page.goto(site.link('/watch.html'));
  const info = await until(async () => {
    const now = (await chrome.savedTabs())['tab:' + tabId];
    return now && now.videos.length === 1 ? now : null;
  }, 'the new page\'s video');
  assert.equal(info.hasDrm, false);
});

test('two tabs keep separate lists, and closing a tab removes its list', async () => {
  const watch = site.link('/watch.html');
  const hls = site.link('/hls.html');
  const first = await open(watch);
  await open(hls);
  const firstInfo = await untilVideos(watch, 1);
  const secondInfo = await untilVideos(hls, 1);
  assert.equal(firstInfo.videos[0].kind, 'file');
  assert.equal(secondInfo.videos[0].kind, 'hls');

  const tabId = await chrome.tabIdOf(watch);
  assert.ok('tab:' + tabId in (await chrome.savedTabs()));
  openPages.splice(openPages.indexOf(first), 1);
  await first.close();
  await until(async () => !('tab:' + tabId in (await chrome.savedTabs())), 'the closed tab\'s list to be removed');
});

test('AC-22: next episode without a page load: only the new episode is listed, also after the popup looks again', async () => {
  const first = site.link('/show/ep-1');
  const second = site.link('/show/ep-2');
  const page = await open(first);
  await untilVideos(first, 1);

  // Only the part after "?" changes: still the same video, so the list stays.
  await page.evaluate(() => window.sameEpisodeNewTime());
  await wait(500);
  const sameEpisode = await chrome.tabInfoOf(first + '?t=90');
  assert.deepEqual(sameEpisode.videos.map((video) => video.url), [site.link('/hls/master.m3u8')]);

  await page.evaluate(() => window.nextEpisode());
  await until(async () => ((await chrome.tabInfoOf(second)) || { videos: [] }).videos.length === 1, 'the new episode to be listed');
  let info = await chrome.tabInfoOf(second);
  assert.deepEqual(info.videos.map((video) => video.url), [site.link('/hls/low/index.m3u8')], 'episode 1 is gone from the list');

  // What the popup does when it opens. The page still remembers that it loaded episode 1.
  const tabId = await chrome.tabIdOf(second);
  await chrome.worker.evaluate((id) => globalThis.chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['page-watcher.js'] }), tabId);
  await wait(500);
  info = await chrome.tabInfoOf(second);
  assert.deepEqual(info.videos.map((video) => video.url), [site.link('/hls/low/index.m3u8')], 'looking again does not bring episode 1 back');
});
