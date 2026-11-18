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
  from static assets     one SQLite             ASSETS + Durable Objects
                         local replay stats     game:<family> → replay:<id>
                                                        alarms ↓
                                                          lobby:v2
  /doom/v2/sessions/<family>_<session>  JSON header line + binary frames
  /doom/v2/batches/<id>                tic ranges + opaque offsets
  /doom/v2/server-snapshots/<id>       server snapshot list [{tic,size}]
  /doom/v2/server-snapshots/<id>/<tic>  gzip heap snapshot (GET/HEAD only)
  /doom/v2/replay-wake/<id>            internal producer wake rows (public read)
  /doom/v2/lobby                       browser-written State session rows
  /doom/v2/scores                      server-written verified State stats (public read)
```

Each frame is the classic eight-byte Doom command layout plus the post-tic `prndindex` RNG byte. Replayers inject the command and check RNG on every tic. Tests also compare diagnostic state hashes. The session header records the WAD and WASM SHA-256, skill, episode and map. New IDs contain two exact 32-character lowercase hexadecimal components. Forks inherit the family component, keeping frame history together for native forks.

Snapshots capture the entire 16 MiB heap XORed against the initialized engine baseline, then gzip it with identity metadata. They are lossless and specific to the engine build, WAD and settings. The replay projection captures them every 21,000 tics (ten minutes), including boundaries inside a frame page, and writes gzip BLOBs to its own SQLite table. The browser reads the list and individual snapshots through GET/HEAD-only endpoints; it uploads no heaps. A seek restores the latest checkpoint at or before its target and replays the remaining inputs on a fresh engine.

The batch manifest retains each write's actual `Stream-Next-Offset` and tic range. Forks use `Stream-Forked-From`, the opaque `Stream-Fork-Offset`, and a byte `Stream-Fork-Sub-Offset` inside a batch. Offset strings are never edited. Each child replay regenerates snapshots for its inherited prefix. Until it catches up, seeks use an older snapshot or replay from zero. A child inherits the original session header bytes; its lobby row records its immediate parent. There is no frame-copy fork mode. Growing-stream reads use no-store/no-cache to avoid stale catch-up and long-poll responses.

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

`dev` builds missing engine output, verifies/fetches Freedoom, rebuilds the web client and WAD parts, and starts the Bun SQLite host. `DOOM_STATIC_DIR=dist bun run dev:host` serves an existing build. Configure `PORT`, `HOST`, `DOOM_DB` (default `doom.sqlite`) and `DOOM_STATIC_DIR` as needed. Both hosts serve game data through `/wad/manifest.json` and its parts and notices.

`fetch-wad` downloads Freedoom Phase 1 0.13.0 and verifies pinned archive and IWAD hashes. Set `DOOM_WAD=/absolute/path/doom1.wad` on **each** fetch/build/dev/test command to use your own legally obtained IWAD. It is runtime data; the WASM does not need rebuilding. That override does not grant redistribution rights. Override builds omit Freedoom notices rather than attaching the wrong licence to your WAD; arrange any required notices and redistribution rights before publishing custom game data.

`build:web` emits ignored `dist/`, including `/wad/`. `build:wad` rebuilds just `dist/wad` (an optional directory argument changes its output). The manifest lists version, whole-file size and SHA-256, ordered part names/sizes, and notice filenames relative to `/wad/`. Default builds include `COPYING.txt` and `CREDITS.txt`. The client concatenates parts, verifies every size and the whole SHA-256, and only then initializes the engine.

Freedoom is 28,795,076 bytes, above Cloudflare's [25 MiB static asset limit](https://developers.cloudflare.com/workers/platform/limits/). Each part is at most 8 MiB. Both hosts serve the same manifest and parts, with no separate browser loading path.

## Playing and watching

Choose a name and skill, then New game (E1M1). Click the canvas for keyboard focus. W and S move forward and back. A and D turn left and right. Space fires, and Enter uses doors and switches. Arrows also move and turn, and Ctrl also fires. Alt strafes, Shift runs, comma and period strafe, and 1–7 select weapons. Outside the canvas, Enter keeps its normal browser behavior for forms and buttons. Blur pauses local play and releases held keys. There is no audio. Use separate browser sessions/windows for a player and live observer.

Watch follows the stream live. Release the timeline slider to seek; the snapshot-to-target range appears below it. Follow live catches up again. Fork here opens a child at the displayed tic and starts recording new inputs. End game drains pending writes and returns to the lobby. Delete appears for sessions created by that browser, remembered in localStorage. It removes the child's manifest and hides its row; the binary session and server snapshots retain their absolute expiry. This ownership UI provides no authorization.

Frames flush in batches of about five tics through one serialized queue, which coalesces work behind slow writes. The screen shows pending frames and batch latency including metadata work. V2 lobby metadata publishes only on create, fork, end and delete; frame flushes write no lobby progress. A shared `#watch/<id>` URL always opens an observer, never another writer. The live lobby joins v2 State session metadata with server scores for map, health, armor, kills, deaths, verification and live state. It shows time since this tab received the published score; Watch also shows frame-to-score lag in tics and a projected-stats HUD. Cloudflare follows metadata and scores over hibernatable WebSockets; Bun and failed upgrades fall back to long poll from the last confirmed opaque offset.

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
| Inert compatibility object logical id / exported class / binding | `Streams` / `DoomStreams` / `STREAMS` |
| Family storage | `Games` / `DoomGames` / `GAMES` |
| Replay checkpoints and wake streams | `Replays` / `DoomReplay` / `REPLAYS` |
| Lobby metadata and scores | `Lobby` / `DoomLobby` / `LOBBY` |
| Physical Worker name | `streamsy-doom-<stage>` |
| Allowed stages | `local`, `test`, `prod` |

