// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { testScratch } from "../helpers/scratch";
import { Miniflare } from "miniflare";
import { bundleWorker } from "../../scripts/bundle-worker";
import { createEngine } from "../../engine/src/engine.js";
import { SNAPSHOT_INTERVAL } from "../../src/streams/snapshots";
import { recording, createHeadless, wad, wasmBinary } from "../helpers/recording";
import { snapshotEntries, snapshotBytes } from "../helpers/snapshots";
import { initialStats, replayPages } from "../../src/projection/stats";
import { concat, encode } from "../../src/streams/protocol";
import type { StateEvent } from "../../src/streams/state";
import { idOf, statsOf } from "../helpers/state";
import type { StatsRow } from "../../src/streams/v2";
import {
  ProtocolClient,
  createSession,
  forkSession,
  SessionReader,
  SnapshotStore,
  deleteSession,
  sessionPath,
  batchPath,
  indexPath,
  snapshotPath,
  familyOf,
  isFamilyId,
} from "../../src/streams";
const scratch = await testScratch("topology");
const binary = { "Content-Type": "application/octet-stream" };
const { identity, frames } = await recording(300, false);
const until = async <A>(probe: () => Promise<A | undefined>, label: string): Promise<A> => {
  for (let n = 0; n < (label.startsWith("idle") ? 2000 : 250); n++) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
};
type Score = { key: string; value: StatsRow };
async function harness(snapshotInterval?: number, serialFrameWake = false) {
  const root = await mkdtemp(`${scratch}/workerd-`);
  const scriptPath = await bundleWorker("test/topology/probe-worker.ts", `${root}/bundle`);
  const start = () =>
    new Miniflare({
      name: "doom-test",
      rootPath: root,
      modulesRoot: `${root}/bundle`,
      modules: [
        { type: "ESModule", path: scriptPath },
        { type: "CompiledWasm", path: `${root}/bundle/doom.wasm` },
      ],
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      cf: false,
      assets: {
        directory: new URL("../../dist", import.meta.url).pathname,
        binding: "ASSETS",
        routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      },
      durableObjects: {
        STREAMS: { className: "DoomStreams", useSQLite: true },
        GAMES: { className: serialFrameWake ? "DoomGamesSerial" : "DoomGames", useSQLite: true },
        REPLAYS: { className: "DoomReplay", useSQLite: true },
        LOBBY: { className: "DoomLobby", useSQLite: true },
      },
      durableObjectsPersist: `${root}/state`,
      bindings:
        snapshotInterval === undefined ? {} : { DOOM_SNAPSHOT_INTERVAL: String(snapshotInterval) },
    });
  let mf = start();
  await mf.ready;
  const send = (path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) =>
    mf.dispatchFetch(`https://demo/${path.replace(/^\//, "")}`, init);
  const stub = async (binding: string, name: string) => {
    const ns = await mf.getDurableObjectNamespace(binding);
    return ns.get(ns.idFromName(name));
  };
  let requests = 0;
  const client = new ProtocolClient("https://demo/", async (input, init) => {
    requests++;
    const request = new Request(input, init);
    if (request.url.includes("/bootstrap/")) ids.add(request.url.split("/").at(-1)!);
    const response = await mf.dispatchFetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
    });
    return new Response(response.status === 204 ? null : await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  });
  const ids = new Set<string>();
  const scores = async (): Promise<{ key: string; value: StatsRow & { live: boolean } }[]> =>
    (
      await Promise.all(
        [...ids].map(async (id) => {
          const events = await client.json<StateEvent<any>>(`doom/v2/games/${id}`);
          const live = events.filter((e) => e.type === "presence").at(-1)?.value?.live ?? false;
          return events
            .filter((e) => e.type === "stats" && e.value)
            .map((e) => ({ key: id, value: { ...e.value, live } as StatsRow & { live: boolean } }));
        }),
      )
    ).flat();
  const entriesClient = new ProtocolClient("https://internal/__entries/", async (input, init) => {
    const request = new Request(input, init),
      owner = await stub("LOBBY", "lobby:v2");
    const response = await owner.fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
    });
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  });
  const entries = <T>() => entriesClient.json<T>("doom/v2/entries");
  const score = (id: string, tic: number, published = tic % 175 === 0) =>
    until(async () => {
      const row = (await scores()).filter((row) => row.key === id).at(-1)?.value;
      const replay = await stub("REPLAYS", `replay:${id}`);
      const probe = (await (await replay.fetch("https://internal/__test/probe")).json()) as {
        engines: { tic: number }[];
      };
      if (!row || (published && row.tic !== tic) || probe.engines[0]?.tic !== tic) return undefined;
      const { live, ...stats } = row;
      return stats;
    }, `score ${id} tic ${tic}`);
  return {
    root,
    send,
    stub,
    client,
    entries,
    entriesClient,
    score,
    scores,
    requests: () => requests,
    runtime: () => mf,
    async restart() {
      await mf.dispose();
      mf = start();
      await mf.ready;
    },
    async stop() {
      await mf.dispose();
    },
  };
}

