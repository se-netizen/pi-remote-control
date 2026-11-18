# Pi Remote Control

Open and control the [Pi](https://github.com/earendil-works/pi) sessions running on your computer from your phone or any other browser. It stays one conversation: what you type on the phone shows up in the terminal, and the other way round. Pi keeps running on your computer with your own model credentials.

- **Easy sign-in**: devices on your Tailscale account sign in automatically; any other device scans a QR from the terminal, once per phone.
- **Real time**: text appears while Pi writes, tools show as rows like `Bash(npm test)` that you can expand, edits show as diffs, one input box for instructions and steering, and a stop button.
- **Files and photos**: attach screenshots, photos, logs or documents from your phone (up to 10 files, 25 MB each). Images go straight to the model; other files reach Pi as paths on your computer.
- **Slash commands from the phone**: `/model`, `/thinking`, `/compact`, `/new`, `/session`, plus Pi extension commands, prompt templates and skills.
- **Background sessions**: `/remote-control detach` keeps Pi working after you close the terminal; `/remote-control attach` brings it back.
- **Private on the way**: over Tailscale (WireGuard) or over Wi-Fi with per-device XChaCha20-Poly1305 encryption, without HTTPS and without third-party servers.

Tested on Linux with Node 22.23 and Pi 1.5.2. Windows is not supported for the daemon yet.

## Quick start

```sh
npm ci && npm run build
npm run pi:install                              # register the extension with Pi
npm start -- start --host 0.0.0.0 --allow-http  # run the daemon
```

Then in Pi (run `/reload` if Pi is already open):

```text
/remote-control
```

Scan the QR with your phone camera, or open `http://YOUR-COMPUTER-TAILSCALE-IP:3141` on a phone signed in to the same Tailscale account. That's it.

## Documentation

| | |
| --- | --- |
| [Guide](docs/GUIDE.md) | Install, daemon as a service, connecting a phone, using the web app, slash commands, background sessions, auto mode, security |
| [Reference](docs/REFERENCE.md) | Every command, option, environment variable, file, limit, API and error code |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Common problems and fixes |
| [All documents](docs/README.md) | Including implementation notes and early design |

## Commands

```text
/remote-control                 # turn on remote for this session (QR if no phone is paired yet)
/remote-control pair [wifi]     # QR for a new device (wifi: encrypted LAN address)
/remote-control detach          # keep this session running in the background, close Pi in the terminal
/remote-control attach [show]   # bring a background session back (or just look at it)
/remote-control auto [on|off]   # every new Pi shows up on your phone automatically
/remote-control status | devices | revoke ID | stop
```

```sh
npm start -- status | pair | revoke ID | sessions | new [FOLDER] | stop pi-rc-xxxxxx
```

## Development

```sh
npm run check     # typecheck + all tests
npm run build     # dist/ for the daemon and web app
PI_REMOTE_REAL_SMOKE=1 npx tsx --test tests/pi-adapter.test.ts   # smoke test against the installed Pi
```

Layout: `extensions/remote-control.ts` (Pi entry) → `src/pi/attach-bridge.ts` (extension), `src/server.ts` and `src/core.ts` (daemon), `src/seal.ts` (Wi-Fi encryption), `src/tailscale.ts` (Tailscale sign-in), `src/background.ts` (background sessions), `src/uploads.ts` (files from the phone), `web/` (web app, no build step).

Daemon data lives in `~/.pi/remote-control/` (0700/0600) and must never be committed. The package name is a working name; it is not published.
