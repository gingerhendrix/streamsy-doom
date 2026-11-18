// SPDX-License-Identifier: GPL-2.0-or-later
import type { StreamAddress } from "@streamsy/core";
import { StateTable, Transaction } from "@streamsy/projection";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Game, Entries, Leaderboard } from "../streams/v2";
import { isFamilyId } from "../streams/ids";

export const GameTable = StateTable.define(Game);
export const EntriesTable = StateTable.define(Entries);
export const LeaderboardTable = StateTable.define(Leaderboard);
// These tables are deliberately not attached: readers sync under their own lock.
export const stateTableMigration = Layer.effectDiscard(
  Effect.flatMap(SqlClient.SqlClient, StateTable.migrate).pipe(Effect.orDie),
);

export const stateSnapshot = <C extends StreamAddress.Collections, R>(
  table: StateTable.Bound<C, R>,
  collections: readonly (keyof C & string)[],
) =>
  Effect.gen(function* () {
    const tx = yield* Transaction;
    return yield* tx.withTransaction(
      Effect.gen(function* () {
        yield* table.sync();
        const events: Array<{
          type?: string;
          key?: string;
          value?: unknown;
          headers: { control?: "snapshot-start" | "snapshot-end"; operation?: "upsert" };
        }> = [{ headers: { control: "snapshot-start" } }];
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
export type StateSnapshotRoute = { kind: "game"; id: string } | { kind: "leaderboard" };
export function stateSnapshotRoute(
  request: Pick<Request, "url" | "method">,
): StateSnapshotRoute | Response | undefined {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/doom/v2/state-snapshot/")) return;
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  if (path === "/doom/v2/state-snapshot/leaderboard") return { kind: "leaderboard" };
  const match = path.match(/^\/doom\/v2\/state-snapshot\/games\/([^/]+)$/);
  if (!match) return new Response(null, { status: 404 });
  return isFamilyId(match[1])
    ? { kind: "game", id: match[1] }
    : new Response("Invalid v2 session id", { status: 400 });
}
export const gameSnapshot = (id: string) =>
  Effect.gen(function* () {
    // Test existence directly; sync wraps missing history in a ProjectionFault.
    yield* (yield* Game).head({ id });
    return yield* stateSnapshot(GameTable.at({ id }), ["session", "stats", "presence"]);
  });
export function stateSnapshotResponse(snapshot: { events: readonly unknown[]; offset: string }) {
  return Response.json(snapshot.events, {
    headers: { "Stream-Next-Offset": snapshot.offset, "Cache-Control": "no-store" },
  });
}