test("workerd: family placement, mid-batch/snapshot forks, seeks, delete and access policies", async () => {
  const h = await harness(5);
  try {
    const parent = await createSession(h.client, { playerName: "Parent", identity });
    const other = await createSession(h.client, { playerName: "Other", identity });
    expect(isFamilyId(parent.row.id)).toBe(true);
    expect(familyOf(parent.row.id)).not.toBe(familyOf(other.row.id));
    await parent.append(frames.slice(0, 12));
    const store = new SnapshotStore(h.client, parent.row.id);
    await snapshotEntries(h.client, parent.row.id, [5, 10]);
    const child = await forkSession(h.client, parent.row.id, 7, { playerName: "Child" });
    const sibling = await forkSession(h.client, parent.row.id, 10, { playerName: "Sibling" });
    const grandchild = await forkSession(h.client, child.row.id, 6, { playerName: "Grandchild" });
    const owner = `game:${familyOf(parent.row.id)}`;
    for (const writer of [child, sibling, grandchild]) {
      expect(familyOf(writer.row.id)).toBe(familyOf(parent.row.id));
      const family = await h.stub("GAMES", owner);
      for (const path of [sessionPath(writer.row.id), batchPath(writer.row.id)])
        expect((await family.fetch(`https://internal/${path}`, { method: "HEAD" })).status).toBe(
          200,
        );
    }
    expect(`game:${familyOf(other.row.id)}`).not.toBe(owner);
    // Verify actual owners by reading through the named namespace stubs.
    const family = await h.stub("GAMES", owner),
      second = await h.stub("GAMES", `game:${familyOf(other.row.id)}`);
    expect(
      (await family.fetch(`https://internal/${sessionPath(parent.row.id)}`, { method: "HEAD" }))
        .status,
    ).toBe(200);
    expect(
      (await second.fetch(`https://internal/${sessionPath(parent.row.id)}`, { method: "HEAD" }))
        .status,
    ).toBe(404);
    expect(await h.runtime().listDurableObjectIds("GAMES")).toHaveLength(2);
    const reader = await new SessionReader(h.client, grandchild.row.id).catchUp();
    expect(reader.frames).toEqual(frames.slice(0, 6));
    expect((await snapshotEntries(h.client, child.row.id, [5])).map((entry) => entry.tic)).toEqual([
      5,
    ]);
    await snapshotEntries(h.client, grandchild.row.id, [5]);
    expect(await snapshotBytes(h.client, child.row.id, 5)).toEqual(
      await snapshotBytes(h.client, parent.row.id, 5),
    );
    const engine = {
      identity,
      tic: 0,
      snapshot() {
        return { ...identity, tic: this.tic, heap: new Uint8Array([this.tic]) };
      },
      restore(checkpoint: { tic: number }) {
        this.tic = checkpoint.tic;
      },
      step() {
        this.tic++;
        return new Uint8Array(9);
      },
    };
    expect(await reader.seek(engine, 6)).toEqual({ snapshotTic: 5, replayed: 1 });
    await grandchild.append(frames.slice(6, 9));
    await h.score(grandchild.row.id, 9);
    await h.score(child.row.id, 7);
    const before = await h.client.all(sessionPath(parent.row.id));
    const requestCount = h.requests();
    await expect(
      forkSession(h.client, parent.row.id, 1, { id: other.row.id, playerName: "Bad" }),
    ).rejects.toThrow("Cross-family");
    expect(h.requests()).toBe(requestCount); // no write, bootstrap or even read
    const missingId = familyOf(other.row.id) + "_" + "f".repeat(32);
    const native = await h.send(sessionPath(missingId), {
      method: "PUT",
      headers: { ...binary, "Stream-Forked-From": `/${sessionPath(parent.row.id)}` },
    });
    expect(native.status).toBe(404);
    expect(await h.client.all(sessionPath(parent.row.id))).toEqual(before);
    expect((await h.send(sessionPath(missingId), { method: "HEAD" })).status).toBe(404);
    for (const malformed of [
      "a_b",
      parent.row.id.toUpperCase(),
      parent.row.id + "0",
      parent.row.id.replace("_", "-"),
      "%2F",
    ]) {
      expect(
        (await h.send(`doom/v2/sessions/${malformed}`, { method: "PUT", headers: binary })).status,
      ).toBe(400);
      expect((await h.send(`doom/v2/bootstrap/${malformed}`, { method: "POST" })).status).toBe(400);
    }
    expect(await h.runtime().listDurableObjectIds("GAMES")).toHaveLength(2);
    const replay = await h.stub("REPLAYS", `replay:${parent.row.id}`);
    expect(
      (await replay.fetch(`https://internal/__bootstrap/${other.row.id}`, { method: "POST" }))
        .status,
    ).toBe(409);
    for (const path of [
      "__entries/doom/v2/entries",
      `__wake/doom/v2/replay-wake/${parent.row.id}`,
      `__frames/${sessionPath(parent.row.id)}`,
      "__init-lobby",
      `__bootstrap/${parent.row.id}`,
    ])
      expect((await h.send(path, { method: "POST" })).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"])
      expect(
        (
          await h.send("doom/v2/entries", {
            method,
            headers: { "Content-Type": "application/json" },
            body: "[]",
          })
        ).status,
      ).toBe(404);
    expect(
      (
        await h.send(`doom/v2/replay-wake/${parent.row.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "[]",
        })
      ).status,
    ).toBe(405);
    await deleteSession(h.client, grandchild.row.id);
    await deleteSession(h.client, child.row.id);
    for (const path of [batchPath(child.row.id)])
      expect((await h.send(path, { method: "HEAD" })).status).toBe(404);
    expect((await h.send(snapshotPath(parent.row.id, 5), { method: "HEAD" })).status).toBe(200);
    expect((await h.send(sessionPath(child.row.id), { method: "HEAD" })).status).toBe(200);
    for (const path of ["doom/lobby", "doom/sessions/old-game", "doom/arbitrary"]) {
      for (const method of ["GET", "HEAD", "PUT", "POST", "DELETE"])
        expect((await h.send(path, { method })).status).toBe(404);
    }
    expect(await h.runtime().listDurableObjectIds("STREAMS")).toHaveLength(0);
    const retired = await h.stub("STREAMS", "doom");
    expect(
      (await retired.fetch("https://internal/doom/sessions/old-game", { method: "PUT" })).status,
    ).toBe(404);
    expect((await retired.fetch("https://internal/doom/sessions/old-game")).status).toBe(404);
  } finally {
    await h.stop();
  }
}, 60000);

test("workerd: two alarms, duplicate wake, partial frames, sink retry, persisted identity and reacquisition", async () => {
  const h = await harness();
  try {
    const lobby = await h.stub("LOBBY", "lobby:v2");
    await lobby.fetch("https://internal/__test/fail-init", { method: "POST" });
    const id = "c".repeat(32) + "_" + "1".repeat(32);
    expect((await h.send(`doom/v2/bootstrap/${id}`, { method: "POST" })).status).toBe(503);
    expect(await h.runtime().listDurableObjectIds("REPLAYS")).toHaveLength(0);
    // The application repeats bootstrap, including idempotent scores creation.
    const writer = await createSession(h.client, { id, playerName: "Counter", identity });
    await h.score(id, 0);
    const began = Date.now();
    await writer.append(frames.slice(0, 175));
    await h.score(id, 175);
    const game = await h.stub("GAMES", `game:${familyOf(id)}`),
      replay = await h.stub("REPLAYS", `replay:${id}`);
    const gameProbe = (await (await game.fetch("https://internal/__test/probe")).json()) as {
      alarm: number[];
    };
    const replayProbe = (await (await replay.fetch("https://internal/__test/probe")).json()) as {
      alarm: number[];
    };
    await until(
      async () =>
        (await h.entries<any>()).some((e) => e.value?.score?.tic === 175) ? true : undefined,
      "entry 175",
    );
    const sinkProbe = (await (await lobby.fetch("https://internal/__test/probe")).json()) as {
      scoreAt: number;
    };
    const gameAt = gameProbe.alarm.find((time) => time >= began)!;
    const replayAt = replayProbe.alarm.filter((time) => time <= sinkProbe.scoreAt).at(-1)!;
    expect(gameAt).toBeGreaterThanOrEqual(began);
    expect(replayAt).toBeGreaterThanOrEqual(gameAt);
    expect(sinkProbe.scoreAt).toBeGreaterThanOrEqual(replayAt);
    console.log(
      `MEASURED local workerd: family alarm→score=${sinkProbe.scoreAt - gameAt} ms; replay alarm→score=${sinkProbe.scoreAt - replayAt} ms; append start→score=${sinkProbe.scoreAt - began} ms`,
    );
    const wake = await h.client.json<unknown>(`doom/v2/replay-wake/${id}`);
    const wakeBody = JSON.stringify([wake.at(-1)]);
    const headers = {
      "Content-Type": "application/json",
      "Producer-Id": "duplicate-test",
      "Producer-Epoch": "0",
      "Producer-Seq": "0",
    };
    const first = await replay.fetch(`https://internal/__wake/doom/v2/replay-wake/${id}`, {
      method: "POST",
      headers,
      body: wakeBody,
    });
    const second = await replay.fetch(`https://internal/__wake/doom/v2/replay-wake/${id}`, {
      method: "POST",
      headers,
      body: wakeBody,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const wakeRows = await h.client.json(`doom/v2/replay-wake/${id}`);
    expect(wakeRows).toHaveLength(wake.length + 1);
    await Bun.sleep(100);
    expect((await h.scores()).filter((row) => row.key === id).at(-1)?.value.verified).toBe(true);
    // Persist an incomplete frame across a settled projection checkpoint.
    const rowsBefore = (await h.scores()).length;
    await h.client.append(sessionPath(id), frames[175].subarray(0, 8));
    await Bun.sleep(200);
    expect((await h.scores()).length).toBe(rowsBefore);
    expect((await h.scores()).at(-1)?.value.verified).toBe(true);
    await h.restart();
    // Reacquire both owners after restart; the persisted identity builds the fixed trigger.
    expect((await h.send(`doom/v2/replay-wake/${id}`, { method: "HEAD" })).status).toBe(200);
    await h.client.append(sessionPath(id), frames[175].subarray(8));
    await h.score(id, 176);
    const reloaded = await h.stub("REPLAYS", `replay:${id}`);
    expect(
      (
        (await (await reloaded.fetch("https://internal/__test/probe")).json()) as {
          identity: string;
        }
      ).identity,
    ).toBe(id);
    const scoreOffset = (
      await h.entriesClient.request("doom/v2/entries", { method: "HEAD" })
    ).headers.get("Stream-Next-Offset");
    for (let n = 0; n < 2; n++)
      expect(
        (
          await h.send(`doom/v2/bootstrap/${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playerName: "Counter", ...identity }),
          })
        ).status,
      ).toBe(200);
    expect(
      (await h.entriesClient.request("doom/v2/entries", { method: "HEAD" })).headers.get(
        "Stream-Next-Offset",
      ),
    ).toBe(scoreOffset);
    const resumedGame = await h.stub("GAMES", `game:${familyOf(id)}`);
    const quiet = await resumedGame.fetch(
      `https://internal/__test/quiet?path=/${sessionPath(id)}`,
      { method: "POST", body: new Uint8Array([...frames[176], ...frames[177]]) },
    );
    expect(quiet.status).toBe(204);
    expect(
      (
        (await (await resumedGame.fetch("https://internal/__test/probe")).json()) as {
          armed: number | null;
        }
      ).armed,
    ).toBeNull();
    await h.restart();
    // This request, rather than an autonomous crash-repair claim, re-arms durable work.
    expect((await h.send(sessionPath(id), { method: "HEAD" })).status).toBe(200);
    expect((await h.send(`doom/v2/replay-wake/${id}`, { method: "HEAD" })).status).toBe(200);
    await h.score(id, 178);
  } finally {
    await h.stop();
  }
}, 60000);

test("workerd: verified ten-minute replay, trusted cache rebuild, inherited fork scores, drift, and idle deadline", async () => {
  const log = await recording(21525);
  const h = await harness();
  try {
    const writer = await createSession(h.client, {
      playerName: "Ten minutes",
      identity: log.identity,
    });
    const began = performance.now();
    await writer.append(log.frames.slice(0, 21000));
    const row = await h.score(writer.row.id, 21000);
    const coldMs = performance.now() - began;
    const localEngine = await createHeadless(log.identity);
    const expected = await replayPages(
      initialStats(),
      [concat([encode({ ...log.identity, formatVersion: 1 }), ...log.frames.slice(0, 21000)])],
      localEngine,
      writer.row.id,
    );
    expect(row).toEqual(expected.state.row!);
    expect(row).toMatchObject({ kills: 5, deaths: 2, verified: true });
    const replay = await h.stub("REPLAYS", `replay:${writer.row.id}`);
    const probe = (await (await replay.fetch("https://internal/__test/probe")).json()) as {
      engines: unknown[];
    };
    expect(probe.engines[0]).toEqual(log.samples[20999]);
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    const rebuild = performance.now();
    await writer.append(log.frames.slice(21000, 21175));
    const rebuilt = await h.score(writer.row.id, 21175);
    const rebuildMs = performance.now() - rebuild;
    const expectedRebuilt = await replayPages(
      expected.state,
      log.frames.slice(21000, 21175),
      localEngine,
      writer.row.id,
    );
    expect(rebuilt).toEqual(expectedRebuilt.state.row!);
    const child = await forkSession(h.client, writer.row.id, 2100, {
      playerName: "Inherited death",
    });
    const childRow = await h.score(child.row.id, 2100);
    expect(childRow).toMatchObject({ kills: 3, deaths: 1, verified: true });
    // Player heaps cannot be uploaded. Recovery uses only server snapshots.
    await expect(
      h.client.append(snapshotPath(writer.row.id, 21175), new Uint8Array([255])),
    ).rejects.toMatchObject({ status: 405 });
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    await writer.append(log.frames.slice(21175, 21350));
    expect((await h.score(writer.row.id, 21350)).verified).toBe(true);
    const drift = await createSession(h.client, { playerName: "Drift", identity: log.identity });
    const badFrames = log.frames.slice(0, 350).map((frame) => frame.slice());
    badFrames[2][8] ^= 1;
    await drift.append(badFrames);
    expect(await h.score(drift.row.id, 350)).toMatchObject({ verified: false, tic: 350 });
    const resumedAt = performance.now();
    await writer.append(log.frames.slice(21350, 21525));
    expect((await h.score(writer.row.id, 21525)).verified).toBe(true);
    const warmMs = performance.now() - resumedAt;
    console.log(
      `MEASURED local workerd: cold 21000-tic projection append→score=${coldMs.toFixed(1)} ms; snapshot cache-miss +175 tics append→score=${rebuildMs.toFixed(1)} ms; warm 175-tic append→score=${warmMs.toFixed(1)} ms`,
    );
    await until(async () => {
      const latest = (await h.scores()).filter((row) => row.key === writer.row.id).at(-1)?.value;
      return latest?.live === false ? latest : undefined;
    }, "idle row after 30 seconds");
    const idle = (await h.scores()).filter((row) => row.key === writer.row.id).at(-1)!.value;
    expect(idle).toMatchObject({ tic: 21525, live: false, verified: true, kills: 5, deaths: 2 });
  } finally {
    await h.stop();
  }
}, 90000);

test("workerd: non-expiring derived lobby and absolute-expiry games leave idle SQL bounded", async () => {
  const h = await harness(175);
  try {
    const writer = await createSession(h.client, { playerName: "Idle SQL", identity });
    await writer.append(frames.slice(0, 175));
    await h.score(writer.row.id, 175);
    await snapshotEntries(h.client, writer.row.id, [175]);
    for (const path of [
      sessionPath(writer.row.id),
      batchPath(writer.row.id),
      `doom/v2/replay-wake/${writer.row.id}`,
    ]) {
      const head = await h.send(path, { method: "HEAD" });
      expect(head.headers.get("Stream-TTL")).toBeNull();
      expect(Date.parse(head.headers.get("Stream-Expires-At")!) - Date.now()).toBeGreaterThan(
        86_390_000,
      );
    }
    const lobby = await h.stub("LOBBY", "lobby:v2");
    for (const path of ["doom/v2/leaderboard", "__entries/doom/v2/entries"]) {
      const head = await lobby.fetch(`https://internal/${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("Stream-TTL")).toBeNull();
      expect(head.headers.get("Stream-Expires-At")).toBeNull();
    }
    // Exercise browser snapshot reads too: they must leave no TTL touch work.
    expect((await h.send("doom/v2/state-snapshot/leaderboard")).status).toBe(200);
    const owners = await Promise.all([
      h.stub("GAMES", `game:${familyOf(writer.row.id)}`),
      h.stub("REPLAYS", `replay:${writer.row.id}`),
      h.stub("LOBBY", "lobby:v2"),
    ]);
    const counts = () =>
      Promise.all(
        owners.map(
          async (owner) =>
            (
              (await (await owner.fetch("https://internal/__test/probe")).json()) as {
                queries: number;
              }
            ).queries,
        ),
      );
    await Bun.sleep(250);
    const before = await counts();
    for (const count of before) expect(count).toBeGreaterThan(20);
    await Bun.sleep(1000);
    const after = await counts(),
      idle = after.map((count, index) => count - before[index]);
    console.log(
      `MEASURED workerd: idle SQL queries in 1s family/replay/lobby=${JSON.stringify(idle)}`,
    );
    for (const count of idle) expect(count).toBeLessThanOrEqual(5);
  } finally {
    await h.stop();
  }
}, 15000);

test("workerd: steady five-tic commits publish local Game stats and capped lobby entries", async () => {
  const log = await recording(350);
  const h = await harness();
  try {
    const writer = await createSession(h.client, {
      playerName: "Score lag",
      identity: log.identity,
    });
    await h.score(writer.row.id, 0);
    const engine = await createHeadless(log.identity);
    let state = (
      await replayPages(
        initialStats(),
        [encode({ ...log.identity, formatVersion: 1 })],
        engine,
        writer.row.id,
      )
    ).state;
    const game = await h.stub("GAMES", `game:${familyOf(writer.row.id)}`),
      lobby = await h.stub("LOBBY", "lobby:v2");
    const lag: number[] = [],
      append: number[] = [];
    for (let at = 0; at < log.frames.length; at += 5) {
      const next = await replayPages(state, log.frames.slice(at, at + 5), engine, writer.row.id);
      state = next.state;
      const started = performance.now();
      await writer.append(log.frames.slice(at, at + 5));
      append.push(performance.now() - started);
      const expected = next.rows.at(-1);
      if (!expected) continue; // The sparse publication rule deliberately emits nothing here.
      await until(async () => {
        const row = (await h.scores()).filter((row) => row.key === writer.row.id).at(-1)?.value;
        return row?.tic === expected.tic ? row : undefined;
      }, "warm score publication");
      const commit = (await (await game.fetch("https://internal/__test/probe")).json()) as {
        frameAt: number;
      };
      const sink = { scoreAt: Date.now() };
      expect(sink.scoreAt).toBeGreaterThanOrEqual(commit.frameAt);
      lag.push(sink.scoreAt - commit.frameAt);
    }
    expect(lag.length).toBeGreaterThan(10);
    await until(
      async () =>
        (await h.entries<any>()).some(
          (e) => e.value?.id === writer.row.id && e.value.score?.tic === 350,
        )
          ? true
          : undefined,
      "capped entry tail",
    );
    const summaries = (await h.entries<any>()).filter(
      (e) => e.value?.id === writer.row.id && e.value.score,
    );
    const later = summaries.filter((e) => e.value.score.tic > 0);
    expect(later.map((e) => e.value.score.tic)).toEqual([175, 350]);
    lag.sort((a, b) => a - b);
    append.sort((a, b) => a - b);
    const summarize = (values: number[]) => ({
      n: values.length,
      p50: values[Math.floor(values.length * 0.5)],
      p95: values[Math.floor(values.length * 0.95)],
      max: values.at(-1),
    });
    const result = {
      measured: { frameCommitToScoreMs: summarize(lag), fiveTicAppendRequestMs: summarize(append) },
      method:
        "Family POST completion in workerd to Game stats receipt at the client (20 ms polling). Only qualifying stats batches sampled; no exact server write timing inferred.",
    };
    await Bun.write(`${scratch}/projection-lag.json`, JSON.stringify(result, null, 2) + "\n");
    console.log("MEASURED local workerd stats lag: " + JSON.stringify(result));
  } finally {
    await h.stop();
  }
}, 30000);

test("workerd: a lost score response retries producer output without duplicate rows or counter drift", async () => {
  const h = await harness();
  try {
    const writer = await createSession(h.client, { playerName: "Producer retry", identity });
    await h.score(writer.row.id, 0);
    const lobby = await h.stub("LOBBY", "lobby:v2");
    const before = (await (await lobby.fetch("https://internal/__test/probe")).json()) as {
      scorePosts: number;
    };
    await lobby.fetch("https://internal/__test/fail-score-response", { method: "POST" });
    await writer.append(frames.slice(0, 175));
    await h.score(writer.row.id, 175);
    const engineOwner = await h.stub("REPLAYS", `replay:${writer.row.id}`);
    const steps = async () =>
      (
        (await (await engineOwner.fetch("https://internal/__test/probe")).json()) as {
          steps: number;
        }
      ).steps;
    const replayed = await steps();
    expect(replayed).toBe(175);
    await until(async () => {
      const probe = (await (await lobby.fetch("https://internal/__test/probe")).json()) as {
        scorePosts: number;
      };
      return probe.scorePosts >= before.scorePosts + 2 ? true : undefined;
    }, "producer delivery retry");
    const rows = (
      await h.entries<{ key: string; value: import("../../src/streams/v2").EntryRow }>()
    ).filter((row) => row.key === writer.row.id && row.value.score);
    expect([...new Set(rows.map((row) => row.value.score!.tic))]).toEqual([0, 175]);
    expect(rows.filter((row) => row.value.score!.tic === 175)).toHaveLength(1);
    expect(rows.at(-1)?.value.score).toMatchObject({ verified: true, kills: 0, deaths: 0 });
    expect(await steps()).toBe(replayed); // Lobby delivery retries never rerun the engine unit.
    // Continue after the independent lobby retry.
    await writer.append(frames.slice(175, 300));
    expect((await h.score(writer.row.id, 300, false)).verified).toBe(true);
  } finally {
    await h.stop();
  }
}, 15000);

test("workerd: Game socket survives forced hibernation; Leaderboard/polling receive server lifecycle", async () => {
  const { followState, StateRows, Lobby } = await import("../../src/streams");
  const h = await harness(),
    abort = new AbortController(),
    tasks: Promise<void>[] = [];
  try {
    const browser = new ProtocolClient((await h.runtime().ready).href);
    const writer = await createSession(browser, { playerName: "Live HUD", identity });
    const metadata = new StateRows<import("../../src/streams/v2").SessionMetadata>("session");
    const entries = new StateRows<import("../../src/streams/v2").EntryRow>("game");
    let gameSocket: WebSocket | undefined;
    const socketStats = new StateRows<StatsRow>("stats"),
      pollStats = new StateRows<StatsRow>("stats"),
      modes: string[] = [];
    tasks.push(
      followState<StateEvent<any>>(browser, {
        snapshot: "doom/v2/state-snapshot/leaderboard",
        stream: "doom/v2/leaderboard",
        signal: abort.signal,
        onBatch: (e) => entries.apply(e),
        onTransport: (mode) => modes.push(`entries:${mode}`),
      }),
    );
    for (const [state, websocket] of [
      [socketStats, true],
      [pollStats, false],
    ] as const)
      tasks.push(
        followState<StateEvent<any>>(browser, {
          snapshot: `doom/v2/state-snapshot/games/${writer.row.id}`,
          stream: `doom/v2/games/${writer.row.id}`,
          signal: abort.signal,
          websocket,
          socket: websocket ? (url) => (gameSocket = new WebSocket(url)) : undefined,
          onBatch: (e) => {
            state.apply(e);
            metadata.apply(e);
          },
          onTransport: (mode) => modes.push(`${websocket ? "socket" : "poll"}:${mode}`),
        }),
      );
    await until(
      async () =>
        modes.includes("entries:websocket") &&
        modes.includes("socket:websocket") &&
        modes.includes("poll:long-poll")
          ? true
          : undefined,
      "subscriptions",
    );
    await h.runtime().unsafeEvictDurableObject("doom-test", "DoomReplay", {
      name: `replay:${writer.row.id}`,
      webSockets: "hibernate",
    });
    const hibernatedSocket = gameSocket;
    const sent = performance.now();
    await writer.append(frames.slice(0, 175));
    await until(
      async () =>
        socketStats.rows.get(writer.row.id)?.tic === 175 &&
        pollStats.rows.get(writer.row.id)?.tic === 175
          ? true
          : undefined,
      "HUD arrival",
    );
    console.log(
      `MEASURED local workerd two-client smoke: append start→HUD arrival=${(performance.now() - sent).toFixed(1)} ms (175-tic batch; poll resolution 20 ms)`,
    );
    expect(socketStats.rows.get(writer.row.id)).toMatchObject({
      verified: true,
      health: 100,
      kills: 0,
    });
    expect(pollStats.rows.get(writer.row.id)).toEqual(socketStats.rows.get(writer.row.id));
    expect(gameSocket).toBe(hibernatedSocket);
    expect(gameSocket!.readyState).toBe(WebSocket.OPEN);
    expect(modes).not.toContain("socket:long-poll");
    await writer.end();
    await until(
      async () =>
        metadata.rows.get(writer.row.id)?.ended && entries.rows.get(writer.row.id)?.ended
          ? true
          : undefined,
      "end metadata",
    );
    for (const path of [`doom/v2/games/${writer.row.id}`, "doom/v2/leaderboard"])
      for (const method of ["PUT", "POST", "DELETE"]) {
        expect(
          (
            await fetch(new URL(path, browser.baseUrl), {
              method,
              headers: { "Content-Type": "application/json" },
              body: "[]",
            })
          ).status,
        ).toBe(405);
      }
    await deleteSession(browser, writer.row.id);
    await until(
      async () =>
        !metadata.rows.has(writer.row.id) && !entries.rows.has(writer.row.id) ? true : undefined,
      "delete metadata",
    );
    expect(socketStats.rows.has(writer.row.id)).toBe(true);
    await expect(new Lobby(browser).get(writer.row.id)).rejects.toThrow("Session missing");
    await h.runtime().unsafeEvictDurableObject("doom-test", "DoomReplay", {
      name: `replay:${writer.row.id}`,
      webSockets: "hibernate",
    });
    const closed = new Promise<number>((resolve) =>
      gameSocket!.addEventListener(
        "close",
        (event) => {
          abort.abort();
          resolve(event.code);
        },
        { once: true },
      ),
    );
    gameSocket!.send("probe"); // Forwarded message handler rejects non-ping client data.
    expect(await Promise.race([closed, Bun.sleep(2000).then(() => -1)])).toBe(4400);
  } finally {
    abort.abort();
    await Promise.all(tasks);
    await h.stop();
  }
}, 30000);

test("workerd: default 21000-tic server snapshot restores, renders and replays 1000 matching tics", async () => {
  expect(SNAPSHOT_INTERVAL).toBe(21000);
  const log = await recording(22000),
    h = await harness();
  try {
    const writer = await createSession(h.client, {
      playerName: "Server snapshot restore",
      identity: log.identity,
    });
    await writer.append(log.frames);
    const entries = await snapshotEntries(h.client, writer.row.id, [21000]);
    const entry = entries[0],
      bytes = await snapshotBytes(h.client, writer.row.id, entry.tic);
    expect(bytes.length).toBe(entry.size);
    expect(entry.size).toBeLessThanOrEqual(2000000);
    const table = await h.stub("REPLAYS", `replay:${writer.row.id}`);
    const rows = (await (await table.fetch("https://internal/__test/snapshots")).json()) as {
      expires_at: number;
    }[];
    const head = await h.send(`doom/v2/replay-wake/${writer.row.id}`, { method: "HEAD" });
    expect(rows[0].expires_at).toBe(Date.parse(head.headers.get("Stream-Expires-At")!));
    const original = await createEngine(wad, { wasmBinary }),
      restored = await createEngine(wad, { wasmBinary });
    for (const frame of log.frames.slice(0, 21000)) original.step(frame);
    restored.restore(await new SnapshotStore(h.client, writer.row.id).load(entry));
    expect(restored.hash()).toBe(original.hash());
    for (const frame of log.frames.slice(21000)) {
      original.step(frame);
      restored.step(frame);
      restored.render();
      expect(restored.hash()).toBe(original.hash());
      expect(restored.stats()).toEqual(original.stats());
    }
    expect(restored.driftCount).toBe(0);
    const measurement = (
      (await (await table.fetch("https://internal/__test/probe")).json()) as { snapshot: unknown }
    ).snapshot;
    console.log(
      `MEASURED local workerd server snapshot: ${JSON.stringify(measurement)}; browser-style restore + 1000 rendered tics: RNG drift=0, state/hash mismatches=0`,
    );
  } finally {
    await h.stop();
  }
}, 30000);

test("workerd: snapshot endpoints reject writes, retry/restart keeps one row, expiry and gone frames clean up", async () => {
  const h = await harness(175);
  try {
    const writer = await createSession(h.client, { playerName: "Snapshot lifecycle", identity });
    await h.score(writer.row.id, 0);
    const id = writer.row.id,
      replay = await h.stub("REPLAYS", `replay:${id}`),
      lobby = await h.stub("LOBBY", "lobby:v2");
    const rows = async () =>
      (await (
        await (await h.stub("REPLAYS", `replay:${id}`)).fetch("https://internal/__test/snapshots")
      ).json()) as { tic: number; size: number }[];
    const posts = (
      (await (await lobby.fetch("https://internal/__test/probe")).json()) as { scorePosts: number }
    ).scorePosts;
    await lobby.fetch("https://internal/__test/fail-score-response", { method: "POST" });
    await writer.append(frames.slice(0, 175));
    await snapshotEntries(h.client, id, [175]);
    const first = await snapshotBytes(h.client, id, 175);
    await until(
      async () =>
        (
          (await (await lobby.fetch("https://internal/__test/probe")).json()) as {
            scorePosts: number;
          }
        ).scorePosts >=
        posts + 2
          ? true
          : undefined,
      "snapshot unit retry",
    );
    expect((await rows()).map(({ tic, size }) => ({ tic, size }))).toEqual([
      { tic: 175, size: first.length },
    ]);
    expect(await snapshotBytes(h.client, id, 175)).toEqual(first);
    for (const path of [indexPath(id), snapshotPath(id, 175)]) {
      for (const method of ["PUT", "POST", "DELETE", "PATCH", "OPTIONS"])
        expect((await h.send(path, { method })).status).toBe(405);
      const head = await h.send(path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    }
    expect((await h.send(snapshotPath(id, 0))).status).toBe(404);
    for (const path of [
      `doom/v2/server-snapshots/bad`,
      `${indexPath(id)}/-1`,
      `${indexPath(id)}/1.5`,
      `${indexPath(id)}/9007199254740992`,
    ])
      expect((await h.send(path)).status).toBe(400);
    for (const path of [`doom/v2/snapshots/${id}/175`, `doom/v2/snapshot-index/${id}`])
      expect([400, 404]).toContain((await h.send(path, { method: "PUT" })).status);
    await h.restart();
    expect((await h.send(`doom/v2/replay-wake/${id}`, { method: "HEAD" })).status).toBe(200);
    expect(await rows()).toHaveLength(1);
    expect(await snapshotBytes(h.client, id, 175)).toEqual(first);
    const reloaded = await h.stub("REPLAYS", `replay:${id}`);
    await reloaded.fetch("https://internal/__test/expire-snapshots", { method: "POST" });
    expect(await new SnapshotStore(h.client, id).entries()).toEqual([]);
    expect((await h.send(snapshotPath(id, 175))).status).toBe(404);
    // Reads only filter expired rows; the next snapshot write removes them.
    expect(await rows()).toHaveLength(1);
    const next = await recording(350, false);
    await writer.append(next.frames.slice(175));
    await snapshotEntries(h.client, id, [350]);
    expect((await rows()).map((row) => row.tic)).toEqual([350]);
    await h.client.remove(sessionPath(id));
    await until(
      async () => ((await rows()).length === 0 ? true : undefined),
      "gone frames delete snapshots",
    );
  } finally {
    await h.stop();
  }
}, 30000);

test("workerd: bootstrap owns metadata, repeats preserve createdAt, invalid cross-family forks fail", async () => {
  const h = await harness();
  try {
    const writer = await createSession(h.client, { playerName: "  Server name  ", identity });
    expect(writer.row.playerName).toBe("Server name");
    const payload = { ...identity, playerName: "Changed", createdAt: "1900-01-01", ended: true };
    const repeat = () =>
      h.client
        .request(`doom/v2/bootstrap/${writer.row.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        .then((r) => r.json());
    const responses = await Promise.all([repeat(), repeat()]);
    for (const row of responses) expect(row).toEqual(writer.row);
    const events = await h.client.json<StateEvent<any>>(`doom/v2/games/${writer.row.id}`);
    expect(events.filter((e) => e.type === "session")).toHaveLength(1);
    const other = "e".repeat(32) + "_" + "1".repeat(32);
    for (const body of [
      { ...payload, forkedFrom: other, forkTic: 0 },
      { ...payload, playerName: "x".repeat(41) },
      { ...payload, skill: 6 },
      { ...payload, forkTic: 0 },
      { ...payload, episode: 0 },
    ]) {
      expect(
        (
          await h.send(`doom/v2/bootstrap/${writer.row.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
  } finally {
    await h.stop();
  }
}, 15000);

test("workerd: oversized snapshot is skipped while local stats and checkpoint advance", async () => {
  const h = await harness(175);
  try {
    const writer = await createSession(h.client, { playerName: "Oversized", identity });
    await h.score(writer.row.id, 0);
    const replay = await h.stub("REPLAYS", `replay:${writer.row.id}`);
    await replay.fetch("https://internal/__test/oversize", { method: "POST" });
    await writer.append(frames.slice(0, 175));
    expect(await h.score(writer.row.id, 175)).toMatchObject({ tic: 175, verified: true });
    expect(await new SnapshotStore(h.client, writer.row.id).entries()).toEqual([]);
    await writer.append(frames.slice(175, 300));
    await h.score(writer.row.id, 300, false);
    const state = await h.client.json<StateEvent<StatsRow>>(`doom/v2/games/${writer.row.id}`);
    expect(state.filter((e) => e.type === "stats" && e.value?.tic === 175)).toHaveLength(1);
  } finally {
    await h.stop();
  }
}, 15000);

test("workerd: expired local Game input delivers gone and deletes its entry", async () => {
  const h = await harness();
  try {
    const writer = await createSession(h.client, { playerName: "Expiring", identity });
    await h.score(writer.row.id, 0);
    const entries = async () => {
      const { StateRows } = await import("../../src/streams");
      const rows = new StateRows<any>("entry");
      rows.apply(await h.entries());
      return rows.rows;
    };
    await until(
      async () => ((await entries()).has(writer.row.id) ? true : undefined),
      "entry before expiry",
    );
    const replay = await h.stub("REPLAYS", `replay:${writer.row.id}`);
    await replay.fetch("https://internal/__test/expire-game", { method: "POST" });
    await until(
      async () => (!(await entries()).has(writer.row.id) ? true : undefined),
      "gone deletes entry",
    );
    console.log(
      "MEASURED local workerd: expired local Game delivered gone to lobbyEntry and removed its Entries row",
    );
  } finally {
    await h.stop();
  }
}, 15000);

test("workerd: HUD snapshot stays small after 5,000 stats changes and follows changes after its offset", async () => {
  const { followState, StateRows, Lobby } = await import("../../src/streams");
  const h = await harness(),
    abort = new AbortController();
  let task: Promise<void> | undefined;
  try {
    const id = idOf(7000),
      path = `doom/v2/state-snapshot/games/${id}`;
    expect((await h.send(path)).status).toBe(404);
    const metadata = { ...identity, playerName: "Snapshot HUD", forkedFrom: null, forkTic: null };
    await h.client.request(`doom/v2/bootstrap/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    const replay = await h.stub("REPLAYS", `replay:${id}`);
    const seed = (rows: StatsRow[]) =>
      replay.fetch("https://internal/__test/game-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, rows }),
      });
    expect((await seed(Array.from({ length: 5000 }, (_, tic) => statsOf(id, tic)))).status).toBe(
      204,
    );
    const began = performance.now(),
      response = await h.send(path),
      text = await response.text(),
      elapsedMs = performance.now() - began;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const offset = response.headers.get("Stream-Next-Offset")!;
    expect(offset).toBeTruthy();
    const events = JSON.parse(text) as StateEvent<StatsRow>[];
    expect(events.filter((e) => e.value)).toHaveLength(2); // session and latest stats, no presence input
    expect(events[0].headers.control).toBe("snapshot-start");
    expect(events.at(-1)?.headers.control).toBe("snapshot-end");
    expect(events.find((e) => e.type === "stats")?.value?.tic).toBe(4999);
    const history = await h.client.json<StateEvent<StatsRow>>(`doom/v2/games/${id}`);
    const fold = new StateRows<StatsRow>("stats"),
      loaded = new StateRows<StatsRow>("stats");
    fold.apply(history);
    loaded.apply(events);
    expect(loaded.rows).toEqual(fold.rows);
    const measurement = {
      historyStatsRows: 5000,
      snapshotRows: 2,
      snapshotBytes: new TextEncoder().encode(text).length,
      snapshotRequestMs: elapsedMs,
      historyBytes: new TextEncoder().encode(JSON.stringify(history)).length,
      environment:
        "local workerd, synthetic valid stats; HTTP round trip including first table sync",
    };
    await Bun.write(
      `${h.root}/state-snapshot-measurement.json`,
      JSON.stringify(measurement, null, 2),
    );
    console.log(`MEASURED workerd Game snapshot: ${JSON.stringify(measurement)}`);
    const requests: URL[] = [],
      state = new StateRows<StatsRow>("stats");
    const browser = new ProtocolClient((await h.runtime().ready).href, async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      const result = await fetch(input, init);
      if (url.pathname === `/${path}`) {
        // Insert a real write after snapshot completion, before follow begins.
        await result.clone().arrayBuffer();
        expect((await seed([statsOf(id, 5000), statsOf(id, 5000)])).status).toBe(204);
      }
      return result;
    });
    task = followState<StateEvent<StatsRow>>(browser, {
      snapshot: path,
      stream: `doom/v2/games/${id}`,
      signal: abort.signal,
      websocket: false,
      onBatch: (batch) => {
        state.apply(batch);
        if (state.rows.get(id)?.tic === 5000) abort.abort();
      },
    });
    await task;
    expect(requests[0].pathname).toBe(`/${path}`);
    expect(requests[1].searchParams.get("offset")).toBe(offset);
    expect(requests.some((url) => url.searchParams.get("offset") === "-1")).toBe(false);
    expect(state.rows.get(id)?.tic).toBe(5000);
    const before = h.requests();
    expect((await new Lobby(h.client).get(id)).playerName).toBe("Snapshot HUD");
    expect(h.requests() - before).toBe(1);
    for (const method of ["POST", "PUT", "DELETE", "HEAD"])
      expect((await h.send(path, { method })).status).toBe(405);
    expect((await h.send("doom/v2/state-snapshot/games/invalid")).status).toBe(400);
    expect((await h.send("__test/game-events", { method: "POST" })).status).toBe(404);
  } finally {
    abort.abort();
    await task;
    await h.stop();
  }
}, 30000);

test("workerd: cold leaderboard snapshot is empty; 60 server sessions load the newest 50", async () => {
  const h = await harness();
  try {
    const path = "doom/v2/state-snapshot/leaderboard";
    const cold = await h.send(path);
    expect(cold.status).toBe(200);
    expect(await cold.json()).toEqual([
      { headers: { control: "snapshot-start" } },
      { headers: { control: "snapshot-end" } },
    ]);
    const sessions = [];
    for (let n = 1; n <= 60; n++) {
      const row = (await (
        await h.client.request(`doom/v2/bootstrap/${idOf(n)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...identity,
            playerName: `Board ${n}`,
            forkedFrom: null,
            forkTic: null,
          }),
        })
      ).json()) as import("../../src/streams/v2").SessionMetadata;
      sessions.push(row);
    }
    const expected = sessions
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, 50);
    await until(async () => {
      const events = (await (await h.send(path)).json()) as StateEvent<any>[];
      return events.some((e) => e.key === expected[0].id) &&
        events.filter((e) => e.value).length === 50
        ? true
        : undefined;
    }, "leaderboard catches up");
    const began = performance.now(),
      response = await h.send(path),
      text = await response.text(),
      elapsedMs = performance.now() - began;
    const events = JSON.parse(text) as StateEvent<import("../../src/streams/v2").EntryRow>[];
    expect(
      events
        .filter((e) => e.value)
        .map((e) => e.key)
        .sort(),
    ).toEqual(expected.map((e) => e.id).sort());
    expect(events.filter((e) => e.value)).toHaveLength(50);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Stream-Next-Offset")).toBeTruthy();
    const measurement = {
      sessions: 60,
      snapshotRows: 50,
      snapshotBytes: new TextEncoder().encode(text).length,
      snapshotRequestMs: elapsedMs,
      environment:
        "local workerd, real bootstrap session metadata, HTTP round trip after projection catch-up",
    };
    await Bun.write(
      `${h.root}/leaderboard-snapshot-measurement.json`,
      JSON.stringify(measurement, null, 2),
    );
    console.log(`MEASURED workerd Leaderboard snapshot: ${JSON.stringify(measurement)}`);
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"])
      expect((await h.send("doom/v2/entries", { method })).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"])
      expect((await h.send(path, { method })).status).toBe(405);
  } finally {
    await h.stop();
  }
}, 30000);

test("workerd: cold rebuild restores newest snapshot, reuses page suffix and reads only later frames", async () => {
  const log = await recording(450);
  const h = await harness(100);
  try {
    const writer = await createSession(h.client, {
      playerName: "Cold cursor",
      identity: log.identity,
    });
    const id = writer.row.id,
      replay = await h.stub("REPLAYS", `replay:${id}`),
      family = await h.stub("GAMES", `game:${familyOf(id)}`);
    const probe = async () =>
      (await (await replay.fetch("https://internal/__test/probe")).json()) as {
        steps: number;
        engines: unknown[];
      };
    const reads = async () =>
      (
        (await (await family.fetch("https://internal/__test/probe")).json()) as {
          frameReads: { offset: string }[];
        }
      ).frameReads;
    const expected = await replayPages(
      initialStats(),
      [concat([encode({ ...log.identity, formatVersion: 1 }), ...log.frames])],
      await createHeadless(log.identity),
      id,
    );
    await writer.append(log.frames.slice(0, 225));
    await h.score(id, 225, false);
    await snapshotEntries(h.client, id, [100, 200]);
    const before = await probe(),
      readCount = (await reads()).length;
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    await writer.append(log.frames.slice(225, 250));
    await h.score(id, 250, false);
    expect((await probe()).steps - before.steps).toBe(50); // 25 persisted suffix + 25 new
    expect((await reads()).slice(readCount).every((read) => read.offset !== "-1")).toBe(true);
    await writer.append(log.frames.slice(250, 300));
    await h.score(id, 300, false);
    const snapshotOffset = writer.offset;
    await writer.append(log.frames.slice(300, 350));
    await h.score(id, 350);
    const at350 = await probe(),
      reads350 = (await reads()).length;
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    await writer.append(log.frames.slice(350, 450));
    await h.score(id, 450, false);
    const after = await probe();
    expect(after.steps - at350.steps).toBe(150); // snapshot 300 → checkpoint 350 → head 450
    expect(after.engines[0]).toEqual(log.final);
    expect((await h.scores()).filter((row) => row.key === id).at(-1)!.value).toMatchObject(
      expected.rows.at(-1)!,
    );
    expect((await reads()).slice(reads350).map((read) => read.offset)).toContain(snapshotOffset);
    expect((await reads()).slice(reads350).every((read) => read.offset !== "-1")).toBe(true);
    console.log(
      "MEASURED workerd cold recovery: checkpoint 225 from snapshot 200 = 25 suffix steps, 0 prefix reads; checkpoint 350 from snapshot 300 = 50 recovery steps; final stats equal replay from zero",
    );
  } finally {
    await h.stop();
  }
}, 30000);

test("workerd: snapshot recovery preserves partial frames and restores legacy rows without cursors", async () => {
  const h = await harness(100),
    log = await recording(200);
  try {
    const writer = await createSession(h.client, {
      playerName: "Partial recovery",
      identity: log.identity,
    });
    const id = writer.row.id,
      path = sessionPath(id),
      replay = await h.stub("REPLAYS", `replay:${id}`);
    const probe = async () =>
      (await (await replay.fetch("https://internal/__test/probe")).json()) as {
        steps: number;
        engines: unknown[];
      };
    await h.client.append(
      path,
      concat([...log.frames.slice(0, 125), log.frames[125].subarray(0, 4)]),
    );
    await h.score(id, 125, false);
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    await h.client.append(
      path,
      concat([log.frames[125].subarray(4), ...log.frames.slice(126, 150)]),
    );
    await h.score(id, 150, false);
    const at150 = await probe();
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    await h.client.append(path, concat(log.frames.slice(150, 175)));
    await h.score(id, 175);
    const at175 = await probe();
    expect(at175.steps - at150.steps).toBe(75); // snapshot 100 through split frame to checkpoint 150, then 25 new
    expect(at175.engines[0]).toEqual(log.samples[174]);
    await replay.fetch("https://internal/__test/legacy-snapshots", { method: "POST" });
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    await h.client.append(path, concat(log.frames.slice(175)));
    await h.score(id, 200, false);
    const final = await probe();
    expect(final.steps - at175.steps).toBe(100); // legacy restores at 100; prefix is read but never stepped
    expect(final.engines[0]).toEqual(log.final);
  } finally {
    await h.stop();
  }
}, 30000);

test("workerd: engine transaction spike rolls snapshot, stats and checkpoint back together across awaits", async () => {
  const h = await harness(100),
    log = await recording(175);
  try {
    const writer = await createSession(h.client, {
      playerName: "Transaction spike",
      identity: log.identity,
    });
    const id = writer.row.id,
      replay = await h.stub("REPLAYS", `replay:${id}`),
      family = await h.stub("GAMES", `game:${familyOf(id)}`);
    const checkpoint = async () =>
      (await (await replay.fetch("https://internal/__test/checkpoint")).json()) as {
        state: string;
      };
    const snapshots = async () =>
      (await (await replay.fetch("https://internal/__test/snapshots")).json()) as unknown[];
    const transactionUnit = async () =>
      (await (
        await replay.fetch("https://internal/__test/transaction-unit", { method: "POST" })
      ).json()) as { failure: string | null };
    const stage = async (items: Uint8Array[]) => {
      expect(
        (
          await family.fetch(
            `https://internal/__test/quiet?path=${encodeURIComponent("/" + sessionPath(id))}`,
            { method: "POST", body: concat(items) },
          )
        ).status,
      ).toBe(204);
    };
    await h.score(id, 0, false);
    await Bun.sleep(100);
    await stage(log.frames.slice(0, 50));
    expect((await transactionUnit()).failure).toBeNull();
    const before = await checkpoint(),
      beforeStats = (await h.scores()).filter((row) => row.key === id);
    await replay.fetch("https://internal/__test/fail-checkpoint", { method: "POST" });
    await stage(log.frames.slice(50));
    expect((await transactionUnit()).failure).toContain("Cannot write a checkpoint");
    expect(await snapshots()).toEqual([]);
    expect(await checkpoint()).toEqual(before);
    expect((await h.scores()).filter((row) => row.key === id)).toEqual(beforeStats);
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    await replay.fetch("https://internal/__test/allow-checkpoint", { method: "POST" });
    expect((await transactionUnit()).failure).toBeNull();
    const final = await h.score(id, 175);
    expect(final.verified).toBe(true);
    expect(JSON.parse((await checkpoint()).state).tic).toBe(175);
    expect(await snapshots()).toHaveLength(1);
    const expected = await replayPages(
      initialStats(),
      [concat([encode({ ...log.identity, formatVersion: 1 }), ...log.frames])],
      await createHeadless(log.identity),
      id,
    );
    expect(
      (await h.scores())
        .filter((row) => row.key === id)
        .map(({ value: { live, ...stats } }) => stats),
    ).toEqual(expected.rows);
    console.log(
      "MEASURED workerd transaction spike: asynchronous engine creation, remote recovery reads and gzip succeed; injected checkpoint failure rolls back snapshot + stats + checkpoint; retry commits one snapshot and the exact replay row sequence",
    );
  } finally {
    await h.stop();
  }
}, 30000);

test("workerd: sibling frame wakes overlap at concurrency 8 versus the serial default", async () => {
  const measure = async (serial: boolean) => {
    const h = await harness(undefined, serial);
    try {
      const parent = await createSession(h.client, { playerName: "Wake parent", identity });
      await parent.append(frames.slice(0, 5));
      await h.score(parent.row.id, 5, false);
      const siblings = [];
      for (let n = 0; n < 4; n++)
        siblings.push(
          await forkSession(h.client, parent.row.id, 5, { playerName: `Sibling ${n}` }),
        );
      for (const writer of siblings) await h.score(writer.row.id, 5, false);
      await Bun.sleep(100);
      const owners = await Promise.all(
        siblings.map((writer) => h.stub("REPLAYS", `replay:${writer.row.id}`)),
      );
      for (const owner of owners)
        await owner.fetch("https://internal/__test/delay-wake", { method: "POST" });
      const family = await h.stub("GAMES", `game:${familyOf(parent.row.id)}`);
      for (const writer of siblings) {
        const path = encodeURIComponent(`/${sessionPath(writer.row.id)}`);
        expect(
          (
            await family.fetch(`https://internal/__test/quiet?path=${path}`, {
              method: "POST",
              body: concat(frames.slice(5, 10)),
            })
          ).status,
        ).toBe(204);
      }
      const began = performance.now();
      await family.fetch("https://internal/__test/run-wake", { method: "POST" });
      const wakes = await until(async () => {
        const samples = await Promise.all(
          owners.map(
            async (owner) =>
              (
                (await (await owner.fetch("https://internal/__test/probe")).json()) as {
                  wakes: { start: number; end: number }[];
                }
              ).wakes,
          ),
        );
        return samples.every((sample) => sample[0]?.end)
          ? samples.map((sample) => sample[0])
          : undefined;
      }, "sibling wakes");
      const ms = performance.now() - began;
      const events = wakes
        .flatMap((wake) => [
          { at: wake.start, delta: 1 },
          { at: wake.end, delta: -1 },
        ])
        .sort((a, b) => a.at - b.at || a.delta - b.delta);
      let active = 0,
        peak = 0;
      for (const event of events) {
        active += event.delta;
        peak = Math.max(peak, active);
      }
      for (const writer of siblings) await h.score(writer.row.id, 10, false);
      return {
        ms,
        peak,
        spanMs:
          Math.max(...wakes.map((wake) => wake.end)) - Math.min(...wakes.map((wake) => wake.start)),
      };
    } finally {
      await h.stop();
    }
  };
  const serial = await measure(true),
    concurrent = await measure(false);
  console.log(
    `MEASURED local workerd sibling wake delivery, 4 forks with 100ms injected response delay: concurrency 1=${JSON.stringify(serial)}; concurrency 8=${JSON.stringify(concurrent)}`,
  );
  expect(serial.peak).toBe(1);
  expect(concurrent.peak).toBeGreaterThan(1);
  expect(concurrent.spanMs).toBeLessThan(serial.spanMs);
}, 60000);
