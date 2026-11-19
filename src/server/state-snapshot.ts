// SPDX-License-Identifier: GPL-2.0-or-later
import type { StreamAddress } from "@streamsy/core";
import { Transaction, type StateTable } from "@streamsy/projection";
import { Effect } from "effect";
import { failIfGameStreamIsMissing, GameTable, LeaderboardTable } from "../storage/state-tables";
import { isSessionId } from "../streams/ids";
import { leaderboardStateSnapshotPath, STATE_SNAPSHOT_PREFIX } from "../streams/paths";
import { createLobbyStreamsThatNeverExpire } from "./lobby";
import { emptyResponse, invalidSessionIdResponse, NO_STORE, pathnameOf } from "./responses";

const ROUTE_PREFIX = `/${STATE_SNAPSHOT_PREFIX}/`;
const LEADERBOARD_ROUTE = `/${leaderboardStateSnapshotPath}`;
const gameRoute = /^\/doom\/v2\/state-snapshot\/games\/([^/]+)$/;

interface SnapshotEvent {
  type?: string;
  key?: string;
  value?: unknown;
  headers: { control?: "snapshot-start" | "snapshot-end"; operation?: "upsert" };
}

export interface StateSnapshot {
  events: readonly unknown[];
  offset: string;
}

export const stateSnapshot = <C extends StreamAddress.Collections, R>(
  table: StateTable.Bound<C, R>,
  collections: readonly (keyof C & string)[],
) =>
  Effect.gen(function* () {
    const transaction = yield* Transaction;
    return yield* transaction.withTransaction(
      Effect.gen(function* () {
        yield* table.sync();
        const events: SnapshotEvent[] = [{ headers: { control: "snapshot-start" } }];
        for (const collection of collections) {
          const { rows } = yield* table.list(collection);
          for (const { key, value } of rows)
            events.push({ type: collection, key, value, headers: { operation: "upsert" } });
        }
        events.push({ headers: { control: "snapshot-end" } });
        return { events, offset: yield* table.offset() };
      }),
    );
  });

export const gameSnapshot = (id: string) =>
  Effect.gen(function* () {
    yield* failIfGameStreamIsMissing(id);
    return yield* stateSnapshot(GameTable.at({ id }), ["session", "stats", "presence"]);
  });

export const leaderboardSnapshot = Effect.gen(function* () {
  yield* createLobbyStreamsThatNeverExpire;
  return yield* stateSnapshot(LeaderboardTable.at({}), ["game"]);
});

export type StateSnapshotRoute = { kind: "game"; id: string } | { kind: "leaderboard" };

export function stateSnapshotRoute(
  request: Pick<Request, "url" | "method">,
): StateSnapshotRoute | Response | undefined {
  const path = pathnameOf(request);
  if (!path.startsWith(ROUTE_PREFIX)) return undefined;
  if (request.method !== "GET") return emptyResponse(405, { Allow: "GET" });
  if (path === LEADERBOARD_ROUTE) return { kind: "leaderboard" };
  const id = path.match(gameRoute)?.[1];
  if (id === undefined) return emptyResponse(404);
  return isSessionId(id) ? { kind: "game", id } : invalidSessionIdResponse();
}

export const stateSnapshotHeaders = (snapshot: StateSnapshot) => ({
  "Stream-Next-Offset": snapshot.offset,
  ...NO_STORE,
});

export const stateSnapshotResponse = (snapshot: StateSnapshot) =>
  Response.json(snapshot.events, { headers: stateSnapshotHeaders(snapshot) });
