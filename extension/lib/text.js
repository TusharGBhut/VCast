// Every piece of text the popup shows, in one place.

import { MAX_SUBTITLE_SHIFT_SECONDS, SUBTITLE_SHIFT_STEP_SECONDS } from './constants.js';

const ERROR_TEXT = {
  server_down: "Can't reach VCast on this computer. Start it and try again.",
  bad_code: "That code didn't match. Check the code on the TV and try again.",
  too_many_tries: 'Too many wrong codes. Wait a minute, then try again.',
  tv_offline: "The TV isn't connected. Open the VCast address on the TV again.",
  not_paired: 'The TV is no longer paired. Type the code from the TV again.',
  tv_unreachable: "Can't reach the TV. Check that it is on and on the same Wi-Fi.",
  tv_refused: 'The TV refused. On the TV, choose Allow when it asks about VCast, then try again.',
  tv_no_answer: "The TV didn't answer. If it is asking to allow VCast, choose Allow, then try again.",
  tv_browser_not_started: "The TV got the request but its browser didn't open. Press Home on the TV remote, then try again.",
  bad_tv_address: 'That is not a TV address. It looks like 192.168.1.6 (TV Settings > Network > Network Status).',
  bad_request: "This video can't be sent. Reload the page and try again.",
  forbidden: 'VCast refused the request. Restart VCast on this computer.'
};

export const OPENING_ON_TV_TEXT = 'Opening VCast on the TV. This can take up to 30 seconds. If the TV asks, choose Allow.';
export const DRM_TEXT = "This video is protected (DRM) and can't be sent to the TV.";
export const NO_VIDEO_TEXT = 'No video found yet. Start the video on the page, then open this again.';
export const HIDDEN_VIDEO_TEXT = "A video is playing but its link wasn't seen. Reload the page, play the video, then open this again.";

export function errorText(code) {
  return ERROR_TEXT[code] || 'Something went wrong. Try again.';
}

// Text for a problem during playback, or '' when all is well.
export function playbackProblemText(state) {
  if (!state || !state.playback || state.playback.status !== 'error') return '';
  const siteStatus = state.cast ? state.cast.siteStatus : 0;
  if ([401, 403, 404, 410].includes(siteStatus)) return 'The video link expired. Reload the page and cast again.';
  if (state.playback.error === 'not_supported') return "The TV browser can't play this kind of video.";
  return "The TV couldn't play this video. Reload the page and cast again.";
}

// What the play/pause button does next: 'play' when the video is paused or has finished.
export function playButtonAction(status) {
  return status === 'paused' || status === 'ended' ? 'play' : 'pause';
}

export function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const two = (n) => String(n).padStart(2, '0');
  return (hours ? hours + ':' + two(minutes) : minutes) + ':' + two(total % 60);
}

const LANGUAGE_NAMES = { eng: 'English', en: 'English', hin: 'Hindi', hi: 'Hindi', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French', fr: 'French', ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian', por: 'Portuguese', pt: 'Portuguese', rus: 'Russian', ru: 'Russian', ara: 'Arabic', ar: 'Arabic', jpn: 'Japanese', ja: 'Japanese' };

// Turns a subtitle file name such as "eng-2" into "English". Unknown names are shown as they are.
export function subtitleName(label) {
  const code = String(label).toLowerCase().split(/[^a-z]/)[0];
  return LANGUAGE_NAMES[code] || label;
}

// Which subtitle to show: the one picked last time if this video has it, else English, else none.
// Returns its place in the list, or -1 for none. `savedChoice` is a name from subtitleName, or 'off'.
export function pickSubtitle(labels, savedChoice) {
  const names = labels.map(subtitleName);
  if (savedChoice === 'off') return -1;
  const saved = names.indexOf(savedChoice);
  return saved >= 0 ? saved : names.indexOf('English');
}

// The subtitle timing after pressing Earlier (steps = -1) or Later (steps = 1), in seconds.
// Rounded so many presses do not drift, and kept within what the server accepts.
export function nextSubtitleShift(current, steps) {
  const next = Math.round(((Number(current) || 0) + steps * SUBTITLE_SHIFT_STEP_SECONDS) * 100) / 100;
  return Math.max(-MAX_SUBTITLE_SHIFT_SECONDS, Math.min(MAX_SUBTITLE_SHIFT_SECONDS, next));
}

export function subtitleShiftText(seconds) {
  if (!seconds) return 'In time with the file';
  return 'Shown ' + Math.abs(seconds) + ' s ' + (seconds > 0 ? 'later' : 'earlier');
}

// The title to show on the TV. Normally the tab's title. Some sites play the next episode
// without updating it; when the address ends in an episode number the title does not mention,
// the title is made from the address: ".../dr-stone/ep-18" gives "Dr Stone · Episode 18".
export function videoTitle(tabTitle, pageLink) {
  const title = tabTitle || '';
  let parts;
  try {
    parts = new URL(pageLink).pathname.split('/').filter(Boolean);
  } catch (e) {
    return title;
  }
  const episode = /^(?:ep|episode|e|chapter|part)[-_.]?(\d+)$/i.exec(parts.at(-1) || '');
  if (!episode || new RegExp('\\b0*' + Number(episode[1]) + '\\b').test(title)) return title;
  const show = (parts.at(-2) || '').replace(/[-_]+/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return (show ? show + ' · ' : '') + 'Episode ' + Number(episode[1]);
}

const KIND_NAME = { hls: 'Stream', file: 'Video file', dash: 'DASH stream (not supported yet)' };

// What to show for one found video: its kind, the site, and the file name.
export function videoLabel(video) {
  const address = new URL(video.url);
  let fileName = address.pathname.split('/').pop() || '';
  try {
    fileName = decodeURIComponent(fileName);
  } catch (e) {
    // A name with a stray % sign: show it as it is.
  }
  fileName = fileName.slice(0, 40);
  return { kind: KIND_NAME[video.kind], detail: address.host + (fileName ? ' · ' + fileName : '') };
}
