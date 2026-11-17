# streamsy-doom

Doom as a fold over an append-only input log, hosted on [Streamsy](https://github.com/gingerhendrix/streamsy) Durable Streams.

A rebuild of Electric's "Durable Doom" demo. Every game tick appends one input frame to a stream. Observers tail the stream live, seek with heap snapshots, and fork a session at any tick.

The engine and deterministic replay test are implemented. The browser client
and Streamsy hosts are planned follow-up batches.

## Build and test

Requires Bun and Docker; no host Emscripten installation is needed.

```sh
bun install --frozen-lockfile
bun run fetch-wad
bun run build:engine
bun test
```

The fetch script downloads and verifies Freedoom Phase 1 0.13.0. To test with your
own IWAD, run `DOOM_WAD=/absolute/path/doom1.wad bun test` instead. Build output
and game data are ignored. Tests report a skip if either is missing.

See [engine/README.md](engine/README.md) for the runtime API, frame format,
snapshots and measurements, and [engine/UPSTREAM.md](engine/UPSTREAM.md) for
source/toolchain/WAD pins and the license-header check.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE). The engine is derived from DoomGeneric and id Software's Doom source, with GPL version 2-or-later engine headers. No game data (WAD files) is committed to this repository.
