// SPDX-License-Identifier: GPL-2.0-or-later
import { absoluteExpiry } from "../../src/streams/protocol";
import { Http, Streamsy } from "@streamsy/core";
import { CheckpointStore, Projection, Transaction } from "@streamsy/projection";
import { allStreams, Sessions, Batches, ReplayWake, Game, Leaderboard } from "../../src/streams/v2";
import { bootstrapSession, changeSession, sessionInput } from "../../src/server/session";
import { initLobbyStreams } from "../../src/server/lobby";
import { gameSnapshot, stateSnapshot, stateSnapshotRoute, stateSnapshotResponse, LeaderboardTable, stateTableMigration } from "../../src/server/state-snapshot";
import { leaderboard } from "../../src/projection/leaderboard";
import { lobbyEntry } from "../../src/projection/lobby-entry";
import { isFamilyId } from "../../src/streams/ids";
import { makeReplayStats, replayIdle } from "../../src/projection/stats";
import { Database } from "bun:sqlite";
import { SnapshotTable, snapshotTable, type SqlValue } from "../../src/projection/snapshots";
import { snapshotRoute, snapshotResponse } from "../../src/server/snapshots";
import { ReplayEngines } from "../../src/projection/engines";
import { serverEngine } from "./engine";
import { Protocol } from "@streamsy/core/protocol";
import { BunStorage } from "@streamsy/storage/bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export const exposedHeaders = [
  "Stream-Next-Offset", "Stream-Cursor", "Stream-Up-To-Date", "Stream-Closed",
  "Stream-TTL", "Stream-Expires-At", "Stream-Forked-From", "Stream-Fork-Offset",
  "Stream-Fork-Sub-Offset", "stream-sse-data-encoding", "ETag", "Location", "Content-Type",
];
export async function startHost(options: {
  port?: number; hostname?: string; database?: string; staticDirectory?: string; longPollTimeoutMs?: number;
  wadPath?: string; snapshotInterval?: number;
  onRequest?: (request: Request, response: Response) => void;
} = {}) {
  const database = new Database(options.database ?? "doom.sqlite", { create: true });
  const snapshots = snapshotTable({
    run: (query, values) => { database.query(query).run(...values); },
    all: <A>(query: string, values: SqlValue[]) => database.query(query).all(...values) as A[],
  }, true);
  const replayStats = makeReplayStats({ snapshotInterval: options.snapshotInterval });
  const protocol = BunStorage.layerProtocol({
    client: { filename: options.database ?? "doom.sqlite" }, longPollTimeoutMs: options.longPollTimeoutMs ?? 20_000,
  });
  const storage = stateTableMigration.pipe(
    Layer.provideMerge(Layer.merge(CheckpointStore.layer, Transaction.layer)),
    Layer.provideMerge(Protocol.bind(protocol, allStreams).pipe(Layer.provideMerge(protocol))),
  );
  let engineFactory: ReturnType<typeof serverEngine> | undefined;
  const engines = Layer.succeed(ReplayEngines, { cache: new Map(), live: new Set<string>(), create: async identity => (await (engineFactory ??= serverEngine(options.wadPath)))(identity) });
  const runtime = ManagedRuntime.make(Layer.mergeAll(Projection.attach(leaderboard, { durable: true }), Projection.attach(replayStats, { durable: true }), Projection.attach(replayIdle, { durable: true }), Projection.attach(lobbyEntry, { durable: true })).pipe(Layer.provideMerge(storage), Layer.provideMerge(engines), Layer.provideMerge(Layer.succeed(SnapshotTable, snapshots))));
  const context = await runtime.context();
  const cors = HttpRouter.cors({ exposedHeaders, maxAge: 0 });
  const v2 = HttpRouter.toWebHandler(Http.routes(Streamsy.group(Sessions, Batches, ReplayWake, Game, Leaderboard), {
    prefix: "/", maxMessageSize: 2_000_000,
    access: stream => stream === Leaderboard || stream === Game || stream === ReplayWake ? "read" : "full",
  }).pipe(Layer.provide(cors), Layer.provideMerge(Layer.succeedContext(context))), { disableLogger: true });
  const directory = await realpath(options.staticDirectory ?? fileURLToPath(new URL("./public", import.meta.url)));
  let sessionQueue: Promise<unknown> = Promise.resolve();
  const server = Bun.serve({
    port: options.port ?? 3000, hostname: options.hostname ?? "127.0.0.1", idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let response: Response;
      const snapshot = snapshotRoute(request);
      const stateRoute = stateSnapshotRoute(request);
      if (snapshot instanceof Response) response = snapshot;
      else if (snapshot) response = snapshotResponse(request, snapshot, snapshots);
      else if (stateRoute instanceof Response) response = stateRoute;
      else if (stateRoute) {
        response = await runtime.runPromise(Effect.gen(function* () {
          if (stateRoute.kind === "leaderboard") {
            yield* initLobbyStreams;
            return stateSnapshotResponse(yield* stateSnapshot(LeaderboardTable.at({}), ["game"]));
          }
          return stateSnapshotResponse(yield* gameSnapshot(stateRoute.id));
        }).pipe(Effect.catchTag("StreamNotFound", () => Effect.succeed(new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } })))));
      }
      else if (url.pathname.startsWith("/__")) response = new Response(null, { status: 404 });
      else if (url.pathname.startsWith("/doom/v2/bootstrap/")) {
        if (request.method !== "POST") response = new Response(null, { status: 405 });
        else {
          const id = url.pathname.slice("/doom/v2/bootstrap/".length);
          if (!isFamilyId(id)) response = new Response("Invalid v2 session id", { status: 400 });
          else {
            let input: ReturnType<typeof sessionInput>;
            try { input = sessionInput(id, await request.json()); }
            catch (error) { return new Response(String(error), { status: 400 }); }
            const work = sessionQueue.then(() => runtime.runPromise(Effect.gen(function* () {
              yield* initLobbyStreams;
              const wake = yield* ReplayWake, game = yield* Game;
              yield* wake.head({ id }).pipe(Effect.catchTag("StreamNotFound", () => wake.create({ id }, { expiresAt: absoluteExpiry() })));
              const expiresAt = (yield* wake.head({ id })).expiresAt!;
              yield* game.head({ id }).pipe(Effect.catchTag("StreamNotFound", () => game.create({ id }, { expiresAt })));
              return yield* bootstrapSession(id, input);
            })));
            sessionQueue = work.catch(() => {});
            response = Response.json(await work);
          }
        }
      }
      else if (/^\/doom\/v2\/(end|delete)\//.test(url.pathname)) {
        const [, action, id] = url.pathname.match(/^\/doom\/v2\/(end|delete)\/([^/]+)$/) ?? [];
        if (!isFamilyId(id ?? "")) response = new Response(null, { status: 400 });
        else if (request.method !== "POST") response = new Response(null, { status: 405 });
        else {
          const work = sessionQueue.then(() => runtime.runPromise(changeSession(id, action as "end" | "delete").pipe(Effect.catchTag("StreamNotFound", () => Effect.succeed(false)))));
          sessionQueue = work.catch(() => {});
          response = new Response(null, { status: await work ? 204 : 404 });
        }
      }
      else if (url.pathname.startsWith("/doom/v2/")) response = await v2.handler(request);
      else if (url.pathname.startsWith("/doom/")) response = new Response(null, { status: 404 });
      else if (request.method !== "GET" && request.method !== "HEAD") response = new Response(null, { status: 405 });
      else {
        try {
          const path = await realpath(resolve(directory, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
          if (!path.startsWith(directory + sep)) response = new Response(null, { status: 404 });
          else {
            const file = Bun.file(path);
            response = new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type } });
          }
        } catch { response = new Response(null, { status: 404 }); }
      }
      options.onRequest?.(request, response);
      return response;
    },
  });
  return {
    url: server.url.toString(), server,
    async stop() { await server.stop(true); await v2.dispose(); await runtime.dispose(); database.close(); },
  };
}
if (import.meta.main) {
  const host = await startHost({
    port: Number(process.env.PORT ?? 3000), hostname: process.env.HOST ?? "127.0.0.1",
    database: process.env.DOOM_DB ?? "doom.sqlite", staticDirectory: process.env.DOOM_STATIC_DIR,
  });
  console.log(`Doom host: ${host.url}`);
  const stop = async () => { await host.stop(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
