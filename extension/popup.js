// The popup: pair with the TV, pick a video, control playback.
// It only shows things and passes clicks on; the rules live in lib/.

import { createServerApi } from './lib/server-api.js';
import { emptyTabInfo, sortVideos, tabKey } from './lib/video-list.js';
import { DRM_TEXT, HIDDEN_VIDEO_TEXT, NO_VIDEO_TEXT, OPENING_ON_TV_TEXT, clock, errorText, nextSubtitleShift, pickSubtitle, playButtonAction, playbackProblemText, subtitleName, subtitleShiftText, videoLabel, videoTitle } from './lib/text.js';
import { logger } from './lib/log.js';
import { DEFAULT_SERVER, POPUP_REFRESH_MS, SAVED_SERVER, SAVED_SESSION, SAVED_SUBTITLE, SAVED_TV, SEEK_BACK_SECONDS, SEEK_FORWARD_SECONDS, SUBTITLES_OFF } from './lib/constants.js';

const log = logger('popup');
const byId = (id) => document.getElementById(id);

let session = null;
let state = null;
let tab = null;
let shownVideos = '';
let shownSubtitles = '';
let foundSubtitles = [];
let savedSubtitle = null;
let savedTv = null;
let lookedForTvs = false;
let openingOnTv = false;
let refreshing = null;

let api = null;

function showOnly(viewId) {
  for (const id of ['serverDownView', 'pairView', 'mainView']) byId(id).classList.toggle('hidden', id !== viewId);
  byId('unpair').classList.toggle('hidden', viewId !== 'mainView');
}

function showError(text) {
  byId('error').textContent = text;
  byId('error').classList.toggle('hidden', !text);
}

// Runs a server call started by a click, and shows a message if it fails.
async function run(action) {
  try {
    showError('');
    await action();
  } catch (error) {
    log.warn('Action failed', { code: error.code });
    showError(errorText(error.code));
  }
  await refresh();
}

async function forgetSession() {
  session = null;
  await chrome.storage.local.remove(SAVED_SESSION);
}

function tvButton(tv) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Open on ' + tv.name + ' (' + tv.ip + ')';
  button.addEventListener('click', () => openOnTv(tv));
  return button;
}

// Shows the TV used last time straight away, then adds the TVs found on the network.
async function showTvList() {
  if (lookedForTvs) return;
  lookedForTvs = true;
  if (savedTv) byId('tvList').replaceChildren(tvButton(savedTv));
  const found = await api.findTvs().then((answer) => answer.tvs, () => []);
  const others = found.filter((tv) => !savedTv || tv.ip !== savedTv.ip);
  byId('tvList').append(...others.map(tvButton));
}

// The TV needs up to 15 seconds to open its browser. More clicks in that time are ignored.
async function openOnTv(tv) {
  if (openingOnTv) return;
  openingOnTv = true;
  byId('waiting').textContent = OPENING_ON_TV_TEXT;
  await run(async () => {
    session = (await api.openOnTv(tv.ip)).session;
    savedTv = tv;
    await chrome.storage.local.set({ [SAVED_SESSION]: session, [SAVED_TV]: tv });
  });
  openingOnTv = false;
}

// Only one refresh runs at a time; the timer and button clicks share it.
function refresh() {
  refreshing = refreshing || loadAndShow().finally(() => (refreshing = null));
  return refreshing;
}

