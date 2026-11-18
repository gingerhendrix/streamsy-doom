// SPDX-License-Identifier: GPL-2.0-or-later
import { compressSnapshot } from "./snapshot";
import { gunzipSync } from "fflate";
import { readStats } from "./stats.js";
import type { EngineIdentity, EngineStats } from "./engine.js";
export interface HeadlessEngine {
  readonly tic: number;
  stats(): EngineStats;
  /** Hold the engine between steps/reset until streaming compression settles. */
  snapshot(): Promise<Uint8Array>;
  restore(bytes: Uint8Array): void;
  /** Returns false for RNG drift; malformed commands remain errors. */
  step(frame: Uint8Array): boolean;
  reset(identity: EngineIdentity): void;
}
export function headlessFactory(factory: (options: any) => Promise<any>, wad: Uint8Array, buildId: string, wadSha256: string, instantiate: Record<string, unknown>) {
  // One immutable WAD and pre-init baseline per factory/isolate. No MEMFS WAD
  // copy, frames allocation or render buffer. Each engine also keeps its post-init
  // baseline for browser-compatible snapshots; reset reuses that allocation.
  let baseline: Uint8Array | undefined;
  return async (identity: EngineIdentity): Promise<HeadlessEngine> => {
    const module = await factory({ ...instantiate, print() {}, printErr() {} });
    module.wadBytes = wad;
    module.FS.writeFile("/doom1.wad", new Uint8Array(0)); // IWAD discovery only
    baseline ??= module.HEAPU8.slice();
    let initialized: Uint8Array | undefined, currentIdentity = identity;
    const reset = (identity: EngineIdentity) => {
      if (identity.version !== 2 || identity.buildId !== buildId || identity.wadSha256 !== wadSha256)
        throw new Error("Replay engine identity mismatch");
      for (const [name, value, max] of [["skill", identity.skill, 5], ["episode", identity.episode, 4], ["map", identity.map, 9]] as const)
        if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
      module.HEAPU8.set(baseline!);
      if (module._dg_init(identity.skill, identity.episode, identity.map)) throw new Error("Engine initialization failed");
      currentIdentity = identity;
      if (initialized) initialized.set(module.HEAPU8); else initialized = module.HEAPU8.slice();
    };
    reset(identity);
    return {
      get tic() { return module._dg_gametic(); }, reset,
      snapshot: () => compressSnapshot(currentIdentity, module._dg_gametic(), module.HEAPU8, initialized!),
      restore(bytes) {
        const raw = gunzipSync(bytes), newline = raw.indexOf(10);
        if (newline < 0) throw new Error("Missing snapshot metadata");
        const metadata = JSON.parse(new TextDecoder().decode(raw.subarray(0, newline)));
        for (const [key, value] of Object.entries(currentIdentity))
          if (metadata[key] !== value) throw new Error(`Snapshot ${key} mismatch`);
        const delta = raw.subarray(newline + 1);
        if (delta.length !== module.HEAPU8.length) throw new Error("Snapshot heap size mismatch");
        for (let i = 0; i < delta.length; i++) module.HEAPU8[i] = delta[i] ^ initialized![i];
        if (module._dg_gametic() !== metadata.tic) throw new Error("Snapshot tic mismatch");
      },
      stats() { return readStats(module); },
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
