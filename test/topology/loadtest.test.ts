// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { testScratch } from "../helpers/scratch";
import { Miniflare } from "miniflare";
import { bundleWorker } from "../../scripts/bundle-worker";
import { prepareRecording } from "../../scripts/loadtest/recording";
import { runScenario, validate, percentiles, summarize, type Result, type Options, type Scenario } from "../../scripts/loadtest/runner";
import { ProtocolClient, Lobby, createSession, deleteSession, sessionPath, batchPath, indexPath } from "../../src/streams";
const scratch = await testScratch("loadtest");
const fixture = await prepareRecording(400);
const options = (target: string, scenario: Scenario): Options => ({ target, scenario, players: 2, tics: 20, depth: 2,
  idleMs: 0, histories: [35, 175], followers: scenario === "lobby" ? 3 : 1, realtime: false, timeoutMs: 25000, scoreTimeoutMs: 10000 });
test("loadtest validates binding limits before touching a target and uses nearest-rank percentiles", () => {
  expect(() => validate({ ...options("https://demo/", "families"), players: 51 })).toThrow("players");
  expect(() => validate({ ...options("https://demo/", "siblings"), players: 50 })).toThrow("parent");
  expect(() => validate({ ...options("https://demo/", "families"), timeoutMs: 900001 })).toThrow("timeoutMs");
  expect(percentiles([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p95: 5, p99: 5, max: 5 });
  const summary = summarize({ ids: ["own"], cleaned: [], errors: [], requests: [], creates: [],
    appends: [{ id: "own", startTic: 0, endTic: 5, sentAt: 100, ackAt: 120, doneAt: 140 }],
    observations: [{ follower: 0, id: "own", tic: 1, live: true, verified: true, at: 200 },
      { follower: 0, id: "own", tic: 5, live: false, verified: true, at: 30100 }],
  } as unknown as Result);
  expect(summary.measured.sendToScoreMs.p95).toBe(100);
  expect(summary.measured.idleSendToScoreMs.p95).toBe(30000);
  expect(summary.measured.commitToObservedLowerMs.p95).toBe(80);

});
test("loadtest scenarios run against real workerd with engine replay, socket fallback and isolated cleanup", async () => {
  const root = await mkdtemp(`${scratch}/loadtest-`);
  const scriptPath = await bundleWorker("test/topology/probe-worker.ts", `${root}/bundle`);
  const start = (port?: number) => new Miniflare({ rootPath: root, modulesRoot: `${root}/bundle`,
    modules: [{ type: "ESModule", path: scriptPath }, { type: "CompiledWasm", path: `${root}/bundle/doom.wasm` }],
    port, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"], cf: false,
    assets: { directory: new URL("../../dist", import.meta.url).pathname, binding: "ASSETS",
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } },
    durableObjects: { STREAMS: { className: "DoomStreams", useSQLite: true }, GAMES: { className: "DoomGames", useSQLite: true },
      REPLAYS: { className: "DoomReplay", useSQLite: true }, LOBBY: { className: "DoomLobby", useSQLite: true } }, durableObjectsPersist: `${root}/state` });
  let mf = start();
  try {
    const target = (await mf.ready).href, port = Number(new URL(target).port), client = new ProtocolClient(target);
    for (const scenario of ["families", "siblings", "lineage", "cold", "lobby"] as const) {
      const config = options(target, scenario);
      // Real-time cadence is covered by the tiny families run; the remaining cases accelerate.
      if (scenario === "families") config.realtime = true;
      if (scenario === "siblings") config.websocket = false;
      if (scenario === "cold") {
        // Dispose/restart the actual workerd process with the same SQLite state.
        // Existing sockets reconnect through the browser follower's fallback path.
        config.coldReset = async ids => {
          await mf.dispose(); mf = start(port); await mf.ready;
          for (const id of ids) await client.request(`doom/v2/replay-wake/${id}`, { method: "HEAD" });
        };
      }
      const result = await runScenario(config, fixture);
      await Bun.write(`${root}/${scenario}.json`, JSON.stringify(result, null, 2));
      expect(result.failure).toBeUndefined(); expect(result.outcome).toBe("passed");
      expect(result.cleaned).toHaveLength(result.ids.length);
      expect(result.observations.some(r => r.tic > 0 && r.verified)).toBe(true);
      expect((await new Lobby(client).rows()).filter(r => result.ids.includes(r.id))).toHaveLength(0);
      for (const id of result.ids) for (const path of [sessionPath(id), batchPath(id), indexPath(id)]) {
        expect((await fetch(new URL(path, target), { method: "HEAD" })).status).toBe(404);
      }
      if (scenario === "families" || scenario === "lobby") expect(result.transports.some(r => r.mode === "websocket")).toBe(true);
      if (scenario === "siblings") expect(result.transports.some(r => r.mode === "long-poll")).toBe(true);
      if (scenario === "lineage") expect(result.replay).toMatchObject({ tics: 30, verified: true });
      if (scenario === "cold") expect(result.cold.map(r => r.history)).toEqual([35, 175]);
    }
    const sentinel = await createSession(client, { playerName: "untouched sentinel", identity: fixture.identity });
    const lobby = await mf.getDurableObjectNamespace("LOBBY");
    await lobby.get(lobby.idFromName("lobby:v2")).fetch("https://internal/__test/fail-init", { method: "POST" });
    const failed = await runScenario({ ...options(target, "families"), players: 1 }, fixture);
    expect(failed.outcome).toBe("failed");
    expect(failed.errors.some(error => error.status === 503)).toBe(true);
    expect(failed.cleaned).toEqual(failed.ids);
    expect((await new Lobby(client).get(sentinel.row.id)).playerName).toBe("untouched sentinel");
    expect((await fetch(new URL(sessionPath(sentinel.row.id), target), { method: "HEAD" })).status).toBe(200);
    await deleteSession(client, sentinel.row.id); await client.remove(sessionPath(sentinel.row.id));
  } finally { await mf.dispose(); }
}, 90000);
