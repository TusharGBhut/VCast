// Fixed values used by the extension, in one place.

// Where the VCast server is unless the person saved another address in the popup.
export const DEFAULT_SERVER = 'http://127.0.0.1:8787';
export const SESSION_HEADER = 'X-VCast-Session';

// Keys in chrome.storage.local
export const SAVED_SESSION = 'session';
export const SAVED_SERVER = 'serverAddress';
export const SAVED_TV = 'tvAddress';

export const MAX_VIDEOS_PER_TAB = 15;
// A link loaded this long before the page changed still counts as belonging to the new page:
// some sites load the next video a moment before they change the address.
export const LOADED_JUST_BEFORE_MS = 3000;
export const MAX_SUBTITLES_PER_TAB = 30;
export const SUBTITLES_OFF = -1;
export const SAVED_SUBTITLE = 'subtitleChoice';
// One press of Earlier or Later moves subtitles by this much.
export const SUBTITLE_SHIFT_STEP_SECONDS = 0.25;
export const MAX_SUBTITLE_SHIFT_SECONDS = 300;
export const POPUP_REFRESH_MS = 1000;
export const SEEK_BACK_SECONDS = 10;
export const SEEK_FORWARD_SECONDS = 30;
