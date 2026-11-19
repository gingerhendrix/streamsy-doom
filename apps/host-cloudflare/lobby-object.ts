// SPDX-License-Identifier: GPL-2.0-or-later
import type { DurableObjectState } from "@cloudflare/workers-types";
import { Http, Streamsy } from "@streamsy/core";
import { CheckpointStore, ProjectionWakeup, Transaction } from "@streamsy/projection";
import { StreamsyObject } from "@streamsy/serve/cloudflare";
import { DurableObjectStorage } from "@streamsy/storage/durable-object";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { leaderboard } from "../../src/projection/leaderboard";
import { LONG_POLL_TIMEOUT_MS } from "../../src/server/limits";
import { createLobbyStreamsThatNeverExpire } from "../../src/server/lobby";
import { leaderboardSnapshot, stateSnapshotHeaders } from "../../src/server/state-snapshot";
import { stateTableMigration } from "../../src/storage/state-tables";
import { Leaderboard, lobbyStreams } from "../../src/streams/declarations";
import { leaderboardStateSnapshotPath } from "../../src/streams/paths";
import type { Env } from "./env";
import { INIT_LOBBY_ROUTE } from "./internal-routes";
import { entriesLink } from "./topology";

const lobbyLayer = (state: DurableObjectState) =>
  stateTableMigration.pipe(
    Layer.provideMerge(Layer.merge(CheckpointStore.layer, Transaction.layer)),
    Layer.provideMerge(
      DurableObjectStorage.layer(lobbyStreams, {
        client: { storage: state.storage },
        longPollTimeoutMs: LONG_POLL_TIMEOUT_MS,
      }),
    ),
  );

const initLobbyRoute = HttpRouter.add(
  "POST",
  INIT_LOBBY_ROUTE,
  Effect.gen(function* () {
    yield* createLobbyStreamsThatNeverExpire;
    return HttpServerResponse.empty({ status: 204 });
  }).pipe(Effect.orDie),
);

const leaderboardSnapshotRoute = HttpRouter.add(
  "GET",
  `/${leaderboardStateSnapshotPath}`,
  Effect.gen(function* () {
    const snapshot = yield* leaderboardSnapshot;
    return HttpServerResponse.jsonUnsafe(snapshot.events, {
      headers: stateSnapshotHeaders(snapshot),
    });
  }).pipe(Effect.orDie),
);

const publicReadOnlyLeaderboard = Http.routes(Streamsy.group(Leaderboard), {
  prefix: "/",
  access: "read",
});

export const DoomLobby = StreamsyObject.make<Env, Layer.Success<ReturnType<typeof lobbyLayer>>>({
  app: Layer.mergeAll(
    publicReadOnlyLeaderboard,
    entriesLink.routes,
    initLobbyRoute,
    leaderboardSnapshotRoute,
  ),
  layer: lobbyLayer,
  live: { websocket: true },
  wakeups: [ProjectionWakeup.attach(leaderboard)],
});
