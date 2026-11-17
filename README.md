# streamsy-doom

Doom as a fold over an append-only input log, hosted on [Streamsy](https://github.com/gingerhendrix/streamsy) Durable Streams. Play a game, observe the same input log live, seek using snapshots, then fork at any recorded tic and play a different future.

Inspired by Electric's [Doom on Durable Streams](https://electric.ax/blog/2026/04/20/doom-on-durable-streams). This GPL demo rebuilds DoomGeneric from source and implements its own engine hooks, stream layer and client. It contains no code copied from the durabledoom.com bundle.

## Architecture

```text
Browser keyboard → DoomGeneric WASM (35 tics/s) → 9-byte input frames
                           ↑                          │
            replay / snapshot restore                 ↓
Browser client ───────────── same-origin HTTP ────────────────┐
  engine + WAD parts     Bun host               Cloudflare Worker
  from static assets     SQLite                 ASSETS + DoomStreams
                         /doom/*                one SQLite Durable Object
                                   │
                  Streamsy 0.12.0 protocol streams
  /doom/sessions/<id>       JSON header line + binary input frames
  /doom/batches/<id>        JSON batch manifest: tic ranges + real offsets
  /doom/snapshots/<id>-N    closed gzip: metadata + XOR heap delta at tic N
  /doom/snapshots/<id>-idx  binary (tic u32, compressed size u32) entries
  /doom/lobby              JSON rows folded by id; latest row wins
```

Each frame is the classic eight-byte Doom command layout plus the post-tic `prndindex` RNG byte. Replayers inject the command and check RNG on every tic. Tests also compare diagnostic state hashes. The session header records the WAD and WASM SHA-256, skill, episode and map.

Snapshots capture the entire 16 MiB heap XORed against the initialized engine baseline, then gzip it with identity metadata. They are lossless and specific to the engine build, WAD and settings. The browser checkpoints every 4200 tics (two minutes). A seek restores the latest checkpoint at or before its target and replays the remaining inputs on a fresh engine.

The batch manifest retains each write's actual `Stream-Next-Offset` and tic range. Forks use `Stream-Forked-From`, the opaque `Stream-Fork-Offset`, and a byte `Stream-Fork-Sub-Offset` inside a batch. Offset strings are never edited. Snapshots up to the fork tic are also protocol-forked. A child inherits the original session header bytes; its lobby row records its immediate parent. There is no frame-copy fork mode. Growing-stream reads use no-store/no-cache to avoid stale catch-up and long-poll responses.

See [engine/README.md](engine/README.md) for the engine and snapshot contracts, [engine/UPSTREAM.md](engine/UPSTREAM.md) for source/toolchain pins, and [src/streams/README.md](src/streams/README.md) for the protocol API, TTLs and delete policy.

## Quick start

Requires Bun and Docker. Emscripten runs in a pinned Docker image; no host toolchain install is needed.

```sh
bun install --frozen-lockfile
bun run fetch-wad
bun run build:engine
bun run build:web
bun run dev
# http://127.0.0.1:3000/
```

`dev` builds missing engine output, verifies/fetches Freedoom, rebuilds the web client and WAD parts, and starts the Bun SQLite host. `DOOM_STATIC_DIR=dist bun run dev:host` serves an existing build. Configure `PORT`, `HOST`, `DOOM_DB` (default `doom.sqlite`) and `DOOM_STATIC_DIR` as needed. Bun retains `/game.wad` and the legacy `/freedoom/` notices for compatibility; this client always uses `/wad/manifest.json`.

`fetch-wad` downloads Freedoom Phase 1 0.13.0 and verifies pinned archive and IWAD hashes. Set `DOOM_WAD=/absolute/path/doom1.wad` on **each** fetch/build/dev/test command to use your own legally obtained IWAD. It is runtime data; the WASM does not need rebuilding. That override does not grant redistribution rights. Override builds omit Freedoom notices rather than attaching the wrong licence to your WAD; arrange any required notices and redistribution rights before publishing custom game data.

`build:web` emits ignored `dist/`, including `/wad/`. `build:wad` rebuilds just `dist/wad` (an optional directory argument changes its output). The manifest lists version, whole-file size and SHA-256, ordered part names/sizes, and notice filenames relative to `/wad/`. Default builds include `COPYING.txt` and `CREDITS.txt`. The client concatenates parts, verifies every size and the whole SHA-256, and only then initializes the engine.

Freedoom is 28,795,076 bytes, above Cloudflare's [25 MiB static asset limit](https://developers.cloudflare.com/workers/platform/limits/). Each part is at most 8 MiB. Both hosts serve the same manifest and parts, with no separate browser loading path.

## Playing and watching

Choose a name and skill, then New game (E1M1). Click the canvas for keyboard focus. Arrows move/turn, Ctrl fires, Space uses, Alt strafes, Shift runs, comma/period strafe, and 1–7 select weapons. Blur pauses local play and releases held keys. There is no audio. Use separate browser sessions/windows for a player and live observer.

Watch follows the stream live. Release the timeline slider to seek; the snapshot-to-target range appears below it. Follow live catches up again. Fork here opens a child at the displayed tic and starts recording new inputs. End game drains pending writes and returns to the lobby. Delete appears for sessions created by that browser, remembered in localStorage. It removes the child's snapshots/index/manifest and hides its row; the binary session is retained until TTL. This ownership UI provides no authorization.

Frames flush in batches of about five tics through one serialized queue, which coalesces work behind slow writes. The screen shows pending frames and batch latency including metadata work. Lobby counts publish at most once per two seconds, and on End. A shared `#watch/<id>` URL always opens an observer, never another writer.

## Cloudflare

```sh
bun run fetch-wad
bun run build:cf
bun run dev:cf
# http://127.0.0.1:3000/ (PORT overrides)
```

`build:cf` builds the engine, client and WAD parts, then creates ignored `apps/host-cloudflare/dist/{assets,worker}`. `dev:cf` runs that exact bundle in Miniflare 4.20260730.0 / local workerd, with SQLite Durable Objects and native static assets. It uses no Alchemy CLI, profiles or credentials. The installed Alchemy dev runtime initializes per-user profile/credential services, so direct Miniflare is used for verification under the no-credentials constraint. Local data persists in `.alchemy/miniflare`; `DOOM_CF_STATE` selects another directory. Rebuild and restart after source changes.

The Alchemy **v2** stack is `apps/host-cloudflare/alchemy.run.ts`, pinned to `2.0.0-beta.85`. It default-exports one stack with `Alchemy.localState()`. Stable identifiers:

| Item | Stable value |
| --- | --- |
| Stack | `streamsy-doom` |
| Worker logical id | `Host` |
| Durable Object logical id / exported class / binding | `Streams` / `DoomStreams` / `STREAMS` |
| Physical Worker name | `streamsy-doom-<stage>` |
| Allowed stages | `local`, `test`, `prod` |

Keep these identifiers and local Alchemy state across deployments; changing resource identity can replace persistent resources. `Alchemy.Stage` selects the stage. `workersDev` is enabled for non-prod stages; production needs a separately configured domain/route before it is reachable.

Every request runs through the Worker: `/doom/*` uses the Streamsy router and everything else calls the `ASSETS` binding. All stream paths use `Placement.byKey(() => "doom")`. Forks resolve source and target within a single object, so default per-stream placement breaks forks across session ids. This deliberately makes all games share one object. `maxMessageSize: 2_000_000` leaves room above Streamsy's 1 MiB default for snapshots while staying within the tested local SQLite envelope. Raising it arbitrarily can cause SQLite size errors to surface as 500 responses. Client assets and streams share an origin, so the Worker needs no CORS. The Bun host retains its existing cross-origin development CORS headers.

For a future **approved** test deployment, first create the public source repository and configure its corresponding-source link, then build:

```sh
VITE_SOURCE_URL=https://github.com/YOUR-ACCOUNT/streamsy-doom bun run build:cf
# Only after Gareth explicitly approves deployment:
bun run deploy:cf
# Only after Gareth explicitly approves destruction:
bun run destroy:cf
```

Those two scripts explicitly select `--stage test --profile default`; review them before use. No deployment, destruction or authenticated plan was run for this batch. Do not use `prod` expecting a workers.dev URL.

Earlier remote experiments observed that a busy Durable Object kept serving old code after redeploy until clients disconnected and it was evicted. Keep stored formats readable by both code versions; a redeploy must not be treated as an immediate object restart. This batch verifies only local workerd, not hosted latency, eviction, account limits or a production rollout.

## Checks and limits

```sh
bun run typecheck
bun run test
```

The suite verifies 5,000-tic deterministic capture/replay, fresh snapshot restore, drift detection, real-engine stream recording/live tail/seek, mid-batch and chained forks, deletes, host CORS/static-path safety, queue timing, and WAD split/reconstruction/hash rejection. Engine-dependent tests explicitly skip when build output or the WAD is absent; fetch and build first for full coverage.

This is an unauthenticated demo, with no load test or unlimited archive guarantee. Important limits:

- Session frames, batch manifests, snapshot/index writes and lobby rows are separate, nontransactional operations. An interruption can leave a partial session, missing metadata or an unindexed snapshot. There is no repair/retry flow; ambiguous network writes stop recording.
- A normal append has **three POSTs**: session, batch manifest and lobby. The browser throttles lobby updates, so most flushes use two and periodically add the third. Snapshots require additional writes.
- Browser unload can lose queued writes and leave a stale playing row. Use End before closing or reloading. Async unload handlers cannot guarantee a drain.
- Frames and full heaps remain in browser memory. Baseline heaps add 16 MiB per engine, compression runs on the main thread, and snapshots must be trusted and match build/WAD/settings. Never restore untrusted heap data.
- One Durable Object owns all sessions, limiting concurrency and coupling their location/latency. There are no access controls, rate limits or per-player isolation. Browser ownership is only a convenience.

## Licence and source

This repository is **GPL-2.0-or-later**, including the client, hosts and engine adaptations; see [LICENSE](LICENSE). Vendored [DoomGeneric](https://github.com/ozkl/doomgeneric) derives from Chocolate Doom and id Software's Doom source, whose retained headers allow GPL version 2 or later. Upstream provenance and pins are in [engine/UPSTREAM.md](engine/UPSTREAM.md).

Freedoom is separate game data under **BSD-3-Clause**. Default builds carry its original COPYING and CREDITS files in `/wad/`, referenced by the manifest. No WAD, generated WASM/JS, or WAD parts are committed. Do not redistribute a proprietary IWAD without permission.

Before distributing the compiled GPL engine/client publicly, provide complete corresponding source under GPL, including these build scripts and modifications. Create the public repository first and set `VITE_SOURCE_URL` when building to point the client footer to the source for the deployed version. The default footer marks the repository URL pending; it does not satisfy the public deployment source requirement. Keep the distributed data's notices alongside its assets.
