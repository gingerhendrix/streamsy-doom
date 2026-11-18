// SPDX-License-Identifier: GPL-2.0-or-later
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const image =
  "emscripten/emsdk:4.0.23@sha256:86537645c51e44899812d29820ee3b64b96c321ebb2aba4416a04ceeb1bcde62";
await mkdir(`${root}/engine/build`, { recursive: true });
// Use the upstream core source list, replacing its OS platform and WAD I/O.
const makefile = await Bun.file(`${root}/engine/doomgeneric/doomgeneric/Makefile`).text();
const sources = makefile
  .match(/^SRC_DOOM = (.+)$/m)![1]
  .trim()
  .split(/\s+/)
  .filter((s) => s !== "doomgeneric_xlib.o" && s !== "w_file_stdc.o")
  .map((s) => `engine/doomgeneric/doomgeneric/${s.replace(/\.o$/, ".c")}`);
const exports = [
  "dg_init",
  "dg_step",
  "dg_key",
  "dg_input",
  "dg_frame",
  "dg_gametic",
  "dg_prndindex",
  "dg_drift_count",
  "dg_state_hash",
  "dg_render",
  "dg_pixels",
  "dg_stats",
];
const args = [
  "/usr/bin/docker",
  "run",
  "--rm",
  "--user",
  `${process.getuid!()}:${process.getgid!()}`,
  "-v",
  `${root}:/src`,
  "-w",
  "/src",
  image,
  "emcc",
  ...sources,
  "engine/src/doom_wasm.c",
  "engine/src/w_file_wasm.c",
  "-Iengine/src",
  "-Iengine/doomgeneric/doomgeneric",
  "-O2",
  "-DSTREAMSY_WASM",
  "-DDOOMGENERIC_RESX=320",
  "-DDOOMGENERIC_RESY=200",
  "--no-entry",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=web,worker,node",
  "-sINITIAL_MEMORY=16777216",
  "-sALLOW_MEMORY_GROWTH=0",
  "-sSTACK_SIZE=1048576",
  "-sFORCE_FILESYSTEM=1",
  "-sFILESYSTEM=1",
  "-sASSERTIONS=1",
  `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports.map((s) => `_${s}`))}`,
  '-sEXPORTED_RUNTIME_METHODS=["FS","HEAPU8"]',
  "-lm",
  "-o",
  "engine/build/doom.js",
];
for (const worker of [false, true]) {
  const command = worker
    ? args.map((arg) =>
        arg === "-sENVIRONMENT=web,worker,node"
          ? "-sENVIRONMENT=web,worker"
          : arg === "engine/build/doom.js"
            ? "engine/build/doom-worker.js"
            : arg,
      )
    : args;
  const proc = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code) process.exit(code);
}
// Emscripten's assertion probes process even in a worker-only build. workerd's
// nodejs_compat exposes it, but has no WorkerGlobalScope constructor. Scope these
// two environment probes to this generated module; never mutate global objects.
const gluePath = `${root}/engine/build/doom-worker.js`;
let glue = await Bun.file(gluePath).text();
if (!glue.includes("globalThis.process") || !glue.includes("globalThis.WorkerGlobalScope"))
  throw new Error("Review worker glue environment probes for this Emscripten version");
glue =
  "// Worker-only environment probes (nodejs_compat safe).\nconst process = undefined;\n" +
  glue
    .replaceAll("globalThis.process", "process")
    .replaceAll("globalThis.WorkerGlobalScope", "true");
await Bun.write(gluePath, glue);
// Both glues must instantiate exactly the same engine build.
if (
  !Buffer.from(await Bun.file(`${root}/engine/build/doom.wasm`).arrayBuffer()).equals(
    Buffer.from(await Bun.file(`${root}/engine/build/doom-worker.wasm`).arrayBuffer()),
  )
)
  throw new Error("Browser and worker WASM differ");
const wasm = await Bun.file(`${root}/engine/build/doom.wasm`).arrayBuffer();
const hash = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
await Bun.write(`${root}/engine/build/build-id.js`, `export default ${JSON.stringify(hash)};\n`);
console.log(`Built engine: ${hash} (${wasm.byteLength} WASM bytes)`);
