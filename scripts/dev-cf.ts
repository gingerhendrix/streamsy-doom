// SPDX-License-Identifier: GPL-2.0-or-later
// Direct Miniflare avoids initializing Alchemy's per-user auth/profile services.
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = `${root}apps/host-cloudflare/dist/worker/worker.js`;
if (!(await Bun.file(scriptPath).exists())) throw new Error("Run bun run build:cf first");
const runtime = new Miniflare({
  modulesRoot: `${root}apps/host-cloudflare/dist/worker`,
  modules: [
    { type: "ESModule", path: scriptPath },
    { type: "CompiledWasm", path: `${root}apps/host-cloudflare/dist/worker/doom.wasm` },
  ],
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  cf: false,
  assets: {
    directory: `${root}apps/host-cloudflare/dist/assets`,
    binding: "ASSETS",
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
  },
  durableObjects: {
    STREAMS: { className: "DoomStreams", useSQLite: true },
    GAMES: { className: "DoomGames", useSQLite: true },
    REPLAYS: { className: "DoomReplay", useSQLite: true },
    LOBBY: { className: "DoomLobby", useSQLite: true },
  },
  durableObjectsPersist: process.env.DOOM_CF_STATE ?? `${root}.alchemy/miniflare`,
});
console.log(`Streamsy Doom (local workerd): ${await runtime.ready}`);
const stop = async () => {
  await runtime.dispose();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
