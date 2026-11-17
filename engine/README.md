# WASM engine

GPL-2.0-or-later; see [UPSTREAM.md](UPSTREAM.md) for source, license, compiler and
WAD pins. This batch contains the engine, a runtime adapter and Bun tests.

## Build and test

From the repository root, with Bun and Docker available:

```sh
bun install --frozen-lockfile
bun run fetch-wad
bun run build:engine
bun test
```

`bun run build:engine` builds from source in one command, using the pinned Docker
Emscripten image. It requires no WAD, host compiler or SDL. It emits ignored
`engine/build/doom.js`, `doom.wasm`, and `build-id.js` (the WASM SHA-256).
Dependencies are used only by the Freedoom fetch script. Audio is disabled.

To use a legally obtained Doom Phase 1/shareware IWAD instead:

```sh
DOOM_WAD=/absolute/path/doom1.wad bun test
```

`DOOM_WAD=... bun run fetch-wad` validates that the supplied file exists and skips
downloading. Otherwise Freedoom 0.13.0 is fetched and hash-checked into ignored
`engine/data/`, with its redistribution notices. Tests skip with an explicit
message when either the WAD or build output is absent. IWAD bytes are runtime
input; changing WADs does not need a rebuild. PWADs and external DeHackEd patches
are outside this adapter's API.

## JavaScript API

`engine/src/engine.js` uses standard JS, without a DOM dependency:

```js
import { createEngine, keys } from './engine/src/engine.js';
const engine = await createEngine(wadBytes, { wasmBinary, skill: 3, episode: 1, map: 1 });
engine.key(keys.up, true);
const frame = engine.step(); // A new Uint8Array(9), one completed game tic.
const hash = engine.hash();
const checkpoint = engine.snapshot();

const observer = await createEngine(wadBytes, { wasmBinary, skill: 3, episode: 1, map: 1 });
observer.step(frame); // Injects the command; throws if post-tic RNG differs.
observer.restore(checkpoint);
const rgba = observer.render(); // Canvas-ready 320 × 200 RGBA bytes.
```

In Bun, load `wadBytes` and `wasmBinary` with `Bun.file(path).bytes()`. In a browser,
use `fetch(...).arrayBuffer()` and wrap in `Uint8Array`. `wasmBinary` is optional
when the generated loader can fetch `doom.wasm` beside itself. Render returns a
copy suitable for `new ImageData(new Uint8ClampedArray(rgba), 320, 200)`; callers
choose when to paint. There is no browser UI or animation loop in this batch.

Skill is **1–5**, episode **1–4**, and map **1–9** (E1M1 is the tested map).
Initialization is single-use per instance, starts at gametic 0, and consumes no
game tics. Use a fresh factory instance to restart. `key(code, boolean)` accepts
only gameplay keys: exported `keys`, Ctrl/Alt/Shift, Space, comma, period and
weapon digits 1–7. The upstream defaults use `keys.fire` and `keys.use`.
Changes persist until released. Escape, menus, pause, saves and chat are excluded
because they introduce state not represented by this gameplay input log.

`step()` samples Doom's normal `G_BuildTiccmd` from gameplay events and captures
the selected command. `step(frame)` replaces the command at `G_Ticker` before
simulation. Each advances exactly one tic with `singletics`. `tic` counts
completed tics; the first frame moves 0 → 1. `prndindex` is the post-tic game RNG
index. No wall clock, sleeping, host RNG or autonomous loop drives the game.
The platform clock is `floor(gametic * 1000 / 35)`. Rendering does not step time;
screen wipes are disabled to avoid waiting for time and consuming cosmetic RNG.

On drift, `step(frame)` throws an error containing tic, expected and actual
`prndindex`; `driftCount` increments. **That tic has already been consumed**.
Discard/restore the diverged instance before continuing. Invalid frames are
rejected before stepping. Matching RNG alone is not a full state comparison;
`hash()` is the deterministic diagnostic used by the test.

## Frame format (version 1)

Exactly **9 bytes**, no struct copy, signed integers in two's complement:

| Byte | Field | Encoding |
| --- | --- | --- |
| 0 | `forwardmove` | signed 8-bit |
| 1 | `sidemove` | signed 8-bit |
| 2–3 | `angleturn` | signed 16-bit, little-endian |
| 4–5 | `consistancy` | unsigned 16-bit, little-endian; high byte must be zero |
| 6 | `chatchar` | byte; must be zero in this single-player API |
| 7 | `buttons` | byte; `BT_SPECIAL` (bit 7) is rejected |
| 8 | `prndindex` | unsigned byte, sampled **after** the tic |

