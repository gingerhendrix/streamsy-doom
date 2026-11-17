// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { bundleWorker } from "../../scripts/bundle-worker";
import { recording, createHeadless } from "../helpers/recording";
import { initialStats, replayPages } from "../../src/projection/stats";
import { concat, encode } from "../../src/streams/protocol";
import type { StateEvent } from "../../src/streams/state";
import type { StatsRow } from "../../src/streams/v2";
import { ProtocolClient, createSession, forkSession, SessionReader, SnapshotStore, deleteSession, sessionPath, batchPath, indexPath, snapshotPath, familyOf, isFamilyId } from "../../src/streams";
const scratch = process.env.DOOM_TEST_SCRATCH ?? "/home/gareth/Documents/Personal/scratch/2026-11-17-doom-cross-object-build/batch2";
const binary = { "Content-Type": "application/octet-stream" };
const { identity, frames } = await recording(300, false);
const until = async <A>(probe: () => Promise<A | undefined>, label: string): Promise<A> => {
  for (let n = 0; n < (label.startsWith("idle") ? 2000 : 250); n++) { const value = await probe(); if (value !== undefined) return value; await Bun.sleep(20); }
  throw new Error(`Timed out: ${label}`);
};
type Score = { key: string; value: StatsRow };
async function harness() {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(`${scratch}/workerd-`);
  const scriptPath = await bundleWorker("test/topology/probe-worker.ts", `${root}/bundle`);
  const start = () => new Miniflare({ rootPath: root, modulesRoot: `${root}/bundle`,
    modules: [{ type: "ESModule", path: scriptPath }, { type: "CompiledWasm", path: `${root}/bundle/doom.wasm` }], compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"], cf: false,
    assets: { directory: new URL("../../dist", import.meta.url).pathname, binding: "ASSETS", routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } },
    durableObjects: { STREAMS: { className: "DoomStreams", useSQLite: true }, GAMES: { className: "DoomGames", useSQLite: true }, REPLAYS: { className: "DoomReplay", useSQLite: true }, LOBBY: { className: "DoomLobby", useSQLite: true } },
    durableObjectsPersist: `${root}/state`,
  });
  let mf = start();
  await mf.ready;
  const send = (path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) => mf.dispatchFetch(`https://demo/${path.replace(/^\//, "")}`, init);
  const stub = async (binding: string, name: string) => { const ns = await mf.getDurableObjectNamespace(binding); return ns.get(ns.idFromName(name)); };
  let requests = 0;
  const client = new ProtocolClient("https://demo/", async (input, init) => {
    requests++;
    const request = new Request(input, init);
    const response = await mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer() });
    return new Response(response.status === 204 ? null : await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
  });
  const scores = () => client.json<Score>("doom/v2/scores");
  const score = (id: string, tic: number, published = tic % 175 === 0) => until(async () => {
    const row = (await scores()).filter(row => row.key === id).at(-1)?.value;
    const replay = await stub("REPLAYS", `replay:${id}`);
    const probe = await (await replay.fetch("https://internal/__test/probe")).json() as { engines: { tic: number }[] };
    return row && (!published || row.tic === tic) && probe.engines[0]?.tic === tic ? row : undefined;
  }, `score ${id} tic ${tic}`);
  return { root, send, stub, client, score, scores, requests: () => requests, runtime: () => mf,
    async restart() { await mf.dispose(); mf = start(); await mf.ready; }, async stop() { await mf.dispose(); } };
}

