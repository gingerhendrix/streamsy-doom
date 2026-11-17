# streamsy-doom

Doom as a fold over an append-only input log, hosted on [Streamsy](https://github.com/gingerhendrix/streamsy) Durable Streams.

A rebuild of Electric's "Durable Doom" demo. Every game tick appends one input frame to a stream. Observers tail the stream live, seek with heap snapshots, and fork a session at any tick.

The engine, stream layer, browser client and local Bun SQLite host are implemented.
The Cloudflare host is a follow-up batch.

## Build and test

Requires Bun and Docker; no host Emscripten installation is needed.

```sh
bun install --frozen-lockfile
bun run fetch-wad
bun run build:engine
bun run test
bun run typecheck
bun run dev
```

The fetch script downloads and verifies Freedoom Phase 1 0.13.0. To test with your
own IWAD, run `DOOM_WAD=/absolute/path/doom1.wad bun test` instead. Build output
and game data are ignored. Tests report a skip if either is missing.

See [engine/README.md](engine/README.md) for the runtime API, frame format,
snapshots and measurements, and [engine/UPSTREAM.md](engine/UPSTREAM.md) for
source/toolchain/WAD pins and the license-header check.

## Local host

`bun run dev` builds the engine if output is missing, fetches/verifies Freedoom,
builds the Vite TypeScript client into ignored `dist/`, then starts the Bun host
at `http://127.0.0.1:3000/`. The client, engine, WAD and `/doom/*` protocol routes
share one origin. Configure `PORT`, `HOST`, `DOOM_DB` (default `doom.sqlite`),
`DOOM_STATIC_DIR`, or `DOOM_WAD` (a user-supplied IWAD served at `/game.wad`).
The default WAD and its credit/licence files are served directly from the fetch
script’s ignored `engine/data/` location; they are never committed or bundled.
`bun run build:web` rebuilds `dist/` after engine output exists. To serve an
already-built client: `DOOM_STATIC_DIR=dist bun run dev:host`. Without that
setting `dev:host` retains its small protocol-host placeholder for tests.
Set `VITE_SOURCE_URL=https://… bun run build:web` to configure the GPL source
link. Until a repository exists, the footer explicitly marks the URL pending.
Public deployment needs an actual corresponding-source link first.
Tests start the host in-process with SQLite `:memory:` and dispose it afterwards.
The host caps each message at 2,000,000 bytes and adds Effect CORS middleware,
including fork request headers and exposed offset, cursor and binary SSE headers.

See [src/streams/README.md](src/streams/README.md) for API examples, stored formats,
cache handling, real-offset forks, inherited headers and delete policy.
The integration test records 5,000 real WASM tics in uneven batches, tails live,
seeks from snapshots, forks inside a batch, plays on, forks again and deletes.
Host and protocol checks still run when the engine/WAD tests are skipped.
This is a local development host; authentication and access controls are outside
this demo. No public deployment is included.

## Browser client

Use New game to choose a player name and skill (E1M1). Click the canvas for
keyboard focus: arrows move/turn, Ctrl fires, Space uses, Alt strafes, Shift
runs, comma/period strafe and 1–7 select weapons. The main-thread fixed-step
accumulator runs at 35 tics/second and renders through requestAnimationFrame.
Window blur pauses local play and releases held keys; use separate browser
windows/sessions for a player and observer. There is no audio.

Frames flush in batches of about five tics, with one serialized drain for
session append, manifest, snapshots and lobby publication. Slow writes coalesce
queued frames. The screen shows local tics, pending frames and the most recent
batch latency (including manifest/metadata). Lobby counts publish at most once
per two seconds and on End. Checkpoints are captured at exactly every 4200 tics
and uploaded after their corresponding frames. Compression is synchronous on
the main thread; the demo’s small checkpoints do not require a Worker.

Watch follows live, showing lag against the last received tail. Release the
scrubber to seek; a fresh engine and separate reader restore the latest
checkpoint at/before the target, then replay. Follow live catches up again.
Fork here opens a child at the displayed tic, preserving engine/WAD/settings
and inheriting snapshots through real-offset protocol forks. End game drains
pending frames, marks the row ended and returns to the lobby. Delete appears
only for ids created by this browser (remembered in localStorage); it is a UI
convenience, not authorization. The stream layer retains binary session bytes
until TTL, as documented below.

Use End before closing/reloading a player: a browser unload cannot guarantee
async writes or an ended row. Reloading the shareable `#watch/<id>` URL opens
an observer, never a second writer. Network errors stop recording and surface
in the page; ambiguous writes are not retried. Histories and WASM heaps remain
in memory, so this is a small local demo rather than an unlimited archive.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE). The engine is derived from DoomGeneric and id Software's Doom source, with GPL version 2-or-later engine headers. No game data (WAD files) is committed to this repository.