async function loadAndShow() {
  const sessionUsed = session;
  try {
    state = await api.getState();
  } catch (error) {
    byId('serverDownText').textContent = errorText(error.code);
    return showOnly('serverDownView');
  }
  // Pairing finished while we were asking, so this answer is already out of date.
  if (sessionUsed !== session) return loadAndShow();
  if (!state.paired) {
    // After "Open on TV" the session exists before the TV's page has connected.
    if (session && !state.waitingForTv) {
      await forgetSession();
      showError(errorText('not_paired'));
    }
    byId('waiting').textContent = state.waitingForTv ? OPENING_ON_TV_TEXT : '';
    showTvList();
    byId('tvAddress').textContent = state.tvAddresses[0] || 'Connect this computer to your home Wi-Fi first.';
    return showOnly('pairView');
  }
  showOnly('mainView');
  showPlayback();
  const key = tabKey(tab.id);
  const info = { ...emptyTabInfo(), ...(await chrome.storage.session.get(key))[key] };
  showVideos(info);
  foundSubtitles = info.subtitles;
  // While a video is on the TV the list is the one sent with it; before that, the one found in the tab.
  if (state.cast) showSubtitles(state.cast.subtitles, state.cast.subtitle);
  else showSubtitles(foundSubtitles.map((subtitle) => subtitle.label), null);
  // Timing can be changed only for a subtitle that is showing on the TV right now.
  const subtitleShowing = !!state.cast && state.cast.subtitle >= 0;
  byId('subtitleTiming').classList.toggle('hidden', !subtitleShowing);
  if (subtitleShowing) byId('subtitleShift').textContent = subtitleShiftText(state.cast.subtitleShift);
}

function shiftSubtitles(steps) {
  return run(() => api.control('subtitleShift', steps ? nextSubtitleShift(state.cast.subtitleShift, steps) : 0));
}

// `chosen` is the place in the list of the subtitle now showing on the TV, or null when
// nothing is playing yet and the remembered choice should be used.
function showSubtitles(labels, chosen) {
  const list = byId('subtitles');
  const snapshot = JSON.stringify(labels);
  byId('subtitlesRow').classList.toggle('hidden', !labels.length);
  if (snapshot !== shownSubtitles) {
    list.replaceChildren(new Option('Off', SUBTITLES_OFF), ...labels.map((label, place) => new Option(subtitleName(label), place)));
    list.value = pickSubtitle(labels, savedSubtitle);
    shownSubtitles = snapshot;
  }
  if (chosen !== null && document.activeElement !== list) list.value = chosen;
}

function showPlayback() {
  const { cast, playback, tv } = state;
  byId('tvStatus').textContent = tv.connected ? 'TV connected' : errorText('tv_offline');
  byId('nowPlaying').classList.toggle('hidden', !cast);
  const problem = playbackProblemText(state);
  if (problem) showError(problem);
  if (!cast) return;

  byId('playingTitle').textContent = cast.title || 'Playing on TV';
  byId('playPause').textContent = playButtonAction(playback.status) === 'play' ? 'Play' : 'Pause';
  byId('times').textContent = clock(playback.position) + ' / ' + clock(playback.duration);
  setSlider('volume', playback.volume);
  setSlider('seek', Math.floor(playback.position), Math.floor(playback.duration));
}

function showVideos(info) {
  const videos = info.hasDrm ? [] : sortVideos(info.videos);
  const canCast = state.tv.connected;
  const snapshot = JSON.stringify([info.hasDrm, info.hasHiddenVideo, canCast, videos.map((video) => video.url)]);
  if (snapshot === shownVideos) return;

  let notice = '';
  if (info.hasDrm) notice = DRM_TEXT;
  else if (!videos.length) notice = info.hasHiddenVideo ? HIDDEN_VIDEO_TEXT : NO_VIDEO_TEXT;
  byId('notice').textContent = notice;

  byId('videos').replaceChildren(
    ...videos.map((video) => {
      const label = videoLabel(video);
      const item = document.createElement('li');
      const text = document.createElement('div');
      const kind = document.createElement('div');
      const detail = document.createElement('div');
      const button = document.createElement('button');
      kind.textContent = label.kind;
      detail.textContent = label.detail;
      detail.className = 'small detail';
      text.append(kind, detail);
      button.textContent = 'Cast';
      button.type = 'button';
      button.disabled = video.kind === 'dash' || !canCast;
      button.addEventListener('click', () => run(() => castVideo(video)));
      item.append(text, button);
      return item;
    })
  );
  shownVideos = snapshot;
}

