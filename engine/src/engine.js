// SPDX-License-Identifier: GPL-2.0-or-later
// This adapter uses only standard JS APIs and runs in browsers, workers and Bun.
import { readStats } from "./stats.js";
export { statNames, readStats } from "./stats.js";
export const keys = Object.freeze({
  up: 0xad,
  down: 0xaf,
  left: 0xac,
  right: 0xae,
  strafeLeft: 0xa0,
  strafeRight: 0xa1,
  use: 0xa2,
  fire: 0xa3,
  run: 0xb6,
  strafe: 0xb8,
});
export async function createEngine(
  wad,
  { skill = 3, episode = 1, map = 1, wasmBinary, print = () => {} } = {},
) {
  for (const [name, value, max] of [
    ["skill", skill, 5],
    ["episode", episode, 4],
    ["map", map, 9],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  }
  if (!(wad instanceof Uint8Array) || wad.length < 12) throw new Error("Expected IWAD bytes");
  if (String.fromCharCode(...wad.subarray(0, 4)) !== "IWAD") throw new Error("Expected an IWAD");
  // Copy ownership: callers cannot change the immutable external WAD after init.
  const wadBytes = wad.slice();
  const wadSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", wadBytes)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const [{ default: factory }, { default: buildId }] = await Promise.all([
    import("../build/doom.js"),
    import("../build/build-id.js"),
  ]);
  const module = await factory({ wasmBinary, print, printErr: print });
  module.wadBytes = wadBytes;
  // IWAD discovery uses the filesystem; actual reads are stateless positional
  // reads of wadBytes, so no JS file cursor or mutable FS state enters snapshots.
  module.FS.writeFile("/doom1.wad", wadBytes);
  if (module._dg_init(skill, episode, map)) throw new Error("Engine initialization failed");
  const baseline = module.HEAPU8.slice();
  const identity = Object.freeze({ version: 2, buildId, wadSha256, skill, episode, map });
  return {
    identity,
    get tic() {
      return module._dg_gametic();
    },
    get prndindex() {
      return module._dg_prndindex();
    },
    get driftCount() {
      return module._dg_drift_count();
    },
    stats() {
      return readStats(module);
    },
    hash() {
      return module._dg_state_hash() >>> 0;
    },
    key(key, down) {
      if (!Number.isInteger(key) || typeof down !== "boolean" || module._dg_key(key, Number(down)))
        throw new Error("Unsupported gameplay key");
    },
    step(injectedFrame) {
      if (injectedFrame !== undefined) {
        if (!(injectedFrame instanceof Uint8Array) || injectedFrame.length !== 9)
          throw new Error("Replay needs a 9-byte frame");
        module.HEAPU8.set(injectedFrame, module._dg_input());
      }
      const result = module._dg_step(Number(injectedFrame !== undefined));
      if (result < 0) throw new Error("Invalid step or noncanonical frame");
      const frame = module.HEAPU8.slice(module._dg_frame(), module._dg_frame() + 9);
      if (result)
        throw new Error(
          `Replay drift at tic ${module._dg_gametic()}: expected prndindex ${injectedFrame[8]}, got ${frame[8]}`,
        );
      return frame;
    },
    snapshot() {
      // Only call between exports, with no WASM stack frame active.
      const heap = module.HEAPU8.slice();
      for (let i = 0; i < heap.length; i++) heap[i] ^= baseline[i];
      return { ...identity, tic: module._dg_gametic(), heap };
    },
    restore(snapshot) {
      for (const [name, value] of Object.entries(identity)) {
        if (snapshot[name] !== value) throw new Error(`Snapshot ${name} mismatch`);
      }
      if (!(snapshot.heap instanceof Uint8Array) || snapshot.heap.length !== module.HEAPU8.length)
        throw new Error("Snapshot heap size mismatch");
      // Memory size is fixed. A fresh instance has the same indirect function
      // table and stack pointer; every mutable simulation field lives in memory.
      for (let i = 0; i < baseline.length; i++) module.HEAPU8[i] = snapshot.heap[i] ^ baseline[i];
      if (module._dg_gametic() !== snapshot.tic) throw new Error("Snapshot tic mismatch");
    },
    render() {
      module._dg_render();
      const pixels = module.HEAPU8.slice(module._dg_pixels(), module._dg_pixels() + 320 * 200 * 4);
      // Upstream packs 0x00RRGGBB (BGRA bytes on WASM's little-endian heap).
      // Convert to canvas-ready RGBA without touching simulation memory.
      for (let i = 0; i < pixels.length; i += 4) {
        const blue = pixels[i];
        pixels[i] = pixels[i + 2];
        pixels[i + 2] = blue;
        pixels[i + 3] = 255;
      }
      return pixels;
    },
  };
}
