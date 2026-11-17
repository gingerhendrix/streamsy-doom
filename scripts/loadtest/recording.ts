// SPDX-License-Identifier: GPL-2.0-or-later
import { createEngine, keys } from "../../engine/src/engine.js";
import { serverEngine } from "../../apps/host-bun/engine";
import { initialStats, replayPages } from "../../src/projection/stats";
import { encode } from "../../src/streams/protocol";
import type { Identity } from "../../src/streams/snapshots";
export interface Recording { identity: Identity; frames: Uint8Array[]; publications: number[] }
/** One real deterministic engine capture, reused by every synthetic player. */
export async function prepareRecording(count: number): Promise<Recording> {
  const wad = await Bun.file(process.env.DOOM_WAD ?? new URL("../../engine/data/freedoom1.wad", import.meta.url)).bytes();
  const wasmBinary = await Bun.file(new URL("../../engine/build/doom.wasm", import.meta.url)).bytes();
  const engine = await createEngine(wad, { wasmBinary });
  const held = new Map<number, boolean>(), frames: Uint8Array[] = [];
  for (let tic = 0; tic < count; tic++) {
    const phase = Math.floor(tic / 175) % 8;
    for (const [key, down] of [[keys.up, phase < 5], [keys.down, phase === 6], [keys.left, phase === 2 || phase === 7],
      [keys.right, phase === 1 || phase === 5], [keys.fire, tic % 45 < 30], [keys.use, tic % 61 === 0]] as const) {
      if ((held.get(key) ?? false) !== down) { engine.key(key, down); held.set(key, down); }
    }
    frames.push(engine.step());
  }
  const replay = await (await serverEngine())(engine.identity);
  const result = replayPages(initialStats(), [encode({ ...engine.identity, formatVersion: 1 }), ...frames], replay, "recording");
  if (!result.state.verified) throw new Error("Fixture did not replay deterministically");
  return { identity: engine.identity, frames, publications: result.rows.map(row => row.tic) };
}
