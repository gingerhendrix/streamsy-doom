// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only observability and fault injection. The public Worker is unchanged.
import type { DurableObjectState } from "@cloudflare/workers-types";
import worker, { DoomGames as Games, DoomReplay as Replay, DoomLobby as Lobby, type Env } from "../../apps/host-cloudflare/worker";
export { DoomStreams } from "../../apps/host-cloudflare/worker";
export default worker;
export class DoomGames extends Games {
  constructor(private readonly probeState: DurableObjectState, env: Env) { super(probeState, env); }
  override async alarm() {
    await this.probeState.storage.put("test-alarm", [...(await this.probeState.storage.get<number[]>("test-alarm") ?? []), Date.now()]);
    await super.alarm();
  }
  override async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/probe") return Response.json({ alarm: await this.probeState.storage.get("test-alarm"), armed: await this.probeState.storage.getAlarm() });
    if (url.pathname === "/__test/quiet") return this.probeState.blockConcurrencyWhile(async () => {
      const response = await super.fetch(new Request(new URL(url.searchParams.get("path")!, url), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: await request.arrayBuffer() }));
      // Simulate commit-before-alarm loss without changing Streamsy's SQL writes.
      await this.probeState.storage.deleteAlarm();
      return response;
    });
    return super.fetch(request);
  }
}
export class DoomReplay extends Replay {
  constructor(private readonly probeState: DurableObjectState, env: Env) { super(probeState, env); }
  override async alarm() {
    await this.probeState.storage.put("test-alarm", [...(await this.probeState.storage.get<number[]>("test-alarm") ?? []), Date.now()]);
    await super.alarm();
  }
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__test/probe") return Response.json({ alarm: await this.probeState.storage.get("test-alarm"), identity: await this.probeState.storage.get("doom-v2-session-id"), armed: await this.probeState.storage.getAlarm() });
    return super.fetch(request);
  }
}
export class DoomLobby extends Lobby {
  constructor(private readonly probeState: DurableObjectState, env: Env) { super(probeState, env); }
  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/fail-init") { await this.probeState.storage.put("test-fail-init", true); return new Response(null, { status: 204 }); }
    if (path === "/__test/probe") return Response.json({ scoreAt: await this.probeState.storage.get("test-score-at") });
    if (path === "/__init-scores" && await this.probeState.storage.get("test-fail-init")) {
      await this.probeState.storage.delete("test-fail-init");
      return new Response("Injected sink initialization failure", { status: 503 });
    }
    const response = await super.fetch(request);
    if (path.startsWith("/__scores/") && request.method === "POST" && response.ok) await this.probeState.storage.put("test-score-at", Date.now());
    return response;
  }
}
