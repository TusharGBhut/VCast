'use strict';
// Flow 1: the TV page in a real browser. The "extension" here is plain API calls, so every
// assertion is about what the TV screen shows and what the video element really does.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startFakeSite, PAGE } = require('../server/tools');
const { CLIP_SECONDS, call, wait, startVideoSite, startApp, until, launchBrowser, videoOf, screenOf, untilPlaying } = require('./helpers');

const LOST_TEXT = 'Lost the connection to the computer. Trying again...';
const CANNOT_PLAY_TEXT = 'This video could not be played. Try again from your computer.';

let site;
let brokenSite;
let server;
let port;
let browser;
const openContexts = [];

before(async () => {
  site = await startVideoSite();
  brokenSite = await startFakeSite();
  server = await startApp();
  port = server.port;
  browser = await launchBrowser();
});

afterEach(async () => {
  while (openContexts.length) await openContexts.pop().close();
});

after(async () => {
  await browser.close();
  await server.stop();
  await site.stop();
  await brokenSite.stop();
});

// Opens the TV page in a fresh browser profile (so it is a new TV) and waits for its code.
async function openTv(onPort) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  openContexts.push(context);
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:' + (onPort || port) + '/');
  const code = await shownCode(page);
  return { page, code, context };
}

function shownCode(page) {
  return until(async () => {
    const text = await page.locator('#code').innerText();
    return /^\d{6}$/.test(text) ? text : null;
  }, 'a 6-digit code on the TV');
}

async function pair(tv, onPort) {
  const result = await call(onPort || port, 'POST', '/api/pair', { body: { code: tv.code } });
  assert.equal(result.status, 200);
  await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
  return result.json.session;
}

async function openPairedTv() {
  const tv = await openTv();
  tv.session = await pair(tv);
  return tv;
}

function castClip(session, title, onPort) {
  return call(onPort || port, 'POST', '/api/cast', {
    session,
    body: { url: site.link('/media/clip.webm'), kind: 'file', title: title || 'Holiday film', headers: { referer: site.link('/watch.html'), cookie: 'login=abc', userAgent: 'E2E-Browser/1.0' } }
  });
}

// A paired TV that is really playing the test clip.
async function openPlayingTv() {
  const tv = await openPairedTv();
  assert.equal((await castClip(tv.session)).status, 200);
  await untilPlaying(tv.page);
  return tv;
}

async function control(session, action, value) {
  const result = await call(port, 'POST', '/api/control', { session, body: { action, value } });
  assert.equal(result.status, 200, 'control ' + action + ' was accepted');
}

async function stateOf(session, onPort) {
  return (await call(onPort || port, 'GET', '/api/state', { session })).json;
}

function dropSocket(app) {
  for (const tv of app.pairing.tvs.values()) if (tv.socket) tv.socket.terminate();
}

test('TV page shows a 6-digit code and how to use it', async () => {
  const { page, code } = await openTv();
  assert.match(code, /^\d{6}$/);
  assert.equal(await screenOf(page), 'pairScreen');
  assert.equal(await page.locator('#pairScreen h1').innerText(), 'VCast');
  assert.equal(await page.locator('#pairScreen p').first().innerText(), 'On your computer, open the VCast extension and type this code');
  assert.ok(await page.locator('#code').isVisible());
  await until(async () => (await page.locator('#connection').innerText()) === '', 'the "Connecting..." text to go away');
  assert.equal(await page.locator('#readyScreen').isVisible(), false);
  assert.equal(await page.locator('#playerScreen').isVisible(), false);
});

test('TV page: a wrong code leaves the code on screen', async () => {
  const { page, code } = await openTv();
  const wrong = code === '000000' ? '111111' : '000000';
  const result = await call(port, 'POST', '/api/pair', { body: { code: wrong } });
  assert.deepEqual([result.status, result.json], [403, { error: 'bad_code' }]);
  await wait(300);
  assert.equal(await screenOf(page), 'pairScreen');
  assert.equal(await page.locator('#code').innerText(), code);
});

test('TV page shows "Connected" after pairing through POST /api/pair', async () => {
  const tv = await openTv();
  const session = await pair(tv);
  assert.equal(await screenOf(tv.page), 'readyScreen');
  assert.equal(await tv.page.locator('#readyScreen h1').innerText(), 'Connected');
  assert.equal(await tv.page.locator('#readyScreen p').first().innerText(), 'Play a video on your computer, open the VCast extension and press Cast.');
  assert.ok(await tv.page.getByText('To pair a different computer, press OK on the remote.').isVisible());
  assert.equal(await tv.page.locator('#code').isVisible(), false, 'a paired TV shows no code');
  const state = await stateOf(session);
  assert.equal(state.paired, true);
  assert.deepEqual(state.tv, { connected: true });
  assert.equal(state.cast, null);
});

test('TV page: the code can be used only once, and a second TV gets its own code', async () => {
  const first = await openTv();
  const second = await openTv();
  assert.notEqual(first.code, second.code);
  await pair(first);
  const again = await call(port, 'POST', '/api/pair', { body: { code: first.code } });
  assert.equal(again.status, 403);
  assert.equal(await screenOf(second.page), 'pairScreen');
  assert.equal(await second.page.locator('#code').innerText(), second.code);
});

