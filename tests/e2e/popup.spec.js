'use strict';
// Flow 2: the extension popup, opened as a normal tab so it can be driven. The popup looks for
// the server at 127.0.0.1:8787 unless another address is saved in it; these tests save the
// address of their own server on a free port, so a VCast server that is already running on this
// computer is left alone. The TV is a pretend one (a plain WebSocket), which lets each test
// check exactly what the popup makes the server send to the TV. The popup reads the videos of
// the "active tab", which here is the popup's own tab, so tests write that tab's list straight
// into chrome.storage.session.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { connectTv } = require('../server/tools');
const { DEFAULT_POPUP_SERVER, call, wait, startVideoSite, startApp, until, launchWithExtension, freePort } = require('./helpers');

const SERVER_DOWN_TEXT = "Can't reach VCast on this computer. Start it and try again.";
const BAD_CODE_TEXT = "That code didn't match. Check the code on the TV and try again.";
const TV_OFFLINE_TEXT = "The TV isn't connected. Open the VCast address on the TV again.";
const DRM_TEXT = "This video is protected (DRM) and can't be sent to the TV.";
const NO_VIDEO_TEXT = 'No video found yet. Start the video on the page, then open this again.';
const HIDDEN_VIDEO_TEXT = "A video is playing but its link wasn't seen. Reload the page, play the video, then open this again.";

let site;
let chrome;
let server = null;
let port;
let tvCount = 0;
const openPages = [];
const openTvs = [];

before(async () => {
  port = await freePort();
  site = await startVideoSite();
  chrome = await launchWithExtension();
  await chrome.useServer(port);
});

afterEach(async () => {
  while (openPages.length) await openPages.pop().close();
  while (openTvs.length) openTvs.pop().socket.terminate();
  await stopServer();
  await chrome.worker.evaluate(async () => {
    await globalThis.chrome.storage.local.clear();
    await globalThis.chrome.storage.session.clear();
  });
  await chrome.useServer(port);
});

after(async () => {
  if (chrome) await chrome.close();
  if (site) await site.stop();
});

async function startServer(options) {
  server = await startApp(Object.assign({ port }, options));
}

async function stopServer() {
  if (server) await server.stop();
  server = null;
}

// Opens the popup as a tab. `withoutTimer` switches off its once-a-second refresh, so a test
// can tell a button's effect from the timer's.
async function openPopup(withoutTimer) {
  const page = await chrome.context.newPage();
  openPages.push(page);
  if (withoutTimer) await page.addInitScript(() => (window.setInterval = /** @type {any} */ (() => 0)));
  await page.goto(chrome.popupLink);
  await until(() => shownView(page), 'the popup to show a view');
  return page;
}

// Which of the popup's three views is on show.
function shownView(page) {
  return page.evaluate(() => ['serverDownView', 'pairView', 'mainView'].filter((id) => !document.getElementById(id).classList.contains('hidden')).join(','));
}

async function connectFakeTv() {
  const tv = await connectTv(port, 'television-popup-' + ++tvCount);
  openTvs.push(tv);
  tv.code = (await tv.next('pair.code')).code;
  return tv;
}

async function pairInPopup(page, code) {
  await page.locator('#code').fill(code);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
}

// Server up, pretend TV connected, popup paired through its own form.
async function pairedPopup(tabInfo, serverOptions) {
  await startServer(serverOptions);
  const tv = await connectFakeTv();
  const page = await openPopup();
  if (tabInfo) await setTabInfo(page, tabInfo);
  await pairInPopup(page, tv.code);
  await page.locator('#mainView').waitFor({ state: 'visible' });
  await tv.next('pair.ok');
  return { page, tv };
}

// Saves `info` as the found videos of the popup's own tab, the way the background script does.
async function setTabInfo(page, info) {
  const tabId = await page.evaluate(async () => (await globalThis.chrome.tabs.getCurrent()).id);
  const full = Object.assign({ videos: [], hasDrm: false, hasHiddenVideo: false }, info);
  await chrome.worker.evaluate(({ key, value }) => globalThis.chrome.storage.session.set({ [key]: value }), { key: 'tab:' + tabId, value: full });
}

