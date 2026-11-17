// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only observability and fault injection. The public Worker is unchanged.
import type { DurableObjectState } from "@cloudflare/workers-types";
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
  private readonly queries: () => number;
  constructor(private readonly probeState: DurableObjectState, env: Env) {
    const traced = instrument(probeState); super(traced.state, env); this.queries = traced.count;
  }
  override async alarm() {
    await this.probeState.storage.put("test-alarm", [...(await this.probeState.storage.get<number[]>("test-alarm") ?? []), Date.now()]);
    await super.alarm();
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__test/evict") { this.engines.cache.clear(); return new Response(null, { status: 204 }); }
    if (new URL(request.url).pathname === "/__test/probe") return Response.json({ queries: this.queries(), alarm: await this.probeState.storage.get("test-alarm"), identity: await this.probeState.storage.get("doom-v2-session-id"), engines: [...this.engines.cache.values()].map(engine => engine.stats()), armed: await this.probeState.storage.getAlarm() });
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
    if (path === "/__init-scores" && await this.probeState.storage.get("test-fail-init")) {
      await this.probeState.storage.delete("test-fail-init");
      return new Response("Injected sink initialization failure", { status: 503 });
    }
    const response = await super.fetch(request);
    if (path.startsWith("/__scores/") && request.method === "POST" && response.ok) {
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
