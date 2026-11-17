// SPDX-License-Identifier: GPL-2.0-or-later
import type { EngineIdentity, EngineStats } from "./engine.js";
export interface HeadlessEngine {
  readonly tic: number;
  stats(): EngineStats;
  /** Returns false for RNG drift; malformed commands remain errors. */
  step(frame: Uint8Array): boolean;
  reset(identity: EngineIdentity): void;
}
const names: readonly (keyof EngineStats)[] = ["tic", "gamestate", "episode", "map", "leveltime", "playerstate",
  "health", "armor", "kills", "items", "secrets", "totalKills", "totalItems", "totalSecrets", "weapon", "ammo"];
export function headlessFactory(factory: (options: any) => Promise<any>, wad: Uint8Array, buildId: string, wadSha256: string, instantiate: Record<string, unknown>) {
  // One immutable WAD and pre-init baseline per factory/isolate. No MEMFS WAD
  // copy, per-engine baseline, frames allocation, render buffer or client snapshot.
  let baseline: Uint8Array | undefined;
  return async (identity: EngineIdentity): Promise<HeadlessEngine> => {
    const module = await factory({ ...instantiate, print() {}, printErr() {} });
    module.wadBytes = wad;
    module.FS.writeFile("/doom1.wad", new Uint8Array(0)); // IWAD discovery only
    baseline ??= module.HEAPU8.slice();
    const reset = (identity: EngineIdentity) => {
      if (identity.version !== 2 || identity.buildId !== buildId || identity.wadSha256 !== wadSha256)
        throw new Error("Replay engine identity mismatch");
      for (const [name, value, max] of [["skill", identity.skill, 5], ["episode", identity.episode, 4], ["map", identity.map, 9]] as const)
        if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
      module.HEAPU8.set(baseline!);
      if (module._dg_init(identity.skill, identity.episode, identity.map)) throw new Error("Engine initialization failed");
    };
    reset(identity);
    return {
      get tic() { return module._dg_gametic(); }, reset,
      stats() {
        const values = new Int32Array(module.HEAPU8.buffer, module._dg_stats(), names.length);
        return Object.fromEntries(names.map((name, i) => [name, values[i]])) as EngineStats;
      },
      step(frame) {
        if (frame.length !== 9) throw new Error("Replay needs a 9-byte frame");
        module.HEAPU8.set(frame, module._dg_input());
        const result = module._dg_step(1);
        if (result < 0) throw new Error("Invalid step or noncanonical frame");
        return result === 0;
      },
    };
  };
}
