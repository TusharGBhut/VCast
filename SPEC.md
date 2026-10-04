# VCast MVP spec

What this build must do, where the code lives, and how each part is checked. Rules it must obey are in [docs/RULES.md](docs/RULES.md); the reasons for the design are in [docs/jira/phase-1.txt](docs/jira/phase-1.txt).

## Requirements

| ID | Requirement |
|---|---|
| R1 | The extension finds MP4 and HLS videos on a page (network requests and `<video>` tags, including inside iframes) and keeps a list per tab. |
| R2 | The extension notices DRM and says the video can't be sent. |
| R3 | The TV page shows a 6-digit code. Typing it in the popup pairs the two. |
| R4 | Pressing Cast plays the video on the TV. All video data goes through the VCast server, which adds the page's Referer, Origin, Cookie and User-Agent. |
| R5 | The popup can play, pause, seek, stop and change volume, and shows position and duration. |
| R6 | The TV remote can play/pause and seek. |
| R7 | The TV reconnects on its own after a network drop and keeps its pairing; after a page reload the video resumes where it was. |
| R8 | The server only answers the home network, only lets the extension use its API, and only fetches video links it was given. |
| R9 | Logs are easy to read, go to the screen and a file, have a debug level, and never contain full links, cookies or headers. |
| R10 | Every error the user can hit shows a short message with a next step. |
| R12 | Nobody types on the TV. The popup lists the Tizen TVs it finds on the network; one click opens the VCast page in the TV's browser, already paired. The TV asks its owner to allow VCast the first time only. The code on the TV stays as a second way in. |
| R13 | The TV page fills the whole screen: the first remote key or click asks the TV browser for full screen, which hides its address bar. A hint says so until then. If the browser refuses, the key press is lost once and keys work normally after. |
| R14 | The TV player shows three on-screen buttons, -10s, Play/Pause and +10s, for remotes with a pointer. They appear with the title bar when the pointer moves, a key is pressed, or the video is paused, and hide again after 4 seconds of playing. |
| R15 | Subtitle timing can be adjusted from the popup while a video plays: Earlier and Later move every subtitle line by 0.25 seconds per press, the popup shows the total ("Shown 0.75 s earlier"), and Reset goes back to the file's own timing. The adjustment survives a TV page reload and starts at zero for each new cast. |
| R16 | A TV page that is already open picks up a newer version by itself. When it reconnects and the server's page files have changed since the page was loaded, it reloads. Nobody has to refresh the TV's browser after VCast is updated. |
| R17 | While a video is loading, playing or buffering on a connected TV, VCast keeps the computer from going to sleep (the screen may still switch off and lock). When the video is paused, stopped or finished, or the TV is gone, the computer may sleep again. Closing a laptop lid still puts it to sleep; the popup says to keep the lid open. |
| R18 | The popup lists only the video that is on the page now. The list is emptied when the tab goes to another page, including sites that change the address without loading a new page (next episode), and a frame that loads something new loses the entries it had. Looking at the page again never brings back links from before that moment. |
| R19 | The title sent to the TV names the video that is playing. Some sites play the next episode without updating the tab's title; when the address ends in an episode number that the title does not mention, the title is made from the address ("Dr Stone · Episode 18"). The tab's title and address are read at the moment Cast is pressed. |
| R20 | The TV player is worked with the remote's arrows and OK, like an app, with a clear highlight on what is selected. There are two rows. On the progress bar (selected at first): Left and Right move 10 seconds, OK plays or pauses. Down goes to the buttons (-10s, Play/Pause, +10s, Stop): Left and Right move the highlight, OK presses the highlighted button. Up goes back to the bar. The pointer is hidden while the controls are hidden. The server logs which remote keys and pointer moves reach the page (debug level), to learn what a TV's browser passes on. |
| R11 | Subtitle files (`.vtt`) the page loads are found, listed in the popup, sent through the server, and shown on the TV. English is picked by default; the last choice is remembered; it can be changed or turned off while playing. |

## Folders and files

