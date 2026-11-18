// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { startHost } from "../../apps/host-bun/host";
import { ProtocolClient, createSession, forkSession, familyOf, sessionPath, batchPath, indexPath, snapshotPath, deleteSession, Lobby, SnapshotStore, concat } from "../../src/streams";
import { testScratch } from "../helpers/scratch";
import { snapshotEntries } from "../helpers/snapshots";
import { recording } from "../helpers/recording";
const { identity, frames } = await recording(350, false);
const snapshotScratch = await testScratch("bun-snapshots");
test("Bun v2 API: local projection, exact IDs, read-only scores and reserved mounts", async () => {
  const host = await startHost({ port: 0, database: ":memory:", snapshotInterval: 175 });
  let requests = 0;
  const client = new ProtocolClient(host.url, (input, init) => { requests++; return fetch(input, init); });
  try {
    const valid = "a".repeat(32) + "_" + "1".repeat(32);
    for (const id of ["invalid", "old-game", valid.toUpperCase(), valid + "0", valid.replace("_", "-"), "../escape"]) {
      for (const path of [sessionPath, batchPath, indexPath, (id: string) => snapshotPath(id, 1)]) expect(() => path(id)).toThrow("Invalid v2");
      await expect(createSession(client, { id, playerName: "Bad", identity })).rejects.toThrow("Invalid v2");
      await expect(forkSession(client, valid, 0, { id, playerName: "Bad" })).rejects.toThrow("Invalid v2");
      await expect(forkSession(client, id, 0, { playerName: "Bad" })).rejects.toThrow("Invalid v2");
      await expect(deleteSession(client, id)).rejects.toThrow("Invalid v2");
      expect(requests).toBe(0);
    }
    for (const path of ["doom/lobby", "doom/sessions/old-game", "doom/arbitrary", "game.wad", "freedoom/COPYING.txt"]) {
      for (const method of ["GET", "HEAD", "PUT", "POST", "DELETE"]) {
        const response = await fetch(new URL(path, host.url), { method });
        expect(response.status).toBe(path.startsWith("doom/") || method === "GET" || method === "HEAD" ? 404 : 405);
      }
    }
    expect(await new Lobby(client).rows()).toEqual([]);
    const writer = await createSession(client, { playerName: "Bun", identity });
    const boardHead = await client.request("doom/v2/leaderboard", { method: "HEAD" });
    expect(boardHead.headers.get("Stream-TTL")).toBeNull();
    expect(boardHead.headers.get("Stream-Expires-At")).toBeNull();
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"])
      expect((await fetch(new URL("doom/v2/entries", host.url), { method })).status).toBe(404);
    const unknown = "f".repeat(32) + "_" + "f".repeat(32);
    expect((await fetch(new URL(`doom/v2/state-snapshot/games/${unknown}`, host.url))).status).toBe(404);

    await writer.append(frames.slice(0, 175));
    let rows: { type: string; value: { tic: number } }[] = [];
    for (let n = 0; n < 100; n++) {
      rows = await client.json(`doom/v2/games/${writer.row.id}`);
      if (rows.filter((r: any) => r.type === "stats").at(-1)?.value.tic === 175) break;
      await Bun.sleep(10);
    }
    expect(rows.filter((r: any) => r.type === "stats").at(-1)?.value.tic).toBe(175);
    await snapshotEntries(client, writer.row.id, [175]);
    for (const path of [indexPath(writer.row.id), snapshotPath(writer.row.id, 175)]) {
      for (const method of ["PUT", "POST", "DELETE", "PATCH", "OPTIONS"]) expect((await fetch(new URL(path, host.url), { method })).status).toBe(405);
      const head = await client.request(path, { method: "HEAD" }); expect((await head.arrayBuffer()).byteLength).toBe(0);
    }
    const before = requests;
    await expect(forkSession(client, writer.row.id, 10, { id: "f".repeat(32) + "_" + "1".repeat(32), playerName: "Bad" })).rejects.toThrow("Cross-family");
    expect(requests).toBe(before);
    const child = await forkSession(client, writer.row.id, 10, { playerName: "Child" });
    expect(familyOf(child.row.id)).toBe(familyOf(writer.row.id));
    const response = await fetch(new URL("doom/v2/leaderboard", host.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" });
    expect(response.status).toBe(405);
    expect((await fetch(new URL("__scores/doom/v2/scores", host.url), { method: "POST" })).status).toBe(404);
    expect((await fetch(new URL("doom/v2/sessions/not-valid", host.url), { method: "PUT" })).status).toBe(404);
    expect((await client.request(sessionPath(writer.row.id), { method: "HEAD" })).status).toBe(200);
  } finally { await host.stop(); }
});

test("Bun absolute-expiry sessions, forks and wakes leave the shared family/replay/lobby database idle", async () => {
  const { Database } = await import("bun:sqlite");
  const query = Database.prototype.query;
  let queries = 0;
  Database.prototype.query = function(this: InstanceType<typeof Database>, sql: string) {
    queries++; return query.call(this, sql);
  } as typeof query;
  const host = await startHost({ port: 0, database: ":memory:", snapshotInterval: 175 });
  try {
    const client = new ProtocolClient(host.url);
    const parent = await createSession(client, { playerName: "Idle", identity });
    await parent.append(frames.slice(0, 175));
    const child = await forkSession(client, parent.row.id, 10, { playerName: "Idle child" });
    const parentExpiry = (await client.request(sessionPath(parent.row.id), { method: "HEAD" })).headers.get("Stream-Expires-At")!;
    const childExpiry = (await client.request(sessionPath(child.row.id), { method: "HEAD" })).headers.get("Stream-Expires-At")!;
    expect(Date.parse(childExpiry)).toBeGreaterThan(Date.parse(parentExpiry));
    for (const id of [parent.row.id, child.row.id]) {
      for (const path of [sessionPath(id), `doom/v2/batches/${id}`, `doom/v2/replay-wake/${id}`, `doom/v2/games/${id}`]) {
        const head = await client.request(path, { method: "HEAD" });
        expect(head.headers.get("Stream-TTL")).toBeNull();
        expect(Date.parse(head.headers.get("Stream-Expires-At")!) - Date.now()).toBeGreaterThan(86_390_000);
        expect(Date.parse(head.headers.get("Stream-Expires-At")!) - Date.now()).toBeLessThanOrEqual(86_400_000);
      }
    }
    for (let n = 0; n < 100; n++) {
      const rows = await client.json<{ type: string; value: { tic: number } }>(`doom/v2/games/${parent.row.id}`);
      if (rows.some(row => row.type === "stats" && row.value.tic === 175)) break;
      await Bun.sleep(10);
    }
    await snapshotEntries(client, parent.row.id, [175]);
    await Bun.sleep(250);
    expect(queries).toBeGreaterThan(100); // proves that the SQL probe is active
    const began = queries;
    await Bun.sleep(1000);
    const idle = queries - began;
    console.log(`MEASURED Bun: family/replay/lobby shared database idle SQL queries in 1s=${idle}`);
    expect(idle).toBeLessThanOrEqual(5);
    await Bun.sleep(30_000);
    const idleRows = await client.json<{ key: string; value: import("../../src/streams/v2").EntryRow }>("doom/v2/leaderboard");
    expect(idleRows.filter(row => row.key === parent.row.id).at(-1)?.value).toMatchObject({ live: false, score: { tic: 175, verified: true } });
    expect(idleRows.filter(row => row.key === child.row.id).at(-1)?.value.live).toBe(false);
    await parent.append(frames.slice(175, 350));
    for (let n = 0; n < 100; n++) {
      const rows = await client.json<{ key: string; value: { score: { tic: number }; live: boolean } }>("doom/v2/leaderboard");
      const row = rows.filter(row => row.key === parent.row.id).at(-1)?.value;
      if (row?.score?.tic === 350) { expect(row.live).toBe(true); break; }
      if (n === 99) throw new Error("Bun replay did not resume after idle eviction");
      await Bun.sleep(10);
    }
  } finally { await host.stop(); Database.prototype.query = query; }
}, 40000);


test("Bun snapshot table persists beside streams, expires rows and clears them when frames are gone", async () => {
  const { Database } = await import("bun:sqlite");
  const database = `${snapshotScratch}/host.sqlite`;
  let host = await startHost({ port: 0, database, snapshotInterval: 175 });
  let sql: InstanceType<typeof Database> | undefined;
  try {
    let client = new ProtocolClient(host.url);
    const writer = await createSession(client, { playerName: "Persistent snapshots", identity });
    await writer.append(frames.slice(0, 175));
    const entries = await snapshotEntries(client, writer.row.id, [175]);
    const original = await new SnapshotStore(client, writer.row.id).load(entries[0]);
    await host.stop(); host = await startHost({ port: 0, database, snapshotInterval: 175 }); client = new ProtocolClient(host.url);
    expect(await new SnapshotStore(client, writer.row.id).entries()).toEqual(entries);
    expect(await new SnapshotStore(client, writer.row.id).load(entries[0])).toEqual(original);
    sql = new Database(database);
    sql.query("UPDATE server_snapshots SET expires_at = 0 WHERE id = ?").run(writer.row.id);
    expect(await new SnapshotStore(client, writer.row.id).entries()).toEqual([]);
    expect((await fetch(new URL(snapshotPath(writer.row.id, 175), host.url))).status).toBe(404);
    await client.append(sessionPath(writer.row.id), concat(frames.slice(175)));
    await snapshotEntries(client, writer.row.id, [350]);
    expect(sql.query("SELECT tic FROM server_snapshots WHERE id = ?").all(writer.row.id)).toEqual([{ tic: 350 }]);
    await deleteSession(client, writer.row.id);
    expect(await new SnapshotStore(client, writer.row.id).entries()).toHaveLength(1);
    await client.remove(sessionPath(writer.row.id));
    await snapshotEntries(client, writer.row.id, []);
    expect(sql.query("SELECT count(*) AS n FROM server_snapshots WHERE id = ?").get(writer.row.id)).toEqual({ n: 0 });
  } finally { sql?.close(); await host.stop(); }
}, 15000);

test("Bun bootstrap serializes repeated metadata creation and rejects browser State writes", async () => {
  const host = await startHost({ port: 0, database: ":memory:" });
  try {
    const client = new ProtocolClient(host.url), writer = await createSession(client, { playerName: "  Server-owned  ", identity });
    const path = `doom/v2/bootstrap/${writer.row.id}`, payload = { ...identity, playerName: "Changed", createdAt: "1900-01-01", ended: true };
    const repeat = () => client.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(r => r.json());
    for (const row of await Promise.all([repeat(), repeat()])) expect(row).toEqual(writer.row);
    expect(writer.row.playerName).toBe("Server-owned");
    const { StateRows } = await import("../../src/streams");
    const events = await client.json<any>(`doom/v2/games/${writer.row.id}`);
    expect(events.filter(e => e.type === "session")).toHaveLength(1);
    const sessions = new StateRows<any>("session"); sessions.apply(events);
    expect(sessions.rows.get(writer.row.id).createdAt).not.toBe(payload.createdAt);
    for (const path of [`doom/v2/games/${writer.row.id}`, "doom/v2/leaderboard"]) for (const method of ["PUT", "POST", "DELETE"]) {
      expect((await fetch(new URL(path, host.url), { method, headers: { "Content-Type": "application/json" }, body: "[]" })).status).toBe(405);
    }
    await expect(client.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, forkedFrom: "f".repeat(32) + "_" + "1".repeat(32), forkTic: 0 }) })).rejects.toMatchObject({ status: 400 });
    await expect(client.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).rejects.toMatchObject({ status: 400 });
  } finally { await host.stop(); }
});
