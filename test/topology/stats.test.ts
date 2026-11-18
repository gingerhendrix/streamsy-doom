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
