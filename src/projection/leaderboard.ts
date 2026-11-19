// SPDX-License-Identifier: GPL-2.0-or-later
import { Commit, Projection } from "@streamsy/projection";
import { Array, Effect } from "effect";
import { EntriesTable, LeaderboardTable } from "../storage/state-tables";
import { Entries, Leaderboard, type EntryRow } from "../streams/declarations";
import { recentFirst } from "../streams/entry-order";

export const LEADERBOARD_SIZE = 50;

type EntryEvents = readonly { headers: object }[];

const keysNamedBy = (events: EntryEvents) => [
  ...new Set(events.flatMap((event) => ("key" in event ? [event.key as string] : []))),
];

const replacesWholeCollection = (events: EntryEvents) =>
  events.some(
    ({ headers }) =>
      "control" in headers && (headers.control === "reset" || headers.control === "snapshot-end"),
  );

const newestRows = (rows: Iterable<EntryRow>) =>
  new Map(
    [...rows]
      .sort(recentFirst)
      .slice(0, LEADERBOARD_SIZE)
      .map((row) => [row.id, row]),
  );

const isSameRow = (a: EntryRow | undefined, b: EntryRow) => JSON.stringify(a) === JSON.stringify(b);

function boardChanges(before: Map<string, EntryRow>, after: Map<string, EntryRow>) {
  const upserts = [...after]
    .filter(([key, row]) => !isSameRow(before.get(key), row))
    .map(([key, row]) => ({
      type: "game" as const,
      key,
      value: row,
      headers: { operation: "upsert" as const },
    }));
  const deletes = [...before.keys()]
    .filter((key) => !after.has(key))
    .map((key) => ({ type: "game" as const, key, headers: { operation: "delete" as const } }));
  return [...upserts, ...deletes];
}

export const leaderboard = Projection.process({
  id: "doom-v2-leaderboard",
  params: {},
  inputs: { entries: Entries },
  outputs: { leaderboard: Leaderboard },
  commit: Commit.transaction,
  process: (batch) =>
    Effect.gen(function* () {
      if (batch.entries.gone) return;
      const entries = EntriesTable.at({});
      const board = LeaderboardTable.at({});
      yield* entries.sync();
      yield* board.sync();

      const boardBefore = new Map(
        (yield* board.list("game")).rows.map(({ key, value }) => [key, value]),
      );
      const namedKeys = keysNamedBy(batch.entries.items);
      const keysToRecheck = replacesWholeCollection(batch.entries.items)
        ? [...new Set([...namedKeys, ...boardBefore.keys()])]
        : namedKeys;
      const { rows: currentEntries } = yield* entries.getMany("entry", keysToRecheck);

      const candidates = new Map(boardBefore);
      for (const key of keysToRecheck) {
        const entry = currentEntries.get(key);
        if (entry) candidates.set(key, entry);
        else candidates.delete(key);
      }
      const changes = boardChanges(boardBefore, newestRows(candidates.values()));
      if (Array.isReadonlyArrayNonEmpty(changes)) yield* (yield* Leaderboard).append({}, changes);
    }),
});