test('TV page plays a cast video through the server: player shown, time advances', async () => {
  const tv = await openPairedTv();
  const requestedLinks = [];
  tv.page.on('request', (request) => requestedLinks.push(request.url()));
  const seenBefore = site.seen.length;
  assert.equal((await castClip(tv.session, 'Holiday film')).status, 200);

  await tv.page.locator('#playerScreen').waitFor({ state: 'visible' });
  assert.equal(await screenOf(tv.page), 'playerScreen');
  const first = await untilPlaying(tv.page);
  await wait(700);
  const later = await videoOf(tv.page);
  assert.ok(later.time > first.time, 'currentTime advances: ' + first.time + ' -> ' + later.time);
  assert.equal(later.paused, false);
  assert.ok(Math.abs(later.duration - CLIP_SECONDS) < 2, 'the whole clip length is known: ' + later.duration);
  assert.match(later.src, /^\/media\/[\w-]+\/[\w-]+\/[\w-]+$/, 'the TV loads the video from the server, not from the site');
  assert.equal(await tv.page.locator('#title').innerText(), 'Holiday film');

  // Only the VCast server was asked by the TV; the site was asked by the server with the page's headers.
  assert.ok(requestedLinks.length > 0);
  for (const link of requestedLinks) assert.ok(link.startsWith('http://127.0.0.1:' + port + '/'), 'TV asked ' + link);
  const fromServer = site.seen.slice(seenBefore).filter((request) => request.route === '/media/clip.webm');
  assert.ok(fromServer.length > 0, 'the site was asked for the video');
  for (const request of fromServer) {
    assert.equal(request.headers.referer, site.link('/watch.html'));
    assert.equal(request.headers.cookie, 'login=abc');
    assert.equal(request.headers['user-agent'], 'E2E-Browser/1.0');
  }

  const state = await until(async () => {
    const now = await stateOf(tv.session);
    return now.playback.status === 'playing' && now.playback.position > 0 ? now : null;
  }, '/api/state to say playing');
  assert.equal(state.cast.title, 'Holiday film');
  assert.equal(state.cast.kind, 'file');
  assert.equal(state.cast.siteStatus, 206);
  assert.ok(Math.abs(state.playback.duration - CLIP_SECONDS) < 2);
  assert.equal(state.playback.volume, 1);
});

test('TV page: the bar with title and time hides a few seconds after the video starts', async () => {
  const tv = await openPlayingTv();
  assert.ok(await tv.page.locator('#overlay').isVisible(), 'shown right after the start');
  assert.match(await tv.page.locator('#time').innerText(), /^0:0\d \/ 1:(29|30)$/);
  await tv.page.locator('#overlay').waitFor({ state: 'hidden', timeout: 7000 });
});

test('TV page: pause and play from the API', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'pause');
  await until(async () => (await videoOf(tv.page)).paused, 'the video to pause');
  assert.equal(await tv.page.locator('#message').innerText(), 'Paused');
  assert.ok(await tv.page.locator('#overlay').isVisible());
  const stopped = (await videoOf(tv.page)).time;
  await wait(600);
  assert.equal((await videoOf(tv.page)).time, stopped, 'time stands still while paused');
  await until(async () => (await stateOf(tv.session)).playback.status === 'paused', '/api/state to say paused');

  await control(tv.session, 'play');
  const playing = await untilPlaying(tv.page);
  assert.ok(playing.time > stopped);
  assert.equal(await tv.page.locator('#message').innerText(), '');
  await until(async () => (await stateOf(tv.session)).playback.status === 'playing', '/api/state to say playing');
});

test('TV page: seek from the API moves the video', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'seek', 42);
  const video = await untilPlaying(tv.page, 42);
  assert.ok(video.time < 47, 'jumped to about 42 s, got ' + video.time);
  const state = await until(async () => {
    const now = await stateOf(tv.session);
    return now.playback.position >= 42 ? now : null;
  }, '/api/state position to follow the seek');
  assert.ok(state.playback.position < 50);
  assert.match(await tv.page.locator('#time').innerText(), /^0:4\d \/ 1:(29|30)$/);
  const width = await tv.page.evaluate(() => parseFloat(document.getElementById('barFill').style.width));
  assert.ok(width > 45 && width < 56, 'progress bar is about half way: ' + width + '%');
});

test('TV page: volume from the API changes the video volume and shows it', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'volume', 0.3);
  await until(async () => Math.abs((await videoOf(tv.page)).volume - 0.3) < 0.001, 'the volume to become 0.3');
  assert.equal(await tv.page.locator('#message').innerText(), 'Volume 30%');
  await until(async () => Math.abs((await stateOf(tv.session)).playback.volume - 0.3) < 0.001, '/api/state volume 0.3');

  await control(tv.session, 'volume', 5);
  await until(async () => (await videoOf(tv.page)).volume === 1, 'a too-high volume to be cut to 1');
  assert.equal(await tv.page.locator('#message').innerText(), 'Volume 100%');
});

test('TV page: stop from the API goes back to "Connected" and unloads the video', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'stop');
  await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
  assert.equal(await screenOf(tv.page), 'readyScreen');
  assert.equal(await tv.page.locator('#readyScreen h1').innerText(), 'Connected');
  const video = await videoOf(tv.page);
  assert.equal(video.src, null);
  assert.equal(video.time, 0);
  const state = await stateOf(tv.session);
  assert.equal(state.cast, null);
  assert.equal(state.playback.status, 'idle');
});

