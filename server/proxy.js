'use strict';
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { logger, siteOf } = require('./logger');
const { shortId } = require('./pairing');
const { isHomeNetwork } = require('./network');

const log = logger('proxy');
const { MAX_PLAYLIST_BYTES, MAX_REDIRECTS, SITE_TIMEOUT_MS, HEADERS_TO_PASS_ON, SLOW_PIECE_MS } = require('./constants');

// Videos the extension asked us to play. The server fetches a link only when it is one of these,
// or when it carries a signature made with that video's secret key. Signatures are only made
// while rewriting that video's own playlists, so nobody can use the server to fetch other things.
class VideoList {
  constructor() {
    this.videos = new Map();
  }

  add(link, headers) {
    const video = {
      id: crypto.randomBytes(16).toString('base64url'),
      secretKey: crypto.randomBytes(32),
      origin: new URL(link).origin,
      // A video that itself lives on the home network (a media box, a test site) may be fetched
      // from there. Any other video must never make the server reach into the home network.
      mayUseHomeNetwork: isHomeAddress(new URL(link).hostname),
      headers: headers || {},
      lastSiteStatus: 0
    };
    this.videos.set(video.id, video);
    return video;
  }

  get(id) {
    return this.videos.get(id);
  }

  remove(id) {
    this.videos.delete(id);
  }
}

function isHomeAddress(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || (net.isIP(host) !== 0 && isHomeNetwork(host));
}

// Used in place of the normal name lookup, so a site name that points at a home address
// (this computer, the router) is refused at the moment of connecting.
function lookupOutsideHome(hostname, options, done) {
  dns.lookup(hostname, options, (error, address, family) => {
    const addresses = Array.isArray(address) ? address.map((item) => item.address) : [address];
    if (!error && addresses.some(isHomeNetwork)) return done(new Error('home network address refused'));
    done(error, address, family);
  });
}

function signLink(video, link) {
  return crypto.createHmac('sha256', video.secretKey).update(link).digest('base64url').slice(0, 22);
}

// The path the TV uses to ask the server for a link.
function serverPathFor(video, link) {
  return '/media/' + video.id + '/' + signLink(video, link) + '/' + Buffer.from(link).toString('base64url');
}

// Changes every link in an HLS playlist (segments, quality playlists, keys, audio tracks) so it
// points at the server. The TV then never talks to the site directly.
function rewritePlaylist(text, playlistLink, toServerPath) {
  const change = (link) => {
    if (/^data:/i.test(link)) return link;
    try {
      return toServerPath(new URL(link, playlistLink).href);
    } catch (e) {
      return link;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed[0] === '#') return line.replace(/URI="([^"]*)"/g, (all, link) => 'URI="' + change(link) + '"');
      return change(trimmed);
    })
    .join('\n');
}

function headersForSite(video, link, tvRequest) {
  const saved = video.headers;
  const headers = { accept: '*/*', 'accept-encoding': 'identity' };
  if (saved.userAgent) headers['user-agent'] = saved.userAgent;
  if (saved.referer) headers.referer = saved.referer;
  if (saved.origin) headers.origin = saved.origin;
  // The cookie belongs to the site the video was found on; other sites must not see it.
  if (saved.cookie && link.origin === video.origin) headers.cookie = saved.cookie;
  if (tvRequest.headers.range) headers.range = tvRequest.headers.range;
  return headers;
}

// Asks the site for the link, following redirects. `current.request` always holds the request
// in flight so it can be cancelled when the TV stops listening.
function askSite(video, linkText, tvRequest, current, redirectsLeft, done) {
  let link;
  try {
    link = new URL(linkText);
  } catch (e) {
    return done(new Error('not a link'));
  }
  if (link.protocol !== 'http:' && link.protocol !== 'https:') return done(new Error('not a web link'));
  if (!video.mayUseHomeNetwork && isHomeAddress(link.hostname)) return done(new Error('home network address refused'));

  let answered = false;
  const options = { method: tvRequest.method, headers: headersForSite(video, link, tvRequest), timeout: SITE_TIMEOUT_MS };
  if (!video.mayUseHomeNetwork) options.lookup = lookupOutsideHome;
  let request;
  try {
    request = (link.protocol === 'https:' ? https : http).request(link, options, (answer) => {
      answered = true;
      // The time limit is for getting an answer. After that the TV may pause as long as it likes.
      request.setTimeout(0);
      if (![301, 302, 303, 307, 308].includes(answer.statusCode) || !answer.headers.location) return done(null, answer, link);
      answer.resume();
      if (redirectsLeft <= 0) return done(new Error('too many redirects'));
      let movedTo;
      try {
        movedTo = new URL(answer.headers.location, link).href;
      } catch (e) {
        return done(new Error('bad redirect'));
      }
      askSite(video, movedTo, tvRequest, current, redirectsLeft - 1, done);
    });
  } catch (e) {
    // Node refuses to send header values with characters that are not allowed.
    return done(new Error('request could not be made'));
  }
  current.request = request;
  request.on('timeout', () => request.destroy(new Error('site took too long')));
  request.on('error', (error) => {
    if (!answered) done(error);
  });
  request.end();
}

