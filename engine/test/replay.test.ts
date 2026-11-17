// SPDX-License-Identifier: GPL-2.0-or-later
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createEngine, keys } from "../src/engine.js";

const build = fileURLToPath(new URL("../build/", import.meta.url));
const wadPath = process.env.DOOM_WAD ?? fileURLToPath(new URL("../data/freedoom1.wad", import.meta.url));
const missing = [wadPath, `${build}/doom.js`, `${build}/doom.wasm`, `${build}/build-id.js`].filter(p => !existsSync(p));
if (missing.length) console.warn(`SKIP engine replay: missing ${missing.join(", ")}. Run bun run fetch-wad && bun run build:engine, or set DOOM_WAD.`);

const count = 2500;
const middle = 1100;

test.skipIf(missing.length > 0)("2500 tics: capture, replay from zero, restore in fresh instance, detect drift", async () => {
  const wad = await Bun.file(wadPath).bytes();
  const wasmBinary = await Bun.file(`${build}/doom.wasm`).bytes();
  const create = () => createEngine(wad, { wasmBinary, skill: 3, episode: 1, map: 1 });
  const player = await create();
  expect(player.tic).toBe(0); // Startup must consume no hidden tics.
  const initialHash = player.hash();
  const frames: Uint8Array[] = [];
  const hashes: number[] = [];
  const held = new Map<number, boolean>();
  let snapshot: ReturnType<typeof player.snapshot> | undefined;
  const applyScript = (tic: number) => {
    const phase = Math.floor(tic / 175) % 8;
    const controls = new Map([
      [keys.up, phase < 5], [keys.down, phase === 6],
      [keys.left, phase === 2 || phase === 7], [keys.right, phase === 1 || phase === 5],
      [keys.strafeLeft, phase === 3], [keys.strafeRight, phase === 4],
      [keys.run, tic % 140 < 70], [keys.fire, tic % 45 < 30], [keys.use, tic % 61 === 0],
    ]);
    for (const [key, down] of controls) {
      if ((held.get(key) ?? false) !== down) { player.key(key, down); held.set(key, down); }
    }
  };
  for (let i = 0; i < count; i++) {
    applyScript(i);
    const frame = player.step();
    expect(player.tic).toBe(i + 1);
    expect(frame[8]).toBe(player.prndindex);
    frames.push(frame);
    hashes.push(player.hash());
    // Exercise the framebuffer path with a cadence different from the observer.
    if (i % 17 === 0) {
      const before = player.hash();
      const pixels = player.render();
      expect(pixels.length).toBe(320 * 200 * 4);
      expect(pixels.some((b, index) => index % 4 !== 3 && b !== 0)).toBe(true);
      expect(player.hash()).toBe(before);
    }
    if (player.tic === middle) snapshot = player.snapshot();
  }
  expect(frames.some(f => f[0] > 0 && f[0] < 128)).toBe(true);
  expect(frames.some(f => f[0] > 127)).toBe(true);
  expect(frames.some(f => f[1] !== 0)).toBe(true);
  expect(frames.some(f => f[2] !== 0 || f[3] !== 0)).toBe(true);
  expect(frames.some(f => (f[7] & 1) !== 0)).toBe(true); // Fire.
  expect(frames.some(f => (f[7] & 2) !== 0)).toBe(true); // Use.
  expect(new Set(hashes).size).toBe(count);
  expect(new Set(frames.map(f => f[8])).size).toBeGreaterThan(10);

  const observer = await create();
  expect(observer.hash()).toBe(initialHash);
  for (let i = 0; i < count; i++) {
    expect(observer.step(frames[i])).toEqual(frames[i]);
    expect(observer.hash()).toBe(hashes[i]);
    expect(observer.tic).toBe(i + 1);
    if (i % 41 === 0) observer.render();
  }
  expect(observer.driftCount).toBe(0);

  const restored = await create();
  // Reject snapshots from another build, WAD or game setup before copying memory.
  for (const field of ["buildId", "wadSha256", "skill", "version"]) {
    expect(() => restored.restore({ ...snapshot!, [field]: "different" })).toThrow(/mismatch/);
    expect(restored.tic).toBe(0);
  }
  restored.restore(snapshot!);
  expect(restored.tic).toBe(middle);
  expect(restored.hash()).toBe(hashes[middle - 1]);
  for (let i = middle; i < count; i++) {
    expect(restored.step(frames[i])).toEqual(frames[i]);
    expect(restored.hash()).toBe(hashes[i]);
    expect(restored.tic).toBe(i + 1);
  }
  expect(restored.driftCount).toBe(0);
  // Restore works after advancing too, and the snapshot owns a copy of the heap.
  restored.restore(snapshot!);
  expect(restored.hash()).toBe(hashes[middle - 1]);
  const invalid = frames[middle].slice(); invalid[5] = 1;
  expect(() => restored.step(invalid)).toThrow(/noncanonical/);
  expect(restored.tic).toBe(middle);
  expect(() => restored.key(27, true)).toThrow(/Unsupported/); // Escape/menu is not logged.
  const corrupt = frames[middle].slice(); corrupt[8] ^= 1;
  expect(() => restored.step(corrupt)).toThrow(/Replay drift.*prndindex/);
  expect(restored.driftCount).toBe(1);
  expect(restored.tic).toBe(middle + 1); // Drift reports an already-consumed tic.

  const raw = snapshot!.heap.byteLength;
  const gzip = gzipSync(snapshot!.heap, { level: 9 }).byteLength;
  console.log(`E1M1 tic ${middle}: snapshot raw=${raw} bytes, gzip(level 9)=${gzip} bytes; IWAD SHA-256=${player.identity.wadSha256}; build=${player.identity.buildId}`);
  console.log(`Verified ${count} captured tics, ${count} replayed from zero, ${count - middle} replayed after fresh-instance restore; drift detection passed.`);
}, 120_000);