test('TV page: a second cast replaces the video that is playing', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'seek', 30);
  await untilPlaying(tv.page, 30);
  const firstSrc = (await videoOf(tv.page)).src;
  assert.equal((await castClip(tv.session, 'Second film')).status, 200);
  await until(async () => (await videoOf(tv.page)).src !== firstSrc, 'the new video to load');
  const video = await untilPlaying(tv.page);
  assert.ok(video.time < 10, 'the new video starts at the beginning, got ' + video.time);
  assert.equal(await tv.page.locator('#title').innerText(), 'Second film');
});

test('TV page: the title is shown as text, never as HTML', async () => {
  const tv = await openPairedTv();
  const title = '<img src=x onerror="window.hacked=1"> & <b>film</b>';
  assert.equal((await castClip(tv.session, title)).status, 200);
  await untilPlaying(tv.page);
  assert.equal(await tv.page.locator('#title').innerText(), title);
  assert.equal(await tv.page.locator('#title img, #title b').count(), 0);
  assert.equal(await tv.page.evaluate(() => /** @type {any} */ (window).hacked), undefined);
});

test('TV remote: Enter toggles play and pause', async () => {
  const tv = await openPlayingTv();
  await tv.page.keyboard.press('Enter');
  await until(async () => (await videoOf(tv.page)).paused, 'Enter to pause the video');
  assert.equal(await tv.page.locator('#message').innerText(), 'Paused');
  await until(async () => (await stateOf(tv.session)).playback.status === 'paused', '/api/state to say paused');
  await tv.page.keyboard.press('Enter');
  await untilPlaying(tv.page);
  assert.equal((await videoOf(tv.page)).paused, false);
});

test('TV remote: Right and Left seek by 10 seconds', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'pause');
  await until(async () => (await videoOf(tv.page)).paused, 'the video to pause');
  await control(tv.session, 'seek', 40);
  await until(async () => (await videoOf(tv.page)).time === 40, 'the video to be at 40 s');

  await tv.page.keyboard.press('ArrowRight');
  await until(async () => (await videoOf(tv.page)).time === 50, 'Right to move to 50 s');
  assert.equal(await tv.page.locator('#message').innerText(), 'Forward');
  await tv.page.keyboard.press('ArrowLeft');
  await tv.page.keyboard.press('ArrowLeft');
  await until(async () => (await videoOf(tv.page)).time === 30, 'two Lefts to move to 30 s');
  assert.equal(await tv.page.locator('#message').innerText(), 'Back');
});

test('TV remote: seeking stops at the start and just before the end', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'pause');
  await until(async () => (await videoOf(tv.page)).paused, 'the video to pause');
  await control(tv.session, 'seek', 4);
  await until(async () => (await videoOf(tv.page)).time === 4, 'the video to be at 4 s');
  await tv.page.keyboard.press('ArrowLeft');
  await until(async () => (await videoOf(tv.page)).time === 0, 'Left near the start to go to 0');

  await control(tv.session, 'seek', 85);
  await until(async () => (await videoOf(tv.page)).time === 85, 'the video to be at 85 s');
  await tv.page.keyboard.press('ArrowRight');
  const video = await until(async () => {
    const now = await videoOf(tv.page);
    return now.time > 85 ? now : null;
  }, 'Right near the end to move');
  assert.ok(Math.abs(video.time - (video.duration - 1)) < 0.01, 'stops one second before the end: ' + video.time + ' of ' + video.duration);
  assert.equal(video.ended, false);
});

test('TV remote: the media keys of a TV remote work (play, pause, play/pause, rewind, forward, stop)', async () => {
  const tv = await openPlayingTv();
  const pressKey = (keyCode) => tv.page.evaluate((code) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })), keyCode);
  await pressKey(19);
  await until(async () => (await videoOf(tv.page)).paused, 'the Pause key to pause');
  await control(tv.session, 'seek', 40);
  await until(async () => (await videoOf(tv.page)).time === 40, 'the video to be at 40 s');
  await pressKey(417);
  await until(async () => (await videoOf(tv.page)).time === 70, 'Forward to add 30 s');
  await pressKey(412);
  await until(async () => (await videoOf(tv.page)).time === 40, 'Rewind to take 30 s off');
  await pressKey(415);
  await untilPlaying(tv.page, 40);
  await pressKey(10252);
  await until(async () => (await videoOf(tv.page)).paused, 'the Play/Pause key to pause');
  await pressKey(10252);
  await untilPlaying(tv.page, 40);
  await pressKey(413);
  await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
  assert.equal((await videoOf(tv.page)).src, null);
});

test('TV remote: Stop and Back end the cast on the TV and on the server', async () => {
  for (const keyCode of [413, 10009]) {
    const tv = await openPlayingTv();
    await tv.page.evaluate((code) => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, bubbles: true })), keyCode);
    await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
    assert.equal((await videoOf(tv.page)).src, null);
    const state = await until(async () => {
      const now = await stateOf(tv.session);
      return now.cast === null ? now : null;
    }, 'the server to end the cast after key ' + keyCode);
    assert.equal(state.playback.status, 'idle');
    assert.equal(state.paired, true);
    // A reload must not bring the stopped video back.
    await tv.page.reload();
    await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
    await wait(500);
    assert.equal(await screenOf(tv.page), 'readyScreen');
  }
});

