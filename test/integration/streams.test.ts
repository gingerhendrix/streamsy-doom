// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createEngine, keys } from "../../engine/src/engine.js";
import { startHost, exposedHeaders } from "../../apps/host-bun/host";
import {
  ProtocolClient, SessionReader, SnapshotStore, Lobby, createSession, forkSession, deleteSession,
  snapshotPath, indexPath, sessionPath, batchPath,
} from "../../src/streams";
const wadPath = process.env.DOOM_WAD ?? fileURLToPath(new URL("../../engine/data/freedoom1.wad", import.meta.url));
const build = fileURLToPath(new URL("../../engine/build/", import.meta.url));
const missing = [wadPath, ...["doom.js", "doom.wasm", "build-id.js"].map(name => build + name)].filter(path => !existsSync(path));
if (missing.length) console.warn(`SKIP real-engine stream integration: missing ${missing.join(", ")}. Run bun run fetch-wad && bun run build:engine, or set DOOM_WAD.`);

for (const v2 of [false, true]) test.skipIf(missing.length > 0)(`real WASM (${v2 ? "v2" : "legacy"}): 5000 tics, live tail, snapshot seek, mid-batch and chained forks, delete`, async () => {
  const parent = v2 ? "a".repeat(32) + "_" + "1".repeat(32) : "parent";
  const childId = v2 ? "a".repeat(32) + "_" + "2".repeat(32) : "child";
  const grandchildId = v2 ? "a".repeat(32) + "_" + "3".repeat(32) : "grandchild";
  const requests: { method: string; path: string; status: number; headers: Headers; live: boolean }[] = [];
  const host = await startHost({ port: 0, database: ":memory:", longPollTimeoutMs: 50,
    onRequest(request, response) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname, status: response.status, headers: request.headers, live: url.searchParams.has("live") });
    },
  });
  const abort = new AbortController();
  let tail: Promise<void> | undefined;
  try {
    const client = new ProtocolClient(host.url);
    const wad = await Bun.file(wadPath).bytes(), wasmBinary = await Bun.file(build + "doom.wasm").bytes();
    const create = () => createEngine(wad, { wasmBinary, skill: 3, episode: 1, map: 1 });
    const player = await create();
    const writer = await createSession(client, { legacy: !v2, id: parent, playerName: "Recorder", identity: player.identity, snapshotInterval: 1500 });
    const liveReader = new SessionReader(client, parent);
    await liveReader.catchUp();
    const liveFrames: Uint8Array[] = [];
    tail = (async () => {
      for await (const event of liveReader.follow(abort.signal)) {
        expect(event.tic).toBe(liveFrames.length + 1);
        expect(event.offset).not.toBe("-1");
        liveFrames.push(event.frame);
        if (liveFrames.length === 5000) break;
      }
    })();
    // Attach an error handler immediately; still await and propagate below.
    tail.catch(() => {});
    const hashes = new Map<number, number>();
    const input = (tic: number) => {
      hashes.set(tic, player.hash());
      const phase = Math.floor(tic / 175) % 8;
      for (const [key, down] of [
        [keys.up, phase < 5], [keys.down, phase === 6], [keys.left, phase === 2 || phase === 7],
        [keys.right, phase === 1 || phase === 5], [keys.strafeLeft, phase === 3], [keys.strafeRight, phase === 4],
        [keys.run, tic % 140 < 70], [keys.fire, tic % 45 < 30], [keys.use, tic % 61 === 0],
      ] as const) player.key(key, down);
      if (tic % 17 === 0) player.render();
    };
    let batchNo = 0;
    while (writer.tic < 5000) {
      await writer.record(player, Math.min([127, 91, 203, 67][batchNo++ % 4], 5000 - writer.tic), input);
    }
    hashes.set(5000, player.hash());
    await tail;
    expect(liveFrames.length).toBe(5000);
    const fresh = await new SessionReader(client, parent).catchUp();
    expect(liveFrames).toEqual(fresh.frames);
    expect(requests.some(request => request.live)).toBe(true);
    expect(fresh.header).toMatchObject({ formatVersion: 1, ...player.identity, forkedFrom: null, forkTic: null });
    const replay = await create();
    for (let i = 0; i < 5000; i++) {
      replay.step(fresh.frames[i]); expect(replay.hash()).toBe(hashes.get(i + 1)!);
    }
    expect(replay.driftCount).toBe(0);
    const parentStore = new SnapshotStore(client, parent);
    const entries = await parentStore.entries();
    expect(entries.map(entry => entry.tic)).toEqual([1500, 3000, 4500]);
    for (const entry of entries) {
      expect(entry.size).toBeLessThan(2_000_000);
      const response = await client.request(snapshotPath(parent, entry.tic), { method: "HEAD" });
      expect(response.headers.get("Stream-Closed")).toBe("true");
      expect(response.headers.get("Stream-TTL")).toBe("86400");
    }
    const seekEngine = await create();
    expect(await fresh.seek(seekEngine, 4321)).toEqual({ snapshotTic: 3000, replayed: 1321 });
    expect(seekEngine.hash()).toBe(hashes.get(4321)!);
    const containing = writer.batches.find(batch => batch.startTic > 3000 && batch.endTic - batch.startTic > 30)!;
    const forkTic = containing.startTic + 17;
    const child = await forkSession(client, parent, forkTic, { id: childId, playerName: "Fork", snapshotInterval: 1500 });
    const forkRequest = requests.find(request => request.method === "PUT" && request.path === `/${sessionPath(childId)}`)!;
    expect(forkRequest.status).toBe(201);
    expect(forkRequest.headers.get("Stream-Fork-Offset")).toBe(containing.before);
    expect(forkRequest.headers.get("Stream-Fork-Sub-Offset")).toBe(String(17 * 9));
    const childReader = await new SessionReader(client, childId).catchUp();
    expect(childReader.frames).toEqual(fresh.frames.slice(0, forkTic));
    const childStore = new SnapshotStore(client, childId);
    expect((await childStore.entries()).map(entry => entry.tic)).toEqual([1500, 3000]);
    for (const entry of await childStore.entries()) {
      expect(await client.all(snapshotPath(childId, entry.tic))).toEqual(await client.all(snapshotPath(parent, entry.tic)));
      expect((await client.request(snapshotPath(childId, entry.tic), { method: "HEAD" })).headers.get("Stream-Closed")).toBe("true");
    }
    const forkEngine = await create();
    expect(await childReader.seek(forkEngine, forkTic)).toEqual({ snapshotTic: 3000, replayed: forkTic - 3000 });
    expect(forkEngine.hash()).toBe(hashes.get(forkTic)!);
    await child.record(forkEngine, 53, tic => {
      for (const key of Object.values(keys)) forkEngine.key(key, false);
      forkEngine.key(keys.right, true); forkEngine.key(keys.fire, tic % 2 === 0);
    });
    await childReader.catchUp();
    expect(childReader.frames.length).toBe(forkTic + 53);
    const continued = await create();
    await childReader.seek(continued, forkTic + 53);
    expect(continued.hash()).toBe(forkEngine.hash());
    expect((await new SessionReader(client, parent).catchUp()).frames).toEqual(fresh.frames);
    const grandchild = await forkSession(client, childId, forkTic + 11, { id: grandchildId, playerName: "Nested fork" });
    const grandReader = await new SessionReader(client, grandchild.row.id).catchUp();
    expect(grandReader.frames).toEqual(childReader.frames.slice(0, forkTic + 11));
    const grandEngine = await create();
    await grandReader.seek(grandEngine, grandchild.tic);
    const comparison = await create();
    await childReader.seek(comparison, grandchild.tic);
    expect(grandEngine.hash()).toBe(comparison.hash());
    await deleteSession(client, grandchildId);
    await deleteSession(client, childId);
    for (const path of [snapshotPath(childId, 1500), snapshotPath(childId, 3000), indexPath(childId), batchPath(childId)]) {
      expect((await fetch(new URL(path, host.url), { method: "HEAD" })).status).toBe(404);
    }
    expect((await client.request(sessionPath(childId), { method: "HEAD" })).status).toBe(200); // TTL policy
    expect((await client.request(snapshotPath(parent, 3000), { method: "HEAD" })).status).toBe(200);
    expect(await new Lobby(client).get(childId)).toMatchObject({ status: "deleted", forkedFrom: parent, forkTic, tickCount: forkTic + 53 });
    await writer.end();
    expect((await new Lobby(client).get(parent)).status).toBe("ended");
    const unexpected = requests.filter(request => request.status >= 400 && !(request.method === "HEAD" && request.status === 404));
    expect(unexpected).toEqual([]);
    const growingReads = requests.filter(request => request.method === "GET");
    expect(growingReads.every(request => request.headers.get("Cache-Control") === "no-cache")).toBe(true);
    console.log(`Stream integration: 5000 matching tics; live batches=${liveReader.reads.length}; seek=3000→4321; fork=${forkTic}, sub-offset=153; snapshot gzip envelope sizes=${entries.map(entry => `${entry.tic}:${entry.size}`).join(", ")}; requests=${requests.length}`);
  } finally {
    abort.abort();
    await tail?.catch(() => {});
    await host.stop();
  }
}, 120_000);

