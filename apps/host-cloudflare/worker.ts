// SPDX-License-Identifier: GPL-2.0-or-later
import { absoluteExpiry } from "../../src/streams/protocol";
import type { DurableObjectNamespace, DurableObjectState, ExecutionContext, IncomingRequestCfProperties, Request as WorkerRequest, Fetcher } from "@cloudflare/workers-types";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Http, Streamsy } from "@streamsy/core";
import { CheckpointStore, ProjectionWakeup } from "@streamsy/projection";
import { StreamsyObject, router, type ObjectInstance } from "@streamsy/serve/cloudflare";
import { DurableObjectStorage } from "@streamsy/storage/durable-object";
import { familyOf } from "../../src/streams/ids";
import { familyStreams, lobbyStreams, ReplayWake, LobbyStream, Scores, Sessions } from "../../src/streams/v2";
import { frameWake } from "../../src/projection/wake";
import { makeReplayStats, replayIdle } from "../../src/projection/stats";
import { SnapshotTable, snapshotTable, type SnapshotTableApi, type SqlValue } from "../../src/projection/snapshots";
import { snapshotRoute, snapshotResponse } from "../../src/server/snapshots";
import { ReplayEngines } from "../../src/projection/engines";
import { serverEngine } from "./engine";
import { placement, framesLink, wakeLink, scoresLink } from "./topology";

export interface Env { DOOM_SNAPSHOT_INTERVAL?: string; STREAMS: DurableObjectNamespace; GAMES: DurableObjectNamespace; REPLAYS: DurableObjectNamespace; LOBBY: DurableObjectNamespace; ASSETS: Fetcher }
// Retain the deployed class/binding identity until a provider migration is reviewed.
// It never acquires storage or serves the removed protocol namespace.
export class DoomStreams {
  async fetch(): Promise<Response> { return new Response(null, { status: 404 }); }
}
const gameLayer = (state: DurableObjectState) => CheckpointStore.layer.pipe(
  Layer.provideMerge(DurableObjectStorage.layer(familyStreams, { client: { storage: state.storage }, longPollTimeoutMs: 20_000 })),
);
export const DoomGames = StreamsyObject.make<Env, Layer.Success<ReturnType<typeof gameLayer>>, ReplayWake>({
  app: Layer.merge(Http.routes(familyStreams, { prefix: "/", access: "full", maxMessageSize: 2_000_000 }), framesLink.routes),
  layer: gameLayer, links: env => [wakeLink.client(env.REPLAYS)], wakeups: [ProjectionWakeup.attach(frameWake)],
});
const initScores = HttpRouter.add("POST", "/__init-scores", Effect.gen(function* () {
  yield* (yield* Scores).create({}, { ttlSeconds: 43200 });
  return HttpServerResponse.empty({ status: 204 });
}).pipe(Effect.orDie));
const lobbyLayer = (state: DurableObjectState) => DurableObjectStorage.layer(lobbyStreams, { client: { storage: state.storage }, longPollTimeoutMs: 20_000 });
export const DoomLobby = StreamsyObject.make<Env, Layer.Success<ReturnType<typeof lobbyLayer>>>({
  app: Layer.mergeAll(Http.routes(lobbyStreams, { prefix: "/", access: stream => stream === Scores ? "read" : "full" }), scoresLink.routes, initScores),
  layer: lobbyLayer, live: { websocket: true },
});

