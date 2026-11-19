// SPDX-License-Identifier: GPL-2.0-or-later
import type { DurableObjectState } from "@cloudflare/workers-types";
import { Http, Streamsy } from "@streamsy/core";
import { CheckpointStore, ProjectionWakeup, Transaction } from "@streamsy/projection";
import { StreamsyObject, type ObjectInstance } from "@streamsy/serve/cloudflare";
import { DurableObjectStorage } from "@streamsy/storage/durable-object";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { lobbyEntry } from "../../src/projection/lobby-entry";
import { ReplayEngines } from "../../src/projection/replay/engines";
import { replayIdle } from "../../src/projection/replay/idle";
import { makeReplayStats } from "../../src/projection/replay/projection";
import { createReplayStreamsWithOneExpiry } from "../../src/server/replay-streams";
import { NO_STORE } from "../../src/server/responses";
import {
  bootstrapSession,
  changeSession,
  parseSessionInput,
  type SessionChange,
} from "../../src/server/session";
import { gameSnapshot, stateSnapshotHeaders } from "../../src/server/state-snapshot";
import { SnapshotTable, type SnapshotTableApi } from "../../src/storage/snapshot-table";
import { stateTableMigration } from "../../src/storage/state-tables";
import { Game, ReplayWake, type Entries, type Sessions } from "../../src/streams/declarations";
import { deletePath, endPath, gameStateSnapshotPath } from "../../src/streams/paths";
import type { Env } from "./env";
import { INIT_REPLAY_ROUTE } from "./internal-routes";
import { entriesLink, framesLink, wakeLink } from "./topology";

const replayStreams = Streamsy.group(ReplayWake, Game);

const snapshotIntervalFrom = (env: Env) =>
  env.DOOM_SNAPSHOT_INTERVAL === undefined ? undefined : Number(env.DOOM_SNAPSHOT_INTERVAL);

const gameSnapshotRoute = (id: string) =>
  HttpRouter.add(
    "GET",
    `/${gameStateSnapshotPath(id)}`,
    Effect.gen(function* () {
      const snapshot = yield* gameSnapshot(id);
      return HttpServerResponse.jsonUnsafe(snapshot.events, {
        headers: stateSnapshotHeaders(snapshot),
      });
    }).pipe(
      Effect.catchTag("StreamNotFound", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 404, headers: NO_STORE })),
      ),
      Effect.orDie,
    ),
  );

const initReplayRoute = (id: string) =>
  HttpRouter.add(
    "POST",
    INIT_REPLAY_ROUTE,
    Effect.gen(function* () {
      yield* createReplayStreamsWithOneExpiry(id);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = parseSessionInput(id, yield* request.json);
      const session = yield* bootstrapSession(id, input);
      return HttpServerResponse.jsonUnsafe(session);
    }).pipe(Effect.orDie),
  );

const sessionChangeRoute = (id: string, change: SessionChange, path: string) =>
  HttpRouter.add(
    "POST",
    `/${path}`,
    Effect.gen(function* () {
      const sessionExisted = yield* changeSession(id, change);
      return HttpServerResponse.empty({ status: sessionExisted ? 204 : 404 });
    }).pipe(Effect.orDie),
  );

export function makeReplayHost(
  id: string,
  state: DurableObjectState,
  env: Env,
  engines: ReplayEngines["Service"],
  snapshots: SnapshotTableApi,
): ObjectInstance {
  class WakeOfThisReplayOnly extends Streamsy.wake<WakeOfThisReplayOnly>()(
    "DoomV2/LocalWake",
    `doom/v2/replay-wake/${id}`,
    { params: {} },
  ) {}

  const layer = (owner: DurableObjectState) =>
    stateTableMigration.pipe(
      Layer.provideMerge(Layer.merge(CheckpointStore.layer, Transaction.layer)),
      Layer.provideMerge(
        DurableObjectStorage.layer(replayStreams, { client: { storage: owner.storage } }),
      ),
      Layer.provideMerge(
        Layer.merge(Layer.succeed(ReplayEngines, engines), Layer.succeed(SnapshotTable, snapshots)),
      ),
    );

  const replayStats = makeReplayStats({ snapshotInterval: snapshotIntervalFrom(env) });
  const wokenByThisReplay = { triggers: [WakeOfThisReplayOnly] };

  const Host = StreamsyObject.make<
    Env,
    Layer.Success<ReturnType<typeof layer>>,
    Sessions | Entries
  >({
    app: Layer.mergeAll(
      wakeLink.routes,
      gameSnapshotRoute(id),
      Http.routes(replayStreams, { prefix: "/", access: "read" }),
      initReplayRoute(id),
      sessionChangeRoute(id, "end", endPath(id)),
      sessionChangeRoute(id, "delete", deletePath(id)),
    ),
    layer,
    links: (bindings) => {
      const frames = framesLink.client(bindings.GAMES);
      const entries = entriesLink.client(bindings.LOBBY);
      return [
        {
          streams: [...frames.streams, ...entries.streams],
          layer: Layer.merge(frames.layer, entries.layer),
        },
      ];
    },
    live: { websocket: true },
    wakeups: [
      ProjectionWakeup.attach(lobbyEntry),
      ProjectionWakeup.attach(replayStats, wokenByThisReplay),
      ProjectionWakeup.attach(replayIdle, wokenByThisReplay),
    ],
  });
  return new Host(state, env);
}
