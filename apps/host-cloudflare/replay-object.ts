// SPDX-License-Identifier: GPL-2.0-or-later
import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";
import type { ObjectInstance } from "@streamsy/serve/cloudflare";
import type { ReplayEngines } from "../../src/projection/replay/engines";
import {
  emptyResponse,
  invalidSessionIdResponse,
  NO_STORE,
  pathnameOf,
} from "../../src/server/responses";
import { parseSessionInput, type SessionInput } from "../../src/server/session";
import {
  snapshotResponse,
  snapshotRoute,
  type SnapshotRoute,
} from "../../src/server/snapshot-routes";
import {
  snapshotTable,
  type SnapshotSql,
  type SnapshotTableApi,
  type SqlValue,
} from "../../src/storage/snapshot-table";
import { isSessionId } from "../../src/streams/ids";
import { STATE_SNAPSHOT_PREFIX } from "../../src/streams/paths";
import { serverEngine } from "./engine";
import type { Env } from "./env";
import {
  BOOTSTRAP_REPLAY_PREFIX,
  INIT_REPLAY_ROUTE,
  internalUrl,
  postJson,
} from "./internal-routes";
import { makeReplayHost } from "./replay-host";

const IDENTITY_STORAGE_KEY = "doom-v2-session-id";

const asArrayBuffers = (values: SqlValue[]) =>
  values.map((value) => (value instanceof Uint8Array ? value.slice().buffer : value));

const durableObjectSql = (sql: SqlStorage): SnapshotSql => ({
  run: (query, values) => {
    sql.exec(query, ...asArrayBuffers(values));
  },
  all: <A>(query: string, values: SqlValue[]) =>
    [...sql.exec(query, ...asArrayBuffers(values))] as A[],
});

const identityConflict = () => new Response("Replay identity conflict", { status: 409 });

function notBootstrapped(path: string) {
  const isStateSnapshotRead = path.startsWith(`/${STATE_SNAPSHOT_PREFIX}/`);
  return new Response("Replay not bootstrapped", {
    status: isStateSnapshotRead ? 404 : 409,
    headers: NO_STORE,
  });
}

export class DoomReplay {
  protected readonly engines: ReplayEngines["Service"];
  protected readonly snapshots: SnapshotTableApi;
  private identity?: string;
  private hostOfIdentity?: ObjectInstance;
  private readonly identityLoaded: Promise<void>;

  constructor(
    private readonly owner: DurableObjectState,
    private readonly bindings: Env,
  ) {
    this.snapshots = snapshotTable(durableObjectSql(owner.storage.sql), "one-session-per-database");
    this.engines = {
      cache: new Map(),
      live: new Set(),
      create: async (identity) => (await serverEngine(bindings))(identity),
    };
    this.identityLoaded = owner.blockConcurrencyWhile(async () => {
      this.identity = await owner.storage.get<string>(IDENTITY_STORAGE_KEY);
    });
  }

  private host() {
    if (!this.identity) throw new Error("Replay not bootstrapped");
    return (this.hostOfIdentity ??= makeReplayHost(
      this.identity,
      this.owner,
      this.bindings,
      this.engines,
      this.snapshots,
    ));
  }

  private belongsToAnotherSession(id: string) {
    return this.identity ? this.identity !== id : false;
  }

  async fetch(request: Request): Promise<Response> {
    await this.identityLoaded;
    const path = pathnameOf(request);
    if (path.startsWith(BOOTSTRAP_REPLAY_PREFIX) && request.method === "POST")
      return this.bootstrap(path.slice(BOOTSTRAP_REPLAY_PREFIX.length), request);

    const snapshot = snapshotRoute(request);
    if (snapshot instanceof Response) return snapshot;
    if (snapshot) return this.snapshotOfThisSession(request, snapshot);

    if (!this.identity) return notBootstrapped(path);
    return this.host().fetch(request);
  }

  private async bootstrap(id: string, request: Request) {
    if (!isSessionId(id)) return invalidSessionIdResponse();
    if (this.belongsToAnotherSession(id)) return identityConflict();
    let input: SessionInput;
    try {
      input = parseSessionInput(id, await request.json());
    } catch (error) {
      return new Response(String(error), { status: 400 });
    }
    return this.owner.blockConcurrencyWhile(async () => {
      if (this.belongsToAnotherSession(id)) return identityConflict();
      await this.owner.storage.put(IDENTITY_STORAGE_KEY, id);
      this.identity = id;
      return this.host().fetch(new Request(internalUrl(INIT_REPLAY_ROUTE), postJson(input)));
    });
  }

  private snapshotOfThisSession(request: Request, route: SnapshotRoute) {
    if (this.belongsToAnotherSession(route.id)) return emptyResponse(404);
    return snapshotResponse(request, route, this.snapshots);
  }

  async webSocketMessage(...args: Parameters<ObjectInstance["webSocketMessage"]>) {
    await this.identityLoaded;
    await this.host().webSocketMessage(...args);
  }

  async webSocketClose(...args: Parameters<ObjectInstance["webSocketClose"]>) {
    await this.identityLoaded;
    await this.host().webSocketClose(...args);
  }

  async webSocketError(...args: Parameters<ObjectInstance["webSocketError"]>) {
    await this.identityLoaded;
    await this.host().webSocketError(...args);
  }

  async alarm(): Promise<void> {
    await this.identityLoaded;
    await this.host().alarm();
  }
}
