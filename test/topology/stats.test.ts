// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { initialStats, replayPages, accumulate } from "../../src/projection/stats";
import { concat, encode } from "../../src/streams/protocol";
import { createHeadless, recording } from "../helpers/recording";
const id = "a".repeat(32) + "_" + "b".repeat(32);
const log = await recording();
const bytes = concat([encode({ ...log.identity, formatVersion: 1 }), ...log.frames]);

test("headless stats match the browser at every tic, including deaths and restart; reset reuses baseline", async () => {
  const engine = await createHeadless(log.identity);
  let state = initialStats(), beforeRestart = 0, restarted = false;
  for (let n = 0; n < log.frames.length; n++) {
    expect(engine.step(log.frames[n])).toBe(true);
    expect(engine.stats()).toEqual(log.samples[n]);
    const next = accumulate(state, engine.stats(), true, id);
    if (state.last && state.last.kills > engine.stats().kills) {
      expect(next.kills).toBeGreaterThanOrEqual(state.kills); beforeRestart = state.kills; restarted = true;
    }
    state = next;
  }
  expect(restarted).toBe(true); expect(beforeRestart).toBe(5);
  expect(state.kills).toBe(5); expect(state.deaths).toBe(2);
  // A different setting uses the same pre-init baseline, then returns to E1M1.
  engine.reset({ ...log.identity, skill: 1 });
  expect(engine.tic).toBe(0);
  engine.reset(log.identity);
  for (const frame of log.frames) expect(engine.step(frame)).toBe(true);
  expect(engine.stats()).toEqual(log.final);
  await expect(createHeadless({ ...log.identity, buildId: "forged" })).rejects.toThrow("identity mismatch");
});

test("producer row sequence and cumulative checkpoint are independent of byte page and unit size", async () => {
  const engine = await createHeadless(log.identity);
  const expected = await replayPages(initialStats(), [bytes], engine, id);
  for (const size of [1, 8, 9, 47, 2048, 65536]) {
    engine.reset(log.identity);
    let state = initialStats(); const rows = [];
    for (let at = 0; at < bytes.length; at += size) {
      const next = await replayPages(state, [bytes.subarray(at, at + size)], engine, id);
      // Exercise the exact durable JSON checkpoint round trip.
      state = JSON.parse(JSON.stringify(next.state)); rows.push(...next.rows);
    }
    expect(state).toEqual(expected.state); expect(rows).toEqual(expected.rows);
  }
  expect(expected.state.row).toMatchObject({ tic: 21000, kills: 5, deaths: 2, verified: true });
});

test("RNG drift stays unverified while later frames continue; counters reset on map changes", async () => {
  const engine = await createHeadless(log.identity);
  const bad = bytes.slice(); bad[bad.length - 1] ^= 1;
  const result = await replayPages(initialStats(), [bad], engine, id);
  expect(result.state.row).toMatchObject({ tic: 21000, verified: false, kills: 5, deaths: 2 });
  expect(result.rows.at(-1)?.verified).toBe(false);
  const advanced = accumulate(result.state, { ...log.final, tic: 21001, map: 2, leveltime: 1, kills: 1, items: 2, secrets: 1 }, true, id);
  expect(advanced).toMatchObject({ kills: 6, items: result.state.items + 2, secrets: result.state.secrets + 1, verified: false });
});

test("durable projection identities are pinned", async () => {
  const { replayStats, replayIdle } = await import("../../src/projection/stats");
  const { lobbyEntry } = await import("../../src/projection/lobby-entry");
  const { frameWake } = await import("../../src/projection/wake");
  expect([frameWake.id, replayStats.id, replayIdle.id, lobbyEntry.id]).toEqual([
    "doom-v2-frame-wake", "doom-v2-replay", "doom-v2-replay-idle", "doom-v2-lobby-entry",
  ]);
});
test("lobby summary caps stats at 175 tics, flushes session/presence, and deletes on gone", async () => {
  const { entryBatch, initialEntry } = await import("../../src/projection/lobby-entry");
  const { state: engine } = await replayPages(initialStats(), [bytes], await createHeadless(log.identity), id);
  expect(engine.row).not.toHaveProperty("live"); expect(engine.row).not.toHaveProperty("updatedTic");
  const row = { id, playerName: "Player", createdAt: "2026-11-18T00:00:00.000Z", skill: 3, episode: 1, map: 1, ended: false, forkedFrom: null, forkTic: null };
  const event = (type: string, value: object) => ({ type, key: id, value, headers: { operation: "upsert" as const } });
  const first = entryBatch(initialEntry(), [event("session", row), event("stats", { ...engine.row, tic: 0 })], id);
  expect(first.rows).toHaveLength(1);
  let state = first.state;
  for (let tic = 1; tic < 175; tic++) {
    const next = entryBatch(state, [event("stats", { ...engine.row, tic, kills: tic })], id);
    expect(next.rows).toHaveLength(0); state = next.state;
  }
  const boundary = entryBatch(state, [event("stats", { ...engine.row, tic: 175, kills: 175 })], id);
  expect(boundary.rows).toHaveLength(1);
  const idle = entryBatch(boundary.state, [event("stats", { ...engine.row, tic: 176, kills: 176 }), event("presence", { id, live: true })], id);
  expect(idle.rows).toHaveLength(1);
  expect(entryBatch(idle.state, [event("session", { ...row, ended: true })], id).rows).toHaveLength(1);
  expect(entryBatch(idle.state, [{ type: "session", key: id, headers: { operation: "delete" } }], id).rows).toHaveLength(1);
  expect(entryBatch(idle.state, [], id, true).rows).toEqual([{ _tag: "Delete", type: "entry", key: id }]);
  // Producer retry determinism includes the entire durable checkpoint round trip.
  const unit = [event("stats", { ...engine.row, tic: 350 }), event("presence", { id, live: false })];
  expect(entryBatch(idle.state, unit, id)).toEqual(entryBatch(JSON.parse(JSON.stringify(idle.state)), unit, id));
  // Splitting suppressed stats within a bucket converges before the same boundary publication.
  const suppressed = Array.from({ length: 20 }, (_, n) => event("stats", { ...engine.row, tic: 180 + n }));
  const together = entryBatch(boundary.state, suppressed, id);
  let split = boundary.state;
  for (const e of suppressed) split = entryBatch(split, [e], id).state;
  expect(split).toEqual(together.state);
  expect(entryBatch(split, unit, id)).toEqual(entryBatch(together.state, unit, id));
});

test("lobby delivery retry delay starts at one second and caps at thirty", async () => {
  const { Effect, Schedule, Duration } = await import("effect");
  const { lobbyEntry } = await import("../../src/projection/lobby-entry");
  const delays = await Effect.runPromise(Effect.gen(function* () {
    const step = yield* Schedule.toStep(lobbyEntry.retry!.schedule!);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const [, delay] = yield* step(0, undefined); delays.push(Duration.toMillis(delay));
    }
    return delays;
  }));
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]);
});