test('TV remote: seek keys do nothing on the code screen and on the "Connected" screen', async () => {
  const tv = await openTv();
  await tv.page.keyboard.press('Enter');
  await tv.page.keyboard.press('ArrowRight');
  await wait(300);
  assert.equal(await screenOf(tv.page), 'pairScreen');
  assert.equal(await tv.page.locator('#code').innerText(), tv.code, 'the code did not change');
  const session = await pair(tv);
  await tv.page.keyboard.press('ArrowRight');
  await tv.page.keyboard.press('ArrowLeft');
  await wait(300);
  assert.equal(await screenOf(tv.page), 'readyScreen');
  assert.equal((await stateOf(session)).paired, true);
});

test('TV remote: OK on the "Connected" screen unpairs and shows a new code', async () => {
  const tv = await openPairedTv();
  await tv.page.keyboard.press('Enter');
  await tv.page.locator('#pairScreen').waitFor({ state: 'visible' });
  const newCode = await until(async () => {
    const text = await tv.page.locator('#code').innerText();
    return /^\d{6}$/.test(text) && text !== tv.code ? text : null;
  }, 'a new code');
  assert.equal((await stateOf(tv.session)).paired, false, 'the old sender is no longer paired');
  assert.equal((await call(port, 'POST', '/api/pair', { body: { code: newCode } })).status, 200);
  await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
});

test('TV page: the video running to its end shows "Finished"', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'seek', CLIP_SECONDS - 2);
  await until(async () => (await videoOf(tv.page)).ended, 'the video to end', 15000);
  assert.equal(await tv.page.locator('#message').innerText(), 'Finished');
  assert.ok(await tv.page.locator('#overlay').isVisible());
  await until(async () => (await stateOf(tv.session)).playback.status === 'ended', '/api/state to say ended');
});

function castBroken(session, route) {
  // The pretend site of the server tests: /video.mp4 is 1000 bytes that are not a video, /gone.mp4 answers 410.
  return call(port, 'POST', '/api/cast', { session, body: { url: brokenSite.link(route), kind: 'file', title: 'Broken', headers: { referer: PAGE } } });
}

function untilStateSaysError(session) {
  return until(async () => {
    const now = await stateOf(session);
    return now.playback.status === 'error' ? now : null;
  }, '/api/state to say error');
}

test('TV page: a video that cannot play makes /api/state report status error', async () => {
  const tv = await openPairedTv();
  assert.equal((await castBroken(tv.session, '/video.mp4')).status, 200);
  const state = await untilStateSaysError(tv.session);
  assert.equal(state.playback.error, 'cannot_play');
  assert.equal(state.cast.siteStatus, 200);
  assert.equal(await screenOf(tv.page), 'playerScreen');
  assert.equal((await videoOf(tv.page)).time, 0);
});

test('TV page: a video the site refuses (expired link) reports error with the site status', async () => {
  const tv = await openPairedTv();
  assert.equal((await castBroken(tv.session, '/gone.mp4')).status, 200);
  const state = await untilStateSaysError(tv.session);
  assert.equal(state.playback.error, 'cannot_play');
  assert.equal(state.cast.siteStatus, 410);
});

test('TV page: a video that cannot play shows the error message', async () => {
  const tv = await openPairedTv();
  assert.equal((await castBroken(tv.session, '/video.mp4')).status, 200);
  await untilStateSaysError(tv.session);
  await wait(1000);
  assert.ok(await tv.page.locator('#message').isVisible());
  assert.equal(await tv.page.locator('#message').innerText(), CANNOT_PLAY_TEXT);
});

test('TV page: a video that cannot play does not ask for a key press', async () => {
  const tv = await openPairedTv();
  assert.equal((await castBroken(tv.session, '/video.mp4')).status, 200);
  await untilStateSaysError(tv.session);
  await wait(500);
  assert.notEqual(await tv.page.locator('#message').innerText(), 'Press OK on the remote to start');
  await tv.page.keyboard.press('Enter');
  await wait(800);
  assert.notEqual(await tv.page.locator('#message').innerText(), 'Press OK on the remote to start');
  assert.equal((await stateOf(tv.session)).playback.status, 'error', 'still reported as an error after OK');
});

test('TV page: a new cast after an error plays normally', async () => {
  const tv = await openPairedTv();
  assert.equal((await castBroken(tv.session, '/video.mp4')).status, 200);
  await untilStateSaysError(tv.session);
  assert.equal((await castClip(tv.session)).status, 200);
  await untilPlaying(tv.page);
  assert.equal(await tv.page.locator('#message').innerText(), '');
  await until(async () => (await stateOf(tv.session)).playback.status === 'playing', '/api/state to say playing');
});

