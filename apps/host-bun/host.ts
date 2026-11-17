// SPDX-License-Identifier: GPL-2.0-or-later
import { Http } from "@streamsy/core";
import { CheckpointStore, Projection } from "@streamsy/projection";
import { allStreams, ReplayWake, Scores } from "../../src/streams/v2";
import { isFamilyId } from "../../src/streams/ids";
import { frameCounter } from "../../src/projection/counter";
import { Protocol, routes } from "@streamsy/core/protocol";
import { BunStorage } from "@streamsy/storage/bun";
import { Effect, Layer, ManagedRuntime } from "effect";
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
  const protocol = BunStorage.layerProtocol({
    client: { filename: options.database ?? "doom.sqlite" }, longPollTimeoutMs: options.longPollTimeoutMs ?? 20_000,
  });
  const storage = CheckpointStore.layer.pipe(Layer.provideMerge(Protocol.bind(protocol, allStreams).pipe(Layer.provideMerge(protocol))));
  const runtime = ManagedRuntime.make(Projection.attach(frameCounter, { durable: true }).pipe(Layer.provideMerge(storage)));
  const context = await runtime.context();
  const cors = HttpRouter.cors({ exposedHeaders, maxAge: 0 });
  const legacy = HttpRouter.toWebHandler(routes({ prefix: "/", maxMessageSize: 2_000_000 }).pipe(
    Layer.provide(cors), Layer.provideMerge(Layer.succeedContext(context)),
  ), { disableLogger: true });
  const v2 = HttpRouter.toWebHandler(Http.routes(allStreams, {
    prefix: "/", maxMessageSize: 2_000_000,
    access: stream => stream === Scores || stream === ReplayWake ? "read" : "full",
  }).pipe(Layer.provide(cors), Layer.provideMerge(Layer.succeedContext(context))), { disableLogger: true });
  const directory = await realpath(options.staticDirectory ?? fileURLToPath(new URL("./public", import.meta.url)));
  const server = Bun.serve({
    port: options.port ?? 3000, hostname: options.hostname ?? "127.0.0.1", idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      let response: Response;
      if (url.pathname.startsWith("/__")) response = new Response(null, { status: 404 });
      else if (url.pathname.startsWith("/doom/v2/bootstrap/")) {
        if (request.method !== "POST") response = new Response(null, { status: 405 });
        else {
          const id = url.pathname.slice("/doom/v2/bootstrap/".length);
          if (!isFamilyId(id)) response = new Response("Invalid v2 session id", { status: 400 });
          else {
            await runtime.runPromise(Effect.gen(function* () {
              yield* (yield* Scores).create({}, { ttlSeconds: 43200 });
              yield* (yield* ReplayWake).create({ id }, { ttlSeconds: 43200 });
            }));
            response = new Response(null, { status: 204 });
          }
        }
      }
      else if (url.pathname.startsWith("/doom/v2/")) response = await v2.handler(request);
      else if (url.pathname.startsWith("/doom/")) response = await legacy.handler(request);
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
    async stop() { await server.stop(true); await legacy.dispose(); await v2.dispose(); await runtime.dispose(); },
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
