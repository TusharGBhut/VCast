// Watches network requests and keeps a list of the videos found in each tab.
// The browser can stop this script at any time, so nothing is kept in variables: the list
// lives in chrome.storage.session, which lasts until the browser closes.

import { addSubtitle, addVideo, emptyTabInfo, headersSentByFrame, headersToKeep, subtitleNameOf, tabKey, videoKindOf } from './lib/video-list.js';
import { logger } from './lib/log.js';

const log = logger('background');

// Changes to a tab's info run one after another, so two requests arriving together
// cannot overwrite each other. `change` returns the new info, or null to leave it as it is.
let lastChange = Promise.resolve();
export function changeTabInfo(tabId, change) {
  lastChange = lastChange
    .then(async () => {
      const key = tabKey(tabId);
      const saved = await chrome.storage.session.get(key);
      const next = change(saved[key] || emptyTabInfo());
      if (next) await chrome.storage.session.set({ [key]: next });
    })
    .catch((error) => log.error('Could not save tab info', { reason: error.message }));
  return lastChange;
}

function rememberVideo(tabId, video) {
  return changeTabInfo(tabId, (info) => {
    const next = addVideo(info, video);
    if (next) log.info('Found a video', { tab: tabId, kind: video.kind, site: video.url });
    return next;
  });
}

export function onRequest(details) {
  if (details.tabId < 0) return;
  // A new page in the tab: forget the videos of the old page.
  if (details.type === 'main_frame') return changeTabInfo(details.tabId, emptyTabInfo);
  const subtitleName = subtitleNameOf(details.url);
  if (subtitleName) return changeTabInfo(details.tabId, (info) => addSubtitle(info, { url: details.url, label: subtitleName }));
  const kind = videoKindOf(details.url, details.type);
  if (!kind) return;
  return rememberVideo(details.tabId, { url: details.url, kind, headers: headersToKeep(details.requestHeaders), foundAt: Date.now() });
}

export function onPageMessage(message, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId === undefined || !message) return;
  if (message.type === 'drm') {
    log.info('Page uses DRM', { tab: tabId });
    return changeTabInfo(tabId, (info) => (info.hasDrm ? null : { ...info, hasDrm: true }));
  }
  if (message.type === 'hidden-video') {
    return changeTabInfo(tabId, (info) => (info.hasHiddenVideo ? null : { ...info, hasHiddenVideo: true }));
  }
  if (message.type === 'loaded-links' && Array.isArray(message.links)) {
    // Links the page loaded before we were listening. The request headers were not seen, but
    // the frame that loaded them is known, and that is what sites check.
    return Promise.all(
      message.links.map((link) => {
        const subtitleName = subtitleNameOf(link);
        if (subtitleName) return changeTabInfo(tabId, (info) => addSubtitle(info, { url: link, label: subtitleName }));
        const kind = videoKindOf(link, 'xmlhttprequest');
        return kind && rememberVideo(tabId, { url: link, kind, headers: headersSentByFrame(sender.url, link), foundAt: Date.now() });
      })
    );
  }
  if (message.type === 'video') {
    const kind = videoKindOf(message.url, 'media');
    if (!kind) return;
    // Seen in the page, not on the network, so the headers are worked out from the frame.
    return rememberVideo(tabId, { url: message.url, kind, headers: headersSentByFrame(sender.url, message.url), foundAt: Date.now() });
  }
}

// Goes through the same queue as changes, so a late change cannot bring a closed tab back.
export function onTabClosed(tabId) {
  lastChange = lastChange.then(() => chrome.storage.session.remove(tabKey(tabId))).catch(() => {});
  return lastChange;
}

chrome.webRequest.onSendHeaders.addListener(
  onRequest,
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'media', 'xmlhttprequest', 'object', 'other'] },
  ['requestHeaders', 'extraHeaders']
);
chrome.runtime.onMessage.addListener((message, sender) => {
  onPageMessage(message, sender);
});
chrome.tabs.onRemoved.addListener(onTabClosed);
