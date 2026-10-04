'use strict';
// Tests for the extension's own logic in extension/lib (no browser needed).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let videoList;
let text;
let serverApi;
let logFile;
let constants;

before(async () => {
  videoList = await import('../../extension/lib/video-list.js');
  text = await import('../../extension/lib/text.js');
  serverApi = await import('../../extension/lib/server-api.js');
  logFile = await import('../../extension/lib/log.js');
  constants = await import('../../extension/lib/constants.js');
});

test('AC-10: knows which links are videos', () => {
  const { videoKindOf } = videoList;
  assert.equal(videoKindOf('https://cdn.example/a/master.m3u8?token=1', 'xmlhttprequest'), 'hls');
  assert.equal(videoKindOf('https://cdn.example/a/manifest.MPD', 'xmlhttprequest'), 'dash');
  for (const name of ['v.mp4', 'v.m4v', 'v.webm', 'v.mov']) assert.equal(videoKindOf('http://cdn.example/' + name, 'media'), 'file');
  assert.equal(videoKindOf('https://cdn.example/stream?id=5', 'media'), 'file', 'a media request without a known ending');
  assert.equal(videoKindOf('https://cdn.example/seg-1.mp4', 'xmlhttprequest'), null, 'a piece fetched by a page script is not a whole video');
  assert.equal(videoKindOf('https://cdn.example/song.mp3', 'media'), null, 'sound only');
  assert.equal(videoKindOf('https://cdn.example/seg1.ts', 'xmlhttprequest'), null);
  assert.equal(videoKindOf('https://cdn.example/page.html', 'xmlhttprequest'), null);
  assert.equal(videoKindOf('blob:https://site.example/1234', 'media'), null);
  assert.equal(videoKindOf('not a link', 'media'), null);
});

test('AC-10: the list ignores repeats, keeps different resolutions apart, and keeps the newest when full', () => {
  const { addVideo, emptyTabInfo, sameVideoKey, tabKey } = videoList;
  const { MAX_VIDEOS_PER_TAB } = constants;
  assert.equal(tabKey(7), 'tab:7');
  assert.equal(sameVideoKey('https://cdn.example/v/film.mp4?token=1'), sameVideoKey('https://cdn.example/v/film.mp4?token=2'));
  assert.notEqual(sameVideoKey('https://cdn.example/a.mp4'), sameVideoKey('https://other.example/a.mp4'));
  assert.notEqual(sameVideoKey('https://cdn.example/film_720.mp4'), sameVideoKey('https://cdn.example/film_1080.mp4'));
  assert.notEqual(sameVideoKey('https://cdn.example/videos/1001/master.m3u8'), sameVideoKey('https://cdn.example/videos/2002/master.m3u8'));

  let info = emptyTabInfo();
  assert.deepEqual(info, { videos: [], subtitles: [], hasDrm: false, hasHiddenVideo: false });
  const first = { url: 'https://cdn.example/v/film.mp4?token=1', kind: 'file' };
  info = addVideo(info, first);
  assert.deepEqual(info.videos, [first]);
  assert.equal(addVideo(info, { url: 'https://cdn.example/v/film.mp4?token=2', kind: 'file' }), null);

  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    info = addVideo(info, { url: 'https://cdn.example/' + letter + '.mp4', kind: 'file' });
  }
  assert.equal(info.videos.length, MAX_VIDEOS_PER_TAB);
  assert.equal(info.videos.at(-1).url, 'https://cdn.example/z.mp4', 'the newest is kept');
  assert.equal(info.videos.includes(first), false, 'the oldest made room');
});

