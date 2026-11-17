// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { FixedStep, FrameQueue, Throttle } from "../../apps/web/timing";
test("fixed step preserves time debt and pause excludes background time", () => {
  const clock = new FixedStep(); let tics = 0;
  const step = () => { tics++; };
  clock.advance(0, step); clock.advance(1000, step);
  expect(tics).toBe(8);
  for (let i = 0; i < 8; i++) clock.advance(1000.01, step);
  expect(tics).toBe(35);
  clock.pause(); clock.advance(5000, step); expect(tics).toBe(35);
});
test("queue serializes writes, coalesces backlog, preserves checkpoints and final short batch", async () => {
  let unblock!: () => void, active = 0, max = 0;
  const batches: number[][] = [], snapshots: number[][] = [];
  const queue = new FrameQueue<number>(async (frames, checkpoints) => {
    active++; max = Math.max(max, active); batches.push(frames.map(frame => frame[0])); snapshots.push(checkpoints);
    if (batches.length === 1) await new Promise<void>(resolve => { unblock = resolve; });
    active--;
  });
  queue.push(new Uint8Array([1])); const first = queue.flush();
  queue.push(new Uint8Array([2]), 2); queue.push(new Uint8Array([3]));
  expect(queue.flush()).toBe(first); expect(queue.pending).toBe(3);
  unblock(); await first;
  expect(max).toBe(1); expect(batches).toEqual([[1], [2, 3]]); expect(snapshots).toEqual([[], [2]]); expect(queue.pending).toBe(0);
  queue.push(new Uint8Array([4])); await queue.flush(); expect(batches.at(-1)).toEqual([4]);
});
test("ambiguous failures stop later writes without retry", async () => {
  let calls = 0;
  const queue = new FrameQueue(async () => { calls++; throw new Error("network lost"); });
  queue.push(new Uint8Array(9)); await expect(queue.flush()).rejects.toThrow("network lost");
  queue.push(new Uint8Array(9)); await expect(queue.flush()).rejects.toThrow("network lost"); expect(calls).toBe(1);
});
test("lobby throttle publishes immediately then at most every two seconds", () => {
  const throttle = new Throttle();
  expect([0, 10, 1999, 2000, 2001, 4000].filter(time => throttle.due(time))).toEqual([0, 2000, 4000]);
});
