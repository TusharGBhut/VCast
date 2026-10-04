'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { isThisComputer, isHomeNetwork, homeNetworkAddresses } = require('./network');
const { Pairing, shortId } = require('./pairing');
const { VideoList, handleVideoRequest, serverPathFor } = require('./proxy');
const { logger, siteOf } = require('./logger');
const net = require('net');
const realTvRemote = require('./tv-remote');
const { createKeepAwake } = require('./keep-awake');
const VERSION = require('../package.json').version;

const log = logger('app');
const { MESSAGE_VERSION, CONTROL_ACTIONS, PLAYBACK_STATUSES, MAX_BODY_BYTES, MAX_TV_MESSAGE_BYTES, MAX_HEADER_TEXT, MAX_TITLE_TEXT, TIDY_EVERY_MS, MAX_SUBTITLES, MAX_SUBTITLE_NAME_TEXT, MAX_SUBTITLE_SHIFT_SECONDS, SUBTITLES_OFF, STATUSES_WHILE_WATCHING } = require('./constants');
const TV_FOLDER = path.join(__dirname, '..', 'tv');
const TV_PAGE_FILES = {
  '/': [path.join(TV_FOLDER, 'index.html'), 'text/html; charset=utf-8'],
  '/tv.js': [path.join(TV_FOLDER, 'tv.js'), 'application/javascript; charset=utf-8'],
  '/tv.css': [path.join(TV_FOLDER, 'tv.css'), 'text/css; charset=utf-8'],
  '/hls.min.js': [require.resolve('hls.js/dist/hls.min.js'), 'application/javascript; charset=utf-8']
};
// Characters Node can send in a header value. Anything else would make the request fail.
const NOT_HEADER_TEXT = /[^\t\x20-\x7e\x80-\xff]/;

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    request.on('data', (part) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) return reject(new Error('body too large'));
      parts.push(part);
    });
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch (e) {
        reject(new Error('body is not a JSON object'));
      }
    });
    request.on('error', reject);
  });
}

function positiveNumber(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0;
}

// Changes whenever a file of the TV page changes. An open TV page compares it with the one it
// was loaded with, so it can tell that it is out of date.
function tvPageVersion() {
  return Object.values(TV_PAGE_FILES).map(([file]) => Math.round(fs.statSync(file).mtimeMs)).join('-');
}

function isWebLink(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) && URL.canParse(value);
}

// Returns the number of the subtitle to show, or SUBTITLES_OFF when the choice is not in the list.
function subtitleChoice(value, subtitles) {
  const choice = Number(value);
  return Number.isInteger(choice) && choice >= 0 && choice < subtitles.length ? choice : SUBTITLES_OFF;
}

