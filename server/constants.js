'use strict';
// Fixed numbers and lists used by the server, in one place.
// Things a person may want to change per computer live in .env instead (see .env.example).

module.exports = {
  // Version number carried by every message between server and TV.
  MESSAGE_VERSION: 1,

  // Defaults for the .env settings.
  DEFAULT_PORT: 8787,
  DEFAULT_LOG_LEVEL: 'info',
  DEFAULT_CODE_LIFE_SECONDS: 300,
  DEFAULT_WRONG_CODES_PER_MINUTE: 5,

  // Pairing
  CODE_DIGITS: 6,
  MAX_TVS: 8,
  FORGET_TV_AFTER_MS: 10 * 60 * 1000,
  TIDY_EVERY_MS: 15 * 1000,

  // Opening the page on the TV through the TV's own remote-control service
  TV_SEARCH_ADDRESS: '239.255.255.250',
  TV_SEARCH_PORT: 1900,
  TV_SEARCH_MS: 2000,
  TV_INFO_PORT: 8001,
  TV_INFO_WAIT_MS: 2000,
  TV_REMOTE_PORT: 8002,
  TV_ALLOW_WAIT_MS: 30 * 1000,
  // Samsung's own TVs start the browser through the remote-control connection under this name.
  TV_BROWSER_APP: 'org.tizen.browser',
  // Licensed Tizen TVs (other makers) have a "Browser" app with this id instead, started
  // through the TV's app service on the info port. Found on the 2023 set in FINDINGS F-005.
  TV_STORE_BROWSER_APP: '3202010022079',
  TV_APP_CLOSE_WAIT_MS: 3000,
  // After asking the TV to start its browser, check this many times that it really started.
  TV_BROWSER_START_CHECKS: 6,
  TV_BROWSER_START_CHECK_MS: 1000,
  TV_REMOTE_NAME: 'VCast',
  // How long a TV has to show up after its browser was told to open the page.
  EXPECT_TV_MS: 2 * 60 * 1000,

  // Requests from the extension and the TV
  MAX_BODY_BYTES: 64 * 1024,
  MAX_TV_MESSAGE_BYTES: 16 * 1024,
  MAX_HEADER_TEXT: 16384,
  MAX_TITLE_TEXT: 200,
  CONTROL_ACTIONS: ['play', 'pause', 'stop', 'seek', 'volume', 'subtitle', 'subtitleShift'],
  MAX_SUBTITLE_SHIFT_SECONDS: 300,
  MAX_SUBTITLES: 30,
  MAX_SUBTITLE_NAME_TEXT: 40,
  SUBTITLES_OFF: -1,
  PLAYBACK_STATUSES: ['idle', 'loading', 'playing', 'paused', 'buffering', 'ended', 'error'],

  // Fetching video from sites
  SITE_TIMEOUT_MS: 15 * 1000,
  MAX_REDIRECTS: 5,
  MAX_PLAYLIST_BYTES: 5 * 1024 * 1024,
  HEADERS_TO_PASS_ON: ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'],

  // Logging
  MAX_LOG_FILE_BYTES: 2 * 1024 * 1024,
  MAX_LOG_VALUE_TEXT: 120
};