function replayHost(id: string, state: DurableObjectState, env: Env, engines: ReplayEngines["Service"], snapshots: SnapshotTableApi): ObjectInstance {
  // Same concrete address as ReplayWake.at({id}), with no parameters. It is
  // intentionally local; only Sessions and Scores are ObjectLink services.
  class LocalWake extends Streamsy.wake<LocalWake>()("DoomV2/LocalWake", `doom/v2/replay-wake/${id}`, { params: {} }) {}
  const layer = (owner: DurableObjectState) => CheckpointStore.layer.pipe(
    Layer.provideMerge(DurableObjectStorage.layer(Streamsy.group(ReplayWake), { client: { storage: owner.storage } })),
    Layer.provideMerge(Layer.merge(Layer.succeed(ReplayEngines, engines), Layer.succeed(SnapshotTable, snapshots))),
  );
  const replayStats = makeReplayStats({ snapshotInterval: env.DOOM_SNAPSHOT_INTERVAL === undefined ? undefined : Number(env.DOOM_SNAPSHOT_INTERVAL) });
  const Host = StreamsyObject.make<Env, Layer.Success<ReturnType<typeof layer>>, Sessions | Scores>({
    app: Layer.mergeAll(wakeLink.routes, Http.routes(Streamsy.group(ReplayWake), { prefix: "/", access: "read" }),
      HttpRouter.add("POST", "/__init-replay", Effect.gen(function* () {
        const wake = yield* ReplayWake;
        yield* wake.head({ id }).pipe(Effect.catchTag("StreamNotFound", () => wake.create({ id }, { expiresAt: absoluteExpiry() })));
        return HttpServerResponse.empty({ status: 204 });
      }).pipe(Effect.orDie))),
    layer, links: bindings => {
      const frames = framesLink.client(bindings.GAMES), scores = scoresLink.client(bindings.LOBBY);
      return [{ streams: [...frames.streams, ...scores.streams], layer: Layer.merge(frames.layer, scores.layer) }];
    },
    wakeups: [ProjectionWakeup.attach(replayStats, { triggers: [LocalWake] }), ProjectionWakeup.attach(replayIdle, { triggers: [LocalWake] })],
  });
  return new Host(state, env);
}
// Bootstrap is outside identity-dependent acquisition, using only public DO and
// StreamsyObject APIs. Once saved, identity selects one layer graph per lifetime.
export class DoomReplay {
  protected readonly engines: ReplayEngines["Service"];
  protected readonly snapshots: SnapshotTableApi;
  private identity?: string;
  private host?: ObjectInstance;
  private readonly ready: Promise<void>;
  constructor(private readonly owner: DurableObjectState, private readonly bindings: Env) {
    const sql = owner.storage.sql;
    const values = (items: SqlValue[]) => items.map(item => item instanceof Uint8Array ? item.slice().buffer : item);
    this.snapshots = snapshotTable({
      run: (query, items) => { sql.exec(query, ...values(items)); },
      all: <A>(query: string, items: SqlValue[]) => [...sql.exec(query, ...values(items))] as A[],
    }, false);
    this.engines = { cache: new Map(), create: async identity => (await serverEngine(bindings))(identity) };
    this.ready = owner.blockConcurrencyWhile(async () => { this.identity = await owner.storage.get<string>("doom-v2-session-id"); });
  }
  private acquire() {
    if (!this.identity) throw new Error("Replay not bootstrapped");
    return this.host ??= replayHost(this.identity, this.owner, this.bindings, this.engines, this.snapshots);
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__bootstrap/") && request.method === "POST") {
      const id = path.slice("/__bootstrap/".length);
      try { familyOf(id); } catch { return new Response("Invalid v2 session id", { status: 400 }); }
      const accepted = await this.owner.blockConcurrencyWhile(async () => {
        if (this.identity && this.identity !== id) return false;
        await this.owner.storage.put("doom-v2-session-id", id);
        this.identity = id;
        return true;
      });
      if (!accepted) return new Response("Replay identity conflict", { status: 409 });
      return this.acquire().fetch(new Request("https://internal/__init-replay", { method: "POST" }));
    }
    const snapshot = snapshotRoute(request);
    if (snapshot instanceof Response) return snapshot;
    if (snapshot) {
      if (this.identity && snapshot.id !== this.identity) return new Response(null, { status: 404 });
      return snapshotResponse(request, snapshot, this.snapshots);
    }
    if (!this.identity) return new Response("Replay not bootstrapped", { status: 409 });
    return this.acquire().fetch(request);
  }
  async alarm(): Promise<void> { await this.ready; await this.acquire().alarm(); }
}
const games = router<Env>({ prefix: "/", placement, namespace: env => env.GAMES });
const replays = router<Env>({ prefix: "/", placement, namespace: env => env.REPLAYS });
const lobby = router<Env>({ prefix: "/", placement, namespace: env => env.LOBBY });
export default {
  async fetch(request: WorkerRequest<unknown, IncomingRequestCfProperties>, env: Env, context: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__")) return new Response(null, { status: 404 });
    const snapshot = snapshotRoute(request);
    if (snapshot instanceof Response) return snapshot;
    if (snapshot) return env.REPLAYS.get(env.REPLAYS.idFromName(`replay:${snapshot.id}`)).fetch(request);
    if (path.startsWith("/doom/v2/bootstrap/")) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const id = path.slice("/doom/v2/bootstrap/".length);
      try { familyOf(id); } catch { return new Response("Invalid v2 session id", { status: 400 }); }
      const sink = await env.LOBBY.get(env.LOBBY.idFromName("lobby:v2")).fetch("https://internal/__init-scores", { method: "POST" });
      if (!sink.ok) return sink;
      return env.REPLAYS.get(env.REPLAYS.idFromName(`replay:${id}`)).fetch(`https://internal/__bootstrap/${id}`, { method: "POST" });
    }
    if (path.startsWith("/doom/v2/")) {
      const owner = placement.name(path.slice(1));
      const target = owner.startsWith("game:") ? games : owner.startsWith("replay:") ? replays : lobby;
      return target.fetch!(request, env, context);
    }
    return path.startsWith("/doom/") ? new Response(null, { status: 404 }) : env.ASSETS.fetch(request);
  },
};
