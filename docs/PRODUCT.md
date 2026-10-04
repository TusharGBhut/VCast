# Product

These are fixed facts. Design around them; they are settled and need no confirmation from the user.

## What it is

"VCast" (working name): a cross-browser extension that detects a video playing on any web page and sends it to the TV, similar to the Web Video Caster app.

## Targets

| | v1 | Later (design for extensibility, build nothing now) |
|---|---|---|
| Browsers | Chrome, Brave, Edge, Opera | Firefox |
| TV | A third-party-assembled TV running Samsung Tizen OS | LG webOS, Android/Google TV, Chromecast, Fire TV, Roku, generic DLNA, a native Tizen app |
| Server OS | Windows | macOS, Linux |

Developer Mode cannot be enabled on the v1 TV, so nothing can be installed on it.

## Environment

- The sender PC and the TV are always on the same home Wi-Fi/LAN.
- Everything stays local: no cloud servers, no internet relay, no user accounts, no login.

## Pairing

No authentication or authorization. The TV shows a short code, the user types it into the extension, and matching codes link the two ends. Casting then works.

## Users

The owner and their household: a single home, with non-technical viewers on the TV side. TV-side UI must be usable with a remote and no instructions.

## MVP slice

The thinnest end-to-end path:

1. Detect a non-DRM MP4 or HLS video on a page.
2. Pair with the TV via the code.
3. The video plays on the TV through the server's proxy.
4. Play, pause, seek, stop and volume work from the extension popup.
5. A DRM page produces a clear "not supported" message.

Everything else is v1.1 or Future. Screen mirroring (the only route for DRM content) is Future.

## What customers should know

- Protected (DRM) sites such as Netflix, Prime Video and Hotstar cannot be sent.
- Sites that build the video inside the page from signed pieces (YouTube and similar) cannot be sent.
- The computer must stay on while the TV plays. VCast keeps it from falling asleep on its own, and the screen may switch off or lock. A laptop lid must stay open: closing it puts the laptop to sleep and the video stops.
- The customer's wish list, with priorities, is in [SPEC.md](../SPEC.md) under "Customer requirements for the next round".

## Releases

`MVP`, `v1.1`, `Future`. Every backlog item carries exactly one.