// Sliders are left alone while a finger or mouse is moving them.
function setSlider(id, value, max) {
  const slider = byId(id);
  if (slider.dataset.moving) return;
  if (max !== undefined) slider.max = max;
  slider.value = value;
}

function onSliderMoved(id, action) {
  const slider = byId(id);
  slider.addEventListener('input', () => (slider.dataset.moving = 'yes'));
  slider.addEventListener('change', () => {
    delete slider.dataset.moving;
    run(() => api.control(action, Number(slider.value)));
  });
}

async function castVideo(video) {
  const headers = { userAgent: navigator.userAgent, ...video.headers };
  log.info('Casting', { kind: video.kind, site: video.url });
  // Read the tab again: its title and address may have changed since the popup opened.
  tab = await chrome.tabs.get(tab.id).catch(() => tab);
  return api.cast({ ...video, headers }, videoTitle(tab.title, tab.url), foundSubtitles, Number(byId('subtitles').value));
}

function seekBy(seconds) {
  const { position, duration } = state.playback;
  const target = Math.max(0, position + seconds);
  return api.control('seek', duration ? Math.min(target, duration) : target);
}

byId('retry').addEventListener('click', refresh);
byId('tvForm').addEventListener('submit', (event) => {
  event.preventDefault();
  openOnTv({ ip: byId('tvIp').value.trim(), name: 'TV' });
});
byId('pairForm').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    session = (await api.pair(byId('code').value)).session;
    await chrome.storage.local.set({ [SAVED_SESSION]: session });
    byId('code').value = '';
  });
});
byId('unpair').addEventListener('click', () =>
  run(async () => {
    await api.unpair();
    await forgetSession();
  })
);
byId('playPause').addEventListener('click', () => run(() => api.control(playButtonAction(state.playback.status))));
byId('stop').addEventListener('click', () => run(() => api.control('stop')));
byId('back').addEventListener('click', () => run(() => seekBy(-SEEK_BACK_SECONDS)));
byId('forward').addEventListener('click', () => run(() => seekBy(SEEK_FORWARD_SECONDS)));
byId('subtitles').addEventListener('change', (event) => {
  const list = event.target;
  const place = Number(list.value);
  savedSubtitle = place === SUBTITLES_OFF ? 'off' : list.selectedOptions[0].textContent;
  chrome.storage.local.set({ [SAVED_SUBTITLE]: savedSubtitle });
  if (state.cast) run(() => api.control('subtitle', place));
});
byId('subtitlesEarlier').addEventListener('click', () => shiftSubtitles(-1));
byId('subtitlesLater').addEventListener('click', () => shiftSubtitles(1));
byId('subtitlesReset').addEventListener('click', () => shiftSubtitles(0));
onSliderMoved('volume', 'volume');
onSliderMoved('seek', 'seek');

// The address is only asked for when VCast cannot be reached, which is when it matters:
// someone changed VCAST_PORT in .env.
function useServer(address) {
  byId('serverAddress').value = address;
  api = createServerApi({ server: address, getSession: () => session });
}

byId('serverForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const address = byId('serverAddress').value.trim().replace(/\/+$/, '') || DEFAULT_SERVER;
  await chrome.storage.local.set({ [SAVED_SERVER]: address });
  useServer(address);
  await refresh();
});

async function start() {
  const saved = await chrome.storage.local.get([SAVED_SESSION, SAVED_SERVER, SAVED_SUBTITLE, SAVED_TV]);
  savedTv = saved[SAVED_TV] || null;
  session = saved[SAVED_SESSION] || null;
  savedSubtitle = saved[SAVED_SUBTITLE] || null;
  useServer(saved[SAVED_SERVER] || DEFAULT_SERVER);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Look at the page again now. This finds a video that started before the extension was
  // installed or reloaded. It fails on pages extensions may not touch, which have no video anyway.
  chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['page-watcher.js'] }).catch(() => {});
  await refresh();
  setInterval(refresh, POPUP_REFRESH_MS);
}

start();
