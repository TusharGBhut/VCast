# Architecture

This file is the single source of truth for components, boundaries and message contracts. The constraints that force this shape live in [RULES.md](RULES.md).

## Components

```
 Browser (PC)                      PC                               TV (Tizen)
+---------------------+      +---------------------------+      +----------------------+
| Extension (MV3)     |      | Server (single binary)    |      | R1: Internet app     |
|  content script     | <--> |  local API (extension)    | <--> |     receiver page    |
|  service worker     |      |  pairing + control (WS)   |      |     <video> + hls.js |
|  popup              |      |  receiver page (HTTP/LAN) |      +----------------------+
+---------------------+      |  stream proxy             | <--> | R2: built-in DLNA    |
   localhost HTTP/WS         |  SSDP + DLNA controller   |      |     renderer (UPnP)  |
   or Native Messaging       +---------------------------+      +----------------------+
                                        |
                                        v
                              Origin media servers (internet)
```

| Component | Responsibility | Must not |
|---|---|---|
| Content script | Find `<video>` elements (including in iframes); detect DRM | Open sockets |
| Service worker | Observe `.m3u8` / `.mpd` / `.mp4` requests, collect candidate streams and the headers needed to replay them, talk to the server | Hold state only in memory |
| Popup | Show candidates, pairing code entry, playback controls, errors | Contain business logic |
| Server: local API | Accept commands from the extension | Listen beyond localhost |
| Server: pairing + control | Issue and match pairing codes, relay control messages | Accept a second pairing silently |
| Server: stream proxy | Fetch registered media with the original page's headers, rewrite HLS playlists so segments also flow through the proxy | Proxy an unregistered URL |
| Server: SSDP + DLNA | Discover renderers, send AVTransport actions | Run in the extension |
| Receiver page (R1) | Show the code, play media, obey control messages, keep the screen awake | Use post-ES5 syntax untranspiled |

## Data flow for a cast

1. The extension detects candidate streams on the page and captures the request headers each needs.
2. The user pairs: the TV shows a code, the user types it into the popup, the server matches them into a session.
3. The extension registers the chosen stream and its headers with the server for that session.
4. The server returns a proxy URL on the LAN address.
5. The receiver plays the proxy URL: R1 loads it in `<video>` / hls.js; R2 receives it via `SetAVTransportURI` then `Play`.
6. Control commands travel popup -> server -> receiver; state (position, duration, playing, volume, errors) travels back.

## Decisions

| Decision | Choice | Date | Why |
|---|---|---|---|
| First receiver mode | R1, the TV browser page | 2026-10-03 | Only mode where HLS is under our control (hls.js) and controls are one hop away. R2 (DLNA) comes later as a second receiver. |
| Extension-to-server transport | HTTP to `http://127.0.0.1:8787`, called from the popup | 2026-10-03 (assumed, spike CAST-002 not run) | Nothing to install or register, works in every Chromium browser, and no connection is held by the background script. |
| Server language | Node.js | 2026-10-03 | hls.js and `ws` are ready to use; a single-file build is backlog item CAST-026. |
| Port, code length, code life | 8787, 6 digits, 5 minutes | 2026-10-03 (assumed) | Short enough to type, long enough with the wrong-code limit. |

Still open: everything in [FINDINGS.md](FINDINGS.md) under "Pending spikes". They need the real TV.

## Message contracts

The API calls, TV messages and video link format are defined in one place: [SPEC.md](../SPEC.md), section "Expected behaviour".

## Folder layout

```
server/      the app on the PC: API, pairing, video proxy, TV page hosting, logger
tv/          the page the TV opens (ES5)
extension/   the browser extension; shared logic in extension/lib/
tests/       server/ and extension/ unit tests, e2e/ browser tests
docs/        these documents; docs/jira/ holds the Phase 1 plan and stories
SPEC.md      what the current build must do and how it is checked
```
