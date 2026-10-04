'use strict';
// Tests the whole server over real HTTP and WebSocket: a pretend extension, TV and video site.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../../server/app');
const { setupLogger } = require('../../server/logger');
const { VideoList, handleVideoRequest, rewritePlaylist, serverPathFor, signLink } = require('../../server/proxy');
const { PAGE, startFakeSite, call, connectTv, listen, wait } = require('./tools');

const COOKIE = 'login=TOP-SECRET-COOKIE';
const HEADERS = { referer: PAGE, origin: 'https://page.example', cookie: COOKIE, userAgent: 'TestBrowser/1.0' };
const EXTENSION = { origin: 'chrome-extension://abcdefgh' };

let site;
let app;
let port;
const logLines = [];

before(async () => {
  setupLogger({ level: 'debug', print: (line) => logLines.push(line) });
  site = await startFakeSite();
  app = createApp({ listenOn: '127.0.0.1', wrongCodesPerMinute: 1000 });
  port = await app.start();
});

after(async () => {
  await app.stop();
  await site.stop();
  setupLogger({ level: 'off' });
});

// Connects a pretend TV and pairs with it. Returns the TV and the session.
async function pairedTv(id) {
  const tv = await connectTv(port, id);
  const { code } = await tv.next('pair.code');
  const paired = await call(port, 'POST', '/api/pair', { body: { code } });
  assert.equal(paired.status, 200);
  await tv.next('pair.ok');
  return { tv, session: paired.json.session, code };
}

async function castTo(session, tv, path, kind) {
  const result = await call(port, 'POST', '/api/cast', { session, body: { url: site.link(path), kind, title: 'My video', headers: HEADERS } });
  assert.equal(result.status, 200);
  return tv.next('media.load');
}

test('AC-1 AC-2: the right code pairs; wrong and used codes do not', async () => {
  const tv = await connectTv(port, 'television-pair');
  const shown = await tv.next('pair.code');
  assert.match(shown.code, /^\d{6}$/);
  assert.equal(shown.v, 1);
  assert.ok(shown.expiresInSec > 290 && shown.expiresInSec <= 300);

  const wrong = await call(port, 'POST', '/api/pair', { body: { code: shown.code === '123456' ? '654321' : '123456' } });
  assert.deepEqual([wrong.status, wrong.json], [403, { error: 'bad_code' }]);

  const right = await call(port, 'POST', '/api/pair', { body: { code: shown.code }, headers: EXTENSION });
  assert.equal(right.status, 200);
  assert.ok(right.json.session.length > 20);
  assert.equal(right.headers['access-control-allow-origin'], EXTENSION.origin);
  await tv.next('pair.ok');

  const again = await call(port, 'POST', '/api/pair', { body: { code: shown.code } });
  assert.equal(again.status, 403, 'a used code does not work again');

  const state = await call(port, 'GET', '/api/state', { session: right.json.session });
  assert.equal(state.json.paired, true);
  assert.deepEqual(state.json.tv, { connected: true });
  assert.equal(state.json.cast, null);
  await tv.close();
});

test('AC-2: too many wrong codes are blocked', async () => {
  const strict = createApp({ listenOn: '127.0.0.1', wrongCodesPerMinute: 2 });
  const strictPort = await strict.start();
  await call(strictPort, 'POST', '/api/pair', { body: { code: '1' } });
  await call(strictPort, 'POST', '/api/pair', { body: { code: '2' } });
  const blocked = await call(strictPort, 'POST', '/api/pair', { body: { code: '3' } });
  assert.deepEqual([blocked.status, blocked.json], [429, { error: 'too_many_tries' }]);
  await strict.stop();
});

