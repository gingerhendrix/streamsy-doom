// SPDX-License-Identifier: GPL-2.0-or-later
import buildId from "../../engine/build/build-id.js";
import factory from "../../engine/build/doom.js";
import { headlessFactory } from "../../engine/src/headless";

const DEFAULT_WAD = new URL("../../engine/data/freedoom1.wad", import.meta.url);
const ENGINE_WASM = new URL("../../engine/build/doom.wasm", import.meta.url);

export async function serverEngine(wadPath?: string) {
  const wad = await Bun.file(wadPath ?? process.env.DOOM_WAD ?? DEFAULT_WAD).bytes();
  const wadSha256 = new Bun.CryptoHasher("sha256").update(wad).digest("hex");
  const wasmBinary = await Bun.file(ENGINE_WASM).bytes();
  return headlessFactory(factory, wad, buildId, wadSha256, { wasmBinary });
}