test('subtitle files are found, named, listed once, and picked sensibly', () => {
  const { subtitleNameOf, addSubtitle, emptyTabInfo } = videoList;
  assert.equal(subtitleNameOf('https://cdn.example/a/subtitles/eng-2.vtt?t=1'), 'eng-2');
  assert.equal(subtitleNameOf('https://cdn.example/a/thumbnails.vtt'), null, 'seek-bar preview pictures are not subtitles');
  assert.equal(subtitleNameOf('https://cdn.example/a/master.m3u8'), null);
  assert.equal(subtitleNameOf('not a link'), null);

  const eng = { url: 'https://cdn.example/s/eng-2.vtt', label: 'eng-2' };
  let info = addSubtitle(emptyTabInfo(), eng);
  assert.deepEqual(info.subtitles, [eng]);
  assert.equal(addSubtitle(info, { ...eng, url: eng.url + '?again' }), null);
  assert.deepEqual(addSubtitle({ videos: [] }, eng).subtitles, [eng], 'tab info saved by an older version has no subtitle list');
  for (let i = 0; i < 40; i++) info = addSubtitle(info, { url: 'https://cdn.example/s/' + i + '.vtt', label: String(i) }) || info;
  assert.equal(info.subtitles.length, constants.MAX_SUBTITLES_PER_TAB);

  const { subtitleName, pickSubtitle } = text;
  assert.equal(subtitleName('eng-2'), 'English');
  assert.equal(subtitleName('FRE'), 'French');
  assert.equal(subtitleName('Signs & Songs'), 'Signs & Songs');
  const labels = ['ara-3', 'eng-2', 'spa-7'];
  assert.equal(pickSubtitle(labels, null), 1, 'English when nothing was picked before');
  assert.equal(pickSubtitle(labels, 'Spanish'), 2, 'the language picked last time');
  assert.equal(pickSubtitle(labels, 'Hindi'), 1, 'falls back to English when last time\'s language is missing');
  assert.equal(pickSubtitle(labels, 'off'), -1);
  assert.equal(pickSubtitle(['ara-3'], null), -1);
  assert.equal(pickSubtitle([], null), -1);
});

test('a video seen again with more headers keeps the fuller set', () => {
  const { addVideo, emptyTabInfo } = videoList;
  const fromPage = { url: 'https://cdn.example/v.mp4', kind: 'file', headers: { referer: 'https://page.example/' }, foundAt: 1 };
  let info = addVideo(emptyTabInfo(), fromPage);
  info = addVideo(info, { url: 'https://cdn.example/v.mp4?t=2', kind: 'file', headers: { referer: 'https://other.example/', cookie: 'a=b' }, foundAt: 2 });
  assert.equal(info.videos.length, 1);
  assert.deepEqual(info.videos[0], { ...fromPage, headers: { referer: 'https://other.example/', cookie: 'a=b' } });
  assert.equal(addVideo(info, { url: 'https://cdn.example/v.mp4', kind: 'file', headers: { cookie: 'c=d' } }), null, 'nothing new, nothing changes');
  assert.equal(text.playButtonAction('paused'), 'play');
  assert.equal(text.playButtonAction('ended'), 'play');
  assert.equal(text.playButtonAction('playing'), 'pause');
});

test('AC-19: subtitle timing steps and the text that shows it', () => {
  const { nextSubtitleShift, subtitleShiftText } = text;
  assert.equal(nextSubtitleShift(0, 1), 0.25);
  assert.equal(nextSubtitleShift(0, -1), -0.25);
  assert.equal(nextSubtitleShift(undefined, 1), 0.25);
  let shift = 0;
  for (let press = 0; press < 7; press++) shift = nextSubtitleShift(shift, 1);
  assert.equal(shift, 1.75, 'many presses do not drift');
  assert.equal(nextSubtitleShift(300, 1), 300);
  assert.equal(nextSubtitleShift(-300, -1), -300);
  assert.equal(subtitleShiftText(0), 'In time with the file');
  assert.equal(subtitleShiftText(undefined), 'In time with the file');
  assert.equal(subtitleShiftText(0.75), 'Shown 0.75 s later');
  assert.equal(subtitleShiftText(-1.5), 'Shown 1.5 s earlier');
});

