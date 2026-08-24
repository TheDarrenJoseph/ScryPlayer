# Scry Player

A media player meant as a local web app

Generated via [Claude Code](https://claude.com/product/claude-code)

This player supports two sources: 
1. Local files / folders
2. YouTube

3. Switch between them with the picker at the top.

## Stack

- **Frontend** — modern JS, no framework and **no bundler**. Plain ES modules
  loaded natively by the WebView, plain CSS. npm is only there to install the
  Tauri CLI.
- **Backend** — Tauri 2 (Rust). Directory walking and audio tag reading
  ([lofty](https://crates.io/crates/lofty)), plus native file dialogs.

## Requirements

- Rust (stable, ≥ 1.77.2)
- Node ≥ 18 — only to run the Tauri CLI
- On Debian/Ubuntu, the Tauri system libraries:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev
```

## Running

```bash
npm install
npm run dev
```

`npm run build` produces a bundled desktop binary in `src-tauri/target/release`.

There is no frontend dev server of our own — Tauri serves `src/` directly and
reloads the window when those files change.

## Layout

```
src/                  frontend, served as-is
  index.html
  main.js             wiring + session persistence
  tauri.js            the ONLY place that touches window.__TAURI__
  core/               emitter, queue, playback controller
  sources/            one adapter per media source
  ui/                 transport, panels, picker, water backdrop
  styles/             theme tokens + app styles
src-tauri/
  src/media.rs        filesystem walking + tag reading (no Tauri types; unit-tested)
  src/lib.rs          Tauri commands and setup
```

### How a source plugs in

`core/controller.js` owns every source and exposes one playback surface to the
transport bar. A source is an **adapter** implementing:

```
load(track, { autoplay, volume, muted }) → Promise
play() / pause() / seek(seconds) / setVolume(0..1) / setMuted(bool)
snapshot() → { position, duration, playing, loaded }
release()

events: 'time' | 'state' | 'ended' | 'error' | 'meta'
```

Adding a third source means writing an adapter and calling
`controller.register(id, adapter, queue)`. The transport bar needs no changes.

## How local audio reaches the player

Over a loopback HTTP server (`src-tauri/src/server.rs`), which is not the
obvious choice — it is the only one that works. Both alternatives were tried
and measured on WebKitGTK:

| route | result |
|---|---|
| `asset:` protocol | **will not load** — `MediaError` code 4 |
| `blob:` URL | plays, but **~18 dropouts per 20s** |
| loopback `http:` | **1 dropout per 20s** (a local player scored 2) |

Dropouts were counted by recording the sink monitor during playback and
running `silencedetect` over it. WebKitGTK's media pipeline refuses custom URI
schemes outright, and its blob source is too slow to feed the decoder. Note
that the failure is engine-level and hits every format — it looks like "MP3
doesn't work", but FLAC fails identically.

Serving over http also means the engine streams and seeks by itself, with no
file held in memory.

## Security notes

`MediaScope` (in `lib.rs`) starts **empty**. Paths enter only via a file dialog
or an explicit browse, and both the commands and the media server check against
it, so the page cannot reach arbitrary files. Both sides are canonicalised, so
symlinked libraries work.

The media server binds to `127.0.0.1` on an ephemeral port and additionally
requires a random per-session token, so another local process cannot read even
the allowed files without it.

File dialogs are opened from Rust rather than JS, so the frontend holds no
dialog permissions at all.

All user-supplied text (filenames, tags, YouTube titles) reaches the DOM via
`textContent`, never `innerHTML`.

## Keyboard

| Key | |
|---|---|
| `Space` | play / pause |
| `←` `→` | seek ∓5s |
| `Shift` `←` `→` | previous / next |
| `↑` `↓` | volume |
| `M` | mute |

## Known limits

- YouTube **playlist** URLs add only the linked video; whole-playlist expansion
  is not implemented.
- Videos whose owners disabled embedding cannot play — YouTube's rule, not ours.
- Formats the WebView cannot decode (`.wma`, `.aiff`, …) are listed but marked
  unplayable rather than hidden.
- Restored sessions cap at 500 tracks per queue, the practical `localStorage`
  limit.
