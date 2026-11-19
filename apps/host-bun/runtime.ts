// SPDX-License-Identifier: GPL-2.0-or-later
import { Database } from "bun:sqlite";
import { Http, Streamsy } from "@streamsy/core";
import { Protocol } from "@streamsy/core/protocol";
import { CheckpointStore, Projection, Transaction } from "@streamsy/projection";
import { BunStorage } from "@streamsy/storage/bun";
import { Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";
import { leaderboard } from "../../src/projection/leaderboard";
import { lobbyEntry } from "../../src/projection/lobby-entry";
import { ReplayEngines } from "../../src/projection/replay/engines";
import { replayIdle } from "../../src/projection/replay/idle";
import { makeReplayStats } from "../../src/projection/replay/projection";
import { LONG_POLL_TIMEOUT_MS, MAX_APPEND_BYTES } from "../../src/server/limits";
import {
  SnapshotTable,
  snapshotTable,
  type SnapshotSql,
  type SqlValue,
} from "../../src/storage/snapshot-table";
import { stateTableMigration } from "../../src/storage/state-tables";
import {
  allStreams,
  Batches,
  Game,
  Leaderboard,
  ReplayWake,
  Sessions,
} from "../../src/streams/declarations";
import { serverEngine } from "./engine";

export const exposedHeaders = [
  "Stream-Next-Offset",
  "Stream-Cursor",
  "Stream-Up-To-Date",
  "Stream-Closed",
  "Stream-TTL",
  "Stream-Expires-At",
  "Stream-Forked-From",
  "Stream-Fork-Offset",
  "Stream-Fork-Sub-Offset",
  "stream-sse-data-encoding",
  "ETag",
  "Location",
  "Content-Type",
];

export interface RuntimeOptions {
  database: string;
  longPollTimeoutMs?: number;
  wadPath?: string;
  snapshotInterval?: number;
}

const publicStreams = Streamsy.group(Sessions, Batches, ReplayWake, Game, Leaderboard);
const streamsOnlyTheServerWrites = [Leaderboard, Game, ReplayWake] as const;

const bunSql = (database: Database): SnapshotSql => ({
  run: (query, values) => {
    database.query(query).run(...values);
  },
  all: <A>(query: string, values: SqlValue[]) => database.query(query).all(...values) as A[],
});

const IN_MEMORY = ":memory:";

export function snapshotDatabase(streamDatabase: string) {
  if (streamDatabase === IN_MEMORY) return IN_MEMORY;
  return `${streamDatabase.replace(/\.sqlite$/, "")}.snapshots.sqlite`;
}

function replayEnginesSharingOneFactory(wadPath?: string) {
  let factory: ReturnType<typeof serverEngine> | undefined;
  return Layer.succeed(ReplayEngines, {
    cache: new Map(),
    live: new Set<string>(),
    create: async (identity) => (await (factory ??= serverEngine(wadPath)))(identity),
  });
}

export async function makeHostRuntime(options: RuntimeOptions) {
  const snapshotsDatabase = new Database(snapshotDatabase(options.database), { create: true });
  const snapshots = snapshotTable(bunSql(snapshotsDatabase), "many-sessions-per-database");

  const protocol = BunStorage.layerProtocol({
    client: { filename: options.database },
    longPollTimeoutMs: options.longPollTimeoutMs ?? LONG_POLL_TIMEOUT_MS,
  });
  const storage = stateTableMigration.pipe(
    Layer.provideMerge(Layer.merge(CheckpointStore.layer, Transaction.layer)),
    Layer.provideMerge(Protocol.bind(protocol, allStreams).pipe(Layer.provideMerge(protocol))),
  );

  const replayStats = makeReplayStats({ snapshotInterval: options.snapshotInterval });
  const durable = { durable: true };
  const projections = Layer.mergeAll(
    Projection.attach(leaderboard, durable),
    Projection.attach(replayStats, durable),
    Projection.attach(replayIdle, durable),
    Projection.attach(lobbyEntry, durable),
  );
  const runtime = ManagedRuntime.make(
    projections.pipe(
      Layer.provideMerge(storage),
      Layer.provideMerge(replayEnginesSharingOneFactory(options.wadPath)),
      Layer.provideMerge(Layer.succeed(SnapshotTable, snapshots)),
    ),
  );

  const streamRoutes = Http.routes(publicStreams, {
    prefix: "/",
    maxMessageSize: MAX_APPEND_BYTES,
    access: (stream) =>
      streamsOnlyTheServerWrites.some((serverWritten) => serverWritten === stream)
        ? "read"
        : "full",
  });
  const streams = HttpRouter.toWebHandler(
    streamRoutes.pipe(
      Layer.provide(HttpRouter.cors({ exposedHeaders, maxAge: 0 })),
      Layer.provideMerge(Layer.succeedContext(await runtime.context())),
    ),
    { disableLogger: true },
  );

  return {
    runtime,
    snapshots,
    streams,
    async dispose() {
      await streams.dispose();
      await runtime.dispose();
      snapshotsDatabase.close();
    },
  };
}

export type HostRuntime = Awaited<ReturnType<typeof makeHostRuntime>>;
