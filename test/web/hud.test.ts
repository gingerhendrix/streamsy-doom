// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { TicClock, HudLatency } from "../../apps/web/hud";
test("HUD samples arrival once, retaining wall time across a paused local clock", () => {
  const clock = new TicClock(), latency = new HudLatency(clock);
  clock.record(10, 100); latency.arrive(10, 15, 400);
  expect(latency.last).toEqual({ tics: 5, ms: 300, median: 300, count: 1 });
  expect(latency.text(50)).toContain("latency 5 tics · 300 ms");
  clock.record(51, 1000); latency.arrive(51, 51, 31000);
  expect(latency.last?.ms).toBe(30000);
  expect(latency.last?.median).toBe(15150);
});
test("unknown and overwritten tic times skip samples and label fork catch-up", () => {
  const clock = new TicClock(2), latency = new HudLatency(clock);
  clock.record(100, 10); clock.record(101, 20); clock.record(102, 30);
  expect(clock.timeOf(100)).toBeUndefined();
  latency.arrive(99, 102, 40);
  expect(latency.last).toBeUndefined(); expect(latency.text(102)).toBe("Server replay catching up · tic 99 of 102");
  latency.arrive(102, 103, 50); expect(latency.last?.count).toBe(1);
});
test("HUD uses a rolling median of twenty, stalls after 350 local tics and clears on arrival", () => {
  const clock = new TicClock(), latency = new HudLatency(clock);
  expect(latency.text(500)).toContain("awaiting stats");
  for (let tic = 1; tic <= 25; tic++) { clock.record(tic, 0); latency.arrive(tic, tic, tic); }
  expect(latency.last).toMatchObject({ median: 15.5, count: 20 });
  expect(latency.stalled(375)).toBe(false); expect(latency.text(376)).toBe("No stats for 351 tics");
  clock.record(376, 100); latency.arrive(376, 376, 110); expect(latency.stalled(376)).toBe(false);
});
test("watch latency clamps independently arriving frames and shows head of game without milliseconds", () => {
  const latency = new HudLatency(); latency.arrive(100, 90, 0);
  expect(latency.text(200)).toBe("Head of game · tic 100 · 0 tics behind the frames in this tab");
  expect(latency.last?.ms).toBeUndefined();
});
