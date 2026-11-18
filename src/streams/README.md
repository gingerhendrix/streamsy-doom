# Doom streams

UI-free TypeScript, standard fetch and fflate, backed by Streamsy 0.12.0.
The engine adapter satisfies `ReplayEngine`; there is no DOM, timing loop or UI.
Plain fetch was chosen instead of a stream client library to retain the exact
`Stream-Next-Offset` returned by every append/read, and control cache behavior.
All dependencies come from npm, with exact versions in the root lockfile.

## API

```ts
import { ProtocolClient, createSession, SessionReader, forkSession, deleteSession } from './src/streams';
const client = new ProtocolClient('http://127.0.0.1:3000/');
const writer = await createSession(client, {
  playerName: 'Player', identity: engine.identity,
});
await writer.record(engine, 37, tic => { /* set gameplay keys before each tic */ });
// Or append already captured frames in one POST:
// await writer.append(frames);
const reader = await new SessionReader(client, writer.row.id).catchUp();
await reader.seek(freshEngine, 20);
const child = await forkSession(client, writer.row.id, 20, { playerName: 'Fork' });
await child.record(freshEngine, 10);
await deleteSession(client, child.row.id);
```

`record` steps the engine and POSTs the frame batch. `append` persists already
captured frames. Both paths let the replay projection create snapshots every
21,000 tics (ten minutes), independently of frame page or batch boundaries.
The browser has no snapshot write API. `SnapshotStore.entries()` reads the server
list and `load(entry)` downloads one gzip snapshot and validates its metadata.
V2 frame appends write no lobby progress; `writer.tic` stays local and server
scores own published progress. `writer.row` and `Lobby` use `SessionMetadata`
directly, without progress fields. Fork validation uses the persisted
batch manifest, so no browser progress heartbeat is needed.
Call writer methods sequentially and use one writer per session. Expected-offset
appends reject competing/stale writers. A failed network or metadata operation
is surfaced immediately; writes are not retried automatically. A failed
`record` may have advanced the local engine. Discard the writer and reconcile
server state before attempting recovery.

`follow(signal)` yields `{ tic, frame, offset }` through catch-up then long poll.
Tics count completed frames (1-based); frame array indices are 0-based.
The yielded offset is the end of the HTTP response, which can contain multiple
POSTs. `append` and `record` return the stored batch boundary, including its
before/after offsets and tic range. Writers and readers retain no diagnostic history.
`reader.frames` retains the log for local seeking. Keep a reader per consumer;
its pull/catchUp/follow methods must not run concurrently. Abort a follow using
its signal; aborting an active fetch rejects the iterator.

`seek` reads the latest server snapshot list, restores the latest checkpoint at or before the
target, and replays the remainder. It validates engine identity first. A seek
before the first checkpoint requires a fresh engine at tic 0. Snapshots are
trusted, build-specific linear-memory state; use only matching WAD/build/settings.

## V2 topology

`createSession` generates `<32 lowercase hex>_<32 lowercase hex>` IDs and calls
`POST doom/v2/bootstrap/:id` before creating the frame stream. A fork copies its
parent's family, including forks of forks. A supplied different-family child ID
fails before any request. Path helpers reject every ID outside this exact grammar.
Both hosts reject the removed namespace under `/doom/*` with 404.

| V2 path | Content | Cloudflare owner |
| --- | --- | --- |
| `doom/v2/sessions/:id` | unchanged JSON header + 9-byte frames | `game:<family>` |
| `doom/v2/batches/:id` | unchanged manifest | `game:<family>` |
| `doom/v2/server-snapshots/:id` | JSON `[{ tic, size }]`, GET/HEAD only | `replay:<id>` table |
| `doom/v2/server-snapshots/:id/:tic` | gzip bytes, GET/HEAD only | `replay:<id>` table |
| `doom/v2/replay-wake/:id` | State wake rows, publicly read-only | `replay:<id>` |
| `doom/v2/lobby` | State `session` metadata (identity/settings, player, lineage, createdAt, ended; no progress) | `lobby:v2` |
| `doom/v2/scores` | State `stats` collection, server replay fields below, publicly read-only | `lobby:v2` |

