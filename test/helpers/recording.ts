// SPDX-License-Identifier: GPL-2.0-or-later
import { createEngine, keys } from "../../engine/src/engine.js";
import { serverEngine } from "../../apps/host-bun/engine";
export const wad = await Bun.file(new URL("../../engine/data/freedoom1.wad", import.meta.url)).bytes();
export const wasmBinary = await Bun.file(new URL("../../engine/build/doom.wasm", import.meta.url)).bytes();
export const createHeadless = await serverEngine();
export async function recording(count = 21000, scripted = true) {
  const engine = await createEngine(wad, { wasmBinary });
  const frames: Uint8Array[] = [], held = new Map<number, boolean>();
  const samples = [];
  for (let tic = 0; tic < count; tic++) {
    if (scripted) {
      const phase = Math.floor(tic / 175) % 8;
      const controls = new Map([[keys.up, phase < 5], [keys.down, phase === 6], [keys.left, phase === 2 || phase === 7],
        [keys.right, phase === 1 || phase === 5], [keys.fire, tic % 45 < 30], [keys.use, tic % 61 === 0]]);
      for (const [key, down] of controls) if ((held.get(key) ?? false) !== down) { engine.key(key, down); held.set(key, down); }
    }
    frames.push(engine.step()); samples.push(engine.stats());
  }
  return { identity: engine.identity, frames, samples, final: engine.stats() };
}