test('TV page: HLS playlist and segments are asked through the server', async () => {
  const tv = await openPairedTv();
  const asked = [];
  tv.page.on('request', (request) => {
    // hls.js feeds the video through a blob: link inside the page; that is not a network request.
    if (!request.url().startsWith('blob:')) asked.push(request.url());
  });
  const seenBefore = site.seen.length;
  const result = await call(port, 'POST', '/api/cast', {
    session: tv.session,
    body: { url: site.link('/hls/master.m3u8'), kind: 'hls', title: 'Live stream', headers: { referer: site.link('/hls.html') } }
  });
  assert.equal(result.status, 200);
  await tv.page.locator('#playerScreen').waitFor({ state: 'visible' });
  assert.equal(await tv.page.locator('#title').innerText(), 'Live stream');

  const canPlayHls = await tv.page.evaluate(() => {
    const Hls = /** @type {any} */ (window).Hls;
    return { hlsJs: !!(Hls && Hls.isSupported()), native: document.createElement('video').canPlayType('application/vnd.apple.mpegurl') };
  });
  if (!canPlayHls.hlsJs && !canPlayHls.native) {
    // This browser has no H.264, so the TV page must say so instead of sitting on "Loading...".
    await until(async () => (await tv.page.locator('#message').innerText()) === 'This TV browser cannot play this kind of video.', 'the not-supported text');
    const state = await until(async () => {
      const now = await stateOf(tv.session);
      return now.playback.status === 'error' ? now : null;
    }, '/api/state to say error');
    assert.equal(state.playback.error, 'not_supported');
    return;
  }

  // The player asks for the playlists and at least one segment, all through the server.
  await until(() => site.seen.slice(seenBefore).some((request) => /^\/hls\/low\/seg\d\.ts$/.test(request.route)), 'a segment request at the site', 15000);
  const atSite = site.seen.slice(seenBefore);
  assert.ok(atSite.some((request) => request.route === '/hls/master.m3u8'));
  assert.ok(atSite.some((request) => request.route === '/hls/low/index.m3u8'));
  for (const request of atSite) assert.equal(request.headers.referer, site.link('/hls.html'), 'the site saw the page Referer for ' + request.route);
  for (const link of asked) assert.ok(link.startsWith('http://127.0.0.1:' + port + '/'), 'the TV asked only the server, got ' + link);
  assert.ok(asked.filter((link) => link.includes('/media/')).length >= 3, 'master, quality playlist and a segment went through /media/');
  // The segments of the pretend site are not real video, so the TV must end on its error text.
  await until(async () => (await tv.page.locator('#message').innerText()) === CANNOT_PLAY_TEXT, 'the error text on the TV', 30000);
  await until(async () => (await stateOf(tv.session)).playback.status === 'error', '/api/state to say error');
});

test('TV page: reloading the page resumes the video at the last position', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'seek', 50);
  await untilPlaying(tv.page, 50);
  const known = await until(async () => {
    const now = await stateOf(tv.session);
    return now.playback.position >= 50 ? now.playback.position : null;
  }, 'the server to know the position');

  await tv.page.reload();
  await tv.page.locator('#playerScreen').waitFor({ state: 'visible' });
  const video = await untilPlaying(tv.page, known - 0.5);
  assert.ok(video.time < known + 6, 'resumed near ' + known + ' s, got ' + video.time);
  assert.equal(await tv.page.locator('#title').innerText(), 'Holiday film');
  assert.equal((await stateOf(tv.session)).paired, true, 'the TV is still paired');
  assert.equal(await tv.page.locator('#code').isVisible(), false);
});

test('TV page: reloading a paired TV with no video shows "Connected" again, not a code', async () => {
  const tv = await openPairedTv();
  await tv.page.reload();
  await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
  assert.equal(await screenOf(tv.page), 'readyScreen');
  assert.deepEqual((await stateOf(tv.session)).tv, { connected: true });
});

test('TV page: a dropped connection on the code screen shows the "Lost the connection" text, then reconnects', async () => {
  const tv = await openTv();
  dropSocket(server.app);
  await until(async () => (await tv.page.locator('#connection').innerText()) === LOST_TEXT, 'the lost-connection text');
  assert.ok(await tv.page.locator('#connection').isVisible());
  await until(async () => (await tv.page.locator('#connection').innerText()) === '', 'the text to clear after reconnecting', 8000);
  assert.equal(await tv.page.locator('#code').innerText(), tv.code, 'the same code is still valid');
  await pair(tv);
  assert.equal(await screenOf(tv.page), 'readyScreen');
});

test('TV page: a paired TV keeps its pairing over a dropped connection and can still be cast to', async () => {
  const tv = await openPairedTv();
  dropSocket(server.app);
  await until(async () => (await stateOf(tv.session)).tv.connected === false, 'the server to see the TV go offline');
  const offline = await castClip(tv.session);
  assert.deepEqual([offline.status, offline.json], [409, { error: 'tv_offline' }]);
  await until(async () => (await stateOf(tv.session)).tv.connected === true, 'the TV to reconnect', 8000);
  assert.equal(await screenOf(tv.page), 'readyScreen');
  assert.equal((await castClip(tv.session)).status, 200);
  await untilPlaying(tv.page);
});

test('TV page: a paired TV that loses the connection tells the viewer', async () => {
  const tv = await openPairedTv();
  await server.stop();
  try {
    await until(async () => (await tv.page.locator('#connection').innerText()) === LOST_TEXT, 'the text to be set');
    assert.equal(await screenOf(tv.page), 'readyScreen');
    assert.ok(await tv.page.getByText(LOST_TEXT).isVisible(), 'the lost-connection text is visible on the "Connected" screen');
  } finally {
    server = await startApp({ port });
  }
});