Keep these identifiers and local Alchemy state across deployments; changing resource identity can replace persistent resources. `Alchemy.Stage` selects the stage. `workersDev` is enabled for non-prod stages; production needs a separately configured domain/route before it is reachable.

Every request runs through the Worker. Both hosts reject unsupported `/doom/*` paths with 404. The inert `DoomStreams` export and `STREAMS` binding retain resource identity until a provider migration is reviewed. V2 uses one shared `Placement.byRoute` table for public routing and internal object links: frames and manifests go to `game:<family>`, wake streams to `replay:<id>`, and lobby/scores to `lobby:v2`. Snapshot requests are matched before stream placement and forwarded to the replay owner, which stores a table keyed by tic. Retain the existing Alchemy resource identities and state.

The client calls `POST /doom/v2/bootstrap/<id>` before creating frames, including forks. The Worker first initializes scores, then the replay owner durably saves its immutable ID and acquires a Streamsy host with a fixed local wake trigger. Frame commits schedule a family alarm to publish wakes; the receiving replay alarm reads remote bytes and runs the headless engine and publishes deterministic stats using producer delivery. Internal `/__frames`, `/__wake` and `/__scores` routes are reachable only through object stubs. Public requests under `/__…` return 404; scores and wakes are publicly read-only. Bun serves the same v2 API with locally attached stats and idle projections over its single SQLite store.

The replay checkpoint stores cumulative kills, deaths, items and secrets plus the last engine counters and any unfinished input record. An engine cache miss rebuilds from recorded inputs at tic zero; snapshot restoration is not used for server cache recovery. Fork scores include the inherited timeline. RNG drift makes `verified: false` permanently for that replay without stopping later frames; transport failures remain binding failures with retries. Verification checks engine identity and per-tic RNG, not player authenticity.

The producer emits each visible-stat change and each 175-tic bucket (five seconds at 35 tics/s), independently of projection unit size. The last score can therefore trail the internal projected tic by up to 174 tics during unchanged play. A separate wall-clock timer publishes the latest checkpoint row with `live: false` after 30 seconds without input and releases its engine. Resumed play becomes live on its next qualifying stats publication. Cache rebuild cost grows with retained history; no trusted server snapshot accelerator is implemented.

Streams keep `maxMessageSize: 2_000_000`; snapshot table writes separately reject gzip BLOBs over 2,000,000 bytes. Both hosts share an origin with their client; Bun also retains its development CORS headers. V2 sessions, manifests and replay wakes use absolute expiry 24 hours after creation, including each fork; reading or appending does not extend that deadline. Snapshot rows use the replay wake stream’s same absolute deadline. Reads ignore expired rows, writes purge expired rows, and a gone frame stream clears the replay’s rows. Lobby/scores keep sliding TTLs; replay identity records remain small durable tombstones, including abandoned bootstraps. Automatic identity/checkpoint garbage collection is not implemented. Recovery after a commit-before-alarm crash is proven on reacquisition, not as an autonomous repair guarantee.

For a future **approved** test deployment, first create the public source repository and configure its corresponding-source link, then build:

```sh
VITE_SOURCE_URL=https://github.com/YOUR-ACCOUNT/streamsy-doom bun run build:cf
# Only after Gareth explicitly approves deployment:
bun run deploy:cf
# Only after Gareth explicitly approves destruction:
bun run destroy:cf
```