test("host: placeholder/static safety, CORS fork preflight and exposed headers, 2 MB cap", async () => {
  const host = await startHost({ port: 0, database: ":memory:" });
  try {
    expect(await (await fetch(host.url)).text()).toContain("stream host is running");
    expect((await fetch(new URL("/missing.js", host.url))).status).toBe(404);
    expect((await fetch(new URL("/%2e%2e%2fhost.ts", host.url))).status).toBe(404);
    expect((await fetch(new URL("/other/stream", host.url), { method: "PUT" })).status).toBe(405);
    const path = new URL("doom/test", host.url), origin = "http://client.example";
    const preflight = await fetch(path, { method: "OPTIONS", headers: {
      Origin: origin, "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type,stream-forked-from,stream-fork-offset,stream-fork-sub-offset,stream-ttl",
    } });
    expect(preflight.status).toBe(204);
    for (const name of ["stream-forked-from", "stream-fork-offset", "stream-fork-sub-offset", "stream-ttl"])
      expect(preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(name);
    const create = await fetch(path, { method: "PUT", headers: { Origin: origin, "Content-Type": "application/octet-stream" } });
    expect(create.status).toBe(201);
    expect(create.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    for (const name of exposedHeaders) expect(create.headers.get("Access-Control-Expose-Headers")?.toLowerCase()).toContain(name.toLowerCase());
    const tooBig = await fetch(new URL("doom/large", host.url), { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(2_000_001) });
    expect(tooBig.status).toBe(413);
    const fits = await fetch(new URL("doom/fits", host.url), { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Stream-Closed": "true" }, body: new Uint8Array(2_000_000) });
    expect(fits.status).toBe(201);
  } finally { await host.stop(); }
});

test("fresh clients: exact boundary, tic zero, inherited partial-batch fork and fresh index reads", async () => {
  const host = await startHost({ port: 0, database: ":memory:" });
  try {
    const client = new ProtocolClient(host.url);
    const identity = { version: 2, buildId: "test", wadSha256: "test", skill: 3, episode: 1, map: 1 };
    const writer = await createSession(client, { legacy: true, id: "boundaries", playerName: "Test", identity });
    await writer.append([new Uint8Array(9).fill(1), new Uint8Array(9).fill(2), new Uint8Array(9).fill(3)]);
    await writer.append([new Uint8Array(9).fill(4), new Uint8Array(9).fill(5)], { publishLobby: false });
    expect((await new Lobby(client).get("boundaries")).tickCount).toBe(3);
    // The manifest, rather than the deliberately stale lobby count, permits tic 5 forks.
    for (const tic of [0, 3, 5]) {
      await forkSession(client, "boundaries", tic, { id: `at-${tic}`, playerName: "Test" });
      expect((await new SessionReader(client, `at-${tic}`).catchUp()).frames.length).toBe(tic);
    }
    await forkSession(client, "boundaries", 2, { id: "partial", playerName: "Test" });
    await forkSession(client, "partial", 1, { id: "partial-again", playerName: "Test" });
    expect((await new SessionReader(client, "partial-again").catchUp()).frames).toEqual([new Uint8Array(9).fill(1)]);
    const store = new SnapshotStore(client, "boundaries");
    expect(await store.entries()).toEqual([]);
    await store.write({ ...identity, tic: 1, heap: new Uint8Array(64) });
    expect((await store.entries()).map(entry => entry.tic)).toEqual([1]);
    await store.write({ ...identity, tic: 2, heap: new Uint8Array(64).fill(2) });
    expect((await store.entries()).map(entry => entry.tic)).toEqual([1, 2]);
    expect((await store.load((await store.entries())[1])).heap).toEqual(new Uint8Array(64).fill(2));
    // HTTP catch-up is capped at 1000 stored messages; boundaries must survive
    // aggregation and pagination independently of response chunking.
    const paged = await createSession(client, { legacy: true, id: "paged", playerName: "Paging", identity });
    for (let i = 0; i < 1003; i++) await paged.append([new Uint8Array(9).fill(i % 256)]);
    const pagedReader = await new SessionReader(client, "paged").catchUp();
    expect(pagedReader.frames.length).toBe(1003);
    expect(pagedReader.reads.length).toBeGreaterThan(1);
    await forkSession(client, "paged", 1001, { id: "paged-fork", playerName: "Paged fork" });
    expect((await new SessionReader(client, "paged-fork").catchUp()).frames).toEqual(pagedReader.frames.slice(0, 1001));
    await expect(writer.append([new Uint8Array(8)])).rejects.toThrow("9-byte");
    await expect(forkSession(client, "boundaries", 6, { playerName: "Test" })).rejects.toThrow("Invalid fork point");
  } finally { await host.stop(); }
});