test('TV page: a video keeps playing over a dropped connection and is not restarted', async () => {
  const tv = await openPlayingTv();
  await control(tv.session, 'seek', 30);
  await untilPlaying(tv.page, 30);
  const srcBefore = (await videoOf(tv.page)).src;
  dropSocket(server.app);
  await until(async () => (await stateOf(tv.session)).tv.connected === false, 'the server to see the TV go offline');
  await until(async () => (await stateOf(tv.session)).tv.connected === true, 'the TV to reconnect', 8000);
  const video = await untilPlaying(tv.page, 30);
  assert.equal(video.src, srcBefore, 'the same video is still loaded');
  assert.equal(await screenOf(tv.page), 'playerScreen');
  await control(tv.session, 'pause');
  await until(async () => (await videoOf(tv.page)).paused, 'controls to work again after the reconnect');
});

test('TV page: unpair goes back to the code screen with a new code', async () => {
  const tv = await openPlayingTv();
  const result = await call(port, 'POST', '/api/unpair', { session: tv.session, body: {} });
  assert.equal(result.status, 200);
  await tv.page.locator('#pairScreen').waitFor({ state: 'visible' });
  const newCode = await until(async () => {
    const text = await tv.page.locator('#code').innerText();
    return /^\d{6}$/.test(text) && text !== tv.code ? text : null;
  }, 'a new code');
  assert.notEqual(newCode, tv.code);
  assert.equal((await videoOf(tv.page)).src, null, 'the video is unloaded');
  assert.equal((await stateOf(tv.session)).paired, false);
  assert.equal((await control404(tv.session)).status, 401);

  // The new code pairs again.
  const again = await call(port, 'POST', '/api/pair', { body: { code: newCode } });
  assert.equal(again.status, 200);
  await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
});

function control404(session) {
  return call(port, 'POST', '/api/control', { session, body: { action: 'pause' } });
}

test('TV page: a new code appears when the old one runs out', async () => {
  const short = await startApp({ codeLifeSeconds: 2, tidyEveryMs: 250 });
  try {
    const tv = await openTv(short.port);
    const newCode = await until(async () => {
      const text = await tv.page.locator('#code').innerText();
      return /^\d{6}$/.test(text) && text !== tv.code ? text : null;
    }, 'the code to change after it ran out', 8000);
    const old = await call(short.port, 'POST', '/api/pair', { body: { code: tv.code } });
    assert.equal(old.status, 403, 'the old code no longer works');
    const fresh = await shownCode(tv.page);
    assert.ok(fresh === newCode || /^\d{6}$/.test(fresh));
    assert.equal(await screenOf(tv.page), 'pairScreen');
  } finally {
    while (openContexts.length) await openContexts.pop().close();
    await short.stop();
  }
});

test('TV page: server restart shows the "Lost the connection" text, then a new code', async () => {
  const own = await startApp();
  let restarted = null;
  try {
    const tv = await openTv(own.port);
    await own.stop();
    await until(async () => (await tv.page.locator('#connection').innerText()) === LOST_TEXT, 'the lost-connection text');
    assert.ok(await tv.page.getByText(LOST_TEXT).isVisible());
    await wait(2500);
    assert.equal(await tv.page.locator('#connection').innerText(), LOST_TEXT, 'still shown while the server is down');

    restarted = await startApp({ port: own.port });
    await until(async () => (await tv.page.locator('#connection').innerText()) === '', 'the text to clear once the server is back', 10000);
    const code = await shownCode(tv.page);
    const result = await call(restarted.port, 'POST', '/api/pair', { body: { code } });
    assert.equal(result.status, 200, 'the code shown after the restart pairs');
    await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
  } finally {
    while (openContexts.length) await openContexts.pop().close();
    if (restarted) await restarted.stop();
  }
});

test('TV page: after a server restart a TV that was paired shows a code again', async () => {
  const own = await startApp();
  let restarted = null;
  try {
    const tv = await openTv(own.port);
    await pair(tv, own.port);
    await own.stop();
    restarted = await startApp({ port: own.port });
    await tv.page.locator('#pairScreen').waitFor({ state: 'visible', timeout: 10000 });
    const code = await shownCode(tv.page);
    assert.equal((await call(restarted.port, 'POST', '/api/pair', { body: { code } })).status, 200);
    await tv.page.locator('#readyScreen').waitFor({ state: 'visible' });
  } finally {
    while (openContexts.length) await openContexts.pop().close();
    if (restarted) await restarted.stop();
  }
});

test('TV page: after a server restart during a video the TV drops the video and shows its new code', async () => {
  const own = await startApp();
  let restarted = null;
  try {
    const tv = await openTv(own.port);
    const session = await pair(tv, own.port);
    assert.equal((await castClip(session, 'Holiday film', own.port)).status, 200);
    await untilPlaying(tv.page);
    await own.stop();
    restarted = await startApp({ port: own.port });
    // The new server does not know this TV, so it sends a code. The viewer needs to see it.
    await until(() => restarted.app.pairing.tvs.size === 1, 'the TV to reconnect to the new server', 10000);
    await tv.page.locator('#pairScreen').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await screenOf(tv.page), 'pairScreen', 'the code screen is shown');
    assert.equal((await videoOf(tv.page)).src, null, 'the dead video is unloaded');
    const code = await shownCode(tv.page);
    assert.equal((await call(restarted.port, 'POST', '/api/pair', { body: { code } })).status, 200);
  } finally {
    while (openContexts.length) await openContexts.pop().close();
    if (restarted) await restarted.stop();
  }
});

