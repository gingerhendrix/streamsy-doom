// SPDX-License-Identifier: GPL-2.0-or-later
import { build } from "vite";
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildWad } from "./build-wad";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of ["doom.js", "doom.wasm", "build-id.js"])
  if (!await Bun.file(`${root}engine/build/${name}`).exists()) throw new Error("Missing engine output: run bun run build:engine first");
await build({ root: `${root}apps/web`, build: { outDir: `${root}dist`, emptyOutDir: true } });
await mkdir(`${root}dist/engine/src`, { recursive: true });
await cp(`${root}engine/src/engine.js`, `${root}dist/engine/src/engine.js`);
await cp(`${root}engine/build`, `${root}dist/engine/build`, { recursive: true });
await buildWad();