function fileVideo(extra) {
  return Object.assign({ url: site.link('/media/clip.webm'), kind: 'file', foundAt: 2000, headers: { referer: site.link('/watch.html'), cookie: 'login=saved-cookie', userAgent: 'Saved-Browser/1.0' } }, extra);
}

const HLS_VIDEO = { url: 'https://cdn.example.com/live/master.m3u8?token=abc', kind: 'hls', foundAt: 3000, headers: { referer: 'https://example.com/watch' } };
const DASH_VIDEO = { url: 'https://cdn.example.com/dash/manifest.mpd', kind: 'dash', foundAt: 1000, headers: { referer: 'https://example.com/watch' } };

// Popup paired, one video cast, and the pretend TV reporting that it plays.
async function castingPopup(playback) {
  const { page, tv } = await pairedPopup({ videos: [fileVideo()] });
  await page.getByRole('button', { name: 'Cast', exact: true }).click();
  const load = await tv.next('media.load');
  tv.send(Object.assign({ v: 1, type: 'media.state', status: 'playing', position: 50, duration: 200, volume: 0.5 }, playback));
  await page.locator('#nowPlaying').waitFor({ state: 'visible' });
  return { page, tv, load };
}

function sessionSaved() {
  return chrome.worker.evaluate(async () => (await globalThis.chrome.storage.local.get('session')).session || null);
}

test('popup, server stopped: shows the "Can\'t reach VCast" text and nothing else', async () => {
  const page = await openPopup();
  assert.equal(await shownView(page), 'serverDownView');
  assert.equal(await page.locator('#serverDownText').innerText(), SERVER_DOWN_TEXT);
  assert.ok(await page.getByText(SERVER_DOWN_TEXT).isVisible());
  assert.ok(await page.getByRole('button', { name: 'Try again' }).isVisible());
  assert.equal(await page.locator('#pairForm').isVisible(), false);
  assert.equal(await page.locator('#unpair').isVisible(), false);
});

test('popup, server stopped: "Try again" works once the server is up', async () => {
  const page = await openPopup(true);
  await page.getByRole('button', { name: 'Try again' }).click();
  await wait(300);
  assert.equal(await shownView(page), 'serverDownView', 'still down: the button changes nothing');

  await startServer();
  await wait(1500);
  assert.equal(await shownView(page), 'serverDownView', 'nothing refreshes by itself in this test');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('#pairView').waitFor({ state: 'visible' });
  assert.equal(await shownView(page), 'pairView');
  assert.equal(await page.getByText(SERVER_DOWN_TEXT).isVisible(), false);
});

test('popup, server stopped: recovers by itself when the server starts', async () => {
  const page = await openPopup();
  assert.equal(await shownView(page), 'serverDownView');
  await startServer();
  await page.locator('#pairView').waitFor({ state: 'visible', timeout: 5000 });
});

test('popup: with no saved address it looks for VCast at 127.0.0.1:8787', async () => {
  await chrome.worker.evaluate(() => globalThis.chrome.storage.local.clear());
  const page = await chrome.context.newPage();
  openPages.push(page);
  const asked = [];
  page.on('request', (request) => asked.push(request.url()));
  await page.goto(chrome.popupLink);
  await until(() => asked.some((link) => link.includes('/api/')), 'the first call to the server');
  assert.equal(asked.find((link) => link.includes('/api/')), DEFAULT_POPUP_SERVER + '/api/state');
});

