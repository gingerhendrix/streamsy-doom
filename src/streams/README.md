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
Game stats own published progress. `writer.row` and `Lobby.get(id)` use server-written `SessionMetadata` without progress fields. `Lobby.rows()` reads the bounded Leaderboard snapshot. Metadata lookups read one Game snapshot. Fork validation uses the persisted
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
| `doom/v2/games/:id` | State `stats`, `presence`, `session`; public read only | `replay:<id>` |
| `doom/v2/entries` | State `entry`: session metadata plus nullable `score` summary and `live`; internal link only | `lobby:v2` |
| `doom/v2/leaderboard` | State `game`: newest 50 entries, public read only | `lobby:v2` |
| `doom/v2/state-snapshot/games/:id` | GET current session/stats/presence with State snapshot controls | `replay:<id>` |
| `doom/v2/state-snapshot/leaderboard` | GET current board with State snapshot controls | `lobby:v2` |
| `doom/v2/bootstrap/:id` | POST validated session JSON; returns server metadata | `replay:<id>` (initializes Entries and Leaderboard first) |
| `doom/v2/end/:id`, `doom/v2/delete/:id` | POST session lifecycle | `replay:<id>` |

Declarations in `v2.ts` use the published Streamsy 0.12.0 APIs. Cloudflare links
and routing share `apps/host-cloudflare/topology.ts`. The replay host stores its
identity before acquisition, attaches a concrete parameter-free local wake
trigger, and reads the family's bytes remotely. The deterministic stats projection
retains an unfinished header/frame and cumulative counters in its checkpoint. It
replays the engine, accumulates kills/items/secrets across resets and alive→dead
transitions, and publishes health, armor, level totals, episode/map, weapon/ammo,
`alive`, `verified` and `tic` into Game. RNG drift is sticky; transport failures retain the retry path. Engine projection `doom-v2-replay` uses `Commit.transaction`: the handler, the snapshot write, the Game append and the checkpoint commit in one SQLite transaction, so a failure rolls all four back. Renaming the previous `doom-v2-replay-stats` identity causes existing live games to replay from zero after rollout; existing snapshot inserts remain idempotent.

Stats emit on visible changes or a 175-tic bucket, retaining qualifying tics inside each engine unit. `replayIdle` alone writes Game presence: input sets `live: true`, and after 30 seconds without input the timer waits for the engine checkpoint to settle, sets false and releases the engine. Its in-memory presence flag can cause one redundant true after eviction. An engine cache miss restores the newest unexpired server snapshot at or below the checkpoint tic, validates build/WAD/settings, and replays the remainder. Without a snapshot it replays from zero. Forks include inherited stats.

`lobbyEntry` (`doom-v2-lobby-entry`) folds Game session, stats and presence, coalescing each unit to at most one Entries change. Each entry contains the session fields, `live`, and `score: null` or `{ tic, episode, map, kills, deaths, items, secrets, alive, verified }`. The first stats, session changes and presence changes publish immediately. Further stats publish only after the 175-tic bucket advances. Metadata and presence can therefore exceed the stats-only cap. Larger units skip intermediate summaries; arbitrary unit splits can change the coalesced output sequence. Retries of a pinned unit produce identical output. Producer delivery is separate from the engine, with exponential backoff capped at 30 seconds. Expired Game delivers `gone` and removes the entry (verified in local workerd).

Bootstrap accepts `{ playerName, skill, episode, map, forkedFrom, forkTic }`. The replay server trims player names, requires 1–40 characters, validates settings and `assertForkFamily`, and sets `createdAt` from its clock and `ended: false`. Repeating bootstrap preserves existing metadata and `createdAt`. End and delete write only the session collection. Public writes to Game and Leaderboard fail; Entries is private. `Lobby.put`, `Lobby.delete`, `Lobby.init` and LobbyStream are removed. `Lobby.get(id)` reads that game's session row from its snapshot; `Lobby.rows()` reads the Leaderboard snapshot. Routes remain unauthenticated.

`StateRows` folds upserts, updates, deletes, resets and snapshot controls. `followState` loads one snapshot then calls `followJson` from its returned offset. Cloudflare Game/Leaderboard sockets fall back to long poll. Binary batches apply only at their control frame; reconnects retain the last confirmed opaque offset. The DoomReplay wrapper forwards all three WebSocket handlers; tests force hibernation and receive subsequent stats. Bun attaches the same projections locally and uses long polling.

Both game pages mount GameHud. Playing uses a 2,048-tic wall-time ring, samples only at stats arrival and displays the last latency plus the median of 20. Watching samples a rough tic lag against downloaded frames and labels the HUD as the head of the game even while seeking. Unknown tic times skip samples, forks label catch-up, and no stats for more than 350 local tics labels a stall. Lobby columns show Map, Kills, Deaths, Items and Secrets; health and armor stay in the live HUD.

Game pages and the lobby load State snapshots and follow from their offsets; no browser folds Game or all-games State history from `-1`. Observed lobby age starts on receipt in this tab; initial history has no server wall timestamp.

