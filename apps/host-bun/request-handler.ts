// SPDX-License-Identifier: GPL-2.0-or-later
import { Effect } from "effect";
import { createLobbyStreamsThatNeverExpire } from "../../src/server/lobby";
import { createReplayStreamsWithOneExpiry } from "../../src/server/replay-streams";
import {
  emptyResponse,
  invalidSessionIdResponse,
  NO_STORE,
  pathnameOf,
} from "../../src/server/responses";
import {
  bootstrapSession,
  changeSession,
  parseSessionInput,
  type SessionChange,
  type SessionInput,
} from "../../src/server/session";
import { snapshotResponse, snapshotRoute } from "../../src/server/snapshot-routes";
import {
  gameSnapshot,
  leaderboardSnapshot,
  stateSnapshotResponse,
  stateSnapshotRoute,
  type StateSnapshotRoute,
} from "../../src/server/state-snapshot";
import { isSessionId } from "../../src/streams/ids";
import { BOOTSTRAP_PREFIX, V2_PREFIX } from "../../src/streams/paths";
import type { HostRuntime } from "./runtime";
import { serialQueue } from "./serial-queue";
import { staticFileResponse } from "./static-files";

const INTERNAL_PREFIX = "/__";
const PUBLIC_BOOTSTRAP_PREFIX = `/${BOOTSTRAP_PREFIX}/`;
const sessionChangePrefix = /^\/doom\/v2\/(end|delete)\//;
const sessionChangeRoute = /^\/doom\/v2\/(end|delete)\/([^/]+)$/;

export function makeRequestHandler(host: HostRuntime, staticDirectory: string) {
  const { runtime, snapshots, streams } = host;
  const oneSessionWriteAtATime = serialQueue();

  const stateSnapshotOf = (route: StateSnapshotRoute) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const snapshot =
          route.kind === "leaderboard" ? yield* leaderboardSnapshot : yield* gameSnapshot(route.id);
        return stateSnapshotResponse(snapshot);
      }).pipe(
        Effect.catchTag("StreamNotFound", () => Effect.succeed(emptyResponse(404, NO_STORE))),
      ),
    );

  const bootstrap = (id: string, input: SessionInput) =>
    oneSessionWriteAtATime(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          yield* createLobbyStreamsThatNeverExpire;
          yield* createReplayStreamsWithOneExpiry(id);
          return yield* bootstrapSession(id, input);
        }),
      ),
    );

  async function bootstrapResponse(request: Request, path: string) {
    if (request.method !== "POST") return emptyResponse(405);
    const id = path.slice(PUBLIC_BOOTSTRAP_PREFIX.length);
    if (!isSessionId(id)) return invalidSessionIdResponse();
    let input: SessionInput;
    try {
      input = parseSessionInput(id, await request.json());
    } catch (error) {
      return new Response(String(error), { status: 400 });
    }
    return Response.json(await bootstrap(id, input));
  }

  async function sessionChangeResponse(request: Request, path: string) {
    const [, change, id] = path.match(sessionChangeRoute) ?? [];
    if (!isSessionId(id ?? "")) return emptyResponse(400);
    if (request.method !== "POST") return emptyResponse(405);
    const sessionExisted = await oneSessionWriteAtATime(() =>
      runtime.runPromise(
        changeSession(id, change as SessionChange).pipe(
          Effect.catchTag("StreamNotFound", () => Effect.succeed(false)),
        ),
      ),
    );
    return emptyResponse(sessionExisted ? 204 : 404);
  }

  return async function respond(request: Request): Promise<Response> {
    const snapshot = snapshotRoute(request);
    if (snapshot instanceof Response) return snapshot;
    if (snapshot) return snapshotResponse(request, snapshot, snapshots);

    const stateSnapshot = stateSnapshotRoute(request);
    if (stateSnapshot instanceof Response) return stateSnapshot;
    if (stateSnapshot) return stateSnapshotOf(stateSnapshot);

    const path = pathnameOf(request);
    if (path.startsWith(INTERNAL_PREFIX)) return emptyResponse(404);
    if (path.startsWith(PUBLIC_BOOTSTRAP_PREFIX)) return bootstrapResponse(request, path);
    if (sessionChangePrefix.test(path)) return sessionChangeResponse(request, path);
    if (path.startsWith(`/${V2_PREFIX}/`)) return streams.handler(request);

    const isRemovedV1Namespace = path.startsWith("/doom/");
    if (isRemovedV1Namespace) return emptyResponse(404);
    return staticFileResponse(staticDirectory, request);
  };
}
