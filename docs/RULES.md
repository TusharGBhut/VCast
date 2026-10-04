# Rules

Treat every rule here as truth. A design or change that conflicts with one is wrong, however convenient.

## Hard constraints

### C1. DRM is out

Netflix, Prime Video, Hotstar and similar use DRM (EME with Widevine/PlayReady). Their streams cannot be extracted or routed. The extension detects DRM and shows a clear "not supported" message. Mirroring is a Future item only.

### C2. The extension is an MV3 client, nothing more

- It has no listening sockets and no raw TCP/UDP, so it does no SSDP discovery and hosts no server.
- The service worker can be suspended at any moment. Keep state in `chrome.storage` or in the server, and make every handler safe to run after a cold start.
- It talks only over HTTP/WebSocket to a known host, or over Native Messaging.

### C3. The server does the networking

A companion server runs on the same PC (Node.js or Go, single binary; Windows first). The extension reaches it over localhost HTTP/WebSocket or Native Messaging. The server:

1. serves the TV receiver page over plain HTTP on the LAN (`http://<PC-IP>:<port>`);
2. runs the pairing and control channel (WebSocket);
3. does SSDP discovery of DLNA renderers;
4. runs the stream proxy, re-requesting media with the original page's `Referer`, `Origin`, `Cookie` and `User-Agent`, because the TV fetching directly often gets 403s or CORS failures.

### C4. Two receiver modes, zero install on the TV

- **R1, TV-browser receiver.** The TV's built-in Internet app opens the server's page. The page shows the pairing code and plays media in `<video>`, with hls.js for HLS. The Tizen browser may be an old Chromium, so receiver code is ES5-safe or transpiled, D-pad friendly, and keeps the screen awake.
- **R2, DLNA push.** The server sends UPnP AVTransport actions (`SetAVTransportURI`, `Play`, `Pause`, `Seek`, `Stop`) to the TV's built-in renderer, pointing it at the proxy URL.

### C5. Video detection

- Sources: `<video>` elements, including those inside iframes, plus network observation of `.m3u8`, `.mpd` and `.mp4` requests.
- A `blob:` URL from Media Source Extensions cannot be sent. Find the underlying manifest.
- Signed URLs expire. Cast quickly, and refresh the URL when it has expired.
- Expect several candidate streams and several quality variants per page; let the user choose when the best one is ambiguous.

### C6. Mixed content

An HTTPS page cannot talk to `ws://` on the LAN. The receiver page is therefore served by the server over HTTP, never from a public HTTPS site.

## Security

There is no auth by design, so these controls are the whole security surface. All apply from the first line of server code.

- **Home network only.** The server listens on every network card (the computer's address can change) and drops any connection that does not come from this computer or a home-network address. The API answers this computer only.
- **Pairing code.** Short-lived, with an expiry, single-use, rate-limited on attempts.
- **Closed proxy.** The proxy serves only URLs registered by the paired extension session, plus links signed while rewriting that video's own playlists. A video from the internet can never make the server fetch from the home network.
- **Minimal permissions.** Each extension permission is requested only when a feature needs it, with the reason written next to it in the manifest review notes.
- **Safe logging.** Logs carry event names and safe fields only (host, status code, duration, session id prefix). Full media URLs, cookies, headers, and sensitive page titles stay out of logs, error messages and crash output.
- **Telemetry.** Local logs only, unless the user opts in.

## Coding rules

- **Plain English everywhere.** Function names, variables, log messages, comments, docs and screen text use everyday words that say what the thing is or does (`showCodeOnTv`, `isHomeNetwork`). Skip jargon and fashionable tech words.
- **Small files with one job each.** Shared logic lives in one place and is reused (`extension/lib/`, `server/logger.js`); look there before writing something new.
- **Write the least code that does the job.** Use what Node and the browser already provide before adding a package or a new layer.
- **One `package.json` and one `node_modules`, at the project root.**
- **No loose numbers or addresses in the code.** There are three homes for a value:
  - `.env` (template in `.env.example`, read by `server/config.js`): what a person may change per computer, such as the port, log level, log file, code life, wrong-code limit.
  - `server/constants.js` and `extension/lib/constants.js`: fixed numbers and lists the code needs, such as size limits, time limits, list sizes.
  - Left in place on purpose: values that are part of a safety rule or a message format (home-network address ranges, the list of headers passed on, message names). Making these adjustable would let a wrong setting open a hole or break the TV page. The TV page keeps its few values at the top of `tv/tv.js`, because it is a single ES5 file that cannot import others.
- **The TV page targets old browsers.** `tv/` is ES5 only (the lint step enforces it), with large text and every action reachable from the remote's arrows, OK and Back.
- **Messages carry a version.** Every server-to-TV and TV-to-server message has `v`; a change to a message or API call updates [SPEC.md](../SPEC.md) in the same change.
- **Log through the logger.** Server code uses `logger('area')` from `server/logger.js`; extension code uses `extension/lib/log.js`. Write log messages as short sentences. Run with `--debug` to see every step.
- **Errors shown to people are short, plain, and name a next step.** All popup text lives in `extension/lib/text.js`.
- **Tests match the spec.** Each acceptance criterion in SPEC.md maps to a test, or to a named manual check on the real TV.

## Commits

- One commit per feature or fix, small enough to read in one go.
- First line: `<type>: <what changed>`, 72 characters at most, no full stop at the end. Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`. Example: `fix: use a new connection for each request to the TV`.
- Say what changed in plain words; the reason goes in the body when it is not obvious.
- Two hooks check this on every commit (set up by `npm install`): `.husky/pre-commit` runs ESLint on the files being committed, `.husky/commit-msg` checks the first line. Run `npm run check` yourself before a commit for the type check and tests.

## Self-check before calling work done

- Extension: no sockets, no server, survives service-worker suspension?
- No cloud, no account, no TV install?
- DRM detected and refused with the message, never attempted?
- Proxy refuses unregistered URLs? Logs free of URLs, cookies and headers?
- Consistent with [ARCHITECTURE.md](ARCHITECTURE.md) and earlier stories?
- Assumptions marked `(assumed)`?
