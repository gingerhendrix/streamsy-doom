// SPDX-License-Identifier: GPL-2.0-or-later
import factory from "../../engine/build/doom.js";
import buildId from "../../engine/build/build-id.js";
import { headlessFactory } from "../../engine/src/headless";
export async function serverEngine(path?: string) {
  const wad = await Bun.file(
    path ?? process.env.DOOM_WAD ?? new URL("../../engine/data/freedoom1.wad", import.meta.url),
  ).bytes();
  const hash = new Bun.CryptoHasher("sha256").update(wad).digest("hex");
  const wasmBinary = await Bun.file(
    new URL("../../engine/build/doom.wasm", import.meta.url),
  ).bytes();
  return headlessFactory(factory, wad, buildId, hash, { wasmBinary });
}