Declarations in `v2.ts` use the published Streamsy 0.12.0 APIs. Cloudflare links
and routing share `apps/host-cloudflare/topology.ts`. The replay host stores its
identity before acquisition, attaches a concrete parameter-free local wake
trigger, and reads the family's bytes remotely. The deterministic stats projection
retains an unfinished header/frame and cumulative counters in its checkpoint. It
replays the engine, accumulates kills/items/secrets across resets and alive→dead
transitions, and publishes health, armor, level totals, episode/map, weapon/ammo,
`alive`, `verified`, `live`, `tic` and `updatedTic`. RNG drift is a sticky unverified
verdict; transport failures retain the projection retry path. `Commit.producer`
retries preserve the producer sequence, including a lost sink response.

Rows emit for visible changes or a 175-tic bucket; every qualifying tic within a
unit emits, so page/unit boundaries do not alter the row sequence. `tic` and
`updatedTic` identify that published engine observation; the durable checkpoint
also stores later projected tics that did not qualify for publication. A separate
`Commit.atLeastOnce` timer publishes the latest settled row with `live: false`
after 30 seconds without input. Resumed input is live on its next qualifying
publication. An engine cache miss replays inputs from zero to the checkpoint;
server snapshots are not used for cache recovery. Forks include inherited stats.
Bun attaches the same projections locally. Reserved `/__…` mounts are never public.

`Lobby` folds the State session collection, including a missing stream. It writes the
`session` collection on create, fork and end, and a State delete on removal.
The browser joins it with server-owned `stats`, hides scores without session
metadata. `StateRows` folds upserts,
partial updates, deletes, resets and snapshot controls. `followJson` catches up
via HTTP and follows Cloudflare lobby/scores over `streamsy-live.v1` WebSockets,
with long-poll fallback on unsupported/failed upgrades. Binary batches are applied
only at their control frame; reconnects retain the last confirmed opaque offset.
Watch shows server scores and lag against the input tics it has read.

New tabs replay retained lobby and score history from `-1`. There is no server
State snapshot/value route. Neither stream is a projection input, so their existing
12-hour sliding TTL remains; continuously active readers can retain growing
history. Observed score age starts on receipt in this tab, since `updatedTic`
is a tic counter, not a wall-clock timestamp. Initial historical age is unknown.

Workerd topology tests build only the Worker and use no cloud credentials. Test
bundles, SQLite state and logs use disposable temporary directories that are
removed after each suite. Set `DOOM_TEST_SCRATCH` to retain evidence under that root.
The restart test explicitly reacquires the objects, which restores pending alarms; it does not prove autonomous crash repair.

## Stored paths and formats

V2 frames, manifests and replay wakes
have absolute `Stream-Expires-At` deadlines 24 hours after creation and no
`Stream-TTL`; forks get their own creation deadline. Protocol reads with sliding
TTL commit lifecycle touches in 0.12.0, which would requeue attached projections;
absolute expiry prevents that feedback. The client and both replay bootstrap
hosts use this policy. V2 lobby/scores retain 43200-second sliding TTL. Server
snapshot rows use the same absolute expiry as the replay wake stream. Watching
cannot extend a v2 recording’s 24-hour life.

| Path | Content | Expiry |
| --- | --- | --- |
| `doom/v2/sessions/<id>` | JSON header line, then 9-byte frames; binary | Absolute, 24 hours |
| `doom/v2/batches/<id>` | JSON records with real append offsets and tic ranges | Absolute, 24 hours |
| `doom/v2/replay-wake/<id>` | State wake rows | Absolute, 24 hours |
| `doom/v2/server-snapshots/<id>/<tic>` | gzip of metadata JSON line + version 2 heap delta | Same absolute deadline as replay wake |
| `doom/v2/server-snapshots/<id>` | JSON `[{ tic, size }]` in tic order | Lists only unexpired rows |
| `doom/v2/lobby` | State session metadata | Sliding, 43200 seconds |
| `doom/v2/scores` | State server stats | Sliding, 43200 seconds |

