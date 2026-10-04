# Findings

What has been observed on the real TV, browsers and network: spike results and gotchas. Only observed behaviour goes here; guesses stay in stories as "(assumed)".

A finding that changes a decision also updates [ARCHITECTURE.md](ARCHITECTURE.md).

## Entry format

```
### F-NNN: one-line statement of what is true
- Date: YYYY-MM-DD
- Source: spike CAST-NNN / story CAST-NNN / manual test
- Setup: TV model and firmware, browser and version, server build, network condition
- Observed: what happened, with the exact error or value
- Consequence: the decision or rule this drives, and where it was recorded
```

## Pending spikes

Each needs the real TV or a real browser. Record the answers below as findings.

| Spike | Questions to answer |
|---|---|
| Tizen browser | Chromium version and user agent of the Internet app; H.264/HEVC/AAC support in `<video>`; native HLS versus hls.js via MSE; does plain `http://<PC-IP>:<port>` load; WebSocket support; does the screen stay awake; which remote keys reach the page |
| DLNA renderer | Does the TV appear in SSDP; does its renderer accept an HLS URL or only MP4; required DIDL-Lite metadata and MIME types; are Seek and volume honoured; how it behaves with range requests through the proxy |
| Extension-to-server transport | Native Messaging versus localhost WebSocket: install friction on Windows, behaviour across service-worker suspension, reconnection, cross-browser support (Chrome, Brave, Edge, Opera) |

## Findings