test('the best guess comes first: streams, then files, then DASH', () => {
  const videos = [
    { kind: 'dash', foundAt: 1 },
    { kind: 'file', foundAt: 2 },
    { kind: 'hls', foundAt: 9 },
    { kind: 'hls', foundAt: 3 }
  ];
  assert.deepEqual(videoList.sortVideos(videos).map((video) => video.kind + video.foundAt), ['hls3', 'hls9', 'file2', 'dash1']);
  assert.equal(videos[0].kind, 'dash', 'the given list is not changed');
});

test('keeps only the headers a video site may check', () => {
  const kept = videoList.headersToKeep([
    { name: 'Referer', value: 'https://page.example/' },
    { name: 'ORIGIN', value: 'https://page.example' },
    { name: 'Cookie', value: 'a=b' },
    { name: 'User-Agent', value: 'Browser' },
    { name: 'Accept', value: '*/*' },
    { name: 'Cookie2' }
  ]);
  assert.deepEqual(kept, { referer: 'https://page.example/', origin: 'https://page.example', cookie: 'a=b', userAgent: 'Browser' });
  assert.deepEqual(videoList.headersToKeep(undefined), {});
});

test('AC-11 AC-12: every error has a short message with a next step', () => {
  const { errorText, DRM_TEXT, NO_VIDEO_TEXT, HIDDEN_VIDEO_TEXT } = text;
  assert.equal(errorText('server_down'), "Can't reach VCast on this computer. Start it and try again.");
  assert.equal(DRM_TEXT, "This video is protected (DRM) and can't be sent to the TV.");
  for (const code of ['bad_code', 'too_many_tries', 'tv_offline', 'not_paired', 'bad_request', 'forbidden', 'tv_unreachable', 'tv_refused', 'tv_no_answer', 'tv_browser_not_started', 'bad_tv_address']) {
    assert.notEqual(errorText(code), errorText('never-heard-of-it'), code);
  }
  assert.equal(errorText('never-heard-of-it'), 'Something went wrong. Try again.');
  assert.ok(NO_VIDEO_TEXT && HIDDEN_VIDEO_TEXT && text.OPENING_ON_TV_TEXT);
});