test('popup, server stopped: another VCast address can be saved and is used from then on', async () => {
  // Someone changed the port in .env: the server is up, but not where the popup looks.
  const elsewhere = await startApp();
  try {
    const page = await openPopup();
    assert.equal(await shownView(page), 'serverDownView');
    const address = page.getByLabel('VCast address on this computer');
    assert.equal(await address.inputValue(), 'http://127.0.0.1:' + port, 'the address in use is shown');

    await address.fill('not an address');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal(await address.evaluate((input) => /** @type {HTMLInputElement} */ (input).validity.valid), false);
    await wait(300);
    assert.equal(await shownView(page), 'serverDownView');

    await address.fill('http://127.0.0.1:' + elsewhere.port + '/');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#pairView').waitFor({ state: 'visible' });
    const state = (await call(elsewhere.port, 'GET', '/api/state')).json;
    assert.equal(await page.locator('#tvAddress').innerText(), state.tvAddresses[0] || 'Connect this computer to your home Wi-Fi first.');

    // The saved address is used when the popup is opened again, and pairing works over it.
    const tv = await connectTv(elsewhere.port, 'television-popup-elsewhere');
    openTvs.push(tv);
    const { code } = await tv.next('pair.code');
    const again = await openPopup();
    assert.equal(await shownView(again), 'pairView');
    await pairInPopup(again, code);
    await again.locator('#mainView').waitFor({ state: 'visible' });
    assert.equal(await again.locator('#tvStatus').innerText(), 'TV connected');
  } finally {
    while (openTvs.length) openTvs.pop().socket.terminate();
    await elsewhere.stop();
  }
});

test('popup, pair view: shows the address to open on the TV', async () => {
  await startServer();
  const page = await openPopup();
  assert.equal(await shownView(page), 'pairView');
  assert.match(await page.locator('#pairView').innerText(), /on the TV, open the Internet app and go to/i);
  const state = (await call(port, 'GET', '/api/state')).json;
  const shown = await page.locator('#tvAddress').innerText();
  if (state.tvAddresses.length) {
    assert.equal(shown, state.tvAddresses[0]);
    assert.match(shown, new RegExp('^http://\\d+\\.\\d+\\.\\d+\\.\\d+:' + port + '$'));
    assert.ok(!shown.includes('127.0.0.1'), 'the TV cannot open a 127.0.0.1 address');
  } else {
    assert.equal(shown, 'Connect this computer to your home Wi-Fi first.');
  }
  assert.ok(await page.getByLabel('Code shown on the TV').isVisible());
  assert.equal(await page.locator('#unpair').isVisible(), false);
});

test('popup, pair form: empty, short and non-digit codes are stopped before any request', async () => {
  await startServer();
  await connectFakeTv();
  const page = await openPopup();
  const pairCalls = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/pair')) pairCalls.push(request.postData());
  });
  const code = page.locator('#code');
  const valid = () => code.evaluate((input) => /** @type {HTMLInputElement} */ (input).validity.valid);

  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  assert.equal(await valid(), false, 'an empty code is not valid');
  assert.equal(await code.evaluate((input) => /** @type {HTMLInputElement} */ (input).validity.valueMissing), true);

  for (const bad of ['12345', 'abcdef', '12 456', '12345a']) {
    await code.fill(bad);
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    assert.equal(await valid(), false, JSON.stringify(bad) + ' is not valid');
    assert.equal(await code.evaluate((input) => /** @type {HTMLInputElement} */ (input).validity.patternMismatch), true);
  }

  await code.fill('');
  await code.pressSequentially('12345678');
  assert.equal(await code.inputValue(), '123456', 'no more than 6 characters can be typed');
  assert.equal(await valid(), true);

  await wait(300);
  assert.deepEqual(pairCalls, [], 'no pairing request was sent for the bad codes');
  assert.equal(await shownView(page), 'pairView');
  assert.equal(await page.locator('#error').isVisible(), false);
});

test('popup, pair form: a wrong code shows the bad-code message', async () => {
  await startServer();
  const tv = await connectFakeTv();
  const page = await openPopup();
  await pairInPopup(page, tv.code === '000000' ? '111111' : '000000');
  await page.locator('#error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#error').innerText(), BAD_CODE_TEXT);
  assert.equal(await page.locator('#error').getAttribute('role'), 'alert');
  await wait(1300);
  assert.equal(await shownView(page), 'pairView');
  assert.equal(await page.locator('#error').innerText(), BAD_CODE_TEXT, 'the message stays after the next refresh');
  assert.equal(await sessionSaved(), null);
});