This is the classic eight-byte Doom command layout plus RNG. The pinned upstream
`ticcmd_t` also has Strife/Heretic/Hexen extensions and a byte-sized `consistancy`,
so its C `sizeof` is not eight. The wire reserves two bytes for consistency and
zeros the high byte. Extensions are zero on injection and absent on the wire.
No binary compatibility with the unavailable Durable Doom implementation is
claimed; the format is specified here independently.

## C exports

The generated module factory resolves to a module with these underscored exports:

| Export (prefix `_` in JS) | Contract |
| --- | --- |
| `dg_init(skill, episode, map)` | Start using `/doom1.wad`; 0 on success, -1 for invalid/repeated init |
| `dg_key(key, down)` | Queue gameplay key change (down = 0/1); 0 or -1 |
| `dg_input()` | Pointer to writable nine-byte injection buffer |
| `dg_step(replay)` | 0 = captured input, 1 = injected input; returns 0 = match/success, 1 = RNG drift, -1 = invalid |
| `dg_frame()` | Pointer to latest nine-byte captured frame, valid until next step |
| `dg_gametic()` / `dg_prndindex()` | Completed tic count / post-tic RNG index |
| `dg_drift_count()` | Number of injected RNG mismatches |
| `dg_state_hash()` | Unsigned 32-bit FNV-1a diagnostic, words serialized little-endian |
| `dg_render()` / `dg_pixels()` | Render without stepping / pointer to 320 × 200 packed `0x00RRGGBB` pixels |

`dg_state_hash` covers tic, level time, game state/action, episode/map, `prndindex`,
player state, health, armor, weapons, ammo and player mobj position, angle,
momentum and health. It is a diagnostic with collision risk, not a cryptographic
or exhaustive world-state hash. The adapter also exports `FS` and `HEAPU8`.
For direct module use, set immutable `module.wadBytes` and write those bytes to
`/doom1.wad` through `module.FS` before `dg_init`.

## Snapshot contract and measured sizes

`snapshot()` copies **all 16,777,216 bytes** of `HEAPU8` between C calls, plus
metadata: format version, WASM build SHA-256, IWAD SHA-256, initial skill/episode/
map, and completed tic. `restore(snapshot)` validates identity and length, then
copies the heap into an initialized fresh instance, or rewinds the same instance.
The checkpoint owns its bytes and can be reused. Capture at a completed tic;
for a snapshot at tic N, replay starts with zero-based frame N.

Memory growth, threads, Asyncify and live WASM stack frames are absent. All
mutable engine/allocator state is in linear memory; the fresh instance has the
same function table and idle stack pointer. WAD reads use immutable JS bytes and
absolute offsets, with no file descriptor, buffer or seek cursor to snapshot.
The JS filesystem is only used during initialization/discovery. The same build,
WAD and initial settings are required. Never restore arbitrary untrusted heaps.
Compression and persistence belong to callers; retain the metadata alongside
the raw/gzipped heap. Snapshots are build-specific, not a portable save format.

Freedoom Phase 1 0.13.0, E1M1, skill 3, tic 1100 in the scripted test:

| Heap snapshot | Bytes |
| --- | ---: |
| Raw | 16,777,216 |
| gzip level 9 | 2,462,045 |

These sizes exclude the small metadata object. The test prints current sizes and
identities; gzip size depends on input, render history, WAD and build. Whole
memory is deliberate for correctness, including stack/static data and allocator
state; no partial-heap restore assumption is made.

**Plan consequence:** this measured gzip is larger than the planned Cloudflare
`maxMessageSize: 2_000_000`. A later host batch must account for this measurement
before storing snapshots. This engine batch does not change host settings.

## Replay check

`engine/test/replay.test.ts` records 2,500 tics with movement, turning, strafing,
fire and use, then compares every command, RNG byte and state hash against a
fresh replay. It restores a tic-1100 snapshot in another fresh engine and checks
the remaining 1,400 tics. Player and observer render at different cadences. It
also rejects mismatched snapshot identities and invalid commands, rewinds an
advanced instance, and checks that a corrupted RNG byte reports drift.