Workerd topology tests build only the Worker and use no cloud credentials. Test
bundles, SQLite state and logs use disposable temporary directories that are
removed after each suite. Set `DOOM_TEST_SCRATCH` to retain evidence under that root.
The restart test explicitly reacquires the objects, which restores pending alarms; it does not prove autonomous crash repair.

## Stored paths and formats

V2 frames, manifests, Game streams and replay wakes
have absolute `Stream-Expires-At` deadlines 24 hours after creation and no
`Stream-TTL`; forks get their own creation deadline. Protocol reads with sliding
TTL commit lifecycle touches in 0.12.0, which would requeue attached projections;
absolute expiry prevents that feedback. The client and both replay bootstrap
hosts use this policy. Entries and Leaderboard have no expiry: neither projection nor browser reads commit TTL touches. Their logs grow until State trim is available. Server
snapshot rows use the same absolute expiry as the replay wake stream. Watching
cannot extend a v2 recording’s 24-hour life.

| Path | Content | Expiry |
| --- | --- | --- |
| `doom/v2/sessions/<id>` | JSON header line, then 9-byte frames; binary | Absolute, 24 hours |
| `doom/v2/batches/<id>` | JSON records with real append offsets and tic ranges | Absolute, 24 hours |
| `doom/v2/replay-wake/<id>` | State wake rows | Absolute, 24 hours |
| `doom/v2/server-snapshots/<id>/<tic>` | gzip of metadata JSON line + version 2 heap delta | Same absolute deadline as replay wake |
| `doom/v2/server-snapshots/<id>` | JSON `[{ tic, size }]` in tic order | Lists only unexpired rows |
| `doom/v2/games/<id>` | State session, stats and presence | Same absolute deadline as replay wake |
| `doom/v2/entries` | State derived lobby entries (internal only) | None |
| `doom/v2/leaderboard` | State newest 50 games | None |

The session header contains `formatVersion: 1`, snapshot identity `version: 2`,
WAD SHA-256, WASM build SHA-256, skill, episode, map, `forkedFrom`, and `forkTic`.
The root header sets fork fields to null. **Protocol forks inherit the original
header bytes.** The Game session row is authoritative for a child's immediate
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

Delete removes the batch manifest and calls the server to delete the Game session row. Game stats/presence and snapshots remain publicly read-only until expiry. The derived Entries delete follows asynchronously.
The binary session stays readable until absolute expiry; a deleted session cannot
be forked via this API. `writer.end()` calls the server to mark the Game session row ended; it does not
close the binary stream.

The replay owns `server_snapshots(tic PRIMARY KEY, size, expires_at, bytes BLOB)`.
Bun uses the same table with `(id, tic)` as the key, in a sibling `<name>.snapshots.sqlite` file. A second connection to the stream database would block on the engine transaction's write lock. Nullable `resume_offset` and `resume_frames` columns migrate existing tables. New snapshots retain the input page cursor and the already-read suffix after their tic, including a partial trailing frame. Recovery consumes that suffix and reads only after the opaque cursor. Legacy rows without these columns populated restore their engine but must download and discard the earlier frames; snapshot bytes and public endpoints remain unchanged. The suffix adds at most the remainder of an input page per snapshot. The replay projection writes
through `SnapshotTable`. On Cloudflare the write is inside the engine transaction,
so a failed checkpoint also removes the snapshot row. On Bun the snapshot file is
outside it, and `INSERT OR IGNORE` makes the retried write safe. Snapshots are gzip of the identity/tic JSON
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

Session appends, manifest appends and server metadata writes are separate HTTP operations.
They are not transactional as a group: interruption can leave a frame batch
without manifest metadata, and creation/fork can leave partial resources. There is no crash-repair/retry or multi-writer
coordination service in this batch. Do not fork sessions with incomplete metadata.
Readers and manifests are held in memory; this is a small demo, not an unbounded
archive. The lobby is server-derived; no browser can append metadata or summaries.
Server compression adds work to the engine unit and can delay HUD stats. Other
maps, WADs or builds can exceed the 2,000,000-byte gzip guard; that snapshot is
skipped while stats and the checkpoint continue. Snapshots trail the player by
replay lag and do not reduce frame download on seek. Hosted memory at snapshot
tics remains unmeasured.

State snapshot reads sync unattached StateTables and list their collections in one
storage transaction, returning `Stream-Next-Offset` and `Cache-Control: no-store`.
`followJson` accepts `from`; `followState` applies a snapshot and follows from that
offset. Bootstrap's session lookup and append share the same transaction.
The `doom-v2-leaderboard` projection uses Entries as its sole input and
`Commit.transaction`; it ranks by `createdAt` descending then `id`, retains 50,
and removes deleted entries without a refill scan. The lobby streams do not expire;
per-game expiry removes derived entries through `lobbyEntry`.

The family `frameWake` attachment uses concurrency 8. Sibling bindings can overlap replay-object delivery waits while each binding still processes its units in order. Local workerd tests compare it with concurrency 1 under a controlled response delay.

The engine moved from `Commit.producer` to `Commit.transaction` without a new projection identity. Streamsy 0.12.0 refuses to run `Commit.transaction` on a record that holds a producer pin ("cannot resume a pinned unit"). Deployments that ran the producer version must start from empty Durable Object storage. The test stage was destroyed and redeployed for this change.