test("workerd: family placement, mid-batch/snapshot forks, seeks, delete, legacy and access policies", async () => {
  const h = await harness();
  try {
    const parent = await createSession(h.client, { playerName: "Parent", identity });
    const other = await createSession(h.client, { playerName: "Other", identity });
    expect(isFamilyId(parent.row.id)).toBe(true);
    expect(familyOf(parent.row.id)).not.toBe(familyOf(other.row.id));
    await parent.append(frames.slice(0, 12));
    const store = new SnapshotStore(h.client, parent.row.id);
    for (const tic of [5, 10]) await store.write({ ...identity, tic, heap: new Uint8Array([tic]) });
    const child = await forkSession(h.client, parent.row.id, 7, { playerName: "Child" });
    const sibling = await forkSession(h.client, parent.row.id, 10, { playerName: "Sibling" });
    const grandchild = await forkSession(h.client, child.row.id, 6, { playerName: "Grandchild" });
    const owner = `game:${familyOf(parent.row.id)}`;
    for (const writer of [child, sibling, grandchild]) {
      expect(familyOf(writer.row.id)).toBe(familyOf(parent.row.id));
      const family = await h.stub("GAMES", owner);
      for (const path of [sessionPath(writer.row.id), batchPath(writer.row.id), indexPath(writer.row.id), snapshotPath(writer.row.id, 5)]) expect((await family.fetch(`https://internal/${path}`, { method: "HEAD" })).status).toBe(200);
    }
    expect(`game:${familyOf(other.row.id)}`).not.toBe(owner);
    // Verify actual owners by reading through the named namespace stubs.
    const family = await h.stub("GAMES", owner), second = await h.stub("GAMES", `game:${familyOf(other.row.id)}`);
    expect((await family.fetch(`https://internal/${sessionPath(parent.row.id)}`, { method: "HEAD" })).status).toBe(200);
    expect((await second.fetch(`https://internal/${sessionPath(parent.row.id)}`, { method: "HEAD" })).status).toBe(404);
    expect(await h.runtime().listDurableObjectIds("GAMES")).toHaveLength(2);
    const reader = await new SessionReader(h.client, grandchild.row.id).catchUp();
    expect(reader.frames).toEqual(frames.slice(0, 6));
    expect((await new SnapshotStore(h.client, child.row.id).entries()).map(entry => entry.tic)).toEqual([5]);
    expect(await h.client.all(snapshotPath(child.row.id, 5))).toEqual(await h.client.all(snapshotPath(parent.row.id, 5)));
    const engine = { identity, tic: 0, snapshot() { return { ...identity, tic: this.tic, heap: new Uint8Array([this.tic]) }; }, restore(checkpoint: { tic: number }) { this.tic = checkpoint.tic; }, step() { this.tic++; return new Uint8Array(9); } };
    expect(await reader.seek(engine, 6)).toEqual({ snapshotTic: 5, replayed: 1 });
    await grandchild.append(frames.slice(6, 9));
    await h.score(grandchild.row.id, 9);
    await h.score(child.row.id, 7);
    const before = await h.client.all(sessionPath(parent.row.id));
    const requestCount = h.requests();
    await expect(forkSession(h.client, parent.row.id, 1, { id: other.row.id, playerName: "Bad" })).rejects.toThrow("Cross-family");
    expect(h.requests()).toBe(requestCount); // no write, bootstrap or even read
    const missingId = familyOf(other.row.id) + "_" + "f".repeat(32);
    const native = await h.send(sessionPath(missingId), { method: "PUT", headers: { ...binary, "Stream-Forked-From": `/${sessionPath(parent.row.id)}` } });
    expect(native.status).toBe(404);
    expect(await h.client.all(sessionPath(parent.row.id))).toEqual(before);
    expect((await h.send(sessionPath(missingId), { method: "HEAD" })).status).toBe(404);
    for (const malformed of ["a_b", parent.row.id.toUpperCase(), parent.row.id + "0", parent.row.id.replace("_", "-"), "%2F"]) {
      expect((await h.send(`doom/v2/sessions/${malformed}`, { method: "PUT", headers: binary })).status).toBe(400);
      expect((await h.send(`doom/v2/bootstrap/${malformed}`, { method: "POST" })).status).toBe(400);
    }
    expect(await h.runtime().listDurableObjectIds("GAMES")).toHaveLength(2);
    const replay = await h.stub("REPLAYS", `replay:${parent.row.id}`);
    expect((await replay.fetch(`https://internal/__bootstrap/${other.row.id}`, { method: "POST" })).status).toBe(409);
    for (const path of ["__scores/doom/v2/scores", `__wake/doom/v2/replay-wake/${parent.row.id}`, `__frames/${sessionPath(parent.row.id)}`, "__init-scores", `__bootstrap/${parent.row.id}`]) expect((await h.send(path, { method: "POST" })).status).toBe(404);
    for (const method of ["POST", "PUT", "DELETE"]) expect((await h.send("doom/v2/scores", { method, headers: { "Content-Type": "application/json" }, body: "[]" })).status).toBe(405);
    expect((await h.send(`doom/v2/replay-wake/${parent.row.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" })).status).toBe(405);
    await deleteSession(h.client, grandchild.row.id);
    await deleteSession(h.client, child.row.id);
    for (const path of [snapshotPath(child.row.id, 5), batchPath(child.row.id), indexPath(child.row.id)]) expect((await h.send(path, { method: "HEAD" })).status).toBe(404);
    expect((await h.send(snapshotPath(parent.row.id, 5), { method: "HEAD" })).status).toBe(200);
    expect((await h.send(sessionPath(child.row.id), { method: "HEAD" })).status).toBe(200);
    const legacy = await createSession(h.client, { legacy: true, id: "old-game", playerName: "Old", identity });
    await legacy.append([new Uint8Array(9)]);
    const legacyChild = await forkSession(h.client, legacy.row.id, 1, { playerName: "Old fork" });
    expect(sessionPath(legacyChild.row.id)).toStartWith("doom/sessions/");
    expect(await h.runtime().listDurableObjectIds("STREAMS")).toHaveLength(1);
    expect((await new SessionReader(h.client, legacyChild.row.id).catchUp()).frames).toHaveLength(1);
  } finally { await h.stop(); }
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
    const game = await h.stub("GAMES", `game:${familyOf(id)}`), replay = await h.stub("REPLAYS", `replay:${id}`);
    const gameProbe = await (await game.fetch("https://internal/__test/probe")).json() as { alarm: number[] };
    const replayProbe = await (await replay.fetch("https://internal/__test/probe")).json() as { alarm: number[] };
    const sinkProbe = await (await lobby.fetch("https://internal/__test/probe")).json() as { scoreAt: number };
    const gameAt = gameProbe.alarm.find(time => time >= began)!;
    const replayAt = replayProbe.alarm.filter(time => time <= sinkProbe.scoreAt).at(-1)!;
    expect(gameAt).toBeGreaterThanOrEqual(began);
    expect(replayAt).toBeGreaterThanOrEqual(gameAt);
    expect(sinkProbe.scoreAt).toBeGreaterThanOrEqual(replayAt);
    console.log(`MEASURED local workerd: family alarm→score=${sinkProbe.scoreAt - gameAt} ms; replay alarm→score=${sinkProbe.scoreAt - replayAt} ms; append start→score=${sinkProbe.scoreAt - began} ms`);
    const wake = await h.client.json<unknown>(`doom/v2/replay-wake/${id}`);
    const wakeBody = JSON.stringify([wake.at(-1)]);
    const headers = { "Content-Type": "application/json", "Producer-Id": "duplicate-test", "Producer-Epoch": "0", "Producer-Seq": "0" };
    const first = await replay.fetch(`https://internal/__wake/doom/v2/replay-wake/${id}`, { method: "POST", headers, body: wakeBody });
    const second = await replay.fetch(`https://internal/__wake/doom/v2/replay-wake/${id}`, { method: "POST", headers, body: wakeBody });
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    const wakeRows = await h.client.json(`doom/v2/replay-wake/${id}`);
    expect(wakeRows).toHaveLength(wake.length + 1);
    await Bun.sleep(100);
    expect((await h.scores()).filter(row => row.key === id).at(-1)?.value.verified).toBe(true);
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
    expect((await (await reloaded.fetch("https://internal/__test/probe")).json() as { identity: string }).identity).toBe(id);
    const scoreOffset = (await h.send("doom/v2/scores", { method: "HEAD" })).headers.get("Stream-Next-Offset");
    for (let n = 0; n < 2; n++) expect((await h.send(`doom/v2/bootstrap/${id}`, { method: "POST" })).status).toBe(204);
    expect((await h.send("doom/v2/scores", { method: "HEAD" })).headers.get("Stream-Next-Offset")).toBe(scoreOffset);
    const resumedGame = await h.stub("GAMES", `game:${familyOf(id)}`);
    const quiet = await resumedGame.fetch(`https://internal/__test/quiet?path=/${sessionPath(id)}`, { method: "POST", body: new Uint8Array([...frames[176], ...frames[177]]) });
    expect(quiet.status).toBe(204);
    expect((await (await resumedGame.fetch("https://internal/__test/probe")).json() as { armed: number | null }).armed).toBeNull();
    await h.restart();
    // This request, rather than an autonomous crash-repair claim, re-arms durable work.
    expect((await h.send(sessionPath(id), { method: "HEAD" })).status).toBe(200);
    expect((await h.send(`doom/v2/replay-wake/${id}`, { method: "HEAD" })).status).toBe(200);
    await h.score(id, 178);
  } finally { await h.stop(); }
}, 60000);

test("workerd: verified ten-minute replay, trusted cache rebuild, inherited fork scores, drift, and idle deadline", async () => {
  const log = await recording(21525);
  const h = await harness();
  try {
    const writer = await createSession(h.client, { playerName: "Ten minutes", identity: log.identity });
    const began = performance.now();
    await writer.append(log.frames.slice(0, 21000));
    const row = await h.score(writer.row.id, 21000);
    const coldMs = performance.now() - began;
    const localEngine = await createHeadless(log.identity);
    const expected = replayPages(initialStats(), [concat([encode({ ...log.identity, formatVersion: 1 }), ...log.frames.slice(0, 21000)])], localEngine, writer.row.id);
    expect(row).toEqual(expected.state.row!);
    expect(row).toMatchObject({ kills: 5, deaths: 2, verified: true });
    const replay = await h.stub("REPLAYS", `replay:${writer.row.id}`);
    const probe = await (await replay.fetch("https://internal/__test/probe")).json() as { engines: unknown[] };
    expect(probe.engines[0]).toEqual(log.samples[20999]);
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    const rebuild = performance.now();
    await writer.append(log.frames.slice(21000, 21175));
    const rebuilt = await h.score(writer.row.id, 21175);
    const rebuildMs = performance.now() - rebuild;
    const expectedRebuilt = replayPages(expected.state, log.frames.slice(21000, 21175), localEngine, writer.row.id);
    expect(rebuilt).toEqual(expectedRebuilt.state.row!);
    const child = await forkSession(h.client, writer.row.id, 2100, { playerName: "Inherited death" });
    const childRow = await h.score(child.row.id, 2100);
    expect(childRow).toMatchObject({ kills: 3, deaths: 1, verified: true });
    // A poisoned player heap is present, but neither initial replay nor rebuild
    // reads snapshot routes: all verification comes from the input timeline.
    await new SnapshotStore(h.client, writer.row.id).write({ ...log.identity, tic: 21175, heap: new Uint8Array([255]) });
    await replay.fetch("https://internal/__test/evict", { method: "POST" });
    await writer.append(log.frames.slice(21175, 21350));
    expect((await h.score(writer.row.id, 21350)).verified).toBe(true);
    const drift = await createSession(h.client, { playerName: "Drift", identity: log.identity });
    const badFrames = log.frames.slice(0, 350).map(frame => frame.slice()); badFrames[2][8] ^= 1;
    await drift.append(badFrames);
    expect(await h.score(drift.row.id, 350)).toMatchObject({ verified: false, tic: 350 });
    const resumedAt = performance.now();
    await writer.append(log.frames.slice(21350, 21525));
    expect((await h.score(writer.row.id, 21525)).verified).toBe(true);
    const warmMs = performance.now() - resumedAt;
    console.log(`MEASURED local workerd: cold 21000-tic projection append→score=${coldMs.toFixed(1)} ms; cache-miss rebuild 21000+175 tics append→score=${rebuildMs.toFixed(1)} ms; warm 175-tic append→score=${warmMs.toFixed(1)} ms`);
    await until(async () => {
      const latest = (await h.scores()).filter(row => row.key === writer.row.id).at(-1)?.value;
      return latest?.live === false ? latest : undefined;
    }, "idle row after 30 seconds");
    const idle = (await h.scores()).filter(row => row.key === writer.row.id).at(-1)!.value;
    expect(idle).toMatchObject({ tic: 21525, live: false, verified: true, kills: 5, deaths: 2 });
  } finally { await h.stop(); }
}, 90000);

test("workerd: absolute expiry leaves idle family, replay and lobby SQL bounded", async () => {
  const h = await harness();
  try {
    const writer = await createSession(h.client, { playerName: "Idle SQL", identity });
    await writer.append(frames.slice(0, 175)); await h.score(writer.row.id, 175);
    for (const path of [sessionPath(writer.row.id), batchPath(writer.row.id), `doom/v2/replay-wake/${writer.row.id}`]) {
      const head = await h.send(path, { method: "HEAD" });
      expect(head.headers.get("Stream-TTL")).toBeNull();
      expect(Date.parse(head.headers.get("Stream-Expires-At")!) - Date.now()).toBeGreaterThan(86_390_000);
    }
    const owners = await Promise.all([h.stub("GAMES", `game:${familyOf(writer.row.id)}`), h.stub("REPLAYS", `replay:${writer.row.id}`), h.stub("LOBBY", "lobby:v2")]);
    const counts = () => Promise.all(owners.map(async owner => (await (await owner.fetch("https://internal/__test/probe")).json() as { queries: number }).queries));
    await Bun.sleep(250);
    const before = await counts(); for (const count of before) expect(count).toBeGreaterThan(20);
    await Bun.sleep(1000);
    const after = await counts(), idle = after.map((count, index) => count - before[index]);
    console.log(`MEASURED workerd: idle SQL queries in 1s family/replay/lobby=${JSON.stringify(idle)}`);
    for (const count of idle) expect(count).toBeLessThanOrEqual(5);
  } finally { await h.stop(); }
}, 15000);

test("workerd: steady five-tic frame commits publish scores through both alarm hops", async () => {
  const log = await recording(350);
  const h = await harness();
  try {
    const writer = await createSession(h.client, { playerName: "Score lag", identity: log.identity });
    await h.score(writer.row.id, 0);
    const engine = await createHeadless(log.identity);
    let state = replayPages(initialStats(), [encode({ ...log.identity, formatVersion: 1 })], engine, writer.row.id).state;
    const game = await h.stub("GAMES", `game:${familyOf(writer.row.id)}`), lobby = await h.stub("LOBBY", "lobby:v2");
    const lag: number[] = [], append: number[] = [];
    for (let at = 0; at < log.frames.length; at += 5) {
      const next = replayPages(state, log.frames.slice(at, at + 5), engine, writer.row.id); state = next.state;
      const started = performance.now();
      await writer.append(log.frames.slice(at, at + 5), { publishLobby: false });
      append.push(performance.now() - started);
      const expected = next.rows.at(-1);
      if (!expected) continue; // The sparse publication rule deliberately emits nothing here.
      await until(async () => {
        const row = (await h.scores()).filter(row => row.key === writer.row.id).at(-1)?.value;
        return row?.tic === expected.tic ? row : undefined;
      }, "warm score publication");
      const commit = await (await game.fetch("https://internal/__test/probe")).json() as { frameAt: number };
      const sink = await (await lobby.fetch("https://internal/__test/probe")).json() as { scoreAt: number };
      expect(sink.scoreAt).toBeGreaterThanOrEqual(commit.frameAt);
      lag.push(sink.scoreAt - commit.frameAt);
    }
    expect(lag.length).toBeGreaterThan(10);
    lag.sort((a, b) => a - b); append.sort((a, b) => a - b);
    const summarize = (values: number[]) => ({ n: values.length, p50: values[Math.floor(values.length * .5)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) });
    const result = { measured: { frameCommitToScoreMs: summarize(lag), fiveTicAppendRequestMs: summarize(append) },
      method: "Same workerd wall clock at family POST completion and lobby score POST completion. Only batches qualifying under the sparse publication rule are sampled; no score-write timing inferred for suppressed batches." };
    await Bun.write(`${scratch}/projection-lag.json`, JSON.stringify(result, null, 2) + "\n");
    console.log("MEASURED local workerd stats lag: " + JSON.stringify(result));
  } finally { await h.stop(); }
}, 30000);

test("workerd: a lost score response retries producer output without duplicate rows or counter drift", async () => {
  const h = await harness();
  try {
    const writer = await createSession(h.client, { playerName: "Producer retry", identity });
    await h.score(writer.row.id, 0);
    const lobby = await h.stub("LOBBY", "lobby:v2");
    const before = await (await lobby.fetch("https://internal/__test/probe")).json() as { scorePosts: number };
    await lobby.fetch("https://internal/__test/fail-score-response", { method: "POST" });
    await writer.append(frames.slice(0, 175));
    await until(async () => {
      const probe = await (await lobby.fetch("https://internal/__test/probe")).json() as { scorePosts: number };
      return probe.scorePosts >= before.scorePosts + 2 ? true : undefined;
    }, "producer delivery retry");
    const rows = (await h.scores()).filter(row => row.key === writer.row.id);
    expect(rows.map(row => row.value.tic)).toEqual([0, 175]);
    expect(rows.at(-1)?.value).toMatchObject({ verified: true, kills: 0, deaths: 0 });
    // Continue after the retry has rebuilt the engine back to its pinned unit.
    await writer.append(frames.slice(175, 300));
    expect((await h.score(writer.row.id, 300, false)).verified).toBe(true);
  } finally { await h.stop(); }
}, 15000);

test("workerd: browser lobby WebSockets and long-poll receive replay-chain scores; public writes/internal routes fail", async () => {
  const { followJson, StateRows } = await import("../../src/streams");
  const h = await harness(), abort = new AbortController();
  const tasks: Promise<void>[] = [];
  try {
    const browser = new ProtocolClient((await h.runtime().ready).href);
    const writer = await createSession(browser, { playerName: "Live lobby", identity });
    const metadata = new StateRows<import("../../src/streams/v2").SessionMetadata>("session");
    const socketScores = new StateRows<StatsRow>("stats"), pollScores = new StateRows<StatsRow>("stats");
    const modes: string[] = [];
    tasks.push(followJson<StateEvent<import("../../src/streams/v2").SessionMetadata>>(browser, "doom/v2/lobby", {
      signal: abort.signal, onBatch: events => metadata.apply(events), onTransport: mode => modes.push(`session:${mode}`),
    }));
    for (const [state, websocket] of [[socketScores, true], [pollScores, false]] as const) {
      tasks.push(followJson<StateEvent<StatsRow>>(browser, "doom/v2/scores", {
        signal: abort.signal, websocket, onBatch: events => state.apply(events), onTransport: mode => modes.push(`${websocket ? "socket" : "poll"}:${mode}`),
      }));
    }
    await until(async () => modes.includes("session:websocket") && modes.includes("socket:websocket") && modes.includes("poll:long-poll") ? true : undefined, "live subscriptions");
    await writer.append(frames.slice(0, 175));
    await until(async () => socketScores.rows.get(writer.row.id)?.tic === 175 && pollScores.rows.get(writer.row.id)?.tic === 175 ? true : undefined, "live replay score");
    expect(socketScores.rows.get(writer.row.id)).toMatchObject({ verified: true, health: 100, kills: 0 });
    expect(pollScores.rows.get(writer.row.id)).toEqual(socketScores.rows.get(writer.row.id));
    await writer.end();
    await until(async () => metadata.rows.get(writer.row.id)?.ended ? true : undefined, "live end metadata");
    const forged = [{ type: "stats", key: writer.row.id, value: { ...socketScores.rows.get(writer.row.id), kills: 999 }, headers: { operation: "upsert" } }];
    await expect(browser.append("doom/v2/scores", JSON.stringify(forged), "application/json")).rejects.toMatchObject({ status: 405 });
    for (const path of ["__scores/doom/v2/scores", `__frames/${sessionPath(writer.row.id)}`, `__wake/doom/v2/replay-wake/${writer.row.id}`, "__init-scores", `__bootstrap/${writer.row.id}`]) {
      for (const method of ["GET", "POST"]) expect((await fetch(new URL(path, browser.baseUrl), { method })).status).toBe(404);
      expect((await h.send(path, { headers: { Upgrade: "websocket" } })).status).toBe(404);
    }
    await deleteSession(browser, writer.row.id);
    await until(async () => !metadata.rows.has(writer.row.id) ? true : undefined, "live State delete");
    // A server-only orphan score cannot resurrect a deleted session in the UI's metadata join.
    expect(socketScores.rows.has(writer.row.id)).toBe(true);
    console.log("MEASURED local workerd: session and score WebSocket upgrades succeeded; both WebSocket and long-poll received replay score tic 175, then live end/delete metadata");
  } finally { abort.abort(); await Promise.all(tasks); await h.stop(); }
}, 30000);
