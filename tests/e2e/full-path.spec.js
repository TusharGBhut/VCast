'use strict';
// Flow 4: everything together in one browser with the extension loaded. A page of the pretend
// site plays a video in one tab, the TV page is open in another, and the popup (as a third tab)
// is used to pair and cast. The TV page must then really play the video through the server,
// with the Referer the site demands.
//
// The server runs on a free port and its address is saved in the popup, so a VCast server
// already running on this computer (port 8787) is left alone.
//
// The popup asks the browser for the "active tab". Opened as a tab, that would be the popup
// itself, so here that one question is answered with the video tab. Everything else is real:
// detection, storage, the popup's code, the server, the proxy and the TV page.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { CLIP_SECONDS, SITE_COOKIE, wait, startVideoSite, startApp, until, launchWithExtension, videoOf, screenOf, untilPlaying, freePort } = require('./helpers');

let site;
let server;
let chrome;
let port;
const openPages = [];

before(async () => {
  port = await freePort();
  site = await startVideoSite();
  chrome = await launchWithExtension();
  await chrome.useServer(port);
});

// A fresh server for every test, so a pairing left over by a failed test cannot spoil the next.
beforeEach(async () => {
  server = await startApp({ port });
});

afterEach(async () => {
  while (openPages.length) await openPages.pop().close();
  await chrome.worker.evaluate(() => globalThis.chrome.storage.local.clear());
  await chrome.useServer(port);
  if (server) await server.stop();
  server = null;
});

after(async () => {
  if (chrome) await chrome.close();
  if (site) await site.stop();
});

async function open(link) {
  const page = await chrome.context.newPage();
  openPages.push(page);
  await page.goto(link);
  return page;
}

// Opens the TV page in a tab and waits for its code.
async function openTv() {
  const page = await chrome.context.newPage();
  openPages.push(page);
  const asked = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('blob:')) asked.push(request.url());
  });
  await page.goto('http://127.0.0.1:' + port + '/');
  const code = await until(async () => {
    const text = await page.locator('#code').innerText();
    return /^\d{6}$/.test(text) ? text : null;
  }, 'a 6-digit code on the TV');
  return { page, code, asked };
}

// Opens the popup as a tab that believes the tab showing `videoPageLink` is the active one.
async function openPopupFor(videoPageLink) {
  const tabId = await until(() => chrome.tabIdOf(videoPageLink), 'the tab of the video page');
  const page = await chrome.context.newPage();
  openPages.push(page);
  await page.addInitScript((id) => {
    const tabs = globalThis.chrome && globalThis.chrome.tabs;
    if (tabs) tabs.query = async () => [await tabs.get(id)];
  }, tabId);
  await page.goto(chrome.popupLink);
  return page;
}

async function pairThroughPopup(popup, tv) {
  await popup.locator('#pairView').waitFor({ state: 'visible' });
  await popup.getByLabel('Code shown on the TV').fill(tv.code);
  await popup.getByRole('button', { name: 'Pair', exact: true }).click();
  await popup.locator('#mainView').waitFor({ state: 'visible' });
  await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
}

// Requests the VCast server made to the site (it asks for the bytes exactly as they are;
// the browser's own video requests ask differently).
function fromServer(requests) {
  return requests.filter((request) => request.headers['accept-encoding'] === 'identity' && !request.headers['sec-fetch-dest']);
}