function createApp(options) {
  options = options || {};
  const fromHomeNetwork = options.isHomeNetwork || isHomeNetwork;
  const tvRemote = options.tvRemote || realTvRemote;
  const keepAwake = options.keepAwake || createKeepAwake();
  const savedTvs = options.savedTvsFile ? realTvRemote.readSavedTvs(options.savedTvsFile) : {};
  const videoList = new VideoList();
  const pairing = new Pairing(Object.assign({}, options, { onTvForgotten: endCast }));
  const tvSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_TV_MESSAGE_BYTES });
  const answeredPing = new WeakSet();
  let port = options.port || 0;

  function sendToTv(tv, message) {
    if (!tv.socket || tv.socket.readyState !== 1) return;
    tv.socket.send(JSON.stringify(Object.assign({ v: MESSAGE_VERSION }, message)));
    log.debug('Sent to TV', { tv: shortId(tv.id), type: message.type, action: message.action });
  }

  function showCodeOnTv(tv, evenIfSame) {
    const { code, isNew } = pairing.codeFor(tv);
    if (!isNew && !evenIfSame) return;
    sendToTv(tv, { type: 'pair.code', code, expiresInSec: Math.round((tv.codeEndsAt - pairing.now()) / 1000) });
  }

  function sendVideoToTv(tv, startAt) {
    const { path: url, kind, title, subtitles, subtitle, subtitleShift } = tv.cast;
    sendToTv(tv, { type: 'media.load', url, kind, title, startAt, subtitles, subtitle, subtitleShift });
  }

  // The computer is kept awake while some connected TV is showing a video that is moving.
  function updateKeepAwake() {
    const watching = (tv) => tv.socket && tv.cast && tv.playback && STATUSES_WHILE_WATCHING.includes(tv.playback.status);
    keepAwake.set([...pairing.tvs.values()].some(watching));
  }

  function endCast(tv) {
    if (tv.cast) videoList.remove(tv.cast.videoId);
    tv.cast = null;
  }

  function idlePlayback(tv, status) {
    return { status, position: 0, duration: 0, volume: tv.playback ? tv.playback.volume : 1 };
  }

  // This computer's address as the TV sees it: the one on the same network as the TV.
  function addressSeenBy(tvIp) {
    const sameNetwork = (address) => address.split('.').slice(0, 3).join('.') === tvIp.split('.').slice(0, 3).join('.');
    const addresses = homeNetworkAddresses();
    return addresses.find(sameNetwork) || addresses[0] || '127.0.0.1';
  }

  // Opens the VCast page in the TV's browser. The link carries a one-time key, so the TV is
  // paired as soon as its page connects and nobody has to type anything on the TV.
  async function openOnTv(body, response) {
    const ip = String(body.ip || '').trim();
    if (net.isIP(ip) !== 4 || !isHomeNetwork(ip)) return sendJson(response, 400, { error: 'bad_tv_address' });
    const expected = pairing.expectTv();
    const pageLink = 'http://' + addressSeenBy(ip) + ':' + port + '/key-' + expected.key;
    try {
      const { token } = await tvRemote.openPageOnTv({ ip, pageLink, token: savedTvs[ip] });
      if (token && token !== savedTvs[ip]) {
        savedTvs[ip] = token;
        if (options.savedTvsFile) realTvRemote.saveTvs(options.savedTvsFile, savedTvs);
      }
    } catch (error) {
      return sendJson(response, 502, { error: error.code || 'tv_unreachable' });
    }
    sendJson(response, 200, { session: expected.session });
  }

  function stateFor(tv, session) {
    return {
      v: MESSAGE_VERSION,
      version: VERSION,
      tvAddresses: homeNetworkAddresses().map((address) => 'http://' + address + ':' + port),
      paired: !!tv,
      waitingForTv: pairing.isWaitingFor(session),
      tv: tv ? { connected: !!tv.socket } : null,
      cast: tv && tv.cast ? castState(tv.cast) : null,
      playback: tv ? tv.playback : null
    };
  }

  function castState(cast) {
    return {
      title: cast.title,
      kind: cast.kind,
      siteStatus: videoList.get(cast.videoId).lastSiteStatus,
      subtitles: cast.subtitles.map((subtitle) => subtitle.label),
      subtitle: cast.subtitle,
      subtitleShift: cast.subtitleShift
    };
  }

  function pair(body, response) {
    const result = pairing.pairWithCode(body.code);
    if (result.error) {
      log.warn('Pairing failed', { reason: result.error });
      return sendJson(response, result.error === 'too_many_tries' ? 429 : 403, { error: result.error });
    }
    sendToTv(result.tv, { type: 'pair.ok' });
    log.info('TV paired', { tv: shortId(result.tv.id) });
    sendJson(response, 200, { session: result.session });
  }

  function unpair(tv, response) {
    endCast(tv);
    pairing.unpair(tv);
    sendToTv(tv, { type: 'session.end' });
    showCodeOnTv(tv, true);
    log.info('TV unpaired', { tv: shortId(tv.id) });
    sendJson(response, 200, {});
  }

  function cast(tv, body, response) {
    if (!isWebLink(body.url)) return sendJson(response, 400, { error: 'bad_request' });
    const given = body.headers || {};
    const text = (value) => (typeof value === 'string' && value.length < MAX_HEADER_TEXT && !NOT_HEADER_TEXT.test(value) ? value : undefined);
    const kind = body.kind === 'hls' || (!body.kind && /\.m3u8($|\?)/i.test(body.url)) ? 'hls' : 'file';
    endCast(tv);
    const video = videoList.add(body.url, {
      referer: text(given.referer),
      origin: text(given.origin),
      cookie: text(given.cookie),
      userAgent: text(given.userAgent)
    });
    // Subtitle files are fetched through the server too, with the same headers as the video.
    const subtitles = (Array.isArray(body.subtitles) ? body.subtitles : [])
      .filter((subtitle) => subtitle && isWebLink(subtitle.url))
      .slice(0, MAX_SUBTITLES)
      .map((subtitle) => ({ url: serverPathFor(video, subtitle.url), label: String(subtitle.label || 'Subtitles').slice(0, MAX_SUBTITLE_NAME_TEXT) }));
    tv.cast = {
      videoId: video.id,
      path: serverPathFor(video, body.url),
      kind,
      title: String(body.title || '').slice(0, MAX_TITLE_TEXT),
      subtitles,
      subtitle: subtitleChoice(body.subtitle, subtitles),
      // Seconds every subtitle line is moved: minus is earlier, plus is later.
      subtitleShift: 0
    };
    tv.playback = idlePlayback(tv, 'loading');
    sendVideoToTv(tv, 0);
    log.info('Cast started', { tv: shortId(tv.id), kind, site: siteOf(body.url) });
    sendJson(response, 200, {});
  }

  function control(tv, body, response) {
    const { action } = body;
    const value = Number(body.value);
    const needsValue = action === 'seek' || action === 'volume';
    if (!CONTROL_ACTIONS.includes(action) || (needsValue && !(value >= 0))) return sendJson(response, 400, { error: 'bad_request' });
    if (action === 'subtitle') {
      if (!tv.cast) return sendJson(response, 400, { error: 'bad_request' });
      tv.cast.subtitle = subtitleChoice(body.value, tv.cast.subtitles);
      sendToTv(tv, { type: 'media.control', action, value: tv.cast.subtitle });
      return sendJson(response, 200, {});
    }
    if (action === 'subtitleShift') {
      if (!tv.cast || !(Math.abs(value) <= MAX_SUBTITLE_SHIFT_SECONDS)) return sendJson(response, 400, { error: 'bad_request' });
      tv.cast.subtitleShift = value;
      sendToTv(tv, { type: 'media.control', action, value });
      return sendJson(response, 200, {});
    }
    sendToTv(tv, { type: 'media.control', action, value: action === 'volume' ? Math.min(value, 1) : value || 0 });
    if (action === 'stop') {
      endCast(tv);
      tv.playback = idlePlayback(tv, 'idle');
      log.info('Cast stopped', { tv: shortId(tv.id) });
    }
    sendJson(response, 200, {});
  }

  // The API is for the extension only. A request must come from this computer, name this
  // computer in its Host header (stops DNS tricks), and if a browser sent an Origin it must be
  // an extension (stops web pages).
  function isAllowedApiCaller(request) {
    const host = String(request.headers.host || '').replace(/:\d+$/, '');
    const origin = request.headers.origin;
    if (!isThisComputer(request.socket.remoteAddress)) return false;
    if (host !== '127.0.0.1' && host !== 'localhost') return false;
    return !origin || /^(chrome|moz)-extension:\/\//.test(origin);
  }

  async function handleApi(request, response, route) {
    if (!isAllowedApiCaller(request)) {
      log.warn('Refused an API call', { route, from: request.socket.remoteAddress, origin: request.headers.origin });
      return sendJson(response, 403, { error: 'forbidden' });
    }
    if (request.headers.origin) {
      response.setHeader('access-control-allow-origin', request.headers.origin);
      response.setHeader('access-control-allow-headers', 'content-type, x-vcast-session');
      response.setHeader('vary', 'origin');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      return response.end();
    }

    const tv = pairing.findBySession(request.headers['x-vcast-session']);
    if (request.method === 'GET' && route === '/api/state') return sendJson(response, 200, stateFor(tv, request.headers['x-vcast-session']));
    if (request.method === 'GET' && route === '/api/tvs') return sendJson(response, 200, { tvs: await tvRemote.findTvs() });
    if (request.method !== 'POST') return sendJson(response, 404, { error: 'not_found' });

    let body;
    try {
      body = await readJsonBody(request);
    } catch (e) {
      return sendJson(response, 400, { error: 'bad_request' });
    }
    log.debug('API call', { route, paired: !!tv, action: body.action });

    if (route === '/api/pair') return pair(body, response);
    if (route === '/api/open-on-tv') return openOnTv(body, response);
    if (!tv) return sendJson(response, 401, { error: 'not_paired' });
    if (route === '/api/unpair') return unpair(tv, response);
    if (route !== '/api/cast' && route !== '/api/control') return sendJson(response, 404, { error: 'not_found' });
    if (!tv.socket) return sendJson(response, 409, { error: 'tv_offline' });
    return route === '/api/cast' ? cast(tv, body, response) : control(tv, body, response);
  }

  function handleTvMessage(tv, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!message || typeof message !== 'object') return;
    // OK pressed on the TV's "Connected" screen: let a different computer pair.
    if (message.type === 'pair.restart' && tv.session) {
      endCast(tv);
      pairing.unpair(tv);
      log.info('TV asked for a new code', { tv: shortId(tv.id) });
      return showCodeOnTv(tv, true);
    }
    // Which remote keys reach the page differs from one TV browser to the next; the log shows it.
    if (message.type === 'tv.input') {
      return log.debug(message.pointer ? 'TV pointer moved' : 'TV remote key', { tv: shortId(tv.id), key: Number(message.key) || undefined });
    }
    // Stop pressed on the TV remote.
    if (message.type === 'media.stopped' && tv.cast) {
      endCast(tv);
      tv.playback = idlePlayback(tv, 'idle');
      return log.info('Cast stopped from the TV', { tv: shortId(tv.id) });
    }
    if (message.type === 'tv.hello') {
      sendToTv(tv, { type: 'page.version', version: options.tvPageVersion || tvPageVersion() });
      if (!tv.session) return showCodeOnTv(tv, true);
      sendToTv(tv, { type: 'pair.ok' });
      // A reloaded TV page has lost its video, so send it again from where it stopped.
      if (tv.cast && !message.hasVideo) sendVideoToTv(tv, (tv.playback && tv.playback.position) || 0);
      return;
    }
    if (message.type === 'media.state' && tv.session && tv.cast) {
      const status = PLAYBACK_STATUSES.includes(message.status) ? message.status : 'idle';
      const error = typeof message.error === 'string' ? message.error.slice(0, 40) : undefined;
      if (status === 'error' && (!tv.playback || tv.playback.status !== 'error')) {
        log.warn('TV could not play the video', { tv: shortId(tv.id), reason: error });
      }
      tv.playback = {
        status,
        position: positiveNumber(message.position),
        duration: positiveNumber(message.duration),
        volume: Math.min(positiveNumber(message.volume), 1),
        error
      };
    }
  }

  function serveTvPage(request, response, route) {
    // "/key-<one-time key>" is the TV page too; the page reads the key from its own address.
    const file = TV_PAGE_FILES[/^\/key-[\w-]+$/.test(route) ? '/' : route];
    if (!file || request.method !== 'GET') {
      response.writeHead(404);
      return response.end();
    }
    fs.readFile(file[0], (error, data) => {
      response.writeHead(error ? 500 : 200, { 'content-type': file[1], 'cache-control': 'no-cache' });
      response.end(error ? '' : data);
    });
  }

  const server = http.createServer((request, response) => {
    if (!fromHomeNetwork(request.socket.remoteAddress)) {
      log.warn('Dropped a request from outside the home network');
      return request.socket.destroy();
    }
    const route = request.url.split('?')[0];
    if (route.startsWith('/api/')) {
      return handleApi(request, response, route)
        .catch((error) => {
          log.error('API call failed', { route, reason: error });
          if (!response.headersSent) sendJson(response, 500, { error: 'internal' });
        })
        .then(updateKeepAwake);
    }
    if (route.startsWith('/media/')) return handleVideoRequest(request, response, videoList);
    serveTvPage(request, response, route);
  });

  server.on('upgrade', (request, socket, head) => {
    // Only our own TV page may connect: from the home network, and not from some other web page.
    const origin = request.headers.origin;
    const isOurPage = !origin || origin === 'http://' + request.headers.host;
    const [path, query] = request.url.split('?');
    if (path !== '/tv' || !isOurPage || !fromHomeNetwork(request.socket.remoteAddress)) return socket.destroy();
    tvSockets.handleUpgrade(request, socket, head, (tvSocket) => {
      const asked = new URLSearchParams(query);
      const tv = pairing.connectTv(asked.get('id'), tvSocket, asked.get('key'));
      if (!tv) {
        log.warn('Refused a TV: too many are connected');
        return tvSocket.close();
      }
      answeredPing.add(tvSocket);
      tvSocket.on('pong', () => answeredPing.add(tvSocket));
      tvSocket.on('message', (raw) => {
        try {
          handleTvMessage(tv, String(raw));
          updateKeepAwake();
        } catch (error) {
          log.error('Could not handle a TV message', { tv: shortId(tv.id), reason: error });
        }
      });
      tvSocket.on('error', () => {});
      tvSocket.on('close', () => {
        pairing.disconnectTv(tv, tvSocket);
        updateKeepAwake();
        log.info('TV disconnected', { tv: shortId(tv.id) });
      });
      log.info('TV connected', { tv: shortId(tv.id), paired: !!tv.session });
    });
  });

  // Runs every few seconds: shows a new code when the old one ran out, drops TVs that stopped
  // answering, and forgets TVs that have been gone a long time.
  function tidyUp() {
    for (const tv of pairing.tvs.values()) {
      if (!tv.socket) continue;
      if (!answeredPing.has(tv.socket)) {
        tv.socket.terminate();
        continue;
      }
      answeredPing.delete(tv.socket);
      tv.socket.ping();
      if (!tv.session) showCodeOnTv(tv, false);
    }
    pairing.removeOldTvs();
    updateKeepAwake();
  }
  const tidyTimer = setInterval(tidyUp, options.tidyEveryMs || TIDY_EVERY_MS);
  tidyTimer.unref();

  return {
    pairing,
    tidyUp,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, options.listenOn || '0.0.0.0', () => {
          port = /** @type {import('net').AddressInfo} */ (server.address()).port;
          resolve(port);
        });
      });
    },
    stop() {
      clearInterval(tidyTimer);
      keepAwake.set(false);
      for (const socket of tvSockets.clients) socket.terminate();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createApp };
