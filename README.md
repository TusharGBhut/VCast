# VCast

Send the video you are watching in the browser to the TV on your home network. Nothing is installed on the TV: it opens a page in its own browser.

<a href="media/vcast-demo.mp4"><img src="media/vcast-demo.jpg" alt="Demo video: the TV shows a pairing code, the code is typed into the extension popup, and the video plays on the TV" width="270"></a>

The video above is 20 seconds long: the TV shows a pairing code, you type it into the extension, and the video starts on the TV. Select the picture to play it. The pairing code, site and film in it are made up.

## Run it

```
npm install
npm start
```

The console prints the address to open on the TV, for example `http://192.168.1.16:8787`.

1. In Chrome, Brave or Edge: open `chrome://extensions`, turn on Developer mode, press "Load unpacked" and pick the `extension/` folder.
2. Turn the TV on. Open the VCast popup and press "Open on <your TV>". The first time, the TV asks whether to allow VCast: choose Allow with the remote. The TV's browser opens on the VCast page, already paired.
3. Play a video on any page, open the popup, and press Cast.

If the TV is not listed, type its address once in the popup (TV Settings > Network > Network Status). There is also a second way that needs no permission: open the printed address in the TV's Internet app and type the 6-digit code it shows into the popup.

On first run Windows asks whether to allow VCast on the network: allow it for private networks.

## Settings

Copy `.env.example` to `.env` and change what you need: port, log level, log file, how long a code lasts, how many wrong codes are allowed. If you change the port, the popup asks for the new address when it cannot reach VCast.

## When something goes wrong

- `npm run start:debug` prints every step. The same lines go to `~/.vcast/vcast.log`.
- Extension logs: `chrome://extensions` > VCast > "service worker", or right-click the popup > Inspect.
- Logs show site names only, never full links, cookies or page titles.

## Checks

| Command | What it does |
|---|---|
| `npm run check` | lint, type check, and tests with 90% coverage |
| `npm run test:e2e` | browser tests with Playwright |

Commits are checked by two hooks: ESLint on the files being committed, and the form of the commit message (`feat: ...`, `fix: ...`; see [docs/RULES.md](docs/RULES.md)).

## More

- [SPEC.md](SPEC.md): what this build does and how each part is tested.
- [docs/](docs/): product facts, rules, architecture, process, progress, findings.