function isPlaylistStart(firstBytes) {
  return firstBytes.subarray(0, 16).toString('latin1').replace(/^\xef\xbb\xbf/, '').trimStart().startsWith('#EXTM3U');
}

function sendAnswerToTv(video, answer, link, tvRequest, tvResponse) {
  const headers = { 'access-control-allow-origin': '*' };
  for (const name of HEADERS_TO_PASS_ON) if (answer.headers[name]) headers[name] = answer.headers[name];

  // If the site drops the connection half way, drop the TV's request too so it can retry.
  answer.on('error', () => {});
  answer.on('close', () => {
    if (!answer.complete) tvResponse.destroy();
  });
  // We ask sites not to compress. One that does anyway cannot be passed on safely.
  if (answer.headers['content-encoding'] && answer.headers['content-encoding'] !== 'identity') {
    answer.resume();
    tvResponse.writeHead(502, { 'content-type': 'text/plain' });
    return tvResponse.end();
  }
  if (tvRequest.method === 'HEAD' || answer.statusCode >= 300) {
    tvResponse.writeHead(answer.statusCode, headers);
    return answer.pipe(tvResponse);
  }

  const saysPlaylist = /mpegurl/i.test(String(answer.headers['content-type'] || '')) || /\.m3u8?$/i.test(link.pathname);
  let playlistParts = null;
  let size = 0;
  answer.once('data', (first) => {
    if (!saysPlaylist && !isPlaylistStart(first)) {
      tvResponse.writeHead(answer.statusCode, headers);
      tvResponse.write(first);
      return answer.pipe(tvResponse);
    }
    playlistParts = [first];
    size = first.length;
    answer.on('data', (part) => {
      size += part.length;
      if (size > MAX_PLAYLIST_BYTES) return answer.destroy(new Error('playlist too large'));
      playlistParts.push(part);
    });
  });
  answer.once('end', () => {
    if (tvResponse.headersSent) return;
    if (!playlistParts) {
      tvResponse.writeHead(answer.statusCode, headers);
      return tvResponse.end();
    }
    const text = rewritePlaylist(Buffer.concat(playlistParts).toString('utf8'), link.href, (inner) => serverPathFor(video, inner));
    tvResponse.writeHead(200, {
      'access-control-allow-origin': '*',
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text)
    });
    tvResponse.end(text);
  });
}

// GET or HEAD /media/<videoId>/<signature>/<link in base64url>
function handleVideoRequest(tvRequest, tvResponse, videoList) {
  const refuse = (status) => {
    tvResponse.writeHead(status, { 'content-type': 'text/plain' });
    tvResponse.end();
  };
  if (tvRequest.method !== 'GET' && tvRequest.method !== 'HEAD') return refuse(405);

  const [, , videoId, signature, encodedLink] = tvRequest.url.split('?')[0].split('/');
  const video = videoList.get(videoId);
  if (!video) return refuse(404);
  const link = Buffer.from(encodedLink || '', 'base64url').toString('utf8');
  const given = Buffer.from(signature || '');
  const expected = Buffer.from(signLink(video, link));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    log.warn('Refused a link with a wrong signature', { video: shortId(video.id) });
    return refuse(403);
  }

  const startedAt = Date.now();
  const current = { request: null };
  tvResponse.on('close', () => current.request && current.request.destroy());
  askSite(video, link, tvRequest, current, MAX_REDIRECTS, (error, answer, finalLink) => {
    // The TV gave up first (a seek, a quality change). That is not the site's fault.
    if (tvResponse.destroyed) return;
    if (error) {
      video.lastSiteStatus = 502;
      log.warn('Could not reach the video site', { site: siteOf(link), reason: error.message });
      if (!tvResponse.headersSent) refuse(502);
      return;
    }
    video.lastSiteStatus = answer.statusCode;
    const details = { site: finalLink.host, status: answer.statusCode, ms: Date.now() - startedAt };
    if (answer.statusCode >= 400) log.warn('The video site refused a request', details);
    else log.debug('Fetched from the video site', details);
    sendAnswerToTv(video, answer, finalLink, tvRequest, tvResponse);

    // For the log: how much was passed on and how long it took, to tell a slow site or network
    // from a TV that stopped asking.
    let bytes = 0;
    answer.on('data', (part) => (bytes += part.length));
    tvResponse.on('close', () => {
      const passedOn = { site: finalLink.host, bytes, ms: Date.now() - startedAt };
      if (!tvResponse.writableFinished) log.debug('The TV stopped a download early', passedOn);
      else if (passedOn.ms > SLOW_PIECE_MS) log.warn('A video piece was slow to arrive', passedOn);
    });
  });
}

module.exports = { VideoList, handleVideoRequest, rewritePlaylist, serverPathFor, signLink };
