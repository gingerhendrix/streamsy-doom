// SPDX-License-Identifier: GPL-2.0-or-later
import { gunzipSync } from "fflate";
import type { EngineIdentity, EngineStats } from "./engine.js";
import { compressSnapshot } from "./snapshot";
import { readStats } from "./stats.js";

const FRAME_BYTES = 9;
const SUPPORTED_IDENTITY_VERSION = 2;
const LINE_FEED = 10;
const STEP_MATCHED_RECORDING = 0;
const IWAD_PATH_THE_ENGINE_LOOKS_FOR = "/doom1.wad";

const settingLimits = [
  ["skill", 5],
  ["episode", 4],
  ["map", 9],
] as const;

export interface HeadlessEngine {
  readonly tic: number;
  stats(): EngineStats;
  snapshot(): Promise<Uint8Array>;
  restore(bytes: Uint8Array): void;
  step(frame: Uint8Array): boolean;
  reset(identity: EngineIdentity): void;
}

function assertValidSettings(identity: EngineIdentity) {
  for (const [name, max] of settingLimits) {
    const value = identity[name];
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  }
}

function parseSnapshot(bytes: Uint8Array) {
  const raw = gunzipSync(bytes);
  const metadataEnd = raw.indexOf(LINE_FEED);
  if (metadataEnd < 0) throw new Error("Missing snapshot metadata");
  return {
    metadata: JSON.parse(new TextDecoder().decode(raw.subarray(0, metadataEnd))),
    heapXorHeapAfterInit: raw.subarray(metadataEnd + 1),
  };
}

export function headlessFactory(
  factory: (options: any) => Promise<any>,
  wad: Uint8Array,
  buildId: string,
  wadSha256: string,
  instantiate: Record<string, unknown>,
) {
  let heapBeforeInitSharedByEveryEngine: Uint8Array | undefined;

  return async (identity: EngineIdentity): Promise<HeadlessEngine> => {
    const module = await factory({ ...instantiate, print() {}, printErr() {} });
    module.wadBytes = wad;
    module.FS.writeFile(IWAD_PATH_THE_ENGINE_LOOKS_FOR, new Uint8Array(0));
    heapBeforeInitSharedByEveryEngine ??= module.HEAPU8.slice();

    let heapAfterInit: Uint8Array | undefined;
    let currentIdentity = identity;

    const assertBuiltForThisEngine = (identity: EngineIdentity) => {
      const matches =
        identity.version === SUPPORTED_IDENTITY_VERSION &&
        identity.buildId === buildId &&
        identity.wadSha256 === wadSha256;
      if (!matches) throw new Error("Replay engine identity mismatch");
    };

    const reset = (identity: EngineIdentity) => {
      assertBuiltForThisEngine(identity);
      assertValidSettings(identity);
      module.HEAPU8.set(heapBeforeInitSharedByEveryEngine!);
      if (module._dg_init(identity.skill, identity.episode, identity.map))
        throw new Error("Engine initialization failed");
      currentIdentity = identity;
      if (heapAfterInit) heapAfterInit.set(module.HEAPU8);
      else heapAfterInit = module.HEAPU8.slice();
    };

    const restore = (bytes: Uint8Array) => {
      const { metadata, heapXorHeapAfterInit } = parseSnapshot(bytes);
      for (const [field, value] of Object.entries(currentIdentity))
        if (metadata[field] !== value) throw new Error(`Snapshot ${field} mismatch`);
      if (heapXorHeapAfterInit.length !== module.HEAPU8.length)
        throw new Error("Snapshot heap size mismatch");
      for (let index = 0; index < heapXorHeapAfterInit.length; index++)
        module.HEAPU8[index] = heapXorHeapAfterInit[index] ^ heapAfterInit![index];
      if (module._dg_gametic() !== metadata.tic) throw new Error("Snapshot tic mismatch");
    };

    const step = (frame: Uint8Array) => {
      if (frame.length !== FRAME_BYTES) throw new Error("Replay needs a 9-byte frame");
      module.HEAPU8.set(frame, module._dg_input());
      const result = module._dg_step(1);
      if (result < 0) throw new Error("Invalid step or noncanonical frame");
      return result === STEP_MATCHED_RECORDING;
    };

    reset(identity);
    return {
      get tic() {
        return module._dg_gametic();
      },
      reset,
      restore,
      step,
      stats: () => readStats(module),
      snapshot: () =>
        compressSnapshot(currentIdentity, module._dg_gametic(), module.HEAPU8, heapAfterInit!),
    };
  };
}
