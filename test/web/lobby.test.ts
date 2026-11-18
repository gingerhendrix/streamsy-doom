// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { StateRows, type StateEvent, followJson, ProtocolClient, createSession, forkSession, deleteSession, Lobby } from "../../src/streams";
import { startHost } from "../../apps/host-bun/host";
import type { SessionMetadata, StatsRow } from "../../src/streams/v2";
import { recording } from "../helpers/recording";

test("both State collections fold upserts, partial updates and deletes independently", () => {
  for (const collection of ["session", "stats"]) {
    const state = new StateRows<{ id: string; name: string; count: number }>(collection);
    const event = (key: string, operation: "upsert" | "update" | "delete", value?: { id?: string; name?: string; count?: number }): StateEvent<{ id: string; name: string; count: number }> => ({ type: collection, key, value, headers: { operation } });
    state.apply([event("a", "upsert", { id: "a", name: "first", count: 1 }), event("b", "upsert", { id: "b", name: "other", count: 2 })]);
    state.apply([event("a", "update", { count: 3 }), { type: "unrelated", key: "a", headers: { operation: "delete" } }]);
    expect(state.rows.get("a")).toEqual({ id: "a", name: "first", count: 3 });
    state.apply([event("b", "delete")]);
    expect([...state.rows.keys()]).toEqual(["a"]);
    state.apply([{ headers: { control: "snapshot-start" } }, event("b", "upsert", { id: "b", name: "snapshot", count: 4 })]);
    state.apply([{ headers: { control: "snapshot-end" } }]);
    expect([...state.rows.keys()]).toEqual(["b"]);
    state.apply([{ headers: { control: "reset" } }]);
    expect(state.rows.size).toBe(0);
  }
});

test("Bun browser fallback receives server scores; v2 lifecycle writes metadata only and deletes State rows", async () => {
  const posts: string[] = [], modes: string[] = [];
  let unsupportedUpgrades = 0;
  const host = await startHost({ port: 0, database: ":memory:", longPollTimeoutMs: 50, onRequest(request, response) {
    if (request.method === "POST") posts.push(new URL(request.url).pathname);
    if (new URL(request.url).searchParams.get("live") === "websocket" && response.status === 426) unsupportedUpgrades++;
  } });
  const abort = new AbortController();
  let follow: Promise<void> | undefined;
  try {
    const { identity, frames } = await recording(175, false);
    const client = new ProtocolClient(host.url), writer = await createSession(client, { playerName: "State client", identity });
    const state = new StateRows<StatsRow>("stats");
    let received!: () => void;
    const updated = new Promise<void>(resolve => { received = resolve; });
    follow = followJson<StateEvent<StatsRow>>(client, `doom/v2/games/${writer.row.id}`, { signal: abort.signal,
      onTransport: mode => modes.push(mode), onBatch: events => {
        state.apply(events);
        if (state.rows.get(writer.row.id)?.tic === 175) received();
      },
    });
    for (let n = 0; n < 100 && !modes.includes("long-poll"); n++) await Bun.sleep(10);
    expect(modes).toContain("long-poll"); // Bun's WebSocket upgrade returns 426.
    expect(unsupportedUpgrades).toBe(1);
    const start = posts.length;
    await writer.append(frames);
    expect(posts.slice(start)).not.toContain("/doom/v2/lobby");
    await Promise.race([updated, Bun.sleep(5000).then(() => { throw new Error("No live fallback score"); })]);
    expect(state.rows.get(writer.row.id)).toMatchObject({ verified: true, tic: 175 });
    const child = await forkSession(client, writer.row.id, 10, { playerName: "Child" });
    await writer.end();
    const events = (await client.json<StateEvent<SessionMetadata>>(`doom/v2/games/${writer.row.id}`)).filter(e => e.type === "session");
    for (const event of events) {
      expect(event.type).toBe("session");
      expect(event.value).not.toHaveProperty("tickCount");
      expect(event.value).not.toHaveProperty("status");
    }
    const sessions = new StateRows<SessionMetadata>("session"); sessions.apply(events);
    expect(sessions.rows.get(writer.row.id)?.ended).toBe(true);
    expect((await new Lobby(client).get(child.row.id)).forkTic).toBe(10);
    expect(writer.tic).toBe(175);
    expect(child.tic).toBe(10);
    await child.append(frames.slice(10, 20));
    expect(child.tic).toBe(20);
    const grandchild = await forkSession(client, child.row.id, 15, { playerName: "Grandchild" });
    expect(grandchild.tic).toBe(15);
    await grandchild.append(frames.slice(15, 18));
    expect(grandchild.tic).toBe(18);
    expect(await new Lobby(client).get(grandchild.row.id)).not.toHaveProperty("tickCount");
    expect(await new Lobby(client).get(grandchild.row.id)).not.toHaveProperty("status");
    await deleteSession(client, child.row.id);
    const deleted = await client.json<StateEvent<SessionMetadata>>(`doom/v2/games/${child.row.id}`);
    expect(deleted.at(-1)).toMatchObject({ type: "session", key: child.row.id, headers: { operation: "delete" } });
    sessions.apply(deleted);
    expect(sessions.rows.has(child.row.id)).toBe(false);
    await expect(new Lobby(client).get(child.row.id)).rejects.toThrow("Session missing");
    await expect(client.append("doom/v2/leaderboard", JSON.stringify([{ type: "stats", key: writer.row.id, value: { kills: 999 }, headers: { operation: "upsert" } }]), "application/json")).rejects.toMatchObject({ status: 405 });
  } finally { abort.abort(); await follow; await host.stop(); }
}, 15000);

