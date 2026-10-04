// What counts as a video, and how the per-tab list of found videos is kept. No browser calls
// in here, so it can be tested on its own.

import { LOADED_JUST_BEFORE_MS, MAX_SUBTITLES_PER_TAB, MAX_VIDEOS_PER_TAB } from './constants.js';

// Where a tab's info is kept in chrome.storage.session.
export function tabKey(tabId) {
  return 'tab:' + tabId;
}

const STREAM_KINDS = [
  { ending: /\.m3u8$/i, kind: 'hls' },
  { ending: /\.mpd$/i, kind: 'dash' }
];
const SUBTITLE_FILE = /\.vtt$/i;
// Players also use .vtt files for the little preview pictures on the seek bar.
const PREVIEW_PICTURES = /thumb|sprite|storyboard|preview/i;
const SOUND_ONLY = /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus)$/i;
const KIND_ORDER = { hls: 0, file: 1, dash: 2 };

// Returns 'hls', 'dash', 'file', or null when the link is not a video.
export function videoKindOf(link, requestType) {
  let address;
  try {
    address = new URL(link);
  } catch (e) {
    return null;
  }
  if (address.protocol !== 'http:' && address.protocol !== 'https:') return null;
  const stream = STREAM_KINDS.find(({ ending }) => ending.test(address.pathname));
  if (stream) return stream.kind;
  // A whole video file is asked for by a <video> tag (a "media" request). The same endings
  // asked for by page scripts are small pieces of a stream, which cannot be played alone.
  return requestType === 'media' && !SOUND_ONLY.test(address.pathname) ? 'file' : null;
}

// Two links with the same key are the same video. The part after "?" is ignored because it
// often holds a token that changes on every request.
export function sameVideoKey(link) {
  const address = new URL(link);
  return address.host + address.pathname;
}

// Picks the request headers the video site may check before it sends the video.
export function headersToKeep(requestHeaders) {
  const wanted = { referer: 'referer', origin: 'origin', cookie: 'cookie', 'user-agent': 'userAgent' };
  const kept = {};
  for (const header of requestHeaders || []) {
    const name = wanted[header.name.toLowerCase()];
    if (name && header.value) kept[name] = header.value;
  }
  return kept;
}

// Returns the subtitle's name (taken from its file name) when the link is a subtitle file, or null.
export function subtitleNameOf(link) {
  let address;
  try {
    address = new URL(link);
  } catch (e) {
    return null;
  }
  const fileName = address.pathname.split('/').pop();
  if (!SUBTITLE_FILE.test(fileName) || PREVIEW_PICTURES.test(address.pathname)) return null;
  return fileName.replace(SUBTITLE_FILE, '');
}

// The headers a browser sends when a frame loads a link, for links whose real request was not
// seen. To another site a browser sends only the frame's site as Referer, not its full address,
// and video sites check for exactly that.
export function headersSentByFrame(frameLink, link) {
  const frame = new URL(frameLink);
  const sameSite = frame.origin === new URL(link).origin;
  return { referer: sameSite ? frameLink : frame.origin + '/', origin: frame.origin };
}

export function emptyTabInfo() {
  return { videos: [], subtitles: [], hasDrm: false, hasHiddenVideo: false };
}

// Which page a tab is on: the address without the parts after "?" and "#", which sites change
// while the same video keeps playing.
export function pageOf(link) {
  try {
    return sameVideoKey(link);
  } catch (e) {
    return '';
  }
}

// An empty list for a tab that has just moved to `link`. `since` is that moment; links found
// before it belong to the page that was left.
export function tabInfoForNewPage(link, now) {
  return { ...emptyTabInfo(), page: pageOf(link), since: now };
}

// True when a link was found before the tab moved to its current page.
function isFromEarlierPage(tabInfo, item) {
  return item.foundAt !== undefined && item.foundAt < (tabInfo.since || 0) - LOADED_JUST_BEFORE_MS;
}

// Returns the tab info without what was found in one frame, or null when that frame had nothing.
// Used when a frame (the player's iframe) loads a new page.
export function withoutFrame(tabInfo, frameId) {
  const elsewhere = (item) => item.frameId !== frameId;
  const videos = tabInfo.videos.filter(elsewhere);
  const subtitles = (tabInfo.subtitles || []).filter(elsewhere);
  if (videos.length === tabInfo.videos.length && subtitles.length === (tabInfo.subtitles || []).length) return null;
  return { ...tabInfo, videos, subtitles };
}

// Returns the tab info with the subtitle added, or null when it is already there or the list is full.
export function addSubtitle(tabInfo, subtitle) {
  if (isFromEarlierPage(tabInfo, subtitle)) return null;
  const known = tabInfo.subtitles || [];
  const key = sameVideoKey(subtitle.url);
  if (known.length >= MAX_SUBTITLES_PER_TAB || known.some((item) => sameVideoKey(item.url) === key)) return null;
  return { ...tabInfo, subtitles: [...known, subtitle] };
}

// Returns the tab info with the video added, or null when nothing changed.
export function addVideo(tabInfo, video) {
  if (isFromEarlierPage(tabInfo, video)) return null;
  const key = sameVideoKey(video.url);
  const known = tabInfo.videos.find((item) => sameVideoKey(item.url) === key);
  if (known) {
    // Seen again with headers we did not have (the page script saw it first, then the network
    // request showed the cookie): keep the fuller set.
    const hasMore = Object.keys(video.headers || {}).some((name) => !(known.headers || {})[name]);
    if (!hasMore) return null;
    const fuller = { ...known, headers: { ...known.headers, ...video.headers } };
    return { ...tabInfo, videos: tabInfo.videos.map((item) => (item === known ? fuller : item)) };
  }
  // When the list is full the oldest entry makes room, so a long-open page still shows new videos.
  return { ...tabInfo, videos: [...tabInfo.videos, video].slice(-MAX_VIDEOS_PER_TAB) };
}

// Best guess first: HLS streams, then video files, then DASH; older before newer.
export function sortVideos(videos) {
  return [...videos].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.foundAt - b.foundAt);
}
