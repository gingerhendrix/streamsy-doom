// SPDX-License-Identifier: GPL-2.0-or-later
import type {
  ExecutionContext,
  IncomingRequestCfProperties,
  Request as WorkerRequest,
} from "@cloudflare/workers-types";
import { router } from "@streamsy/serve/cloudflare";
import { emptyResponse, invalidSessionIdResponse, pathnameOf } from "../../src/server/responses";
import { snapshotRoute } from "../../src/server/snapshot-routes";
import { stateSnapshotRoute } from "../../src/server/state-snapshot";
import { isSessionId } from "../../src/streams/ids";
import { BOOTSTRAP_PREFIX, entriesStatePath, V2_PREFIX } from "../../src/streams/paths";
import type { Env } from "./env";
import {
  BOOTSTRAP_REPLAY_PREFIX,
  INIT_LOBBY_ROUTE,
  INTERNAL_PREFIX,
  internalUrl,
} from "./internal-routes";
import { objectKindOwning, placement, replayObject, theLobbyObject } from "./topology";

type EdgeRequest = WorkerRequest<unknown, IncomingRequestCfProperties>;

const PUBLIC_BOOTSTRAP_PREFIX = `/${BOOTSTRAP_PREFIX}/`;
const PRIVATE_ENTRIES_PATH = `/${entriesStatePath}`;
const sessionChangeRoute = /^\/doom\/v2\/(end|delete)\/([^/]+)$/;

const streamRouters = {
  games: router<Env>({ prefix: "/", placement, namespace: (env) => env.GAMES }),
  replays: router<Env>({ prefix: "/", placement, namespace: (env) => env.REPLAYS }),
  lobby: router<Env>({ prefix: "/", placement, namespace: (env) => env.LOBBY }),
};

const isPrivateEntriesStream = (path: string) =>
  path === PRIVATE_ENTRIES_PATH || path.startsWith(`${PRIVATE_ENTRIES_PATH}/`);

async function bootstrapSessionAfterLobbyExists(request: EdgeRequest, env: Env, id: string) {
  const lobbyReady = await theLobbyObject(env).fetch(internalUrl(INIT_LOBBY_ROUTE), {
    method: "POST",
  });
  if (!lobbyReady.ok) return lobbyReady;
  return replayObject(env, id).fetch(internalUrl(`${BOOTSTRAP_REPLAY_PREFIX}${id}`), {
    method: "POST",
    headers: request.headers,
    body: await request.arrayBuffer(),
  });
}

export default {
  async fetch(request: EdgeRequest, env: Env, context: ExecutionContext) {
    const path = pathnameOf(request);
    if (path.startsWith(INTERNAL_PREFIX)) return emptyResponse(404);

    const snapshot = snapshotRoute(request);
    if (snapshot instanceof Response) return snapshot;
    if (snapshot) return replayObject(env, snapshot.id).fetch(request);

    const stateSnapshot = stateSnapshotRoute(request);
    if (stateSnapshot instanceof Response) return stateSnapshot;
    if (stateSnapshot)
      return stateSnapshot.kind === "game"
        ? replayObject(env, stateSnapshot.id).fetch(request)
        : theLobbyObject(env).fetch(request);

    if (isPrivateEntriesStream(path)) return emptyResponse(404);

    if (path.startsWith(PUBLIC_BOOTSTRAP_PREFIX)) {
      if (request.method !== "POST") return emptyResponse(405);
      const id = path.slice(PUBLIC_BOOTSTRAP_PREFIX.length);
      if (!isSessionId(id)) return invalidSessionIdResponse();
      return bootstrapSessionAfterLobbyExists(request, env, id);
    }

    const sessionChange = path.match(sessionChangeRoute);
    if (sessionChange) {
      const id = sessionChange[2];
      if (!isSessionId(id)) return invalidSessionIdResponse();
      return replayObject(env, id).fetch(request);
    }

    if (path.startsWith(`/${V2_PREFIX}/`)) {
      const streamPath = path.slice(1);
      return streamRouters[objectKindOwning(streamPath)].fetch!(request, env, context);
    }

    const isRemovedV1Namespace = path.startsWith("/doom/");
    return isRemovedV1Namespace ? emptyResponse(404) : env.ASSETS.fetch(request);
  },
};
