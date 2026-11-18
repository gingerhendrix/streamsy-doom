// SPDX-License-Identifier: GPL-2.0-or-later
import { headlessFactory } from "../../engine/src/headless";
import { loadWad } from "../../src/wad";
import factory from "../../engine/build/doom-worker.js";
import buildId from "../../engine/build/build-id.js";
// Resolved by the Worker bundler as a precompiled Cloudflare WASM module.
import wasm from "./doom.wasm";
import type { Env } from "./worker";
let shared: ReturnType<typeof load> | undefined;
async function load(assets: Env["ASSETS"]) {
  const wad = await loadWad(
    "https://assets/wad/manifest.json",
    async (url) => assets.fetch(url) as unknown as Response,
  );
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", wad as Uint8Array<ArrayBuffer>)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  return headlessFactory(factory, wad, buildId, hash, {
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
      const instance = new WebAssembly.Instance(wasm, imports);
      done(instance);
      return instance.exports;
    },
  });
}
export function serverEngine(env: Env) {
  // Failed asset reads remain retryable. Share only immutable engine resources.
  return (shared ??= load(env.ASSETS).catch((error) => {
    shared = undefined;
    throw error;
  }));
}
