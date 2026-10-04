'use strict';
// Finds Samsung Tizen TVs on the home network and opens a page in the TV's own browser, using
// the remote-control service these TVs offer on the network. Nothing is installed on the TV.
// The first time, the TV asks its owner to allow "VCast"; the TV then gives a token that is
// saved so it does not ask again.
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { logger } = require('./logger');
const { TV_SEARCH_ADDRESS, TV_SEARCH_PORT, TV_SEARCH_MS, TV_INFO_PORT, TV_INFO_WAIT_MS, TV_APP_SERVICE_WAIT_MS, TV_REMOTE_PORT, TV_ALLOW_WAIT_MS, TV_BROWSER_APP, TV_STORE_BROWSER_APP, TV_APP_CLOSE_WAIT_MS, TV_BROWSER_START_CHECKS, TV_BROWSER_START_CHECK_MS, TV_REMOTE_NAME } = require('./constants');

const log = logger('tv');

function problem(code) {
  return Object.assign(new Error(code), { code });
}

// Shouts "who is a TV?" on the network and collects the addresses that answer.
function findTvAddresses(options) {
  options = options || {};
  return new Promise((resolve) => {
    const found = new Set();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      socket.close();
      resolve([...found]);
    };
    const question = ['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 1', 'ST: urn:dial-multiscreen-org:service:dial:1', '', ''].join('\r\n');
    socket.on('message', (answer, from) => found.add(from.address));
    socket.on('error', () => resolve([...found]));
    socket.send(question, options.searchPort || TV_SEARCH_PORT, options.searchAddress || TV_SEARCH_ADDRESS, (error) => {
      if (error) return finish();
      setTimeout(finish, options.searchMs || TV_SEARCH_MS);
    });
  });
}