The session header contains `formatVersion: 1`, snapshot identity `version: 2`,
WAD SHA-256, WASM build SHA-256, skill, episode, map, `forkedFrom`, and `forkTic`.
The root header sets fork fields to null. **Protocol forks inherit the original
header bytes.** The lobby row is authoritative for a child's immediate
`forkedFrom` and `forkTic`; do not read those two fields from its inherited header.
Forks keep the original engine settings/WAD/build. No second header is injected
among frames and no existing bytes are rewritten.

Every successful append records `{ startTic, endTic, before, after }` in the batch
manifest. The initial record stores the returned header offset. These records
are necessary because binary HTTP reads concatenate messages, and the protocol's
binary sub-offset is measured inside the single next stored message. A fresh
client cannot derive message boundaries from an aggregated response. This extra
small metadata stream makes arbitrary historical forks possible after reload.

A fork uses a manifest boundary verbatim as `Stream-Fork-Offset`. Inside a batch
it sends `(targetTic - startTic) * 9` as `Stream-Fork-Sub-Offset`; this is a byte
count, never arithmetic on an offset string. The source path is sent in
`Stream-Forked-From`. The child gets a filtered batch manifest, with its partial
last batch ending at the actual child PUT response offset. Manifest writes are
chunked so long histories do not exceed the message cap. Each child replay
regenerates snapshots for the inherited prefix in its own table. While it catches
up, seeks use an older snapshot or tic zero. No session-frame copy mode exists,
including for chained forks.

All reads send `Cache-Control: no-cache` and fetch `cache: 'no-store'`. This
revalidates growing `offset=-1` streams and avoids cached long-poll URLs, including
in a reused browser. A reader advances using returned offsets/cursors. Lobby
folds paginate until up-to-date. The server snapshot list uses a normal
JSON response with no Streamsy offset headers, and each tic endpoint returns
exactly one gzip body. Offsets remain opaque throughout the frame protocol.

Delete removes the batch manifest and the State session row. Scores and snapshots
are publicly read-only, so they can remain without visible session metadata.
The binary session stays readable until absolute expiry; a deleted session cannot
be forked via this API. `writer.end()` marks the lobby row ended; it does not
close the binary stream.

The replay owns `server_snapshots(tic PRIMARY KEY, size, expires_at, bytes BLOB)`.
Bun uses the same table with `(id, tic)` as the key. The replay projection writes
through `SnapshotTable` using `INSERT OR IGNORE`; a write that precedes a failed
producer checkpoint is safe to repeat. Snapshots are gzip of the identity/tic JSON
line followed by the heap XOR the post-init baseline, preserving browser restore
compatibility. Native compression consumes 64 KiB XOR chunks without allocating
a second 16 MiB delta. The retained post-init baseline adds 16 MiB per engine.

Both endpoints accept only GET and HEAD; all other methods return 405. The list
is uncached and omits expired rows. A missing/expired tic returns 404; immutable
byte responses are cached for at most the remaining row lifetime. Writes purge
expired rows. `replayIdle` clears the table when its frame stream is gone.
Existing v2 browser snapshot streams are no longer mounted. Their recordings seek
from tic zero until the server produces a new snapshot; old streams expire under
their previous policy.

## Limits

Session appends, manifest appends and lobby writes are separate HTTP operations.
They are not transactional as a group: interruption can leave a frame batch
without manifest metadata, and creation/fork can leave partial resources. There is no crash-repair/retry or multi-writer
coordination service in this batch. Do not fork sessions with incomplete metadata.
Readers and manifests are held in memory; this is a small demo, not an unbounded
archive. The lobby uses State upserts with one browser writer per session and a separate server-owned scores stream.
Server compression adds work to the replay unit and can delay scores. Other
maps, WADs or engine builds can exceed the 2,000,000-byte gzip guard and fail the
unit. Snapshots trail the player by replay lag; they do not reduce frame download
on seek. Hosted memory at snapshot tics remains unmeasured.