test('AC-3: a second sender cannot join a paired TV, and a second TV gets its own code', async () => {
  const { tv, code } = await pairedTv('television-second');
  const secondSender = await call(port, 'POST', '/api/pair', { body: { code } });
  assert.equal(secondSender.status, 403);
  for (const route of ['/api/cast', '/api/control', '/api/unpair']) {
    const result = await call(port, 'POST', route, { session: 'made-up-session', body: {} });
    assert.deepEqual([result.status, result.json], [401, { error: 'not_paired' }], route);
  }
  const unpaired = await call(port, 'GET', '/api/state', {});
  assert.equal(unpaired.json.paired, false);
  assert.equal(unpaired.json.playback, null);

  const otherTv = await connectTv(port, 'television-other');
  const other = await otherTv.next('pair.code');
  assert.notEqual(other.code, code);
  await otherTv.close();
  await tv.close();
});

test('AC-4: an MP4 plays through the server with the page headers, including ranges', async () => {
  const { tv, session } = await pairedTv('television-mp4');
  const load = await castTo(session, tv, '/video.mp4?token=LINK-TOKEN', 'file');
  assert.equal(load.kind, 'file');
  assert.equal(load.title, 'My video');
  assert.equal(load.startAt, 0);
  assert.match(load.url, /^\/media\//);

  site.seen.length = 0;
  const whole = await call(port, 'GET', load.url);
  assert.equal(whole.status, 200);
  assert.equal(whole.raw.length, 1000);
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.equal(whole.headers['access-control-allow-origin'], '*');
  const sent = site.seen[0].headers;
  assert.equal(sent.referer, PAGE);
  assert.equal(sent.origin, 'https://page.example');
  assert.equal(sent.cookie, COOKIE);
  assert.equal(sent['user-agent'], 'TestBrowser/1.0');

  const part = await call(port, 'GET', load.url, { headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.raw.length, 10);
  assert.equal(part.headers['content-range'], 'bytes 10-19/1000');

  const head = await call(port, 'HEAD', load.url);
  assert.deepEqual([head.status, head.raw.length, head.headers['content-length']], [200, 0, '1000']);
  assert.equal((await call(port, 'POST', load.url)).status, 405);

  const state = await call(port, 'GET', '/api/state', { session });
  assert.deepEqual(state.json.cast, { title: 'My video', kind: 'file', siteStatus: 200, subtitles: [], subtitle: -1, subtitleShift: 0 });
  assert.equal(state.json.playback.status, 'loading');
  await tv.close();
});

test('AC-5: every link in an HLS playlist goes through the server', async () => {
  const { tv, session } = await pairedTv('television-hls');
  const load = await castTo(session, tv, '/hls/master.m3u8', undefined);
  assert.equal(load.kind, 'hls', 'the kind is worked out from the link when not given');

  const master = await call(port, 'GET', load.url);
  assert.equal(master.headers['content-type'], 'application/vnd.apple.mpegurl');
  const masterLinks = master.text.match(/\/media\/[^\s"]+/g);
  assert.equal(masterLinks.length, 2, 'the audio track and the quality playlist');
  assert.doesNotMatch(master.text, /127\.0\.0\.1|index\.m3u8/);

  const quality = await call(port, 'GET', masterLinks[1]);
  const lines = quality.text.split('\n');
  assert.match(lines[1], /^#EXT-X-KEY:METHOD=AES-128,URI="\/media\/[^"]+"$/);
  const segments = lines.filter((line) => line.startsWith('/media/'));
  assert.equal(segments.length, 2);

  site.seen.length = 0;
  const first = await call(port, 'GET', segments[0]);
  assert.deepEqual([first.status, first.text], [200, 'segment-bytes']);
  assert.equal(site.seen[0].headers.cookie, COOKIE);
  const otherSite = await call(port, 'GET', segments[1]);
  assert.equal(otherSite.status, 200);
  assert.equal(site.seen[1].headers.cookie, undefined, 'the cookie is not sent to a different site');
  assert.equal(site.seen[1].headers.referer, PAGE);
  await tv.close();
});

test('proxy: playlists without a name, redirects, empty answers, and site problems', async () => {
  const { tv, session } = await pairedTv('television-edge');

  let load = await castTo(session, tv, '/playlist-without-name', 'hls');
  const playlist = await call(port, 'GET', load.url);
  assert.match(playlist.text, /\n\/media\//, 'spotted as a playlist from its first line');

  load = await castTo(session, tv, '/moved', 'file');
  assert.equal((await call(port, 'GET', load.url)).raw.length, 1000);

  load = await castTo(session, tv, '/moved-forever', 'file');
  assert.equal((await call(port, 'GET', load.url)).status, 502, 'gives up after 5 redirects');

  load = await castTo(session, tv, '/empty', 'file');
  const empty = await call(port, 'GET', load.url);
  assert.deepEqual([empty.status, empty.raw.length], [200, 0]);

  load = await castTo(session, tv, '/huge.m3u8', 'hls');
  await assert.rejects(call(port, 'GET', load.url), /socket hang up|aborted|ECONNRESET/, 'a playlist that is too big is cut off');

  load = await castTo(session, tv, '/gone.mp4', 'file');
  assert.equal((await call(port, 'GET', load.url)).status, 410);
  assert.equal((await call(port, 'GET', '/api/state', { session })).json.cast.siteStatus, 410);
  await tv.close();
});

test('proxy: answers that would break the TV or the server are turned into clear failures', async () => {
  const { tv, session } = await pairedTv('television-broken');

  let load = await castTo(session, tv, '/bad-redirect', 'file');
  assert.equal((await call(port, 'GET', load.url)).status, 502, 'a redirect to a broken address');

  load = await castTo(session, tv, '/squeezed.mp4', 'file');
  assert.equal((await call(port, 'GET', load.url)).status, 502, 'a compressed answer we did not ask for');

  load = await castTo(session, tv, '/drops.mp4', 'file');
  await assert.rejects(call(port, 'GET', load.url), /aborted|socket hang up|ECONNRESET/, 'the TV is not left waiting when the site drops');

  load = await castTo(session, tv, '/slow.mp4', 'file');
  await new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: load.url });
    request.on('error', resolve);
    setTimeout(() => request.destroy(), 50);
  });
  await wait(400);
  const state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.equal(state.cast.siteStatus, 0, 'the TV giving up is not counted as a site failure');

  const odd = await call(port, 'POST', '/api/cast', {
    session,
    body: { url: site.link('/video.mp4'), headers: { referer: PAGE, cookie: 'name=\u65e5\u672c', userAgent: 'two\nlines' } }
  });
  assert.equal(odd.status, 200);
  site.seen.length = 0;
  const played = await call(port, 'GET', (await tv.next('media.load')).url);
  assert.equal(played.status, 200);
  assert.equal(site.seen[0].headers.cookie, undefined, 'a header value that cannot be sent is left out');
  assert.notEqual(site.seen[0].headers['user-agent'], 'two\nlines');
  await tv.close();
});

test('proxy: a video from the internet can never make the server fetch from the home network', async () => {
  const videos = new VideoList();
  const server = http.createServer((request, response) => handleVideoRequest(request, response, videos));
  const proxyPort = await listen(server);
  const video = videos.add('https://site.example/v.m3u8', { referer: PAGE });
  site.seen.length = 0;
  for (const link of [site.link('/video.mp4'), site.link('/video.mp4').replace('127.0.0.1', 'localhost'), site.link('/video.mp4').replace('127.0.0.1', 'localhost.'), 'http://192.168.1.1/admin', 'http://[::1]/x']) {
    assert.equal((await call(proxyPort, 'GET', serverPathFor(video, link))).status, 502, link);
  }
  assert.equal(site.seen.length, 0);
  await new Promise((resolve) => server.close(resolve));
});

test('AC-6: made-up and changed video links are refused without contacting the site', async () => {
  const { tv, session } = await pairedTv('television-refuse');
  const load = await castTo(session, tv, '/video.mp4', 'file');
  const [, , videoId, signature] = load.url.split('/');
  const otherLink = Buffer.from(site.link('/hls/master.m3u8')).toString('base64url');
  site.seen.length = 0;

  assert.equal((await call(port, 'GET', '/media/unknown-video/' + signature + '/' + otherLink)).status, 404);
  assert.equal((await call(port, 'GET', '/media/' + videoId + '/' + signature + '/' + otherLink)).status, 403);
  assert.equal((await call(port, 'GET', '/media/' + videoId + '/short/' + otherLink)).status, 403);
  assert.equal((await call(port, 'GET', '/media/' + videoId)).status, 403);
  assert.equal(site.seen.length, 0);

  await call(port, 'POST', '/api/control', { session, body: { action: 'stop' } });
  assert.equal((await call(port, 'GET', load.url)).status, 404, 'after stop the link is dead');
  await tv.close();
});

test('proxy: links that are not web links, and a site that is down, give 502', async () => {
  const videos = new VideoList();
  const server = http.createServer((request, response) => handleVideoRequest(request, response, videos));
  const proxyPort = await listen(server);
  const video = videos.add('https://site.example/v.mp4');
  for (const link of ['ftp://site.example/v.mp4', 'not a link', 'http://127.0.0.1:1/down.mp4']) {
    assert.equal((await call(proxyPort, 'GET', serverPathFor(video, link))).status, 502, link);
  }
  assert.equal(video.lastSiteStatus, 502);
  assert.notEqual(signLink(video, 'a'), signLink(videos.add('https://site.example/v.mp4'), 'a'));
  videos.remove(video.id);
  assert.equal(videos.get(video.id), undefined);
  await new Promise((resolve) => server.close(resolve));
});

test('proxy: playlist rewriting keeps comments, blank lines and data links', () => {
  const text = ['#EXTM3U', '', '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-KEY:URI="data:text/plain,abc"', 'seg.ts', 'https://cdn.example/x.ts', '  ', 'http://[bad'].join('\r\n');
  const out = rewritePlaylist(text, 'https://site.example/a/list.m3u8', (link) => 'P(' + link + ')').split('\n');
  assert.deepEqual(out, [
    '#EXTM3U',
    '',
    '#EXT-X-MAP:URI="P(https://site.example/a/init.mp4)"',
    '#EXT-X-KEY:URI="data:text/plain,abc"',
    'P(https://site.example/a/seg.ts)',
    'P(https://cdn.example/x.ts)',
    '  ',
    'http://[bad'
  ]);
});

test('AC-7: only the extension on this computer may use the API', async () => {
  const fromWebPage = await call(port, 'GET', '/api/state', { headers: { origin: 'https://evil.example' } });
  assert.deepEqual([fromWebPage.status, fromWebPage.json], [403, { error: 'forbidden' }]);
  const wrongHost = await call(port, 'GET', '/api/state', { headers: { host: 'evil.example' } });
  assert.equal(wrongHost.status, 403);
  const localhost = await call(port, 'GET', '/api/state', { headers: { host: 'localhost:' + port, origin: 'moz-extension://abc' } });
  assert.equal(localhost.status, 200);
  assert.equal(localhost.json.v, 1);
  assert.ok(Array.isArray(localhost.json.tvAddresses));

  const preflight = await call(port, 'OPTIONS', '/api/pair', { headers: EXTENSION });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers['access-control-allow-headers'], /x-vcast-session/);
});

test('API: bad requests get clear answers', async () => {
  const { tv, session } = await pairedTv('television-bad');
  const post = (route, body) => call(port, 'POST', route, { session, body });
  assert.equal((await post('/api/cast', 'null')).status, 400);
  assert.equal((await post('/api/cast', '[1]')).status, 400);
  assert.equal((await post('/api/cast', { url: ['https://site.example/v.mp4'] })).status, 400);
  assert.equal((await post('/api/cast', '{not json')).status, 400);
  assert.equal((await post('/api/cast', 'x'.repeat(70000))).status, 400);
  assert.equal((await post('/api/cast', { url: 'ftp://site.example/v.mp4' })).status, 400);
  assert.equal((await post('/api/cast', {})).status, 400);
  assert.equal((await post('/api/control', { action: 'dance' })).status, 400);
  assert.equal((await post('/api/control', { action: 'seek', value: -5 })).status, 400);
  assert.equal((await post('/api/control', { action: 'volume' })).status, 400);
  assert.equal((await post('/api/nothing', {})).status, 404);
  assert.equal((await call(port, 'GET', '/api/nothing', { session })).status, 404);
  assert.equal((await call(port, 'GET', '/nothing')).status, 404);
  assert.equal((await call(port, 'POST', '/')).status, 404);
  await tv.close();
});

test('AC-8: controls reach the TV and the TV state reaches the extension', async () => {
  const { tv, session } = await pairedTv('television-control');
  await castTo(session, tv, '/video.mp4', 'file');
  const control = (body) => call(port, 'POST', '/api/control', { session, body });

  await control({ action: 'pause' });
  assert.deepEqual(await tv.next('media.control'), { v: 1, type: 'media.control', action: 'pause', value: 0 });
  await control({ action: 'play' });
  assert.equal((await tv.next('media.control')).action, 'play');
  await control({ action: 'seek', value: 42 });
  assert.equal((await tv.next('media.control')).value, 42);
  await control({ action: 'volume', value: 5 });
  assert.equal((await tv.next('media.control')).value, 1, 'volume is capped at 1');

  tv.send({ type: 'media.state', status: 'playing', position: 12.5, duration: 100, volume: 0.4 });
  tv.send('not an object');
  tv.socket.send('{broken');
  await wait(50);
  let state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.deepEqual(state.playback, { status: 'playing', position: 12.5, duration: 100, volume: 0.4 });

  tv.send({ type: 'media.state', status: 'made-up', position: -1, duration: 'x', volume: 9, error: 5 });
  await wait(50);
  state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.deepEqual(state.playback, { status: 'idle', position: 0, duration: 0, volume: 1 }, 'odd values from the TV are cleaned');

  tv.send({ type: 'media.state', status: 'error', error: 'cannot_play' });
  tv.send({ type: 'media.state', status: 'error', error: 'cannot_play' });
  await wait(50);
  state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.equal(state.playback.error, 'cannot_play');
  assert.equal(logLines.filter((line) => /TV could not play/.test(line) && /televi/.test(line)).length, 1, 'a repeated error is logged once');

  await control({ action: 'stop' });
  assert.equal((await tv.next('media.control')).action, 'stop');
  state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.equal(state.cast, null);
  assert.equal(state.playback.status, 'idle');
  await tv.close();
});

test('AC-9: a reloaded TV page gets the video again from where it was; a dropped one keeps playing', async () => {
  const { tv, session } = await pairedTv('television-resume');
  const firstLoad = await castTo(session, tv, '/video.mp4', 'file');
  tv.send({ type: 'media.state', status: 'playing', position: 73, duration: 100, volume: 1 });
  await wait(50);
  await tv.close();
  await wait(50);

  const offline = await call(port, 'POST', '/api/control', { session, body: { action: 'pause' } });
  assert.deepEqual([offline.status, offline.json], [409, { error: 'tv_offline' }]);
  assert.deepEqual((await call(port, 'GET', '/api/state', { session })).json.tv, { connected: false });

  const reloaded = await connectTv(port, 'television-resume', { hasVideo: false });
  await reloaded.next('pair.ok');
  const again = await reloaded.next('media.load');
  assert.equal(again.startAt, 73);
  assert.equal(again.url, firstLoad.url);

  const dropped = await connectTv(port, 'television-resume', { hasVideo: true });
  await dropped.next('pair.ok');
  await reloaded.closed;
  await wait(50);
  assert.equal(dropped.got.length, 0, 'the video is not sent again while the TV still has it');
  await dropped.close();
});

test('subtitles go through the server and can be switched while playing', async () => {
  const { tv, session } = await pairedTv('television-subtitles');
  const control = (body) => call(port, 'POST', '/api/control', { session, body });
  assert.equal((await control({ action: 'subtitle', value: 0 })).status, 400, 'nothing is playing yet');
  assert.equal((await control({ action: 'subtitleShift', value: 1 })).status, 400, 'nothing is playing yet');

  const subtitles = [{ url: site.link('/subs/eng-2.vtt'), label: 'eng-2' }, { url: 'ftp://bad', label: 'bad' }, null, { url: site.link('/subs/other.vtt') }];
  const sent = await call(port, 'POST', '/api/cast', { session, body: { url: site.link('/video.mp4'), headers: HEADERS, subtitles, subtitle: 0 } });
  assert.equal(sent.status, 200);
  const load = await tv.next('media.load');
  assert.deepEqual(load.subtitles.map((subtitle) => subtitle.label), ['eng-2', 'Subtitles'], 'entries that are not web links are left out');
  assert.equal(load.subtitle, 0);
  assert.match(load.subtitles[0].url, /^\/media\//);

  const file = await call(port, 'GET', load.subtitles[0].url);
  assert.deepEqual([file.status, file.headers['content-type']], [200, 'text/vtt']);
  assert.match(file.text, /^WEBVTT/);

  await control({ action: 'subtitle', value: 1 });
  assert.deepEqual(await tv.next('media.control'), { v: 1, type: 'media.control', action: 'subtitle', value: 1 });
  let state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.deepEqual([state.cast.subtitles, state.cast.subtitle], [['eng-2', 'Subtitles'], 1]);

  for (const value of [-1, 7, 'x', 0.5]) {
    await control({ action: 'subtitle', value });
    assert.equal((await tv.next('media.control')).value, -1, 'anything not in the list means off: ' + value);
  }

  // AC-19: subtitle timing
  assert.equal(load.subtitleShift, 0, 'a new cast starts with the file\'s own timing');
  for (const value of [2, -1.5, 0, 300, -300]) {
    assert.equal((await control({ action: 'subtitleShift', value })).status, 200, String(value));
    assert.deepEqual(await tv.next('media.control'), { v: 1, type: 'media.control', action: 'subtitleShift', value });
    assert.equal((await call(port, 'GET', '/api/state', { session })).json.cast.subtitleShift, value);
  }
  for (const value of [300.5, -301, 'soon', undefined]) {
    assert.equal((await control({ action: 'subtitleShift', value })).status, 400, 'refused: ' + value);
  }
  await control({ action: 'subtitleShift', value: 0.75 });
  await tv.next('media.control');
  await tv.close();
  const reloaded = await connectTv(port, 'television-subtitles', { hasVideo: false });
  assert.equal((await reloaded.next('media.load')).subtitleShift, 0.75, 'a reloaded TV page gets the timing again');

  await castTo(session, reloaded, '/video.mp4', 'file');
  state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.deepEqual([state.cast.subtitles, state.cast.subtitle, state.cast.subtitleShift], [[], -1, 0], 'a cast without subtitles, timing back to zero');
  await reloaded.close();
});

test('TV remote: Stop ends the cast, and OK on the Connected screen asks for a new code', async () => {
  const { tv, session, code } = await pairedTv('television-remote');
  const load = await castTo(session, tv, '/video.mp4', 'file');
  tv.send({ type: 'media.stopped' });
  await wait(50);
  let state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.deepEqual([state.cast, state.playback.status], [null, 'idle']);
  assert.equal((await call(port, 'GET', load.url)).status, 404);

  tv.send({ type: 'pair.restart' });
  const fresh = await tv.next('pair.code');
  assert.notEqual(fresh.code, code);
  state = (await call(port, 'GET', '/api/state', { session })).json;
  assert.equal(state.paired, false);
  tv.send({ type: 'pair.restart' });
  tv.send({ type: 'media.stopped' });
  await wait(50);
  assert.equal(tv.got.length, 0, 'an unpaired TV asking again changes nothing');
  await tv.close();
});

test('odd TV messages and connections never stop the server', async () => {
  const WebSocket = require('ws');
  const tv = await connectTv(port, 'television-odd');
  await tv.next('pair.code');
  for (const text of ['null', '5', '"text"', '[]', '{"type":{}}']) tv.socket.send(text);
  await wait(50);

  const refused = (address, options) => new Promise((resolve) => new WebSocket(address, options).on('error', () => resolve('refused')).on('open', () => resolve('open')));
  assert.equal(await refused('ws://127.0.0.1:' + port + '//'), 'refused');
  assert.equal(await refused('ws://127.0.0.1:' + port + '/tv', { origin: 'https://evil.example' }), 'refused', 'a web page cannot pretend to be the TV');
  assert.equal(await refused('ws://127.0.0.1:' + port + '/tv?id=television-ok', { origin: 'http://127.0.0.1:' + port }), 'open');
  assert.equal((await call(port, 'GET', '/api/state')).status, 200);
  await tv.close();
});

test('AC-7: nothing is answered outside the home network, and a full TV list refuses new TVs', async () => {
  const closed = createApp({ listenOn: '127.0.0.1', isHomeNetwork: () => false });
  const closedPort = await closed.start();
  await assert.rejects(call(closedPort, 'GET', '/'), /socket hang up|ECONNRESET/);
  await assert.rejects(call(closedPort, 'GET', '/api/state'), /socket hang up|ECONNRESET/);
  await assert.rejects(connectTv(closedPort, 'television-far'));
  await closed.stop();

  const small = createApp({ listenOn: '127.0.0.1' });
  const smallPort = await small.start();
  const tvs = [];
  for (let i = 0; i < 8; i++) tvs.push(await connectTv(smallPort, 'television-n' + i));
  const extra = await connectTv(smallPort, 'television-extra');
  await extra.closed;
  assert.equal(small.pairing.tvs.size, 8);
  assert.equal(small.pairing.tvs.has('television-n0'), true, 'the TVs already connected stay');
  await small.stop();
});

test('Open on TV: the TV browser is sent to the page and pairs without a code', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vcast-open-'));
  const savedTvsFile = path.join(folder, 'tvs.json');
  const asked = [];
  let answer = { token: 'tv-token' };
  const tvRemote = {
    findTvs: async () => [{ ip: '192.168.1.6', name: 'Living room', model: 'X' }],
    openPageOnTv: async (options) => {
      asked.push(options);
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
  const remoteApp = createApp({ listenOn: '127.0.0.1', tvRemote, savedTvsFile });
  const remotePort = await remoteApp.start();
  const open = (ip) => call(remotePort, 'POST', '/api/open-on-tv', { body: { ip } });

  assert.deepEqual((await call(remotePort, 'GET', '/api/tvs')).json, { tvs: [{ ip: '192.168.1.6', name: 'Living room', model: 'X' }] });
  for (const ip of ['8.8.8.8', 'not an address', '::1', undefined]) {
    assert.deepEqual((await open(ip)).json, { error: 'bad_tv_address' }, String(ip));
  }
  assert.equal(asked.length, 0, 'only home-network TVs are contacted');

  const opened = await open('192.168.1.6');
  assert.equal(opened.status, 200);
  const { session } = opened.json;
  assert.match(asked[0].pageLink, new RegExp('^http://[\\d.]+:' + remotePort + '/key-[\\w-]{20,}$'));
  const keyPage = await call(remotePort, 'GET', new URL(asked[0].pageLink).pathname);
  assert.match(keyPage.text, /<video id="video"/, 'the link with the key shows the TV page');
  assert.equal(asked[0].token, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(savedTvsFile, 'utf8')), { '192.168.1.6': 'tv-token' }, 'the TV\'s permission is remembered');

  let state = (await call(remotePort, 'GET', '/api/state', { session })).json;
  assert.deepEqual([state.paired, state.waitingForTv], [false, true]);

  const key = new URL(asked[0].pageLink).pathname.slice('/key-'.length);
  const tv = await connectTv(remotePort, 'television-opened&key=' + key);
  await tv.next('pair.ok');
  state = (await call(remotePort, 'GET', '/api/state', { session })).json;
  assert.deepEqual([state.paired, state.waitingForTv], [true, false]);
  assert.equal(tv.got.length, 0, 'no code is shown');

  await open('192.168.1.6');
  assert.equal(asked[1].token, 'tv-token', 'the saved permission is used the next time');

  answer = Object.assign(new Error('refused'), { code: 'tv_refused' });
  assert.deepEqual((await open('192.168.1.6')).json, { error: 'tv_refused' });
  answer = new Error('something else');
  const failed = await open('192.168.1.6');
  assert.deepEqual([failed.status, failed.json], [502, { error: 'tv_unreachable' }]);

  await tv.close();
  await remoteApp.stop();
  const restarted = createApp({ listenOn: '127.0.0.1', tvRemote, savedTvsFile });
  await restarted.start();
  await restarted.stop();
  fs.rmSync(folder, { recursive: true });
});

test('unpair ends the cast and shows a new code', async () => {
  const { tv, session, code } = await pairedTv('television-unpair');
  const load = await castTo(session, tv, '/video.mp4', 'file');
  assert.equal((await call(port, 'POST', '/api/unpair', { session, body: {} })).status, 200);
  await tv.next('session.end');
  const fresh = await tv.next('pair.code');
  assert.notEqual(fresh.code, code);
  assert.equal((await call(port, 'GET', load.url)).status, 404);
  assert.equal((await call(port, 'POST', '/api/control', { session, body: { action: 'play' } })).status, 401);
  await tv.close();
});

test('tidy up: shows a new code when the old one ran out and drops TVs that stopped answering', async () => {
  let time = Date.now();
  const timed = createApp({ listenOn: '127.0.0.1', now: () => time, tidyEveryMs: 100000 });
  const timedPort = await timed.start();
  const tv = await connectTv(timedPort, 'television-tidy');
  const first = await tv.next('pair.code');

  timed.tidyUp();
  await wait(50);
  assert.equal(tv.got.length, 0, 'the code is still good, so nothing is sent');

  time += 301 * 1000;
  timed.tidyUp();
  const second = await tv.next('pair.code');
  assert.notEqual(second.code, first.code);

  const quietTv = await connectTv(timedPort, 'television-quiet', undefined, { autoPong: false });
  timed.tidyUp();
  await wait(50);
  timed.tidyUp();
  await quietTv.closed;

  await tv.close();
  await wait(20);
  time += 11 * 60 * 1000;
  timed.tidyUp();
  assert.equal(timed.pairing.tvs.size, 0, 'a TV gone for a long time is forgotten');
  await timed.stop();
});

test('TV page: files are served and other WebSocket paths are refused', async () => {
  const page = await call(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<video id="video"/);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal((await call(port, 'GET', '/tv.js')).status, 200);
  assert.equal((await call(port, 'GET', '/tv.css')).status, 200);
  assert.ok((await call(port, 'GET', '/hls.min.js')).raw.length > 100000);

  const WebSocket = require('ws');
  const wrongPath = new WebSocket('ws://127.0.0.1:' + port + '/elsewhere');
  await new Promise((resolve) => wrongPath.on('error', resolve));

  const silentTv = await connectTv(port, 'television-silent', false);
  silentTv.send({ type: 'media.state', status: 'playing' });
  silentTv.send({ type: 'something-else' });
  await wait(50);
  assert.equal(silentTv.got.length, 0, 'an unpaired TV is told nothing until it says hello');
  await silentTv.close();
});

test('start: a port that is taken gives an error', async () => {
  const second = createApp({ listenOn: '127.0.0.1', port });
  await assert.rejects(second.start(), /EADDRINUSE/);
  await second.stop().catch(() => {});
});

test('AC-13: logs never hold cookies, full links or page titles', () => {
  const all = logLines.join('\n');
  assert.ok(logLines.length > 20);
  assert.match(all, /Cast started/);
  assert.match(all, /Fetched from the video site/);
  assert.doesNotMatch(all, /TOP-SECRET-COOKIE|LINK-TOKEN|video\.mp4|master\.m3u8|My video|page\.example\/watch/);
});
