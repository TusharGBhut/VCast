'use strict';
// Tests finding TVs and opening a page on a TV, against a pretend TV on this computer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { findTvs, findTvAddresses, readTvInfo, openPageOnTv, readSavedTvs, saveTvs } = require('../../server/tv-remote');
const { setupLogger } = require('../../server/logger');
const { listen, wait } = require('./tools');

setupLogger({ level: 'off' });

// Answers the "who is a TV?" question the way a TV does.
function startSearchAnswerer() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (question, from) => socket.send('HTTP/1.1 200 OK\r\n\r\n', from.port, from.address));
    socket.bind(0, '127.0.0.1', () => resolve({ port: socket.address().port, stop: () => socket.close() }));
  });
}

async function startInfoPage(answer, delayMs) {
  const server = http.createServer((request, response) => setTimeout(() => response.end(answer), delayMs || 0));
  return { port: await listen(server), stop: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const TIZEN = JSON.stringify({ device: { OS: 'Tizen', name: 'Living room', modelName: 'ABC123' } });

test('finds Tizen TVs that answer the search', async () => {
  const answerer = await startSearchAnswerer();
  const info = await startInfoPage(TIZEN);
  const options = { searchAddress: '127.0.0.1', searchPort: answerer.port, searchMs: 150, infoPort: info.port };
  assert.deepEqual(await findTvAddresses(options), ['127.0.0.1']);
  assert.deepEqual(await findTvs(options), [{ ip: '127.0.0.1', name: 'Living room', model: 'ABC123' }]);
  answerer.stop();
  await info.stop();
  assert.deepEqual(await findTvAddresses({ searchAddress: 'no-such-name.invalid', searchMs: 50 }), [], 'a search that cannot be sent finds nothing');
});

test('an address that is not a Tizen TV is left out', async () => {
  const cases = [JSON.stringify({ device: { OS: 'Other' } }), 'not json', JSON.stringify({}), JSON.stringify({ device: { OS: 'Tizen' } })];
  const expected = [null, null, null, { ip: '127.0.0.1', name: 'TV', model: '' }];
  for (let i = 0; i < cases.length; i++) {
    const info = await startInfoPage(cases[i]);
    assert.deepEqual(await readTvInfo('127.0.0.1', { infoPort: info.port }), expected[i], cases[i]);
    await info.stop();
  }
  const slow = await startInfoPage(TIZEN, 500);
  assert.equal(await readTvInfo('127.0.0.1', { infoPort: slow.port, infoWaitMs: 50 }), null, 'too slow');
  await slow.stop();
  assert.equal(await readTvInfo('127.0.0.1', { infoPort: 1 }), null, 'nothing listening');
});

// A pretend TV remote-control service. `behave` decides what it says when VCast connects.
// `storeBrowser` is what its app service says about the "Browser" store app (none by default).
async function startTvRemote(behave, storeBrowser) {
  const seen = { links: [], launches: [], appCalls: [] };
  const server = http.createServer((request, response) => {
    const parts = [];
    request.on('data', (part) => parts.push(part));
    request.on('end', () => {
      seen.appCalls.push([request.method, request.url, Buffer.concat(parts).toString()]);
      // Like the real TV: it hangs up after each answer without saying so, which breaks a
      // caller that tries to use the same connection for its next request.
      response.on('finish', () => request.socket.destroy());
      if (!storeBrowser) return response.writeHead(404).end('{"code":404}');
      if (request.method === 'POST' && storeBrowser.refuseStart) return response.writeHead(500).end('not json');
      // Like the real TV: the browser runs after a start request, unless this one ignores some.
      if (request.method === 'POST') storeBrowser.running = (storeBrowser.ignoreStarts || 0) < seen.appCalls.filter((call) => call[0] === 'POST').length;
      if (request.method === 'DELETE') storeBrowser.running = false;
      response.writeHead(200).end(request.method === 'GET' ? JSON.stringify(storeBrowser) : 'true');
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => {
    seen.links.push(request.url);
    socket.on('message', (raw) => seen.launches.push(JSON.parse(String(raw))));
    behave(socket);
  });
  const port = await listen(server);
  return { seen, port, browser: storeBrowser, stop: () => new Promise((resolve) => { for (const socket of sockets.clients) socket.terminate(); server.close(resolve); }) };
}

const say = (socket, event, data) => socket.send(JSON.stringify({ event, data }));

test('opens the page in the TV browser and keeps the token the TV gives', async () => {
  const tv = await startTvRemote((socket) => {
    socket.send('not json');
    say(socket, 'something.else');
    say(socket, 'ms.channel.connect', { token: 'tv-token-1' });
  });
  const options = { ip: '127.0.0.1', pageLink: 'http://192.168.1.16:8787/?key=abc', secure: false, remotePort: tv.port, infoPort: tv.port };
  assert.deepEqual(await openPageOnTv(options), { token: 'tv-token-1' });
  await wait(50);
  assert.match(tv.seen.links[0], /^\/api\/v2\/channels\/samsung\.remote\.control\?name=VkNhc3Q=$/);
  assert.deepEqual(tv.seen.launches[0], {
    method: 'ms.channel.emit',
    params: { event: 'ed.apps.launch', to: 'host', data: { appId: 'org.tizen.browser', action_type: 'NATIVE_LAUNCH', metaTag: 'http://192.168.1.16:8787/?key=abc' } }
  });
  await tv.stop();

  const knownTv = await startTvRemote((socket) => say(socket, 'ms.channel.connect'));
  options.infoPort = knownTv.port;
  assert.deepEqual(await openPageOnTv({ ...options, remotePort: knownTv.port, token: 'saved token' }), { token: 'saved token' }, 'a TV that already knows us sends no new token');
  assert.match(knownTv.seen.links[0], /&token=saved%20token$/);
  assert.deepEqual(await openPageOnTv({ ...options, remotePort: knownTv.port }), { token: null });
  await knownTv.stop();
});

test('a TV with the "Browser" store app is opened through its app service', async () => {
  const pageLink = 'http://192.168.1.16:8787/?key=abc';
  const connect = (socket) => say(socket, 'ms.channel.connect', { token: 't' });
  const appPath = '/api/v2/applications/3202010022079';
  const body = JSON.stringify({ id: pageLink, url: pageLink, data: pageLink });

  const closed = await startTvRemote(connect, { id: '3202010022079', running: false });
  const options = { ip: '127.0.0.1', pageLink, secure: false, remotePort: closed.port, infoPort: closed.port, appCloseWaitMs: 20, startChecks: 2, startCheckMs: 20 };
  assert.deepEqual(await openPageOnTv({ ...options, token: 'saved' }), { token: 'saved' });
  await wait(50);
  assert.deepEqual(closed.seen.appCalls, [['GET', appPath, ''], ['POST', appPath, body], ['GET', appPath, '']], 'asks, starts, and checks that it started');
  assert.equal(closed.seen.links.length, 0, 'no permission question: the remote-control connection is not opened');
  assert.equal(closed.seen.launches.length, 0, 'the classic way is not used as well');
  await closed.stop();

  const open = await startTvRemote(connect, { id: '3202010022079', running: true });
  await openPageOnTv({ ...options, remotePort: open.port, infoPort: open.port });
  assert.deepEqual(open.seen.appCalls.map((call) => call[0]), ['GET', 'DELETE', 'POST', 'GET'], 'an open browser is closed first so it takes the new page');
  await open.stop();

  const moody = await startTvRemote(connect, { id: '3202010022079', running: false, ignoreStarts: 1 });
  await openPageOnTv({ ...options, remotePort: moody.port, infoPort: moody.port });
  assert.equal(moody.seen.appCalls.filter((call) => call[0] === 'POST').length, 2, 'a start the TV ignored is made again');
  await moody.stop();

  const stuck = await startTvRemote(connect, { id: '3202010022079', running: false, ignoreStarts: 9 });
  await assert.rejects(openPageOnTv({ ...options, remotePort: stuck.port, infoPort: stuck.port }), { code: 'tv_browser_not_started' });
  await stuck.stop();

  const broken = await startTvRemote(connect, { id: '3202010022079', running: false, refuseStart: true });
  await assert.rejects(openPageOnTv({ ...options, remotePort: broken.port, infoPort: broken.port }), { code: 'tv_unreachable' });
  assert.equal(broken.seen.links.length, 1, 'a refusal makes VCast ask for permission, then try once more');
  assert.equal(broken.seen.appCalls.filter((call) => call[0] === 'POST').length, 2);
  await broken.stop();

  // A TV that wants permission first: refuses until the remote-control connection was made.
  const strict = await startTvRemote((socket) => {
    strict.browser.refuseStart = false;
    connect(socket);
  }, { id: '3202010022079', running: false, refuseStart: true });
  assert.deepEqual(await openPageOnTv({ ...options, remotePort: strict.port, infoPort: strict.port }), { token: 't' }, 'the token from the permission is kept');
  await strict.stop();

  // The TV dropping the remote-control connection while its browser starts is not a failure.
  const dropping = await startTvRemote((socket) => {
    dropping.browser.refuseStart = false;
    connect(socket);
    setTimeout(() => socket.terminate(), 5);
  }, { id: '3202010022079', running: false, refuseStart: true });
  assert.deepEqual(await openPageOnTv({ ...options, remotePort: dropping.port, infoPort: dropping.port, startCheckMs: 60 }), { token: 't' });
  await dropping.stop();
});

test('says clearly why the page could not be opened', async () => {
  const options = { ip: '127.0.0.1', pageLink: 'http://192.168.1.16:8787/', secure: false, allowWaitMs: 150, infoPort: 1 };
  const refusing = await startTvRemote((socket) => say(socket, 'ms.channel.unauthorized'));
  await assert.rejects(openPageOnTv({ ...options, remotePort: refusing.port }), { code: 'tv_refused' });
  await refusing.stop();

  const silent = await startTvRemote(() => {});
  await assert.rejects(openPageOnTv({ ...options, remotePort: silent.port }), { code: 'tv_no_answer' }, 'nobody pressed Allow');
  await silent.stop();

  const hangingUp = await startTvRemote((socket) => socket.close());
  await assert.rejects(openPageOnTv({ ...options, remotePort: hangingUp.port }), { code: 'tv_unreachable' });
  await hangingUp.stop();

  await assert.rejects(openPageOnTv({ ...options, remotePort: 1 }), { code: 'tv_unreachable' }, 'nothing listening');
  await assert.rejects(openPageOnTv({ ...options, remotePort: 1, secure: true }), { code: 'tv_unreachable' });
});

test('TV tokens are kept in a file', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vcast-tvs-'));
  const file = path.join(folder, 'inner', 'tvs.json');
  assert.deepEqual(readSavedTvs(file), {});
  saveTvs(file, { '192.168.1.6': 'token' });
  assert.deepEqual(readSavedTvs(file), { '192.168.1.6': 'token' });
  fs.rmSync(folder, { recursive: true });
});
