// Runs in every page and frame. Tells the background script about <video> tags, DRM, and
// stream and subtitle links the page has already loaded.
// The popup runs this file again each time it opens, so a page that was open before the
// extension was installed or reloaded is still looked at.
(function () {
  var STREAM_OR_SUBTITLE = /\.(m3u8|mpd|vtt)$/i;
  var MAX_LINKS = 50;

  function tell(message) {
    // Fails when the extension was reloaded while this page stayed open. Nothing to do then.
    try {
      chrome.runtime.sendMessage(message).catch(function () {});
    } catch (e) { /* same reason */ }
  }

  function checkVideo(video) {
    if (!video || video.tagName !== 'VIDEO') return;
    if (video.mediaKeys) return tell({ type: 'drm' });
    var link = video.currentSrc || video.src;
    if (/^https?:/i.test(link)) tell({ type: 'video', url: link });
    // A blob: link is built by the page from pieces, so there is nothing to send to the TV
    // unless the real stream link is known.
    else if (/^blob:/i.test(link)) tell({ type: 'hidden-video' });
  }

  // The browser keeps a list of what this frame has loaded. It still holds the stream and
  // subtitle links when the background script was not listening at the time they were fetched.
  function linksAlreadyLoaded() {
    var links = [];
    try {
      var loaded = performance.getEntriesByType('resource');
      for (var i = 0; i < loaded.length && links.length < MAX_LINKS; i++) {
        // `at` is the clock time the link was loaded, so links from an earlier video can be told apart.
        if (STREAM_OR_SUBTITLE.test(loaded[i].name.split('?')[0])) links.push({ url: loaded[i].name, at: Math.round(performance.timeOrigin + loaded[i].startTime) });
      }
    } catch (e) { /* the list is not available in this frame */ }
    return links;
  }

  function reportWhatIsHere() {
    var links = linksAlreadyLoaded();
    if (links.length) tell({ type: 'loaded-links', links: links });
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) checkVideo(videos[i]);
  }

  function onVideoEvent(event) { checkVideo(event.target); }
  function onEncrypted() { tell({ type: 'drm' }); }

  // Take off the listeners of an earlier run of this file before adding new ones.
  if (window.vcastStopWatching) window.vcastStopWatching();
  // These events do not bubble, so they are caught on the way down (third argument true).
  document.addEventListener('loadedmetadata', onVideoEvent, true);
  document.addEventListener('playing', onVideoEvent, true);
  document.addEventListener('encrypted', onEncrypted, true);
  window.vcastStopWatching = function () {
    document.removeEventListener('loadedmetadata', onVideoEvent, true);
    document.removeEventListener('playing', onVideoEvent, true);
    document.removeEventListener('encrypted', onEncrypted, true);
  };

  reportWhatIsHere();
})();
