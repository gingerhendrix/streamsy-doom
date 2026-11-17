// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { ProtocolClient, createSession, forkSession, SessionReader, SnapshotStore, deleteSession, sessionPath, batchPath, indexPath, snapshotPath, familyOf, isFamilyId } from "../../src/streams";
const scratch = process.env.DOOM_TEST_SCRATCH ?? "/home/gareth/Documents/Personal/scratch/2026-11-17-doom-cross-object-build/batch1";
const binary = { "Content-Type": "application/octet-stream" };
const identity = { version: 2, buildId: "counter", wadSha256: "counter", skill: 3, episode: 1, map: 1 };
const until = async <A>(probe: () => Promise<A | undefined>, label: string): Promise<A> => {
  for (let n = 0; n < 250; n++) { const value = await probe(); if (value !== undefined) return value; await Bun.sleep(20); }
  throw new Error(`Timed out: ${label}`);
};
type Score = { key: string; value: { id: string; tic: number } };
async function harness() {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(`${scratch}/workerd-`);
  const bundle = await Bun.build({ entrypoints: ["test/topology/probe-worker.ts"], outdir: `${root}/bundle`, target: "browser", format: "esm", external: ["cloudflare:workers"] });
  if (!bundle.success) throw new AggregateError(bundle.logs);
  const start = () => new Miniflare({ rootPath: root, modulesRoot: `${root}/bundle`, scriptPath: bundle.outputs[0].path, modules: true, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"], cf: false,
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
  const score = (id: string, tic: number) => until(async () => {
    const row = (await scores()).filter(row => row.key === id).at(-1)?.value;
    return row?.tic === tic ? row : undefined;
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
    await parent.append(Array.from({ length: 12 }, (_, n) => new Uint8Array(9).fill(n)));
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
    expect(reader.frames.map(frame => frame[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect((await new SnapshotStore(h.client, child.row.id).entries()).map(entry => entry.tic)).toEqual([5]);
    expect(await h.client.all(snapshotPath(child.row.id, 5))).toEqual(await h.client.all(snapshotPath(parent.row.id, 5)));
    const engine = { identity, tic: 0, snapshot() { return { ...identity, tic: this.tic, heap: new Uint8Array([this.tic]) }; }, restore(checkpoint: { tic: number }) { this.tic = checkpoint.tic; }, step() { this.tic++; return new Uint8Array(9); } };
    expect(await reader.seek(engine, 6)).toEqual({ snapshotTic: 5, replayed: 1 });
    await grandchild.record(engine, 3);
    expect(engine.tic).toBe(9);
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
    await writer.append(Array.from({ length: 35 }, () => new Uint8Array(9)));
    await h.score(id, 35);
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
    expect((await h.scores()).filter(row => row.key === id).at(-1)?.value.tic).toBe(35);
    // Persist an incomplete frame across a settled projection checkpoint.
    const rowsBefore = (await h.scores()).length;
    await h.client.append(sessionPath(id), new Uint8Array(8));
    await until(async () => (await h.scores()).length > rowsBefore ? true : undefined, "partial-frame checkpoint");
    expect((await h.scores()).at(-1)?.value.tic).toBe(35);
    await h.restart();
    // Reacquire both owners after restart; the persisted identity builds the fixed trigger.
    expect((await h.send(`doom/v2/replay-wake/${id}`, { method: "HEAD" })).status).toBe(200);
    await h.client.append(sessionPath(id), new Uint8Array(1));
    await h.score(id, 36);
    const reloaded = await h.stub("REPLAYS", `replay:${id}`);
    expect((await (await reloaded.fetch("https://internal/__test/probe")).json() as { identity: string }).identity).toBe(id);
    const scoreOffset = (await h.send("doom/v2/scores", { method: "HEAD" })).headers.get("Stream-Next-Offset");
    for (let n = 0; n < 2; n++) expect((await h.send(`doom/v2/bootstrap/${id}`, { method: "POST" })).status).toBe(204);
    expect((await h.send("doom/v2/scores", { method: "HEAD" })).headers.get("Stream-Next-Offset")).toBe(scoreOffset);
    const resumedGame = await h.stub("GAMES", `game:${familyOf(id)}`);
    const quiet = await resumedGame.fetch(`https://internal/__test/quiet?path=/${sessionPath(id)}`, { method: "POST", body: new Uint8Array(18) });
    expect(quiet.status).toBe(204);
    expect((await (await resumedGame.fetch("https://internal/__test/probe")).json() as { armed: number | null }).armed).toBeNull();
    await h.restart();
    // This request, rather than an autonomous crash-repair claim, re-arms durable work.
    expect((await h.send(sessionPath(id), { method: "HEAD" })).status).toBe(200);
    expect((await h.send(`doom/v2/replay-wake/${id}`, { method: "HEAD" })).status).toBe(200);
    await h.score(id, 38);
  } finally { await h.stop(); }
}, 60000);
