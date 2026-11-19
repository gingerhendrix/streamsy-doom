// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { testScratch } from "./helpers/scratch";
import { Miniflare } from "miniflare";
import { bundleWorker } from "../scripts/bundle-worker";
import { recording, createHeadless } from "./helpers/recording";
import { concat } from "../src/streams/bytes";
import type { EngineStats } from "../engine/src/engine.js";
const scratch = await testScratch("engine");
const log = await recording(22000);

test("headless stats match browser through deaths, restarts and reuse of the shared baseline", async () => {
  const engine = await createHeadless(log.identity);
  const resets: number[] = [];
  let last: EngineStats | undefined;
  for (let n = 0; n < log.frames.length; n++) {
    expect(engine.step(log.frames[n])).toBe(true);
    const stats = engine.stats();
    expect(stats).toEqual(log.samples[n]);
    if (last && stats.kills < last.kills) resets.push(last.kills);
    last = stats;
  }
  expect(resets).toEqual([3, 2]);
  engine.reset({ ...log.identity, skill: 1 });
  expect(engine.tic).toBe(0);
  engine.reset(log.identity);
  for (const frame of log.frames) expect(engine.step(frame)).toBe(true);
  expect(engine.stats()).toEqual(log.final);
  const bad = log.frames[0].slice();
  bad[8] ^= 1;
  engine.reset(log.identity);
  expect(engine.step(bad)).toBe(false);
  expect(engine.step(log.frames[1])).toBe(true);
  expect(engine.tic).toBe(2);
  expect(() => engine.step(new Uint8Array([0]))).toThrow("9-byte");
  const noncanonical = log.frames[2].slice();
  noncanonical[5] = 1;
  expect(() => engine.step(noncanonical)).toThrow("noncanonical");
  await expect(createHeadless({ ...log.identity, buildId: "forged" })).rejects.toThrow(
    "identity mismatch",
  );
});

test("workerd headless engine starts under nodejs_compat, matches Bun, and measures replay", async () => {
  const root = await mkdtemp(`${scratch}/engine-workerd-`);
  const scriptPath = await bundleWorker("test/helpers/engine-worker.ts", `${root}/bundle`);
  const mf = new Miniflare({
    modulesRoot: `${root}/bundle`,
    modules: [
      { type: "ESModule", path: scriptPath },
      { type: "CompiledWasm", path: `${root}/bundle/doom.wasm` },
    ],
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    assets: {
      directory: new URL("../dist", import.meta.url).pathname,
      binding: "ASSETS",
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    },
    durableObjects: { ENGINE: { className: "EngineProbe", useSQLite: true } },
  });
  try {
    await mf.ready;
    const call = async (path: string, body: string | Uint8Array) => {
      const began = performance.now();
      const response = await mf.dispatchFetch(`https://probe/${path}`, { method: "POST", body });
      expect(response.status).toBe(200);
      const value = (await response.json()) as {
        drift: number;
        stats: EngineStats;
        memoryAvailable: boolean;
      };
      return { ms: performance.now() - began, value };
    };
    const init = await call("init", JSON.stringify(log.identity));
    const replay = await call("reset", concat(log.frames.slice(0, 21000)));
    expect(replay.value.drift).toBe(0);
    expect(replay.value.stats).toEqual(log.samples[20999]);
    const warm: number[] = [];
    for (let at = 21000; at < 22000; at += 5) {
      const result = await call("replay", concat(log.frames.slice(at, at + 5)));
      expect(result.value.drift).toBe(0);
      warm.push(result.ms);
    }
    const final = await call("replay", new Uint8Array());
    expect(final.value.stats).toEqual(log.final);
    const coldRebuild = await call("reset", concat(log.frames.slice(0, 21000)));
    expect(coldRebuild.value.stats).toEqual(replay.value.stats);
    warm.sort((a, b) => a - b);
    const measurements = {
      measured: {
        tics: 21000,
        engineCreationRequestMs: init.ms,
        resetAndReplayRequestMs: replay.ms,
        repeatResetAndReplayRequestMs: coldRebuild.ms,
        warmFiveTicRequests: { n: warm.length, p50: warm[100], p95: warm[190], max: warm.at(-1) },
        drift: replay.value.drift,
        statsMatchBun: true,
        isolateMemoryApiAvailable: replay.value.memoryAvailable,
      },
      inferred: {
        sharedWadBytes: 28795076,
        sharedBaselineBytes: 16777216,
        heapBytesPerEngine: 16777216,
        postInitBaselineBytesPerEngine: 16777216,
      },
      limits:
        "Request round trips, not CPU counters. Reset/replay excludes frame storage and projection alarms. Projection score lag is measured separately in projection-lag.json.",
    };
    await Bun.write(
      `${scratch}/engine-measurements.json`,
      JSON.stringify(measurements, null, 2) + "\n",
    );
    console.log("MEASURED local workerd engine: " + JSON.stringify(measurements));
  } finally {
    await mf.dispose();
  }
}, 30000);
