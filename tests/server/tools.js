'use strict';
// Shared tools for server tests: a pretend video site, a pretend TV, and a plain HTTP caller.
const http = require('http');
const WebSocket = require('ws');

const PAGE = 'https://page.example/watch';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A video site that refuses requests without the page's Referer, like many real ones do.
async function startFakeSite() {
  const seen = [];
  const videoBytes = Buffer.alloc(1000, 7);
  const send = (response, status, type, body) => {
    response.writeHead(status, { 'content-type': type });
    response.end(body);
  };
  const server = http.createServer((request, response) => {
    seen.push({ path: request.url, headers: request.headers });
    const base = 'http://' + request.headers.host;
    if (request.headers.referer !== PAGE) return send(response, 403, 'text/plain', 'no');
    switch (request.url.split('?')[0]) {
      case '/video.mp4': {
        const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range || '');
        if (!range) {
          response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': videoBytes.length, 'accept-ranges': 'bytes' });
          return response.end(request.method === 'HEAD' ? undefined : videoBytes);
        }
        const part = videoBytes.subarray(Number(range[1]), Number(range[2]) + 1);
        response.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes ' + range[1] + '-' + range[2] + '/1000', 'content-length': part.length });
        return response.end(part);
      }
      case '/hls/master.m3u8':
        return send(response, 200, 'application/vnd.apple.mpegurl', ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/a.m3u8"', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'low/index.m3u8', ''].join('\n'));
      case '/hls/low/index.m3u8':
        return send(response, 200, 'application/vnd.apple.mpegurl', ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXTINF:4,', 'seg1.ts', '#EXTINF:4,', base.replace('127.0.0.1', 'localhost') + '/other/seg2.ts', '#EXT-X-ENDLIST'].join('\n'));
      case '/hls/low/seg1.ts':
      case '/other/seg2.ts':
        return send(response, 200, 'video/mp2t', 'segment-bytes');
      case '/playlist-without-name':
        return send(response, 200, 'text/plain', '﻿#EXTM3U\n#EXTINF:4,\nseg1.ts\n');
      case '/moved':
        response.writeHead(302, { location: '/video.mp4' });
        return response.end();
      case '/moved-forever':
        response.writeHead(302, { location: '/moved-forever' });
        return response.end();
      case '/empty':
        return send(response, 200, 'video/mp4', '');
      case '/huge.m3u8':
        return send(response, 200, 'application/vnd.apple.mpegurl', '#EXTM3U\n' + 'x'.repeat(6 * 1024 * 1024));
      case '/subs/eng-2.vtt':
        return send(response, 200, 'text/vtt', 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n');
      case '/bad-redirect':
        response.writeHead(302, { location: 'http://[bad' });
        return response.end();
      case '/squeezed.mp4':
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-encoding': 'gzip' });
        return response.end('not really gzip');
      case '/drops.mp4':
        response.writeHead(403, { 'content-type': 'text/plain', 'content-length': 1000 });
        response.write('part');
        return setTimeout(() => response.destroy(), 20);
      case '/slow.mp4':
        return setTimeout(() => send(response, 200, 'video/mp4', 'late'), 300);
      case '/gone.mp4':
        return send(response, 410, 'text/plain', 'gone');
      default:
        return send(response, 404, 'text/plain', 'not found');
    }
  });
  const port = await listen(server);
  return { seen, link: (path) => 'http://127.0.0.1:' + port + path, stop: () => new Promise((resolve) => server.close(resolve)) };
}

// Sends one HTTP request and returns the status, headers, raw body and JSON (when it is JSON).
function call(port, method, path, options) {
  options = options || {};
  const headers = Object.assign({}, options.headers);
  const body = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  if (options.session) headers['x-vcast-session'] = options.session;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const parts = [];
      response.on('data', (part) => parts.push(part));
      response.on('error', reject);
      response.on('close', () => response.complete || reject(new Error('aborted')));
      response.on('end', () => {
        const raw = Buffer.concat(parts);
        let json = null;
        try {
          json = JSON.parse(raw.toString());
        } catch (e) { /* not JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, raw, text: raw.toString(), json });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

// A pretend TV page: connects, says hello, and lets a test wait for a message type.
function connectTv(port, id, hello, socketOptions) {
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/tv?id=' + (id || ''), socketOptions);
  const got = [];
  const waiting = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const index = waiting.findIndex((item) => item.type === message.type);
    if (index >= 0) waiting.splice(index, 1)[0].resolve(message);
    else got.push(message);
  });
  const tv = {
    socket,
    got,
    send: (message) => socket.send(JSON.stringify(message)),
    next(type) {
      const index = got.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(got.splice(index, 1)[0]);
      return new Promise((resolve) => waiting.push({ type, resolve }));
    },
    closed: new Promise((resolve) => socket.on('close', resolve)),
    close() {
      socket.close();
      return tv.closed;
    }
  };
  return new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('open', () => {
      if (hello !== false) tv.send(Object.assign({ type: 'tv.hello' }, hello));
      resolve(tv);
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { PAGE, startFakeSite, call, connectTv, listen, wait };