test('popup, pair form: too many wrong codes shows the wait-a-minute message', async () => {
  await startServer({ wrongCodesPerMinute: 2 });
  const tv = await connectFakeTv();
  const page = await openPopup();
  const wrong = tv.code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 2; i++) {
    await pairInPopup(page, wrong);
    await until(async () => (await page.locator('#error').innerText()) === BAD_CODE_TEXT, 'the bad-code message');
  }
  await pairInPopup(page, tv.code);
  await until(async () => (await page.locator('#error').innerText()) === 'Too many wrong codes. Wait a minute, then try again.', 'the too-many-tries message');
  assert.equal(await shownView(page), 'pairView');
});

test('popup, pair form: the right code moves to the main view and the pairing is remembered', async () => {
  await startServer();
  const tv = await connectFakeTv();
  const page = await openPopup();
  await pairInPopup(page, tv.code === '000000' ? '111111' : '000000');
  await page.locator('#error').waitFor({ state: 'visible' });

  await pairInPopup(page, tv.code);
  await page.locator('#mainView').waitFor({ state: 'visible' });
  await tv.next('pair.ok');
  assert.equal(await shownView(page), 'mainView');
  assert.equal(await page.locator('#tvStatus').innerText(), 'TV connected');
  assert.ok(await page.getByRole('button', { name: 'Unpair TV' }).isVisible());
  assert.equal(await page.locator('#error').isVisible(), false, 'the earlier bad-code message is gone');
  assert.equal(await page.locator('#nowPlaying').isVisible(), false);
  assert.equal(await page.locator('#pairForm').isVisible(), false);
  assert.equal(await page.locator('#code').inputValue(), '');
  assert.match(await sessionSaved(), /^[\w-]{20,}$/);

  // Closing and opening the popup again keeps the pairing.
  const again = await openPopup();
  assert.equal(await shownView(again), 'mainView');
  assert.equal(await again.locator('#tvStatus').innerText(), 'TV connected');
});

test('popup, main view: no-video notice when nothing was found', async () => {
  const { page } = await pairedPopup();
  assert.equal(await page.locator('#notice').innerText(), NO_VIDEO_TEXT);
  assert.equal(await page.locator('#videos li').count(), 0);
});

