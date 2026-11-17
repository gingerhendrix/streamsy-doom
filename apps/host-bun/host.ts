// SPDX-License-Identifier: GPL-2.0-or-later
import { routes } from "@streamsy/core/protocol";
import { BunStorage } from "@streamsy/storage/bun";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export const exposedHeaders = [
  "Stream-Next-Offset", "Stream-Cursor", "Stream-Up-To-Date", "Stream-Closed",
  "Stream-TTL", "Stream-Expires-At", "Stream-Forked-From", "Stream-Fork-Offset",
  "Stream-Fork-Sub-Offset", "stream-sse-data-encoding", "ETag", "Location", "Content-Type",
];
export async function startHost(options: {
  port?: number; hostname?: string; database?: string; staticDirectory?: string; longPollTimeoutMs?: number;
  wadPath?: string;
  onRequest?: (request: Request, response: Response) => void;
} = {}) {
  const storage = BunStorage.layerProtocol({
    client: { filename: options.database ?? "doom.sqlite" }, longPollTimeoutMs: options.longPollTimeoutMs ?? 20_000,
  });
  const app = routes({ prefix: "/", maxMessageSize: 2_000_000 }).pipe(
    Layer.provide(HttpRouter.cors({ exposedHeaders, maxAge: 0 })), Layer.provideMerge(storage),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  const directory = await realpath(options.staticDirectory ?? fileURLToPath(new URL("./public", import.meta.url)));
  const server = Bun.serve({
    port: options.port ?? 3000, hostname: options.hostname ?? "127.0.0.1", idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname.startsWith("/doom/")) response = await web.handler(request);
      else if (request.method !== "GET" && request.method !== "HEAD") response = new Response(null, { status: 405 });
      else if (url.pathname === "/game.wad" || url.pathname === "/freedoom/COPYING.txt" || url.pathname === "/freedoom/CREDITS.txt") {
        const data = fileURLToPath(new URL("../../engine/data/", import.meta.url));
        const path = url.pathname === "/game.wad" ? (options.wadPath ?? process.env.DOOM_WAD ?? data + "freedoom1.wad") : data + url.pathname.split("/").at(-1);
        const file = Bun.file(path);
        response = await file.exists() ? new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type } }) : new Response(null, { status: 404 });
      } else {
        try {
          const path = await realpath(resolve(directory, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
          if (!path.startsWith(directory + sep)) response = new Response(null, { status: 404 });
          else {
            const file = Bun.file(path);
            response = new Response(request.method === "HEAD" ? null : file, { headers: { "Content-Type": file.type } });
          }
        } catch { response = new Response(null, { status: 404 }); }
      }
      options.onRequest?.(request, response);
      return response;
    },
  });
  return {
    url: server.url.toString(), server,
    async stop() { await server.stop(true); await web.dispose(); },
  };
}
if (import.meta.main) {
  const host = await startHost({
    port: Number(process.env.PORT ?? 3000), hostname: process.env.HOST ?? "127.0.0.1",
    database: process.env.DOOM_DB ?? "doom.sqlite", staticDirectory: process.env.DOOM_STATIC_DIR,
  });
  console.log(`Doom host: ${host.url}`);
  const stop = async () => { await host.stop(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