```
server/           the app that runs on the PC
  index.js          starts it from the command line
  app.js            web server: API for the extension, TV page, TV connection
  pairing.js        TV list, codes, sessions
  proxy.js          fetches video from the site and passes it to the TV
  network.js        home-network address checks
  logger.js         logging
  tv-remote.js      finds Tizen TVs and opens a page in the TV's browser
  keep-awake.js     keeps the computer from sleeping while a video plays
  config.js         settings a person may change, read from .env
  constants.js      fixed numbers and lists
tv/               the page the TV opens (ES5 only)
  index.html, tv.js, tv.css
extension/        the browser extension (Manifest V3)
  manifest.json
  background.js     watches network requests, keeps the video list per tab
  page-watcher.js   runs in pages: finds <video> tags and DRM
  popup.html/js/css
  lib/video-list.js   pure logic: what counts as a video, list handling
  lib/text.js         pure logic: messages, labels, time format
  lib/server-api.js   calls to the VCast server
  lib/constants.js    fixed values (default server address, list sizes)
tests/
  server/, extension/   unit and integration tests (node:test)
  e2e/                  browser tests (Playwright)
```

## Expected behaviour

### Server API (extension only, `http://127.0.0.1:8787`)

All bodies are JSON. The session goes in the `X-VCast-Session` header. Errors are `{ "error": "<code>" }`.

| Call | Body | Success | Errors |
|---|---|---|---|
| `GET /api/state` | — | `{ v, version, tvAddresses, paired, tv, cast, playback }` | — |
| `POST /api/pair` | `{ code }` | `{ session }` | 403 `bad_code`, 429 `too_many_tries` |
| `GET /api/tvs` | — | `{ tvs: [{ ip, name, model }] }` (Tizen TVs that answered a network search) | — |
| `POST /api/open-on-tv` | `{ ip }` | `{ session }`; `/api/state` then shows `waitingForTv: true` until the TV's page connects | 400 `bad_tv_address` (not a home-network address), 502 `tv_unreachable`, `tv_refused`, `tv_no_answer` |
| `POST /api/cast` | `{ url, kind, title, headers: { referer, origin, cookie, userAgent }, subtitles: [{ url, label }], subtitle }` (`subtitle` is the place in the list to show, -1 for none) | `{}` | 400 `bad_request`, 401 `not_paired`, 409 `tv_offline` |
| `POST /api/control` | `{ action: play\|pause\|stop\|seek\|volume\|subtitle\|subtitleShift, value }` (`subtitleShift` is seconds, from -300 to 300; a minus value shows subtitles earlier) | `{}` | 400, 401, 409 |
| `POST /api/unpair` | `{}` | `{}` | 401 |

A request is refused with 403 `forbidden` when it does not come from this computer, when its Host is not `127.0.0.1`/`localhost`, or when it has an Origin that is not a browser extension.

### TV connection (`ws://<PC-IP>:8787/tv?id=<tvId>`)

Every message has `v: 1` and a `type`.

| Type | From | Fields |
|---|---|---|
| `tv.hello` | TV | `hasVideo` |
| `page.version` | Server | `version` (changes when a file of the TV page changes; sent in answer to every `tv.hello`) |
| `pair.code` | Server | `code`, `expiresInSec` |
| `pair.ok` | Server | — |
| `media.load` | Server | `url` (path on the server), `kind` (`hls`\|`file`), `title`, `startAt`, `subtitles` (`[{ url, label }]`, paths on the server), `subtitle`, `subtitleShift` (seconds) |
| `media.control` | Server | `action`, `value` |
| `media.state` | TV | `status`, `position`, `duration`, `volume`, `error` |
| `session.end` | Server | — |
| `tv.input` | TV | `key` (key code of a remote key that reached the page) or `pointer: true` (the pointer moved); only written to the debug log |
| `media.stopped` | TV | — (Stop or Back pressed on the remote; the server ends the cast) |
| `pair.restart` | TV | — (OK pressed on the "Connected" screen; the server unpairs and shows a new code) |