test('popup, main view: hidden-video notice when a video plays but its link was not seen', async () => {
  const { page } = await pairedPopup({ hasHiddenVideo: true });
  assert.equal(await page.locator('#notice').innerText(), HIDDEN_VIDEO_TEXT);
  assert.equal(await page.locator('#videos li').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cast', exact: true }).count(), 0);
});

test('popup, main view: lists found videos, best guess first, each with a Cast button; DASH is disabled', async () => {
  const { page } = await pairedPopup({ videos: [DASH_VIDEO, fileVideo(), HLS_VIDEO], hasHiddenVideo: true });
  const items = page.locator('#videos li');
  await until(async () => (await items.count()) === 3, 'three list items');
  const rows = await items.evaluateAll((list) =>
    list.map((item) => ({
      kind: item.querySelector('div > div').textContent,
      detail: item.querySelector('.detail').textContent,
      button: item.querySelector('button').textContent,
      disabled: item.querySelector('button').disabled
    }))
  );
  assert.deepEqual(rows, [
    { kind: 'Stream', detail: 'cdn.example.com · master.m3u8', button: 'Cast', disabled: false },
    { kind: 'Video file', detail: '127.0.0.1:' + site.port + ' · clip.webm', button: 'Cast', disabled: false },
    { kind: 'DASH stream (not supported yet)', detail: 'cdn.example.com · manifest.mpd', button: 'Cast', disabled: true }
  ]);
  assert.equal(await page.locator('#notice').innerText(), '', 'no notice when there is a list');
  for (let i = 0; i < 3; i++) assert.ok(await items.nth(i).isVisible());
});

test('popup, main view: the list follows the page (a video found while the popup is open appears)', async () => {
  const { page } = await pairedPopup();
  assert.equal(await page.locator('#notice').innerText(), NO_VIDEO_TEXT);
  await setTabInfo(page, { videos: [HLS_VIDEO] });
  await until(async () => (await page.locator('#videos li').count()) === 1, 'the new video to appear', 4000);
  assert.equal(await page.locator('#notice').innerText(), '');
});

test('popup, main view: DRM flag shows the DRM message and no Cast button', async () => {
  const { page } = await pairedPopup({ videos: [fileVideo(), HLS_VIDEO], hasDrm: true });
  assert.equal(await page.locator('#notice').innerText(), DRM_TEXT);
  assert.ok(await page.getByText(DRM_TEXT).isVisible());
  assert.equal(await page.locator('#videos li').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Cast', exact: true }).count(), 0);
});

test('popup, cast: pressing Cast sends the video to the TV and shows the now-playing box', async () => {
  const { page, tv } = await pairedPopup({ videos: [fileVideo()] });
  assert.equal(await page.locator('#nowPlaying').isVisible(), false);
  await page.getByRole('button', { name: 'Cast', exact: true }).click();

  const load = await tv.next('media.load');
  assert.equal(load.kind, 'file');
  // The extension may not read the title of its own page (only of web pages), so here the
  // title is empty and the popup shows its stand-in text. full-path.spec.js checks a real title.
  assert.equal(load.title, '');
  assert.equal(load.startAt, 0);
  assert.match(load.url, /^\/media\/[\w-]+\/[\w-]+\/[\w-]+$/);

  await page.locator('#nowPlaying').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#playingTitle').innerText(), 'Playing on TV');
  assert.equal(await page.locator('#error').isVisible(), false);
  for (const name of ['-10s', 'Pause', '+30s', 'Stop']) assert.ok(await page.getByRole('button', { name, exact: true }).isVisible(), name + ' button');
  assert.ok(await page.getByLabel('Position').isVisible());
  assert.ok(await page.getByLabel('Volume').isVisible());

  tv.send({ v: 1, type: 'media.state', status: 'playing', position: 50, duration: 200, volume: 0.5 });
  await until(async () => (await page.locator('#times').innerText()) === '0:50 / 3:20', 'position and length to show');
  assert.equal(await page.locator('#seek').inputValue(), '50');
  assert.equal(await page.locator('#seek').getAttribute('max'), '200');
  assert.equal(await page.locator('#volume').inputValue(), '0.5');
  assert.equal(await page.locator('#playPause').innerText(), 'Pause');

  // The saved request headers reach the video site when the TV asks the server for the video.
  const seenBefore = site.seen.length;
  const answer = await call(port, 'GET', load.url, { headers: { range: 'bytes=0-99' } });
  assert.equal(answer.status, 206);
  const atSite = site.seen.slice(seenBefore).find((request) => request.route === '/media/clip.webm');
  assert.equal(atSite.headers.referer, site.link('/watch.html'));
  assert.equal(atSite.headers.cookie, 'login=saved-cookie');
  assert.equal(atSite.headers['user-agent'], 'Saved-Browser/1.0');
});

test('popup, cast: a video found only in the page (no saved User-Agent) is sent with the browser\'s own', async () => {
  const { page, tv } = await pairedPopup({ videos: [fileVideo({ headers: { referer: site.link('/watch.html') } })] });
  await page.getByRole('button', { name: 'Cast', exact: true }).click();
  const load = await tv.next('media.load');
  const seenBefore = site.seen.length;
  assert.equal((await call(port, 'GET', load.url)).status, 200);
  const atSite = site.seen.slice(seenBefore).find((request) => request.route === '/media/clip.webm');
  assert.equal(atSite.headers['user-agent'], await page.evaluate(() => navigator.userAgent));
  assert.equal(atSite.headers.cookie, undefined);
});

test('popup, cast: an HLS entry is sent as kind hls', async () => {
  const { page, tv } = await pairedPopup({ videos: [HLS_VIDEO] });
  await page.getByRole('button', { name: 'Cast', exact: true }).click();
  assert.equal((await tv.next('media.load')).kind, 'hls');
});

test('popup, controls: Pause and Play send the right control and the button follows the TV', async () => {
  const { page, tv } = await castingPopup();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const pause = await tv.next('media.control');
  assert.equal(pause.action, 'pause');

  tv.send({ v: 1, type: 'media.state', status: 'paused', position: 51, duration: 200, volume: 0.5 });
  await until(async () => (await page.locator('#playPause').innerText()) === 'Play', 'the button to read Play');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  assert.equal((await tv.next('media.control')).action, 'play');
  tv.send({ v: 1, type: 'media.state', status: 'playing', position: 51, duration: 200, volume: 0.5 });
  await until(async () => (await page.locator('#playPause').innerText()) === 'Pause', 'the button to read Pause again');
});

test('popup, controls: -10s and +30s seek from the TV\'s position', async () => {
  const { page, tv } = await castingPopup({ position: 50, duration: 200 });
  await until(async () => (await page.locator('#times').innerText()) === '0:50 / 3:20', 'the position to show');
  await page.getByRole('button', { name: '-10s', exact: true }).click();
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'seek', value: 40 });
  await page.getByRole('button', { name: '+30s', exact: true }).click();
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'seek', value: 80 });

  // Near the ends the target stays inside the video.
  tv.send({ v: 1, type: 'media.state', status: 'playing', position: 4, duration: 200, volume: 0.5 });
  await until(async () => (await page.locator('#times').innerText()) === '0:04 / 3:20', 'the position to show');
  await page.getByRole('button', { name: '-10s', exact: true }).click();
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'seek', value: 0 });
  tv.send({ v: 1, type: 'media.state', status: 'playing', position: 190, duration: 200, volume: 0.5 });
  await until(async () => (await page.locator('#times').innerText()) === '3:10 / 3:20', 'the position to show');
  await page.getByRole('button', { name: '+30s', exact: true }).click();
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'seek', value: 200 });
  assert.equal(await page.locator('#error').isVisible(), false);
});

