// SPDX-License-Identifier: GPL-2.0-or-later
import { StateTable } from "@streamsy/projection";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Entries, Game, Leaderboard } from "../streams/declarations";

export const GameTable = StateTable.define(Game);
export const EntriesTable = StateTable.define(Entries);
export const LeaderboardTable = StateTable.define(Leaderboard);

export const stateTableMigration = Layer.effectDiscard(
  Effect.flatMap(SqlClient.SqlClient, StateTable.migrate).pipe(Effect.orDie),
);

export const failIfGameStreamIsMissing = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* Game).head({ id });
  });
