// SPDX-License-Identifier: GPL-2.0-or-later
import type { Engine } from "../../engine/src/engine.js";
import { loadWad } from "../../src/wad";
import { find } from "./dom";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./templates";

type EngineRuntime = typeof import("../../engine/src/engine.js");

const ENGINE_RUNTIME_URL = "/engine/src/engine.js";
const ENGINE_WASM_URL = "/engine/build/doom.wasm";

let assets:
  | Promise<{ wad: Uint8Array; wasmBinary: Uint8Array; runtime: EngineRuntime }>
  | undefined;

async function fetchBytes(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Engine asset ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function loadAssets() {
  const [wad, wasmBinary, runtime] = await Promise.all([
    loadWad(),
    fetchBytes(ENGINE_WASM_URL),
    import(/* @vite-ignore */ ENGINE_RUNTIME_URL),
  ]);
  return { wad, wasmBinary, runtime };
}

const assetsLoadedOnce = () => (assets ??= loadAssets());

export const engineKeys = async () => (await assetsLoadedOnce()).runtime.keys;

export async function createEngine(settings: {
  skill: number;
  episode?: number;
  map?: number;
}): Promise<Engine> {
  const { wad, wasmBinary, runtime } = await assetsLoadedOnce();
  return runtime.createEngine(wad, { ...settings, wasmBinary });
}

export function paint(game: Engine) {
  const pixels = new ImageData(new Uint8ClampedArray(game.render()), CANVAS_WIDTH, CANVAS_HEIGHT);
  find<HTMLCanvasElement>("canvas").getContext("2d")!.putImageData(pixels, 0, 0);
}
