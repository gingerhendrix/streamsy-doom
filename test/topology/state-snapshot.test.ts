// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { BunStorage } from "@streamsy/storage/bun";
import { CheckpointStore, Projection, Transaction } from "@streamsy/projection";
import { Streamsy } from "@streamsy/core";
import { Entries, Game, Leaderboard, type EntryRow, type StatsRow } from "../../src/streams/v2";
import { GameTable, LeaderboardTable, gameSnapshot, stateSnapshot, stateTableMigration } from "../../src/server/state-snapshot";
import { bootstrapSession } from "../../src/server/session";
import { initLobbyStreams } from "../../src/server/lobby";
import { leaderboard, recentFirst } from "../../src/projection/leaderboard";
import { StateRows, type StateEvent } from "../../src/streams/state";

import { idOf, entryOf, statsOf } from "../helpers/state";
const runtime = () => ManagedRuntime.make(stateTableMigration.pipe(
  Layer.provideMerge(Layer.merge(CheckpointStore.layer, Transaction.layer)),
  Layer.provideMerge(BunStorage.layer(Streamsy.group(Game, Entries, Leaderboard), { client: { filename: ":memory:" } })),
));
const event = (row: EntryRow) => ({ type: "entry" as const, key: row.id, value: row, headers: { operation: "upsert" as const } });

test("Game snapshot equals a full fold at its offset; 5,000 stats changes load two rows and follow without gaps", async () => {
  const rt = runtime(), id = idOf(1);
  try { await rt.runPromise(Effect.gen(function* () {
    const game = yield* Game;
    yield* game.create({ id });
    const changes = Array.from({ length: 5000 }, (_, tic) => ({ type: "stats" as const, key: id, value: statsOf(id, tic), headers: { operation: "upsert" as const } }));
    yield* game.append({ id }, [{ type: "presence", key: id, value: { id, live: true }, headers: { operation: "upsert" } }, ...changes]);
    const snapshot = yield* gameSnapshot(id);
    expect(snapshot.events.filter(e => e.value)).toHaveLength(2);
    const folded = new StateRows<StatsRow>("stats"), loaded = new StateRows<StatsRow>("stats");
    yield* game.read({ id }).pipe(Stream.runForEach(batch => Effect.sync(() => folded.apply(batch.items))));
    loaded.apply(snapshot.events as StateEvent<StatsRow>[]);
    expect(loaded.rows).toEqual(folded.rows);
    expect(snapshot.offset).toBe((yield* GameTable.at({ id }).offset()));
    const next = { type: "stats" as const, key: id, value: statsOf(id, 5000), headers: { operation: "upsert" as const } };
    // This write occurs after the snapshot and before starting the follow.
    yield* game.append({ id }, [next, next]);
    yield* game.read({ id }, { offset: snapshot.offset }).pipe(Stream.runForEach(batch => Effect.sync(() => {
      loaded.apply(batch.items); folded.apply(batch.items);
    })));
    expect(loaded.rows).toEqual(folded.rows);
    expect(loaded.rows.get(id)?.tic).toBe(5000);
  })); } finally { await rt.dispose(); }
});

test("bootstrap lookup and append are atomic under concurrent first bootstraps", async () => {
  const rt = runtime(), id = idOf(2);
  try { await rt.runPromise(Effect.gen(function* () {
    yield* (yield* Game).create({ id });
    const { id: _, createdAt, ended, score, live, ...input } = entryOf(2);
    const rows = yield* Effect.all(Array.from({ length: 8 }, () => bootstrapSession(id, input)), { concurrency: "unbounded" });
    for (const row of rows) expect(row).toEqual(rows[0]);
    let count = 0;
    yield* (yield* Game).read({ id }).pipe(Stream.runForEach(batch => Effect.sync(() => { count += batch.items.length; })));
    expect(count).toBe(1);
  })); } finally { await rt.dispose(); }
});

test("leaderboard keeps newest 50 with stable id ties, ignores the 55th, coalesces bursts and does not refill deletes", async () => {
  const rt = runtime();
  try { await rt.runPromise(Effect.gen(function* () {
    yield* initLobbyStreams;
    const entries = yield* Entries, board = yield* Leaderboard;
    const rows = Array.from({ length: 60 }, (_, i) => entryOf(i + 1));
    yield* entries.append({}, [event(rows[0]), ...rows.slice(1).map(event)]);
    yield* Projection.run(leaderboard.at({}));
    const snapshot = yield* stateSnapshot(LeaderboardTable.at({}), ["game"]);
    const loaded = new StateRows<EntryRow>("game"); loaded.apply(snapshot.events as StateEvent<EntryRow>[]);
    expect([...loaded.rows.values()].sort(recentFirst).map(r => r.id)).toEqual(rows.slice(10).reverse().map(r => r.id));
    const offset = (yield* board.head({})).nextOffset;
    yield* entries.append({}, [event({ ...rows[5], live: true })]);
    yield* Projection.run(leaderboard.at({}));
    expect((yield* board.head({})).nextOffset).toBe(offset);
    const burst = rows.slice(10).map(row => event({ ...row, live: true }));
    yield* entries.append({}, [burst[0], ...burst.slice(1)]);
    yield* Projection.run(leaderboard.at({}));
    let count = 0;
    yield* board.read({}, { offset }).pipe(Stream.runForEach(batch => Effect.sync(() => { count += batch.items.length; loaded.apply(batch.items); })));
    expect(count).toBe(50);
    yield* entries.append({}, [{ type: "entry", key: rows[59].id, headers: { operation: "delete" } }]);
    yield* Projection.run(leaderboard.at({}));
    const after = yield* stateSnapshot(LeaderboardTable.at({}), ["game"]);
    expect(after.events.filter(e => e.value)).toHaveLength(49);
    const fold = new StateRows<EntryRow>("game"), followed = new StateRows<EntryRow>("game");
    followed.apply(snapshot.events as StateEvent<EntryRow>[]);
    yield* board.read({}, { offset: snapshot.offset }).pipe(Stream.runForEach(batch => Effect.sync(() => followed.apply(batch.items))));
    yield* board.read({}).pipe(Stream.runForEach(batch => Effect.sync(() => fold.apply(batch.items))));
    expect(followed.rows).toEqual(fold.rows);
    // One input already contains the metadata, even before a score exists.
    yield* entries.append({}, [event(entryOf(61))]);
    yield* Projection.run(leaderboard.at({}));
    expect((yield* stateSnapshot(LeaderboardTable.at({}), ["game"])).events.filter(e => e.value)).toHaveLength(50);
    expect(recentFirst({ ...rows[0], createdAt: rows[1].createdAt }, rows[1])).toBeLessThan(0);
  })); } finally { await rt.dispose(); }
});