test('full path: page video -> pair in the popup -> Cast -> the TV plays it through the server', async () => {
  const watchLink = site.link('/watch.html');
  const watch = await open(watchLink);
  await watch.waitForFunction(() => /** @type {HTMLVideoElement} */ (document.getElementById('v')).currentTime > 0.2);
  const found = (await chrome.tabInfoOf(watchLink)).videos;
  assert.equal(found.length, 1);
  assert.equal(found[0].headers.referer, watchLink);
  assert.equal(found[0].headers.cookie, SITE_COOKIE, 'the extension saw the cookie the page sent with its video request');
  const tv = await openTv();
  const popup = await openPopupFor(watchLink);

  // Pair by typing the code from the TV screen into the popup.
  await pairThroughPopup(popup, tv);
  assert.equal(await tv.page.locator('#readyScreen h1').innerText(), 'Connected');
  assert.equal(await popup.locator('#tvStatus').innerText(), 'TV connected');

  // The popup lists the video the extension found in the page.
  const items = popup.locator('#videos li');
  await until(async () => (await items.count()) === 1, 'the found video in the popup');
  assert.equal(await items.locator('div > div').first().innerText(), 'Video file');
  assert.equal(await items.locator('.detail').innerText(), '127.0.0.1:' + site.port + ' · clip.webm');

  // Cast.
  const seenBefore = site.seen.length;
  await items.getByRole('button', { name: 'Cast', exact: true }).click();
  await tv.page.locator('#playerScreen').waitFor({ state: 'visible' });
  const first = await untilPlaying(tv.page);
  await wait(700);
  const later = await videoOf(tv.page);
  assert.ok(later.time > first.time, 'the TV video advances: ' + first.time + ' -> ' + later.time);
  assert.ok(Math.abs(later.duration - CLIP_SECONDS) < 2);
  assert.match(later.src, /^\/media\//, 'the TV plays the server link');
  assert.equal(await tv.page.locator('#title').innerText(), 'Holiday film', 'the page title is shown on the TV');

  // The TV asked only the VCast server. The server asked the site with the headers of the page.
  for (const link of tv.asked) assert.ok(link.startsWith('http://127.0.0.1:' + port + '/'), 'the TV asked ' + link);
  const proxied = fromServer(site.seen.slice(seenBefore)).filter((request) => request.route === '/media/clip.webm');
  assert.ok(proxied.length > 0, 'the server asked the site for the video');
  for (const request of proxied) {
    assert.equal(request.headers.referer, watchLink, 'the Referer the site demands');
    assert.equal(request.headers.cookie, SITE_COOKIE);
    assert.equal(request.headers['user-agent'], await watch.evaluate(() => navigator.userAgent));
    assert.match(String(request.headers.range), /^bytes=\d+-/);
  }

  // The popup shows what is playing and follows the TV.
  await popup.locator('#nowPlaying').waitFor({ state: 'visible' });
  assert.equal(await popup.locator('#playingTitle').innerText(), 'Holiday film');
  await until(async () => /^0:\d\d \/ 1:(29|30)$/.test(await popup.locator('#times').innerText()), 'position and length in the popup');
  const timesBefore = await popup.locator('#times').innerText();
  await until(async () => (await popup.locator('#times').innerText()) !== timesBefore, 'the position in the popup to move', 5000);
  assert.equal(await popup.locator('#error').isVisible(), false);

  // Controls in the popup change the real video.
  await popup.getByRole('button', { name: 'Pause', exact: true }).click();
  await until(async () => (await videoOf(tv.page)).paused, 'the TV video to pause');
  assert.equal(await tv.page.locator('#message').innerText(), 'Paused');
  await until(async () => (await popup.locator('#playPause').innerText()) === 'Play', 'the popup button to read Play');

  await popup.getByLabel('Position').fill('40');
  await until(async () => (await videoOf(tv.page)).time === 40, 'the seek bar to move the TV video to 40 s');
  await until(async () => (await popup.locator('#times').innerText()).startsWith('0:40 /'), 'the popup to show 0:40');
  await popup.getByRole('button', { name: '+30s', exact: true }).click();
  await until(async () => (await videoOf(tv.page)).time === 70, '+30s to move the TV video to 70 s');
  await until(async () => (await popup.locator('#times').innerText()).startsWith('1:10 /'), 'the popup to show 1:10');
  await popup.getByRole('button', { name: '-10s', exact: true }).click();
  await until(async () => (await videoOf(tv.page)).time === 60, '-10s to move the TV video to 60 s');

  await popup.getByLabel('Volume').fill('0.25');
  await until(async () => (await videoOf(tv.page)).volume === 0.25, 'the TV volume to become 0.25');

  await popup.getByRole('button', { name: 'Play', exact: true }).click();
  await untilPlaying(tv.page, 60);
  await until(async () => (await popup.locator('#playPause').innerText()) === 'Pause', 'the popup button to read Pause');

  await popup.getByRole('button', { name: 'Stop', exact: true }).click();
  await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
  assert.equal((await videoOf(tv.page)).src, null);
  await popup.locator('#nowPlaying').waitFor({ state: 'hidden' });

  // Unpair: the TV shows a new code.
  await popup.getByRole('button', { name: 'Unpair TV' }).click();
  await popup.locator('#pairView').waitFor({ state: 'visible' });
  await tv.page.locator('#pairScreen').waitFor({ state: 'visible' });
  await until(async () => {
    const text = await tv.page.locator('#code').innerText();
    return /^\d{6}$/.test(text) && text !== tv.code;
  }, 'a new code on the TV');
});

test('full path: a video inside an iframe from another site is cast with the frame as Referer', async () => {
  const pageLink = site.link('/iframe.html');
  await open(pageLink);
  await until(async () => ((await chrome.tabInfoOf(pageLink)) || { videos: [] }).videos.length === 1, 'the framed video to be found');
  const tv = await openTv();
  const popup = await openPopupFor(pageLink);
  await pairThroughPopup(popup, tv);

  const seenBefore = site.seen.length;
  await popup.getByRole('button', { name: 'Cast', exact: true }).click();
  await untilPlaying(tv.page);
  assert.equal(await tv.page.locator('#title').innerText(), 'Page with a player in a frame');
  const proxied = fromServer(site.seen.slice(seenBefore)).filter((request) => request.route === '/media/framed.webm');
  assert.ok(proxied.length > 0);
  for (const request of proxied) assert.equal(request.headers.referer, site.otherLink('/embed.html'));
  await popup.getByRole('button', { name: 'Unpair TV' }).click();
  await tv.page.locator('#pairScreen').waitFor({ state: 'visible' });
});

test('full path: an HLS stream found in a page is cast and its playlists and segments go through the server', async () => {
  const pageLink = site.link('/hls.html');
  await open(pageLink);
  await until(async () => ((await chrome.tabInfoOf(pageLink)) || { videos: [] }).videos.length === 1, 'the stream to be found');
  const tv = await openTv();
  const popup = await openPopupFor(pageLink);
  await pairThroughPopup(popup, tv);
  assert.equal(await popup.locator('#videos li div > div').first().innerText(), 'Stream');
  assert.equal(await popup.locator('#videos li .detail').innerText(), '127.0.0.1:' + site.port + ' · master.m3u8');

  const seenBefore = site.seen.length;
  await popup.getByRole('button', { name: 'Cast', exact: true }).click();
  await tv.page.locator('#playerScreen').waitFor({ state: 'visible' });
  assert.equal(await screenOf(tv.page), 'playerScreen');

  const canPlayHls = await tv.page.evaluate(() => {
    const Hls = /** @type {any} */ (window).Hls;
    return !!(Hls && Hls.isSupported()) || !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  });
  if (canPlayHls) {
    await until(() => fromServer(site.seen.slice(seenBefore)).some((request) => /^\/hls\/low\/seg\d\.ts$/.test(request.route)), 'a segment request from the server', 15000);
    const proxied = fromServer(site.seen.slice(seenBefore));
    assert.equal(proxied[0].path, '/hls/master.m3u8?token=abc', 'the token of the found link is kept');
    assert.ok(proxied.some((request) => request.route === '/hls/low/index.m3u8'));
    for (const request of proxied) assert.equal(request.headers.referer, pageLink, 'Referer for ' + request.route);
    for (const link of tv.asked) assert.ok(link.startsWith('http://127.0.0.1:' + port + '/'), 'the TV asked ' + link);
  }
  // The pretend segments are not real video (and this browser has no H.264), so the popup
  // must end up telling the user that the TV could not play it.
  await popup.locator('#error').waitFor({ state: 'visible', timeout: 30000 });
  assert.match(await popup.locator('#error').innerText(), /^The TV (couldn't play this video\. Reload the page and cast again\.|browser can't play this kind of video\.)$/);
  await popup.getByRole('button', { name: 'Unpair TV' }).click();
  await tv.page.locator('#pairScreen').waitFor({ state: 'visible' });
});

test('full path: a page that sets up DRM shows the DRM message in the popup and no Cast button', async () => {
  const pageLink = site.link('/drm.html');
  const drmPage = await open(pageLink);
  await drmPage.waitForFunction(() => document.title !== 'Protected film');
  assert.equal(await drmPage.title(), 'drm set up');
  await until(async () => ((await chrome.tabInfoOf(pageLink)) || {}).hasDrm, 'the DRM mark');
  const tv = await openTv();
  const popup = await openPopupFor(pageLink);
  await pairThroughPopup(popup, tv);
  await until(async () => (await popup.locator('#notice').innerText()) === "This video is protected (DRM) and can't be sent to the TV.", 'the DRM message');
  assert.equal(await popup.getByRole('button', { name: 'Cast', exact: true }).count(), 0);
  assert.equal(await popup.locator('#videos li').count(), 0, 'the protected video is not offered');
  await popup.getByRole('button', { name: 'Unpair TV' }).click();
  await tv.page.locator('#pairScreen').waitFor({ state: 'visible' });
});

test('full path: "Open on TV" in the popup opens the TV page and pairs without typing a code', async () => {
  // The pretend remote-control service: one TV on the network. "Opening the page on the TV"
  // opens it in a browser tab here (through 127.0.0.1, where the test server listens).
  await server.stop();
  const opened = [];
  let tvPage = null;
  const tvRemote = {
    findTvs: async () => [{ ip: '192.168.1.6', name: 'Living room', model: 'TestTV' }],
    openPageOnTv: async (options) => {
      opened.push(options);
      const link = new URL(options.pageLink);
      tvPage = await open('http://127.0.0.1:' + link.port + link.pathname);
      return { token: 'tv-token' };
    }
  };
  server = await startApp({ port, tvRemote });

  const watchLink = site.link('/watch.html');
  await open(watchLink);
  const popup = await openPopupFor(watchLink);
  await popup.locator('#pairView').waitFor({ state: 'visible' });
  const button = popup.getByRole('button', { name: 'Open on Living room (192.168.1.6)' });
  await button.waitFor({ state: 'visible' });
  await button.click();

  await popup.locator('#mainView').waitFor({ state: 'visible' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].ip, '192.168.1.6');
  assert.match(opened[0].pageLink, new RegExp('^http://[\\d.]+:' + port + '/key-[\\w-]+$'));
  await tvPage.locator('#readyScreen').waitFor({ state: 'visible' });
  assert.equal(await tvPage.locator('#readyScreen h1').innerText(), 'Connected');
  assert.equal(await popup.locator('#tvStatus').innerText(), 'TV connected');
  assert.equal(await popup.locator('#error').isVisible(), false);

  await popup.getByRole('button', { name: 'Cast', exact: true }).click();
  await untilPlaying(tvPage);
  assert.equal(await tvPage.locator('#title').innerText(), 'Holiday film');
});

test('full path: "Open on TV" with a TV that cannot be reached shows what to check', async () => {
  const watchLink = site.link('/watch.html');
  await open(watchLink);
  const popup = await openPopupFor(watchLink);
  await popup.locator('#pairView').waitFor({ state: 'visible' });
  await popup.getByLabel(/TV not listed/).fill('192.168.1.250');
  await popup.getByRole('button', { name: 'Open on TV', exact: true }).click();
  await popup.locator('#error').waitFor({ state: 'visible' });
  assert.equal(await popup.locator('#error').innerText(), "Can't reach the TV. Check that it is on and on the same Wi-Fi.");
  assert.equal(await popup.locator('#pairView').isVisible(), true);

  await popup.getByLabel(/TV not listed/).fill('8.8.8.8');
  await popup.getByRole('button', { name: 'Open on TV', exact: true }).click();
  await until(async () => (await popup.locator('#error').innerText()).startsWith('That is not a TV address.'), 'the bad-address message');
});