function pick(message) {
  return { action: message.action, value: message.value };
}

test('popup, controls: moving the seek bar sends seek with the chosen second', async () => {
  const { page, tv } = await castingPopup({ position: 50, duration: 200 });
  await until(async () => (await page.locator('#seek').getAttribute('max')) === '200', 'the seek bar to know the length');
  await page.getByLabel('Position').fill('120');
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'seek', value: 120 });
  tv.send({ v: 1, type: 'media.state', status: 'playing', position: 120, duration: 200, volume: 0.5 });
  await until(async () => (await page.locator('#times').innerText()) === '2:00 / 3:20', 'the new position to show');
  assert.equal(await page.locator('#seek').inputValue(), '120');
});

test('popup, controls: the seek bar is left alone while it is being dragged', async () => {
  const { page, tv } = await castingPopup({ position: 50, duration: 200 });
  await until(async () => (await page.locator('#seek').inputValue()) === '50', 'the seek bar to show 50');
  // A drag in progress: the value changes and "input" fires, but "change" has not come yet.
  await page.locator('#seek').evaluate((bar) => {
    /** @type {HTMLInputElement} */ (bar).value = '150';
    bar.dispatchEvent(new Event('input', { bubbles: true }));
  });
  tv.send({ v: 1, type: 'media.state', status: 'playing', position: 55, duration: 200, volume: 0.5 });
  await until(async () => (await page.locator('#times').innerText()) === '0:55 / 3:20', 'the time text to follow the TV');
  assert.equal(await page.locator('#seek').inputValue(), '150', 'the thumb did not jump back under the finger');
});

test('popup, controls: the volume slider sends volume', async () => {
  const { page, tv } = await castingPopup({ volume: 0.5 });
  await until(async () => (await page.locator('#volume').inputValue()) === '0.5', 'the slider to show the TV volume');
  await page.getByLabel('Volume').fill('0.3');
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'volume', value: 0.3 });
  tv.send({ v: 1, type: 'media.state', status: 'playing', position: 50, duration: 200, volume: 0.3 });
  await wait(1300);
  assert.equal(await page.locator('#volume').inputValue(), '0.3');

  await page.getByLabel('Volume').fill('0');
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'volume', value: 0 });
  assert.equal(await page.locator('#error').isVisible(), false);
});