Those two scripts explicitly select `--stage test --profile default`; review them before use. No deployment, destruction or authenticated plan was run for this batch. Do not use `prod` expecting a workers.dev URL.

Earlier remote experiments observed that a busy Durable Object kept serving old code after redeploy until clients disconnected and it was evicted. Keep stored formats readable by both code versions; a redeploy must not be treated as an immediate object restart. Earlier batches verified local workerd; see the load-testing section below for hosted latency measurements and their limits. Hosted eviction and a production rollout remain unverified.

## Checks and limits

```sh
bun run typecheck
bun run test
```

The suite verifies State upsert/update/delete folds, metadata-only v2 lifecycle writes, read-only scores, live replay-chain scores over WebSockets and long poll, Bun upgrade fallback, zero idle SQL activity on Bun and on all three workerd owner types, real idle timers and resume, server stats matching Bun/workerd across deaths and level restarts, byte/unit-size independence, trusted cache rebuilds, inherited fork scores, lost producer responses, the two-alarm chain, duplicate wakes, immutable replay bootstrap, restart recovery, sink initialization retries, public access policies, family ownership, and 5,000-tic deterministic capture/replay on v2 paths, server snapshot restore with 1,000 rendered replay tics, idempotent snapshot retries/restarts, snapshot expiry and write rejection on both hosts, drift detection, real-engine stream recording/live tail/seek, mid-batch and chained forks, deletes, host CORS/static-path safety, queue timing, and WAD split/reconstruction/hash rejection. Engine-dependent tests explicitly skip when build output or the WAD is absent; fetch and build first for full coverage.

This is an unauthenticated demo with limited hosted load measurements and no unlimited archive guarantee. Important limits:

- Session frames, batch manifests and lobby rows are separate, nontransactional operations. An interruption can leave a partial session or missing metadata. Server snapshot writes are idempotent by tic (`INSERT OR IGNORE`) across projection retries and restarts. There is no repair/retry flow; ambiguous network writes stop recording.
- A v2 append has **two POSTs**: session and batch manifest. Session metadata writes only at create, fork and end; delete removes its State row. Server snapshots add no browser writes.
- A new lobby/watch tab replays both retained State streams from offset `-1`; no State snapshot/value route is provided. Lobby/scores keep sliding 12-hour TTL because no projection reads them. Active readers can retain growing history; TTL is not a bound on join cost for a continuously active lobby. Deleted sessions may retain server-only score rows until expiry, but the metadata join hides them. Projection age is measured from receipt in the current tab, not a server timestamp or a guarantee that a projection is healthy.
- Browser unload can lose queued writes and leave a stale playing row. Use End before closing or reloading. Async unload handlers cannot guarantee a drain.
- Frames and full heaps remain in browser memory. A post-init baseline adds 16 MiB per replay engine, alongside the shared pre-init reset baseline. Server compression streams 64 KiB XOR chunks into native gzip; browser gunzip and restore still run on the main thread. Snapshots must match build/WAD/settings. Larger snapshots are rejected and can delay score projection. Hosted memory at a snapshot tic remains unmeasured.
- Each fork family shares one storage object; each session gets a replay object, and all scores share a lobby object. Popular families and the lobby can still bottleneck. There are no access controls or rate limits. Browser ownership is only a convenience.

## Load testing

The [Bun load harness](scripts/loadtest/README.md) exercises v2 families, sibling forks, deep lineages, cold rebuilds, and live lobby followers. [Hosted measurements and the failure that stopped testing](docs/performance.md) include latency, cleanup, and telemetry limits. The harness never deploys.

## Licence and source

This repository is **GPL-2.0-or-later**, including the client, hosts and engine adaptations; see [LICENSE](LICENSE). Vendored [DoomGeneric](https://github.com/ozkl/doomgeneric) derives from Chocolate Doom and id Software's Doom source, whose retained headers allow GPL version 2 or later. Upstream provenance and pins are in [engine/UPSTREAM.md](engine/UPSTREAM.md).

Freedoom is separate game data under **BSD-3-Clause**. Default builds carry its original COPYING and CREDITS files in `/wad/`, referenced by the manifest. No WAD, generated WASM/JS, or WAD parts are committed. Do not redistribute a proprietary IWAD without permission.

Before distributing the compiled GPL engine/client publicly, provide complete corresponding source under GPL, including these build scripts and modifications. Create the public repository first and set `VITE_SOURCE_URL` when building to point the client footer to the source for the deployed version. The default footer marks the repository URL pending; it does not satisfy the public deployment source requirement. Keep the distributed data's notices alongside its assets.
