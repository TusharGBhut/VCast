# Progress

Read at session start. Update before ending a session.

## Current state

The first working build exists: server, TV page and extension, with unit tests, lint and type checks passing (`npm run check`). It has not yet been tried on the real TV.

## Next up

1. Try it on the real TV (steps in [README.md](../README.md)) and record what happens in [FINDINGS.md](FINDINGS.md).
2. Build the Must items from "Customer requirements for the next round" in [SPEC.md](../SPEC.md): resolution and quality list (C1, C2), DASH with separate sound and picture (C3), main video first (C5), start at the browser position (C8), live label (C9), keep pairing across restarts (C16).

## Milestones

- [x] Phase 1: architecture decision, spikes, epics, backlog, journeys, assumptions (`docs/jira/phase-1.txt`)
- [x] MVP code: detect -> pair -> play through proxy -> control from popup -> DRM message
- [x] Code review round 1: findings fixed
- [x] Browser test round 1 (Playwright): 99 tests in `tests/e2e/`, findings fixed
- [x] Subtitles from `.vtt` files, and "Open on TV" (no typing on the TV)
- [x] Real TV: "Open on TV" opens the page and pairs with no typing; a 1080p HLS episode plays (F-006, F-008)
- [x] On-screen -10s / Play-Pause / +10s buttons on the TV, and subtitle timing (Earlier / Later / Reset) in the popup
- [ ] Real TV: confirm full screen hides the browser's address bar, subtitles are readable, and the new on-screen buttons work with the pointer
- [ ] Spike: Tizen browser on the real TV (codecs, HLS, remote keys, screen saver)
- [ ] Spike: DLNA renderer on the real TV
- [ ] Phase 2: full Jira stories (none written yet; say "all MVP" to generate them)
- [ ] v1.1: customer Must items

## Backlog status

IDs are from `docs/jira/phase-1.txt`. Status: `todo`, `in progress`, `needs TV check`, `done`.

| ID | Title | Release | Status | Verified by |
|---|---|---|---|---|
| CAST-001 | Verify Tizen browser playback | MVP | todo | needs the real TV |
| CAST-002 | Decide extension-to-server transport | MVP | done (assumed: local HTTP) | works in tests |
| CAST-003 | Serve local API and TV page | MVP | done | tests/server/app.test.js |
| CAST-004 | Restrict access to home network and extension | MVP | done | tests/server/app.test.js |
| CAST-005 | Issue and match pairing codes | MVP | done | tests/server |
| CAST-006 | Show pairing code on TV | MVP | needs TV check | browser tests |
| CAST-007 | Pair extension with TV by code | MVP | needs TV check | browser tests |
| CAST-008 | Relay video with original headers | MVP | done | tests/server/app.test.js |
| CAST-009 | Rewrite HLS playlists | MVP | done | tests/server/app.test.js |
| CAST-010 | Refuse unregistered and unsigned links | MVP | done | tests/server/app.test.js |
| CAST-011 | Detect MP4 and HLS requests per tab | MVP | done | tests/extension |
| CAST-012 | Detect video tags in pages and iframes | MVP | done | browser tests |
| CAST-013 | Detect DRM and show message | MVP | done | tests/extension, browser tests |
| CAST-014 | Play MP4 and HLS from the proxy | MVP | needs TV check | browser tests (WebM only; no H.264 in the test browser) |
| CAST-015 | Cast the selected video | MVP | needs TV check | browser tests |
| CAST-016 | Control play, pause, seek, stop, volume | MVP | needs TV check | tests/server, browser tests |
| CAST-017 | Control with the TV remote | MVP | needs TV check | browser tests (keyboard keys) |
| CAST-018 | Restore session after drop or reload | MVP | done | tests/server/app.test.js |
| CAST-019 | Log with safe fields only | MVP | done | tests/server |
| CAST-020 to CAST-045 | DLNA, quality list, DASH, installer and the customer items | v1.1 / Future | todo | — |

## Blocked or waiting on the user

- On the real TV: do the arrows and OK reach the page (the debug log shows `TV remote key`), or does the browser only move its pointer (`TV pointer moved`)? Is the pointer hidden while watching?
- On the real TV: does pressing OK hide the browser's address bar? Are subtitles a readable size? Do the on-screen buttons work with the pointer? Does the `1 2 3 4 5` Developer Mode box appear in the Apps screen?

## Session log

Newest first. One or two lines per session: what changed, what was verified, what is left.

- 2026-10-04: The computer is now kept awake while the TV plays (F-010); an open TV page reloads itself after an update (F-009). 64 unit tests and 104 browser tests pass. Not yet tried on the real TV: on-screen buttons, subtitle timing, full screen.
- 2026-10-04: Fixed "Open on TV" failing at random: the TV hangs up after every answer, so each request now uses a new connection (F-008); the browser start is checked and retried. Confirmed working on the real TV by the owner. Added full screen on first key, on-screen player buttons, subtitle timing. Git repo started with ESLint and commit-message hooks. 61 unit tests and 103 browser tests pass.
- 2026-10-03: Browser-test round found 4 bugs (error text replaced by "Paused", lost-connection text hidden once paired, no Play after a video ends, cookie missed when the page script saw the video first); all fixed. Added subtitles, Open on TV, `.env` settings and constants files. 58 unit tests (99% lines, 96% branches, 97% functions) and 99 browser tests pass. A real streaming page played at 1080p with subtitles through the server in desktop Chrome (F-003).
- 2026-10-03: Built the MVP. Renamed to VCast with one root package. Added SPEC.md, readable logger, 47 unit tests (99% lines, 97% branches, 97% functions). Code review found 31 items; valid ones fixed with tests. Wrote 22 customer requirements and the cases-to-handle table into SPEC.md. TV facts recorded as F-001.
- 2026-10-03: Created AGENTS.md and docs/ from the planning prompt.