test('TV page: a browser that will not start a video by itself asks for a key press, and the key starts it', async () => {
  // Headless Chromium always lets a video start, so the refusal of a strict TV browser is
  // imitated here: play() is refused until the first key press.
  const tv = await openTv();
  await tv.page.addInitScript(() => {
    const realPlay = HTMLMediaElement.prototype.play;
    let keyPressed = false;
    document.addEventListener('keydown', () => (keyPressed = true), true);
    HTMLMediaElement.prototype.play = function () {
      return keyPressed ? realPlay.call(this) : Promise.reject(new DOMException('play() needs a key press first', 'NotAllowedError'));
    };
  });
  await tv.page.reload();
  tv.code = await shownCode(tv.page);
  const session = await pair(tv);
  assert.equal((await castClip(session)).status, 200);
  await tv.page.locator('#playerScreen').waitFor({ state: 'visible' });
  await until(async () => (await tv.page.locator('#message').innerText()) === 'Press OK on the remote to start', 'the press-OK text');
  assert.ok(await tv.page.locator('#message').isVisible());
  assert.equal((await videoOf(tv.page)).paused, true);
  await wait(4500);
  assert.ok(await tv.page.locator('#message').isVisible(), 'the text stays until a key is pressed');
  await tv.page.keyboard.press('Enter');
  await untilPlaying(tv.page);
  assert.equal(await tv.page.locator('#message').innerText(), '');
});

test('TV page: the first remote key goes full screen (hiding the browser bar), later keys act as usual', async () => {
  const fullScreenBrowser = await launchBrowser({ fullScreen: true });
  const context = await fullScreenBrowser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:' + port + '/');
  const isFullScreen = () => page.evaluate(() => !!document.fullscreenElement);
  const hintShown = () => page.evaluate(() => document.getElementById('fullScreenHint').className !== 'hidden');
  assert.equal(await hintShown(), true, 'the hint is shown while the browser bar is visible');

  await page.keyboard.press('Enter');
  await until(isFullScreen, 'full screen after the first key');
  assert.equal(await hintShown(), false);
  assert.equal(await page.evaluate(() => document.getElementById('pairScreen').className), 'screen', 'the key did nothing else');

  await fullScreenBrowser.close();
});

test('AC-18: the on-screen buttons pause, play, and move 10 seconds; they hide while playing and come back with the pointer', async () => {
  const tv = await openPlayingTv();
  const page = tv.page;
  const label = () => page.locator('#playButton').innerText();

  await page.locator('#playButton').click();
  await until(async () => (await videoOf(page)).paused, 'the Pause button to pause the video');
  await until(async () => (await label()) === 'Play', 'the button to offer Play');
  assert.ok(await page.locator('#buttons').isVisible(), 'the buttons stay on screen while paused');

  await control(tv.session, 'seek', 40);
  await until(async () => (await videoOf(page)).time === 40, 'the video to be at 40 s');
  await page.locator('#forwardButton').click();
  await until(async () => (await videoOf(page)).time === 50, '+10s to move to 50 s');
  await page.locator('#backButton').click();
  await page.locator('#backButton').click();
  await until(async () => (await videoOf(page)).time === 30, 'two -10s to move to 30 s');
  assert.ok(await page.locator('#buttons').isVisible(), 'still on screen after seeking while paused');

  await page.locator('#playButton').click();
  await untilPlaying(page, 30);
  await until(async () => (await label()) === 'Pause', 'the button to offer Pause');
  assert.equal((await stateOf(tv.session)).playback.status, 'playing');

  await page.locator('#overlay').waitFor({ state: 'hidden', timeout: 7000 });
  await page.mouse.move(300, 300);
  await page.mouse.move(320, 320);
  await page.locator('#buttons').waitFor({ state: 'visible' });

  // The buttons are plain boxes, so the OK key is not also taken as a button press.
  await page.keyboard.press('Enter');
  await until(async () => (await videoOf(page)).paused, 'OK to pause once');
  await wait(300);
  assert.equal((await videoOf(page)).paused, true, 'and not to start it again');
});

test('AC-19: subtitle timing moves every line later, earlier, and back to the file\'s times', async () => {
  const tv = await openPairedTv();
  const sent = await call(port, 'POST', '/api/cast', {
    session: tv.session,
    body: {
      url: site.link('/media/clip.webm'),
      kind: 'file',
      headers: { referer: site.link('/watch.html') },
      subtitles: [{ url: site.link('/media/eng.vtt'), label: 'eng' }],
      subtitle: 0
    }
  });
  assert.equal(sent.status, 200);
  const times = () =>
    tv.page.evaluate(() => {
      const video = /** @type {HTMLVideoElement} */ (document.getElementById('video'));
      // Just after the cast is sent the TV page may not have added the subtitle yet.
      const lines = video.textTracks[0] && video.textTracks[0].cues;
      return lines ? Array.from(lines).map((line) => [line.startTime, line.endTime]) : null;
    });
  // Wait until it plays: the start of playback clears the message on screen.
  await untilPlaying(tv.page);
  await until(async () => (await times()) && (await times()).length === 2, 'the subtitle file to load');
  assert.deepEqual(await times(), [[5, 7], [10, 12]]);

  await control(tv.session, 'subtitleShift', 2);
  await until(async () => (await times())[0][0] === 7, 'the lines to move 2 s later');
  assert.deepEqual(await times(), [[7, 9], [12, 14]]);
  assert.equal(await tv.page.locator('#message').innerText(), 'Subtitles 2 s later');

  await control(tv.session, 'subtitleShift', -1.5);
  await until(async () => (await times())[0][0] === 3.5, 'the lines to move 1.5 s earlier than the file');
  assert.deepEqual(await times(), [[3.5, 5.5], [8.5, 10.5]]);
  assert.equal(await tv.page.locator('#message').innerText(), 'Subtitles 1.5 s earlier');

  await control(tv.session, 'subtitleShift', 0);
  await until(async () => (await times())[0][0] === 5, 'the lines to go back to the file\'s times');
  assert.equal(await tv.page.locator('#message').innerText(), 'Subtitles in time with the file');

  // A reloaded TV page gets the timing again with the video.
  await control(tv.session, 'subtitleShift', 0.75);
  await tv.page.reload();
  await until(async () => (await times()) && (await times()).length === 2 && (await times())[0][0] === 5.75, 'the timing to be applied after a reload');
});

