// SPDX-License-Identifier: GPL-2.0-or-later
import buildId from "../../engine/build/build-id.js";
import factory from "../../engine/build/doom-worker.js";
import { headlessFactory } from "../../engine/src/headless";
import { sha256Hex } from "../../src/sha256";
import { loadWad } from "../../src/wad";
import precompiledWasm from "./doom.wasm";
import type { Env } from "./env";

const WAD_MANIFEST_URL = "https://assets/wad/manifest.json";

type EngineFactory = ReturnType<typeof loadEngineFactory>;

let factorySharedByIsolate: EngineFactory | undefined;

const instantiatePrecompiledWasm = {
  instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
    const instance = new WebAssembly.Instance(precompiledWasm, imports);
    done(instance);
    return instance.exports;
  },
};

async function loadEngineFactory(assets: Env["ASSETS"]) {
  const fetchAsset = async (url: string) => assets.fetch(url) as unknown as Response;
  const wad = await loadWad(WAD_MANIFEST_URL, fetchAsset);
  const wadSha256 = await sha256Hex(wad);
  return headlessFactory(factory, wad, buildId, wadSha256, instantiatePrecompiledWasm);
}

function forgetFailedLoadSoTheNextCallRetries(error: unknown): never {
  factorySharedByIsolate = undefined;
  throw error;
}

export function serverEngine(env: Env) {
  return (factorySharedByIsolate ??= loadEngineFactory(env.ASSETS).catch(
    forgetFailedLoadSoTheNextCallRetries,
  ));
}
