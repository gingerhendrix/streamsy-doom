// SPDX-License-Identifier: GPL-2.0-or-later
import { Effect } from "effect";
import { Entries, Leaderboard } from "../streams/declarations";

export const createLobbyStreamsThatNeverExpire = Effect.gen(function* () {
  yield* (yield* Entries).create({});
  yield* (yield* Leaderboard).create({});
});