test('AC-20: an open TV page reloads itself when the server comes back with a newer page, and not otherwise', async () => {
  const own = await startApp({ tvPageVersion: 'build-one' });
  let restarted = null;
  try {
    const tv = await openTv(own.port);
    // A mark that only a reload removes.
    await tv.page.evaluate(() => (window.stillTheSamePage = true));
    const samePage = () => tv.page.evaluate(() => window.stillTheSamePage === true).catch(() => false);

    await own.stop();
    restarted = await startApp({ port: own.port, tvPageVersion: 'build-one' });
    await shownCodeAfterReconnect(tv.page);
    assert.equal(await samePage(), true, 'same version: the page is left alone');

    await restarted.stop();
    restarted = await startApp({ port: own.port, tvPageVersion: 'build-two' });
    await until(async () => !(await samePage()), 'the page to reload for the newer version', 15000);
    await shownCode(tv.page);
  } finally {
    while (openContexts.length) await openContexts.pop().close();
    if (restarted) await restarted.stop();
  }
});

// After a server restart the page first shows "Lost the connection", then a fresh code.
async function shownCodeAfterReconnect(page) {
  await until(async () => (await page.locator('#connection').innerText()) === LOST_TEXT, 'the page to notice the server is gone', 15000);
  await until(async () => (await page.locator('#connection').innerText()) === '', 'the page to reconnect', 15000);
  return shownCode(page);
}

test('AC-23: the remote works the player like an app: arrows choose, OK presses', async () => {
  const tv = await openPlayingTv();
  const page = tv.page;
  const press = (key) => page.keyboard.press(key);
  const selected = () =>
    page.evaluate(() => {
      const ids = ['bar', 'backButton', 'playButton', 'forwardButton', 'stopButton'];
      return ids.filter((id) => /selected/.test(document.getElementById(id).className)).join(',');
    });
  assert.equal(await selected(), 'bar', 'the remote starts on the progress bar');

  await control(tv.session, 'pause');
  await until(async () => (await videoOf(page)).paused, 'the video to pause');
  await control(tv.session, 'seek', 40);
  await until(async () => (await videoOf(page)).time === 40, 'the video to be at 40 s');

  await press('ArrowDown');
  assert.equal(await selected(), 'playButton', 'Down goes to the buttons, on Play/Pause');
  await press('ArrowRight');
  assert.equal(await selected(), 'forwardButton');
  assert.equal((await videoOf(page)).time, 40, 'on the buttons, Right moves the highlight, not the video');
  await press('Enter');
  await until(async () => (await videoOf(page)).time === 50, 'OK on +10s to move to 50 s');

  await press('ArrowLeft');
  await press('ArrowLeft');
  await press('ArrowLeft');
  assert.equal(await selected(), 'backButton', 'the highlight stops at the first button');
  await press('Enter');
  await until(async () => (await videoOf(page)).time === 40, 'OK on -10s to move back to 40 s');

  await press('ArrowRight');
  await press('Enter');
  await untilPlaying(page, 40);
  assert.equal(await selected(), 'playButton');

  await press('ArrowUp');
  assert.equal(await selected(), 'bar', 'Up goes back to the progress bar');
  await press('Enter');
  await until(async () => (await videoOf(page)).paused, 'OK on the bar to pause');
  await press('ArrowRight');
  await until(async () => (await videoOf(page)).time >= 50, 'Right on the bar to move 10 s');
  await press('Enter');
  await untilPlaying(page, 50);

  // When the controls hide, the pointer hides too and the remote is back on the bar.
  await press('ArrowDown');
  await page.locator('#overlay').waitFor({ state: 'hidden', timeout: 7000 });
  assert.equal(await selected(), 'bar');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('playerScreen')).cursor), 'none');
  await page.mouse.move(200, 200);
  await page.mouse.move(220, 220);
  await until(async () => (await page.evaluate(() => getComputedStyle(document.getElementById('playerScreen')).cursor)) !== 'none', 'the pointer to come back when moved');

  await press('ArrowDown');
  for (let i = 0; i < 5; i++) await press('ArrowRight');
  assert.equal(await selected(), 'stopButton', 'the highlight stops at the last button');
  await press('Enter');
  await page.locator('#readyScreen').waitFor({ state: 'visible' });
  await until(async () => (await stateOf(tv.session)).cast === null, 'Stop to end the cast on the server');
});