test('popup, controls: Stop sends stop and hides the now-playing box', async () => {
  const { page, tv } = await castingPopup();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  assert.equal((await tv.next('media.control')).action, 'stop');
  await page.locator('#nowPlaying').waitFor({ state: 'hidden' });
  assert.equal(await shownView(page), 'mainView');
  assert.ok(await page.getByRole('button', { name: 'Cast', exact: true }).isEnabled(), 'the video can be cast again');
  assert.equal(await page.locator('#error').isVisible(), false);
});

test('popup, controls: when the video has finished the button offers Play', async () => {
  const { page, tv } = await castingPopup();
  tv.send({ v: 1, type: 'media.state', status: 'ended', position: 200, duration: 200, volume: 0.5 });
  await until(async () => (await page.locator('#times').innerText()) === '3:20 / 3:20', 'the end position to show');
  assert.equal(await page.locator('#playPause').innerText(), 'Play');
  await page.locator('#playPause').click();
  assert.equal((await tv.next('media.control')).action, 'play');
});

test('popup, TV offline: says so, disables Cast, and recovers when the TV is back', async () => {
  const { page, tv } = await pairedPopup({ videos: [fileVideo()] });
  assert.ok(await page.getByRole('button', { name: 'Cast', exact: true }).isEnabled());
  await tv.close();
  await until(async () => (await page.locator('#tvStatus').innerText()) === TV_OFFLINE_TEXT, 'the TV-offline text', 5000);
  assert.ok(await page.getByText(TV_OFFLINE_TEXT).isVisible());
  assert.ok(await page.getByRole('button', { name: 'Cast', exact: true }).isDisabled());
  assert.equal(await shownView(page), 'mainView', 'still paired');

  const back = await connectTv(port, 'television-popup-' + tvCount);
  openTvs.push(back);
  await back.next('pair.ok');
  await until(async () => (await page.locator('#tvStatus').innerText()) === 'TV connected', 'the TV to be shown as connected', 5000);
  assert.ok(await page.getByRole('button', { name: 'Cast', exact: true }).isEnabled());
});

test('popup, TV offline: a control pressed while the TV is gone shows the TV-offline message', async () => {
  const { page, tv } = await castingPopup();
  await tv.close();
  await until(async () => !(await call(port, 'GET', '/api/state', { session: await sessionSaved() })).json.tv.connected, 'the server to see the TV go');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('#error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#error').innerText(), TV_OFFLINE_TEXT);
});

test('popup, playback problem: shows that the TV could not play the video', async () => {
  const { page, tv } = await castingPopup();
  tv.send({ v: 1, type: 'media.state', status: 'error', position: 0, duration: 0, volume: 1, error: 'cannot_play' });
  await page.locator('#error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#error').innerText(), "The TV couldn't play this video. Reload the page and cast again.");
});

test('popup, playback problem: a TV browser that cannot play the kind of video', async () => {
  const { page, tv } = await castingPopup();
  tv.send({ v: 1, type: 'media.state', status: 'error', position: 0, duration: 0, volume: 1, error: 'not_supported' });
  await page.locator('#error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#error').innerText(), "The TV browser can't play this kind of video.");
});

test('popup, playback problem: a link the site refuses shows the expired-link message', async () => {
  // No Referer saved, so the pretend site answers 403 like a site with an expired link.
  const { page, tv } = await pairedPopup({ videos: [fileVideo({ headers: {} })] });
  await page.getByRole('button', { name: 'Cast', exact: true }).click();
  const load = await tv.next('media.load');
  assert.equal((await call(port, 'GET', load.url)).status, 403);
  tv.send({ v: 1, type: 'media.state', status: 'error', position: 0, duration: 0, volume: 1, error: 'cannot_play' });
  await page.locator('#error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#error').innerText(), 'The video link expired. Reload the page and cast again.');
});

