# streamsy-doom

Doom as a fold over an append-only input log, hosted on [Streamsy](https://github.com/gingerhendrix/streamsy) Durable Streams.

A rebuild of Electric's "Durable Doom" demo. Every game tick appends one input frame to a stream. Observers tail the stream live, seek with heap snapshots, and fork a session at any tick.

The engine, UI-free stream layer and local Bun SQLite host are implemented.
The browser client and Cloudflare host are planned follow-up batches.

## Build and test

Requires Bun and Docker; no host Emscripten installation is needed.

```sh
bun install --frozen-lockfile
bun run fetch-wad
bun run build:engine
bun run test
bun run typecheck
bun run dev:host
```

The fetch script downloads and verifies Freedoom Phase 1 0.13.0. To test with your
own IWAD, run `DOOM_WAD=/absolute/path/doom1.wad bun test` instead. Build output
and game data are ignored. Tests report a skip if either is missing.

See [engine/README.md](engine/README.md) for the runtime API, frame format,
snapshots and measurements, and [engine/UPSTREAM.md](engine/UPSTREAM.md) for
source/toolchain/WAD pins and the license-header check.

## Local host

`bun run dev:host` serves a placeholder at `http://127.0.0.1:3000/` and all
`/doom/*` protocol routes on the same origin. Configure `PORT`, `HOST`, `DOOM_DB`
(default `doom.sqlite`), or `DOOM_STATIC_DIR` (a later client build directory).
Tests start the host in-process with SQLite `:memory:` and dispose it afterwards.
The host caps each message at 2,000,000 bytes and adds Effect CORS middleware,
including fork request headers and exposed offset, cursor and binary SSE headers.

See [src/streams/README.md](src/streams/README.md) for API examples, stored formats,
cache handling, real-offset forks, inherited headers and delete policy.
The integration test records 5,000 real WASM tics in uneven batches, tails live,
seeks from snapshots, forks inside a batch, plays on, forks again and deletes.
Host and protocol checks still run when the engine/WAD tests are skipped.
This is a local development host; authentication and access controls are outside
this batch. No public deployment or browser UI is included.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE). The engine is derived from DoomGeneric and id Software's Doom source, with GPL version 2-or-later engine headers. No game data (WAD files) is committed to this repository.
