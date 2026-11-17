// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { startHost } from "../../apps/host-bun/host";
import { ProtocolClient, createSession, forkSession, familyOf, sessionPath, Lobby } from "../../src/streams";
const identity = { version: 2, buildId: "counter", wadSha256: "counter", skill: 3, episode: 1, map: 1 };
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
    await writer.append(Array.from({ length: 21 }, () => new Uint8Array(9)));
    let rows: { value: { tic: number } }[] = [];
    for (let n = 0; n < 100; n++) {
      rows = await client.json("doom/v2/scores");
      if (rows.at(-1)?.value.tic === 21) break;
      await Bun.sleep(10);
    }
    expect(rows.at(-1)?.value.tic).toBe(21);
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