test("broken socket resumes at its last control offset and never applies an unconfirmed batch", async () => {
  const abort = new AbortController(), offsets: string[] = [], delivered: number[][] = [];
  const client = new ProtocolClient("https://demo/", async input => {
    const offset = new URL(String(input)).searchParams.get("offset")!; offsets.push(offset);
    const first = offsets.length === 1;
    return new Response(JSON.stringify([first ? 1 : 2]), { headers: {
      "Stream-Next-Offset": first ? "opaque/+one==" : "unrelated:two", "Stream-Up-To-Date": "true",
    } });
  });
  await followJson<number>(client, "doom/v2/entries", { signal: abort.signal,
    onBatch: events => { delivered.push(events); if (events.includes(2)) abort.abort(); },
    socket: url => {
      expect(new URL(url).searchParams.get("offset")).toBe("opaque/+one==");
      const socket = { binaryType: "", onopen: null as null | (() => void), onmessage: null as null | ((event: { data: ArrayBuffer }) => void),
        onclose: null as null | ((event: { code: number }) => void), onerror: null, close() {} };
      queueMicrotask(() => {
        socket.onopen?.();
        // The connection dies after data, before the offset's control frame.
        socket.onmessage?.({ data: new TextEncoder().encode("[99]").buffer });
        socket.onclose?.({ code: 1006 });
      });
      return socket as unknown as WebSocket;
    },
  });
  expect(offsets).toEqual(["-1", "opaque/+one=="]);
  expect(delivered).toEqual([[1], [2]]);
});

test("followState applies a snapshot then uses its opaque offset, including abort before the follow", async () => {
  const { followState } = await import("../../src/streams");
  for (const abortAtSnapshot of [false, true]) {
    const abort = new AbortController(), paths: URL[] = [], state = new StateRows<{ id: string; n: number }>("game");
    const row = (n: number) => ({ type: "game", key: "one", value: { id: "one", n }, headers: { operation: "upsert" } });
    const client = new ProtocolClient("https://demo/", async input => {
      const url = new URL(String(input)); paths.push(url);
      if (paths.length === 1) return Response.json([{ headers: { control: "snapshot-start" } }, row(1), { headers: { control: "snapshot-end" } }], {
        headers: { "Stream-Next-Offset": "opaque/+snapshot==" },
      });
      expect(url.searchParams.get("offset")).toBe("opaque/+snapshot==");
      return Response.json([row(1), row(2)], { headers: { "Stream-Next-Offset": "opaque:next", "Stream-Up-To-Date": "true" } });
    });
    let batches = 0;
    await followState<StateEvent<{ id: string; n: number }>>(client, { snapshot: "state-snapshot", stream: "state", signal: abort.signal, websocket: false,
      onBatch: events => { batches++; state.apply(events); if (abortAtSnapshot || batches === 2) abort.abort(); } });
    expect(paths).toHaveLength(abortAtSnapshot ? 1 : 2);
    expect(state.rows.get("one")?.n).toBe(abortAtSnapshot ? 1 : 2);
  }
});