test('playback problems are explained', () => {
  const { playbackProblemText } = text;
  assert.equal(playbackProblemText(null), '');
  assert.equal(playbackProblemText({ playback: null }), '');
  assert.equal(playbackProblemText({ playback: { status: 'playing' } }), '');
  assert.match(playbackProblemText({ playback: { status: 'error' }, cast: { siteStatus: 403 } }), /link expired/);
  assert.match(playbackProblemText({ playback: { status: 'error', error: 'not_supported' }, cast: { siteStatus: 200 } }), /can't play this kind/);
  assert.match(playbackProblemText({ playback: { status: 'error', error: 'cannot_play' }, cast: null }), /couldn't play this video/);
});

test('times and labels', () => {
  const { clock, videoLabel } = text;
  assert.equal(clock(0), '0:00');
  assert.equal(clock(65.9), '1:05');
  assert.equal(clock(3723), '1:02:03');
  assert.equal(clock(-5), '0:00');
  assert.equal(clock('abc'), '0:00');
  assert.deepEqual(videoLabel({ url: 'https://cdn.example/a/my%20film.m3u8?t=1', kind: 'hls' }), { kind: 'Stream', detail: 'cdn.example · my film.m3u8' });
  assert.deepEqual(videoLabel({ url: 'https://cdn.example/', kind: 'file' }), { kind: 'Video file', detail: 'cdn.example' });
  assert.match(videoLabel({ url: 'https://cdn.example/x.mpd', kind: 'dash' }).kind, /not supported yet/);
  assert.equal(videoLabel({ url: 'https://cdn.example/100%.mp4', kind: 'file' }).detail, 'cdn.example · 100%.mp4', 'a stray % sign does not break the list');
});

function fakeFetch(answer) {
  const calls = [];
  const fetch = async (link, options) => {
    calls.push({ link, options });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, fetch };
}

test('server calls send the session and the right body', async () => {
  const { calls, fetch } = fakeFetch({ ok: true, json: async () => ({ fine: true }) });
  const api = serverApi.createServerApi({ getSession: () => 'my-session', fetch });

  assert.deepEqual(await api.getState(), { fine: true });
  assert.equal(calls[0].link, 'http://127.0.0.1:8787/api/state');
  assert.deepEqual(calls[0].options, { headers: { 'X-VCast-Session': 'my-session' } });

  await api.pair('123456');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { code: '123456' });

  await api.cast({ url: 'https://cdn.example/v.m3u8', kind: 'hls', headers: { referer: 'r' }, foundAt: 5 }, 'Title');
  assert.deepEqual(JSON.parse(calls[2].options.body), { url: 'https://cdn.example/v.m3u8', kind: 'hls', title: 'Title', headers: { referer: 'r' }, subtitles: [], subtitle: -1 });
  await api.cast({ url: 'https://cdn.example/v.m3u8', kind: 'hls' }, 'Title', [{ url: 'https://cdn.example/eng.vtt', label: 'eng' }], 0);
  const withSubtitles = JSON.parse(calls.pop().options.body);
  assert.deepEqual([withSubtitles.subtitles, withSubtitles.subtitle], [[{ url: 'https://cdn.example/eng.vtt', label: 'eng' }], 0]);

  await api.control('seek', 30);
  assert.deepEqual(JSON.parse(calls[3].options.body), { action: 'seek', value: 30 });
  await api.findTvs();
  assert.equal(calls.pop().link, 'http://127.0.0.1:8787/api/tvs');
  await api.openOnTv('192.168.1.6');
  assert.deepEqual(JSON.parse(calls.pop().options.body), { ip: '192.168.1.6' });
  await api.unpair();
  assert.equal(calls[4].link, 'http://127.0.0.1:8787/api/unpair');
});

test('AC-12: server problems come back as error codes', async () => {
  const { createServerApi } = serverApi;
  const down = createServerApi({ getSession: () => null, fetch: fakeFetch(new Error('refused')).fetch });
  await assert.rejects(down.getState(), { code: 'server_down' });

  const { calls, fetch } = fakeFetch({ ok: false, json: async () => ({ error: 'bad_code' }) });
  const refused = createServerApi({ server: 'http://127.0.0.1:9000', getSession: () => null, fetch });
  await assert.rejects(refused.pair('1'), { code: 'bad_code' });
  assert.equal(calls[0].link, 'http://127.0.0.1:9000/api/pair');
  assert.equal(calls[0].options.headers['X-VCast-Session'], undefined);

  const broken = createServerApi({ getSession: () => null, fetch: fakeFetch({ ok: false, json: async () => { throw new Error('not json'); } }).fetch });
  await assert.rejects(broken.getState(), { code: 'unknown' });
  assert.equal(typeof createServerApi({ getSession: () => null }).getState, 'function');
});

test('extension logs cut links down to the site name', () => {
  const lines = [];
  const print = {};
  for (const level of ['debug', 'info', 'warn', 'error']) print[level] = (message, fields) => lines.push([level, message, fields]);
  const log = logFile.logger('popup', print);
  log.info('Casting', { site: 'https://cdn.example/secret/path.m3u8?token=abc', tab: 3 });
  log.warn('Odd link', { site: 'https://' });
  log.debug('a');
  log.error('b');
  assert.deepEqual(lines[0], ['info', '[VCast popup] Casting', { site: 'cdn.example', tab: 3 }]);
  assert.deepEqual(lines[1][2], { site: 'unknown-site' });
  assert.deepEqual(lines.slice(2).map((line) => line[0]), ['debug', 'error']);
  assert.equal(typeof logFile.logger('x').info, 'function');
});
