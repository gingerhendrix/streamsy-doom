// SPDX-License-Identifier: GPL-2.0-or-later
import { Effect } from "effect";
import { Entries, Leaderboard } from "../streams/v2";
// Projection reads must not touch a sliding TTL and schedule themselves again.
// These derived logs persist until State trim is available.
export const initLobbyStreams = Effect.gen(function* () {
  yield* (yield* Entries).create({});
  yield* (yield* Leaderboard).create({});
});
