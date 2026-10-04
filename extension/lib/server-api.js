// Calls to the VCast server on this computer.

import { DEFAULT_SERVER, SESSION_HEADER } from './constants.js';

// `getSession` returns the saved pairing session (or nothing). Failed calls throw an Error
// whose `code` is one of the keys in text.js.
export function createServerApi({ server = DEFAULT_SERVER, getSession, fetch = globalThis.fetch }) {
  async function call(path, body) {
    const headers = {};
    const session = await getSession();
    if (session) headers[SESSION_HEADER] = session;
    const options = { headers };
    if (body) {
      options.method = 'POST';
      options.body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }

    let response;
    try {
      response = await fetch(server + path, options);
    } catch (e) {
      throw problem('server_down');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw problem(data.error || 'unknown');
    return data;
  }

  return {
    getState: () => call('/api/state'),
    pair: (code) => call('/api/pair', { code }),
    findTvs: () => call('/api/tvs'),
    openOnTv: (ip) => call('/api/open-on-tv', { ip }),
    unpair: () => call('/api/unpair', {}),
    // `subtitles` is the list found in the tab; `subtitle` is the number of the one to show (-1 for none).
    cast: (video, title, subtitles = [], subtitle = -1) => call('/api/cast', { url: video.url, kind: video.kind, title, headers: video.headers, subtitles, subtitle }),
    control: (action, value) => call('/api/control', { action, value })
  };
}

function problem(code) {
  return Object.assign(new Error(code), { code });
}