The server accepts a TV connection only from the home network and only from its own TV page (no Origin, or an Origin equal to the server's own address). At most 8 TVs are remembered; a TV that is connected is never dropped to make room.

### Video links (`/media/<linkId>/<signature>/<encoded link>`)

- The server fetches the real link with the saved headers and passes the answer on, including Range requests.
- HLS playlists are rewritten so every link inside them points back at the server with its own signature.
- Unknown `linkId` gives 404. A wrong signature gives 403. Cookies go only to the site the video was found on (same address and same http/https).
- A video found on the internet can never make the server fetch from this computer or the home network, whether through a redirect or a link inside a playlist. Such a request gives 502.
- Site problems give 502: site down, more than 5 redirects, a broken redirect, a compressed answer we did not ask for. If the site drops half way, the TV's request is dropped too so the player retries.
- The 15 second limit is for the site to start answering. A TV that pauses is not cut off.

### Opening the page on the TV

- The server finds TVs by asking the network (SSDP search), then reads each answer's info page on port 8001 and keeps the ones that say `OS: Tizen`.
- It starts the TV's browser on `http://<PC address>:<port>/key-<one-time key>`, checks that the browser is really running, and asks once more if it is not. If the TV refuses, it connects to the TV's remote-control service (secure WebSocket on port 8002), which makes the TV ask its owner for permission, and then tries again. Licensed Tizen TVs have a "Browser" store app (`3202010022079`) that is started through the TV's app service on port 8001; an open browser is closed first so it takes the new page. Samsung's own TVs are asked over the remote-control connection to start `org.tizen.browser`.
- The first time, the TV shows "Allow VCast?". The token the TV gives back is saved in `~/.vcast/tvs.json`, so it does not ask again.
- The key in the link is random, works once, and runs out after 2 minutes. The TV page that connects with it is paired to the session the popup was given.
- Only home-network addresses are accepted as a TV address.

### Pairing rules

- Code: 6 digits, valid 5 minutes, usable once. A new one appears on the TV when the old one runs out.
- 5 wrong codes in a minute blocks pairing for the rest of that minute.
- A paired TV shows no code, so a second sender cannot join. Unpairing shows a new code.

### Logging

- Line format: `time LEVEL area  message  key=value ...`
- Levels: debug, info, warn, error. `--debug` or `VCAST_LOG_LEVEL=debug` turns on debug.
- File: `~/.vcast/vcast.log`, one older file kept once it passes 2 MB.
- Any value that looks like a link is cut down to its site name before it is written.

### Extension permissions

| Permission | Why it is needed |
|---|---|
| `webRequest` | See video requests and the headers the site checks (Referer, Origin, Cookie, User-Agent). Read only; nothing is blocked or changed. |
| `storage` | Keep the found videos per tab until the browser closes, and the pairing session. |
| `scripting` | When the popup opens, look at the current page again, so a video that started before the extension was installed or reloaded is still found. |
| Host access to all sites | Videos can be on any site, and the page script that spots `<video>` tags and DRM must run there. |

DRM is spotted from the browser's own signals: the `encrypted` event on a video, or a video that has media keys set. A page that only asks whether DRM is available is not marked.

## Acceptance criteria

| ID | Criterion | Checked by |
|---|---|---|
| AC-1 | Given a TV page is open, when the right code is posted to `/api/pair`, then a session is returned and the TV gets `pair.ok`. | tests/server/app.test.js |
| AC-2 | Given a wrong, used or expired code, pairing returns 403 `bad_code`; after 5 wrong tries it returns 429. | tests/server/small-parts.test.js, app.test.js |
| AC-3 | Given a TV is already paired, a second sender has no code to use and its calls return 401 `not_paired`. | tests/server/app.test.js |
| AC-4 | Given a site that needs a Referer, when the video is cast, then the TV gets the bytes through the server and the site sees the Referer, Origin, User-Agent and Cookie. | tests/server/app.test.js |
| AC-5 | Given an HLS playlist, every link in what the TV receives starts with `/media/` and loads through the server. | tests/server/app.test.js |
| AC-6 | A changed or made-up `/media/` link is refused (403 or 404) and the site is never contacted. | tests/server/app.test.js |
| AC-7 | A request with a web page Origin, a non-local Host, or from outside the home network is refused. | tests/server/app.test.js, small-parts.test.js |
| AC-8 | play, pause, seek, stop and volume reach the TV as `media.control`; state sent by the TV shows up in `/api/state`. | tests/server/app.test.js |
| AC-9 | After the TV page reloads, the server sends `media.load` again with `startAt` at the last known position. | tests/server/app.test.js |
| AC-10 | A request for `.m3u8` or `.mp4` in a tab adds one entry to that tab's list with its headers; segments and repeats do not add more. | tests/extension/lib.test.js, background.test.js |
| AC-11 | When a page sets up DRM, the popup shows "This video is protected (DRM) and can't be sent to the TV." and no Cast button. | tests/extension/background.test.js, e2e |
| AC-12 | With the server stopped, the popup shows "Can't reach VCast on this computer. Start it and try again." | tests/extension/lib.test.js, e2e |
| AC-13 | No log line contains a full link, a cookie or a header value. | tests/server/small-parts.test.js, app.test.js |
| AC-14 | The TV page shows the code, then "Connected", then the player; Enter toggles play, Left/Right seek 10 s. | e2e |
| AC-16 | Given a page that loads `.vtt` subtitle files, they are listed once each (seek-bar preview files are not), sent with the cast as `/media/` paths, and `subtitle` control switches or hides them. Only the chosen one shows on the TV. | tests/extension/lib.test.js, tests/server/app.test.js, real-site run (F-003) |
| AC-17 | Given a Tizen TV on the network, `GET /api/tvs` lists it; `POST /api/open-on-tv` sends the TV's browser to a link with a one-time key; the TV page that connects with that key is paired with no code; a wrong, used or late key is not. Refusal, no answer and unreachable TV each give their own error. | tests/server/tv-remote.test.js, app.test.js, small-parts.test.js; real TV: found, waiting for Allow (F-004) |
| AC-18 | Given a video playing on the TV page, clicking Play/Pause pauses and resumes it and its label says what it will do next; clicking +10s and -10s moves the position by 10 seconds; the buttons hide after 4 seconds of playing and come back when the pointer moves. | tests/e2e/tv.spec.js |
| AC-19 | Given a cast with a subtitle showing, `subtitleShift` of +2 moves every line 2 seconds later on the TV, -1.5 moves them 1.5 seconds earlier than the file, and 0 restores the file's times; `/api/state` reports the value; values beyond 300 seconds or not a number are refused with 400. In the popup, Earlier/Later/Reset send the right value and the text shows the total. | tests/server/app.test.js, tests/extension/lib.test.js, tests/e2e/tv.spec.js, tests/e2e/popup.spec.js |
| AC-20 | Given an open TV page, when the server restarts with changed page files and the page reconnects, the page reloads itself and then shows the new page. With unchanged files it does not reload (a playing video is not interrupted by a network drop). | tests/server/app.test.js, tests/e2e/tv.spec.js |
| AC-21 | Given a cast, keep-awake is switched on when the cast starts and while the TV reports loading, playing or buffering, and switched off when the TV reports paused, ended or error, when the cast is stopped or unpaired, when the TV disconnects, and when VCast stops. The system tool is started once, ends with VCast, and a missing tool is reported once without stopping anything. | tests/server/small-parts.test.js, tests/server/app.test.js; checked by hand on macOS with `pmset -g assertions` |
| AC-22 | Given a tab listing episode 1's stream, when the site moves to episode 2 by changing the address without a page load and loads the new stream, the list holds only episode 2's stream and subtitles. A change of only the part after `?` or `#` keeps the list. When the player's frame loads a new page, the entries found in that frame are removed and other frames' entries stay. Links the page loaded before the change are not added again when the popup looks at the page. | tests/extension/lib.test.js, tests/extension/background.test.js, tests/e2e/detection.spec.js; real-site run |
| AC-23 | Given a playing video, Left/Right on the bar move 10 seconds and OK toggles play; Down highlights Play/Pause in the button row; Right then OK presses +10s; Left twice then OK presses -10s; Right to the end then OK presses Stop and ends the cast; Up returns to the bar. The highlight returns to the bar when the controls hide. Keys that reach the page appear in the server's debug log. | tests/e2e/tv.spec.js, tests/server/app.test.js |
| AC-15 | Lines, branches and functions are each covered 90% or more for `server/` (except `index.js`), `extension/background.js` and `extension/lib/`. | `npm run coverage` |

## Test scenarios

| Area | Happy path | Bad input | Second sender / TV | Edge cases |
|---|---|---|---|---|
| Pairing | right code pairs | wrong, expired, reused code; too many tries | second sender gets 401; second TV gets its own code | code refresh on expiry; TV reconnect keeps pairing |
| Proxy | MP4 with Range; HLS master, variant, segments, key | dead site (502), site says 403 | link signed for another video refused | redirects, cookie only to first site, playlist without `.m3u8` name |
| Control | each action reaches the TV | unknown action, negative seek | — | TV offline (409), stop clears the cast |
| Detection | m3u8 and mp4 requests listed | non-video requests ignored | — | many segments, new page clears list, iframe video, blob video, DRM |
| Popup | pair, cast, control | wrong code message | — | server stopped, TV offline, expired link message |
| TV page | code, connected, playing | video that cannot play | — | reconnect, reload resume, remote keys |

## Cases to handle

"Tested" means an automated test covers it. "Next" points at the customer requirement that will cover it.

| Area | Case | What happens | Status |
|---|---|---|---|
| Finding | Same video requested again with a new token | One entry | Tested |
| Finding | Same film at 720p and 1080p as separate files | Two entries | Tested |
| Finding | Small numbered pieces of a stream fetched by the page | Not listed | Tested |
| Finding | Sound-only files | Not listed | Tested |
| Finding | More than 15 videos on a page | Oldest entry makes room | Tested |
| Finding | Video was already playing when the extension was installed or reloaded | Opening the popup looks at the page again and finds the stream and subtitles from the browser's own list of loaded links | Tested (unit); real page check |
| Finding | Video inside an iframe | Listed under the tab | Browser test |
| Finding | Video built in the page (blob link) with no stream seen | Notice asks to reload and play | Tested |
| Finding | Page changes video without a full page load (next episode) | The list is emptied when the address changes, and a player frame that reloads loses its old entries | Tested |
| Finding | Player frame is thrown away and a new one made, with no change of address | Old entries stay | Known limit |
| Finding | Subtitle files in several languages | Listed in the popup; English by default, last choice remembered | Tested |
| Finding | Seek-bar preview pictures stored as `.vtt` | Not listed as subtitles | Tested |
| Finding | Stream listed twice (the main playlist and one quality of it) | Both shown; the first is the main one | Next: C1 |
| Finding | Advert before the main video | Both listed | Next: C5 |
| Finding | Stream with several qualities | TV picks automatically | Next: C1, C2 |
| Finding | DASH stream | Listed, Cast disabled | Next: C3 |
| Pairing | TV asks "Allow VCast?" and nobody answers, or someone chooses Deny | Popup says what to do on the TV | Tested |
| Pairing | TV is off or on another network | Popup says it can't reach the TV | Tested |
| Pairing | TV not found by the search | Its address can be typed once in the popup (on the computer) and is remembered | Tested |
| Pairing | Wrong, used, or expired code; too many tries | Clear message | Tested |
| Pairing | Popup lost its session while the TV is paired | Press OK on the TV's Connected screen for a new code | Tested |
| Pairing | Second sender | Refused until the TV shows a new code | Tested |
| Pairing | VCast restarted | TV shows a new code; the dead video is cleared | Next: C16 keeps the pairing |
| Playing | Site needs Referer, Origin, Cookie, User-Agent | Sent by the server | Tested |
| Playing | Link expired | Message: reload and cast again | Tested; Next: C11 renews it |
| Playing | Site redirects, or answers slowly, or drops half way | Followed, waited for, or retried by the player | Tested |
| Playing | TV browser blocks autoplay | "Press OK on the remote to start" | Browser test |
| Playing | TV cannot play the format | Error on the TV and in the popup | Browser test; Next: C12 |
| Playing | Subtitles come before or after the speech | Earlier / Later in the popup, 0.25 s per press | Tested |
| Playing | Remote with a pointer and no handy play key | On-screen -10s, Play/Pause, +10s buttons | Tested |
| Playing | Stop or Back on the remote | Cast ends on both sides | Tested |
| Playing | New cast while one is playing | The new one replaces it | Tested |
| Network | Wi-Fi drops for a moment | TV reconnects, video keeps playing | Tested |
| Network | VCast was updated while the TV page stayed open | The page reloads itself when it reconnects | Tested |
| Network | TV page reloaded | Video resumes at the last position | Tested |
| Network | Computer left idle, screen switches off or locks | VCast holds off sleep while the TV plays, so the video keeps going | Tested |
| Network | Laptop lid closed | The laptop sleeps and the video stops; the popup says to keep the lid open | Known limit |
| Network | Computer's address changes | TV bookmark stops working | Next: C18 |
| Network | TV is off or its page is closed | Popup says the TV isn't connected; Cast disabled | Tested |
| Safety | Web page tries to call the API or pose as the TV | Refused | Tested |
| Safety | Device outside the home network | Connection dropped | Tested |
| Safety | Hostile playlist or redirect pointing at home devices | Refused | Tested |
| Safety | Broken or odd messages and requests | Ignored; the server keeps running | Tested |
| Real TV | The TV browser moves a pointer with the arrows and does not pass them to the page | On-screen buttons can be clicked with the pointer; the debug log shows which keys arrive | Manual check on the TV |
| Real TV | Screen saver while the code is shown; which remote keys reach the page; formats the TV plays | Unknown | Manual check on the TV |

## Not in this build

DLNA (R2 mode), DASH playback, quality picking, refreshing expired links, installer and auto-start, Firefox. They are in the backlog as v1.1 or later.

## Customer requirements for the next round

Written from the seat of the person using it at home. "Today" is what the current build does. Must items are built next; each gets acceptance criteria and tests in this file before code is written.

### Picking the right video

| ID | As a customer I expect | Today | Priority |
|---|---|---|---|
| C1 | Each found video shows its resolution (1080p, 720p), length, and whether it is live, so I can tell the film from an advert. | Only kind, site and file name | Must |
| C2 | A quality list for streams: Auto plus every resolution on offer. My choice is remembered ("best", or "up to 1080p" for a 1080p TV). | The TV picks by itself (auto); no list | Must |
| C3 | Video and sound that come as separate sources play together, in sync. | Works for HLS with separate audio tracks. DASH is not played at all. Two loose files (one video, one sound) cannot be joined. | Must (DASH), Won't (loose files) |
| C4 | Several files of the same video at different resolutions are all listed. | Bug: `film_720.mp4` and `film_1080.mp4` are treated as one, because numbers in the name are ignored | Must |
| C5 | The main video is marked as the best match; adverts and previews are pushed down. | First stream found is listed first | Must |
| C6 | I can choose the sound language and turn subtitles on or off. | Subtitles: done for `.vtt` files the page loads (R11). Not yet: subtitles carried inside the stream, `.srt`/`.ass` files, sound language. | Should (the rest) |
| C7 | The toolbar icon shows how many videos were found, and right-click on a video offers "Send to TV". | Not available | Should |

### Watching

| ID | As a customer I expect | Today | Priority |
|---|---|---|---|
| C8 | The TV starts from where I am in the browser, and the browser video pauses. | Starts from the beginning; the browser keeps playing | Must |
| C9 | Live streams say LIVE and hide the seek bar. | Shown with an empty seek bar | Must |
| C10 | A mute button, and the picked quality shown while playing. | Volume only | Should |
| C11 | When a link runs out mid-film, it is renewed without me doing anything. | Message asks me to reload and cast again | Should |
| C12 | If the TV cannot play this kind of video (HEVC, AV1), the message says so and suggests another quality. | General "could not play" message | Should |
| C13 | The computer does not go to sleep while it is sending a video. | Done (R17) for sleep from sitting idle, with the screen off or locked. Not possible: a closed laptop lid. | Done; lid close stays a limit |
| C14 | The popup remembers where I stopped, so I can carry on later. | Not available | Could |
| C15 | Next episode plays by itself; I can line up several videos. | Not available | Could |

### Setting up and living with it

| ID | As a customer I expect | Today | Priority |
|---|---|---|---|
| C16 | I pair once. Restarting the computer or VCast does not ask for the code again. | Pairing is lost when VCast restarts | Must |
| C17 | One installer; VCast starts with Windows and sits in the tray. No terminal. | Started with `npm start` | Must before sharing with the household |
| C18 | I never type on the TV. | Done for Tizen TVs (R12): one click in the popup opens the page on the TV and pairs it. The link always uses the computer's current address, so a changed address no longer matters. | Done; needs the real-TV check |
| C19 | With two TVs I can name them and pick one. | One TV per browser | Could |
| C20 | Another family member's computer can take over the TV after a confirm on the TV. | A second sender is refused | Could |
| C21 | Private (incognito) windows are left alone unless I allow them, and nothing I watched is stored. | Browser default applies; nothing is stored | Must (state it, test it) |
| C22 | A "copy details for a bug report" button that never includes links or cookies. | Logs only | Should |

### Things to be honest about

- Netflix, Prime Video, Hotstar and other protected (DRM) sites cannot be sent. The popup says so.
- YouTube and similar sites build the video in the page from signed pieces; VCast cannot send those.
- Volume changes the video's own volume on the TV page. The TV's main volume stays on the TV remote.
