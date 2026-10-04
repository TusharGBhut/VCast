/* The TV page. Old TV browsers run this, so it is plain ES5: var, function, no arrow functions. */
(function () {
  'use strict';

  var RETRY_MS = 2000;
  var REPORT_MS = 1000;
  var OVERLAY_MS = 4000;
  var SEEK_SECONDS = 10;
  var LONG_SEEK_SECONDS = 30;
  var KEY = { ENTER: 13, BACK: 10009, LEFT: 37, RIGHT: 39, PAUSE: 19, PLAY: 415, STOP: 413, REWIND: 412, FORWARD: 417, PLAY_PAUSE: 10252 };

  var video = document.getElementById('video');
  var socket = null;
  var hls = null;
  var hasVideo = false;
  var problem = '';
  var needsKeyPress = false;
  var overlayTimer = null;
  var paired = false;
  var loadCount = 0;
  var subtitleTracks = [];
  var subtitlePlace = -1;
  var subtitleShift = 0;
  var overlayStays = false;
  var savedTvId = null;
  var pageVersion = null;

  function byId(id) {
    return document.getElementById(id);
  }

  // Full screen hides the TV browser's address bar. A browser only allows it right after a key
  // press or click, so the first press of any remote key is used for that.
  var page = document.documentElement;
  var askForFullScreen = page.requestFullscreen || page.webkitRequestFullscreen || page.webkitRequestFullScreen;
  var fullScreenTriesLeft = 1;

  function isFullScreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  // Returns true when it asked the browser for full screen.
  function goFullScreen() {
    if (!askForFullScreen || isFullScreen()) return false;
    try {
      var result = askForFullScreen.call(page);
      if (result && result['catch']) result['catch'](function () {});
    } catch (e) {
      return false;
    }
    return true;
  }

  function onFullScreenChange() {
    // One try per visit to normal view: a browser that refuses costs one key press, not all of them.
    if (isFullScreen()) fullScreenTriesLeft = 1;
    byId('fullScreenHint').className = !askForFullScreen || isFullScreen() ? 'hidden' : '';
  }

  function showScreen(name) {
    var names = ['pairScreen', 'readyScreen', 'playerScreen'];
    for (var i = 0; i < names.length; i++) {
      byId(names[i]).className = names[i] === name ? 'screen' : 'screen hidden';
    }
  }

  // The TV keeps one id so the server knows it again after a reload or a network drop.
  function tvId() {
    if (savedTvId) return savedTvId;
    var id = null;
    try {
      id = window.localStorage.getItem('vcastTvId');
    } catch (e) { /* storage can be turned off */ }
    if (!id) {
      id = 'tv' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      try {
        window.localStorage.setItem('vcastTvId', id);
      } catch (e) { /* keep the id for this visit only */ }
    }
    savedTvId = id;
    return id;
  }

  function send(message) {
    if (!socket || socket.readyState !== 1) return;
    message.v = 1;
    socket.send(JSON.stringify(message));
  }

  function twoDigits(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function clock(seconds) {
    seconds = Math.floor(seconds || 0);
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    return (h ? h + ':' + twoDigits(m) : m) + ':' + twoDigits(seconds % 60);
  }

  function status() {
    if (!hasVideo) return 'idle';
    if (problem) return 'error';
    if (video.ended) return 'ended';
    if (video.readyState < 3 && !video.paused) return video.currentTime > 0 ? 'buffering' : 'loading';
    return video.paused ? 'paused' : 'playing';
  }

  function report() {
    var length = isFinite(video.duration) ? video.duration : 0;
    send({ type: 'media.state', status: status(), position: video.currentTime || 0, duration: length, volume: video.volume, error: problem || undefined });
    byId('barFill').style.width = (length ? Math.min(100, (video.currentTime / length) * 100) : 0) + '%';
    byId('time').innerHTML = clock(video.currentTime) + (length ? ' / ' + clock(length) : '');
    byId('playButton').innerHTML = video.paused ? 'Play' : 'Pause';
  }

  // Brings the title bar and buttons back. They hide again after a while, unless the last
  // message was one that stays (paused, an error).
  function wakeOverlay() {
    byId('overlay').className = '';
    clearTimeout(overlayTimer);
    if (!overlayStays) {
      overlayTimer = setTimeout(function () {
        byId('overlay').className = 'hidden';
      }, OVERLAY_MS);
    }
  }

  function showOverlay(text, keep) {
    byId('message').innerHTML = text || '';
    overlayStays = !!keep;
    wakeOverlay();
  }

  function fail(reason, text) {
    problem = reason;
    showOverlay(text, true);
    report();
  }

  function startPlaying() {
    var thisLoad = loadCount;
    var result;
    try {
      result = video.play();
    } catch (e) {
      result = null;
    }
    // Some TV browsers refuse to start a video until a key is pressed. Other failures
    // (a newer video took over, the video cannot be played) are handled elsewhere.
    if (result && result['catch']) {
      result['catch'](function (error) {
        if (thisLoad !== loadCount || !error || error.name !== 'NotAllowedError') return;
        needsKeyPress = true;
        showOverlay('Press OK on the remote to start', true);
      });
    }
  }

  function unloadVideo() {
    if (hls) {
      hls.destroy();
      hls = null;
    }
    for (var i = 0; i < subtitleTracks.length; i++) video.removeChild(subtitleTracks[i]);
    subtitleTracks = [];
    video.removeAttribute('src');
    video.load();
    loadCount++;
    hasVideo = false;
    problem = '';
    needsKeyPress = false;
  }

  // Moves every line of one subtitle file by `subtitleShift` seconds, counted from the times in
  // the file (kept on each line the first time), so it can be run again and again.
  function shiftSubtitle(trackElement) {
    var list = trackElement.track.cues;
    if (!list) return;
    // Copied first: changing a line's time can move it within the browser's own list.
    var lines = [];
    for (var i = 0; i < list.length; i++) lines.push(list[i]);
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (line.fileStart === undefined) {
        line.fileStart = line.startTime;
        line.fileEnd = line.endTime;
      }
      try {
        line.startTime = line.fileStart + subtitleShift;
        line.endTime = line.fileEnd + subtitleShift;
      } catch (e) { /* a browser that refuses a time before zero: that line stays as it was */ }
    }
  }

  function shiftAllSubtitles() {
    for (var i = 0; i < subtitleTracks.length; i++) shiftSubtitle(subtitleTracks[i]);
  }

  function subtitleShiftText() {
    if (!subtitleShift) return 'Subtitles in time with the file';
    return 'Subtitles ' + Math.abs(subtitleShift) + ' s ' + (subtitleShift > 0 ? 'later' : 'earlier');
  }

  // Shows the subtitle at this place in the list and hides the others. -1 hides them all.
  function showSubtitle(place) {
    subtitlePlace = place;
    for (var i = 0; i < subtitleTracks.length; i++) {
      var mode = i === place ? 'showing' : 'disabled';
      if (subtitleTracks[i].track.mode !== mode) subtitleTracks[i].track.mode = mode;
    }
  }

  function addSubtitles(subtitles, place) {
    for (var i = 0; i < (subtitles || []).length; i++) {
      var track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = subtitles[i].label;
      track.src = subtitles[i].url;
      // The lines arrive when the file has loaded; move them then.
      track.addEventListener('load', shiftAllSubtitles);
      video.appendChild(track);
      subtitleTracks.push(track);
    }
    showSubtitle(typeof place === 'number' ? place : -1);
  }

  function loadVideo(message) {
    unloadVideo();
    var thisLoad = loadCount;
    hasVideo = true;
    subtitleShift = Number(message.subtitleShift) || 0;
    addSubtitles(message.subtitles, message.subtitle);
    showScreen('playerScreen');
    byId('title').innerHTML = '';
    byId('title').appendChild(document.createTextNode(message.title || ''));
    showOverlay('Loading...');

    var startAt = message.startAt || 0;
    var triedRecovery = false;
    var Hls = window.Hls;
    if (message.kind === 'hls' && Hls && Hls.isSupported()) {
      hls = new Hls({ startPosition: startAt > 0 ? startAt : -1 });
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !triedRecovery) {
          triedRecovery = true;
          return hls.recoverMediaError();
        }
        fail(data.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network' : 'cannot_play', 'This video could not be played. Try again from your computer.');
      });
      hls.loadSource(message.url);
      hls.attachMedia(video);
    } else if (message.kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl')) {
      return fail('not_supported', 'This TV browser cannot play this kind of video.');
    } else {
      video.src = message.url;
      if (startAt > 0) {
        video.addEventListener('loadedmetadata', function jump() {
          video.removeEventListener('loadedmetadata', jump);
          if (thisLoad === loadCount) video.currentTime = startAt;
        });
      }
    }
    startPlaying();
  }

  function seekBy(seconds) {
    var length = isFinite(video.duration) ? video.duration : 0;
    var target = Math.max(0, video.currentTime + seconds);
    video.currentTime = length ? Math.min(target, length - 1) : target;
    showOverlay(seconds > 0 ? 'Forward' : 'Back', video.paused);
  }

  function togglePlay() {
    if (video.paused) startPlaying();
    else video.pause();
  }

  // The on-screen buttons do what the remote keys do. They only work while a video is loaded.
  function onButton(id, action) {
    byId(id).onclick = function () {
      if (!hasVideo) return;
      needsKeyPress = false;
      action();
    };
  }

  function showWaitingScreen() {
    showScreen(paired ? 'readyScreen' : 'pairScreen');
  }

  // Stop pressed on the remote: tell the computer, so it does not send the video again.
  function stopFromRemote() {
    unloadVideo();
    showWaitingScreen();
    send({ type: 'media.stopped' });
  }

  function control(action, value) {
    if (action === 'stop') {
      unloadVideo();
      return showWaitingScreen();
    }
    if (!hasVideo) return;
    if (action === 'play') startPlaying();
    if (action === 'pause') video.pause();
    if (action === 'seek') video.currentTime = value;
    if (action === 'subtitle') {
      showSubtitle(value);
      showOverlay(value >= 0 && subtitleTracks[value] ? 'Subtitles: ' + subtitleTracks[value].label : 'Subtitles off');
    }
    if (action === 'subtitleShift') {
      subtitleShift = Number(value) || 0;
      shiftAllSubtitles();
      showOverlay(subtitleShiftText());
    }
    if (action === 'volume') {
      video.volume = Math.max(0, Math.min(1, value));
      video.muted = false;
      showOverlay('Volume ' + Math.round(video.volume * 100) + '%');
    }
  }

  function handleMessage(message) {
    if (message.type === 'page.version') {
      // The first answer tells which version this page is. A different one later means VCast
      // was updated while this page stayed open, so load the new page.
      if (pageVersion && pageVersion !== message.version) return window.location.reload();
      pageVersion = message.version;
    } else if (message.type === 'pair.code') {
      // A code means we are not paired (any more), so a video still on screen is dead.
      paired = false;
      unloadVideo();
      byId('code').innerHTML = String(message.code).replace(/\D/g, '');
      showScreen('pairScreen');
    } else if (message.type === 'pair.ok') {
      paired = true;
      if (!hasVideo) showScreen('readyScreen');
    } else if (message.type === 'media.load') {
      loadVideo(message);
    } else if (message.type === 'media.control') {
      control(message.action, message.value);
    } else if (message.type === 'session.end') {
      paired = false;
      unloadVideo();
      showScreen('pairScreen');
    }
  }

  function connect() {
    // When the computer opened this page on the TV, the link carries a one-time key that pairs it.
    var key = /^\/key-([\w-]+)$/.exec(window.location.pathname);
    socket = new WebSocket('ws://' + window.location.host + '/tv?id=' + tvId() + (key ? '&key=' + key[1] : ''));
    socket.onopen = function () {
      byId('connection').innerHTML = '';
      send({ type: 'tv.hello', hasVideo: hasVideo });
    };
    socket.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      handleMessage(message);
    };
    socket.onclose = function () {
      byId('connection').innerHTML = 'Lost the connection to the computer. Trying again...';
      setTimeout(connect, RETRY_MS);
    };
  }

  document.addEventListener('fullscreenchange', onFullScreenChange);
  document.addEventListener('webkitfullscreenchange', onFullScreenChange);
  document.addEventListener('click', goFullScreen);
  onFullScreenChange();

  document.addEventListener('keydown', function (event) {
    var key = event.keyCode;
    if (fullScreenTriesLeft > 0 && key !== KEY.BACK) {
      fullScreenTriesLeft--;
      if (goFullScreen()) return event.preventDefault();
    }
    // On the "Connected" screen, OK asks for a new code so a different computer can pair.
    if (!hasVideo && paired && key === KEY.ENTER) return send({ type: 'pair.restart' });
    if (!hasVideo) return;
    if (needsKeyPress) {
      needsKeyPress = false;
      showOverlay('');
      return startPlaying();
    }
    if (key === KEY.ENTER || key === KEY.PLAY_PAUSE) togglePlay();
    else if (key === KEY.PLAY) startPlaying();
    else if (key === KEY.PAUSE) video.pause();
    else if (key === KEY.STOP || key === KEY.BACK) stopFromRemote();
    else if (key === KEY.LEFT) seekBy(-SEEK_SECONDS);
    else if (key === KEY.RIGHT) seekBy(SEEK_SECONDS);
    else if (key === KEY.REWIND) seekBy(-LONG_SEEK_SECONDS);
    else if (key === KEY.FORWARD) seekBy(LONG_SEEK_SECONDS);
    else return;
    event.preventDefault();
  });

  onButton('playButton', togglePlay);
  onButton('backButton', function () { seekBy(-SEEK_SECONDS); });
  onButton('forwardButton', function () { seekBy(SEEK_SECONDS); });
  // Moving the remote's pointer brings the buttons back.
  document.addEventListener('mousemove', function () {
    if (hasVideo) wakeOverlay();
  });

  // The stream player switches subtitle tracks on by itself; put back the one that was chosen.
  if (video.textTracks && video.textTracks.addEventListener) {
    video.textTracks.addEventListener('change', function () { showSubtitle(subtitlePlace); });
  }

  video.addEventListener('playing', function () { showOverlay(''); report(); });
  // An error message stays on screen; later player events must not write over it.
  video.addEventListener('pause', function () { if (hasVideo && !problem) showOverlay('Paused', true); report(); });
  video.addEventListener('waiting', function () { if (!problem) showOverlay('Loading...', true); report(); });
  video.addEventListener('ended', function () { showOverlay('Finished', true); report(); });
  video.addEventListener('seeked', report);
  video.addEventListener('volumechange', report);
  video.addEventListener('error', function () {
    if (hasVideo && !hls) fail('cannot_play', 'This video could not be played. Try again from your computer.');
  });

  setInterval(function () {
    if (hasVideo) report();
  }, REPORT_MS);

  connect();
})();
