// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only observability and fault injection. The public Worker is unchanged.
import type { DurableObjectState } from "@cloudflare/workers-types";
import { Effect } from "effect";
import { Streamsy } from "@streamsy/core";
import { DurableObjectStorage } from "@streamsy/storage/durable-object";
import { Game, type StatsRow } from "../../src/streams/v2";
import worker, { DoomGames as Games, DoomReplay as Replay, DoomLobby as Lobby, type Env } from "../../apps/host-cloudflare/worker";
export { DoomStreams } from "../../apps/host-cloudflare/worker";
export default worker;
// Count only application SQL submitted through Streamsy's storage connection.
function instrument(owner: DurableObjectState) {
  let queries = 0;
  const sql = owner.storage.sql, exec = sql.exec.bind(sql);
  Object.defineProperty(sql, "exec", { value: (...args: Parameters<typeof sql.exec>) => { queries++; return exec(...args); } });
  return { state: owner, count: () => queries };
}
export class DoomGames extends Games {
  private readonly queries: () => number;
  constructor(private readonly probeState: DurableObjectState, env: Env) {
    const traced = instrument(probeState); super(traced.state, env); this.queries = traced.count;
  }
  override async alarm() {
    await this.probeState.storage.put("test-alarm", [...(await this.probeState.storage.get<number[]>("test-alarm") ?? []), Date.now()]);
    await super.alarm();
  }
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/probe") return Response.json({ queries: this.queries(), frameAt: await this.probeState.storage.get("test-frame-at"), alarm: await this.probeState.storage.get("test-alarm"), armed: await this.probeState.storage.getAlarm() });
    if (url.pathname === "/__test/quiet") return this.probeState.blockConcurrencyWhile(async () => {
      const response = await super.fetch(new Request(new URL(url.searchParams.get("path")!, url), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: await request.arrayBuffer() }));
      // Simulate commit-before-alarm loss without changing Streamsy's SQL writes.
      await this.probeState.storage.deleteAlarm();
      return response;
    });
    const response = await super.fetch(request);
    if (url.pathname.startsWith("/doom/v2/sessions/") && request.method === "POST" && response.ok)
      await this.probeState.storage.put("test-frame-at", Date.now());
    return response;
  }
}
export class DoomReplay extends Replay {
  private steps = 0;
  private readonly queries: () => number;
  constructor(private readonly probeState: DurableObjectState, env: Env) {
    const traced = instrument(probeState); super(traced.state, env); this.queries = traced.count;
    const create = this.engines.create;
    this.engines.create = async identity => {
      const engine = await create(identity), snapshot = engine.snapshot, step = engine.step.bind(engine);
      engine.step = frame => { this.steps++; return step(frame); };
      engine.snapshot = async () => {
        const began = performance.now(), bytes = await this.probeState.storage.get("test-oversize") ? new Uint8Array(2000001) : await snapshot();
        await this.probeState.storage.put("test-snapshot-measurement", { tic: engine.tic, bytes: bytes.length,
          compressionMs: performance.now() - began, isolateMemoryApiAvailable: "memory" in performance,
          inferredPostInitBaselineBytes: 16777216, inferredXorChunkBytes: 65536 });
        return bytes;
      };
      return engine;
    };
  }
  override async alarm() {
    await this.probeState.storage.put("test-alarm", [...(await this.probeState.storage.get<number[]>("test-alarm") ?? []), Date.now()]);
    await super.alarm();
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__test/game-events") {
      const { id, rows } = await request.json() as { id: string; rows: StatsRow[] };
      // Test-only writer using the published storage API, on this replay's SQL.
      await Effect.runPromise(Effect.gen(function* () {
        const game = yield* Game;
        for (let at = 0; at < rows.length; at += 500) {
          const events = rows.slice(at, at + 500).map(value => ({ type: "stats" as const, key: id, value, headers: { operation: "upsert" as const } }));
          if (events.length) yield* game.append({ id }, [events[0], ...events.slice(1)]);
        }
      }).pipe(Effect.provide(DurableObjectStorage.layer(Streamsy.group(Game), { client: { storage: this.probeState.storage } }))));
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__test/oversize") {
      await this.probeState.storage.put("test-oversize", true); return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__test/expire-game") {
      this.probeState.storage.sql.exec("UPDATE streamsy_streams SET expires_at_ms = 0, expires_at = '1970-01-01T00:00:00.000Z' WHERE stream_id LIKE 'doom/v2/games/%'");
      await this.probeState.storage.setAlarm(Date.now()); return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__test/expire-snapshots") {
      this.probeState.storage.sql.exec("UPDATE server_snapshots SET expires_at = 0"); return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__test/snapshots") return Response.json([...this.probeState.storage.sql.exec("SELECT tic,size,expires_at FROM server_snapshots ORDER BY tic")]);
    if (new URL(request.url).pathname === "/__test/evict") { this.engines.cache.clear(); return new Response(null, { status: 204 }); }
    if (new URL(request.url).pathname === "/__test/probe") return Response.json({ queries: this.queries(), steps: this.steps, snapshot: await this.probeState.storage.get("test-snapshot-measurement"), alarm: await this.probeState.storage.get("test-alarm"), identity: await this.probeState.storage.get("doom-v2-session-id"), engines: [...this.engines.cache.values()].map(engine => engine.stats()), armed: await this.probeState.storage.getAlarm() });
    return super.fetch(request);
  }
}
export class DoomLobby extends Lobby {
  private readonly queries: () => number;
  constructor(private readonly probeState: DurableObjectState, env: Env) {
    const traced = instrument(probeState); super(traced.state, env); this.queries = traced.count;
  }
  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/fail-score-response") { await this.probeState.storage.put("test-fail-score", true); return new Response(null, { status: 204 }); }
    if (path === "/__test/fail-init") { await this.probeState.storage.put("test-fail-init", true); return new Response(null, { status: 204 }); }
    if (path === "/__test/probe") return Response.json({ queries: this.queries(), scoreAt: await this.probeState.storage.get("test-score-at"), scorePosts: await this.probeState.storage.get("test-score-posts") });
    if (path === "/__init-lobby" && await this.probeState.storage.get("test-fail-init")) {
      await this.probeState.storage.delete("test-fail-init");
      return new Response("Injected sink initialization failure", { status: 503 });
    }
    const response = await super.fetch(request);
    if (path.startsWith("/__entries/") && request.method === "POST" && response.ok) {
      await this.probeState.storage.put("test-score-at", Date.now());
      await this.probeState.storage.put("test-score-posts", (await this.probeState.storage.get<number>("test-score-posts") ?? 0) + 1);
      if (await this.probeState.storage.get("test-fail-score")) {
        await this.probeState.storage.delete("test-fail-score");
        return new Response("Injected lost score response after durable append", { status: 503 });
      }
    }
    return response;
  }
}
