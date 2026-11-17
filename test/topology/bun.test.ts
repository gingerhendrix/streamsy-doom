// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { startHost } from "../../apps/host-bun/host";
import { ProtocolClient, createSession, forkSession, familyOf, sessionPath, Lobby } from "../../src/streams";
import { recording } from "../helpers/recording";
const { identity, frames } = await recording(350, false);
test("Bun v2 API: local projection, exact IDs, read-only scores and reserved mounts", async () => {
  const host = await startHost({ port: 0, database: ":memory:" });
  let requests = 0;
  const client = new ProtocolClient(host.url, (input, init) => { requests++; return fetch(input, init); });
  try {
    await expect(createSession(client, { id: "invalid", playerName: "Bad", identity })).rejects.toThrow("Invalid v2");
    expect(requests).toBe(0);
    const legacyRow = { id: "legacy-only", playerName: "Old", skill: 3, episode: 1, map: 1,
      createdAt: "2026-11-17", status: "playing" as const, tickCount: 0, forkedFrom: null, forkTic: null };
    await client.create("doom/lobby", JSON.stringify([legacyRow]), "application/json");
    // A direct old watch URL must work before any v2 lobby has been created.
    expect(await new Lobby(client).get(legacyRow.id)).toEqual(legacyRow);
    const writer = await createSession(client, { playerName: "Bun", identity });
    await writer.append(frames.slice(0, 175));
    let rows: { value: { tic: number } }[] = [];
    for (let n = 0; n < 100; n++) {
      rows = await client.json("doom/v2/scores");
      if (rows.at(-1)?.value.tic === 175) break;
      await Bun.sleep(10);
    }
    expect(rows.at(-1)?.value.tic).toBe(175);
    const before = requests;
    await expect(forkSession(client, writer.row.id, 10, { id: "f".repeat(32) + "_" + "1".repeat(32), playerName: "Bad" })).rejects.toThrow("Cross-family");
    expect(requests).toBe(before);
    const child = await forkSession(client, writer.row.id, 10, { playerName: "Child" });
    expect(familyOf(child.row.id)).toBe(familyOf(writer.row.id));
    const response = await fetch(new URL("doom/v2/scores", host.url), { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" });
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
  const host = await startHost({ port: 0, database: ":memory:" });
  try {
    const client = new ProtocolClient(host.url);
    const parent = await createSession(client, { playerName: "Idle", identity });
    await parent.append(frames.slice(0, 175));
    const child = await forkSession(client, parent.row.id, 10, { playerName: "Idle child" });
    const parentExpiry = (await client.request(sessionPath(parent.row.id), { method: "HEAD" })).headers.get("Stream-Expires-At")!;
    const childExpiry = (await client.request(sessionPath(child.row.id), { method: "HEAD" })).headers.get("Stream-Expires-At")!;
    expect(Date.parse(childExpiry)).toBeGreaterThan(Date.parse(parentExpiry));
    for (const id of [parent.row.id, child.row.id]) {
      for (const path of [sessionPath(id), `doom/v2/batches/${id}`, `doom/v2/replay-wake/${id}`]) {
        const head = await client.request(path, { method: "HEAD" });
        expect(head.headers.get("Stream-TTL")).toBeNull();
        expect(Date.parse(head.headers.get("Stream-Expires-At")!) - Date.now()).toBeGreaterThan(86_390_000);
        expect(Date.parse(head.headers.get("Stream-Expires-At")!) - Date.now()).toBeLessThanOrEqual(86_400_000);
      }
    }
    for (let n = 0; n < 100; n++) {
      const rows = await client.json<{ value: { tic: number } }>("doom/v2/scores");
      if (rows.some(row => row.value.tic === 175)) break;
      await Bun.sleep(10);
    }
    await Bun.sleep(250);
    expect(queries).toBeGreaterThan(100); // proves that the SQL probe is active
    const began = queries;
    await Bun.sleep(1000);
    const idle = queries - began;
    console.log(`MEASURED Bun: family/replay/lobby shared database idle SQL queries in 1s=${idle}`);
    expect(idle).toBeLessThanOrEqual(5);
    await Bun.sleep(30_000);
    const idleRows = await client.json<{ key: string; value: { tic: number; live: boolean; verified: boolean } }>("doom/v2/scores");
    expect(idleRows.filter(row => row.key === parent.row.id).at(-1)?.value).toMatchObject({ live: false, tic: 175, verified: true });
    expect(idleRows.filter(row => row.key === child.row.id).at(-1)?.value.live).toBe(false);
    await parent.append(frames.slice(175, 350));
    for (let n = 0; n < 100; n++) {
      const rows = await client.json<{ key: string; value: { tic: number; live: boolean } }>("doom/v2/scores");
      const row = rows.filter(row => row.key === parent.row.id).at(-1)?.value;
      if (row?.tic === 350) { expect(row.live).toBe(true); break; }
      if (n === 99) throw new Error("Bun replay did not resume after idle eviction");
      await Bun.sleep(10);
    }
    const legacy = await createSession(client, { legacy: true, playerName: "Legacy TTL", identity });
    expect((await client.request(sessionPath(legacy.row.id), { method: "HEAD" })).headers.get("Stream-TTL")).toBe("43200");
  } finally { await host.stop(); Database.prototype.query = query; }
}, 40000);
