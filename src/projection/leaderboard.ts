// SPDX-License-Identifier: GPL-2.0-or-later
import { Commit, Projection } from "@streamsy/projection";
import { Array, Effect } from "effect";
import { Entries, Leaderboard, type EntryRow } from "../streams/v2";
import { EntriesTable, LeaderboardTable } from "../server/state-snapshot";

export const recentFirst = (a: EntryRow, b: EntryRow) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
export const leaderboard = Projection.process({
  id: "doom-v2-leaderboard",
  params: {},
  inputs: { entries: Entries },
  outputs: { leaderboard: Leaderboard },
  commit: Commit.transaction,
  process: (batch) =>
    Effect.gen(function* () {
      const entries = EntriesTable.at({}),
        board = LeaderboardTable.at({});
      // Lobby streams have no expiry; a removed input is handled by the runner.
      if (batch.entries.gone) return;
      yield* entries.sync();
      yield* board.sync();
      const keys = [
        ...new Set(batch.entries.items.flatMap((event) => ("key" in event ? [event.key] : []))),
      ];
      const reset = batch.entries.items.some(
        (event) =>
          "control" in event.headers &&
          (event.headers.control === "reset" || event.headers.control === "snapshot-end"),
      );
      const current = (yield* board.list("game")).rows;
      const candidates = new Map(current.map(({ key, value }) => [key, value]));
      // A reset/snapshot can remove keys not explicitly named in this unit.
      const changed = reset ? [...new Set([...keys, ...candidates.keys()])] : keys;
      const { rows } = yield* entries.getMany("entry", changed);
      for (const key of changed) {
        const row = rows.get(key);
        if (row) candidates.set(key, row);
        else candidates.delete(key);
      }
      const kept = new Map(
        [...candidates.values()]
          .sort(recentFirst)
          .slice(0, 50)
          .map((row) => [row.id, row]),
      );
      const before = new Map(current.map(({ key, value }) => [key, value]));
      const changes = [
        ...[...kept].flatMap(([key, row]) =>
          JSON.stringify(before.get(key)) === JSON.stringify(row)
            ? []
            : [
                {
                  type: "game" as const,
                  key,
                  value: row,
                  headers: { operation: "upsert" as const },
                },
              ],
        ),
        ...[...before.keys()]
          .filter((key) => !kept.has(key))
          .map((key) => ({
            type: "game" as const,
            key,
            headers: { operation: "delete" as const },
          })),
      ];
      if (Array.isReadonlyArrayNonEmpty(changes)) yield* (yield* Leaderboard).append({}, changes);
    }),
});
