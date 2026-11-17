// SPDX-License-Identifier: GPL-2.0-or-later
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
async function run(script: string) {
  const process = Bun.spawn(["bun", "run", script], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await process.exited) throw new Error(`${script} failed`);
}
if (!(await Promise.all(["doom.js", "doom.wasm", "build-id.js"].map(name => Bun.file(`${root}engine/build/${name}`).exists()))).every(Boolean)) await run("build:engine");
await run("fetch-wad");
await run("build:web");
const { startHost } = await import("../apps/host-bun/host");
const host = await startHost({ port: Number(process.env.PORT ?? 3000), hostname: process.env.HOST ?? "127.0.0.1", database: process.env.DOOM_DB ?? "doom.sqlite", staticDirectory: process.env.DOOM_STATIC_DIR ?? `${root}dist` });
console.log(`Streamsy Doom: ${host.url}`);
const stop = async () => { await host.stop(); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