// Asks one address whether it is a Tizen TV. Gives { ip, name, model } or null.
function readTvInfo(ip, options) {
  options = options || {};
  return new Promise((resolve) => {
    const request = http.get({ host: ip, port: options.infoPort || TV_INFO_PORT, path: '/api/v2/', agent: false, timeout: options.infoWaitMs || TV_INFO_WAIT_MS }, (answer) => {
      const parts = [];
      answer.on('data', (part) => parts.push(part));
      answer.on('end', () => {
        try {
          const device = JSON.parse(Buffer.concat(parts).toString('utf8')).device;
          resolve(device.OS === 'Tizen' ? { ip, name: String(device.name || 'TV'), model: String(device.modelName || '') } : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function findTvs(options) {
  const addresses = await findTvAddresses(options);
  const tvs = (await Promise.all(addresses.map((ip) => readTvInfo(ip, options)))).filter(Boolean);
  log.info('Looked for TVs', { answered: addresses.length, tizenTvs: tvs.length });
  return tvs;
}

// One call to the TV's app service. Gives { status, json }; status 0 when the TV did not answer.
function askTvAppService(ip, method, body, options) {
  return new Promise((resolve) => {
    const text = body ? JSON.stringify(body) : '';
    const request = http.request({
      host: ip,
      port: options.infoPort || TV_INFO_PORT,
      path: '/api/v2/applications/' + TV_STORE_BROWSER_APP,
      method,
      // A new connection for every request. The TV hangs up after each answer, and a request
      // sent down the old connection fails at once (seen on the real TV, F-008).
      agent: false,
      timeout: options.infoWaitMs || TV_APP_SERVICE_WAIT_MS,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {}
    }, (answer) => {
      const parts = [];
      answer.on('data', (part) => parts.push(part));
      answer.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(parts).toString('utf8'));
        } catch (e) { /* not JSON */ }
        resolve({ status: answer.statusCode, json });
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', (error) => {
      log.debug('TV app service request failed', { tv: ip, method, reason: error.message });
      resolve({ status: 0, json: null });
    });
    request.end(text);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Starts the "Browser" store app on the page. Gives:
//   'opened'   the browser is running on the page
//   'no-app'   this TV has no such app (Samsung's own TVs; the classic way is used instead)
//   'refused'  the TV would not answer or would not start it (it may first want permission)
async function openInStoreBrowser(ip, pageLink, options) {
  const app = await askTvAppService(ip, 'GET', null, options);
  log.debug('Asked the TV about its Browser app', { tv: ip, status: app.status, running: app.json && app.json.running });
  if (app.status === 404) return 'no-app';
  if (app.status !== 200) return 'refused';
  // A browser that is already open keeps its page, so it is closed first.
  const wasRunning = !!(app.json && app.json.running);
  if (wasRunning) {
    await askTvAppService(ip, 'DELETE', null, options);
    await wait(options.appCloseWaitMs || TV_APP_CLOSE_WAIT_MS);
  }
  // The TV sometimes says yes and then does not start the browser, so the request is checked
  // and made a second time if needed.
  for (let attempt = 1; attempt <= 2; attempt++) {
    // The TV takes the page address from these fields together (seen on the real TV, F-005).
    const started = await askTvAppService(ip, 'POST', { id: pageLink, url: pageLink, data: pageLink }, options);
    if (started.status !== 200) {
      log.debug('TV would not start its Browser app', { tv: ip, status: started.status });
      return 'refused';
    }
    for (let check = 1; check <= (options.startChecks || TV_BROWSER_START_CHECKS); check++) {
      await wait(options.startCheckMs || TV_BROWSER_START_CHECK_MS);
      const now = await askTvAppService(ip, 'GET', null, options);
      if (now.json && now.json.running) {
        log.debug('TV browser started', { tv: ip, wasRunning, attempt, checks: check });
        return 'opened';
      }
    }
    log.warn('TV took the request but its browser did not start', { tv: ip, attempt });
  }
  throw problem('tv_browser_not_started');
}

// Connects to the TV's remote-control service. The first time, this is what makes the TV ask
// its owner to allow VCast. Gives { socket, token } once the TV has let us in.
function connectToTvRemote(options) {
  const { ip, token } = options;
  const name = Buffer.from(TV_REMOTE_NAME).toString('base64');
  const address = (options.secure === false ? 'ws' : 'wss') + '://' + ip + ':' + (options.remotePort || TV_REMOTE_PORT) +
    '/api/v2/channels/samsung.remote.control?name=' + name + (token ? '&token=' + encodeURIComponent(token) : '');
  return new Promise((resolve, reject) => {
    // The TV signs its own certificate, so it cannot be checked against a public authority.
    const socket = new WebSocket(address, { rejectUnauthorized: false });
    let done = false;
    const fail = (code, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      log.debug('TV remote connection failed', { tv: ip, reason: code, detail });
      reject(problem(code));
    };
    const timer = setTimeout(() => fail('tv_no_answer', 'nobody answered the Allow question in time'), options.allowWaitMs || TV_ALLOW_WAIT_MS);
    socket.on('error', (error) => fail('tv_unreachable', error.message));
    socket.on('close', (code) => fail('tv_unreachable', 'the TV closed the connection, code ' + code));
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch (e) {
        return;
      }
      if (message.event === 'ms.channel.unauthorized') return fail('tv_refused', 'the TV said no');
      if (message.event !== 'ms.channel.connect' || done) return;
      // From here on the TV closing this connection is not a failure.
      done = true;
      clearTimeout(timer);
      resolve({ socket, token: (message.data && message.data.token) || token || null });
    });
  });
}

// Opens `pageLink` in the TV's browser. Gives { token } to save for next time.
// Fails with code tv_unreachable, tv_refused, tv_no_answer (nobody pressed Allow in time),
// or tv_browser_not_started.
async function openPageOnTv(options) {
  const { ip, pageLink } = options;
  let token = options.token || null;
  try {
    // A TV that already knows this computer starts its browser with no questions asked.
    let how = await openInStoreBrowser(ip, pageLink, options);
    if (how !== 'opened') {
      const remote = await connectToTvRemote(options);
      token = remote.token;
      try {
        if (how === 'refused') how = await openInStoreBrowser(ip, pageLink, options);
        if (how === 'refused') throw problem('tv_unreachable');
        if (how === 'no-app') {
          const launch = { appId: TV_BROWSER_APP, action_type: 'NATIVE_LAUNCH', metaTag: pageLink };
          const message = JSON.stringify({ method: 'ms.channel.emit', params: { event: 'ed.apps.launch', to: 'host', data: launch } });
          await new Promise((resolve) => remote.socket.send(message, resolve));
          how = 'asked the classic way';
        }
      } finally {
        remote.socket.close();
      }
    }
    log.info('Opened the page on the TV', { tv: ip, how });
    return { token };
  } catch (error) {
    log.warn('Could not open the page on the TV', { tv: ip, reason: error.code || error.message });
    throw error.code ? error : problem('tv_unreachable');
  }
}

// Tokens the TVs gave us, kept in a small file: { "<tv address>": "<token>" }.
function readSavedTvs(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveTvs(file, tvs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(tvs, null, 2), { mode: 0o600 });
}

module.exports = { findTvs, findTvAddresses, readTvInfo, openPageOnTv, readSavedTvs, saveTvs };