### F-001: The TV is a 2023 licensed Tizen 4K set and answers on the network
- Date: 2026-10-03
- Source: manual check, `http://<TV-IP>:8001/api/v2/` (the TV's own info page)
- Setup: TV at 192.168.1.6 on Wi-Fi (the address can change; the router decides it)
- Observed: `OS: Tizen`, `model: 23_K2LC_SQY_UHD_LIC`, `modelName: ST24043454`, `resolution: 3840x2160`, `developerMode: 0`, `DMP_available: true`, `TokenAuthSupport: true`, `remote_available: true`. Ports 9197 and 7676 (usual Samsung DLNA ports) did not answer.
- Consequence: a 2023 platform should have a recent enough browser for hls.js; still to confirm on the TV itself. DLNA (R2) needs a proper search of the network before it is counted on. 4K is possible, so the quality list (C2) should offer it.

### F-009: A TV page left open keeps running its old code; and the TV needs about 8 seconds to start its browser
- Date: 2026-10-04
- Source: the owner's report ("the play/pause buttons are not showing on the TV") and `~/.vcast/vcast.log`
- Observed:
  - The page was opened on the TV at 15:21. VCast was updated and restarted at 15:42. The page reconnected on its own (`TV connected paired=false`), showed a code, and was paired by code. It was never loaded again, so it still ran the page from before the update, without the new buttons.
  - At 15:21 the request that starts the TV's browser took about 8 seconds to be answered, right at the 8-second limit VCast had for it.
- Consequence: the server now tells every connecting TV page the version of the page files (`page.version`); a page that sees a different version than the one it was loaded with reloads itself. The limit for the browser-start request is now 25 seconds.

### F-008: The TV hangs up after every answer, so each request needs its own connection
- Date: 2026-10-04
- Source: the owner's debug log, then reproduced with a pretend TV in `tests/server/tv-remote.test.js`
- Observed: `Asked the TV about its Browser app status=200`, then 2 ms later `TV would not start its Browser app status=0`. Status 0 after 2 ms is not the TV answering: Node reused the connection from the first request, which the TV had already closed, and the second request failed at once. Whether it failed depended on timing, which is why "Open on TV" worked sometimes and not others.
- Reproduced: with the pretend TV closing the connection after each answer, the test failed before the fix and passes after it.
- Consequence: every request to the TV's app service and info page uses a new connection (`agent: false`), and a failed request logs its reason. F-007's guess (the permission connection closing) may have been a second cause or none at all; this one is confirmed by test, though not yet on the TV.

### F-007: "Open on TV" failed with the TV on: the permission connection was in the way
- Date: 2026-10-04
- Source: the owner's log (`open-on-tv` failed after 4.6 s with `tv_unreachable`; the TV had asked to allow VCast again and Allow was pressed)
- Observed: VCast opened the remote-control connection first, then started the browser while holding that connection open. Any close of that connection during the several seconds the browser takes to start was reported as "can't reach the TV", even though the TV was reachable (the TV search had just found it). The log did not say which step failed.
- Not confirmed on the TV: that the TV closing the connection was the cause, and why the TV asked for permission again although a token was saved.
- Consequence: the browser is now started through the TV's app service first, with no permission connection at all (the 2026-10-03 tests started it that way with plain requests). The permission connection is only made if the TV refuses, and its closing afterwards no longer counts as a failure. Every step is logged at debug level with the TV's answer.

### F-006: The real TV plays a 1080p HLS stream from VCast in its own browser
- Date: 2026-10-03
- Source: the owner's test on the TV (photo)
- Setup: TV 192.168.1.6, computer 192.168.1.16, "Open on TV" from the popup in Brave, an anime episode page (HLS with separate subtitle files)
- Observed: the TV's Browser opened on the VCast page and paired with no typing. The episode played (1:40 / 24:06 shown, title and progress bar visible, pause from the popup worked). The browser's address bar stayed on screen above the video, and the page was shown at 125% zoom with a mouse pointer.
- Consequence: R1 (the TV browser as receiver) works on this TV, so hls.js and H.264 are fine there. The address bar is what the owner dislikes; the TV page now asks for full screen on the first remote key or click. An installed app would need Developer Mode, which is off on this TV.
- Recovered videos need the Referer a browser would send (the frame's site only); the full frame address got 403 from this site.

### F-005: This TV's browser is a store app, started through the app service, not the remote-control connection
- Date: 2026-10-03
- Source: manual requests to the real TV (192.168.1.6), watched by the owner
- Observed:
  - After Allow, the remote-control connection (port 8002) is accepted, but `ed.apps.launch` for `org.tizen.browser` does nothing and gets no reply. `ed.installedApp.get` gets no reply either.
  - `GET http://<TV>:8001/api/v2/applications/org.tizen.browser` gives 404. The browser here is the store app `3202010022079`, named "Browser".
  - `POST http://<TV>:8001/api/v2/applications/3202010022079` starts it. With no body, or with only one of `id`, `url`, `data`, `metaTag`, it opens on its home page. With `{ id, url, data }` all set to the page address, it opened the VCast page twice (the TV page connected to the server 6 seconds later). Why all three are needed is not understood.
  - The browser was closed (`DELETE`) before each start; whether an already open browser would take a new address was not tried.
- Consequence: `server/tv-remote.js` first asks whether the TV has app `3202010022079`. If so it closes it when running and starts it with the three fields; otherwise it uses the classic `org.tizen.browser` way for Samsung's own TVs. Still to confirm through the real popup button.

### F-004: The TV is found by a network search and offers Samsung's remote-control service
- Date: 2026-10-03
- Source: manual run of `server/tv-remote.js` against the real TV
- Setup: TV at 192.168.1.6, computer at 192.168.1.16, same Wi-Fi
- Observed: the SSDP search got one answer, and its info page said Tizen ("Samsung Smart TV", model ST24043454). The secure connection to port 8002 was accepted. No reply came within 30 seconds, which is what happens while the TV shows "Allow VCast?" and nobody answers.
- Consequence: the TV can be listed in the popup without typing its address. Still to confirm with someone at the TV: after Allow, does the browser open on the VCast page? (App id used: `org.tizen.browser`.)

### F-003: A real streaming page works end to end, in a desktop browser standing in for the TV
- Date: 2026-10-03
- Source: manual run with Playwright (extension in Chromium, TV page in Chrome)
- Setup: an anime episode page whose player sits in an iframe on another site; HLS stream on a third site; eight `.vtt` subtitle files on a fourth
- Observed: the extension found the stream inside the iframe with its Referer and Origin, and all eight subtitles. Through the server the TV page played 1920x1080, a seek to 2:00 worked, the site answered 200 to every request, and the English subtitle loaded (290 lines). The stream player switched a second subtitle on by itself until the TV page was changed to put the chosen one back.
- Consequence: the proxy approach holds for this kind of site. Subtitles as separate `.vtt` files are a common case and are now handled. The stream shows twice in the list (main playlist and one quality), which C1 will tidy. Not yet proven: the same on the real TV's browser.

### F-002: A TV page request that is dropped by the site must be dropped for the TV too
- Date: 2026-10-03
- Source: code review, confirmed by test
- Observed: when a site sent headers and then cut the connection, the TV's request stayed open for ever.
- Consequence: `server/proxy.js` closes the TV's request when the site's answer ends early.