test('popup, playback problem: the message goes away after Stop', async () => {
  const { page, tv } = await castingPopup();
  tv.send({ v: 1, type: 'media.state', status: 'error', position: 0, duration: 0, volume: 1, error: 'cannot_play' });
  await page.locator('#error').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('#nowPlaying').waitFor({ state: 'hidden' });
  await wait(1300);
  assert.equal(await page.locator('#error').isVisible(), false);
});

test('popup, Unpair: returns to the pair view and the TV gets a new code', async () => {
  const { page, tv } = await castingPopup();
  await page.getByRole('button', { name: 'Unpair TV' }).click();
  await page.locator('#pairView').waitFor({ state: 'visible' });
  assert.equal(await shownView(page), 'pairView');
  assert.equal(await page.locator('#unpair').isVisible(), false);
  assert.equal(await page.locator('#nowPlaying').isVisible(), false);
  assert.equal(await page.locator('#error').isVisible(), false, 'unpairing on purpose is not an error');
  await tv.next('session.end');
  const fresh = await tv.next('pair.code');
  assert.match(fresh.code, /^\d{6}$/);
  assert.notEqual(fresh.code, tv.code);
  assert.equal(await sessionSaved(), null);
  await wait(1300);
  assert.equal(await page.locator('#error').isVisible(), false, 'and no error after the next refresh either');

  // The new code pairs again from the same popup.
  await pairInPopup(page, fresh.code);
  await page.locator('#mainView').waitFor({ state: 'visible' });
});

test('popup: when the server was restarted and forgot the pairing, it asks for the code again', async () => {
  const { page } = await pairedPopup();
  await stopServer();
  await page.locator('#serverDownView').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#serverDownText').innerText(), SERVER_DOWN_TEXT);
  assert.equal(await page.locator('#unpair').isVisible(), false);

  await startServer();
  await page.locator('#pairView').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#error').innerText(), 'The TV is no longer paired. Type the code from the TV again.');
  assert.ok(await page.locator('#error').isVisible());
  assert.equal(await sessionSaved(), null);
});

test('AC-19 popup: Earlier, Later and Reset change the subtitle timing and the text shows the total', async () => {
  const subtitles = [{ url: site.link('/media/eng.vtt'), label: 'eng' }];
  const { page, tv } = await pairedPopup({ videos: [fileVideo()], subtitles });
  assert.equal(await page.locator('#subtitleTiming').isVisible(), false, 'nothing to adjust before a video is on the TV');

  await page.getByRole('button', { name: 'Cast', exact: true }).click();
  const load = await tv.next('media.load');
  assert.deepEqual([load.subtitle, load.subtitleShift], [0, 0], 'English is on, timing as in the file');
  tv.send({ v: 1, type: 'media.state', status: 'playing', position: 5, duration: 200, volume: 0.5 });
  await page.locator('#subtitleTiming').waitFor({ state: 'visible' });
  const shown = () => page.locator('#subtitleShift').innerText();
  assert.equal(await shown(), 'In time with the file');

  await page.getByRole('button', { name: 'Earlier', exact: true }).click();
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'subtitleShift', value: -0.25 });
  await until(async () => (await shown()) === 'Shown 0.25 s earlier', 'the text to show the timing');

  for (let press = 0; press < 3; press++) {
    await page.getByRole('button', { name: 'Later', exact: true }).click();
    await tv.next('media.control');
  }
  await until(async () => (await shown()) === 'Shown 0.5 s later', 'three presses of Later to add up');

  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'subtitleShift', value: 0 });
  await until(async () => (await shown()) === 'In time with the file', 'Reset to go back');

  await page.locator('#subtitles').selectOption({ label: 'Off' });
  assert.deepEqual(pick(await tv.next('media.control')), { action: 'subtitle', value: -1 });
  await page.locator('#subtitleTiming').waitFor({ state: 'hidden' });
});
