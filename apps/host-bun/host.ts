// SPDX-License-Identifier: GPL-2.0-or-later
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makeRequestHandler } from "./request-handler";
import { makeHostRuntime } from "./runtime";

export { exposedHeaders, snapshotDatabase } from "./runtime";

const DEFAULT_DATABASE = "doom.sqlite";
const DEFAULT_PORT = 3000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const NEVER_CLOSE_IDLE_LONG_POLLS = 0;

export interface HostOptions {
  port?: number;
  hostname?: string;
  database?: string;
  staticDirectory?: string;
  longPollTimeoutMs?: number;
  wadPath?: string;
  snapshotInterval?: number;
  onRequest?: (request: Request, response: Response) => void;
}

export async function startHost(options: HostOptions = {}) {
  const host = await makeHostRuntime({
    database: options.database ?? DEFAULT_DATABASE,
    longPollTimeoutMs: options.longPollTimeoutMs,
    wadPath: options.wadPath,
    snapshotInterval: options.snapshotInterval,
  });
  const staticDirectory = await realpath(
    options.staticDirectory ?? fileURLToPath(new URL("./public", import.meta.url)),
  );
  const respond = makeRequestHandler(host, staticDirectory);

  const server = Bun.serve({
    port: options.port ?? DEFAULT_PORT,
    hostname: options.hostname ?? DEFAULT_HOSTNAME,
    idleTimeout: NEVER_CLOSE_IDLE_LONG_POLLS,
    async fetch(request) {
      const response = await respond(request);
      options.onRequest?.(request, response);
      return response;
    },
  });

  return {
    url: server.url.toString(),
    server,
    async stop() {
      await server.stop(true);
      await host.dispose();
    },
  };
}

if (import.meta.main) {
  const host = await startHost({
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    hostname: process.env.HOST ?? DEFAULT_HOSTNAME,
    database: process.env.DOOM_DB ?? DEFAULT_DATABASE,
    staticDirectory: process.env.DOOM_STATIC_DIR,
  });
  console.log(`Doom host: ${host.url}`);
  const stop = async () => {
    await host.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
